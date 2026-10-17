/**
 * User routing policy (PRD §6.2), persisted in AsyncStorage
 * ('@liquid_routing_policy'). Defaults keep everything on-device except
 * public-data steps, with tight per-task and calendar budgets.
 */
import AsyncStorage from '@react-native-async-storage/async-storage';

import type { KeyValueStore } from './ModelRegistry';
import type { Complexity, DataClass, EnergyMode, RoutingMode } from './types';

export const ROUTING_POLICY_KEY = '@liquid_routing_policy';

export interface RoutingPolicy {
  mode: RoutingMode;
  energy: EnergyMode;
  /** Data classes allowed to leave the device at all. */
  allowRemoteDataClasses: DataClass[];
  maxRemoteCallsPerTask: number;
  maxSpendPerTaskUsd: number;
  dailyBudgetUsd: number;
  monthlyBudgetUsd: number;
  providerTimeoutMs: number;
  /** Retries on the same remote model for retryable errors before falling back. */
  providerRetries: number;
  /** Measured local success rate needed to keep a step local, per complexity. */
  localQualityThreshold: Record<Complexity, number>;
  batteryThresholds: { saverBelow: number; critical: number };
}

export const DEFAULT_ROUTING_POLICY: RoutingPolicy = {
  mode: 'hybrid',
  energy: 'balanced',
  allowRemoteDataClasses: ['public'],
  maxRemoteCallsPerTask: 3,
  maxSpendPerTaskUsd: 0.05,
  dailyBudgetUsd: 0.5,
  monthlyBudgetUsd: 5,
  providerTimeoutMs: 20_000,
  providerRetries: 1,
  localQualityThreshold: { low: 0.5, medium: 0.7, high: 0.85 },
  batteryThresholds: { saverBelow: 20, critical: 10 },
};

const MODES: RoutingMode[] = ['local_only', 'hybrid', 'cloud_preferred'];
const ENERGY: EnergyMode[] = ['battery_saver', 'balanced', 'performance'];
const CLASSES: DataClass[] = ['public', 'personal', 'sensitive'];

/** Coerces untrusted stored JSON into a valid policy, falling back field-by-field. */
export function normalizePolicy(raw: unknown): RoutingPolicy {
  const d = DEFAULT_ROUTING_POLICY;
  const r = (raw && typeof raw === 'object' ? raw : {}) as Partial<RoutingPolicy>;
  const num = (v: unknown, def: number, min = 0, max = Number.MAX_SAFE_INTEGER) =>
    typeof v === 'number' && Number.isFinite(v) && v >= min && v <= max ? v : def;
  const lqt = (r.localQualityThreshold ?? {}) as Partial<Record<Complexity, number>>;
  const bt = (r.batteryThresholds ?? {}) as Partial<RoutingPolicy['batteryThresholds']>;
  return {
    mode: MODES.includes(r.mode as RoutingMode) ? (r.mode as RoutingMode) : d.mode,
    energy: ENERGY.includes(r.energy as EnergyMode) ? (r.energy as EnergyMode) : d.energy,
    allowRemoteDataClasses: Array.isArray(r.allowRemoteDataClasses)
      ? [...new Set(r.allowRemoteDataClasses.filter(c => CLASSES.includes(c)))]
      : [...d.allowRemoteDataClasses],
    maxRemoteCallsPerTask: Math.floor(num(r.maxRemoteCallsPerTask, d.maxRemoteCallsPerTask)),
    maxSpendPerTaskUsd: num(r.maxSpendPerTaskUsd, d.maxSpendPerTaskUsd),
    dailyBudgetUsd: num(r.dailyBudgetUsd, d.dailyBudgetUsd),
    monthlyBudgetUsd: num(r.monthlyBudgetUsd, d.monthlyBudgetUsd),
    providerTimeoutMs: num(r.providerTimeoutMs, d.providerTimeoutMs, 1000, 600_000),
    providerRetries: Math.floor(num(r.providerRetries, d.providerRetries, 0, 5)),
    localQualityThreshold: {
      low: num(lqt.low, d.localQualityThreshold.low, 0, 1),
      medium: num(lqt.medium, d.localQualityThreshold.medium, 0, 1),
      high: num(lqt.high, d.localQualityThreshold.high, 0, 1),
    },
    batteryThresholds: {
      saverBelow: num(bt.saverBelow, d.batteryThresholds.saverBelow, 0, 100),
      critical: num(bt.critical, d.batteryThresholds.critical, 0, 100),
    },
  };
}

export interface RoutingPolicySource {
  get(): Promise<RoutingPolicy>;
}

export class RoutingPolicyStore implements RoutingPolicySource {
  private cache: RoutingPolicy | null = null;
  constructor(private readonly storage: KeyValueStore = AsyncStorage) {}

  async get(): Promise<RoutingPolicy> {
    if (this.cache) return this.cache;
    let raw: unknown = undefined;
    try {
      const s = await this.storage.getItem(ROUTING_POLICY_KEY);
      raw = s ? JSON.parse(s) : undefined;
    } catch {
      raw = undefined;
    }
    this.cache = normalizePolicy(raw);
    return this.cache;
  }

  async update(patch: Partial<RoutingPolicy>): Promise<RoutingPolicy> {
    const cur = await this.get();
    const next = normalizePolicy({
      ...cur,
      ...patch,
      localQualityThreshold: { ...cur.localQualityThreshold, ...patch.localQualityThreshold },
      batteryThresholds: { ...cur.batteryThresholds, ...patch.batteryThresholds },
    });
    await this.storage.setItem(ROUTING_POLICY_KEY, JSON.stringify(next));
    this.cache = next;
    return next;
  }

  async reset(): Promise<RoutingPolicy> {
    await this.storage.setItem(ROUTING_POLICY_KEY, JSON.stringify(DEFAULT_ROUTING_POLICY));
    this.cache = normalizePolicy(DEFAULT_ROUTING_POLICY);
    return this.cache;
  }

  invalidate(): void {
    this.cache = null;
  }
}
