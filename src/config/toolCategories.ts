export interface ToolCategory {
  name: string;
  tools: string[];
}

export const TOOL_CATEGORIES: ToolCategory[] = [
  {
    name: 'Device',
    tools: ['turn_on_flashlight', 'turn_off_flashlight', 'set_brightness', 'take_screenshot'],
  },
  {
    name: 'System Controls',
    tools: ['set_volume', 'toggle_rotation_lock'],
  },
  {
    name: 'Connectivity',
    tools: ['open_wifi_settings', 'toggle_bluetooth', 'toggle_airplane_mode'],
  },
  {
    name: 'Notifications',
    tools: ['toggle_dnd'],
  },
  {
    name: 'Clock',
    tools: ['set_alarm', 'set_timer'],
  },
  {
    name: 'Productivity',
    tools: ['create_calendar_event', 'send_email', 'create_contact'],
  },
  {
    name: 'Navigation',
    tools: ['show_map', 'open_settings_page'],
  },
];

const TOOL_ICON_MAP: Record<string, string> = {
  turn_on_flashlight: '🔦',
  turn_off_flashlight: '🔦',
  set_brightness: '🔆',
  take_screenshot: '📱',
  set_volume: '🔊',
  toggle_rotation_lock: '🔄',
  open_wifi_settings: '📶',
  toggle_bluetooth: '📡',
  toggle_airplane_mode: '✈️',
  toggle_dnd: '🔕',
  set_alarm: '⏰',
  set_timer: '⏱️',
  create_calendar_event: '📅',
  send_email: '✉️',
  create_contact: '👤',
  show_map: '🗺️',
  open_settings_page: '⚙️',
};

export function getToolIcon(name: string): string {
  return TOOL_ICON_MAP[name] || '⚙️';
}

export function getToolCategory(name: string): string | undefined {
  for (const category of TOOL_CATEGORIES) {
    if (category.tools.includes(name)) {
      return category.name;
    }
  }
  return undefined;
}
