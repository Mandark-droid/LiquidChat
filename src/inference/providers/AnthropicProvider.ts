/**
 * Anthropic Messages API: POST https://api.anthropic.com/v1/messages.
 * System prompt is top-level; consecutive same-role turns are merged because
 * the API requires alternating user/assistant messages.
 */
import { ProviderError } from '../errors';
import type { InferenceRequest, InferenceResult } from '../types';
import { ensureOk, httpRequest, parseArgs, parseJson } from './http';
import { parseDataUrl, RemoteProviderBase } from './remoteBase';

export const ANTHROPIC_DEFAULT_BASE_URL = 'https://api.anthropic.com';
export const ANTHROPIC_VERSION = '2023-06-01';
const DEFAULT_MAX_TOKENS = 1024;

interface AnthropicResponse {
  content?: { type: string; text?: string; name?: string; input?: unknown }[];
  stop_reason?: string;
  usage?: { input_tokens?: number; output_tokens?: number };
}

type Block = Record<string, unknown>;

export function buildAnthropicBody(
  apiModel: string,
  req: InferenceRequest,
): Record<string, unknown> {
  const system = req.messages
    .filter(m => m.role === 'system')
    .map(m => m.content)
    .join('\n\n');
  const messages: { role: 'user' | 'assistant'; content: Block[] }[] = [];
  for (const m of req.messages) {
    if (m.role === 'system') continue;
    const blocks: Block[] = [];
    if (m.role === 'user') {
      for (const img of m.images ?? []) {
        const d = parseDataUrl(img);
        if (d)
          blocks.push({
            type: 'image',
            source: { type: 'base64', media_type: d.mime, data: d.data },
          });
        else if (/^https?:\/\//i.test(img))
          blocks.push({ type: 'image', source: { type: 'url', url: img } });
      }
    }
    blocks.push({ type: 'text', text: m.content || ' ' });
    const last = messages[messages.length - 1];
    if (last && last.role === m.role) last.content.push(...blocks);
    else messages.push({ role: m.role, content: blocks });
  }
  if (messages[0]?.role === 'assistant')
    messages.unshift({ role: 'user', content: [{ type: 'text', text: '(continue)' }] });

  let sys = system;
  if (req.json)
    sys = `${sys ? `${sys}\n\n` : ''}Respond with a single valid JSON object and nothing else.`;

  const body: Record<string, unknown> = {
    model: apiModel,
    max_tokens: req.maxTokens ?? DEFAULT_MAX_TOKENS,
    messages,
  };
  if (sys) body.system = sys;
  if (req.temperature !== undefined) body.temperature = req.temperature;
  if (req.stop?.length) body.stop_sequences = req.stop;
  if (req.tools?.length)
    body.tools = req.tools.map(t => ({
      name: t.name,
      description: t.description,
      input_schema: t.parameters,
    }));
  return body;
}

export class AnthropicProvider extends RemoteProviderBase {
  private baseUrl(): string {
    return (this.config.baseUrl ?? ANTHROPIC_DEFAULT_BASE_URL)
      .replace(/\/+$/, '')
      .replace(/\/v1$/, '');
  }

  async complete(
    modelId: string,
    req: InferenceRequest,
    signal?: AbortSignal,
  ): Promise<InferenceResult> {
    const key = await this.apiKey();
    const { apiModel, cfg } = this.resolveModel(modelId);
    const started = this.now();
    const res = await httpRequest(
      this.id,
      {
        url: `${this.baseUrl()}/v1/messages`,
        headers: {
          'Content-Type': 'application/json',
          'x-api-key': key,
          'anthropic-version': ANTHROPIC_VERSION,
        },
        body: buildAnthropicBody(apiModel, req),
        timeoutMs: await this.timeoutMs(),
        signal,
        secrets: [key],
      },
      this.fetchImpl,
    );
    ensureOk(this.id, res, [key]);
    const j = parseJson<AnthropicResponse>(this.id, res.text);
    if (!Array.isArray(j.content))
      throw new ProviderError('parse', `${this.id} returned no content`, this.id);
    const text = j.content
      .filter(b => b.type === 'text' && typeof b.text === 'string')
      .map(b => b.text)
      .join('');
    const functionCalls = j.content
      .filter(b => b.type === 'tool_use' && b.name)
      .map(b => ({ name: b.name!, arguments: parseArgs(b.input) }));
    if (j.stop_reason === 'refusal' && !text && !functionCalls.length)
      throw new ProviderError('content_filtered', `${this.id} refused the request`, this.id);
    return this.finish(modelId, cfg, started, {
      text,
      functionCalls,
      inputTokens: j.usage?.input_tokens,
      outputTokens: j.usage?.output_tokens,
    });
  }
}
