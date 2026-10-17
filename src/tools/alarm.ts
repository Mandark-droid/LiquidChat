import { Linking, Platform } from 'react-native';

import type { ToolResult } from '../types';
import { launchIntent } from './launchIntent';

export async function setAlarm(
  hour: number,
  minutes: number,
  message?: string,
): Promise<ToolResult> {
  try {
    if (Platform.OS === 'android') {
      await launchIntent('android.intent.action.SET_ALARM', {
        extras: {
          'android.intent.extra.alarm.HOUR': hour,
          'android.intent.extra.alarm.MINUTES': minutes,
          'android.intent.extra.alarm.SKIP_UI': false,
          ...(message ? { 'android.intent.extra.alarm.MESSAGE': message } : {}),
        },
      });
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
