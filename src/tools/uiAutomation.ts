import { NativeModules } from 'react-native';
import type { ToolResult } from '../types';

const { AccessibilityBridge } = NativeModules;

async function ensureServiceEnabled(): Promise<string | null> {
  try {
    const enabled = await AccessibilityBridge.isServiceEnabled();
    if (!enabled) {
      return 'Accessibility service not enabled. Enable LiquidChat in Settings > Accessibility.';
    }
    return null;
  } catch {
    return 'Failed to check accessibility service status.';
  }
}

function parseResult(resultJson: string): { success: boolean; message: string; data?: any } {
  try {
    const parsed = JSON.parse(resultJson);
    return {
      success: parsed.success ?? false,
      message: parsed.message ?? '',
      data: parsed.data,
    };
  } catch {
    return { success: false, message: 'Failed to parse service response' };
  }
}

export async function tapElement(target: string): Promise<ToolResult> {
  const err = await ensureServiceEnabled();
  if (err) return { success: false, message: err };

  try {
    const result = await AccessibilityBridge.performAction(
      JSON.stringify({ action: 'tap', target })
    );
    return parseResult(result);
  } catch (error) {
    return { success: false, message: `Tap failed: ${error instanceof Error ? error.message : String(error)}` };
  }
}

export async function longPressElement(target: string): Promise<ToolResult> {
  const err = await ensureServiceEnabled();
  if (err) return { success: false, message: err };

  try {
    const result = await AccessibilityBridge.performAction(
      JSON.stringify({ action: 'long_press', target })
    );
    return parseResult(result);
  } catch (error) {
    return { success: false, message: `Long press failed: ${error instanceof Error ? error.message : String(error)}` };
  }
}

export async function scrollScreen(direction: string = 'down'): Promise<ToolResult> {
  const err = await ensureServiceEnabled();
  if (err) return { success: false, message: err };

  try {
    const result = await AccessibilityBridge.performAction(
      JSON.stringify({ action: 'scroll', direction })
    );
    return parseResult(result);
  } catch (error) {
    return { success: false, message: `Scroll failed: ${error instanceof Error ? error.message : String(error)}` };
  }
}

export async function typeTextInField(text: string, target?: string): Promise<ToolResult> {
  const err = await ensureServiceEnabled();
  if (err) return { success: false, message: err };

  try {
    const payload: Record<string, string> = { action: 'type_text', text };
    if (target) payload.target = target;
    const result = await AccessibilityBridge.performAction(JSON.stringify(payload));
    return parseResult(result);
  } catch (error) {
    return { success: false, message: `Type text failed: ${error instanceof Error ? error.message : String(error)}` };
  }
}

export async function readScreen(): Promise<ToolResult> {
  const err = await ensureServiceEnabled();
  if (err) return { success: false, message: err };

  try {
    const result = await AccessibilityBridge.performAction(
      JSON.stringify({ action: 'read_screen' })
    );
    return parseResult(result);
  } catch (error) {
    return { success: false, message: `Read screen failed: ${error instanceof Error ? error.message : String(error)}` };
  }
}

export async function findElement(query: string): Promise<ToolResult> {
  const err = await ensureServiceEnabled();
  if (err) return { success: false, message: err };

  try {
    const result = await AccessibilityBridge.performAction(
      JSON.stringify({ action: 'find_element', query })
    );
    return parseResult(result);
  } catch (error) {
    return { success: false, message: `Find element failed: ${error instanceof Error ? error.message : String(error)}` };
  }
}

export async function goBack(): Promise<ToolResult> {
  const err = await ensureServiceEnabled();
  if (err) return { success: false, message: err };

  try {
    const result = await AccessibilityBridge.performAction(
      JSON.stringify({ action: 'go_back' })
    );
    return parseResult(result);
  } catch (error) {
    return { success: false, message: `Go back failed: ${error instanceof Error ? error.message : String(error)}` };
  }
}

export async function goHome(): Promise<ToolResult> {
  const err = await ensureServiceEnabled();
  if (err) return { success: false, message: err };

  try {
    const result = await AccessibilityBridge.performAction(
      JSON.stringify({ action: 'go_home' })
    );
    return parseResult(result);
  } catch (error) {
    return { success: false, message: `Go home failed: ${error instanceof Error ? error.message : String(error)}` };
  }
}

export async function openRecents(): Promise<ToolResult> {
  const err = await ensureServiceEnabled();
  if (err) return { success: false, message: err };

  try {
    const result = await AccessibilityBridge.performAction(
      JSON.stringify({ action: 'open_recents' })
    );
    return parseResult(result);
  } catch (error) {
    return { success: false, message: `Open recents failed: ${error instanceof Error ? error.message : String(error)}` };
  }
}

export async function swipe(
  startX: number,
  startY: number,
  endX: number,
  endY: number,
  duration?: number,
): Promise<ToolResult> {
  const err = await ensureServiceEnabled();
  if (err) return { success: false, message: err };

  try {
    const payload: Record<string, any> = { action: 'swipe', startX, startY, endX, endY };
    if (duration) payload.duration = duration;
    const result = await AccessibilityBridge.performAction(JSON.stringify(payload));
    return parseResult(result);
  } catch (error) {
    return { success: false, message: `Swipe failed: ${error instanceof Error ? error.message : String(error)}` };
  }
}
