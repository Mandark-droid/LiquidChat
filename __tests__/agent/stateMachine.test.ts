import {
  assertTransition,
  canTransition,
  isInFlight,
  isTerminal,
  TRANSITIONS,
} from '../../src/agent/AgentStateMachine';
import type { ExecutionState } from '../../src/agent/types';

describe('execution state machine', () => {
  it('allows the PRD happy path', () => {
    const path: ExecutionState[] = [
      'CREATED',
      'PLANNING',
      'ROUTING',
      'EXECUTING',
      'VERIFYING',
      'COMPLETED',
    ];
    for (let i = 1; i < path.length; i++) expect(canTransition(path[i - 1], path[i])).toBe(true);
  });

  it('allows failure → recovering → executing', () => {
    expect(canTransition('VERIFYING', 'RECOVERING')).toBe(true);
    expect(canTransition('RECOVERING', 'EXECUTING')).toBe(true);
  });

  it('rejects leaving terminal states', () => {
    for (const t of ['COMPLETED', 'CANCELLED', 'FAILED'] as ExecutionState[]) {
      expect(isTerminal(t)).toBe(true);
      expect(TRANSITIONS[t]).toHaveLength(0);
      expect(() => assertTransition(t, 'EXECUTING')).toThrow(/Illegal state transition/);
    }
  });

  it('every non-terminal state can be cancelled or failed', () => {
    for (const [s, next] of Object.entries(TRANSITIONS)) {
      if (isTerminal(s as ExecutionState)) continue;
      expect(next).toEqual(expect.arrayContaining(['CANCELLED', 'FAILED']));
    }
  });

  it('marks in-flight states for restart recovery', () => {
    expect(isInFlight('EXECUTING')).toBe(true);
    expect(isInFlight('WAITING_FOR_USER')).toBe(false);
  });
});
