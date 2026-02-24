import type { LiquidModel, ModelTier } from '../types';
import { getModelTier as _getModelTier } from './modelTiers';

export const LIQUID_MODELS: LiquidModel[] = [
  // === Liquid AI Models (in CactusLM registry) ===
  {
    name: 'LFM2-350M',
    slug: 'lfm2-350m',
    category: 'text',
    sizeMb: 200,
    description: 'Lightweight model for fast inference.',
    supportsCompletion: true,
    supportsToolCalling: false,
    supportsVision: false,
    supportsAudio: false,
  },
  {
    name: 'LFM2-700M',
    slug: 'lfm2-700m',
    category: 'text',
    sizeMb: 400,
    description: 'Medium model balancing speed and quality.',
    supportsCompletion: true,
    supportsToolCalling: false,
    supportsVision: false,
    supportsAudio: false,
  },
  {
    name: 'LFM2-1.2B',
    slug: 'lfm2-1.2b',
    category: 'text',
    sizeMb: 600,
    description: 'Standard Liquid AI model for everyday use.',
    supportsCompletion: true,
    supportsToolCalling: false,
    supportsVision: false,
    supportsAudio: false,
  },
  // NOTE: LFM2-1.2B-RAG removed — its HF weights ("lfm2-1.2b-rag.zip")
  // lack the int4/int8 pair required by the CactusLM registry.
  // RAG functionality uses the base lfm2-1.2b model with corpus init.
  // === Vision Models ===
  {
    name: 'LFM2-VL-450M',
    slug: 'lfm2-vl-450m',
    category: 'vision',
    sizeMb: 300,
    description: 'Compact vision-language model.',
    supportsCompletion: true,
    supportsToolCalling: false,
    supportsVision: true,
    supportsAudio: false,
  },
  {
    name: 'LFM2.5-VL-1.6B',
    slug: 'lfm2.5-vl-1.6b',
    category: 'vision',
    sizeMb: 900,
    description: 'Standard vision-language model.',
    supportsCompletion: true,
    supportsToolCalling: false,
    supportsVision: true,
    supportsAudio: false,
  },
  // === Audio Models (Whisper STT) ===
  {
    name: 'Whisper Small',
    slug: 'whisper-small',
    category: 'audio',
    sizeMb: 192,
    description: 'Fast on-device speech-to-text transcription.',
    supportsCompletion: false,
    supportsToolCalling: false,
    supportsVision: false,
    supportsAudio: true,
    isSTT: true,
    hfRepo: 'cactus-compute/whisper-small',
  },
  {
    name: 'Whisper Medium',
    slug: 'whisper-medium',
    category: 'audio',
    sizeMb: 615,
    description: 'Higher accuracy speech-to-text transcription.',
    supportsCompletion: false,
    supportsToolCalling: false,
    supportsVision: false,
    supportsAudio: true,
    isSTT: true,
    hfRepo: 'cactus-compute/whisper-medium',
  },
  // === Embedding Models ===
  {
    name: 'Qwen3-Embedding-0.6B',
    slug: 'qwen3-embedding-0.6b',
    category: 'embedding',
    sizeMb: 394,
    description: 'Text embedding model for semantic memory and RAG.',
    supportsCompletion: false,
    supportsToolCalling: false,
    supportsVision: false,
    supportsAudio: false,
  },
  // === Thinking Model ===
  {
    name: 'LFM2.5-1.2B-Thinking',
    slug: 'lfm2.5-1.2b-thinking',
    category: 'specialized',
    sizeMb: 750,
    description: 'Optimized for step-by-step reasoning and planning.',
    supportsCompletion: true,
    supportsToolCalling: false,
    supportsVision: false,
    supportsAudio: false,
    supportsThinking: true,
  },
  // NOTE: lfm25-mobile-actions removed — requires CACT-format weights
  // incompatible with stock cactus-react-native 1.7.0.
];

export function getModelsByCategory(category: string): LiquidModel[] {
  return LIQUID_MODELS.filter(m => m.category === category);
}

export function getModelBySlug(slug: string): LiquidModel | undefined {
  return LIQUID_MODELS.find(m => m.slug === slug);
}

export function getModelsByTier(tier: ModelTier): LiquidModel[] {
  return LIQUID_MODELS.filter(m => _getModelTier(m.slug) === tier);
}

export { _getModelTier as getModelTier };
