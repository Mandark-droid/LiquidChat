/**
 * App-level OpenTelemetry spans (agent runs, skills, tool and MCP calls, retrieval, the vector
 * store, LiquidChat Space calls, the meeting pipeline), following the OpenTelemetry GenAI
 * semantic conventions. @traceverse/genai-otel-instrument-node registers the tracer provider when export is
 * on; until then every call here is a no-op. React Native has no async context manager, so a
 * parent is passed explicitly (agent runs are looked up by execution id).
 *
 * Message text, tool arguments and results and transcripts are attached only when the user turned
 * on "Include prompts and replies".
 */
import {
  type Attributes,
  type Context,
  context,
  type Span,
  SpanStatusCode,
  trace,
} from '@opentelemetry/api';

const TRACER = 'liquidchat';
const MAX_CONTENT = 8000;

let captureContent = false;
/** Set by otelExport from the user's setting. */
export function setContentCapture(on: boolean): void {
  captureContent = on;
}

const executions = new Map<string, Context>();

/** The agent run's context, so its tool calls and model calls become its children. */
export function executionContext(executionId?: string): Context | undefined {
  return executionId ? executions.get(executionId) : undefined;
}

type Attr = string | number | boolean | undefined | null;

function clean(attrs: Record<string, Attr>): Attributes {
  const out: Attributes = {};
  for (const [k, v] of Object.entries(attrs)) if (v !== undefined && v !== null) out[k] = v;
  return out;
}

/** Attaches text only when content capture is on. */
export function setContent(span: Span, key: string, value: unknown): void {
  if (!captureContent || value === undefined || value === null) return;
  const s = typeof value === 'string' ? value : JSON.stringify(value);
  span.setAttribute(key, s.length > MAX_CONTENT ? `${s.slice(0, MAX_CONTENT)}…` : s);
}

/** Runs `fn` inside a span; errors are recorded and rethrown. */
export async function withSpan<T>(
  name: string,
  attrs: Record<string, Attr>,
  fn: (span: Span) => Promise<T>,
  parent?: Context,
): Promise<T> {
  const outer = parent ?? context.active();
  const span = trace.getTracer(TRACER).startSpan(name, { attributes: clean(attrs) }, outer);
  // Active for everything fn awaits, so the SDK's model-call spans (a Cactus completion or
  // transcription) become children of this span rather than traces of their own.
  return context.with(trace.setSpan(outer, span), () => runInSpan(span, fn));
}

async function runInSpan<T>(span: Span, fn: (span: Span) => Promise<T>): Promise<T> {
  try {
    const result = await fn(span);
    return result;
  } catch (e) {
    // The error's type always; its message (which may quote content) only with content capture.
    const type = e instanceof Error ? e.name : typeof e;
    span.setAttribute('error.type', type);
    if (captureContent) {
      span.recordException(e instanceof Error ? e : new Error(String(e)));
      span.setStatus({
        code: SpanStatusCode.ERROR,
        message: e instanceof Error ? e.message : String(e),
      });
    } else {
      span.setStatus({ code: SpanStatusCode.ERROR, message: type });
    }
    throw e;
  } finally {
    span.end();
  }
}

/** One agent run (chat request, routine or skill): the root of its steps' spans. */
export async function traceAgentRun<
  T extends { state: string; response?: string; error?: { code?: string } },
>(
  executionId: string,
  request: { text: string; source: string; skillName?: string },
  fn: () => Promise<T>,
): Promise<T> {
  const agent = request.skillName ? `skill:${request.skillName}` : 'liquidchat';
  return withSpan(
    `invoke_agent ${agent}`,
    {
      'gen_ai.operation.name': 'invoke_agent',
      'gen_ai.agent.name': agent,
      'gen_ai.agent.id': executionId,
      'gen_ai.conversation.id': executionId,
      'liquidchat.request.source': request.source,
      'liquidchat.skill.name': request.skillName,
    },
    async span => {
      executions.set(executionId, trace.setSpan(context.active(), span));
      try {
        setContent(span, 'gen_ai.input.messages', request.text);
        const r = await fn();
        span.setAttribute('liquidchat.execution.state', r.state);
        if (r.error?.code) span.setAttribute('error.type', r.error.code);
        if (r.state === 'FAILED')
          span.setStatus({ code: SpanStatusCode.ERROR, message: r.error?.code });
        setContent(span, 'gen_ai.output.messages', r.response);
        return r;
      } finally {
        executions.delete(executionId);
      }
    },
  );
}

/** One tool call through the permission gateway (MCP tools included). */
export function traceTool<T extends { success: boolean; error?: { code?: string } }>(
  tool: string,
  info: { executionId?: string; callId?: string; risk?: string; mcpServer?: string },
  args: unknown,
  fn: () => Promise<T>,
): Promise<T> {
  return withSpan(
    `execute_tool ${tool}`,
    {
      'gen_ai.operation.name': 'execute_tool',
      'gen_ai.tool.name': tool,
      'gen_ai.tool.type': info.mcpServer ? 'extension' : 'function',
      'gen_ai.tool.call.id': info.callId,
      'liquidchat.tool.risk': info.risk,
      'mcp.server.name': info.mcpServer,
      'mcp.method.name': info.mcpServer ? 'tools/call' : undefined,
    },
    async span => {
      setContent(span, 'gen_ai.tool.call.arguments', args);
      const r = await fn();
      span.setAttribute('liquidchat.tool.success', r.success);
      if (!r.success) {
        span.setAttribute('error.type', r.error?.code ?? 'tool_error');
        span.setStatus({ code: SpanStatusCode.ERROR, message: r.error?.code });
      }
      setContent(span, 'gen_ai.tool.call.result', r);
      return r;
    },
    executionContext(info.executionId),
  );
}

/** Similarity scores of a search, under the names genai-otel-instrument uses for vector stores. */
export function recordScores(span: Span, scores: number[]): void {
  span.setAttribute('db.response.returned_rows', scores.length);
  if (!scores.length) return;
  const ordered = [...scores].sort((a, b) => b - a);
  span.setAttribute('rag.result.score_max', ordered[0]);
  span.setAttribute('rag.result.score_min', ordered[ordered.length - 1]);
  span.setAttribute('rag.result.score_mean', scores.reduce((a, b) => a + b, 0) / scores.length);
  if (ordered.length > 1) span.setAttribute('rag.result.score_margin', ordered[0] - ordered[1]);
}
