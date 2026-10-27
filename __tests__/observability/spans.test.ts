import { trace } from '@opentelemetry/api';
import {
  BasicTracerProvider,
  InMemorySpanExporter,
  SimpleSpanProcessor,
} from '@opentelemetry/sdk-trace-base';

import {
  executionContext,
  setContentCapture,
  traceAgentRun,
  traceTool,
} from '../../src/observability/spans';
import { VectorStore } from '../../src/services/VectorStore';

const exporter = new InMemorySpanExporter();
trace.setGlobalTracerProvider(
  new BasicTracerProvider({ spanProcessors: [new SimpleSpanProcessor(exporter)] }),
);

const spans = () => exporter.getFinishedSpans();
beforeEach(() => {
  exporter.reset();
  setContentCapture(false);
});

describe('LiquidChat spans', () => {
  it('nests tool calls under their agent run, and tags MCP tools', async () => {
    await traceAgentRun('exe_1', { text: 'search hf', source: 'chat' }, async () => {
      expect(executionContext('exe_1')).toBeDefined();
      await traceTool(
        'mcp.hf.hub_repo_search',
        { executionId: 'exe_1', callId: 'c1', mcpServer: 'hf' },
        { query: 'LFM2' },
        async () => ({ success: true }),
      );
      return { state: 'COMPLETED', response: 'Found 5' };
    });
    const tool = spans().find(s => s.name === 'execute_tool mcp.hf.hub_repo_search')!;
    const run = spans().find(s => s.name === 'invoke_agent liquidchat')!;
    expect(tool.parentSpanContext?.spanId).toBe(run.spanContext().spanId);
    expect(tool.attributes).toMatchObject({
      'gen_ai.operation.name': 'execute_tool',
      'gen_ai.tool.type': 'extension',
      'mcp.server.name': 'hf',
      'mcp.method.name': 'tools/call',
    });
    expect(run.attributes['liquidchat.execution.state']).toBe('COMPLETED');
    expect(executionContext('exe_1')).toBeUndefined();
  });

  it('attaches arguments, results and messages only with content capture on', async () => {
    const run = (task: string) =>
      traceAgentRun('exe_2', { text: task, source: 'chat', skillName: 'end-of-day' }, async () => {
        await traceTool('tasks.list', { executionId: 'exe_2' }, { filter: 'open' }, async () => ({
          success: true,
        }));
        return { state: 'COMPLETED', response: 'Two open tasks' };
      });
    await run('private task');
    expect(JSON.stringify(spans().map(s => s.attributes))).not.toMatch(
      /private task|Two open tasks|filter/,
    );
    exporter.reset();
    setContentCapture(true);
    await run('private task');
    const tool = spans().find(s => s.name === 'execute_tool tasks.list')!;
    const agent = spans().find(s => s.name === 'invoke_agent skill:end-of-day')!;
    expect(tool.attributes['gen_ai.tool.call.arguments']).toBe('{"filter":"open"}');
    expect(agent.attributes['gen_ai.input.messages']).toBe('private task');
    expect(agent.attributes['gen_ai.output.messages']).toBe('Two open tasks');
  });

  it('records failed tools as errors', async () => {
    await traceTool('send_email', {}, {}, async () => ({
      success: false,
      error: { code: 'USER_DENIED' },
    }));
    expect(spans()[0].attributes['error.type']).toBe('USER_DENIED');
    expect(spans()[0].status.code).toBe(2);
  });

  it('traces vector store queries with similarity scores', async () => {
    const store = new VectorStore('span_test');
    await store.add('a', 'alpha', [1, 0, 0]);
    await store.add('b', 'beta', [0.6, 0.8, 0]);
    await store.query([1, 0, 0], 2);
    const q = spans().find(s => s.name === 'query span_test')!;
    expect(q.attributes).toMatchObject({
      'db.operation.name': 'query',
      'db.collection.name': 'span_test',
      'db.vector.query.top_k': 2,
      'db.response.returned_rows': 2,
      'rag.result.score_max': 1,
    });
    expect(q.attributes['rag.result.score_margin']).toBeCloseTo(0.4);
  });
});
