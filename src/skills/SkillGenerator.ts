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
import { repairManifest } from './repairManifest';
import { heuristicManifest, manifestFromSpec, specPrompt } from './skillSpec';
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

/**
 * A complete, valid manifest shown to the model. A small model copies a real example far more
 * reliably than it follows a schema written with "a" | "b" alternatives (a test proves it validates).
 */
export const EXAMPLE_MANIFEST = {
  name: 'latest-meeting-actions',
  version: '1.0.0',
  description: 'List the action items from the most recent meeting.',
  permissions: [],
  triggers: [
    { type: 'phrase', phrases: ['what did we agree', 'meeting action items'] },
    { type: 'manual' },
  ],
  steps: [
    { id: 'meeting', tool: 'meetings.latest', args: {} },
    {
      id: 'actions',
      operation: 'extract',
      dataClass: 'personal',
      dependsOn: ['meeting'],
      prompt:
        'List the action items with owner and due date, one per line. If there are none, say so.\n{{steps.meeting.output}}',
    },
  ],
  responseStep: 'actions',
};

export function generatorPrompt(request: string, catalog: string): string {
  return `Tools:
${catalog}

Model operations (steps without a tool): summarize, extract, reason, respond.

Example of a valid skill, for a different request ("what were the action items of my last meeting"):
${JSON.stringify(EXAMPLE_MANIFEST)}

User wants: """${request}"""

Reply with ONE JSON object shaped exactly like the example, for the user's request.
Rules: name is kebab-case; steps use a tool from the list above OR an operation, never both; a later step may use {{steps.<id>.output}} only if it lists that id in dependsOn; list in "permissions" only what the chosen tools need (usually none); triggers may be {"type":"daily","time":"HH:MM"}, {"type":"phrase","phrases":[...]} or {"type":"manual"}; steps that send or change something sensitive need "requiresApproval": true; use the fewest steps.`;
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
    // "Gather data on a schedule and summarize it" needs no model to design: build it directly.
    const direct = heuristicManifest(request, this.tools, this.distribution());
    if (direct) {
      const v = validateManifest(
        withInferredPermissions(direct, this.tools),
        this.tools,
        this.distribution(),
      );
      if (v.ok) return { manifest: v.manifest, issues: [], raw: '' };
    }

    // Then a flat spec from the model; the manifest is assembled in code.
    let raw = await this.ask(specPrompt(request, catalog), 'spec', 300);
    let issues: SkillIssue[] = [];
    const built = manifestFromSpec(extractJson(raw), request, this.tools);
    if (built) {
      const v = validateManifest(
        withInferredPermissions(built, this.tools),
        this.tools,
        this.distribution(),
      );
      if (v.ok) return { manifest: v.manifest, issues: [], raw };
      issues = v.issues;
    }

    // Fall back to a full manifest (needed when tools take specific arguments).
    let prompt = generatorPrompt(request, catalog);
    for (let attempt = 0; attempt < 2; attempt++) {
      raw = await this.ask(prompt, `draft-${attempt}`, 1000);
      const json = extractJson(raw);
      const isObject = !!json && typeof json === 'object' && !Array.isArray(json);
      const fixed = isObject
        ? withInferredPermissions(repairManifest(json, request) as SkillManifest, this.tools)
        : null;
      const v = validateManifest(fixed, this.tools, this.distribution());
      if (v.ok) return { manifest: v.manifest, issues: [], raw };
      issues = isObject
        ? v.issues
        : [{ path: '$', message: 'the reply was not a single JSON object like the example' }];
      prompt = `${generatorPrompt(request, catalog)}\n\nYour previous manifest was rejected:\n${formatSkillIssues(issues)}\nReturn a corrected manifest.`;
    }
    return { issues, raw };
  }

  private async ask(prompt: string, stepId: string, maxTokens: number): Promise<string> {
    const { result } = await this.inference.run(
      {
        executionId: 'skill-generator',
        stepId,
        requirements: { operation: 'plan', structuredOutput: true, complexity: 'medium' },
        dataClass: 'public',
        estimatedInputTokens: Math.ceil(prompt.length / 4),
        estimatedOutputTokens: maxTokens,
        remoteCallsSoFar: 0,
        spendSoFarUsd: 0,
      },
      {
        messages: [
          { role: 'system', content: SYSTEM },
          { role: 'user', content: prompt },
        ],
        maxTokens,
        temperature: 0.2,
        json: true,
      },
    );
    return result.text;
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
