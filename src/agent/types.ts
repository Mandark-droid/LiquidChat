/**
 * Agent runtime contracts (PRD §5). The model proposes; the runtime decides.
 */
import type {
  DataClass,
  InferOperation,
  RoutingDecision,
  StepRequirements,
} from '../inference/types';
import type { JsonSchema, ToolError } from '../tools/types';

export type ExecutionState =
  | 'CREATED'
  | 'PLANNING'
  | 'ROUTING'
  | 'EXECUTING'
  | 'VERIFYING'
  | 'RECOVERING'
  | 'COMPLETED'
  | 'WAITING_FOR_PERMISSION'
  | 'WAITING_FOR_USER'
  | 'WAITING_FOR_NETWORK'
  | 'PAUSED'
  | 'CANCELLED'
  | 'FAILED';

export const TERMINAL_STATES: ExecutionState[] = ['COMPLETED', 'CANCELLED', 'FAILED'];

export interface RetryPolicy {
  maxAttempts: number;
  backoffMs: number;
}

interface BaseStep {
  id: string;
  description?: string;
  dependsOn?: string[];
  timeoutMs?: number;
  retry?: RetryPolicy;
  requiresApproval?: boolean;
}

/**
 * Tool step. String values in `args` may reference earlier outputs:
 * "{{steps.step_1.output}}" or "{{steps.step_1.output.title}}".
 */
export interface ToolStep extends BaseStep {
  kind: 'tool';
  tool: string;
  args: Record<string, unknown>;
}

/** Model step. `prompt` may reference earlier outputs the same way. */
export interface InferStep extends BaseStep {
  kind: 'infer';
  operation: InferOperation;
  prompt: string;
  needs?: Omit<StepRequirements, 'operation'>;
  dataClass: DataClass;
  outputSchema?: JsonSchema;
  maxTokens?: number;
}

export type PlanStep = ToolStep | InferStep;

export interface Plan {
  goal: string;
  steps: PlanStep[];
  source: 'fastpath' | 'planner' | 'skill' | 'direct';
  skillId?: string;
  /** Which step's output is the user-facing answer (defaults to a synthesized reply). */
  responseStep?: string;
}

export type StepStatus = 'pending' | 'running' | 'succeeded' | 'failed' | 'skipped' | 'waiting';

export interface StepRecord {
  stepId: string;
  status: StepStatus;
  attempts: number;
  output?: unknown;
  display?: string;
  error?: ToolError;
  startedAt?: number;
  endedAt?: number;
  routing?: RoutingDecision[];
  verified?: boolean;
}

export type RequestSource = 'chat' | 'voice' | 'skill' | 'schedule' | 'eval' | 'notification';

export interface AgentRequest {
  text: string;
  source: RequestSource;
  conversationId?: string;
  /** Recent conversation turns, newest last (only what the planner needs). */
  history?: { role: 'user' | 'assistant'; content: string }[];
  images?: string[];
  skillId?: string;
  skillInputs?: Record<string, unknown>;
  /** Pre-built plan (skills, evals, legacy fast path). */
  plan?: Plan;
}

export interface ExecutionRecord {
  id: string;
  request: AgentRequest;
  state: ExecutionState;
  plan?: Plan;
  steps: Record<string, StepRecord>;
  response?: string;
  error?: ToolError;
  createdAt: number;
  updatedAt: number;
  /** Set by cancel(); the executor checks it between and during steps. */
  cancelRequested?: boolean;
  /** What the runtime is waiting on (permission id, approval id, network). */
  waitingOn?: string;
  remoteCalls: number;
  spendUsd: number;
}

export interface AgentResult {
  executionId: string;
  state: ExecutionState;
  response: string;
  plan?: Plan;
  steps: StepRecord[];
  error?: ToolError;
}

export type AgentEvent =
  | { type: 'state'; executionId: string; state: ExecutionState }
  | { type: 'plan'; executionId: string; plan: Plan }
  | { type: 'step'; executionId: string; step: StepRecord }
  | { type: 'routing'; executionId: string; stepId: string; decision: RoutingDecision }
  | { type: 'token'; executionId: string; stepId: string; token: string }
  | { type: 'approval'; executionId: string; approvalId: string; summary: string };

export interface AgentController {
  execute(request: AgentRequest, onEvent?: (e: AgentEvent) => void): Promise<AgentResult>;
  resume(executionId: string, onEvent?: (e: AgentEvent) => void): Promise<AgentResult>;
  cancel(executionId: string): Promise<void>;
}

export class AgentError extends Error {
  constructor(
    readonly code: string,
    message: string,
    readonly recoverable = false,
  ) {
    super(message);
    this.name = 'AgentError';
  }
  toToolError(): ToolError {
    return { code: this.code, message: this.message, recoverable: this.recoverable };
  }
}
