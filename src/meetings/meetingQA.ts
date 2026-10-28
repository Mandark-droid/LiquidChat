/**
 * "Ask about this meeting": each question gets the minutes plus the transcript passages most
 * relevant to it, instead of the first few minutes of transcript. Small on-device models only
 * attend to a short window, so what goes in the prompt has to be chosen, not truncated.
 */
import { trace } from '@opentelemetry/api';

import { recordDocuments, setContent } from '../observability/spans';
import { transcriptLines } from './MinutesGenerator';
import type { Meeting } from './types';

export const MEETING_QA_PROMPT =
  'You answer questions about one meeting using only the meeting notes and transcript excerpts ' +
  'given below. Name who said or owns something when the notes show it, and cite times like ' +
  '[12:30]. If the answer is not in the material, say it was not discussed. Answer in English, briefly.';

const STOP = new Set(
  (
    'a an the and or but if of to in on at for with from by about as is are was were be been it ' +
    'this that these those what which who whom whose when where why how do does did can could ' +
    'should would will shall may might must i me my we our you your he she they them their his her ' +
    'its there here any all some no not so than then too very just also meeting discussed discuss ' +
    'tell say said give list please us'
  ).split(' '),
);

/** Lower-case word stems; crude, but stable for English and romanized Hindi. */
export function terms(text: string): string[] {
  return (text.toLowerCase().match(/[\p{L}\p{N}]+/gu) ?? [])
    .filter(w => w.length > 1 && !STOP.has(w))
    .map(w => w.replace(/(ing|ed|es|s)$/, '') || w);
}

interface Passage {
  order: number;
  text: string;
  terms: string[];
}

/** Overlapping windows of consecutive transcript lines. */
export function passages(lines: string[], maxChars = 700): Passage[] {
  const out: Passage[] = [];
  let i = 0;
  while (i < lines.length) {
    let j = i;
    let len = 0;
    while (j < lines.length && (j === i || len + lines[j].length <= maxChars))
      len += lines[j++].length + 1;
    const text = lines.slice(i, j).join('\n');
    out.push({ order: out.length, text, terms: terms(text) });
    if (j >= lines.length) break;
    i = Math.max(i + 1, j - 1); // one line of overlap keeps an answer and its question together
  }
  return out;
}

/** BM25 ranking of passages against the question. */
export function rank(question: string, ps: Passage[]): { p: Passage; score: number }[] {
  const q = [...new Set(terms(question))];
  if (!q.length || !ps.length) return ps.map(p => ({ p, score: 0 }));
  const avg = ps.reduce((n, p) => n + p.terms.length, 0) / ps.length || 1;
  const df = new Map<string, number>();
  for (const p of ps) for (const t of new Set(p.terms)) df.set(t, (df.get(t) ?? 0) + 1);
  return ps
    .map(p => {
      const tf = new Map<string, number>();
      for (const t of p.terms) tf.set(t, (tf.get(t) ?? 0) + 1);
      let score = 0;
      for (const t of q) {
        const f = tf.get(t) ?? 0;
        if (!f) continue;
        const idf = Math.log(1 + (ps.length - (df.get(t) ?? 0) + 0.5) / ((df.get(t) ?? 0) + 0.5));
        score += (idf * f * 2.2) / (f + 1.2 * (0.25 + (0.75 * p.terms.length) / avg));
      }
      return { p, score };
    })
    .sort((a, b) => b.score - a.score);
}

/** Title, people, summary, decisions and action items, as plain text. */
export function notes(m: Meeting): string {
  const out: string[] = [`Meeting: ${m.title} (${new Date(m.startedAt).toDateString()})`];
  if (m.attendees.length) out.push(`Attendees: ${m.attendees.map(a => a.name).join(', ')}`);
  const mins = m.minutes;
  if (mins?.summary) out.push(`Summary: ${mins.summary}`);
  if (mins?.decisions?.length)
    out.push(`Decisions:\n${mins.decisions.map(d => `- ${d}`).join('\n')}`);
  if (m.actionItems.length)
    out.push(
      `Action items:\n${m.actionItems
        .map(
          a =>
            `- ${a.task}${a.owner ? ` — owner: ${a.owner}` : ''}` +
            `${a.dueDate || a.dueText ? ` — due: ${a.dueDate ?? a.dueText}` : ''}` +
            `${a.status === 'done' ? ' (done)' : ''}`,
        )
        .join('\n')}`,
    );
  return out.join('\n');
}

/**
 * The material for one question, within a character budget: the meeting's notes, then the
 * best-matching transcript passages in meeting order (the opening of the meeting when nothing matches).
 */
// On the phone the model reads ~20 tokens/s, so ~3000 characters (~750 tokens) keeps answers under a minute.
export function meetingContext(m: Meeting, question: string, budgetChars = 3000): string {
  const span = trace.getTracer('liquidchat').startSpan('retrieve meeting', {
    attributes: {
      'gen_ai.operation.name': 'retrieve',
      'liquidchat.retrieval.method': 'bm25',
      'liquidchat.meeting.id': m.id,
    },
  });
  try {
    const { ctx, picked } = buildMeetingContext(m, question, budgetChars);
    span.setAttribute('liquidchat.retrieval.context_chars', ctx.length);
    recordDocuments(
      span,
      picked.map(({ p, score }) => ({
        id: `${m.id}#${p.order}`,
        score,
        content: p.text,
        metadata: { position: p.order },
      })),
      question,
    );
    setContent(span, 'liquidchat.retrieval.context', ctx);
    return ctx;
  } finally {
    span.end();
  }
}

/** The context, and the passages chosen for it in rank order (best first). */
function buildMeetingContext(
  m: Meeting,
  question: string,
  budgetChars: number,
): { ctx: string; picked: { p: Passage; score: number }[] } {
  const head = notes(m).slice(0, Math.floor(budgetChars * 0.45));
  let room = budgetChars - head.length;
  const ranked = rank(question, passages(transcriptLines(m)));
  const matched = ranked.some(r => r.score > 0) ? ranked.filter(r => r.score > 0) : ranked;
  const picked: { p: Passage; score: number }[] = [];
  for (const hit of matched) {
    if (hit.p.text.length + 2 > room) continue;
    picked.push(hit);
    room -= hit.p.text.length + 2;
  }
  const excerpts = [...picked].sort((a, b) => a.p.order - b.p.order).map(h => h.p.text);
  const ctx = `\n\n## Meeting notes\n${head}${
    excerpts.length ? `\n\n## Transcript excerpts\n${excerpts.join('\n…\n')}` : ''
  }`;
  return { ctx, picked };
}
