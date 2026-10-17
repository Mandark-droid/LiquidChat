import { CactusLM } from 'cactus-react-native';

import { getModelBySlug, LIQUID_MODELS, quantizationFor } from '../config/models';
import { modelLifecycle } from '../services/ModelLifecycleManager';
import { listDownloadedCactusModels } from '../utils/engineMigration';
import { resolveDue, toIsoDate } from './dateResolver';
import { meetingStore, newActionId } from './MeetingStore';
import { transcriber } from './Transcriber';
import type { ActionItem, ActionPriority, Meeting, Minutes } from './types';

/**
 * Transcript -> minutes, action items, decisions.
 *
 * Map-reduce so hour-long meetings fit small on-device context windows:
 *   map:    each ~4.5k-char transcript window -> structured JSON
 *   reduce: merge + fuzzy-dedupe lists, then one short pass for title/summary
 * Formatting of the final document is deterministic (documents.ts) — the
 * model only supplies content.
 */

const CHUNK_CHARS = 4500;

export interface PartialMinutes {
  title: string;
  summary: string;
  keyPoints: string[];
  decisions: string[];
  actionItems: { task: string; owner?: string; due?: string; priority?: ActionPriority }[];
  openQuestions: string[];
  nextSteps: string[];
}

export type MinutesProgress = (stage: string, fraction: number) => void;

export function formatClock(ms: number): string {
  const s = Math.max(0, Math.floor(ms / 1000));
  const h = Math.floor(s / 3600);
  const mm = String(Math.floor((s % 3600) / 60)).padStart(2, '0');
  const ss = String(s % 60).padStart(2, '0');
  return h > 0 ? `${h}:${mm}:${ss}` : `${mm}:${ss}`;
}

/** Transcript as timestamped lines, with user markers interleaved. */
export function transcriptLines(m: Meeting): string[] {
  const lines: { at: number; text: string }[] = [];
  m.segments.forEach((s, i) => {
    if (s.status !== 'done' || !s.text) return;
    // Imported transcripts without timestamps use startMs < 0; keep their order.
    if (s.startMs < 0) lines.push({ at: i, text: s.text });
    else lines.push({ at: s.startMs, text: `[${formatClock(s.startMs)}] ${s.text}` });
  });
  for (const mk of m.markers) {
    lines.push({
      at: mk.atMs,
      text: `[${formatClock(mk.atMs)}] ★ FLAGGED BY USER: ${mk.note || 'important moment'}`,
    });
  }
  return lines.sort((a, b) => a.at - b.at).map(l => l.text);
}

export function transcriptPlain(m: Meeting): string {
  return transcriptLines(m).join('\n');
}

function chunkLines(lines: string[], maxChars: number): string[] {
  const chunks: string[] = [];
  let cur = '';
  for (const line of lines) {
    if (cur && cur.length + line.length + 1 > maxChars) {
      chunks.push(cur);
      cur = '';
    }
    if (line.length > maxChars) {
      for (let i = 0; i < line.length; i += maxChars) chunks.push(line.slice(i, i + maxChars));
      continue;
    }
    cur = cur ? `${cur}\n${line}` : line;
  }
  if (cur) chunks.push(cur);
  return chunks;
}

function contextBlock(m: Meeting): string {
  const d = new Date(m.startedAt);
  const day = d.toLocaleDateString('en-US', { weekday: 'long' });
  const parts = [
    `Date: ${toIsoDate(d)} (${day})`, // local calendar date, not UTC
    m.client ? `Client: ${m.client}` : '',
    m.project ? `Project: ${m.project}` : '',
    m.attendees.length ? `Attendees: ${m.attendees.map(a => a.name).join(', ')}` : '',
    m.agenda ? `Agenda: ${m.agenda}` : '',
  ].filter(Boolean);
  return parts.join('\n');
}

const SYSTEM =
  'You write accurate minutes of meeting (MoM) from transcripts for a professional services firm. ' +
  'You only use facts stated in the transcript. Always write the minutes in English, even if the ' +
  'transcript is in another language. You reply with a single JSON object and nothing else.';

function mapPrompt(m: Meeting, chunk: string, i: number, n: number): string {
  return `Meeting context:
${contextBlock(m)}

Transcript part ${i + 1} of ${n} (lines may start with [mm:ss] or a speaker name; lines marked ★ were flagged as important by the user):
"""
${chunk}
"""

Extract the minutes for THIS part. Return JSON with exactly these keys:
{"title": "short meeting title (max 8 words)",
 "summary": "2-3 sentence summary of this part",
 "key_points": [one string per main discussion point],
 "decisions": [one string per decision that was agreed],
 "action_items": [{"task": "what must be done", "owner": "person responsible or empty", "due": "deadline exactly as said, or empty", "priority": "high|medium|low"}],
 "open_questions": [one string per unresolved question],
 "next_steps": [one string per next step]}

Rules:
- Use only what is said in the transcript. Never invent names, numbers or dates.
- An action item is a concrete commitment ("I will send…", "can you share…", "let's schedule…").
- Use [] when there is nothing for a key. Keep every item to one short sentence.`;
}

function reducePrompt(m: Meeting, merged: PartialMinutes): string {
  const bullet = (xs: string[]) => xs.map(x => `- ${x}`).join('\n') || '- (none)';
  return `Meeting context:
${contextBlock(m)}

Section summaries:
${bullet(merged.summary.split('\n').filter(Boolean))}

Key points:
${bullet(merged.keyPoints)}

Decisions:
${bullet(merged.decisions)}

Write the overall result as JSON:
{"title": "short meeting title (max 8 words)", "summary": "executive summary in 3-5 sentences for the client"}
Use only the information above.`;
}

// ---------------------------------------------------------------------------
// Tolerant JSON parsing for small-model output

export function extractJson(raw: string): any | null {
  if (!raw) return null;
  const s = raw
    .replace(/<think>[\s\S]*?<\/think>/gi, '')
    .replace(/```(?:json)?/gi, '')
    .replace(/[“”]/g, '"')
    .replace(/[‘’]/g, "'");
  const start = s.indexOf('{');
  if (start < 0) return null;
  // Balance braces to find the end (tolerates trailing chatter or truncation).
  let depth = 0,
    inStr = false,
    esc = false,
    end = -1;
  for (let i = start; i < s.length; i++) {
    const c = s[i];
    if (inStr) {
      if (esc) esc = false;
      else if (c === '\\') esc = true;
      else if (c === '"') inStr = false;
      continue;
    }
    if (c === '"') inStr = true;
    else if (c === '{' || c === '[') depth++;
    else if (c === '}' || c === ']') {
      depth--;
      if (depth === 0) {
        end = i;
        break;
      }
    }
  }
  const body = end > 0 ? s.slice(start, end + 1) : closeTruncated(s.slice(start));
  for (const attempt of [
    (x: string) => x,
    (x: string) => x.replace(/,\s*([}\]])/g, '$1'),
    (x: string) =>
      x.replace(/,\s*([}\]])/g, '$1').replace(/([{,]\s*)([A-Za-z_][\w]*)\s*:/g, '$1"$2":'),
    (x: string) => x.replace(/,\s*([}\]])/g, '$1').replace(/'([^'"\n]*)'/g, '"$1"'),
  ]) {
    try {
      return JSON.parse(attempt(body));
    } catch {}
  }
  return null;
}

/** Closes brackets/strings of output cut off by maxTokens. */
function closeTruncated(s: string): string {
  const stack: string[] = [];
  let inStr = false,
    esc = false;
  for (const c of s) {
    if (inStr) {
      if (esc) esc = false;
      else if (c === '\\') esc = true;
      else if (c === '"') inStr = false;
      continue;
    }
    if (c === '"') inStr = true;
    else if (c === '{') stack.push('}');
    else if (c === '[') stack.push(']');
    else if (c === '}' || c === ']') stack.pop();
  }
  let out = s.replace(/,\s*$/, '');
  if (inStr) out += '"';
  return out + stack.reverse().join('');
}

/** Last resort: read "Decisions:"-style headed bullet lists. */
function parseHeadedText(raw: string): Partial<PartialMinutes> {
  const out: Partial<PartialMinutes> = {
    keyPoints: [],
    decisions: [],
    actionItems: [],
    openQuestions: [],
    nextSteps: [],
  };
  let section: keyof PartialMinutes | null = null;
  for (const line of raw.split('\n')) {
    const l = line.trim();
    const h = l.toLowerCase().replace(/[#*:]/g, '').trim();
    if (/^(key points|discussion|highlights)/.test(h)) {
      section = 'keyPoints';
      continue;
    }
    if (/^decisions?/.test(h)) {
      section = 'decisions';
      continue;
    }
    if (/^action items?/.test(h)) {
      section = 'actionItems';
      continue;
    }
    if (/^open questions?/.test(h)) {
      section = 'openQuestions';
      continue;
    }
    if (/^next steps?/.test(h)) {
      section = 'nextSteps';
      continue;
    }
    if (/^summary/.test(h)) {
      section = 'summary';
      continue;
    }
    const item = l.replace(/^[-*•\d.)\s]+/, '').trim();
    if (!item || !section) continue;
    if (section === 'summary') out.summary = `${out.summary ?? ''} ${item}`.trim();
    else if (section === 'actionItems') out.actionItems!.push({ task: item });
    else (out[section] as string[]).push(item);
  }
  return out;
}

// Small models echo the schema's descriptions or ellipses back as content.
const TEMPLATE_ECHO =
  /^(\.{2,}|…|n\/?a|none|tbd|one string per .*|main discussion point|decision that was agreed|unresolved question|what must be done)\.?$/i;

const strList = (v: any): string[] =>
  Array.isArray(v)
    ? v
        .map(x => (typeof x === 'string' ? x : (x?.text ?? x?.point ?? JSON.stringify(x))))
        .map(s => String(s).trim())
        .filter(s => s && !TEMPLATE_ECHO.test(s))
    : [];

function normalizePartial(j: any, raw: string): PartialMinutes {
  const src = j ?? parseHeadedText(raw);
  const actions = Array.isArray(src.action_items ?? src.actionItems)
    ? (src.action_items ?? src.actionItems)
    : [];
  return {
    title: String(src.title ?? '').trim(),
    summary: String(src.summary ?? '').trim(),
    keyPoints: strList(src.key_points ?? src.keyPoints),
    decisions: strList(src.decisions),
    openQuestions: strList(src.open_questions ?? src.openQuestions),
    nextSteps: strList(src.next_steps ?? src.nextSteps),
    actionItems: actions
      .map((a: any) => (typeof a === 'string' ? { task: a } : a))
      .map((a: any) => ({
        task: String(a.task ?? a.action ?? a.item ?? '')
          .trim()
          .replace(TEMPLATE_ECHO, ''),
        owner: cleanField(a.owner ?? a.assignee),
        due: cleanField(a.due ?? a.deadline ?? a.due_date),
        priority: (['high', 'medium', 'low'].includes(String(a.priority).toLowerCase())
          ? String(a.priority).toLowerCase()
          : undefined) as ActionPriority | undefined,
      }))
      .filter((a: any) => a.task),
  };
}

function cleanField(v: any): string | undefined {
  const s = v == null ? '' : String(v).trim();
  return !s || /^(none|n\/a|null|unknown|unassigned|tbd|-)$/i.test(s) ? undefined : s;
}

// ---------------------------------------------------------------------------
// Fuzzy dedupe

function tokens(s: string): Set<string> {
  return new Set(
    s
      .toLowerCase()
      .replace(/[^\p{L}\p{N} ]/gu, ' ')
      .split(/\s+/)
      .filter(w => w.length > 2),
  );
}
function numbers(s: string): string {
  return (s.match(/\d+(?:[.,]\d+)?/g) ?? []).join(' ');
}
function similar(a: string, b: string): boolean {
  // "20 lakh" vs "50 lakh" are different commitments even if the words match.
  if (numbers(a) !== numbers(b)) return false;
  const ta = tokens(a),
    tb = tokens(b);
  if (!ta.size || !tb.size) return a.trim().toLowerCase() === b.trim().toLowerCase();
  let inter = 0;
  for (const t of ta) if (tb.has(t)) inter++;
  return inter / Math.min(ta.size, tb.size) >= 0.75;
}
function dedupe(xs: string[]): string[] {
  const out: string[] = [];
  for (const x of xs) if (!out.some(o => similar(o, x))) out.push(x);
  return out;
}

/** Fewer distinct words than this is noise or a fragment, not a meeting. */
const MIN_DISTINCT_WORDS = 8;

export function mergePartials(parts: PartialMinutes[]): PartialMinutes {
  const actions: PartialMinutes['actionItems'] = [];
  for (const p of parts) {
    for (const a of p.actionItems) {
      const dup = actions.find(x => similar(x.task, a.task));
      if (dup) {
        dup.owner = dup.owner ?? a.owner;
        dup.due = dup.due ?? a.due;
        dup.priority = dup.priority ?? a.priority;
      } else actions.push({ ...a });
    }
  }
  return {
    title: parts.find(p => p.title)?.title ?? '',
    summary: parts
      .map(p => p.summary)
      .filter(Boolean)
      .join('\n'),
    keyPoints: dedupe(parts.flatMap(p => p.keyPoints)),
    decisions: dedupe(parts.flatMap(p => p.decisions)),
    openQuestions: dedupe(parts.flatMap(p => p.openQuestions)),
    nextSteps: dedupe(parts.flatMap(p => p.nextSteps)),
    actionItems: actions,
  };
}

// ---------------------------------------------------------------------------
// Summary model selection

/** Must match ModelLifecycleManager's RAM estimate. */
const RAM_MULTIPLIER = 1.3;

export interface SummaryModelChoice {
  slug: string;
  downloaded: boolean;
  reason: string;
}

/**
 * Picks the model for minutes. The configured model wins only if it fits the RAM left
 * after evictable models are freed; otherwise an already-downloaded text model is
 * preferred over downloading something new.
 */
export function chooseSummaryModel(input: {
  preferred: string;
  downloaded: Set<string>;
  loaded: { slug: string; tier: string; ramMb: number }[];
  budgetMb: number;
}): SummaryModelChoice | null {
  const { preferred, downloaded, loaded, budgetMb } = input;
  const pinnedMb = (slug: string) =>
    loaded.filter(m => m.tier === 'hot' && m.slug !== slug).reduce((n, m) => n + m.ramMb, 0);
  const fits = (slug: string) => {
    if (budgetMb <= 0) return true;
    const def = getModelBySlug(slug);
    const need = def ? Math.round(def.sizeMb * RAM_MULTIPLIER) : 500;
    return need <= budgetMb - pinnedMb(slug);
  };
  const isLoaded = (slug: string) => loaded.some(m => m.slug === slug);

  if (fits(preferred) && (downloaded.has(preferred) || isLoaded(preferred)))
    return { slug: preferred, downloaded: true, reason: 'configured' };

  const candidates = LIQUID_MODELS.filter(
    m =>
      m.category === 'text' &&
      m.supportsCompletion &&
      !m.isSTT &&
      !m.isCustom &&
      (downloaded.has(m.slug) || isLoaded(m.slug)) &&
      fits(m.slug),
  ).sort(
    (a, b) =>
      Number(isLoaded(b.slug)) - Number(isLoaded(a.slug)) ||
      Number(!!a.legacy) - Number(!!b.legacy) ||
      b.sizeMb - a.sizeMb,
  );
  if (candidates.length)
    return {
      slug: candidates[0].slug,
      downloaded: true,
      reason: fits(preferred) ? `${preferred} not downloaded` : `${preferred} does not fit in RAM`,
    };

  if (fits(preferred)) return { slug: preferred, downloaded: false, reason: 'configured' };
  return null;
}

async function resolveSummaryModel(preferred: string): Promise<SummaryModelChoice> {
  const downloaded = new Set((await listDownloadedCactusModels()).map(m => m.slug));
  const choice = chooseSummaryModel({
    preferred,
    downloaded,
    loaded: modelLifecycle.getLoadedModels(),
    budgetMb: modelLifecycle.getRamBudgetMb(),
  });
  if (!choice) {
    throw new Error(
      `${getModelBySlug(preferred)?.name ?? preferred} needs more memory than this phone has free, ` +
        'and no smaller text model is downloaded. Download LFM2.5-350M in Models, then retry.',
    );
  }
  if (choice.slug !== preferred) {
    console.log(`[Minutes] Using "${choice.slug}" instead of "${preferred}" (${choice.reason})`);
  }
  return choice;
}

/** Downloads with visible progress so ensure() then finds the weights cached. */
async function downloadWithProgress(slug: string, onProgress?: MinutesProgress): Promise<void> {
  const quantization = quantizationFor(slug);
  const lm = new CactusLM({ model: slug, options: quantization ? { quantization } : undefined });
  const name = getModelBySlug(slug)?.name ?? slug;
  try {
    await lm.download({
      onProgress: p =>
        onProgress?.(`Downloading ${name} · ${Math.round(p * 100)}%`, 0.02 + 0.3 * p),
    });
  } finally {
    await lm.destroy().catch(() => {});
  }
}

// ---------------------------------------------------------------------------

async function complete(lm: CactusLM, user: string, maxTokens: number): Promise<string> {
  try {
    await lm.reset();
  } catch {}
  const r = await lm.complete({
    messages: [
      { role: 'system', content: SYSTEM },
      { role: 'user', content: user },
    ],
    options: { temperature: 0.2, topP: 0.9, maxTokens },
  });
  return r.response ?? '';
}

export async function generateMinutes(
  meetingId: string,
  modelSlug: string,
  onProgress?: MinutesProgress,
): Promise<Meeting> {
  const meeting = await meetingStore.get(meetingId);
  if (!meeting) throw new Error('Meeting not found');
  const lines = transcriptLines(meeting);
  if (!lines.some(l => !l.includes('★')))
    throw new Error('Transcript is empty — nothing to summarise.');
  const spoken = new Set(
    meeting.segments.filter(s => s.status === 'done').flatMap(s => [...tokens(s.text)]),
  );
  if (spoken.size < MIN_DISTINCT_WORDS) {
    throw new Error(
      'Too little clear speech was transcribed to write minutes. Check the recording, then retry.',
    );
  }

  // Free the STT model before loading the LLM; phones rarely fit both comfortably.
  await transcriber.release();

  const choice = await resolveSummaryModel(modelSlug);
  const slug = choice.slug;
  if (!choice.downloaded) await downloadWithProgress(slug, onProgress);

  onProgress?.(`Loading ${getModelBySlug(slug)?.name ?? slug}`, 0.33);
  const managed = await modelLifecycle.ensure(slug);
  const lm = managed.instance;
  if (!lm) throw new Error(`Model ${slug} failed to load`);

  const chunks = chunkLines(lines, CHUNK_CHARS);
  const parts: PartialMinutes[] = [];
  for (let i = 0; i < chunks.length; i++) {
    onProgress?.(`Reading part ${i + 1} of ${chunks.length}`, 0.35 + (0.5 * i) / chunks.length);
    const raw = await complete(lm, mapPrompt(meeting, chunks[i], i, chunks.length), 900);
    const json = extractJson(raw);
    if (!json)
      console.warn(`[Minutes] Part ${i + 1}: no JSON in model output, using text fallback`);
    parts.push(normalizePartial(json, raw));
  }

  const merged = mergePartials(parts);
  let title = merged.title;
  let summary = merged.summary;
  if (chunks.length > 1) {
    onProgress?.('Writing summary', 0.9);
    const raw = await complete(lm, reducePrompt(meeting, merged), 400);
    const j = extractJson(raw);
    if (j?.summary) summary = String(j.summary).trim();
    if (j?.title) title = String(j.title).trim();
  }

  const meetingDate = new Date(meeting.startedAt);
  const now = Date.now();
  const previous = meeting.actionItems;
  const actionItems: ActionItem[] = merged.actionItems.map(a => {
    const prior = previous.find(p => similar(p.task, a.task));
    if (prior?.manual) return prior; // user's edit wins
    return {
      id: prior?.id ?? newActionId(),
      task: a.task,
      owner: a.owner,
      dueText: a.due,
      dueDate: resolveDue(a.due, meetingDate),
      priority: a.priority,
      status: prior?.status ?? 'open',
      completedAt: prior?.completedAt,
      calendarAdded: prior?.calendarAdded,
      createdAt: prior?.createdAt ?? now,
    };
  });
  // Keep items the user added by hand or already completed that the model no longer lists.
  for (const p of previous) {
    if (!actionItems.some(a => a.id === p.id) && (p.status === 'done' || p.manual)) {
      actionItems.push(p);
    }
  }

  const seen = new Set<string>();
  const uniqueActions = actionItems.filter(a => (seen.has(a.id) ? false : (seen.add(a.id), true)));

  const minutes: Minutes = {
    summary,
    keyPoints: merged.keyPoints,
    decisions: merged.decisions,
    openQuestions: merged.openQuestions,
    nextSteps: merged.nextSteps,
    generatedAt: now,
    model: slug,
    edited: false,
  };

  onProgress?.('Saving', 0.98);
  const updated = await meetingStore.update(meetingId, m => {
    m.minutes = minutes;
    m.actionItems = uniqueActions;
    if (title && isDefaultTitle(m)) m.title = title;
    m.status = 'ready';
    m.error = undefined;
  });
  onProgress?.('Done', 1);
  return updated!;
}

export function defaultTitle(ts: number, client?: string): string {
  const d = new Date(ts);
  const date = d.toLocaleDateString('en-IN', { day: 'numeric', month: 'short' });
  return client ? `${client} · ${date}` : `Meeting · ${date}`;
}

function isDefaultTitle(m: Meeting): boolean {
  return (
    !m.title.trim() ||
    m.title === defaultTitle(m.startedAt, m.client) ||
    m.title.startsWith('Meeting · ')
  );
}
