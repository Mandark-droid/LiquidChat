/**
 * Ports the agent core depends on. Concrete implementations (InferenceService,
 * MemoryManager, SkillRegistry …) are injected by src/agent/runtime.ts, and
 * tests inject scripted fakes — the core never imports a model or a native module.
 */
import type {
  InferenceRequest,
  InferenceResult,
  RoutingContext,
  RoutingDecision,
} from '../inference/types';
import type { Memory } from '../memory/MemoryManager';
import type { Plan } from './types';

export interface InferenceRunOptions {
  signal?: AbortSignal;
  /** Asked when a decision requires user approval (e.g. first cloud send of personal data). */
  approve?: (decision: RoutingDecision) => Promise<boolean | 'once' | 'always'>;
  onToken?: (token: string) => void;
}

export interface InferenceRunner {
  run(
    ctx: RoutingContext,
    req: InferenceRequest,
    opts?: InferenceRunOptions,
  ): Promise<{
    result: InferenceResult;
    decision: RoutingDecision;
    /** Every remote call this step dispatched, including failed/retried ones. */
    remoteCalls?: number;
    spendUsd?: number;
  }>;
}

export interface MemoryPort {
  retrieve(query: string, opts: { limit?: number; excludeSensitive?: boolean }): Promise<Memory[]>;
}

export interface SkillMatch {
  skillId: string;
  name: string;
  plan: Plan;
}

export interface SkillPort {
  /** Returns a ready plan when the request names or matches an enabled skill. */
  match(text: string, inputs?: Record<string, unknown>): Promise<SkillMatch | null>;
  planFor(skillId: string, inputs?: Record<string, unknown>): Promise<Plan | null>;
}
