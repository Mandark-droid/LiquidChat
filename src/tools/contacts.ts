import { Linking, Platform } from 'react-native';

import type { ToolResult } from '../types';
import { launchIntent } from './launchIntent';

export async function createContact(
  firstName: string,
  lastName: string,
  phoneNumber?: string,
  email?: string,
): Promise<ToolResult> {
  try {
    if (Platform.OS === 'android') {
      // Without the raw-contact type the INSERT action matches no app.
      await launchIntent('android.intent.action.INSERT', {
        type: 'vnd.android.cursor.dir/raw_contact',
        extras: {
          name: `${firstName} ${lastName}`.trim(),
          ...(phoneNumber ? { phone: phoneNumber } : {}),
          ...(email ? { email } : {}),
        },
      });
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
