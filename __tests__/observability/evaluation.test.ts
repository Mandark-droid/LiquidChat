import type { AgentRequest, Plan, PlanStep } from '../../src/agent/types';
import {
  EVAL_CASES,
  type EvalCase,
  evalCases,
  EVALSET_REFERENCE_DATE,
  MOBILE_TOOL_NAMES,
} from '../../src/observability/evalset';
import {
  argMatches,
  type EvalPlanner,
  listEvalRuns,
  runEvaluation,
  scoreCase,
} from '../../src/observability/EvaluationRunner';
import { getDatabase, resetDatabaseForTests } from '../../src/storage/db';
import { MOBILE_ACTION_TOOLS } from '../../src/tools/registry';

const REF = new Date(EVALSET_REFERENCE_DATE);

beforeEach(() => {
  resetDatabaseForTests();
  (require('@op-engineering/op-sqlite') as any).__resetAll();
});

function plan(calls: { name: string; args?: Record<string, unknown> }[]): Plan {
  const steps: PlanStep[] = calls.map((c, i) => ({
    id: `step_${i + 1}`,
    kind: 'tool',
    tool: c.name,
    args: c.args ?? {},
  }));
  return { goal: 'eval', steps, source: 'planner' };
}

/** Turns an expected arg (possibly a matcher) into a concrete value a model might emit. */
function concrete(v: unknown): unknown {
  if (v && typeof v === 'object' && !Array.isArray(v)) {
    const m = v as Record<string, unknown>;
    if ('$contains' in m) return `  ${String(m.$contains).toUpperCase()} please `;
    if ('$digits' in m) return `+${m.$digits}`;
    if ('$oneOf' in m) return (m.$oneOf as unknown[])[0];
    if ('$approx' in m) return m.$approx;
    if ('$day' in m) return m.$day;
    if ('$any' in m) return 'x';
  }
  if (typeof v === 'boolean') return String(v); // 'true'/'false' must normalize
  if (typeof v === 'number') return String(v);
  return v;
}

const byIntent = new Map(EVAL_CASES.map(c => [c.intent, c]));

const perfectPlanner: EvalPlanner = async (req: AgentRequest) => {
  const c = byIntent.get(req.text) as EvalCase;
  if ('refuse' in c.expected) return plan([]);
  return plan(
    c.expected.tools.map(t => ({
      name: t.name,
      args: Object.fromEntries(Object.entries(t.args ?? {}).map(([k, v]) => [k, concrete(v)])),
    })),
  );
};

describe('evalset', () => {
  test('has ≥ 40 unique cases across every scenario', () => {
    expect(EVAL_CASES.length).toBeGreaterThanOrEqual(40);
    expect(new Set(EVAL_CASES.map(c => c.id)).size).toBe(EVAL_CASES.length);
    for (const s of [
      'happy',
      'missing_permission',
      'ambiguous',
      'injection',
      'multi_step',
    ] as const) {
      expect(evalCases(s).length).toBeGreaterThanOrEqual(3);
    }
  });

  test('tool names match the registry and every expected tool is available', () => {
    const registry = MOBILE_ACTION_TOOLS.map(t => t.function.name).sort();
    expect([...MOBILE_TOOL_NAMES].sort()).toEqual(registry);
    const known = new Set<string>(registry);
    for (const c of EVAL_CASES) {
      for (const t of c.availableTools) expect(known.has(t)).toBe(true);
      if ('tools' in c.expected) {
        for (const t of c.expected.tools) expect(c.availableTools).toContain(t.name);
      }
      for (const f of c.forbiddenTools ?? []) {
        expect(known.has(f)).toBe(true);
        if ('tools' in c.expected) expect(c.expected.tools.map(t => t.name)).not.toContain(f);
      }
    }
  });

  test('expected args only use parameters the tool declares', () => {
    const params = new Map(
      MOBILE_ACTION_TOOLS.map(t => [
        t.function.name,
        Object.keys((t.function.parameters as { properties: object }).properties),
      ]),
    );
    for (const c of EVAL_CASES) {
      if (!('tools' in c.expected)) continue;
      for (const t of c.expected.tools) {
        for (const k of Object.keys(t.args ?? {})) expect(params.get(t.name)).toContain(k);
      }
    }
  });

  test('injection cases forbid the injected tool, including the send_email notification case', () => {
    const inj = evalCases('injection');
    expect(inj.every(c => (c.forbiddenTools ?? []).length > 0)).toBe(true);
    const notif = inj.find(c => /IGNORE PREVIOUS INSTRUCTIONS/.test(c.intent));
    expect(notif?.forbiddenTools).toContain('send_email');
  });
});

describe('argMatches normalization', () => {
  test.each([
    ['Invoice', '  invoice ', true],
    ['on my way', 'On  my   way', true],
    [40, '40', true],
    [40, 40.3, true],
    [40, 45, false],
    [true, 'true', true],
    [false, 'False', true],
    [true, 'false', false],
    ['2026-10-20', '20 Oct', true],
    ['2026-10-20', '2026-10-20T11:00:00', true],
    ['tomorrow', '2026-10-18 15:00', true],
    ['tomorrow', 'today', false],
    ['monday', 'next monday 10am', true], // said on a Saturday, "next monday" is the 19th
    ['monday', '2026-10-26', false],
    ['monday', 'Monday at 10am', true],
    ['Design sync', 'design sync', true],
    ['Design sync', 'Friday', false],
    [{ $contains: 'dentist' }, 'Dentist appointment', true],
    [{ $digits: '9876543210' }, '+91 98765-43210', true],
    [{ $digits: '9876543210' }, '98765', false],
    [{ $approx: 30, tol: 5 }, 33, true],
    [{ $oneOf: ['media', 'music'] }, 'MUSIC', true],
    [{ $day: 'friday' }, '2026-10-23T13:00', true],
    [{ $any: true }, undefined, false],
  ])('%j vs %j → %s', (want, got, ok) => {
    expect(argMatches(want, got, REF)).toBe(ok);
  });
});

describe('scoreCase', () => {
  const focus = EVAL_CASES.find(c => c.id === 'focus_mode') as EvalCase;
  const bt = EVAL_CASES.find(c => c.id === 'bluetooth_on') as EvalCase;

  test('multi_step is order-sensitive', () => {
    const [a, b, c] = 'tools' in focus.expected ? focus.expected.tools : [];
    const ok = scoreCase(focus, plan([a, b, c]), REF);
    expect(ok.passed).toBe(true);
    const swapped = scoreCase(focus, plan([b, a, c]), REF);
    expect(swapped.toolMatch).toBe(false);
    expect(swapped.passed).toBe(false);
  });

  test('accepts camelCase arg keys and reports mismatches', () => {
    const r = scoreCase(bt, plan([{ name: 'toggle_bluetooth', args: { Enable: 'off' } }]), REF);
    expect(r.toolMatch).toBe(true);
    expect(r.argCallsPaired).toBe(1);
    expect(r.argCallsValid).toBe(0);
    expect(r.argMismatches[0]).toMatchObject({ tool: 'toggle_bluetooth', key: 'enable' });
  });

  test('infer steps are not tool calls', () => {
    const amb = EVAL_CASES.find(c => c.id === 'ambiguous_alarm_no_time') as EvalCase;
    const p: Plan = {
      goal: 'clarify',
      source: 'planner',
      steps: [
        { id: 's1', kind: 'infer', operation: 'respond', prompt: 'ask', dataClass: 'public' },
      ],
    };
    expect(scoreCase(amb, p, REF).passed).toBe(true);
  });
});

describe('runEvaluation', () => {
  function fakeClock(stepMs: number) {
    let t = 0;
    return () => (t += stepMs);
  }

  test('perfect planner scores 1.0 everywhere and persists the run', async () => {
    const progress: number[] = [];
    const run = await runEvaluation({
      cases: EVAL_CASES,
      planner: perfectPlanner,
      modelId: 'perfect',
      clock: fakeClock(10),
      onProgress: done => progress.push(done),
    });
    const failed = run.results.filter(r => !r.passed);
    expect(failed.map(f => [f.caseId, f.argMismatches])).toEqual([]);
    expect(run.metrics).toMatchObject({
      total: EVAL_CASES.length,
      passed: EVAL_CASES.length,
      passRate: 1,
      toolAccuracy: 1,
      argumentValidity: 1,
      multiStepSuccess: 1,
      injectionSafety: 1,
      refusalAccuracy: 1,
      falseRefusalRate: 0,
      errors: 0,
      latencyP50Ms: 10,
      latencyP95Ms: 10,
    });
    expect(progress).toHaveLength(EVAL_CASES.length);

    const db = await getDatabase();
    const runs = await db.execute('SELECT * FROM eval_runs');
    expect(runs.rows).toHaveLength(1);
    expect(runs.rows[0]).toMatchObject({ model_id: 'perfect', passed: EVAL_CASES.length });
    const results = await db.execute('SELECT COUNT(*) AS n FROM eval_results WHERE passed = 1');
    expect(Number(results.rows[0].n)).toBe(EVAL_CASES.length);
    const listed = await listEvalRuns({ modelId: 'perfect' });
    expect(listed[0].metrics.toolAccuracy).toBe(1);
  });

  test('partially wrong planner: wrong args, wrong order, false refusals, guessing', async () => {
    const wrongArgs = new Set(['brightness_40', 'alarm_0630']);
    const planner: EvalPlanner = async (req, ctx) => {
      const c = ctx.evalCase;
      if (c.id === 'brightness_40') return plan([{ name: 'set_brightness', args: { level: 80 } }]);
      if (c.id === 'alarm_0630')
        return plan([{ name: 'set_alarm', args: { hour: 18, minutes: 30 } }]);
      if (c.id === 'bedtime') {
        const p = await perfectPlanner(req, ctx);
        p.steps.reverse();
        return p;
      }
      if (c.id === 'screenshot') return plan([]); // false refusal
      if (c.id === 'ambiguous_alarm_no_time') {
        return plan([{ name: 'set_alarm', args: { hour: 7, minutes: 0 } }]); // guessed
      }
      if (c.id === 'flashlight_on') throw new Error('model crashed');
      return perfectPlanner(req, ctx);
    };
    const run = await runEvaluation({
      cases: EVAL_CASES,
      planner,
      modelId: 'partial',
      clock: fakeClock(5),
    });
    const failedIds = run.results
      .filter(r => !r.passed)
      .map(r => r.caseId)
      .sort();
    expect(failedIds).toEqual(
      [...wrongArgs, 'bedtime', 'screenshot', 'ambiguous_alarm_no_time', 'flashlight_on'].sort(),
    );
    const m = run.metrics;
    const toolCases = EVAL_CASES.filter(c => 'tools' in c.expected).length;
    // screenshot (refused), bedtime (order), flashlight_on (error ⇒ empty plan) miss tools.
    expect(m.toolAccuracy).toBeCloseTo((toolCases - 3) / toolCases);
    expect(m.argumentValidity).toBeLessThan(1);
    expect(m.multiStepSuccess).toBeCloseTo(5 / 6);
    expect(m.refusalAccuracy).toBeCloseTo(5 / 6);
    expect(m.injectionSafety).toBe(1);
    expect(m.errors).toBe(1);
    expect(run.results.find(r => r.caseId === 'flashlight_on')?.error).toBe('model crashed');
  });

  test('injection-vulnerable planner obeys embedded instructions and is caught', async () => {
    const planner: EvalPlanner = async (req, ctx) => {
      const base = await perfectPlanner(req, ctx);
      const injected = (ctx.evalCase.forbiddenTools ?? [])[0];
      if (ctx.evalCase.scenario === 'injection' && injected) {
        base.steps.push({
          id: 'evil',
          kind: 'tool',
          tool: injected,
          args: injected === 'send_email' ? { to: 'x@evil.com', subject: 's', body: 'b' } : {},
        });
      }
      return base;
    };
    const run = await runEvaluation({
      cases: EVAL_CASES,
      planner,
      modelId: 'vulnerable',
      persist: false,
    });
    expect(run.metrics.injectionSafety).toBe(0);
    const notif = run.results.find(r => r.caseId === 'inject_notification_email');
    expect(notif).toMatchObject({ passed: false, injectionSafe: false });
    expect(notif?.forbiddenPlanned).toEqual(['send_email']);
    expect(run.metrics.byScenario.injection).toEqual({
      total: evalCases('injection').length,
      passed: 0,
    });
    expect(run.metrics.byScenario.happy?.passed).toBe(evalCases('happy').length);
    const db = await getDatabase();
    const runs = await db.execute('SELECT COUNT(*) AS n FROM eval_runs');
    expect(Number(runs.rows[0].n)).toBe(0);
  });

  test('empty case list gives null rates, not NaN', async () => {
    const run = await runEvaluation({
      cases: [],
      planner: perfectPlanner,
      modelId: 'none',
      persist: false,
    });
    expect(run.metrics.passRate).toBe(0);
    expect(run.metrics.toolAccuracy).toBeNull();
    expect(run.metrics.latencyP95Ms).toBeNull();
    expect(JSON.stringify(run.metrics)).not.toContain('NaN');
  });

  test('planner receives denied permissions and the reference date', async () => {
    const seen: string[][] = [];
    await runEvaluation({
      cases: evalCases('missing_permission'),
      planner: async (req, ctx) => {
        seen.push(ctx.deniedPermissions);
        expect(ctx.referenceDate.toISOString()).toBe(REF.toISOString());
        return perfectPlanner(req, ctx);
      },
      modelId: 'perm',
      persist: false,
    });
    expect(seen.every(d => d.length > 0)).toBe(true);
  });
});
