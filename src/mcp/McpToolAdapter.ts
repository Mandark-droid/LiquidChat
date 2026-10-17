/**
 * Exposes MCP tools as AgentTools. MCP output is UNTRUSTED: it is returned as
 * `{ untrusted: true, server, content }` so the runtime treats it as data and
 * never as instructions. Risk comes from the server's annotations, which are
 * themselves hints — unannotated tools default to 'reversible' (approval rules
 * of the PermissionGateway still apply), destructive ones to 'sensitive'.
 */
import type { AgentTool, JsonSchema, RiskLevel, ToolContext, ToolOutcome } from '../tools/types';
import { toolError } from '../tools/types';
import {
  type McpClient,
  type McpContent,
  McpError,
  type McpServerRef,
  type McpTool,
} from './McpClient';

export const MCP_MAX_OUTPUT_CHARS = 8000;

export interface McpToolOutput {
  untrusted: true;
  server: string;
  content: string;
  truncated?: boolean;
  structuredContent?: unknown;
}

export function sanitizeName(s: string): string {
  return s
    .toLowerCase()
    .replace(/[^a-z0-9_.]+/g, '_')
    .replace(/_+/g, '_')
    .replace(/^[_.]+|[_.]+$/g, '');
}

export function mcpToolName(serverName: string, toolName: string): string {
  return `mcp.${sanitizeName(serverName) || 'server'}.${sanitizeName(toolName) || 'tool'}`;
}

export function riskFor(tool: McpTool): RiskLevel {
  const a = tool.annotations ?? {};
  // Per the MCP spec destructiveHint is only meaningful when readOnlyHint is false.
  if (a.readOnlyHint === true) return 'read_only';
  if (a.destructiveHint === true) return 'sensitive';
  return 'reversible';
}

function contentToText(parts: McpContent[]): string {
  return parts
    .map(p => {
      if (p.type === 'text' && typeof p.text === 'string') return p.text;
      if (p.type === 'resource' && typeof p.resource?.text === 'string') return p.resource.text;
      if (p.type === 'resource_link') return `[resource: ${p.name ?? ''} ${p.uri ?? ''}]`.trim();
      if (p.type === 'image' || p.type === 'audio') return `[${p.type}: ${p.mimeType ?? 'binary'}]`;
      return '';
    })
    .filter(Boolean)
    .join('\n');
}

export interface McpToolAdapterOptions {
  maxOutputChars?: number;
}

export function adaptMcpTool(
  client: Pick<McpClient, 'callTool'> & { server: McpServerRef },
  tool: McpTool,
  opts: McpToolAdapterOptions = {},
): AgentTool {
  const server = client.server;
  const max = opts.maxOutputChars ?? MCP_MAX_OUTPUT_CHARS;
  const desc = (tool.description ?? tool.title ?? tool.annotations?.title ?? tool.name).slice(
    0,
    1000,
  );
  const inputSchema = (
    tool.inputSchema && typeof tool.inputSchema === 'object'
      ? tool.inputSchema
      : { type: 'object', properties: {} }
  ) as JsonSchema;
  return {
    name: mcpToolName(server.name, tool.name),
    description: `[MCP: ${server.name}] ${desc}`,
    category: 'mcp',
    inputSchema,
    requiredPermissions: ['special:network'],
    riskLevel: riskFor(tool),
    idempotent: !!tool.annotations?.idempotentHint,
    describeCall: args => `${server.name} → ${tool.name}(${JSON.stringify(args).slice(0, 120)})`,
    async execute(args: Record<string, unknown>, ctx: ToolContext): Promise<ToolOutcome> {
      const ctrl = new AbortController();
      const off = ctx.cancel.onCancel(() => ctrl.abort());
      try {
        if (ctx.cancel.cancelled) return toolError('CANCELLED', 'Cancelled', true);
        const res = await client.callTool(tool.name, args, ctrl.signal);
        const full = contentToText(res.content);
        const truncated = full.length > max;
        const content = truncated ? full.slice(0, max) : full;
        if (res.isError)
          return toolError(
            'MCP_TOOL_ERROR',
            `${server.name}/${tool.name} reported an error: ${content.slice(0, 500) || 'no details'}`,
            true,
          );
        const data: McpToolOutput = { untrusted: true, server: server.name, content };
        if (truncated) data.truncated = true;
        if (res.structuredContent !== undefined) data.structuredContent = res.structuredContent;
        return {
          success: true,
          data,
          display: `${server.name}: ${tool.name} returned ${content.length} chars`,
        };
      } catch (e) {
        if (ctx.cancel.cancelled) return toolError('CANCELLED', 'Cancelled', true);
        if (e instanceof McpError) {
          const code =
            e.kind === 'auth'
              ? 'MCP_AUTH'
              : e.kind === 'timeout'
                ? 'MCP_TIMEOUT'
                : e.kind === 'rpc'
                  ? 'MCP_RPC_ERROR'
                  : 'MCP_UNAVAILABLE';
          return toolError(code, e.message, e.retryable);
        }
        return toolError('MCP_UNAVAILABLE', (e as Error).message ?? String(e), true);
      } finally {
        off();
      }
    },
  };
}

/** Adapts all tools from one server; duplicate sanitized names get a numeric suffix. */
export function adaptMcpTools(
  client: Pick<McpClient, 'callTool'> & { server: McpServerRef },
  tools: McpTool[],
  opts: McpToolAdapterOptions = {},
): AgentTool[] {
  const seen = new Map<string, number>();
  return tools.map(t => {
    const tool = adaptMcpTool(client, t, opts);
    const n = seen.get(tool.name) ?? 0;
    seen.set(tool.name, n + 1);
    if (n > 0) tool.name = `${tool.name}_${n + 1}`;
    return tool;
  });
}

/** Connects, lists tools, caches them via the store callback and returns AgentTools. */
export async function discoverMcpTools(
  client: McpClient,
  cache?: (tools: McpTool[]) => Promise<void>,
  signal?: AbortSignal,
): Promise<AgentTool[]> {
  const tools = await client.listTools(signal);
  if (cache) await cache(tools);
  return adaptMcpTools(client, tools);
}
