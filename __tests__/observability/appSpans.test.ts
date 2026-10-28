/**
 * What LiquidChat's own components put on their spans, through the SDK's helpers and a real
 * instrument() (no network: export goes to a stub fetch, spans to an in-memory exporter).
 */
import { context, metrics, trace } from '@opentelemetry/api';
import { InMemorySpanExporter, SimpleSpanProcessor } from '@opentelemetry/sdk-trace-base';
import { instrument, uninstrument } from '@traceverse/genai-otel-instrument-node/react-native';

import { VectorStore } from '../../src/services/VectorStore';

// A new exporter per test: uninstrument() shuts down the one it was given.
let exporter = new InMemorySpanExporter();

function start(enableContentCapture: boolean) {
  exporter = new InMemorySpanExporter();
  instrument({
    serviceName: 'liquidchat-test',
    endpoint: 'https://collector.example',
    fetch: (async () => ({ ok: true, status: 200 })) as unknown as typeof fetch,
    spanProcessors: [new SimpleSpanProcessor(exporter)],
    enableContentCapture,
    contentMaxLength: 8000,
  });
}

afterEach(async () => {
  await uninstrument(0.2);
  trace.disable();
  metrics.disable();
  context.disable();
});

const span = (name: string) => exporter.getFinishedSpans().find(s => s.name === name)!;

describe('vector RAG search', () => {
  async function store() {
    const s = new VectorStore('documents_test');
    await s.add('c1', 'Refunds are accepted within 30 days.', [1, 0, 0], {
      sourceFile: 'policy.md',
      chunkIndex: 4,
    });
    await s.add('c2', 'Shipping takes 3 to 5 days.', [0.6, 0.8, 0], {
      sourceFile: 'policy.md',
      chunkIndex: 7,
    });
    return s;
  }

  it('records every chunk returned, in rank order, with its similarity, document and position', async () => {
    start(true);
    await (await store()).query([1, 0, 0], 2, 0, 'refund window');
    expect(span('retrieve documents_test').attributes).toMatchObject({
      'openinference.span.kind': 'RETRIEVER',
      'db.collection.name': 'documents_test',
      'db.vector.query.top_k': 2,
      'db.response.returned_rows': 2,
      'rag.result.score_max': 1,
      'retrieval.query': 'refund window',
      'retrieval.documents.0.document.id': 'c1',
      'retrieval.documents.0.document.score': 1,
      'retrieval.documents.0.document.content': 'Refunds are accepted within 30 days.',
      'retrieval.documents.0.document.metadata.source': 'policy.md',
      'retrieval.documents.0.document.metadata.chunk': '4',
      'retrieval.documents.1.document.id': 'c2',
      'retrieval.documents.1.document.content': 'Shipping takes 3 to 5 days.',
      'retrieval.documents.1.document.metadata.chunk': '7',
    });
    expect(span('retrieve documents_test').attributes['rag.result.score_margin']).toBeCloseTo(0.4);
  });

  it('without content capture: ids and scores only, no query, chunk text or file names', async () => {
    start(false);
    await (await store()).query([1, 0, 0], 2, 0, 'refund window');
    const attributes = span('retrieve documents_test').attributes;
    expect(attributes).toMatchObject({
      'retrieval.documents.0.document.id': 'c1',
      'retrieval.documents.0.document.score': 1,
    });
    expect(
      Object.keys(attributes).filter(
        k => k === 'retrieval.query' || k.endsWith('.content') || k.includes('.metadata.'),
      ),
    ).toEqual([]);
  });
});
