import { EXAMPLE_MANIFEST, generatorPrompt, SkillGenerator } from '../../src/skills/SkillGenerator';
import { validateManifest } from '../../src/skills/SkillValidator';
import { makeHarness } from '../helpers/harness';

describe('skill generator prompt', () => {
  it('shows the model an example that is itself a valid manifest', () => {
    const h = makeHarness();
    const r = validateManifest(EXAMPLE_MANIFEST, h.registry, 'full');
    expect(r.issues).toEqual([]);
    expect(r.ok).toBe(true);
  });

  it('puts the example and the user request in the prompt, without pseudo-JSON alternatives', () => {
    const p = generatorPrompt('Every evening summarize my open tasks', 'tasks.list: list tasks');
    expect(p).toContain(JSON.stringify(EXAMPLE_MANIFEST));
    expect(p).toContain('Every evening summarize my open tasks');
    expect(p).not.toMatch(/"daily", "time": "08:00"\} \|/);
  });
});

describe('skill generator recovery', () => {
  const good = JSON.stringify({
    name: 'evening-task-digest',
    version: '1.0.0',
    description: 'Summarize open tasks.',
    triggers: [{ type: 'daily', time: '21:00' }],
    steps: [
      { id: 'tasks', tool: 'tasks.list', args: { view: 'today', limit: 15 } },
      {
        id: 'digest',
        operation: 'summarize',
        dataClass: 'personal',
        dependsOn: ['tasks'],
        prompt: 'What is due today?\n{{steps.tasks.output}}',
      },
    ],
    responseStep: 'digest',
  });

  it('retries when the first reply is prose, and says why', async () => {
    const replies = ['Sure!', 'Sure! Here is a skill that summarizes your tasks.', good];
    const prompts: string[] = [];
    const h = makeHarness({
      responder: (_ctx, req) => {
        prompts.push(req.messages[req.messages.length - 1].content);
        return { text: replies.shift() ?? good };
      },
    });
    const gen = new SkillGenerator(h.registry, h.inference, () => 'full');
    const d = await gen.draft('Turn on do not disturb every night');
    expect(d.manifest?.name).toBe('evening-task-digest');
    expect(prompts).toHaveLength(3);
    expect(prompts[2]).toContain('not a single JSON object');
  });

  it('feeds the validators field errors back when the object is incomplete', async () => {
    const prompts: string[] = [];
    const h = makeHarness({
      responder: (_ctx, req) => {
        prompts.push(req.messages[req.messages.length - 1].content);
        return { text: '{"name":"x"}' };
      },
    });
    const gen = new SkillGenerator(h.registry, h.inference, () => 'full');
    const d = await gen.draft('anything');
    expect(d.manifest).toBeUndefined();
    expect(prompts[2]).toContain('rejected');
    expect(d.issues.length).toBeGreaterThan(0);
  });

  it('reports a reply with no JSON object at all', async () => {
    const h = makeHarness({ responder: () => ({ text: 'I am not able to do that.' }) });
    const gen = new SkillGenerator(h.registry, h.inference, () => 'full');
    const d = await gen.draft('anything');
    expect(d.manifest).toBeUndefined();
    expect(d.issues[0].message).toMatch(/not a single JSON object/);
  });
});

describe('repairing small-model manifests', () => {
  const { repairManifest, slugify } = require('../../src/skills/repairManifest');

  it('fills a missing name, description, triggers and empty args', () => {
    const fixed = repairManifest(
      {
        steps: [
          { tool: 'tasks.list' },
          {
            id: 'digest',
            operation: 'summarize',
            prompt: 'Summarize {{steps.step1.output}}',
            dependsOn: ['step1'],
          },
        ],
      },
      'Every evening summarize my open tasks',
    ) as Record<string, unknown>;
    expect(fixed.name).toBe('every-evening-summarize-my');
    expect(fixed.description).toBe('Every evening summarize my open tasks');
    expect(fixed.triggers).toEqual([{ type: 'manual' }]);
    expect((fixed.steps as { id: string; args?: unknown }[])[0]).toMatchObject({
      id: 'step1',
      args: {},
    });
    expect(fixed.responseStep).toBe('digest');
  });

  it('drops stray keys the schema would reject', () => {
    const fixed = repairManifest(
      {
        name: 'good-name',
        description: 'ok desc',
        notes: 'x',
        steps: [{ id: 'a', tool: 'time.now', args: {}, why: 'y' }],
      },
      'r',
    ) as Record<string, unknown>;
    expect(fixed.notes).toBeUndefined();
    expect((fixed.steps as Record<string, unknown>[])[0].why).toBeUndefined();
  });

  it('never launders executable content: a manifest with forbidden keys is left as is', () => {
    const bad = { name: 'evil-skill', description: 'bad one', script: 'rm -rf /', steps: [] };
    expect(repairManifest(bad, 'r')).toBe(bad);
    const h = makeHarness();
    expect(validateManifest(repairManifest(bad, 'r'), h.registry, 'full').ok).toBe(false);
  });

  it('makes a usable name from a request', () => {
    expect(slugify('Every evening, summarize my open tasks!')).toBe('every-evening-summarize-my');
    expect(slugify('42')).toBe('skill-42');
    expect(slugify('!!')).toBe('my-skill');
  });

  it('turns an incomplete reply into a valid skill end to end', async () => {
    const incomplete = JSON.stringify({
      steps: [
        { id: 'tasks', tool: 'tasks.list', args: { view: 'today' } },
        {
          id: 'digest',
          operation: 'summarize',
          dataClass: 'personal',
          dependsOn: ['tasks'],
          prompt: 'Due today?\n{{steps.tasks.output}}',
        },
      ],
    });
    const h = makeHarness({ responder: () => ({ text: incomplete }) });
    const gen = new SkillGenerator(h.registry, h.inference, () => 'full');
    const d = await gen.draft('Turn on do not disturb every night');
    expect(d.issues).toEqual([]);
    expect(d.manifest?.name).toBe('turn-on-do-not');
  });
});

describe('repairing a model step written as a tool', () => {
  const { repairManifest } = require('../../src/skills/repairManifest');

  it('moves "tool": "extract" to "operation" and defaults the data class', () => {
    const fixed = repairManifest(
      {
        name: 'task-digest',
        description: 'Digest of tasks',
        steps: [
          { id: 'tasks', tool: 'tasks.list', args: {} },
          {
            id: 'digest',
            tool: 'Extract',
            args: {},
            prompt: 'x {{steps.tasks.output}}',
            dependsOn: ['tasks'],
          },
        ],
      },
      'r',
    ) as { steps: Record<string, unknown>[] };
    expect(fixed.steps[1]).toMatchObject({ operation: 'extract', dataClass: 'personal' });
    expect(fixed.steps[1].tool).toBeUndefined();
    expect(fixed.steps[1].args).toBeUndefined();
    expect(fixed.steps[0].tool).toBe('tasks.list');
  });
});

describe('flat skill spec (first attempt)', () => {
  const { manifestFromSpec, SPEC_EXAMPLE } = require('../../src/skills/skillSpec');

  it('builds a valid manifest from a flat spec', () => {
    const h = makeHarness();
    const m = manifestFromSpec(
      {
        title: 'Evening task digest',
        tools: ['tasks.list'],
        instruction: 'Say which tasks are due today, then the rest.',
        dailyAt: '21:00',
        phrases: ['task digest'],
      },
      'Every evening summarize my open tasks',
      h.registry,
    );
    expect(m.name).toBe('evening-task-digest');
    expect(m.triggers).toEqual([
      { type: 'manual' },
      { type: 'daily', time: '21:00' },
      { type: 'phrase', phrases: ['task digest'] },
    ]);
    expect(validateManifest(m, h.registry, 'full').issues).toEqual([]);
  });

  it('the example spec builds a valid manifest too', () => {
    const h = makeHarness();
    const m = manifestFromSpec(SPEC_EXAMPLE, 'meeting actions', h.registry);
    expect(validateManifest(m, h.registry, 'full').issues).toEqual([]);
  });

  it('ignores unknown tools and returns null when none are usable', () => {
    const h = makeHarness();
    expect(manifestFromSpec({ tools: ['do_magic'] }, 'x', h.registry)).toBeNull();
    const m = manifestFromSpec(
      { tools: 'tasks.list, do_magic', dailyAt: '25:99' },
      'abc',
      h.registry,
    );
    expect(m.steps.map((s: { tool?: string }) => s.tool).filter(Boolean)).toEqual(['tasks.list']);
    expect(m.triggers).toEqual([{ type: 'manual' }]);
  });

  it('a good flat reply yields a skill on the first call', async () => {
    let calls = 0;
    const h = makeHarness({
      responder: () => {
        calls++;
        return {
          text: JSON.stringify({
            title: 'Task digest',
            tools: ['tasks.list'],
            instruction: 'What is due today?',
            dailyAt: '',
            phrases: [],
          }),
        };
      },
    });
    const gen = new SkillGenerator(h.registry, h.inference, () => 'full');
    const d = await gen.draft('Turn on do not disturb every night');
    expect(d.issues).toEqual([]);
    expect(d.manifest?.name).toBe('task-digest');
    expect(calls).toBe(1);
  });
});

describe('repairing invented permissions', () => {
  const { repairManifest } = require('../../src/skills/repairManifest');
  it('keeps real permission names and drops invented ones', () => {
    const fixed = repairManifest(
      {
        name: 'x-skill',
        description: 'desc',
        permissions: ['task_management', 'special:notification_listener', 'calendar'],
        steps: [{ id: 'a', tool: 'time.now', args: {} }],
      },
      'r',
    ) as { permissions: string[] };
    expect(fixed.permissions).toEqual(['special:notification_listener']);
  });
});

describe('direct skill building (no model)', () => {
  const { heuristicManifest, scheduleFrom } = require('../../src/skills/skillSpec');

  it('reads schedules from plain words', () => {
    expect(scheduleFrom('Every evening summarize my tasks')).toBe('19:00');
    expect(scheduleFrom('every morning brief me')).toBe('08:00');
    expect(scheduleFrom('remind me at 9 pm')).toBe('21:00');
    expect(scheduleFrom('at 21:30 list my tasks')).toBe('21:30');
    expect(scheduleFrom('12 am check')).toBe('00:00');
    expect(scheduleFrom('summarize my tasks')).toBeNull();
  });

  it('builds the task-digest skill from the request alone', async () => {
    let calls = 0;
    const h = makeHarness({
      responder: () => {
        calls++;
        return { text: '' };
      },
    });
    const gen = new SkillGenerator(h.registry, h.inference, () => 'full');
    const d = await gen.draft('Every evening summarize my open tasks and say which are due today');
    expect(calls).toBe(0);
    expect(d.issues).toEqual([]);
    const m = d.manifest!;
    expect(m.name).toBe('summarize-my-open-tasks');
    expect(m.steps.map(s => s.tool ?? s.operation)).toEqual(['tasks.list', 'summarize']);
    expect(m.triggers).toContainEqual({ type: 'daily', time: '19:00' });
  });

  it('picks meeting tools for a meeting request', () => {
    const h = makeHarness();
    const m = heuristicManifest(
      'Every Friday at 5 pm list the action items from my latest meeting',
      h.registry,
      'full',
    );
    expect(m.steps.map((s: { tool?: string }) => s.tool).filter(Boolean)).toContain(
      'meetings.latest',
    );
    expect(m.triggers).toContainEqual({ type: 'daily', time: '17:00' });
  });

  it('leaves action skills to the model path', () => {
    const h = makeHarness();
    expect(heuristicManifest('Turn on do not disturb every night', h.registry, 'full')).toBeNull();
  });
});
