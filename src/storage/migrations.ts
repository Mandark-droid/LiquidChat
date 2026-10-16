/**
 * Forward-only schema migrations. Never edit a shipped migration; add a new one.
 */
export interface Migration {
  version: number;
  description: string;
  statements: string[];
}

export const MIGRATIONS: Migration[] = [
  {
    version: 1,
    description: 'agent runtime: executions, steps, transitions, tool calls, traces, grants',
    statements: [
      `CREATE TABLE executions (
        id TEXT PRIMARY KEY,
        request_json TEXT NOT NULL,
        state TEXT NOT NULL,
        plan_json TEXT,
        response TEXT,
        error_json TEXT,
        waiting_on TEXT,
        cancel_requested INTEGER NOT NULL DEFAULT 0,
        remote_calls INTEGER NOT NULL DEFAULT 0,
        spend_usd REAL NOT NULL DEFAULT 0,
        created_at INTEGER NOT NULL,
        updated_at INTEGER NOT NULL
      )`,
      'CREATE INDEX idx_executions_state ON executions(state)',
      'CREATE INDEX idx_executions_created ON executions(created_at)',
      `CREATE TABLE execution_steps (
        execution_id TEXT NOT NULL,
        step_id TEXT NOT NULL,
        record_json TEXT NOT NULL,
        PRIMARY KEY (execution_id, step_id)
      )`,
      `CREATE TABLE state_transitions (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        execution_id TEXT NOT NULL,
        from_state TEXT,
        to_state TEXT NOT NULL,
        reason TEXT,
        at INTEGER NOT NULL
      )`,
      'CREATE INDEX idx_transitions_exec ON state_transitions(execution_id)',
      `CREATE TABLE tool_calls (
        id TEXT PRIMARY KEY,
        execution_id TEXT NOT NULL,
        step_id TEXT NOT NULL,
        tool TEXT NOT NULL,
        args_json TEXT,
        status TEXT NOT NULL,
        result_json TEXT,
        idempotent INTEGER NOT NULL,
        risk TEXT NOT NULL,
        approved_by TEXT,
        started_at INTEGER NOT NULL,
        ended_at INTEGER
      )`,
      'CREATE INDEX idx_tool_calls_exec ON tool_calls(execution_id)',
      `CREATE TABLE tool_grants (
        tool TEXT PRIMARY KEY,
        created_at INTEGER NOT NULL
      )`,
      `CREATE TABLE traces (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        execution_id TEXT,
        type TEXT NOT NULL,
        payload_json TEXT,
        at INTEGER NOT NULL
      )`,
      'CREATE INDEX idx_traces_exec ON traces(execution_id)',
      'CREATE INDEX idx_traces_type_at ON traces(type, at)',
    ],
  },
  {
    version: 2,
    description: 'hybrid routing: decisions, cost ledger, model stats, privacy grants',
    statements: [
      `CREATE TABLE routing_decisions (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        execution_id TEXT NOT NULL,
        step_id TEXT NOT NULL,
        model_id TEXT NOT NULL,
        provider_id TEXT NOT NULL,
        mode TEXT NOT NULL,
        reason TEXT NOT NULL,
        estimated_cost REAL,
        actual_cost REAL,
        latency_ms INTEGER,
        outcome TEXT,
        at INTEGER NOT NULL
      )`,
      'CREATE INDEX idx_routing_exec ON routing_decisions(execution_id)',
      `CREATE TABLE cost_ledger (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        provider_id TEXT NOT NULL,
        model_id TEXT NOT NULL,
        execution_id TEXT,
        usd REAL NOT NULL,
        at INTEGER NOT NULL
      )`,
      'CREATE INDEX idx_cost_at ON cost_ledger(at)',
      `CREATE TABLE model_stats (
        model_id TEXT PRIMARY KEY,
        samples INTEGER NOT NULL,
        avg_latency_ms REAL,
        avg_tps REAL,
        quality_json TEXT,
        updated_at INTEGER NOT NULL
      )`,
      `CREATE TABLE privacy_grants (
        provider_id TEXT NOT NULL,
        data_class TEXT NOT NULL,
        created_at INTEGER NOT NULL,
        PRIMARY KEY (provider_id, data_class)
      )`,
    ],
  },
  {
    version: 3,
    description: 'memory (profile/episodic/procedural) with FTS5, skills, schedules',
    statements: [
      `CREATE TABLE memories (
        id TEXT PRIMARY KEY,
        kind TEXT NOT NULL CHECK (kind IN ('profile','episodic','procedural')),
        title TEXT NOT NULL,
        content TEXT NOT NULL,
        tags TEXT NOT NULL DEFAULT '',
        sensitive INTEGER NOT NULL DEFAULT 0,
        source TEXT NOT NULL,
        confidence REAL NOT NULL DEFAULT 1,
        pinned INTEGER NOT NULL DEFAULT 0,
        created_at INTEGER NOT NULL,
        updated_at INTEGER NOT NULL,
        last_used_at INTEGER
      )`,
      `CREATE VIRTUAL TABLE memories_fts USING fts5(title, content, tags, content='memories', content_rowid='rowid')`,
      `CREATE TRIGGER memories_ai AFTER INSERT ON memories BEGIN
        INSERT INTO memories_fts(rowid, title, content, tags) VALUES (new.rowid, new.title, new.content, new.tags);
      END`,
      `CREATE TRIGGER memories_ad AFTER DELETE ON memories BEGIN
        INSERT INTO memories_fts(memories_fts, rowid, title, content, tags) VALUES ('delete', old.rowid, old.title, old.content, old.tags);
      END`,
      `CREATE TRIGGER memories_au AFTER UPDATE ON memories BEGIN
        INSERT INTO memories_fts(memories_fts, rowid, title, content, tags) VALUES ('delete', old.rowid, old.title, old.content, old.tags);
        INSERT INTO memories_fts(rowid, title, content, tags) VALUES (new.rowid, new.title, new.content, new.tags);
      END`,
      `CREATE TABLE skills (
        id TEXT PRIMARY KEY,
        name TEXT NOT NULL UNIQUE,
        version TEXT NOT NULL,
        manifest_json TEXT NOT NULL,
        enabled INTEGER NOT NULL DEFAULT 0,
        source TEXT NOT NULL CHECK (source IN ('builtin','user','generated','imported')),
        publisher TEXT,
        hash TEXT NOT NULL,
        created_at INTEGER NOT NULL,
        updated_at INTEGER NOT NULL,
        last_run_at INTEGER
      )`,
      `CREATE TABLE schedules (
        id TEXT PRIMARY KEY,
        skill_id TEXT NOT NULL,
        trigger_json TEXT NOT NULL,
        enabled INTEGER NOT NULL DEFAULT 1,
        next_run_at INTEGER,
        last_run_at INTEGER,
        created_at INTEGER NOT NULL
      )`,
    ],
  },
  {
    version: 4,
    description: 'notification intelligence + evaluations',
    statements: [
      `CREATE TABLE notifications (
        key TEXT PRIMARY KEY,
        package TEXT NOT NULL,
        app_label TEXT NOT NULL,
        title TEXT NOT NULL,
        text TEXT NOT NULL,
        category TEXT,
        posted_at INTEGER NOT NULL
      )`,
      'CREATE INDEX idx_notifications_posted ON notifications(posted_at)',
      `CREATE VIRTUAL TABLE notifications_fts USING fts5(app_label, title, text, content='notifications', content_rowid='rowid')`,
      `CREATE TRIGGER notifications_ai AFTER INSERT ON notifications BEGIN
        INSERT INTO notifications_fts(rowid, app_label, title, text) VALUES (new.rowid, new.app_label, new.title, new.text);
      END`,
      `CREATE TRIGGER notifications_ad AFTER DELETE ON notifications BEGIN
        INSERT INTO notifications_fts(notifications_fts, rowid, app_label, title, text) VALUES ('delete', old.rowid, old.app_label, old.title, old.text);
      END`,
      `CREATE TABLE eval_runs (
        id TEXT PRIMARY KEY,
        model_id TEXT NOT NULL,
        total INTEGER NOT NULL,
        passed INTEGER NOT NULL,
        metrics_json TEXT NOT NULL,
        at INTEGER NOT NULL
      )`,
      `CREATE TABLE eval_results (
        run_id TEXT NOT NULL,
        case_id TEXT NOT NULL,
        passed INTEGER NOT NULL,
        detail_json TEXT NOT NULL,
        PRIMARY KEY (run_id, case_id)
      )`,
      `CREATE TABLE mcp_servers (
        id TEXT PRIMARY KEY,
        name TEXT NOT NULL,
        url TEXT NOT NULL,
        enabled INTEGER NOT NULL DEFAULT 1,
        tools_json TEXT,
        created_at INTEGER NOT NULL
      )`,
    ],
  },
];
