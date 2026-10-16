import { topoSort, validatePlan } from '../../src/agent/PlanValidator';
import type { Plan } from '../../src/agent/types';
import { makeHarness } from '../helpers/harness';

describe('plan validation', () => {
  const h = makeHarness();
  const v = (plan: Partial<Plan>, dist: 'play' | 'full' = 'full') =>
    validatePlan({ goal: 'g', source: 'planner', steps: [], ...plan } as Plan, h.registry, dist);

  it('accepts a valid multi-step plan and orders it topologically', () => {
    const r = v({
      steps: [
        {
          id: 'b',
          kind: 'tool',
          tool: 'set_volume',
          args: { stream: 'ring', level: 0 },
          dependsOn: ['a'],
        },
        { id: 'a', kind: 'tool', tool: 'toggle_dnd', args: { enable: true } },
      ],
    });
    expect(r.ok).toBe(true);
    expect(r.plan!.steps.map(s => s.id)).toEqual(['a', 'b']);
  });

  it.each([
    ['empty', { steps: [] }, 'EMPTY'],
    [
      'unknown tool',
      { steps: [{ id: 'a', kind: 'tool', tool: 'rm_rf', args: {} }] },
      'UNKNOWN_TOOL',
    ],
    [
      'bad args',
      { steps: [{ id: 'a', kind: 'tool', tool: 'set_volume', args: { level: 999 } }] },
      'INVALID_ARGS',
    ],
    [
      'cycle',
      {
        steps: [
          { id: 'a', kind: 'tool', tool: 'toggle_dnd', args: { enable: true }, dependsOn: ['b'] },
          { id: 'b', kind: 'tool', tool: 'toggle_dnd', args: { enable: false }, dependsOn: ['a'] },
        ],
      },
      'CYCLE',
    ],
    [
      'dangling dependency',
      {
        steps: [
          { id: 'a', kind: 'tool', tool: 'toggle_dnd', args: { enable: true }, dependsOn: ['zz'] },
        ],
      },
      'BAD_DEPENDENCY',
    ],
    [
      'reference to non-dependency',
      {
        steps: [
          { id: 'a', kind: 'tool', tool: 'meetings.latest', args: {} },
          {
            id: 'b',
            kind: 'infer',
            operation: 'summarize',
            prompt: 'sum {{steps.a.output}}',
            dataClass: 'personal',
          },
        ],
      },
      'BAD_REFERENCE',
    ],
    [
      'duplicate ids',
      {
        steps: [
          { id: 'a', kind: 'tool', tool: 'go_home', args: {} },
          { id: 'a', kind: 'tool', tool: 'go_home', args: {} },
        ],
      },
      'DUPLICATE_ID',
    ],
    [
      'bad operation',
      { steps: [{ id: 'a', kind: 'infer', operation: 'hack', prompt: 'x', dataClass: 'public' }] },
      'BAD_OPERATION',
    ],
    [
      'too many steps',
      {
        steps: Array.from({ length: 13 }, (_, i) => ({
          id: `s${i}`,
          kind: 'tool',
          tool: 'go_home',
          args: {},
        })),
      },
      'TOO_MANY_STEPS',
    ],
  ] as [string, Partial<Plan>, string][])('rejects %s', (_n, plan, code) => {
    const r = v(plan);
    expect(r.ok).toBe(false);
    expect(r.issues.map(i => i.code)).toContain(code);
  });

  it('marks sensitive and always-ask tools as requiring approval even if the model said otherwise', () => {
    const r = v({
      steps: [
        {
          id: 'a',
          kind: 'tool',
          tool: 'tap_element',
          args: { target: 'Pay' },
          requiresApproval: false,
        },
        { id: 'b', kind: 'tool', tool: 'send_email', args: { to: 'a@b.co', subject: 'hi' } },
      ],
    });
    expect(r.ok).toBe(true);
    expect(r.plan!.steps.every(s => s.requiresApproval)).toBe(true);
  });

  it('rejects Accessibility automation in the Play flavor', () => {
    const r = v({ steps: [{ id: 'a', kind: 'tool', tool: 'read_screen', args: {} }] }, 'play');
    expect(r.issues.map(i => i.code)).toContain('NOT_AVAILABLE');
  });

  it('defers validation of templated args to execution time', () => {
    const r = v({
      steps: [
        { id: 'a', kind: 'tool', tool: 'dates.resolve', args: { phrase: 'next thursday' } },
        {
          id: 'b',
          kind: 'tool',
          tool: 'tasks.add',
          args: { title: 'Send deck', due: '{{steps.a.output.date}}' },
          dependsOn: ['a'],
        },
      ],
    });
    expect(r.ok).toBe(true);
  });

  it('topoSort returns null on cycles', () => {
    expect(
      topoSort([
        { id: 'a', kind: 'tool', tool: 'x', args: {}, dependsOn: ['b'] },
        { id: 'b', kind: 'tool', tool: 'x', args: {}, dependsOn: ['a'] },
      ]),
    ).toBeNull();
  });
});
