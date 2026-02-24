import type { ModelTier } from '../types';

export interface DeviceProfile {
  name: string;
  totalRamGb: number;
  ramBudgetMb: number;
  hotModels: string[];
  maxConcurrentModels: number;
}

const MODEL_TIER_CONFIG: Record<string, ModelTier> = {
  // Hot: always prioritized, never auto-evicted
  'lfm25-mobile-actions': 'hot',
  'lfm2-350m': 'hot',
  // Warm: kept loaded when budget allows
  'whisper-small': 'warm',
  'qwen3-embedding-0.6b': 'warm',
  'lfm2-vl-450m': 'warm',
  'lfm2-1.2b': 'warm',
  'lfm2-1.2b-rag': 'warm',
  // Cold: loaded on demand, first to evict
  'lfm2-700m': 'cold',
  'lfm2-vl-1.6b': 'cold',
  'whisper-medium': 'cold',
  'lfm25-1.2b-thinking': 'cold',
};

const DEVICE_PROFILES: DeviceProfile[] = [
  {
    name: 'low',
    totalRamGb: 4,
    ramBudgetMb: 800,
    hotModels: ['lfm2-350m'],
    maxConcurrentModels: 2,
  },
  {
    name: 'mid',
    totalRamGb: 6,
    ramBudgetMb: 1500,
    hotModels: ['lfm25-mobile-actions', 'lfm2-350m'],
    maxConcurrentModels: 3,
  },
  {
    name: 'high',
    totalRamGb: 8,
    ramBudgetMb: 2500,
    hotModels: ['lfm25-mobile-actions', 'lfm2-350m'],
    maxConcurrentModels: 4,
  },
  {
    name: 'flagship',
    totalRamGb: 12,
    ramBudgetMb: 4000,
    hotModels: ['lfm25-mobile-actions', 'lfm2-350m'],
    maxConcurrentModels: 5,
  },
];

export function getDeviceProfile(totalRamBytes: number): DeviceProfile {
  const totalRamGb = totalRamBytes / (1024 * 1024 * 1024);
  let matched = DEVICE_PROFILES[0];
  for (const profile of DEVICE_PROFILES) {
    if (totalRamGb >= profile.totalRamGb) {
      matched = profile;
    }
  }
  return matched;
}

export function getModelTier(slug: string): ModelTier {
  return MODEL_TIER_CONFIG[slug] ?? 'cold';
}
