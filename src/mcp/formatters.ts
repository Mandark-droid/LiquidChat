/**
 * Plain, deterministic renderings of known MCP results. A 1.2B on-device model rewrites a search
 * listing slowly and inaccurately (it invents descriptions); a list we can parse needs no model.
 */

function field(block: string, label: string): string | undefined {
  const m = new RegExp(`\\*\\*${label}:\\*\\*\\s*([^|\\n]+)`).exec(block);
  return m?.[1]?.trim() || undefined;
}

/** Hugging Face `hub_repo_search`: "### owner/name" blocks with Task / Downloads / Likes lines. */
function formatHubSearch(text: string): string | null {
  const blocks = text.split(/\n### /).slice(1);
  if (!blocks.length) return null;
  const rows = blocks.map(block => {
    const name = block.split('\n')[0].trim();
    const downloads = field(block, 'Downloads');
    const likes = field(block, 'Likes');
    const parts = [
      field(block, 'Task'),
      downloads && `${downloads} downloads`,
      likes && `${likes} likes`,
    ].filter(Boolean);
    return `• ${name}${parts.length ? ` — ${parts.join(' · ')}` : ''}`;
  });
  const head = text.split('\n')[0].trim();
  return [head, ...rows].join(String.fromCharCode(10));
}

const FORMATTERS: Record<string, (text: string) => string | null> = {
  'huggingface/hub_repo_search': formatHubSearch,
};

/** Formatted text for a known server tool, or null when the model should write the answer. */
export function formatMcpResult(serverId: string, toolName: string, text: string): string | null {
  try {
    return FORMATTERS[`${serverId}/${toolName}`]?.(text) ?? null;
  } catch {
    return null;
  }
}

export function hasMcpFormatter(serverId: string, toolName: string): boolean {
  return `${serverId}/${toolName}` in FORMATTERS;
}
