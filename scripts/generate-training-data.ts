#!/usr/bin/env npx ts-node
/**
 * Synthetic Training Data Generator for LiquidChat
 *
 * Generates JSONL training data matching the exact format used by chatExport.ts
 * for LoRA fine-tuning to teach the model new system control tools.
 *
 * Usage:
 *   npx ts-node scripts/generate-training-data.ts --output data/
 *   npx ts-node scripts/generate-training-data.ts --system-controls 5000 --compound 3000 --boundaries 2000
 *   npx ts-node scripts/generate-training-data.ts --seed 42 --output data/
 */

import * as fs from 'fs';
import * as path from 'path';
import {
  SYSTEM_CONTROL_TEMPLATES,
  fillPattern,
} from './templates/system-controls';
import {
  COMPOUND_TEMPLATES,
  fillCompoundPattern,
} from './templates/compound-actions';
import { INTENT_BOUNDARY_TEMPLATES } from './templates/intent-boundaries';

// ===== PRNG (seedable) =====

class SeededRandom {
  private state: number;

  constructor(seed: number) {
    this.state = seed;
  }

  next(): number {
    // xorshift32
    this.state ^= this.state << 13;
    this.state ^= this.state >> 17;
    this.state ^= this.state << 5;
    return (this.state >>> 0) / 4294967296;
  }

  int(min: number, max: number): number {
    return Math.floor(this.next() * (max - min + 1)) + min;
  }

  pick<T>(arr: T[]): T {
    return arr[Math.floor(this.next() * arr.length)];
  }

  shuffle<T>(arr: T[]): T[] {
    const result = [...arr];
    for (let i = result.length - 1; i > 0; i--) {
      const j = Math.floor(this.next() * (i + 1));
      [result[i], result[j]] = [result[j], result[i]];
    }
    return result;
  }
}

// ===== Tool definitions (must match registry.ts exactly) =====

const MOBILE_ACTION_TOOLS = [
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

function buildSystemPrompt(): string {
  const now = new Date();
  const dayOfWeek = ['Sunday', 'Monday', 'Tuesday', 'Wednesday', 'Thursday', 'Friday', 'Saturday'];
  return `Current date and time given in YYYY-MM-DDTHH:MM:SS format: ${now.toISOString().slice(0, 19)}\nDay of week is ${dayOfWeek[now.getDay()]}\nYou are a model that can do function calling with the following functions\n\n${JSON.stringify(MOBILE_ACTION_TOOLS)}`;
}

// ===== Sample types =====

interface TrainingSample {
  messages: Array<{
    role: string;
    content: string | null;
    tool_calls?: Array<{ function: { name: string; arguments: Record<string, any> } }>;
  }>;
  metadata: {
    source: string;
    category: string;
    tool?: string;
    tools?: string[];
  };
}

// ===== Generators =====

let rng: SeededRandom;

function overrideRandom(): void {
  // Monkey-patch Math.random so template argGenerators use our seeded PRNG
  const originalRandom = Math.random;
  Math.random = () => rng.next();
  // Store for cleanup (not needed since this is a CLI script)
}

function generateSystemControlSamples(count: number): TrainingSample[] {
  const samples: TrainingSample[] = [];
  const systemPrompt = buildSystemPrompt();

  // Distribute samples across all tools proportionally
  const totalVariations = SYSTEM_CONTROL_TEMPLATES.reduce(
    (sum, t) => sum + t.variations.reduce((vs, v) => vs + v.patterns.length, 0),
    0,
  );

  let generated = 0;
  while (generated < count) {
    for (const template of SYSTEM_CONTROL_TEMPLATES) {
      for (const variation of template.variations) {
        for (const pattern of variation.patterns) {
          if (generated >= count) break;

          const args = variation.argGenerator();
          const userMessage = fillPattern(pattern, args);

          // Clean arguments: remove display/pad helpers, keep only real args
          const cleanArgs: Record<string, any> = {};
          for (const [key, value] of Object.entries(args)) {
            if (!key.endsWith('_pad') && key !== 'display' && key !== 'min' && key !== 'sec') {
              cleanArgs[key] = value;
            }
          }

          samples.push({
            messages: [
              { role: 'system', content: systemPrompt },
              { role: 'user', content: userMessage },
              {
                role: 'assistant',
                content: null,
                tool_calls: [
                  { function: { name: template.tool, arguments: cleanArgs } },
                ],
              },
            ],
            metadata: {
              source: 'synthetic',
              category: 'system_controls',
              tool: template.tool,
            },
          });

          generated++;
        }
      }
    }
  }

  return samples.slice(0, count);
}

function generateCompoundSamples(count: number): TrainingSample[] {
  const samples: TrainingSample[] = [];
  const systemPrompt = buildSystemPrompt();

  let generated = 0;
  while (generated < count) {
    for (const template of COMPOUND_TEMPLATES) {
      for (const pattern of template.patterns) {
        if (generated >= count) break;

        const toolsArgs = template.tools.map(t => ({
          name: t.name,
          args: t.argGenerator(),
        }));

        const userMessage = fillCompoundPattern(pattern, toolsArgs);

        const toolCalls = toolsArgs.map(ta => {
          const cleanArgs: Record<string, any> = {};
          for (const [key, value] of Object.entries(ta.args)) {
            if (!key.endsWith('_pad') && key !== 'display' && key !== 'min' && key !== 'sec') {
              cleanArgs[key] = value;
            }
          }
          return { function: { name: ta.name, arguments: cleanArgs } };
        });

        samples.push({
          messages: [
            { role: 'system', content: systemPrompt },
            { role: 'user', content: userMessage },
            {
              role: 'assistant',
              content: null,
              tool_calls: toolCalls,
            },
          ],
          metadata: {
            source: 'synthetic',
            category: 'compound_actions',
            tools: toolsArgs.map(t => t.name),
          },
        });

        generated++;
      }
    }
  }

  return samples.slice(0, count);
}

function generateBoundarySamples(count: number): TrainingSample[] {
  const samples: TrainingSample[] = [];
  const systemPrompt = buildSystemPrompt();

  let generated = 0;
  while (generated < count) {
    for (const template of INTENT_BOUNDARY_TEMPLATES) {
      for (const pattern of template.patterns) {
        if (generated >= count) break;

        const response = rng.pick(template.responseHints);

        samples.push({
          messages: [
            { role: 'system', content: systemPrompt },
            { role: 'user', content: pattern },
            { role: 'assistant', content: response },
          ],
          metadata: {
            source: 'synthetic',
            category: 'intent_boundary',
          },
        });

        generated++;
      }
    }
  }

  return samples.slice(0, count);
}

// ===== CLI =====

function parseArgs(argv: string[]): {
  output: string;
  systemControls: number;
  compound: number;
  boundaries: number;
  seed: number;
  evalSplit: number;
} {
  const args = {
    output: 'data',
    systemControls: 5000,
    compound: 3000,
    boundaries: 2000,
    seed: 42,
    evalSplit: 0.1,
  };

  for (let i = 2; i < argv.length; i++) {
    switch (argv[i]) {
      case '--output':
        args.output = argv[++i];
        break;
      case '--system-controls':
        args.systemControls = parseInt(argv[++i], 10);
        break;
      case '--compound':
        args.compound = parseInt(argv[++i], 10);
        break;
      case '--boundaries':
        args.boundaries = parseInt(argv[++i], 10);
        break;
      case '--seed':
        args.seed = parseInt(argv[++i], 10);
        break;
      case '--eval-split':
        args.evalSplit = parseFloat(argv[++i]);
        break;
      case '--help':
        console.log(`
LiquidChat Synthetic Training Data Generator

Usage:
  npx ts-node scripts/generate-training-data.ts [options]

Options:
  --output <dir>           Output directory (default: data/)
  --system-controls <n>    Number of single-tool samples (default: 5000)
  --compound <n>           Number of compound action samples (default: 3000)
  --boundaries <n>         Number of intent boundary samples (default: 2000)
  --seed <n>               Random seed for reproducibility (default: 42)
  --eval-split <f>         Fraction for eval set (default: 0.1)
  --help                   Show this help
        `);
        process.exit(0);
    }
  }

  return args;
}

function main() {
  const args = parseArgs(process.argv);

  console.log('=== LiquidChat Training Data Generator ===');
  console.log(`Seed: ${args.seed}`);
  console.log(`System controls: ${args.systemControls}`);
  console.log(`Compound actions: ${args.compound}`);
  console.log(`Intent boundaries: ${args.boundaries}`);
  console.log(`Total target: ${args.systemControls + args.compound + args.boundaries}`);
  console.log('');

  // Initialize seeded PRNG
  rng = new SeededRandom(args.seed);
  overrideRandom();

  // Generate samples
  console.log('Generating system control samples...');
  const systemControlSamples = generateSystemControlSamples(args.systemControls);
  console.log(`  Generated: ${systemControlSamples.length}`);

  console.log('Generating compound action samples...');
  const compoundSamples = generateCompoundSamples(args.compound);
  console.log(`  Generated: ${compoundSamples.length}`);

  console.log('Generating intent boundary samples...');
  const boundarySamples = generateBoundarySamples(args.boundaries);
  console.log(`  Generated: ${boundarySamples.length}`);

  // Combine and shuffle
  const allSamples = rng.shuffle([
    ...systemControlSamples,
    ...compoundSamples,
    ...boundarySamples,
  ]);

  console.log(`\nTotal samples: ${allSamples.length}`);

  // Split into train/eval
  const evalCount = Math.round(allSamples.length * args.evalSplit);
  const evalSamples = allSamples.slice(0, evalCount);
  const trainSamples = allSamples.slice(evalCount);

  console.log(`Train: ${trainSamples.length}`);
  console.log(`Eval: ${evalSamples.length}`);

  // Write output
  const outputDir = path.resolve(args.output);
  if (!fs.existsSync(outputDir)) {
    fs.mkdirSync(outputDir, { recursive: true });
  }

  const trainPath = path.join(outputDir, 'train.jsonl');
  const evalPath = path.join(outputDir, 'eval.jsonl');

  fs.writeFileSync(
    trainPath,
    trainSamples.map(s => JSON.stringify(s)).join('\n') + '\n',
  );
  fs.writeFileSync(
    evalPath,
    evalSamples.map(s => JSON.stringify(s)).join('\n') + '\n',
  );

  console.log(`\nOutput written to:`);
  console.log(`  ${trainPath} (${trainSamples.length} samples)`);
  console.log(`  ${evalPath} (${evalSamples.length} samples)`);

  // Print distribution stats
  const toolDist: Record<string, number> = {};
  for (const s of allSamples) {
    const cat = s.metadata.category;
    toolDist[cat] = (toolDist[cat] || 0) + 1;
    if (s.metadata.tool) {
      const key = `  ${s.metadata.tool}`;
      toolDist[key] = (toolDist[key] || 0) + 1;
    }
  }

  console.log('\nDistribution:');
  for (const [key, count] of Object.entries(toolDist).sort()) {
    console.log(`  ${key}: ${count}`);
  }
}

main();
