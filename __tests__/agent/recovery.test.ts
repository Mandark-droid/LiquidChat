/**
 * Restart recovery, retries, cancellation, permission prompts and verification.
 */
import type { Plan } from '../../src/agent/types';
import { setDeviceStateReader } from '../../src/tools/builtin/device';
import { makeHarness } from '../helpers/harness';

const plan = (steps: Plan['steps']): Plan => ({ goal: 'test', source: 'direct', steps });

afterEach(() => setDeviceStateReader(null));

describe('restart recovery', () => {
  async function crashedExecution(
    h: ReturnType<typeof makeHarness>,
    tool: string,
    args: Record<string, unknown>,
  ) {
    const p = plan([
      { id: 's1', kind: 'tool', tool: 'turn_on_flashlight', args: {} },
      { id: 's2', kind: 'tool', tool, args, dependsOn: ['s1'] },
    ]);
    const rec = await h.repo.create('exeX', { text: 'x', source: 'chat', plan: p });
    await h.repo.savePlan('exeX', p);
    await h.repo.transition('exeX', 'CREATED', 'EXECUTING');
    // s1 finished before the crash; s2's call was started but never ended.
    await h.repo.saveStep('exeX', {
      stepId: 's1',
      status: 'succeeded',
      attempts: 1,
      output: null,
      display: 'Flashlight on',
    });
    await h.repo.saveStep('exeX', { stepId: 's2', status: 'running', attempts: 1 });
    await h.repo.startToolCall({
      id: 'exeX:s2',
      executionId: 'exeX',
      stepId: 's2',
      tool,
      args,
      idempotent: false,
      risk: 'reversible',
    });
    return rec;
  }

  it('never silently replays an interrupted non-idempotent call', async () => {
    const h = makeHarness();
    await crashedExecution(h, 'create_calendar_event', {
      title: 'Review',
      datetime: '2026-10-22T16:00',
    });
    h.setApproval(r => (r.title.startsWith('Run this step again') ? 'deny' : 'approve_once'));
    const res = await h.controller.resume('exeX');
    expect(h.legacyCalls).toHaveLength(0); // s1 not re-run, s2 not replayed
    expect(res.state).toBe('FAILED');
    expect(res.steps.find(s => s.stepId === 's2')?.error?.code).toBe('NOT_REPLAYED');
    const states = (await h.repo.transitions('exeX')).map(t => t.to);
    expect(states).toEqual(expect.arrayContaining(['RECOVERING', 'WAITING_FOR_USER']));
  });

  it('re-runs an interrupted call only after the user confirms', async () => {
    const h = makeHarness();
    await crashedExecution(h, 'create_calendar_event', {
      title: 'Review',
      datetime: '2026-10-22T16:00',
    });
    const res = await h.controller.resume('exeX');
    expect(res.state).toBe('COMPLETED');
    expect(h.legacyCalls.map(c => c.name)).toEqual(['create_calendar_event']);
  });

  it('reuses the stored result of a call that completed before the crash', async () => {
    const h = makeHarness();
    await crashedExecution(h, 'create_calendar_event', {
      title: 'Review',
      datetime: '2026-10-22T16:00',
    });
    await h.repo.endToolCall('exeX:s2', 'succeeded', { display: 'Event created' });
    const res = await h.controller.resume('exeX');
    expect(res.state).toBe('COMPLETED');
    expect(h.legacyCalls).toHaveLength(0);
    expect(h.approvalLog).toHaveLength(0);
  });

  it('lists unfinished executions for the resume prompt', async () => {
    const h = makeHarness();
    await crashedExecution(h, 'set_timer', { seconds: 60 });
    expect((await h.controller.unfinished()).map(r => r.id)).toEqual(['exeX']);
  });
});

describe('retries and errors', () => {
  it('retries a recoverable tool failure, then succeeds', async () => {
    const h = makeHarness();
    let n = 0;
    h.setLegacyResult(c =>
      c.name === 'set_timer' && n++ === 0
        ? { success: false, message: 'Clock app busy' }
        : { success: true, message: 'ok' },
    );
    const res = await h.controller.execute({
      text: 'x',
      source: 'chat',
      plan: plan([{ id: 's1', kind: 'tool', tool: 'set_timer', args: { seconds: 30 } }]),
    });
    expect(res.state).toBe('COMPLETED');
    expect(res.steps[0].attempts).toBe(2);
  });

  it('gives structured errors and skips dependants when a step fails for good', async () => {
    const h = makeHarness();
    h.setLegacyResult(() => ({ success: false, message: 'Clock app missing' }));
    const res = await h.controller.execute({
      text: 'x',
      source: 'chat',
      plan: plan([
        {
          id: 's1',
          kind: 'tool',
          tool: 'set_timer',
          args: { seconds: 30 },
          retry: { maxAttempts: 1, backoffMs: 0 },
        },
        { id: 's2', kind: 'tool', tool: 'turn_on_flashlight', args: {}, dependsOn: ['s1'] },
      ]),
    });
    expect(res.state).toBe('FAILED');
    expect(res.error).toMatchObject({ code: 'TOOL_FAILED', recoverable: true });
    expect(res.steps.map(s => s.status)).toEqual(['failed', 'skipped']);
  });

  it('asks for a missing permission and continues when granted', async () => {
    const h = makeHarness();
    h.permissions.grantOnRequest = true;
    const res = await h.controller.execute({
      text: 'x',
      source: 'chat',
      plan: plan([{ id: 's1', kind: 'tool', tool: 'toggle_dnd', args: { enable: true } }]),
    });
    expect(h.permissions.requests).toEqual(['special:notification_policy']);
    expect(res.state).toBe('COMPLETED');
    const states = (await h.repo.transitions(res.executionId)).map(t => t.to);
    expect(states).toContain('WAITING_FOR_PERMISSION');
  });

  it('a denied permission fails the step without crashing the workflow', async () => {
    const h = makeHarness();
    const res = await h.controller.execute({
      text: 'x',
      source: 'chat',
      plan: plan([
        { id: 's1', kind: 'tool', tool: 'toggle_dnd', args: { enable: true } },
        { id: 's2', kind: 'tool', tool: 'set_timer', args: { seconds: 60 } },
      ]),
    });
    expect(res.steps.map(s => s.status)).toEqual(['failed', 'succeeded']);
    expect(res.response).toMatch(/needs permission/);
  });

  it('verification failure on an idempotent tool retries, then fails with the reason', async () => {
    const h = makeHarness();
    h.permissions.granted.add('special:notification_policy');
    setDeviceStateReader({
      getInterruptionFilter: async () => 'all',
      getStreamVolumePercent: async () => 50,
    });
    const res = await h.controller.execute({
      text: 'x',
      source: 'chat',
      plan: plan([{ id: 's1', kind: 'tool', tool: 'toggle_dnd', args: { enable: true } }]),
    });
    expect(res.state).toBe('FAILED');
    expect(res.error?.code).toBe('VERIFICATION_FAILED');
    expect(h.legacyCalls).toHaveLength(2);
  });
});

describe('cancellation', () => {
  it('stops before the next step and ends CANCELLED', async () => {
    const h = makeHarness();
    h.registry.register({
      name: 'test.slow',
      description: 'slow',
      category: 'device',
      inputSchema: { type: 'object' },
      requiredPermissions: [],
      riskLevel: 'read_only',
      idempotent: true,
      execute: () => new Promise(r => setTimeout(() => r({ success: true }), 200)),
    });
    const running = h.controller.execute({
      text: 'x',
      source: 'chat',
      plan: plan([
        { id: 's1', kind: 'tool', tool: 'test.slow', args: {} },
        { id: 's2', kind: 'tool', tool: 'turn_on_flashlight', args: {} },
      ]),
    });
    await new Promise(r => setTimeout(r, 20));
    const [rec] = await h.repo.list({ limit: 1 });
    await h.controller.cancel(rec.id);
    const res = await running;
    expect(res.state).toBe('CANCELLED');
    expect(h.legacyCalls).toHaveLength(0);
  });
});
