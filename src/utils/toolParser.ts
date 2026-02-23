import type { ToolCall } from '../types';

/**
 * Parse tool calls from model output.
 * Supports:
 * 1. Special token format (google/mobile-actions training format)
 * 2. JSON format
 * 3. CactusLM functionCalls field
 */
export function parseToolCalls(text: string): ToolCall[] {
  // Try special token format first (google/mobile-actions)
  const specialTokenCalls = parseSpecialTokenFormat(text);
  if (specialTokenCalls.length > 0) return specialTokenCalls;

  // Try JSON format
  const jsonCalls = parseJsonFormat(text);
  if (jsonCalls.length > 0) return jsonCalls;

  return [];
}

function parseSpecialTokenFormat(text: string): ToolCall[] {
  const calls: ToolCall[] = [];
  const regex = /<start_function_call>\s*call:(\w+)\{([^}]*)\}\s*<end_function_call>/g;
  let match;

  while ((match = regex.exec(text)) !== null) {
    const name = match[1];
    const paramsStr = match[2];
    const args: Record<string, any> = {};

    // Parse params: key:<escape>[value]</escape>
    const paramRegex = /(\w+):<escape>\[([^\]]*)\]<\/escape>/g;
    let paramMatch;
    while ((paramMatch = paramRegex.exec(paramsStr)) !== null) {
      args[paramMatch[1]] = paramMatch[2];
    }

    calls.push({ name, arguments: args });
  }

  return calls;
}

function parseJsonFormat(text: string): ToolCall[] {
  const calls: ToolCall[] = [];

  // Try to find JSON tool call objects
  // Pattern: {"name": "...", "arguments": {...}}
  const jsonRegex = /\{[\s]*"name"[\s]*:[\s]*"([^"]+)"[\s]*,[\s]*"arguments"[\s]*:[\s]*(\{[^}]*\})/g;
  let match;

  while ((match = jsonRegex.exec(text)) !== null) {
    try {
      const name = match[1];
      const args = JSON.parse(match[2]);
      calls.push({ name, arguments: args });
    } catch {
      // Skip malformed JSON
    }
  }

  // Also try parsing the entire text as a JSON array of tool calls
  if (calls.length === 0) {
    try {
      const parsed = JSON.parse(text.trim());
      if (Array.isArray(parsed)) {
        for (const item of parsed) {
          if (item.name && typeof item.arguments === 'object') {
            calls.push({ name: item.name, arguments: item.arguments });
          }
        }
      } else if (parsed.name && typeof parsed.arguments === 'object') {
        calls.push({ name: parsed.name, arguments: parsed.arguments });
      }
    } catch {
      // Not valid JSON
    }
  }

  return calls;
}

/**
 * Parse CactusLM functionCalls from completion result
 */
export function parseCactusFunctionCalls(
  functionCalls?: Array<{ name: string; arguments: string }>
): ToolCall[] {
  if (!functionCalls || functionCalls.length === 0) return [];

  return functionCalls.map(fc => {
    let args: Record<string, any> = {};
    try {
      args = JSON.parse(fc.arguments);
    } catch {
      args = {};
    }
    return { name: fc.name, arguments: args };
  });
}

/**
 * Check if text contains tool call patterns
 */
export function hasToolCallPattern(text: string): boolean {
  return (
    text.includes('<start_function_call>') ||
    text.includes('"name"') && text.includes('"arguments"') ||
    /call:\w+\{/.test(text)
  );
}
