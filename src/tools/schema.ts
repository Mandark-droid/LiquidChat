/**
 * Minimal JSON-Schema validator for tool arguments, plan steps, skill
 * manifests and structured model outputs. No dependency; deliberately strict.
 * Model-generated arguments are never trusted without passing through here.
 */
import type { JsonSchema } from './types';

export interface SchemaIssue {
  path: string;
  message: string;
}

export interface ValidationResult<T = unknown> {
  ok: boolean;
  issues: SchemaIssue[];
  /** Input with defaults applied and numeric strings coerced (only when ok). */
  value?: T;
}

const DATE_RE = /^\d{4}-\d{2}-\d{2}$/;
const DATETIME_RE = /^\d{4}-\d{2}-\d{2}[T ]\d{2}:\d{2}(:\d{2}(\.\d+)?)?(Z|[+-]\d{2}:?\d{2})?$/;
const EMAIL_RE = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;
const URI_RE = /^[a-z][a-z0-9+.-]*:\/\/[^\s]+$/i;

export function validate<T = unknown>(schema: JsonSchema, input: unknown): ValidationResult<T> {
  const issues: SchemaIssue[] = [];
  const value = walk(schema, input, '$', issues);
  return issues.length ? { ok: false, issues } : { ok: true, issues, value: value as T };
}

/**
 * Small models often send a single value where a list is expected ("model" for ["model"]) or a
 * JSON array as text. Accept those unambiguous shapes; anything else stays a validation error.
 */
function liftToArray(v: unknown, s: JsonSchema): unknown[] | null {
  const itemType = s.items?.type;
  const scalar = (x: unknown) =>
    (itemType === 'string' && typeof x === 'string') ||
    ((itemType === 'number' || itemType === 'integer') && typeof x === 'number') ||
    (itemType === 'boolean' && typeof x === 'boolean');
  if (typeof v === 'string') {
    const t = v.trim();
    if (t.startsWith('[')) {
      try {
        const parsed = JSON.parse(t);
        if (Array.isArray(parsed)) return parsed;
      } catch {
        /* not strict JSON: ['model'  "a", "b"]  [model] — read the items leniently */
      }
      const parts = t
        .replace(/^\[|\]$/g, '')
        .split(',')
        .map(x => x.trim().replace(/^['"`]+|['"`]+$/g, ''))
        .filter(Boolean);
      if (parts.length) return parts;
    }
    if (!t) return null;
    // Comma-separated only when the items are an enum, where a comma cannot be part of a value.
    if (s.items?.enum && t.includes(','))
      return t
        .split(',')
        .map(x => x.trim())
        .filter(Boolean);
    return scalar(t) ? [t] : null;
  }
  return scalar(v) ? [v] : null;
}

function walk(s: JsonSchema, v: unknown, path: string, issues: SchemaIssue[]): unknown {
  if (v === undefined && s.default !== undefined) v = structuredCloneSafe(s.default);
  if (s.enum && typeof v === 'string' && !s.enum.includes(v as never)) {
    // "Models" / "models" for "model": same word, different case or plural.
    const lower = v.trim().toLowerCase();
    const snapped = s.enum.find(
      e =>
        typeof e === 'string' &&
        (e.toLowerCase() === lower ||
          (lower.endsWith('s') && e.toLowerCase() === lower.slice(0, -1))),
    );
    if (snapped !== undefined) v = snapped;
  }
  if (s.enum && !s.enum.includes(v as never)) {
    issues.push({
      path,
      message: `must be one of ${s.enum.map(e => JSON.stringify(e)).join(', ')}`,
    });
    return v;
  }
  switch (s.type) {
    case undefined:
      return v;
    case 'null':
      if (v !== null) issues.push({ path, message: 'must be null' });
      return v;
    case 'boolean':
      if (typeof v === 'boolean') return v;
      if (v === 'true' || v === 'false') return v === 'true';
      issues.push({ path, message: 'must be a boolean' });
      return v;
    case 'number':
    case 'integer': {
      let n = v;
      if (typeof n === 'string' && n.trim() !== '' && !isNaN(Number(n))) n = Number(n);
      if (typeof n !== 'number' || !Number.isFinite(n)) {
        issues.push({ path, message: `must be a ${s.type}` });
        return v;
      }
      if (s.type === 'integer' && !Number.isInteger(n))
        issues.push({ path, message: 'must be an integer' });
      if (s.minimum !== undefined && n < s.minimum)
        issues.push({ path, message: `must be >= ${s.minimum}` });
      if (s.maximum !== undefined && n > s.maximum)
        issues.push({ path, message: `must be <= ${s.maximum}` });
      return n;
    }
    case 'string': {
      if (typeof v !== 'string') {
        issues.push({ path, message: 'must be a string' });
        return v;
      }
      if (s.minLength !== undefined && v.length < s.minLength)
        issues.push({ path, message: `must have at least ${s.minLength} characters` });
      if (s.maxLength !== undefined && v.length > s.maxLength)
        issues.push({ path, message: `must have at most ${s.maxLength} characters` });
      if (s.pattern && !new RegExp(s.pattern).test(v))
        issues.push({ path, message: `must match ${s.pattern}` });
      if (s.format === 'date' && !DATE_RE.test(v))
        issues.push({ path, message: 'must be a date (YYYY-MM-DD)' });
      if (s.format === 'date-time' && !DATETIME_RE.test(v))
        issues.push({ path, message: 'must be an ISO date-time' });
      if (s.format === 'email' && !EMAIL_RE.test(v))
        issues.push({ path, message: 'must be an email address' });
      if (s.format === 'uri' && !URI_RE.test(v)) issues.push({ path, message: 'must be a URI' });
      return v;
    }
    case 'array': {
      const list = Array.isArray(v) ? v : liftToArray(v, s);
      if (!list) {
        issues.push({ path, message: 'must be an array' });
        return v;
      }
      return s.items ? list.map((x, i) => walk(s.items!, x, `${path}[${i}]`, issues)) : list;
    }
    case 'object': {
      if (typeof v !== 'object' || v === null || Array.isArray(v)) {
        issues.push({ path, message: 'must be an object' });
        return v;
      }
      const obj = v as Record<string, unknown>;
      const out: Record<string, unknown> = {};
      const props = s.properties ?? {};
      for (const req of s.required ?? []) {
        if (obj[req] === undefined || obj[req] === null || obj[req] === '') {
          if (props[req]?.default === undefined)
            issues.push({ path: `${path}.${req}`, message: 'is required' });
        }
      }
      for (const [k, sub] of Object.entries(props)) {
        if ((obj[k] === undefined || obj[k] === null) && sub.default === undefined) continue;
        const val = walk(sub, obj[k] ?? undefined, `${path}.${k}`, issues);
        if (val !== undefined) out[k] = val;
      }
      for (const k of Object.keys(obj)) {
        if (props[k]) continue;
        if (s.additionalProperties === false)
          issues.push({ path: `${path}.${k}`, message: 'is not allowed' });
        else out[k] = obj[k];
      }
      return out;
    }
  }
  return v;
}

function structuredCloneSafe<T>(v: T): T {
  return v === null || typeof v !== 'object' ? v : (JSON.parse(JSON.stringify(v)) as T);
}

export function formatIssues(issues: SchemaIssue[]): string {
  return issues.map(i => `${i.path} ${i.message}`).join('; ');
}

/** Converts a schema to the google/mobile-actions dialect the fine-tuned model was trained on. */
export function toMobileActionsSchema(s: JsonSchema): Record<string, unknown> {
  const t = (s.type ?? 'string').toUpperCase();
  const out: Record<string, unknown> = { type: t === 'INTEGER' ? 'NUMBER' : t };
  if (s.description) out.description = s.description;
  if (s.properties) {
    out.properties = Object.fromEntries(
      Object.entries(s.properties).map(([k, v]) => [k, toMobileActionsSchema(v)]),
    );
    out.required = s.required ?? [];
  }
  if (s.items) out.items = toMobileActionsSchema(s.items);
  return out;
}
