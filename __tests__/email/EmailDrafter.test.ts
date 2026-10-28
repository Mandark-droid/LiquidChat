import AsyncStorage from '@react-native-async-storage/async-storage';
import { Linking } from 'react-native';

import {
  deleteDraft,
  draftAsText,
  draftEmail,
  type DraftRequest,
  type EmailDraft,
  listDrafts,
  openInMailApp,
  refineDraft,
  saveDraft,
  TONES,
} from '../../src/email/EmailDrafter';
import { modelLifecycle } from '../../src/services/ModelLifecycleManager';
import { action, makeMeeting } from '../meetings/fixtures';

let mockDownloaded = ['lfm2.5-1.2b-instruct', 'lfm2.5-350m', 'big'];
jest.mock('../../src/utils/engineMigration', () => ({
  listDownloadedCactusModels: async () => mockDownloaded.map(slug => ({ slug })),
}));
jest.mock('../../src/services/ModelLifecycleManager', () => ({
  modelLifecycle: {
    ensure: jest.fn(),
    recordCompletion: jest.fn(),
    getLoadedModels: () => [],
    getRamBudgetMb: () => 0,
  },
}));

const ensure = modelLifecycle.ensure as jest.Mock;

type Msg = { role: string; content: string };
interface CompleteArgs {
  messages: Msg[];
  options: { maxTokens: number; temperature: number };
}

function fakeLM(response: string | (() => string)) {
  const calls: CompleteArgs[] = [];
  const lm = {
    reset: jest.fn(async () => {}),
    complete: jest.fn(async (args: CompleteArgs) => {
      calls.push(args);
      return { response: typeof response === 'string' ? response : response() };
    }),
  };
  ensure.mockResolvedValue({ instance: lm });
  return { lm, calls, user: () => calls[calls.length - 1].messages[1].content };
}

const draft = (over: Partial<EmailDraft> = {}): EmailDraft => ({
  id: 'eml_1',
  mode: 'compose',
  tone: 'professional',
  to: [],
  cc: [],
  subject: 'Hello',
  body: 'Hi Rahul,\n\nQuick note.\n\nThanks',
  intent: 'say hi',
  refinements: [],
  model: 'lfm',
  createdAt: 1,
  updatedAt: 1,
  ...over,
});

beforeEach(async () => {
  ensure.mockReset();
  await AsyncStorage.clear();
});

describe('draftAsText', () => {
  it('renders subject and body without a To line when there are no recipients', () => {
    expect(draftAsText(draft())).toBe('Subject: Hello\n\nHi Rahul,\n\nQuick note.\n\nThanks');
  });

  it('includes a comma-separated To line', () => {
    expect(draftAsText(draft({ to: ['a@x.com', 'b@y.com'], subject: '', body: '' }))).toBe(
      'To: a@x.com, b@y.com\nSubject: \n\n',
    );
  });
});

describe('TONES', () => {
  it('exposes six unique tones with labels', () => {
    expect(TONES.map(t => t.key)).toEqual([
      'professional',
      'friendly',
      'concise',
      'formal',
      'apologetic',
      'firm',
    ]);
    expect(TONES.every(t => t.label.length > 0)).toBe(true);
  });
});

describe('draftEmail', () => {
  const meeting = makeMeeting({
    nextMeeting: 'Tue 20 Oct, 11:00',
    actionItems: [
      action({ task: 'Send revised proposal', owner: 'Priya', dueDate: '2026-10-23' }),
      action({ task: 'Share access', dueText: 'after sign-off' }),
      action({ task: 'Book follow-up call', status: 'done' }),
    ],
  });
  const followup = (over: Partial<DraftRequest> = {}): DraftRequest => ({
    mode: 'followup',
    tone: 'friendly',
    intent: 'mention the invoice',
    to: ['rahul@acme.com'],
    recipientName: 'Rahul',
    senderName: 'Kshitij',
    meeting,
    model: 'lfm2.5-1.2b-instruct',
    ...over,
  });

  it('follow-up prompt carries the meeting context, open actions and the tone', async () => {
    const { lm, calls, user } = fakeLM(
      '{"subject": "Thanks for today", "body": "Hi Rahul,\\nThanks."}',
    );
    const out = await draftEmail(followup());

    expect(ensure).toHaveBeenCalledWith('lfm2.5-1.2b-instruct');
    expect(lm.reset).toHaveBeenCalled();
    expect(calls[0].messages[0].role).toBe('system');
    expect(calls[0].messages[0].content).toMatch(/never invent facts/i);
    expect(calls[0].options.maxTokens).toBe(700);

    const p = user();
    expect(p).toContain('Write a follow-up email');
    expect(p).toContain('Tone: warm and friendly, still professional.');
    expect(p).toContain('Recipient: Rahul');
    expect(p).toContain('Sender (sign off as): Kshitij');
    expect(p).toMatch(/Meeting: Acme kickoff on Friday,? 16 October/);
    expect(p).toContain('Client: Acme');
    expect(p).toContain('Attendees: Rahul Mehta, Priya');
    expect(p).toContain('Summary: Kickoff of the Acme engagement.');
    expect(p).toContain('Decisions:\n- Go with the fixed-price model');
    expect(p).toContain('- Send revised proposal (owner: Priya) — due 23 Oct 2026');
    expect(p).toContain('- Share access — due after sign-off');
    expect(p).not.toContain('Book follow-up call');
    expect(p).toContain('Next steps:\n- Share the SOW draft');
    expect(p).toContain('Next meeting: Tue 20 Oct, 11:00');
    expect(p).toContain('Extra instructions: mention the invoice');

    expect(out).toMatchObject({
      mode: 'followup',
      tone: 'friendly',
      to: ['rahul@acme.com'],
      cc: [],
      subject: 'Thanks for today',
      body: 'Hi Rahul,\nThanks.',
      intent: 'mention the invoice',
      meetingId: meeting.id,
      refinements: [],
      model: 'lfm2.5-1.2b-instruct',
    });
    expect(out.id).toMatch(/^eml_/);
    expect(out.createdAt).toBe(out.updatedAt);
  });

  it.each([
    ['professional', 'professional and courteous'],
    ['concise', 'under 120 words'],
    ['formal', 'formal business English'],
    ['apologetic', 'sincerely apologetic'],
    ['firm', 'polite but firm'],
  ] as const)('tone %p is described in the prompt', async (tone, phrase) => {
    const { user } = fakeLM('{"subject":"s","body":"b"}');
    await draftEmail({ mode: 'compose', tone, intent: 'x', model: 'm' });
    expect(user()).toContain(phrase);
  });

  it('compose prompt includes the intent and has no meeting facts', async () => {
    const { user } = fakeLM('{"subject":"Demo moves","body":"Hi"}');
    const out = await draftEmail({
      mode: 'compose',
      tone: 'concise',
      intent: 'tell Rahul the demo moves to Tuesday',
      model: 'm',
    });
    expect(user()).toContain('What the email must say: tell Rahul the demo moves to Tuesday');
    expect(user()).not.toContain('Meeting:');
    expect(out.to).toEqual([]);
    expect(out.meetingId).toBeUndefined();
  });

  it('reply prompt quotes the source email (capped at 5000 chars) with a default intent', async () => {
    const { user } = fakeLM('{"subject":"Re: Invoice","body":"Hi"}');
    const source = 'Can you resend the invoice? ' + 'z'.repeat(6000) + 'END-MARKER';
    const out = await draftEmail({
      mode: 'reply',
      tone: 'formal',
      intent: '',
      sourceEmail: source,
      model: 'm',
    });
    expect(user()).toContain('Write a reply to the email below.');
    expect(user()).toContain('respond appropriately to every question or request');
    expect(user()).toContain('Can you resend the invoice?');
    expect(user()).not.toContain('END-MARKER');
    expect(out.sourceEmail).toBe(source);
  });

  it('follow-up without a meeting falls back to a compose prompt', async () => {
    const { user } = fakeLM('{"subject":"s","body":"b"}');
    await draftEmail({ mode: 'followup', tone: 'friendly', intent: 'check in', model: 'm' });
    expect(user()).toContain('Write an email.');
    expect(user()).toContain('What the email must say: check in');
  });

  it('parses fenced JSON with think blocks and literal \\n escapes', async () => {
    fakeLM('<think>plan</think>```json\n{"subject": " Hi ", "body": "Line 1\\\\nLine 2"}\n```');
    const out = await draftEmail({ mode: 'compose', tone: 'friendly', intent: 'x', model: 'm' });
    expect(out.subject).toBe('Hi');
    expect(out.body).toBe('Line 1\nLine 2');
  });

  it('falls back to "Subject:" first-line parsing for non-JSON output', async () => {
    fakeLM('```\nSubject: Quick update\nHi Rahul,\n\nThe demo moved.\n\nBest,\nK\n```');
    const out = await draftEmail({ mode: 'compose', tone: 'friendly', intent: 'x', model: 'm' });
    expect(out.subject).toBe('Quick update');
    expect(out.body).toBe('Hi Rahul,\n\nThe demo moved.\n\nBest,\nK');
  });

  it('uses the raw text as body and a meeting-based subject when nothing parses', async () => {
    fakeLM('Hi Rahul, thanks for the time today.');
    const out = await draftEmail(followup());
    expect(out.subject).toBe('Follow-up: Acme kickoff');
    expect(out.body).toBe('Hi Rahul, thanks for the time today.');

    fakeLM('Just a body.');
    const plain = await draftEmail({ mode: 'compose', tone: 'friendly', intent: 'x', model: 'm' });
    expect(plain.subject).toBe('');
  });

  it('throws when the model fails to load', async () => {
    ensure.mockResolvedValue({ instance: null });
    await expect(
      draftEmail({ mode: 'compose', tone: 'friendly', intent: 'x', model: 'nope' }),
    ).rejects.toThrow('Model nope failed to load');
  });
});

describe('refineDraft', () => {
  it('sends the current draft plus the full instruction history', async () => {
    const { user } = fakeLM('{"subject": "Shorter", "body": "Short body"}');
    const d0 = draft({ refinements: ['more formal'], updatedAt: 1 });
    const d1 = await refineDraft(d0, 'shorter');
    expect(user()).toContain('Subject: Hello');
    expect(user()).toContain('Quick note.');
    expect(user()).toContain('1. more formal\n2. shorter');
    expect(d1).toMatchObject({
      subject: 'Shorter',
      body: 'Short body',
      refinements: ['more formal', 'shorter'],
    });
    expect(d1.updatedAt).toBeGreaterThan(1);
    expect(d0.refinements).toEqual(['more formal']); // original untouched
  });

  it('keeps the previous subject/body when the model returns empty parts', async () => {
    fakeLM('{"subject": "", "body": "New body"}');
    const d1 = await refineDraft(draft(), 'x');
    expect(d1.subject).toBe('Hello');
    expect(d1.body).toBe('New body');
  });

  it('can switch model for a refinement', async () => {
    fakeLM('{"subject": "s", "body": "b"}');
    await refineDraft(draft({ model: 'small' }), 'x', 'big');
    expect(ensure).toHaveBeenLastCalledWith('big');
  });
});

describe('draft persistence', () => {
  it('saves newest first, replaces by id and deletes', async () => {
    expect(await listDrafts()).toEqual([]);
    await saveDraft(draft({ id: 'a' }));
    await saveDraft(draft({ id: 'b' }));
    await saveDraft(draft({ id: 'a', subject: 'Updated' }));
    const xs = await listDrafts();
    expect(xs.map(x => x.id)).toEqual(['a', 'b']);
    expect(xs[0].subject).toBe('Updated');
    await deleteDraft('a');
    expect((await listDrafts()).map(x => x.id)).toEqual(['b']);
  });

  it('keeps at most 50 drafts', async () => {
    for (let i = 0; i < 55; i++) await saveDraft(draft({ id: `d${i}` }));
    const xs = await listDrafts();
    expect(xs).toHaveLength(50);
    expect(xs[0].id).toBe('d54');
    expect(xs.some(x => x.id === 'd4')).toBe(false);
  });

  it('returns [] for corrupt storage', async () => {
    await AsyncStorage.setItem('@liquid_email_drafts', '{not json');
    expect(await listDrafts()).toEqual([]);
  });
});

describe('openInMailApp', () => {
  it('builds an encoded mailto: URL', async () => {
    const spy = jest.spyOn(Linking, 'openURL').mockResolvedValue(true);
    await openInMailApp(
      draft({
        to: ['a@x.com', 'b+tag@y.com'],
        cc: ['c@z.com'],
        subject: 'Q&A?',
        body: 'Line 1\nLine 2',
      }),
    );
    expect(spy).toHaveBeenCalledWith(
      'mailto:a%40x.com,b%2Btag%40y.com?cc=c%40z.com&subject=Q%26A%3F&body=Line%201%0ALine%202',
    );
    spy.mockRestore();
  });
});

describe('draft hygiene', () => {
  const { stripPlaceholders } = require('../../src/email/EmailDrafter');

  it('removes bracket placeholders without leaving blank gaps', () => {
    expect(
      stripPlaceholders(
        'Hi [Recipient Name],\n\nThanks for today.\n\nBest regards,\n[Your Name]\n[Your Position]',
      ),
    ).toBe('Hi,\n\nThanks for today.\n\nBest regards,');
  });

  it('keeps ordinary bracketed text', () => {
    expect(stripPlaceholders('Budget [approved] for Q3')).toBe('Budget [approved] for Q3');
  });

  it('falls back to a downloaded model instead of downloading the chosen one', async () => {
    mockDownloaded = ['lfm2.5-350m'];
    const lm = {
      reset: jest.fn(async () => {}),
      complete: jest.fn(async () => ({ response: '{"subject":"S","body":"B"}' })),
    };
    ensure.mockResolvedValue({ instance: lm });
    await draftEmail({
      mode: 'compose',
      tone: 'professional',
      intent: 'say hi',
      model: 'lfm2.5-1.2b-instruct',
    });
    expect(ensure).toHaveBeenLastCalledWith('lfm2.5-350m');
    mockDownloaded = ['lfm2.5-1.2b-instruct', 'lfm2.5-350m', 'big'];
  });
});
