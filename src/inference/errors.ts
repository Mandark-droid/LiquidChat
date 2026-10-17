/**
 * Typed inference errors. Messages never contain API keys: every message that
 * may carry provider-supplied text is passed through scrubSecrets() first.
 */

export type ProviderErrorKind =
  | 'auth' // 401/403 — wrong or revoked key; never retried
  | 'rate_limit' // 429
  | 'server' // 5xx / overloaded
  | 'bad_request' // 400/404/422 — request shape or model id problem
  | 'timeout'
  | 'network'
  | 'aborted' // caller cancelled
  | 'parse' // provider answered with something we cannot read
  | 'content_filtered'
  | 'model_error' // local model failed to generate
  | 'unavailable'; // provider not configured / circuit open / no key

const RETRYABLE: Record<ProviderErrorKind, boolean> = {
  auth: false,
  rate_limit: true,
  server: true,
  bad_request: false,
  timeout: true,
  network: true,
  aborted: false,
  parse: false,
  content_filtered: false,
  model_error: false,
  unavailable: false,
};

export class ProviderError extends Error {
  readonly retryable: boolean;
  constructor(
    readonly kind: ProviderErrorKind,
    message: string,
    readonly providerId: string,
    readonly status?: number,
    retryable?: boolean,
  ) {
    super(scrubSecrets(message));
    this.name = 'ProviderError';
    this.retryable = retryable ?? RETRYABLE[kind];
  }
}

export function httpStatusToKind(status: number): ProviderErrorKind {
  if (status === 401 || status === 403) return 'auth';
  if (status === 429) return 'rate_limit';
  if (status === 408) return 'timeout';
  if (status >= 500) return 'server';
  return 'bad_request';
}

/** Removes anything that looks like a credential, plus explicitly known secrets. */
export function scrubSecrets(text: string, known: (string | null | undefined)[] = []): string {
  let out = text;
  for (const k of known) if (k && k.length >= 4) out = out.split(k).join('[REDACTED]');
  return out
    .replace(/\bBearer\s+[A-Za-z0-9\-._~+/]+=*/gi, 'Bearer [REDACTED]')
    .replace(/\bsk-[A-Za-z0-9_-]{8,}/g, '[REDACTED]')
    .replace(/\bAIza[0-9A-Za-z_-]{20,}/g, '[REDACTED]')
    .replace(/\bgh[pousr]_[A-Za-z0-9]{20,}/g, '[REDACTED]')
    .replace(/([?&](?:key|api_key|apikey|access_token)=)[^&\s"']+/gi, '$1[REDACTED]');
}

export function isAbortError(e: unknown): boolean {
  return (
    (e instanceof ProviderError && e.kind === 'aborted') ||
    (typeof e === 'object' && e !== null && (e as { name?: string }).name === 'AbortError')
  );
}
