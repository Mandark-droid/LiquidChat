/**
 * InferenceService — the single entry point the agent executor uses for a
 * model call. One call = one inference STEP:
 *
 *   route → (privacy approval) → minimize if remote → provider.complete
 *         → record cost / breaker / stats / decision outcome
 *         → on failure: retry (retryable remote errors) then re-route with the
 *           failed model excluded, bounded by maxRouteAttempts.
 *
 * Nothing here is sticky across steps: the next step calls run() again and is
 * routed from scratch, so a remote escalation never "captures" the workflow.
 */
import { nullTracer, type Tracer } from '../observability/types';
import type { CredentialStore, DeviceContextProvider } from '../platform/types';
import { getDatabase, type SqlDb } from '../storage/db';
import { CircuitBreaker } from './CircuitBreaker';
import { CostLedger } from './CostLedger';
import { isAbortError, ProviderError } from './errors';
import { ModelRegistry, type RemoteProviderConfig } from './ModelRegistry';
import { ModelRouter, type RoutedDecision, type RouteOptions } from './ModelRouter';
import { minimizeForRemote, PrivacyGrants, type Redaction } from './privacy';
import { AnthropicProvider } from './providers/AnthropicProvider';
import { CactusProvider } from './providers/CactusProvider';
import { GeminiProvider } from './providers/GeminiProvider';
import type { FetchLike } from './providers/http';
import { OpenAICompatibleProvider } from './providers/OpenAICompatibleProvider';
import { RoutingPolicyStore } from './RoutingPolicy';
import {
  type InferenceProvider,
  type InferenceRequest,
  type InferenceResult,
  NoEligibleModelError,
  type RoutingContext,
  type RoutingDecision,
} from './types';

export interface RunOptions {
  signal?: AbortSignal;
  /**
   * Asked when a step would send personal/sensitive data to a provider for the
   * first time. true ⇒ grant is persisted; false ⇒ step is re-routed on-device.
   * Absent ⇒ treated as "deny".
   */
  approve?: (decision: RoutingDecision) => Promise<boolean>;
  /** Hard cap for the whole step including local generation (remote calls also use policy timeout). */
  timeoutMs?: number;
  onDecision?: (decision: RoutingDecision) => void;
}

export interface AttemptRecord {
  modelId: string;
  providerId: string;
  mode: 'local' | 'remote';
  outcome: 'success' | 'error' | 'denied';
  error?: { kind: string; message: string; retryable: boolean };
  latencyMs?: number;
  costUsd?: number;
}

export interface RunOutcome {
  result: InferenceResult;
  decision: RoutingDecision;
  /** Every model tried for this step, in order. */
  attempts: AttemptRecord[];
  /** Remote calls actually dispatched by this step (incl. failed ones) — add to the task's count. */
  remoteCalls: number;
  /** USD spent by this step — add to the task's spend. */
  spendUsd: number;
  redactions: Redaction[];
}

export class InferenceFailedError extends Error {
  constructor(
    message: string,
    readonly attempts: AttemptRecord[],
    readonly lastError?: unknown,
  ) {
    super(message);
    this.name = 'InferenceFailedError';
  }
}

export class InferenceCancelledError extends Error {
  constructor() {
    super('Inference cancelled');
    this.name = 'InferenceCancelledError';
  }
}

type RouterLike = Pick<ModelRouter, 'route' | 'recordOutcome'>;
type RegistryLike = Pick<ModelRegistry, 'recordSample' | 'provider'>;

export interface InferenceServiceDeps {
  router: RouterLike;
  registry: RegistryLike;
  ledger: Pick<CostLedger, 'record'>;
  breaker: Pick<CircuitBreaker, 'recordSuccess' | 'recordFailure' | 'onDispatch'>;
  grants: Pick<PrivacyGrants, 'grant'>;
  policyStore: Pick<RoutingPolicyStore, 'get'>;
  /** Resolves the provider implementation for a decision. */
  providerFor: (decision: RoutedDecision) => Promise<InferenceProvider>;
  tracer?: Tracer;
  sleep?: (ms: number) => Promise<void>;
  /** Max distinct models tried per step (route attempts). Default 3. */
  maxRouteAttempts?: number;
  retryBackoffMs?: number;
}

const defaultSleep = (ms: number) => new Promise<void>(r => setTimeout(r, ms));

export class InferenceService {
  private readonly tracer: Tracer;
  private readonly lastModelForStep = new Map<string, string>();

  constructor(private readonly deps: InferenceServiceDeps) {
    this.tracer = deps.tracer ?? nullTracer;
  }

  async run(
    ctx: RoutingContext,
    req: InferenceRequest,
    opts: RunOptions = {},
  ): Promise<RunOutcome> {
    const policy = await this.deps.policyStore.get();
    const maxRoutes = this.deps.maxRouteAttempts ?? 3;
    const attempts: AttemptRecord[] = [];
    const exclude = new Set(ctx.excludeModels ?? []);
    const routeOpts: RouteOptions = {};
    let remoteCalls = 0;
    let spendUsd = 0;
    let lastError: unknown;

    const { signal, cleanup } = linkSignal(opts.signal, opts.timeoutMs);
    try {
      // Approval denials don't consume a model attempt but are bounded too.
      for (let route = 0, guard = 0; route < maxRoutes && guard < maxRoutes + 2; guard++) {
        if (signal.aborted) throw this.abortReason(opts, signal);
        const stepCtx: RoutingContext = {
          ...ctx,
          excludeModels: [...exclude],
          remoteCallsSoFar: ctx.remoteCallsSoFar + remoteCalls,
          spendSoFarUsd: ctx.spendSoFarUsd + spendUsd,
        };
        let decision: RoutedDecision;
        try {
          decision = await this.deps.router.route(stepCtx, routeOpts);
        } catch (e) {
          if (e instanceof NoEligibleModelError && attempts.length) {
            throw new InferenceFailedError(
              `All eligible models failed for step "${ctx.stepId}": ${describe(lastError)}`,
              attempts,
              lastError,
            );
          }
          throw e;
        }
        opts.onDecision?.(decision);

        // ---- privacy approval (first send of this data class to this provider)
        if (decision.requiresUserApproval) {
          const ok = opts.approve ? await opts.approve(publicDecision(decision)) : false;
          this.tracer.record(ctx.executionId, 'approval', {
            kind: 'remote_data',
            stepId: ctx.stepId,
            provider: decision.providerId,
            dataClass: ctx.dataClass,
            approved: ok,
          });
          if (!ok) {
            attempts.push({
              modelId: decision.selectedModelId,
              providerId: decision.providerId,
              mode: decision.executionMode,
              outcome: 'denied',
            });
            await this.safeOutcome(decision, { outcome: 'denied_by_user' });
            routeOpts.forbidRemote = true;
            routeOpts.forbidRemoteReason = `you declined sending ${ctx.dataClass} data off-device`;
            continue;
          }
          await this.deps.grants.grant(decision.providerId, ctx.dataClass);
        }
        route++;

        // ---- data minimization for remote steps
        let request = req;
        let redactions: Redaction[] = [];
        if (decision.executionMode === 'remote') {
          const min = minimizeForRemote(req.messages, {
            dataClass: ctx.dataClass,
            allowImages: !!ctx.requirements.vision,
          });
          request = { ...req, messages: min.messages };
          redactions = min.redactions;
          if (redactions.length)
            this.tracer.record(ctx.executionId, 'policy.violation_blocked', {
              stepId: ctx.stepId,
              kind: 'redaction',
              provider: decision.providerId,
              redactions,
            });
        }

        // ---- call, with retries for retryable remote errors
        const provider = await this.deps.providerFor(decision);
        const tries = decision.executionMode === 'remote' ? 1 + policy.providerRetries : 1;
        for (let t = 0; t < tries; t++) {
          if (signal.aborted) throw this.abortReason(opts, signal);
          if (decision.executionMode === 'remote') {
            this.deps.breaker.onDispatch(decision.providerId);
            remoteCalls++;
          }
          const started = Date.now();
          try {
            const result = await provider.complete(decision.model.providerModelId, request, signal);
            const normalized: InferenceResult = {
              ...result,
              modelId: decision.selectedModelId,
              provider: decision.providerId,
              mode: decision.executionMode,
            };
            await this.onSuccess(ctx, decision, normalized);
            spendUsd += normalized.costUsd ?? 0;
            attempts.push({
              modelId: decision.selectedModelId,
              providerId: decision.providerId,
              mode: decision.executionMode,
              outcome: 'success',
              latencyMs: normalized.latencyMs,
              costUsd: normalized.costUsd,
            });
            this.lastModelForStep.set(stepKey(ctx), decision.selectedModelId);
            return {
              result: normalized,
              decision: publicDecision(decision),
              attempts,
              remoteCalls,
              spendUsd,
              redactions,
            };
          } catch (e) {
            if (isAbortError(e) || signal.aborted) {
              await this.safeOutcome(decision, { outcome: 'cancelled' });
              throw this.abortReason(opts, signal, e);
            }
            lastError = e;
            const pe = e instanceof ProviderError ? e : undefined;
            if (decision.executionMode === 'remote')
              this.deps.breaker.recordFailure(decision.providerId);
            attempts.push({
              modelId: decision.selectedModelId,
              providerId: decision.providerId,
              mode: decision.executionMode,
              outcome: 'error',
              latencyMs: Date.now() - started,
              error: {
                kind: pe?.kind ?? 'unknown',
                message: describe(e),
                retryable: pe?.retryable ?? false,
              },
            });
            this.tracer.record(ctx.executionId, 'retry', {
              stepId: ctx.stepId,
              model: decision.selectedModelId,
              provider: decision.providerId,
              error: pe?.kind ?? 'unknown',
              message: describe(e),
              willRetrySameModel: !!pe?.retryable && t + 1 < tries,
            });
            if (!pe?.retryable || t + 1 >= tries) {
              await this.safeOutcome(decision, {
                outcome: `error:${pe?.kind ?? 'unknown'}`,
                latencyMs: Date.now() - started,
              });
              break;
            }
            await (this.deps.sleep ?? defaultSleep)((this.deps.retryBackoffMs ?? 500) * (t + 1));
          }
        }
        exclude.add(decision.selectedModelId);
      }
      throw new InferenceFailedError(
        `Step "${ctx.stepId}" failed after ${attempts.length} attempt(s): ${describe(lastError)}`,
        attempts,
        lastError,
      );
    } finally {
      cleanup();
    }
  }

  /**
   * Per-step escalation: re-run the same step with an escalation reason and the
   * model that just failed verification excluded. The router then prefers a
   * remote model (if policy allows) or the next-best local one. The failed
   * model's per-operation quality is downgraded.
   */
  async escalate(
    ctx: RoutingContext,
    req: InferenceRequest,
    reason: string,
    opts: RunOptions & { failedModelId?: string } = {},
  ): Promise<RunOutcome> {
    const failed = opts.failedModelId ?? this.lastModelForStep.get(stepKey(ctx));
    if (failed) await this.reportQuality(failed, ctx.requirements.operation, false);
    const exclude = new Set(ctx.excludeModels ?? []);
    if (failed) exclude.add(failed);
    this.tracer.record(ctx.executionId, 'routing.decision', {
      stepId: ctx.stepId,
      escalation: reason,
      failedModel: failed ?? null,
    });
    return this.run({ ...ctx, escalationReason: reason, excludeModels: [...exclude] }, req, opts);
  }

  /**
   * Feed verification results back (the executor's verifier knows whether the
   * output was usable). This is what builds measured qualityScores.
   */
  async reportQuality(
    modelId: string,
    operation: RoutingContext['requirements']['operation'],
    success: boolean,
  ): Promise<void> {
    try {
      await this.deps.registry.recordSample(modelId, { operation, success });
    } catch (e) {
      console.warn('[Inference] could not record quality sample:', describe(e));
    }
  }

  private async onSuccess(ctx: RoutingContext, d: RoutedDecision, r: InferenceResult) {
    if (d.executionMode === 'remote') this.deps.breaker.recordSuccess(d.providerId);
    const tasks: Promise<unknown>[] = [
      this.deps.registry.recordSample(d.selectedModelId, {
        latencyMs: r.latencyMs,
        tps: r.tokensPerSecond,
      }),
      this.safeOutcome(d, { outcome: 'success', latencyMs: r.latencyMs, actualCost: r.costUsd }),
    ];
    if (r.costUsd && r.costUsd > 0)
      tasks.push(
        this.deps.ledger.record({
          providerId: d.providerId,
          modelId: d.selectedModelId,
          executionId: ctx.executionId,
          usd: r.costUsd,
        }),
      );
    const settled = await Promise.allSettled(tasks);
    for (const s of settled)
      if (s.status === 'rejected')
        console.warn('[Inference] bookkeeping failed:', describe(s.reason));
    this.tracer.record(ctx.executionId, 'inference', {
      stepId: ctx.stepId,
      operation: ctx.requirements.operation,
      model: d.selectedModelId,
      provider: d.providerId,
      mode: d.executionMode,
      latencyMs: r.latencyMs,
      inputTokens: r.inputTokens ?? null,
      outputTokens: r.outputTokens ?? null,
      tps: r.tokensPerSecond ?? null,
      costUsd: r.costUsd ?? 0,
      confidence: r.confidence ?? null,
      ramUsageMb: r.ramUsageMb ?? null,
      functionCalls: r.functionCalls?.map(f => f.name) ?? [],
    });
  }

  private async safeOutcome(
    d: RoutedDecision,
    o: { outcome: string; latencyMs?: number; actualCost?: number },
  ): Promise<void> {
    try {
      await this.deps.router.recordOutcome(d, o);
    } catch (e) {
      console.warn('[Inference] could not record routing outcome:', describe(e));
    }
  }

  private abortReason(opts: RunOptions, signal: AbortSignal, cause?: unknown): Error {
    if (opts.signal?.aborted) return new InferenceCancelledError();
    if (signal.aborted && opts.timeoutMs)
      return new ProviderError('timeout', `Step timed out after ${opts.timeoutMs} ms`, 'inference');
    return cause instanceof Error ? cause : new InferenceCancelledError();
  }
}

/** Strips internal bookkeeping (registry entry etc.) from the decision the agent sees. */
function publicDecision(d: RoutedDecision): RoutingDecision {
  return {
    selectedModelId: d.selectedModelId,
    providerId: d.providerId,
    executionMode: d.executionMode,
    reason: d.reason,
    estimatedLatencyMs: d.estimatedLatencyMs,
    estimatedCost: d.estimatedCost,
    confidence: d.confidence,
    requiresUserApproval: d.requiresUserApproval,
    rejected: d.rejected,
  };
}

function stepKey(ctx: RoutingContext): string {
  return `${ctx.executionId}::${ctx.stepId}`;
}

function describe(e: unknown): string {
  if (!e) return 'unknown error';
  return e instanceof Error ? e.message : String(e);
}

function linkSignal(
  parent: AbortSignal | undefined,
  timeoutMs: number | undefined,
): { signal: AbortSignal; cleanup: () => void } {
  const ctrl = new AbortController();
  const onAbort = () => ctrl.abort();
  if (parent?.aborted) ctrl.abort();
  parent?.addEventListener?.('abort', onAbort);
  const timer = timeoutMs ? setTimeout(() => ctrl.abort(), timeoutMs) : undefined;
  return {
    signal: ctrl.signal,
    cleanup: () => {
      if (timer) clearTimeout(timer);
      parent?.removeEventListener?.('abort', onAbort);
    },
  };
}

// ---- production wiring ----------------------------------------------------

export interface InferenceWiring {
  credentials: CredentialStore;
  device: DeviceContextProvider;
  tracer?: Tracer;
  fetch?: FetchLike;
  db?: () => Promise<SqlDb>;
  /** The user's default chat model slug (tie-break among unmeasured local models). */
  preferredLocalModel?: () => string | undefined;
  localAvailability?: (modelId: string) => boolean | Promise<boolean>;
}

export interface InferenceStack {
  service: InferenceService;
  router: ModelRouter;
  registry: ModelRegistry;
  policyStore: RoutingPolicyStore;
  ledger: CostLedger;
  breaker: CircuitBreaker;
  grants: PrivacyGrants;
}

export function createRemoteProvider(
  config: RemoteProviderConfig,
  credentials: CredentialStore,
  timeoutMs: () => Promise<number>,
  fetchImpl?: FetchLike,
): InferenceProvider {
  const deps = { config, credentials, timeoutMs, fetch: fetchImpl };
  switch (config.kind) {
    case 'openai':
      return new OpenAICompatibleProvider(deps);
    case 'anthropic':
      return new AnthropicProvider(deps);
    case 'gemini':
      return new GeminiProvider(deps);
  }
}

/** Builds the full stack with real providers. */
export function createInferenceStack(w: InferenceWiring): InferenceStack {
  const db = w.db ?? (() => getDatabase());
  const registry = new ModelRegistry({ credentials: w.credentials, db });
  const policyStore = new RoutingPolicyStore();
  const ledger = new CostLedger(db);
  const breaker = new CircuitBreaker();
  const grants = new PrivacyGrants(db);
  const loadedLocalModels = (): string[] => {
    try {
      const { modelLifecycle } = require('../services/ModelLifecycleManager') as {
        modelLifecycle: { getLoadedModels(): { slug: string }[] };
      };
      return modelLifecycle.getLoadedModels().map(m => m.slug);
    } catch {
      return [];
    }
  };
  const router = new ModelRouter({
    registry,
    policyStore,
    device: w.device,
    credentials: w.credentials,
    ledger,
    breaker,
    grants,
    tracer: w.tracer,
    db,
    loadedLocalModels,
    preferredLocalModel: w.preferredLocalModel,
    localAvailability: w.localAvailability,
  });
  const local = new CactusProvider();
  const remoteCache = new Map<string, { sig: string; provider: InferenceProvider }>();
  const timeoutMs = async () => (await policyStore.get()).providerTimeoutMs;
  const providerFor = async (d: RoutedDecision): Promise<InferenceProvider> => {
    if (d.executionMode === 'local') return local;
    const cfg = await registry.provider(d.providerId);
    if (!cfg)
      throw new ProviderError(
        'unavailable',
        `Provider ${d.providerId} is not configured`,
        d.providerId,
      );
    const sig = JSON.stringify(cfg);
    const hit = remoteCache.get(cfg.id);
    if (hit && hit.sig === sig) return hit.provider;
    const provider = createRemoteProvider(cfg, w.credentials, timeoutMs, w.fetch);
    remoteCache.set(cfg.id, { sig, provider });
    return provider;
  };
  const service = new InferenceService({
    router,
    registry,
    ledger,
    breaker,
    grants,
    policyStore,
    providerFor,
    tracer: w.tracer,
  });
  return { service, router, registry, policyStore, ledger, breaker, grants };
}

let singleton: InferenceStack | null = null;

/** Wires the app-wide inference stack once (call at startup with platform implementations). */
export function initInference(w: InferenceWiring): InferenceStack {
  singleton = createInferenceStack(w);
  return singleton;
}

/** The app-wide InferenceService. Throws if initInference() hasn't run. */
export function inference(): InferenceService {
  if (!singleton) throw new Error('Inference not initialised: call initInference() at startup');
  return singleton.service;
}

/** Router / registry / policy / ledger for settings screens. */
export function inferenceStack(): InferenceStack {
  if (!singleton) throw new Error('Inference not initialised: call initInference() at startup');
  return singleton;
}

export function resetInferenceForTests(): void {
  singleton = null;
}
