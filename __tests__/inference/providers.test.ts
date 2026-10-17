import { ProviderError } from '../../src/inference/errors';
import type { RemoteProviderConfig } from '../../src/inference/ModelRegistry';
import { AnthropicProvider } from '../../src/inference/providers/AnthropicProvider';
import { CactusProvider, toCactusTool } from '../../src/inference/providers/CactusProvider';
import { GeminiProvider } from '../../src/inference/providers/GeminiProvider';
import { OpenAICompatibleProvider } from '../../src/inference/providers/OpenAICompatibleProvider';
import type { InferenceRequest } from '../../src/inference/types';
import { ANTHROPIC_CFG, MemoryCredentials, mockFetch, OPENAI_CFG } from './helpers';

const KEY = 'sk-live-SUPERSECRETKEY1234567890';

const REQ: InferenceRequest = {
  messages: [
    { role: 'system', content: 'Be terse.' },
    { role: 'user', content: 'Weather in Pune?', images: ['data:image/png;base64,AAAA'] },
  ],
  tools: [
    {
      name: 'get_weather',
      description: 'Weather for a city',
      parameters: {
        type: 'object',
        properties: { city: { type: 'string', description: 'City' } },
        required: ['city'],
      },
    },
  ],
  maxTokens: 64,
  temperature: 0.2,
};

async function creds(id: string) {
  const c = new MemoryCredentials();
  await c.set(`provider:${id}`, KEY);
  return c;
}

const realFetch = global.fetch;
afterEach(() => {
  global.fetch = realFetch;
});

describe('OpenAICompatibleProvider', () => {
  const cfg: RemoteProviderConfig = { ...OPENAI_CFG, baseUrl: 'https://openrouter.ai/api/v1/' };

  test('request shape and response mapping', async () => {
    const { fn, calls } = mockFetch({
      body: {
        choices: [
          {
            message: {
              content: null,
              tool_calls: [
                {
                  type: 'function',
                  function: { name: 'get_weather', arguments: '{"city":"Pune"}' },
                },
              ],
            },
            finish_reason: 'tool_calls',
          },
        ],
        usage: { prompt_tokens: 1000, completion_tokens: 100 },
      },
    });
    global.fetch = fn as any;
    const p = new OpenAICompatibleProvider({ config: cfg, credentials: await creds('oai') });
    const r = await p.complete('oai/gpt-mini', { ...REQ, json: true, stop: ['END'] });

    expect(calls[0].url).toBe('https://openrouter.ai/api/v1/chat/completions');
    expect(calls[0].init.headers.Authorization).toBe(`Bearer ${KEY}`);
    expect(calls[0].body).toMatchObject({
      model: 'gpt-mini',
      max_tokens: 64,
      temperature: 0.2,
      stop: ['END'],
      response_format: { type: 'json_object' },
      tools: [
        {
          type: 'function',
          function: { name: 'get_weather', parameters: REQ.tools![0].parameters },
        },
      ],
    });
    expect(calls[0].body.messages[1].content).toEqual([
      { type: 'text', text: 'Weather in Pune?' },
      { type: 'image_url', image_url: { url: 'data:image/png;base64,AAAA' } },
    ]);
    expect(r.functionCalls).toEqual([{ name: 'get_weather', arguments: { city: 'Pune' } }]);
    expect(r).toMatchObject({
      text: '',
      mode: 'remote',
      provider: 'oai',
      inputTokens: 1000,
      outputTokens: 100,
    });
    expect(r.costUsd).toBeCloseTo((1000 * 0.15 + 100 * 0.6) / 1e6, 10);
  });

  test.each([
    [401, 'auth', false],
    [403, 'auth', false],
    [429, 'rate_limit', true],
    [503, 'server', true],
    [400, 'bad_request', false],
  ])('HTTP %i → %s (retryable=%s), key never in message', async (status, kind, retryable) => {
    const { fn } = mockFetch({
      status,
      body: { error: { message: `Incorrect API key provided: ${KEY}` } },
    });
    global.fetch = fn as any;
    const p = new OpenAICompatibleProvider({ config: OPENAI_CFG, credentials: await creds('oai') });
    const err = (await p.complete('gpt-mini', REQ).catch(e => e)) as ProviderError;
    expect(err).toBeInstanceOf(ProviderError);
    expect(err.kind).toBe(kind);
    expect(err.retryable).toBe(retryable);
    expect(err.status).toBe(status);
    expect(err.message).not.toContain(KEY);
    expect(err.message).not.toContain('SUPERSECRET');
  });

  test('network error and timeout', async () => {
    global.fetch = mockFetch(new Error(`connect failed with key ${KEY}`)).fn as any;
    const p = new OpenAICompatibleProvider({ config: OPENAI_CFG, credentials: await creds('oai') });
    const err = (await p.complete('gpt-mini', REQ).catch(e => e)) as ProviderError;
    expect(err.kind).toBe('network');
    expect(err.retryable).toBe(true);
    expect(err.message).not.toContain(KEY);

    global.fetch = jest.fn(
      (_url: string, init: any) =>
        new Promise((_res, rej) => {
          init.signal.addEventListener('abort', () =>
            rej(Object.assign(new Error('aborted'), { name: 'AbortError' })),
          );
        }),
    ) as any;
    const slow = new OpenAICompatibleProvider({
      config: OPENAI_CFG,
      credentials: await creds('oai'),
      timeoutMs: 20,
    });
    const t = (await slow.complete('gpt-mini', REQ).catch(e => e)) as ProviderError;
    expect(t.kind).toBe('timeout');
  });

  test('caller abort → aborted', async () => {
    global.fetch = jest.fn(
      (_url: string, init: any) =>
        new Promise((_res, rej) => {
          init.signal.addEventListener('abort', () => rej(new Error('aborted')));
        }),
    ) as any;
    const p = new OpenAICompatibleProvider({ config: OPENAI_CFG, credentials: await creds('oai') });
    const ctrl = new AbortController();
    const pending = p.complete('gpt-mini', REQ, ctrl.signal).catch(e => e);
    ctrl.abort();
    expect(((await pending) as ProviderError).kind).toBe('aborted');
  });

  test('missing key → unavailable without a network call', async () => {
    const { fn } = mockFetch({ body: {} });
    global.fetch = fn as any;
    const p = new OpenAICompatibleProvider({
      config: OPENAI_CFG,
      credentials: new MemoryCredentials(),
    });
    expect(await p.isAvailable()).toBe(false);
    await expect(p.complete('gpt-mini', REQ)).rejects.toMatchObject({ kind: 'unavailable' });
    expect(fn).not.toHaveBeenCalled();
  });

  test('non-JSON body → parse error', async () => {
    global.fetch = mockFetch({ text: '<html>gateway</html>' }).fn as any;
    const p = new OpenAICompatibleProvider({ config: OPENAI_CFG, credentials: await creds('oai') });
    await expect(p.complete('gpt-mini', REQ)).rejects.toMatchObject({ kind: 'parse' });
  });
});

describe('AnthropicProvider', () => {
  test('request shape and content-block mapping', async () => {
    const { fn, calls } = mockFetch({
      body: {
        content: [
          { type: 'text', text: 'Checking. ' },
          { type: 'tool_use', id: 't1', name: 'get_weather', input: { city: 'Pune' } },
        ],
        stop_reason: 'tool_use',
        usage: { input_tokens: 2000, output_tokens: 50 },
      },
    });
    global.fetch = fn as any;
    const p = new AnthropicProvider({ config: ANTHROPIC_CFG, credentials: await creds('claude') });
    const r = await p.complete('claude/claude-haiku', {
      ...REQ,
      messages: [
        ...REQ.messages,
        { role: 'assistant', content: 'ok' },
        { role: 'assistant', content: 'more' },
      ],
    });
    expect(calls[0].url).toBe('https://api.anthropic.com/v1/messages');
    expect(calls[0].init.headers['x-api-key']).toBe(KEY);
    expect(calls[0].init.headers['anthropic-version']).toBe('2023-06-01');
    expect(calls[0].init.headers.Authorization).toBeUndefined();
    const b = calls[0].body;
    expect(b.system).toBe('Be terse.');
    expect(b.model).toBe('claude-haiku');
    expect(b.max_tokens).toBe(64);
    expect(b.tools).toEqual([
      {
        name: 'get_weather',
        description: 'Weather for a city',
        input_schema: REQ.tools![0].parameters,
      },
    ]);
    expect(b.messages.map((m: any) => m.role)).toEqual(['user', 'assistant']); // merged
    expect(b.messages[0].content[0]).toEqual({
      type: 'image',
      source: { type: 'base64', media_type: 'image/png', data: 'AAAA' },
    });
    expect(r.text).toBe('Checking. ');
    expect(r.functionCalls).toEqual([{ name: 'get_weather', arguments: { city: 'Pune' } }]);
    expect(r.costUsd).toBeCloseTo((2000 * 1 + 50 * 5) / 1e6, 10);
  });

  test('json mode instructs via system; 529 overloaded is retryable', async () => {
    const { fn, calls } = mockFetch({ status: 529, body: { error: { message: 'Overloaded' } } });
    global.fetch = fn as any;
    const p = new AnthropicProvider({ config: ANTHROPIC_CFG, credentials: await creds('claude') });
    const err = (await p
      .complete('claude-haiku', { ...REQ, json: true })
      .catch(e => e)) as ProviderError;
    expect(calls[0].body.system).toMatch(/JSON object/);
    expect(err.kind).toBe('server');
    expect(err.retryable).toBe(true);
  });
});

describe('GeminiProvider', () => {
  const cfg: RemoteProviderConfig = {
    id: 'gem',
    kind: 'gemini',
    enabled: true,
    models: [
      {
        id: 'gemini-flash',
        displayName: 'Gemini Flash',
        contextTokens: 1_000_000,
        vision: true,
        tools: true,
        inputCostPerM: 0.1,
        outputCostPerM: 0.4,
      },
    ],
  };

  test('request shape (key in header, not URL) and parts mapping', async () => {
    const { fn, calls } = mockFetch({
      body: {
        candidates: [
          {
            content: {
              parts: [
                { text: 'Sure' },
                { functionCall: { name: 'get_weather', args: { city: 'Pune' } } },
              ],
            },
            finishReason: 'STOP',
          },
        ],
        usageMetadata: { promptTokenCount: 300, candidatesTokenCount: 20 },
      },
    });
    global.fetch = fn as any;
    const p = new GeminiProvider({ config: cfg, credentials: await creds('gem') });
    const r = await p.complete('gem/gemini-flash', {
      ...REQ,
      messages: [...REQ.messages, { role: 'assistant', content: 'hm' }],
    });
    expect(calls[0].url).toBe(
      'https://generativelanguage.googleapis.com/v1beta/models/gemini-flash:generateContent',
    );
    expect(calls[0].url).not.toContain(KEY);
    expect(calls[0].init.headers['x-goog-api-key']).toBe(KEY);
    const b = calls[0].body;
    expect(b.systemInstruction).toEqual({ parts: [{ text: 'Be terse.' }] });
    expect(b.contents.map((c: any) => c.role)).toEqual(['user', 'model']);
    expect(b.contents[0].parts[0]).toEqual({ inlineData: { mimeType: 'image/png', data: 'AAAA' } });
    expect(b.tools[0].functionDeclarations[0]).toMatchObject({
      name: 'get_weather',
      parameters: { type: 'object', required: ['city'] },
    });
    expect(b.generationConfig).toEqual({ maxOutputTokens: 64, temperature: 0.2 });
    expect(r).toMatchObject({ text: 'Sure', inputTokens: 300, outputTokens: 20 });
    expect(r.functionCalls).toEqual([{ name: 'get_weather', arguments: { city: 'Pune' } }]);
  });

  test('json mode without tools; blocked prompt → content_filtered', async () => {
    const { fn, calls } = mockFetch({ body: { promptFeedback: { blockReason: 'SAFETY' } } });
    global.fetch = fn as any;
    const p = new GeminiProvider({ config: cfg, credentials: await creds('gem') });
    const err = (await p
      .complete('gemini-flash', { messages: [{ role: 'user', content: 'x' }], json: true })
      .catch(e => e)) as ProviderError;
    expect(calls[0].body.generationConfig.responseMimeType).toBe('application/json');
    expect(err.kind).toBe('content_filtered');
  });

  test('403 → auth', async () => {
    global.fetch = mockFetch({ status: 403, body: { error: { message: 'API key not valid' } } })
      .fn as any;
    const p = new GeminiProvider({ config: cfg, credentials: await creds('gem') });
    await expect(p.complete('gemini-flash', REQ)).rejects.toMatchObject({
      kind: 'auth',
      retryable: false,
    });
  });
});

describe('CactusProvider', () => {
  function fakeLm(result: Partial<Record<string, unknown>> = {}) {
    const calls: any[] = [];
    const lm = {
      reset: jest.fn(async () => {}),
      stop: jest.fn(async () => {}),
      complete: jest.fn(async (p: any) => {
        calls.push(p);
        return {
          success: true,
          response: 'hello',
          functionCalls: [{ name: 'set_timer', arguments: { minutes: 5 } }],
          confidence: 0.82,
          timeToFirstTokenMs: 50,
          totalTimeMs: 900,
          prefillTokens: 120,
          prefillTps: 400,
          decodeTokens: 30,
          decodeTps: 33,
          totalTokens: 150,
          ramUsageMb: 1450,
          ...result,
        };
      }),
    };
    return { lm, calls };
  }

  test('ensure → reset → complete; result mapped', async () => {
    const { lm, calls } = fakeLm();
    const lifecycle = { ensure: jest.fn(async () => ({ instance: lm as any })) };
    const p = new CactusProvider({ lifecycle });
    const r = await p.complete('lfm2.5-1.2b-instruct', { ...REQ, json: true, stop: ['</s>'] });
    expect(lifecycle.ensure).toHaveBeenCalledWith('lfm2.5-1.2b-instruct');
    expect(lm.reset).toHaveBeenCalled();
    expect(calls[0].tools[0]).toEqual({
      name: 'get_weather',
      description: 'Weather for a city',
      parameters: {
        type: 'object',
        properties: { city: { type: 'string', description: 'City' } },
        required: ['city'],
      },
    });
    expect(calls[0].messages[0].content).toMatch(/JSON object/);
    expect(calls[0].messages[1].images).toEqual(['data:image/png;base64,AAAA']);
    expect(calls[0].options).toEqual({ temperature: 0.2, maxTokens: 64, stopSequences: ['</s>'] });
    expect(r).toEqual({
      text: 'hello',
      functionCalls: [{ name: 'set_timer', arguments: { minutes: 5 } }],
      modelId: 'lfm2.5-1.2b-instruct',
      provider: 'cactus',
      mode: 'local',
      latencyMs: 900,
      inputTokens: 120,
      outputTokens: 30,
      tokensPerSecond: 33,
      confidence: 0.82,
      costUsd: 0,
      ramUsageMb: 1450,
    });
    expect(REQ.messages[0].content).toBe('Be terse.'); // input not mutated
  });

  test('serializes generations per model instance', async () => {
    let active = 0;
    let maxActive = 0;
    const lm = {
      reset: async () => {},
      stop: async () => {},
      complete: async () => {
        active++;
        maxActive = Math.max(maxActive, active);
        await new Promise(r => setTimeout(r, 5));
        active--;
        return {
          success: true,
          response: 'x',
          totalTimeMs: 1,
          prefillTokens: 1,
          decodeTokens: 1,
          decodeTps: 1,
        } as any;
      },
    };
    const p = new CactusProvider({ lifecycle: { ensure: async () => ({ instance: lm as any }) } });
    await Promise.all([p.complete('m', REQ), p.complete('m', REQ), p.complete('m', REQ)]);
    expect(maxActive).toBe(1);
  });

  test('load failure → unavailable; generation failure → model_error', async () => {
    const p1 = new CactusProvider({
      lifecycle: { ensure: async () => Promise.reject(new Error('OOM')) },
    });
    await expect(p1.complete('m', REQ)).rejects.toMatchObject({ kind: 'unavailable' });
    const { lm } = fakeLm({ success: false });
    const p2 = new CactusProvider({ lifecycle: { ensure: async () => ({ instance: lm as any }) } });
    await expect(p2.complete('m', REQ)).rejects.toMatchObject({
      kind: 'model_error',
      retryable: false,
    });
  });

  test('toCactusTool flattens enums into descriptions', () => {
    const t = toCactusTool({
      name: 'x',
      description: 'd',
      parameters: { type: 'object', properties: { mode: { type: 'string', enum: ['a', 'b'] } } },
    });
    expect(t.parameters.properties.mode.description).toBe('mode One of: a, b.');
    expect(t.parameters.required).toEqual([]);
  });
});
