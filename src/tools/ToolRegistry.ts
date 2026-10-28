/**
 * Unified tool registry (PRD §7.1). Tools are registered once and rendered in
 * whichever schema a model needs: the google/mobile-actions dialect for the
 * fine-tuned action model, or JSON Schema for Cactus native tool calling and
 * remote providers. Execution is NOT exposed here — only via PermissionGateway.
 */
import type { InferenceTool } from '../inference/types';
import { toMobileActionsSchema } from './schema';
import type { AgentTool, Distribution } from './types';

// Words that appear in nearly every request and tool description and so say nothing about which
// tool is wanted.
const STOP_WORDS = new Set([
  'the',
  'and',
  'for',
  'with',
  'you',
  'your',
  'this',
  'that',
  'from',
  'into',
  'what',
  'how',
  'can',
  'please',
  'are',
  'was',
  'not',
  'has',
  'have',
  'about',
  'tell',
  'give',
  'just',
  'some',
  'would',
  'could',
  'should',
  'any',
  'all',
  'now',
  'out',
  'get',
]);

export class ToolRegistry {
  private tools = new Map<string, AgentTool>();
  private aliases = new Map<string, string>();

  register(tool: AgentTool): void {
    if (this.tools.has(tool.name)) throw new Error(`Tool already registered: ${tool.name}`);
    if (!/^[a-z][a-z0-9_.]*$/.test(tool.name)) throw new Error(`Invalid tool name: ${tool.name}`);
    this.tools.set(tool.name, tool as AgentTool);
    if (tool.legacyName) this.aliases.set(tool.legacyName, tool.name);
  }

  unregister(name: string): void {
    const t = this.tools.get(name);
    if (t?.legacyName) this.aliases.delete(t.legacyName);
    this.tools.delete(name);
  }

  /** Removes every tool whose name starts with prefix (e.g. an MCP server's tools). */
  unregisterPrefix(prefix: string): void {
    for (const name of [...this.tools.keys()]) if (name.startsWith(prefix)) this.unregister(name);
  }

  get(name: string): AgentTool | undefined {
    return this.tools.get(name) ?? this.tools.get(this.aliases.get(name) ?? '');
  }

  has(name: string): boolean {
    return !!this.get(name);
  }

  list(
    opts: { distribution?: Distribution; categories?: AgentTool['category'][] } = {},
  ): AgentTool[] {
    return [...this.tools.values()].filter(
      t =>
        (!opts.distribution || !t.distributions || t.distributions.includes(opts.distribution)) &&
        (!opts.categories || opts.categories.includes(t.category)),
    );
  }

  /** Keyword relevance so prompts carry a handful of tools, not all of them. */
  relevant(query: string, k: number, distribution?: Distribution): AgentTool[] {
    const words = new Set(
      query
        .toLowerCase()
        .split(/[^a-z0-9]+/)
        .filter(w => w.length > 2 && !STOP_WORDS.has(w)),
    );
    const scored = this.list({ distribution }).map(t => {
      const name = t.name.toLowerCase();
      const nameParts = new Set(name.split(/[^a-z0-9]+/));
      const desc = ` ${t.description.toLowerCase()} `;
      let score = 0;
      for (const w of words) {
        if (nameParts.has(w)) score += 4;
        else if (name.includes(w)) score += 2;
        else if (desc.includes(` ${w} `) || desc.includes(` ${w}s `)) score += 2;
        else if (desc.includes(w)) score += 1;
      }
      return { t, score };
    });
    // A tool needs at least half the best score: a clear match ("flashlight" in its name) leaves
    // out tools that only share a fragment of a word ("turn" in "returns"). A small model offered
    // those as well sometimes answered in prose instead of calling the tool that was asked for.
    const best = Math.max(0, ...scored.map(s => s.score));
    return scored
      .filter(s => s.score > 0 && s.score * 2 >= best)
      .sort((a, b) => b.score - a.score)
      .slice(0, k)
      .map(s => s.t);
  }

  /** Rendering for the fine-tuned mobile-actions model's system prompt. */
  toMobileActions(
    tools: AgentTool[],
  ): { function: { name: string; description: string; parameters: unknown } }[] {
    return tools.map(t => ({
      function: {
        name: t.legacyName ?? t.name,
        description: t.description,
        parameters: toMobileActionsSchema(t.inputSchema),
      },
    }));
  }

  /** Rendering for Cactus native tools / remote function calling. */
  toInferenceTools(tools: AgentTool[]): InferenceTool[] {
    return tools.map(t => ({
      name: t.name,
      description: t.description,
      parameters: t.inputSchema,
    }));
  }

  /** Compact catalog for planner prompts. */
  catalog(tools: AgentTool[]): string {
    return tools
      .map(t => {
        const props = t.inputSchema.properties ?? {};
        const req = new Set(t.inputSchema.required ?? []);
        const args = Object.entries(props)
          .map(
            ([k, v]) =>
              `${k}${req.has(k) ? '' : '?'}: ${v.type ?? 'any'}${v.enum ? ` (${v.enum.join('|')})` : ''}`,
          )
          .join(', ');
        return `- ${t.name}(${args}) — ${t.description} [${t.riskLevel}]`;
      })
      .join('\n');
  }
}
