/**
 * PRD Phase 1 acceptance: three multi-step workflows end-to-end through the
 * real controller → planner → validator → executor → gateway → SQLite path.
 */
import type { InferenceRequest, RoutingContext } from '../../src/inference/types';
import { makeHarness } from '../helpers/harness';

const lastUser = (req: InferenceRequest) =>
  req.messages.filter(m => m.role === 'user').pop()?.content ?? '';

describe('workflow 1: focus mode', () => {
  it('plans and runs DnD + ring volume + timer, verifies, and replies without a model call', async () => {
    const h = makeHarness({
      responder: ctx => {
        expect(ctx.requirements.operation).toBe('plan');
        return {
          text: JSON.stringify({
            goal: 'Focus for an hour',
            steps: [
              { id: 's1', kind: 'tool', tool: 'toggle_dnd', args: { enable: true } },
              {
                id: 's2',
                kind: 'tool',
                tool: 'set_volume',
                args: { stream: 'ring', level: 0 },
                dependsOn: ['s1'],
              },
              {
                id: 's3',
                kind: 'tool',
                tool: 'set_timer',
                args: { seconds: 3600, message: 'Meeting' },
                dependsOn: ['s2'],
              },
            ],
          }),
        };
      },
    });
    h.permissions.granted.add('special:notification_policy');
    const res = await h.controller.execute({
      text: "I'm going into a meeting for an hour: turn on do not disturb, mute the ringer and set a timer",
      source: 'chat',
    });
    expect(res.state).toBe('COMPLETED');
    expect(h.legacyCalls.map(c => c.name)).toEqual(['toggle_dnd', 'set_volume', 'set_timer']);
    expect(h.legacyCalls[1].args).toEqual({ stream: 'ring', level: 0 });
    expect(h.inference.calls).toHaveLength(1); // planning only; reply composed deterministically
    expect(res.response).toContain('toggle_dnd ok');
    const transitions = (await h.repo.transitions(res.executionId)).map(t => t.to);
    expect(transitions[0]).toBe('CREATED');
    expect(transitions).toContain('PLANNING');
    expect(transitions).toContain('VERIFYING');
    expect(transitions.at(-1)).toBe('COMPLETED');
  });
});

describe('workflow 2: meeting follow-up with per-step routing', () => {
  const meeting = {
    id: 'm1',
    title: 'UPI latency review',
    client: 'Acme',
    startedAt: Date.now(),
    summary: 'Reviewed p99 spikes.',
    decisions: ['Increase pool to 400'],
    actionItems: [
      { task: 'Share HSM logs', owner: 'Rahul', status: 'open' },
      { task: 'Send RCA', owner: 'Kshitij', due: 'Friday', status: 'open' },
    ],
    attendees: [{ name: 'Rahul Mehta', email: 'rahul@acme.com' }],
  };

  it('extract step escalates once, then control returns to the local model for the next step', async () => {
    let extractCalls = 0;
    const h = makeHarness({
      meetings: { latest: async () => meeting },
      responder: (ctx: RoutingContext, req) => {
        if (ctx.requirements.operation === 'plan') {
          return {
            text: JSON.stringify({
              goal: 'Email Rahul his action items',
              steps: [
                { id: 's1', kind: 'tool', tool: 'meetings.latest', args: { client: 'Acme' } },
                {
                  id: 's2',
                  kind: 'infer',
                  operation: 'extract',
                  dataClass: 'personal',
                  dependsOn: ['s1'],
                  prompt:
                    'From this meeting draft an email to Rahul with his action items as JSON {to, subject, body}: {{steps.s1.output}}',
                },
                {
                  id: 's3',
                  kind: 'tool',
                  tool: 'send_email',
                  dependsOn: ['s2'],
                  args: {
                    to: '{{steps.s2.output.to}}',
                    subject: '{{steps.s2.output.subject}}',
                    body: '{{steps.s2.output.body}}',
                  },
                },
                {
                  id: 's4',
                  kind: 'infer',
                  operation: 'respond',
                  dataClass: 'personal',
                  dependsOn: ['s3'],
                  prompt: 'Tell the user the email is ready: {{steps.s3.output}}',
                },
              ],
            }),
          };
        }
        if (ctx.stepId === 's2') {
          extractCalls++;
          expect(lastUser(req)).toContain('<data source="step s1"');
          expect(lastUser(req)).toContain('Share HSM logs');
          if (!ctx.excludeModels?.length) return { text: 'I am unable to do that.' }; // local fails verification
          expect(ctx.escalationReason).toMatch(/could not complete|JSON/);
          return {
            text: JSON.stringify({
              to: 'rahul@acme.com',
              subject: 'Action items: UPI latency review',
              body: 'Hi Rahul, please share the HSM logs.',
            }),
            modelId: 'claude-remote',
            provider: 'anthropic',
            mode: 'remote',
            costUsd: 0.002,
          };
        }
        if (ctx.stepId === 's4') {
          expect(ctx.excludeModels ?? []).toEqual([]); // a fresh routing decision, not a sticky remote
          return { text: 'Your email to Rahul is ready in Gmail.' };
        }
        throw new Error(`unexpected step ${ctx.stepId}`);
      },
    });
    // the extract step declares a JSON schema so the verifier can check structure
    const origPlan = h.planner.planWithModel.bind(h.planner);
    h.planner.planWithModel = async (req, ctx) => {
      const out = await origPlan(req, ctx);
      if (out.kind === 'plan') {
        const s2 = out.plan.steps.find(s => s.id === 's2');
        if (s2?.kind === 'infer')
          s2.outputSchema = {
            type: 'object',
            properties: {
              to: { type: 'string', format: 'email' },
              subject: { type: 'string' },
              body: { type: 'string' },
            },
            required: ['to', 'subject', 'body'],
          };
      }
      return out;
    };
    const res = await h.controller.execute({
      text: 'Summarize my last Acme meeting and then email Rahul his action items',
      source: 'chat',
    });
    expect(res.state).toBe('COMPLETED');
    expect(extractCalls).toBe(2);
    const routed = h.inference.calls.map(c => `${c.ctx.stepId}:${c.decision.executionMode}`);
    expect(routed).toEqual(['plan:local', 's2:local', 's2:remote', 's4:local']);
    expect(res.response).toBe('Your email to Rahul is ready in Gmail.');
    // the send step was approved by the user and received the remote step's structured output
    expect(h.approvalLog.some(a => a.detail.includes('rahul@acme.com'))).toBe(true);
    expect(h.legacyCalls).toEqual([
      {
        name: 'send_email',
        args: {
          to: 'rahul@acme.com',
          subject: 'Action items: UPI latency review',
          body: 'Hi Rahul, please share the HSM logs.',
        },
      },
    ]);
    const rec = await h.repo.get(res.executionId);
    expect(rec!.remoteCalls).toBe(1);
    expect(rec!.spendUsd).toBeCloseTo(0.002);
    expect(rec!.steps.s2.routing).toHaveLength(2);
  });

  it('declining the email leaves nothing sent and reports it', async () => {
    const h = makeHarness({
      meetings: { latest: async () => meeting },
      responder: ctx =>
        ctx.requirements.operation === 'plan'
          ? {
              text: JSON.stringify({
                goal: 'g',
                steps: [
                  {
                    id: 's1',
                    kind: 'tool',
                    tool: 'send_email',
                    args: { to: 'rahul@acme.com', subject: 'Hi' },
                  },
                ],
              }),
            }
          : { text: '' },
    });
    h.setApproval(() => 'deny');
    const res = await h.controller.execute({
      text: 'email rahul@acme.com then also remind me',
      source: 'chat',
    });
    expect(res.state).toBe('FAILED');
    expect(res.response).toMatch(/declined/);
    expect(h.legacyCalls).toHaveLength(0);
  });
});

describe('workflow 3: schedule and remember', () => {
  it('resolves dates, creates the event and a dependent task', async () => {
    const h = makeHarness({
      responder: () => ({
        text: JSON.stringify({
          goal: 'Book review and reminder',
          steps: [
            { id: 's1', kind: 'tool', tool: 'dates.resolve', args: { phrase: 'next Thursday' } },
            {
              id: 's2',
              kind: 'tool',
              tool: 'create_calendar_event',
              dependsOn: ['s1'],
              args: { title: 'Review with Priya', datetime: '{{steps.s1.output.date}}T16:00:00' },
            },
            {
              id: 's3',
              kind: 'tool',
              tool: 'tasks.add',
              dependsOn: ['s2'],
              args: { title: 'Send the deck to Priya', due: '2026-10-21' },
            },
          ],
        }),
      }),
    });
    const res = await h.controller.execute({
      text: 'Book a review with Priya next Thursday at 4 and then remind me to send the deck the day before',
      source: 'chat',
    });
    expect(res.state).toBe('COMPLETED');
    expect(h.legacyCalls).toEqual([
      {
        name: 'create_calendar_event',
        args: { title: 'Review with Priya', datetime: '2026-10-22T16:00:00' },
      },
    ]);
    expect(h.tasksAdded).toEqual([
      expect.objectContaining({ title: 'Send the deck to Priya', dueDate: '2026-10-21' }),
    ]);
  });
});
