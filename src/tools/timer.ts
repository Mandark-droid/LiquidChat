import { Linking, Platform } from 'react-native';
import type { ToolResult } from '../types';

export async function setTimer(
  seconds: number,
  message?: string,
): Promise<ToolResult> {
  try {
    if (Platform.OS === 'android') {
      const extras: Array<{ key: string; value: string }> = [
        { key: 'android.intent.extra.alarm.LENGTH', value: String(seconds) },
        { key: 'android.intent.extra.alarm.SKIP_UI', value: 'false' },
      ];
      if (message) {
        extras.push({ key: 'android.intent.extra.alarm.MESSAGE', value: message });
      }
      await Linking.sendIntent('android.intent.action.SET_TIMER', extras);
    } else {
      await Linking.openURL('clock-timer://');
    }

    const mins = Math.floor(seconds / 60);
    const secs = seconds % 60;
    const timeStr = mins > 0
      ? `${mins}m ${secs}s`
      : `${secs}s`;
    return {
      success: true,
      message: `Timer set for ${timeStr}${message ? ` - "${message}"` : ''}`,
    };
  } catch (error) {
    return {
      success: false,
      message: `Failed to set timer: ${error instanceof Error ? error.message : String(error)}`,
    };
  }
}
