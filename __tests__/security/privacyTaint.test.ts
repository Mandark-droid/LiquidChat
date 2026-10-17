/**
 * Data-class taint (PRD §6.6): model steps inherit the privacy class of the
 * tool outputs they read, and on-device-only data never reaches a remote model
 * or a network tool — regardless of how the plan labelled the step.
 */
import { maxClass } from '../../src/agent/AgentExecutor';
import type { Plan } from '../../src/agent/types';
import type { AgentTool } from '../../src/tools/types';
import { makeHarness } from '../helpers/harness';

const notifications = {
  recent: async () => [
    { app: 'Slack', title: 'Rahul', text: 'Prod is down', postedAt: Date.now() },
  ],
};

function plan(steps: Plan['steps'], responseStep?: string): Plan {
  return { goal: 'test', source: 'direct', steps, responseStep };
}

describe('privacy taint', () => {
  it('orders classes', () => {
    expect(maxClass(['public', 'sensitive', 'personal'])).toBe('sensitive');
    expect(maxClass([])).toBe('public');
  });

  it('a "public" summary of notifications is routed as personal', async () => {
    const h = makeHarness({ notifications, responder: () => ({ text: 'summary' }) });
    h.permissions.granted.add('special:notification_listener');
    const r = await h.controller.execute({
      text: 'x',
      source: 'chat',
      plan: plan(
        [
          { id: 'n', kind: 'tool', tool: 'notifications.recent', args: { sinceMinutes: 60 } },
          {
            id: 's',
            kind: 'infer',
            operation: 'summarize',
            dataClass: 'public',
            prompt: 'Summarize {{steps.n.output}}',
            dependsOn: ['n'],
          },
        ],
        's',
      ),
    });
    expect(r.state).toBe('COMPLETED');
    const call = h.inference.calls.find(c => c.ctx.stepId === 's')!;
    expect(call.ctx.dataClass).toBe('personal');
    expect(call.ctx.localOnly).toBeUndefined();
  });

  it('public inputs stay public', async () => {
    const h = makeHarness({ responder: () => ({ text: 'ok' }) });
    await h.controller.execute({
      text: 'x',
      source: 'chat',
      plan: plan(
        [
          { id: 't', kind: 'tool', tool: 'time.now', args: {} },
          {
            id: 's',
            kind: 'infer',
            operation: 'respond',
            dataClass: 'public',
            prompt: 'It is {{steps.t.output.time}}',
            dependsOn: ['t'],
          },
        ],
        's',
      ),
    });
    expect(h.inference.calls.find(c => c.ctx.stepId === 's')!.ctx.dataClass).toBe('public');
  });

  it('on-device-only output marks downstream model steps local-only and blocks network tools', async () => {
    const h = makeHarness({ notifications, responder: () => ({ text: 'digest' }) });
    h.permissions.granted.add('special:notification_listener');
    h.registry.get('notifications.recent')!.localOnlyOutput = () => true;
    const sent: unknown[] = [];
    const upload: AgentTool = {
      name: 'mcp.cloud.upload',
      description: 'Upload text',
      category: 'mcp',
      inputSchema: { type: 'object', properties: { text: { type: 'string' } }, required: ['text'] },
      requiredPermissions: ['special:network'],
      riskLevel: 'read_only',
      idempotent: true,
      execute: async args => {
        sent.push(args);
        return { success: true };
      },
    };
    h.registry.register(upload);
    h.permissions.granted.add('special:network');
    const r = await h.controller.execute({
      text: 'x',
      source: 'chat',
      plan: plan([
        { id: 'n', kind: 'tool', tool: 'notifications.recent', args: { sinceMinutes: 60 } },
        {
          id: 's',
          kind: 'infer',
          operation: 'summarize',
          dataClass: 'personal',
          prompt: 'Summarize {{steps.n.output}}',
          dependsOn: ['n'],
        },
        {
          id: 'u',
          kind: 'tool',
          tool: 'mcp.cloud.upload',
          args: { text: '{{steps.s.output}}' },
          dependsOn: ['s'],
        },
      ]),
    });
    expect(h.inference.calls.find(c => c.ctx.stepId === 's')!.ctx.localOnly).toBe(true);
    expect(sent).toEqual([]);
    expect(r.state).not.toBe('COMPLETED');
    const rec = await h.repo.get(r.executionId);
    expect(rec?.steps.u?.error?.code).toBe('LOCAL_ONLY_DATA');
  });

  it('fails closed when the local-only check itself errors', async () => {
    const h = makeHarness({ notifications, responder: () => ({ text: 'ok' }) });
    h.permissions.granted.add('special:notification_listener');
    h.registry.get('notifications.recent')!.localOnlyOutput = () => {
      throw new Error('settings unreadable');
    };
    await h.controller.execute({
      text: 'x',
      source: 'chat',
      plan: plan([
        { id: 'n', kind: 'tool', tool: 'notifications.recent', args: {} },
        {
          id: 's',
          kind: 'infer',
          operation: 'summarize',
          dataClass: 'personal',
          prompt: '{{steps.n.output}}',
          dependsOn: ['n'],
        },
      ]),
    });
    expect(h.inference.calls.find(c => c.ctx.stepId === 's')!.ctx.localOnly).toBe(true);
  });
});
