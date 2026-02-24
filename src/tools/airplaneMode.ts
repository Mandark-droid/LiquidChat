import { Linking, Platform } from 'react-native';
import type { ToolResult } from '../types';

export async function toggleAirplaneMode(): Promise<ToolResult> {
  try {
    if (Platform.OS === 'android') {
      await Linking.sendIntent('android.settings.AIRPLANE_MODE_SETTINGS');
    } else {
      await Linking.openURL('App-Prefs:AIRPLANE_MODE');
    }
    return {
      success: true,
      message: 'Opened airplane mode settings (toggle manually)',
    };
  } catch (error) {
    return {
      success: false,
      message: `Failed to open airplane mode settings: ${error instanceof Error ? error.message : String(error)}`,
    };
  }
}
