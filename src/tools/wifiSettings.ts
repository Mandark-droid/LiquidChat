import { Linking, Platform } from 'react-native';
import type { ToolResult } from '../types';

export async function openWifiSettings(): Promise<ToolResult> {
  try {
    if (Platform.OS === 'android') {
      await Linking.sendIntent('android.settings.WIFI_SETTINGS');
    } else {
      await Linking.openURL('App-Prefs:WIFI');
    }
    return { success: true, message: 'Wi-Fi settings opened' };
  } catch (error) {
    return {
      success: false,
      message: `Failed to open Wi-Fi settings: ${error instanceof Error ? error.message : String(error)}`,
    };
  }
}
