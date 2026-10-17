/** Test double: the Cactus file system hybrid object over the RNFS mock's temp dir. */
import * as RNFS from '@dr.pogodin/react-native-fs';

const modelsDir = `${RNFS.DocumentDirectoryPath}/cactus/models`;

export const downloads: { model: string; url: string }[] = [];

const cactusFileSystem = {
  async modelExists(model: string) {
    return RNFS.exists(`${modelsDir}/${model}`);
  },
  async getModelPath(model: string) {
    return `${modelsDir}/${model}`;
  },
  async deleteModel(model: string) {
    await RNFS.unlink(`${modelsDir}/${model}`);
  },
  async downloadModel(model: string, url: string, onProgress?: (p: number) => void) {
    downloads.push({ model, url });
    await RNFS.mkdir(`${modelsDir}/${model}`);
    onProgress?.(1);
  },
};

export const NitroModules = {
  createHybridObject: (name: string) => {
    if (name === 'CactusFileSystem') return cactusFileSystem;
    throw new Error(`No mock for hybrid object ${name}`);
  },
};
