/**
 * Test double for @op-engineering/op-sqlite backed by better-sqlite3.
 * Same surface the app uses: open() -> { execute, executeSync, transaction, close }.
 * In-memory unless a location is given, so each test gets a fresh database.
 */
import Database from 'better-sqlite3';

type Scalar = string | number | null | Uint8Array;

function run(db: Database.Database, sql: string, params: Scalar[] = []) {
  const stmt = db.prepare(sql);
  if (stmt.reader) {
    const rows = stmt.all(...(params as any[])) as Record<string, Scalar>[];
    return { rows, rowsAffected: 0, insertId: undefined };
  }
  const info = stmt.run(...(params as any[]));
  return { rows: [], rowsAffected: info.changes, insertId: Number(info.lastInsertRowid) };
}

const opened = new Map<string, Database.Database>();

export function open(params: { name: string; location?: string; encryptionKey?: string }) {
  const key = `${params.location ?? ''}/${params.name}`;
  const db = opened.get(key) ?? new Database(':memory:');
  opened.set(key, db);
  const api = {
    execute: async (sql: string, p?: Scalar[]) => run(db, sql, p),
    executeSync: (sql: string, p?: Scalar[]) => run(db, sql, p),
    transaction: async (fn: (tx: { execute: typeof api.execute }) => Promise<void>) => {
      db.exec('BEGIN');
      try {
        await fn({ execute: api.execute });
        db.exec('COMMIT');
      } catch (e) {
        db.exec('ROLLBACK');
        throw e;
      }
    },
    close: () => {
      db.close();
      opened.delete(key);
    },
  };
  return api;
}

/** Test helper: forget all databases (call in beforeEach for isolation). */
export function __resetAll() {
  for (const db of opened.values()) {
    try {
      db.close();
    } catch {}
  }
  opened.clear();
}
