import { CactusFileSystem } from 'cactus-react-native/src/native';
import { getRegistry } from 'cactus-react-native/src/modelRegistry';

/**
 * Ensures a Cactus registry model's weights are present on device, working
 * around an SDK bug where download URLs are pinned to the `v1.7` git revision.
 *
 * Newer Cactus-Compute repos (e.g. Cactus-Compute/LFM2.5-350M) are only tagged
 * on `main`, so the stock `CactusLM.download()` 404s on `/resolve/v1.7/...`.
 * For those we download the weights zip from `main` into the exact model-name
 * key (`<slug>-<quant>`) that `CactusLM.init()` looks up, so the normal flow
 * then finds the model already present and skips the broken URL.
 *
 * Returns true if the weights are now present (pre-fetched or already existed),
 * false if the SDK should handle the download normally (pinned URL works, or
 * registry/URL could not be resolved).
 */
export async function ensureRegistryModel(
  slug: string,
  onProgress?: (progress: number) => void,
  quant: 'int4' | 'int8' = 'int8',
): Promise<boolean> {
  const modelName = `${slug}-${quant}`;

  try {
    if (await CactusFileSystem.modelExists(modelName)) {
      onProgress?.(1);
      return true;
    }
  } catch {
    // modelExists failed — fall through and let the SDK try
  }

  let pinnedUrl: string | undefined;
  try {
    const registry = await getRegistry();
    pinnedUrl = registry[slug]?.quantization?.[quant]?.url;
  } catch {
    return false; // offline / registry unavailable — let the SDK try
  }
  if (!pinnedUrl) return false;

  // Only the v1.7-pinned URLs are affected; nothing to work around otherwise.
  if (!pinnedUrl.includes('/resolve/v1.7/')) return false;

  // If the pinned revision actually resolves, let the SDK download normally.
  try {
    const pinnedRes = await fetch(pinnedUrl, { method: 'HEAD' });
    if (pinnedRes.ok) return false;
  } catch {
    return false; // network error probing — let the SDK try
  }

  // Pinned revision is missing — fall back to `main`.
  const mainUrl = pinnedUrl.replace('/resolve/v1.7/', '/resolve/main/');
  try {
    const mainRes = await fetch(mainUrl, { method: 'HEAD' });
    if (!mainRes.ok) return false;
  } catch {
    return false;
  }

  console.log(
    `[cactusModelFetch] "${slug}" missing at v1.7; downloading from main: ${mainUrl}`,
  );
  await CactusFileSystem.downloadModel(modelName, mainUrl, onProgress);
  return true;
}
