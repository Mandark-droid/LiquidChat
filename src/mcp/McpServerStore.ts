/**
 * CRUD over the mcp_servers table. The discovered tool list is cached in
 * tools_json so tools can be registered at startup without a network round trip.
 * Bearer tokens are NOT stored here — they live in the CredentialStore (`mcp:<id>`).
 */
import type { CredentialStore } from '../platform/types';
import { fromJson, getDatabase, type Row, type SqlDb, toJson } from '../storage/db';
import { isLocalHost } from '../utils/net';
import type { McpTool } from './McpClient';

export interface McpServerRecord {
  id: string;
  name: string;
  url: string;
  enabled: boolean;
  tools?: McpTool[];
  createdAt: number;
}

export const mcpTokenKey = (serverId: string): string => `mcp:${serverId}`;

function rowToRecord(r: Row): McpServerRecord {
  return {
    id: String(r.id),
    name: String(r.name),
    url: String(r.url),
    enabled: Number(r.enabled) === 1,
    tools: fromJson<McpTool[]>(r.tools_json),
    createdAt: Number(r.created_at),
  };
}

export function validateServerUrl(url: string): void {
  // Regex rather than `new URL()`: React Native's URL polyfill lacks hostname/protocol.
  const m = /^(https?):\/\/(?:[^@/?#\s]*@)?(\[[^\]]+\]|[^:/?#\s]+)(?::\d+)?(?:[/?#]\S*)?$/i.exec(
    url.trim(),
  );
  if (!m) throw new Error(`Invalid MCP server URL: ${url}`);
  const protocol = m[1].toLowerCase();
  const host = m[2].toLowerCase();
  const local = isLocalHost(host);
  if (protocol !== 'https' && !(protocol === 'http' && local))
    throw new Error('MCP servers must use https (http is only allowed for local addresses)');
}

export class McpServerStore {
  constructor(
    private readonly db: () => Promise<SqlDb> = () => getDatabase(),
    private readonly now: () => number = Date.now,
    private readonly credentials?: CredentialStore,
  ) {}

  async list(opts: { enabledOnly?: boolean } = {}): Promise<McpServerRecord[]> {
    const db = await this.db();
    const r = await db.execute(
      `SELECT * FROM mcp_servers ${opts.enabledOnly ? 'WHERE enabled = 1' : ''} ORDER BY created_at, id`,
    );
    return r.rows.map(rowToRecord);
  }

  async get(id: string): Promise<McpServerRecord | undefined> {
    const db = await this.db();
    const r = await db.execute('SELECT * FROM mcp_servers WHERE id = ?', [id]);
    return r.rows[0] ? rowToRecord(r.rows[0]) : undefined;
  }

  async add(input: {
    id?: string;
    name: string;
    url: string;
    enabled?: boolean;
    token?: string;
  }): Promise<McpServerRecord> {
    validateServerUrl(input.url);
    const name = input.name.trim();
    if (!name) throw new Error('MCP server name is required');
    const id =
      input.id ?? `mcp_${this.now().toString(36)}_${Math.random().toString(36).slice(2, 8)}`;
    const db = await this.db();
    await db.execute(
      'INSERT INTO mcp_servers (id, name, url, enabled, tools_json, created_at) VALUES (?, ?, ?, ?, NULL, ?)',
      [id, name, input.url, input.enabled === false ? 0 : 1, this.now()],
    );
    if (input.token && this.credentials) await this.credentials.set(mcpTokenKey(id), input.token);
    return (await this.get(id))!;
  }

  async update(
    id: string,
    patch: Partial<Pick<McpServerRecord, 'name' | 'url' | 'enabled'>>,
  ): Promise<McpServerRecord | undefined> {
    const cur = await this.get(id);
    if (!cur) return undefined;
    const next = { ...cur, ...patch };
    if (patch.url !== undefined) validateServerUrl(next.url);
    const db = await this.db();
    // A URL change invalidates the cached tool list.
    const urlChanged = next.url !== cur.url;
    await db.execute(
      `UPDATE mcp_servers SET name = ?, url = ?, enabled = ?${urlChanged ? ', tools_json = NULL' : ''} WHERE id = ?`,
      [next.name, next.url, next.enabled ? 1 : 0, id],
    );
    return this.get(id);
  }

  async setTools(id: string, tools: McpTool[]): Promise<void> {
    const db = await this.db();
    await db.execute('UPDATE mcp_servers SET tools_json = ? WHERE id = ?', [toJson(tools), id]);
  }

  async remove(id: string): Promise<void> {
    const db = await this.db();
    await db.execute('DELETE FROM mcp_servers WHERE id = ?', [id]);
    if (this.credentials) await this.credentials.delete(mcpTokenKey(id));
  }
}
