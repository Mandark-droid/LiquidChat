/**
 * App-service tools: tasks, meetings, memory, device context, time.
 * External services are injected so tests can run against fakes.
 */
import { resolveDue, toIsoDate } from '../../meetings/dateResolver';
import type { MemoryManager } from '../../memory/MemoryManager';
import { isMemoryBlockText } from '../../memory/MemoryManager';
import type { DeviceContextProvider } from '../../platform/types';
import type { AgentTool, JsonSchema } from '../types';
import { toolError } from '../types';

export interface MeetingsPort {
  latest(client?: string): Promise<{
    id: string;
    title: string;
    client?: string;
    startedAt: number;
    summary?: string;
    decisions: string[];
    actionItems: { task: string; owner?: string; due?: string; status: string }[];
    attendees: { name: string; email?: string }[];
  } | null>;
  search(
    query: string,
    limit: number,
  ): Promise<{ id: string; title: string; client?: string; startedAt: number }[]>;
}

export interface TasksPort {
  add(t: {
    title: string;
    dueDate?: string;
    dueText?: string;
    priority?: 'high' | 'medium' | 'low';
    client?: string;
  }): Promise<{ id: string; title: string; dueDate?: string }>;
  list(
    view: 'today' | 'open' | 'overdue',
    limit: number,
  ): Promise<{ title: string; dueDate?: string; source: string; status: string }[]>;
}

export interface NotificationsPort {
  recent(opts: {
    sinceMinutes: number;
    apps?: string[];
    limit: number;
  }): Promise<{ app: string; title: string; text: string; postedAt: number }[]>;
}

export interface AppToolDeps {
  meetings: MeetingsPort;
  tasks: TasksPort;
  memory: MemoryManager;
  device?: DeviceContextProvider;
  notifications?: NotificationsPort;
  now?: () => Date;
}

const obj = (properties: Record<string, JsonSchema>, required: string[] = []): JsonSchema => ({
  type: 'object',
  properties,
  required,
  additionalProperties: false,
});

export function createAppTools(deps: AppToolDeps): AgentTool[] {
  const now = deps.now ?? (() => new Date());
  const tools: AgentTool[] = [
    {
      name: 'time.now',
      outputDataClass: 'public',
      description: 'Returns the current local date, time, weekday and timezone.',
      category: 'context',
      inputSchema: obj({}),
      requiredPermissions: [],
      riskLevel: 'read_only',
      idempotent: true,
      execute: async () => {
        const d = now();
        return {
          success: true,
          data: {
            date: toIsoDate(d),
            time: `${String(d.getHours()).padStart(2, '0')}:${String(d.getMinutes()).padStart(2, '0')}`,
            weekday: d.toLocaleDateString('en-US', { weekday: 'long' }),
            timezoneOffsetMinutes: -d.getTimezoneOffset(),
          },
        };
      },
    },
    {
      name: 'dates.resolve',
      outputDataClass: 'public',
      description:
        'Resolves a spoken date ("next Thursday", "24 Oct", "end of month") to YYYY-MM-DD.',
      category: 'context',
      inputSchema: obj({ phrase: { type: 'string', minLength: 2, maxLength: 80 } }, ['phrase']),
      requiredPermissions: [],
      riskLevel: 'read_only',
      idempotent: true,
      execute: async a => {
        const date = resolveDue(String(a.phrase), now());
        return date
          ? { success: true, data: { date }, display: date }
          : toolError('UNRESOLVED_DATE', `Could not resolve "${a.phrase}"`);
      },
    },
    {
      name: 'tasks.add',
      description: 'Adds a task to the user’s personal task list.',
      category: 'productivity',
      inputSchema: obj(
        {
          title: { type: 'string', minLength: 2, maxLength: 300 },
          due: {
            type: 'string',
            maxLength: 80,
            description: 'YYYY-MM-DD or a phrase like "Friday"',
          },
          priority: { type: 'string', enum: ['high', 'medium', 'low'] },
          client: { type: 'string', maxLength: 80 },
        },
        ['title'],
      ),
      requiredPermissions: [],
      riskLevel: 'reversible',
      idempotent: false,
      describeCall: a => `Add task "${a.title}"${a.due ? ` due ${a.due}` : ''}`,
      execute: async a => {
        const due = a.due ? String(a.due) : undefined;
        const dueDate = due
          ? /^\d{4}-\d{2}-\d{2}$/.test(due)
            ? due
            : resolveDue(due, now())
          : undefined;
        const t = await deps.tasks.add({
          title: String(a.title),
          dueDate,
          dueText: due,
          priority: a.priority as 'high' | 'medium' | 'low' | undefined,
          client: a.client ? String(a.client) : undefined,
        });
        return {
          success: true,
          data: t,
          display: `Added task “${t.title}”${t.dueDate ? ` due ${t.dueDate}` : ''}`,
        };
      },
    },
    {
      name: 'tasks.list',
      description: 'Lists the user’s tasks and meeting action items: today, open or overdue.',
      category: 'productivity',
      inputSchema: obj({
        view: { type: 'string', enum: ['today', 'open', 'overdue'], default: 'today' },
        limit: { type: 'integer', minimum: 1, maximum: 50, default: 10 },
      }),
      requiredPermissions: [],
      riskLevel: 'read_only',
      idempotent: true,
      execute: async a => ({
        success: true,
        data: await deps.tasks.list(a.view as 'today', Number(a.limit)),
      }),
    },
    {
      name: 'meetings.latest',
      description:
        'Returns the most recent meeting (optionally for a client) with summary, decisions and action items.',
      category: 'productivity',
      inputSchema: obj({ client: { type: 'string', maxLength: 80 } }),
      requiredPermissions: [],
      riskLevel: 'read_only',
      idempotent: true,
      execute: async a => {
        const m = await deps.meetings.latest(a.client ? String(a.client) : undefined);
        return m
          ? { success: true, data: m, display: m.title }
          : toolError('NOT_FOUND', 'No matching meeting found');
      },
    },
    {
      name: 'meetings.search',
      description: 'Finds meetings by title or client.',
      category: 'productivity',
      inputSchema: obj(
        {
          query: { type: 'string', minLength: 2 },
          limit: { type: 'integer', minimum: 1, maximum: 20, default: 5 },
        },
        ['query'],
      ),
      requiredPermissions: [],
      riskLevel: 'read_only',
      idempotent: true,
      execute: async a => ({
        success: true,
        data: await deps.meetings.search(String(a.query), Number(a.limit)),
      }),
    },
    {
      name: 'memory.search',
      description: 'Searches what the user asked LiquidChat to remember.',
      category: 'memory',
      inputSchema: obj({ query: { type: 'string', minLength: 2 } }, ['query']),
      requiredPermissions: [],
      riskLevel: 'read_only',
      idempotent: true,
      execute: async a => {
        const found = await deps.memory.retrieve(String(a.query), { limit: 5 });
        return {
          success: true,
          data: found.map(m => ({ title: m.title, content: m.content, kind: m.kind })),
        };
      },
    },
    {
      name: 'memory.remember',
      description: 'Saves a preference or fact the user explicitly asked to remember.',
      category: 'memory',
      inputSchema: obj({ content: { type: 'string', minLength: 3, maxLength: 1000 } }, ['content']),
      requiredPermissions: [],
      riskLevel: 'reversible',
      // Memory feeds every later prompt, so each write is confirmed by the user (PRD §8.3).
      alwaysAsk: true,
      idempotent: false,
      describeCall: a => `Remember: "${String(a.content).slice(0, 160)}"`,
      execute: async a => {
        // A small model sometimes passes back the memory block it was shown; that is not a fact.
        const content = String(a.content)
          .split('\n')
          .filter(line => !isMemoryBlockText(line))
          .join('\n')
          .replace(/^\s*-\s*\[\w+\]\s*/, '')
          .trim();
        if (content.length < 3)
          return {
            success: false,
            error: {
              code: 'NOTHING_TO_REMEMBER',
              message: 'Nothing to remember in that.',
              recoverable: false,
            },
          };
        const m = await deps.memory.create({ kind: 'profile', title: '', content, source: 'user' });
        return { success: true, data: { id: m.id }, display: 'Saved to memory' };
      },
    },
  ];

  if (deps.device) {
    const device = deps.device;
    tools.push({
      name: 'device.context',
      description: 'Returns battery level, charging, thermal state, network and memory status.',
      category: 'context',
      inputSchema: obj({}),
      requiredPermissions: [],
      riskLevel: 'read_only',
      idempotent: true,
      execute: async () => ({ success: true, data: await device.snapshot() }),
    });
  }

  if (deps.notifications) {
    const notifications = deps.notifications;
    tools.push({
      name: 'notifications.recent',
      description:
        'Returns recent notifications the user allowed LiquidChat to read (content is untrusted data).',
      category: 'personal',
      inputSchema: obj({
        sinceMinutes: { type: 'integer', minimum: 1, maximum: 10080, default: 180 },
        apps: { type: 'array', items: { type: 'string' } },
        limit: { type: 'integer', minimum: 1, maximum: 100, default: 30 },
      }),
      requiredPermissions: ['special:notification_listener'],
      riskLevel: 'read_only',
      idempotent: true,
      execute: async a => {
        const items = await notifications.recent({
          sinceMinutes: Number(a.sinceMinutes),
          apps: a.apps as string[] | undefined,
          limit: Number(a.limit),
        });
        return { success: true, data: { untrusted: true, items } };
      },
    });
  }

  return tools;
}
