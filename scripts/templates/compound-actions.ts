/**
 * Compound (multi-tool) training data templates.
 * Each template represents 2-3 tool calls that a user might request together.
 */

function randomInt(min: number, max: number): number {
  return Math.floor(Math.random() * (max - min + 1)) + min;
}

function pick<T>(arr: T[]): T {
  return arr[Math.floor(Math.random() * arr.length)];
}

export interface CompoundTemplate {
  patterns: string[];
  tools: Array<{
    name: string;
    argGenerator: () => Record<string, any>;
  }>;
}

export const COMPOUND_TEMPLATES: CompoundTemplate[] = [
  // brightness + DND (bedtime)
  {
    patterns: [
      'Set brightness to {level} and turn on Do Not Disturb',
      'Dim the screen to {level} and enable DND',
      "I'm going to sleep, set brightness to {level} and silence notifications",
      'Bedtime mode: brightness {level} and DND on',
      'Night mode please - dim to {level} and enable Do Not Disturb',
      'Set brightness low to {level} and enable DND mode',
      'Going to bed, dim screen to {level} and turn on do not disturb',
    ],
    tools: [
      { name: 'set_brightness', argGenerator: () => ({ level: randomInt(5, 25) }) },
      { name: 'toggle_dnd', argGenerator: () => ({ enable: true }) },
    ],
  },
  // brightness + DND off (waking up)
  {
    patterns: [
      'Set brightness to {level} and turn off Do Not Disturb',
      "I'm awake, set brightness to {level} and disable DND",
      'Morning mode: brightness {level} and DND off',
      'Wake up mode - brightness to {level} and turn off DND',
      'Good morning, increase brightness to {level} and disable do not disturb',
    ],
    tools: [
      { name: 'set_brightness', argGenerator: () => ({ level: randomInt(60, 90) }) },
      { name: 'toggle_dnd', argGenerator: () => ({ enable: false }) },
    ],
  },
  // volume + DND
  {
    patterns: [
      'Mute the volume and enable Do Not Disturb',
      'Set volume to 0 and turn on DND',
      'Silence everything - mute volume and enable DND',
      'Going into a meeting, mute and enable DND',
      'Meeting mode: volume off and DND on',
    ],
    tools: [
      { name: 'set_volume', argGenerator: () => ({ stream: 'media', level: 0 }) },
      { name: 'toggle_dnd', argGenerator: () => ({ enable: true }) },
    ],
  },
  // bluetooth + volume
  {
    patterns: [
      'Turn on Bluetooth and set volume to {level}',
      'Enable Bluetooth and change volume to {level}',
      'I want to connect my headphones - turn on BT and set volume to {level}',
      'Bluetooth on and volume {level} please',
    ],
    tools: [
      { name: 'toggle_bluetooth', argGenerator: () => ({ enable: true }) },
      { name: 'set_volume', argGenerator: () => ({ stream: 'media', level: randomInt(40, 80) }) },
    ],
  },
  // alarm + brightness (morning setup)
  {
    patterns: [
      'Set an alarm for {hour}:{minutes_pad} and dim brightness to {level}',
      'Alarm at {hour}:{minutes_pad} and lower brightness to {level}',
      'Set a wake-up alarm for {hour}:{minutes_pad} and set brightness to {level}',
    ],
    tools: [
      { name: 'set_alarm', argGenerator: () => ({ hour: randomInt(5, 9), minutes: pick([0, 15, 30]) }) },
      { name: 'set_brightness', argGenerator: () => ({ level: randomInt(5, 20) }) },
    ],
  },
  // brightness + rotation lock
  {
    patterns: [
      'Set brightness to {level} and lock rotation',
      'Dim to {level} and enable rotation lock',
      'Brightness {level} and stop the screen from rotating',
      "I'm reading, set brightness to {level} and lock orientation",
    ],
    tools: [
      { name: 'set_brightness', argGenerator: () => ({ level: randomInt(30, 70) }) },
      { name: 'toggle_rotation_lock', argGenerator: () => ({ enable: true }) },
    ],
  },
  // timer + DND
  {
    patterns: [
      'Set a timer for {display} and enable Do Not Disturb',
      'Timer {display} and turn on DND',
      'Start a {display} timer and silence my phone',
      "I'm studying, set a timer for {display} and enable DND",
      'Focus mode: {display} timer and DND on',
    ],
    tools: [
      { name: 'set_timer', argGenerator: () => ({ seconds: pick([300, 600, 900, 1200, 1800, 3600]) }) },
      { name: 'toggle_dnd', argGenerator: () => ({ enable: true }) },
    ],
  },
  // flashlight + brightness
  {
    patterns: [
      'Turn on the flashlight and set brightness to {level}',
      'Flashlight on and increase screen brightness to {level}',
      "It's dark, turn on the flashlight and set brightness to {level}",
    ],
    tools: [
      { name: 'turn_on_flashlight', argGenerator: () => ({}) },
      { name: 'set_brightness', argGenerator: () => ({ level: randomInt(70, 100) }) },
    ],
  },
  // airplane mode + bluetooth off
  {
    patterns: [
      'Turn on airplane mode and disable Bluetooth',
      'Airplane mode on and Bluetooth off',
      'Flight mode and turn off BT',
      'Going on a flight, enable airplane mode and turn off Bluetooth',
    ],
    tools: [
      { name: 'toggle_airplane_mode', argGenerator: () => ({}) },
      { name: 'toggle_bluetooth', argGenerator: () => ({ enable: false }) },
    ],
  },
  // brightness + volume + DND (full bedtime)
  {
    patterns: [
      'Set brightness to {level}, volume to 0, and enable DND',
      'Bedtime: dim to {level}, mute volume, and turn on Do Not Disturb',
      "I'm going to sleep - brightness {level}, silence everything, DND on",
      'Night mode: brightness {level}, volume off, DND enabled',
      'Sleep mode: dim screen to {level}, mute, and enable do not disturb',
    ],
    tools: [
      { name: 'set_brightness', argGenerator: () => ({ level: randomInt(0, 15) }) },
      { name: 'set_volume', argGenerator: () => ({ stream: 'media', level: 0 }) },
      { name: 'toggle_dnd', argGenerator: () => ({ enable: true }) },
    ],
  },
  // alarm + DND off + brightness (wake up full)
  {
    patterns: [
      'Set alarm for {hour}:{minutes_pad}, turn off DND, and set brightness to {level}',
      'Wake up setup: alarm at {hour}:{minutes_pad}, disable DND, brightness {level}',
    ],
    tools: [
      { name: 'set_alarm', argGenerator: () => ({ hour: randomInt(5, 8), minutes: pick([0, 15, 30]) }) },
      { name: 'toggle_dnd', argGenerator: () => ({ enable: false }) },
      { name: 'set_brightness', argGenerator: () => ({ level: randomInt(60, 90) }) },
    ],
  },
  // wifi settings + bluetooth
  {
    patterns: [
      'Open WiFi settings and turn on Bluetooth',
      'I need to connect - open WiFi and enable BT',
      'Show WiFi settings and enable Bluetooth',
    ],
    tools: [
      { name: 'open_wifi_settings', argGenerator: () => ({}) },
      { name: 'toggle_bluetooth', argGenerator: () => ({ enable: true }) },
    ],
  },
  // bluetooth + rotation lock + volume
  {
    patterns: [
      'Turn on Bluetooth, lock rotation, and set volume to {level}',
      'Connect headphones mode: BT on, rotation locked, volume {level}',
      'Enable Bluetooth, lock screen rotation, and set volume to {level}',
    ],
    tools: [
      { name: 'toggle_bluetooth', argGenerator: () => ({ enable: true }) },
      { name: 'toggle_rotation_lock', argGenerator: () => ({ enable: true }) },
      { name: 'set_volume', argGenerator: () => ({ stream: 'media', level: randomInt(40, 80) }) },
    ],
  },
  // calendar + alarm
  {
    patterns: [
      'Create a calendar event for {title} and set an alarm for {hour}:{minutes_pad}',
      'Add {title} to my calendar and wake me up at {hour}:{minutes_pad}',
    ],
    tools: [
      { name: 'create_calendar_event', argGenerator: () => ({ title: pick(['Meeting', 'Doctor appointment', 'Lunch', 'Gym', 'Interview']), datetime: '2025-01-15T10:00:00' }) },
      { name: 'set_alarm', argGenerator: () => ({ hour: randomInt(5, 9), minutes: pick([0, 15, 30, 45]) }) },
    ],
  },
  // email + timer
  {
    patterns: [
      'Send an email to {to} and set a timer for {display}',
      'Email {to} about {subject} then start a {display} timer',
    ],
    tools: [
      { name: 'send_email', argGenerator: () => ({ to: pick(['john@example.com', 'jane@work.com', 'boss@company.com']), subject: pick(['Follow up', 'Quick question', 'Meeting notes']), body: pick(['See attached.', 'Please review.', 'Let me know your thoughts.']) }) },
      { name: 'set_timer', argGenerator: () => ({ seconds: pick([300, 600, 1800]) }) },
    ],
  },
];

/**
 * Fill a compound pattern with generated arguments.
 */
export function fillCompoundPattern(
  pattern: string,
  toolsArgs: Array<{ name: string; args: Record<string, any> }>,
): string {
  let result = pattern;

  // Flatten all args for replacement
  for (const { args } of toolsArgs) {
    for (const [key, value] of Object.entries(args)) {
      result = result.replace(new RegExp(`\\{${key}\\}`, 'g'), String(value));
    }
    if (args.minutes !== undefined) {
      result = result.replace(/\{minutes_pad\}/g, String(args.minutes).padStart(2, '0'));
    }
    if (args.seconds !== undefined) {
      const mins = Math.floor(args.seconds / 60);
      const secs = args.seconds % 60;
      const display = mins > 0
        ? (secs > 0 ? `${mins} minutes and ${secs} seconds` : `${mins} minute${mins > 1 ? 's' : ''}`)
        : `${secs} seconds`;
      result = result.replace(/\{display\}/g, display);
    }
  }

  return result;
}
