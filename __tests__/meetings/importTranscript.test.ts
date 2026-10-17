import {
  detectSpeakers,
  formatAttendees,
  parseAttendees,
  parseTranscript,
} from '../../src/meetings/importTranscript';
import type { Attendee } from '../../src/meetings/types';
import { seg } from './fixtures';

const texts = (raw: string) => parseTranscript(raw).map(s => s.text);
const starts = (raw: string) => parseTranscript(raw).map(s => s.startMs);

describe('parseTranscript — plain paragraphs', () => {
  it('returns no segments for empty or whitespace input', () => {
    expect(parseTranscript('')).toEqual([]);
    expect(parseTranscript('\n\n   \n\t\n')).toEqual([]);
  });

  it('splits on blank lines into untimed segments that keep their order', () => {
    const raw = 'First paragraph about scope.\n\nSecond paragraph\ncontinues here.\n\n\nThird.';
    const segs = parseTranscript(raw);
    expect(segs.map(s => s.text)).toEqual([
      'First paragraph about scope.',
      'Second paragraph continues here.',
      'Third.',
    ]);
    expect(segs.map(s => s.index)).toEqual([0, 1, 2]);
    expect(segs.every(s => s.startMs === -1)).toBe(true);
    expect(segs.every(s => s.status === 'done' && s.speechRatio === 1)).toBe(true);
  });

  it('normalises CRLF line endings and collapses whitespace', () => {
    expect(texts('Hello   there\r\nfriend\r\n\r\nNext')).toEqual(['Hello there friend', 'Next']);
  });

  it('breaks a very long paragraph at a sentence end once it passes 400 chars', () => {
    const sentence = 'We discussed the migration plan in detail and agreed on the next milestone.';
    const raw = Array.from({ length: 12 }, () => sentence).join('\n');
    const segs = parseTranscript(raw);
    expect(segs.length).toBeGreaterThan(1);
    for (const s of segs) expect(s.text.length).toBeLessThan(400 + sentence.length + 2);
    expect(segs.map(s => s.text).join(' ')).toBe(Array(12).fill(sentence).join(' '));
  });
});

describe('parseTranscript — Zoom / Meet / Teams style', () => {
  it('reads leading [mm:ss] and hh:mm:ss timestamps, one segment per line', () => {
    const raw = [
      '[00:05] Rahul Mehta: Good morning everyone.',
      '[01:30] Priya: Morning! Shall we start?',
      '00:12:30 Rahul Mehta: Let us look at the budget.',
      '1:02:03 Priya: Wrapping up.',
    ].join('\n');
    const segs = parseTranscript(raw);
    expect(segs.map(s => s.text)).toEqual([
      'Rahul Mehta: Good morning everyone.',
      'Priya: Morning! Shall we start?',
      'Rahul Mehta: Let us look at the budget.',
      'Priya: Wrapping up.',
    ]);
    expect(segs.map(s => s.startMs)).toEqual([5_000, 90_000, 750_000, 3_723_000]);
  });

  it('reads "mm:ss Speaker: text" without brackets as minutes:seconds', () => {
    expect(starts('12:30 Speaker: text')).toEqual([750_000]);
  });

  it('attaches a timestamp-only line (Meet/Otter) to the text below it', () => {
    const raw = '00:01:02\nRahul: Hello there.\n\n[00:01:10]\nPriya: Hi Rahul.\nHow are you?';
    const segs = parseTranscript(raw);
    expect(segs.map(s => [s.startMs, s.text])).toEqual([
      [62_000, 'Rahul: Hello there.'],
      [70_000, 'Priya: Hi Rahul. How are you?'],
    ]);
  });

  it('keeps speaker prefixes in the text for attribution', () => {
    expect(texts('[00:01] Rahul Mehta: I will send it by Friday.')[0]).toMatch(/^Rahul Mehta: /);
  });

  it('timestamp reset after an untimed paragraph: following text is untimed again', () => {
    const segs = parseTranscript('[00:10] Timed line\nuntimed tail');
    expect(segs.map(s => [s.startMs, s.text])).toEqual([
      [10_000, 'Timed line'],
      [-1, 'untimed tail'],
    ]);
  });
});

describe('parseTranscript — WebVTT / SRT', () => {
  const vtt = [
    'WEBVTT',
    '',
    'NOTE exported by Zoom',
    '',
    '1',
    '00:00:01.000 --> 00:00:04.000',
    '<v Rahul Mehta>Hello everyone.</v>',
    '',
    '2',
    '00:00:05.500 --> 00:00:09.000',
    'Priya: Thanks Rahul,',
    'let us begin.',
    '',
    '3',
    '01:02:03.250 --> 01:02:06.000',
    'Closing remarks.',
  ].join('\n');

  it('uses cue start times, skips header/NOTE/cue numbers and strips voice tags', () => {
    const segs = parseTranscript(vtt);
    expect(segs.map(s => s.startMs)).toEqual([1_000, 5_000, 3_723_000]);
    expect(segs[1].text).toBe('Priya: Thanks Rahul, let us begin.');
    expect(segs[2].text).toBe('Closing remarks.');
    expect(segs.some(s => /WEBVTT|NOTE|-->|<\/?v/.test(s.text))).toBe(false);
    expect(segs.map(s => s.index)).toEqual([0, 1, 2]);
  });

  it('handles cues without an hour field and SRT comma milliseconds', () => {
    const raw =
      '1\n00:05.500 --> 00:07.000\nShort cue\n\n2\n00:00:12,000 --> 00:00:14,000\nSRT cue';
    expect(parseTranscript(raw).map(s => [s.startMs, s.text])).toEqual([
      [5_000, 'Short cue'],
      [12_000, 'SRT cue'],
    ]);
  });

  // DESIGN GAP (src/meetings/importTranscript.ts:62): the VTT voice tag is the
  // only place the speaker appears, and stripping `<v Rahul Mehta>` discards it,
  // although the module promises speaker prefixes are kept for attribution.
  it('keeps the VTT voice-tag speaker as a "Name:" prefix', () => {
    expect(parseTranscript(vtt)[0].text).toBe('Rahul Mehta: Hello everyone.');
  });
});

describe('parseAttendees', () => {
  it('parses the documented mixed example', () => {
    expect(parseAttendees('Rahul Mehta <rahul@acme.com>; Priya (Acme); ops@acme.com')).toEqual([
      { name: 'Rahul Mehta', email: 'rahul@acme.com', org: undefined },
      { name: 'Priya', email: undefined, org: 'Acme' },
      { name: 'Ops', email: 'ops@acme.com', org: undefined },
    ]);
  });

  it('splits on commas, semicolons and newlines', () => {
    expect(parseAttendees('Rahul, Priya\nAmit;  Neha ').map(a => a.name)).toEqual([
      'Rahul',
      'Priya',
      'Amit',
      'Neha',
    ]);
  });

  it('does not split on commas inside parentheses', () => {
    expect(parseAttendees('Priya (Acme, India), Rahul')).toEqual([
      { name: 'Priya', email: undefined, org: 'Acme, India' },
      { name: 'Rahul', email: undefined, org: undefined },
    ]);
  });

  it('reads name, org and email together in either order', () => {
    expect(parseAttendees('Rahul Mehta (Acme) <rahul@acme.com>')[0]).toEqual({
      name: 'Rahul Mehta',
      email: 'rahul@acme.com',
      org: 'Acme',
    });
    expect(parseAttendees('Rahul Mehta <rahul@acme.com> ( Acme Corp )')[0]).toEqual({
      name: 'Rahul Mehta',
      email: 'rahul@acme.com',
      org: 'Acme Corp',
    });
  });

  it('accepts a bare email after the name', () => {
    expect(parseAttendees('Rahul rahul.m@acme.co.in')[0]).toEqual({
      name: 'Rahul',
      email: 'rahul.m@acme.co.in',
      org: undefined,
    });
  });

  it('derives a title-cased name from an email-only entry', () => {
    expect(parseAttendees('<first.last-name@acme.com>')[0]).toEqual({
      name: 'First Last Name',
      email: 'first.last-name@acme.com',
      org: undefined,
    });
  });

  it('drops empty entries', () => {
    expect(parseAttendees('')).toEqual([]);
    expect(parseAttendees(' ; , \n ;')).toEqual([]);
  });
});

describe('formatAttendees', () => {
  it('renders "Name (Org) <email>" joined by "; "', () => {
    expect(
      formatAttendees([
        { name: 'Rahul Mehta', email: 'rahul@acme.com', org: 'Acme' },
        { name: 'Priya' },
        { name: 'Ops', email: 'ops@acme.com' },
      ]),
    ).toBe('Rahul Mehta (Acme) <rahul@acme.com>; Priya; Ops <ops@acme.com>');
  });

  it('returns an empty string for no attendees', () => {
    expect(formatAttendees([])).toBe('');
  });

  it('round-trips through parseAttendees', () => {
    const xs: Attendee[] = [
      { name: 'Rahul Mehta', email: 'rahul@acme.com', org: 'Acme' },
      { name: 'Priya', org: 'Acme, India' },
      { name: 'Ops Team', email: 'ops@acme.com' },
      { name: 'Neha' },
    ];
    expect(parseAttendees(formatAttendees(xs))).toEqual(xs);
    const again = formatAttendees(parseAttendees(formatAttendees(xs)));
    expect(again).toBe(formatAttendees(xs));
  });
});

describe('detectSpeakers', () => {
  it('returns names seen at least twice as "Name:" prefixes, most frequent first', () => {
    const segs = [
      seg(0, 'Priya: Hello.'),
      seg(1, 'Rahul Mehta: Hi.'),
      seg(2, 'Rahul Mehta: Agenda first.'),
      seg(3, 'Priya: Sure.'),
      seg(4, 'Rahul Mehta: Budget.'),
      seg(5, 'Amit: Once only.'),
      seg(6, 'no prefix here: lower case'),
    ];
    expect(detectSpeakers(segs)).toEqual(['Rahul Mehta', 'Priya']);
  });

  it('ignores names that are not at the start or have no space after the colon', () => {
    const segs = [
      seg(0, 'then Rahul: said'),
      seg(1, 'then Rahul: said again'),
      seg(2, 'Time 10:30 is fine'),
      seg(3, 'Rahul:nospace'),
      seg(4, 'Rahul:nospace'),
    ];
    expect(detectSpeakers(segs)).toEqual([]);
  });

  it('works end-to-end on a timestamped paste', () => {
    const raw = [
      '[00:01] Rahul Mehta: Hi.',
      '[00:05] Priya: Hello.',
      '[00:09] Rahul Mehta: Shall we start?',
      '[00:12] Priya: Yes.',
    ].join('\n');
    expect(detectSpeakers(parseTranscript(raw))).toEqual(['Rahul Mehta', 'Priya']);
  });

  // Regression (fixed; src/meetings/importTranscript.ts:62-63): untimed "Name: text"
  // lines without blank lines between them (the usual Zoom/Otter copy-paste)
  // are merged into one paragraph segment, so only the first speaker sits at a
  // segment start and detectSpeakers finds nobody.
  it('detects speakers in an untimed one-turn-per-line paste', () => {
    const raw = ['Rahul Mehta: Hi.', 'Priya: Hello.', 'Rahul Mehta: Start?', 'Priya: Yes.'].join(
      '\n',
    );
    expect(detectSpeakers(parseTranscript(raw))).toEqual(['Rahul Mehta', 'Priya']);
  });
});
