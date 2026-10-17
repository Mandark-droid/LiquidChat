/**
 * Agent Controller (PRD §5.1): owns the lifecycle of a request —
 * memory retrieval → planning → per-step execution → verification → reply —
 * persisting every state transition. It depends only on ports, never on a
 * specific model.
 */
import { MemoryManager, type MemoryProposal } from '../memory/MemoryManager';
import type { Tracer } from '../observability/types';
import { nullTracer } from '../observability/types';
import type { ApprovalManager } from '../security/ApprovalManager';
import type { ExecutionRepository } from '../storage/ExecutionRepository';
import type { AgentExecutor } from './AgentExecutor';
import { composeResponse } from './AgentExecutor';
import type { AgentPlanner } from './AgentPlanner';
import { assertTransition, isInFlight, isTerminal } from './AgentStateMachine';
import { CancellationSource } from './cancellation';
import type { MemoryPort } from './ports';
import type {
  AgentController as IAgentController,
  AgentEvent,
  AgentRequest,
  AgentResult,
  ExecutionRecord,
  ExecutionState,
  Plan,
} from './types';
import { AgentError } from './types';

export interface ControllerDeps {
  planner: AgentPlanner;
  executor: AgentExecutor;
  repo: ExecutionRepository;
  memory?: MemoryPort;
  tracer?: Tracer;
  /** Called with proposals the user may approve; nothing is stored automatically. */
  onMemoryProposal?: (p: MemoryProposal, executionId: string) => void;
  approvals?: Pick<ApprovalManager, 'denyAllFor'>;
  newId?: () => string;
}

export class AgentControllerImpl implements IAgentController {
  private readonly tracer: Tracer;
  private readonly active = new Map<string, CancellationSource>();

  constructor(private readonly deps: ControllerDeps) {
    this.tracer = deps.tracer ?? nullTracer;
  }

  async execute(request: AgentRequest, onEvent?: (e: AgentEvent) => void): Promise<AgentResult> {
    const id =
      this.deps.newId?.() ??
      `exe_${Date.now().toString(36)}${Math.random().toString(36).slice(2, 8)}`;
    const record = await this.deps.repo.create(id, request);
    return this.drive(record, onEvent ?? (() => {}), false);
  }

  async resume(executionId: string, onEvent?: (e: AgentEvent) => void): Promise<AgentResult> {
    const record = await this.deps.repo.get(executionId);
    if (!record) throw new AgentError('NOT_FOUND', `Execution ${executionId} not found`);
    if (isTerminal(record.state)) return toResult(record);
    if (this.active.has(executionId))
      throw new AgentError('ALREADY_RUNNING', 'Execution is already running');
    return this.drive(record, onEvent ?? (() => {}), true);
  }

  async cancel(executionId: string): Promise<void> {
    await this.deps.repo.requestCancel(executionId);
    this.active.get(executionId)?.cancel();
    // Close any approval sheet still open for it (a late "allow" must not act).
    this.deps.approvals?.denyAllFor(executionId);
    const record = await this.deps.repo.get(executionId);
    if (record && !isTerminal(record.state) && !this.active.has(executionId)) {
      await this.deps.repo.transition(
        executionId,
        record.state,
        'CANCELLED',
        'cancelled while idle',
      );
    }
  }

  /** Executions left unfinished by a process death (offered for resume on launch). */
  async unfinished(): Promise<ExecutionRecord[]> {
    const all = await this.deps.repo.list({
      states: [
        'CREATED',
        'PLANNING',
        'ROUTING',
        'EXECUTING',
        'VERIFYING',
        'RECOVERING',
        'WAITING_FOR_PERMISSION',
        'WAITING_FOR_USER',
        'WAITING_FOR_NETWORK',
        'PAUSED',
      ],
      limit: 20,
    });
    return all.filter(r => !this.active.has(r.id));
  }

  isActive(executionId: string): boolean {
    return this.active.has(executionId);
  }

  // ---------------------------------------------------------------------------

  private async drive(
    record: ExecutionRecord,
    emit: (e: AgentEvent) => void,
    resuming: boolean,
  ): Promise<AgentResult> {
    const cancel = new CancellationSource();
    this.active.set(record.id, cancel);
    const setState = async (to: ExecutionState, reason?: string, waitingOn?: string) => {
      if (record.state === to && !waitingOn) return;
      assertTransition(record.state, to);
      await this.deps.repo.transition(record.id, record.state, to, reason, waitingOn);
      this.tracer.record(record.id, 'execution.state', { from: record.state, to, reason });
      record.state = to;
      record.waitingOn = waitingOn;
      emit({ type: 'state', executionId: record.id, state: to });
    };

    try {
      if (resuming && isInFlight(record.state)) {
        // Process died mid-flight: move to RECOVERING so the executor applies replay rules.
        if (record.state !== 'RECOVERING')
          await setState(
            record.state === 'PLANNING' ? 'FAILED' : 'RECOVERING',
            'resumed after restart',
          );
        if (record.state === 'FAILED') {
          return await this.fail(record, {
            code: 'INTERRUPTED',
            message: 'Interrupted while planning; please ask again.',
            recoverable: false,
          });
        }
      }

      let memoryContext = '';
      if (this.deps.memory && record.request.source !== 'eval') {
        try {
          const mems = await this.deps.memory.retrieve(record.request.text, { limit: 5 });
          memoryContext = MemoryManager.asContext(mems);
          if (mems.length) this.tracer.record(record.id, 'memory.retrieve', { count: mems.length });
        } catch {}
      }

      let plan: Plan | undefined = record.plan;
      if (!plan) {
        await setState('PLANNING');
        const outcome = await this.deps.planner.plan(record.request, {
          executionId: record.id,
          memoryContext,
          signal: cancel.signal,
          onToken: token => emit({ type: 'token', executionId: record.id, stepId: 'plan', token }),
        });
        if (cancel.cancelled) return await this.cancelled(record, setState);
        if (outcome.kind === 'answer') {
          record.response = outcome.text;
          await setState('COMPLETED', 'direct answer');
          await this.deps.repo.finish(record.id, outcome.text, undefined);
          return toResult(record);
        }
        if (outcome.kind === 'invalid') {
          await setState('FAILED', 'invalid plan');
          return await this.fail(record, {
            code: 'INVALID_PLAN',
            message: `I couldn't turn that into a safe plan (${outcome.issues.map(i => i.message).join('; ')}).`,
            recoverable: false,
          });
        }
        plan = outcome.plan;
        record.plan = plan;
        await this.deps.repo.savePlan(record.id, plan);
        this.tracer.record(record.id, 'execution.plan', {
          source: plan.source,
          steps: plan.steps.length,
          skillId: plan.skillId,
        });
        emit({ type: 'plan', executionId: record.id, plan });
      }

      if (record.state !== 'EXECUTING') await setState('EXECUTING');
      const outcome = await this.deps.executor.run({
        record,
        plan,
        cancel,
        setState,
        emit,
        memoryContext,
        voice: record.request.source === 'voice',
      });
      if (outcome.cancelled) return await this.cancelled(record, setState);

      const response = composeResponse(plan, record, outcome);
      record.response = response;
      if (outcome.ok) {
        await setState('COMPLETED');
        await this.deps.repo.finish(record.id, response, undefined);
        const proposal =
          MemoryManager.proposeFromRequest(record.request.text) ??
          MemoryManager.proposeEpisode(plan.goal, response.slice(0, 200), plan.steps.length);
        if (proposal && this.deps.onMemoryProposal) this.deps.onMemoryProposal(proposal, record.id);
      } else {
        const error = outcome.failed[0]?.error;
        record.error = error;
        await setState('FAILED', error?.code);
        await this.deps.repo.finish(record.id, response, error);
      }
      return toResult(record);
    } catch (e) {
      const err =
        e instanceof AgentError
          ? e.toToolError()
          : {
              code: 'RUNTIME_ERROR',
              message: e instanceof Error ? e.message : String(e),
              recoverable: false,
            };
      if (!isTerminal(record.state)) {
        try {
          await this.deps.repo.transition(record.id, record.state, 'FAILED', err.code);
          record.state = 'FAILED';
        } catch {}
      }
      return this.fail(record, err);
    } finally {
      this.active.delete(record.id);
      await this.tracer.flush().catch(() => {});
    }
  }

  private async cancelled(
    record: ExecutionRecord,
    setState: (s: ExecutionState, r?: string) => Promise<void>,
  ): Promise<AgentResult> {
    if (!isTerminal(record.state)) await setState('CANCELLED', 'user cancelled');
    record.response = record.response ?? 'Cancelled.';
    await this.deps.repo.finish(record.id, record.response, undefined);
    return toResult(record);
  }

  private async fail(record: ExecutionRecord, error: AgentResult['error']): Promise<AgentResult> {
    record.error = error;
    record.response = record.response ?? error?.message ?? 'Failed.';
    await this.deps.repo.finish(record.id, record.response, error);
    return toResult(record);
  }
}

function toResult(r: ExecutionRecord): AgentResult {
  return {
    executionId: r.id,
    state: r.state,
    response: r.response ?? '',
    plan: r.plan,
    steps: r.plan ? r.plan.steps.map(s => r.steps[s.id]).filter(Boolean) : Object.values(r.steps),
    error: r.error,
  };
}
