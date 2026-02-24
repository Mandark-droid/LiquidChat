import { Linking, Platform } from 'react-native';
import type { ToolResult } from '../types';

export async function setAlarm(
  hour: number,
  minutes: number,
  message?: string,
): Promise<ToolResult> {
  try {
    if (Platform.OS === 'android') {
      const extras: Array<{ key: string; value: string }> = [
        { key: 'android.intent.extra.alarm.HOUR', value: String(hour) },
        { key: 'android.intent.extra.alarm.MINUTES', value: String(minutes) },
        { key: 'android.intent.extra.alarm.SKIP_UI', value: 'false' },
      ];
      if (message) {
        extras.push({ key: 'android.intent.extra.alarm.MESSAGE', value: message });
      }
      await Linking.sendIntent('android.intent.action.SET_ALARM', extras);
    } else {
      await Linking.openURL('clock-alarm://');
    }

    const timeStr = `${String(hour).padStart(2, '0')}:${String(minutes).padStart(2, '0')}`;
    return {
      success: true,
      message: `Alarm set for ${timeStr}${message ? ` - "${message}"` : ''}`,
    };
  } catch (error) {
    return {
      success: false,
      message: `Failed to set alarm: ${error instanceof Error ? error.message : String(error)}`,
    };
  }
}
