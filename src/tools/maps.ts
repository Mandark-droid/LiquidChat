import { Linking, Platform } from 'react-native';
import type { ToolResult } from '../types';

export async function showMap(query: string): Promise<ToolResult> {
  try {
    const encodedQuery = encodeURIComponent(query);
    if (Platform.OS === 'android') {
      await Linking.openURL(`geo:0,0?q=${encodedQuery}`);
    } else {
      await Linking.openURL(`maps:0,0?q=${encodedQuery}`);
    }
    return {
      success: true,
      message: `Showing map for "${query}"`,
    };
  } catch (error) {
    return {
      success: false,
      message: `Failed to show map: ${error instanceof Error ? error.message : String(error)}`,
    };
  }
}
