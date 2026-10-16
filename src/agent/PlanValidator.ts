/**
 * Plan validation (PRD §5.3): the model proposes a plan, the runtime decides
 * whether it is well-formed and authorized. Rejects cycles, unknown tools,
 * invalid arguments, references to non-dependencies, oversized plans, and
 * sensitive steps without approval.
 */
import { formatIssues, validate } from '../tools/schema';
import type { ToolRegistry } from '../tools/ToolRegistry';
import type { Distribution, JsonSchema } from '../tools/types';
import { findRefs } from './templating';
import type { InferStep, Plan, PlanStep, ToolStep } from './types';

export const MAX_PLAN_STEPS = 12;
const OPERATIONS = ['plan', 'summarize', 'reason', 'extract', 'respond', 'classify'];
const DATA_CLASSES = ['public', 'personal', 'sensitive'];

export interface PlanIssue {
  stepId?: string;
  code:
    | 'EMPTY'
    | 'TOO_MANY_STEPS'
    | 'DUPLICATE_ID'
    | 'BAD_ID'
    | 'UNKNOWN_KIND'
    | 'UNKNOWN_TOOL'
    | 'NOT_AVAILABLE'
    | 'INVALID_ARGS'
    | 'BAD_DEPENDENCY'
    | 'CYCLE'
    | 'BAD_REFERENCE'
    | 'BAD_OPERATION'
    | 'BAD_DATA_CLASS'
    | 'EMPTY_PROMPT'
    | 'BAD_RESPONSE_STEP'
    | 'BAD_RETRY';
  message: string;
}

export interface PlanValidation {
  ok: boolean;
  issues: PlanIssue[];
  /** Plan with defaults applied: sensitive steps marked requiresApproval, ordered topologically. */
  plan?: Plan;
}

export function validatePlan(
  plan: Plan,
  registry: ToolRegistry,
  distribution: Distribution,
): PlanValidation {
  const issues: PlanIssue[] = [];
  const steps = Array.isArray(plan?.steps) ? plan.steps : [];
  if (!steps.length)
    return { ok: false, issues: [{ code: 'EMPTY', message: 'Plan has no steps' }] };
  if (steps.length > MAX_PLAN_STEPS) {
    issues.push({
      code: 'TOO_MANY_STEPS',
      message: `Plan has ${steps.length} steps (max ${MAX_PLAN_STEPS})`,
    });
  }

  const ids = new Set<string>();
  for (const s of steps) {
    if (!s?.id || !/^[a-zA-Z0-9_-]{1,40}$/.test(s.id)) {
      issues.push({
        stepId: s?.id,
        code: 'BAD_ID',
        message: 'Step id must be 1-40 chars [a-zA-Z0-9_-]',
      });
      continue;
    }
    if (ids.has(s.id))
      issues.push({ stepId: s.id, code: 'DUPLICATE_ID', message: `Duplicate step id ${s.id}` });
    ids.add(s.id);
  }

  const normalized: PlanStep[] = [];
  for (const s of steps) {
    if (!s?.id) continue;
    const deps = s.dependsOn ?? [];
    for (const d of deps) {
      if (!ids.has(d) || d === s.id)
        issues.push({
          stepId: s.id,
          code: 'BAD_DEPENDENCY',
          message: `Depends on unknown step ${d}`,
        });
    }
    if (s.retry && (s.retry.maxAttempts < 1 || s.retry.maxAttempts > 5 || s.retry.backoffMs < 0)) {
      issues.push({ stepId: s.id, code: 'BAD_RETRY', message: 'retry.maxAttempts must be 1-5' });
    }
    const content =
      s.kind === 'tool'
        ? (s as ToolStep).args
        : s.kind === 'infer'
          ? (s as InferStep).prompt
          : undefined;
    for (const ref of findRefs(content)) {
      if (!transitiveDeps(steps, s.id).has(ref)) {
        issues.push({
          stepId: s.id,
          code: 'BAD_REFERENCE',
          message: `References step ${ref} which it does not depend on`,
        });
      }
    }

    if (s.kind === 'tool') {
      const t = registry.get(s.tool);
      if (!t) {
        issues.push({ stepId: s.id, code: 'UNKNOWN_TOOL', message: `Unknown tool ${s.tool}` });
        continue;
      }
      if (t.distributions && !t.distributions.includes(distribution)) {
        issues.push({
          stepId: s.id,
          code: 'NOT_AVAILABLE',
          message: `${t.name} is not available in this build`,
        });
        continue;
      }
      // Args containing references are validated at execution time after resolution;
      // literal args are validated now against a relaxed schema (refs replaced by placeholders).
      const v = validate(relaxForRefs(t.inputSchema, s.args ?? {}), s.args ?? {});
      if (!v.ok)
        issues.push({ stepId: s.id, code: 'INVALID_ARGS', message: formatIssues(v.issues) });
      normalized.push({
        ...s,
        tool: t.name,
        args: s.args ?? {},
        requiresApproval: s.requiresApproval || t.riskLevel === 'sensitive' || !!t.alwaysAsk,
      });
    } else if (s.kind === 'infer') {
      if (!OPERATIONS.includes(s.operation))
        issues.push({
          stepId: s.id,
          code: 'BAD_OPERATION',
          message: `Unknown operation ${s.operation}`,
        });
      if (!DATA_CLASSES.includes(s.dataClass))
        issues.push({
          stepId: s.id,
          code: 'BAD_DATA_CLASS',
          message: `Unknown data class ${s.dataClass}`,
        });
      if (!s.prompt || !String(s.prompt).trim())
        issues.push({
          stepId: s.id,
          code: 'EMPTY_PROMPT',
          message: 'Inference step has no prompt',
        });
      normalized.push(s);
    } else {
      issues.push({
        stepId: (s as PlanStep).id,
        code: 'UNKNOWN_KIND',
        message: 'Step kind must be "tool" or "infer"',
      });
    }
  }

  const order = topoSort(normalized);
  if (!order) issues.push({ code: 'CYCLE', message: 'Plan dependencies contain a cycle' });
  if (plan.responseStep && !ids.has(plan.responseStep)) {
    issues.push({
      code: 'BAD_RESPONSE_STEP',
      message: `responseStep ${plan.responseStep} does not exist`,
    });
  }

  if (issues.length) return { ok: false, issues };
  return { ok: true, issues, plan: { ...plan, steps: order! } };
}

function transitiveDeps(steps: PlanStep[], id: string): Set<string> {
  const byId = new Map(steps.map(s => [s.id, s]));
  const out = new Set<string>();
  const stack = [...(byId.get(id)?.dependsOn ?? [])];
  while (stack.length) {
    const d = stack.pop()!;
    if (out.has(d)) continue;
    out.add(d);
    stack.push(...(byId.get(d)?.dependsOn ?? []));
  }
  return out;
}

function relaxForRefs(schema: JsonSchema, args: Record<string, unknown>): JsonSchema {
  if (!schema.properties) return schema;
  const props: Record<string, JsonSchema> = {};
  for (const [k, sub] of Object.entries(schema.properties)) {
    const v = args[k];
    props[k] = typeof v === 'string' && v.includes('{{') ? {} : sub;
  }
  return { ...schema, properties: props };
}

/** Kahn's algorithm, stable w.r.t. the original order. Returns null on cycles. */
export function topoSort(steps: PlanStep[]): PlanStep[] | null {
  const indeg = new Map<string, number>();
  const ids = new Set(steps.map(s => s.id));
  for (const s of steps) indeg.set(s.id, (s.dependsOn ?? []).filter(d => ids.has(d)).length);
  const out: PlanStep[] = [];
  const remaining = [...steps];
  while (remaining.length) {
    const i = remaining.findIndex(s => indeg.get(s.id) === 0);
    if (i < 0) return null;
    const [s] = remaining.splice(i, 1);
    out.push(s);
    for (const r of remaining)
      if (r.dependsOn?.includes(s.id)) indeg.set(r.id, (indeg.get(r.id) ?? 1) - 1);
  }
  return out;
}
