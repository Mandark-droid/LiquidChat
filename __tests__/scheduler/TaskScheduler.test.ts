import type { AlarmScheduler, AlarmSpec } from '../../src/platform/types';
import {
  ALARM_LOOKAHEAD,
  parseAlarmPayload,
  TaskScheduler,
} from '../../src/scheduler/TaskScheduler';
import { offsetFnForZone } from '../../src/scheduler/triggers';
import { getDatabase, resetDatabaseForTests } from '../../src/storage/db';

/** Minimal in-test AlarmScheduler double. */
class FakeAlarms implements AlarmScheduler {
  alarms = new Map<string, AlarmSpec>();
  cancelled: string[] = [];
  async schedule(a: AlarmSpec) {
    this.alarms.set(a.id, a);
  }
  async cancel(id: string) {
    this.alarms.delete(id);
    this.cancelled.push(id);
  }
  async consumeLaunchPayload() {
    return null;
  }
}

const MIN = 60_000;
const HOUR = 60 * MIN;
const IST = offsetFnForZone('Asia/Kolkata');
const NY = offsetFnForZone('America/New_York');
const at = (s: string) => Date.parse(s);

let clock = 0;
let alarms: FakeAlarms;

function make(offsetFn = IST) {
  return new TaskScheduler({ now: () => clock, offsetFn });
}

beforeEach(async () => {
  resetDatabaseForTests();
  (require('@op-engineering/op-sqlite') as any).__resetAll();
  clock = at('2026-10-17T06:00:00+05:30');
  alarms = new FakeAlarms();
  const db = await getDatabase();
  await db.execute(
    `INSERT INTO skills (id, name, version, manifest_json, enabled, source, hash, created_at, updated_at)
     VALUES ('sk_brief', 'Morning briefing', '1', '{}', 1, 'builtin', 'h', 0, 0)`,
  );
});

describe('TaskScheduler CRUD', () => {
  test('create computes next run and persists', async () => {
    const s = make();
    const sch = await s.create({ skillId: 'sk_brief', trigger: { type: 'daily', time: '7:30' } });
    expect(sch.trigger).toEqual({ type: 'daily', time: '07:30' });
    expect(sch.nextRunAt).toBe(at('2026-10-17T07:30:00+05:30'));
    expect(sch.enabled).toBe(true);
    expect(await s.get(sch.id)).toEqual(sch);
    expect(await s.list()).toHaveLength(1);
  });

  test('rejects invalid triggers and missing skill id', async () => {
    const s = make();
    await expect(
      s.create({ skillId: 'sk_brief', trigger: { type: 'interval', minutes: 5 } }),
    ).rejects.toThrow(/Invalid trigger/);
    await expect(
      s.create({ skillId: '', trigger: { type: 'interval', minutes: 30 } }),
    ).rejects.toThrow(/skillId/);
  });

  test('update, disable, list filters and remove', async () => {
    const s = make();
    await s.sync(alarms);
    const a = await s.create({ skillId: 'sk_brief', trigger: { type: 'interval', minutes: 60 } });
    const b = await s.create({ skillId: 'sk_other', trigger: { type: 'daily', time: '21:00' } });
    // Each recurring schedule arms a week of occurrences.
    expect(alarms.alarms.size).toBe(2 * ALARM_LOOKAHEAD);

    const upd = await s.update(a.id, { trigger: { type: 'interval', minutes: 30 } });
    expect(upd.nextRunAt).toBe(clock + 30 * MIN);
    expect(alarms.alarms.get(a.id)?.triggerAtMs).toBe(clock + 30 * MIN);

    const off = await s.setEnabled(b.id, false);
    expect(off.nextRunAt).toBeNull();
    expect([...alarms.alarms.keys()].some(k => k.startsWith(b.id))).toBe(false);
    expect((await s.list({ enabledOnly: true })).map(x => x.id)).toEqual([a.id]);
    expect((await s.list({ skillId: 'sk_other' })).map(x => x.id)).toEqual([b.id]);

    expect(await s.remove(a.id)).toBe(true);
    expect(await s.remove(a.id)).toBe(false);
    expect(alarms.alarms.size).toBe(0);
    expect(await s.removeForSkill('sk_other')).toBe(1);
    expect(await s.list()).toEqual([]);
    await expect(s.update('nope', { enabled: true })).rejects.toThrow(/not found/);
  });

  test('corrupt trigger rows are ignored, not fatal', async () => {
    const s = make();
    const db = await getDatabase();
    await db.execute(
      `INSERT INTO schedules (id, skill_id, trigger_json, enabled, created_at) VALUES ('bad', 'x', '{"type":"weird"}', 1, 0)`,
    );
    expect(await s.list()).toEqual([]);
    expect(await s.count()).toBe(1);
    await expect(s.sync(alarms)).resolves.toBeUndefined();
  });
});

describe('alarms', () => {
  test('sync registers next occurrence with JSON payload and skill title', async () => {
    const s = make();
    const sch = await s.create({ skillId: 'sk_brief', trigger: { type: 'daily', time: '07:30' } });
    const disabled = await s.create({
      skillId: 'sk_brief',
      trigger: { type: 'interval', minutes: 60 },
      enabled: false,
    });
    await s.sync(alarms);
    expect([...alarms.alarms.keys()]).toEqual([
      sch.id,
      ...Array.from({ length: ALARM_LOOKAHEAD - 1 }, (_, k) => `${sch.id}#${k + 1}`),
    ]);
    // Look-ahead occurrences are consecutive days with the same payload.
    expect(alarms.alarms.get(`${sch.id}#1`)?.triggerAtMs).toBe(at('2026-10-18T07:30:00+05:30'));
    expect(alarms.alarms.get(`${sch.id}#1`)?.payload).toBe(alarms.alarms.get(sch.id)?.payload);
    const spec = alarms.alarms.get(sch.id) as AlarmSpec;
    expect(spec.triggerAtMs).toBe(at('2026-10-17T07:30:00+05:30'));
    expect(spec.title).toBe('Morning briefing');
    expect(spec.body).toBe('Daily 07:30');
    expect(JSON.parse(spec.payload)).toEqual({ scheduleId: sch.id, skillId: 'sk_brief' });
    expect(alarms.cancelled).toContain(disabled.id);
  });

  test('onFired records the run and re-registers the next one', async () => {
    const s = make();
    await s.sync(alarms);
    const sch = await s.create({ skillId: 'sk_brief', trigger: { type: 'daily', time: '07:30' } });
    clock = at('2026-10-17T07:30:02+05:30');
    const fired = await s.onFired(alarms.alarms.get(sch.id)!.payload);
    expect(fired).toEqual({ scheduleId: sch.id, skillId: 'sk_brief' });
    const after = (await s.get(sch.id))!;
    expect(after.lastRunAt).toBe(clock);
    expect(after.nextRunAt).toBe(at('2026-10-18T07:30:00+05:30'));
    expect(alarms.alarms.get(sch.id)?.triggerAtMs).toBe(after.nextRunAt);
  });

  test('onFired on a once schedule disables it and cancels the alarm', async () => {
    const s = make();
    await s.sync(alarms);
    const sch = await s.create({
      skillId: 'sk_brief',
      trigger: { type: 'once', at: '2026-10-17T08:00:00+05:30' },
    });
    clock = at('2026-10-17T08:00:00+05:30');
    expect(await s.onFired({ scheduleId: sch.id, skillId: 'sk_brief' })).not.toBeNull();
    const after = (await s.get(sch.id))!;
    expect(after).toMatchObject({ enabled: false, nextRunAt: null, lastRunAt: clock });
    expect(alarms.alarms.has(sch.id)).toBe(false);
  });

  test('onFired ignores malformed, unknown and disabled schedules', async () => {
    const s = make();
    const sch = await s.create({
      skillId: 'sk_brief',
      trigger: { type: 'interval', minutes: 30 },
      enabled: false,
    });
    expect(await s.onFired('not json')).toBeNull();
    expect(await s.onFired('{"scheduleId":1}')).toBeNull();
    expect(await s.onFired({ scheduleId: 'ghost', skillId: 'x' })).toBeNull();
    expect(await s.onFired({ scheduleId: sch.id, skillId: 'sk_brief' })).toBeNull();
    expect(parseAlarmPayload('{"scheduleId":"a","skillId":"b"}')).toEqual({
      scheduleId: 'a',
      skillId: 'b',
    });
  });

  test('alarm backend failures do not break CRUD', async () => {
    const warn = jest.spyOn(console, 'warn').mockImplementation(() => {});
    const broken: AlarmScheduler = {
      schedule: async () => {
        throw new Error('exact alarm permission revoked');
      },
      cancel: async () => {
        throw new Error('x');
      },
      consumeLaunchPayload: async () => null,
    };
    const s = new TaskScheduler({ now: () => clock, offsetFn: IST, alarms: broken });
    const sch = await s.create({ skillId: 'sk_brief', trigger: { type: 'interval', minutes: 30 } });
    expect(await s.remove(sch.id)).toBe(true);
    expect(warn).toHaveBeenCalled();
    warn.mockRestore();
  });
});

describe('missed runs and time changes', () => {
  test('checkMissed reports schedules due while the device was off; sync keeps them pending but armed', async () => {
    const s = make();
    const daily = await s.create({
      skillId: 'sk_brief',
      trigger: { type: 'daily', time: '07:30' },
    });
    const future = await s.create({ skillId: 'sk_x', trigger: { type: 'daily', time: '22:00' } });
    // Device off for 3 days; it's now 08:00 on the 20th.
    clock = at('2026-10-20T08:00:00+05:30');
    await s.sync(alarms);
    // Overdue → still reported for a prompt, but future occurrences stay armed.
    expect(alarms.alarms.get(daily.id)?.triggerAtMs).toBe(at('2026-10-21T07:30:00+05:30'));
    expect(alarms.alarms.get(future.id)?.triggerAtMs).toBe(at('2026-10-20T22:00:00+05:30'));
    expect((await s.get(daily.id))!.nextRunAt).toBe(at('2026-10-17T07:30:00+05:30'));

    const missed = await s.checkMissed();
    expect(missed.map(m => m.schedule.id)).toEqual([daily.id, future.id]);
    expect(missed[0].dueAt).toBe(at('2026-10-17T07:30:00+05:30'));
    expect(missed[0].missedCount).toBe(4); // 17th, 18th, 19th, 20th
    expect(missed[1].missedCount).toBe(3); // 17th, 18th, 19th

    // User says "run now" for the first, "skip" for the second.
    await s.onFired({ scheduleId: daily.id, skillId: 'sk_brief' });
    await s.skipMissed(future.id);
    expect(await s.checkMissed()).toEqual([]);
    expect(alarms.alarms.get(daily.id)?.triggerAtMs).toBe(at('2026-10-21T07:30:00+05:30'));
    expect(alarms.alarms.get(future.id)?.triggerAtMs).toBe(at('2026-10-20T22:00:00+05:30'));
  });

  test('checkMissed with an explicit now and no overdue schedules', async () => {
    const s = make();
    await s.create({ skillId: 'sk_brief', trigger: { type: 'interval', minutes: 60 } });
    expect(await s.checkMissed(clock + 30 * MIN)).toEqual([]);
    expect(await s.checkMissed(clock + 3.5 * HOUR)).toMatchObject([{ missedCount: 3 }]);
  });

  test('onTimeChanged recomputes next runs from the new local wall clock', async () => {
    let offsetFn = IST;
    const s = new TaskScheduler({ now: () => clock, offsetFn: ms => offsetFn(ms) });
    await s.sync(alarms);
    const sch = await s.create({ skillId: 'sk_brief', trigger: { type: 'daily', time: '09:00' } });
    expect(sch.nextRunAt).toBe(at('2026-10-17T09:00:00+05:30'));
    // User flies to New York; device timezone changes.
    offsetFn = NY;
    await s.onTimeChanged();
    const after = (await s.get(sch.id))!;
    expect(after.nextRunAt).toBe(at('2026-10-17T09:00:00-04:00'));
    expect(alarms.alarms.get(sch.id)?.triggerAtMs).toBe(after.nextRunAt);
  });

  test('onTimeChanged leaves overdue schedules for checkMissed', async () => {
    const s = make();
    const sch = await s.create({ skillId: 'sk_brief', trigger: { type: 'daily', time: '07:30' } });
    clock = at('2026-10-17T10:00:00+05:30');
    await s.onTimeChanged();
    expect((await s.get(sch.id))!.nextRunAt).toBe(at('2026-10-17T07:30:00+05:30'));
    expect(await s.checkMissed()).toHaveLength(1);
  });
});
