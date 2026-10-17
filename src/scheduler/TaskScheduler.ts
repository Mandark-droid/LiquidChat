/**
 * Skill schedules (PRD §13) over the `schedules` table. The scheduler only
 * decides *when*; firing a skill is the caller's job (onFired returns the
 * skill id to run). Exactly one OS alarm per enabled schedule — its next
 * occurrence — is registered with the injected AlarmScheduler and
 * re-registered after every fire, boot, or clock/timezone change.
 */
import type { AlarmScheduler } from '../platform/types';
import { fromJson, getDatabase, type Row, type SqlDb, toJson } from '../storage/db';
import {
  describeTrigger,
  deviceOffset,
  isTrigger,
  missedRuns,
  nextRunAt,
  normalizeTrigger,
  type TimeZoneOffsetFn,
  type Trigger,
} from './triggers';

/** Occurrences armed ahead per recurring schedule (a week of daily routines). */
export const ALARM_LOOKAHEAD = 7;

export interface Schedule {
  id: string;
  skillId: string;
  trigger: Trigger;
  enabled: boolean;
  nextRunAt: number | null;
  lastRunAt: number | null;
  createdAt: number;
}

export interface AlarmPayload {
  scheduleId: string;
  skillId: string;
}

export interface MissedSchedule {
  schedule: Schedule;
  /** The occurrence that was due while the app/device was off. */
  dueAt: number;
  /** How many occurrences were missed (capped). */
  missedCount: number;
}

export interface TaskSchedulerOptions {
  getDb?: () => Promise<SqlDb>;
  now?: () => number;
  offsetFn?: TimeZoneOffsetFn;
  /** Alarm backend; can also be supplied later via sync(). */
  alarms?: AlarmScheduler;
  /** Alarm title/body; defaults to the skill name from the skills table. */
  describe?: (s: Schedule, skillName: string | null) => { title: string; body: string };
}

export function parseAlarmPayload(payload: string): AlarmPayload | null {
  const p = fromJson<Partial<AlarmPayload>>(payload);
  if (!p || typeof p.scheduleId !== 'string' || typeof p.skillId !== 'string') return null;
  return { scheduleId: p.scheduleId, skillId: p.skillId };
}

export class TaskScheduler {
  private readonly getDb: () => Promise<SqlDb>;
  private readonly now: () => number;
  private readonly offsetFn: TimeZoneOffsetFn;
  private readonly describeFn: NonNullable<TaskSchedulerOptions['describe']>;
  private alarms: AlarmScheduler | null = null;

  constructor(opts: TaskSchedulerOptions = {}) {
    this.getDb = opts.getDb ?? (() => getDatabase());
    this.now = opts.now ?? Date.now;
    this.offsetFn = opts.offsetFn ?? deviceOffset;
    this.alarms = opts.alarms ?? null;
    this.describeFn =
      opts.describe ??
      ((s, name) => ({
        title: name ?? 'Scheduled skill',
        body: describeTrigger(s.trigger),
      }));
  }

  // ---------------------------------------------------------------- CRUD

  async create(input: {
    skillId: string;
    trigger: Trigger;
    enabled?: boolean;
    id?: string;
  }): Promise<Schedule> {
    const trigger = normalizeTrigger(input.trigger);
    if (!input.skillId) throw new Error('skillId is required');
    const now = this.now();
    const enabled = input.enabled ?? true;
    const s: Schedule = {
      id: input.id ?? newId(now),
      skillId: input.skillId,
      trigger,
      enabled,
      nextRunAt: enabled ? nextRunAt(trigger, now, this.offsetFn) : null,
      lastRunAt: null,
      createdAt: now,
    };
    const db = await this.getDb();
    await db.execute(
      `INSERT INTO schedules (id, skill_id, trigger_json, enabled, next_run_at, last_run_at, created_at)
       VALUES (?, ?, ?, ?, ?, ?, ?)`,
      [s.id, s.skillId, toJson(s.trigger), s.enabled ? 1 : 0, s.nextRunAt, null, s.createdAt],
    );
    await this.register(s);
    return s;
  }

  async get(id: string): Promise<Schedule | null> {
    const db = await this.getDb();
    const r = await db.execute('SELECT * FROM schedules WHERE id = ?', [id]);
    return r.rows[0] ? rowToSchedule(r.rows[0]) : null;
  }

  /** Raw row count including corrupt rows (diagnostics). */
  async count(): Promise<number> {
    const db = await this.getDb();
    const r = await db.execute('SELECT COUNT(*) AS n FROM schedules');
    return Number(r.rows[0]?.n ?? 0);
  }

  async list(filter: { skillId?: string; enabledOnly?: boolean } = {}): Promise<Schedule[]> {
    const where: string[] = [];
    const params: string[] = [];
    if (filter.skillId) {
      where.push('skill_id = ?');
      params.push(filter.skillId);
    }
    if (filter.enabledOnly) where.push('enabled = 1');
    const db = await this.getDb();
    const r = await db.execute(
      `SELECT * FROM schedules ${where.length ? `WHERE ${where.join(' AND ')}` : ''}
       ORDER BY created_at, id`,
      params,
    );
    return r.rows.map(rowToSchedule).filter((s): s is Schedule => s !== null);
  }

  async update(
    id: string,
    patch: { trigger?: Trigger; enabled?: boolean; skillId?: string },
  ): Promise<Schedule> {
    const cur = await this.get(id);
    if (!cur) throw new Error(`Schedule not found: ${id}`);
    const trigger = patch.trigger ? normalizeTrigger(patch.trigger) : cur.trigger;
    const enabled = patch.enabled ?? cur.enabled;
    const next: Schedule = {
      ...cur,
      skillId: patch.skillId ?? cur.skillId,
      trigger,
      enabled,
      nextRunAt: enabled ? nextRunAt(trigger, this.now(), this.offsetFn) : null,
    };
    await this.save(next);
    await this.register(next);
    return next;
  }

  setEnabled(id: string, enabled: boolean): Promise<Schedule> {
    return this.update(id, { enabled });
  }

  async remove(id: string): Promise<boolean> {
    const db = await this.getDb();
    const r = await db.execute('DELETE FROM schedules WHERE id = ?', [id]);
    await this.cancelAlarm(id);
    return r.rowsAffected > 0;
  }

  /** Removes every schedule of a skill (e.g. when the skill is deleted). */
  async removeForSkill(skillId: string): Promise<number> {
    const all = await this.list({ skillId });
    for (const s of all) await this.remove(s.id);
    return all.length;
  }

  // ---------------------------------------------------------------- alarms

  /**
   * Registers the next occurrence of every enabled schedule. Schedules whose
   * next_run_at is in the past are left for checkMissed() (not silently
   * skipped) — unless they have no future occurrence at all.
   */
  async sync(alarms: AlarmScheduler): Promise<void> {
    this.alarms = alarms;
    const now = this.now();
    for (const s of await this.list()) {
      if (!s.enabled) {
        await this.cancelAlarm(s.id);
        continue;
      }
      let next = s.nextRunAt;
      if (next === null) {
        next = nextRunAt(s.trigger, s.lastRunAt ?? now, this.offsetFn);
        if (next !== null && next !== s.nextRunAt) await this.save({ ...s, nextRunAt: next });
      }
      if (next === null) {
        await this.cancelAlarm(s.id);
      } else {
        // Overdue schedules keep their nextRunAt (checkMissed reports them) but
        // future occurrences are armed so the routine keeps firing meanwhile.
        await this.register({ ...s, nextRunAt: next });
      }
    }
  }

  /**
   * Called when an alarm fires (or its notification is tapped). Records the
   * run, schedules the next occurrence, and returns which skill to run.
   * Returns null for unknown/disabled schedules or malformed payloads.
   */
  async onFired(payload: string | AlarmPayload): Promise<AlarmPayload | null> {
    const p = typeof payload === 'string' ? parseAlarmPayload(payload) : payload;
    if (!p) return null;
    const s = await this.get(p.scheduleId);
    if (!s || !s.enabled) return null;
    const now = this.now();
    const next = nextRunAt(s.trigger, now, this.offsetFn);
    const updated: Schedule = {
      ...s,
      lastRunAt: now,
      nextRunAt: next,
      // A one-shot schedule is spent once it fires.
      enabled: s.trigger.type === 'once' ? false : s.enabled,
    };
    await this.save(updated);
    await this.register(updated);
    return { scheduleId: s.id, skillId: s.skillId };
  }

  /**
   * Schedules that came due while the app/device was off. The caller asks the
   * user "run now?" and then calls onFired() (run) or skipMissed() (skip).
   */
  async checkMissed(now: number = this.now()): Promise<MissedSchedule[]> {
    const out: MissedSchedule[] = [];
    for (const s of await this.list({ enabledOnly: true })) {
      if (s.nextRunAt === null || s.nextRunAt > now) continue;
      const missedCount = 1 + missedRuns(s.trigger, s.nextRunAt, now, 99, this.offsetFn);
      out.push({ schedule: s, dueAt: s.nextRunAt, missedCount });
    }
    return out.sort((a, b) => a.dueAt - b.dueAt);
  }

  /** Skips a missed schedule: moves it to its next future occurrence without running. */
  async skipMissed(id: string): Promise<Schedule | null> {
    const s = await this.get(id);
    if (!s) return null;
    const next = nextRunAt(s.trigger, this.now(), this.offsetFn);
    const updated: Schedule = {
      ...s,
      nextRunAt: next,
      enabled: s.trigger.type === 'once' ? false : s.enabled,
    };
    await this.save(updated);
    await this.register(updated);
    return updated;
  }

  /**
   * Clock or timezone changed: recompute every future next run from the new
   * local wall clock. Overdue ones stay overdue for checkMissed().
   */
  async onTimeChanged(): Promise<void> {
    const now = this.now();
    for (const s of await this.list()) {
      if (!s.enabled) continue;
      if (s.nextRunAt !== null && s.nextRunAt <= now) continue;
      const next = nextRunAt(s.trigger, now, this.offsetFn);
      const updated = { ...s, nextRunAt: next };
      await this.save(updated);
      await this.register(updated);
    }
  }

  // ---------------------------------------------------------------- internals

  private async save(s: Schedule): Promise<void> {
    const db = await this.getDb();
    await db.execute(
      `UPDATE schedules SET skill_id = ?, trigger_json = ?, enabled = ?, next_run_at = ?, last_run_at = ?
       WHERE id = ?`,
      [s.skillId, toJson(s.trigger), s.enabled ? 1 : 0, s.nextRunAt, s.lastRunAt, s.id],
    );
  }

  /**
   * Arms the next occurrence plus a few after it. Android alarms are one-shot and
   * only re-armed from JS, so without look-ahead a routine whose notification is
   * swiped away (never opening the app) would stop for good. Extra occurrences use
   * ids `<id>#k`; their payload is the same schedule, so onFired re-arms the chain.
   */
  private async register(s: Schedule): Promise<void> {
    if (!this.alarms) return;
    await this.cancelAlarm(s.id);
    if (!s.enabled) return;
    const now = this.now();
    let at: number | null =
      s.nextRunAt !== null && s.nextRunAt > now
        ? s.nextRunAt
        : nextRunAt(s.trigger, now, this.offsetFn);
    if (at === null) return;
    const { title, body } = this.describeFn(s, await this.skillName(s.skillId));
    const payload: AlarmPayload = { scheduleId: s.id, skillId: s.skillId };
    const count = s.trigger.type === 'once' ? 1 : ALARM_LOOKAHEAD;
    for (let k = 0; k < count && at !== null; k++) {
      try {
        await this.alarms.schedule({
          id: k === 0 ? s.id : `${s.id}#${k}`,
          triggerAtMs: at,
          title,
          body,
          payload: JSON.stringify(payload),
        });
      } catch (err) {
        console.warn('[TaskScheduler] alarm registration failed', s.id, err);
        return;
      }
      at = nextRunAt(s.trigger, at, this.offsetFn);
    }
  }

  private async cancelAlarm(id: string): Promise<void> {
    if (!this.alarms) return;
    for (let k = 0; k < ALARM_LOOKAHEAD; k++) {
      try {
        await this.alarms.cancel(k === 0 ? id : `${id}#${k}`);
      } catch {}
    }
  }

  private async skillName(skillId: string): Promise<string | null> {
    try {
      const db = await this.getDb();
      const r = await db.execute('SELECT name FROM skills WHERE id = ?', [skillId]);
      return r.rows[0]?.name != null ? String(r.rows[0].name) : null;
    } catch {
      return null;
    }
  }
}

/** Null for rows with a corrupt trigger (they are ignored rather than crashing sync). */
function rowToSchedule(r: Row): Schedule | null {
  const trigger = fromJson<Trigger>(r.trigger_json);
  if (!isTrigger(trigger)) return null;
  return {
    id: String(r.id),
    skillId: String(r.skill_id),
    trigger,
    enabled: Number(r.enabled) === 1,
    nextRunAt: r.next_run_at === null ? null : Number(r.next_run_at),
    lastRunAt: r.last_run_at === null ? null : Number(r.last_run_at),
    createdAt: Number(r.created_at),
  };
}

function newId(now: number): string {
  return `sch_${now.toString(36)}${Math.random().toString(36).slice(2, 8)}`;
}
