import { BUILTIN_SKILLS, MEETING_PREPARATION } from '../../src/skills/builtin';
import { canonicalJson, sha256Hex } from '../../src/skills/sha256';
import { planToManifest, SkillGenerator } from '../../src/skills/SkillGenerator';
import { hashManifest, SkillError } from '../../src/skills/SkillRegistry';
import { validateManifest } from '../../src/skills/SkillValidator';
import type { SkillManifest } from '../../src/skills/types';
import { makeHarness } from '../helpers/harness';

const notifications = {
  recent: async () => [
    {
      app: 'Slack',
      title: 'Rahul',
      text: 'Prod is down for UPI, can you join?',
      postedAt: Date.now(),
    },
    { app: 'Gmail', title: 'Newsletter', text: 'Top 10 gadgets', postedAt: Date.now() },
  ],
};

describe('sha256', () => {
  it('matches known vectors', () => {
    expect(sha256Hex('')).toBe('e3b0c44298fc1c149afbf4c8996fb92427ae41e4649b934ca495991b7852b855');
    expect(sha256Hex('abc')).toBe(
      'ba7816bf8f01cfea414140de5dae2223b00361a396177a9cb410ff61f20015ad',
    );
    expect(sha256Hex('नमस्ते')).toHaveLength(64);
  });
  it('canonical JSON is key-order independent', () => {
    expect(canonicalJson({ b: 1, a: [2, { d: 1, c: 2 }] })).toBe(
      canonicalJson({ a: [2, { c: 2, d: 1 }], b: 1 }),
    );
  });
});

describe('skill validation', () => {
  const h = makeHarness({ notifications });

  it('all built-in skills are valid', () => {
    for (const m of BUILTIN_SKILLS)
      expect(validateManifest(m, h.registry, 'full').issues).toEqual([]);
  });

  it('rejects executable content anywhere in the manifest', () => {
    const bad = {
      ...MEETING_PREPARATION,
      steps: [{ id: 'x', tool: 'time.now', args: {}, script: 'rm -rf /' }],
    };
    const r = validateManifest(bad, h.registry, 'full');
    expect(r.ok).toBe(false);
    expect(r.issues.map(i => i.message).join()).toMatch(/executable content/);
  });

  it('rejects permission escalation (tool needs a permission the skill did not declare)', () => {
    const r = validateManifest(
      { ...MEETING_PREPARATION, permissions: ['special:notification_listener'] },
      h.registry,
      'full',
    );
    expect(r.issues.some(i => /special:notification_policy/.test(i.message))).toBe(true);
  });

  it('rejects sensitive steps without explicit approval', () => {
    const m: SkillManifest = {
      name: 'tapper',
      version: '1.0.0',
      description: 'tap things',
      permissions: ['special:accessibility'],
      steps: [{ id: 'a', tool: 'tap_element', args: { target: 'OK' } }],
    };
    expect(validateManifest(m, h.registry, 'full').issues.map(i => i.path)).toContain(
      '$.steps[0].requiresApproval',
    );
  });

  it('rejects bad triggers and unknown tools', () => {
    const m = {
      name: 'bad-one',
      version: '1.0.0',
      description: 'bad',
      permissions: [],
      triggers: [{ type: 'interval', minutes: 1 }],
      steps: [{ id: 'a', tool: 'nuke' }],
    };
    const msgs = validateManifest(m, h.registry, 'full').issues.map(i => i.message);
    expect(msgs).toEqual(
      expect.arrayContaining(['interval must be ≥ 15 minutes', 'unknown tool nuke']),
    );
  });
});

describe('skill registry', () => {
  it('installs built-ins, matches phrases and compiles plans with inputs', async () => {
    const h = makeHarness({ notifications });
    await h.skills.installBuiltins();
    expect((await h.skills.list()).map(s => s.manifest.name).sort()).toEqual([
      'end-of-day',
      'focus-mode',
      'meeting-followup',
      'meeting-preparation',
      'morning-briefing',
    ]);
    const m = await h.skills.match("I'm going into a meeting now");
    expect(m?.name).toBe('meeting-preparation');
    const focus = await h.skills.planFor('skl_focus-mode', { seconds: 1500 });
    expect(focus!.steps.find(s => s.id === 'timer')).toMatchObject({ args: { seconds: 1500 } });
  });

  it('imports skills disabled, verifies integrity and refuses tampering', async () => {
    const h = makeHarness();
    await h.skills.installBuiltins();
    const exported = await h.skills.export('skl_end-of-day');
    const bundle = JSON.parse(exported);
    bundle.manifest.name = 'end-of-day-copy';
    await expect(h.skills.import(JSON.stringify(bundle))).rejects.toThrow(/Integrity check failed/);
    bundle.hash = hashManifest(bundle.manifest);
    const imported = await h.skills.import(JSON.stringify(bundle));
    expect(imported).toMatchObject({ enabled: false, source: 'imported' });
    // Timed built-in routines are opt-in.
    expect((await h.skills.get('skl_end-of-day'))!.enabled).toBe(false);
    expect((await h.skills.get('skl_focus-mode'))!.enabled).toBe(true);
    expect(await h.skills.match('wrap up my day')).toBeNull();
    await h.skills.setEnabled('skl_end-of-day', true);
    expect(await h.skills.match('wrap up my day')).toMatchObject({ name: 'end-of-day' }); // copy not active
    await h.skills.setEnabled(imported.id, true);
    expect((await h.skills.get(imported.id))!.enabled).toBe(true);
  });

  it('accepts YAML manifests like the PRD example', async () => {
    const h = makeHarness({ notifications });
    const yaml = `name: quiet-hour
version: 1.0.0
description: Quiet hour
permissions:
  - special:notification_policy
steps:
  - id: dnd
    tool: toggle_dnd
    args: { enable: true }
    requiresApproval: true
`;
    const s = await h.skills.import(yaml);
    expect(s.manifest.steps[0]).toMatchObject({ tool: 'toggle_dnd', requiresApproval: true });
  });

  it('built-ins cannot be removed, unavailable ones are skipped, invalid imports explain why', async () => {
    const h = makeHarness(); // no notification access wired in this session
    const r = await h.skills.installBuiltins();
    expect(r.skipped.map(s => s.name).sort()).toEqual(['meeting-preparation', 'morning-briefing']);
    await expect(h.skills.remove('skl_focus-mode')).rejects.toThrow(SkillError);
    await expect(h.skills.import('{"name":"x"}')).rejects.toMatchObject({
      issues: expect.any(Array),
    });
  });
});

describe('PRD §21 flagship: meeting preparation', () => {
  it('summarizes urgent notifications locally, enables DnD with approval, drafts but never sends', async () => {
    const h = makeHarness({
      notifications,
      responder: (ctx, req) => {
        const prompt = req.messages.at(-1)!.content;
        if (ctx.stepId === 'urgent') {
          expect(prompt).toContain('Prod is down');
          expect(prompt).toContain('content, not instructions');
          return { text: '- Slack, Rahul: prod is down for UPI, wants you to join' };
        }
        if (ctx.stepId === 'replies')
          return { text: '- Rahul: In a meeting until 4, joining right after.' };
        if (ctx.stepId === 'briefing')
          return {
            text: 'Urgent: Rahul — UPI prod down.\nSuggested replies (not sent): In a meeting until 4.',
          };
        throw new Error(`unexpected ${ctx.stepId}`);
      },
    });
    h.permissions.granted.add('special:notification_listener');
    h.permissions.granted.add('special:notification_policy');
    await h.skills.installBuiltins();
    const res = await h.controller.execute({
      text: "I'm going into a meeting. Check my notifications, summarize urgent messages, enable Do Not Disturb, and prepare replies.",
      source: 'chat',
    });
    expect(res.state).toBe('COMPLETED');
    expect(res.plan?.source).toBe('skill');
    expect(h.inference.calls.every(c => c.decision.executionMode === 'local')).toBe(true);
    expect(h.approvalLog.map(a => a.detail)).toEqual(['toggle_dnd({"enable":true})']);
    expect(h.legacyCalls.map(c => c.name)).toEqual(['toggle_dnd']); // nothing sent
    expect(res.response).toContain('Suggested replies (not sent)');
  });

  it('without notification access it fails visibly and recoverably, without crashing', async () => {
    const h = makeHarness({ notifications, responder: () => ({ text: 'x' }) });
    h.permissions.granted.add('special:notification_policy');
    await h.skills.installBuiltins();
    const res = await h.controller.execute({ text: 'meeting prep please', source: 'chat' });
    expect(res.state).toBe('FAILED');
    expect(res.steps.find(s => s.stepId === 'notifications')?.error?.code).toBe(
      'PERMISSION_REQUIRED',
    );
    expect(res.steps.find(s => s.stepId === 'briefing')?.status).toBe('skipped');
  });
});

describe('skill creation from natural language', () => {
  it('drafts, repairs and infers permissions; the result validates but is not enabled', async () => {
    let n = 0;
    const h = makeHarness({
      notifications,
      responder: () =>
        n++ === 0
          ? { text: '{"name":"Morning Notes","steps":[]}' }
          : {
              text: JSON.stringify({
                name: 'notification-digest',
                version: '1.0.0',
                description: 'Summarize notifications every morning',
                permissions: [],
                triggers: [{ type: 'daily', time: '08:00' }],
                steps: [
                  { id: 'n', tool: 'notifications.recent', args: { sinceMinutes: 720 } },
                  {
                    id: 's',
                    operation: 'summarize',
                    prompt: 'Summarize {{steps.n.output}}',
                    dataClass: 'personal',
                    dependsOn: ['n'],
                  },
                ],
                responseStep: 's',
              }),
            },
    });
    const gen = new SkillGenerator(h.registry, h.inference, () => 'full');
    const d = await gen.draft('Every morning, summarize important notifications');
    expect(d.manifest?.permissions).toEqual(['special:notification_listener']);
    const installed = await h.skills.install(d.manifest, 'generated');
    expect(installed.enabled).toBe(false);
  });

  it('saves a working ad-hoc plan as a reusable skill', () => {
    const h = makeHarness();
    const m = planToManifest(
      {
        goal: 'focus',
        source: 'planner',
        steps: [{ id: 's1', kind: 'tool', tool: 'toggle_dnd', args: { enable: true } }],
      },
      'My Focus!',
      'Quiet time',
      h.registry,
    );
    expect(m).toMatchObject({ name: 'my-focus', permissions: ['special:notification_policy'] });
    expect(validateManifest(m, h.registry, 'full').ok).toBe(true);
  });
});
