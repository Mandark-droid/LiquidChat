import { toMobileActionsSchema, validate } from '../../src/tools/schema';
import type { JsonSchema } from '../../src/tools/types';

const s: JsonSchema = {
  type: 'object',
  properties: {
    to: { type: 'string', format: 'email' },
    level: { type: 'number', minimum: 0, maximum: 100 },
    stream: { type: 'string', enum: ['media', 'ring'], default: 'media' },
    enable: { type: 'boolean' },
    when: { type: 'string', format: 'date' },
  },
  required: ['to', 'level'],
  additionalProperties: false,
};

describe('schema validator', () => {
  it('accepts valid input, applies defaults and coerces numeric/boolean strings', () => {
    const r = validate(s, { to: 'a@b.co', level: '40', enable: 'true' });
    expect(r.ok).toBe(true);
    expect(r.value).toEqual({ to: 'a@b.co', level: 40, stream: 'media', enable: true });
  });

  it('reports every problem with a path', () => {
    const r = validate(s, { to: 'nope', level: 140, stream: 'x', extra: 1, when: '24 Oct' });
    expect(r.ok).toBe(false);
    const paths = r.issues.map(i => i.path).sort();
    expect(paths).toEqual(['$.extra', '$.level', '$.stream', '$.to', '$.when']);
  });

  it('requires required fields', () => {
    expect(validate(s, {}).issues.map(i => i.path)).toEqual(['$.to', '$.level']);
  });

  it('rejects non-objects', () => {
    expect(validate(s, 'hi').ok).toBe(false);
    expect(validate(s, null).ok).toBe(false);
  });

  it('renders the mobile-actions dialect for the fine-tuned model', () => {
    expect(toMobileActionsSchema(s)).toMatchObject({
      type: 'OBJECT',
      properties: { level: { type: 'NUMBER' } },
      required: ['to', 'level'],
    });
  });
});
