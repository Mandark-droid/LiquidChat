import { Linking, Platform } from 'react-native';

import type { ToolResult } from '../types';
import { launchIntent } from './launchIntent';

export async function setTimer(seconds: number, message?: string): Promise<ToolResult> {
  try {
    if (Platform.OS === 'android') {
      await launchIntent('android.intent.action.SET_TIMER', {
        extras: {
          'android.intent.extra.alarm.LENGTH': seconds,
          'android.intent.extra.alarm.SKIP_UI': false,
          ...(message ? { 'android.intent.extra.alarm.MESSAGE': message } : {}),
        },
      });
    } else {
      await Linking.openURL('clock-timer://');
    }

    const mins = Math.floor(seconds / 60);
    const secs = seconds % 60;
    const timeStr = mins > 0 ? `${mins}m ${secs}s` : `${secs}s`;
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
