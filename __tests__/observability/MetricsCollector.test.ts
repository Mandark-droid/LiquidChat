import { createTracer } from '../../src/observability/AgentTracer';
import { EVAL_CASES } from '../../src/observability/evalset';
import { runEvaluation } from '../../src/observability/EvaluationRunner';
import { MetricsCollector } from '../../src/observability/MetricsCollector';
import type { TraceType } from '../../src/observability/types';
import { getDatabase, resetDatabaseForTests, type SqlValue } from '../../src/storage/db';

beforeEach(() => {
  resetDatabaseForTests();
  (require('@op-engineering/op-sqlite') as any).__resetAll();
});

const T0 = 1_700_000_000_000;

async function exec(sql: string, params: SqlValue[] = []) {
  const db = await getDatabase();
  return db.execute(sql, params);
}

async function addExecution(
  id: string,
  state: string,
  opts: { steps?: number; created?: number; durationMs?: number } = {},
) {
  const created = opts.created ?? T0;
  const plan =
    opts.steps === undefined
      ? null
      : JSON.stringify({
          goal: 'g',
          source: 'planner',
          steps: Array.from({ length: opts.steps }, (_, i) => ({ id: `s${i}`, kind: 'tool' })),
        });
  await exec(
    `INSERT INTO executions (id, request_json, state, plan_json, created_at, updated_at)
     VALUES (?, '{}', ?, ?, ?, ?)`,
    [id, state, plan, created, created + (opts.durationMs ?? 1000)],
  );
}

async function addTrace(execId: string | null, type: TraceType, payload: object, at = T0 + 10) {
  await exec('INSERT INTO traces (execution_id, type, payload_json, at) VALUES (?, ?, ?, ?)', [
    execId,
    type,
    JSON.stringify(payload),
    at,
  ]);
}

const window = { since: T0 - 1, until: T0 + 3_600_000 };

describe('MetricsCollector', () => {
  test('empty database yields zeros and nulls, never NaN', async () => {
    const m = await new MetricsCollector().collect(window);
    expect(m.executions).toEqual({ total: 0, terminal: 0, completed: 0, failed: 0, cancelled: 0 });
    expect(m.taskCompletionRate).toBeNull();
    expect(m.multiStep.successRate).toBeNull();
    expect(m.recovery.successRate).toBeNull();
    expect(m.toolCalls.argumentValidity).toBeNull();
    expect(m.toolCalls.incorrectActionRate).toBeNull();
    expect(m.routing.localShare).toBeNull();
    expect(m.latency).toEqual({ medianMs: null, p95Ms: null, samples: 0 });
    expect(m.energy).toEqual({ avgBatteryDropPerTask: null, samples: 0 });
    expect(m.cost).toEqual({ totalUsd: 0, perSuccessfulTaskUsd: null });
    expect(m.policyViolationsBlocked).toBe(0);
    expect(JSON.stringify(m)).not.toMatch(/NaN|Infinity/);
  });

  test('computes the PRD §15.3 metrics from seeded data', async () => {
    // Executions: 3 completed, 1 failed, 1 cancelled, 1 still running, 1 outside the window.
    await addExecution('e1', 'COMPLETED', { steps: 1, durationMs: 1000 });
    await addExecution('e2', 'COMPLETED', { steps: 3, durationMs: 2000 });
    await addExecution('e3', 'COMPLETED', { steps: 2, durationMs: 3000 });
    await addExecution('e4', 'FAILED', { steps: 2, durationMs: 4000 });
    await addExecution('e5', 'CANCELLED', { durationMs: 10000 });
    await addExecution('e6', 'EXECUTING', { steps: 2 });
    await addExecution('old', 'FAILED', { created: T0 - 10 * 86_400_000 });

    // Recovery: e2 via state_transitions, e4 via trace; e6 still running (ignored).
    await exec(
      `INSERT INTO state_transitions (execution_id, from_state, to_state, at)
       VALUES ('e2', 'VERIFYING', 'RECOVERING', ?)`,
      [T0 + 5],
    );
    await addTrace('e4', 'execution.state', { state: 'RECOVERING' });
    await addTrace('e6', 'execution.state', { state: 'RECOVERING' });

    // Tool calls: 4 executed, 1 rejected for invalid args, 1 user correction.
    for (let i = 0; i < 4; i++) {
      await exec(
        `INSERT INTO tool_calls (id, execution_id, step_id, tool, status, idempotent, risk, started_at)
         VALUES (?, 'e1', 's0', 'set_volume', 'succeeded', 1, 'reversible', ?)`,
        [`tc${i}`, T0 + i],
      );
    }
    await addTrace('e3', 'tool.denied', { reason: 'invalid_args', tool: 'set_alarm' });
    await addTrace('e3', 'tool.denied', { reason: 'permission_denied' });
    await addTrace('e2', 'user.correction', { note: 'wrong contact' });
    await addTrace('e2', 'policy.violation_blocked', { rule: 'injection' });
    await addTrace(null, 'policy.violation_blocked', { rule: 'budget' });

    // Routing: e1 local; e2 local then escalated to remote for the same step; e3 remote.
    const route = (
      exe: string,
      step: string,
      model: string,
      mode: string,
      reason: string,
      lat: number,
      at: number,
    ) =>
      exec(
        `INSERT INTO routing_decisions (execution_id, step_id, model_id, provider_id, mode, reason, latency_ms, at)
         VALUES (?, ?, ?, 'p', ?, ?, ?, ?)`,
        [exe, step, model, mode, reason, lat, at],
      );
    await route('e1', 's0', 'lfm2', 'local', 'default', 100, T0 + 1);
    await route('e2', 's0', 'lfm2', 'local', 'default', 300, T0 + 2);
    await route('e2', 's0', 'gpt', 'remote', 'verification failed', 900, T0 + 3);
    await route('e3', 's0', 'gpt', 'remote', 'complexity high', 1100, T0 + 4);

    // Energy: e1 drops 2%, e2 drops 1%, e3 charging (skipped), e4 failed (skipped).
    const snap = (e: string, phase: string, pct: number, charging = false) =>
      addTrace(e, 'device.snapshot', { phase, batteryPercent: pct, charging });
    await snap('e1', 'start', 80);
    await snap('e1', 'end', 78);
    await snap('e2', 'start', 60);
    await snap('e2', 'end', 59);
    await snap('e3', 'start', 50, true);
    await snap('e3', 'end', 52, true);
    await snap('e4', 'start', 40);
    await snap('e4', 'end', 30);

    // Cost: e2 $0.02 + e3 $0.04 (completed) + e4 $0.10 (failed).
    for (const [e, usd] of [
      ['e2', 0.02],
      ['e3', 0.04],
      ['e4', 0.1],
    ] as const) {
      await exec(
        `INSERT INTO cost_ledger (provider_id, model_id, execution_id, usd, at) VALUES ('p', 'gpt', ?, ?, ?)`,
        [e, usd, T0 + 5],
      );
    }

    const m = await new MetricsCollector().collect(window);
    expect(m.executions).toEqual({ total: 6, terminal: 5, completed: 3, failed: 1, cancelled: 1 });
    expect(m.taskCompletionRate).toBeCloseTo(3 / 5);
    expect(m.multiStep).toEqual({ total: 3, completed: 2, successRate: 2 / 3 });
    expect(m.recovery).toEqual({ attempted: 2, recovered: 1, successRate: 0.5 });
    expect(m.toolCalls).toEqual({
      total: 4,
      invalidArgs: 1,
      argumentValidity: 0.8,
      userCorrections: 1,
      incorrectActionRate: 0.25,
    });
    expect(m.policyViolationsBlocked).toBe(2);
    expect(m.routing).toMatchObject({
      decisions: 4,
      local: 2,
      remote: 2,
      localShare: 0.5,
      remoteShare: 0.5,
      escalations: 1,
    });
    expect(m.routing.perModel).toEqual([
      { modelId: 'gpt', mode: 'remote', calls: 2, medianMs: 1000, p95Ms: 1090 },
      { modelId: 'lfm2', mode: 'local', calls: 2, medianMs: 200, p95Ms: 290 },
    ]);
    expect(m.latency.samples).toBe(5);
    expect(m.latency.medianMs).toBe(3000);
    expect(m.latency.p95Ms).toBeCloseTo(8800);
    expect(m.energy).toEqual({ avgBatteryDropPerTask: 1.5, samples: 2 });
    expect(m.cost.totalUsd).toBeCloseTo(0.16);
    expect(m.cost.perSuccessfulTaskUsd).toBeCloseTo(0.06 / 3);
  });

  test('evaluation accuracy comes from eval_results in the window', async () => {
    const planner = async () => ({ goal: 'x', source: 'planner' as const, steps: [] });
    await runEvaluation({ cases: EVAL_CASES, planner, modelId: 'lazy' });
    const m = await new MetricsCollector().collect({ since: 0, until: Date.now() + 1000 });
    expect(m.evaluation.cases).toBe(EVAL_CASES.length);
    expect(m.evaluation.toolCallAccuracy).toBeLessThan(0.2); // only empty-plan injection cases match
    expect(m.evaluation.argumentValidity).toBeNull(); // nothing paired
    const outside = await new MetricsCollector().collect({ since: 0, until: 1 });
    expect(outside.evaluation.cases).toBe(0);
  });

  test('works with traces written through the tracer', async () => {
    const t = createTracer(undefined, { now: () => T0 + 100 });
    t.record(null, 'policy.violation_blocked', { rule: 'x', token: 'secret' });
    await t.flush();
    const m = await new MetricsCollector().collect(window);
    expect(m.policyViolationsBlocked).toBe(1);
    await t.dispose();
  });
});
