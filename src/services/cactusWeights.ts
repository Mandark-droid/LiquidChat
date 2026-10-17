import * as RNFS from '@dr.pogodin/react-native-fs';
import { NitroModules } from 'react-native-nitro-modules';

/**
 * cactus-react-native 1.13.1 resolves weights to the newest tag <= its runtime version,
 * which is v1.12 for most audio models. The 1.13.1 engine expects the v1.14 layout:
 * Whisper v1.12 weights decode to garbage / loops and fail language detection, and
 * WeSpeaker v1.12 lacks tensors the engine loads (init fails). Pin those to v1.14.
 */
const PINNED: Record<string, { repo: string; tag: string }> = {
  'whisper-tiny': { repo: 'whisper-tiny', tag: 'v1.14' },
  'whisper-base': { repo: 'whisper-base', tag: 'v1.14' },
  'whisper-small': { repo: 'whisper-small', tag: 'v1.14' },
  'whisper-medium': { repo: 'whisper-medium', tag: 'v1.14' },
  'moonshine-base': { repo: 'moonshine-base', tag: 'v1.14' },
  'wespeaker-voxceleb-resnet34-lm': { repo: 'wespeaker-voxceleb-resnet34-LM', tag: 'v1.14' },
  // Text / vision / embedding models that publish v1.14 (checked against the Hub, Oct 2026).
  // v2.x tags target the Cactus 2 engine and are deliberately not used.
  'lfm2.5-350m': { repo: 'LFM2.5-350M', tag: 'v1.14' },
  'lfm2.5-1.2b-instruct': { repo: 'LFM2.5-1.2B-Instruct', tag: 'v1.14' },
  'lfm2.5-1.2b-thinking': { repo: 'LFM2.5-1.2B-Thinking', tag: 'v1.14' },
  'lfm2-700m': { repo: 'LFM2-700M', tag: 'v1.14' },
  'lfm2-2.6b': { repo: 'LFM2-2.6B', tag: 'v1.14' },
  'lfm2.5-vl-1.6b': { repo: 'LFM2.5-VL-1.6B', tag: 'v1.14' },
  'qwen3-embedding-0.6b': { repo: 'Qwen3-Embedding-0.6B', tag: 'v1.14' },
  'qwen3.5-2b': { repo: 'Qwen3.5-2B', tag: 'v1.14' },
};

const MARKER = '.liquidchat-weights';

interface CactusFsSpec {
  downloadModel(model: string, url: string, onProgress?: (p: number) => void): Promise<void>;
  deleteModel(model: string): Promise<void>;
  modelExists(model: string): Promise<boolean>;
  getModelPath(model: string): Promise<string>;
}

let fs: CactusFsSpec | null = null;
const cactusFs = (): CactusFsSpec =>
  (fs ??= NitroModules.createHybridObject<CactusFsSpec & never>('CactusFileSystem'));

export function pinnedWeightsUrl(slug: string, quant: 'int4' | 'int8'): string | null {
  const pin = PINNED[slug];
  return pin
    ? `https://huggingface.co/Cactus-Compute/${pin.repo}/resolve/${pin.tag}/weights/${slug}-${quant}.zip`
    : null;
}

const inflight = new Map<string, Promise<void>>();

/**
 * Makes sure `<slug>-<quant>` holds the pinned weights, replacing an unpinned copy once.
 * No-op for models without a pin, so callers can use it for every model.
 */
export function ensurePinnedWeights(
  slug: string,
  quant: 'int4' | 'int8' = 'int8',
  onProgress?: (p: number) => void,
): Promise<void> {
  const url = pinnedWeightsUrl(slug, quant);
  if (!url) return Promise.resolve();
  const name = `${slug}-${quant}`;
  const running = inflight.get(name);
  if (running) return running;
  const job = (async () => {
    const want = PINNED[slug].tag;
    const files = cactusFs();
    if (await files.modelExists(name)) {
      const marker = `${await files.getModelPath(name)}/${MARKER}`;
      const have = (await RNFS.exists(marker)) ? (await RNFS.readFile(marker, 'utf8')).trim() : '';
      if (have === want) return;
      console.log(`[Weights] Replacing ${name} (${have || 'unpinned'}) with ${want}`);
      await files.deleteModel(name);
    }
    await files.downloadModel(name, url, onProgress);
    await RNFS.writeFile(`${await files.getModelPath(name)}/${MARKER}`, want, 'utf8');
  })().finally(() => inflight.delete(name));
  inflight.set(name, job);
  return job;
}
