import { NativeModules } from 'react-native';
import type { ToolResult } from '../types';

const { SystemControls } = NativeModules;

export async function toggleRotationLock(enable: boolean): Promise<ToolResult> {
  try {
    const result = await SystemControls.toggleRotationLock(enable);
    return { success: true, message: result };
  } catch (error) {
    return {
      success: false,
      message: `Failed to toggle rotation lock: ${error instanceof Error ? error.message : String(error)}`,
    };
  }
}
