import {
  BasicTracerProvider,
  InMemorySpanExporter,
  SimpleSpanProcessor,
} from '@opentelemetry/sdk-trace-base';

import {
  openInferenceKind,
  OpenInferenceSpanProcessor,
} from '../../src/observability/openinference';

describe('OpenInference attributes for Arize', () => {
  it('maps GenAI operations and span names to span kinds', () => {
    expect(openInferenceKind('invoke_agent liquidchat', {})).toBe('AGENT');
    expect(openInferenceKind('execute_tool flashlight', {})).toBe('TOOL');
    expect(openInferenceKind('cactus.complete', { 'gen_ai.operation.name': 'chat' })).toBe('LLM');
    expect(
      openInferenceKind('cactus.stt.transcribe', { 'gen_ai.operation.name': 'speech_to_text' }),
    ).toBe('LLM');
    expect(openInferenceKind('cactus.embed', { 'gen_ai.operation.name': 'embeddings' })).toBe(
      'EMBEDDING',
    );
    expect(openInferenceKind('retrieve memory', {})).toBe('RETRIEVER');
    expect(openInferenceKind('query documents', {})).toBe('RETRIEVER');
    expect(openInferenceKind('meeting.process', {})).toBe('CHAIN');
    expect(openInferenceKind('cactus.stt.init', { 'gen_ai.operation.name': 'load_model' })).toBe(
      'CHAIN',
    );
  });

  it('adds them to the exported span, after its attributes are final', () => {
    const exporter = new InMemorySpanExporter();
    // The app's order: the OpenInference processor, then the exporting one.
    const provider = new BasicTracerProvider({
      spanProcessors: [new OpenInferenceSpanProcessor(), new SimpleSpanProcessor(exporter)],
    });
    const span = provider.getTracer('t').startSpan('cactus.complete', {
      attributes: { 'gen_ai.operation.name': 'chat', 'gen_ai.request.model': 'lfm2.5-350m' },
    });
    span.setAttribute('gen_ai.usage.input_tokens', 120);
    span.setAttribute('gen_ai.usage.output_tokens', 30);
    span.setAttribute('gen_ai.response', 'Hello!');
    span.end();

    const [exported] = exporter.getFinishedSpans();
    expect(exported.attributes).toMatchObject({
      'openinference.span.kind': 'LLM',
      'llm.model_name': 'lfm2.5-350m',
      'llm.token_count.prompt': 120,
      'llm.token_count.completion': 30,
      'llm.token_count.total': 150,
      'output.value': 'Hello!',
      'gen_ai.operation.name': 'chat',
    });
  });
});
