/**
 * Running totals of tokens processed on the phone versus sent to cloud models, for "tokens
 * saved by running offline" on the Insights screen. Counts only, never content.
 */
import AsyncStorage from '@react-native-async-storage/async-storage';

const KEY = '@liquid_usage_v1';

export interface UsageTotals {
  localInput: number;
  localOutput: number;
  localCalls: number;
  remoteInput: number;
  remoteOutput: number;
  remoteCalls: number;
  /** When counting started. */
  since: number;
}

/**
 * What the on-device tokens would have cost on a small cloud model (GPT-4o-mini list price,
 * USD per million tokens); shown as an estimate, not a bill.
 */
export const REFERENCE_PRICE = { inputPerM: 0.15, outputPerM: 0.6, label: 'GPT-4o-mini' };

export function savedUsd(t: UsageTotals): number {
  return (
    (t.localInput / 1e6) * REFERENCE_PRICE.inputPerM +
    (t.localOutput / 1e6) * REFERENCE_PRICE.outputPerM
  );
}

const empty = (): UsageTotals => ({
  localInput: 0,
  localOutput: 0,
  localCalls: 0,
  remoteInput: 0,
  remoteOutput: 0,
  remoteCalls: 0,
  since: Date.now(),
});

class UsageLedger {
  private totals: UsageTotals | null = null;
  private loading: Promise<UsageTotals> | null = null;
  private saveTimer: ReturnType<typeof setTimeout> | null = null;

  async get(): Promise<UsageTotals> {
    if (this.totals) return { ...this.totals };
    this.loading ??= AsyncStorage.getItem(KEY)
      .then(raw => ({ ...empty(), ...(raw ? JSON.parse(raw) : {}) }))
      .catch(() => empty());
    this.totals = await this.loading;
    return { ...this.totals };
  }

  /** One model call. Missing counts (a provider that does not report them) add nothing. */
  record(mode: 'local' | 'remote', input?: number, output?: number): void {
    const n = (x?: number) => (Number.isFinite(x) && x! > 0 ? Math.round(x!) : 0);
    this.get()
      .then(() => {
        const t = this.totals!;
        if (mode === 'local') {
          t.localInput += n(input);
          t.localOutput += n(output);
          t.localCalls++;
        } else {
          t.remoteInput += n(input);
          t.remoteOutput += n(output);
          t.remoteCalls++;
        }
        this.saveTimer ??= setTimeout(() => {
          this.saveTimer = null;
          AsyncStorage.setItem(KEY, JSON.stringify(this.totals)).catch(() => undefined);
        }, 3000);
      })
      .catch(() => undefined);
  }

  async reset(): Promise<void> {
    this.totals = empty();
    await AsyncStorage.setItem(KEY, JSON.stringify(this.totals));
  }
}

export const usageLedger = new UsageLedger();
