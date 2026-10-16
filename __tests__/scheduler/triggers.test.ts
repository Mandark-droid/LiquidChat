/**
 * Jest workers don't re-read process.env.TZ for Date, so each zone is applied
 * through the injectable offset function built from process.env.TZ.
 */
import {
  describeTrigger,
  deviceOffset,
  missedRuns,
  missedRunTimes,
  nextRunAt,
  normalizeTrigger,
  offsetFnForZone,
  type TimeZoneOffsetFn,
  validateTrigger,
  wallToUtc,
} from '../../src/scheduler/triggers';

const MIN = 60_000;
const HOUR = 60 * MIN;
const DAY = 24 * HOUR;
const iso = (ms: number | null) => (ms === null ? null : new Date(ms).toISOString());

function zone(tz: string): TimeZoneOffsetFn {
  process.env.TZ = tz;
  return offsetFnForZone(process.env.TZ);
}

describe('validation', () => {
  test.each([
    [{ type: 'daily', time: '07:30' }, true],
    [{ type: 'daily', time: '7:05', days: [1, 3] }, true],
    [{ type: 'daily', time: '24:00' }, false],
    [{ type: 'daily', time: '07:30', days: [] }, false],
    [{ type: 'daily', time: '07:30', days: [7] }, false],
    [{ type: 'interval', minutes: 15 }, true],
    [{ type: 'interval', minutes: 14 }, false],
    [{ type: 'once', at: '2026-10-20T09:00:00+05:30' }, true],
    [{ type: 'once', at: 'soon' }, false],
    [{ type: 'weekly' }, false],
    [null, false],
  ])('%j valid=%s', (t, ok) => {
    expect(validateTrigger(t).length === 0).toBe(ok);
  });

  test('normalize pads time and sorts days', () => {
    expect(normalizeTrigger({ type: 'daily', time: '7:05', days: [5, 1, 5] })).toEqual({
      type: 'daily',
      time: '07:05',
      days: [1, 5],
    });
    expect(() => normalizeTrigger({ type: 'interval', minutes: 5 })).toThrow(/>= 15/);
    expect(describeTrigger({ type: 'daily', time: '07:05', days: [1, 5] })).toBe(
      'Daily 07:05 (Mon, Fri)',
    );
    expect(describeTrigger({ type: 'interval', minutes: 120 })).toBe('Every 2 h');
  });
});

describe('Asia/Kolkata (no DST)', () => {
  const off = zone('Asia/Kolkata');

  test('offset is +05:30', () => {
    expect(off(Date.UTC(2026, 0, 1))).toBe(330);
    expect(off(Date.UTC(2026, 6, 1))).toBe(330);
  });

  test('daily: later today, or tomorrow once passed', () => {
    const from = Date.parse('2026-10-17T06:00:00+05:30');
    expect(iso(nextRunAt({ type: 'daily', time: '07:30' }, from, off))).toBe(
      '2026-10-17T02:00:00.000Z',
    );
    const after = Date.parse('2026-10-17T07:30:00+05:30'); // exactly at → strictly after
    expect(iso(nextRunAt({ type: 'daily', time: '07:30' }, after, off))).toBe(
      '2026-10-18T02:00:00.000Z',
    );
  });

  test('daily across local midnight uses the local date, not UTC', () => {
    // 23:00 UTC on the 16th is 04:30 IST on the 17th.
    const from = Date.UTC(2026, 9, 16, 23, 0);
    expect(iso(nextRunAt({ type: 'daily', time: '05:00' }, from, off))).toBe(
      '2026-10-16T23:30:00.000Z',
    );
  });

  test('daily with weekdays (2026-10-17 is a Saturday)', () => {
    const from = Date.parse('2026-10-17T09:00:00+05:30');
    const t = { type: 'daily' as const, time: '08:00', days: [1, 3] as (1 | 3)[] };
    expect(iso(nextRunAt(t, from, off))).toBe('2026-10-19T02:30:00.000Z'); // Mon 08:00 IST
    const wed = Date.parse('2026-10-19T08:00:00+05:30');
    expect(iso(nextRunAt(t, wed, off))).toBe('2026-10-21T02:30:00.000Z');
  });

  test('interval and once', () => {
    const from = Date.parse('2026-10-17T09:00:00+05:30');
    expect(nextRunAt({ type: 'interval', minutes: 30 }, from, off)).toBe(from + 30 * MIN);
    const once = { type: 'once' as const, at: '2026-10-18T10:00:00+05:30' };
    expect(nextRunAt(once, from, off)).toBe(Date.parse(once.at));
    expect(nextRunAt(once, Date.parse(once.at), off)).toBeNull();
  });

  test('missedRuns counts occurrences between last run and now, capped', () => {
    const last = Date.parse('2026-10-10T07:30:00+05:30');
    const now = Date.parse('2026-10-17T08:00:00+05:30');
    const daily = { type: 'daily' as const, time: '07:30' };
    expect(missedRuns(daily, last, now, 100, off)).toBe(7);
    expect(missedRuns(daily, last, now, 3, off)).toBe(3);
    expect(missedRuns(daily, now, now, 100, off)).toBe(0);
    expect(missedRuns({ type: 'interval', minutes: 60 }, last, last + 5.5 * HOUR)).toBe(5);
    expect(missedRuns({ type: 'interval', minutes: 15 }, last, last + 30 * DAY, 50)).toBe(50);
    const once = { type: 'once' as const, at: '2026-10-12T10:00:00+05:30' };
    expect(missedRuns(once, last, now, 100, off)).toBe(1);
    expect(missedRunTimes(daily, last, now, 2, off).map(iso)).toEqual([
      '2026-10-11T02:00:00.000Z',
      '2026-10-12T02:00:00.000Z',
    ]);
  });
});

describe('America/New_York around DST', () => {
  const off = zone('America/New_York');

  test('offsets switch on 2026-03-08 and 2026-11-01', () => {
    expect(off(Date.UTC(2026, 2, 8, 6, 59))).toBe(-300);
    expect(off(Date.UTC(2026, 2, 8, 7, 0))).toBe(-240);
    expect(off(Date.UTC(2026, 10, 1, 5, 59))).toBe(-240);
    expect(off(Date.UTC(2026, 10, 1, 6, 0))).toBe(-300);
  });

  test('daily 07:00 keeps local wall time across spring-forward (23 h day)', () => {
    const t = { type: 'daily' as const, time: '07:00' };
    const sat = nextRunAt(t, Date.parse('2026-03-07T06:00:00-05:00'), off) as number;
    expect(iso(sat)).toBe('2026-03-07T12:00:00.000Z'); // 07:00 EST
    const sun = nextRunAt(t, sat, off) as number;
    expect(iso(sun)).toBe('2026-03-08T11:00:00.000Z'); // 07:00 EDT
    expect(sun - sat).toBe(23 * HOUR);
  });

  test('daily 07:00 keeps local wall time across fall-back (25 h day)', () => {
    const t = { type: 'daily' as const, time: '07:00' };
    const sat = Date.parse('2026-10-31T07:00:00-04:00');
    const sun = nextRunAt(t, sat, off) as number;
    expect(iso(sun)).toBe('2026-11-01T12:00:00.000Z'); // 07:00 EST
    expect(sun - sat).toBe(25 * HOUR);
  });

  test('nonexistent 02:30 on spring-forward day runs at 03:30 EDT', () => {
    const t = { type: 'daily' as const, time: '02:30' };
    const r = nextRunAt(t, Date.parse('2026-03-08T00:00:00-05:00'), off);
    expect(iso(r)).toBe('2026-03-08T07:30:00.000Z'); // 03:30 EDT
    // and the following day is back to 02:30 EDT
    expect(iso(nextRunAt(t, r as number, off))).toBe('2026-03-09T06:30:00.000Z');
  });

  test('repeated 01:30 on fall-back day runs once, at the first occurrence', () => {
    const t = { type: 'daily' as const, time: '01:30' };
    const first = nextRunAt(t, Date.parse('2026-11-01T00:00:00-04:00'), off) as number;
    expect(iso(first)).toBe('2026-11-01T05:30:00.000Z'); // 01:30 EDT
    const next = nextRunAt(t, first, off) as number;
    expect(iso(next)).toBe('2026-11-02T06:30:00.000Z'); // skips 01:30 EST same night
  });

  test('wallToUtc resolves gaps and overlaps deterministically', () => {
    expect(iso(wallToUtc(Date.UTC(2026, 2, 8, 2, 30), off))).toBe('2026-03-08T07:30:00.000Z');
    expect(iso(wallToUtc(Date.UTC(2026, 10, 1, 1, 30), off))).toBe('2026-11-01T05:30:00.000Z');
  });

  test('missedRuns across DST counts calendar days, not 24 h blocks', () => {
    const t = { type: 'daily' as const, time: '07:00' };
    const last = Date.parse('2026-03-06T07:00:00-05:00');
    const now = Date.parse('2026-03-10T07:00:00-04:00');
    expect(missedRuns(t, last, now, 100, off)).toBe(4); // 7th, 8th, 9th, 10th
  });

  test('timezone change: same trigger recomputed in a new zone', () => {
    const t = { type: 'daily' as const, time: '09:00' };
    const from = Date.UTC(2026, 9, 17, 0, 0);
    const ny = nextRunAt(t, from, off);
    const ist = nextRunAt(t, from, zone('Asia/Kolkata'));
    expect(iso(ny)).toBe('2026-10-17T13:00:00.000Z');
    expect(iso(ist)).toBe('2026-10-17T03:30:00.000Z');
  });
});

test('default offset function follows the runtime zone', () => {
  const now = Date.UTC(2026, 9, 17, 12);
  expect(deviceOffset(now)).toBe(-new Date(now).getTimezoneOffset());
  const r = nextRunAt({ type: 'daily', time: '10:15' }, now) as number;
  const d = new Date(r);
  expect([d.getHours(), d.getMinutes()]).toEqual([10, 15]);
  expect(r).toBeGreaterThan(now);
  expect(r - now).toBeLessThanOrEqual(DAY + HOUR);
});
