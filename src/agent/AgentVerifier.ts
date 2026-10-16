/**
 * Outcome verification (PRD §6.5): measurable signals, not model self-confidence.
 *  - tool steps: structured success + the tool's own post-condition check
 *  - infer steps: non-empty output, structured-output validity, explicit uncertainty
 */
import type { InferenceResult } from '../inference/types';
import { extractJson } from '../meetings/MinutesGenerator';
import { formatIssues, validate } from '../tools/schema';
import type { AgentTool, ToolContext, ToolResult } from '../tools/types';
import type { InferStep } from './types';

export interface Verification {
  ok: boolean;
  reason?: string;
  /** Failure that a stronger model might fix (vs. one that needs the user). */
  escalate: boolean;
  /** Parsed structured output when the step declared an outputSchema. */
  value?: unknown;
}

const UNCERTAIN_RE =
  /\b(i (?:can(?:'|no)t|am unable to|don't know how to)|i'm not (?:sure|able)|as an ai|insufficient information|cannot determine)\b/i;

export async function verifyTool(
  tool: AgentTool,
  args: Record<string, unknown>,
  result: ToolResult,
  ctx: ToolContext,
): Promise<Verification> {
  if (!result.success)
    return { ok: false, reason: result.error?.message ?? 'tool failed', escalate: false };
  if (!tool.verify) return { ok: true, escalate: false };
  try {
    const v = await tool.verify(args, result, ctx);
    return v.ok
      ? { ok: true, escalate: false }
      : { ok: false, reason: v.reason ?? 'post-condition not met', escalate: false };
  } catch (e) {
    // A verifier that cannot read state must not fail an action that reported success.
    return {
      ok: true,
      escalate: false,
      reason: `verifier unavailable: ${e instanceof Error ? e.message : String(e)}`,
    };
  }
}

export function verifyInference(step: InferStep, result: InferenceResult): Verification {
  const text = (result.text ?? '').replace(/<think>[\s\S]*?<\/think>/gi, '').trim();
  if (!text) return { ok: false, reason: 'empty model output', escalate: true };
  if (step.outputSchema) {
    const json = extractJson(text);
    if (json === null) return { ok: false, reason: 'output is not valid JSON', escalate: true };
    const v = validate(step.outputSchema, json);
    if (!v.ok)
      return {
        ok: false,
        reason: `output does not match schema: ${formatIssues(v.issues)}`,
        escalate: true,
      };
    return { ok: true, escalate: false, value: v.value };
  }
  if (
    (step.operation === 'reason' || step.operation === 'extract') &&
    UNCERTAIN_RE.test(text.slice(0, 300))
  ) {
    return { ok: false, reason: 'model expressed it could not complete the step', escalate: true };
  }
  return { ok: true, escalate: false, value: text };
}
