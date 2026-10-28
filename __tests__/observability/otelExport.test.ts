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
  parseHeaders,
  saveOtelSettings,
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
        additionalDestinations: [],
      }),
    );
  });

  it('sends to a second destination through the SDK, with its own headers', async () => {
    await saveOtelSettings(
      {
        enabled: true,
        endpoint: 'https://collector.example.com',
        captureContent: true,
        mirrorEndpoint: 'https://otlp.example.net',
      },
      'Authorization=Bearer mine',
      'api_key=k2',
    );
    expect(sdk.instrument).toHaveBeenLastCalledWith(
      expect.objectContaining({
        headers: { Authorization: 'Bearer mine' },
        additionalDestinations: [
          { endpoint: 'https://otlp.example.net', headers: { api_key: 'k2' } },
        ],
        enableContentCapture: true,
      }),
    );
  });
});
