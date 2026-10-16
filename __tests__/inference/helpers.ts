/**
 * Small in-test fakes for the inference suites (src/platform/fakes.ts is
 * being built separately). This file also holds a sanity test so Jest's
 * testMatch (which includes every file under __tests__) accepts it.
 */
import type { RemoteProviderConfig } from '../../src/inference/ModelRegistry';
import type {
  CredentialStore,
  DeviceContextProvider,
  DeviceSnapshot,
} from '../../src/platform/types';
import { resetDatabaseForTests } from '../../src/storage/db';

export function freshDb(): void {
  resetDatabaseForTests();
  (require('@op-engineering/op-sqlite') as any).__resetAll();
}

export class MemoryCredentials implements CredentialStore {
  readonly map = new Map<string, string>();
  async get(k: string) {
    return this.map.get(k) ?? null;
  }
  async set(k: string, v: string) {
    this.map.set(k, v);
  }
  async delete(k: string) {
    this.map.delete(k);
  }
  async has(k: string) {
    return this.map.has(k);
  }
  async databaseKey() {
    return '00'.repeat(32);
  }
}

export const BASE_SNAPSHOT: DeviceSnapshot = {
  batteryPercent: 80,
  charging: false,
  powerSaveMode: false,
  thermal: 'none',
  online: true,
  unmetered: true,
  availableRamMb: 6000,
  totalRamMb: 12 * 1024,
  lowMemory: false,
  timestamp: 0,
};

export class FakeDevice implements DeviceContextProvider {
  snap: DeviceSnapshot;
  constructor(patch: Partial<DeviceSnapshot> = {}) {
    this.snap = { ...BASE_SNAPSHOT, ...patch };
  }
  set(patch: Partial<DeviceSnapshot>) {
    this.snap = { ...this.snap, ...patch };
  }
  async snapshot() {
    return { ...this.snap };
  }
  distribution() {
    return 'play' as const;
  }
}

export class MemoryKV {
  readonly map = new Map<string, string>();
  async getItem(k: string) {
    return this.map.get(k) ?? null;
  }
  async setItem(k: string, v: string) {
    this.map.set(k, v);
  }
}

export const OPENAI_CFG: RemoteProviderConfig = {
  id: 'oai',
  kind: 'openai',
  enabled: true,
  models: [
    {
      id: 'gpt-mini',
      displayName: 'GPT Mini',
      contextTokens: 128_000,
      vision: true,
      tools: true,
      inputCostPerM: 0.15,
      outputCostPerM: 0.6,
    },
  ],
};

export const ANTHROPIC_CFG: RemoteProviderConfig = {
  id: 'claude',
  kind: 'anthropic',
  enabled: true,
  models: [
    {
      id: 'claude-haiku',
      displayName: 'Claude Haiku',
      contextTokens: 200_000,
      vision: true,
      tools: true,
      inputCostPerM: 1,
      outputCostPerM: 5,
    },
  ],
};

/** Builds a fetch mock returning queued responses and capturing requests. */
export function mockFetch(
  ...responses: (
    { status?: number; body?: unknown; text?: string; headers?: Record<string, string> } | Error
  )[]
) {
  const calls: { url: string; init: any; body: any }[] = [];
  const fn = jest.fn(async (url: string, init: any) => {
    calls.push({ url, init, body: init?.body ? JSON.parse(init.body) : undefined });
    const r = responses.length > 1 ? responses.shift()! : responses[0];
    if (r instanceof Error) throw r;
    const headers = Object.fromEntries(
      Object.entries(r.headers ?? { 'content-type': 'application/json' }).map(([k, v]) => [
        k.toLowerCase(),
        v,
      ]),
    );
    const status = r.status ?? 200;
    return {
      ok: status >= 200 && status < 300,
      status,
      headers: { get: (n: string) => headers[n.toLowerCase()] ?? null },
      text: async () => r.text ?? (r.body === undefined ? '' : JSON.stringify(r.body)),
    };
  });
  return { fn, calls };
}

/** Jest treats every file under __tests__ as a suite; only self-test when run directly. */
if (expect.getState().testPath?.endsWith('helpers.ts')) {
  test('fakes behave', async () => {
    const c = new MemoryCredentials();
    await c.set('a', 'b');
    expect(await c.has('a')).toBe(true);
    const d = new FakeDevice({ online: false });
    expect((await d.snapshot()).online).toBe(false);
  });
}
