jest.mock('react-native-device-info', () => ({
  getTotalMemory: jest.fn(async () => 7.24 * 1024 ** 3),
}));
jest.mock('../../src/services/cactusWeights', () => ({
  ensurePinnedWeights: jest.fn(async () => undefined),
}));

import { CactusAudio, CactusSTT } from 'cactus-react-native';

import { modelLifecycle } from '../../src/services/ModelLifecycleManager';

describe('ModelLifecycleManager loads every kind of model', () => {
  afterEach(() => modelLifecycle.releaseAll());

  it('loads speech-to-text and audio models and lists them as loaded', async () => {
    const stt = await modelLifecycle.ensureSTT('whisper-small');
    expect(stt).toBeInstanceOf(CactusSTT);
    const vad = await modelLifecycle.ensureAudio('silero-vad');
    expect(vad).toBeInstanceOf(CactusAudio);
    const loaded = modelLifecycle.getLoadedModels().map(m => [m.slug, m.kind]);
    expect(loaded).toEqual(
      expect.arrayContaining([
        ['whisper-small', 'stt'],
        ['silero-vad', 'audio'],
      ]),
    );
    expect(modelLifecycle.getTotalLoadedRamMb()).toBeGreaterThan(0);
  });

  it('keeps each kind behind its own entry point', async () => {
    await expect(modelLifecycle.ensure('whisper-small')).rejects.toThrow(/ensureSTT/);
    await expect(modelLifecycle.ensureSTT('lfm2.5-350m')).rejects.toThrow(/not a speech/);
  });

  it('never evicts a pinned model, and evicts unpinned ones by least recent use', async () => {
    await modelLifecycle.ensureSTT('whisper-medium', { pin: true });
    await modelLifecycle.ensure('lfm2-700m');
    // Too big to fit next to both: only the unpinned chat model can make room.
    await modelLifecycle.ensure('lfm2-2.6b');
    expect(modelLifecycle.getModelState('whisper-medium')).toBe('ready');
    expect(modelLifecycle.getModelState('lfm2-700m')).toBe('unloaded');
    // The owner is done: release unloads it, pinned or not.
    await modelLifecycle.release('whisper-medium');
    expect(modelLifecycle.getModelState('whisper-medium')).toBe('unloaded');
  });

  it('records calls for the dashboard', async () => {
    const managed = await modelLifecycle.ensure('lfm2.5-350m');
    modelLifecycle.recordCompletion(managed.instance, { totalTimeMs: 1200, tokensPerSecond: 19 });
    await modelLifecycle.ensureSTT('whisper-small');
    modelLifecycle.recordUse('whisper-small', 800);
    modelLifecycle.recordUse('whisper-small', 1200);
    const bySlug = Object.fromEntries(modelLifecycle.getLoadedModels().map(m => [m.slug, m]));
    expect(bySlug['lfm2.5-350m']).toMatchObject({ uses: 1, totalMs: 1200, tokensPerSecond: 19 });
    expect(bySlug['whisper-small']).toMatchObject({ uses: 2, totalMs: 2000 });
  });
});
