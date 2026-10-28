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
  nextHeaders,
  originOf,
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

  it('saved headers stay with their backend: removed on request or when the endpoint moves host', () => {
    const arize = 'https://otlp.arize.com';
    const ngrok = 'https://x.ngrok-free.dev';
    expect(nextHeaders('api_key=new', false, arize, arize)).toBe('api_key=new');
    expect(nextHeaders('', false, arize, `${arize}/`)).toBeNull(); // same host: keep
    expect(nextHeaders('', false, arize, ngrok)).toBe(''); // another host: never sent there
    expect(nextHeaders('', true, arize, arize)).toBe(''); // asked to remove
    expect(nextHeaders('', false, ngrok, '')).toBe(''); // destination cleared
    expect(nextHeaders('', false, '', arize)).toBeNull(); // first save, nothing typed
  });

  it('an endpoint that only looks like the same host does not keep the headers', () => {
    const arize = 'https://otlp.arize.com';
    for (const tricky of [
      'https://otlp.arize.com:x@evil.example',
      'https://otlp.arize.com@evil.example',
      'https://user:pass@otlp.arize.com',
      'http://otlp.arize.com', // another scheme
      'https://otlp.arize.com:8443', // another port
      'not a url',
    ])
      expect(nextHeaders('', false, arize, tricky)).toBe('');
    expect(nextHeaders('', false, arize, 'HTTPS://OTLP.ARIZE.COM:443/')).toBeNull();
    expect(originOf('https://otlp.arize.com:x@evil.example')).toBeNull();
    expect(endpointProblem('https://key@otel.example.com')).toMatch(/headers/);
  });
});
