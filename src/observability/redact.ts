/**
 * Payload redaction (PRD §15.1): every trace payload passes through here
 * before it is persisted. Deep-copies, never mutates the input.
 *
 * Masks: API keys (sk-…, AIza…, gh*_…), bearer tokens, long hex/base64 blobs,
 * OTP-like codes near otp/code/verification words, Luhn-valid card numbers,
 * emails (u***@domain), phone numbers (all but the last 2 digits).
 * Drops keys named password/apiKey/token/secret/authorization (and *Token,
 * *Secret, *Password, *ApiKey variants). Truncates strings > 2000 chars.
 */

export const MAX_STRING_LENGTH = 2000;
const MAX_DEPTH = 10;

const DROP_KEYS = new Set(['password', 'passwd', 'apikey', 'token', 'secret', 'authorization']);
const DROP_SUFFIXES = ['token', 'secret', 'password', 'apikey'];

/** True when an object key must never be persisted. */
export function isSensitiveKey(key: string): boolean {
  const k = key.toLowerCase().replace(/[_\-\s]/g, '');
  if (DROP_KEYS.has(k)) return true;
  return DROP_SUFFIXES.some(s => k.endsWith(s));
}

/** Luhn checksum over a digit string. */
export function luhnValid(digits: string): boolean {
  if (!/^\d{13,19}$/.test(digits)) return false;
  let sum = 0;
  let double = false;
  for (let i = digits.length - 1; i >= 0; i--) {
    let d = digits.charCodeAt(i) - 48;
    if (double) {
      d *= 2;
      if (d > 9) d -= 9;
    }
    sum += d;
    double = !double;
  }
  return sum % 10 === 0;
}

/** API keys, bearer tokens and long opaque hex/base64 blobs. */
export function redactSecrets(s: string): string {
  return (
    s
      .replace(/\bsk-[A-Za-z0-9_-]{16,}/g, '[REDACTED_KEY]')
      .replace(/\bAIza[0-9A-Za-z_-]{30,}/g, '[REDACTED_KEY]')
      .replace(/\bgh[pousr]_[A-Za-z0-9]{20,}/g, '[REDACTED_KEY]')
      .replace(/\b(Bearer|Basic)\s+[A-Za-z0-9._~+/=-]+/gi, '$1 [REDACTED]')
      .replace(/\b[A-Fa-f0-9]{32,}\b/g, '[REDACTED_HEX]')
      // base64/base64url: 32+ chars with letters and digits
      .replace(/(?<![A-Za-z0-9+/_-])[A-Za-z0-9+/_-]{32,}={0,2}/g, m =>
        looksLikeBlob(m) ? '[REDACTED_BLOB]' : m,
      )
  );
}
const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

/**
 * Opaque blobs have letters and digits and a long unbroken run; file paths and
 * hyphenated ids ("storage/emulated/0/…", "qwen3-8b-flash-…", UUIDs) don't.
 */
function looksLikeBlob(m: string): boolean {
  if (UUID_RE.test(m)) return false;
  if (!/\d/.test(m) || !/[A-Za-z]/.test(m)) return false;
  const longest = Math.max(...m.split(/[/_-]/).map(seg => seg.length));
  return longest >= 16;
}

/** Card numbers (13–19 digits, optional space/dash groups) that pass Luhn. */
export function redactCards(s: string): string {
  return s.replace(/(?<![\d])\d(?:[ -]?\d){12,18}(?![\d])/g, m => {
    const digits = m.replace(/\D/g, '');
    return luhnValid(digits) ? '[REDACTED_CARD]' : m;
  });
}

const OTP_WORDS =
  '(?:otp|one[- ]?time(?: pass(?:word|code))?|code|verification|verify|passcode|pin|2fa|security code|auth(?:entication)?)';
const OTP_AFTER = new RegExp(`(\\b${OTP_WORDS}\\b[^\\d\\n]{0,40}?)(\\d{4,8})(?!\\d)`, 'gi');
const OTP_BEFORE = new RegExp(`(?<!\\d)(\\d{4,8})(\\s*[^\\d\\n]{0,40}?\\b${OTP_WORDS}\\b)`, 'gi');

/** OTP-like 4–8 digit codes within ~40 chars of otp/code/verification words. */
export function redactOtps(s: string): string {
  return s
    .replace(OTP_AFTER, (_m, pre: string) => `${pre}[REDACTED_OTP]`)
    .replace(OTP_BEFORE, (_m, _code: string, post: string) => `[REDACTED_OTP]${post}`);
}

/** u***@domain */
export function redactEmails(s: string): string {
  return s.replace(
    /\b([A-Za-z0-9])[A-Za-z0-9._%+-]*@([A-Za-z0-9-]+(?:\.[A-Za-z0-9-]+)*\.[A-Za-z]{2,})\b/g,
    '$1***@$2',
  );
}

/** Phone numbers (10–15 digits, or 8+ with a leading +) keep only the last 2 digits. */
export function redactPhones(s: string): string {
  return s.replace(/(?<![\w+(-])(?:\+|\()?\d[\d\s().-]{6,}\d(?![\w-])/g, m => {
    if (/^\d{4}[-/.]\d{1,2}[-/.]\d{1,2}/.test(m)) return m; // ISO-ish dates
    const digits = m.replace(/\D/g, '');
    const min = m.startsWith('+') ? 8 : 10;
    if (digits.length < min || digits.length > 15) return m;
    return `***${digits.slice(-2)}`;
  });
}

export function truncate(s: string, max = MAX_STRING_LENGTH): string {
  return s.length > max ? `${s.slice(0, max)}…[truncated ${s.length - max} chars]` : s;
}

/** All string-level redactions, in a safe order (cards before phones). */
export function redactString(s: string): string {
  let out = redactSecrets(s);
  out = redactEmails(out);
  out = redactCards(out);
  out = redactOtps(out);
  out = redactPhones(out);
  return truncate(out);
}

/**
 * Deep-copies `value` with secrets masked and sensitive keys dropped.
 * Non-JSON values are normalized (Date → ISO, Error → {name,message},
 * functions dropped, cycles → '[Circular]').
 */
export function redactPayload<T>(value: T): T {
  return walk(value, 0, new WeakSet()) as T;
}

function walk(v: unknown, depth: number, seen: WeakSet<object>): unknown {
  if (typeof v === 'string') return redactString(v);
  if (v === null || typeof v === 'number' || typeof v === 'boolean') return v;
  if (typeof v === 'bigint') return v.toString();
  if (typeof v === 'undefined' || typeof v === 'function' || typeof v === 'symbol') {
    return undefined;
  }
  if (v instanceof Date) return Number.isNaN(v.getTime()) ? null : v.toISOString();
  if (v instanceof Error) return { name: v.name, message: redactString(v.message) };
  const obj = v as object;
  if (seen.has(obj)) return '[Circular]';
  if (depth >= MAX_DEPTH) return '[MaxDepth]';
  seen.add(obj);
  try {
    if (Array.isArray(obj)) {
      return obj.map(x => {
        const r = walk(x, depth + 1, seen);
        return r === undefined ? null : r;
      });
    }
    if (obj instanceof Map) {
      return walk(Object.fromEntries(obj), depth, seen);
    }
    if (obj instanceof Set) {
      return walk([...obj], depth, seen);
    }
    const out: Record<string, unknown> = {};
    for (const [k, val] of Object.entries(obj)) {
      if (isSensitiveKey(k)) continue;
      const r = walk(val, depth + 1, seen);
      if (r !== undefined) out[k] = r;
    }
    return out;
  } finally {
    seen.delete(obj);
  }
}
