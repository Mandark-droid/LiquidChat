/**
 * Minimal MCP client over the Streamable HTTP transport (spec 2025-06-18,
 * falls back to 2025-03-26). Requests are JSON-RPC POSTs; the server may
 * answer with application/json or a text/event-stream carrying the response.
 * The session id from initialize (Mcp-Session-Id) is echoed on every request.
 *
 * Bearer token (if any) comes from the CredentialStore key `mcp:<serverId>`.
 */
import { ProviderError, scrubSecrets } from '../inference/errors';
import { type FetchLike, httpRequest, type HttpResponse } from '../inference/providers/http';
import type { CredentialStore } from '../platform/types';

export const MCP_PROTOCOL_VERSION = '2025-06-18';
export const MCP_FALLBACK_PROTOCOL_VERSION = '2025-03-26';
export const SUPPORTED_PROTOCOL_VERSIONS = [MCP_PROTOCOL_VERSION, MCP_FALLBACK_PROTOCOL_VERSION];
export const MCP_CLIENT_VERSION = '1.0.0';

export interface McpServerRef {
  id: string;
  name: string;
  url: string;
}

export interface McpToolAnnotations {
  title?: string;
  readOnlyHint?: boolean;
  destructiveHint?: boolean;
  idempotentHint?: boolean;
  openWorldHint?: boolean;
}

export interface McpTool {
  name: string;
  title?: string;
  description?: string;
  inputSchema: Record<string, unknown>;
  outputSchema?: Record<string, unknown>;
  annotations?: McpToolAnnotations;
}

export interface McpContent {
  type: string;
  text?: string;
  mimeType?: string;
  data?: string;
  resource?: { uri?: string; text?: string; mimeType?: string };
  uri?: string;
  name?: string;
}

export interface McpCallResult {
  content: McpContent[];
  structuredContent?: unknown;
  isError?: boolean;
}

export type McpErrorKind = 'transport' | 'http' | 'auth' | 'rpc' | 'protocol' | 'timeout';

export class McpError extends Error {
  constructor(
    readonly kind: McpErrorKind,
    message: string,
    readonly code?: number,
    readonly status?: number,
  ) {
    super(message);
    this.name = 'McpError';
  }
  get retryable(): boolean {
    return (
      this.kind === 'transport' ||
      this.kind === 'timeout' ||
      (this.kind === 'http' && (this.status === 429 || (this.status ?? 0) >= 500))
    );
  }
}

interface JsonRpcResponse {
  jsonrpc: '2.0';
  id?: number | string | null;
  result?: unknown;
  error?: { code: number; message: string; data?: unknown };
  method?: string;
}

export interface McpClientOptions {
  credentials: CredentialStore;
  fetch?: FetchLike;
  timeoutMs?: number;
  clientVersion?: string;
}

/** Parses an SSE body, returning the data payloads of each event (multi-line data joined by \n). */
export function parseSseEvents(body: string): string[] {
  const out: string[] = [];
  let data: string[] = [];
  const flush = () => {
    if (data.length) out.push(data.join('\n'));
    data = [];
  };
  for (const rawLine of body.split(/\r?\n/)) {
    if (rawLine === '') {
      flush();
      continue;
    }
    if (rawLine.startsWith(':')) continue;
    if (rawLine.startsWith('data:')) {
      const v = rawLine.slice(5);
      data.push(v.startsWith(' ') ? v.slice(1) : v);
    }
  }
  flush();
  return out;
}

/** Picks the JSON-RPC response with the given id out of a JSON or SSE body. */
export function extractRpcResponse(
  contentType: string,
  body: string,
  id: number,
): JsonRpcResponse | undefined {
  const candidates: unknown[] = [];
  if (contentType.includes('text/event-stream')) {
    for (const payload of parseSseEvents(body)) {
      try {
        candidates.push(JSON.parse(payload));
      } catch {}
    }
  } else {
    try {
      candidates.push(JSON.parse(body));
    } catch {
      return undefined;
    }
  }
  const flat = candidates.flatMap(c => (Array.isArray(c) ? c : [c])) as JsonRpcResponse[];
  return flat.find(
    m => m && typeof m === 'object' && m.id === id && ('result' in m || 'error' in m),
  );
}

export class McpClient {
  private sessionId: string | null = null;
  private protocolVersion: string | null = null;
  private nextId = 1;
  private initializing: Promise<void> | null = null;
  private serverInfo: { name?: string; version?: string } | undefined;
  private serverCapabilities: Record<string, unknown> = {};
  private readonly timeoutMs: number;

  constructor(
    readonly server: McpServerRef,
    private readonly opts: McpClientOptions,
  ) {
    this.timeoutMs = opts.timeoutMs ?? 20_000;
  }

  get session(): string | null {
    return this.sessionId;
  }

  get negotiatedProtocolVersion(): string | null {
    return this.protocolVersion;
  }

  get info(): { name?: string; version?: string } | undefined {
    return this.serverInfo;
  }

  get capabilities(): Record<string, unknown> {
    return this.serverCapabilities;
  }

  /** initialize + notifications/initialized. Idempotent; concurrent callers share one handshake. */
  async connect(signal?: AbortSignal): Promise<void> {
    if (this.protocolVersion) return;
    if (!this.initializing) {
      this.initializing = this.handshake(signal).catch(e => {
        this.initializing = null;
        throw e;
      });
    }
    await this.initializing;
  }

  private async handshake(signal?: AbortSignal): Promise<void> {
    let lastErr: unknown;
    for (const version of SUPPORTED_PROTOCOL_VERSIONS) {
      try {
        const res = (await this.rpc(
          'initialize',
          {
            protocolVersion: version,
            capabilities: {},
            clientInfo: {
              name: 'LiquidChat',
              version: this.opts.clientVersion ?? MCP_CLIENT_VERSION,
            },
          },
          signal,
          version,
        )) as {
          protocolVersion?: string;
          capabilities?: Record<string, unknown>;
          serverInfo?: { name?: string; version?: string };
        };
        const negotiated = res?.protocolVersion ?? version;
        if (!SUPPORTED_PROTOCOL_VERSIONS.includes(negotiated))
          throw new McpError('protocol', `Server requires unsupported protocol ${negotiated}`);
        this.protocolVersion = negotiated;
        this.serverInfo = res?.serverInfo;
        this.serverCapabilities = res?.capabilities ?? {};
        await this.notify('notifications/initialized', undefined, signal);
        return;
      } catch (e) {
        lastErr = e;
        this.sessionId = null;
        // Only fall back when the server rejected the request itself, not on auth/transport.
        const retryOlder =
          e instanceof McpError &&
          (e.kind === 'rpc' || e.kind === 'protocol' || (e.kind === 'http' && e.status === 400));
        if (!retryOlder) throw e;
      }
    }
    throw lastErr;
  }

  async listTools(signal?: AbortSignal, maxPages = 20): Promise<McpTool[]> {
    await this.connect(signal);
    const tools: McpTool[] = [];
    let cursor: string | undefined;
    for (let page = 0; page < maxPages; page++) {
      const res = (await this.request('tools/list', cursor ? { cursor } : {}, signal)) as {
        tools?: McpTool[];
        nextCursor?: string;
      };
      for (const t of res?.tools ?? []) if (t && typeof t.name === 'string') tools.push(t);
      if (!res?.nextCursor || res.nextCursor === cursor) break;
      cursor = res.nextCursor;
    }
    return tools;
  }

  async callTool(
    name: string,
    args: Record<string, unknown>,
    signal?: AbortSignal,
  ): Promise<McpCallResult> {
    await this.connect(signal);
    const res = (await this.request('tools/call', { name, arguments: args }, signal)) as
      McpCallResult | undefined;
    return {
      content: Array.isArray(res?.content) ? res!.content : [],
      structuredContent: res?.structuredContent,
      isError: !!res?.isError,
    };
  }

  /** Ends the session (best effort; servers may answer 405). */
  async close(): Promise<void> {
    if (!this.sessionId) return;
    try {
      await httpRequest(
        this.server.id,
        {
          url: this.server.url,
          method: 'DELETE',
          headers: await this.headers(),
          timeoutMs: 5000,
        },
        this.opts.fetch,
      );
    } catch {}
    this.sessionId = null;
    this.protocolVersion = null;
    this.initializing = null;
  }

  /** Request with one transparent re-initialize when the server expired our session (404). */
  private async request(method: string, params: unknown, signal?: AbortSignal): Promise<unknown> {
    try {
      return await this.rpc(method, params, signal);
    } catch (e) {
      if (e instanceof McpError && e.kind === 'http' && e.status === 404 && this.sessionId) {
        this.sessionId = null;
        this.protocolVersion = null;
        this.initializing = null;
        await this.connect(signal);
        return this.rpc(method, params, signal);
      }
      throw e;
    }
  }

  private async headers(versionOverride?: string): Promise<Record<string, string>> {
    const h: Record<string, string> = {
      'Content-Type': 'application/json',
      Accept: 'application/json, text/event-stream',
    };
    const v = versionOverride ? undefined : this.protocolVersion;
    if (v) h['MCP-Protocol-Version'] = v;
    if (this.sessionId) h['Mcp-Session-Id'] = this.sessionId;
    const token = await this.opts.credentials.get(`mcp:${this.server.id}`);
    if (token) h.Authorization = `Bearer ${token}`;
    return h;
  }

  private async post(
    body: unknown,
    signal?: AbortSignal,
    versionOverride?: string,
  ): Promise<HttpResponse & { token?: string }> {
    const headers = await this.headers(versionOverride);
    const token = headers.Authorization?.slice(7);
    try {
      const res = await httpRequest(
        this.server.id,
        {
          url: this.server.url,
          headers,
          body,
          timeoutMs: this.timeoutMs,
          signal,
          secrets: [token],
        },
        this.opts.fetch,
      );
      return { ...res, token };
    } catch (e) {
      if (e instanceof ProviderError) {
        if (e.kind === 'timeout')
          throw new McpError('timeout', `${this.server.name}: ${e.message}`);
        if (e.kind === 'aborted') throw e;
        throw new McpError('transport', `${this.server.name}: ${e.message}`);
      }
      throw e;
    }
  }

  private checkHttp(res: HttpResponse & { token?: string }): void {
    if (res.status >= 200 && res.status < 300) return;
    const kind: McpErrorKind = res.status === 401 || res.status === 403 ? 'auth' : 'http';
    throw new McpError(
      kind,
      scrubSecrets(`${this.server.name} HTTP ${res.status}: ${res.text.slice(0, 200)}`, [
        res.token,
      ]),
      undefined,
      res.status,
    );
  }

  private async rpc(
    method: string,
    params: unknown,
    signal?: AbortSignal,
    versionOverride?: string,
  ): Promise<unknown> {
    const id = this.nextId++;
    const res = await this.post(
      { jsonrpc: '2.0', id, method, ...(params === undefined ? {} : { params }) },
      signal,
      versionOverride,
    );
    this.checkHttp(res);
    const sid = res.headers.get('mcp-session-id');
    if (sid) this.sessionId = sid;
    const msg = extractRpcResponse(res.headers.get('content-type') ?? '', res.text, id);
    if (!msg)
      throw new McpError('protocol', `${this.server.name}: no JSON-RPC response for ${method}`);
    if (msg.error)
      throw new McpError(
        'rpc',
        scrubSecrets(
          `${this.server.name} ${method} failed: ${msg.error.message} (${msg.error.code})`,
          [res.token],
        ),
        msg.error.code,
      );
    return msg.result;
  }

  private async notify(method: string, params?: unknown, signal?: AbortSignal): Promise<void> {
    const res = await this.post(
      { jsonrpc: '2.0', method, ...(params === undefined ? {} : { params }) },
      signal,
    );
    // Spec: 202 Accepted with no body. Tolerate 200/204 from lenient servers.
    this.checkHttp(res);
  }
}
