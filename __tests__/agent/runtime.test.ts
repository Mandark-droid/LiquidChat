/**
 * Composition root: the production AgentRuntime wired to fake platform
 * implementations and a scripted model, exercising startup, notification
 * ingestion, skill scheduling → alarm → launch, MCP tool registration,
 * evaluation and the encrypted-database key provider.
 */
import { AgentRuntime } from '../../src/agent/AgentRuntime';
import type { AgentEvent } from '../../src/agent/types';
import { listEvalRuns } from '../../src/observability/EvaluationRunner';
import { evalCases } from '../../src/observability/evalset';
import { createFakePlatform, type FakePlatform } from '../../src/platform/fakes';
import { parseAlarmPayload } from '../../src/scheduler/TaskScheduler';
import { ApprovalManager } from '../../src/security/ApprovalManager';
import { getDatabase, resetDatabaseForTests, setDatabaseKeyProvider } from '../../src/storage/db';
import { setLegacyExecutor } from '../../src/tools/builtin/device';
import { ScriptedInference } from '../helpers/harness';

const NOW = new Date(2026, 9, 17, 7, 0);

function makeRuntime(opts: { platform?: FakePlatform; responder?: ScriptedInference } = {}) {
  resetDatabaseForTests();
  (require('@op-engineering/op-sqlite') as { __resetAll: () => void }).__resetAll();
  setLegacyExecutor(async name => ({ success: true, message: `${name} ok` }));
  const platform =
    opts.platform ?? createFakePlatform({ permissions: { 'special:notification_listener': true } });
  const inference =
    opts.responder ??
    new ScriptedInference((ctx, req) => {
      const prompt = String(req.messages[req.messages.length - 1]?.content ?? '');
      if (ctx.stepId === 'brief') return { text: `BRIEF:: ${prompt.slice(0, 4000)}` };
      return { text: 'ok' };
    });
  const approvals = new ApprovalManager();
  approvals.setHandler(async () => 'approve_once');
  const tasks: { title: string }[] = [];
  const runtime = new AgentRuntime({
    platform,
    inference,
    approvals,
    now: () => NOW,
    meetings: { latest: async () => null, search: async () => [] },
    tasks: {
      add: async t => {
        tasks.push(t);
        return { id: `t${tasks.length}`, title: t.title };
      },
      list: async view =>
        view === 'today'
          ? [
              {
                title: 'Send Acme proposal',
                dueDate: '2026-10-17',
                source: 'personal',
                status: 'open',
              },
            ]
          : [],
    },
  });
  live = runtime;
  return { runtime, platform, inference, tasks };
}

let live: AgentRuntime | null = null;
afterEach(async () => {
  await live?.tracer.dispose();
  live = null;
  setDatabaseKeyProvider(null);
});

describe('AgentRuntime', () => {
  it('starts idempotently and installs every built-in skill when notification capture exists', async () => {
    const { runtime } = makeRuntime();
    const a = await runtime.ready();
    const b = await runtime.ready();
    expect(a).toBe(b);
    expect(a.builtinSkills.installed.sort()).toEqual(
      [
        'end-of-day',
        'focus-mode',
        'meeting-followup',
        'meeting-preparation',
        'morning-briefing',
      ].sort(),
    );
    expect(a.builtinSkills.skipped).toEqual([]);
    expect(runtime.registry.has('notifications.recent')).toBe(true);
    expect(runtime.registry.has('toggle_dnd')).toBe(true);
  });

  it('skips skills needing notifications when the platform has no listener', async () => {
    const platform = createFakePlatform();
    const { runtime } = makeRuntime({
      platform: { ...platform, notifications: undefined } as unknown as FakePlatform,
    });
    const r = await runtime.ready();
    expect(r.builtinSkills.skipped.map(s => s.name)).toEqual(
      expect.arrayContaining(['meeting-preparation', 'morning-briefing']),
    );
    expect(runtime.registry.has('notifications.recent')).toBe(false);
  });

  it('drains captured notifications into the encrypted store and serves them to tools', async () => {
    const { runtime, platform } = makeRuntime();
    platform.notifications.post({
      packageName: 'com.slack',
      appLabel: 'Slack',
      title: 'Rahul',
      text: 'Prod is down, can you join?',
    });
    // Capture is opt-in: nothing is stored until the user enables it.
    expect((await runtime.ready()).notificationsIngested).toBe(0);
    await runtime.notificationStore.updateSettings({ enabled: true });
    expect(await runtime.ingestNotifications()).toBe(0); // queue was already drained while disabled
    platform.notifications.post({
      packageName: 'com.slack',
      appLabel: 'Slack',
      title: 'Rahul',
      text: 'Prod is down, can you join?',
    });
    platform.notifications.post({
      packageName: 'com.whatsapp',
      appLabel: 'WhatsApp',
      title: 'Mom',
      text: 'Call me',
    });
    const tool = runtime.registry.get('notifications.recent')!;
    const out = await tool.execute({ sinceMinutes: 60, limit: 10 }, {
      executionId: 'x',
      stepId: 's',
      cancel: { cancelled: false, onCancel: () => () => {} },
      distribution: 'full',
    } as never);
    expect(out.success).toBe(true);
    expect(JSON.stringify(out.data)).toContain('Call me');
    expect(JSON.stringify(out.data)).toContain('Prod is down');
  });

  it('schedules a routine, fires its alarm, and runs it from the launch payload', async () => {
    const { runtime, platform } = makeRuntime();
    await runtime.ready();
    const skill = (await runtime.skills.getByName('morning-briefing'))!;
    await runtime.skills.setEnabled(skill.id, true);
    expect(await runtime.scheduleSkill(skill.id)).toBe(1);
    const [alarm] = platform.alarms.list();
    expect(alarm).toBeDefined();
    expect(parseAlarmPayload(alarm.payload)?.skillId).toBe(skill.id);

    platform.alarms.advanceTo(alarm.triggerAtMs, true);
    const events: AgentEvent[] = [];
    const result = await runtime.handleLaunchPayload(e => events.push(e));
    expect(result?.state).toBe('COMPLETED');
    expect(result?.response).toContain('Send Acme proposal');
    expect(events.some(e => e.type === 'plan')).toBe(true);
    const rec = await runtime.repo.get(result!.executionId);
    expect(rec?.request.source).toBe('schedule');
    // re-armed for the next day
    expect(platform.alarms.list()).toHaveLength(1);
    // consumed: a second launch does nothing
    expect(await runtime.handleLaunchPayload()).toBeNull();

    await runtime.unscheduleSkill(skill.id);
    expect(platform.alarms.list()).toHaveLength(0);
  });

  it('will not run a disabled skill', async () => {
    const { runtime } = makeRuntime();
    await runtime.ready();
    const skill = (await runtime.skills.getByName('end-of-day'))!;
    await runtime.skills.setEnabled(skill.id, false);
    await expect(runtime.runSkill(skill.id)).rejects.toThrow(/disabled/);
  });

  it('registers cached MCP tools at startup and removes them on demand', async () => {
    const { runtime } = makeRuntime();
    const s = await runtime.mcpServers.add({ name: 'Notes', url: 'https://mcp.example.com/mcp' });
    await runtime.mcpServers.setTools(s.id, [
      {
        name: 'search_notes',
        description: 'Search notes',
        inputSchema: { type: 'object', properties: { q: { type: 'string' } }, required: ['q'] },
        annotations: { readOnlyHint: true },
      },
    ]);
    const r = await runtime.ready();
    expect(r.mcpTools).toBe(1);
    const t = runtime.registry.get('mcp.notes.search_notes');
    expect(t).toBeDefined();
    expect(t?.requiredPermissions).toContain('special:network');
    runtime.removeMcpTools(s.id);
    expect(runtime.registry.get('mcp.notes.search_notes')).toBeUndefined();
  });

  it('runs the offline evaluation through the real planner without executing anything', async () => {
    const inference = new ScriptedInference((_ctx, req) => {
      const user = String(req.messages[req.messages.length - 1]?.content ?? '');
      if (/flashlight/i.test(user))
        return {
          text: '',
          functionCalls: [{ name: 'toggle_flashlight', arguments: { enable: true } }],
        } as never;
      return { text: 'Sorry, I cannot do that.' };
    });
    const { runtime, platform } = makeRuntime({ responder: inference });
    platform.permissions.set('special:notification_listener', true);
    const cases = evalCases().slice(0, 5);
    const run = await runtime.evaluate({ cases, modelId: 'scripted' });
    expect(run.results).toHaveLength(5);
    expect(run.metrics).toBeDefined();
    expect((await listEvalRuns()).length).toBeGreaterThan(0);
  });
});

describe('database key provider', () => {
  it('opens the database with the Keystore key and fails closed if the key is unavailable', async () => {
    resetDatabaseForTests();
    const provider = jest.fn(async () => 'k'.repeat(64));
    setDatabaseKeyProvider(provider);
    await getDatabase();
    expect(provider).toHaveBeenCalledTimes(1);

    resetDatabaseForTests();
    setDatabaseKeyProvider(async () => {
      throw new Error('keystore locked');
    });
    await expect(getDatabase()).rejects.toThrow('keystore locked');
    setDatabaseKeyProvider(null);
    await expect(getDatabase()).resolves.toBeDefined();
  });
});
