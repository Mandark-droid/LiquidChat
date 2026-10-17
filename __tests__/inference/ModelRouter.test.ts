import { energyState } from '../../src/inference/ModelRouter';
import { DEFAULT_ROUTING_POLICY } from '../../src/inference/RoutingPolicy';
import { NoEligibleModelError } from '../../src/inference/types';
import { getDatabase } from '../../src/storage/db';
import { BASE_SNAPSHOT, freshDb } from './helpers';
import { ctx, makeHarness } from './routerHarness';

beforeEach(freshDb);

const REMOTE = 'oai/gpt-mini';

async function measure(
  h: Awaited<ReturnType<typeof makeHarness>>,
  modelId: string,
  op: 'reason' | 'plan',
  successes: number,
  failures: number,
) {
  for (let i = 0; i < successes; i++)
    await h.registry.recordSample(modelId, { operation: op, success: true });
  for (let i = 0; i < failures; i++)
    await h.registry.recordSample(modelId, { operation: op, success: false });
}

describe('routing modes', () => {
  test('local_only never yields remote, even when escalating a high-complexity step', async () => {
    const h = await makeHarness({ policy: { mode: 'local_only' } });
    const d = await h.router.route(
      ctx({
        requirements: { operation: 'reason', complexity: 'high' },
        escalationReason: 'output failed verification',
      }),
    );
    expect(d.executionMode).toBe('local');
    expect(d.rejected).toContainEqual({
      modelId: REMOTE,
      stage: 'policy',
      reason: 'routing mode is local only',
    });
    expect(d.reason).toMatch(/Local-only/);
  });

  test('local_only throws NoEligibleModelError instead of going remote', async () => {
    const h = await makeHarness({ policy: { mode: 'local_only' } });
    const p = h.router.route(ctx({ estimatedInputTokens: 100_000 }));
    await expect(p).rejects.toBeInstanceOf(NoEligibleModelError);
    const err = await p.catch(e => e as NoEligibleModelError);
    expect(err.rejected.find(r => r.modelId === REMOTE)!.stage).toBe('policy');
    expect(err.rejected.find(r => r.modelId === 'lfm2.5-350m')!.reason).toMatch(/context/);
  });

  test('hybrid keeps a medium step local when quality is unknown', async () => {
    const h = await makeHarness();
    const d = await h.router.route(ctx());
    expect(d.executionMode).toBe('local');
    expect(d.providerId).toBe('cactus');
    expect(d.reason).toMatch(/on-device/);
    expect(d.requiresUserApproval).toBe(false);
    expect(d.estimatedCost).toBe(0);
  });

  test('hybrid sends a high-complexity step remote when no local model is proven', async () => {
    const h = await makeHarness();
    const d = await h.router.route(
      ctx({ requirements: { operation: 'reason', complexity: 'high' } }),
    );
    expect(d.selectedModelId).toBe(REMOTE);
    expect(d.executionMode).toBe('remote');
    expect(d.estimatedCost).toBeCloseTo((600 * 0.15 + 200 * 0.6) / 1e6, 8);
    expect(d.reason).toMatch(/High-complexity/);
  });

  test('hybrid keeps a high step local when a local model is measured above threshold', async () => {
    const h = await makeHarness();
    await measure(h, 'lfm2.5-1.2b-thinking', 'reason', 9, 0);
    const d = await h.router.route(
      ctx({ requirements: { operation: 'reason', complexity: 'high' } }),
    );
    expect(d.selectedModelId).toBe('lfm2.5-1.2b-thinking');
    expect(d.confidence).toBe(1);
    expect(d.reason).toMatch(/measured reason success 100%/);
  });

  test('hybrid escalates when every local model measures below threshold', async () => {
    const h = await makeHarness({ policy: { mode: 'local_only' } });
    const entries = await h.registry.entries();
    for (const e of entries.filter(x => x.provider === 'local'))
      await measure(h, e.modelId, 'plan', 1, 3);
    await h.policyStore.update({ mode: 'hybrid' });
    const d = await h.router.route(ctx({ requirements: { operation: 'plan', complexity: 'low' } }));
    expect(d.executionMode).toBe('remote');
    expect(d.reason).toMatch(/below the 50% threshold/);
  });

  test('cloud_preferred goes remote first and falls back to local offline', async () => {
    const h = await makeHarness({ policy: { mode: 'cloud_preferred' } });
    expect((await h.router.route(ctx())).executionMode).toBe('remote');
    h.device.set({ online: false });
    const d = await h.router.route(ctx());
    expect(d.executionMode).toBe('local');
    expect(d.rejected).toContainEqual({
      modelId: REMOTE,
      stage: 'policy',
      reason: 'device is offline',
    });
    expect(d.reason).toMatch(/Cloud preferred but no remote/);
  });
});

describe('per-step routing', () => {
  test('escalated step goes remote, the next step routes local again', async () => {
    const h = await makeHarness();
    const plan = await h.router.route(ctx({ stepId: 'plan', requirements: { operation: 'plan' } }));
    expect(plan.executionMode).toBe('local');

    const first = await h.router.route(ctx({ stepId: 'reason' }));
    expect(first.executionMode).toBe('local');
    const escalated = await h.router.route(
      ctx({
        stepId: 'reason',
        escalationReason: 'answer failed schema validation',
        excludeModels: [first.selectedModelId],
      }),
    );
    expect(escalated.executionMode).toBe('remote');
    expect(escalated.reason).toMatch(/Escalating this step/);
    expect(escalated.rejected).toContainEqual({
      modelId: first.selectedModelId,
      stage: 'policy',
      reason: 'already tried for this step',
    });

    const next = await h.router.route(
      ctx({ stepId: 'respond', requirements: { operation: 'respond' }, remoteCallsSoFar: 1 }),
    );
    expect(next.executionMode).toBe('local');

    const db = await getDatabase();
    const rows = (await db.execute('SELECT step_id, mode FROM routing_decisions ORDER BY id')).rows;
    expect(rows.map(r => `${r.step_id}:${r.mode}`)).toEqual([
      'plan:local',
      'reason:local',
      'reason:remote',
      'respond:local',
    ]);
  });

  test('escalation with no eligible remote picks the next-best local model', async () => {
    const h = await makeHarness({ device: { online: false } });
    const first = await h.router.route(ctx());
    const d = await h.router.route(
      ctx({ escalationReason: 'bad', excludeModels: [first.selectedModelId] }),
    );
    expect(d.executionMode).toBe('local');
    expect(d.selectedModelId).not.toBe(first.selectedModelId);
    expect(d.reason).toMatch(/next local model/);
  });
});

describe('privacy policy', () => {
  test('personal data is blocked from remote by default', async () => {
    const h = await makeHarness();
    const d = await h.router.route(
      ctx({ dataClass: 'personal', requirements: { operation: 'reason', complexity: 'high' } }),
    );
    expect(d.executionMode).toBe('local');
    expect(d.rejected).toContainEqual({
      modelId: REMOTE,
      stage: 'policy',
      reason: 'personal data may not leave the device',
    });
  });

  test('allowed class needs approval on first send; the grant persists', async () => {
    const h = await makeHarness({ policy: { allowRemoteDataClasses: ['public', 'sensitive'] } });
    const c = ctx({
      dataClass: 'sensitive',
      requirements: { operation: 'reason', complexity: 'high' },
    });
    const d1 = await h.router.route(c);
    expect(d1.executionMode).toBe('remote');
    expect(d1.requiresUserApproval).toBe(true);
    expect(d1.reason).toMatch(/needs your approval/);
    await h.grants.grant('oai', 'sensitive');
    const d2 = await h.router.route(c);
    expect(d2.requiresUserApproval).toBe(false);
    // public never needs approval
    expect((await h.router.route({ ...c, dataClass: 'public' })).requiresUserApproval).toBe(false);
  });
});

describe('budgets, caps, breaker, keys', () => {
  const high = () => ctx({ requirements: { operation: 'reason', complexity: 'high' } });

  test('per-task remote call cap', async () => {
    const h = await makeHarness();
    const d = await h.router.route({ ...high(), remoteCallsSoFar: 3 });
    expect(d.executionMode).toBe('local');
    expect(d.rejected.find(r => r.modelId === REMOTE)!.reason).toMatch(/3\/3 remote calls/);
  });

  test('per-task spend cap', async () => {
    const h = await makeHarness();
    const d = await h.router.route({ ...high(), spendSoFarUsd: 0.0499999 });
    expect(d.executionMode).toBe('local');
    expect(d.rejected.find(r => r.modelId === REMOTE)!.reason).toMatch(/per-task budget/);
  });

  test('daily and monthly budgets from the ledger', async () => {
    const h = await makeHarness();
    await h.ledger.record({ providerId: 'oai', modelId: REMOTE, usd: 0.5 });
    let d = await h.router.route(high());
    expect(d.rejected.find(r => r.modelId === REMOTE)!.reason).toMatch(/daily budget/);

    h.clock.now += 2 * 86_400_000; // two days later, same month
    await h.ledger.record({ providerId: 'oai', modelId: REMOTE, usd: 4.6 });
    h.clock.now += 86_400_000;
    d = await h.router.route(high());
    expect(d.rejected.find(r => r.modelId === REMOTE)!.reason).toMatch(/monthly budget/);
  });

  test('open circuit excludes the provider until half-open', async () => {
    const h = await makeHarness();
    for (let i = 0; i < 3; i++) h.breaker.recordFailure('oai');
    let d = await h.router.route(high());
    expect(d.rejected.find(r => r.modelId === REMOTE)!.reason).toMatch(/circuit open/);
    h.clock.now += 60_000;
    d = await h.router.route(high());
    expect(d.executionMode).toBe('remote');
  });

  test('missing key / disabled provider', async () => {
    const h = await makeHarness({ keys: false });
    let d = await h.router.route(high());
    expect(d.rejected.find(r => r.modelId === REMOTE)!.reason).toBe('no API key for oai');
    await h.credentials.set('provider:oai', 'k');
    await h.registry.setProviderEnabled('oai', false);
    d = await h.router.route(high());
    expect(d.rejected.find(r => r.modelId === REMOTE)!.reason).toBe('provider oai is disabled');
  });

  test('excludeModels removes a remote model', async () => {
    const h = await makeHarness({ policy: { mode: 'cloud_preferred' } });
    const d = await h.router.route(ctx({ excludeModels: [REMOTE] }));
    expect(d.executionMode).toBe('local');
    expect(d.rejected).toContainEqual({
      modelId: REMOTE,
      stage: 'policy',
      reason: 'excluded by caller',
    });
  });

  test('forbidRemote option (user declined) keeps the step local', async () => {
    const h = await makeHarness({ policy: { mode: 'cloud_preferred' } });
    const d = await h.router.route(ctx(), { forbidRemote: true, forbidRemoteReason: 'declined' });
    expect(d.executionMode).toBe('local');
  });
});

describe('capability filter', () => {
  test('tools + vision requirements', async () => {
    const h = await makeHarness({ policy: { mode: 'local_only' } });
    const d = await h.router.route(
      ctx({ requirements: { operation: 'extract', toolCalling: true, vision: true } }),
    );
    expect(d.selectedModelId).toBe('qwen3.5-2b');
    expect(d.rejected.find(r => r.modelId === 'lfm2.5-vl-1.6b')!.reason).toBe('no tool calling');
    expect(d.rejected.find(r => r.modelId === 'lfm2.5-350m')!.reason).toBe('no vision input');
  });

  test('local models must fit free RAM unless already loaded', async () => {
    const h = await makeHarness({
      device: { availableRamMb: 1000 },
      policy: { energy: 'performance' },
    });
    let d = await h.router.route(ctx({ requirements: { operation: 'respond' } }));
    const big = d.rejected.find(r => r.modelId === 'lfm2-8b-a1b')!;
    expect(big.stage).toBe('capability');
    expect(big.reason).toMatch(/RAM/);
    expect(['lfm2.5-350m', 'lfm2-700m', 'lfm2-vl-450m']).toContain(d.selectedModelId);

    h.loaded.push('lfm2.5-1.2b-instruct');
    d = await h.router.route(ctx({ requirements: { operation: 'respond' } }));
    expect(d.rejected.find(r => r.modelId === 'lfm2.5-1.2b-instruct')).toBeUndefined();
  });

  test('device RAM class gate (minRamGb)', async () => {
    const h = await makeHarness({ device: { totalRamMb: 6 * 1024 } });
    const d = await h.router.route(ctx());
    expect(d.rejected.find(r => r.modelId === 'lfm2-8b-a1b')!.reason).toMatch(/12 GB RAM device/);
  });
});

describe('energy', () => {
  test('energyState triggers', () => {
    const p = DEFAULT_ROUTING_POLICY;
    expect(energyState(p, BASE_SNAPSHOT).saver).toBe(false);
    expect(energyState(p, { ...BASE_SNAPSHOT, batteryPercent: 15 }).saver).toBe(true);
    expect(energyState(p, { ...BASE_SNAPSHOT, batteryPercent: 15, charging: true }).saver).toBe(
      false,
    );
    expect(energyState(p, { ...BASE_SNAPSHOT, thermal: 'severe' }).saver).toBe(true);
    expect(energyState(p, { ...BASE_SNAPSHOT, batteryPercent: -1 }).saver).toBe(false);
    expect(energyState({ ...p, energy: 'battery_saver' }, BASE_SNAPSHOT).saver).toBe(true);
    expect(
      energyState(
        { ...p, batteryThresholds: { saverBelow: 50, critical: 5 } },
        {
          ...BASE_SNAPSHOT,
          batteryPercent: 40,
        },
      ).saver,
    ).toBe(true);
  });

  test('battery saver picks the smallest capable local model over the preferred one', async () => {
    const h = await makeHarness({ policy: { energy: 'battery_saver' }, preferred: 'lfm2-2.6b' });
    const d = await h.router.route(
      ctx({ requirements: { operation: 'respond', toolCalling: true } }),
    );
    expect(d.selectedModelId).toBe('lfm2.5-350m');
    expect(d.reason).toMatch(/battery saver/);
  });

  test('low battery avoids loading a new model when a capable one is resident', async () => {
    const h = await makeHarness({ device: { batteryPercent: 12 }, preferred: 'lfm2-2.6b' });
    h.loaded.push('lfm2.5-1.2b-instruct');
    const d = await h.router.route(
      ctx({ requirements: { operation: 'respond', toolCalling: true } }),
    );
    expect(d.selectedModelId).toBe('lfm2.5-1.2b-instruct');
    expect(d.reason).toMatch(/battery low/);
  });

  test('saver still allows remote when policy permits (high complexity)', async () => {
    const h = await makeHarness({ device: { thermal: 'critical' } });
    const d = await h.router.route(
      ctx({ requirements: { operation: 'reason', complexity: 'high' } }),
    );
    expect(d.executionMode).toBe('remote');
  });

  test('balanced prefers the user default among unmeasured models; performance prefers measured best', async () => {
    const h = await makeHarness({ preferred: 'lfm2-2.6b' });
    expect((await h.router.route(ctx())).selectedModelId).toBe('lfm2-2.6b');
    await measure(h, 'lfm2-700m', 'reason', 2, 1); // 67% < 70% medium threshold
    await measure(h, 'qwen3.5-2b', 'reason', 5, 0);
    await h.policyStore.update({ energy: 'performance' });
    expect((await h.router.route(ctx())).selectedModelId).toBe('qwen3.5-2b');
  });
});

describe('audit trail', () => {
  test('decision persisted, traced, and outcome recorded', async () => {
    const h = await makeHarness();
    const d = await h.router.route(ctx());
    expect(d.decisionId).toBeGreaterThan(0);
    expect(h.tracer.record).toHaveBeenCalledWith(
      'exec-1',
      'routing.decision',
      expect.objectContaining({ stepId: 'step-1', selected: d.selectedModelId, mode: 'local' }),
    );
    await h.router.recordOutcome(d, { outcome: 'success', latencyMs: 812.4, actualCost: 0 });
    const db = await getDatabase();
    const row = (await db.execute('SELECT * FROM routing_decisions WHERE id = ?', [d.decisionId!]))
      .rows[0];
    expect(row).toMatchObject({ outcome: 'success', latency_ms: 812, model_id: d.selectedModelId });
    expect(String(row.reason).length).toBeGreaterThan(10);
  });

  test('NoEligibleModelError is traced too', async () => {
    const h = await makeHarness({ policy: { mode: 'local_only' } });
    await expect(h.router.route(ctx({ estimatedInputTokens: 1e6 }))).rejects.toThrow(/No eligible/);
    expect(h.tracer.record).toHaveBeenCalledWith(
      'exec-1',
      'routing.decision',
      expect.objectContaining({ selected: null }),
    );
  });
});
