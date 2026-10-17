import {
  luhnValid,
  minimizeForRemote,
  PrivacyGrants,
  redactText,
} from '../../src/inference/privacy';
import type { ChatTurn } from '../../src/inference/types';
import { freshDb } from './helpers';

beforeEach(freshDb);

const kinds = (r: { redactions: { kind: string; count: number }[] }) =>
  Object.fromEntries(r.redactions.map(x => [x.kind, x.count]));

describe('redactText', () => {
  test.each([
    ['openai key', 'use sk-proj-abcdefghijklmnopqrstuvwx123 now', 'api_key'],
    ['google key', 'key AIzaSyA1234567890abcdefghijklmnopqrstu', 'api_key'],
    ['github token', 'ghp_abcdefghijklmnopqrstuvwxyz0123456789', 'api_key'],
    ['bearer', 'Authorization: Bearer abc.def-ghi_jkl123', 'bearer_token'],
    ['hex secret', 'secret=4f9a8b7c6d5e4f3a2b1c0d9e8f7a6b5c4d3e2f1a', 'secret'],
    ['card', 'card 4111 1111 1111 1111 exp 12/29', 'card_number'],
    ['aadhaar', 'Aadhaar 2345 6789 0123', 'aadhaar'],
    ['pan', 'PAN is ABCDE1234F.', 'pan'],
    ['otp before', 'Your OTP is 482913. Do not share.', 'otp'],
    ['otp after', '482913 is your verification code', 'otp'],
  ])('%s', (_name, input, kind) => {
    const r = redactText(input);
    expect(r.counts.get(kind as any)).toBe(1);
    expect(r.text).toContain('[REDACTED_');
  });

  test('keeps ordinary numbers and words', () => {
    const s = 'Meeting at 1530 in room 42, call 9876543210 about 2026 budget of 120000';
    const r = redactText(s);
    expect(r.text).toBe(s);
    expect(r.counts.size).toBe(0);
  });

  test('non-Luhn 16 digits is not a card', () => {
    expect(luhnValid('4111111111111111')).toBe(true);
    expect(luhnValid('4111111111111112')).toBe(false);
    expect(redactText('order 4111111111111112').counts.get('card_number')).toBeUndefined();
  });
});

describe('minimizeForRemote', () => {
  const history: ChatTurn[] = [
    { role: 'system', content: 'You are helpful.' },
    { role: 'user', content: 'my earlier private chat' },
    { role: 'assistant', content: 'earlier answer' },
    {
      role: 'user',
      content: 'Prove this. My key is sk-abcdefghijklmnopqrstuvwxyz',
      images: ['/x.jpg'],
    },
  ];

  test('keeps only the step messages, strips images, redacts; input untouched', () => {
    const snapshot = JSON.parse(JSON.stringify(history));
    const r = minimizeForRemote(history, { dataClass: 'personal' });
    expect(r.messages.map(m => m.role)).toEqual(['system', 'user']);
    expect(r.messages[1].content).not.toContain('sk-abc');
    expect(r.messages[1].images).toBeUndefined();
    expect(kinds(r)).toEqual({ api_key: 1, image: 1, history: 2 });
    expect(history).toEqual(snapshot);
  });

  test('allowImages + explicit step start', () => {
    const r = minimizeForRemote(history, {
      dataClass: 'public',
      allowImages: true,
      stepStartIndex: 1,
    });
    expect(r.messages).toHaveLength(4);
    expect(r.messages[3].images).toEqual(['/x.jpg']);
    expect(r.messages[3].images).not.toBe(history[3].images);
  });
});

describe('PrivacyGrants', () => {
  test('grant persists and revokes', async () => {
    const g = new PrivacyGrants();
    expect(await g.has('oai', 'personal')).toBe(false);
    await g.grant('oai', 'personal');
    await g.grant('oai', 'personal');
    expect(await new PrivacyGrants().has('oai', 'personal')).toBe(true);
    expect(await g.has('oai', 'sensitive')).toBe(false);
    expect(await g.list()).toHaveLength(1);
    await g.revoke('oai');
    expect(await g.has('oai', 'personal')).toBe(false);
  });
});
