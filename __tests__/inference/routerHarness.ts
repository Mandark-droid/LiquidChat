import { CircuitBreaker } from '../../src/inference/CircuitBreaker';
import { CostLedger } from '../../src/inference/CostLedger';
import { ModelRegistry, type RemoteProviderConfig } from '../../src/inference/ModelRegistry';
import { ModelRouter, type ModelRouterDeps } from '../../src/inference/ModelRouter';
import { PrivacyGrants } from '../../src/inference/privacy';
import { type RoutingPolicy, RoutingPolicyStore } from '../../src/inference/RoutingPolicy';
import type { RoutingContext } from '../../src/inference/types';
import type { DeviceSnapshot } from '../../src/platform/types';
import { FakeDevice, MemoryCredentials, MemoryKV, OPENAI_CFG } from './helpers';

export interface Harness {
  router: ModelRouter;
  registry: ModelRegistry;
  policyStore: RoutingPolicyStore;
  device: FakeDevice;
  credentials: MemoryCredentials;
  ledger: CostLedger;
  breaker: CircuitBreaker;
  grants: PrivacyGrants;
  tracer: { record: jest.Mock; flush: jest.Mock };
  loaded: string[];
  clock: { now: number };
}

export async function makeHarness(
  opts: {
    policy?: Partial<RoutingPolicy>;
    device?: Partial<DeviceSnapshot>;
    providers?: RemoteProviderConfig[];
    keys?: boolean;
    preferred?: string;
    deps?: Partial<ModelRouterDeps>;
  } = {},
): Promise<Harness> {
  const clock = { now: new Date(2026, 9, 17, 12).getTime() };
  const now = () => clock.now;
  const credentials = new MemoryCredentials();
  const registry = new ModelRegistry({ credentials, storage: new MemoryKV(), now });
  for (const p of opts.providers ?? [OPENAI_CFG])
    await registry.upsertProvider(p, opts.keys === false ? undefined : `sk-key-for-${p.id}-0000`);
  const policyStore = new RoutingPolicyStore(new MemoryKV());
  if (opts.policy) await policyStore.update(opts.policy);
  const device = new FakeDevice(opts.device);
  const ledger = new CostLedger(undefined, now);
  const breaker = new CircuitBreaker({ now });
  const grants = new PrivacyGrants(undefined, now);
  const tracer = { record: jest.fn(), flush: jest.fn(async () => {}) };
  const loaded: string[] = [];
  const router = new ModelRouter({
    registry,
    policyStore,
    device,
    credentials,
    ledger,
    breaker,
    grants,
    tracer,
    now,
    loadedLocalModels: () => loaded,
    preferredLocalModel: () => opts.preferred,
    ...opts.deps,
  });
  return {
    router,
    registry,
    policyStore,
    device,
    credentials,
    ledger,
    breaker,
    grants,
    tracer,
    loaded,
    clock,
  };
}

export function ctx(patch: Partial<RoutingContext> = {}): RoutingContext {
  return {
    executionId: 'exec-1',
    stepId: 'step-1',
    requirements: { operation: 'reason', complexity: 'medium' },
    dataClass: 'public',
    estimatedInputTokens: 600,
    estimatedOutputTokens: 200,
    remoteCallsSoFar: 0,
    spendSoFarUsd: 0,
    ...patch,
  };
}

/** Jest treats every file under __tests__ as a suite; only self-test when run directly. */
if (expect.getState().testPath?.endsWith('routerHarness.ts')) {
  test('harness builds', async () => {
    const h = await makeHarness();
    expect(h.router).toBeInstanceOf(ModelRouter);
  });
}
