import Torch from 'react-native-torch';
import type { ToolResult } from '../types';

export async function turnOnFlashlight(): Promise<ToolResult> {
  try {
    Torch.switchState(true);
    return { success: true, message: 'Flashlight turned on' };
  } catch (error) {
    return {
      success: false,
      message: `Failed to turn on flashlight: ${error instanceof Error ? error.message : String(error)}`,
    };
  }
}

export async function turnOffFlashlight(): Promise<ToolResult> {
  try {
    Torch.switchState(false);
    return { success: true, message: 'Flashlight turned off' };
  } catch (error) {
    return {
      success: false,
      message: `Failed to turn off flashlight: ${error instanceof Error ? error.message : String(error)}`,
    };
  }
}
