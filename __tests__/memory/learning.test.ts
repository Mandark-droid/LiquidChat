import { learnFromRun, MAX_EPISODIC } from '../../src/memory/learning';
import { MemoryManager } from '../../src/memory/MemoryManager';
import { resetDatabaseForTests } from '../../src/storage/db';

beforeEach(() => {
  resetDatabaseForTests();
  (require('@op-engineering/op-sqlite') as { __resetAll: () => void }).__resetAll();
});

const run = (over: Partial<Parameters<typeof learnFromRun>[1]> = {}) => ({
  request: 'Set an alarm for 7 am',
  goal: 'Set an alarm for 7 am',
  ok: true,
  response: 'Alarm set for 07:00',
  tools: ['set_alarm'],
  ...over,
});

describe('memory the agent learns on its own', () => {
  it('a task it acted on becomes an episode, updated (not duplicated) when it comes back', async () => {
    const m = new MemoryManager();
    await learnFromRun(m, run());
    await learnFromRun(m, run({ response: 'Alarm set for 07:00 - "Gym"' }));
    const episodes = await m.list({ kind: 'episodic' });
    expect(episodes).toHaveLength(1);
    expect(episodes[0].content).toContain('Gym');
    expect(episodes[0].tags).toEqual(
      expect.arrayContaining(['task', 'succeeded', 'tools:set_alarm']),
    );
    expect(episodes[0].source).toBe('execution');
  });

  it('a failure is remembered too, with why', async () => {
    const m = new MemoryManager();
    await learnFromRun(
      m,
      run({ ok: false, errorCode: 'PERMISSION_DENIED', response: 'Not allowed' }),
    );
    const [e] = await m.list({ kind: 'episodic' });
    expect(e.tags).toContain('failed');
    expect(e.content).toContain('PERMISSION_DENIED');
  });

  it('the same tools working twice becomes a workflow, with the requests it served', async () => {
    const m = new MemoryManager();
    await learnFromRun(
      m,
      run({
        request: 'Turn on the flashlight',
        goal: 'Turn on the flashlight',
        tools: ['turn_on_flashlight'],
      }),
    );
    expect(await m.list({ kind: 'procedural' })).toHaveLength(0);
    await learnFromRun(
      m,
      run({ request: 'I need light', goal: 'Light up', tools: ['turn_on_flashlight'] }),
    );
    const [w] = await m.list({ kind: 'procedural' });
    expect(w.title).toBe('Workflow: turn_on_flashlight');
    expect(w.content).toContain('"I need light"');
    expect(w.content).toContain('"Turn on the flashlight"');
  });

  it('a stated preference becomes a profile memory; a plain answer adds no episode', async () => {
    const m = new MemoryManager();
    await learnFromRun(
      m,
      run({ request: 'I prefer short answers', goal: 'answer', tools: [], response: 'Okay.' }),
    );
    const profile = await m.list({ kind: 'profile' });
    expect(profile.map(p => p.content)).toEqual(['I prefer short answers']);
    expect(profile[0].confidence).toBeLessThan(1);
    expect(await m.list({ kind: 'episodic' })).toHaveLength(0);
  });

  it('never learns from sensitive requests', async () => {
    const m = new MemoryManager();
    await learnFromRun(
      m,
      run({ request: 'my bank account number is 1234', goal: 'note bank account' }),
    );
    expect(await m.list()).toHaveLength(0);
  });

  it('keeps at most MAX_EPISODIC learned episodes, never removing what the user saved', async () => {
    const m = new MemoryManager();
    await m.create({ kind: 'episodic', title: 'Mine', content: 'Saved by hand', source: 'user' });
    for (let i = 0; i < MAX_EPISODIC + 3; i++)
      await learnFromRun(m, run({ request: `task ${i}`, goal: `task ${i}`, tools: ['time.now'] }));
    const episodes = await m.list({ kind: 'episodic', limit: 1000 });
    expect(episodes.filter(e => e.source === 'execution')).toHaveLength(MAX_EPISODIC);
    expect(episodes.some(e => e.title === 'Mine')).toBe(true);
  });
});
