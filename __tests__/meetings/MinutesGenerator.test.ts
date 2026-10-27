import * as RNFS from '@dr.pogodin/react-native-fs';

import { toIsoDate } from '../../src/meetings/dateResolver';
import { meetingStore } from '../../src/meetings/MeetingStore';
import {
  chooseSummaryModel,
  defaultTitle,
  extractJson,
  formatClock,
  generateMinutes,
  mergePartials,
  type PartialMinutes,
  transcriptLines,
  transcriptPlain,
} from '../../src/meetings/MinutesGenerator';
import type { Meeting } from '../../src/meetings/types';
import { modelLifecycle } from '../../src/services/ModelLifecycleManager';
import { action, makeMeeting, MEETING_DATE, MEETING_TS, runSourceInChild, seg } from './fixtures';

jest.mock('../../src/services/ModelLifecycleManager', () => ({
  modelLifecycle: { ensure: jest.fn(), getLoadedModels: () => [], getRamBudgetMb: () => 0 },
}));
jest.mock('../../src/utils/engineMigration', () => ({
  listDownloadedCactusModels: async () =>
    ['lfm', 'lfm2.5-1.2b-instruct', 'broken-model'].map(slug => ({ slug })),
}));

const ensure = modelLifecycle.ensure as jest.Mock;

// ---------------------------------------------------------------------------
// extractJson

describe('extractJson', () => {
  it('parses a bare object', () => {
    expect(extractJson('{"title":"Kickoff","n":2}')).toEqual({ title: 'Kickoff', n: 2 });
  });

  it('parses a ```json fenced block', () => {
    expect(extractJson('```json\n{"a": [1, 2]}\n```')).toEqual({ a: [1, 2] });
    expect(extractJson('```\n{"a": true}\n```')).toEqual({ a: true });
  });

  it('skips leading prose and trailing junk (including a second object)', () => {
    expect(
      extractJson('Sure! Here are the minutes:\n{"summary": "ok"}\nHope this helps {"x": 1}'),
    ).toEqual({ summary: 'ok' });
  });

  it('removes <think> blocks before parsing', () => {
    expect(extractJson('<think>maybe {"wrong": 1}</think>{"right": 2}')).toEqual({ right: 2 });
  });

  it('ignores braces and escaped quotes inside strings', () => {
    expect(extractJson('{"t": "a } b { c", "q": "he said \\"hi\\""} tail}')).toEqual({
      t: 'a } b { c',
      q: 'he said "hi"',
    });
  });

  it('repairs trailing commas, unquoted keys, single quotes and smart quotes', () => {
    expect(extractJson('{"a": [1, 2,], "b": 3,}')).toEqual({ a: [1, 2], b: 3 });
    expect(extractJson('{title: "x", key_points: ["y"]}')).toEqual({
      title: 'x',
      key_points: ['y'],
    });
    expect(extractJson("{'title': 'x', 'list': ['a', 'b']}")).toEqual({
      title: 'x',
      list: ['a', 'b'],
    });
    expect(extractJson('{“title”: “Smart”}')).toEqual({ title: 'Smart' });
  });

  it('closes output truncated by maxTokens', () => {
    expect(extractJson('{"title": "Kickoff", "key_points": ["one", "two"')).toEqual({
      title: 'Kickoff',
      key_points: ['one', 'two'],
    });
    expect(extractJson('{"title": "Kick')).toEqual({ title: 'Kick' });
    expect(extractJson('{"a": {"b": [1, {"c": 2},')).toEqual({ a: { b: [1, { c: 2 }] } });
  });

  it.each(['', 'no json here', 'Decisions: none', '{not json at all}', '{"a": }', '[1, 2, 3]'])(
    'returns null for %p',
    raw => {
      expect(extractJson(raw)).toBeNull();
    },
  );
});

// ---------------------------------------------------------------------------
// mergePartials

const partial = (over: Partial<PartialMinutes> = {}): PartialMinutes => ({
  title: '',
  summary: '',
  keyPoints: [],
  decisions: [],
  actionItems: [],
  openQuestions: [],
  nextSteps: [],
  ...over,
});

describe('mergePartials', () => {
  it('returns empty lists for no parts', () => {
    expect(mergePartials([])).toEqual(partial());
  });

  it('takes the first non-empty title and joins summaries with newlines', () => {
    const merged = mergePartials([
      partial({ summary: 'Part one.' }),
      partial({ title: 'Acme kickoff', summary: '' }),
      partial({ title: 'Later title', summary: 'Part three.' }),
    ]);
    expect(merged.title).toBe('Acme kickoff');
    expect(merged.summary).toBe('Part one.\nPart three.');
  });

  it('fuzzy-dedupes list items across windows, keeping the first wording', () => {
    const merged = mergePartials([
      partial({
        keyPoints: ['Budget for phase one is 20 lakh', 'Timeline is twelve weeks'],
        decisions: ['Go with the fixed price model'],
        openQuestions: ['Who signs the SOW?'],
        nextSteps: ['Share SOW draft'],
      }),
      partial({
        keyPoints: ['The budget for phase one is 20 lakh.', 'Hiring two engineers'],
        decisions: ['Go with the fixed-price model.', 'Weekly status calls on Monday'],
        openQuestions: ['who signs the sow'],
        nextSteps: ['Share the SOW draft'],
      }),
    ]);
    expect(merged.keyPoints).toEqual([
      'Budget for phase one is 20 lakh',
      'Timeline is twelve weeks',
      'Hiring two engineers',
    ]);
    expect(merged.decisions).toEqual([
      'Go with the fixed price model',
      'Weekly status calls on Monday',
    ]);
    expect(merged.openQuestions).toEqual(['Who signs the SOW?']);
    expect(merged.nextSteps).toEqual(['Share SOW draft']);
  });

  it('dedupes within a single window too, and compares short items exactly', () => {
    expect(mergePartials([partial({ keyPoints: ['OK', 'ok', 'Go', 'No'] })]).keyPoints).toEqual([
      'OK',
      'Go',
      'No',
    ]);
  });

  it('merges duplicate action items, filling owner/due/priority from later windows', () => {
    const first = partial({ actionItems: [{ task: 'Send the revised proposal to Acme' }] });
    const second = partial({
      actionItems: [
        {
          task: 'Send revised proposal to Acme by Friday',
          owner: 'Priya',
          due: 'by Friday',
          priority: 'high',
        },
        { task: 'Book the follow-up call', owner: 'Rahul' },
      ],
    });
    const merged = mergePartials([first, second]);
    expect(merged.actionItems).toEqual([
      {
        task: 'Send the revised proposal to Acme',
        owner: 'Priya',
        due: 'by Friday',
        priority: 'high',
      },
      { task: 'Book the follow-up call', owner: 'Rahul' },
    ]);
    // Inputs are not mutated.
    expect(first.actionItems[0]).toEqual({ task: 'Send the revised proposal to Acme' });
  });

  // Regression (fixed; src/meetings/MinutesGenerator.ts:301-317, tokens/similar): tokens of
  // <= 2 chars are dropped, so numbers like "20" and "50" vanish and two
  // different facts that differ only in a figure are treated as duplicates —
  // the second decision is silently lost from the minutes.
  it('does not merge items that differ only in a number', () => {
    const merged = mergePartials([
      partial({ decisions: ['Budget is 20 lakh'] }),
      partial({ decisions: ['Budget is 50 lakh'] }),
    ]);
    expect(merged.decisions).toEqual(['Budget is 20 lakh', 'Budget is 50 lakh']);
  });

  it('keeps the first owner when both windows name one', () => {
    const merged = mergePartials([
      partial({ actionItems: [{ task: 'Prepare the demo environment', owner: 'Amit' }] }),
      partial({ actionItems: [{ task: 'Prepare demo environment', owner: 'Neha' }] }),
    ]);
    expect(merged.actionItems).toEqual([{ task: 'Prepare the demo environment', owner: 'Amit' }]);
  });
});

// ---------------------------------------------------------------------------
// formatClock / transcriptLines / defaultTitle

describe('formatClock', () => {
  it.each([
    [0, '00:00'],
    [999, '00:00'],
    [59_999, '00:59'],
    [65_000, '01:05'],
    [3_599_000, '59:59'],
    [3_600_000, '1:00:00'],
    [3_723_000, '1:02:03'],
    [36_000_000, '10:00:00'],
    [-5_000, '00:00'],
  ])('%p ms -> %p', (ms, expected) => {
    expect(formatClock(ms)).toBe(expected);
  });
});

describe('transcriptLines', () => {
  it('prefixes timed segments with [mm:ss] and interleaves user markers by time', () => {
    const m = makeMeeting({
      segments: [seg(0, 'Opening.', 0), seg(1, 'Budget talk.', 65_000), seg(2, 'Wrap.', 3_723_000)],
      markers: [
        { atMs: 70_000, note: 'Key number' },
        { atMs: 10_000, note: '' },
      ],
    });
    expect(transcriptLines(m)).toEqual([
      '[00:00] Opening.',
      '[00:10] ★ FLAGGED BY USER: important moment',
      '[01:05] Budget talk.',
      '[01:10] ★ FLAGGED BY USER: Key number',
      '[1:02:03] Wrap.',
    ]);
  });

  it('keeps untimed (startMs < 0) imported segments in order without a clock', () => {
    const m = makeMeeting({
      segments: [seg(0, 'Rahul: First.', -1), seg(1, 'Priya: Second.', -1), seg(2, 'Third.', -1)],
      markers: [],
    });
    expect(transcriptLines(m)).toEqual(['Rahul: First.', 'Priya: Second.', 'Third.']);
  });

  it('skips segments that are not done or have no text', () => {
    const m = makeMeeting({
      segments: [
        seg(0, 'Kept.', 0),
        { ...seg(1, 'Pending.', 30_000), status: 'pending' },
        { ...seg(2, 'Skipped.', 60_000), status: 'skipped' },
        { ...seg(3, 'Errored.', 90_000), status: 'error' },
        seg(4, '', 120_000),
      ],
      markers: [],
    });
    expect(transcriptLines(m)).toEqual(['[00:00] Kept.']);
    expect(transcriptPlain(m)).toBe('[00:00] Kept.');
  });

  it('transcriptPlain joins lines with newlines', () => {
    const m = makeMeeting({ segments: [seg(0, 'A.', 0), seg(1, 'B.', 1_000)], markers: [] });
    expect(transcriptPlain(m)).toBe('[00:00] A.\n[00:01] B.');
  });
});

describe('defaultTitle', () => {
  it('uses "Meeting · <day> <Mon>" without a client', () => {
    expect(defaultTitle(MEETING_TS)).toBe('Meeting · 16 Oct');
  });

  it('uses the client name when given', () => {
    expect(defaultTitle(MEETING_TS, 'Acme')).toBe('Acme · 16 Oct');
    expect(defaultTitle(new Date(2027, 0, 3, 9).getTime(), 'Globex')).toBe('Globex · 3 Jan');
  });
});

// ---------------------------------------------------------------------------
// generateMinutes with a fake LM

type Msg = { role: string; content: string };
interface CompleteArgs {
  messages: Msg[];
  options: { maxTokens: number; temperature: number };
}

function fakeLM(respond: (user: string, call: number) => string) {
  const calls: CompleteArgs[] = [];
  const lm = {
    reset: jest.fn(async () => {}),
    complete: jest.fn(async (args: CompleteArgs) => {
      calls.push(args);
      return {
        response: respond(args.messages[args.messages.length - 1].content, calls.length - 1),
      };
    }),
  };
  ensure.mockResolvedValue({ instance: lm });
  return { lm, calls, prompts: () => calls.map(c => c.messages[c.messages.length - 1].content) };
}

async function stored(over: Partial<Meeting>): Promise<Meeting> {
  const m = makeMeeting({ minutes: undefined, actionItems: [], ...over });
  await meetingStore.create(m);
  return m;
}

const WORDS = ['zero', 'alpha', 'bravo', 'charlie', 'delta', 'echo', 'foxtrot'];
const mapJson = (o: Record<string, unknown>) => '```json\n' + JSON.stringify(o) + '\n```';

describe('generateMinutes', () => {
  beforeEach(() => {
    ensure.mockReset();
  });

  it('single window: one minutes call plus the action-item pass, normalised fields, resolved due dates, saved to disk', async () => {
    const m = await stored({ title: defaultTitle(MEETING_TS, 'Acme') });
    const { lm, calls, prompts } = fakeLM(() =>
      mapJson({
        title: 'Acme proposal review',
        summary: '  We reviewed the proposal.  ',
        key_points: ['Scope agreed', { text: 'Budget is 20 lakh' }, '  '],
        decisions: ['Fixed price'],
        action_items: [
          { task: 'Send revised proposal', owner: 'Priya', due: 'by Friday', priority: 'HIGH' },
          { action: 'Book follow-up call', assignee: 'none', deadline: 'N/A', priority: 'urgent' },
          'Share SOW draft',
          { task: '   ' },
        ],
        open_questions: ['Who signs?'],
        next_steps: [],
      }),
    );
    const progress: [string, number][] = [];

    const out = await generateMinutes(m.id, 'lfm2.5-1.2b-instruct', (s, f) =>
      progress.push([s, f]),
    );

    expect(ensure).toHaveBeenCalledWith('lfm2.5-1.2b-instruct');
    expect(lm.complete).toHaveBeenCalledTimes(2); // minutes + focused action items
    expect(lm.reset).toHaveBeenCalledTimes(2);
    expect(calls[0].messages[0].role).toBe('system');
    expect(calls[0].messages[0].content).toMatch(/single JSON object/);
    expect(calls[0].options.maxTokens).toBe(900);
    expect(calls[0].options.temperature).toBeLessThanOrEqual(0.3);

    const p = prompts()[0];
    expect(p).toContain('Transcript part 1 of 1');
    expect(p).toContain('Client: Acme');
    expect(p).toContain('Attendees: Rahul Mehta, Priya');
    expect(p).toContain('(Friday)');
    expect(p).toContain('[00:00] Rahul Mehta: Thanks for joining');
    expect(p).toContain('[00:30] Priya: I will send the revised proposal by Friday.');

    expect(out.status).toBe('ready');
    expect(out.title).toBe('Acme proposal review');
    expect(out.minutes).toMatchObject({
      summary: 'We reviewed the proposal.',
      keyPoints: ['Scope agreed', 'Budget is 20 lakh'],
      decisions: ['Fixed price'],
      openQuestions: ['Who signs?'],
      nextSteps: [],
      model: 'lfm2.5-1.2b-instruct',
      edited: false,
    });
    expect(out.actionItems.map(a => [a.task, a.owner, a.dueText, a.dueDate, a.priority])).toEqual([
      ['Send revised proposal', 'Priya', 'by Friday', toIsoDate(new Date(2026, 9, 23)), 'high'],
      ['Book follow-up call', undefined, undefined, undefined, undefined],
      ['Share SOW draft', undefined, undefined, undefined, undefined],
    ]);
    expect(out.actionItems.every(a => a.status === 'open' && /^act_/.test(a.id))).toBe(true);
    expect(new Set(out.actionItems.map(a => a.id)).size).toBe(3);

    expect(progress[0]).toEqual(['Loading LFM2.5-1.2B Instruct', 0.33]);
    expect(progress.map(([s]) => s)).toEqual([
      'Loading LFM2.5-1.2B Instruct',
      'Reading part 1 of 1',
      'Finding action items (1/1)',
      'Saving',
      'Done',
    ]);
    expect(progress[progress.length - 1][1]).toBe(1);

    const onDisk = JSON.parse(
      await RNFS.readFile(`${meetingStore.dir(m.id)}/meeting.json`, 'utf8'),
    ) as Meeting;
    expect(onDisk.minutes?.summary).toBe('We reviewed the proposal.');
    expect(onDisk.actionItems).toHaveLength(3);
  });

  it('map-reduce for a long transcript: one call per window plus a reduce pass', async () => {
    const filler = 'we walked through the integration details and the data migration plan';
    const segments = Array.from({ length: 60 }, (_, i) =>
      seg(i, `Rahul Mehta: point ${i}, ${filler} once more for clarity.`, i * 20_000),
    );
    const m = await stored({ title: 'Meeting · 16 Oct', segments });
    const totalChars = transcriptLines(m).join('\n').length;
    const expectedWindows = Math.ceil(totalChars / 4500);
    expect(expectedWindows).toBeGreaterThan(1);

    const { lm, calls, prompts } = fakeLM(user => {
      if (user.includes('Section summaries:')) {
        return 'Here you go: {"title": "Acme integration deep-dive", "summary": "Overall summary."}';
      }
      const part = Number(/Transcript part (\d+) of/.exec(user)![1]);
      return mapJson({
        title: `Part ${part} title`,
        summary: `Summary of part ${part}.`,
        key_points: ['Data migration plan reviewed', `Unique point ${WORDS[part]}`],
        decisions:
          part === 1 ? ['Use the staging cluster for UAT'] : ['Use staging cluster for UAT.'],
        action_items:
          part === 1
            ? [{ task: 'Send the migration runbook to Acme', priority: 'medium' }]
            : [{ task: 'Send migration runbook to Acme', owner: 'Rahul Mehta', due: 'tomorrow' }],
        open_questions: [],
        next_steps: ['Schedule UAT'],
      });
    });
    const progress: string[] = [];

    const out = await generateMinutes(m.id, 'lfm', s => progress.push(s));
    expect(out.minutes?.keyPoints).toContain(`Unique point ${WORDS[1]}`);

    const n = lm.complete.mock.calls.length - 1;
    expect(n).toBeGreaterThan(1);
    expect(n).toBe(expectedWindows);
    expect(lm.reset).toHaveBeenCalledTimes(n + 1);
    const ps = prompts();
    for (let i = 0; i < n; i++) {
      expect(ps[i]).toContain(`Transcript part ${i + 1} of ${n}`);
      expect(ps[i].length).toBeLessThan(4500 + 2500);
    }
    // Every transcript line reached exactly one window.
    for (let i = 0; i < 60; i++) {
      expect(ps.slice(0, n).filter(p => p.includes(`point ${i},`))).toHaveLength(1);
    }
    // Reduce prompt carries merged section summaries and deduped lists.
    const reduce = ps[n];
    expect(calls[n].options.maxTokens).toBe(400);
    expect(reduce).toContain('- Summary of part 1.');
    expect(reduce).toContain(`- Summary of part ${n}.`);
    expect(reduce.match(/Data migration plan reviewed/g)).toHaveLength(1);

    expect(out.title).toBe('Acme integration deep-dive');
    expect(out.minutes?.summary).toBe('Overall summary.');
    expect(out.minutes?.keyPoints[0]).toBe('Data migration plan reviewed');
    expect(out.minutes?.keyPoints).toHaveLength(1 + n);
    expect(out.minutes?.decisions).toEqual(['Use the staging cluster for UAT']);
    expect(out.minutes?.nextSteps).toEqual(['Schedule UAT']);
    expect(out.actionItems).toHaveLength(1);
    expect(out.actionItems[0]).toMatchObject({
      task: 'Send the migration runbook to Acme',
      owner: 'Rahul Mehta',
      dueText: 'tomorrow',
      dueDate: toIsoDate(new Date(2026, 9, 17)),
      priority: 'medium',
    });
    expect(progress).toContain('Writing summary');
    expect(progress.filter(s => s.startsWith('Reading part'))).toHaveLength(n);
  });

  it('map-reduce keeps the merged title/summary when the reduce output is unusable', async () => {
    const segments = Array.from({ length: 40 }, (_, i) =>
      seg(i, `${WORDS[i % WORDS.length]} ` + 'x'.repeat(200) + ` ${i}`, i * 1000),
    );
    const m = await stored({ title: '', segments });
    fakeLM(user =>
      user.includes('Section summaries:')
        ? 'sorry, I cannot'
        : mapJson({ title: 'Merged title', summary: 'S.', action_items: [] }),
    );
    const out = await generateMinutes(m.id, 'lfm');
    expect(out.title).toBe('Merged title');
    expect(out.minutes?.summary.split('\n').every(l => l === 'S.')).toBe(true);
  });

  it('keeps a user-chosen title', async () => {
    const m = await stored({ title: 'Quarterly review with Acme' });
    fakeLM(() => mapJson({ title: 'Model title', summary: 'x' }));
    const out = await generateMinutes(m.id, 'lfm');
    expect(out.title).toBe('Quarterly review with Acme');
  });

  it('falls back to "Heading:" bullet text when the model does not return JSON', async () => {
    const m = await stored({});
    fakeLM(
      () =>
        '## Summary\nThe team met to review the proposal.\n\n**Key points:**\n- Scope agreed\n' +
        'Decisions:\n1. Fixed price\nAction items:\n* Send revised proposal\nOpen questions:\n- Who signs?\nNext steps:\n- Share SOW',
    );
    const out = await generateMinutes(m.id, 'lfm');
    expect(out.minutes).toMatchObject({
      summary: 'The team met to review the proposal.',
      keyPoints: ['Scope agreed'],
      decisions: ['Fixed price'],
      openQuestions: ['Who signs?'],
      nextSteps: ['Share SOW'],
    });
    expect(out.actionItems.map(a => a.task)).toEqual(['Send revised proposal']);
  });

  it('preserves manual and completed items across regeneration', async () => {
    const manual = action({
      task: 'Send revised proposal',
      owner: 'Me',
      manual: true,
      dueDate: '2026-10-30',
    });
    const done = action({
      task: 'Book follow-up call',
      status: 'done',
      completedAt: MEETING_TS + 1,
    });
    const doneGone = action({
      task: 'Circulate NDA copy',
      status: 'done',
      completedAt: MEETING_TS + 2,
    });
    const manualGone = action({ task: 'Personal reminder about invoices', manual: true });
    const staleOpen = action({ task: 'Obsolete open item nobody mentions' });
    const m = await stored({ actionItems: [manual, done, doneGone, manualGone, staleOpen] });
    fakeLM(() =>
      mapJson({
        title: 't',
        summary: 's',
        action_items: [
          { task: 'Send the revised proposal', owner: 'Priya', due: 'tomorrow' },
          { task: 'Book the follow-up call', owner: 'Rahul' },
          { task: 'Draft the SOW' },
        ],
      }),
    );
    const out = await generateMinutes(m.id, 'lfm');
    const byTask = new Map(out.actionItems.map(a => [a.task, a]));

    // The user's manual edit wins wholesale.
    expect(byTask.get('Send revised proposal')).toEqual(manual);
    // Completed item keeps id/status/completedAt, takes the new wording/owner.
    expect(byTask.get('Book the follow-up call')).toMatchObject({
      id: done.id,
      status: 'done',
      completedAt: done.completedAt,
      owner: 'Rahul',
      createdAt: done.createdAt,
    });
    expect(byTask.get('Draft the SOW')?.status).toBe('open');
    // Items the model no longer lists: done/manual survive, stale open ones drop.
    expect(byTask.get('Circulate NDA copy')).toEqual(doneGone);
    expect(byTask.get('Personal reminder about invoices')).toEqual(manualGone);
    expect(byTask.has('Obsolete open item nobody mentions')).toBe(false);
    expect(new Set(out.actionItems.map(a => a.id)).size).toBe(out.actionItems.length);
  });

  it('uses the meeting date (not today) to resolve due phrases', async () => {
    const m = await stored({ startedAt: new Date(2026, 0, 30, 15).getTime() });
    fakeLM(() => mapJson({ action_items: [{ task: 'Ship it', due: 'end of month' }] }));
    const out = await generateMinutes(m.id, 'lfm');
    expect(out.actionItems[0].dueDate).toBe(toIsoDate(new Date(2026, 0, 31)));
  });

  it('rejects an unknown meeting', async () => {
    await expect(generateMinutes('mtg_does_not_exist', 'lfm')).rejects.toThrow('Meeting not found');
  });

  it('rejects a transcript that only contains markers or unfinished segments', async () => {
    const m = await stored({
      segments: [{ ...seg(0, 'pending', 0), status: 'pending' }],
      markers: [{ atMs: 0, note: 'flag' }],
    });
    fakeLM(() => '{}');
    await expect(generateMinutes(m.id, 'lfm')).rejects.toThrow(/Transcript is empty/);
    expect(ensure).not.toHaveBeenCalled();
  });

  it('rejects when the model fails to load', async () => {
    const m = await stored({});
    ensure.mockResolvedValue({ instance: null });
    await expect(generateMinutes(m.id, 'broken-model')).rejects.toThrow(
      'Model broken-model failed to load',
    );
  });

  it('survives lm.reset() throwing', async () => {
    const m = await stored({});
    const { lm } = fakeLM(() => mapJson({ summary: 'fine' }));
    lm.reset.mockRejectedValue(new Error('no session'));
    const out = await generateMinutes(m.id, 'lfm');
    expect(out.minutes?.summary).toBe('fine');
  });

  // Regression (fixed; src/meetings/MinutesGenerator.ts:85, contextBlock): the prompt date is
  // `toISOString().slice(0, 10)` (UTC) while the weekday is local. For a meeting
  // at 01:00 IST on Fri 16 Oct the model is told "Date: 2026-10-15 (Friday)".
  // Reproduced in a child process because Jest workers ignore TZ changes.
  it('tells the model the local meeting date (IST meeting at 01:00)', () => {
    const r = runSourceInChild({
      file: 'src/meetings/MinutesGenerator.ts',
      env: { TZ: 'Asia/Kolkata' },
      stubs: {
        './dateResolver':
          "{ resolveDue: () => undefined, toIsoDate: d => `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}` }",
        './Transcriber': '{ transcriber: { release: async () => {} } }',
        '../utils/engineMigration': "{ listDownloadedCactusModels: async () => [{ slug: 'lfm' }] }",
        'cactus-react-native': '{ CactusLM: class {} }',
        '../observability/usageLedger': '{ usageLedger: { record: () => {} } }',
        './MeetingStore': `{
          meetingStore: {
            get: async () => globalThis.M,
            update: async (_id, f) => { f(globalThis.M); return globalThis.M; },
          },
          newActionId: () => 'act_1',
        }`,
        '../services/ModelLifecycleManager': `{
          modelLifecycle: { getLoadedModels: () => [], getRamBudgetMb: () => 0, ensure: async () => ({ instance: {
            reset: async () => {},
            complete: async ({ messages }) => {
              globalThis.prompts.push(messages[1].content);
              return { response: '{}' };
            },
          } }) },
        }`,
      },
      body: `
        globalThis.prompts = [];
        globalThis.M = {
          id: 'm1', title: 'x', attendees: [], markers: [], actionItems: [],
          startedAt: new Date(2026, 9, 16, 1, 0).getTime(),
          segments: [{ index: 0, startMs: 0, status: 'done', text: 'Hello everyone, today we review the budget and the launch plan.' }],
        };
        await mod.generateMinutes('m1', 'lfm');
        return globalThis.prompts[0].match(/Date: (.*)/)[1];`,
    });
    expect(r).toEqual({ ok: true, value: '2026-10-16 (Friday)' });
  });

  it('child-process harness itself works in another time zone (sanity check)', () => {
    const r = runSourceInChild({
      file: 'src/meetings/dateResolver.ts',
      env: { TZ: 'Asia/Kolkata' },
      body: `return mod.resolveDue('tomorrow', new Date(2026, 9, 16, 1, 0));`,
    });
    expect(r).toEqual({ ok: true, value: '2026-10-17' });
  });
});

describe('fixture sanity', () => {
  it('meeting date is Friday 16 Oct 2026 local', () => {
    expect(MEETING_DATE.getDay()).toBe(5);
    expect(toIsoDate(MEETING_DATE)).toBe('2026-10-16');
  });
});

// ---------------------------------------------------------------------------
// Summary model selection

describe('chooseSummaryModel', () => {
  const hot350 = { slug: 'lfm2.5-350m', tier: 'hot', ramMb: 441 };

  it('uses the configured model when it is downloaded and fits', () => {
    expect(
      chooseSummaryModel({
        preferred: 'lfm2.5-1.2b-instruct',
        downloaded: new Set(['lfm2.5-1.2b-instruct']),
        loaded: [],
        budgetMb: 3000,
      }),
    ).toMatchObject({ slug: 'lfm2.5-1.2b-instruct', downloaded: true });
  });

  it('falls back to a downloaded model instead of loading one that does not fit in RAM', () => {
    // Device log: budget ~1059 MB, hot 350M pinned -> ~618 MB free, 1.2B needs ~1455 MB.
    expect(
      chooseSummaryModel({
        preferred: 'lfm2.5-1.2b-instruct',
        downloaded: new Set(['lfm2.5-350m', 'lfm2-350m']),
        loaded: [hot350],
        budgetMb: 1059,
      }),
    ).toMatchObject({ slug: 'lfm2.5-350m', downloaded: true });
  });

  it('prefers a downloaded model over downloading the configured one', () => {
    expect(
      chooseSummaryModel({
        preferred: 'lfm2.5-1.2b-instruct',
        downloaded: new Set(['lfm2-700m', 'lfm2-350m']),
        loaded: [],
        budgetMb: 4000,
      }),
    ).toMatchObject({ slug: 'lfm2-700m', downloaded: true });
  });

  it('downloads the configured model only when nothing usable is on the device', () => {
    expect(
      chooseSummaryModel({
        preferred: 'lfm2.5-1.2b-instruct',
        downloaded: new Set(['whisper-small', 'qwen3-embedding-0.6b']),
        loaded: [],
        budgetMb: 4000,
      }),
    ).toMatchObject({ slug: 'lfm2.5-1.2b-instruct', downloaded: false });
  });

  it('returns null when nothing fits', () => {
    expect(
      chooseSummaryModel({
        preferred: 'lfm2.5-1.2b-instruct',
        downloaded: new Set(),
        loaded: [],
        budgetMb: 300,
      }),
    ).toBeNull();
  });
});

describe('generateMinutes guards', () => {
  it('refuses to summarise a transcript with almost no distinct words', async () => {
    const m = makeMeeting({
      minutes: undefined,
      actionItems: [],
      segments: [seg(0, 'spea-courge-courge-courge-courge')],
    });
    await meetingStore.create(m);
    ensure.mockReset();
    await expect(generateMinutes(m.id, 'lfm')).rejects.toThrow(/Too little clear speech/);
    expect(ensure).not.toHaveBeenCalled();
  });
});

describe('generateMinutes template echoes', () => {
  it('drops placeholder items the model copied from the schema', async () => {
    const m = await stored({ title: defaultTitle(MEETING_TS, 'Acme') });
    fakeLM(() =>
      mapJson({
        title: 'Acme sync',
        summary: 'Payments status reviewed.',
        key_points: ['UPI integration complete', '...', 'main discussion point'],
        decisions: ['…'],
        action_items: [
          { task: 'what must be done' },
          { task: 'Fix timeout handling', owner: 'Rahul' },
        ],
        open_questions: ['one string per unresolved question', 'N/A'],
        next_steps: ['...'],
      }),
    );
    const out = await generateMinutes(m.id, 'lfm2.5-1.2b-instruct');
    expect(out.minutes).toMatchObject({
      keyPoints: ['UPI integration complete'],
      decisions: [],
      openQuestions: [],
      nextSteps: [],
    });
    // The fixture's real commitment survives even when the model cannot phrase it.
    expect(out.actionItems.map(a => a.task)).toEqual([
      'Fix timeout handling',
      'Send the revised proposal by Friday.',
    ]);
  });
});

describe('generateMinutes per-line commitments', () => {
  it('takes owner and deadline from the committing line, overriding the summary pass', async () => {
    const m = await stored({ title: defaultTitle(MEETING_TS, 'Acme') });
    const { prompts } = fakeLM(user =>
      user.includes('committed to a task in the first line')
        ? JSON.stringify({ task: 'Send the revised proposal' })
        : mapJson({
            title: 'Acme review',
            summary: 'Reviewed.',
            action_items: [{ task: 'Send the revised proposal', owner: 'Rahul' }],
          }),
    );
    const out = await generateMinutes(m.id, 'lfm2.5-1.2b-instruct');
    expect(
      prompts().some(p => p.includes('Line: "Priya: I will send the revised proposal by Friday."')),
    ).toBe(true);
    const item = out.actionItems.find(a => a.task === 'Send the revised proposal');
    expect(item).toMatchObject({ owner: 'Priya', dueText: 'by Friday' });
  });
});
