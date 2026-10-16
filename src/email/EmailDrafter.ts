import AsyncStorage from '@react-native-async-storage/async-storage';
import { Linking } from 'react-native';

import { fmtDue } from '../meetings/documents';
import { extractJson } from '../meetings/MinutesGenerator';
import type { Meeting } from '../meetings/types';
import { modelLifecycle } from '../services/ModelLifecycleManager';

/**
 * On-device email drafting agent.
 *
 * Modes:
 *   followup  — from a meeting: thanks, summary, decisions, action items, next meeting
 *   compose   — from a one-line intent ("tell Rahul the demo moves to Tuesday")
 *   reply     — to a pasted email
 * Every draft can be refined with a free-text instruction; the history of
 * instructions is kept so refinements compound instead of drifting.
 */

export type EmailMode = 'followup' | 'compose' | 'reply';
export type EmailTone = 'professional' | 'friendly' | 'concise' | 'formal' | 'apologetic' | 'firm';

export const TONES: { key: EmailTone; label: string }[] = [
  { key: 'professional', label: 'Professional' },
  { key: 'friendly', label: 'Friendly' },
  { key: 'concise', label: 'Concise' },
  { key: 'formal', label: 'Formal' },
  { key: 'apologetic', label: 'Apologetic' },
  { key: 'firm', label: 'Firm' },
];

export interface EmailDraft {
  id: string;
  mode: EmailMode;
  tone: EmailTone;
  to: string[];
  cc: string[];
  subject: string;
  body: string;
  intent: string; // compose intent / reply instructions
  sourceEmail?: string; // reply mode
  meetingId?: string;
  refinements: string[];
  model: string;
  createdAt: number;
  updatedAt: number;
}

export interface DraftRequest {
  mode: EmailMode;
  tone: EmailTone;
  intent: string;
  to?: string[];
  recipientName?: string;
  senderName?: string;
  sourceEmail?: string;
  meeting?: Meeting;
  model: string;
}

const KEY = '@liquid_email_drafts';
const MAX_DRAFTS = 50;

const SYSTEM =
  'You are an expert email writer. You write clear, natural emails that sound like a real person, ' +
  'never robotic. You never invent facts, numbers, dates or commitments that were not given. ' +
  'You reply with a single JSON object: {"subject": "...", "body": "..."}. ' +
  'The body is plain text with line breaks, a greeting, and a sign-off.';

function toneGuide(t: EmailTone): string {
  switch (t) {
    case 'friendly':
      return 'warm and friendly, still professional';
    case 'concise':
      return 'very short and to the point (under 120 words)';
    case 'formal':
      return 'formal business English';
    case 'apologetic':
      return 'sincerely apologetic and solution-oriented';
    case 'firm':
      return 'polite but firm and unambiguous';
    default:
      return 'professional and courteous';
  }
}

function meetingFacts(m: Meeting): string {
  const date = new Date(m.startedAt).toLocaleDateString('en-IN', {
    weekday: 'long',
    day: 'numeric',
    month: 'long',
  });
  const lines = [`Meeting: ${m.title} on ${date}`];
  if (m.client) lines.push(`Client: ${m.client}`);
  if (m.attendees.length) lines.push(`Attendees: ${m.attendees.map(a => a.name).join(', ')}`);
  if (m.minutes?.summary) lines.push(`Summary: ${m.minutes.summary}`);
  if (m.minutes?.decisions.length)
    lines.push(`Decisions:\n${m.minutes.decisions.map(d => `- ${d}`).join('\n')}`);
  const open = m.actionItems.filter(a => a.status === 'open');
  if (open.length) {
    lines.push(
      `Action items:\n${open.map(a => `- ${a.task}${a.owner ? ` (owner: ${a.owner})` : ''}${a.dueDate || a.dueText ? ` — due ${fmtDue(a)}` : ''}`).join('\n')}`,
    );
  }
  if (m.minutes?.nextSteps.length)
    lines.push(`Next steps:\n${m.minutes.nextSteps.map(s => `- ${s}`).join('\n')}`);
  if (m.nextMeeting) lines.push(`Next meeting: ${m.nextMeeting}`);
  return lines.join('\n');
}

function buildPrompt(r: DraftRequest): string {
  const who = [
    r.recipientName ? `Recipient: ${r.recipientName}` : '',
    r.senderName ? `Sender (sign off as): ${r.senderName}` : '',
  ]
    .filter(Boolean)
    .join('\n');
  const tone = `Tone: ${toneGuide(r.tone)}.`;
  if (r.mode === 'followup' && r.meeting) {
    return `Write a follow-up email to the client after a meeting.
${who}
${tone}

Facts from the meeting:
${meetingFacts(r.meeting)}

${r.intent ? `Extra instructions: ${r.intent}\n` : ''}Thank them for their time, recap the key outcomes briefly, list the action items with owners and dates as a short list, and mention that the full minutes are attached. Return JSON {"subject": "...", "body": "..."}.`;
  }
  if (r.mode === 'reply' && r.sourceEmail) {
    return `Write a reply to the email below.
${who}
${tone}
What the reply should say: ${r.intent || 'respond appropriately to every question or request in the email'}

Email to reply to:
"""
${r.sourceEmail.slice(0, 5000)}
"""
Return JSON {"subject": "Re: ...", "body": "..."}.`;
  }
  return `Write an email.
${who}
${tone}
What the email must say: ${r.intent}
Return JSON {"subject": "...", "body": "..."}.`;
}

function parseDraft(raw: string): { subject: string; body: string } {
  const j = extractJson(raw);
  if (j && (j.body || j.subject)) {
    return {
      subject: String(j.subject ?? '').trim(),
      body: String(j.body ?? '')
        .replace(/\\n/g, '\n')
        .trim(),
    };
  }
  // Fallback: "Subject: …" on the first line, rest is the body.
  const cleaned = raw
    .replace(/<think>[\s\S]*?<\/think>/gi, '')
    .replace(/```[a-z]*\n?/gi, '')
    .trim();
  const m = cleaned.match(/^\s*subject\s*:\s*(.+)\n([\s\S]*)$/i);
  return m ? { subject: m[1].trim(), body: m[2].trim() } : { subject: '', body: cleaned };
}

async function run(
  model: string,
  messages: { role: 'system' | 'user' | 'assistant'; content: string }[],
) {
  const managed = await modelLifecycle.ensure(model);
  const lm = managed.instance;
  if (!lm) throw new Error(`Model ${model} failed to load`);
  try {
    await lm.reset();
  } catch {}
  const r = await lm.complete({
    messages,
    options: { temperature: 0.5, topP: 0.9, maxTokens: 700 },
  });
  return r.response ?? '';
}

export async function draftEmail(r: DraftRequest): Promise<EmailDraft> {
  const raw = await run(r.model, [
    { role: 'system', content: SYSTEM },
    { role: 'user', content: buildPrompt(r) },
  ]);
  const { subject, body } = parseDraft(raw);
  const now = Date.now();
  let fallbackSubject = '';
  if (!subject && r.meeting) fallbackSubject = `Follow-up: ${r.meeting.title}`;
  return {
    id: `eml_${now.toString(36)}${Math.random().toString(36).slice(2, 6)}`,
    mode: r.mode,
    tone: r.tone,
    to: r.to ?? [],
    cc: [],
    subject: subject || fallbackSubject,
    body,
    intent: r.intent,
    sourceEmail: r.sourceEmail,
    meetingId: r.meeting?.id,
    refinements: [],
    model: r.model,
    createdAt: now,
    updatedAt: now,
  };
}

/** Applies an instruction ("shorter", "mention the invoice") to the current draft. */
export async function refineDraft(
  d: EmailDraft,
  instruction: string,
  model?: string,
): Promise<EmailDraft> {
  const history = [...d.refinements, instruction];
  const raw = await run(model ?? d.model, [
    { role: 'system', content: SYSTEM },
    {
      role: 'user',
      content: `Here is an email draft:
Subject: ${d.subject}

${d.body}

Revise it. Instructions (apply all, most recent last):
${history.map((h, i) => `${i + 1}. ${h}`).join('\n')}
Keep every fact unchanged unless an instruction says otherwise. Return JSON {"subject": "...", "body": "..."}.`,
    },
  ]);
  const { subject, body } = parseDraft(raw);
  return {
    ...d,
    subject: subject || d.subject,
    body: body || d.body,
    refinements: history,
    updatedAt: Date.now(),
  };
}

// ---------------------------------------------------------------------------
// Persistence

export async function listDrafts(): Promise<EmailDraft[]> {
  try {
    const raw = await AsyncStorage.getItem(KEY);
    return raw ? JSON.parse(raw) : [];
  } catch {
    return [];
  }
}

export async function saveDraft(d: EmailDraft): Promise<void> {
  const all = (await listDrafts()).filter(x => x.id !== d.id);
  all.unshift(d);
  await AsyncStorage.setItem(KEY, JSON.stringify(all.slice(0, MAX_DRAFTS)));
}

export async function deleteDraft(id: string): Promise<void> {
  const all = (await listDrafts()).filter(x => x.id !== id);
  await AsyncStorage.setItem(KEY, JSON.stringify(all));
}

/** Opens the user's mail app with the draft prefilled (no attachment). */
export async function openInMailApp(d: EmailDraft): Promise<void> {
  const q: string[] = [];
  if (d.cc.length) q.push(`cc=${encodeURIComponent(d.cc.join(','))}`);
  q.push(`subject=${encodeURIComponent(d.subject)}`);
  q.push(`body=${encodeURIComponent(d.body)}`);
  const url = `mailto:${d.to.map(encodeURIComponent).join(',')}?${q.join('&')}`;
  await Linking.openURL(url);
}

export function draftAsText(d: EmailDraft): string {
  return `${d.to.length ? `To: ${d.to.join(', ')}\n` : ''}Subject: ${d.subject}\n\n${d.body}`;
}
