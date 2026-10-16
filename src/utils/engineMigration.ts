import * as RNFS from '@dr.pogodin/react-native-fs';
import AsyncStorage from '@react-native-async-storage/async-storage';
import { Alert } from 'react-native';

/**
 * cactus-react-native stores weights at <filesDir>/cactus/models/<slug>-<quant>
 * and skips download() when that folder exists. Weights fetched by SDK 1.7
 * (HF tag v1.7) therefore survive the upgrade to 1.13 even though newer
 * weight tags exist for the 1.13 engine. Offer a one-time cleanup.
 */

export const CACTUS_MODELS_DIR = `${RNFS.DocumentDirectoryPath}/cactus/models`;
const ENGINE_KEY = '@liquid_cactus_engine';
const ENGINE = '1.13';

export async function listDownloadedCactusModels(): Promise<
  { name: string; slug: string; quant: string; path: string }[]
> {
  try {
    if (!(await RNFS.exists(CACTUS_MODELS_DIR))) return [];
    const entries = await RNFS.readDir(CACTUS_MODELS_DIR);
    return entries
      .filter(e => e.isDirectory())
      .map(e => {
        const m = e.name.match(/^(.*)-(int4|int8)(-pro)?$/);
        return { name: e.name, slug: m ? m[1] : e.name, quant: m ? m[2] : '', path: e.path };
      });
  } catch {
    return [];
  }
}

export async function checkEngineMigration(): Promise<void> {
  try {
    const seen = await AsyncStorage.getItem(ENGINE_KEY);
    if (seen === ENGINE) return;
    const models = await listDownloadedCactusModels();
    await AsyncStorage.setItem(ENGINE_KEY, ENGINE);
    if (models.length === 0) return;
    Alert.alert(
      'Inference engine updated',
      `LiquidChat now uses Cactus ${ENGINE}. ${models.length} model(s) were downloaded for the previous engine. ` +
        'Re-downloading gives you the newer, smaller weights and avoids compatibility issues.',
      [
        { text: 'Keep for now', style: 'cancel' },
        {
          text: 'Re-download on demand',
          style: 'destructive',
          onPress: async () => {
            for (const m of models) {
              try {
                await RNFS.unlink(m.path);
              } catch {}
            }
          },
        },
      ],
    );
  } catch {}
}
