/**
 * PRD §15.3 agent metrics, computed from the database over a time window.
 * Rates are in [0,1] or null when there is nothing to measure — never NaN.
 *
 * Data sources and definitions:
 * - executions (created_at in window): completion = COMPLETED / terminal;
 *   multi-step = same, restricted to plans with ≥ 2 steps; latency =
 *   updated_at − created_at of terminal executions.
 * - state_transitions + 'execution.state' traces: an execution "recovered"
 *   if it entered RECOVERING and ended COMPLETED.
 * - eval_results (joined to eval_runs.at): offline tool-call accuracy and
 *   argument validity.
 * - tool_calls + 'tool.denied' {reason:'invalid_args'} traces: live argument
 *   validity = 1 − invalid / (tool calls + invalid). A call rejected by
 *   validation is assumed not to produce a tool_calls row.
 * - 'user.correction' traces / tool calls: incorrect action rate.
 * - 'policy.violation_blocked' traces: count.
 * - routing_decisions: local/remote share, escalations (a re-route of the same
 *   step, or a reason mentioning escalation), per-model latency.
 * - 'device.snapshot' traces {phase:'start'|'end', batteryPercent, charging?}:
 *   battery drop per completed execution (skipped when charging or unknown).
 * - cost_ledger joined to executions: cloud USD per completed execution.
 */
import { TERMINAL_STATES } from '../agent/types';
import { fromJson, getDatabase, type Row, type SqlDb } from '../storage/db';
import { mean, median, percentile, ratio } from './stats';

const DAY_MS = 24 * 60 * 60 * 1000;

export interface MetricsWindow {
  /** Inclusive start (epoch ms). Default: until − 7 days. */
  since?: number;
  /** Exclusive end (epoch ms). Default: now. */
  until?: number;
}

export interface ModelLatency {
  modelId: string;
  mode: string;
  calls: number;
  medianMs: number | null;
  p95Ms: number | null;
}

export interface AgentMetrics {
  window: { since: number; until: number };
  executions: {
    total: number;
    terminal: number;
    completed: number;
    failed: number;
    cancelled: number;
  };
  taskCompletionRate: number | null;
  multiStep: { total: number; completed: number; successRate: number | null };
  recovery: { attempted: number; recovered: number; successRate: number | null };
  toolCalls: {
    total: number;
    invalidArgs: number;
    /** Live: 1 − invalid / (calls + invalid). */
    argumentValidity: number | null;
    userCorrections: number;
    incorrectActionRate: number | null;
  };
  evaluation: {
    cases: number;
    /** Offline: share of eval cases whose planned tools matched. */
    toolCallAccuracy: number | null;
    /** Offline: share of paired expected calls with valid arguments. */
    argumentValidity: number | null;
    passRate: number | null;
  };
  policyViolationsBlocked: number;
  routing: {
    decisions: number;
    local: number;
    remote: number;
    localShare: number | null;
    remoteShare: number | null;
    escalations: number;
    perModel: ModelLatency[];
  };
  latency: { medianMs: number | null; p95Ms: number | null; samples: number };
  energy: {
    /** Mean battery-percent drop per completed execution with start+end snapshots. */
    avgBatteryDropPerTask: number | null;
    samples: number;
  };
  cost: {
    totalUsd: number;
    /** Cloud USD attributed to completed executions / completed executions. */
    perSuccessfulTaskUsd: number | null;
  };
}

export class MetricsCollector {
  constructor(
    private readonly getDb: () => Promise<SqlDb> = () => getDatabase(),
    private readonly now: () => number = Date.now,
  ) {}

  async collect(window: MetricsWindow = {}): Promise<AgentMetrics> {
    const until = window.until ?? this.now();
    const since = window.since ?? until - 7 * DAY_MS;
    const db = await this.getDb();
    const range = [since, until];

    // ---------------------------------------------------------- executions
    const execRows = (
      await db.execute(
        `SELECT id, state, plan_json, created_at, updated_at FROM executions
         WHERE created_at >= ? AND created_at < ?`,
        range,
      )
    ).rows;
    const terminalSet = new Set<string>(TERMINAL_STATES);
    const state = new Map<string, string>();
    let completed = 0;
    let failed = 0;
    let cancelled = 0;
    let multiTotal = 0;
    let multiCompleted = 0;
    const latencies: number[] = [];
    for (const r of execRows) {
      const id = String(r.id);
      const st = String(r.state);
      state.set(id, st);
      if (!terminalSet.has(st)) continue;
      if (st === 'COMPLETED') completed++;
      else if (st === 'FAILED') failed++;
      else if (st === 'CANCELLED') cancelled++;
      const dur = Number(r.updated_at) - Number(r.created_at);
      if (Number.isFinite(dur) && dur >= 0) latencies.push(dur);
      const steps = fromJson<{ steps?: unknown[] }>(r.plan_json)?.steps;
      if (Array.isArray(steps) && steps.length >= 2) {
        multiTotal++;
        if (st === 'COMPLETED') multiCompleted++;
      }
    }
    const terminal = completed + failed + cancelled;

    // ---------------------------------------------------------- traces in window
    const traceRows = (
      await db.execute(
        `SELECT execution_id, type, payload_json, at FROM traces
         WHERE at >= ? AND at < ? AND type IN
           ('tool.denied','user.correction','policy.violation_blocked','device.snapshot','execution.state')
         ORDER BY at, id`,
        range,
      )
    ).rows;
    let invalidArgs = 0;
    let corrections = 0;
    let violations = 0;
    const recovering = new Set<string>();
    const battery = new Map<string, { start?: number; end?: number; charging?: boolean }>();
    for (const t of traceRows) {
      const p = fromJson<Record<string, unknown>>(t.payload_json) ?? {};
      const exec = t.execution_id == null ? null : String(t.execution_id);
      switch (t.type) {
        case 'tool.denied':
          if (p.reason === 'invalid_args') invalidArgs++;
          break;
        case 'user.correction':
          corrections++;
          break;
        case 'policy.violation_blocked':
          violations++;
          break;
        case 'execution.state':
          if (exec && (p.state === 'RECOVERING' || p.to === 'RECOVERING')) recovering.add(exec);
          break;
        case 'device.snapshot': {
          if (!exec) break;
          const pct = Number(p.batteryPercent);
          if (!Number.isFinite(pct) || pct < 0) break;
          const b = battery.get(exec) ?? {};
          if (p.phase === 'start' && b.start === undefined) b.start = pct;
          if (p.phase === 'end') b.end = pct;
          if (p.charging === true) b.charging = true;
          battery.set(exec, b);
          break;
        }
      }
    }

    // ---------------------------------------------------------- recovery
    const transitions = (
      await db.execute(
        `SELECT DISTINCT t.execution_id AS id FROM state_transitions t
         JOIN executions e ON e.id = t.execution_id
         WHERE t.to_state = 'RECOVERING' AND e.created_at >= ? AND e.created_at < ?`,
        range,
      )
    ).rows;
    for (const r of transitions) recovering.add(String(r.id));
    let recoveryAttempted = 0;
    let recovered = 0;
    for (const id of recovering) {
      const st = state.get(id);
      if (!st || !terminalSet.has(st)) continue; // unknown or still running
      recoveryAttempted++;
      if (st === 'COMPLETED') recovered++;
    }

    // ---------------------------------------------------------- tool calls
    const toolCalls = await scalar(
      db,
      'SELECT COUNT(*) AS n FROM tool_calls WHERE started_at >= ? AND started_at < ?',
      range,
    );

    // ---------------------------------------------------------- evaluation
    const evalRows = (
      await db.execute(
        `SELECT r.passed, r.detail_json FROM eval_results r
         JOIN eval_runs u ON u.id = r.run_id
         WHERE u.at >= ? AND u.at < ?`,
        range,
      )
    ).rows;
    let evalToolCases = 0;
    let evalToolMatch = 0;
    let evalPaired = 0;
    let evalValid = 0;
    let evalPassed = 0;
    for (const r of evalRows) {
      if (Number(r.passed) === 1) evalPassed++;
      const d = fromJson<Record<string, unknown>>(r.detail_json) ?? {};
      if (d.expectedRefusal !== true) {
        evalToolCases++;
        if (d.toolMatch === true) evalToolMatch++;
      }
      evalPaired += num(d.argCallsPaired);
      evalValid += num(d.argCallsValid);
    }

    // ---------------------------------------------------------- routing
    const routeRows = (
      await db.execute(
        `SELECT d.execution_id, d.step_id, d.model_id, d.mode, d.reason, d.latency_ms,
                (SELECT COUNT(*) FROM routing_decisions p
                  WHERE p.execution_id = d.execution_id AND p.step_id = d.step_id
                    AND (p.at < d.at OR (p.at = d.at AND p.id < d.id))) AS prior
         FROM routing_decisions d WHERE d.at >= ? AND d.at < ?`,
        range,
      )
    ).rows;
    let local = 0;
    let remote = 0;
    let escalations = 0;
    const perModel = new Map<string, { mode: string; lat: number[]; calls: number }>();
    for (const r of routeRows) {
      const mode = String(r.mode);
      if (mode === 'local') local++;
      else if (mode === 'remote') remote++;
      if (Number(r.prior) > 0 || /escalat/i.test(String(r.reason ?? ''))) escalations++;
      const key = String(r.model_id);
      const m = perModel.get(key) ?? { mode, lat: [], calls: 0 };
      m.calls++;
      if (r.latency_ms != null && Number.isFinite(Number(r.latency_ms))) {
        m.lat.push(Number(r.latency_ms));
      }
      perModel.set(key, m);
    }

    // ---------------------------------------------------------- energy
    const drops: number[] = [];
    for (const [id, b] of battery) {
      if (state.get(id) !== 'COMPLETED' || b.charging) continue;
      if (b.start === undefined || b.end === undefined) continue;
      drops.push(Math.max(0, b.start - b.end));
    }

    // ---------------------------------------------------------- cost
    const totalUsd = await scalar(
      db,
      'SELECT COALESCE(SUM(usd), 0) AS n FROM cost_ledger WHERE at >= ? AND at < ?',
      range,
    );
    const successUsd = await scalar(
      db,
      `SELECT COALESCE(SUM(c.usd), 0) AS n FROM cost_ledger c
       JOIN executions e ON e.id = c.execution_id
       WHERE e.state = 'COMPLETED' AND e.created_at >= ? AND e.created_at < ?`,
      range,
    );

    const decisions = local + remote;
    return {
      window: { since, until },
      executions: { total: execRows.length, terminal, completed, failed, cancelled },
      taskCompletionRate: ratio(completed, terminal),
      multiStep: {
        total: multiTotal,
        completed: multiCompleted,
        successRate: ratio(multiCompleted, multiTotal),
      },
      recovery: {
        attempted: recoveryAttempted,
        recovered,
        successRate: ratio(recovered, recoveryAttempted),
      },
      toolCalls: {
        total: toolCalls,
        invalidArgs,
        argumentValidity:
          toolCalls + invalidArgs > 0 ? 1 - invalidArgs / (toolCalls + invalidArgs) : null,
        userCorrections: corrections,
        incorrectActionRate:
          toolCalls > 0 ? Math.min(1, corrections / toolCalls) : corrections > 0 ? 1 : null,
      },
      evaluation: {
        cases: evalRows.length,
        toolCallAccuracy: ratio(evalToolMatch, evalToolCases),
        argumentValidity: ratio(evalValid, evalPaired),
        passRate: ratio(evalPassed, evalRows.length),
      },
      policyViolationsBlocked: violations,
      routing: {
        decisions: routeRows.length,
        local,
        remote,
        localShare: ratio(local, decisions),
        remoteShare: ratio(remote, decisions),
        escalations,
        perModel: [...perModel.entries()]
          .map(([modelId, m]) => ({
            modelId,
            mode: m.mode,
            calls: m.calls,
            medianMs: median(m.lat),
            p95Ms: percentile(m.lat, 95),
          }))
          .sort((a, b) => b.calls - a.calls || a.modelId.localeCompare(b.modelId)),
      },
      latency: {
        medianMs: median(latencies),
        p95Ms: percentile(latencies, 95),
        samples: latencies.length,
      },
      energy: { avgBatteryDropPerTask: mean(drops), samples: drops.length },
      cost: { totalUsd, perSuccessfulTaskUsd: ratio(successUsd, completed) },
    };
  }
}

async function scalar(db: SqlDb, sql: string, params: number[]): Promise<number> {
  const r = await db.execute(sql, params);
  return num((r.rows[0] as Row | undefined)?.n);
}

function num(v: unknown): number {
  const n = Number(v);
  return Number.isFinite(n) ? n : 0;
}

/** Convenience: metrics for the last `days` days from the app database. */
export function collectMetrics(window?: MetricsWindow): Promise<AgentMetrics> {
  return new MetricsCollector().collect(window);
}
