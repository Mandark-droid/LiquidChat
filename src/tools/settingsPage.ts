import { Linking, Platform } from 'react-native';
import type { ToolResult } from '../types';

const SETTINGS_PAGES: Record<string, string> = {
  wifi: 'android.settings.WIFI_SETTINGS',
  bluetooth: 'android.settings.BLUETOOTH_SETTINGS',
  location: 'android.settings.LOCATION_SOURCE_SETTINGS',
  display: 'android.settings.DISPLAY_SETTINGS',
  sound: 'android.settings.SOUND_SETTINGS',
  battery: 'android.intent.action.POWER_USAGE_SUMMARY',
  storage: 'android.settings.INTERNAL_STORAGE_SETTINGS',
  security: 'android.settings.SECURITY_SETTINGS',
  accounts: 'android.settings.SYNC_SETTINGS',
  accessibility: 'android.settings.ACCESSIBILITY_SETTINGS',
  date: 'android.settings.DATE_SETTINGS',
  language: 'android.settings.LOCALE_SETTINGS',
  developer: 'android.settings.APPLICATION_DEVELOPMENT_SETTINGS',
  about: 'android.settings.DEVICE_INFO_SETTINGS',
  apps: 'android.settings.APPLICATION_SETTINGS',
  notifications: 'android.settings.NOTIFICATION_SETTINGS',
  nfc: 'android.settings.NFC_SETTINGS',
  data_usage: 'android.settings.DATA_USAGE_SETTINGS',
  vpn: 'android.settings.VPN_SETTINGS',
  hotspot: 'android.settings.TETHER_SETTINGS',
  airplane: 'android.settings.AIRPLANE_MODE_SETTINGS',
  privacy: 'android.settings.PRIVACY_SETTINGS',
  biometric: 'android.settings.BIOMETRIC_ENROLL',
};

export async function openSettingsPage(page: string): Promise<ToolResult> {
  try {
    const key = page.toLowerCase().replace(/[\s_-]+/g, '_').replace(/settings?$/i, '').replace(/_$/, '');
    const action = SETTINGS_PAGES[key];

    if (Platform.OS === 'android') {
      if (action) {
        await Linking.sendIntent(action);
      } else {
        // Fall back to main settings
        await Linking.sendIntent('android.settings.SETTINGS');
        return {
          success: true,
          message: `Unknown page "${page}", opened main settings. Available: ${Object.keys(SETTINGS_PAGES).join(', ')}`,
        };
      }
    } else {
      await Linking.openURL('App-Prefs:');
    }

    return {
      success: true,
      message: `Opened ${page} settings`,
    };
  } catch (error) {
    return {
      success: false,
      message: `Failed to open settings: ${error instanceof Error ? error.message : String(error)}`,
    };
  }
}
