/**
 * Persistence for agent executions (PRD §5.2): every state transition, step
 * record and tool call is written before the runtime moves on, so a restart
 * can resume safely and never replays a non-idempotent call.
 */
import type {
  AgentRequest,
  ExecutionRecord,
  ExecutionState,
  Plan,
  StepRecord,
} from '../agent/types';
import type { RiskLevel, ToolError } from '../tools/types';
import { fromJson, getDatabase, type Row, type SqlDb, toJson } from './db';

export type ToolCallStatus = 'started' | 'succeeded' | 'failed' | 'denied';

export interface ToolCallRow {
  id: string;
  executionId: string;
  stepId: string;
  tool: string;
  args?: unknown;
  status: ToolCallStatus;
  result?: unknown;
  idempotent: boolean;
  risk: RiskLevel;
  approvedBy?: string;
  startedAt: number;
  endedAt?: number;
}

export class ExecutionRepository {
  constructor(private readonly db: () => Promise<SqlDb> = () => getDatabase()) {}

  async create(id: string, request: AgentRequest, now = Date.now()): Promise<ExecutionRecord> {
    const db = await this.db();
    await db.execute(
      `INSERT INTO executions (id, request_json, state, created_at, updated_at) VALUES (?, ?, 'CREATED', ?, ?)`,
      [id, JSON.stringify(stripImages(request)), now, now],
    );
    await db.execute(
      'INSERT INTO state_transitions (execution_id, from_state, to_state, reason, at) VALUES (?, NULL, ?, ?, ?)',
      [id, 'CREATED', 'created', now],
    );
    return {
      id,
      request,
      state: 'CREATED',
      steps: {},
      createdAt: now,
      updatedAt: now,
      remoteCalls: 0,
      spendUsd: 0,
    };
  }

  async transition(
    id: string,
    from: ExecutionState,
    to: ExecutionState,
    reason?: string,
    waitingOn?: string,
  ): Promise<void> {
    const db = await this.db();
    const now = Date.now();
    await db.transaction(async tx => {
      await tx.execute(
        'UPDATE executions SET state = ?, waiting_on = ?, updated_at = ? WHERE id = ?',
        [to, waitingOn ?? null, now, id],
      );
      await tx.execute(
        'INSERT INTO state_transitions (execution_id, from_state, to_state, reason, at) VALUES (?, ?, ?, ?, ?)',
        [id, from, to, reason ?? null, now],
      );
    });
  }

  async savePlan(id: string, plan: Plan): Promise<void> {
    const db = await this.db();
    await db.execute('UPDATE executions SET plan_json = ?, updated_at = ? WHERE id = ?', [
      toJson(plan),
      Date.now(),
      id,
    ]);
  }

  async saveStep(id: string, step: StepRecord): Promise<void> {
    const db = await this.db();
    await db.execute(
      `INSERT INTO execution_steps (execution_id, step_id, record_json) VALUES (?, ?, ?)
       ON CONFLICT(execution_id, step_id) DO UPDATE SET record_json = excluded.record_json`,
      [id, step.stepId, JSON.stringify(step)],
    );
  }

  async finish(
    id: string,
    response: string | undefined,
    error: ToolError | undefined,
  ): Promise<void> {
    const db = await this.db();
    await db.execute(
      'UPDATE executions SET response = ?, error_json = ?, updated_at = ? WHERE id = ?',
      [response ?? null, toJson(error), Date.now(), id],
    );
  }

  async addSpend(id: string, usd: number, remoteCall: boolean): Promise<void> {
    const db = await this.db();
    await db.execute(
      'UPDATE executions SET spend_usd = spend_usd + ?, remote_calls = remote_calls + ? WHERE id = ?',
      [usd, remoteCall ? 1 : 0, id],
    );
  }

  async requestCancel(id: string): Promise<void> {
    const db = await this.db();
    await db.execute('UPDATE executions SET cancel_requested = 1, updated_at = ? WHERE id = ?', [
      Date.now(),
      id,
    ]);
  }

  async isCancelRequested(id: string): Promise<boolean> {
    const db = await this.db();
    const r = await db.execute('SELECT cancel_requested FROM executions WHERE id = ?', [id]);
    return Number(r.rows[0]?.cancel_requested ?? 0) === 1;
  }

  async get(id: string): Promise<ExecutionRecord | null> {
    const db = await this.db();
    const r = await db.execute('SELECT * FROM executions WHERE id = ?', [id]);
    const row = r.rows[0];
    if (!row) return null;
    const steps = await db.execute(
      'SELECT record_json FROM execution_steps WHERE execution_id = ?',
      [id],
    );
    return rowToRecord(row, steps.rows);
  }

  async list(opts: { states?: ExecutionState[]; limit?: number } = {}): Promise<ExecutionRecord[]> {
    const db = await this.db();
    const params: (string | number)[] = [];
    let where = '';
    if (opts.states?.length) {
      where = `WHERE state IN (${opts.states.map(() => '?').join(',')})`;
      params.push(...opts.states);
    }
    params.push(opts.limit ?? 50);
    const r = await db.execute(
      `SELECT * FROM executions ${where} ORDER BY created_at DESC LIMIT ?`,
      params,
    );
    const out: ExecutionRecord[] = [];
    for (const row of r.rows) {
      const steps = await db.execute(
        'SELECT record_json FROM execution_steps WHERE execution_id = ?',
        [String(row.id)],
      );
      out.push(rowToRecord(row, steps.rows));
    }
    return out;
  }

  async transitions(
    id: string,
  ): Promise<{ from: string | null; to: string; reason: string | null; at: number }[]> {
    const db = await this.db();
    const r = await db.execute(
      'SELECT from_state, to_state, reason, at FROM state_transitions WHERE execution_id = ? ORDER BY id',
      [id],
    );
    return r.rows.map(x => ({
      from: (x.from_state as string) ?? null,
      to: String(x.to_state),
      reason: (x.reason as string) ?? null,
      at: Number(x.at),
    }));
  }

  // --- tool calls (idempotency / dedupe) -------------------------------------

  async toolCall(id: string): Promise<ToolCallRow | null> {
    const db = await this.db();
    const r = await db.execute('SELECT * FROM tool_calls WHERE id = ?', [id]);
    const x = r.rows[0];
    return x ? rowToToolCall(x) : null;
  }

  async startToolCall(c: Omit<ToolCallRow, 'status' | 'startedAt'>): Promise<void> {
    const db = await this.db();
    await db.execute(
      `INSERT INTO tool_calls (id, execution_id, step_id, tool, args_json, status, idempotent, risk, approved_by, started_at)
       VALUES (?, ?, ?, ?, ?, 'started', ?, ?, ?, ?)
       ON CONFLICT(id) DO UPDATE SET status = 'started', args_json = excluded.args_json, started_at = excluded.started_at, ended_at = NULL`,
      [
        c.id,
        c.executionId,
        c.stepId,
        c.tool,
        toJson(c.args),
        c.idempotent ? 1 : 0,
        c.risk,
        c.approvedBy ?? null,
        Date.now(),
      ],
    );
  }

  async endToolCall(
    id: string,
    status: Exclude<ToolCallStatus, 'started'>,
    result: unknown,
  ): Promise<void> {
    const db = await this.db();
    await db.execute(
      'UPDATE tool_calls SET status = ?, result_json = ?, ended_at = ? WHERE id = ?',
      [status, toJson(result), Date.now(), id],
    );
  }

  async recordDenied(c: Omit<ToolCallRow, 'status' | 'startedAt'>, reason: string): Promise<void> {
    await this.startToolCall(c);
    await this.endToolCall(c.id, 'denied', { reason });
  }

  async toolCallsFor(executionId: string): Promise<ToolCallRow[]> {
    const db = await this.db();
    const r = await db.execute(
      'SELECT * FROM tool_calls WHERE execution_id = ? ORDER BY started_at',
      [executionId],
    );
    return r.rows.map(rowToToolCall);
  }

  // --- standing grants ("always allow this tool") ----------------------------

  async hasGrant(tool: string): Promise<boolean> {
    const db = await this.db();
    const r = await db.execute('SELECT 1 FROM tool_grants WHERE tool = ?', [tool]);
    return r.rows.length > 0;
  }

  async addGrant(tool: string): Promise<void> {
    const db = await this.db();
    await db.execute('INSERT OR REPLACE INTO tool_grants (tool, created_at) VALUES (?, ?)', [
      tool,
      Date.now(),
    ]);
  }

  async revokeGrant(tool: string): Promise<void> {
    const db = await this.db();
    await db.execute('DELETE FROM tool_grants WHERE tool = ?', [tool]);
  }

  async grants(): Promise<string[]> {
    const db = await this.db();
    const r = await db.execute('SELECT tool FROM tool_grants ORDER BY tool');
    return r.rows.map(x => String(x.tool));
  }
}

function stripImages(r: AgentRequest): AgentRequest {
  // Image URIs are device paths; keep them, but never inline base64 blobs into the DB.
  return { ...r, images: r.images?.filter(u => !u.startsWith('data:')) };
}

function rowToRecord(row: Row, stepRows: Row[]): ExecutionRecord {
  const steps: Record<string, StepRecord> = {};
  for (const s of stepRows) {
    const rec = fromJson<StepRecord>(s.record_json);
    if (rec) steps[rec.stepId] = rec;
  }
  return {
    id: String(row.id),
    request: fromJson<AgentRequest>(row.request_json) ?? { text: '', source: 'chat' },
    state: String(row.state) as ExecutionState,
    plan: fromJson<Plan>(row.plan_json),
    steps,
    response: (row.response as string) ?? undefined,
    error: fromJson<ToolError>(row.error_json),
    waitingOn: (row.waiting_on as string) ?? undefined,
    cancelRequested: Number(row.cancel_requested) === 1,
    remoteCalls: Number(row.remote_calls ?? 0),
    spendUsd: Number(row.spend_usd ?? 0),
    createdAt: Number(row.created_at),
    updatedAt: Number(row.updated_at),
  };
}

function rowToToolCall(x: Row): ToolCallRow {
  return {
    id: String(x.id),
    executionId: String(x.execution_id),
    stepId: String(x.step_id),
    tool: String(x.tool),
    args: fromJson(x.args_json),
    status: String(x.status) as ToolCallStatus,
    result: fromJson(x.result_json),
    idempotent: Number(x.idempotent) === 1,
    risk: String(x.risk) as RiskLevel,
    approvedBy: (x.approved_by as string) ?? undefined,
    startedAt: Number(x.started_at),
    endedAt: x.ended_at == null ? undefined : Number(x.ended_at),
  };
}

export const executionRepository = new ExecutionRepository();
