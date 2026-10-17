/**
 * Google Gemini API: POST {base}/v1beta/models/{model}:generateContent.
 * The key goes in the x-goog-api-key header (never the query string, so it
 * can't leak into URL logs).
 */
import type { JsonSchema } from '../../tools/types';
import { ProviderError } from '../errors';
import type { InferenceRequest, InferenceResult } from '../types';
import { ensureOk, httpRequest, parseArgs, parseJson } from './http';
import { parseDataUrl, RemoteProviderBase } from './remoteBase';

export const GEMINI_DEFAULT_BASE_URL = 'https://generativelanguage.googleapis.com';

interface GeminiResponse {
  candidates?: {
    content?: { parts?: { text?: string; functionCall?: { name?: string; args?: unknown } }[] };
    finishReason?: string;
  }[];
  promptFeedback?: { blockReason?: string };
  usageMetadata?: { promptTokenCount?: number; candidatesTokenCount?: number };
}

/** Gemini's OpenAPI-subset schema rejects some JSON-Schema keywords. */
function toGeminiSchema(s: JsonSchema): Record<string, unknown> {
  const out: Record<string, unknown> = {};
  if (s.type) out.type = s.type;
  if (s.description) out.description = s.description;
  if (s.enum) out.enum = s.enum.map(String);
  if (s.format === 'date-time') out.format = 'date-time';
  if (s.minimum !== undefined) out.minimum = s.minimum;
  if (s.maximum !== undefined) out.maximum = s.maximum;
  if (s.items) out.items = toGeminiSchema(s.items);
  if (s.properties) {
    out.properties = Object.fromEntries(
      Object.entries(s.properties).map(([k, v]) => [k, toGeminiSchema(v)]),
    );
  }
  if (s.required?.length) out.required = s.required;
  return out;
}

export function buildGeminiBody(req: InferenceRequest): Record<string, unknown> {
  const system = req.messages
    .filter(m => m.role === 'system')
    .map(m => m.content)
    .join('\n\n');
  const contents: { role: 'user' | 'model'; parts: Record<string, unknown>[] }[] = [];
  for (const m of req.messages) {
    if (m.role === 'system') continue;
    const role = m.role === 'assistant' ? 'model' : 'user';
    const parts: Record<string, unknown>[] = [];
    for (const img of m.role === 'user' ? (m.images ?? []) : []) {
      const d = parseDataUrl(img);
      if (d) parts.push({ inlineData: { mimeType: d.mime, data: d.data } });
    }
    parts.push({ text: m.content });
    const last = contents[contents.length - 1];
    if (last && last.role === role) last.parts.push(...parts);
    else contents.push({ role, parts });
  }
  const body: Record<string, unknown> = { contents };
  if (system) body.systemInstruction = { parts: [{ text: system }] };
  const gen: Record<string, unknown> = {};
  if (req.maxTokens !== undefined) gen.maxOutputTokens = req.maxTokens;
  if (req.temperature !== undefined) gen.temperature = req.temperature;
  if (req.stop?.length) gen.stopSequences = req.stop.slice(0, 5);
  // JSON mode and function calling are mutually exclusive in Gemini.
  if (req.json && !req.tools?.length) gen.responseMimeType = 'application/json';
  if (Object.keys(gen).length) body.generationConfig = gen;
  if (req.tools?.length) {
    body.tools = [
      {
        functionDeclarations: req.tools.map(t => ({
          name: t.name,
          description: t.description,
          parameters: toGeminiSchema(t.parameters),
        })),
      },
    ];
  }
  return body;
}

export class GeminiProvider extends RemoteProviderBase {
  private baseUrl(): string {
    return (this.config.baseUrl ?? GEMINI_DEFAULT_BASE_URL)
      .replace(/\/+$/, '')
      .replace(/\/v1beta$/, '');
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
        url: `${this.baseUrl()}/v1beta/models/${encodeURIComponent(apiModel)}:generateContent`,
        headers: { 'Content-Type': 'application/json', 'x-goog-api-key': key },
        body: buildGeminiBody(req),
        timeoutMs: await this.timeoutMs(),
        signal,
        secrets: [key],
      },
      this.fetchImpl,
    );
    ensureOk(this.id, res, [key]);
    const j = parseJson<GeminiResponse>(this.id, res.text);
    if (j.promptFeedback?.blockReason)
      throw new ProviderError(
        'content_filtered',
        `${this.id} blocked the prompt (${j.promptFeedback.blockReason})`,
        this.id,
      );
    const cand = j.candidates?.[0];
    if (!cand) throw new ProviderError('parse', `${this.id} returned no candidates`, this.id);
    const parts = cand.content?.parts ?? [];
    if (!parts.length && cand.finishReason === 'SAFETY')
      throw new ProviderError('content_filtered', `${this.id} filtered the response`, this.id);
    const text = parts
      .filter(p => typeof p.text === 'string')
      .map(p => p.text)
      .join('');
    const functionCalls = parts
      .filter(p => p.functionCall?.name)
      .map(p => ({ name: p.functionCall!.name!, arguments: parseArgs(p.functionCall!.args) }));
    return this.finish(modelId, cfg, started, {
      text,
      functionCalls,
      inputTokens: j.usageMetadata?.promptTokenCount,
      outputTokens: j.usageMetadata?.candidatesTokenCount,
    });
  }
}
