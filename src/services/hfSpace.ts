/**
 * Minimal client for a Gradio Space's HTTP API: upload a file, call an endpoint, read the result
 * stream. The Hugging Face token goes in `x-hf-authorization`, which is how ZeroGPU charges the
 * caller's own GPU quota (the same header the official gradio_client sends).
 */
import { setContent, withSpan } from '../observability/spans';

/** The public LiquidChat Space (source in /space). Anyone can use it with their own token. */
export const DEFAULT_SPACE_ID = 'kshitijthakkar/LiquidChat';

/** "owner/name" or a full https URL → the Space's app URL. */
export function spaceUrl(spaceIdOrUrl: string): string {
  const s = spaceIdOrUrl.trim();
  if (/^https:\/\//i.test(s)) return s.replace(/\/+$/, '');
  const m = /^([\w.-]+)\/([\w.-]+)$/.exec(s);
  if (!m) throw new SpaceError(`Not a Space id: "${s}" (expected owner/name)`);
  return `https://${`${m[1]}-${m[2]}`.toLowerCase().replace(/[^a-z0-9-]/g, '-')}.hf.space`;
}

export class SpaceError extends Error {
  constructor(
    message: string,
    readonly status?: number,
  ) {
    super(message);
    this.name = 'SpaceError';
  }
}

export interface FileRef {
  path: string;
  meta: { _type: 'gradio.FileData' };
}

type FetchLike = typeof fetch;

function httpMessage(status: number, what: string): string {
  if (status === 401 || status === 403)
    return `${what}: the Hugging Face token was rejected (check it in Settings).`;
  if (status === 404) return `${what}: Space not found.`;
  if (status === 429) return `${what}: too many requests or GPU quota used up for today.`;
  if (status >= 500)
    return `${what}: the Space is starting or unavailable (${status}). Try again in a minute.`;
  return `${what} failed (${status}).`;
}

/** Result of a `/gradio_api/call/<api>/<id>` event stream: the first output, or the Space's error. */
export function parseEventStream(text: string): unknown {
  let event = '';
  for (const line of text.split(/\r?\n/)) {
    if (line.startsWith('event:')) event = line.slice(6).trim();
    else if (line.startsWith('data:')) {
      const data = line.slice(5).trim();
      if (event === 'complete') {
        const out = JSON.parse(data);
        return Array.isArray(out) ? out[0] : out;
      }
      if (event === 'error') {
        let msg = '';
        try {
          const j = JSON.parse(data);
          msg = typeof j === 'string' ? j : (j?.message ?? j?.error ?? '');
        } catch {
          msg = data;
        }
        throw new SpaceError(
          msg && msg !== 'null' ? `The Space reported: ${msg}` : 'The Space reported an error.',
        );
      }
    }
  }
  throw new SpaceError('The Space returned no result.');
}

export class SpaceClient {
  readonly base: string;

  constructor(
    spaceIdOrUrl: string,
    private readonly token: string,
    private readonly fetchImpl: FetchLike = fetch,
  ) {
    this.base = spaceUrl(spaceIdOrUrl);
  }

  private headers(extra: Record<string, string> = {}): Record<string, string> {
    return {
      ...(this.token ? { 'x-hf-authorization': `Bearer ${this.token}` } : {}),
      ...extra,
    };
  }

  /** Uploads a local file; the returned ref is passed as a file input. */
  async upload(filePath: string, name: string, mime: string): Promise<FileRef> {
    const form = new FormData();
    const uri = filePath.startsWith('file://') ? filePath : `file://${filePath}`;
    // React Native's FormData takes { uri, name, type } for files.
    form.append('files', { uri, name, type: mime } as unknown as Blob);
    const res = await this.fetchImpl(`${this.base}/gradio_api/upload`, {
      method: 'POST',
      headers: this.headers(),
      body: form,
    });
    if (!res.ok) throw new SpaceError(httpMessage(res.status, 'Upload'), res.status);
    const paths = (await res.json()) as string[];
    if (!Array.isArray(paths) || !paths[0]) throw new SpaceError('Upload returned no file.');
    return { path: paths[0], meta: { _type: 'gradio.FileData' } };
  }

  /** Calls `api` with positional inputs and waits for its first output. */
  call<T>(api: string, data: unknown[]): Promise<T> {
    return withSpan(
      `hf_space ${api}`,
      {
        'gen_ai.provider.name': 'hf_space',
        'gen_ai.operation.name': api === 'chat' || api === 'ask' ? 'chat' : api,
        'server.address': this.base.replace(/^https:\/\//, ''),
        'liquidchat.space.api': api,
      },
      async span => {
        const out = await this.request<T>(api, data);
        setContent(span, 'gen_ai.output.messages', out);
        return out;
      },
    );
  }

  private async request<T>(api: string, data: unknown[]): Promise<T> {
    const res = await this.fetchImpl(`${this.base}/gradio_api/call/${api}`, {
      method: 'POST',
      headers: this.headers({ 'Content-Type': 'application/json' }),
      body: JSON.stringify({ data }),
    });
    if (!res.ok) throw new SpaceError(httpMessage(res.status, `/${api}`), res.status);
    const { event_id: eventId } = (await res.json()) as { event_id?: string };
    if (!eventId) throw new SpaceError(`/${api} was not queued.`);
    const out = await this.fetchImpl(`${this.base}/gradio_api/call/${api}/${eventId}`, {
      headers: this.headers({ Accept: 'text/event-stream' }),
    });
    if (!out.ok) throw new SpaceError(httpMessage(out.status, `/${api}`), out.status);
    return parseEventStream(await out.text()) as T;
  }
}
