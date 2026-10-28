/**
 * OpenInference attributes alongside the OpenTelemetry GenAI ones. Arize (and Phoenix) classify a
 * span by `openinference.span.kind` and read the model, tokens and input/output from `llm.*`,
 * `input.value` and `output.value`; without them every span shows as kind "unknown". The GenAI
 * attributes stay as they are, so other backends see no difference.
 */
import type { Context } from '@opentelemetry/api';
import type { ReadableSpan, Span, SpanProcessor } from '@opentelemetry/sdk-trace-base';

type Attrs = Record<string, unknown>;

/** OpenInference span kind for a span, from its GenAI operation or its name. */
export function openInferenceKind(name: string, a: Attrs): string {
  const op = String(a['gen_ai.operation.name'] ?? '');
  if (op === 'invoke_agent' || name.startsWith('invoke_agent')) return 'AGENT';
  if (op === 'execute_tool' || name.startsWith('execute_tool')) return 'TOOL';
  if (op === 'embeddings' || name === 'cactus.embed') return 'EMBEDDING';
  if (name.startsWith('retrieve') || name.startsWith('query ')) return 'RETRIEVER';
  if (['chat', 'text_completion', 'generate_content', 'speech_to_text'].includes(op)) return 'LLM';
  if (name === 'cactus.complete' || name === 'cactus.stt.transcribe') return 'LLM';
  return 'CHAIN';
}

const first = (a: Attrs, keys: string[]) => keys.map(k => a[k]).find(v => v !== undefined);

/** The OpenInference attributes to add; existing ones are kept. */
export function openInferenceAttributes(name: string, a: Attrs): Attrs {
  const out: Attrs = {};
  const set = (k: string, v: unknown) => {
    if (v !== undefined && v !== null && v !== '' && a[k] === undefined) out[k] = v;
  };
  const kind = openInferenceKind(name, a);
  set('openinference.span.kind', kind);
  set('input.value', first(a, ['gen_ai.input.messages', 'gen_ai.request.first_message']));
  set(
    'output.value',
    first(a, ['gen_ai.output.messages', 'gen_ai.response', 'gen_ai.tool.call.result']),
  );
  if (kind === 'LLM' || kind === 'EMBEDDING') {
    set('llm.model_name', first(a, ['gen_ai.response.model', 'gen_ai.request.model']));
    set('llm.provider', a['gen_ai.provider.name'] ?? a['gen_ai.system']);
    const prompt = first(a, ['gen_ai.usage.input_tokens', 'gen_ai.usage.prompt_tokens']);
    const completion = first(a, ['gen_ai.usage.output_tokens', 'gen_ai.usage.completion_tokens']);
    set('llm.token_count.prompt', prompt);
    set('llm.token_count.completion', completion);
    if (typeof prompt === 'number' && typeof completion === 'number')
      set('llm.token_count.total', prompt + completion);
  }
  if (kind === 'TOOL') {
    set('tool.name', a['gen_ai.tool.name']);
    set('tool.parameters', a['gen_ai.tool.call.arguments']);
  }
  if (kind === 'EMBEDDING')
    set('embedding.model_name', first(a, ['gen_ai.response.model', 'gen_ai.request.model']));
  return out;
}

/**
 * Adds the OpenInference attributes when a span ends. It runs before the exporting processor
 * (the SDK places extra processors first), so the exported span carries them; the span is ended
 * by then, so they are written to its attribute map directly.
 */
export class OpenInferenceSpanProcessor implements SpanProcessor {
  onStart(_span: Span, _ctx: Context): void {}

  onEnd(span: ReadableSpan): void {
    try {
      Object.assign(span.attributes, openInferenceAttributes(span.name, span.attributes));
    } catch {
      // Frozen attributes in some SDK version: leave the span as it is.
    }
  }

  forceFlush(): Promise<void> {
    return Promise.resolve();
  }

  shutdown(): Promise<void> {
    return Promise.resolve();
  }
}
