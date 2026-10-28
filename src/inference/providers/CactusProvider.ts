/**
 * On-device inference through cactus-react-native. Models are loaded via the
 * ModelLifecycleManager (RAM budget + LRU eviction). Each CactusLM instance
 * runs one generation at a time, so calls are serialized per model, and the
 * KV cache is reset before every independent prompt.
 */
import type { CactusLM } from 'cactus-react-native';

import { modelLifecycle } from '../../services/ModelLifecycleManager';
import type { JsonSchema } from '../../tools/types';
import { isAbortError, ProviderError } from '../errors';
import { LOCAL_PROVIDER_ID } from '../ModelRegistry';
import type { ChatTurn, InferenceProvider, InferenceRequest, InferenceResult } from '../types';

type CompleteParams = Parameters<CactusLM['complete']>[0];
type CactusTool = NonNullable<CompleteParams['tools']>[number];

export interface LocalModelHandle {
  instance: Pick<CactusLM, 'complete' | 'reset' | 'stop'> | null;
}

export interface LocalModelLoader {
  ensure(slug: string): Promise<LocalModelHandle>;
}

export interface CactusProviderDeps {
  lifecycle?: LocalModelLoader;
  now?: () => number;
}

const JSON_HINT = 'Respond with a single valid JSON object and nothing else.';

/** Cactus' tool type is narrower than JSON Schema: flatten each property to {type, description}. */
export function toCactusTool(t: {
  name: string;
  description: string;
  parameters: JsonSchema;
}): CactusTool {
  const props: Record<string, { type: string; description: string }> = {};
  for (const [k, v] of Object.entries(t.parameters.properties ?? {})) {
    const enumHint = v.enum ? ` One of: ${v.enum.join(', ')}.` : '';
    props[k] = { type: v.type ?? 'string', description: `${v.description ?? k}${enumHint}`.trim() };
  }
  return {
    name: t.name,
    description: t.description,
    parameters: { type: 'object', properties: props, required: t.parameters.required ?? [] },
  };
}

function toCactusMessages(messages: ChatTurn[], json?: boolean): CompleteParams['messages'] {
  const out = messages.map(m => ({
    role: m.role,
    content: m.content,
    ...(m.images?.length ? { images: [...m.images] } : {}),
  }));
  if (json) {
    const sys = out.find(m => m.role === 'system');
    if (sys) sys.content = `${sys.content}\n\n${JSON_HINT}`;
    else out.unshift({ role: 'system', content: JSON_HINT });
  }
  return out;
}

export class CactusProvider implements InferenceProvider {
  readonly id = LOCAL_PROVIDER_ID;
  readonly mode = 'local' as const;
  private readonly queues = new Map<string, Promise<unknown>>();
  private readonly now: () => number;

  constructor(private readonly deps: CactusProviderDeps = {}) {
    this.now = deps.now ?? Date.now;
  }

  private loader(): LocalModelLoader {
    if (this.deps.lifecycle) return this.deps.lifecycle;
    // Lazy: keeps native-module imports out of code paths that never run locally.
    const { modelLifecycle } = require('../../services/ModelLifecycleManager') as {
      modelLifecycle: LocalModelLoader;
    };
    return modelLifecycle;
  }

  async isAvailable(): Promise<boolean> {
    return true;
  }

  complete(modelId: string, req: InferenceRequest, signal?: AbortSignal): Promise<InferenceResult> {
    const prev = this.queues.get(modelId) ?? Promise.resolve();
    const run = prev.then(
      () => this.run(modelId, req, signal),
      () => this.run(modelId, req, signal),
    );
    const tail = run.catch(() => undefined);
    this.queues.set(modelId, tail);
    void tail.then(() => {
      if (this.queues.get(modelId) === tail) this.queues.delete(modelId);
    });
    return run;
  }

  private async run(
    modelId: string,
    req: InferenceRequest,
    signal?: AbortSignal,
  ): Promise<InferenceResult> {
    if (signal?.aborted) throw new ProviderError('aborted', 'Request cancelled', this.id);
    const started = this.now();
    let handle: LocalModelHandle;
    try {
      handle = await this.loader().ensure(modelId);
    } catch (e) {
      throw new ProviderError(
        'unavailable',
        `Could not load ${modelId}: ${(e as Error).message}`,
        this.id,
      );
    }
    const lm = handle.instance;
    if (!lm) throw new ProviderError('unavailable', `${modelId} is not loaded`, this.id);

    const onAbort = () => void lm.stop().catch(() => {});
    signal?.addEventListener?.('abort', onAbort);
    try {
      await lm.reset();
      const r = await lm.complete({
        messages: toCactusMessages(req.messages, req.json),
        tools: req.tools?.length ? req.tools.map(toCactusTool) : undefined,
        options: {
          temperature: req.temperature,
          maxTokens: req.maxTokens,
          stopSequences: req.stop,
        },
        onToken: req.onToken,
      });
      modelLifecycle.recordCompletion(lm, r);
      if (signal?.aborted) throw new ProviderError('aborted', 'Request cancelled', this.id);
      if (r.success === false)
        throw new ProviderError('model_error', `${modelId} failed to generate`, this.id);
      const latencyMs = r.totalTimeMs > 0 ? r.totalTimeMs : Math.max(0, this.now() - started);
      return {
        text: r.response ?? '',
        functionCalls: r.functionCalls?.length
          ? r.functionCalls.map(f => ({ name: f.name, arguments: { ...(f.arguments ?? {}) } }))
          : undefined,
        modelId,
        provider: this.id,
        mode: 'local',
        latencyMs,
        inputTokens: r.prefillTokens,
        outputTokens: r.decodeTokens,
        tokensPerSecond: r.decodeTps || undefined,
        confidence: r.confidence,
        costUsd: 0,
        ramUsageMb: r.ramUsageMb,
      };
    } catch (e) {
      if (e instanceof ProviderError) throw e;
      if (isAbortError(e) || signal?.aborted)
        throw new ProviderError('aborted', 'Request cancelled', this.id);
      throw new ProviderError('model_error', `${modelId}: ${(e as Error).message}`, this.id);
    } finally {
      signal?.removeEventListener?.('abort', onAbort);
    }
  }
}
