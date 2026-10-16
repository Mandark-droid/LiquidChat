/**
 * Remote spend ledger (cost_ledger table). Day/month windows use the device's
 * local calendar, which is what users mean by "daily budget".
 */
import { getDatabase, type SqlDb } from '../storage/db';

export interface CostEntry {
  providerId: string;
  modelId: string;
  executionId?: string | null;
  usd: number;
}

export interface SpendSummary {
  todayUsd: number;
  monthUsd: number;
}

export function startOfLocalDay(ms: number): number {
  const d = new Date(ms);
  d.setHours(0, 0, 0, 0);
  return d.getTime();
}

export function startOfLocalMonth(ms: number): number {
  const d = new Date(ms);
  return new Date(d.getFullYear(), d.getMonth(), 1).getTime();
}

export class CostLedger {
  constructor(
    private readonly db: () => Promise<SqlDb> = () => getDatabase(),
    private readonly now: () => number = Date.now,
  ) {}

  async record(e: CostEntry): Promise<void> {
    if (!Number.isFinite(e.usd) || e.usd <= 0) return;
    const db = await this.db();
    await db.execute(
      'INSERT INTO cost_ledger (provider_id, model_id, execution_id, usd, at) VALUES (?, ?, ?, ?, ?)',
      [e.providerId, e.modelId, e.executionId ?? null, e.usd, this.now()],
    );
  }

  async spentSince(sinceMs: number): Promise<number> {
    const db = await this.db();
    const r = await db.execute('SELECT COALESCE(SUM(usd), 0) AS s FROM cost_ledger WHERE at >= ?', [
      sinceMs,
    ]);
    return Number(r.rows[0]?.s ?? 0);
  }

  spentToday(): Promise<number> {
    return this.spentSince(startOfLocalDay(this.now()));
  }

  spentThisMonth(): Promise<number> {
    return this.spentSince(startOfLocalMonth(this.now()));
  }

  async spentForExecution(executionId: string): Promise<number> {
    const db = await this.db();
    const r = await db.execute(
      'SELECT COALESCE(SUM(usd), 0) AS s FROM cost_ledger WHERE execution_id = ?',
      [executionId],
    );
    return Number(r.rows[0]?.s ?? 0);
  }

  async summary(): Promise<SpendSummary> {
    const [todayUsd, monthUsd] = await Promise.all([this.spentToday(), this.spentThisMonth()]);
    return { todayUsd, monthUsd };
  }
}

/** USD estimate for a call given per-million prices. */
export function estimateCostUsd(
  inputTokens: number,
  outputTokens: number,
  inputPerM = 0,
  outputPerM = 0,
): number {
  return (Math.max(0, inputTokens) * inputPerM + Math.max(0, outputTokens) * outputPerM) / 1e6;
}
