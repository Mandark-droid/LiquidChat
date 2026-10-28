/**
 * What the agent learns on its own from each finished run, in the three kinds of memory the PRD
 * plans (§8.1), created and kept up to date without a prompt. Everything is on the phone, listed
 * in the Memory screen, and can be edited or deleted there.
 *
 * - Profile: a preference or personal fact the user states ("I prefer meetings after 11 am",
 *   "my manager is Priya"), saved as a lower-confidence entry; an explicit "remember that …" is
 *   still saved as given.
 * - Episodic: one entry per task the agent acted on (a tool ran, or the run failed), updated each
 *   time the same goal comes back, with how it went last.
 * - Procedural: once the same sequence of tools has worked twice, the workflow itself, with the
 *   requests it served.
 *
 * Requests that look sensitive (passwords, health, money) are never learned from. Only what the
 * user typed or said is stored, with the outcome and the tool names: never the reply or a tool's
 * output, which can carry text from outside (a web page, an MCP server) that would otherwise come
 * back into later prompts as "memory".
 */
import { type Memory, MemoryManager } from './MemoryManager';

export interface RunSummary {
  /** What the user typed or said. */
  request: string;
  /** Who asked: only the user's own requests (chat, voice) are learned from. */
  source: string;
  goal: string;
  ok: boolean;
  /** Tools the plan called, in order. */
  tools: string[];
  errorCode?: string;
}

/** Most entries kept per learned kind; the least recently updated go first. */
export const MAX_EPISODIC = 300;
export const MAX_PROCEDURAL = 100;
/** Successful runs of the same tool sequence before it is saved as a workflow. */
export const WORKFLOW_AFTER = 2;

const SENSITIVE_RE =
  /\b(password|passcode|pin|otp|aadhaar|pan card|bank account|account number|salary|diagnos|medical|health|religion|caste)\b/i;

const PREFERENCE_RE =
  /^\s*(?:(?:i|we)\s+(?:(?:really\s+)?(?:prefer|like|love|hate|always|usually|never|don't like|do not like|want))\b.{3,200}|my\s+(?:name|email|phone|number|birthday|company|team|role|job|title|timezone|time zone|city|home|office|address|manager|boss|wife|husband|partner|language)\s+(?:is|are)\s+.{2,150})$/i;

const norm = (s: string) =>
  s
    .trim()
    .toLowerCase()
    .replace(/\s+/g, ' ')
    .replace(/[.!?]+$/, '');

function sequenceTag(tools: string[]): string {
  return `tools:${tools.join('>')}`.toLowerCase();
}

const USER_SOURCES = new Set(['chat', 'voice']);

export async function learnFromRun(memory: MemoryManager, run: RunSummary): Promise<void> {
  if (!USER_SOURCES.has(run.source)) return;
  if (SENSITIVE_RE.test(`${run.request} ${run.goal}`)) return;
  await learnPreference(memory, run.request);
  if (!run.tools.length && run.ok) return; // a plain answer: nothing was done to remember
  await learnEpisode(memory, run);
  if (run.ok && run.tools.length) await learnWorkflow(memory, run);
}

async function findByTitle(memory: MemoryManager, kind: Memory['kind'], title: string) {
  const all = await memory.list({ kind, limit: 1000 });
  return all.find(m => norm(m.title) === norm(title));
}

async function learnPreference(memory: MemoryManager, request: string): Promise<void> {
  // "Remember that …" is saved straight away elsewhere, exactly as asked.
  if (MemoryManager.proposeFromRequest(request)) return;
  if (!PREFERENCE_RE.test(request)) return;
  const content = request.trim().replace(/[.!]+$/, '');
  const existing = (await memory.list({ kind: 'profile', limit: 1000 })).find(
    m => norm(m.content) === norm(content),
  );
  if (existing) {
    await memory.update(existing.id, { content });
    return;
  }
  await memory.create({
    kind: 'profile',
    title: content.slice(0, 60),
    content,
    tags: ['learned'],
    source: 'execution',
    confidence: 0.6,
  });
}

async function learnEpisode(memory: MemoryManager, run: RunSummary): Promise<void> {
  const title = run.goal.trim().slice(0, 80) || run.request.trim().slice(0, 80);
  const outcome = run.ok
    ? `done${run.tools.length ? ` with ${run.tools.join(', ')}` : ''}`
    : `failed${run.errorCode ? ` (${run.errorCode})` : ''}`;
  const content = `${run.request.trim()} — ${outcome}`.slice(0, 600);
  const tags = [
    'task',
    run.ok ? 'succeeded' : 'failed',
    ...(run.tools.length ? [sequenceTag(run.tools)] : []),
  ];
  const existing = await findByTitle(memory, 'episodic', title);
  if (existing) await memory.update(existing.id, { content, tags });
  else await memory.create({ kind: 'episodic', title, content, tags, source: 'execution' });
  await prune(memory, 'episodic', MAX_EPISODIC);
}

async function learnWorkflow(memory: MemoryManager, run: RunSummary): Promise<void> {
  const tag = sequenceTag(run.tools);
  const episodes = (await memory.list({ kind: 'episodic', limit: 1000 })).filter(
    m => m.tags.includes(tag) && m.tags.includes('succeeded'),
  );
  if (episodes.length < WORKFLOW_AFTER) return;
  const title = `Workflow: ${run.tools.join(' → ')}`;
  // The latest requests it served, so it can be recognised next time.
  const examples = [
    run.request.trim(),
    ...episodes.map(e => e.content.split(' — ')[0]).filter(r => norm(r) !== norm(run.request)),
  ].slice(0, 3);
  const content = `Steps: ${run.tools.join(' → ')}. Worked for: ${examples.map(e => `"${e}"`).join('; ')}.`;
  const existing = await findByTitle(memory, 'procedural', title);
  if (existing) await memory.update(existing.id, { content });
  else
    await memory.create({
      kind: 'procedural',
      title,
      content,
      tags: ['workflow', tag],
      source: 'execution',
    });
  await prune(memory, 'procedural', MAX_PROCEDURAL);
}

/** Keeps the newest `max` learned entries of a kind; what the user saved or pinned is never removed. */
async function prune(memory: MemoryManager, kind: Memory['kind'], max: number): Promise<void> {
  const learned = (await memory.list({ kind, limit: 5000 })).filter(
    m => m.source === 'execution' && !m.pinned,
  );
  for (const m of learned.sort((a, b) => b.updatedAt - a.updatedAt).slice(max))
    await memory.delete(m.id);
}
