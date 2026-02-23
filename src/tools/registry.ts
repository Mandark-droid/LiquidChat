import { turnOnFlashlight, turnOffFlashlight } from './flashlight';
import { openWifiSettings } from './wifiSettings';
import { createCalendarEvent } from './calendarEvent';
import { sendEmail } from './email';
import { showMap } from './maps';
import { createContact } from './contacts';
import type { ToolResult } from '../types';

/**
 * Tool definitions matching the exact google/mobile-actions training format.
 * Format: [{"function": {"name": ..., "parameters": {"type": "OBJECT", "properties": {"key": {"type": "STRING", ...}}}}}]
 */
export const MOBILE_ACTION_TOOLS = [
  { function: { name: 'turn_on_flashlight', description: 'Turns the flashlight on.', parameters: { type: 'OBJECT', properties: {}, required: [] } } },
  { function: { name: 'turn_off_flashlight', description: 'Turns the flashlight off.', parameters: { type: 'OBJECT', properties: {}, required: [] } } },
  { function: { name: 'open_wifi_settings', description: 'Opens the Wi-Fi settings page.', parameters: { type: 'OBJECT', properties: {}, required: [] } } },
  { function: { name: 'create_calendar_event', description: 'Creates a new calendar event.', parameters: { type: 'OBJECT', properties: { title: { type: 'STRING', description: 'The event title' }, datetime: { type: 'STRING', description: 'The date and time of the event' } }, required: ['title', 'datetime'] } } },
  { function: { name: 'send_email', description: 'Sends an email to the specified address.', parameters: { type: 'OBJECT', properties: { to: { type: 'STRING', description: 'The recipient email address' }, subject: { type: 'STRING', description: 'The email subject' }, body: { type: 'STRING', description: 'The email body' } }, required: ['to', 'subject', 'body'] } } },
  { function: { name: 'show_map', description: 'Shows a location on the map.', parameters: { type: 'OBJECT', properties: { query: { type: 'STRING', description: 'The search query or address' } }, required: ['query'] } } },
  { function: { name: 'create_contact', description: 'Creates a new contact.', parameters: { type: 'OBJECT', properties: { first_name: { type: 'STRING', description: 'First name' }, last_name: { type: 'STRING', description: 'Last name' }, phone_number: { type: 'STRING', description: 'Phone number' }, email: { type: 'STRING', description: 'Email address' } }, required: ['first_name'] } } },
];

export async function executeTool(
  name: string,
  args: Record<string, any>
): Promise<ToolResult> {
  try {
    switch (name) {
      case 'turn_on_flashlight':
        return await turnOnFlashlight();
      case 'turn_off_flashlight':
        return await turnOffFlashlight();
      case 'open_wifi_settings':
        return await openWifiSettings();
      case 'create_calendar_event':
        return await createCalendarEvent(args.title, args.datetime);
      case 'send_email':
        return await sendEmail(args.to, args.subject, args.body);
      case 'show_map':
        return await showMap(args.query);
      case 'create_contact':
        return await createContact(args.first_name, args.last_name, args.phone_number, args.email);
      default:
        return { success: false, message: `Unknown tool: ${name}` };
    }
  } catch (error) {
    return {
      success: false,
      message: `Tool execution failed: ${error instanceof Error ? error.message : String(error)}`,
    };
  }
}

export function getToolDefinitionsJSON(): string {
  return JSON.stringify(MOBILE_ACTION_TOOLS, null, 2);
}

export function getDefaultSystemPrompt(): string {
  return (
    'You are a helpful assistant with access to the following functions. Use them if required.\n\n' +
    getToolDefinitionsJSON()
  );
}
