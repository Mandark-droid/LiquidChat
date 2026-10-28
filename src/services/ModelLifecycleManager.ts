import { CactusAudio, CactusLM, CactusSTT } from 'cactus-react-native';
import DeviceInfo from 'react-native-device-info';

import { getModelBySlug, LIQUID_MODELS, quantizationFor } from '../config/models';
import { type DeviceProfile, getDeviceProfile, getModelTier } from '../config/modelTiers';
import type { ModelState, ModelTier } from '../types';
import { ensurePinnedWeights } from './cactusWeights';

const RAM_MULTIPLIER = 1.3;

/** Audio models outside the catalog (voice activity, speaker embeddings) and their RAM. */
const AUDIO_RAM_MB: Record<string, number> = {
  'silero-vad': 10,
  'wespeaker-voxceleb-resnet34-lm': 60,
};

/** Chat/vision models, speech-to-text, and audio analysis (VAD, speaker embeddings). */
export type ModelKind = 'lm' | 'stt' | 'audio';

export interface ManagedModel {
  slug: string;
  kind: ModelKind;
  tier: ModelTier;
  state: ModelState;
  /** The loaded instance for `kind: 'lm'`. */
  instance: CactusLM | null;
  stt: CactusSTT | null;
  audio: CactusAudio | null;
  nativeInstance: any;
  isCustomModel: boolean;
  lastUsed: number;
  ramMb: number;
  /** Owners that hold it across many calls (a meeting's Whisper): never evicted while > 0. */
  pins: number;
  /** Calls since it was loaded, their total time and the decode speed of the last one. */
  uses?: number;
  totalMs?: number;
  tokensPerSecond?: number;
}

export interface EnsureOptions {
  onProgress?: (progress: number) => void;
  /** Keep it loaded (not evictable) until `release(slug)`. */
  pin?: boolean;
}

type Listener = () => void;

function kindOf(slug: string): ModelKind {
  if (slug in AUDIO_RAM_MB) return 'audio';
  return getModelBySlug(slug)?.isSTT ? 'stt' : 'lm';
}

function estimateRamMb(slug: string): number {
  if (slug in AUDIO_RAM_MB) return AUDIO_RAM_MB[slug];
  const def = getModelBySlug(slug);
  return def ? Math.round(def.sizeMb * RAM_MULTIPLIER) : 500;
}

function progressLogger(slug: string, label: string) {
  return (p: number) => {
    if (p % 0.25 < 0.01)
      console.log(`[ModelLifecycle] ${label} "${slug}": ${Math.round(p * 100)}%`);
  };
}

/**
 * Every on-device model loads through here (chat and vision LMs, speech-to-text, VAD and speaker
 * embeddings), so the app has one RAM budget, one load queue and one list of what is loaded.
 */
class ModelLifecycleManager {
  private models = new Map<string, ManagedModel>();
  private profile: DeviceProfile | null = null;
  private listeners: Set<Listener> = new Set();
  private loadingLocks = new Map<string, Promise<ManagedModel>>();
  private _initialized = false;
  // Global mutex: native Cactus cannot handle concurrent init() calls
  private _globalLoadQueue: Promise<any> = Promise.resolve();

  get initialized(): boolean {
    return this._initialized;
  }

  async init(): Promise<void> {
    if (this._initialized) return;

    // Get total RAM from device
    let totalRamBytes = 6 * 1024 * 1024 * 1024; // 6GB safe default
    try {
      totalRamBytes = await DeviceInfo.getTotalMemory();
    } catch {
      // Use default
    }

    this.profile = getDeviceProfile(totalRamBytes);
    console.log(
      `[ModelLifecycle] Device profile: ${this.profile.name} (budget: ${this.profile.ramBudgetMb}MB)`,
    );

    // Register all catalog models
    for (const model of LIQUID_MODELS) this.entry(model.slug);

    this._initialized = true;
    this.notify();
  }

  private entry(slug: string): ManagedModel {
    let managed = this.models.get(slug);
    if (!managed) {
      managed = {
        slug,
        kind: kindOf(slug),
        tier: getModelTier(slug),
        state: 'unloaded',
        instance: null,
        stt: null,
        audio: null,
        nativeInstance: null,
        isCustomModel: getModelBySlug(slug)?.isCustom ?? false,
        lastUsed: 0,
        ramMb: 0,
        pins: 0,
      };
      this.models.set(slug, managed);
    }
    return managed;
  }

  /** A chat or vision model, loaded (and downloaded) if needed. */
  async ensure(slug: string, opts: EnsureOptions = {}): Promise<ManagedModel> {
    if (kindOf(slug) === 'stt')
      throw new Error(`"${slug}" is a speech-to-text model; use ensureSTT().`);
    return this.ensureAny(slug, opts);
  }

  /** A speech-to-text model (Whisper, Parakeet, Moonshine). */
  async ensureSTT(slug: string, opts: EnsureOptions = {}): Promise<CactusSTT> {
    if (kindOf(slug) !== 'stt') throw new Error(`"${slug}" is not a speech-to-text model.`);
    const managed = await this.ensureAny(slug, opts);
    if (!managed.stt) throw new Error(`${slug} failed to load`);
    return managed.stt;
  }

  /** An audio analysis model (voice activity detection, speaker embeddings). */
  async ensureAudio(slug: string, opts: EnsureOptions = {}): Promise<CactusAudio> {
    if (kindOf(slug) !== 'audio') throw new Error(`"${slug}" is not an audio model.`);
    const managed = await this.ensureAny(slug, opts);
    if (!managed.audio) throw new Error(`${slug} failed to load`);
    return managed.audio;
  }

  private async ensureAny(slug: string, opts: EnsureOptions): Promise<ManagedModel> {
    if (!this._initialized) await this.init();

    const existing = this.models.get(slug);
    if (existing && existing.state === 'ready') {
      existing.lastUsed = Date.now();
      if (opts.pin) existing.pins++;
      this.notify();
      return existing;
    }

    // Per-slug dedup: if already loading this exact slug, wait for it
    let loadPromise = this.loadingLocks.get(slug);
    if (!loadPromise) {
      // Serialize ALL model loads through global queue —
      // native Cactus crashes when two init() calls run concurrently
      loadPromise = this._globalLoadQueue.then(
        () => this.loadModel(slug, opts.onProgress),
        () => this.loadModel(slug, opts.onProgress), // proceed even if previous load failed
      );
      this._globalLoadQueue = loadPromise.catch(() => {}); // keep queue moving
      this.loadingLocks.set(slug, loadPromise);
      loadPromise.finally(() => this.loadingLocks.delete(slug)).catch(() => {});
    }
    const managed = await loadPromise;
    if (opts.pin) managed.pins++;
    return managed;
  }

  /** Downloads a model's weights without loading it. */
  async download(slug: string, onProgress?: (progress: number) => void): Promise<void> {
    const kind = kindOf(slug);
    const quantization = quantizationFor(slug);
    if (kind !== 'audio')
      // The SDK would pick v1.12 weights, which mismatch this engine; fetch v1.14 where published.
      await ensurePinnedWeights(slug, quantization ?? 'int8', onProgress);
    else if (slug !== 'silero-vad') await ensurePinnedWeights(slug, 'int8');
    const model = this.construct(slug, kind);
    try {
      await model.download({ onProgress: onProgress ?? progressLogger(slug, 'Download') });
    } finally {
      await model.destroy().catch(() => {});
    }
  }

  private construct(slug: string, kind: ModelKind): CactusLM | CactusSTT | CactusAudio {
    const quantization = quantizationFor(slug);
    const options = quantization ? { quantization } : undefined;
    if (kind === 'stt') return new CactusSTT({ model: slug, options });
    if (kind === 'audio') return new CactusAudio({ model: slug });
    return new CactusLM({ model: slug, options });
  }

  private async loadModel(
    slug: string,
    onProgress?: (progress: number) => void,
  ): Promise<ManagedModel> {
    const kind = kindOf(slug);
    const estimatedRam = estimateRamMb(slug);

    // Evict if needed
    await this.evictIfNeeded(estimatedRam);

    const managed = this.entry(slug);
    managed.state = 'loading';
    this.notify();

    try {
      // Cactus SDK classes handle registry lookup, download, and init. The model key (slug like
      // "lfm2-1.2b") maps directly to the registry key derived from weight filenames on
      // Cactus-Compute HuggingFace repos.
      console.log(`[ModelLifecycle] Loading "${slug}" (${kind})...`);
      await this.download(slug, onProgress ?? progressLogger(slug, 'Download'));
      const model = this.construct(slug, kind);
      await model.init();
      managed.instance = kind === 'lm' ? (model as CactusLM) : null;
      managed.stt = kind === 'stt' ? (model as CactusSTT) : null;
      managed.audio = kind === 'audio' ? (model as CactusAudio) : null;
      managed.nativeInstance = null;
      managed.isCustomModel = false;

      managed.state = 'ready';
      managed.lastUsed = Date.now();
      managed.ramMb = estimatedRam;
      managed.pins = 0;
      managed.uses = 0;
      managed.totalMs = 0;
      managed.tokensPerSecond = undefined;
      this.notify();
      console.log(`[ModelLifecycle] Loaded "${slug}" (~${estimatedRam}MB)`);
      return managed;
    } catch (error) {
      const errMsg = error instanceof Error ? error.message : String(error);
      console.error(`[ModelLifecycle] FAILED to load "${slug}": ${errMsg}`);
      managed.state = 'error';
      managed.instance = null;
      managed.stt = null;
      managed.audio = null;
      managed.nativeInstance = null;
      this.notify();
      throw error;
    }
  }

  private isEvictable(m: ManagedModel): boolean {
    return m.state === 'ready' && m.tier !== 'hot' && m.pins === 0;
  }

  private async evictIfNeeded(neededMb: number): Promise<void> {
    if (!this.profile) return;

    const currentUsage = this.getTotalLoadedRamMb();
    let freeSpace = this.profile.ramBudgetMb - currentUsage;

    if (freeSpace >= neededMb) return;

    // Loaded, non-hot, unpinned models, least recently used first
    const evictable = Array.from(this.models.values())
      .filter(m => this.isEvictable(m))
      .sort((a, b) => a.lastUsed - b.lastUsed);

    for (const model of evictable) {
      if (freeSpace >= neededMb) break;

      console.log(`[ModelLifecycle] Evicting "${model.slug}" (~${model.ramMb}MB)`);
      const freed = model.ramMb;
      await this.releaseOne(model);
      freeSpace += freed;
    }

    if (freeSpace < neededMb) {
      console.warn(
        `[ModelLifecycle] RAM budget tight: need ~${neededMb}MB but only ~${freeSpace}MB available after eviction. Attempting load anyway.`,
      );
    }
  }

  private async releaseOne(managed: ManagedModel): Promise<void> {
    for (const model of [managed.instance, managed.stt, managed.audio, managed.nativeInstance]) {
      try {
        if (model) await model.destroy();
      } catch {}
    }
    managed.instance = null;
    managed.stt = null;
    managed.audio = null;
    managed.nativeInstance = null;
    managed.state = 'unloaded';
    managed.ramMb = 0;
    managed.pins = 0;
    this.notify();
  }

  /** Unloads it (its owner is done with it), pinned or not. */
  async release(slug: string): Promise<void> {
    const managed = this.models.get(slug);
    if (managed && managed.state === 'ready') {
      await this.releaseOne(managed);
      console.log(`[ModelLifecycle] Released "${slug}"`);
    }
  }

  async releaseAll(): Promise<void> {
    const loaded = Array.from(this.models.values()).filter(m => m.state === 'ready');
    for (const model of loaded) {
      await this.releaseOne(model);
    }
    console.log('[ModelLifecycle] Released all models');
  }

  /** One call to a loaded model (e.g. a transcription), for the dashboard. */
  recordUse(slug: string, ms: number, tokensPerSecond?: number): void {
    const m = this.models.get(slug);
    if (m?.state === 'ready') this.recordOn(m, ms, tokensPerSecond);
  }

  /** One completion by a CactusLM instance loaded here. */
  recordCompletion(
    instance: unknown,
    r: { totalTimeMs?: number; tokensPerSecond?: number } | undefined,
  ): void {
    if (!instance || !r) return;
    const m = Array.from(this.models.values()).find(x => x.instance === instance);
    if (m) this.recordOn(m, r.totalTimeMs ?? 0, r.tokensPerSecond);
  }

  private recordOn(m: ManagedModel, ms: number, tokensPerSecond?: number): void {
    m.uses = (m.uses ?? 0) + 1;
    m.totalMs = (m.totalMs ?? 0) + Math.max(0, ms);
    if (tokensPerSecond && tokensPerSecond > 0) m.tokensPerSecond = tokensPerSecond;
    m.lastUsed = Date.now();
    this.notify();
  }

  getLoadedModels(): ManagedModel[] {
    return Array.from(this.models.values()).filter(m => m.state === 'ready');
  }

  getAllModels(): ManagedModel[] {
    return Array.from(this.models.values());
  }

  getTotalLoadedRamMb(): number {
    return this.getLoadedModels().reduce((sum, m) => sum + m.ramMb, 0);
  }

  /**
   * Whether `slug` can be loaded without going over the RAM budget, counting what could be evicted
   * (loaded, not hot, not pinned). Already loaded counts as yes. Without a device profile, yes.
   */
  fitsInBudget(slug: string): boolean {
    if (!this.profile) return true;
    if (this.models.get(slug)?.state === 'ready') return true;
    const evictable = this.getLoadedModels()
      .filter(m => this.isEvictable(m) && m.slug !== slug)
      .reduce((sum, m) => sum + m.ramMb, 0);
    return this.profile.ramBudgetMb - this.getTotalLoadedRamMb() + evictable >= estimateRamMb(slug);
  }

  getRamBudgetMb(): number {
    return this.profile?.ramBudgetMb ?? 0;
  }

  getDeviceProfile(): DeviceProfile | null {
    return this.profile;
  }

  getModelState(slug: string): ModelState {
    return this.models.get(slug)?.state ?? 'unloaded';
  }

  subscribe(listener: Listener): () => void {
    this.listeners.add(listener);
    return () => {
      this.listeners.delete(listener);
    };
  }

  private notify(): void {
    for (const listener of this.listeners) {
      try {
        listener();
      } catch {}
    }
  }
}

export const modelLifecycle = new ModelLifecycleManager();
