import type { LiquidModel, ModelTier } from '../types';
import { getModelTier as _getModelTier } from './modelTiers';

/**
 * Catalog for cactus-react-native 1.13.x.
 *
 * Slugs resolve through the SDK's runtime registry (Cactus-Compute HF org,
 * newest weight tag <= 1.13.1, repo must ship both int4 + int8 zips).
 * sizeMb is the download size for the quantization we request (int8 unless
 * `quantization` says otherwise). Verified against the HF weight trees,
 * October 2026.
 *
 * Not loadable by the npm SDK yet (tracked in ROADMAP): Cactus Needle 2/3
 * (.cact tool-calling/extraction), Cactus Whistle STT (.cact),
 * LFM2-2.6B-Transcript, LFM2.5-VL-450M (v1.14 tag only).
 */
export const LIQUID_MODELS: LiquidModel[] = [
  // === Text (Liquid AI) ===
  {
    name: 'LFM2.5-350M',
    slug: 'lfm2.5-350m',
    category: 'text',
    sizeMb: 339,
    description: 'Fast small model for chat, routing and quick replies.',
    supportsCompletion: true,
    supportsToolCalling: true,
    supportsVision: false,
    supportsAudio: false,
  },
  {
    name: 'LFM2.5-1.2B Instruct',
    slug: 'lfm2.5-1.2b-instruct',
    category: 'text',
    sizeMb: 1119,
    description: 'Default assistant. Better tool calling than LFM2-1.2B and smaller.',
    supportsCompletion: true,
    supportsToolCalling: true,
    supportsVision: false,
    supportsAudio: false,
  },
  {
    name: 'LFM2-700M',
    slug: 'lfm2-700m',
    category: 'text',
    sizeMb: 709,
    description: 'Mid-size model balancing speed and quality.',
    supportsCompletion: true,
    supportsToolCalling: true,
    supportsVision: false,
    supportsAudio: false,
  },
  {
    name: 'LFM2-2.6B',
    slug: 'lfm2-2.6b',
    category: 'text',
    sizeMb: 1261,
    quantization: 'int4',
    minRamGb: 8,
    description: 'Highest-quality Liquid model that fits phones. Best for meeting minutes and email drafts.',
    supportsCompletion: true,
    supportsToolCalling: true,
    supportsVision: false,
    supportsAudio: false,
  },
  {
    name: 'LFM2-8B-A1B (MoE)',
    slug: 'lfm2-8b-a1b',
    category: 'text',
    sizeMb: 3973,
    quantization: 'int4',
    minRamGb: 12,
    description: '8B mixture-of-experts, ~1B active. Flagship phones only.',
    supportsCompletion: true,
    supportsToolCalling: true,
    supportsVision: false,
    supportsAudio: false,
  },
  {
    name: 'Qwen3.5-2B',
    slug: 'qwen3.5-2b',
    category: 'text',
    sizeMb: 2076,
    minRamGb: 8,
    description: 'Strong small multilingual model with vision and tools.',
    supportsCompletion: true,
    supportsToolCalling: true,
    supportsVision: true,
    supportsAudio: false,
  },
  // Legacy entries: still resolvable, kept so existing chats/settings keep working.
  {
    name: 'LFM2-1.2B (legacy)',
    slug: 'lfm2-1.2b',
    category: 'text',
    sizeMb: 1243,
    legacy: true,
    description: 'Superseded by LFM2.5-1.2B Instruct.',
    supportsCompletion: true,
    supportsToolCalling: true,
    supportsVision: false,
    supportsAudio: false,
  },
  {
    name: 'LFM2-350M (legacy)',
    slug: 'lfm2-350m',
    category: 'text',
    sizeMb: 339,
    legacy: true,
    description: 'Superseded by LFM2.5-350M.',
    supportsCompletion: true,
    supportsToolCalling: false,
    supportsVision: false,
    supportsAudio: false,
  },
  // === Vision ===
  {
    name: 'LFM2-VL-450M',
    slug: 'lfm2-vl-450m',
    category: 'vision',
    sizeMb: 476,
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
    sizeMb: 1225,
    quantization: 'int4',
    description: 'Standard vision-language model (screens, documents, photos).',
    supportsCompletion: true,
    supportsToolCalling: false,
    supportsVision: true,
    supportsAudio: false,
  },
  // === Speech-to-text ===
  {
    name: 'Whisper Small',
    slug: 'whisper-small',
    category: 'audio',
    sizeMb: 268,
    description: 'Default STT. 99 languages incl. Hindi; supports translate-to-English.',
    supportsCompletion: false,
    supportsToolCalling: false,
    supportsVision: false,
    supportsAudio: true,
    isSTT: true,
    hfRepo: 'Cactus-Compute/whisper-small',
  },
  {
    name: 'Whisper Base',
    slug: 'whisper-base',
    category: 'audio',
    sizeMb: 94,
    description: 'Lightweight multilingual STT for low-RAM phones.',
    supportsCompletion: false,
    supportsToolCalling: false,
    supportsVision: false,
    supportsAudio: true,
    isSTT: true,
    hfRepo: 'Cactus-Compute/whisper-base',
  },
  {
    name: 'Whisper Medium',
    slug: 'whisper-medium',
    category: 'audio',
    sizeMb: 435,
    quantization: 'int4',
    description: 'Higher-accuracy multilingual STT (slower).',
    supportsCompletion: false,
    supportsToolCalling: false,
    supportsVision: false,
    supportsAudio: true,
    isSTT: true,
    hfRepo: 'Cactus-Compute/whisper-medium',
  },
  {
    name: 'Parakeet TDT 0.6B v3',
    slug: 'parakeet-tdt-0.6b-v3',
    category: 'audio',
    sizeMb: 411,
    quantization: 'int4',
    description: 'NVIDIA Parakeet: top accuracy for meetings, multilingual (European languages). No Whisper prompt/translate.',
    supportsCompletion: false,
    supportsToolCalling: false,
    supportsVision: false,
    supportsAudio: true,
    isSTT: true,
    hfRepo: 'Cactus-Compute/parakeet-tdt-0.6b-v3',
  },
  {
    name: 'Moonshine Base',
    slug: 'moonshine-base',
    category: 'audio',
    sizeMb: 75,
    description: 'Tiny, fast English-only STT for voice input.',
    supportsCompletion: false,
    supportsToolCalling: false,
    supportsVision: false,
    supportsAudio: true,
    isSTT: true,
    hfRepo: 'Cactus-Compute/moonshine-base',
  },
  // === Embedding ===
  {
    name: 'Qwen3-Embedding-0.6B',
    slug: 'qwen3-embedding-0.6b',
    category: 'embedding',
    sizeMb: 574,
    description: 'Text embedding model for semantic memory and RAG.',
    supportsCompletion: false,
    supportsToolCalling: false,
    supportsVision: false,
    supportsAudio: false,
  },
  {
    name: 'Nomic Embed v2 MoE',
    slug: 'nomic-embed-text-v2-moe',
    category: 'embedding',
    sizeMb: 463,
    description: 'Multilingual embedding model (100+ languages).',
    supportsCompletion: false,
    supportsToolCalling: false,
    supportsVision: false,
    supportsAudio: false,
  },
  // === Specialized ===
  {
    name: 'LFM2.5-1.2B-Thinking',
    slug: 'lfm2.5-1.2b-thinking',
    category: 'specialized',
    sizeMb: 1118,
    description: 'Step-by-step reasoning and planning.',
    supportsCompletion: true,
    supportsToolCalling: true,
    supportsVision: false,
    supportsAudio: false,
    supportsThinking: true,
  },
  {
    name: 'LFM2-1.2B-RAG',
    slug: 'lfm2-1.2b-rag',
    category: 'specialized',
    sizeMb: 1242,
    description: 'Tuned to answer from retrieved documents (meetings, notes).',
    supportsCompletion: true,
    supportsToolCalling: false,
    supportsVision: false,
    supportsAudio: false,
  },
];

export const STT_MODELS = (): LiquidModel[] => LIQUID_MODELS.filter(m => m.isSTT);
export const COMPLETION_MODELS = (): LiquidModel[] =>
  LIQUID_MODELS.filter(m => m.supportsCompletion && !m.legacy && m.category !== 'vision');

export function getModelsByCategory(category: string): LiquidModel[] {
  return LIQUID_MODELS.filter(m => m.category === category);
}

export function getModelBySlug(slug: string): LiquidModel | undefined {
  return LIQUID_MODELS.find(m => m.slug === slug);
}

export function getModelsByTier(tier: ModelTier): LiquidModel[] {
  return LIQUID_MODELS.filter(m => _getModelTier(m.slug) === tier);
}

export function quantizationFor(slug: string): 'int4' | 'int8' | undefined {
  return getModelBySlug(slug)?.quantization;
}

export { _getModelTier as getModelTier };
