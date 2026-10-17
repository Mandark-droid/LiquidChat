import { findForbiddenKeys } from './SkillValidator';

const TOP_KEYS = new Set([
  'name',
  'version',
  'description',
  'publisher',
  'permissions',
  'triggers',
  'inputs',
  'steps',
  'responseStep',
]);
const STEP_KEYS = new Set([
  'id',
  'description',
  'tool',
  'args',
  'operation',
  'prompt',
  'dataClass',
  'outputSchema',
  'dependsOn',
  'requiresApproval',
  'timeoutMs',
]);

const OPERATIONS = new Set(['summarize', 'reason', 'extract', 'respond', 'classify']);

const isPlainObject = (v: unknown): v is Record<string, unknown> =>
  !!v && typeof v === 'object' && !Array.isArray(v);

export function slugify(text: string): string {
  const words = text
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, ' ')
    .trim()
    .split(' ')
    .filter(Boolean)
    .slice(0, 4);
  const slug = words.join('-').slice(0, 40).replace(/-+$/g, '');
  if (!slug) return 'my-skill';
  const named = /^[a-z]/.test(slug) ? slug : `skill-${slug}`;
  return named.length >= 3 ? named : 'my-skill';
}

/**
 * Small models routinely omit the boring fields (name, description, empty args, step ids) or add
 * stray keys. Fill those in deterministically so one slip does not throw away a good plan. This only
 * adds defaults and drops unknown keys: tools, permissions and executable-content checks still run
 * afterwards, and a manifest that contains forbidden keys is returned untouched so it is rejected.
 */
export function repairManifest(raw: unknown, request: string): unknown {
  if (!isPlainObject(raw) || findForbiddenKeys(raw).length) return raw;
  const m: Record<string, unknown> = {};
  for (const [k, v] of Object.entries(raw)) if (TOP_KEYS.has(k)) m[k] = v;

  const rawName = typeof m.name === 'string' ? m.name.trim() : '';
  m.name = /^[a-z][a-z0-9-]{2,48}$/.test(rawName) ? rawName : slugify(rawName || request);
  if (typeof m.description !== 'string' || m.description.trim().length < 3)
    m.description = request.trim().slice(0, 300) || 'Custom skill';
  if (!Array.isArray(m.triggers) || !m.triggers.length) m.triggers = [{ type: 'manual' }];
  // Real permissions are inferred from the chosen tools afterwards; drop names the model invented.
  m.permissions = Array.isArray(m.permissions)
    ? m.permissions.filter(
        p => typeof p === 'string' && /^(android\.permission\.[A-Z_]+|special:[a-z_]+)$/.test(p),
      )
    : [];

  if (Array.isArray(m.steps)) {
    m.steps = m.steps.map((s, i) => {
      if (!isPlainObject(s)) return s;
      const step: Record<string, unknown> = {};
      for (const [k, v] of Object.entries(s)) if (STEP_KEYS.has(k)) step[k] = v;
      if (typeof step.id !== 'string' || !/^[a-zA-Z0-9_-]{1,40}$/.test(step.id))
        step.id = `step${i + 1}`;
      // "tool": "summarize" is a model step written with the wrong key.
      if (
        typeof step.tool === 'string' &&
        !step.operation &&
        OPERATIONS.has(step.tool.toLowerCase())
      ) {
        step.operation = step.tool.toLowerCase();
        delete step.tool;
        delete step.args;
      }
      if (step.operation && !step.dataClass) step.dataClass = 'personal';
      if (step.tool && !isPlainObject(step.args)) step.args = {};
      if (step.dependsOn !== undefined && !Array.isArray(step.dependsOn)) delete step.dependsOn;
      return step;
    });
    const steps = m.steps as Record<string, unknown>[];
    const last = steps[steps.length - 1];
    const ids = new Set(steps.map(s => (isPlainObject(s) ? s.id : undefined)));
    if (
      isPlainObject(last) &&
      last.operation &&
      (typeof m.responseStep !== 'string' || !ids.has(m.responseStep))
    )
      m.responseStep = last.id;
  }
  return m;
}
