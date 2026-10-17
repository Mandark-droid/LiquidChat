/**
 * Regressions from the runtime review: remote approval mid-routing, crash during
 * inference, non-idempotent timeouts, cancel closing approvals, exact local hosts.
 */
import type { Plan } from '../../src/agent/types';
import type { AgentTool } from '../../src/tools/types';
import { isLocalHost } from '../../src/utils/net';
import { makeHarness } from '../helpers/harness';

const infer = (dataClass: 'personal' | 'public' = 'personal'): Plan => ({
  goal: 'g',
  source: 'skill',
  steps: [{ id: 's', kind: 'infer', operation: 'reason', dataClass, prompt: 'think' }],
  responseStep: 's',
});

describe('review regressions', () => {
  it('a cloud-data approval during routing is shown and the step completes', async () => {
    const decisions: unknown[] = [];
    const h = makeHarness({
      responder: async (_ctx, _req, opts) => {
        decisions.push(
          await opts?.approve?.({
            selectedModelId: 'oai/gpt',
            providerId: 'oai',
            executionMode: 'remote',
            reason: 'needs stronger reasoning',
            requiresUserApproval: true,
            rejected: [],
          }),
        );
        return { text: 'answer', mode: 'remote', provider: 'oai', modelId: 'oai/gpt' };
      },
    });
    h.setApproval(() => 'approve_once');
    const r = await h.controller.execute({ text: 'x', source: 'chat', plan: infer() });
    expect(r.state).toBe('COMPLETED');
    expect(h.approvalLog.map(a => a.kind)).toEqual(['remote_inference']);
    expect(decisions).toEqual(['once']); // "Allow once" never becomes a standing grant
    const states = (await h.repo.transitions(r.executionId)).map(t => t.to);
    expect(states).toEqual(expect.arrayContaining(['ROUTING', 'WAITING_FOR_PERMISSION']));
  });

  it('"Always allow" for sensitive data is downgraded to once', async () => {
    let answer: unknown;
    const h = makeHarness({
      responder: async (_c, _r, opts) => {
        answer = await opts?.approve?.({
          selectedModelId: 'oai/gpt',
          providerId: 'oai',
          executionMode: 'remote',
          reason: '',
          requiresUserApproval: true,
          rejected: [],
        });
        return { text: 'ok' };
      },
    });
    h.setApproval(() => 'approve_always');
    await h.controller.execute({
      text: 'x',
      source: 'chat',
      plan: {
        ...infer(),
        steps: [
          { id: 's', kind: 'infer', operation: 'reason', dataClass: 'sensitive', prompt: 'p' },
        ],
      },
    });
    expect(answer).toBe('once');
  });

  it('an execution killed while ROUTING resumes through RECOVERING', async () => {
    const h = makeHarness({ responder: () => ({ text: 'done' }) });
    const rec = await h.repo.create('exe_crash', {
      text: 'x',
      source: 'chat',
      plan: infer('public'),
    });
    await h.repo.savePlan(rec.id, infer('public'));
    await h.repo.transition(rec.id, 'CREATED', 'EXECUTING');
    await h.repo.transition(rec.id, 'EXECUTING', 'ROUTING');
    const r = await h.controller.resume(rec.id);
    expect(r.state).toBe('COMPLETED');
  });

  it('a non-idempotent tool that times out is not run again', async () => {
    const h = makeHarness();
    let calls = 0;
    const slow: AgentTool = {
      name: 'test.book',
      description: 'Books something',
      category: 'productivity',
      inputSchema: { type: 'object', properties: {} },
      requiredPermissions: [],
      riskLevel: 'reversible',
      idempotent: false,
      execute: () => {
        calls++;
        return new Promise(res => setTimeout(() => res({ success: true }), 200));
      },
    };
    h.registry.register(slow);
    const r = await h.controller.execute({
      text: 'x',
      source: 'chat',
      plan: {
        goal: 'g',
        source: 'skill',
        steps: [{ id: 'b', kind: 'tool', tool: 'test.book', args: {}, timeoutMs: 20 }],
      },
    });
    await new Promise(res => setTimeout(res, 250));
    expect(calls).toBe(1);
    expect(r.state).toBe('FAILED');
  });

  it('cancelling closes approval sheets still open for the execution', async () => {
    const h = makeHarness();
    h.permissions.granted.add('special:notification_policy');
    h.approvals.setHandler(null); // use the UI queue
    const p = h.controller.execute({
      text: 'x',
      source: 'chat',
      plan: {
        goal: 'g',
        source: 'skill',
        steps: [
          {
            id: 'd',
            kind: 'tool',
            tool: 'toggle_dnd',
            args: { enable: true },
            requiresApproval: true,
          },
        ],
      },
    });
    for (let i = 0; i < 50 && h.approvals.pending().length === 0; i++)
      await new Promise(res => setTimeout(res, 2));
    const pending = h.approvals.pending()[0];
    expect(pending).toBeDefined();
    await h.controller.cancel(pending.executionId!);
    expect(h.approvals.pending()).toEqual([]);
    const r = await p;
    expect(r.state).toBe('CANCELLED');
    expect(h.legacyCalls).toEqual([]);
  });
});

describe('isLocalHost', () => {
  it.each([
    ['localhost', true],
    ['127.0.0.1', true],
    ['10.0.0.5', true],
    ['192.168.1.20', true],
    ['172.20.1.1', true],
    ['[::1]', true],
    ['10.evil.com', false],
    ['localhost.attacker.net', false],
    ['192.168.1.example.org', false],
    ['172.32.0.1', false],
    ['8.8.8.8', false],
    ['999.1.1.1', false],
  ])('%s -> %s', (h, ok) => expect(isLocalHost(h)).toBe(ok));
});
