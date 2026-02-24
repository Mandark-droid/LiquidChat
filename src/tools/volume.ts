import { NativeModules } from 'react-native';
import type { ToolResult } from '../types';

const { SystemControls } = NativeModules;

export async function setVolume(stream: string, level: number): Promise<ToolResult> {
  try {
    const result = await SystemControls.setVolume(stream || 'media', level);
    return { success: true, message: result };
  } catch (error) {
    return {
      success: false,
      message: `Failed to set volume: ${error instanceof Error ? error.message : String(error)}`,
    };
  }
}
