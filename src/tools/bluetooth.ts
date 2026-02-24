import { NativeModules } from 'react-native';
import type { ToolResult } from '../types';

const { SystemControls } = NativeModules;

export async function toggleBluetooth(enable: boolean): Promise<ToolResult> {
  try {
    const result = await SystemControls.toggleBluetooth(enable);
    return { success: true, message: result };
  } catch (error) {
    return {
      success: false,
      message: `Failed to toggle Bluetooth: ${error instanceof Error ? error.message : String(error)}`,
    };
  }
}
