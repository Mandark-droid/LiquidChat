import { CancellationSource } from '../../src/agent/cancellation';
import type { ToolContext } from '../../src/tools/types';
import { makeHarness } from '../helpers/harness';

function ctx(id = 'exe1', step = 's1'): ToolContext {
  return {
    executionId: id,
    stepId: step,
    toolCallId: `${id}:${step}`,
    cancel: new CancellationSource(),
    distribution: 'full',
  };
}

describe('PermissionGateway', () => {
  it('validates arguments before anything runs', async () => {
    const h = makeHarness();
    await h.repo.create('exe1', { text: 't', source: 'chat' });
    const r = await h.gateway.invoke('set_volume', { level: 'loud' }, ctx());
    expect(r.success).toBe(false);
    expect(r.error?.code).toBe('INVALID_ARGS');
    expect(h.legacyCalls).toHaveLength(0);
    const calls = await h.repo.toolCallsFor('exe1');
    expect(calls[0].status).toBe('denied');
  });

  it('rejects unknown tools', async () => {
    const h = makeHarness();
    const r = await h.gateway.invoke('format_disk', {}, ctx());
    expect(r.error?.code).toBe('UNKNOWN_TOOL');
  });

  it('blocks a tool when its Android permission is missing and runs it once granted', async () => {
    const h = makeHarness();
    await h.repo.create('exe1', { text: 't', source: 'chat' });
    const denied = await h.gateway.invoke('toggle_dnd', { enable: true }, ctx());
    expect(denied.error).toMatchObject({ code: 'PERMISSION_REQUIRED', recoverable: true });
    expect(h.legacyCalls).toHaveLength(0);
    h.permissions.granted.add('special:notification_policy');
    const ok = await h.gateway.invoke('toggle_dnd', { enable: true }, ctx('exe1', 's2'));
    expect(ok.success).toBe(true);
    expect(h.legacyCalls).toEqual([{ name: 'toggle_dnd', args: { enable: true } }]);
  });

  it('requires approval for sensitive tools and never executes on denial', async () => {
    const h = makeHarness();
    await h.repo.create('exe1', { text: 't', source: 'chat' });
    h.permissions.granted.add('special:accessibility');
    h.setApproval(() => 'deny');
    const r = await h.gateway.invoke('tap_element', { target: 'Pay now' }, ctx());
    expect(r.error?.code).toBe('USER_DENIED');
    expect(h.legacyCalls).toHaveLength(0);
    expect(h.approvalLog[0]).toMatchObject({ risk: 'high', allowAlways: false });
  });

  it('send_email always asks, even after "always allow"', async () => {
    const h = makeHarness();
    await h.repo.create('exe1', { text: 't', source: 'chat' });
    h.setApproval(() => 'approve_always');
    await h.gateway.invoke('send_email', { to: 'a@b.co', subject: 'x' }, ctx('exe1', 's1'));
    await h.gateway.invoke('send_email', { to: 'a@b.co', subject: 'y' }, ctx('exe1', 's2'));
    expect(h.approvalLog).toHaveLength(2);
    expect(await h.repo.grants()).toEqual([]);
  });

  it('plan-requested approval on a reversible tool can be granted permanently', async () => {
    const h = makeHarness();
    await h.repo.create('exe1', { text: 't', source: 'chat' });
    h.setApproval(() => 'approve_always');
    await h.gateway.invoke('set_timer', { seconds: 60 }, ctx('exe1', 's1'), {
      requireApproval: true,
    });
    await h.gateway.invoke('set_timer', { seconds: 60 }, ctx('exe1', 's2'), {
      requireApproval: true,
    });
    expect(h.approvalLog).toHaveLength(1);
    expect(await h.repo.grants()).toEqual(['set_timer']);
  });

  it('personal data leaving the device asks every time, despite an earlier "always allow"', async () => {
    const h = makeHarness();
    await h.repo.create('exe1', { text: 't', source: 'chat' });
    h.setApproval(() => 'approve_always');
    await h.gateway.invoke('set_timer', { seconds: 60 }, ctx('exe1', 's1'), {
      requireApproval: true,
    });
    expect(await h.repo.grants()).toEqual(['set_timer']);
    await h.gateway.invoke('set_timer', { seconds: 60 }, ctx('exe1', 's2'), {
      requireFreshApproval: true,
    });
    expect(h.approvalLog).toHaveLength(2);
    expect(h.approvalLog[1]).toMatchObject({ allowAlways: false });
  });

  it('blocks Accessibility automation in the Play flavor', async () => {
    const h = makeHarness({ distribution: 'play' });
    h.permissions.granted.add('special:accessibility');
    const r = await h.gateway.invoke('read_screen', {}, ctx());
    expect(r.error?.code).toBe('NOT_AVAILABLE');
  });

  it('times out hung tools and records the failure', async () => {
    const h = makeHarness();
    await h.repo.create('exe1', { text: 't', source: 'chat' });
    h.registry.register({
      name: 'test.hang',
      description: 'hangs',
      category: 'device',
      inputSchema: { type: 'object' },
      requiredPermissions: [],
      riskLevel: 'read_only',
      idempotent: true,
      execute: () => new Promise(() => {}),
    });
    const r = await h.gateway.invoke('test.hang', {}, ctx(), { timeoutMs: 20 });
    expect(r.error?.code).toBe('TIMEOUT');
    expect((await h.repo.toolCall('exe1:s1'))?.status).toBe('failed');
  });

  it('cancellation aborts an in-flight tool', async () => {
    const h = makeHarness();
    await h.repo.create('exe1', { text: 't', source: 'chat' });
    h.registry.register({
      name: 'test.slow',
      description: 'slow',
      category: 'device',
      inputSchema: { type: 'object' },
      requiredPermissions: [],
      riskLevel: 'read_only',
      idempotent: true,
      execute: () => new Promise(r => setTimeout(() => r({ success: true }), 1000)),
    });
    const c = ctx();
    const p = h.gateway.invoke('test.slow', {}, c);
    (c.cancel as CancellationSource).cancel();
    expect((await p).error?.code).toBe('CANCELLED');
  });
});
