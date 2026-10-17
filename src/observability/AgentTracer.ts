/**
 * Persistent Tracer (PRD §15.1). record() is synchronous and cheap: events are
 * redacted and buffered, then batch-inserted into `traces` when 25 events are
 * pending, after a 2 s timer, or on flush(). Tracing never throws into the
 * agent — a failed write is logged and the batch dropped.
 */
import { fromJson, getDatabase, type Row, type SqlDb, toJson } from '../storage/db';
import { redactPayload } from './redact';
import type { TraceEvent, Tracer, TraceType } from './types';

export const FLUSH_BATCH_SIZE = 25;
export const FLUSH_INTERVAL_MS = 2000;
/** Cap the in-memory buffer so a dead database can't grow it without bound. */
const MAX_BUFFER = 1000;
const DAY_MS = 24 * 60 * 60 * 1000;

export interface TraceQuery {
  executionId?: string;
  types?: TraceType[];
  /** Only events at or after this epoch-ms. */
  since?: number;
  /** Only events strictly before this epoch-ms. */
  until?: number;
  limit?: number;
  /** Default 'asc' (chronological). */
  order?: 'asc' | 'desc';
}

export interface StoredTraceEvent extends TraceEvent {
  id: number;
}

export interface AgentTracer extends Tracer {
  query(q?: TraceQuery): Promise<StoredTraceEvent[]>;
  /** Deletes events older than `olderThanDays`; returns rows removed. */
  prune(olderThanDays: number, now?: number): Promise<number>;
  /** Pending (unflushed) event count — for tests/diagnostics. */
  pending(): number;
  /** Stops the timer and flushes. */
  dispose(): Promise<void>;
}

export interface TracerOptions {
  batchSize?: number;
  intervalMs?: number;
  now?: () => number;
}

export function createTracer(
  getDb: () => Promise<SqlDb> = () => getDatabase(),
  opts: TracerOptions = {},
): AgentTracer {
  const batchSize = opts.batchSize ?? FLUSH_BATCH_SIZE;
  const intervalMs = opts.intervalMs ?? FLUSH_INTERVAL_MS;
  const now = opts.now ?? Date.now;

  let buffer: TraceEvent[] = [];
  let timer: ReturnType<typeof setTimeout> | null = null;
  let chain: Promise<void> = Promise.resolve();

  const clearTimer = () => {
    if (timer) {
      clearTimeout(timer);
      timer = null;
    }
  };

  const writeBatch = async (batch: TraceEvent[]) => {
    if (!batch.length) return;
    try {
      const db = await getDb();
      await db.transaction(async tx => {
        for (const e of batch) {
          await tx.execute(
            'INSERT INTO traces (execution_id, type, payload_json, at) VALUES (?, ?, ?, ?)',
            [e.executionId, e.type, toJson(e.payload), e.at],
          );
        }
      });
    } catch (err) {
      console.warn('[AgentTracer] dropping trace batch:', (err as Error)?.message ?? err);
    }
  };

  const flush = (): Promise<void> => {
    clearTimer();
    const batch = buffer;
    buffer = [];
    chain = chain.then(() => writeBatch(batch));
    return chain;
  };

  const record: Tracer['record'] = (executionId, type, payload = {}) => {
    let safe: Record<string, unknown>;
    try {
      safe = redactPayload(payload);
    } catch {
      safe = { redactionFailed: true };
    }
    buffer.push({ executionId, type, payload: safe, at: now() });
    if (buffer.length > MAX_BUFFER) buffer.splice(0, buffer.length - MAX_BUFFER);
    if (buffer.length >= batchSize) {
      void flush();
    } else if (!timer) {
      timer = setTimeout(() => {
        timer = null;
        void flush();
      }, intervalMs);
    }
  };

  const query = async (q: TraceQuery = {}): Promise<StoredTraceEvent[]> => {
    await flush();
    const where: string[] = [];
    const params: (string | number)[] = [];
    if (q.executionId !== undefined) {
      where.push('execution_id = ?');
      params.push(q.executionId);
    }
    if (q.types?.length) {
      where.push(`type IN (${q.types.map(() => '?').join(',')})`);
      params.push(...q.types);
    }
    if (q.since !== undefined) {
      where.push('at >= ?');
      params.push(q.since);
    }
    if (q.until !== undefined) {
      where.push('at < ?');
      params.push(q.until);
    }
    const order = q.order === 'desc' ? 'DESC' : 'ASC';
    const limit = Math.max(1, Math.min(q.limit ?? 500, 10000));
    const db = await getDb();
    const r = await db.execute(
      `SELECT id, execution_id, type, payload_json, at FROM traces
       ${where.length ? `WHERE ${where.join(' AND ')}` : ''}
       ORDER BY at ${order}, id ${order} LIMIT ${limit}`,
      params,
    );
    return r.rows.map(rowToEvent);
  };

  const prune = async (olderThanDays: number, at: number = now()): Promise<number> => {
    await flush();
    const cutoff = at - Math.max(0, olderThanDays) * DAY_MS;
    const db = await getDb();
    const r = await db.execute('DELETE FROM traces WHERE at < ?', [cutoff]);
    return r.rowsAffected;
  };

  return {
    record,
    flush,
    query,
    prune,
    pending: () => buffer.length,
    dispose: async () => {
      clearTimer();
      await flush();
    },
  };
}

function rowToEvent(r: Row): StoredTraceEvent {
  return {
    id: Number(r.id),
    executionId: r.execution_id === null ? null : String(r.execution_id),
    type: String(r.type) as TraceType,
    payload: fromJson<Record<string, unknown>>(r.payload_json) ?? {},
    at: Number(r.at),
  };
}

let singleton: AgentTracer | null = null;

/** App-wide tracer, created on first use against the app database. */
export function getTracer(): AgentTracer {
  if (!singleton) singleton = createTracer();
  return singleton;
}

/** Lazily-initialized singleton: nothing is created until a method is called. */
export const tracer: AgentTracer = {
  record: (executionId, type, payload) => getTracer().record(executionId, type, payload),
  flush: () => (singleton ? singleton.flush() : Promise.resolve()),
  query: q => getTracer().query(q),
  prune: (days, at) => getTracer().prune(days, at),
  pending: () => (singleton ? singleton.pending() : 0),
  dispose: () => (singleton ? singleton.dispose() : Promise.resolve()),
};

/** Tests: drop the singleton (pending events are discarded). */
export function resetTracerForTests(): void {
  singleton = null;
}
