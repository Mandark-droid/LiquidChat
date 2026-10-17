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

describe('lifting scalars to arrays (small-model output)', () => {
  const schema = {
    type: 'object',
    properties: {
      repo_types: { type: 'array', items: { type: 'string', enum: ['model', 'dataset', 'space'] } },
      tags: { type: 'array', items: { type: 'string' } },
      ids: { type: 'array', items: { type: 'number' } },
    },
  } as never;

  it('wraps a single enum value and splits a comma list', () => {
    expect(validate(schema, { repo_types: 'model' }).value).toEqual({ repo_types: ['model'] });
    expect(validate(schema, { repo_types: 'model, dataset' }).value).toEqual({
      repo_types: ['model', 'dataset'],
    });
  });
  it('parses a JSON array sent as text', () => {
    expect(validate(schema, { tags: '["a","b"]' }).value).toEqual({ tags: ['a', 'b'] });
  });
  it('keeps free-text commas inside one item', () => {
    expect(validate(schema, { tags: 'fast, small' }).value).toEqual({ tags: ['fast, small'] });
  });
  it('still rejects values that cannot be a list', () => {
    expect(validate(schema, { repo_types: 'robot' }).ok).toBe(false);
    expect(validate(schema, { ids: 'abc' }).ok).toBe(false);
    expect(validate(schema, { tags: { a: 1 } }).ok).toBe(false);
  });
});

describe('tolerant parsing of small-model arguments', () => {
  const schema = {
    type: 'object',
    properties: {
      repo_types: { type: 'array', items: { type: 'string', enum: ['model', 'dataset', 'space'] } },
      limit: { type: 'integer' },
      sort: { type: 'string', enum: ['downloads', 'likes'] },
    },
  } as never;

  it('accepts the exact malformed call seen from LFM2.5-1.2B', () => {
    const r = validate(schema, { repo_types: "['model'", limit: '5', sort: 'Downloads' });
    expect(r.ok).toBe(true);
    expect(r.value).toEqual({ repo_types: ['model'], limit: 5, sort: 'downloads' });
  });
  it('reads quoted, unterminated and unquoted lists', () => {
    expect(validate(schema, { repo_types: '["model", "dataset"' }).value).toEqual({
      repo_types: ['model', 'dataset'],
    });
    expect(validate(schema, { repo_types: '[model, space]' }).value).toEqual({
      repo_types: ['model', 'space'],
    });
  });
  it('matches enum words ignoring case and a plural s', () => {
    expect(validate(schema, { repo_types: ['Models', 'DATASETS'] }).value).toEqual({
      repo_types: ['model', 'dataset'],
    });
  });
  it('still rejects an unknown enum word', () => {
    expect(validate(schema, { repo_types: ['LFM2'] }).ok).toBe(false);
  });
});
