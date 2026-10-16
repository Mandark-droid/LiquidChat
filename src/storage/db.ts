/**
 * Single encrypted SQLite database for the agent runtime (PRD §8.2):
 * executions, steps, tool calls, traces, routing, costs, memory (FTS5),
 * skills, schedules, notifications, evaluations.
 *
 * Production: op-sqlite built with SQLCipher + FTS5 (package.json "op-sqlite"),
 * key from the Android-Keystore-backed CredentialStore.
 * Tests: the same API backed by better-sqlite3 (__mocks__), so SQL runs for real.
 */
import { open } from '@op-engineering/op-sqlite';

import { MIGRATIONS } from './migrations';

export type SqlValue = string | number | null;
export type Row = Record<string, SqlValue>;

export interface SqlDb {
  execute(
    sql: string,
    params?: SqlValue[],
  ): Promise<{ rows: Row[]; rowsAffected: number; insertId?: number }>;
  transaction(fn: (tx: Pick<SqlDb, 'execute'>) => Promise<void>): Promise<void>;
  close(): void;
}

let instance: SqlDb | null = null;
let opening: Promise<SqlDb> | null = null;

export interface OpenOptions {
  name?: string;
  encryptionKey?: string;
}

/** Opens (once) and migrates the app database. */
export function getDatabase(opts: OpenOptions = {}): Promise<SqlDb> {
  if (instance) return Promise.resolve(instance);
  if (opening) return opening;
  opening = (async () => {
    const raw = open({
      name: opts.name ?? 'liquidchat-agent.db',
      encryptionKey: opts.encryptionKey,
    }) as unknown as SqlDb;
    const db: SqlDb = {
      execute: (sql, params) => raw.execute(sql, params ?? []),
      transaction: fn => raw.transaction(fn),
      close: () => raw.close(),
    };
    await migrate(db);
    instance = db;
    return db;
  })();
  opening.catch(() => {
    opening = null; // allow a retry after a failed open
  });
  return opening;
}

/** Tests: drop the cached handle so the next getDatabase() starts fresh. */
export function resetDatabaseForTests(): void {
  try {
    instance?.close();
  } catch {}
  instance = null;
  opening = null;
}

export async function migrate(db: SqlDb): Promise<number> {
  await db.execute('CREATE TABLE IF NOT EXISTS schema_version (version INTEGER NOT NULL)');
  const r = await db.execute('SELECT MAX(version) AS v FROM schema_version');
  let current = Number(r.rows[0]?.v ?? 0);
  for (const m of MIGRATIONS) {
    if (m.version <= current) continue;
    await db.transaction(async tx => {
      for (const stmt of m.statements) await tx.execute(stmt);
      await tx.execute('INSERT INTO schema_version (version) VALUES (?)', [m.version]);
    });
    current = m.version;
  }
  return current;
}

/** JSON helpers — columns ending in _json hold serialized objects. */
export function toJson(v: unknown): string | null {
  return v === undefined ? null : JSON.stringify(v);
}

export function fromJson<T>(v: SqlValue | undefined): T | undefined {
  if (v === null || v === undefined || v === '') return undefined;
  try {
    return JSON.parse(String(v)) as T;
  } catch {
    return undefined;
  }
}

/** Turns free text into a safe FTS5 MATCH expression (OR of quoted terms). */
export function ftsQuery(text: string, maxTerms = 12): string | null {
  const terms = text
    .toLowerCase()
    .replace(/[^\p{L}\p{N}\s]/gu, ' ')
    .split(/\s+/)
    .filter(t => t.length > 2 && !STOPWORDS.has(t))
    .slice(0, maxTerms);
  if (!terms.length) return null;
  return [...new Set(terms)].map(t => `"${t}"`).join(' OR ');
}

const STOPWORDS = new Set([
  'the',
  'and',
  'for',
  'with',
  'that',
  'this',
  'from',
  'have',
  'what',
  'when',
  'where',
  'which',
  'about',
  'into',
  'your',
  'you',
  'are',
  'was',
  'were',
  'will',
  'can',
  'please',
  'could',
  'would',
  'should',
  'there',
  'their',
  'them',
  'they',
  'then',
  'than',
  'also',
  'just',
  'our',
  'out',
]);
