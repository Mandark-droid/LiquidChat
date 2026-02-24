import { NativeModules } from 'react-native';
import type { ToolResult } from '../types';

const { SystemControls } = NativeModules;

export async function setBrightness(level: number): Promise<ToolResult> {
  try {
    const result = await SystemControls.setBrightness(level);
    return { success: true, message: result };
  } catch (error) {
    return {
      success: false,
      message: `Failed to set brightness: ${error instanceof Error ? error.message : String(error)}`,
    };
  }
}
