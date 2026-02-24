import { CactusLM } from 'cactus-react-native';
import DeviceInfo from 'react-native-device-info';
import { LIQUID_MODELS, getModelBySlug } from '../config/models';
import { getDeviceProfile, getModelTier, type DeviceProfile } from '../config/modelTiers';
import type { ModelTier, ModelState } from '../types';

const RAM_MULTIPLIER = 1.3;

export interface ManagedModel {
  slug: string;
  tier: ModelTier;
  state: ModelState;
  instance: CactusLM | null;
  nativeInstance: any;
  isCustomModel: boolean;
  lastUsed: number;
  ramMb: number;
}

type Listener = () => void;

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
    console.log(`[ModelLifecycle] Device profile: ${this.profile.name} (budget: ${this.profile.ramBudgetMb}MB)`);

    // Register all catalog models
    for (const model of LIQUID_MODELS) {
      this.models.set(model.slug, {
        slug: model.slug,
        tier: getModelTier(model.slug),
        state: 'unloaded',
        instance: null,
        nativeInstance: null,
        isCustomModel: model.isCustom ?? false,
        lastUsed: 0,
        ramMb: 0,
      });
    }

    this._initialized = true;
    this.notify();
  }

  async ensure(slug: string): Promise<ManagedModel> {
    if (!this._initialized) await this.init();

    const existing = this.models.get(slug);
    if (existing && existing.state === 'ready') {
      existing.lastUsed = Date.now();
      this.notify();
      return existing;
    }

    // Per-slug dedup: if already loading this exact slug, wait for it
    const activeLock = this.loadingLocks.get(slug);
    if (activeLock) return activeLock;

    // Serialize ALL model loads through global queue —
    // native Cactus crashes when two init() calls run concurrently
    const loadPromise = this._globalLoadQueue.then(
      () => this.loadModel(slug),
      () => this.loadModel(slug), // proceed even if previous load failed
    );
    this._globalLoadQueue = loadPromise.catch(() => {}); // keep queue moving
    this.loadingLocks.set(slug, loadPromise);

    try {
      const result = await loadPromise;
      return result;
    } finally {
      this.loadingLocks.delete(slug);
    }
  }

  private async loadModel(slug: string): Promise<ManagedModel> {
    const modelDef = getModelBySlug(slug);
    const estimatedRam = modelDef ? Math.round(modelDef.sizeMb * RAM_MULTIPLIER) : 500;

    // STT models (Whisper) are managed by CactusSTT, not here
    if (modelDef?.isSTT) {
      throw new Error(`"${slug}" is an STT model and cannot be loaded as a chat model.`);
    }

    // Evict if needed
    await this.evictIfNeeded(estimatedRam);

    let managed = this.models.get(slug);
    if (!managed) {
      managed = {
        slug,
        tier: getModelTier(slug),
        state: 'unloaded',
        instance: null,
        nativeInstance: null,
        isCustomModel: modelDef?.isCustom ?? false,
        lastUsed: 0,
        ramMb: 0,
      };
      this.models.set(slug, managed);
    }

    managed.state = 'loading';
    this.notify();

    try {
      // Use CactusLM high-level SDK: handles registry lookup, download, and init.
      // The model key (slug like "lfm2-1.2b") maps directly to the registry key
      // derived from weight filenames on Cactus-Compute HuggingFace repos.
      console.log(`[ModelLifecycle] Loading "${slug}" via CactusLM SDK...`);
      const cactusLM = new CactusLM({ model: slug });

      // Download if not already cached
      await cactusLM.download({
        onProgress: (progress: number) => {
          if (progress % 0.25 < 0.01) {
            console.log(`[ModelLifecycle] Download "${slug}": ${Math.round(progress * 100)}%`);
          }
        },
      });
      console.log(`[ModelLifecycle] Download complete for "${slug}", initializing...`);

      await cactusLM.init();
      managed.instance = cactusLM;
      managed.nativeInstance = null;
      managed.isCustomModel = false;
      console.log(`[ModelLifecycle] CactusLM init succeeded for "${slug}"`);

      managed.state = 'ready';
      managed.lastUsed = Date.now();
      managed.ramMb = estimatedRam;
      this.notify();
      console.log(`[ModelLifecycle] Loaded "${slug}" (~${estimatedRam}MB)`);
      return managed;
    } catch (error) {
      const errMsg = error instanceof Error ? error.message : String(error);
      console.error(`[ModelLifecycle] FAILED to load "${slug}": ${errMsg}`);
      managed.state = 'error';
      managed.instance = null;
      managed.nativeInstance = null;
      this.notify();
      throw error;
    }
  }

  private async evictIfNeeded(neededMb: number): Promise<void> {
    if (!this.profile) return;

    const currentUsage = this.getTotalLoadedRamMb();
    let freeSpace = this.profile.ramBudgetMb - currentUsage;

    if (freeSpace >= neededMb) return;

    // Get loaded non-hot models sorted by lastUsed (LRU first)
    const evictable = Array.from(this.models.values())
      .filter(m => m.state === 'ready' && m.tier !== 'hot')
      .sort((a, b) => a.lastUsed - b.lastUsed);

    for (const model of evictable) {
      if (freeSpace >= neededMb) break;

      console.log(`[ModelLifecycle] Evicting "${model.slug}" (~${model.ramMb}MB)`);
      await this.releaseOne(model);
      freeSpace += model.ramMb;
    }

    if (freeSpace < neededMb) {
      console.warn(
        `[ModelLifecycle] RAM budget tight: need ~${neededMb}MB but only ~${freeSpace}MB available after eviction. Attempting load anyway.`,
      );
    }
  }

  private async releaseOne(managed: ManagedModel): Promise<void> {
    try {
      if (managed.instance) {
        await managed.instance.destroy();
      }
      if (managed.nativeInstance) {
        await managed.nativeInstance.destroy();
      }
    } catch {}
    managed.instance = null;
    managed.nativeInstance = null;
    managed.state = 'unloaded';
    managed.ramMb = 0;
    this.notify();
  }

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

  getLoadedModels(): ManagedModel[] {
    return Array.from(this.models.values()).filter(m => m.state === 'ready');
  }

  getAllModels(): ManagedModel[] {
    return Array.from(this.models.values());
  }

  getTotalLoadedRamMb(): number {
    return this.getLoadedModels().reduce((sum, m) => sum + m.ramMb, 0);
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
