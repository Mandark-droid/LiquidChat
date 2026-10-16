/** Structured trace contract (PRD §15). Payloads are redacted before storage. */
export type TraceType =
  | 'execution.state'
  | 'execution.plan'
  | 'step.start'
  | 'step.end'
  | 'tool.call'
  | 'tool.denied'
  | 'routing.decision'
  | 'inference'
  | 'verification'
  | 'retry'
  | 'approval'
  | 'memory.retrieve'
  | 'memory.write'
  | 'skill.run'
  | 'schedule.fire'
  | 'policy.violation_blocked'
  | 'user.correction'
  | 'device.snapshot';

export interface TraceEvent {
  executionId: string | null;
  type: TraceType;
  payload: Record<string, unknown>;
  at: number;
}

export interface Tracer {
  record(executionId: string | null, type: TraceType, payload?: Record<string, unknown>): void;
  /** Resolves when buffered events are persisted (tests, shutdown). */
  flush(): Promise<void>;
}

/** No-op tracer for contexts that don't persist (and as a default in unit tests). */
export const nullTracer: Tracer = {
  record: () => {},
  flush: async () => {},
};
