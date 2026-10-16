/**
 * Skill validation (PRD §9.3–9.5). A skill is rejected when it:
 *  - is not a well-formed manifest, or carries executable fields (code, script …)
 *  - uses tools that need permissions it did not declare (escalation)
 *  - has a sensitive step without explicit requiresApproval
 *  - compiles to a plan the PlanValidator rejects
 */
import { validatePlan } from '../agent/PlanValidator';
import type { Plan, PlanStep } from '../agent/types';
import { formatIssues, validate } from '../tools/schema';
import type { ToolRegistry } from '../tools/ToolRegistry';
import type { Distribution, JsonSchema } from '../tools/types';
import type { SkillManifest, SkillStep } from './types';

export interface SkillIssue {
  path: string;
  message: string;
}

const FORBIDDEN_KEYS =
  /^(code|script|scripts|js|javascript|eval|exec|shell|command|cmd|function|import|require|download|install|binary|wasm)$/i;

const STEP_SCHEMA: JsonSchema = {
  type: 'object',
  properties: {
    id: { type: 'string', pattern: '^[a-zA-Z0-9_-]{1,40}$' },
    description: { type: 'string', maxLength: 300 },
    tool: { type: 'string', pattern: '^[a-z][a-z0-9_.]*$' },
    args: { type: 'object' },
    operation: { type: 'string', enum: ['summarize', 'reason', 'extract', 'respond', 'classify'] },
    prompt: { type: 'string', maxLength: 4000 },
    dataClass: { type: 'string', enum: ['public', 'personal', 'sensitive'] },
    outputSchema: { type: 'object' },
    dependsOn: { type: 'array', items: { type: 'string' } },
    requiresApproval: { type: 'boolean' },
    timeoutMs: { type: 'integer', minimum: 100, maximum: 120000 },
  },
  required: ['id'],
  additionalProperties: false,
};

export const MANIFEST_SCHEMA: JsonSchema = {
  type: 'object',
  properties: {
    name: { type: 'string', pattern: '^[a-z][a-z0-9-]{2,48}$' },
    version: { type: 'string', pattern: '^\\d+\\.\\d+\\.\\d+$' },
    description: { type: 'string', minLength: 3, maxLength: 500 },
    publisher: { type: 'string', maxLength: 100 },
    permissions: {
      type: 'array',
      items: { type: 'string', pattern: '^(android\\.permission\\.[A-Z_]+|special:[a-z_]+)$' },
    },
    triggers: { type: 'array', items: { type: 'object' } },
    inputs: { type: 'object' },
    steps: { type: 'array', items: STEP_SCHEMA },
    responseStep: { type: 'string' },
  },
  required: ['name', 'version', 'description', 'permissions', 'steps'],
  additionalProperties: false,
};

export function findForbiddenKeys(v: unknown, path = '$'): string[] {
  const out: string[] = [];
  if (Array.isArray(v)) v.forEach((x, i) => out.push(...findForbiddenKeys(x, `${path}[${i}]`)));
  else if (v && typeof v === 'object') {
    for (const [k, x] of Object.entries(v)) {
      // Tool *arguments* may legitimately be named e.g. "command" by an MCP tool — only flag structural keys.
      if (FORBIDDEN_KEYS.test(k) && !path.includes('.args')) out.push(`${path}.${k}`);
      out.push(...findForbiddenKeys(x, `${path}.${k}`));
    }
  }
  return out;
}

function validateTriggers(m: SkillManifest, issues: SkillIssue[]) {
  (m.triggers ?? []).forEach((t, i) => {
    const p = `$.triggers[${i}]`;
    switch (t?.type) {
      case 'manual':
        break;
      case 'phrase':
        if (
          !Array.isArray(t.phrases) ||
          !t.phrases.length ||
          t.phrases.some(x => typeof x !== 'string' || x.length < 3)
        ) {
          issues.push({ path: p, message: 'phrase trigger needs phrases (≥3 chars)' });
        }
        break;
      case 'daily':
        if (!/^([01]\d|2[0-3]):[0-5]\d$/.test(t.time))
          issues.push({ path: p, message: 'daily trigger needs time HH:MM' });
        if (t.days && t.days.some(d => !Number.isInteger(d) || d < 0 || d > 6))
          issues.push({ path: p, message: 'days must be 0-6' });
        break;
      case 'interval':
        if (!Number.isInteger(t.minutes) || t.minutes < 15)
          issues.push({ path: p, message: 'interval must be ≥ 15 minutes' });
        break;
      case 'once':
        if (isNaN(Date.parse(t.at)))
          issues.push({ path: p, message: 'once trigger needs an ISO date-time' });
        break;
      default:
        issues.push({ path: p, message: 'unknown trigger type' });
    }
  });
}

/** Substitutes {{inputs.x}} placeholders. */
export function applyInputs<T>(v: T, inputs: Record<string, unknown>): T {
  const visit = (x: unknown): unknown => {
    if (typeof x === 'string') {
      const whole = x.match(/^\{\{\s*inputs\.([a-zA-Z0-9_]+)\s*\}\}$/);
      if (whole) return inputs[whole[1]];
      return x.replace(/\{\{\s*inputs\.([a-zA-Z0-9_]+)\s*\}\}/g, (_m, k: string) =>
        String(inputs[k] ?? ''),
      );
    }
    if (Array.isArray(x)) return x.map(visit);
    if (x && typeof x === 'object')
      return Object.fromEntries(Object.entries(x).map(([k, y]) => [k, visit(y)]));
    return x;
  };
  return visit(v) as T;
}

export function resolveInputs(
  m: SkillManifest,
  given: Record<string, unknown> = {},
): { values: Record<string, unknown>; issues: SkillIssue[] } {
  const values: Record<string, unknown> = {};
  const issues: SkillIssue[] = [];
  for (const [k, spec] of Object.entries(m.inputs ?? {})) {
    const v = given[k] ?? spec.default;
    if (v === undefined) {
      if (spec.required) issues.push({ path: `$.inputs.${k}`, message: 'is required' });
      continue;
    }
    if (typeof v !== spec.type)
      issues.push({ path: `$.inputs.${k}`, message: `must be a ${spec.type}` });
    values[k] = v;
  }
  return { values, issues };
}

export function stepToPlanStep(s: SkillStep): PlanStep {
  if (s.tool) {
    return {
      id: s.id,
      kind: 'tool',
      tool: s.tool,
      args: s.args ?? {},
      dependsOn: s.dependsOn,
      requiresApproval: s.requiresApproval,
      timeoutMs: s.timeoutMs,
      description: s.description,
    };
  }
  return {
    id: s.id,
    kind: 'infer',
    operation: s.operation ?? 'respond',
    prompt: s.prompt ?? '',
    dataClass: s.dataClass ?? 'personal',
    outputSchema: s.outputSchema,
    dependsOn: s.dependsOn,
    description: s.description,
  };
}

export function manifestToPlan(
  m: SkillManifest,
  skillId: string,
  inputs: Record<string, unknown> = {},
): Plan {
  const steps = applyInputs(m.steps, inputs).map(stepToPlanStep);
  return { goal: m.description, steps, source: 'skill', skillId, responseStep: m.responseStep };
}

export function validateManifest(
  raw: unknown,
  registry: ToolRegistry,
  distribution: Distribution,
): { ok: boolean; issues: SkillIssue[]; manifest?: SkillManifest } {
  const issues: SkillIssue[] = [];
  for (const p of findForbiddenKeys(raw))
    issues.push({ path: p, message: 'executable content is not allowed in skills' });
  const v = validate<SkillManifest>(MANIFEST_SCHEMA, raw);
  if (!v.ok) {
    issues.push(...v.issues.map(i => ({ path: i.path, message: i.message })));
    return { ok: false, issues };
  }
  const m = v.value!;
  if (!m.steps.length) issues.push({ path: '$.steps', message: 'needs at least one step' });
  validateTriggers(m, issues);

  const declared = new Set<string>(m.permissions);
  m.steps.forEach((s, i) => {
    const p = `$.steps[${i}]`;
    if (!!s.tool === !!s.operation)
      issues.push({ path: p, message: 'a step has exactly one of "tool" or "operation"' });
    if (s.operation && !s.prompt)
      issues.push({ path: p, message: 'operation steps need a prompt' });
    if (!s.tool) return;
    const tool = registry.get(s.tool);
    if (!tool) {
      issues.push({ path: `${p}.tool`, message: `unknown tool ${s.tool}` });
      return;
    }
    for (const perm of tool.requiredPermissions) {
      if (perm !== 'special:network' && !declared.has(perm)) {
        issues.push({
          path: `${p}.tool`,
          message: `${s.tool} needs permission ${perm}, which the skill does not declare`,
        });
      }
    }
    if ((tool.riskLevel === 'sensitive' || tool.alwaysAsk) && s.requiresApproval !== true) {
      issues.push({
        path: `${p}.requiresApproval`,
        message: `${s.tool} is sensitive and must set requiresApproval: true`,
      });
    }
  });
  if (issues.length) return { ok: false, issues };

  // Placeholder inputs so plan validation sees well-typed args.
  const dummy: Record<string, unknown> = {};
  for (const [k, spec] of Object.entries(m.inputs ?? {})) {
    // '{{deferred}}' is treated as a late-bound value by the plan validator (like a step reference).
    dummy[k] =
      spec.default ??
      (spec.type === 'number' ? 1 : spec.type === 'boolean' ? true : '{{deferred}}');
  }
  const pv = validatePlan(manifestToPlan(m, 'validation', dummy), registry, distribution);
  if (!pv.ok)
    issues.push(
      ...pv.issues.map(i => ({
        path: `$.steps${i.stepId ? `(${i.stepId})` : ''}`,
        message: i.message,
      })),
    );
  return issues.length ? { ok: false, issues } : { ok: true, issues, manifest: m };
}

export function formatSkillIssues(issues: SkillIssue[]): string {
  return issues.map(i => `${i.path}: ${i.message}`).join('\n');
}

export { formatIssues };
