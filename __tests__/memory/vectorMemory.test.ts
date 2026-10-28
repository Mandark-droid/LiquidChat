import * as RNFS from '@dr.pogodin/react-native-fs';
import * as fs from 'fs';

import { meetingVersion, planIndexJobs } from '../../src/memory/autoIndex';
import { VectorStore } from '../../src/services/VectorStore';
import { makeMeeting, seg } from '../meetings/fixtures';

const v = (x: number) => [x, 1 - x, 0];

describe('vector store limits', () => {
  it('evicts the least recently used entries beyond the limit', async () => {
    const store = new VectorStore('lru_test', { maxEntries: 3 });
    const now = jest.spyOn(Date, 'now');
    for (let i = 0; i < 3; i++) {
      now.mockReturnValue(1000 + i);
      await store.add(`e${i}`, `entry ${i}`, v(i / 10));
    }
    // A search uses e0, so e1 is now the least recently used.
    now.mockReturnValue(2000);
    expect((await store.query(v(0), 1))[0].id).toBe('e0');
    now.mockReturnValue(3000);
    await store.add('e3', 'entry 3', v(0.9));
    expect(
      store
        .getAll()
        .map(e => e.id)
        .sort(),
    ).toEqual(['e0', 'e2', 'e3']);
    now.mockRestore();
  });

  it('evicts whole documents, never half of one', async () => {
    const store = new VectorStore('group_test', {
      maxEntries: 4,
      groupBy: e => e.metadata?.sourceFile,
    });
    const now = jest.spyOn(Date, 'now');
    now.mockReturnValue(1);
    for (let i = 0; i < 3; i++) await store.add(`a${i}`, 'a', v(0.1), { sourceFile: 'a.txt' });
    now.mockReturnValue(2);
    for (let i = 0; i < 2; i++) await store.add(`b${i}`, 'b', v(0.2), { sourceFile: 'b.txt' });
    expect(new Set(store.getAll().map(e => e.metadata?.sourceFile))).toEqual(new Set(['b.txt']));
    now.mockRestore();
  });

  it('moves a store out of the cache folder, keeping its entries', async () => {
    const legacy = `${RNFS.CachesDirectoryPath}/vectorstore_moved.json`;
    fs.writeFileSync(
      legacy,
      JSON.stringify([{ id: 'x', text: 't', embedding: v(0), createdAt: 1 }]),
    );
    const store = new VectorStore('moved');
    await store.ensureLoaded();
    expect(store.getAll().map(e => e.id)).toEqual(['x']);
    expect(fs.existsSync(legacy)).toBe(false);
    expect(fs.existsSync(`${RNFS.DocumentDirectoryPath}/vectorstore_moved.json`)).toBe(true);
  });
});

describe('document indexing', () => {
  it('re-indexing a file replaces its chunks instead of duplicating them', async () => {
    const { memoryService } = require('../../src/services/MemoryService');
    await memoryService.init();
    const path = `${RNFS.DocumentDirectoryPath}/notes.txt`;
    fs.writeFileSync(path, 'First paragraph about Netscope.\n\nSecond paragraph about LiteLLM.');
    await memoryService.addDocument(path);
    const first = memoryService.getStats().documentCount;
    await memoryService.addDocument(path);
    expect(memoryService.getStats().documentCount).toBe(first);
    expect(await memoryService.hasSource('notes.txt')).toBe(true);
    expect(memoryService.removeSource('notes.txt')).toBe(first);
  });
});

describe('automatic meeting indexing', () => {
  it('indexes new or changed meetings and drops deleted ones', () => {
    const plan = planIndexJobs(
      [
        { id: 'new', version: 'v1' },
        { id: 'same', version: 'v1' },
        { id: 'changed', version: 'v2' },
        { id: 'no_minutes', version: null },
      ],
      { same: 'v1', changed: 'v1', deleted: 'v1' },
    );
    expect(plan).toEqual({ index: ['new', 'changed'], remove: ['deleted'] });
  });

  it('a meeting has an index version only once its minutes exist', () => {
    const m = makeMeeting({ segments: [seg(0, 'Hello')], status: 'ready', minutes: undefined });
    expect(meetingVersion(m)).toBeNull();
    m.minutes = {
      summary: 's',
      keyPoints: [],
      decisions: [],
      openQuestions: [],
      nextSteps: [],
      generatedAt: 5,
      model: 'm',
      edited: false,
    };
    expect(meetingVersion(m)).toBe('5::1');
  });
});

describe('remember requests in chat', () => {
  it('saves "remember that …" straight to memory, and ignores other messages', async () => {
    const { saveIfRememberRequest } = require('../../src/memory/chatContext');
    const { memoryManager } = require('../../src/memory/MemoryManager');
    const create = jest.spyOn(memoryManager, 'create').mockResolvedValue({} as never);
    expect(await saveIfRememberRequest('Remember that I prefer meetings after 11 am.')).toBe(
      'I prefer meetings after 11 am',
    );
    expect(create).toHaveBeenCalledWith(
      expect.objectContaining({ kind: 'profile', source: 'user', pinned: true }),
    );
    expect(await saveIfRememberRequest('What is the capital of Japan?')).toBeNull();
    create.mockRestore();
  });
});

describe('chat index privacy', () => {
  it('a deleted meeting, or turning indexing off, removes meetings from the index', async () => {
    const { memoryService } = require('../../src/services/MemoryService');
    const { autoIndexer, indexFileName } = require('../../src/memory/autoIndex');
    const { meetingStore } = require('../../src/meetings/MeetingStore');
    const mod = require('@react-native-async-storage/async-storage');
    const AsyncStorage = mod.default ?? mod;
    await memoryService.init();
    for (const id of ['mtg_a', 'mtg_b']) {
      const path = `${RNFS.DocumentDirectoryPath}/${indexFileName(id)}`;
      fs.writeFileSync(path, `Minutes of ${id}.`);
      await memoryService.addDocument(path);
    }
    await AsyncStorage.setItem('@liquid_autoindex_v1', JSON.stringify({ mtg_a: 'v', mtg_b: 'v' }));

    await meetingStore.delete('mtg_a'); // the store tells the indexer
    await new Promise(r => setTimeout(r, 50));
    expect(await memoryService.hasSource(indexFileName('mtg_a'))).toBe(false);
    expect(await memoryService.hasSource(indexFileName('mtg_b'))).toBe(true);

    await autoIndexer.purgeAll();
    expect(await memoryService.hasSource(indexFileName('mtg_b'))).toBe(false);
    expect(JSON.parse(await AsyncStorage.getItem('@liquid_autoindex_v1'))).toEqual({});
  });
});

describe('embedding model and the RAM budget', () => {
  it('never loads it over budget: remembers later, and releases it when idle', async () => {
    jest.useFakeTimers({ doNotFake: ['nextTick', 'setImmediate'] });
    const { memoryService, EMBED_IDLE_MS } = require('../../src/services/MemoryService');
    const { modelLifecycle } = require('../../src/services/ModelLifecycleManager');
    await memoryService.init();
    const before = memoryService.getStats().memoryCount;

    const fits = jest.spyOn(modelLifecycle, 'fitsInBudget').mockReturnValue(false);
    const ensure = jest.spyOn(modelLifecycle, 'ensure');
    const release = jest.spyOn(modelLifecycle, 'release').mockResolvedValue(undefined);
    jest.spyOn(modelLifecycle, 'getModelState').mockReturnValue('unloaded');
    (memoryService as any).managedModel = null;
    expect(await memoryService.remember('User asked about LiteLLM')).toBe('');
    expect(ensure).not.toHaveBeenCalled();
    expect(memoryService.getStats().memoryCount).toBe(before);

    // Room again: the next embedding call loads the model and the queued item is stored too.
    fits.mockReturnValue(true);
    await memoryService.remember('User asked about Netscope');
    await jest.runOnlyPendingTimersAsync();
    expect(memoryService.getStats().memoryCount).toBe(before + 2);

    await jest.advanceTimersByTimeAsync(EMBED_IDLE_MS + 10);
    expect(release).toHaveBeenCalledWith('qwen3-embedding-0.6b');
    jest.restoreAllMocks();
    jest.useRealTimers();
  });
});
