/**
 * Resolves spoken deadlines ("by Friday", "end of next week", "20th Oct")
 * against the meeting date. Returns YYYY-MM-DD or undefined when unsure —
 * the raw phrase is always kept alongside, so a miss is never destructive.
 * Numeric dates are read day-first (DD/MM), matching Indian usage.
 */

const WEEKDAYS = ['sunday', 'monday', 'tuesday', 'wednesday', 'thursday', 'friday', 'saturday'];
const MONTHS = ['jan', 'feb', 'mar', 'apr', 'may', 'jun', 'jul', 'aug', 'sep', 'oct', 'nov', 'dec'];

export function toIsoDate(d: Date): string {
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`;
}

function addDays(d: Date, n: number): Date {
  const x = new Date(d.getFullYear(), d.getMonth(), d.getDate());
  x.setDate(x.getDate() + n);
  return x;
}

function nextWeekday(from: Date, wd: number, forceNextWeek: boolean): Date {
  let delta = (wd - from.getDay() + 7) % 7;
  if (delta === 0) delta = 7;
  if (forceNextWeek && delta < 7) {
    // "next Friday" said on a Monday means the Friday of next week.
    const daysToMonday = (8 - from.getDay()) % 7 || 7;
    if (delta < daysToMonday) delta += 7;
  }
  return addDays(from, delta);
}

function monthIndex(token: string): number {
  return MONTHS.indexOf(token.slice(0, 3).toLowerCase());
}

/** Picks the year that puts the date on/after the meeting (deadlines are future). */
function withYear(base: Date, month: number, day: number, year?: number): Date | undefined {
  if (month < 0 || month > 11 || day < 1 || day > 31) return undefined;
  if (year !== undefined) {
    const y = year < 100 ? 2000 + year : year;
    return new Date(y, month, day);
  }
  const d = new Date(base.getFullYear(), month, day);
  if (d.getTime() < addDays(base, -14).getTime()) d.setFullYear(d.getFullYear() + 1);
  return d;
}

export function resolveDue(phrase: string | undefined, meetingDate: Date): string | undefined {
  if (!phrase) return undefined;
  const p = phrase.toLowerCase().replace(/[,.]/g, ' ').replace(/\s+/g, ' ').trim();
  if (!p) return undefined;
  const base = new Date(meetingDate.getFullYear(), meetingDate.getMonth(), meetingDate.getDate());

  let m: RegExpMatchArray | null;

  if ((m = p.match(/\b(\d{4})-(\d{1,2})-(\d{1,2})\b/))) {
    return toIsoDate(new Date(+m[1], +m[2] - 1, +m[3]));
  }
  if (
    (m = p.match(/\b(\d{1,2})(?:st|nd|rd|th)?(?: of)? ([a-z]{3,9})(?: (\d{2,4}))?\b/)) &&
    monthIndex(m[2]) >= 0
  ) {
    const d = withYear(base, monthIndex(m[2]), +m[1], m[3] ? +m[3] : undefined);
    return d ? toIsoDate(d) : undefined;
  }
  if (
    (m = p.match(/\b([a-z]{3,9}) (\d{1,2})(?:st|nd|rd|th)?(?: (\d{2,4}))?\b/)) &&
    monthIndex(m[1]) >= 0
  ) {
    const d = withYear(base, monthIndex(m[1]), +m[2], m[3] ? +m[3] : undefined);
    return d ? toIsoDate(d) : undefined;
  }
  if ((m = p.match(/\b(\d{1,2})[/-](\d{1,2})(?:[/-](\d{2,4}))?\b/))) {
    const d = withYear(base, +m[2] - 1, +m[1], m[3] ? +m[3] : undefined);
    return d ? toIsoDate(d) : undefined;
  }

  if (/\b(today|tonight|eod|end of (the )?day|asap|immediately)\b/.test(p)) return toIsoDate(base);
  if (/\bday after tomorrow\b/.test(p)) return toIsoDate(addDays(base, 2));
  if (/\btomorrow\b/.test(p)) return toIsoDate(addDays(base, 1));

  if ((m = p.match(/\bin (\d+|a|one|two|three|four) (day|week|month)s?\b/))) {
    const words: Record<string, number> = { a: 1, one: 1, two: 2, three: 3, four: 4 };
    const n = words[m[1]] ?? +m[1];
    if (m[2] === 'day') return toIsoDate(addDays(base, n));
    if (m[2] === 'week') return toIsoDate(addDays(base, 7 * n));
    const d = new Date(base);
    d.setMonth(d.getMonth() + n);
    return toIsoDate(d);
  }

  if (/\bend of (the )?next week\b/.test(p))
    return toIsoDate(addDays(nextWeekday(base, 5, false), 7));
  if (/\b(end of (the |this )?week|eow|this week)\b/.test(p)) {
    const fri = (5 - base.getDay() + 7) % 7;
    return toIsoDate(addDays(base, fri));
  }
  if (/\bnext week\b/.test(p)) return toIsoDate(nextWeekday(base, 1, false));
  if (/\b(end of (the |this )?month|eom|month end)\b/.test(p)) {
    return toIsoDate(new Date(base.getFullYear(), base.getMonth() + 1, 0));
  }
  if (/\bnext month\b/.test(p))
    return toIsoDate(new Date(base.getFullYear(), base.getMonth() + 1, 1));

  for (let i = 0; i < 7; i++) {
    const re = new RegExp(`\\b(next |coming |this )?${WEEKDAYS[i]}\\b`);
    if ((m = p.match(re))) {
      return toIsoDate(nextWeekday(base, i, (m[1] ?? '').trim() === 'next'));
    }
  }
  return undefined;
}
