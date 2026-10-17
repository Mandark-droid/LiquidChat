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
