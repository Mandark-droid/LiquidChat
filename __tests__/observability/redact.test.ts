import {
  isSensitiveKey,
  luhnValid,
  MAX_STRING_LENGTH,
  redactPayload,
  redactString,
} from '../../src/observability/redact';

describe('redactString', () => {
  test('masks API keys and bearer tokens', () => {
    const s = redactString(
      'key sk-abcdefghijklmnopqrstuvwx and AIzaSyA1234567890abcdefghijklmnopqrstu and ghp_abcdefghijklmnopqrstuvwxyz0123456789',
    );
    expect(s).not.toMatch(/sk-abc|AIzaSy|ghp_abc/);
    expect(s.match(/\[REDACTED_KEY\]/g)).toHaveLength(3);
    expect(redactString('Authorization: Bearer eyJhbGciOi.payload.sig')).toBe(
      'Authorization: Bearer [REDACTED]',
    );
  });

  test('masks long hex and base64 blobs but keeps uuids, paths and model ids', () => {
    expect(redactString('hash 0123456789abcdef0123456789abcdef0123')).toBe('hash [REDACTED_HEX]');
    expect(redactString('blob QWxhZGRpbjpvcGVuIHNlc2FtZQ9876543210abcdXYZ==')).toBe(
      'blob [REDACTED_BLOB]',
    );
    const uuid = '123e4567-e89b-12d3-a456-426614174000';
    expect(redactString(uuid)).toBe(uuid);
    expect(redactString('/storage/emulated/0/models/qwen3-8b-q4/model.gguf')).toBe(
      '/storage/emulated/0/models/qwen3-8b-q4/model.gguf',
    );
    expect(redactString('lfm2-vl-1.6b-instruct-q4_k_m-2025')).toBe(
      'lfm2-vl-1.6b-instruct-q4_k_m-2025',
    );
  });

  test('masks OTP codes near otp/code/verification words only', () => {
    expect(redactString('Your OTP is 482913')).toBe('Your OTP is [REDACTED_OTP]');
    expect(redactString('Use verification code: 7731 to sign in')).toBe(
      'Use verification code: [REDACTED_OTP] to sign in',
    );
    expect(redactString('839201 is your login code')).toBe('[REDACTED_OTP] is your login code');
    expect(redactString('Meeting moved to room 4021')).toBe('Meeting moved to room 4021');
    expect(redactString('Set a timer for 1500 seconds')).toBe('Set a timer for 1500 seconds');
  });

  test('masks Luhn-valid card numbers but not arbitrary digit runs', () => {
    expect(luhnValid('4111111111111111')).toBe(true);
    expect(luhnValid('4111111111111112')).toBe(false);
    expect(redactString('card 4111 1111 1111 1111 exp')).toBe('card [REDACTED_CARD] exp');
    expect(redactString('card 4111-1111-1111-1111')).toBe('card [REDACTED_CARD]');
    expect(redactString('order 4111111111111112')).not.toContain('REDACTED_CARD');
  });

  test('masks emails and phone numbers', () => {
    expect(redactString('mail rahul.k@example.com now')).toBe('mail r***@example.com now');
    expect(redactString('call +91 98450 12345')).toBe('call ***45');
    expect(redactString('call 9876543210 today')).toBe('call ***10 today');
    expect(redactString('(555) 123-4567')).toBe('***67');
    expect(redactString('on 2026-10-17 at 10:00')).toBe('on 2026-10-17 at 10:00');
    expect(redactString('level 40, 25 minutes')).toBe('level 40, 25 minutes');
  });

  test('truncates long strings', () => {
    const s = redactString('a '.repeat(3000));
    expect(s.startsWith('a a ')).toBe(true);
    expect(s.length).toBeLessThan(MAX_STRING_LENGTH + 40);
    expect(s).toMatch(/truncated 4000 chars/);
  });
});

describe('redactPayload', () => {
  test('drops sensitive keys case-insensitively and deep-copies', () => {
    const input = {
      tool: 'send_email',
      Password: 'hunter2',
      apiKey: 'x',
      API_KEY: 'y',
      nested: { Authorization: 'Bearer abc', accessToken: 't', refresh_token: 'r', ok: 1 },
      list: [{ secret: 's', to: 'bob@corp.io' }],
    };
    const out = redactPayload(input);
    expect(out).toEqual({
      tool: 'send_email',
      nested: { ok: 1 },
      list: [{ to: 'b***@corp.io' }],
    });
    expect(input.Password).toBe('hunter2');
    expect(out.nested).not.toBe(input.nested);
    expect(isSensitiveKey('Token')).toBe(true);
    expect(isSensitiveKey('tokens_per_second')).toBe(false);
  });

  test('handles cycles, dates, errors, functions and primitives', () => {
    const a: Record<string, unknown> = { n: 1, d: new Date(0), e: new Error('OTP is 123456') };
    a.self = a;
    a.fn = () => 1;
    a.u = undefined;
    const out = redactPayload(a) as Record<string, unknown>;
    expect(out.n).toBe(1);
    expect(out.d).toBe('1970-01-01T00:00:00.000Z');
    expect(out.e).toEqual({ name: 'Error', message: 'OTP is [REDACTED_OTP]' });
    expect(out.self).toBe('[Circular]');
    expect('fn' in out).toBe(false);
    expect('u' in out).toBe(false);
    expect(redactPayload(null)).toBeNull();
    expect(redactPayload(42)).toBe(42);
    expect(redactPayload([undefined, 'x'])).toEqual([null, 'x']);
  });

  test('shared (non-cyclic) references are both copied', () => {
    const shared = { v: 'x' };
    expect(redactPayload({ a: shared, b: shared })).toEqual({ a: { v: 'x' }, b: { v: 'x' } });
  });
});
