import {
  localEntries,
  ModelRegistry,
  REMOTE_PROVIDERS_KEY,
} from '../../src/inference/ModelRegistry';
import { freshDb, MemoryCredentials, MemoryKV, OPENAI_CFG } from './helpers';

beforeEach(freshDb);

function makeRegistry() {
  const credentials = new MemoryCredentials();
  const storage = new MemoryKV();
  return { registry: new ModelRegistry({ credentials, storage }), credentials, storage };
}

describe('local catalog', () => {
  const entries = localEntries();
  const ids = entries.map(e => e.modelId);

  test('excludes STT, embedding and legacy models', () => {
    expect(ids).not.toContain('whisper-small');
    expect(ids).not.toContain('qwen3-embedding-0.6b');
    expect(ids).not.toContain('lfm2-1.2b');
    expect(ids).not.toContain('lfm2-350m');
    expect(ids).toContain('lfm2.5-1.2b-instruct');
    expect(ids).toContain('lfm2.5-vl-1.6b');
  });

  test('context, memory and vision flags', () => {
    const lfm = entries.find(e => e.modelId === 'lfm2.5-1.2b-instruct')!;
    expect(lfm.maxContextTokens).toBe(32768);
    expect(lfm.estimatedMemoryMB).toBe(Math.round(1119 * 1.3));
    expect(lfm.provider).toBe('local');
    expect(entries.find(e => e.modelId === 'qwen3.5-2b')!.maxContextTokens).toBe(32768);
    expect(entries.find(e => e.modelId === 'qwen3.5-2b')!.supportsVision).toBe(true);
    expect(entries.find(e => e.modelId === 'lfm2-vl-450m')!.supportsVision).toBe(true);
    expect(entries.find(e => e.modelId === 'lfm2-8b-a1b')!.minDeviceRamMb).toBe(12 * 1024);
  });

  test('no quality guesses without measurements', () => {
    for (const e of entries) expect(e.qualityScores).toBeUndefined();
  });
});

describe('remote providers', () => {
  test('persists config without keys; keys go to the CredentialStore', async () => {
    const { registry, credentials, storage } = makeRegistry();
    await registry.upsertProvider(OPENAI_CFG, 'sk-test-secret-123456789');
    const raw = storage.map.get(REMOTE_PROVIDERS_KEY)!;
    expect(raw).not.toContain('sk-test');
    expect(await credentials.get('provider:oai')).toBe('sk-test-secret-123456789');
    const caps = await registry.capabilities();
    const m = caps.find(c => c.modelId === 'oai/gpt-mini')!;
    expect(m).toMatchObject({
      provider: 'remote',
      providerId: 'oai',
      maxContextTokens: 128000,
      supportsLongContext: true,
      estimatedInputCostPerMillion: 0.15,
    });
    expect((await registry.get('oai/gpt-mini'))!.providerModelId).toBe('gpt-mini');
  });

  test('rejects apiKey in config and bad ids', async () => {
    const { registry } = makeRegistry();
    await expect(
      registry.saveRemoteProviders([{ ...OPENAI_CFG, apiKey: 'x' } as any]),
    ).rejects.toThrow(/CredentialStore/);
    await expect(registry.saveRemoteProviders([{ ...OPENAI_CFG, id: 'cactus' }])).rejects.toThrow(
      /reserved/,
    );
  });

  test('removeProvider deletes the key', async () => {
    const { registry, credentials } = makeRegistry();
    await registry.upsertProvider(OPENAI_CFG, 'k');
    await registry.removeProvider('oai');
    expect(await credentials.has('provider:oai')).toBe(false);
    expect(await registry.remoteProviders()).toHaveLength(0);
  });
});

describe('measured stats', () => {
  test('EWMA latency/tps and per-operation success-rate quality', async () => {
    const { registry } = makeRegistry();
    await registry.recordSample('lfm2.5-350m', { latencyMs: 1000, tps: 20 });
    await registry.recordSample('lfm2.5-350m', { latencyMs: 2000, tps: 40 });
    let e = (await registry.get('lfm2.5-350m'))!;
    expect(e.samples).toBe(2);
    expect(e.averageLatencyMs).toBe(1500); // alpha = 1/2 for the second sample
    expect(e.averageTokensPerSecond).toBe(30);
    expect(e.qualityScores).toBeUndefined();

    // below MIN_QUALITY_SAMPLES quality stays unknown
    await registry.recordSample('lfm2.5-350m', { operation: 'plan', success: true });
    await registry.recordSample('lfm2.5-350m', { operation: 'plan', success: false });
    e = (await registry.get('lfm2.5-350m'))!;
    expect(e.qualityScores).toBeUndefined();
    await registry.recordSample('lfm2.5-350m', { operation: 'plan', success: true });
    e = (await registry.get('lfm2.5-350m'))!;
    expect(e.qualityScores!.plan).toBeCloseTo(2 / 3, 3);
    expect(e.qualityScores!.reason).toBeUndefined();
  });

  test('failed samples do not skew latency', async () => {
    const { registry } = makeRegistry();
    await registry.recordSample('m', { latencyMs: 100 });
    await registry.recordSample('m', { latencyMs: 99999, success: false });
    const caps = await registry.entries();
    expect(caps.find(c => c.modelId === 'm')).toBeUndefined(); // unknown model not listed
    await registry.recordSample('lfm2-700m', { latencyMs: 100 });
    await registry.recordSample('lfm2-700m', { latencyMs: 99999, success: false });
    expect((await registry.get('lfm2-700m'))!.averageLatencyMs).toBe(100);
  });
});
