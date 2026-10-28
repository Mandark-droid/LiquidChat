import { makeHarness } from '../helpers/harness';

/** The text of the user turn the model was given for the plan step. */
function promptOf(h: ReturnType<typeof makeHarness>): string {
  const plan = h.inference.calls.find(c => c.ctx.stepId === 'plan');
  const turns = plan?.req.messages ?? [];
  return String(turns[turns.length - 1]?.content ?? '');
}

async function withPreference(h: ReturnType<typeof makeHarness>) {
  await h.memory.create({
    kind: 'profile',
    title: 'Meetings',
    content: 'I prefer meetings after 11 am',
    source: 'user',
    pinned: true,
  });
}

describe('memory in action requests', () => {
  it('an action does not see a pinned preference that has nothing to do with it', async () => {
    const h = makeHarness({ responder: () => ({ text: 'Done.' }) });
    await withPreference(h);
    await h.controller.execute({ text: 'Set an alarm for 7 am', source: 'chat' });
    expect(promptOf(h)).toContain('Set an alarm for 7 am');
    expect(promptOf(h)).not.toContain('11 am');
  });

  it('an action still sees a memory that matches it', async () => {
    const h = makeHarness({ responder: () => ({ text: 'Done.' }) });
    await h.memory.create({
      kind: 'profile',
      title: 'Alarm',
      content: 'Label alarms "Gym" on weekdays',
      source: 'user',
      pinned: true,
    });
    await h.controller.execute({ text: 'Set an alarm for 7 am', source: 'chat' });
    expect(promptOf(h)).toContain('Gym');
  });

  it('a question still gets the pinned preference', async () => {
    const h = makeHarness({ responder: () => ({ text: 'After 11 am.' }) });
    await withPreference(h);
    await h.controller.execute({ text: 'What time do I prefer meetings?', source: 'chat' });
    expect(promptOf(h)).toContain('11 am');
  });
});
