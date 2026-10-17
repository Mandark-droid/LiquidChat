import { ProviderError } from '../../src/inference/errors';
import {
  createInferenceStack,
  inference,
  InferenceCancelledError,
  InferenceFailedError,
  InferenceService,
  initInference,
  resetInferenceForTests,
} from '../../src/inference/InferenceService';
import type { RoutedDecision } from '../../src/inference/ModelRouter';
import type {
  InferenceProvider,
  InferenceRequest,
  InferenceResult,
  RoutingContext,
} from '../../src/inference/types';
import { NoEligibleModelError } from '../../src/inference/types';
import { getDatabase } from '../../src/storage/db';
import { FakeDevice, freshDb, MemoryCredentials, mockFetch, OPENAI_CFG } from './helpers';
import { ctx, type Harness, makeHarness } from './routerHarness';

beforeEach(freshDb);

type Script = (modelId: string, req: InferenceRequest) => Promise<Partial<InferenceResult>>;

class ScriptedProvider implements InferenceProvider {
  readonly calls: { modelId: string; req: InferenceRequest }[] = [];
  constructor(
    readonly id: string,
    readonly mode: 'local' | 'remote',
    public script: Script = async () => ({ text: 'ok' }),
  ) {}
  async isAvailable() {
    return true;
  }
  async complete(modelId: string, req: InferenceRequest): Promise<InferenceResult> {
    this.calls.push({ modelId, req });
    const r = await this.script(modelId, req);
    return {
      text: '',
      modelId,
      provider: this.id,
      mode: this.mode,
      latencyMs: 100,
      ...r,
    } as InferenceResult;
  }
}

function makeService(h: Harness, opts: { maxRouteAttempts?: number } = {}) {
  const local = new ScriptedProvider('cactus', 'local', async () => ({
    text: 'local',
    tokensPerSecond: 20,
  }));
  const remote = new ScriptedProvider('oai', 'remote', async () => ({
    text: 'remote',
    costUsd: 0.001,
    inputTokens: 600,
    outputTokens: 200,
  }));
  const service = new InferenceService({
    router: h.router,
    registry: h.registry,
    ledger: h.ledger,
    breaker: h.breaker,
    grants: h.grants,
    policyStore: h.policyStore,
    providerFor: async (d: RoutedDecision) => (d.executionMode === 'local' ? local : remote),
    tracer: h.tracer,
    sleep: async () => {},
    ...opts,
  });
  return { service, local, remote };
}

const REQ: InferenceRequest = {
  messages: [
    { role: 'system', content: 'sys' },
    { role: 'user', content: 'old private stuff' },
    { role: 'assistant', content: 'old answer' },
    { role: 'user', content: 'Analyse this. token: Bearer abcdefghijklmnop123' },
  ],
};

const high = (patch: Partial<RoutingContext> = {}) =>
  ctx({ requirements: { operation: 'reason', complexity: 'high' }, ...patch });

describe('run', () => {
  test('local step: no minimization, stats + decision outcome recorded', async () => {
    const h = await makeHarness();
    const { service, local } = makeService(h);
    const out = await service.run(ctx(), REQ);
    expect(out.result).toMatchObject({ text: 'local', mode: 'local', provider: 'cactus' });
    expect(out.decision.executionMode).toBe('local');
    expect((out.decision as any).model).toBeUndefined(); // internal fields stripped
    expect(local.calls[0].req).toBe(REQ);
    expect(local.calls[0].modelId).toBe(out.decision.selectedModelId);
    expect(out.remoteCalls).toBe(0);
    const e = await h.registry.get(out.decision.selectedModelId);
    expect(e!.samples).toBe(1);
    expect(e!.averageTokensPerSecond).toBe(20);
    const db = await getDatabase();
    const row = (await db.execute('SELECT outcome, latency_ms FROM routing_decisions')).rows[0];
    expect(row).toMatchObject({ outcome: 'success', latency_ms: 100 });
  });

  test('remote step: minimized + redacted, cost to ledger, breaker success', async () => {
    const h = await makeHarness();
    const { service, remote } = makeService(h);
    const out = await service.run(high(), REQ);
    expect(out.result.mode).toBe('remote');
    expect(out.remoteCalls).toBe(1);
    expect(out.spendUsd).toBeCloseTo(0.001);
    const sent = remote.calls[0].req.messages;
    expect(sent.map(m => m.content)).toEqual([
      'sys',
      'Analyse this. token: Bearer [REDACTED_TOKEN]',
    ]);
    expect(remote.calls[0].modelId).toBe('gpt-mini'); // provider's raw id
    expect(out.redactions).toEqual(
      expect.arrayContaining([
        { kind: 'bearer_token', count: 1 },
        { kind: 'history', count: 2 },
      ]),
    );
    expect(REQ.messages).toHaveLength(4); // caller's request untouched
    expect(await h.ledger.spentForExecution('exec-1')).toBeCloseTo(0.001);
    expect(h.tracer.record).toHaveBeenCalledWith(
      'exec-1',
      'inference',
      expect.objectContaining({ mode: 'remote' }),
    );
  });

  test('approval: first sensitive send asks; approve persists grant', async () => {
    const h = await makeHarness({ policy: { allowRemoteDataClasses: ['public', 'sensitive'] } });
    const { service } = makeService(h);
    const approve = jest.fn(async () => true);
    const out = await service.run(high({ dataClass: 'sensitive' }), REQ, { approve });
    expect(approve).toHaveBeenCalledTimes(1);
    expect(out.result.mode).toBe('remote');
    expect(await h.grants.has('oai', 'sensitive')).toBe(true);
    await service.run(high({ dataClass: 'sensitive', stepId: 's2' }), REQ, { approve });
    expect(approve).toHaveBeenCalledTimes(1); // not asked again
  });

  test('approval denied ⇒ re-routed on-device; missing approve callback counts as deny', async () => {
    const h = await makeHarness({ policy: { allowRemoteDataClasses: ['public', 'personal'] } });
    const { service, remote } = makeService(h);
    const out = await service.run(high({ dataClass: 'personal' }), REQ, {
      approve: async () => false,
    });
    expect(out.result.mode).toBe('local');
    expect(remote.calls).toHaveLength(0);
    expect(out.attempts[0]).toMatchObject({ outcome: 'denied', mode: 'remote' });
    expect(out.decision.rejected).toContainEqual(
      expect.objectContaining({
        modelId: 'oai/gpt-mini',
        reason: expect.stringMatching(/declined/),
      }),
    );
    expect(await h.grants.has('oai', 'personal')).toBe(false);

    const out2 = await service.run(high({ dataClass: 'personal' }), REQ);
    expect(out2.result.mode).toBe('local');
  });

  test('retryable remote error retried, then success', async () => {
    const h = await makeHarness();
    const { service, remote } = makeService(h);
    let n = 0;
    remote.script = async () => {
      if (n++ === 0) throw new ProviderError('rate_limit', 'slow down', 'oai', 429);
      return { text: 'remote', costUsd: 0.001 };
    };
    const out = await service.run(high(), REQ);
    expect(out.result.text).toBe('remote');
    expect(remote.calls).toHaveLength(2);
    expect(out.remoteCalls).toBe(2);
    expect(h.breaker.state('oai')).toBe('closed');
  });

  test('non-retryable remote failure falls back by re-routing locally', async () => {
    const h = await makeHarness();
    const { service, remote } = makeService(h);
    remote.script = async () => {
      throw new ProviderError('auth', 'bad key', 'oai', 401);
    };
    const out = await service.run(high(), REQ);
    expect(remote.calls).toHaveLength(1);
    expect(out.result.mode).toBe('local');
    expect(out.attempts.map(a => `${a.mode}:${a.outcome}`)).toEqual([
      'remote:error',
      'local:success',
    ]);
    expect(out.attempts[0].error).toMatchObject({ kind: 'auth', retryable: false });
    const db = await getDatabase();
    const outcomes = (
      await db.execute('SELECT outcome FROM routing_decisions ORDER BY id')
    ).rows.map(r => r.outcome);
    expect(outcomes).toEqual(['error:auth', 'success']);
  });

  test('breaker opens after repeated remote failures across steps', async () => {
    const h = await makeHarness({ policy: { providerRetries: 0, maxRemoteCallsPerTask: 99 } });
    const { service, remote } = makeService(h);
    remote.script = async () => {
      throw new ProviderError('server', 'boom', 'oai', 500);
    };
    for (let i = 0; i < 3; i++) await service.run(high({ stepId: `s${i}` }), REQ);
    expect(h.breaker.state('oai')).toBe('open');
    const out = await service.run(high({ stepId: 's4' }), REQ);
    expect(out.attempts).toHaveLength(1);
    expect(out.result.mode).toBe('local');
    expect(remote.calls).toHaveLength(3);
  });

  test('bounded attempts: every model failing ⇒ InferenceFailedError', async () => {
    const h = await makeHarness({ policy: { mode: 'local_only' } });
    const { service, local } = makeService(h, { maxRouteAttempts: 3 });
    local.script = async () => {
      throw new ProviderError('model_error', 'garbage', 'cactus');
    };
    const err = (await service.run(ctx(), REQ).catch(e => e)) as InferenceFailedError;
    expect(err).toBeInstanceOf(InferenceFailedError);
    expect(err.attempts).toHaveLength(3);
    expect(new Set(err.attempts.map(a => a.modelId)).size).toBe(3);
    expect(local.calls).toHaveLength(3);
  });

  test('NoEligibleModelError surfaces when nothing ever qualified', async () => {
    const h = await makeHarness({ policy: { mode: 'local_only' } });
    const { service } = makeService(h);
    await expect(service.run(ctx({ estimatedInputTokens: 1e6 }), REQ)).rejects.toBeInstanceOf(
      NoEligibleModelError,
    );
  });

  test('cancellation', async () => {
    const h = await makeHarness();
    const { service, local } = makeService(h);
    const ctrl = new AbortController();
    local.script = async () => {
      ctrl.abort();
      throw Object.assign(new Error('aborted'), { name: 'AbortError' });
    };
    await expect(service.run(ctx(), REQ, { signal: ctrl.signal })).rejects.toBeInstanceOf(
      InferenceCancelledError,
    );
    expect(local.calls).toHaveLength(1);
  });
});

describe('escalate (per-step hybrid)', () => {
  test('local plan → failed local reason escalates remote → next step local again', async () => {
    const h = await makeHarness();
    const { service, local, remote } = makeService(h);

    const plan = await service.run(
      ctx({ stepId: 'plan', requirements: { operation: 'plan' } }),
      REQ,
    );
    expect(plan.result.mode).toBe('local');

    const reasonCtx = ctx({ stepId: 'reason' });
    const first = await service.run(reasonCtx, REQ);
    expect(first.result.mode).toBe('local');

    const esc = await service.escalate(
      { ...reasonCtx, remoteCallsSoFar: 0 },
      REQ,
      'output failed schema validation',
    );
    expect(esc.result.mode).toBe('remote');
    expect(esc.decision.reason).toMatch(/Escalating this step/);
    expect(esc.decision.rejected).toContainEqual({
      modelId: first.decision.selectedModelId,
      stage: 'policy',
      reason: 'already tried for this step',
    });
    // only the step's own (minimized) input left the device
    expect(remote.calls).toHaveLength(1);
    expect(remote.calls[0].req.messages.some(m => m.content.includes('old private stuff'))).toBe(
      false,
    );

    const respond = await service.run(
      ctx({
        stepId: 'respond',
        requirements: { operation: 'respond' },
        remoteCallsSoFar: esc.remoteCalls,
      }),
      REQ,
    );
    expect(respond.result.mode).toBe('local');
    expect(local.calls).toHaveLength(3);
  });

  test('escalate records a quality failure for the failed model', async () => {
    const h = await makeHarness({ policy: { mode: 'local_only' } });
    const { service } = makeService(h);
    const c = ctx();
    for (let i = 0; i < 3; i++) {
      const first = await service.run(c, REQ);
      await service.escalate(c, REQ, 'bad', { failedModelId: first.decision.selectedModelId });
    }
    const caps = await h.registry.entries();
    const scored = caps.filter(e => e.qualityScores?.reason !== undefined);
    expect(scored.length).toBeGreaterThan(0);
    expect(scored[0].qualityScores!.reason).toBe(0);
  });

  test('reportQuality feeds measured quality that then drives routing', async () => {
    const h = await makeHarness({ preferred: 'lfm2.5-350m' });
    const { service } = makeService(h);
    for (let i = 0; i < 3; i++) await service.reportQuality('lfm2.5-350m', 'reason', false);
    const out = await service.run(ctx(), REQ);
    expect(out.decision.selectedModelId).not.toBe('lfm2.5-350m');
  });
});

describe('wiring', () => {
  afterEach(resetInferenceForTests);
  const realFetch = global.fetch;
  afterEach(() => {
    global.fetch = realFetch;
  });

  test('inference() requires initInference()', () => {
    expect(() => inference()).toThrow(/initInference/);
  });

  test('createInferenceStack routes remote via the real OpenAI provider', async () => {
    const credentials = new MemoryCredentials();
    const { fn, calls } = mockFetch({
      body: {
        choices: [{ message: { content: 'deep answer' } }],
        usage: { prompt_tokens: 10, completion_tokens: 5 },
      },
    });
    global.fetch = fn as any;
    const stack = initInference({ credentials, device: new FakeDevice() });
    expect(inference()).toBe(stack.service);
    await stack.registry.upsertProvider(OPENAI_CFG, 'sk-wired-key-000000000000');
    const out = await inference().run(high(), {
      messages: [{ role: 'user', content: 'hard question' }],
    });
    expect(out.result.text).toBe('deep answer');
    expect(calls[0].url).toBe('https://api.openai.com/v1/chat/completions');
    expect(calls[0].body.model).toBe('gpt-mini');
    expect(out.spendUsd).toBeGreaterThan(0);
  });

  test('createInferenceStack exposes components', () => {
    const s = createInferenceStack({
      credentials: new MemoryCredentials(),
      device: new FakeDevice(),
    });
    expect(s.router).toBeDefined();
    expect(s.policyStore).toBeDefined();
  });
});
