/**
 * A LiquidChat Space on Hugging Face (Gemma 4 on ZeroGPU) as a remote model. The API key is the
 * user's Hugging Face token: each call uses their own free daily GPU quota, so the cost is zero.
 * No tool calling: the router only sends it steps that need a larger model to write or reason.
 */
import { DEFAULT_SPACE_ID, SpaceClient, SpaceError } from '../../services/hfSpace';
import { ProviderError } from '../errors';
import type { InferenceRequest, InferenceResult } from '../types';
import { RemoteProviderBase } from './remoteBase';

export class HfSpaceProvider extends RemoteProviderBase {
  async complete(modelId: string, req: InferenceRequest): Promise<InferenceResult> {
    const key = await this.apiKey();
    const { cfg } = this.resolveModel(modelId);
    const started = this.now();
    const client = new SpaceClient(
      this.config.baseUrl ?? DEFAULT_SPACE_ID,
      key,
      this.fetchImpl as unknown as typeof fetch | undefined,
    );
    const messages = req.messages.map(m => ({ role: m.role, content: m.content }));
    if (req.json && messages.length) {
      const last = messages[messages.length - 1];
      messages[messages.length - 1] = {
        ...last,
        content: `${last.content}\n\nReply with one JSON object only.`,
      };
    }
    let text: string;
    try {
      text = await client.call<string>('chat', [
        JSON.stringify(messages),
        req.maxTokens ?? 1024,
        req.temperature ?? 0.3,
        'gemma',
      ]);
    } catch (e) {
      const status = e instanceof SpaceError ? e.status : undefined;
      const kind =
        status === 401 || status === 403
          ? 'auth'
          : status === 429
            ? 'rate_limit'
            : status && status >= 500
              ? 'server'
              : status
                ? 'bad_request'
                : 'network';
      throw new ProviderError(kind, e instanceof Error ? e.message : String(e), this.id);
    }
    if (typeof text !== 'string')
      throw new ProviderError('parse', `${this.id} returned no text`, this.id);
    req.onToken?.(text);
    return this.finish(modelId, cfg, started, { text });
  }
}
