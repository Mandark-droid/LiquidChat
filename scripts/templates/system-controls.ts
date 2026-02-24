/**
 * Single-tool training data templates for 10 new system control tools.
 * Each tool has 50+ natural language variations with randomized parameters.
 */

export interface ToolTemplate {
  tool: string;
  variations: ToolVariation[];
}

export interface ToolVariation {
  patterns: string[];
  argGenerator: () => Record<string, any>;
}

function randomInt(min: number, max: number): number {
  return Math.floor(Math.random() * (max - min + 1)) + min;
}

function pick<T>(arr: T[]): T {
  return arr[Math.floor(Math.random() * arr.length)];
}

export const SYSTEM_CONTROL_TEMPLATES: ToolTemplate[] = [
  // ============ set_brightness ============
  {
    tool: 'set_brightness',
    variations: [
      {
        patterns: [
          'Set brightness to {level}',
          'Set the brightness to {level} percent',
          'Change brightness to {level}%',
          'Make the screen {level}% bright',
          'Adjust the display brightness to {level}',
          'Brightness {level}',
          'Set screen brightness {level}',
          'Put brightness at {level}',
          'Can you set the brightness to {level}?',
          'Please change the screen brightness to {level}',
        ],
        argGenerator: () => ({ level: randomInt(0, 100) }),
      },
      {
        patterns: [
          'Turn brightness all the way up',
          'Max brightness please',
          'Make the screen as bright as possible',
          'Full brightness',
          'Crank up the brightness',
          'Set brightness to maximum',
          'I need maximum brightness',
          'Brightest setting please',
        ],
        argGenerator: () => ({ level: 100 }),
      },
      {
        patterns: [
          'Turn brightness all the way down',
          'Minimum brightness',
          'Make the screen as dim as possible',
          'Lowest brightness setting',
          'Dim the screen to the lowest',
          'Set brightness to the minimum',
        ],
        argGenerator: () => ({ level: 0 }),
      },
      {
        patterns: [
          'Dim the screen a bit',
          'Lower the screen brightness to about {level}',
          'Can you dim the display to {level}?',
          'Make it a bit dimmer, like {level}',
          'Reduce the brightness to {level}',
          'The screen is too bright, set it to {level}',
          'Tone down the brightness to {level}',
        ],
        argGenerator: () => ({ level: randomInt(10, 40) }),
      },
      {
        patterns: [
          'I can barely see the screen, increase brightness',
          'Brighten the screen to {level}',
          'Make it brighter, set to {level}',
          'Increase brightness to {level}',
          'The screen is too dark, set brightness to {level}',
          'Bump up the brightness to {level}',
        ],
        argGenerator: () => ({ level: randomInt(60, 95) }),
      },
      {
        patterns: [
          'Set brightness to half',
          'Brightness at 50',
          'Medium brightness',
          'Set brightness to the middle',
          'Put brightness at 50 percent',
        ],
        argGenerator: () => ({ level: 50 }),
      },
      {
        patterns: [
          'brigtness {level}',
          'set brightnes to {level}',
          'brightnss {level}',
          'set the birhtness to {level}',
        ],
        argGenerator: () => ({ level: randomInt(0, 100) }),
      },
    ],
  },

  // ============ set_volume ============
  {
    tool: 'set_volume',
    variations: [
      {
        patterns: [
          'Set volume to {level}',
          'Set the volume to {level} percent',
          'Change volume to {level}%',
          'Volume {level}',
          'Put the volume at {level}',
          'Adjust volume to {level}',
          'Can you set volume to {level}?',
          'Set media volume to {level}',
        ],
        argGenerator: () => ({ stream: 'media', level: randomInt(0, 100) }),
      },
      {
        patterns: [
          'Set the ring volume to {level}',
          'Change ringtone volume to {level}',
          'Ringtone volume {level}',
          'Set ringer to {level} percent',
          'Put ring volume at {level}',
          'Adjust the ringer volume to {level}',
        ],
        argGenerator: () => ({ stream: 'ring', level: randomInt(0, 100) }),
      },
      {
        patterns: [
          'Set alarm volume to {level}',
          'Change the alarm volume to {level}',
          'Alarm volume {level}',
          'Put alarm sound at {level} percent',
        ],
        argGenerator: () => ({ stream: 'alarm', level: randomInt(0, 100) }),
      },
      {
        patterns: [
          'Mute the phone',
          'Set volume to zero',
          'Silence the device',
          'Turn the volume all the way down',
          'Mute everything',
          'Volume off',
        ],
        argGenerator: () => ({ stream: 'media', level: 0 }),
      },
      {
        patterns: [
          'Max volume',
          'Turn it up to the max',
          'Full volume',
          'Volume all the way up',
          'Crank up the volume',
          'Maximum volume please',
        ],
        argGenerator: () => ({ stream: 'media', level: 100 }),
      },
      {
        patterns: [
          'Turn the notification volume to {level}',
          'Set notification sound to {level}',
          'Notification volume {level}',
        ],
        argGenerator: () => ({ stream: 'notification', level: randomInt(0, 100) }),
      },
      {
        patterns: [
          'Set call volume to {level}',
          'Change the voice call volume to {level}',
          'Adjust the in-call volume to {level}',
        ],
        argGenerator: () => ({ stream: 'voice', level: randomInt(0, 100) }),
      },
      {
        patterns: [
          'volum {level}',
          'set vol to {level}',
          'valume {level}',
        ],
        argGenerator: () => ({ stream: 'media', level: randomInt(0, 100) }),
      },
    ],
  },

  // ============ toggle_bluetooth ============
  {
    tool: 'toggle_bluetooth',
    variations: [
      {
        patterns: [
          'Turn on Bluetooth',
          'Enable Bluetooth',
          'Switch on BT',
          'Activate Bluetooth',
          'Turn Bluetooth on',
          'Can you turn on Bluetooth?',
          'Please enable Bluetooth',
          'I need Bluetooth on',
          'Start Bluetooth',
          'Power on Bluetooth',
        ],
        argGenerator: () => ({ enable: true }),
      },
      {
        patterns: [
          'Turn off Bluetooth',
          'Disable Bluetooth',
          'Switch off BT',
          'Deactivate Bluetooth',
          'Turn Bluetooth off',
          'Can you turn off Bluetooth?',
          'Please disable Bluetooth',
          'Stop Bluetooth',
          'Power off Bluetooth',
          'Kill Bluetooth',
        ],
        argGenerator: () => ({ enable: false }),
      },
      {
        patterns: [
          'blueetooth on',
          'enbale bluetooth',
          'turn on BT pls',
          'bluetooth plz',
        ],
        argGenerator: () => ({ enable: true }),
      },
      {
        patterns: [
          'bluetooth off',
          'disable bt',
          'turn off BT',
          'no more bluetooth',
        ],
        argGenerator: () => ({ enable: false }),
      },
    ],
  },

  // ============ toggle_dnd ============
  {
    tool: 'toggle_dnd',
    variations: [
      {
        patterns: [
          'Turn on Do Not Disturb',
          'Enable DND',
          'Activate Do Not Disturb mode',
          'Switch on DND',
          'Put my phone on Do Not Disturb',
          'Enable do not disturb',
          'Can you turn on DND?',
          'Please activate DND mode',
          'I want Do Not Disturb on',
          'Silence my phone with DND',
          'Go into DND mode',
          'Set Do Not Disturb to on',
        ],
        argGenerator: () => ({ enable: true }),
      },
      {
        patterns: [
          'Turn off Do Not Disturb',
          'Disable DND',
          'Deactivate Do Not Disturb mode',
          'Switch off DND',
          'Take my phone off Do Not Disturb',
          'Disable do not disturb',
          'Can you turn off DND?',
          'Stop DND mode',
          'Exit Do Not Disturb',
          'Remove DND',
        ],
        argGenerator: () => ({ enable: false }),
      },
      {
        patterns: [
          'dnd on',
          'do not disturb pls',
          'silence notifications',
          'dont disturb mode',
        ],
        argGenerator: () => ({ enable: true }),
      },
    ],
  },

  // ============ toggle_rotation_lock ============
  {
    tool: 'toggle_rotation_lock',
    variations: [
      {
        patterns: [
          'Lock screen rotation',
          'Enable rotation lock',
          'Turn on rotation lock',
          'Stop the screen from rotating',
          'Lock the orientation',
          'Disable auto-rotate',
          'Keep the screen in portrait mode',
          'Prevent screen rotation',
          'Fix the screen orientation',
          'Turn off auto rotate',
        ],
        argGenerator: () => ({ enable: true }),
      },
      {
        patterns: [
          'Unlock screen rotation',
          'Disable rotation lock',
          'Turn off rotation lock',
          'Enable auto-rotate',
          'Let the screen rotate',
          'Allow screen rotation',
          'Turn on auto rotate',
          'Unlock the orientation',
        ],
        argGenerator: () => ({ enable: false }),
      },
      {
        patterns: [
          'lock rotation',
          'rotation lock on',
          'stop rotating',
          'fix screen orientation',
        ],
        argGenerator: () => ({ enable: true }),
      },
    ],
  },

  // ============ set_alarm ============
  {
    tool: 'set_alarm',
    variations: [
      {
        patterns: [
          'Set an alarm for {hour}:{minutes_pad}',
          'Wake me up at {hour}:{minutes_pad}',
          'Set alarm {hour}:{minutes_pad}',
          'Alarm at {hour}:{minutes_pad}',
          'Can you set an alarm for {hour}:{minutes_pad}?',
          'Please set an alarm at {hour}:{minutes_pad}',
          'I need an alarm at {hour}:{minutes_pad}',
          'Create an alarm for {hour}:{minutes_pad}',
        ],
        argGenerator: () => {
          const h = randomInt(0, 23);
          const m = pick([0, 15, 30, 45, randomInt(0, 59)]);
          return { hour: h, minutes: m };
        },
      },
      {
        patterns: [
          'Set an alarm for {hour} AM',
          'Wake me up at {hour} in the morning',
          'Alarm for {hour} AM',
          'Set a morning alarm for {hour}',
        ],
        argGenerator: () => ({ hour: randomInt(4, 11), minutes: 0 }),
      },
      {
        patterns: [
          'Set an alarm for {hour} PM',
          'Set an alarm for {hour} in the evening',
          'Alarm for {hour} PM',
          'Evening alarm at {hour}',
        ],
        argGenerator: () => {
          const h12 = randomInt(1, 11);
          return { hour: h12 + 12, minutes: 0 };
        },
      },
      {
        patterns: [
          'Set an alarm for {hour}:{minutes_pad} called {message}',
          'Wake me up at {hour}:{minutes_pad} with label {message}',
          'Alarm at {hour}:{minutes_pad} named {message}',
        ],
        argGenerator: () => {
          const h = randomInt(5, 9);
          const m = pick([0, 15, 30]);
          const labels = ['Work', 'Gym', 'Morning run', 'Meeting', 'School', 'Medicine', 'Walk the dog'];
          return { hour: h, minutes: m, message: pick(labels) };
        },
      },
      {
        patterns: [
          'set alarm {hour}:{minutes_pad}',
          'alarm {hour} {minutes_pad}',
          'wake me {hour}:{minutes_pad}',
        ],
        argGenerator: () => {
          const h = randomInt(5, 10);
          const m = pick([0, 30]);
          return { hour: h, minutes: m };
        },
      },
    ],
  },

  // ============ set_timer ============
  {
    tool: 'set_timer',
    variations: [
      {
        patterns: [
          'Set a timer for {display}',
          'Timer for {display}',
          'Start a {display} timer',
          'Can you set a timer for {display}?',
          'Please set a timer for {display}',
          'I need a timer for {display}',
          'Count down {display}',
        ],
        argGenerator: () => {
          const s = pick([30, 60, 120, 180, 300, 600, 900, 1200, 1800, 3600]);
          return { seconds: s };
        },
      },
      {
        patterns: [
          'Set a timer for {min} minutes',
          'Timer {min} minutes',
          'Start a {min}-minute timer',
          '{min} minute timer',
          '{min} min timer please',
        ],
        argGenerator: () => {
          const m = pick([1, 2, 3, 5, 10, 15, 20, 25, 30, 45, 60]);
          return { seconds: m * 60 };
        },
      },
      {
        patterns: [
          'Set a timer for {sec} seconds',
          'Timer for {sec} seconds',
          '{sec} second timer',
          'Count down from {sec} seconds',
        ],
        argGenerator: () => {
          const s = pick([10, 15, 20, 30, 45, 60, 90]);
          return { seconds: s };
        },
      },
      {
        patterns: [
          'Set a timer for {display} called {message}',
          'Timer for {display} labeled {message}',
          '{display} timer for {message}',
        ],
        argGenerator: () => {
          const m = pick([1, 3, 5, 10, 15, 20, 30]);
          const labels = ['Eggs', 'Laundry', 'Pasta', 'Tea', 'Break', 'Workout', 'Study', 'Nap'];
          return { seconds: m * 60, message: pick(labels) };
        },
      },
      {
        patterns: [
          'timer {min} min',
          'set timer {sec} sec',
          'countdown {min} minutes',
        ],
        argGenerator: () => {
          const m = pick([1, 5, 10, 15]);
          return { seconds: m * 60 };
        },
      },
    ],
  },

  // ============ toggle_airplane_mode ============
  {
    tool: 'toggle_airplane_mode',
    variations: [
      {
        patterns: [
          'Turn on airplane mode',
          'Enable airplane mode',
          'Switch to airplane mode',
          'Activate airplane mode',
          'Put my phone in airplane mode',
          'Go into flight mode',
          'Turn on flight mode',
          'Enable flight mode',
          'Can you turn on airplane mode?',
          'I need airplane mode on',
        ],
        argGenerator: () => ({}),
      },
      {
        patterns: [
          'Turn off airplane mode',
          'Disable airplane mode',
          'Switch off airplane mode',
          'Deactivate airplane mode',
          'Take my phone out of airplane mode',
          'Exit flight mode',
          'Turn off flight mode',
          'Disable flight mode',
        ],
        argGenerator: () => ({}),
      },
      {
        patterns: [
          'airplane mode',
          'flight mode on',
          'arplane mode',
          'airplane mode pls',
        ],
        argGenerator: () => ({}),
      },
    ],
  },

  // ============ open_settings_page ============
  {
    tool: 'open_settings_page',
    variations: [
      {
        patterns: [
          'Open {page} settings',
          'Go to {page} settings',
          'Show me the {page} settings',
          'Take me to {page} settings',
          'Open the {page} settings page',
          'Navigate to {page} settings',
          'Can you open {page} settings?',
        ],
        argGenerator: () => ({
          page: pick(['wifi', 'bluetooth', 'display', 'sound', 'battery', 'storage', 'location', 'security', 'accounts', 'accessibility', 'notifications', 'apps', 'about', 'developer', 'date', 'language', 'privacy', 'vpn', 'nfc', 'data_usage']),
        }),
      },
      {
        patterns: [
          'Open WiFi settings',
          'Go to WiFi',
          'Show WiFi settings',
        ],
        argGenerator: () => ({ page: 'wifi' }),
      },
      {
        patterns: [
          'Open Bluetooth settings',
          'Go to Bluetooth settings',
          'Bluetooth settings',
        ],
        argGenerator: () => ({ page: 'bluetooth' }),
      },
      {
        patterns: [
          'Open display settings',
          'Display settings',
          'Screen settings',
        ],
        argGenerator: () => ({ page: 'display' }),
      },
      {
        patterns: [
          'Open battery settings',
          'Battery settings',
          'Check battery settings',
          'Show me battery info',
        ],
        argGenerator: () => ({ page: 'battery' }),
      },
      {
        patterns: [
          'Open location settings',
          'Location settings',
          'GPS settings',
        ],
        argGenerator: () => ({ page: 'location' }),
      },
      {
        patterns: [
          'settings {page}',
          'open {page}',
          '{page} settings plz',
        ],
        argGenerator: () => ({
          page: pick(['wifi', 'bluetooth', 'display', 'sound', 'battery', 'notifications']),
        }),
      },
    ],
  },

  // ============ take_screenshot ============
  {
    tool: 'take_screenshot',
    variations: [
      {
        patterns: [
          'Take a screenshot',
          'Screenshot',
          'Capture the screen',
          'Take a screen capture',
          'Can you take a screenshot?',
          'Please take a screenshot',
          'Grab a screenshot',
          'Screen grab',
          'Save this screen',
          'Capture what\'s on screen',
          'Screenshot this',
          'screenshoot',
          'take screenshit',
          'screenshot pls',
        ],
        argGenerator: () => ({}),
      },
    ],
  },
];

/**
 * Generate a user message from a pattern and arguments.
 */
export function fillPattern(pattern: string, args: Record<string, any>): string {
  let result = pattern;
  for (const [key, value] of Object.entries(args)) {
    result = result.replace(new RegExp(`\\{${key}\\}`, 'g'), String(value));
  }
  // Handle {minutes_pad} - pad minutes with leading zero
  if (args.minutes !== undefined) {
    result = result.replace(/\{minutes_pad\}/g, String(args.minutes).padStart(2, '0'));
  }
  // Handle {display} for timers
  if (args.seconds !== undefined) {
    const mins = Math.floor(args.seconds / 60);
    const secs = args.seconds % 60;
    const display = mins > 0
      ? (secs > 0 ? `${mins} minutes and ${secs} seconds` : `${mins} minute${mins > 1 ? 's' : ''}`)
      : `${secs} seconds`;
    result = result.replace(/\{display\}/g, display);
  }
  if (args.seconds !== undefined) {
    result = result.replace(/\{min\}/g, String(Math.floor(args.seconds / 60)));
    result = result.replace(/\{sec\}/g, String(args.seconds));
  }
  return result;
}
