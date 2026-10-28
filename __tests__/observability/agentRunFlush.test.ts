const mockFlush = jest.fn(async () => true);
jest.mock('@traceverse/genai-otel-instrument-node/react-native', () => ({
  ...jest.requireActual('@traceverse/genai-otel-instrument-node/react-native'),
  isInstrumented: () => true,
  flushTelemetry: (...args: unknown[]) => mockFlush(...(args as [])),
}));

import { traceAgentRun } from '../../src/observability/spans';

describe('agent run export', () => {
  beforeEach(() => mockFlush.mockClear());

  it('sends the trace as soon as the run ends, so it leaves the phone whole', async () => {
    await traceAgentRun('exe_1', { text: 'Set an alarm for 7 am', source: 'chat' }, async () => ({
      state: 'COMPLETED',
    }));
    await new Promise(resolve => setImmediate(resolve));
    expect(mockFlush).toHaveBeenCalledTimes(1);
  });

  it('also after a run that failed', async () => {
    await expect(
      traceAgentRun('exe_2', { text: 'x', source: 'chat' }, async () => {
        throw new Error('boom');
      }),
    ).rejects.toThrow('boom');
    await new Promise(resolve => setImmediate(resolve));
    expect(mockFlush).toHaveBeenCalledTimes(1);
  });
});
