/**
 * OpenAI Chat Completions and compatible endpoints (OpenRouter, Groq,
 * Together, vLLM, LM Studio…): POST {baseUrl}/chat/completions.
 */
import { ProviderError } from '../errors';
import type { ChatTurn, InferenceRequest, InferenceResult } from '../types';
import { ensureOk, httpRequest, parseArgs, parseJson } from './http';
import { parseDataUrl, RemoteProviderBase } from './remoteBase';

export const OPENAI_DEFAULT_BASE_URL = 'https://api.openai.com/v1';

interface OpenAIResponse {
  choices?: {
    message?: {
      content?: string | null;
      tool_calls?: { type?: string; function?: { name?: string; arguments?: unknown } }[];
    };
    finish_reason?: string;
  }[];
  usage?: { prompt_tokens?: number; completion_tokens?: number };
}

function toOpenAIMessage(m: ChatTurn): Record<string, unknown> {
  const images = (m.images ?? []).filter(i => parseDataUrl(i) || /^https?:\/\//i.test(i));
  if (m.role !== 'user' || !images.length) return { role: m.role, content: m.content };
  return {
    role: m.role,
    content: [
      { type: 'text', text: m.content },
      ...images.map(url => ({ type: 'image_url', image_url: { url } })),
    ],
  };
}

export function buildOpenAIBody(apiModel: string, req: InferenceRequest): Record<string, unknown> {
  const body: Record<string, unknown> = {
    model: apiModel,
    messages: req.messages.map(toOpenAIMessage),
  };
  if (req.maxTokens !== undefined) body.max_tokens = req.maxTokens;
  if (req.temperature !== undefined) body.temperature = req.temperature;
  if (req.stop?.length) body.stop = req.stop.slice(0, 4);
  if (req.tools?.length) {
    body.tools = req.tools.map(t => ({
      type: 'function',
      function: { name: t.name, description: t.description, parameters: t.parameters },
    }));
  }
  if (req.json) body.response_format = { type: 'json_object' };
  return body;
}

export class OpenAICompatibleProvider extends RemoteProviderBase {
  private baseUrl(): string {
    return (this.config.baseUrl ?? OPENAI_DEFAULT_BASE_URL).replace(/\/+$/, '');
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
        url: `${this.baseUrl()}/chat/completions`,
        headers: {
          'Content-Type': 'application/json',
          Accept: 'application/json',
          Authorization: `Bearer ${key}`,
        },
        body: buildOpenAIBody(apiModel, req),
        timeoutMs: await this.timeoutMs(),
        signal,
        secrets: [key],
      },
      this.fetchImpl,
    );
    ensureOk(this.id, res, [key]);
    const j = parseJson<OpenAIResponse>(this.id, res.text);
    const choice = j.choices?.[0];
    if (!choice?.message)
      throw new ProviderError('parse', `${this.id} returned no choices`, this.id);
    if (choice.finish_reason === 'content_filter' && !choice.message.content)
      throw new ProviderError('content_filtered', `${this.id} filtered the response`, this.id);
    const functionCalls = (choice.message.tool_calls ?? [])
      .filter(c => c.function?.name)
      .map(c => ({ name: c.function!.name!, arguments: parseArgs(c.function!.arguments) }));
    return this.finish(modelId, cfg, started, {
      text: choice.message.content ?? '',
      functionCalls,
      inputTokens: j.usage?.prompt_tokens,
      outputTokens: j.usage?.completion_tokens,
    });
  }
}
