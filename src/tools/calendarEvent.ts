import { Linking, Platform } from 'react-native';
import type { ToolResult } from '../types';

export async function createCalendarEvent(
  title: string,
  datetime: string
): Promise<ToolResult> {
  try {
    const date = new Date(datetime);
    const endDate = new Date(date.getTime() + 60 * 60 * 1000); // 1 hour default

    if (Platform.OS === 'android') {
      const beginTime = date.getTime();
      const endTime = endDate.getTime();
      await Linking.sendIntent('android.intent.action.INSERT', [
        { key: 'beginTime', value: String(beginTime) },
        { key: 'endTime', value: String(endTime) },
        { key: 'title', value: title },
      ]);
    } else {
      // iOS - use calshow URL scheme
      const timestamp = date.getTime() / 1000 - 978307200; // Convert to Apple epoch
      await Linking.openURL(`calshow:${timestamp}`);
    }

    return {
      success: true,
      message: `Calendar event "${title}" created for ${datetime}`,
    };
  } catch (error) {
    return {
      success: false,
      message: `Failed to create calendar event: ${error instanceof Error ? error.message : String(error)}`,
    };
  }
}
