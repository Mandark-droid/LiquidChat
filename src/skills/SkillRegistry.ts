/**
 * Skill registry (PRD §9): install, enable, match, compile, import/export.
 * Imported and generated skills install DISABLED; the user reviews the
 * permissions and steps and enables them explicitly. Downloaded skills are
 * never trusted because of where they came from (PRD §9.5).
 */
import YAML from 'yaml';

import type { Plan } from '../agent/types';
import { fromJson, getDatabase, type Row, type SqlDb } from '../storage/db';
import type { ToolRegistry } from '../tools/ToolRegistry';
import type { Distribution } from '../tools/types';
import { BUILTIN_SKILLS } from './builtin';
import { canonicalJson, sha256Hex } from './sha256';
import { manifestToPlan, resolveInputs, type SkillIssue, validateManifest } from './SkillValidator';
import type { InstalledSkill, SkillBundle, SkillManifest, SkillSource } from './types';

export class SkillError extends Error {
  constructor(
    message: string,
    readonly issues: SkillIssue[] = [],
  ) {
    super(message);
    this.name = 'SkillError';
  }
}

export function hashManifest(m: SkillManifest): string {
  return sha256Hex(canonicalJson(m));
}

/** Accepts JSON or YAML text. */
export function parseManifestText(text: string): unknown {
  const t = text.trim();
  if (t.startsWith('{')) return JSON.parse(t);
  return YAML.parse(t, { maxAliasCount: 0 });
}

export class SkillRegistry {
  constructor(
    private readonly tools: ToolRegistry,
    private readonly distribution: () => Distribution,
    private readonly db: () => Promise<SqlDb> = () => getDatabase(),
  ) {}

  /**
   * Installs/updates the bundled skills; idempotent. Skills whose tools are not
   * available in this build/session (e.g. notification access in a build without
   * the listener) are skipped and reported, not half-installed.
   */
  async installBuiltins(): Promise<{
    installed: string[];
    skipped: { name: string; reason: string }[];
  }> {
    const installed: string[] = [];
    const skipped: { name: string; reason: string }[] = [];
    for (const m of BUILTIN_SKILLS) {
      const existing = await this.getByName(m.name);
      if (existing && existing.manifest.version === m.version) {
        installed.push(m.name);
        continue;
      }
      try {
        // Routines that would raise daily notifications are opt-in: enabling one schedules it.
        const timed = (m.triggers ?? []).some(t => t.type !== 'manual' && t.type !== 'phrase');
        await this.install(m, 'builtin', { enabled: existing?.enabled ?? !timed, replace: true });
        installed.push(m.name);
      } catch (e) {
        skipped.push({
          name: m.name,
          reason: e instanceof SkillError ? e.issues.map(i => i.message).join('; ') : String(e),
        });
      }
    }
    return { installed, skipped };
  }

  async install(
    raw: unknown,
    source: SkillSource,
    opts: { enabled?: boolean; replace?: boolean; publisher?: string } = {},
  ): Promise<InstalledSkill> {
    const v = validateManifest(raw, this.tools, this.distribution());
    if (!v.ok) throw new SkillError('Skill rejected', v.issues);
    const m = v.manifest!;
    const db = await this.db();
    const existing = await this.getByName(m.name);
    if (existing && !opts.replace) throw new SkillError(`A skill named ${m.name} already exists`);
    if (existing?.source === 'builtin' && source !== 'builtin')
      throw new SkillError(`${m.name} is a built-in skill`);
    const now = Date.now();
    const enabled = source === 'builtin' || source === 'user' ? (opts.enabled ?? true) : false;
    const id = existing?.id ?? `skl_${m.name}`;
    const hash = hashManifest(m);
    await db.execute(
      `INSERT INTO skills (id, name, version, manifest_json, enabled, source, publisher, hash, created_at, updated_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
       ON CONFLICT(id) DO UPDATE SET version = excluded.version, manifest_json = excluded.manifest_json,
         enabled = excluded.enabled, source = excluded.source, publisher = excluded.publisher, hash = excluded.hash, updated_at = excluded.updated_at`,
      [
        id,
        m.name,
        m.version,
        JSON.stringify(m),
        enabled ? 1 : 0,
        source,
        opts.publisher ?? m.publisher ?? null,
        hash,
        existing?.createdAt ?? now,
        now,
      ],
    );
    return (await this.get(id))!;
  }

  async get(id: string): Promise<InstalledSkill | null> {
    const db = await this.db();
    const r = await db.execute('SELECT * FROM skills WHERE id = ?', [id]);
    return r.rows[0] ? toSkill(r.rows[0]) : null;
  }

  async getByName(name: string): Promise<InstalledSkill | null> {
    const db = await this.db();
    const r = await db.execute('SELECT * FROM skills WHERE name = ?', [name]);
    return r.rows[0] ? toSkill(r.rows[0]) : null;
  }

  async list(): Promise<InstalledSkill[]> {
    const db = await this.db();
    const r = await db.execute('SELECT * FROM skills ORDER BY source, name');
    return r.rows.map(toSkill);
  }

  async setEnabled(id: string, enabled: boolean): Promise<void> {
    const s = await this.get(id);
    if (!s) throw new SkillError('Skill not found');
    if (enabled) {
      // Re-validate at activation time: tools/permissions may have changed since install.
      const v = validateManifest(s.manifest, this.tools, this.distribution());
      if (!v.ok) throw new SkillError('Skill can no longer be enabled', v.issues);
    }
    const db = await this.db();
    await db.execute('UPDATE skills SET enabled = ?, updated_at = ? WHERE id = ?', [
      enabled ? 1 : 0,
      Date.now(),
      id,
    ]);
  }

  async remove(id: string): Promise<void> {
    const s = await this.get(id);
    if (s?.source === 'builtin')
      throw new SkillError('Built-in skills can be disabled, not removed');
    const db = await this.db();
    await db.execute('DELETE FROM skills WHERE id = ?', [id]);
    await db.execute('DELETE FROM schedules WHERE skill_id = ?', [id]);
  }

  async markRun(id: string): Promise<void> {
    const db = await this.db();
    await db.execute('UPDATE skills SET last_run_at = ? WHERE id = ?', [Date.now(), id]);
  }

  // --- SkillPort ---------------------------------------------------------------

  async match(
    text: string,
    inputs?: Record<string, unknown>,
  ): Promise<{ skillId: string; name: string; plan: Plan } | null> {
    const t = ` ${text
      .toLowerCase()
      .replace(/[^\p{L}\p{N}\s'-]/gu, ' ')
      .replace(/\s+/g, ' ')} `;
    for (const s of await this.list()) {
      if (!s.enabled) continue;
      const byName =
        t.includes(` ${s.manifest.name.replace(/-/g, ' ')} `) && /\b(run|start|do|use)\b/.test(t);
      const byPhrase = (s.manifest.triggers ?? []).some(
        tr =>
          tr.type === 'phrase' &&
          tr.phrases.some(
            p => t.includes(` ${p.toLowerCase()} `) || t.includes(` ${p.toLowerCase()}`),
          ),
      );
      if (byName || byPhrase) {
        const plan = await this.planFor(s.id, inputs);
        if (plan) return { skillId: s.id, name: s.manifest.name, plan };
      }
    }
    return null;
  }

  async planFor(id: string, inputs: Record<string, unknown> = {}): Promise<Plan | null> {
    const s = (await this.get(id)) ?? (await this.getByName(id));
    if (!s || !s.enabled) return null;
    const r = resolveInputs(s.manifest, inputs);
    if (r.issues.length) throw new SkillError('Missing skill inputs', r.issues);
    return manifestToPlan(s.manifest, s.id, r.values);
  }

  // --- import / export (PRD §9.5) ---------------------------------------------------

  async export(id: string): Promise<string> {
    const s = await this.get(id);
    if (!s) throw new SkillError('Skill not found');
    const bundle: SkillBundle = {
      format: 'liquidchat.skill.v1',
      manifest: s.manifest,
      hash: hashManifest(s.manifest),
      publisher: s.publisher,
      exportedAt: new Date().toISOString(),
    };
    return JSON.stringify(bundle, null, 2);
  }

  /** Verifies integrity, validates, and installs DISABLED for review. */
  async import(text: string): Promise<InstalledSkill> {
    let parsed: unknown;
    try {
      parsed = parseManifestText(text);
    } catch (e) {
      throw new SkillError(`Not valid JSON/YAML: ${e instanceof Error ? e.message : String(e)}`);
    }
    const bundle = parsed as Partial<SkillBundle>;
    let manifest: unknown = parsed;
    let publisher: string | undefined;
    if (bundle && bundle.format === 'liquidchat.skill.v1') {
      manifest = bundle.manifest;
      publisher = bundle.publisher;
      if (!bundle.hash || hashManifest(bundle.manifest as SkillManifest) !== bundle.hash) {
        throw new SkillError('Integrity check failed: the skill was modified after export');
      }
    }
    return this.install(manifest, 'imported', { publisher, enabled: false });
  }
}

function toSkill(r: Row): InstalledSkill {
  return {
    id: String(r.id),
    manifest: fromJson<SkillManifest>(r.manifest_json)!,
    enabled: Number(r.enabled) === 1,
    source: String(r.source) as SkillSource,
    publisher: (r.publisher as string) ?? undefined,
    hash: String(r.hash),
    createdAt: Number(r.created_at),
    updatedAt: Number(r.updated_at),
    lastRunAt: r.last_run_at == null ? undefined : Number(r.last_run_at),
  };
}
