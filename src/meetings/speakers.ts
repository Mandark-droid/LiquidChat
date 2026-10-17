/**
 * Speaker identification maths, free of native calls so it can be unit-tested:
 * speech units from VAD, clustering of speaker embeddings, sentence-to-speaker
 * assignment inside each transcription window, and naming speakers from the text.
 */
import type { Attendee, Speaker, TranscriptSegment, Utterance } from './types';

export interface SpeechUnit {
  startMs: number;
  endMs: number;
  /** Segment the unit's audio lives in (VAD runs per segment file). */
  segmentIndex: number;
  speakerId?: string;
}

/** Units shorter than this get no embedding; they take a neighbour's speaker. */
export const MIN_EMBED_MS = 1000;
/** Centre crop embedded per unit; WeSpeaker cost grows linearly with length. */
export const EMBED_CROP_MS = 1000;
/** Cosine similarity above which two clusters are the same speaker (average linkage). */
export const SAME_SPEAKER_SIMILARITY = 0.25;

// ---------------------------------------------------------------------------
// Clustering

function normalise(v: number[]): number[] {
  const n = Math.sqrt(v.reduce((s, x) => s + x * x, 0)) || 1;
  return v.map(x => x / n);
}

/**
 * Average-linkage agglomerative clustering on cosine similarity. Merges while the best
 * pair is above `threshold`, and keeps merging past it while there are more clusters
 * than `maxSpeakers`. Labels are 0..k-1 in order of first appearance.
 */
export function clusterEmbeddings(
  vectors: number[][],
  opts: { threshold?: number; maxSpeakers?: number } = {},
): number[] {
  const threshold = opts.threshold ?? SAME_SPEAKER_SIMILARITY;
  const n = vectors.length;
  if (!n) return [];
  const x = vectors.map(normalise);
  const sim: number[][] = x.map(a => x.map(b => a.reduce((s, ai, k) => s + ai * b[k], 0)));
  const groups: number[][] = x.map((_, i) => [i]);
  const link = (a: number[], b: number[]) => {
    let s = 0;
    for (const i of a) for (const j of b) s += sim[i][j];
    return s / (a.length * b.length);
  };
  while (groups.length > 1) {
    let best = -Infinity;
    let pair: [number, number] = [0, 1];
    for (let a = 0; a < groups.length; a++)
      for (let b = a + 1; b < groups.length; b++) {
        const s = link(groups[a], groups[b]);
        if (s > best) {
          best = s;
          pair = [a, b];
        }
      }
    const tooMany = opts.maxSpeakers !== undefined && groups.length > opts.maxSpeakers;
    if (best < threshold && !tooMany) break;
    groups[pair[0]].push(...groups[pair[1]]);
    groups.splice(pair[1], 1);
  }
  const labels = new Array<number>(n);
  groups
    .map(g => [...g].sort((a, b) => a - b))
    .sort((a, b) => a[0] - b[0])
    .forEach((g, k) => g.forEach(i => (labels[i] = k)));
  return labels;
}

/** Short replies ("Agreed.", "I'll take that.") are embedded but only matched to known speakers. */
export const MIN_SHORT_EMBED_MS = 500;
/** Below this similarity to every known speaker, a short unit falls back to its neighbours. */
export const SHORT_MATCH_SIMILARITY = 0.15;

/**
 * Assigns short-unit embeddings to the most similar cluster centroid, so a short reply
 * never invents a new speaker. Returns unit index -> cluster for confident matches.
 */
export function matchToCentroids(
  centroidsOf: { vectors: number[][]; labels: number[] },
  shorts: { unit: number; vector: number[] }[],
): Map<number, number> {
  const k = Math.max(-1, ...centroidsOf.labels) + 1;
  const sums: number[][] = Array.from({ length: k }, () => []);
  centroidsOf.vectors.forEach((v, i) => {
    const n = normalise(v);
    const s = sums[centroidsOf.labels[i]];
    n.forEach((x, d) => (s[d] = (s[d] ?? 0) + x));
  });
  const centroids = sums.map(normalise);
  const out = new Map<number, number>();
  for (const { unit, vector } of shorts) {
    const v = normalise(vector);
    let best = -Infinity;
    let label = -1;
    centroids.forEach((c, j) => {
      const sim = c.reduce((acc, x, d) => acc + x * v[d], 0);
      if (sim > best) {
        best = sim;
        label = j;
      }
    });
    if (label >= 0 && best >= SHORT_MATCH_SIMILARITY) out.set(unit, label);
  }
  return out;
}

/**
 * Gives every unit a speaker: embedded units from their cluster, the rest from the
 * nearer neighbour in time (ties go to the previous speaker, who is usually finishing).
 */
export function labelUnits(units: SpeechUnit[], embedded: Map<number, number>): SpeechUnit[] {
  const out = units.map(u => ({ ...u }));
  const id = (k: number) => `S${k + 1}`;
  embedded.forEach((k, i) => (out[i].speakerId = id(k)));
  for (let i = 0; i < out.length; i++) {
    if (out[i].speakerId) continue;
    let p = i - 1;
    while (p >= 0 && !embedded.has(p)) p--;
    let q = i + 1;
    while (q < out.length && !embedded.has(q)) q++;
    const gapPrev = p >= 0 ? out[i].startMs - out[p].endMs : Infinity;
    const gapNext = q < out.length ? out[q].startMs - out[i].endMs : Infinity;
    if (p < 0 && q >= out.length) out[i].speakerId = id(0);
    else out[i].speakerId = gapPrev <= gapNext ? out[p].speakerId : out[q].speakerId;
  }
  return out;
}

// ---------------------------------------------------------------------------
// Text to speaker

/** Sentences, keeping their punctuation; handles the Devanagari danda. */
export function splitSentences(text: string): string[] {
  return (text.match(/[^.!?।]+(?:[.!?।]+|$)/g) ?? []).map(s => s.trim()).filter(Boolean);
}

/**
 * Splits a transcription window's text between the speakers who spoke in it. Whisper
 * gives no timestamps here, so a sentence's position in the text is mapped onto the
 * window's speech time; sentence breaks fall at pauses, which is where turns change.
 */
export function assignSentences(
  seg: Pick<TranscriptSegment, 'startMs' | 'durationMs' | 'text'>,
  units: SpeechUnit[],
  fallbackSpeaker: string,
): Utterance[] {
  const w0 = seg.startMs;
  const w1 = seg.startMs + seg.durationMs;
  const spans: { speakerId: string; startMs: number; endMs: number; speech: number }[] = [];
  for (const u of units) {
    const a = Math.max(u.startMs, w0);
    const b = Math.min(u.endMs, w1);
    if (b <= a || !u.speakerId) continue;
    const last = spans[spans.length - 1];
    if (last && last.speakerId === u.speakerId) {
      last.endMs = b;
      last.speech += b - a;
    } else spans.push({ speakerId: u.speakerId, startMs: a, endMs: b, speech: b - a });
  }
  const sentences = splitSentences(seg.text);
  if (!sentences.length) return [];
  if (!spans.length)
    return [{ speakerId: fallbackSpeaker, startMs: w0, endMs: w1, text: sentences.join(' ') }];

  // Place each speaker change at a sentence break so that, at every change, the share of
  // text so far best matches the share of speech time so far (least squares, monotone).
  const totalSpeech = spans.reduce((s, x) => s + x.speech, 0);
  const totalChars = sentences.reduce((s, x) => s + x.length, 0);
  const c = [0];
  for (const s of sentences) c.push(c[c.length - 1] + s.length / totalChars);
  const t = [0];
  for (const s of spans) t.push(t[t.length - 1] + s.speech / totalSpeech);
  const n = sentences.length;
  const k = spans.length;
  const cost: number[][] = Array.from({ length: k + 1 }, () => new Array(n + 1).fill(Infinity));
  const from: number[][] = Array.from({ length: k + 1 }, () => new Array(n + 1).fill(0));
  cost[0][0] = 0;
  for (let j = 1; j <= k; j++)
    for (let i = 0; i <= n; i++) {
      if (j === k && i !== n) continue;
      const here = j === k ? 0 : (c[i] - t[j]) ** 2;
      for (let p = 0; p <= i; p++)
        if (cost[j - 1][p] + here < cost[j][i]) {
          cost[j][i] = cost[j - 1][p] + here;
          from[j][i] = p;
        }
    }
  const owner = new Array<number>(n);
  for (let j = k, i = n; j > 0; j--) {
    const p = from[j][i];
    for (let x = p; x < i; x++) owner[x] = j - 1;
    i = p;
  }

  const out: Utterance[] = [];
  for (const [x, sentence] of sentences.entries()) {
    const span = spans[owner[x]];
    const last = out[out.length - 1];
    if (last && last.speakerId === span.speakerId) {
      last.text += ` ${sentence}`;
      last.endMs = span.endMs;
    } else
      out.push({
        speakerId: span.speakerId,
        startMs: span.startMs,
        endMs: span.endMs,
        text: sentence,
      });
  }
  return out;
}

// ---------------------------------------------------------------------------
// Names

const NOT_NAMES = new Set(
  (
    'sure sorry fine good done not just going here back happy glad afraid okay ready ' +
    'also still really very so the a an in on at with from and but yes yeah hello hi ' +
    'thanks thank everyone all team going trying talking speaking working looking ' +
    'monday tuesday wednesday thursday friday saturday sunday today tomorrow ' +
    'january february march april may june july august september october november december'
  ).split(' '),
);

/** [pattern, weight]: unambiguous self-introductions outweigh "this is X" / "main X". */
const INTRO_PATTERNS: [RegExp, number][] = [
  [/(?:^|[^A-Za-z])(?:[Ii]'m|[Ii] am|[Mm]y name is)\s+([A-Z][a-z]{2,})/g, 3],
  [/(?:^|[^A-Za-z])([A-Z][a-z]{2,})\s+here\b/g, 3],
  [/(?:^|[^A-Za-z])(?:[Tt]his is|[Mm]ain|[Mm]ai)\s+([A-Z][a-z]{2,})/g, 2],
  [/मैं\s+([ऀ-ॿ]{2,})\s+(?:हूँ|हूं)/g, 3],
];
const ADDRESS = /\b([A-Z][a-z]{2,}),\s*(?:can|could|would|will|do|are|please|kya|aap)\b/;
const AGREE =
  /^(?:sure|yes|yeah|yep|ok|okay|of course|definitely|absolutely|haan|ha|ji|i'll|i will|will do)\b/i;

function editDistance(a: string, b: string): number {
  const row = Array.from({ length: b.length + 1 }, (_, j) => j);
  for (let i = 1; i <= a.length; i++) {
    let prev = row[0];
    row[0] = i;
    for (let j = 1; j <= b.length; j++) {
      const cur = Math.min(row[j] + 1, row[j - 1] + 1, prev + (a[i - 1] === b[j - 1] ? 0 : 1));
      prev = row[j];
      row[j] = cur;
    }
  }
  return row[b.length];
}

/** Exact first/full name, else a close spelling (Whisper writes "Vikran" for Vikram). */
function matchAttendee(candidate: string, attendees: Attendee[]): string | null {
  const c = candidate.toLowerCase();
  const first = (a: Attendee) => a.name.trim().split(/\s+/)[0]?.toLowerCase() ?? '';
  const exact = attendees.find(a => first(a) === c || a.name.trim().toLowerCase() === c);
  if (exact) return exact.name.trim();
  let best: Attendee | null = null;
  let bestD = Infinity;
  for (const a of attendees) {
    const f = first(a);
    if (!f || f[0] !== c[0]) continue;
    const d = editDistance(c, f);
    if (d <= Math.max(1, Math.floor(Math.max(c.length, f.length) * 0.4)) && d < bestD) {
      best = a;
      bestD = d;
    }
  }
  return best ? best.name.trim() : null;
}

/**
 * Names speakers from self-introductions (strong) and "Name, can you…" answered by
 * another speaker (weak). With attendees given, only names matching one are used.
 */
export function inferSpeakerNames(
  utterances: Utterance[],
  attendees: Attendee[],
): Map<string, string> {
  const votes = new Map<string, Map<string, number>>();
  const vote = (speaker: string, raw: string, weight: number) => {
    if (NOT_NAMES.has(raw.toLowerCase())) return;
    const name = attendees.length ? matchAttendee(raw, attendees) : raw;
    if (!name) return;
    const m = votes.get(speaker) ?? new Map<string, number>();
    m.set(name, (m.get(name) ?? 0) + weight);
    votes.set(speaker, m);
  };
  utterances.forEach((u, i) => {
    for (const [re, weight] of INTRO_PATTERNS)
      for (const m of u.text.matchAll(re)) vote(u.speakerId, m[1], weight);
    const addressed = u.text.match(ADDRESS)?.[1];
    const next = utterances[i + 1];
    if (addressed && next && next.speakerId !== u.speakerId && AGREE.test(next.text.trim()))
      vote(next.speakerId, addressed, 1);
  });

  const pairs: { speaker: string; name: string; weight: number }[] = [];
  votes.forEach((m, speaker) => m.forEach((weight, name) => pairs.push({ speaker, name, weight })));
  pairs.sort((a, b) => b.weight - a.weight);
  const out = new Map<string, string>();
  const used = new Set<string>();
  for (const p of pairs) {
    if (out.has(p.speaker) || used.has(p.name)) continue;
    out.set(p.speaker, p.name);
    used.add(p.name);
  }
  return out;
}

export function speakerLabel(speakers: Speaker[] | undefined, id: string): string {
  const s = speakers?.find(x => x.id === id);
  return s?.name || `Speaker ${id.replace(/^S/, '')}`;
}
