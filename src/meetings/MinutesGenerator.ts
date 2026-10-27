import { CactusLM } from 'cactus-react-native';

import { getModelBySlug, LIQUID_MODELS, quantizationFor } from '../config/models';
import { usageLedger } from '../observability/usageLedger';
import { modelLifecycle } from '../services/ModelLifecycleManager';
import { listDownloadedCactusModels } from '../utils/engineMigration';
import { resolveDue, toIsoDate } from './dateResolver';
import { meetingStore, newActionId } from './MeetingStore';
import { speakerLabel } from './speakers';
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
    if (s.utterances?.length) {
      for (const u of s.utterances)
        lines.push({
          at: u.startMs,
          text: `[${formatClock(u.startMs)}] ${speakerLabel(m.speakers, u.speakerId)}: ${u.text}`,
        });
      return;
    }
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

Extract the minutes for THIS part. Return a JSON object with exactly these keys (replace every <...> with real content, or use [] / ""):
{"title": "<short meeting title, max 8 words>",
 "summary": "<2-3 sentence summary of this part>",
 "key_points": ["<main discussion point>"],
 "decisions": ["<decision that was agreed>"],
 "action_items": [{"task": "<what must be done>", "owner": "<speaker name, or empty>", "due": "<deadline exactly as said, or empty>", "priority": "high|medium|low"}],
 "open_questions": ["<unresolved question>"],
 "next_steps": ["<next step>"]}

Rules:
- Use only what is said in the transcript. Never invent names, numbers or dates.
- An action item is a concrete commitment ("I will send…", "can you share…", "let's schedule…").
- Lines start with the speaker's name. "I", "I'll" or "main" means that line's speaker: put their name as owner, never "I". When someone answers "Sure"/"I'll do it" to a request, the person answering is the owner.
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
  /^(\.{2,}|…|n\/?a|none|tbd|<[^>]*>|one string per .*|main discussion point|decision that was agreed|unresolved question|what must be done|next step)\.?$/i;

const strList = (v: any): string[] =>
  Array.isArray(v)
    ? v
        .map(x => (typeof x === 'string' ? x : (x?.text ?? x?.point ?? JSON.stringify(x))))
        .map(s => String(s).trim())
        .filter(s => s && !TEMPLATE_ECHO.test(s))
    : [];

export function normalizePartial(j: any, raw: string): PartialMinutes {
  const src = j ?? parseHeadedText(raw);
  const actions = Array.isArray(src.action_items ?? src.actionItems)
    ? (src.action_items ?? src.actionItems)
    : [];
  return {
    title: String(src.title ?? '')
      .trim()
      .replace(TEMPLATE_ECHO, ''),
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
        owner: ((o?: string) => (o && SELF.test(o) ? undefined : o))(
          cleanField(a.owner ?? a.assignee),
        ),
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

export async function resolveSummaryModel(preferred: string): Promise<SummaryModelChoice> {
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
  usageLedger.record('local', r.prefillTokens, r.decodeTokens);
  return r.response ?? '';
}

// ---------------------------------------------------------------------------
// Commitments: small models drop or merge action items buried in a long transcript, and
// misattribute them. With speaker labels the owner is simply the line's speaker, and the
// deadline is in the line; the model only phrases the task, one line at a time.

/** The speaker commits to doing something ("I'll…", "main … kar dunga", "मैं … करूँगा"). */
const SELF_COMMITMENT =
  /\b(?:i'll|i will|i can take|i'm going to|i shall|will do)\b|\bmain\b.*\b(?:karunga|karungi|kar dunga|kar dungi|le lunga|le lungi|bhej dunga|bhej dungi|dekh lunga)\b|(?:करूँगा|करूँगी|कर दूँगा|कर दूँगी|लूँगा|लूँगी|भेज दूँगा|भेज दूँगी)/i;

const DAYS = 'monday|tuesday|wednesday|thursday|friday|saturday|sunday';
const MONTHS =
  'january|february|march|april|may|june|july|august|september|october|november|december';
const WHEN = `(?:next\\s+)?(?:${DAYS}|week|month|tomorrow|today|tonight|eod|end of (?:the )?(?:day|week|month))|\\d{1,2}(?:st|nd|rd|th)?(?: of)? (?:${MONTHS})|(?:${MONTHS}) \\d{1,2}(?:st|nd|rd|th)?`;
const DUE = new RegExp(
  `\\b(?:(?:by|before|till|until|on)\\s+(?:${WHEN})|(?:${WHEN})\\s+tak|next (?:${DAYS}))\\b`,
  'i',
);

const LINE = /^\[[\d:]+\]\s+([^:]+):\s+(.*)$/;

export interface Commitment {
  owner: string;
  text: string;
  previous?: string;
  due?: string;
}

/** Every line where the speaker commits to something, with the request before it. */
export function findCommitments(lines: string[]): Commitment[] {
  const out: Commitment[] = [];
  lines.forEach((line, i) => {
    const m = line.match(LINE);
    if (!m || line.includes('★ FLAGGED BY USER') || !SELF_COMMITMENT.test(m[2])) return;
    const prev = lines[i - 1]?.match(LINE);
    out.push({
      owner: m[1].trim(),
      text: m[2].trim(),
      previous: prev ? `${prev[1]}: ${prev[2]}` : undefined,
      due: m[2].match(DUE)?.[0],
    });
  });
  return out;
}

function taskPrompt(c: Commitment): string {
  return `Line: "${c.owner}: ${c.text}"
${c.previous ? `Line before it: "${c.previous}"\n` : ''}
${c.owner} committed to a task in the first line. Reply with JSON {"task": "<what ${c.owner} will do, in the words of that line, as a short imperative, max 10 words>"}`;
}

/** The commitment itself, without lead-ins, for when the model's phrasing is unusable. */
function plainTask(text: string): string {
  const words = text
    .replace(/^(?:(?:sure|okay|ok|yes|yeah|haan|ji|and|so|great|right)[,.!]?\s+)+/i, '')
    .replace(/^(?:i'll take that[.!]?\s*)/i, '')
    .replace(/^(?:i will|i'll|i can|i'm going to|i shall)\s+/i, '')
    .split(/\s+/);
  const short = words.slice(0, 12).join(' ');
  return short.charAt(0).toUpperCase() + short.slice(1);
}

/** Owners named "Speaker N" are still useful; only pronouns are dropped. */
const SELF = /^(i|me|myself|main|mai|मैं)$/i;

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
    const prompt = mapPrompt(meeting, chunks[i], i, chunks.length);
    let raw = await complete(lm, prompt, 900);
    let json = extractJson(raw);
    if (!json) {
      // Small models sometimes answer in prose; one firmer ask usually yields the JSON.
      raw = await complete(
        lm,
        `${prompt}

Reply with the JSON object only. Start with {`,
        900,
      );
      json = extractJson(raw);
    }
    if (!json)
      console.warn(`[Minutes] Part ${i + 1}: no JSON in model output, using text fallback`);
    parts.push(normalizePartial(json, raw));
  }

  let merged = mergePartials(parts);

  const commitments = findCommitments(lines);
  if (commitments.length) {
    const items: PartialMinutes['actionItems'] = [];
    const unphrased: Commitment[] = [];
    for (const [i, c] of commitments.entries()) {
      onProgress?.(
        `Finding action items (${i + 1}/${commitments.length})`,
        0.86 + (0.1 * i) / commitments.length,
      );
      const j = extractJson(await complete(lm, taskPrompt(c), 80));
      const task = String(j?.task ?? '')
        .trim()
        .replace(TEMPLATE_ECHO, '');
      const owner = SELF.test(c.owner) ? undefined : c.owner;
      // A task sharing no words with what was said is a copied template, not a summary.
      const said = tokens(c.text);
      const grounded = [...tokens(task)].filter(w => said.has(w)).length >= 1;
      if (task && grounded) items.push({ task, owner, due: c.due });
      else unphrased.push({ ...c, owner: owner ?? '' });
    }
    const focused: PartialMinutes = { ...mergePartials([]), actionItems: items };
    // Per-line items first: their owners and deadlines come straight from the transcript.
    merged = { ...merged, actionItems: mergePartials([focused, merged]).actionItems };
    // A line the model could not phrase still fixes the owner/deadline of its closest item.
    for (const c of unphrased) {
      const words = tokens(c.text);
      let best = 0;
      let hit: PartialMinutes['actionItems'][number] | undefined;
      for (const a of merged.actionItems) {
        const t = tokens(a.task);
        const overlap = [...t].filter(w => words.has(w)).length / Math.max(1, t.size);
        if (overlap > best) {
          best = overlap;
          hit = a;
        }
      }
      if (hit && best >= 0.5) {
        if (c.owner) hit.owner = c.owner;
        hit.due ??= c.due;
      } else {
        merged.actionItems.push({
          task: plainTask(c.text),
          owner: c.owner || undefined,
          due: c.due,
        });
      }
    }
  }
  let title = merged.title;
  let summary = merged.summary;
  if (chunks.length > 1) {
    onProgress?.('Writing summary', 0.9);
    const raw = await complete(lm, reducePrompt(meeting, merged), 400);
    const j = extractJson(raw);
    if (j?.summary) summary = String(j.summary).trim();
    if (j?.title) title = String(j.title).trim();
  }

  return applyMinutes(meeting, { ...merged, title, summary }, slug, onProgress);
}

/**
 * Saves minutes for a meeting from either engine (on-device or the LiquidChat Space): action
 * items keep the user's edits and completed state, deadlines are resolved against the meeting date.
 */
export async function applyMinutes(
  meeting: Meeting,
  merged: PartialMinutes,
  slug: string,
  onProgress?: MinutesProgress,
): Promise<Meeting> {
  const meetingId = meeting.id;
  const { title, summary } = merged;
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
