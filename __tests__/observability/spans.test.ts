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

  it('records the retrieved documents in rank order; their text and source only with content capture', async () => {
    const store = new VectorStore('docs_test');
    await store.add('a', 'Prefers meetings at 11 am', [1, 0, 0], { sourceFile: 'notes.md' });
    await store.add('b', 'Asked about LiteLLM', [0.6, 0.8, 0]);

    await store.query([1, 0, 0], 2);
    const bare = spans().find(s => s.name === 'query docs_test')!.attributes;
    expect(bare).toMatchObject({
      'retrieval.documents.0.document.id': 'a',
      'retrieval.documents.0.document.score': 1,
      'retrieval.documents.1.document.id': 'b',
      'retrieval.document_count': 2,
    });
    expect(Object.keys(bare).some(k => k.endsWith('.content') || k.includes('.metadata.'))).toBe(
      false,
    );

    exporter.reset();
    setContentCapture(true);
    await store.query([1, 0, 0], 2);
    expect(spans().find(s => s.name === 'query docs_test')!.attributes).toMatchObject({
      'retrieval.documents.0.document.content': 'Prefers meetings at 11 am',
      'retrieval.documents.0.document.metadata.source': 'notes.md',
      'retrieval.documents.1.document.content': 'Asked about LiteLLM',
    });
  });

  it('puts the tool description on tool spans', async () => {
    await traceTool(
      'set_alarm',
      { description: 'Sets an alarm at a given time.' },
      {},
      async () => ({ success: true }),
    );
    expect(spans().find(s => s.name === 'execute_tool set_alarm')!.attributes).toMatchObject({
      'gen_ai.tool.description': 'Sets an alarm at a given time.',
    });
  });
});

describe('errors and content capture', () => {
  it('keeps error messages out of spans unless content capture is on', async () => {
    const { withSpan } = require('../../src/observability/spans');
    const fail = () =>
      withSpan('x', {}, async () => {
        throw new TypeError('secret transcript text');
      }).catch(() => undefined);
    await fail();
    const s = spans()[0];
    expect(s.attributes['error.type']).toBe('TypeError');
    expect(JSON.stringify([s.attributes, s.status, s.events])).not.toMatch(/secret transcript/);
    exporter.reset();
    setContentCapture(true);
    await fail();
    expect(spans()[0].status.message).toBe('secret transcript text');
  });
});
