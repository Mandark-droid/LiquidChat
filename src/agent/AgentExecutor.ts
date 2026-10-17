/**
 * Plan execution (PRD §5): runs validated steps in dependency order, routes
 * every inference step individually, verifies outcomes, retries/escalates
 * within limits, and persists each step before moving on.
 *
 * Restart safety: a tool call is recorded as 'started' before it runs. On
 * resume, a step whose call already succeeded reuses the stored result; a
 * call that was in flight is re-run only if the tool is idempotent —
 * otherwise the user is asked (WAITING_FOR_USER), so messages, events or
 * contacts are never duplicated silently.
 */
import type { DataClass, InferenceResult, RoutingDecision } from '../inference/types';
import type { Tracer } from '../observability/types';
import { nullTracer } from '../observability/types';
import type { PermissionChecker } from '../platform/types';
import type { ApprovalDecision, ApprovalManager } from '../security/ApprovalManager';
import type { ExecutionRepository } from '../storage/ExecutionRepository';
import type { PermissionGateway } from '../tools/PermissionGateway';
import type { ToolRegistry } from '../tools/ToolRegistry';
import type { Distribution, ToolError } from '../tools/types';
import { verifyInference, verifyTool } from './AgentVerifier';
import type { CancellationSource } from './cancellation';
import type { InferenceRunner } from './ports';
import { findRefs, resolveArgs, resolvePrompt } from './templating';
import type {
  AgentEvent,
  ExecutionRecord,
  ExecutionState,
  InferStep,
  Plan,
  PlanStep,
  StepRecord,
  ToolStep,
} from './types';

interface Taint {
  dataClass: DataClass;
  localOnly: boolean;
}

const CLASS_RANK: Record<DataClass, number> = { public: 0, personal: 1, sensitive: 2 };

export function maxClass(classes: DataClass[]): DataClass {
  return classes.reduce<DataClass>((a, b) => (CLASS_RANK[b] > CLASS_RANK[a] ? b : a), 'public');
}

export interface ExecutorDeps {
  registry: ToolRegistry;
  gateway: PermissionGateway;
  inference: InferenceRunner;
  repo: ExecutionRepository;
  approvals: ApprovalManager;
  permissions: PermissionChecker;
  distribution: () => Distribution;
  tracer?: Tracer;
  /** Escalations per inference step (re-route to a stronger model on verification failure). */
  maxEscalations?: number;
  sleep?: (ms: number) => Promise<void>;
}

export interface RunContext {
  record: ExecutionRecord;
  plan: Plan;
  cancel: CancellationSource;
  setState: (to: ExecutionState, reason?: string, waitingOn?: string) => Promise<void>;
  emit: (e: AgentEvent) => void;
  memoryContext?: string;
  voice?: boolean;
}

export interface ExecutionOutcome {
  ok: boolean;
  cancelled: boolean;
  outputs: Record<string, unknown>;
  failed: { stepId: string; error: ToolError }[];
}

const OPERATION_SYSTEM: Record<string, string> = {
  summarize: 'You summarise content accurately and concisely. Use only the provided material.',
  extract:
    'You extract the requested information precisely. Use only the provided material; say "none" if absent.',
  reason: 'You reason carefully step by step and give a clear, correct conclusion.',
  respond:
    'You are LiquidChat, a concise and helpful on-device assistant. Answer the user directly.',
  classify: 'You classify the input into one of the requested labels. Reply with the label only.',
  plan: 'You plan tasks.',
};

const DEFAULT_TOOL_RETRY = { maxAttempts: 2, backoffMs: 400 };

export class AgentExecutor {
  private readonly tracer: Tracer;
  private readonly sleep: (ms: number) => Promise<void>;

  constructor(private readonly deps: ExecutorDeps) {
    this.tracer = deps.tracer ?? nullTracer;
    this.sleep = deps.sleep ?? (ms => new Promise(r => setTimeout(r, ms)));
  }

  async run(ctx: RunContext): Promise<ExecutionOutcome> {
    const { record, plan } = ctx;
    const outputs: Record<string, unknown> = {};
    const failed: ExecutionOutcome['failed'] = [];
    const taint = new Map<string, Taint>();

    for (const step of plan.steps) {
      taint.set(step.id, await this.taintOf(step, taint, ctx));
      if (ctx.cancel.cancelled || (await this.deps.repo.isCancelRequested(record.id))) {
        ctx.cancel.cancel();
        return { ok: false, cancelled: true, outputs, failed };
      }

      const prev = record.steps[step.id];
      if (prev?.status === 'succeeded') {
        outputs[step.id] = prev.output;
        continue;
      }

      const blocked = (step.dependsOn ?? []).find(d => record.steps[d]?.status !== 'succeeded');
      if (blocked) {
        await this.save(ctx, {
          stepId: step.id,
          status: 'skipped',
          attempts: 0,
          error: {
            code: 'DEPENDENCY_FAILED',
            message: `Skipped because ${blocked} did not succeed`,
            recoverable: false,
          },
        });
        continue;
      }

      const rec: StepRecord = {
        stepId: step.id,
        status: 'running',
        attempts: prev?.attempts ?? 0,
        startedAt: Date.now(),
        routing: prev?.routing ?? [],
      };
      await this.save(ctx, rec);
      this.tracer.record(record.id, 'step.start', { stepId: step.id, kind: step.kind });

      const res =
        step.kind === 'tool'
          ? await this.runTool(ctx, step, rec, outputs, taint)
          : await this.runInfer(ctx, step, rec, outputs, taint.get(step.id)!);

      if (ctx.cancel.cancelled) return { ok: false, cancelled: true, outputs, failed };
      rec.endedAt = Date.now();
      if (res.ok) {
        rec.status = 'succeeded';
        rec.output = res.output;
        rec.display = res.display;
        rec.verified = true;
        outputs[step.id] = res.output;
      } else {
        rec.status = 'failed';
        rec.error = res.error;
        failed.push({ stepId: step.id, error: res.error! });
      }
      await this.save(ctx, rec);
      this.tracer.record(record.id, 'step.end', {
        stepId: step.id,
        status: rec.status,
        attempts: rec.attempts,
        code: rec.error?.code,
      });
    }
    return { ok: failed.length === 0, cancelled: false, outputs, failed };
  }

  // ---------------------------------------------------------------------------

  /**
   * Privacy taint (PRD §6.6): a step's output carries the highest data class of
   * everything that flowed into it, so a model step summarising notifications is
   * routed as personal even if the plan labelled it public, and data captured as
   * "on-device only" can never reach a remote model or a network tool.
   */
  private async taintOf(
    step: PlanStep,
    taint: Map<string, Taint>,
    ctx: RunContext,
  ): Promise<Taint> {
    const upstream = findRefs(step.kind === 'tool' ? step.args : step.prompt)
      .map(id => taint.get(id))
      .filter((t): t is Taint => !!t);
    if (step.kind === 'tool') {
      const tool = this.deps.registry.get(step.tool);
      const own: DataClass =
        tool?.outputDataClass ?? (tool?.category === 'device' ? 'public' : 'personal');
      let localOnly = false;
      try {
        localOnly = !!(await tool?.localOnlyOutput?.());
      } catch {
        localOnly = true; // fail closed
      }
      return {
        dataClass: maxClass([own, ...upstream.map(t => t.dataClass)]),
        localOnly: localOnly || upstream.some(t => t.localOnly),
      };
    }
    const fromMemory: DataClass[] =
      ctx.memoryContext && step.dataClass !== 'public' ? ['personal'] : [];
    return {
      dataClass: maxClass([step.dataClass, ...fromMemory, ...upstream.map(t => t.dataClass)]),
      localOnly: upstream.some(t => t.localOnly),
    };
  }

  private async runTool(
    ctx: RunContext,
    step: ToolStep,
    rec: StepRecord,
    outputs: Record<string, unknown>,
    taint: Map<string, Taint>,
  ): Promise<{ ok: boolean; output?: unknown; display?: string; error?: ToolError }> {
    const { record } = ctx;
    const tool = this.deps.registry.get(step.tool);
    if (!tool)
      return {
        ok: false,
        error: { code: 'UNKNOWN_TOOL', message: `Unknown tool ${step.tool}`, recoverable: false },
      };
    const leaks = findRefs(step.args).filter(id => taint.get(id)?.localOnly);
    if (leaks.length && tool.requiredPermissions.includes('special:network')) {
      this.tracer.record(record.id, 'policy.violation_blocked', {
        stepId: step.id,
        code: 'LOCAL_ONLY_DATA',
      });
      return {
        ok: false,
        error: {
          code: 'LOCAL_ONLY_DATA',
          message: `${tool.name} would send on-device-only data (from ${leaks.join(', ')}) over the network`,
          recoverable: false,
        },
      };
    }

    const toolCallId = `${record.id}:${step.id}`;
    const existing = await this.deps.repo.toolCall(toolCallId);
    if (existing?.status === 'succeeded') {
      const r = existing.result as { data?: unknown; display?: string } | undefined;
      return { ok: true, output: r?.data, display: r?.display };
    }
    if (existing?.status === 'started' && !tool.idempotent) {
      // In flight when the app died: we cannot know whether it happened.
      await ctx.setState('WAITING_FOR_USER', `replay? ${step.id}`, `confirm_replay:${step.id}`);
      const decision = await this.deps.approvals.request({
        kind: 'tool',
        title: 'Run this step again?',
        detail: `${tool.describeCall?.(step.args as never) ?? tool.name} was interrupted and may already have happened.`,
        risk: 'high',
        allowAlways: false,
        executionId: record.id,
      });
      await ctx.setState('EXECUTING', decision === 'deny' ? 'replay declined' : 'replay confirmed');
      if (decision === 'deny') {
        return {
          ok: false,
          error: {
            code: 'NOT_REPLAYED',
            message: 'Interrupted step was not re-run',
            recoverable: false,
          },
        };
      }
    }

    const retry = step.retry ?? DEFAULT_TOOL_RETRY;
    let lastError: ToolError | undefined;
    let permissionAsked = false;
    while (rec.attempts < retry.maxAttempts + (permissionAsked ? 1 : 0)) {
      rec.attempts++;
      const args = resolveArgs(step.args, outputs);
      const toolCtx = {
        executionId: record.id,
        stepId: step.id,
        toolCallId,
        cancel: ctx.cancel,
        distribution: this.deps.distribution(),
      };
      const result = await this.deps.gateway.invoke(tool.name, args, toolCtx, {
        requireApproval: step.requiresApproval,
        timeoutMs: step.timeoutMs,
        voice: ctx.voice,
        approver: async req =>
          this.withState(ctx, 'WAITING_FOR_PERMISSION', `approval:${tool.name}`, () =>
            this.deps.approvals.request(req),
          ),
      });

      if (result.success) {
        await ctx.setState('VERIFYING');
        const v = await verifyTool(tool, args, result, toolCtx);
        this.tracer.record(record.id, 'verification', {
          stepId: step.id,
          ok: v.ok,
          reason: v.reason,
        });
        if (v.ok) {
          await ctx.setState('EXECUTING');
          return { ok: true, output: result.data, display: result.display };
        }
        lastError = {
          code: 'VERIFICATION_FAILED',
          message: v.reason ?? 'post-condition failed',
          recoverable: tool.idempotent,
        };
        if (!tool.idempotent) break; // never repeat a non-idempotent action to "fix" verification
      } else {
        lastError = result.error;
        if (result.error?.code === 'PERMISSION_REQUIRED' && !permissionAsked) {
          const perm = tool.requiredPermissions.find(Boolean);
          permissionAsked = true;
          if (perm) {
            const granted = await this.withState(ctx, 'WAITING_FOR_PERMISSION', perm, () =>
              this.deps.permissions.request(perm),
            );
            if (granted) {
              rec.attempts--; // the permission prompt doesn't consume a retry
              continue;
            }
          }
          break;
        }
        if (
          !result.error?.recoverable ||
          ['USER_DENIED', 'CANCELLED', 'INVALID_ARGS', 'NOT_AVAILABLE'].includes(result.error.code)
        )
          break;
      }
      if (rec.attempts < retry.maxAttempts) {
        await ctx.setState('RECOVERING', lastError?.code);
        this.tracer.record(record.id, 'retry', {
          stepId: step.id,
          attempt: rec.attempts,
          code: lastError?.code,
        });
        await this.sleep(retry.backoffMs * rec.attempts);
        await ctx.setState('EXECUTING');
      }
    }
    return {
      ok: false,
      error: lastError ?? { code: 'TOOL_FAILED', message: 'Tool failed', recoverable: false },
    };
  }

  private async runInfer(
    ctx: RunContext,
    step: InferStep,
    rec: StepRecord,
    outputs: Record<string, unknown>,
    taint: Taint,
  ): Promise<{ ok: boolean; output?: unknown; display?: string; error?: ToolError }> {
    const { record } = ctx;
    const prompt = resolvePrompt(step.prompt, outputs);
    const messages = [
      {
        role: 'system' as const,
        content: OPERATION_SYSTEM[step.operation] ?? OPERATION_SYSTEM.respond,
      },
      ...(ctx.memoryContext && step.dataClass !== 'public'
        ? [{ role: 'system' as const, content: ctx.memoryContext }]
        : []),
      { role: 'user' as const, content: prompt },
    ];
    const tried: string[] = [];
    let escalationReason: string | undefined;
    const maxEscalations = this.deps.maxEscalations ?? 1;

    for (let round = 0; round <= maxEscalations; round++) {
      rec.attempts++;
      await ctx.setState('ROUTING');
      let result: InferenceResult;
      let decision: RoutingDecision;
      try {
        ({ result, decision } = await this.deps.inference.run(
          {
            executionId: record.id,
            stepId: step.id,
            requirements: { operation: step.operation, ...step.needs },
            dataClass: taint.dataClass,
            localOnly: taint.localOnly || undefined,
            estimatedInputTokens: Math.ceil(messages.reduce((n, m) => n + m.content.length, 0) / 4),
            estimatedOutputTokens: step.maxTokens ?? 600,
            excludeModels: tried,
            escalationReason,
            remoteCallsSoFar: record.remoteCalls,
            spendSoFarUsd: record.spendUsd,
          },
          {
            messages,
            maxTokens: step.maxTokens ?? 700,
            temperature: step.operation === 'respond' ? 0.6 : 0.2,
            json: !!step.outputSchema,
          },
          {
            signal: ctx.cancel.signal,
            approve: d => this.approveRemote(ctx, step, d, taint.dataClass),
            onToken: token =>
              ctx.emit({ type: 'token', executionId: record.id, stepId: step.id, token }),
          },
        ));
      } catch (e) {
        await ctx.setState('EXECUTING');
        const code =
          (e as { name?: string })?.name === 'NoEligibleModelError'
            ? 'NO_ELIGIBLE_MODEL'
            : 'INFERENCE_FAILED';
        return {
          ok: false,
          error: { code, message: e instanceof Error ? e.message : String(e), recoverable: false },
        };
      }
      await ctx.setState('EXECUTING');
      rec.routing = [...(rec.routing ?? []), decision];
      ctx.emit({ type: 'routing', executionId: record.id, stepId: step.id, decision });
      if (result.mode === 'remote' || result.costUsd) {
        record.remoteCalls += result.mode === 'remote' ? 1 : 0;
        record.spendUsd += result.costUsd ?? 0;
        await this.deps.repo.addSpend(record.id, result.costUsd ?? 0, result.mode === 'remote');
      }
      this.tracer.record(record.id, 'inference', {
        stepId: step.id,
        model: result.modelId,
        mode: result.mode,
        latencyMs: result.latencyMs,
        outputTokens: result.outputTokens,
        costUsd: result.costUsd,
      });

      await ctx.setState('VERIFYING');
      const v = verifyInference(step, result);
      this.tracer.record(record.id, 'verification', {
        stepId: step.id,
        ok: v.ok,
        reason: v.reason,
        model: result.modelId,
      });
      await ctx.setState('EXECUTING');
      if (v.ok) {
        const text = result.text.replace(/<think>[\s\S]*?<\/think>/gi, '').trim();
        return {
          ok: true,
          output: step.outputSchema ? v.value : text,
          display: text.slice(0, 200),
        };
      }
      if (!v.escalate || round === maxEscalations) {
        return {
          ok: false,
          error: {
            code: 'VERIFICATION_FAILED',
            message: v.reason ?? 'output rejected',
            recoverable: false,
          },
        };
      }
      // Per-step escalation: exclude this model and let the router pick a stronger one.
      tried.push(result.modelId);
      escalationReason = v.reason;
      await ctx.setState('RECOVERING', `escalate: ${v.reason}`);
      this.tracer.record(record.id, 'retry', {
        stepId: step.id,
        escalate: true,
        reason: v.reason,
        from: result.modelId,
      });
    }
    return {
      ok: false,
      error: { code: 'VERIFICATION_FAILED', message: 'output rejected', recoverable: false },
    };
  }

  private async approveRemote(
    ctx: RunContext,
    step: InferStep,
    d: RoutingDecision,
    dataClass: DataClass,
  ): Promise<boolean> {
    const decision: ApprovalDecision = await this.withState(
      ctx,
      'WAITING_FOR_PERMISSION',
      `remote:${d.providerId}`,
      () =>
        this.deps.approvals.request({
          kind: 'remote_inference',
          title: `Use ${d.selectedModelId} in the cloud?`,
          detail: `One ${step.operation} step with ${dataClass} data would be sent to ${d.providerId}. ${d.reason}`,
          risk: dataClass === 'sensitive' ? 'high' : 'medium',
          allowAlways: dataClass !== 'sensitive',
          executionId: ctx.record.id,
        }),
    );
    return decision !== 'deny';
  }

  private async withState<T>(
    ctx: RunContext,
    state: ExecutionState,
    waitingOn: string,
    fn: () => Promise<T>,
  ): Promise<T> {
    await ctx.setState(state, waitingOn, waitingOn);
    try {
      return await fn();
    } finally {
      if (!ctx.cancel.cancelled) await ctx.setState('EXECUTING');
    }
  }

  private async save(ctx: RunContext, rec: StepRecord): Promise<void> {
    ctx.record.steps[rec.stepId] = rec;
    await this.deps.repo.saveStep(ctx.record.id, rec);
    ctx.emit({ type: 'step', executionId: ctx.record.id, step: { ...rec } });
  }
}

/** Deterministic reply for tool-only plans — no model call (battery, latency, privacy). */
export function composeResponse(
  plan: Plan,
  record: ExecutionRecord,
  outcome: ExecutionOutcome,
): string {
  const responseId =
    plan.responseStep ??
    [...plan.steps].reverse().find(s => s.kind === 'infer' && s.operation === 'respond')?.id;
  if (responseId && record.steps[responseId]?.status === 'succeeded') {
    const out = record.steps[responseId].output;
    return typeof out === 'string' ? out : JSON.stringify(out, null, 2);
  }
  const done = plan.steps
    .filter(s => record.steps[s.id]?.status === 'succeeded')
    .map(s => record.steps[s.id].display)
    .filter((d): d is string => !!d);
  const lastInfer = [...plan.steps]
    .reverse()
    .find(s => s.kind === 'infer' && record.steps[s.id]?.status === 'succeeded');
  const parts: string[] = [];
  if (lastInfer) {
    const out = record.steps[lastInfer.id].output;
    parts.push(typeof out === 'string' ? out : JSON.stringify(out, null, 2));
  } else if (done.length) {
    parts.push(done.join('\n'));
  }
  for (const f of outcome.failed) parts.push(`Couldn’t complete ${f.stepId}: ${f.error.message}`);
  const skipped = plan.steps.filter(s => record.steps[s.id]?.status === 'skipped').map(s => s.id);
  if (skipped.length) parts.push(`Skipped: ${skipped.join(', ')}`);
  return parts.join('\n') || (outcome.ok ? 'Done.' : 'Nothing was completed.');
}
