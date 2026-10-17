/**
 * Per-provider circuit breaker: after `failureThreshold` consecutive failures
 * the provider is excluded from routing for `openMs`; then one half-open probe
 * is allowed — success closes the circuit, failure re-opens it.
 * In-memory by design: a restart is a fresh chance for the provider.
 */
export type BreakerState = 'closed' | 'open' | 'half_open';

export interface CircuitBreakerOptions {
  failureThreshold?: number;
  openMs?: number;
  now?: () => number;
}

interface Entry {
  failures: number;
  openedAt: number | null;
  probing: boolean;
}

export class CircuitBreaker {
  private readonly threshold: number;
  private readonly openMs: number;
  private readonly now: () => number;
  private readonly entries = new Map<string, Entry>();

  constructor(opts: CircuitBreakerOptions = {}) {
    this.threshold = opts.failureThreshold ?? 3;
    this.openMs = opts.openMs ?? 60_000;
    this.now = opts.now ?? Date.now;
  }

  private entry(id: string): Entry {
    let e = this.entries.get(id);
    if (!e) {
      e = { failures: 0, openedAt: null, probing: false };
      this.entries.set(id, e);
    }
    return e;
  }

  state(providerId: string): BreakerState {
    const e = this.entries.get(providerId);
    if (!e || e.openedAt === null) return 'closed';
    return this.now() - e.openedAt >= this.openMs ? 'half_open' : 'open';
  }

  /** True when routing may send a call: closed, or half-open with no probe in flight. */
  canRequest(providerId: string): boolean {
    const s = this.state(providerId);
    if (s === 'closed') return true;
    if (s === 'open') return false;
    return !this.entry(providerId).probing;
  }

  /** Call right before dispatching; marks the half-open probe as in flight. */
  onDispatch(providerId: string): void {
    if (this.state(providerId) === 'half_open') this.entry(providerId).probing = true;
  }

  recordSuccess(providerId: string): void {
    const e = this.entry(providerId);
    e.failures = 0;
    e.openedAt = null;
    e.probing = false;
  }

  recordFailure(providerId: string): void {
    const e = this.entry(providerId);
    const wasHalfOpen = this.state(providerId) === 'half_open';
    e.failures += 1;
    e.probing = false;
    if (wasHalfOpen || e.failures >= this.threshold) e.openedAt = this.now();
  }

  reset(providerId?: string): void {
    if (providerId) this.entries.delete(providerId);
    else this.entries.clear();
  }
}
