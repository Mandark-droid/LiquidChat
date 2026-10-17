/**
 * Execution state machine (PRD §5.2). Pure: the transition table is the single
 * source of truth for what the controller may do next; illegal transitions throw.
 */
import { AgentError, type ExecutionState, TERMINAL_STATES } from './types';

const WAITING: ExecutionState[] = [
  'WAITING_FOR_PERMISSION',
  'WAITING_FOR_USER',
  'WAITING_FOR_NETWORK',
];

/** Allowed next states for each state. */
export const TRANSITIONS: Record<ExecutionState, readonly ExecutionState[]> = {
  CREATED: ['PLANNING', 'EXECUTING', 'CANCELLED', 'FAILED'],
  PLANNING: [
    'ROUTING',
    'EXECUTING',
    'COMPLETED',
    'WAITING_FOR_USER',
    'WAITING_FOR_NETWORK',
    'CANCELLED',
    'FAILED',
  ],
  // ROUTING spans the model call: it can pause for a cloud-data approval, and a
  // process death during generation is recovered from it.
  ROUTING: ['EXECUTING', ...WAITING, 'RECOVERING', 'CANCELLED', 'FAILED'],
  EXECUTING: [
    'ROUTING',
    'VERIFYING',
    'RECOVERING',
    ...WAITING,
    'PAUSED',
    'COMPLETED',
    'CANCELLED',
    'FAILED',
  ],
  VERIFYING: ['EXECUTING', 'RECOVERING', 'COMPLETED', 'CANCELLED', 'FAILED'],
  RECOVERING: ['EXECUTING', 'ROUTING', ...WAITING, 'CANCELLED', 'FAILED'],
  WAITING_FOR_PERMISSION: ['EXECUTING', 'RECOVERING', 'CANCELLED', 'FAILED'],
  WAITING_FOR_USER: ['EXECUTING', 'PLANNING', 'RECOVERING', 'CANCELLED', 'FAILED'],
  WAITING_FOR_NETWORK: ['EXECUTING', 'ROUTING', 'CANCELLED', 'FAILED'],
  PAUSED: ['EXECUTING', 'CANCELLED', 'FAILED'],
  COMPLETED: [],
  CANCELLED: [],
  FAILED: [],
};

export function canTransition(from: ExecutionState, to: ExecutionState): boolean {
  return from === to || TRANSITIONS[from].includes(to);
}

export function assertTransition(from: ExecutionState, to: ExecutionState): void {
  if (!canTransition(from, to)) {
    throw new AgentError('ILLEGAL_TRANSITION', `Illegal state transition ${from} → ${to}`);
  }
}

export function isTerminal(s: ExecutionState): boolean {
  return TERMINAL_STATES.includes(s);
}

export function isWaiting(s: ExecutionState): boolean {
  return WAITING.includes(s);
}

/** States in which a process death leaves work half-done and needs recovery rules. */
export function isInFlight(s: ExecutionState): boolean {
  return ['PLANNING', 'ROUTING', 'EXECUTING', 'VERIFYING', 'RECOVERING'].includes(s);
}
