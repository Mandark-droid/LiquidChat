import { isPlainChat } from '../../src/services/IntentRouter';
import { makeHarness } from '../helpers/harness';

describe('isPlainChat', () => {
  it.each([
    'Hi',
    'hello there',
    'thanks!',
    'What is the capital of France?',
    "What's a black hole?",
    'Explain quantum entanglement simply',
    'why is the sky blue',
  ])('answers directly: %s', text => expect(isPlainChat(text)).toBe(true));

  it.each([
    'turn on the flashlight',
    'remind me to call mom at 5',
    "what's on my calendar today",
    'set an alarm for 7am',
    'send an email to John about the meeting',
    'what is my battery level',
    'open settings',
    'draft a reply to the last email and then remind me tomorrow',
    '',
  ])('goes to the agent: %s', text => expect(isPlainChat(text)).toBe(false));
});

describe('planner fast path latency', () => {
  it('sends tool schemas once (tools param), not also as JSON in the system prompt', async () => {
    const h = makeHarness({ responder: () => ({ text: 'Hello!' }) });
    await h.planner.plan({ text: 'hey', source: 'chat' }, { executionId: 'e' });
    const { req } = h.inference.calls[0];
    expect(req.tools?.length).toBeGreaterThan(0);
    expect(req.messages[0].content).not.toContain('"parameters"');
  });

  it('streams tokens through the request', async () => {
    const tokens: string[] = [];
    const h = makeHarness({
      responder: (_ctx, req) => {
        req.onToken?.('Hel');
        req.onToken?.('lo');
        return { text: 'Hello' };
      },
    });
    await h.planner.plan(
      { text: 'hey', source: 'chat' },
      { executionId: 'e', onToken: t => tokens.push(t) },
    );
    expect(tokens.join('')).toBe('Hello');
  });
});

describe('invented contact details', () => {
  const emailCall = (to: string) => () => ({
    text: JSON.stringify([{ name: 'send_email', arguments: { to, subject: 'Hello' } }]),
  });

  it('asks for the address instead of using a made-up one', async () => {
    const h = makeHarness({ responder: emailCall('user@example.com') });
    const out = await h.planner.plan(
      { text: 'Send an email to', source: 'chat' },
      { executionId: 'e' },
    );
    expect(out.kind).toBe('answer');
    expect(out.kind === 'answer' && out.text).toMatch(/email address/);
  });

  it('asks when the address appears nowhere in the request', async () => {
    const h = makeHarness({ responder: emailCall('priya@acme.com') });
    const out = await h.planner.plan(
      { text: 'email Priya the notes', source: 'chat' },
      { executionId: 'e' },
    );
    expect(out.kind).toBe('answer');
  });

  it('uses an address the user gave', async () => {
    const h = makeHarness({ responder: emailCall('priya@acme.com') });
    const out = await h.planner.plan(
      { text: 'email priya@acme.com about lunch', source: 'chat' },
      { executionId: 'e' },
    );
    expect(out.kind).toBe('plan');
  });

  it('uses an address known from memory', async () => {
    const h = makeHarness({ responder: emailCall('priya@acme.com') });
    const out = await h.planner.plan(
      { text: 'email Priya about lunch', source: 'chat' },
      { executionId: 'e', memoryContext: 'Priya Shah <priya@acme.com> is a client.' },
    );
    expect(out.kind).toBe('plan');
  });
});

describe('device RAM profile', () => {
  const { getDeviceProfile } = require('../../src/config/modelTiers');
  const gib = (g: number) => g * 1024 ** 3;
  it.each([
    [7.24, 'high'], // Nothing Phone 2a, sold as 8 GB
    [5.5, 'mid'], // 6 GB phone
    [11.1, 'flagship'], // 12 GB phone
    [3.6, 'low'],
  ])('%s GiB reported -> %s', (g, name) => expect(getDeviceProfile(gib(g)).name).toBe(name));
});

describe('repairToolName', () => {
  const { repairToolName } = require('../../src/agent/AgentPlanner');
  const known = [
    'set_alarm',
    'turn_on_flashlight',
    'mcp.hugging_face.hub_repo_search',
    'mcp.hugging_face.hub_repo_details',
    'mcp.hugging_face.hf_whoami',
  ];

  it('keeps exact names', () => {
    expect(repairToolName('set_alarm', known)).toBe('set_alarm');
  });
  it('restores a dropped namespace', () => {
    expect(repairToolName('hub_repo_search', known)).toBe('mcp.hugging_face.hub_repo_search');
  });
  it('maps a garbled MCP name by its distinctive word', () => {
    expect(repairToolName('liap_search', known)).toBe('mcp.hugging_face.hub_repo_search');
  });
  it('fixes a one-letter slip in a built-in name', () => {
    expect(repairToolName('turn_on_flashlite', known)).toBe('turn_on_flashlight');
  });
  it('leaves invented or ambiguous names for the validator to reject', () => {
    expect(repairToolName('delete_all_files', known)).toBe('delete_all_files');
    expect(repairToolName('hub_repo', known)).toBe('hub_repo');
  });
});

describe('tool relevance for the fast path', () => {
  const names = (query: string) => {
    const h = makeHarness();
    return h.registry.relevant(query, 8, 'full').map(t => t.name);
  };

  it('finds the flashlight tool and ignores filler words', () => {
    expect(names('Turn on the flashlight')).toContain('turn_on_flashlight');
    expect(names('Turn on the flashlight').length).toBeLessThanOrEqual(8);
  });
  it('finds alarm and timer tools', () => {
    expect(names('set an alarm for 7am')).toContain('set_alarm');
    expect(names('start a 5 minute timer')).toContain('set_timer');
  });
  it('ranks a tool whose name matches above one that only mentions the word', () => {
    expect(names('open wifi settings')[0]).toBe('open_wifi_settings');
  });
  it('returns nothing for a request with no hints, so the planner offers every tool', () => {
    expect(names('the and for')).toEqual([]);
  });
  it('offers far fewer tools than the full list', () => {
    const h = makeHarness();
    const all = h.registry.list({ distribution: 'full' }).length;
    expect(all).toBeGreaterThan(30);
    expect(h.registry.relevant('Turn on the flashlight', 8, 'full').length).toBeLessThan(all / 3);
  });
});

describe('answering from remote tool results', () => {
  const { resolvePrompt } = require('../../src/agent/templating');

  it('caps how much of a tool result enters the prompt', () => {
    const out = resolvePrompt('see {{steps.s1.output}}', { s1: 'x'.repeat(5000) }, 100);
    expect(out).toContain('[truncated]');
    expect(out.length).toBeLessThan(400);
  });
  it('leaves short results whole and applies no cap when none is given', () => {
    expect(resolvePrompt('{{steps.s1.output}}', { s1: 'short' }, 100)).toContain('short');
    expect(resolvePrompt('{{steps.s1.output}}', { s1: 'y'.repeat(9000) })).not.toContain(
      'truncated',
    );
  });
});

describe('planner: remote tool calls get an answer step', () => {
  const { adaptMcpTool } = require('../../src/mcp/McpToolAdapter');

  it('adds a respond step that reads the tool output', async () => {
    const call = JSON.stringify([
      { name: 'mcp.hugging_face.hub_repo_details', arguments: { repo_ids: ['LiquidAI/LFM2'] } },
    ]);
    const h = makeHarness({ responder: () => ({ text: call }) });
    h.registry.register(
      adaptMcpTool(
        {
          server: { id: 'huggingface', name: 'Hugging Face', url: 'https://x' },
          callTool: jest.fn(),
        },
        {
          name: 'hub_repo_details',
          description: 'Get details for Hugging Face repositories',
          inputSchema: {
            type: 'object',
            properties: { repo_ids: { type: 'array', items: { type: 'string' } } },
          },
          annotations: { readOnlyHint: true },
        },
      ),
    );
    const out = await h.planner.plan(
      { text: 'Get details of the LFM2 repo on Hugging Face', source: 'chat' },
      { executionId: 'e' },
    );
    expect(out.kind).toBe('plan');
    if (out.kind !== 'plan') return;
    expect(out.plan.steps.map(s => s.kind)).toEqual(['tool', 'infer']);
    expect(out.plan.responseStep).toBe('s2');
    const infer = out.plan.steps[1];
    expect(infer.kind === 'infer' && infer.prompt).toContain('{{steps.s1.output.content}}');
    expect(infer.kind === 'infer' && infer.maxDataChars).toBeGreaterThan(0);
  });

  it('keeps device-only plans model-free', async () => {
    const h = makeHarness({
      responder: () => ({ text: JSON.stringify([{ name: 'turn_on_flashlight', arguments: {} }]) }),
    });
    const out = await h.planner.plan(
      { text: 'turn on the flashlight', source: 'chat' },
      { executionId: 'e' },
    );
    expect(out.kind === 'plan' && out.plan.steps.map(s => s.kind)).toEqual(['tool']);
  });
});

describe('planner: formatted remote results need no model step', () => {
  const { adaptMcpTool } = require('../../src/mcp/McpToolAdapter');

  it('answers a Hugging Face search directly', async () => {
    const call = JSON.stringify([
      { name: 'mcp.hugging_face.hub_repo_search', arguments: { query: 'LFM2' } },
    ]);
    const h = makeHarness({ responder: () => ({ text: call }) });
    h.registry.register(
      adaptMcpTool(
        {
          server: { id: 'huggingface', name: 'Hugging Face', url: 'https://x' },
          callTool: jest.fn(),
        },
        {
          name: 'hub_repo_search',
          description: 'Search Hugging Face repositories',
          inputSchema: { type: 'object', properties: { query: { type: 'string' } } },
          annotations: { readOnlyHint: true },
        },
      ),
    );
    const out = await h.planner.plan(
      { text: 'Search Hugging Face for LFM2 models', source: 'chat' },
      { executionId: 'e' },
    );
    expect(out.kind === 'plan' && out.plan.steps.map(s => s.kind)).toEqual(['tool']);
    expect(out.kind === 'plan' && out.plan.responseStep).toBeUndefined();
  });
});
