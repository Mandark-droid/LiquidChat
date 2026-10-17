import { Linking, NativeModules, Platform } from 'react-native';

import type { ToolResult } from '../types';

interface SystemControlsNative {
  insertCalendarEvent?: (
    title: string,
    beginMs: number,
    endMs: number,
    allDay: boolean,
    description: string | null,
  ) => Promise<boolean>;
}

const DATE_ONLY = /^\d{4}-\d{2}-\d{2}$/;

/** Local calendar date "YYYY-MM-DD" (or a date-time) → event window. */
export function eventWindow(datetime: string): { begin: number; end: number; allDay: boolean } {
  if (DATE_ONLY.test(datetime)) {
    // All-day events are anchored at UTC midnight (CalendarContract convention).
    const [y, m, d] = datetime.split('-').map(Number);
    const begin = Date.UTC(y, m - 1, d);
    return { begin, end: begin + 86_400_000, allDay: true };
  }
  const begin = new Date(datetime).getTime();
  if (Number.isNaN(begin)) throw new Error(`Unrecognised date "${datetime}"`);
  return { begin, end: begin + 60 * 60 * 1000, allDay: false };
}

/**
 * Opens the calendar's "new event" screen prefilled; the user confirms. A date-only value
 * ("2026-10-24") creates an all-day event, which suits task due dates.
 */
export async function createCalendarEvent(
  title: string,
  datetime: string,
  description?: string,
): Promise<ToolResult> {
  try {
    const { begin, end, allDay } = eventWindow(datetime);
    if (Platform.OS === 'android') {
      const native = NativeModules.SystemControls as SystemControlsNative | undefined;
      if (!native?.insertCalendarEvent) {
        return {
          success: false,
          message: 'Calendar needs the latest app build. Please update LiquidChat.',
        };
      }
      await native.insertCalendarEvent(title, begin, end, allDay, description ?? null);
    } else {
      const timestamp = begin / 1000 - 978307200; // Apple reference date
      await Linking.openURL(`calshow:${timestamp}`);
    }
    return {
      success: true,
      message: `Opened your calendar to add "${title}" — save it there to confirm.`,
    };
  } catch (error) {
    return {
      success: false,
      message: `Could not open the calendar: ${error instanceof Error ? error.message : String(error)}`,
    };
  }
}
