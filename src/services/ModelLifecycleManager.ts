import { CactusLM } from 'cactus-react-native';
import { Cactus } from 'cactus-react-native/src/native';
import * as RNFS from '@dr.pogodin/react-native-fs';
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

  private async downloadFromHF(slug: string, hfRepo: string, destDir: string): Promise<void> {
    const apiUrl = `https://huggingface.co/api/models/${hfRepo}`;
    const apiResponse = await fetch(apiUrl);
    if (!apiResponse.ok) {
      throw new Error(`Failed to fetch model info from HuggingFace (HTTP ${apiResponse.status})`);
    }
    const repoInfo = await apiResponse.json();
    const filesToDownload: string[] = (repoInfo.siblings || [])
      .map((s: { rfilename: string }) => s.rfilename)
      .filter((name: string) => !name.startsWith('.'));

    if (filesToDownload.length === 0) {
      throw new Error(`No files found in HuggingFace repo: ${hfRepo}`);
    }

    if (!(await RNFS.exists(destDir))) {
      await RNFS.mkdir(destDir);
    }

    for (const fileName of filesToDownload) {
      const parts = fileName.split('/');
      if (parts.length > 1) {
        const subDir = `${destDir}/${parts.slice(0, -1).join('/')}`;
        if (!(await RNFS.exists(subDir))) {
          await RNFS.mkdir(subDir);
        }
      }
      const fileUrl = `https://huggingface.co/${hfRepo}/resolve/main/${fileName}`;
      const destPath = `${destDir}/${fileName}`;
      const result = RNFS.downloadFile({ fromUrl: fileUrl, toFile: destPath });
      const response = await result.promise;
      if (response.statusCode !== 200) {
        throw new Error(`Failed to download ${fileName} (HTTP ${response.statusCode})`);
      }
    }
    console.log(`[ModelLifecycle] Downloaded "${slug}" from HuggingFace (${hfRepo})`);
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
      // Loading strategy: custom/HF models go straight to local/HF path;
      // registry models try CactusLM first, then fall through to local/HF.
      let loaded = false;

      // Step 1: Try CactusLM registry (skip for custom models)
      if (!modelDef?.isCustom) {
        let modelInfo: any = null;
        try {
          console.log(`[ModelLifecycle] Step 1: Checking registry for "${slug}"...`);
          const tempCactusLM = new CactusLM();
          const registryModels = await tempCactusLM.getModels();
          modelInfo = registryModels.find((m: any) => m.slug === slug) || null;
          console.log(`[ModelLifecycle] Registry lookup: "${slug}" ${modelInfo ? 'FOUND' : 'NOT FOUND'} (${registryModels.length} models available)`);
          await tempCactusLM.destroy();
        } catch (regErr) {
          console.log(`[ModelLifecycle] Registry unavailable: ${regErr}`);
        }

        if (modelInfo) {
          try {
            console.log(`[ModelLifecycle] Step 1a: Loading registry model "${slug}"...`);
            const cactusLM = new CactusLM({ model: slug });
            await cactusLM.download({ onProgress: () => {} });
            console.log(`[ModelLifecycle] Download complete for "${slug}", calling init()...`);

            try {
              await cactusLM.init();
              managed.instance = cactusLM;
              managed.nativeInstance = null;
              managed.isCustomModel = false;
              loaded = true;
              console.log(`[ModelLifecycle] CactusLM init succeeded for "${slug}"`);
            } catch (initErr) {
              console.log(`[ModelLifecycle] CactusLM init failed for "${slug}": ${initErr}`);
              console.log(`[ModelLifecycle] Falling back to native Cactus...`);
              const { CactusFileSystem } = require('cactus-react-native/src/native');
              const modelPath = await CactusFileSystem.getModelPath(slug);
              console.log(`[ModelLifecycle] Native model path: ${modelPath}`);
              const nativeCactus = new Cactus();
              await nativeCactus.init(modelPath, 2048);
              managed.instance = null;
              managed.nativeInstance = nativeCactus;
              managed.isCustomModel = true;
              loaded = true;
              console.log(`[ModelLifecycle] Native Cactus fallback succeeded for "${slug}"`);
            }
          } catch (registryErr) {
            console.log(`[ModelLifecycle] Registry path failed for "${slug}": ${registryErr}`);
            console.log(`[ModelLifecycle] Falling through to local/HF path...`);
          }
        }
      } else {
        console.log(`[ModelLifecycle] Skipping registry for custom model "${slug}"`);
      }

      // Step 2: Local files + HF download (used for custom models and as fallback)
      if (!loaded) {
        console.log(`[ModelLifecycle] Step 2: Checking local files for "${slug}"...`);
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
        console.log(`[ModelLifecycle] Local entries found: ${files.map((f: any) => f.name).join(', ') || '(none)'}`);

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

        if (!modelPath && modelDef?.hfRepo) {
          // Auto-download from HuggingFace
          const modelDir = `${RNFS.DocumentDirectoryPath}/models/${slug}`;
          console.log(`[ModelLifecycle] Downloading "${slug}" from HuggingFace (${modelDef.hfRepo})...`);
          await this.downloadFromHF(slug, modelDef.hfRepo, modelDir);
          modelPath = modelDir;
        }

        if (!modelPath) {
          throw new Error(`No model files found for "${slug}"`);
        }

        console.log(`[ModelLifecycle] Loading native model from: ${modelPath}`);
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
