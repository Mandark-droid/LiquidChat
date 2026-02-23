import { Linking, Platform } from 'react-native';
import type { ToolResult } from '../types';

export async function createContact(
  firstName: string,
  lastName: string,
  phoneNumber?: string,
  email?: string
): Promise<ToolResult> {
  try {
    if (Platform.OS === 'android') {
      const extras = [
        { key: 'name', value: `${firstName} ${lastName}` },
      ];
      if (phoneNumber) {
        extras.push({ key: 'phone', value: phoneNumber });
      }
      if (email) {
        extras.push({ key: 'email', value: email });
      }
      await Linking.sendIntent('android.intent.action.INSERT', extras);
    } else {
      // iOS - no direct contact creation via URL, open contacts app
      await Linking.openURL('contacts://');
    }
    return {
      success: true,
      message: `Contact "${firstName} ${lastName}" creation initiated`,
    };
  } catch (error) {
    return {
      success: false,
      message: `Failed to create contact: ${error instanceof Error ? error.message : String(error)}`,
    };
  }
}
