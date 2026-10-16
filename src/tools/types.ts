/**
 * Tool contracts (PRD §7). Every capability the agent can exercise — native
 * Android actions, app services, MCP tools — is an AgentTool and can only be
 * invoked through the PermissionGateway.
 */

export type RiskLevel = 'read_only' | 'reversible' | 'sensitive';

export type Distribution = 'play' | 'full';

/** JSON Schema subset understood by src/tools/schema.ts. */
export interface JsonSchema {
  type?: 'object' | 'string' | 'number' | 'integer' | 'boolean' | 'array' | 'null';
  description?: string;
  properties?: Record<string, JsonSchema>;
  required?: string[];
  additionalProperties?: boolean;
  items?: JsonSchema;
  enum?: (string | number | boolean)[];
  minimum?: number;
  maximum?: number;
  minLength?: number;
  maxLength?: number;
  pattern?: string;
  format?: 'date' | 'date-time' | 'email' | 'uri';
  default?: unknown;
}

export interface ToolError {
  code: string;
  message: string;
  recoverable: boolean;
}

export interface ToolResult {
  success: boolean;
  data?: unknown;
  error?: ToolError;
  durationMs: number;
  /** Short human-readable outcome, used when no model call writes the reply. */
  display?: string;
}

export type ToolOutcome = Omit<ToolResult, 'durationMs'>;

export interface CancellationToken {
  readonly cancelled: boolean;
  onCancel(cb: () => void): () => void;
}

export interface ToolContext {
  executionId: string;
  stepId: string;
  toolCallId: string;
  cancel: CancellationToken;
  distribution: Distribution;
}

export interface VerifyOutcome {
  ok: boolean;
  reason?: string;
}

/** Well-known permission ids. Android runtime permissions use their manifest names. */
export type PermissionId =
  | `android.permission.${string}`
  | 'special:notification_policy'
  | 'special:write_settings'
  | 'special:accessibility'
  | 'special:notification_listener'
  | 'special:network';

export interface AgentTool<A = Record<string, unknown>> {
  name: string;
  description: string;
  category:
    | 'device'
    | 'personal'
    | 'communication'
    | 'productivity'
    | 'context'
    | 'screen'
    | 'mcp'
    | 'memory';
  inputSchema: JsonSchema;
  requiredPermissions: PermissionId[];
  riskLevel: RiskLevel;
  /** Safe to run twice with the same args (used by restart recovery). */
  idempotent: boolean;
  /** Never eligible for a standing "always allow" grant (e.g. sending messages). */
  alwaysAsk?: boolean;
  /** Restrict to a distribution flavor (Accessibility automation is 'full' only). */
  distributions?: Distribution[];
  /** Name in the google/mobile-actions schema the fine-tuned model emits, if different. */
  legacyName?: string;
  execute(args: A, ctx: ToolContext): Promise<ToolOutcome>;
  /** Post-condition check (e.g. read DnD state back after enabling it). */
  verify?(args: A, result: ToolResult, ctx: ToolContext): Promise<VerifyOutcome>;
  /** One-line description of the call for approval prompts. */
  describeCall?(args: A): string;
}

export function toolError(code: string, message: string, recoverable = false): ToolOutcome {
  return { success: false, error: { code, message, recoverable } };
}
