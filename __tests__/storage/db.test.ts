import { getDatabase, resetDatabaseForTests } from '../../src/storage/db';

beforeEach(() => {
  resetDatabaseForTests();
  (require('@op-engineering/op-sqlite') as { __resetAll: () => void }).__resetAll();
});

describe('database', () => {
  it('migrates to the latest schema once', async () => {
    const db = await getDatabase();
    const v = await db.execute('SELECT MAX(version) AS v FROM schema_version');
    expect(Number(v.rows[0].v)).toBeGreaterThanOrEqual(4);
    expect(await getDatabase()).toBe(db);
  });

  it('serialises concurrent transactions from independent writers', async () => {
    const db = await getDatabase();
    await db.execute('CREATE TABLE t (n INTEGER)');
    const tick = () => new Promise(r => setTimeout(r, 1));
    const writer = (n: number) =>
      db.transaction(async tx => {
        await tx.execute('INSERT INTO t (n) VALUES (?)', [n]);
        await tick();
        await tx.execute('INSERT INTO t (n) VALUES (?)', [n]);
      });
    await Promise.all([writer(1), writer(2), writer(3)]);
    const r = await db.execute('SELECT n FROM t ORDER BY rowid');
    expect(r.rows.map(x => x.n)).toEqual([1, 1, 2, 2, 3, 3]);
  });

  it('a failed transaction rolls back and does not block the next one', async () => {
    const db = await getDatabase();
    await db.execute('CREATE TABLE t (n INTEGER)');
    await expect(
      db.transaction(async tx => {
        await tx.execute('INSERT INTO t (n) VALUES (1)');
        throw new Error('boom');
      }),
    ).rejects.toThrow('boom');
    await db.transaction(async tx => {
      await tx.execute('INSERT INTO t (n) VALUES (2)');
    });
    const r = await db.execute('SELECT n FROM t');
    expect(r.rows.map(x => x.n)).toEqual([2]);
  });
});
