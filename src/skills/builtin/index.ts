/**
 * Built-in skills. The first is the PRD §21 flagship: Meeting Preparation.
 * All are ordinary manifests — validated, permission-checked and executed
 * exactly like user-created skills.
 */
import type { SkillManifest } from '../types';

export const MEETING_PREPARATION: SkillManifest = {
  name: 'meeting-preparation',
  version: '1.0.0',
  description:
    'Prepare for a meeting: summarize urgent notifications, enable Do Not Disturb, draft replies (never sent without approval).',
  publisher: 'LiquidChat',
  permissions: ['special:notification_listener', 'special:notification_policy'],
  triggers: [
    { type: 'manual' },
    {
      type: 'phrase',
      phrases: [
        'going into a meeting',
        'meeting prep',
        'prepare for my meeting',
        'prepare me for the meeting',
        'heading into a meeting',
      ],
    },
  ],
  steps: [
    {
      id: 'notifications',
      tool: 'notifications.recent',
      args: { sinceMinutes: 180, limit: 40 },
      description: 'Read authorized notifications',
    },
    {
      id: 'urgent',
      operation: 'summarize',
      dataClass: 'personal',
      dependsOn: ['notifications'],
      prompt:
        'From these notifications, list only the items that need my attention before or during a meeting (people waiting on me, deadlines, incidents). Group by app, at most 6 bullets, each with who and what. If nothing is urgent, say so.\n{{steps.notifications.output}}',
    },
    {
      id: 'dnd',
      tool: 'toggle_dnd',
      args: { enable: true },
      requiresApproval: true,
      description: 'Enable Do Not Disturb',
    },
    {
      id: 'replies',
      operation: 'respond',
      dataClass: 'personal',
      dependsOn: ['urgent'],
      prompt:
        'Draft a one-line suggested reply for each urgent item below, polite and brief, e.g. "In a meeting until 4, will reply after." These are drafts only and will not be sent.\n{{steps.urgent.output}}',
    },
    {
      id: 'briefing',
      operation: 'respond',
      dataClass: 'personal',
      dependsOn: ['urgent', 'replies'],
      prompt:
        'Write my pre-meeting briefing with two short sections, "Urgent" and "Suggested replies (not sent)".\nUrgent: {{steps.urgent.output}}\nReplies: {{steps.replies.output}}',
    },
  ],
  responseStep: 'briefing',
};

export const MORNING_BRIEFING: SkillManifest = {
  name: 'morning-briefing',
  version: '1.0.0',
  description:
    'Morning brief: today’s tasks and meeting action items, overnight notifications and phone status.',
  publisher: 'LiquidChat',
  permissions: ['special:notification_listener'],
  triggers: [
    { type: 'daily', time: '08:30' },
    {
      type: 'phrase',
      phrases: ['morning briefing', 'brief me', 'what is on today', "what's on today"],
    },
  ],
  steps: [
    { id: 'time', tool: 'time.now', args: {} },
    { id: 'tasks', tool: 'tasks.list', args: { view: 'today', limit: 15 } },
    { id: 'overdue', tool: 'tasks.list', args: { view: 'overdue', limit: 10 } },
    { id: 'notifications', tool: 'notifications.recent', args: { sinceMinutes: 720, limit: 40 } },
    {
      id: 'brief',
      operation: 'summarize',
      dataClass: 'personal',
      dependsOn: ['time', 'tasks', 'overdue', 'notifications'],
      prompt:
        'Write a short morning briefing for {{steps.time.output.weekday}} {{steps.time.output.date}}: 1) due today, 2) overdue, 3) notifications that need action. Max 10 bullets total, most important first.\nToday: {{steps.tasks.output}}\nOverdue: {{steps.overdue.output}}\nNotifications: {{steps.notifications.output}}',
    },
  ],
  responseStep: 'brief',
};

export const FOCUS_MODE: SkillManifest = {
  name: 'focus-mode',
  version: '1.0.0',
  description: 'Silence the phone for a focus block: Do Not Disturb, ringer off and a timer.',
  publisher: 'LiquidChat',
  permissions: ['special:notification_policy'],
  triggers: [
    { type: 'manual' },
    { type: 'phrase', phrases: ['focus mode', 'start a focus block', 'do not disturb me for'] },
  ],
  inputs: { seconds: { type: 'number', description: 'Focus duration in seconds', default: 3600 } },
  steps: [
    { id: 'dnd', tool: 'toggle_dnd', args: { enable: true } },
    { id: 'ring', tool: 'set_volume', args: { stream: 'ring', level: 0 }, dependsOn: ['dnd'] },
    {
      id: 'timer',
      tool: 'set_timer',
      args: { seconds: '{{inputs.seconds}}', message: 'Focus block over' },
      dependsOn: ['ring'],
    },
  ],
};

export const MEETING_FOLLOWUP: SkillManifest = {
  name: 'meeting-followup',
  version: '1.0.0',
  description:
    'Draft a follow-up email from the latest meeting and open it for review (sending always needs approval).',
  publisher: 'LiquidChat',
  permissions: [],
  triggers: [
    { type: 'manual' },
    {
      type: 'phrase',
      phrases: ['send the follow-up', 'follow up on the meeting', 'meeting follow-up email'],
    },
  ],
  inputs: { client: { type: 'string', description: 'Client name (optional)', default: '' } },
  steps: [
    { id: 'meeting', tool: 'meetings.latest', args: { client: '{{inputs.client}}' } },
    {
      id: 'draft',
      operation: 'extract',
      dataClass: 'personal',
      dependsOn: ['meeting'],
      prompt:
        'Write a follow-up email to the first attendee with an email address: thank them, recap decisions, list action items with owners and dates. Return JSON {"to": email, "subject": string, "body": string}.\n{{steps.meeting.output}}',
      outputSchema: {
        type: 'object',
        properties: {
          to: { type: 'string', format: 'email' },
          subject: { type: 'string', minLength: 3 },
          body: { type: 'string', minLength: 20 },
        },
        required: ['to', 'subject', 'body'],
      },
    },
    {
      id: 'compose',
      tool: 'send_email',
      args: {
        to: '{{steps.draft.output.to}}',
        subject: '{{steps.draft.output.subject}}',
        body: '{{steps.draft.output.body}}',
      },
      dependsOn: ['draft'],
      requiresApproval: true,
    },
  ],
};

export const END_OF_DAY: SkillManifest = {
  name: 'end-of-day',
  version: '1.0.0',
  description: 'End-of-day wrap-up: what is still open and the top three for tomorrow.',
  publisher: 'LiquidChat',
  permissions: [],
  triggers: [
    { type: 'daily', time: '18:30', days: [1, 2, 3, 4, 5] },
    { type: 'phrase', phrases: ['wrap up my day', 'end of day summary'] },
  ],
  steps: [
    { id: 'open', tool: 'tasks.list', args: { view: 'open', limit: 30 } },
    {
      id: 'wrap',
      operation: 'summarize',
      dataClass: 'personal',
      dependsOn: ['open'],
      prompt:
        'Summarize what is still open in 3 bullets and propose my top three for tomorrow, most impactful first.\n{{steps.open.output}}',
    },
  ],
  responseStep: 'wrap',
};

export const BUILTIN_SKILLS: SkillManifest[] = [
  MEETING_PREPARATION,
  MORNING_BRIEFING,
  FOCUS_MODE,
  MEETING_FOLLOWUP,
  END_OF_DAY,
];
