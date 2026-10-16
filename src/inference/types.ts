/**
 * Inference contracts (PRD §6). The agent never talks to Cactus or an API
 * directly — every model call is an InferenceRequest routed per step by the
 * ModelRouter to an InferenceProvider.
 */
import type { JsonSchema } from '../tools/types';

export type ExecutionMode = 'local' | 'remote';
export type RoutingMode = 'local_only' | 'hybrid' | 'cloud_preferred';
export type EnergyMode = 'battery_saver' | 'balanced' | 'performance';
export type DataClass = 'public' | 'personal' | 'sensitive';
export type InferOperation = 'plan' | 'summarize' | 'reason' | 'extract' | 'respond' | 'classify';
export type Complexity = 'low' | 'medium' | 'high';

export interface ChatTurn {
  role: 'system' | 'user' | 'assistant';
  content: string;
  images?: string[];
}

export interface InferenceTool {
  name: string;
  description: string;
  parameters: JsonSchema;
}

export interface InferenceRequest {
  messages: ChatTurn[];
  tools?: InferenceTool[];
  maxTokens?: number;
  temperature?: number;
  /** Ask the provider for a JSON object (best effort; output is still validated). */
  json?: boolean;
  stop?: string[];
}

export interface InferenceResult {
  text: string;
  functionCalls?: { name: string; arguments: Record<string, unknown> }[];
  modelId: string;
  provider: string;
  mode: ExecutionMode;
  latencyMs: number;
  inputTokens?: number;
  outputTokens?: number;
  tokensPerSecond?: number;
  /** Local model's self-assessed confidence (Cactus), when reported. */
  confidence?: number;
  costUsd?: number;
  ramUsageMb?: number;
}

export interface InferenceProvider {
  readonly id: string;
  readonly mode: ExecutionMode;
  isAvailable(): Promise<boolean>;
  complete(modelId: string, req: InferenceRequest, signal?: AbortSignal): Promise<InferenceResult>;
}

/** PRD §6.3 */
export interface ModelCapabilities {
  modelId: string;
  provider: ExecutionMode;
  providerId: string;
  displayName: string;
  supportsToolCalling: boolean;
  supportsVision: boolean;
  supportsStructuredOutput: boolean;
  supportsLongContext: boolean;
  maxContextTokens: number;
  estimatedMemoryMB?: number;
  averageLatencyMs?: number;
  averageTokensPerSecond?: number;
  /** Per-operation quality in [0,1], from evaluations; absent = unknown. */
  qualityScores?: Partial<Record<InferOperation, number>>;
  estimatedInputCostPerMillion?: number;
  estimatedOutputCostPerMillion?: number;
  /** Measured sample count behind latency/quality numbers. */
  samples?: number;
}

export interface StepRequirements {
  operation: InferOperation;
  toolCalling?: boolean;
  vision?: boolean;
  structuredOutput?: boolean;
  minContextTokens?: number;
  complexity?: Complexity;
}

/** Everything the router needs to decide one inference step. */
export interface RoutingContext {
  executionId: string;
  stepId: string;
  requirements: StepRequirements;
  dataClass: DataClass;
  estimatedInputTokens: number;
  estimatedOutputTokens: number;
  /** Models already tried for this step (escalation excludes them). */
  excludeModels?: string[];
  /** Why the previous attempt failed verification, if escalating. */
  escalationReason?: string;
  remoteCallsSoFar: number;
  spendSoFarUsd: number;
}

/** PRD §6.4 */
export interface RoutingDecision {
  selectedModelId: string;
  providerId: string;
  executionMode: ExecutionMode;
  reason: string;
  estimatedLatencyMs?: number;
  estimatedCost?: number;
  confidence?: number;
  requiresUserApproval: boolean;
  /** Models eliminated and why — makes decisions inspectable (PRD §6 acceptance). */
  rejected: { modelId: string; stage: 'capability' | 'policy'; reason: string }[];
}

export class NoEligibleModelError extends Error {
  constructor(
    message: string,
    readonly rejected: RoutingDecision['rejected'],
  ) {
    super(message);
    this.name = 'NoEligibleModelError';
  }
}
