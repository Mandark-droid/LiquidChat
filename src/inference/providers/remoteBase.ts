/**
 * Common plumbing for remote providers: key lookup, model price lookup,
 * timeout policy and result assembly.
 */
import type { CredentialStore } from '../../platform/types';
import { estimateCostUsd } from '../CostLedger';
import { ProviderError } from '../errors';
import {
  providerKeyName,
  type RemoteModelConfig,
  type RemoteProviderConfig,
} from '../ModelRegistry';
import type { InferenceProvider, InferenceRequest, InferenceResult } from '../types';
import type { FetchLike } from './http';

export interface RemoteProviderDeps {
  config: RemoteProviderConfig;
  credentials: CredentialStore;
  fetch?: FetchLike;
  timeoutMs?: number | (() => number | Promise<number>);
  now?: () => number;
}

export abstract class RemoteProviderBase implements InferenceProvider {
  readonly mode = 'remote' as const;
  protected readonly config: RemoteProviderConfig;
  protected readonly credentials: CredentialStore;
  protected readonly fetchImpl?: FetchLike;
  private readonly timeout: RemoteProviderDeps['timeoutMs'];
  protected readonly now: () => number;

  constructor(deps: RemoteProviderDeps) {
    this.config = deps.config;
    this.credentials = deps.credentials;
    this.fetchImpl = deps.fetch;
    this.timeout = deps.timeoutMs;
    this.now = deps.now ?? Date.now;
  }

  get id(): string {
    return this.config.id;
  }

  async isAvailable(): Promise<boolean> {
    return this.config.enabled && (await this.credentials.has(providerKeyName(this.config.id)));
  }

  protected async apiKey(): Promise<string> {
    const k = await this.credentials.get(providerKeyName(this.config.id));
    if (!k) throw new ProviderError('unavailable', `No API key configured for ${this.id}`, this.id);
    return k;
  }

  protected async timeoutMs(): Promise<number> {
    const t = typeof this.timeout === 'function' ? await this.timeout() : this.timeout;
    return t ?? 20_000;
  }

  /** Accepts either the provider's raw model id or the registry's "<provider>/<model>" id. */
  protected resolveModel(modelId: string): { apiModel: string; cfg?: RemoteModelConfig } {
    const prefix = `${this.config.id}/`;
    const apiModel = modelId.startsWith(prefix) ? modelId.slice(prefix.length) : modelId;
    return { apiModel, cfg: this.config.models.find(m => m.id === apiModel) };
  }

  protected finish(
    modelId: string,
    cfg: RemoteModelConfig | undefined,
    startedAt: number,
    out: {
      text: string;
      functionCalls?: InferenceResult['functionCalls'];
      inputTokens?: number;
      outputTokens?: number;
    },
  ): InferenceResult {
    const latencyMs = Math.max(0, this.now() - startedAt);
    const costUsd =
      cfg && (out.inputTokens !== undefined || out.outputTokens !== undefined)
        ? estimateCostUsd(
            out.inputTokens ?? 0,
            out.outputTokens ?? 0,
            cfg.inputCostPerM,
            cfg.outputCostPerM,
          )
        : undefined;
    return {
      text: out.text,
      functionCalls: out.functionCalls?.length ? out.functionCalls : undefined,
      modelId,
      provider: this.id,
      mode: 'remote',
      latencyMs,
      inputTokens: out.inputTokens,
      outputTokens: out.outputTokens,
      tokensPerSecond:
        out.outputTokens && latencyMs > 0 ? (out.outputTokens / latencyMs) * 1000 : undefined,
      costUsd,
    };
  }

  abstract complete(
    modelId: string,
    req: InferenceRequest,
    signal?: AbortSignal,
  ): Promise<InferenceResult>;
}

/** Splits a data: URL into mime + base64; returns null for file paths / http URLs. */
export function parseDataUrl(s: string): { mime: string; data: string } | null {
  const m = /^data:([^;,]+);base64,(.*)$/s.exec(s);
  return m ? { mime: m[1], data: m[2] } : null;
}
