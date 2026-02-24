import { turnOnFlashlight, turnOffFlashlight } from './flashlight';
import { openWifiSettings } from './wifiSettings';
import { createCalendarEvent } from './calendarEvent';
import { sendEmail } from './email';
import { showMap } from './maps';
import { createContact } from './contacts';
import { setBrightness } from './brightness';
import { setVolume } from './volume';
import { toggleBluetooth } from './bluetooth';
import { toggleDnd } from './dnd';
import { toggleRotationLock } from './rotationLock';
import { setAlarm } from './alarm';
import { setTimer } from './timer';
import { toggleAirplaneMode } from './airplaneMode';
import { openSettingsPage } from './settingsPage';
import { takeScreenshot } from './screenshot';
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
  { function: { name: 'set_brightness', description: 'Sets the screen brightness level.', parameters: { type: 'OBJECT', properties: { level: { type: 'NUMBER', description: 'Brightness level from 0 to 100' } }, required: ['level'] } } },
  { function: { name: 'set_volume', description: 'Sets the volume level for a specific audio stream.', parameters: { type: 'OBJECT', properties: { stream: { type: 'STRING', description: 'Audio stream: media, ring, alarm, notification, system, or voice' }, level: { type: 'NUMBER', description: 'Volume level from 0 to 100' } }, required: ['level'] } } },
  { function: { name: 'toggle_bluetooth', description: 'Enables or disables Bluetooth.', parameters: { type: 'OBJECT', properties: { enable: { type: 'BOOLEAN', description: 'True to enable, false to disable' } }, required: ['enable'] } } },
  { function: { name: 'toggle_dnd', description: 'Enables or disables Do Not Disturb mode.', parameters: { type: 'OBJECT', properties: { enable: { type: 'BOOLEAN', description: 'True to enable, false to disable' } }, required: ['enable'] } } },
  { function: { name: 'toggle_rotation_lock', description: 'Enables or disables screen rotation lock.', parameters: { type: 'OBJECT', properties: { enable: { type: 'BOOLEAN', description: 'True to lock rotation, false to unlock' } }, required: ['enable'] } } },
  { function: { name: 'set_alarm', description: 'Sets an alarm for a specific time.', parameters: { type: 'OBJECT', properties: { hour: { type: 'NUMBER', description: 'Hour in 24-hour format (0-23)' }, minutes: { type: 'NUMBER', description: 'Minutes (0-59)' }, message: { type: 'STRING', description: 'Optional alarm label' } }, required: ['hour', 'minutes'] } } },
  { function: { name: 'set_timer', description: 'Sets a countdown timer.', parameters: { type: 'OBJECT', properties: { seconds: { type: 'NUMBER', description: 'Timer duration in seconds' }, message: { type: 'STRING', description: 'Optional timer label' } }, required: ['seconds'] } } },
  { function: { name: 'toggle_airplane_mode', description: 'Opens airplane mode settings to toggle it.', parameters: { type: 'OBJECT', properties: {}, required: [] } } },
  { function: { name: 'open_settings_page', description: 'Opens a specific settings page.', parameters: { type: 'OBJECT', properties: { page: { type: 'STRING', description: 'Settings page name: wifi, bluetooth, location, display, sound, battery, storage, security, accounts, accessibility, date, language, developer, about, apps, notifications, nfc, data_usage, vpn, hotspot, airplane, privacy, biometric' } }, required: ['page'] } } },
  { function: { name: 'take_screenshot', description: 'Takes a screenshot of the current screen.', parameters: { type: 'OBJECT', properties: {}, required: [] } } },
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
      case 'set_brightness':
        return await setBrightness(args.level);
      case 'set_volume':
        return await setVolume(args.stream, args.level);
      case 'toggle_bluetooth':
        return await toggleBluetooth(args.enable);
      case 'toggle_dnd':
        return await toggleDnd(args.enable);
      case 'toggle_rotation_lock':
        return await toggleRotationLock(args.enable);
      case 'set_alarm':
        return await setAlarm(args.hour, args.minutes, args.message);
      case 'set_timer':
        return await setTimer(args.seconds, args.message);
      case 'toggle_airplane_mode':
        return await toggleAirplaneMode();
      case 'open_settings_page':
        return await openSettingsPage(args.page);
      case 'take_screenshot':
        return await takeScreenshot();
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
