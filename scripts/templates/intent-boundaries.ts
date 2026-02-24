/**
 * Intent boundary templates (negative examples).
 * These are user messages where the model should reply with text,
 * NOT with a tool call. Used to teach the model intent routing.
 */

export interface BoundaryTemplate {
  patterns: string[];
  responseHints: string[];
}

export const INTENT_BOUNDARY_TEMPLATES: BoundaryTemplate[] = [
  // Informational questions about tools (should NOT trigger the tool)
  {
    patterns: [
      'How does brightness work on Android?',
      'What does the brightness setting do?',
      'Can you explain screen brightness levels?',
      'What is the maximum brightness on my phone?',
      'How do I manually adjust brightness?',
      'Why does my brightness keep changing?',
    ],
    responseHints: [
      'Screen brightness controls how bright your display is. You can adjust it from 0 (dimmest) to 100 (brightest). Would you like me to set the brightness for you?',
      'Brightness on Android ranges from 0% to 100%. Auto-brightness adjusts it based on ambient light. I can set a specific level if you\'d like.',
    ],
  },
  {
    patterns: [
      'What is Do Not Disturb mode?',
      'How does DND work?',
      'What does enabling DND do?',
      'Can you explain Do Not Disturb?',
      'What notifications are blocked by DND?',
    ],
    responseHints: [
      'Do Not Disturb (DND) silences calls, alerts, and notifications. Some priority contacts can still reach you depending on your settings. Would you like me to enable it?',
    ],
  },
  {
    patterns: [
      'What is Bluetooth?',
      'How does Bluetooth work?',
      'What can I connect with Bluetooth?',
      'Is Bluetooth safe to leave on?',
      'Does Bluetooth drain battery?',
    ],
    responseHints: [
      'Bluetooth is a wireless technology for connecting devices like headphones, speakers, and keyboards. It uses minimal battery on modern phones. Want me to turn it on?',
    ],
  },

  // General knowledge questions
  {
    patterns: [
      'What time is it?',
      'What day is today?',
      'What is the weather like?',
      'How is the weather today?',
      'What is the date?',
      "What's the current time?",
      'Is it going to rain today?',
    ],
    responseHints: [
      'I can help with that! Let me check the current time for you.',
      "I don't have access to real-time weather data, but I can help with device settings.",
    ],
  },
  {
    patterns: [
      'Tell me a joke',
      'Say something funny',
      'Make me laugh',
      'Do you know any jokes?',
      'Tell me something interesting',
    ],
    responseHints: [
      "Why don't scientists trust atoms? Because they make up everything!",
      "Sure! Here's one: What do you call a fake noodle? An impasta!",
    ],
  },
  {
    patterns: [
      'Who are you?',
      'What can you do?',
      'What are your capabilities?',
      'How can you help me?',
      'What tools do you have?',
      'List your abilities',
    ],
    responseHints: [
      "I'm your personal assistant. I can control your device settings like brightness, volume, Bluetooth, and DND. I can also set alarms, timers, create calendar events, send emails, and more!",
    ],
  },
  {
    patterns: [
      'Thank you',
      'Thanks',
      'Thanks a lot',
      'Appreciate it',
      'Awesome, thanks!',
      'That was helpful',
      'Good job',
    ],
    responseHints: [
      "You're welcome! Let me know if you need anything else.",
      'Happy to help! Is there anything else I can do for you?',
    ],
  },
  {
    patterns: [
      'Hello',
      'Hi',
      'Hey',
      'Good morning',
      'Good evening',
      'How are you?',
      "What's up?",
      'Yo',
    ],
    responseHints: [
      "Hello! How can I help you today? I can control your device settings, set alarms, timers, and more.",
      "Hi there! What can I do for you?",
    ],
  },

  // Math and calculation questions
  {
    patterns: [
      'What is 2 + 2?',
      'Calculate 15 times 30',
      'How much is 100 divided by 7?',
      'What is the square root of 144?',
      'Convert 72 Fahrenheit to Celsius',
    ],
    responseHints: [
      '2 + 2 = 4',
      '15 times 30 = 450',
      '100 / 7 is approximately 14.29',
    ],
  },

  // Translation requests
  {
    patterns: [
      'How do you say hello in Spanish?',
      'Translate good morning to French',
      'What is thank you in Japanese?',
      'How to say goodbye in German?',
    ],
    responseHints: [
      'Hello in Spanish is "Hola".',
      'Good morning in French is "Bonjour".',
    ],
  },

  // Similar-sounding but non-actionable
  {
    patterns: [
      "What is my phone's brightness currently set to?",
      'Can you check the current volume level?',
      'Is Bluetooth on or off right now?',
      'Is DND currently enabled?',
      'What is the current rotation lock status?',
      "What's my alarm set for?",
    ],
    responseHints: [
      "I can set your brightness but I can't check the current level. Would you like me to set it to a specific value?",
      "I don't have access to read the current volume level, but I can set it for you. What level would you like?",
    ],
  },

  // Ambiguous requests that need clarification
  {
    patterns: [
      'Set it to 50',
      'Turn it on',
      'Turn it off',
      'Make it louder',
      'Make it quieter',
      'Change it',
      'Fix it',
    ],
    responseHints: [
      "Could you be more specific? Would you like me to set the brightness or volume to 50?",
      "I'd be happy to help! What would you like me to turn on? Flashlight, Bluetooth, DND?",
    ],
  },

  // Technology and phone questions
  {
    patterns: [
      'How much storage do I have left?',
      'What is my battery percentage?',
      'How much RAM does my phone have?',
      'What Android version am I running?',
      'Is my phone rooted?',
    ],
    responseHints: [
      "I don't have access to check your storage, but I can open the storage settings page for you. Would you like me to do that?",
    ],
  },

  // Recipe and cooking (should not trigger timer despite mention of time)
  {
    patterns: [
      'How long should I cook pasta?',
      'What temperature should I bake chicken at?',
      'How do you make scrambled eggs?',
      'Give me a recipe for chocolate cake',
    ],
    responseHints: [
      'Pasta typically cooks for 8-12 minutes depending on the type. Would you like me to set a timer for that?',
    ],
  },
];
