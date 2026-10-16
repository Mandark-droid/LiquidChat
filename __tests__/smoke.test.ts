import { open } from '@op-engineering/op-sqlite';

test('sqlite double runs real SQL with FTS5', async () => {
  const db = open({ name: 'smoke.db' });
  await db.execute('CREATE VIRTUAL TABLE t USING fts5(body)');
  await db.execute('INSERT INTO t(body) VALUES (?)', ['send the proposal to acme']);
  const r = await db.execute("SELECT body FROM t WHERE t MATCH 'proposal'");
  expect(r.rows).toHaveLength(1);
});
