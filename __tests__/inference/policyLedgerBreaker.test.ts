import { CircuitBreaker } from '../../src/inference/CircuitBreaker';
import { CostLedger, estimateCostUsd } from '../../src/inference/CostLedger';
import {
  DEFAULT_ROUTING_POLICY,
  normalizePolicy,
  ROUTING_POLICY_KEY,
  RoutingPolicyStore,
} from '../../src/inference/RoutingPolicy';
import { freshDb, MemoryKV } from './helpers';

beforeEach(freshDb);

describe('RoutingPolicyStore', () => {
  test('defaults', async () => {
    const p = await new RoutingPolicyStore(new MemoryKV()).get();
    expect(p).toMatchObject({
      mode: 'hybrid',
      energy: 'balanced',
      allowRemoteDataClasses: ['public'],
      maxRemoteCallsPerTask: 3,
      maxSpendPerTaskUsd: 0.05,
      dailyBudgetUsd: 0.5,
      monthlyBudgetUsd: 5,
      providerTimeoutMs: 20000,
      batteryThresholds: { saverBelow: 20, critical: 10 },
    });
  });

  test('update persists and merges nested fields', async () => {
    const kv = new MemoryKV();
    const s = new RoutingPolicyStore(kv);
    await s.update({ mode: 'local_only', batteryThresholds: { saverBelow: 30 } as any });
    const fresh = await new RoutingPolicyStore(kv).get();
    expect(fresh.mode).toBe('local_only');
    expect(fresh.batteryThresholds).toEqual({ saverBelow: 30, critical: 10 });
    expect(JSON.parse(kv.map.get(ROUTING_POLICY_KEY)!).mode).toBe('local_only');
  });

  test('garbage in storage falls back to defaults field by field', () => {
    const p = normalizePolicy({
      mode: 'yolo',
      dailyBudgetUsd: -1,
      allowRemoteDataClasses: ['public', 'nope', 'personal'],
    });
    expect(p.mode).toBe('hybrid');
    expect(p.dailyBudgetUsd).toBe(DEFAULT_ROUTING_POLICY.dailyBudgetUsd);
    expect(p.allowRemoteDataClasses).toEqual(['public', 'personal']);
  });
});

describe('CostLedger', () => {
  test('sums by day, month and execution', async () => {
    let now = new Date(2026, 9, 17, 12, 0, 0).getTime();
    const ledger = new CostLedger(undefined, () => now);
    await ledger.record({ providerId: 'oai', modelId: 'm', executionId: 'e1', usd: 0.01 });
    await ledger.record({ providerId: 'oai', modelId: 'm', executionId: 'e2', usd: 0.02 });
    now = new Date(2026, 9, 3, 12).getTime();
    await ledger.record({ providerId: 'oai', modelId: 'm', executionId: 'e1', usd: 0.1 });
    now = new Date(2026, 8, 30, 12).getTime();
    await ledger.record({ providerId: 'oai', modelId: 'm', usd: 1 });
    await ledger.record({ providerId: 'oai', modelId: 'm', usd: 0 }); // ignored
    now = new Date(2026, 9, 17, 18).getTime();
    expect(await ledger.spentToday()).toBeCloseTo(0.03);
    expect(await ledger.spentThisMonth()).toBeCloseTo(0.13);
    expect(await ledger.spentForExecution('e1')).toBeCloseTo(0.11);
  });

  test('estimateCostUsd', () => {
    expect(estimateCostUsd(1_000_000, 500_000, 1, 4)).toBeCloseTo(3);
  });
});

describe('CircuitBreaker', () => {
  test('opens after 3 consecutive failures, half-opens after 60s, closes on success', () => {
    let now = 0;
    const b = new CircuitBreaker({ now: () => now });
    b.recordFailure('p');
    b.recordFailure('p');
    expect(b.state('p')).toBe('closed');
    b.recordSuccess('p'); // resets the streak
    b.recordFailure('p');
    b.recordFailure('p');
    expect(b.canRequest('p')).toBe(true);
    b.recordFailure('p');
    expect(b.state('p')).toBe('open');
    expect(b.canRequest('p')).toBe(false);
    now = 59_999;
    expect(b.state('p')).toBe('open');
    now = 60_000;
    expect(b.state('p')).toBe('half_open');
    expect(b.canRequest('p')).toBe(true);
    b.onDispatch('p');
    expect(b.canRequest('p')).toBe(false); // single probe in flight
    b.recordSuccess('p');
    expect(b.state('p')).toBe('closed');
  });

  test('failed half-open probe re-opens immediately', () => {
    let now = 0;
    const b = new CircuitBreaker({ now: () => now });
    for (let i = 0; i < 3; i++) b.recordFailure('p');
    now = 61_000;
    b.onDispatch('p');
    b.recordFailure('p');
    expect(b.state('p')).toBe('open');
    now = 61_000 + 59_000;
    expect(b.canRequest('p')).toBe(false);
    expect(b.canRequest('other')).toBe(true);
  });
});
