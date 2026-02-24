import type { LiquidModel } from '../types';

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
  // === Specialized Models ===
  {
    name: 'LFM2-1.2B-RAG',
    slug: 'lfm2-1.2b-rag',
    category: 'specialized',
    sizeMb: 600,
    description: 'Optimized for retrieval-augmented generation.',
    supportsCompletion: true,
    supportsToolCalling: false,
    supportsVision: false,
    supportsAudio: false,
  },
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
    name: 'LFM2-VL-1.6B',
    slug: 'lfm2-vl-1.6b',
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
    sizeMb: 244,
    description: 'Fast on-device speech-to-text transcription.',
    supportsCompletion: false,
    supportsToolCalling: false,
    supportsVision: false,
    supportsAudio: true,
  },
  {
    name: 'Whisper Medium',
    slug: 'whisper-medium',
    category: 'audio',
    sizeMb: 769,
    description: 'Higher accuracy speech-to-text transcription.',
    supportsCompletion: false,
    supportsToolCalling: false,
    supportsVision: false,
    supportsAudio: true,
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
  // === Custom Fine-tuned Model ===
  {
    name: 'LFM2.5 Mobile Actions',
    slug: 'lfm25-mobile-actions',
    category: 'custom',
    sizeMb: 600,
    description: 'Fine-tuned for mobile action tool calling. Downloads cactus-format weights from HuggingFace.',
    supportsCompletion: true,
    supportsToolCalling: true,
    supportsVision: false,
    supportsAudio: false,
    isCustom: true,
    hfRepo: 'kshitijthakkar/lfm25-mobile-actions-cactus',
  },
];

export function getModelsByCategory(category: string): LiquidModel[] {
  return LIQUID_MODELS.filter(m => m.category === category);
}

export function getModelBySlug(slug: string): LiquidModel | undefined {
  return LIQUID_MODELS.find(m => m.slug === slug);
}
