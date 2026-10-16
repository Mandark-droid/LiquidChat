/**
 * fetch with timeout + caller cancellation, typed error mapping and secret
 * scrubbing. Shared by the remote providers and the MCP client.
 */
import { httpStatusToKind, ProviderError, scrubSecrets } from '../errors';

export interface HttpRequest {
  url: string;
  method?: 'GET' | 'POST' | 'DELETE';
  headers: Record<string, string>;
  body?: unknown;
  timeoutMs: number;
  signal?: AbortSignal;
  /** Values that must never appear in an error message (the API key). */
  secrets?: (string | null | undefined)[];
}

export interface HttpResponse {
  status: number;
  headers: { get(name: string): string | null };
  text: string;
}

export type FetchLike = (
  url: string,
  init: Record<string, unknown>,
) => Promise<{
  ok: boolean;
  status: number;
  headers: { get(name: string): string | null };
  text(): Promise<string>;
}>;

const defaultFetch: FetchLike = (url, init) =>
  (globalThis.fetch as unknown as FetchLike)(url, init);

/** Performs the request; resolves with any HTTP status (callers decide), rejects on transport errors. */
export async function httpRequest(
  providerId: string,
  r: HttpRequest,
  fetchImpl: FetchLike = defaultFetch,
): Promise<HttpResponse> {
  if (r.signal?.aborted) throw new ProviderError('aborted', 'Request cancelled', providerId);
  const ctrl = new AbortController();
  let timedOut = false;
  const timer = setTimeout(() => {
    timedOut = true;
    ctrl.abort();
  }, r.timeoutMs);
  const onAbort = () => ctrl.abort();
  r.signal?.addEventListener?.('abort', onAbort);
  try {
    const res = await fetchImpl(r.url, {
      method: r.method ?? 'POST',
      headers: r.headers,
      body: r.body === undefined ? undefined : JSON.stringify(r.body),
      signal: ctrl.signal,
    });
    const text = await res.text();
    return { status: res.status, headers: res.headers, text };
  } catch (e) {
    if (timedOut)
      throw new ProviderError('timeout', `Timed out after ${r.timeoutMs} ms`, providerId);
    if (r.signal?.aborted) throw new ProviderError('aborted', 'Request cancelled', providerId);
    const msg = e instanceof Error ? e.message : String(e);
    throw new ProviderError(
      'network',
      scrubSecrets(`Network error: ${msg}`, r.secrets ?? []),
      providerId,
    );
  } finally {
    clearTimeout(timer);
    r.signal?.removeEventListener?.('abort', onAbort);
  }
}

/** Throws a typed ProviderError for non-2xx responses. */
export function ensureOk(
  providerId: string,
  res: HttpResponse,
  secrets: (string | null | undefined)[] = [],
): void {
  if (res.status >= 200 && res.status < 300) return;
  const kind = httpStatusToKind(res.status);
  const detail = extractErrorMessage(res.text);
  const retryAfter = res.headers.get('retry-after');
  const msg =
    `${providerId} HTTP ${res.status}` +
    (detail ? `: ${detail}` : '') +
    (retryAfter ? ` (retry after ${retryAfter}s)` : '');
  throw new ProviderError(kind, scrubSecrets(msg, secrets), providerId, res.status);
}

function extractErrorMessage(text: string): string {
  try {
    const j = JSON.parse(text) as Record<string, unknown>;
    const err = j.error as Record<string, unknown> | string | undefined;
    if (typeof err === 'string') return err.slice(0, 300);
    if (err && typeof err.message === 'string') return err.message.slice(0, 300);
    if (typeof j.message === 'string') return j.message.slice(0, 300);
  } catch {}
  return text.slice(0, 200);
}

export function parseJson<T>(providerId: string, text: string): T {
  try {
    return JSON.parse(text) as T;
  } catch {
    throw new ProviderError('parse', `${providerId} returned a non-JSON response`, providerId);
  }
}

/** Parses JSON-string tool arguments into an object (never throws). */
export function parseArgs(raw: unknown): Record<string, unknown> {
  if (raw && typeof raw === 'object' && !Array.isArray(raw)) return raw as Record<string, unknown>;
  if (typeof raw !== 'string' || !raw.trim()) return {};
  try {
    const v = JSON.parse(raw) as unknown;
    return v && typeof v === 'object' && !Array.isArray(v)
      ? (v as Record<string, unknown>)
      : { value: v };
  } catch {
    return { _raw: raw };
  }
}
