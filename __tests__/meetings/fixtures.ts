/** Shared fixtures for meetings/tasks/email tests. Not a test file (no .test.ts suffix). */
import { spawnSync } from 'child_process';
import * as fs from 'fs';
import * as path from 'path';
import * as ts from 'typescript';

import type { ActionItem, Letterhead, Meeting, TranscriptSegment } from '../../src/meetings/types';

/** Friday 16 Oct 2026, 10:00 local time. */
export const MEETING_DATE = new Date(2026, 9, 16, 10, 0);
export const MEETING_TS = MEETING_DATE.getTime();

export const EMPTY_LETTERHEAD: Letterhead = {
  companyName: '',
  preparedBy: '',
  contactLine: '',
  footerNote: '',
  accentColor: '',
};

export function seg(index: number, text: string, startMs = index * 30_000): TranscriptSegment {
  return {
    index,
    startMs,
    durationMs: 30_000,
    wallStartMs: MEETING_TS + Math.max(0, startMs),
    speechRatio: 0.8,
    text,
    status: 'done',
  };
}

export function action(over: Partial<ActionItem> & { task: string }): ActionItem {
  return {
    id: `act_${over.task.replace(/\W+/g, '_').toLowerCase()}`,
    status: 'open',
    createdAt: MEETING_TS,
    ...over,
  };
}

let seq = 0;
export function makeMeeting(over: Partial<Meeting> = {}): Meeting {
  seq++;
  return {
    schemaVersion: 1,
    id: `mtg_test_${seq}_${Math.random().toString(36).slice(2, 8)}`,
    title: 'Acme kickoff',
    client: 'Acme',
    attendees: [{ name: 'Rahul Mehta', email: 'rahul@acme.com', org: 'Acme' }, { name: 'Priya' }],
    startedAt: MEETING_TS,
    endedAt: MEETING_TS + 45 * 60_000,
    durationMs: 45 * 60_000,
    status: 'ready',
    source: 'recording',
    language: 'en',
    segments: [
      seg(0, 'Rahul Mehta: Thanks for joining, let us go over the proposal.'),
      seg(1, 'Priya: I will send the revised proposal by Friday.'),
    ],
    markers: [],
    minutes: {
      summary: 'Kickoff of the Acme engagement.',
      keyPoints: ['Scope agreed for phase one'],
      decisions: ['Go with the fixed-price model'],
      openQuestions: ['Who signs off on the SOW?'],
      nextSteps: ['Share the SOW draft'],
      generatedAt: MEETING_TS,
      model: 'test-model',
      edited: false,
    },
    actionItems: [
      action({
        task: 'Send revised proposal',
        owner: 'Priya',
        dueText: 'by Friday',
        dueDate: '2026-10-23',
        priority: 'high',
      }),
      action({ task: 'Book follow-up call', owner: 'Rahul Mehta', status: 'done' }),
    ],
    updatedAt: MEETING_TS,
    ...over,
  };
}

/**
 * Transpiles one src file and runs `body` against its exports in a child Node
 * process with a hard timeout. Used where the in-process Jest worker cannot
 * reproduce a condition safely: an infinite loop (the child is killed) or a
 * different time zone (Jest workers do not re-read process.env.TZ).
 *
 * `stubs` maps each import specifier to a JS expression for that module's
 * exports. `body` is the inside of an async function receiving `mod` (the
 * module's exports); its return value is JSON-encoded back. Returns
 * `{ ok: false }` when the child timed out or crashed.
 */
export function runSourceInChild(opts: {
  file: string;
  body: string;
  stubs?: Record<string, string>;
  env?: Record<string, string>;
  timeoutMs?: number;
}): { ok: true; value: unknown } | { ok: false; reason: string } {
  const src = fs.readFileSync(path.join(__dirname, '../..', opts.file), 'utf8');
  const js = ts.transpileModule(src, {
    compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2020 },
  }).outputText;
  const stubEntries = Object.entries(opts.stubs ?? {})
    .map(([k, v]) => `${JSON.stringify(k)}: (${v})`)
    .join(',\n');
  const script = `
    const stubs = {${stubEntries}};
    const req = id => (id in stubs ? stubs[id] : {});
    const m = { exports: {} };
    new Function('module', 'exports', 'require', ${JSON.stringify(js)})(m, m.exports, req);
    (async mod => { ${opts.body} })(m.exports).then(
      v => process.stdout.write(JSON.stringify(v === undefined ? null : v)),
      e => { process.stderr.write(String(e && e.stack || e)); process.exit(2); },
    );`;
  const r = spawnSync(process.execPath, ['-e', script], {
    timeout: opts.timeoutMs ?? 2000,
    encoding: 'utf8',
    env: { ...process.env, ...opts.env },
  });
  if (r.signal) return { ok: false, reason: `killed by ${r.signal} (timeout)` };
  if (r.status !== 0) return { ok: false, reason: r.stderr };
  return { ok: true, value: JSON.parse(r.stdout) };
}
