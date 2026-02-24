import type { Message } from 'cactus-react-native';

export interface ToolCall {
  name: string;
  arguments: Record<string, any>;
}

export interface ToolResult {
  success: boolean;
  message: string;
  data?: any;
}

export interface ChatMessage extends Message {
  timestamp: number;
  tokens?: number;
  timeToFirstTokenMs?: number;
  tokensPerSecond?: number;
  toolCalls?: ToolCall[];
  toolResult?: ToolResult;
}

export interface ChatMetrics {
  totalTokens: number;
  timeToFirstTokenMs: number;
  totalTimeMs: number;
  tokensPerSecond: number;
  prefillTokens: number;
  decodeTokens: number;
}

export interface Chat {
  id: string;
  title: string;
  messages: ChatMessage[];
  createdAt: number;
  updatedAt: number;
  model: string;
  settings: ChatSettings;
}

export interface ChatSettings {
  model: string;
  temperature: number;
  topP: number;
  topK: number;
  maxTokens: number;
  systemPrompt: string;
  enableHaptics: boolean;
  autoTTS: boolean;
  ttsRate: number;
  ttsVoice: string;
  autoExecuteTools: boolean;
  hfToken: string;
  hfPrivateDataset: boolean;
  sttModel: string;
  autoSendVoice: boolean;
  voiceInputEnabled: boolean;
  memoryEnabled: boolean;
  autoRemember: boolean;
  embeddingModel: string;
}

export interface MemoryResult {
  id: string;
  text: string;
  score: number;
  metadata?: Record<string, any>;
  createdAt: number;
}

export interface DocumentResult extends MemoryResult {
  sourceFile: string;
  chunkIndex: number;
}

export type ModelCategory = 'text' | 'vision' | 'audio' | 'specialized' | 'custom' | 'embedding';

export interface LiquidModel {
  name: string;
  slug: string;
  category: ModelCategory;
  sizeMb: number;
  description: string;
  supportsCompletion: boolean;
  supportsToolCalling: boolean;
  supportsVision: boolean;
  supportsAudio: boolean;
  isCustom?: boolean;
  hfRepo?: string;
}

export const DEFAULT_SETTINGS: ChatSettings = {
  model: 'lfm25-mobile-actions',
  temperature: 0.7,
  topP: 0.9,
  topK: 40,
  maxTokens: 512,
  systemPrompt: '',
  enableHaptics: true,
  autoTTS: false,
  ttsRate: 1.0,
  ttsVoice: 'en-US-language',
  autoExecuteTools: true,
  hfToken: '',
  hfPrivateDataset: false,
  sttModel: 'whisper-small',
  autoSendVoice: false,
  voiceInputEnabled: true,
  memoryEnabled: false,
  autoRemember: true,
  embeddingModel: 'qwen3-embedding-0.6b',
};
