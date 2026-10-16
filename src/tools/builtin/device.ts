/**
 * The 28 existing Android actions, migrated behind AgentTool without changing
 * their behaviour (PRD §7.1): each adapter delegates to the original function
 * via the legacy executeTool switch and adds a schema, permissions, risk level
 * and — where state can be read back — a verifier.
 */
import type { DeviceStateReader } from '../../platform/types';
import type { ToolResult as LegacyResult } from '../../types';
import { executeTool as legacyExecuteTool } from '../registry';
import type { AgentTool, JsonSchema, PermissionId, RiskLevel, ToolOutcome } from '../types';

type LegacyExecutor = (name: string, args: Record<string, unknown>) => Promise<LegacyResult>;

let legacy: LegacyExecutor = legacyExecuteTool;
let stateReader: DeviceStateReader | null = null;

/** Tests inject a fake native layer; production uses the original tool functions. */
export function setLegacyExecutor(fn: LegacyExecutor): void {
  legacy = fn;
}
export function setDeviceStateReader(r: DeviceStateReader | null): void {
  stateReader = r;
}

function toOutcome(r: LegacyResult): ToolOutcome {
  if (r.success) return { success: true, data: r.data, display: r.message };
  const permission = /permission|not enabled|access/i.test(r.message);
  return {
    success: false,
    display: r.message,
    error: {
      code: permission ? 'PERMISSION_REQUIRED' : 'TOOL_FAILED',
      message: r.message,
      recoverable: !permission,
    },
  };
}

const obj = (properties: Record<string, JsonSchema>, required: string[] = []): JsonSchema => ({
  type: 'object',
  properties,
  required,
  additionalProperties: false,
});
const none = obj({});

interface Def {
  name: string;
  description: string;
  schema: JsonSchema;
  risk: RiskLevel;
  category: AgentTool['category'];
  perms?: PermissionId[];
  idempotent?: boolean;
  full?: boolean;
  alwaysAsk?: boolean;
  describe?: (a: Record<string, unknown>) => string;
  verify?: AgentTool['verify'];
}

const SETTINGS_PAGES = [
  'wifi',
  'bluetooth',
  'location',
  'display',
  'sound',
  'battery',
  'storage',
  'security',
  'accounts',
  'accessibility',
  'date',
  'language',
  'developer',
  'about',
  'apps',
  'notifications',
  'nfc',
  'data_usage',
  'vpn',
  'hotspot',
  'airplane',
  'privacy',
  'biometric',
];

const DEFS: Def[] = [
  {
    name: 'turn_on_flashlight',
    description: 'Turns the flashlight on.',
    schema: none,
    risk: 'reversible',
    category: 'device',
    idempotent: true,
  },
  {
    name: 'turn_off_flashlight',
    description: 'Turns the flashlight off.',
    schema: none,
    risk: 'reversible',
    category: 'device',
    idempotent: true,
  },
  {
    name: 'open_wifi_settings',
    description: 'Opens the Wi-Fi settings page.',
    schema: none,
    risk: 'read_only',
    category: 'device',
    idempotent: true,
  },
  {
    name: 'create_calendar_event',
    description: 'Opens the calendar to create an event (the user confirms in the Calendar app).',
    schema: obj(
      {
        title: { type: 'string', minLength: 1, maxLength: 200, description: 'Event title' },
        datetime: {
          type: 'string',
          minLength: 4,
          description: 'Start date and time, ISO 8601 preferred',
        },
      },
      ['title', 'datetime'],
    ),
    risk: 'reversible',
    category: 'personal',
    describe: a => `Create calendar event "${a.title}" at ${a.datetime}`,
  },
  {
    name: 'send_email',
    description: 'Opens the mail app with a composed email; the user presses send.',
    schema: obj(
      {
        to: { type: 'string', format: 'email', description: 'Recipient email address' },
        subject: { type: 'string', minLength: 1, maxLength: 300 },
        body: { type: 'string', maxLength: 20000, default: '' },
      },
      ['to', 'subject'],
    ),
    risk: 'reversible',
    category: 'communication',
    alwaysAsk: true,
    describe: a => `Compose email to ${a.to}: "${a.subject}"`,
  },
  {
    name: 'show_map',
    description: 'Shows a location on the map.',
    schema: obj({ query: { type: 'string', minLength: 1, maxLength: 300 } }, ['query']),
    risk: 'read_only',
    category: 'device',
    idempotent: true,
  },
  {
    name: 'create_contact',
    description: 'Opens the contacts app to create a contact (the user confirms).',
    schema: obj(
      {
        first_name: { type: 'string', minLength: 1 },
        last_name: { type: 'string', default: '' },
        phone_number: { type: 'string', pattern: '^[+0-9 ()-]{3,20}$' },
        email: { type: 'string', format: 'email' },
      },
      ['first_name'],
    ),
    risk: 'reversible',
    category: 'personal',
    describe: a => `Create contact ${a.first_name} ${a.last_name ?? ''}`.trim(),
  },
  {
    name: 'set_brightness',
    description: 'Sets the screen brightness level (0-100).',
    schema: obj({ level: { type: 'number', minimum: 0, maximum: 100 } }, ['level']),
    risk: 'reversible',
    category: 'device',
    perms: ['special:write_settings'],
    idempotent: true,
  },
  {
    name: 'set_volume',
    description:
      'Sets the volume (0-100) for a stream: media, ring, alarm, notification, system or voice.',
    schema: obj(
      {
        stream: {
          type: 'string',
          enum: ['media', 'ring', 'alarm', 'notification', 'system', 'voice'],
          default: 'media',
        },
        level: { type: 'number', minimum: 0, maximum: 100 },
      },
      ['level'],
    ),
    risk: 'reversible',
    category: 'device',
    idempotent: true,
    verify: async (a, _r) => {
      if (!stateReader) return { ok: true };
      const got = await stateReader.getStreamVolumePercent(String(a.stream ?? 'media'));
      const ok = got < 0 || Math.abs(got - Number(a.level)) <= 15;
      return ok ? { ok } : { ok, reason: `volume is ${got}%, expected ~${a.level}%` };
    },
  },
  {
    name: 'toggle_bluetooth',
    description: 'Enables or disables Bluetooth (opens settings on Android 13+).',
    schema: obj({ enable: { type: 'boolean' } }, ['enable']),
    risk: 'reversible',
    category: 'device',
    idempotent: true,
  },
  {
    name: 'toggle_dnd',
    description: 'Enables or disables Do Not Disturb.',
    schema: obj({ enable: { type: 'boolean' } }, ['enable']),
    risk: 'reversible',
    category: 'device',
    perms: ['special:notification_policy'],
    idempotent: true,
    verify: async a => {
      if (!stateReader) return { ok: true };
      const f = await stateReader.getInterruptionFilter();
      if (f === 'unknown') return { ok: true };
      const on = f !== 'all';
      return on === Boolean(a.enable)
        ? { ok: true }
        : { ok: false, reason: `Do Not Disturb is ${on ? 'on' : 'off'}` };
    },
  },
  {
    name: 'toggle_rotation_lock',
    description: 'Locks (true) or unlocks (false) screen rotation.',
    schema: obj({ enable: { type: 'boolean' } }, ['enable']),
    risk: 'reversible',
    category: 'device',
    perms: ['special:write_settings'],
    idempotent: true,
  },
  {
    name: 'set_alarm',
    description: 'Sets an alarm in the Clock app.',
    schema: obj(
      {
        hour: { type: 'integer', minimum: 0, maximum: 23 },
        minutes: { type: 'integer', minimum: 0, maximum: 59 },
        message: { type: 'string', maxLength: 100 },
      },
      ['hour', 'minutes'],
    ),
    risk: 'reversible',
    category: 'productivity',
    describe: a =>
      `Set alarm ${String(a.hour).padStart(2, '0')}:${String(a.minutes).padStart(2, '0')}`,
  },
  {
    name: 'set_timer',
    description: 'Sets a countdown timer.',
    schema: obj(
      {
        seconds: { type: 'integer', minimum: 1, maximum: 86400 },
        message: { type: 'string', maxLength: 100 },
      },
      ['seconds'],
    ),
    risk: 'reversible',
    category: 'productivity',
  },
  {
    name: 'toggle_airplane_mode',
    description: 'Opens airplane mode settings.',
    schema: none,
    risk: 'read_only',
    category: 'device',
    idempotent: true,
  },
  {
    name: 'open_settings_page',
    description: 'Opens a specific Android settings page.',
    schema: obj({ page: { type: 'string', enum: SETTINGS_PAGES } }, ['page']),
    risk: 'read_only',
    category: 'device',
    idempotent: true,
  },
  {
    name: 'take_screenshot',
    description: 'Takes a screenshot of the current screen.',
    schema: none,
    risk: 'sensitive',
    category: 'screen',
    perms: ['special:accessibility'],
    full: true,
  },
  {
    name: 'tap_element',
    description: 'Taps a UI element matching text or a content description.',
    schema: obj({ target: { type: 'string', minLength: 1 } }, ['target']),
    risk: 'sensitive',
    category: 'screen',
    perms: ['special:accessibility'],
    full: true,
    describe: a => `Tap "${a.target}" on screen`,
  },
  {
    name: 'long_press_element',
    description: 'Long-presses a UI element matching text or a content description.',
    schema: obj({ target: { type: 'string', minLength: 1 } }, ['target']),
    risk: 'sensitive',
    category: 'screen',
    perms: ['special:accessibility'],
    full: true,
  },
  {
    name: 'scroll_screen',
    description: 'Scrolls the screen up, down, left or right.',
    schema: obj({ direction: { type: 'string', enum: ['up', 'down', 'left', 'right'] } }, [
      'direction',
    ]),
    risk: 'sensitive',
    category: 'screen',
    perms: ['special:accessibility'],
    full: true,
  },
  {
    name: 'type_text',
    description: 'Types text into an input field.',
    schema: obj({ text: { type: 'string', minLength: 1 }, target: { type: 'string' } }, ['text']),
    risk: 'sensitive',
    category: 'screen',
    perms: ['special:accessibility'],
    full: true,
    describe: a => `Type "${String(a.text).slice(0, 40)}"`,
  },
  {
    name: 'read_screen',
    description: 'Reads the UI elements currently visible on screen.',
    schema: none,
    risk: 'sensitive',
    category: 'screen',
    perms: ['special:accessibility'],
    full: true,
  },
  {
    name: 'find_element',
    description: 'Searches visible UI elements for text.',
    schema: obj({ query: { type: 'string', minLength: 1 } }, ['query']),
    risk: 'sensitive',
    category: 'screen',
    perms: ['special:accessibility'],
    full: true,
  },
  {
    name: 'go_back',
    description: 'Presses the system back button.',
    schema: none,
    risk: 'sensitive',
    category: 'screen',
    perms: ['special:accessibility'],
    full: true,
  },
  {
    name: 'go_home',
    description: 'Presses the system home button.',
    schema: none,
    risk: 'sensitive',
    category: 'screen',
    perms: ['special:accessibility'],
    full: true,
  },
  {
    name: 'open_recents',
    description: 'Opens the recent apps overview.',
    schema: none,
    risk: 'sensitive',
    category: 'screen',
    perms: ['special:accessibility'],
    full: true,
  },
  {
    name: 'swipe_screen',
    description: 'Swipes between two screen coordinates.',
    schema: obj(
      {
        startX: { type: 'number', minimum: 0 },
        startY: { type: 'number', minimum: 0 },
        endX: { type: 'number', minimum: 0 },
        endY: { type: 'number', minimum: 0 },
        duration: { type: 'number', minimum: 50, maximum: 5000, default: 300 },
      },
      ['startX', 'startY', 'endX', 'endY'],
    ),
    risk: 'sensitive',
    category: 'screen',
    perms: ['special:accessibility'],
    full: true,
  },
];

export const DEVICE_TOOL_NAMES = DEFS.map(d => d.name);

export function createDeviceTools(): AgentTool[] {
  return DEFS.map<AgentTool>(d => ({
    name: d.name,
    description: d.description,
    category: d.category,
    inputSchema: d.schema,
    requiredPermissions: d.perms ?? [],
    riskLevel: d.risk,
    idempotent: d.idempotent ?? false,
    alwaysAsk: d.alwaysAsk,
    distributions: d.full ? ['full'] : undefined,
    describeCall: d.describe,
    verify: d.verify,
    execute: async args => toOutcome(await legacy(d.name, args)),
  }));
}
