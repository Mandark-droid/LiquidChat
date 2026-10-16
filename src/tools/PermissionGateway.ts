/**
 * Permission Gateway (PRD §7.3) — the ONLY code path that executes a tool.
 *
 *   proposed call → schema validation → distribution check → Android permission
 *   → risk policy → user approval (if required) → execute (timeout, cancel)
 *   → structured result → audit record
 *
 * A model cannot bypass it: tools' execute() is never handed to planners or
 * models, and skill/plan "requiresApproval: false" can only add friction, never
 * remove the gateway's own approval requirements.
 */
import type { Tracer } from '../observability/types';
import { nullTracer } from '../observability/types';
import type { PermissionChecker } from '../platform/types';
import type { ApprovalDecision, ApprovalManager } from '../security/ApprovalManager';
import type { ExecutionRepository } from '../storage/ExecutionRepository';
import { formatIssues, validate } from './schema';
import type { ToolRegistry } from './ToolRegistry';
import type { AgentTool, Distribution, ToolContext, ToolError, ToolResult } from './types';

export interface InvokeOptions {
  /** Plan/skill asked for confirmation even if the tool's risk wouldn't require it. */
  requireApproval?: boolean;
  timeoutMs?: number;
  /** Voice sessions get a spoken prompt. */
  voice?: boolean;
  /** Per-execution approver (lets the executor reflect WAITING_FOR_PERMISSION while the user decides). */
  approver?: (req: Parameters<ApprovalManager['request']>[0]) => Promise<ApprovalDecision>;
}

export interface GatewayDeps {
  registry: ToolRegistry;
  permissions: PermissionChecker;
  approvals: ApprovalManager;
  repo: ExecutionRepository;
  distribution: () => Distribution;
  tracer?: Tracer;
}

const DEFAULT_TIMEOUT_MS = 20_000;

export class PermissionGateway {
  private readonly tracer: Tracer;

  constructor(private readonly deps: GatewayDeps) {
    this.tracer = deps.tracer ?? nullTracer;
  }

  async invoke(
    name: string,
    rawArgs: unknown,
    ctx: ToolContext,
    opts: InvokeOptions = {},
  ): Promise<ToolResult> {
    const started = Date.now();
    const tool = this.deps.registry.get(name);
    const fail = (error: ToolError, extra: Record<string, unknown> = {}): ToolResult => {
      this.tracer.record(ctx.executionId, 'tool.denied', {
        tool: name,
        code: error.code,
        ...extra,
      });
      return { success: false, error, durationMs: Date.now() - started, display: error.message };
    };

    if (!tool)
      return fail({ code: 'UNKNOWN_TOOL', message: `Unknown tool "${name}"`, recoverable: false });

    // 1. Schema validation — model-generated arguments are never trusted as-is.
    const v = validate<Record<string, unknown>>(tool.inputSchema, rawArgs ?? {});
    if (!v.ok) {
      const error = {
        code: 'INVALID_ARGS',
        message: `Invalid arguments for ${tool.name}: ${formatIssues(v.issues)}`,
        recoverable: true,
      };
      await this.audit(tool, ctx, rawArgs, 'denied', { reason: 'invalid_args', issues: v.issues });
      return fail(error, { reason: 'invalid_args' });
    }
    const args = v.value ?? {};

    // 2. Distribution (Play builds never run Accessibility automation).
    if (tool.distributions && !tool.distributions.includes(this.deps.distribution())) {
      this.tracer.record(ctx.executionId, 'policy.violation_blocked', {
        tool: tool.name,
        reason: 'distribution',
      });
      return fail({
        code: 'NOT_AVAILABLE',
        message: `${tool.name} is not available in this build`,
        recoverable: false,
      });
    }

    // 3. Android permissions.
    for (const p of tool.requiredPermissions) {
      if (!(await this.deps.permissions.check(p))) {
        await this.audit(tool, ctx, args, 'denied', {
          reason: 'missing_permission',
          permission: p,
        });
        return fail(
          {
            code: 'PERMISSION_REQUIRED',
            message: `${tool.name} needs permission: ${p}`,
            recoverable: true,
          },
          { permission: p },
        );
      }
    }

    // 4. Risk policy + approval.
    let approvedBy: string | undefined;
    const needsApproval = opts.requireApproval || tool.riskLevel === 'sensitive' || tool.alwaysAsk;
    if (needsApproval) {
      const granted =
        !tool.alwaysAsk &&
        tool.riskLevel !== 'sensitive' &&
        (await this.deps.repo.hasGrant(tool.name));
      if (granted) {
        approvedBy = 'grant';
      } else {
        const summary =
          tool.describeCall?.(args as never) ??
          `${tool.name}(${JSON.stringify(args).slice(0, 160)})`;
        const ask = opts.approver ?? (r => this.deps.approvals.request(r));
        const decision = await ask({
          kind: 'tool',
          title: tool.riskLevel === 'sensitive' ? 'Allow sensitive action?' : 'Allow this action?',
          detail: summary,
          risk: tool.riskLevel === 'sensitive' ? 'high' : 'medium',
          allowAlways: !tool.alwaysAsk && tool.riskLevel !== 'sensitive',
          executionId: ctx.executionId,
          speak: opts.voice ? `Should I ${summary}?` : undefined,
        });
        this.tracer.record(ctx.executionId, 'approval', { tool: tool.name, decision });
        if (decision === 'deny') {
          await this.audit(tool, ctx, args, 'denied', { reason: 'user_denied' });
          return fail({
            code: 'USER_DENIED',
            message: `You declined: ${summary}`,
            recoverable: false,
          });
        }
        // A standing grant is only honoured where offering one was allowed.
        if (decision === 'approve_always' && !tool.alwaysAsk && tool.riskLevel !== 'sensitive') {
          await this.deps.repo.addGrant(tool.name);
        }
        approvedBy = decision;
      }
    }

    if (ctx.cancel.cancelled)
      return fail({ code: 'CANCELLED', message: 'Cancelled', recoverable: false });

    // 5. Execute with timeout + cancellation, audit before and after.
    await this.deps.repo.startToolCall({
      id: ctx.toolCallId,
      executionId: ctx.executionId,
      stepId: ctx.stepId,
      tool: tool.name,
      args,
      idempotent: tool.idempotent,
      risk: tool.riskLevel,
      approvedBy,
    });
    let result: ToolResult;
    try {
      const outcome = await withTimeout(
        tool.execute(args as never, ctx),
        opts.timeoutMs ?? DEFAULT_TIMEOUT_MS,
        ctx,
      );
      result = { ...outcome, durationMs: Date.now() - started };
    } catch (e) {
      const code =
        e instanceof TimeoutError
          ? 'TIMEOUT'
          : e instanceof CancelledError
            ? 'CANCELLED'
            : 'TOOL_EXCEPTION';
      result = {
        success: false,
        error: {
          code,
          message: e instanceof Error ? e.message : String(e),
          recoverable: code !== 'CANCELLED',
        },
        durationMs: Date.now() - started,
      };
    }
    await this.deps.repo.endToolCall(ctx.toolCallId, result.success ? 'succeeded' : 'failed', {
      data: result.data,
      error: result.error,
      display: result.display,
    });
    this.tracer.record(ctx.executionId, 'tool.call', {
      tool: tool.name,
      stepId: ctx.stepId,
      success: result.success,
      code: result.error?.code,
      durationMs: result.durationMs,
      risk: tool.riskLevel,
      approvedBy,
    });
    return result;
  }

  private async audit(
    tool: AgentTool,
    ctx: ToolContext,
    args: unknown,
    _status: 'denied',
    detail: Record<string, unknown>,
  ) {
    await this.deps.repo.recordDenied(
      {
        id: ctx.toolCallId,
        executionId: ctx.executionId,
        stepId: ctx.stepId,
        tool: tool.name,
        args,
        idempotent: tool.idempotent,
        risk: tool.riskLevel,
      },
      String(detail.reason ?? 'denied'),
    );
  }
}

export class TimeoutError extends Error {}
export class CancelledError extends Error {}

function withTimeout<T>(p: Promise<T>, ms: number, ctx: ToolContext): Promise<T> {
  return new Promise<T>((resolve, reject) => {
    const timer = setTimeout(() => reject(new TimeoutError(`Timed out after ${ms} ms`)), ms);
    const off = ctx.cancel.onCancel(() => {
      clearTimeout(timer);
      reject(new CancelledError('Cancelled'));
    });
    p.then(
      v => {
        clearTimeout(timer);
        off();
        resolve(v);
      },
      e => {
        clearTimeout(timer);
        off();
        reject(e);
      },
    );
  });
}
