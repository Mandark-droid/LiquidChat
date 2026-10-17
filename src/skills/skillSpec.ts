/**
 * The small-model path for "describe a skill in plain words". A 1.2B model cannot reliably write a
 * nested manifest (it drops fields, invents keys, puts operations in `tool`), but it can fill a flat
 * object. The manifest is then assembled here, so its structure is always right; the validator still
 * checks the chosen tools, permissions and approvals before the user reviews it.
 */
import type { ToolRegistry } from '../tools/ToolRegistry';
import { slugify } from './repairManifest';
import type { SkillManifest, SkillStep } from './types';

export const SPEC_EXAMPLE = {
  title: 'Meeting actions',
  tools: ['meetings.latest'],
  instruction: 'List the action items with owner and due date, one per line.',
  dailyAt: '',
  phrases: ['what did we agree'],
};

export function specPrompt(request: string, catalog: string): string {
  return `Tools:
${catalog}

User wants: """${request}"""

Pick the tools from the list that get the information needed, and say what to do with their results.
Reply with ONE JSON object with these keys only: title, tools, instruction, dailyAt, phrases.
- tools: tool names copied exactly from the list
- dailyAt: "HH:MM" if it should run every day at a time, otherwise ""
- phrases: short things the user might say to start it, or []
Example for "what were the action items of my last meeting":
${JSON.stringify(SPEC_EXAMPLE)}`;
}

const isObject = (v: unknown): v is Record<string, unknown> =>
  !!v && typeof v === 'object' && !Array.isArray(v);

function toolNames(raw: unknown, tools: ToolRegistry): string[] {
  const list = Array.isArray(raw) ? raw : typeof raw === 'string' ? raw.split(',') : [];
  const names = list
    .map(t =>
      typeof t === 'string' ? t.trim() : isObject(t) && typeof t.name === 'string' ? t.name : '',
    )
    .filter(n => !!n && !!tools.get(n));
  return [...new Set(names)].slice(0, 4);
}

function dailyTime(raw: unknown): string | null {
  const m = typeof raw === 'string' ? /^(\d{1,2}):(\d{2})$/.exec(raw.trim()) : null;
  if (!m) return null;
  const h = Number(m[1]);
  const min = Number(m[2]);
  return h < 24 && min < 60 ? `${String(h).padStart(2, '0')}:${m[2]}` : null;
}

const ACTION_WORDS =
  /\b(turn|enable|disable|set|send|email|call|text|mute|silence|toggle|create|add|delete|book|play)\b/i;

const PERIODS: [RegExp, string][] = [
  [/\bmorning\b/i, '08:00'],
  [/\bafternoon\b/i, '14:00'],
  [/\bevening\b/i, '19:00'],
  [/\b(night|tonight)\b/i, '21:00'],
];

/** "at 9 pm", "at 21:30", or "every evening" → "HH:MM"; null when no daily schedule is asked for. */
export function scheduleFrom(request: string): string | null {
  const clock = /\b(\d{1,2})(?::(\d{2}))?\s*(am|pm)\b|\bat\s+(\d{1,2}):(\d{2})\b/i.exec(request);
  if (clock) {
    let h = Number(clock[1] ?? clock[4]);
    const min = clock[2] ?? clock[5] ?? '00';
    const ampm = clock[3]?.toLowerCase();
    if (ampm === 'pm' && h < 12) h += 12;
    if (ampm === 'am' && h === 12) h = 0;
    if (h < 24 && Number(min) < 60) return `${String(h).padStart(2, '0')}:${min}`;
  }
  if (/\b(every|each|daily)\b/i.test(request))
    for (const [re, time] of PERIODS) if (re.test(request)) return time;
  return null;
}

/** "Every evening summarize my tasks" → "summarize my tasks". */
function withoutSchedule(request: string): string {
  return (
    request
      .replace(/\b(every|each)\s+(morning|afternoon|evening|night|day|weekday)\b,?/gi, '')
      .replace(/\b(daily|tonight)\b,?/gi, '')
      .replace(/\bat\s+\d{1,2}(:\d{2})?\s*(am|pm)?\b/gi, '')
      .replace(/\s{2,}/g, ' ')
      .trim() || request.trim()
  );
}

/**
 * The common skill — "on a schedule, gather something and summarize it" — built without asking a
 * model to design it: data tools come from relevance ranking, the schedule from the wording. Only
 * the agent's own read-only data tools that need no arguments qualify (not screen openers).
 */
export function heuristicManifest(
  request: string,
  tools: ToolRegistry,
  distribution: Parameters<ToolRegistry['relevant']>[2],
): SkillManifest | null {
  // A summary cannot carry out an action; those skills go to the model path.
  if (ACTION_WORDS.test(request)) return null;
  const stem = (w: string) => w.toLowerCase().replace(/s$/, '');
  const asked = new Set(
    request
      .split(/[^A-Za-z0-9]+/)
      .filter(w => w.length > 2)
      .map(stem),
  );
  const picks = tools
    .relevant(request, 8, distribution)
    .filter(
      t =>
        t.name.includes('.') &&
        !t.name.startsWith('mcp.') &&
        t.riskLevel === 'read_only' &&
        !t.inputSchema.required?.length &&
        t.name.split(/[^a-z0-9]+/).some(part => asked.has(stem(part))),
    )
    .slice(0, 2);
  if (!picks.length) return null;
  const what = withoutSchedule(request);
  return manifestFromSpec(
    {
      title: what,
      tools: picks.map(t => t.name),
      instruction: what,
      dailyAt: scheduleFrom(request) ?? '',
      phrases: [],
    },
    request,
    tools,
  );
}

/** Builds a manifest from the flat spec, or null when the spec names no usable tool. */
export function manifestFromSpec(
  spec: unknown,
  request: string,
  tools: ToolRegistry,
): SkillManifest | null {
  if (!isObject(spec)) return null;
  const names = toolNames(spec.tools, tools);
  if (!names.length) return null;

  const toolSteps: SkillStep[] = names.map((name, i) => {
    const t = tools.get(name)!;
    const sensitive = t.riskLevel === 'sensitive' || !!t.alwaysAsk;
    return {
      id: `t${i + 1}`,
      tool: name,
      args: {},
      ...(sensitive ? { requiresApproval: true } : {}),
    };
  });
  const ids = toolSteps.map(s => s.id);
  const instruction =
    typeof spec.instruction === 'string' && spec.instruction.trim()
      ? spec.instruction.trim().slice(0, 600)
      : request.trim();
  const answer: SkillStep = {
    id: 'answer',
    operation: 'summarize',
    dataClass: 'personal',
    dependsOn: ids,
    prompt: [instruction, ...ids.map(id => `{{steps.${id}.output}}`)].join(String.fromCharCode(10)),
  };

  const triggers: SkillManifest['triggers'] = [{ type: 'manual' }];
  const time = dailyTime(spec.dailyAt);
  if (time) triggers.push({ type: 'daily', time });
  const phrases = (Array.isArray(spec.phrases) ? spec.phrases : [])
    .filter((p): p is string => typeof p === 'string' && p.trim().length >= 3)
    .map(p => p.trim())
    .slice(0, 5);
  if (phrases.length) triggers.push({ type: 'phrase', phrases });

  const title = typeof spec.title === 'string' && spec.title.trim() ? spec.title : request;
  return {
    name: slugify(title),
    version: '1.0.0',
    description: request.trim().slice(0, 300) || 'Custom skill',
    permissions: [],
    triggers,
    steps: [...toolSteps, answer],
    responseStep: 'answer',
  };
}
