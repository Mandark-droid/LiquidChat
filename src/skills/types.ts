/**
 * Skill manifest (PRD §9.2): declarative, allowlisted operations only — no
 * scripts, code or downloads. A skill compiles to an ordinary Plan and runs
 * through the same controller, validator and permission gateway as any request.
 */
import type { DataClass, InferOperation } from '../inference/types';
import type { JsonSchema, PermissionId } from '../tools/types';

export type SkillTrigger =
  | { type: 'manual' }
  | { type: 'phrase'; phrases: string[] }
  | { type: 'daily'; time: string; days?: number[] }
  | { type: 'interval'; minutes: number }
  | { type: 'once'; at: string };

export interface SkillInput {
  type: 'string' | 'number' | 'boolean';
  description?: string;
  required?: boolean;
  default?: string | number | boolean;
}

export interface SkillStep {
  id: string;
  description?: string;
  /** Tool step */
  tool?: string;
  args?: Record<string, unknown>;
  /** Inference step */
  operation?: InferOperation;
  prompt?: string;
  dataClass?: DataClass;
  outputSchema?: JsonSchema;
  dependsOn?: string[];
  requiresApproval?: boolean;
  timeoutMs?: number;
}

export interface SkillManifest {
  name: string;
  version: string;
  description: string;
  publisher?: string;
  permissions: PermissionId[];
  triggers?: SkillTrigger[];
  inputs?: Record<string, SkillInput>;
  steps: SkillStep[];
  /** Step whose output is the reply (defaults to the last respond/summarize step). */
  responseStep?: string;
}

export type SkillSource = 'builtin' | 'user' | 'generated' | 'imported';

export interface InstalledSkill {
  id: string;
  manifest: SkillManifest;
  enabled: boolean;
  source: SkillSource;
  publisher?: string;
  hash: string;
  createdAt: number;
  updatedAt: number;
  lastRunAt?: number;
}

export interface SkillBundle {
  format: 'liquidchat.skill.v1';
  manifest: SkillManifest;
  hash: string;
  publisher?: string;
  exportedAt: string;
}
