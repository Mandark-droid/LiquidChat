import type { ToolCall } from '../types';

/**
 * Parse tool calls from model output.
 * Supports:
 * 1. Special token format (google/mobile-actions training format)
 * 2. JSON format (single object, array, wrapped function format, embedded in text)
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

  // Strategy 1: Try parsing the full text as JSON first (handles clean JSON responses)
  try {
    const parsed = JSON.parse(text.trim());
    const extracted = extractToolCallsFromParsed(parsed);
    if (extracted.length > 0) return extracted;
  } catch {
    // Not clean JSON, continue to other strategies
  }

  // Strategy 2: Try to find a JSON block within the text (e.g., surrounded by markdown fences or text)
  const jsonBlockMatch = text.match(/```(?:json)?\s*([\s\S]*?)```/);
  if (jsonBlockMatch) {
    try {
      const parsed = JSON.parse(jsonBlockMatch[1].trim());
      const extracted = extractToolCallsFromParsed(parsed);
      if (extracted.length > 0) return extracted;
    } catch {
      // Malformed JSON block
    }
  }

  // Strategy 3: Try to find JSON objects/arrays embedded in text
  // Look for array of tool calls
  const arrayMatch = text.match(/\[[\s\S]*?\{[\s\S]*?"name"[\s\S]*?\}[\s\S]*?\]/);
  if (arrayMatch) {
    try {
      const parsed = JSON.parse(arrayMatch[0]);
      const extracted = extractToolCallsFromParsed(parsed);
      if (extracted.length > 0) return extracted;
    } catch {
      // Malformed array
    }
  }

  // Strategy 4: Regex fallback for partially-embedded tool calls
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

  // Strategy 5: Try {"function": {"name": ..., "arguments": ...}} wrapper format
  if (calls.length === 0) {
    const wrapperRegex = /\{[\s]*"function"[\s]*:[\s]*\{[\s]*"name"[\s]*:[\s]*"([^"]+)"[\s]*,[\s]*"arguments"[\s]*:[\s]*(\{[^}]*\})/g;
    let wrapperMatch;

    while ((wrapperMatch = wrapperRegex.exec(text)) !== null) {
      try {
        const name = wrapperMatch[1];
        const args = JSON.parse(wrapperMatch[2]);
        calls.push({ name, arguments: args });
      } catch {
        // Skip malformed JSON
      }
    }
  }

  return calls;
}

function extractToolCallsFromParsed(parsed: any): ToolCall[] {
  const calls: ToolCall[] = [];

  if (Array.isArray(parsed)) {
    for (const item of parsed) {
      const extracted = extractSingleToolCall(item);
      if (extracted) calls.push(extracted);
    }
  } else if (typeof parsed === 'object' && parsed !== null) {
    const extracted = extractSingleToolCall(parsed);
    if (extracted) calls.push(extracted);
  }

  return calls;
}

function extractSingleToolCall(item: any): ToolCall | null {
  if (!item || typeof item !== 'object') return null;

  // Direct format: {"name": "...", "arguments": {...}}
  if (item.name && typeof item.arguments === 'object') {
    return { name: item.name, arguments: item.arguments };
  }

  // Wrapper format: {"function": {"name": "...", "arguments": {...}}}
  if (item.function && typeof item.function === 'object') {
    const fn = item.function;
    if (fn.name && typeof fn.arguments === 'object') {
      return { name: fn.name, arguments: fn.arguments };
    }
    // Arguments might be a JSON string
    if (fn.name && typeof fn.arguments === 'string') {
      try {
        const args = JSON.parse(fn.arguments);
        return { name: fn.name, arguments: args };
      } catch {
        return null;
      }
    }
  }

  // tool_calls wrapper: {"tool_calls": [...]}
  if (Array.isArray(item.tool_calls)) {
    // Return first one; caller should handle array case
    for (const tc of item.tool_calls) {
      const extracted = extractSingleToolCall(tc);
      if (extracted) return extracted;
    }
  }

  return null;
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
