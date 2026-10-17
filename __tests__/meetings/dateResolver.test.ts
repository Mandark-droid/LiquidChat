import { resolveDue, toIsoDate } from '../../src/meetings/dateResolver';

/** Friday 16 Oct 2026, 10:00 local. */
const FRI = new Date(2026, 9, 16, 10, 0);
/** Monday 12 Oct 2026, 09:30 local. */
const MON = new Date(2026, 9, 12, 9, 30);
/** Sunday 18 Oct 2026. */
const SUN = new Date(2026, 9, 18, 18, 0);

const iso = (y: number, m: number, d: number) => toIsoDate(new Date(y, m - 1, d));

describe('toIsoDate', () => {
  it('formats local calendar fields with zero padding', () => {
    expect(toIsoDate(new Date(2026, 0, 5))).toBe('2026-01-05');
    expect(toIsoDate(new Date(2026, 11, 31, 23, 59))).toBe('2026-12-31');
  });

  it('uses local time, not UTC (late-evening local dates do not roll over)', () => {
    expect(toIsoDate(new Date(2026, 9, 16, 23, 59, 59))).toBe('2026-10-16');
    expect(toIsoDate(new Date(2026, 9, 16, 0, 0, 1))).toBe('2026-10-16');
  });
});

describe('resolveDue — empty and unknown input', () => {
  it.each([undefined, '', '   ', ',.', 'whenever', 'soon', 'later', 'when possible', 'TBD'])(
    '%p -> undefined',
    phrase => {
      expect(resolveDue(phrase, FRI)).toBeUndefined();
    },
  );

  it('does not mistake "in 3 days" style counts for month names', () => {
    expect(resolveDue('in 2 weeks', FRI)).toBe(iso(2026, 10, 30));
  });
});

describe('resolveDue — relative words (meeting on Friday 2026-10-16)', () => {
  it.each([
    ['today', iso(2026, 10, 16)],
    ['tonight', iso(2026, 10, 16)],
    ['EOD', iso(2026, 10, 16)],
    ['by end of day', iso(2026, 10, 16)],
    ['by end of the day', iso(2026, 10, 16)],
    ['ASAP', iso(2026, 10, 16)],
    ['immediately', iso(2026, 10, 16)],
    ['tomorrow', iso(2026, 10, 17)],
    ['by tomorrow.', iso(2026, 10, 17)],
    ['day after tomorrow', iso(2026, 10, 18)],
    ['in 3 days', iso(2026, 10, 19)],
    ['in a day', iso(2026, 10, 17)],
    ['in one week', iso(2026, 10, 23)],
    ['in two weeks', iso(2026, 10, 30)],
    ['in four days', iso(2026, 10, 20)],
    ['in a month', iso(2026, 11, 16)],
    ['in 3 months', iso(2027, 1, 16)],
    ['next week', iso(2026, 10, 19)],
    ['end of this week', iso(2026, 10, 16)],
    ['EOW', iso(2026, 10, 16)],
    ['this week', iso(2026, 10, 16)],
    ['end of month', iso(2026, 10, 31)],
    ['by end of the month', iso(2026, 10, 31)],
    ['EOM', iso(2026, 10, 31)],
    ['month end', iso(2026, 10, 31)],
    ['next month', iso(2026, 11, 1)],
  ])('%p -> %s', (phrase, expected) => {
    expect(resolveDue(phrase, FRI)).toBe(expected);
  });

  it('ignores the time of day of the meeting', () => {
    expect(resolveDue('tomorrow', new Date(2026, 9, 16, 23, 59))).toBe(iso(2026, 10, 17));
    expect(resolveDue('tomorrow', new Date(2026, 9, 16, 0, 1))).toBe(iso(2026, 10, 17));
  });

  it('crosses month and year boundaries', () => {
    expect(resolveDue('tomorrow', new Date(2026, 11, 31, 12))).toBe(iso(2027, 1, 1));
    expect(resolveDue('in 3 days', new Date(2026, 1, 27, 12))).toBe(iso(2026, 3, 2));
    expect(resolveDue('end of month', new Date(2028, 1, 10))).toBe(iso(2028, 2, 29));
    expect(resolveDue('next month', new Date(2026, 11, 5))).toBe(iso(2027, 1, 1));
  });
});

describe('resolveDue — weekdays', () => {
  it.each([
    // Said on a Friday: a bare weekday means the next occurrence, never today.
    ['by Friday', FRI, iso(2026, 10, 23)],
    ['Friday', FRI, iso(2026, 10, 23)],
    ['Monday', FRI, iso(2026, 10, 19)],
    ['by Thursday', FRI, iso(2026, 10, 22)],
    ['this Monday', FRI, iso(2026, 10, 19)],
    ['coming Tuesday', FRI, iso(2026, 10, 20)],
    ['next Monday', FRI, iso(2026, 10, 19)],
    ['next Friday', FRI, iso(2026, 10, 23)],
    // Said on a Monday: "Friday" is this week's, "next Friday" is next week's.
    ['Friday', MON, iso(2026, 10, 16)],
    ['next Friday', MON, iso(2026, 10, 23)],
    ['next Wednesday', MON, iso(2026, 10, 21)],
    ['next Monday', MON, iso(2026, 10, 19)],
    // Said on a Sunday: Monday is tomorrow.
    ['next Monday', SUN, iso(2026, 10, 19)],
    ['Saturday', SUN, iso(2026, 10, 24)],
  ])('%p said on %s -> %s', (phrase, base, expected) => {
    expect(resolveDue(phrase, base)).toBe(expected);
  });

  it('"end of next week" said on a Monday is the Friday of next week', () => {
    expect(resolveDue('end of next week', MON)).toBe(iso(2026, 10, 23));
  });

  // Regression (fixed; src/meetings/dateResolver.ts:92-93): "end of next week" is computed as
  // nextWeekday(base, Friday) + 7. When the meeting itself is on a Friday,
  // nextWeekday already jumps a full week (delta 0 -> 7), so the result lands
  // two Fridays out (2026-10-30) instead of the Friday of next week
  // (2026-10-23). It also contradicts "next week" -> Monday 2026-10-19.
  it('"end of next week" said on a Friday is the following Friday', () => {
    expect(resolveDue('end of next week', FRI)).toBe(iso(2026, 10, 23));
  });
});

describe('resolveDue — explicit dates', () => {
  it.each([
    ['24 Oct', iso(2026, 10, 24)],
    ['by 24th Oct', iso(2026, 10, 24)],
    ['24th of October', iso(2026, 10, 24)],
    ['Oct 24', iso(2026, 10, 24)],
    ['October 24th', iso(2026, 10, 24)],
    ['2nd of November', iso(2026, 11, 2)],
    ['Friday, 6 Nov', iso(2026, 11, 6)],
    ['2026-11-03', iso(2026, 11, 3)],
    ['due 2027-1-9', iso(2027, 1, 9)],
    ['24 Oct 2027', iso(2027, 10, 24)],
    ['24 Oct 27', iso(2027, 10, 24)],
    // Numeric dates are day-first (Indian usage).
    ['24/10', iso(2026, 10, 24)],
    ['03/11/2026', iso(2026, 11, 3)],
    ['3-11-26', iso(2026, 11, 3)],
  ])('%p -> %s', (phrase, expected) => {
    expect(resolveDue(phrase, FRI)).toBe(expected);
  });

  it('rolls a month/day without year into next year when it is well in the past', () => {
    expect(resolveDue('Jan 5', FRI)).toBe(iso(2027, 1, 5));
    expect(resolveDue('1 Oct', FRI)).toBe(iso(2027, 10, 1));
  });

  it('keeps the current year for dates up to 14 days before the meeting', () => {
    expect(resolveDue('5 Oct', FRI)).toBe(iso(2026, 10, 5));
    expect(resolveDue('2 Oct', FRI)).toBe(iso(2026, 10, 2));
  });

  it('rejects out-of-range numeric parts', () => {
    expect(resolveDue('45/10', FRI)).toBeUndefined();
    expect(resolveDue('10/13', FRI)).toBeUndefined();
    expect(resolveDue('0 Oct', FRI)).toBeUndefined();
  });

  it('an explicit date wins over a relative word in the same phrase', () => {
    expect(resolveDue('next week, say 21 Oct', FRI)).toBe(iso(2026, 10, 21));
  });

  // Regression (fixed; src/meetings/dateResolver.ts:37-46 and :56-57): impossible calendar
  // dates are not rejected — `new Date(y, 1, 31)` silently rolls over to
  // 3 March, so "31 Feb" resolves to 2027-03-03 and "2026-02-30" to 2026-03-02.
  // The module promises "undefined when unsure"; a nonexistent date should miss.
  it('returns undefined for impossible dates like "31 Feb"', () => {
    expect(resolveDue('31 Feb', FRI)).toBeUndefined();
    expect(resolveDue('2026-02-30', FRI)).toBeUndefined();
  });
});

describe('resolveDue — business days', () => {
  it('skips the weekend for "next business day"', () => {
    // Friday 16 Oct 2026 → Monday 19 Oct; Saturday 17 Oct → Monday 19 Oct.
    expect(resolveDue('next business day', new Date(2026, 9, 16))).toBe('2026-10-19');
    expect(resolveDue('by the next working day', new Date(2026, 9, 17))).toBe('2026-10-19');
    expect(resolveDue('next work day', new Date(2026, 9, 14))).toBe('2026-10-15');
  });
});
