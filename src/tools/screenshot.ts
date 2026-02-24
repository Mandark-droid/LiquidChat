import { NativeModules } from 'react-native';
import type { ToolResult } from '../types';

const { AccessibilityBridge } = NativeModules;

export async function takeScreenshot(): Promise<ToolResult> {
  try {
    const enabled = await AccessibilityBridge.isServiceEnabled();
    if (!enabled) {
      return {
        success: false,
        message: 'Accessibility service not enabled. Enable LiquidChat in Settings > Accessibility.',
      };
    }

    const resultJson = await AccessibilityBridge.performAction(
      JSON.stringify({ action: 'take_screenshot' })
    );

    const result = JSON.parse(resultJson);
    return {
      success: result.success ?? false,
      message: result.message ?? 'Screenshot captured',
      data: result.data ? { path: result.data } : undefined,
    };
  } catch (error) {
    return {
      success: false,
      message: `Screenshot failed: ${error instanceof Error ? error.message : String(error)}`,
    };
  }
}
