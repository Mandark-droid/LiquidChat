import { MemoryManager } from '../../src/memory/MemoryManager';
import { resetDatabaseForTests } from '../../src/storage/db';

beforeEach(() => {
  resetDatabaseForTests();
  (require('@op-engineering/op-sqlite') as { __resetAll: () => void }).__resetAll();
});

describe('MemoryManager (SQLite + FTS5)', () => {
  it('creates, retrieves by relevance, updates and deletes', async () => {
    const m = new MemoryManager();
    const a = await m.create({
      kind: 'profile',
      title: 'Navigation app',
      content: 'Prefers Google Maps for directions',
      source: 'user',
    });
    await m.create({
      kind: 'episodic',
      title: 'Acme follow-up',
      content: 'Sent RCA to Acme on Friday',
      source: 'execution',
    });
    const hits = await m.retrieve('open directions in maps');
    expect(hits.map(h => h.id)).toEqual([a.id]);
    await m.update(a.id, { content: 'Prefers OsmAnd for directions' });
    expect((await m.retrieve('OsmAnd'))[0].id).toBe(a.id);
    expect(await m.retrieve('google maps')).toHaveLength(0);
    await m.delete(a.id);
    expect(await m.get(a.id)).toBeNull();
  });

  it('flags sensitive memories and can exclude them (e.g. for remote steps)', async () => {
    const m = new MemoryManager();
    await m.create({
      kind: 'profile',
      title: 'Bank',
      content: 'My bank account number ends 4417',
      source: 'user',
    });
    expect((await m.retrieve('bank account'))[0].sensitive).toBe(true);
    expect(await m.retrieve('bank account', { excludeSensitive: true })).toHaveLength(0);
  });

  it('always includes pinned profile memories', async () => {
    const m = new MemoryManager();
    await m.create({
      kind: 'profile',
      title: 'Language',
      content: 'Reply in English',
      source: 'user',
      pinned: true,
    });
    expect((await m.retrieve('weather tomorrow')).map(x => x.title)).toEqual(['Language']);
  });

  it('says which hits the search matched and which are only there because they are pinned', async () => {
    const m = new MemoryManager();
    await m.create({
      kind: 'profile',
      title: 'Language',
      content: 'Reply in English',
      source: 'user',
      pinned: true,
    });
    await m.create({
      kind: 'episodic',
      title: 'Weather',
      content: 'Check weather before cycling',
      source: 'user',
    });
    const hits = await m.retrieveScored('weather tomorrow');
    const byTitle = Object.fromEntries(hits.map(h => [h.memory.title, h]));
    expect(byTitle.Language.matched).toBe(false);
    expect(byTitle.Language.score).toBeUndefined();
    expect(byTitle.Weather.matched).toBe(true);
    expect(typeof byTitle.Weather.score).toBe('number');
  });

  it('survives FTS syntax in queries', async () => {
    const m = new MemoryManager();
    await m.create({
      kind: 'profile',
      title: 't',
      content: 'quote "test" AND OR NEAR(',
      source: 'user',
    });
    await expect(m.retrieve('"AND" OR NEAR( ) * -')).resolves.toBeDefined();
  });

  it('exports, clears and imports', async () => {
    const m = new MemoryManager();
    await m.create({ kind: 'profile', title: 'a', content: 'alpha preference', source: 'user' });
    await m.create({ kind: 'procedural', title: 'b', content: 'beta workflow', source: 'user' });
    const dump = await m.export();
    expect(await m.clearAll()).toBe(2);
    expect(await m.import(dump)).toBe(2);
    expect((await m.list()).map(x => x.kind).sort()).toEqual(['procedural', 'profile']);
    await expect(m.import('{"nope":1}')).rejects.toThrow();
  });

  it('only proposes memories, never auto-saves', () => {
    expect(MemoryManager.proposeFromRequest('Remember that I prefer window seats')).toMatchObject({
      kind: 'profile',
      content: 'I prefer window seats',
    });
    expect(MemoryManager.proposeFromRequest('what is the weather')).toBeNull();
    expect(MemoryManager.proposeEpisode('g', 'o', 1)).toBeNull();
  });
});
