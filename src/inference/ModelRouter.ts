/**
 * ModelRouter (PRD §6.1–6.4): decides ONE inference step at a time.
 *
 * Routing is per step, not per conversation: a local model may plan and drive
 * tools, a single hard reasoning step may go remote, and the next step is
 * routed from scratch (and lands back on-device unless it too needs help).
 *
 * Stages:
 *   1. capability — tools / vision / structured output / context window /
 *      local RAM fit / local availability.
 *   2. policy — routing mode, connectivity, provider enabled + key, circuit
 *      breaker, data class, per-task call & spend caps, daily & monthly
 *      budgets, models excluded by the caller.
 *   3. rank — hybrid / cloud_preferred / local_only × energy mode.
 *
 * Every eliminated model is reported in `decision.rejected` with its stage and
 * reason, every decision is persisted to routing_decisions and traced.
 */
import type { Tracer } from '../observability/types';
import type { CredentialStore, DeviceContextProvider, DeviceSnapshot } from '../platform/types';
import { getDatabase, type SqlDb } from '../storage/db';
import type { CircuitBreaker } from './CircuitBreaker';
import { CostLedger, estimateCostUsd } from './CostLedger';
import {
  LOCAL_PROVIDER_ID,
  type ModelEntry,
  type ModelRegistry,
  providerKeyName,
  type RemoteProviderConfig,
} from './ModelRegistry';
import { PrivacyGrants } from './privacy';
import { type RoutingPolicy, type RoutingPolicySource } from './RoutingPolicy';
import {
  type Complexity,
  type InferOperation,
  NoEligibleModelError,
  type RoutingContext,
  type RoutingDecision,
} from './types';

/** Minimal surface the router needs from the registry (lets tests pass fakes). */
export type RegistryLike = Pick<ModelRegistry, 'entries' | 'provider'>;
export type LedgerLike = Pick<CostLedger, 'spentToday' | 'spentThisMonth'>;
export type BreakerLike = Pick<CircuitBreaker, 'canRequest' | 'state'>;
export type GrantsLike = Pick<PrivacyGrants, 'has'>;

export interface ModelRouterDeps {
  registry: RegistryLike;
  policyStore: RoutingPolicySource;
  device: DeviceContextProvider;
  credentials: CredentialStore;
  ledger: LedgerLike;
  breaker: BreakerLike;
  tracer?: Tracer;
  now?: () => number;
  grants?: GrantsLike;
  db?: () => Promise<SqlDb>;
  /** Local slugs currently loaded in RAM (no load cost, no new RAM needed). */
  loadedLocalModels?: () => string[];
  /** Whether a local model can be used now (e.g. downloaded). Default: all. */
  localAvailability?: (modelId: string) => boolean | Promise<boolean>;
  /** The user's chosen default chat model, used as a tie-break among unknown-quality locals. */
  preferredLocalModel?: () => string | undefined;
}

export interface RouteOptions {
  /** Exclude every remote model (e.g. user declined sending this step off-device). */
  forbidRemote?: boolean;
  forbidRemoteReason?: string;
}

/** A decision plus bookkeeping the InferenceService uses to record the outcome. */
export interface RoutedDecision extends RoutingDecision {
  decisionId?: number;
  decidedAt: number;
  /** Entry for the selected model (dispatch info: providerModelId, kind). */
  model: ModelEntry;
  dataClass: RoutingContext['dataClass'];
  operation: InferOperation;
}

type Rejected = RoutingDecision['rejected'][number];

const THERMAL_HOT = new Set(['severe', 'critical', 'emergency', 'shutdown']);

interface EnergyState {
  saver: boolean;
  critical: boolean;
  why?: string;
}

export function energyState(policy: RoutingPolicy, d: DeviceSnapshot): EnergyState {
  const battKnown = d.batteryPercent >= 0;
  const critical = battKnown && !d.charging && d.batteryPercent < policy.batteryThresholds.critical;
  if (policy.energy === 'battery_saver')
    return { saver: true, critical, why: 'battery saver mode is on' };
  if (critical) return { saver: true, critical, why: `battery critical (${d.batteryPercent}%)` };
  if (battKnown && !d.charging && d.batteryPercent < policy.batteryThresholds.saverBelow)
    return { saver: true, critical, why: `battery low (${d.batteryPercent}%)` };
  if (THERMAL_HOT.has(d.thermal))
    return { saver: true, critical, why: `device is hot (${d.thermal})` };
  if (d.powerSaveMode) return { saver: true, critical, why: 'system power saving is on' };
  return { saver: false, critical: false };
}

const pct = (n: number) => `${Math.round(n * 100)}%`;

export class ModelRouter {
  constructor(private readonly deps: ModelRouterDeps) {}

  private now(): number {
    return (this.deps.now ?? Date.now)();
  }

  async route(ctx: RoutingContext, opts: RouteOptions = {}): Promise<RoutedDecision> {
    const [policy, device, entries] = await Promise.all([
      this.deps.policyStore.get(),
      this.deps.device.snapshot(),
      this.deps.registry.entries(),
    ]);
    const req = ctx.requirements;
    const op = req.operation;
    const complexity: Complexity = req.complexity ?? 'medium';
    const rejected: Rejected[] = [];
    const loaded = new Set(this.deps.loadedLocalModels?.() ?? []);
    const excluded = new Set(ctx.excludeModels ?? []);
    const energy = energyState(policy, device);
    const neededCtx = Math.max(
      req.minContextTokens ?? 0,
      ctx.estimatedInputTokens + ctx.estimatedOutputTokens,
    );

    // ---- stage 1: capability --------------------------------------------
    const capable: ModelEntry[] = [];
    for (const m of entries) {
      const why = await this.capabilityProblem(m, req, neededCtx, device, loaded);
      if (why) rejected.push({ modelId: m.modelId, stage: 'capability', reason: why });
      else capable.push(m);
    }

    // ---- stage 2: policy --------------------------------------------------
    const local: ModelEntry[] = [];
    const remote: ModelEntry[] = [];
    const budget = new BudgetCache(this.deps.ledger);
    for (const m of capable) {
      const why = excluded.has(m.modelId)
        ? ctx.escalationReason
          ? 'already tried for this step'
          : 'excluded by caller'
        : m.provider === 'remote'
          ? await this.remotePolicyProblem(m, ctx, policy, device, budget, opts)
          : null;
      if (why) rejected.push({ modelId: m.modelId, stage: 'policy', reason: why });
      else (m.provider === 'local' ? local : remote).push(m);
    }

    if (!local.length && !remote.length) {
      const msg = `No eligible model for step "${ctx.stepId}" (${op}): ${summarizeRejections(rejected)}`;
      this.deps.tracer?.record(ctx.executionId, 'routing.decision', {
        stepId: ctx.stepId,
        operation: op,
        selected: null,
        rejected,
      });
      throw new NoEligibleModelError(msg, rejected);
    }

    // ---- stage 3: rank ----------------------------------------------------
    const threshold = policy.localQualityThreshold[complexity];
    const preferred = this.deps.preferredLocalModel?.();
    const rankedLocal = rankLocal(local, op, threshold, policy, energy, loaded, preferred);
    const rankedRemote = rankRemote(remote, op, ctx, policy);
    const { pick, reason } = choose(
      rankedLocal,
      rankedRemote,
      ctx,
      policy,
      energy,
      op,
      complexity,
      threshold,
      loaded,
    );

    // ---- privacy approval -------------------------------------------------
    let requiresUserApproval = false;
    if (pick.provider === 'remote' && ctx.dataClass !== 'public') {
      const grants = this.deps.grants ?? new PrivacyGrants(this.deps.db);
      requiresUserApproval = !(await grants.has(pick.providerId, ctx.dataClass));
    }

    const estimatedCost =
      pick.provider === 'remote'
        ? estimateCostUsd(
            ctx.estimatedInputTokens,
            ctx.estimatedOutputTokens,
            pick.estimatedInputCostPerMillion,
            pick.estimatedOutputCostPerMillion,
          )
        : 0;
    const decision: RoutedDecision = {
      selectedModelId: pick.modelId,
      providerId: pick.providerId,
      executionMode: pick.provider,
      reason:
        reason +
        (requiresUserApproval
          ? ` First ${ctx.dataClass} data sent to ${pick.providerId}: needs your approval.`
          : ''),
      estimatedLatencyMs: estimateLatency(pick, ctx.estimatedOutputTokens),
      estimatedCost: round6(estimatedCost),
      confidence: pick.qualityScores?.[op],
      requiresUserApproval,
      rejected,
      decidedAt: this.now(),
      model: pick,
      dataClass: ctx.dataClass,
      operation: op,
    };

    decision.decisionId = await this.persist(ctx, decision);
    this.deps.tracer?.record(ctx.executionId, 'routing.decision', {
      stepId: ctx.stepId,
      operation: op,
      complexity,
      dataClass: ctx.dataClass,
      selected: decision.selectedModelId,
      provider: decision.providerId,
      mode: decision.executionMode,
      reason: decision.reason,
      estimatedCost: decision.estimatedCost,
      requiresUserApproval,
      escalation: ctx.escalationReason ?? null,
      energy: energy.saver ? (energy.why ?? 'saver') : policy.energy,
      rejected: rejected.map(r => `${r.modelId}:${r.stage}`),
    });
    return decision;
  }

  /** Writes actual cost / latency / outcome back to the persisted decision. */
  async recordOutcome(
    decision: Pick<RoutedDecision, 'decisionId'>,
    outcome: { actualCost?: number; latencyMs?: number; outcome: string },
  ): Promise<void> {
    if (decision.decisionId === undefined) return;
    const db = await (this.deps.db ?? (() => getDatabase()))();
    await db.execute(
      'UPDATE routing_decisions SET actual_cost = ?, latency_ms = ?, outcome = ? WHERE id = ?',
      [
        outcome.actualCost ?? null,
        outcome.latencyMs === undefined ? null : Math.round(outcome.latencyMs),
        outcome.outcome,
        decision.decisionId,
      ],
    );
  }

  private async persist(ctx: RoutingContext, d: RoutedDecision): Promise<number | undefined> {
    try {
      const db = await (this.deps.db ?? (() => getDatabase()))();
      const r = await db.execute(
        `INSERT INTO routing_decisions
          (execution_id, step_id, model_id, provider_id, mode, reason, estimated_cost, at)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
        [
          ctx.executionId,
          ctx.stepId,
          d.selectedModelId,
          d.providerId,
          d.executionMode,
          d.reason,
          d.estimatedCost ?? null,
          d.decidedAt,
        ],
      );
      return r.insertId;
    } catch (e) {
      // Routing must not fail because the audit write failed.
      console.warn('[ModelRouter] could not persist decision:', (e as Error).message);
      return undefined;
    }
  }

  private async capabilityProblem(
    m: ModelEntry,
    req: RoutingContext['requirements'],
    neededCtx: number,
    device: DeviceSnapshot,
    loaded: Set<string>,
  ): Promise<string | null> {
    if (req.toolCalling && !m.supportsToolCalling) return 'no tool calling';
    if (req.vision && !m.supportsVision) return 'no vision input';
    if (req.structuredOutput && !m.supportsStructuredOutput) return 'no structured output';
    if (neededCtx > m.maxContextTokens)
      return `context ${m.maxContextTokens} < ~${neededCtx} tokens needed`;
    if (m.provider === 'local') {
      if (m.minDeviceRamMb && device.totalRamMb > 0 && device.totalRamMb < m.minDeviceRamMb)
        return `needs a ${Math.round(m.minDeviceRamMb / 1024)} GB RAM device`;
      if (
        !loaded.has(m.modelId) &&
        m.estimatedMemoryMB !== undefined &&
        device.availableRamMb >= 0 &&
        m.estimatedMemoryMB > device.availableRamMb
      )
        return `needs ~${m.estimatedMemoryMB} MB RAM, ${device.availableRamMb} MB free`;
      if (this.deps.localAvailability && !(await this.deps.localAvailability(m.modelId)))
        return 'not downloaded';
    }
    return null;
  }

  private async remotePolicyProblem(
    m: ModelEntry,
    ctx: RoutingContext,
    policy: RoutingPolicy,
    device: DeviceSnapshot,
    budget: BudgetCache,
    opts: RouteOptions,
  ): Promise<string | null> {
    if (opts.forbidRemote) return opts.forbidRemoteReason ?? 'remote not allowed for this step';
    if (policy.mode === 'local_only') return 'routing mode is local only';
    if (!device.online) return 'device is offline';
    const cfg: RemoteProviderConfig | undefined = await this.deps.registry.provider(m.providerId);
    if (!cfg) return `provider ${m.providerId} not configured`;
    if (!cfg.enabled) return `provider ${m.providerId} is disabled`;
    if (!(await this.deps.credentials.has(providerKeyName(m.providerId))))
      return `no API key for ${m.providerId}`;
    if (!this.deps.breaker.canRequest(m.providerId))
      return `${m.providerId} circuit ${this.deps.breaker.state(m.providerId)} after repeated failures`;
    if (!policy.allowRemoteDataClasses.includes(ctx.dataClass))
      return `${ctx.dataClass} data may not leave the device`;
    if (ctx.remoteCallsSoFar >= policy.maxRemoteCallsPerTask)
      return `task already made ${ctx.remoteCallsSoFar}/${policy.maxRemoteCallsPerTask} remote calls`;
    const est = estimateCostUsd(
      ctx.estimatedInputTokens,
      ctx.estimatedOutputTokens,
      m.estimatedInputCostPerMillion,
      m.estimatedOutputCostPerMillion,
    );
    if (ctx.spendSoFarUsd + est > policy.maxSpendPerTaskUsd)
      return `would exceed per-task budget ($${fmt(ctx.spendSoFarUsd + est)} > $${fmt(policy.maxSpendPerTaskUsd)})`;
    const today = await budget.today();
    if (today + est > policy.dailyBudgetUsd)
      return `would exceed daily budget ($${fmt(today + est)} > $${fmt(policy.dailyBudgetUsd)})`;
    const month = await budget.month();
    if (month + est > policy.monthlyBudgetUsd)
      return `would exceed monthly budget ($${fmt(month + est)} > $${fmt(policy.monthlyBudgetUsd)})`;
    return null;
  }
}

class BudgetCache {
  private t?: Promise<number>;
  private m?: Promise<number>;
  constructor(private readonly ledger: LedgerLike) {}
  today() {
    return (this.t ??= this.ledger.spentToday());
  }
  month() {
    return (this.m ??= this.ledger.spentThisMonth());
  }
}

// ---- ranking ------------------------------------------------------------

/** 2 = measured ≥ threshold, 1 = unknown, 0 = measured below threshold. */
function bucket(m: ModelEntry, op: InferOperation, threshold: number): number {
  const q = m.qualityScores?.[op];
  if (q === undefined) return 1;
  return q >= threshold ? 2 : 0;
}

type Cmp = (a: ModelEntry, b: ModelEntry) => number;
const by =
  (...cmps: Cmp[]): Cmp =>
  (a, b) => {
    for (const c of cmps) {
      const r = c(a, b);
      if (r) return r;
    }
    return 0;
  };

function rankLocal(
  models: ModelEntry[],
  op: InferOperation,
  threshold: number,
  policy: RoutingPolicy,
  energy: EnergyState,
  loaded: Set<string>,
  preferred: string | undefined,
): ModelEntry[] {
  const q = (m: ModelEntry) => m.qualityScores?.[op] ?? -1;
  const mem = (m: ModelEntry) => m.estimatedMemoryMB ?? 0;
  const isLoaded = (m: ModelEntry) => (loaded.has(m.modelId) ? 1 : 0);
  const isPreferred = (m: ModelEntry) => (m.modelId === preferred ? 1 : 0);
  const usable = (m: ModelEntry) => (bucket(m, op, threshold) > 0 ? 1 : 0);
  let cmp: Cmp;
  if (energy.saver) {
    // Smallest capable model; never pay to load a big one if one is already resident.
    cmp = by(
      (a, b) => usable(b) - usable(a),
      (a, b) => isLoaded(b) - isLoaded(a),
      (a, b) => mem(a) - mem(b),
      (a, b) => q(b) - q(a),
    );
  } else if (policy.energy === 'performance') {
    cmp = by(
      (a, b) => bucket(b, op, threshold) - bucket(a, op, threshold),
      (a, b) => q(b) - q(a),
      (a, b) => isPreferred(b) - isPreferred(a),
      (a, b) => mem(b) - mem(a),
    );
  } else {
    cmp = by(
      (a, b) => bucket(b, op, threshold) - bucket(a, op, threshold),
      (a, b) => q(b) - q(a),
      (a, b) => isLoaded(b) - isLoaded(a),
      (a, b) => isPreferred(b) - isPreferred(a),
      (a, b) => mem(a) - mem(b),
    );
  }
  return [...models].sort(cmp);
}

function rankRemote(
  models: ModelEntry[],
  op: InferOperation,
  ctx: RoutingContext,
  policy: RoutingPolicy,
): ModelEntry[] {
  const q = (m: ModelEntry) => m.qualityScores?.[op] ?? 0.5;
  const cost = (m: ModelEntry) =>
    estimateCostUsd(
      ctx.estimatedInputTokens,
      ctx.estimatedOutputTokens,
      m.estimatedInputCostPerMillion,
      m.estimatedOutputCostPerMillion,
    );
  const lat = (m: ModelEntry) => m.averageLatencyMs ?? Number.MAX_SAFE_INTEGER;
  const cmp =
    policy.energy === 'performance'
      ? by(
          (a, b) => q(b) - q(a),
          (a, b) => lat(a) - lat(b),
          (a, b) => cost(a) - cost(b),
        )
      : by(
          (a, b) => q(b) - q(a),
          (a, b) => cost(a) - cost(b),
          (a, b) => lat(a) - lat(b),
        );
  return [...models].sort(cmp);
}

function choose(
  L: ModelEntry[],
  R: ModelEntry[],
  ctx: RoutingContext,
  policy: RoutingPolicy,
  energy: EnergyState,
  op: InferOperation,
  complexity: Complexity,
  threshold: number,
  loaded: Set<string>,
): { pick: ModelEntry; reason: string } {
  const l = L[0];
  const r = R[0];
  const lq = l?.qualityScores?.[op];
  const describeLocal = (m: ModelEntry) => {
    const q = m.qualityScores?.[op];
    const qual =
      q === undefined
        ? `no measured ${op} quality yet`
        : `measured ${op} success ${pct(q)} vs ${pct(threshold)} threshold`;
    const parts = [qual];
    if (loaded.has(m.modelId)) parts.push('already loaded');
    if (energy.saver) parts.push(`smallest capable model because ${energy.why}`);
    return `${m.displayName} on-device (${parts.join('; ')})`;
  };
  const describeRemote = (m: ModelEntry) =>
    `${m.displayName} via ${m.providerId}${
      m.qualityScores?.[op] !== undefined
        ? ` (measured ${op} success ${pct(m.qualityScores[op]!)})`
        : ''
    }`;
  const localFallback = (why: string) => ({
    pick: l,
    reason: `${why}; using ${describeLocal(l)}.`,
  });

  if (!l) {
    return {
      pick: r,
      reason: `No on-device model can run this ${op} step; using ${describeRemote(r)}.`,
    };
  }
  if (!r) {
    const why =
      policy.mode === 'local_only'
        ? 'Local-only mode'
        : ctx.escalationReason
          ? `Escalation requested (${ctx.escalationReason}) but no remote model is eligible — trying the next local model`
          : policy.mode === 'cloud_preferred'
            ? 'Cloud preferred but no remote model is eligible (offline or blocked by policy)'
            : 'Kept on-device';
    return localFallback(why);
  }

  // Both sides available.
  if (policy.mode === 'cloud_preferred') {
    return { pick: r, reason: `Cloud preferred: using ${describeRemote(r)}.` };
  }
  if (ctx.escalationReason) {
    return {
      pick: r,
      reason: `Escalating this step (${ctx.escalationReason}): using ${describeRemote(r)}; later steps return on-device.`,
    };
  }
  const localGood = lq === undefined || lq >= threshold;
  if (policy.energy === 'performance' && !energy.saver) {
    const rq = r.qualityScores?.[op];
    if (lq !== undefined && rq !== undefined && rq > lq)
      return {
        pick: r,
        reason: `Performance mode: ${describeRemote(r)} outscores the best local model (${pct(lq)}).`,
      };
    if (lq === undefined && complexity === 'high')
      return {
        pick: r,
        reason: `Performance mode, high-complexity step with unmeasured local quality: using ${describeRemote(r)}.`,
      };
  }
  if (complexity === 'high' && (lq === undefined || lq < threshold)) {
    return {
      pick: r,
      reason: `High-complexity ${op} step and no local model has proven ≥ ${pct(threshold)}: using ${describeRemote(r)}.`,
    };
  }
  if (localGood) return { pick: l, reason: `Hybrid: kept on-device with ${describeLocal(l)}.` };
  return {
    pick: r,
    reason: `Best local model scores ${pct(lq!)} on ${op}, below the ${pct(threshold)} threshold: using ${describeRemote(r)}.`,
  };
}

function estimateLatency(m: ModelEntry, outTokens: number): number | undefined {
  if (m.averageLatencyMs !== undefined) return Math.round(m.averageLatencyMs);
  if (m.averageTokensPerSecond) return Math.round((outTokens / m.averageTokensPerSecond) * 1000);
  return undefined;
}

function summarizeRejections(rejected: Rejected[]): string {
  if (!rejected.length) return 'no models configured';
  return rejected
    .slice(0, 8)
    .map(r => `${r.modelId} (${r.reason})`)
    .join('; ');
}

function fmt(n: number): string {
  return n < 0.01 ? n.toFixed(4) : n.toFixed(2);
}

function round6(n: number): number {
  return Math.round(n * 1e6) / 1e6;
}

/** Convenience factory with default ledger / grants (registry + device + credentials required). */
export function createModelRouter(
  deps: Omit<ModelRouterDeps, 'ledger' | 'grants'> & {
    ledger?: LedgerLike;
    grants?: GrantsLike;
  },
): ModelRouter {
  return new ModelRouter({
    ...deps,
    ledger: deps.ledger ?? new CostLedger(deps.db),
    grants: deps.grants ?? new PrivacyGrants(deps.db),
  });
}

export { LOCAL_PROVIDER_ID };
