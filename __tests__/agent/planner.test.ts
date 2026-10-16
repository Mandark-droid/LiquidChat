import { looksMultiStep, normalizePlan } from '../../src/agent/AgentPlanner';
import { parseToolCalls } from '../../src/utils/toolParser';
import { makeHarness, toolCallsText } from '../helpers/harness';

describe('planner fast path (parity with the legacy chat path)', () => {
  const legacyOutputs = [
    '<start_function_call>call:set_alarm{hour:<escape>[7]</escape>,minutes:<escape>[30]</escape>}<end_function_call>',
    toolCallsText([{ name: 'turn_on_flashlight', arguments: {} }]),
    '```json\n{"name": "set_volume", "arguments": {"stream": "media", "level": 40}}\n```',
  ];

  it.each(legacyOutputs)('produces the same tool calls the legacy parser would: %s', async text => {
    const h = makeHarness({ responder: () => ({ text }) });
    const out = await h.planner.plan({ text: 'do it', source: 'chat' }, { executionId: 'e' });
    const legacy = parseToolCalls(text);
    expect(out.kind).toBe('plan');
    if (out.kind !== 'plan') return;
    expect(out.plan.source).toBe('fastpath');
    expect(out.plan.steps.map(s => (s.kind === 'tool' ? s.tool : ''))).toEqual(
      legacy.map(c => c.name),
    );
  });

  it('uses Cactus native functionCalls when the text has none', async () => {
    const h = makeHarness({
      responder: () => ({
        text: '',
        functionCalls: [{ name: 'toggle_bluetooth', arguments: { enable: true } }],
      }),
    });
    const out = await h.planner.plan(
      { text: 'bluetooth on', source: 'chat' },
      { executionId: 'e' },
    );
    expect(out.kind === 'plan' && out.plan.steps[0]).toMatchObject({
      tool: 'toggle_bluetooth',
      args: { enable: true },
    });
  });

  it('returns a direct answer when no tool is called', async () => {
    const h = makeHarness({ responder: () => ({ text: 'Paris is the capital of France.' }) });
    const out = await h.planner.plan(
      { text: 'capital of France?', source: 'chat' },
      { executionId: 'e' },
    );
    expect(out).toEqual({ kind: 'answer', text: 'Paris is the capital of France.' });
  });

  it('rejects a hallucinated tool from the fast path instead of running it', async () => {
    const h = makeHarness({
      responder: () => ({
        text: toolCallsText([{ name: 'wire_money', arguments: { amount: 1000 } }]),
      }),
    });
    const out = await h.planner.plan({ text: 'pay', source: 'chat' }, { executionId: 'e' });
    expect(out.kind).toBe('invalid');
  });
});

describe('multi-step planner', () => {
  it('detects multi-step requests', () => {
    expect(looksMultiStep('Turn on DND and then set a timer for 30 minutes')).toBe(true);
    expect(looksMultiStep('summarize my notifications and draft replies')).toBe(true);
    expect(looksMultiStep('turn on the flashlight')).toBe(false);
  });

  it('repairs an invalid plan once using the validator issues', async () => {
    const prompts: string[] = [];
    let n = 0;
    const h = makeHarness({
      responder: (_c, req) => {
        prompts.push(req.messages.at(-1)!.content);
        return n++ === 0
          ? {
              text: '{"goal":"x","steps":[{"id":"s1","kind":"tool","tool":"set_volume","args":{"level":500}}]}',
            }
          : {
              text: '{"goal":"x","steps":[{"id":"s1","kind":"tool","tool":"set_volume","args":{"level":50}},{"id":"s2","kind":"tool","tool":"set_timer","args":{"seconds":60},"dependsOn":["s1"]}]}',
            };
      },
    });
    const out = await h.planner.planWithModel(
      { text: 'volume half and then a timer', source: 'chat' },
      { executionId: 'e' },
    );
    expect(out.kind).toBe('plan');
    expect(prompts[1]).toContain('was rejected');
    expect(prompts[1]).toContain('must be <= 100');
  });

  it('normalizes common model deviations', () => {
    const p = normalizePlan(
      {
        plan: [
          { type: 'tool', name: 'go_home', arguments: {} },
          { operation: 'respond', instruction: 'say done', depends_on: ['s1'] },
        ],
      },
      'g',
    );
    expect(p!.steps).toEqual([
      { id: 's1', kind: 'tool', tool: 'go_home', args: {}, dependsOn: [] },
      {
        id: 's2',
        kind: 'infer',
        operation: 'respond',
        prompt: 'say done',
        dataClass: 'personal',
        dependsOn: ['s1'],
      },
    ]);
  });
});
