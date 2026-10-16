/**
 * Natural-language skill creation (PRD §9.4): the model drafts a manifest,
 * the validator checks it, and the user reviews it before activation.
 * Nothing generated can contain code — only allowlisted tools and model steps.
 */
import type { InferenceRunner } from '../agent/ports';
import type { Plan } from '../agent/types';
import { extractJson } from '../meetings/MinutesGenerator';
import type { ToolRegistry } from '../tools/ToolRegistry';
import type { Distribution, PermissionId } from '../tools/types';
import { formatSkillIssues, type SkillIssue, validateManifest } from './SkillValidator';
import type { SkillManifest, SkillStep } from './types';

export interface DraftResult {
  manifest?: SkillManifest;
  issues: SkillIssue[];
  raw: string;
}

const SYSTEM =
  'You design automation "skills" for a privacy-first Android assistant as declarative JSON manifests. ' +
  'You can only use the listed tools and model operations. Never include code. Reply with JSON only.';

export function generatorPrompt(request: string, catalog: string): string {
  return `Tools:
${catalog}

Model operations (steps without a tool): summarize, extract, reason, respond.

User wants: """${request}"""

Return a manifest:
{"name": "kebab-case-name", "version": "1.0.0", "description": "...",
 "permissions": ["special:notification_listener" | "special:notification_policy" | ... only those the tools need],
 "triggers": [{"type": "daily", "time": "08:00"} | {"type": "phrase", "phrases": ["..."]} | {"type": "manual"}],
 "steps": [
   {"id": "a", "tool": "<tool>", "args": {...}},
   {"id": "b", "operation": "summarize", "prompt": "... {{steps.a.output}}", "dataClass": "personal", "dependsOn": ["a"]}
 ],
 "responseStep": "b"}
Rules: steps that change something sensitive need "requiresApproval": true; reference only outputs of steps in dependsOn; keep it to the fewest steps.`;
}

export class SkillGenerator {
  constructor(
    private readonly tools: ToolRegistry,
    private readonly inference: InferenceRunner,
    private readonly distribution: () => Distribution,
  ) {}

  async draft(request: string): Promise<DraftResult> {
    const relevant = this.tools.relevant(request, 10, this.distribution());
    const catalog = this.tools.catalog(
      relevant.length
        ? relevant
        : this.tools.list({ distribution: this.distribution() }).slice(0, 15),
    );
    let prompt = generatorPrompt(request, catalog);
    let raw = '';
    let issues: SkillIssue[] = [];
    for (let attempt = 0; attempt < 2; attempt++) {
      const { result } = await this.inference.run(
        {
          executionId: 'skill-generator',
          stepId: `draft-${attempt}`,
          requirements: { operation: 'plan', structuredOutput: true, complexity: 'medium' },
          dataClass: 'public',
          estimatedInputTokens: Math.ceil(prompt.length / 4),
          estimatedOutputTokens: 800,
          remoteCallsSoFar: 0,
          spendSoFarUsd: 0,
        },
        {
          messages: [
            { role: 'system', content: SYSTEM },
            { role: 'user', content: prompt },
          ],
          maxTokens: 1000,
          temperature: 0.2,
          json: true,
        },
      );
      raw = result.text;
      const json = extractJson(raw);
      const fixed = json ? withInferredPermissions(json as SkillManifest, this.tools) : null;
      const v = validateManifest(fixed, this.tools, this.distribution());
      if (v.ok) return { manifest: v.manifest, issues: [], raw };
      issues = v.issues;
      prompt = `${generatorPrompt(request, catalog)}\n\nYour previous manifest was rejected:\n${formatSkillIssues(issues)}\nReturn a corrected manifest.`;
    }
    return { issues, raw };
  }
}

/** Declares exactly the permissions the chosen tools require (the user still reviews them). */
export function withInferredPermissions(m: SkillManifest, tools: ToolRegistry): SkillManifest {
  if (!m || typeof m !== 'object' || !Array.isArray(m.steps)) return m;
  const perms = new Set<PermissionId>((m.permissions ?? []).filter(p => typeof p === 'string'));
  for (const s of m.steps) {
    const t = s?.tool ? tools.get(s.tool) : undefined;
    t?.requiredPermissions.filter(p => p !== 'special:network').forEach(p => perms.add(p));
  }
  return { ...m, version: m.version ?? '1.0.0', permissions: [...perms] };
}

/** "Save as skill" for an ad-hoc plan that worked (PRD §21 step 12). */
export function planToManifest(
  plan: Plan,
  name: string,
  description: string,
  tools: ToolRegistry,
): SkillManifest {
  const steps: SkillStep[] = plan.steps.map(s =>
    s.kind === 'tool'
      ? {
          id: s.id,
          tool: s.tool,
          args: s.args,
          dependsOn: s.dependsOn,
          requiresApproval: s.requiresApproval || undefined,
        }
      : {
          id: s.id,
          operation: s.operation === 'plan' ? 'reason' : s.operation,
          prompt: s.prompt,
          dataClass: s.dataClass,
          outputSchema: s.outputSchema,
          dependsOn: s.dependsOn,
        },
  );
  const slug =
    name
      .toLowerCase()
      .replace(/[^a-z0-9]+/g, '-')
      .replace(/^-+|-+$/g, '')
      .slice(0, 40) || 'my-skill';
  return withInferredPermissions(
    {
      name: /^[a-z]/.test(slug) ? slug : `skill-${slug}`,
      version: '1.0.0',
      description: description.slice(0, 500) || plan.goal.slice(0, 500),
      permissions: [],
      triggers: [{ type: 'manual' }],
      steps,
      responseStep: plan.responseStep,
    },
    tools,
  );
}
