import { NativeModules, Platform } from 'react-native';
import { CactusLM } from 'cactus-react-native';
import { Cactus } from 'cactus-react-native/src/native';
import * as RNFS from '@dr.pogodin/react-native-fs';
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

  get initialized(): boolean {
    return this._initialized;
  }

  async init(): Promise<void> {
    if (this._initialized) return;

    // Get total RAM from device
    let totalRamBytes = 4 * 1024 * 1024 * 1024; // 4GB default
    try {
      if (Platform.OS === 'android' && NativeModules.DeviceInfoModule) {
        totalRamBytes = await NativeModules.DeviceInfoModule.getTotalMemory();
      }
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

    // Per-slug loading lock to prevent races
    const activeLock = this.loadingLocks.get(slug);
    if (activeLock) return activeLock;

    const loadPromise = this.loadModel(slug);
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
      // 3-stage fallback: registry -> local files -> native Cactus
      // (mirrors ChatScreen's initializeModel logic)

      // Step 1: Check CactusLM registry
      let modelInfo: any = null;
      try {
        const tempCactusLM = new CactusLM();
        const registryModels = await tempCactusLM.getModels();
        modelInfo = registryModels.find((m: any) => m.slug === slug) || null;
        await tempCactusLM.destroy();
      } catch {
        // Registry unavailable
      }

      if (modelInfo) {
        // Registry model
        const cactusLM = new CactusLM({ model: slug });
        await cactusLM.download({ onProgress: () => {} });

        try {
          await cactusLM.init();
          managed.instance = cactusLM;
          managed.nativeInstance = null;
          managed.isCustomModel = false;
        } catch {
          // CactusLM init failed, fall back to native
          const { CactusFileSystem } = require('cactus-react-native/src/native');
          const modelPath = await CactusFileSystem.getModelPath(slug);
          const nativeCactus = new Cactus();
          await nativeCactus.init(modelPath, 2048);
          managed.instance = null;
          managed.nativeInstance = nativeCactus;
          managed.isCustomModel = true;
        }
      } else {
        // Step 2: Local files
        const userModelsDir = `${RNFS.DocumentDirectoryPath}/models`;
        const cactusModelsDir = `${RNFS.DocumentDirectoryPath}/cactus/models`;

        let files: any[] = [];
        try {
          if (await RNFS.exists(userModelsDir)) {
            files = [...(await RNFS.readDir(userModelsDir))];
          }
        } catch {}
        try {
          if (await RNFS.exists(cactusModelsDir)) {
            files = [...files, ...(await RNFS.readDir(cactusModelsDir))];
          }
        } catch {}

        // Cactus weight folders
        const cactusWeightDirs: any[] = [];
        for (const f of files) {
          if (f.isDirectory()) {
            const hasConfig = await RNFS.exists(`${f.path}/config.txt`);
            if (hasConfig) cactusWeightDirs.push(f);
          }
        }

        const ggufFiles = files.filter((f: any) => f.name.endsWith('.gguf'));

        let modelPath: string | null = null;

        // Try matching weight folders
        let matchedDir = cactusWeightDirs.find((f: any) => f.name === slug);
        if (!matchedDir) {
          matchedDir = cactusWeightDirs.find((f: any) =>
            f.name.toLowerCase().includes(slug.toLowerCase()),
          );
        }

        if (matchedDir) {
          modelPath = matchedDir.path;
        } else if (cactusWeightDirs.length > 0 && !ggufFiles.length) {
          modelPath = cactusWeightDirs[0].path;
        } else {
          // Try GGUF files
          let matchedFile = ggufFiles.find((f: any) => f.name === `${slug}.gguf`);
          if (!matchedFile) {
            matchedFile = ggufFiles.find((f: any) =>
              f.name.toLowerCase().includes(slug.toLowerCase()),
            );
          }
          if (matchedFile) {
            modelPath = matchedFile.path;
          }
        }

        if (!modelPath) {
          throw new Error(`No model files found for "${slug}"`);
        }

        const nativeCactus = new Cactus();
        await nativeCactus.init(modelPath, 2048);
        managed.instance = null;
        managed.nativeInstance = nativeCactus;
        managed.isCustomModel = true;
      }

      managed.state = 'ready';
      managed.lastUsed = Date.now();
      managed.ramMb = estimatedRam;
      this.notify();
      console.log(`[ModelLifecycle] Loaded "${slug}" (~${estimatedRam}MB)`);
      return managed;
    } catch (error) {
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
