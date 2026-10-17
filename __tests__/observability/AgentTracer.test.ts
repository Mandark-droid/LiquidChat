import {
  createTracer,
  FLUSH_BATCH_SIZE,
  resetTracerForTests,
  tracer,
} from '../../src/observability/AgentTracer';
import { getDatabase, resetDatabaseForTests } from '../../src/storage/db';

async function traceCount(): Promise<number> {
  const db = await getDatabase();
  const r = await db.execute('SELECT COUNT(*) AS n FROM traces');
  return Number(r.rows[0].n);
}

beforeEach(() => {
  resetDatabaseForTests();
  (require('@op-engineering/op-sqlite') as any).__resetAll();
  resetTracerForTests();
});

afterEach(() => {
  jest.useRealTimers();
});

describe('AgentTracer', () => {
  test('buffers until flush() and redacts payloads', async () => {
    const t = createTracer();
    t.record('ex1', 'tool.call', {
      tool: 'send_email',
      args: { to: 'alice@example.com', body: 'Your OTP is 123456' },
      apiKey: 'sk-abcdefghijklmnopqrstuvwxyz',
    });
    expect(t.pending()).toBe(1);
    expect(await traceCount()).toBe(0);
    await t.flush();
    expect(t.pending()).toBe(0);
    const rows = await t.query({ executionId: 'ex1' });
    expect(rows).toHaveLength(1);
    expect(rows[0].type).toBe('tool.call');
    expect(rows[0].payload).toEqual({
      tool: 'send_email',
      args: { to: 'a***@example.com', body: 'Your OTP is [REDACTED_OTP]' },
    });
    await t.dispose();
  });

  test('auto-flushes at the batch size', async () => {
    const t = createTracer();
    for (let i = 0; i < FLUSH_BATCH_SIZE; i++) t.record('ex', 'step.start', { i });
    expect(t.pending()).toBe(0);
    await t.flush(); // waits for the in-flight batch
    expect(await traceCount()).toBe(FLUSH_BATCH_SIZE);
    await t.dispose();
  });

  test('auto-flushes after the timer', async () => {
    jest.useFakeTimers();
    const t = createTracer(undefined, { intervalMs: 2000 });
    t.record(null, 'schedule.fire', { scheduleId: 's1' });
    jest.advanceTimersByTime(1999);
    expect(t.pending()).toBe(1);
    jest.advanceTimersByTime(1);
    expect(t.pending()).toBe(0);
    jest.useRealTimers();
    await t.flush();
    expect(await traceCount()).toBe(1);
  });

  test('query filters by types, since, limit and order', async () => {
    let clock = 1000;
    const t = createTracer(undefined, { now: () => clock });
    t.record('a', 'step.start', {});
    clock = 2000;
    t.record('a', 'tool.call', { tool: 'x' });
    clock = 3000;
    t.record('b', 'tool.denied', { reason: 'invalid_args' });
    clock = 4000;
    t.record('a', 'step.end', {});
    expect((await t.query()).map(e => e.at)).toEqual([1000, 2000, 3000, 4000]);
    expect((await t.query({ types: ['tool.call', 'tool.denied'] })).map(e => e.type)).toEqual([
      'tool.call',
      'tool.denied',
    ]);
    expect((await t.query({ executionId: 'a', since: 2000 })).map(e => e.at)).toEqual([2000, 4000]);
    expect((await t.query({ limit: 2, order: 'desc' })).map(e => e.at)).toEqual([4000, 3000]);
    await t.dispose();
  });

  test('prune removes events older than N days', async () => {
    const day = 86_400_000;
    let clock = 0;
    const t = createTracer(undefined, { now: () => clock });
    t.record('old', 'inference', {});
    clock = 5 * day;
    t.record('new', 'inference', {});
    const removed = await t.prune(3, 6 * day);
    expect(removed).toBe(1);
    expect((await t.query()).map(e => e.executionId)).toEqual(['new']);
    await t.dispose();
  });

  test('a failing database never throws into the caller', async () => {
    const warn = jest.spyOn(console, 'warn').mockImplementation(() => {});
    const t = createTracer(() => Promise.reject(new Error('db down')));
    t.record('x', 'retry', {});
    await expect(t.flush()).resolves.toBeUndefined();
    expect(warn).toHaveBeenCalled();
    warn.mockRestore();
  });

  test('lazy singleton writes to the app database', async () => {
    expect(tracer.pending()).toBe(0);
    tracer.record('s', 'approval', { approved: true });
    await tracer.flush();
    expect(await traceCount()).toBe(1);
    await tracer.dispose();
  });
});
