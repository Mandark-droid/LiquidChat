/**
 * Data minimization for remote inference (PRD §6.5). Only the step's own
 * inputs may leave the device, with credentials and identifiers redacted.
 * Pure functions: inputs are never mutated.
 *
 * Also: PrivacyGrants — the persisted record that the user approved sending a
 * data class to a provider (privacy_grants table).
 */
import { getDatabase, type SqlDb } from '../storage/db';
import type { ChatTurn, DataClass } from './types';

export type RedactionKind =
  | 'api_key'
  | 'bearer_token'
  | 'jwt'
  | 'secret'
  | 'card_number'
  | 'aadhaar'
  | 'pan'
  | 'otp'
  | 'image'
  | 'history';

export interface Redaction {
  kind: RedactionKind;
  count: number;
}

export interface MinimizeOptions {
  dataClass: DataClass;
  /** Keep image attachments (only when the step itself needs vision). Default false. */
  allowImages?: boolean;
  /**
   * Index of the first message belonging to this step. Earlier non-system
   * messages are dropped. Default: the last user turn (plus anything after it).
   */
  stepStartIndex?: number;
}

export interface MinimizedMessages {
  messages: ChatTurn[];
  redactions: Redaction[];
}

interface Rule {
  kind: RedactionKind;
  re: RegExp;
  /** Returns the replacement, or null to leave the match untouched. */
  replace: (match: string, ...groups: string[]) => string | null;
}

const tag = (k: string) => `[REDACTED_${k.toUpperCase()}]`;

export function luhnValid(digits: string): boolean {
  let sum = 0;
  let dbl = false;
  for (let i = digits.length - 1; i >= 0; i--) {
    let d = digits.charCodeAt(i) - 48;
    if (d < 0 || d > 9) return false;
    if (dbl) {
      d *= 2;
      if (d > 9) d -= 9;
    }
    sum += d;
    dbl = !dbl;
  }
  return sum % 10 === 0;
}

function looksLikeSecret(s: string): boolean {
  // Long mixed-alphabet token: needs digits and letters and no long word-like runs.
  if (!/\d/.test(s) || !/[A-Za-z]/.test(s)) return false;
  if (/^[0-9a-f]+$/i.test(s)) return s.length >= 32; // hex: sha/keys
  return s.length >= 40 && /[A-Z]/.test(s) && /[a-z]/.test(s);
}

const OTP_WORDS =
  '(?:otp|one[- ]time (?:password|passcode|code|pin)|verification code|security code|auth(?:entication)? code|login code|passcode|pin|code)';

// Order matters: credentials first, then long numbers (cards before Aadhaar),
// then short OTP codes, then PAN.
const RULES: Rule[] = [
  {
    kind: 'bearer_token',
    re: /\bBearer\s+[A-Za-z0-9\-._~+/]{8,}=*/gi,
    replace: () => `Bearer ${tag('token')}`,
  },
  {
    kind: 'jwt',
    re: /\beyJ[A-Za-z0-9_-]{8,}\.[A-Za-z0-9_-]{8,}\.[A-Za-z0-9_-]{8,}\b/g,
    replace: () => tag('token'),
  },
  {
    kind: 'api_key',
    re: /\b(?:sk-(?:proj-|ant-[a-z0-9]+-|live_|test_)?[A-Za-z0-9_-]{16,}|AIza[0-9A-Za-z_-]{30,}|gh[pousr]_[A-Za-z0-9]{30,}|github_pat_[A-Za-z0-9_]{30,}|xox[abpors]-[A-Za-z0-9-]{10,}|hf_[A-Za-z0-9]{30,}|AKIA[0-9A-Z]{16})/g,
    replace: () => tag('api_key'),
  },
  {
    kind: 'secret',
    re: /(?<![A-Za-z0-9+_-])[A-Za-z0-9+_-]{32,}={0,2}(?![A-Za-z0-9+_-])/g,
    replace: m => (looksLikeSecret(m.replace(/=+$/, '')) ? tag('secret') : null),
  },
  {
    kind: 'card_number',
    re: /(?<!\d)\d(?:[ -]?\d){12,18}(?!\d)/g,
    replace: m => {
      const d = m.replace(/\D/g, '');
      return d.length >= 13 && d.length <= 19 && luhnValid(d) ? tag('card') : null;
    },
  },
  {
    kind: 'aadhaar',
    re: /(?<!\d)[2-9]\d{3}([ -]?)\d{4}\1\d{4}(?!\d)/g,
    replace: () => tag('aadhaar'),
  },
  {
    kind: 'otp',
    re: new RegExp(`(\\b${OTP_WORDS}\\b[^\\d\\n]{0,30}?)(?<!\\d)(\\d{4,8})(?!\\d)`, 'gi'),
    replace: (_m, prefix) => `${prefix}${tag('otp')}`,
  },
  {
    kind: 'otp',
    re: new RegExp(`(?<!\\d)\\d{4,8}(?!\\d)(?=[^\\d\\n]{0,20}\\b${OTP_WORDS}\\b)`, 'gi'),
    replace: () => tag('otp'),
  },
  {
    kind: 'pan',
    re: /\b[A-Z]{5}\d{4}[A-Z]\b/g,
    replace: () => tag('pan'),
  },
];

/** Redacts secrets and identifiers in one string. */
export function redactText(text: string): { text: string; counts: Map<RedactionKind, number> } {
  const counts = new Map<RedactionKind, number>();
  let out = text;
  for (const rule of RULES) {
    rule.re.lastIndex = 0;
    out = out.replace(rule.re, (match: string, ...rest: unknown[]) => {
      const groups = rest.filter((g): g is string => typeof g === 'string');
      const r = rule.replace(match, ...groups);
      if (r === null) return match;
      counts.set(rule.kind, (counts.get(rule.kind) ?? 0) + 1);
      return r;
    });
  }
  return { text: out, counts };
}

/** Selects the step's messages, strips images unless allowed and redacts secrets. */
export function minimizeForRemote(messages: ChatTurn[], opts: MinimizeOptions): MinimizedMessages {
  const total = new Map<RedactionKind, number>();
  const add = (k: RedactionKind, n: number) => n > 0 && total.set(k, (total.get(k) ?? 0) + n);

  let start = opts.stepStartIndex;
  if (start === undefined) {
    start = 0;
    for (let i = messages.length - 1; i >= 0; i--) {
      if (messages[i].role === 'user') {
        start = i;
        break;
      }
    }
  }
  start = Math.max(0, Math.min(start, messages.length));

  const out: ChatTurn[] = [];
  let droppedHistory = 0;
  messages.forEach((m, i) => {
    if (i < start && m.role !== 'system') {
      droppedHistory++;
      return;
    }
    const { text, counts } = redactText(m.content);
    for (const [k, n] of counts) add(k, n);
    const turn: ChatTurn = { role: m.role, content: text };
    if (m.images?.length) {
      if (opts.allowImages) turn.images = [...m.images];
      else add('image', m.images.length);
    }
    out.push(turn);
  });
  add('history', droppedHistory);

  return {
    messages: out,
    redactions: [...total.entries()].map(([kind, count]) => ({ kind, count })),
  };
}

/** Persisted user approvals: "this data class may go to this provider". */
export class PrivacyGrants {
  constructor(
    private readonly db: () => Promise<SqlDb> = () => getDatabase(),
    private readonly now: () => number = Date.now,
  ) {}

  async has(providerId: string, dataClass: DataClass): Promise<boolean> {
    const db = await this.db();
    const r = await db.execute(
      'SELECT 1 AS ok FROM privacy_grants WHERE provider_id = ? AND data_class = ?',
      [providerId, dataClass],
    );
    return r.rows.length > 0;
  }

  async grant(providerId: string, dataClass: DataClass): Promise<void> {
    const db = await this.db();
    await db.execute(
      'INSERT OR IGNORE INTO privacy_grants (provider_id, data_class, created_at) VALUES (?, ?, ?)',
      [providerId, dataClass, this.now()],
    );
  }

  async revoke(providerId: string, dataClass?: DataClass): Promise<void> {
    const db = await this.db();
    if (dataClass)
      await db.execute('DELETE FROM privacy_grants WHERE provider_id = ? AND data_class = ?', [
        providerId,
        dataClass,
      ]);
    else await db.execute('DELETE FROM privacy_grants WHERE provider_id = ?', [providerId]);
  }

  async list(): Promise<{ providerId: string; dataClass: DataClass; createdAt: number }[]> {
    const db = await this.db();
    const r = await db.execute(
      'SELECT provider_id, data_class, created_at FROM privacy_grants ORDER BY created_at',
    );
    return r.rows.map(row => ({
      providerId: String(row.provider_id),
      dataClass: String(row.data_class) as DataClass,
      createdAt: Number(row.created_at),
    }));
  }
}
