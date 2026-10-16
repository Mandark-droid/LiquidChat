/**
 * Schedule triggers (PRD §13). Daily triggers are wall-clock times in the
 * device's local zone: every computation converts "now" to the local wall
 * clock, picks the next matching local date/time, and converts back with the
 * offset in force *at that instant* — so DST switches and timezone changes are
 * handled by recomputing, never by adding 24 h.
 *
 * DST rules: a wall time that doesn't exist (spring-forward gap) runs at the
 * equivalent instant after the jump (02:30 → 03:30); a wall time that occurs
 * twice (fall-back overlap) runs once, at the first occurrence.
 */

export type Weekday = 0 | 1 | 2 | 3 | 4 | 5 | 6; // 0 = Sunday

export type Trigger =
  | { type: 'daily'; time: string; days?: Weekday[] }
  | { type: 'interval'; minutes: number }
  | { type: 'once'; at: string };

/** Minutes EAST of UTC in force at a UTC instant (IST → 330, EST → -300). */
export type TimeZoneOffsetFn = (utcMs: number) => number;

export const MIN_INTERVAL_MINUTES = 15;
export const DEFAULT_MISSED_CAP = 100;
const MINUTE_MS = 60_000;
const DAY_MS = 24 * 60 * MINUTE_MS;

/** Device-local offset (honours the JS runtime's current zone). */
export const deviceOffset: TimeZoneOffsetFn = utcMs => -new Date(utcMs).getTimezoneOffset();

/**
 * Offset function for an IANA zone via Intl (tests, or when the device zone is
 * known by name). Falls back to the device offset if Intl lacks the zone.
 */
export function offsetFnForZone(timeZone: string): TimeZoneOffsetFn {
  let fmt: Intl.DateTimeFormat;
  try {
    fmt = new Intl.DateTimeFormat('en-US', {
      timeZone,
      hourCycle: 'h23',
      year: 'numeric',
      month: 'numeric',
      day: 'numeric',
      hour: 'numeric',
      minute: 'numeric',
      second: 'numeric',
    });
  } catch {
    return deviceOffset;
  }
  return utcMs => {
    const parts: Record<string, number> = {};
    for (const p of fmt.formatToParts(new Date(utcMs))) {
      if (p.type !== 'literal') parts[p.type] = Number(p.value);
    }
    const wall = Date.UTC(
      parts.year,
      parts.month - 1,
      parts.day,
      parts.hour % 24,
      parts.minute,
      parts.second,
    );
    const flooredUtc = Math.floor(utcMs / 1000) * 1000;
    return Math.round((wall - flooredUtc) / MINUTE_MS);
  };
}

const TIME_RE = /^([01]?\d|2[0-3]):([0-5]\d)$/;

/** Returns a list of problems; empty means valid. */
export function validateTrigger(t: unknown): string[] {
  if (!t || typeof t !== 'object') return ['trigger must be an object'];
  const tr = t as Record<string, unknown>;
  switch (tr.type) {
    case 'daily': {
      const errs: string[] = [];
      if (typeof tr.time !== 'string' || !TIME_RE.test(tr.time)) errs.push('time must be HH:MM');
      if (tr.days !== undefined) {
        if (
          !Array.isArray(tr.days) ||
          tr.days.length === 0 ||
          !tr.days.every(d => Number.isInteger(d) && d >= 0 && d <= 6)
        ) {
          errs.push('days must be a non-empty array of 0-6');
        }
      }
      return errs;
    }
    case 'interval':
      return typeof tr.minutes === 'number' &&
        Number.isFinite(tr.minutes) &&
        tr.minutes >= MIN_INTERVAL_MINUTES
        ? []
        : [`minutes must be a number >= ${MIN_INTERVAL_MINUTES}`];
    case 'once':
      return typeof tr.at === 'string' && !Number.isNaN(Date.parse(tr.at))
        ? []
        : ['at must be an ISO date string'];
    default:
      return ['type must be daily, interval or once'];
  }
}

export function isTrigger(t: unknown): t is Trigger {
  return validateTrigger(t).length === 0;
}

/** Validates and normalizes (sorted unique days, zero-padded time). Throws on invalid input. */
export function normalizeTrigger(t: unknown): Trigger {
  const errs = validateTrigger(t);
  if (errs.length) throw new Error(`Invalid trigger: ${errs.join('; ')}`);
  const tr = t as Trigger;
  if (tr.type === 'daily') {
    const [h, m] = tr.time.split(':').map(Number);
    const time = `${String(h).padStart(2, '0')}:${String(m).padStart(2, '0')}`;
    return tr.days
      ? { type: 'daily', time, days: [...new Set(tr.days)].sort((a, b) => a - b) as Weekday[] }
      : { type: 'daily', time };
  }
  if (tr.type === 'interval') return { type: 'interval', minutes: tr.minutes };
  return { type: 'once', at: tr.at };
}

/** Converts a local wall-clock instant (encoded as if UTC) to a real UTC instant. */
export function wallToUtc(wallMs: number, offsetFn: TimeZoneOffsetFn): number {
  const before = offsetFn(wallMs - DAY_MS);
  const after = offsetFn(wallMs + DAY_MS);
  const candidates = [...new Set([before, after])]
    .map(off => wallMs - off * MINUTE_MS)
    .filter(utc => utc + offsetFn(utc) * MINUTE_MS === wallMs)
    .sort((a, b) => a - b);
  if (candidates.length) return candidates[0];
  // Gap (spring forward): interpret with the pre-transition offset, which
  // lands the same distance past the jump.
  return wallMs - before * MINUTE_MS;
}

function utcToWall(utcMs: number, offsetFn: TimeZoneOffsetFn): Date {
  return new Date(utcMs + offsetFn(utcMs) * MINUTE_MS);
}

/**
 * Next occurrence strictly after `fromMs`, or null when the trigger will never
 * fire again (a past 'once').
 */
export function nextRunAt(
  trigger: Trigger,
  fromMs: number,
  offsetFn: TimeZoneOffsetFn = deviceOffset,
): number | null {
  switch (trigger.type) {
    case 'interval':
      return fromMs + Math.max(MIN_INTERVAL_MINUTES, trigger.minutes) * MINUTE_MS;
    case 'once': {
      const at = Date.parse(trigger.at);
      return Number.isNaN(at) || at <= fromMs ? null : at;
    }
    case 'daily': {
      const m = TIME_RE.exec(trigger.time);
      if (!m) return null;
      const hh = Number(m[1]);
      const mm = Number(m[2]);
      const days = trigger.days?.length ? new Set<number>(trigger.days) : null;
      const wall = utcToWall(fromMs, offsetFn);
      const y = wall.getUTCFullYear();
      const mo = wall.getUTCMonth();
      const d = wall.getUTCDate();
      for (let i = 0; i <= 8; i++) {
        const candWall = Date.UTC(y, mo, d + i, hh, mm);
        const weekday = new Date(candWall).getUTCDay();
        if (days && !days.has(weekday)) continue;
        const utc = wallToUtc(candWall, offsetFn);
        if (utc > fromMs) return utc;
      }
      return null;
    }
  }
}

/** Occurrences in (lastRunAt, now], at most `cap`. */
export function missedRunTimes(
  trigger: Trigger,
  lastRunAt: number,
  now: number,
  cap = DEFAULT_MISSED_CAP,
  offsetFn: TimeZoneOffsetFn = deviceOffset,
): number[] {
  const out: number[] = [];
  let t = lastRunAt;
  while (out.length < cap) {
    const next = nextRunAt(trigger, t, offsetFn);
    if (next === null || next > now) break;
    out.push(next);
    t = next;
  }
  return out;
}

/** Number of occurrences missed between lastRunAt and now (capped). */
export function missedRuns(
  trigger: Trigger,
  lastRunAt: number,
  now: number,
  cap = DEFAULT_MISSED_CAP,
  offsetFn: TimeZoneOffsetFn = deviceOffset,
): number {
  if (trigger.type === 'interval') {
    if (now <= lastRunAt) return 0;
    const iv = Math.max(MIN_INTERVAL_MINUTES, trigger.minutes) * MINUTE_MS;
    return Math.min(cap, Math.floor((now - lastRunAt) / iv));
  }
  return missedRunTimes(trigger, lastRunAt, now, cap, offsetFn).length;
}

/** Short human description, e.g. "Daily 07:30 (Mon, Wed)". */
export function describeTrigger(t: Trigger): string {
  const names = ['Sun', 'Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat'];
  switch (t.type) {
    case 'daily':
      return t.days?.length && t.days.length < 7
        ? `Daily ${t.time} (${t.days.map(d => names[d]).join(', ')})`
        : `Daily ${t.time}`;
    case 'interval':
      return t.minutes % 60 === 0 ? `Every ${t.minutes / 60} h` : `Every ${t.minutes} min`;
    case 'once':
      return `Once at ${t.at}`;
  }
}
