import { Linking } from 'react-native';
import type { ToolResult } from '../types';

export async function sendEmail(
  to: string,
  subject: string,
  body?: string
): Promise<ToolResult> {
  try {
    const params = new URLSearchParams();
    params.append('subject', subject);
    if (body) {
      params.append('body', body);
    }
    const url = `mailto:${encodeURIComponent(to)}?${params.toString()}`;
    await Linking.openURL(url);
    return {
      success: true,
      message: `Email composed to ${to} with subject "${subject}"`,
    };
  } catch (error) {
    return {
      success: false,
      message: `Failed to compose email: ${error instanceof Error ? error.message : String(error)}`,
    };
  }
}
