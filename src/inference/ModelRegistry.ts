/**
 * ModelRegistry (PRD §6.3): one list of ModelCapabilities covering the local
 * Cactus catalog and the user's configured remote providers.
 *
 * - Local capabilities come from the static catalog (src/config/models.ts).
 *   Quality is NEVER inferred from parameter count: qualityScores only exist
 *   once measured samples have been recorded via recordSample().
 * - Remote provider configs live in AsyncStorage ('@liquid_remote_providers');
 *   their API keys live ONLY in the CredentialStore under `provider:<id>`.
 * - Measured latency / throughput / per-operation success rates are kept in
 *   the model_stats table as EWMAs and merged into capabilities().
 */
import AsyncStorage from '@react-native-async-storage/async-storage';

import { LIQUID_MODELS } from '../config/models';
import type { CredentialStore } from '../platform/types';
import { fromJson, getDatabase, type SqlDb, toJson } from '../storage/db';
import type { LiquidModel } from '../types';
import type { InferOperation, ModelCapabilities } from './types';

export const REMOTE_PROVIDERS_KEY = '@liquid_remote_providers';
export const LOCAL_PROVIDER_ID = 'cactus';
/** RAM a loaded Cactus model needs relative to its download size (matches ModelLifecycleManager). */
export const LOCAL_RAM_MULTIPLIER = 1.3;
/** Context at or above this counts as "long context". */
export const LONG_CONTEXT_TOKENS = 64_000;
/** Below this many samples for an operation, its quality stays "unknown". */
export const MIN_QUALITY_SAMPLES = 3;
/** EWMA floor: once samples > 1/alpha the average weights recent samples by alpha. */
const EWMA_ALPHA = 0.2;

export type RemoteProviderKind = 'openai' | 'anthropic' | 'gemini';

export interface RemoteModelConfig {
  id: string;
  displayName: string;
  contextTokens: number;
  vision: boolean;
  tools: boolean;
  /** USD per million input tokens. */
  inputCostPerM: number;
  /** USD per million output tokens. */
  outputCostPerM: number;
  /** Defaults to true (all three APIs offer JSON / tool-forced output). */
  structuredOutput?: boolean;
}

export interface RemoteProviderConfig {
  id: string;
  kind: RemoteProviderKind;
  /** OpenAI-compatible endpoints (OpenRouter, Groq, vLLM…); defaults per kind. */
  baseUrl?: string;
  models: RemoteModelConfig[];
  enabled: boolean;
}

/** Registry entry: capabilities plus what's needed to dispatch the call. */
export interface ModelEntry extends ModelCapabilities {
  /** The id the provider's API expects (slug for local, raw model id for remote). */
  providerModelId: string;
  /** Local only: recommended minimum device RAM. */
  minDeviceRamMb?: number;
  providerKind?: RemoteProviderKind | 'cactus';
}

export interface ModelSample {
  latencyMs?: number;
  tps?: number;
  operation?: InferOperation;
  success?: boolean;
}

interface OpQuality {
  n: number;
  rate: number;
}

interface StatsRow {
  samples: number;
  avgLatencyMs?: number;
  avgTps?: number;
  quality: Partial<Record<InferOperation, OpQuality>>;
}

export interface KeyValueStore {
  getItem(key: string): Promise<string | null>;
  setItem(key: string, value: string): Promise<void>;
}

export interface ModelRegistryDeps {
  credentials: CredentialStore;
  storage?: KeyValueStore;
  db?: () => Promise<SqlDb>;
  catalog?: LiquidModel[];
  now?: () => number;
}

export const providerKeyName = (providerId: string): string => `provider:${providerId}`;

/** Remote model ids are qualified so two providers can expose the same model. */
export const remoteModelId = (providerId: string, modelId: string): string =>
  `${providerId}/${modelId}`;

function localContextTokens(slug: string): number {
  const s = slug.toLowerCase();
  if (s.startsWith('lfm2') || s.startsWith('qwen3.5')) return 32_768;
  return 8_192;
}

/** Local catalog → capabilities (completion models only; no STT/embedding/legacy). */
export function localEntries(catalog: LiquidModel[] = LIQUID_MODELS): ModelEntry[] {
  return catalog
    .filter(
      m =>
        m.supportsCompletion &&
        !m.isSTT &&
        !m.legacy &&
        m.category !== 'embedding' &&
        m.category !== 'audio',
    )
    .map(m => {
      const ctx = localContextTokens(m.slug);
      return {
        modelId: m.slug,
        providerModelId: m.slug,
        provider: 'local',
        providerId: LOCAL_PROVIDER_ID,
        providerKind: 'cactus',
        displayName: m.name,
        supportsToolCalling: m.supportsToolCalling,
        supportsVision: m.supportsVision,
        // Cactus has no grammar-constrained decoding; JSON is best-effort and
        // validated downstream. Tool-calling models reliably emit JSON objects.
        supportsStructuredOutput: m.supportsToolCalling,
        supportsLongContext: ctx >= LONG_CONTEXT_TOKENS,
        maxContextTokens: ctx,
        estimatedMemoryMB: Math.round(m.sizeMb * LOCAL_RAM_MULTIPLIER),
        estimatedInputCostPerMillion: 0,
        estimatedOutputCostPerMillion: 0,
        minDeviceRamMb: m.minRamGb ? m.minRamGb * 1024 : undefined,
      } satisfies ModelEntry;
    });
}

export function remoteEntries(configs: RemoteProviderConfig[]): ModelEntry[] {
  const out: ModelEntry[] = [];
  for (const p of configs) {
    for (const m of p.models) {
      out.push({
        modelId: remoteModelId(p.id, m.id),
        providerModelId: m.id,
        provider: 'remote',
        providerId: p.id,
        providerKind: p.kind,
        displayName: m.displayName,
        supportsToolCalling: m.tools,
        supportsVision: m.vision,
        supportsStructuredOutput: m.structuredOutput ?? true,
        supportsLongContext: m.contextTokens >= LONG_CONTEXT_TOKENS,
        maxContextTokens: m.contextTokens,
        estimatedInputCostPerMillion: m.inputCostPerM,
        estimatedOutputCostPerMillion: m.outputCostPerM,
      });
    }
  }
  return out;
}

function validateConfigs(configs: RemoteProviderConfig[]): void {
  const ids = new Set<string>();
  for (const p of configs) {
    if (!p.id || !/^[A-Za-z0-9_-]+$/.test(p.id))
      throw new Error(`Invalid provider id "${p.id}" (use letters, digits, - or _)`);
    if (p.id === LOCAL_PROVIDER_ID) throw new Error(`Provider id "${p.id}" is reserved`);
    if (ids.has(p.id)) throw new Error(`Duplicate provider id "${p.id}"`);
    ids.add(p.id);
    if (!['openai', 'anthropic', 'gemini'].includes(p.kind))
      throw new Error(`Unknown provider kind "${p.kind}"`);
    if (p.baseUrl && !/^https?:\/\//i.test(p.baseUrl))
      throw new Error(`Provider "${p.id}" baseUrl must be http(s)`);
    // Guard against a key accidentally pasted into the config object.
    if ('apiKey' in (p as unknown as Record<string, unknown>))
      throw new Error('API keys must be stored in the CredentialStore, not in provider config');
  }
}

export class ModelRegistry {
  private readonly credentials: CredentialStore;
  private readonly storage: KeyValueStore;
  private readonly db: () => Promise<SqlDb>;
  private readonly catalog: LiquidModel[];
  private readonly now: () => number;
  private remoteCache: RemoteProviderConfig[] | null = null;

  constructor(deps: ModelRegistryDeps) {
    this.credentials = deps.credentials;
    this.storage = deps.storage ?? AsyncStorage;
    this.db = deps.db ?? (() => getDatabase());
    this.catalog = deps.catalog ?? LIQUID_MODELS;
    this.now = deps.now ?? Date.now;
  }

  // ---- remote provider configuration ------------------------------------

  async remoteProviders(): Promise<RemoteProviderConfig[]> {
    if (this.remoteCache) return this.remoteCache;
    let parsed: RemoteProviderConfig[] = [];
    try {
      const raw = await this.storage.getItem(REMOTE_PROVIDERS_KEY);
      const v = raw ? (JSON.parse(raw) as unknown) : [];
      if (Array.isArray(v)) parsed = v as RemoteProviderConfig[];
    } catch {
      parsed = [];
    }
    this.remoteCache = parsed;
    return parsed;
  }

  async provider(providerId: string): Promise<RemoteProviderConfig | undefined> {
    return (await this.remoteProviders()).find(p => p.id === providerId);
  }

  async saveRemoteProviders(configs: RemoteProviderConfig[]): Promise<void> {
    validateConfigs(configs);
    const clean = configs.map(p => ({
      id: p.id,
      kind: p.kind,
      baseUrl: p.baseUrl,
      enabled: p.enabled,
      models: p.models.map(m => ({ ...m })),
    }));
    await this.storage.setItem(REMOTE_PROVIDERS_KEY, JSON.stringify(clean));
    this.remoteCache = clean;
  }

  /** Adds or replaces one provider; optionally stores its key in the CredentialStore. */
  async upsertProvider(config: RemoteProviderConfig, apiKey?: string): Promise<void> {
    const all = (await this.remoteProviders()).filter(p => p.id !== config.id);
    await this.saveRemoteProviders([...all, config]);
    if (apiKey !== undefined) await this.credentials.set(providerKeyName(config.id), apiKey);
  }

  async removeProvider(providerId: string): Promise<void> {
    const all = (await this.remoteProviders()).filter(p => p.id !== providerId);
    await this.saveRemoteProviders(all);
    await this.credentials.delete(providerKeyName(providerId));
  }

  async setProviderEnabled(providerId: string, enabled: boolean): Promise<void> {
    const all = await this.remoteProviders();
    await this.saveRemoteProviders(all.map(p => (p.id === providerId ? { ...p, enabled } : p)));
  }

  async hasProviderKey(providerId: string): Promise<boolean> {
    return this.credentials.has(providerKeyName(providerId));
  }

  /** Drops the cached provider list (e.g. after another screen edited storage). */
  invalidate(): void {
    this.remoteCache = null;
  }

  // ---- capabilities -----------------------------------------------------

  /** Every known model (local + all configured remote, enabled or not), with measured stats merged. */
  async entries(): Promise<ModelEntry[]> {
    const base = [...localEntries(this.catalog), ...remoteEntries(await this.remoteProviders())];
    const stats = await this.loadStats();
    return base.map(e => mergeStats(e, stats.get(e.modelId)));
  }

  async capabilities(): Promise<ModelCapabilities[]> {
    return this.entries();
  }

  async get(modelId: string): Promise<ModelEntry | undefined> {
    return (await this.entries()).find(e => e.modelId === modelId);
  }

  // ---- measured stats ---------------------------------------------------

  async recordSample(modelId: string, sample: ModelSample): Promise<void> {
    const db = await this.db();
    const r = await db.execute(
      'SELECT samples, avg_latency_ms, avg_tps, quality_json FROM model_stats WHERE model_id = ?',
      [modelId],
    );
    const row = r.rows[0];
    const prev: StatsRow = row
      ? {
          samples: Number(row.samples ?? 0),
          avgLatencyMs: row.avg_latency_ms == null ? undefined : Number(row.avg_latency_ms),
          avgTps: row.avg_tps == null ? undefined : Number(row.avg_tps),
          quality: fromJson<StatsRow['quality']>(row.quality_json) ?? {},
        }
      : { samples: 0, quality: {} };

    const samples = prev.samples + 1;
    const alpha = Math.max(1 / samples, EWMA_ALPHA);
    const timing = sample.success !== false;
    const avgLatencyMs =
      timing && isPositive(sample.latencyMs)
        ? ewma(prev.avgLatencyMs, sample.latencyMs!, alpha)
        : prev.avgLatencyMs;
    const avgTps =
      timing && isPositive(sample.tps) ? ewma(prev.avgTps, sample.tps!, alpha) : prev.avgTps;

    const quality = { ...prev.quality };
    if (sample.operation && sample.success !== undefined) {
      const q = quality[sample.operation] ?? { n: 0, rate: 0 };
      const n = q.n + 1;
      const a = Math.max(1 / n, EWMA_ALPHA);
      quality[sample.operation] = {
        n,
        rate: ewma(q.n ? q.rate : undefined, sample.success ? 1 : 0, a),
      };
    }

    await db.execute(
      `INSERT INTO model_stats (model_id, samples, avg_latency_ms, avg_tps, quality_json, updated_at)
       VALUES (?, ?, ?, ?, ?, ?)
       ON CONFLICT(model_id) DO UPDATE SET samples = excluded.samples,
         avg_latency_ms = excluded.avg_latency_ms, avg_tps = excluded.avg_tps,
         quality_json = excluded.quality_json, updated_at = excluded.updated_at`,
      [modelId, samples, avgLatencyMs ?? null, avgTps ?? null, toJson(quality), this.now()],
    );
  }

  async resetStats(modelId?: string): Promise<void> {
    const db = await this.db();
    if (modelId) await db.execute('DELETE FROM model_stats WHERE model_id = ?', [modelId]);
    else await db.execute('DELETE FROM model_stats');
  }

  private async loadStats(): Promise<Map<string, StatsRow>> {
    const db = await this.db();
    const r = await db.execute(
      'SELECT model_id, samples, avg_latency_ms, avg_tps, quality_json FROM model_stats',
    );
    const m = new Map<string, StatsRow>();
    for (const row of r.rows) {
      m.set(String(row.model_id), {
        samples: Number(row.samples ?? 0),
        avgLatencyMs: row.avg_latency_ms == null ? undefined : Number(row.avg_latency_ms),
        avgTps: row.avg_tps == null ? undefined : Number(row.avg_tps),
        quality: fromJson<StatsRow['quality']>(row.quality_json) ?? {},
      });
    }
    return m;
  }
}

function isPositive(n: number | undefined): boolean {
  return typeof n === 'number' && Number.isFinite(n) && n > 0;
}

function ewma(prev: number | undefined, x: number, alpha: number): number {
  return prev === undefined ? x : prev + alpha * (x - prev);
}

function mergeStats(e: ModelEntry, s: StatsRow | undefined): ModelEntry {
  if (!s) return e;
  const qualityScores: Partial<Record<InferOperation, number>> = {};
  for (const [op, q] of Object.entries(s.quality) as [InferOperation, OpQuality][]) {
    if (q && q.n >= MIN_QUALITY_SAMPLES) qualityScores[op] = round3(q.rate);
  }
  return {
    ...e,
    samples: s.samples,
    averageLatencyMs: s.avgLatencyMs,
    averageTokensPerSecond: s.avgTps,
    qualityScores: Object.keys(qualityScores).length ? qualityScores : undefined,
  };
}

function round3(n: number): number {
  return Math.round(n * 1000) / 1000;
}
