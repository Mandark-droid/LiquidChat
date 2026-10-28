jest.mock('@traceverse/genai-otel-instrument-node/react-native', () => ({
  instrument: jest.fn(),
  instrumentCactus: jest.fn(() => true),
  isInstrumented: jest.fn(() => false),
  uninstrument: jest.fn(),
  setLogger: jest.fn(),
  flushTelemetry: jest.fn(async () => true),
}));
jest.mock('../../src/platform/android', () => {
  const store = new Map<string, string>();
  return {
    credentials: {
      get: async (k: string) => store.get(k) ?? null,
      set: async (k: string, v: string) => void store.set(k, v),
      delete: async (k: string) => void store.delete(k),
    },
  };
});

import * as sdk from '@traceverse/genai-otel-instrument-node/react-native';

import {
  applyOtel,
  endpointProblem,
  mirroringFetch,
  parseHeaders,
  saveOtelSettings,
  withProjectRouting,
} from '../../src/observability/otelExport';

describe('OpenTelemetry export settings', () => {
  it('parses OTLP header strings', () => {
    expect(parseHeaders('Authorization=Bearer a=b, x-tenant = lc ,bad')).toEqual({
      Authorization: 'Bearer a=b',
      'x-tenant': 'lc',
    });
  });

  it('requires https except for a collector on the local network', () => {
    expect(endpointProblem('https://otel.example.com:4318')).toBeNull();
    expect(endpointProblem('http://192.168.1.20:4318')).toBeNull();
    expect(endpointProblem('http://otel.example.com:4318')).toMatch(/https/);
    expect(endpointProblem('')).toMatch(/URL/);
  });

  it('is off by default and exports only after it is turned on', async () => {
    expect(await applyOtel()).toBe(false);
    expect(sdk.instrument).not.toHaveBeenCalled();
    await saveOtelSettings(
      {
        enabled: true,
        endpoint: 'https://otel.example.com:4318',
        captureContent: false,
        mirrorEndpoint: '',
      },
      'Authorization=Bearer k',
    );
    expect(sdk.instrument).toHaveBeenCalledWith(
      expect.objectContaining({
        serviceName: 'liquidchat',
        endpoint: 'https://otel.example.com:4318',
        headers: { Authorization: 'Bearer k' },
        enableContentCapture: false,
      }),
    );
    expect(sdk.instrumentCactus).toHaveBeenCalled();
  });

  it('names an Arize project unless the user did', () => {
    const keys = { space_id: 's', api_key: 'k' };
    expect(withProjectRouting('https://otlp.arize.com', keys)).toEqual({
      ...keys,
      'x-project-name': 'liquidchat',
    });
    const named = { ...keys, 'X-Project-Name': 'mine' };
    expect(withProjectRouting('https://otlp.arize.com', named)).toBe(named);
    expect(withProjectRouting('https://notarize.com', keys)).toBe(keys);
    expect(withProjectRouting('https://otel.example.com:4318', keys)).toBe(keys);
  });

  it('sends each OTLP request to the second destination too, with its own headers', async () => {
    const calls: { url: string; headers: Record<string, string>; body: string }[] = [];
    const base = jest.fn(async (url: any, init: any) => {
      calls.push({ url: String(url), headers: init.headers, body: init.body });
      return { ok: true, status: 200 } as Response;
    });
    const f = mirroringFetch(
      'https://collector.example.com/',
      'https://otlp.arize.com',
      { space_id: 's', api_key: 'k', 'x-project-name': 'liquidchat' },
      base as unknown as typeof fetch,
    );
    const r = await f('https://collector.example.com/v1/traces', {
      method: 'POST',
      headers: { Authorization: 'Bearer mine', 'content-type': 'application/json' },
      body: '{"resourceSpans":[]}',
    });
    expect(r.ok).toBe(true);
    expect(calls.map(c => c.url).sort()).toEqual([
      'https://collector.example.com/v1/traces',
      'https://otlp.arize.com/v1/traces',
    ]);
    const mirrored = calls.find(c => c.url.startsWith('https://otlp.arize.com'))!;
    // The primary's credentials never go to the second destination.
    expect(mirrored.headers).toEqual({
      'content-type': 'application/json',
      space_id: 's',
      api_key: 'k',
      'x-project-name': 'liquidchat',
    });
    expect(mirrored.body).toBe('{"resourceSpans":[]}');
  });
});
