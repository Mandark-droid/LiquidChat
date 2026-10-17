import AsyncStorage from '@react-native-async-storage/async-storage';

import { toIsoDate } from '../../src/meetings/dateResolver';
import { meetingStore } from '../../src/meetings/MeetingStore';
import {
  bucketOf,
  isMine,
  parseQuickAdd,
  sortTasks,
  taskStore,
  type UnifiedTask,
} from '../../src/tasks/TaskStore';
import { action, makeMeeting } from '../meetings/fixtures';

/** Friday 16 Oct 2026, 10:00 local. */
const NOW = new Date(2026, 9, 16, 10, 0);
const d = (m: number, day: number, y = 2026) => toIsoDate(new Date(y, m - 1, day));

describe('parseQuickAdd', () => {
  it('parses the documented example: title, priority, client and due', () => {
    expect(parseQuickAdd('send Acme proposal by Friday !high @Acme', NOW)).toEqual({
      title: 'send Acme proposal',
      dueText: 'Friday',
      dueDate: d(10, 23),
      priority: 'high',
      client: 'Acme',
    });
  });

  it('returns just a title for plain text', () => {
    expect(parseQuickAdd('  Review   the deck  ', NOW)).toEqual({
      title: 'Review the deck',
      dueText: undefined,
      dueDate: undefined,
      priority: undefined,
      client: undefined,
    });
  });

  it.each([
    ['!high', 'high'],
    ['!h', 'high'],
    ['!HIGH', 'high'],
    ['!!', 'high'],
    ['!!!', 'high'],
    ['!medium', 'medium'],
    ['!med', 'medium'],
    ['!m', 'medium'],
    ['!low', 'low'],
    ['!l', 'low'],
  ])('priority token %p -> %p', (tok, expected) => {
    const r = parseQuickAdd(`call Rahul ${tok}`, NOW);
    expect(r.priority).toBe(expected);
    expect(r.title).toBe('call Rahul');
  });

  it('priority tokens can appear anywhere, but not glued to a word', () => {
    expect(parseQuickAdd('!low tidy desk', NOW)).toMatchObject({
      title: 'tidy desk',
      priority: 'low',
    });
    expect(parseQuickAdd('wow!high five', NOW)).toMatchObject({
      title: 'wow!high five',
      priority: undefined,
    });
  });

  it('reads @client including a following capitalised word', () => {
    expect(parseQuickAdd('call @Acme Corp tomorrow', NOW)).toEqual({
      title: 'call',
      client: 'Acme Corp',
      dueText: 'tomorrow',
      dueDate: d(10, 17),
      priority: undefined,
    });
    expect(parseQuickAdd('invoice @globex.in for Q3', NOW)).toMatchObject({
      title: 'invoice for Q3',
      client: 'globex.in',
    });
    expect(parseQuickAdd('ping @R&D team', NOW)).toMatchObject({
      client: 'R&D',
      title: 'ping team',
    });
  });

  it('does not treat an email address as a client', () => {
    expect(parseQuickAdd('email rahul@acme.com the deck', NOW)).toMatchObject({
      title: 'email rahul@acme.com the deck',
      client: undefined,
    });
  });

  it.each([
    ['pay invoice by tomorrow', 'pay invoice', 'tomorrow', d(10, 17)],
    ['pay invoice tomorrow', 'pay invoice', 'tomorrow', d(10, 17)],
    ['submit report today', 'submit report', 'today', d(10, 16)],
    ['ship release by EOD', 'ship release', 'EOD', d(10, 16)],
    ['file taxes by EOW', 'file taxes', 'EOW', d(10, 16)],
    ['draft SOW by end of the week', 'draft SOW', 'end of the week', d(10, 16)],
    ['close books by the end of month', 'close books', 'the end of month', d(10, 31)],
    ['renew domain in 3 days', 'renew domain in 3 days', undefined, undefined],
    ['renew domain due in 3 days', 'renew domain', 'in 3 days', d(10, 19)],
    ['book venue by next Monday', 'book venue', 'next Monday', d(10, 19)],
    ['book venue next week', 'book venue', 'next week', d(10, 19)],
    ['demo on Tuesday', 'demo', 'Tuesday', d(10, 20)],
    ['demo this Thursday', 'demo', 'this Thursday', d(10, 22)],
    ['pay rent before 1st Nov', 'pay rent', '1st Nov', d(11, 1)],
    ['pay rent by Nov 5', 'pay rent', 'Nov 5', d(11, 5)],
    ['pay rent by 24/10', 'pay rent', '24/10', d(10, 24)],
    ['send pack until 03/11/2026', 'send pack', '03/11/2026', d(11, 3)],
  ])('%p -> title %p, dueText %p, dueDate %p', (text, title, dueText, dueDate) => {
    expect(parseQuickAdd(text, NOW)).toMatchObject({ title, dueText, dueDate });
  });

  it('keeps a weekday that is part of the title when it is not trailing', () => {
    expect(parseQuickAdd('prepare Monday standup notes', NOW)).toMatchObject({
      title: 'prepare Monday standup notes',
      dueDate: undefined,
    });
  });

  it('combines everything in any order', () => {
    expect(parseQuickAdd('@Globex !! renew contract by 2 Nov', NOW)).toEqual({
      title: 'renew contract',
      client: 'Globex',
      priority: 'high',
      dueText: '2 Nov',
      dueDate: d(11, 2),
    });
  });

  it('resolves relative to the supplied "now"', () => {
    expect(parseQuickAdd('call tomorrow', new Date(2026, 11, 31, 9)).dueDate).toBe(d(1, 1, 2027));
  });

  it('returns an empty title when only tokens are given', () => {
    expect(parseQuickAdd('!high @Acme', NOW).title).toBe('');
  });

  // Regression (fixed; src/tasks/TaskStore.ts:276-288): the due-phrase regex also matches
  // "<word> <number>" after "on/by" ("on page 5", "by step 2"). resolveDue then
  // returns undefined, so dueText is dropped — but the phrase was already cut
  // from the title, silently losing part of the task text.
  it('does not strip a non-date "on <word> <n>" phrase from the title', () => {
    expect(parseQuickAdd('fix typo on page 5', NOW)).toMatchObject({
      title: 'fix typo on page 5',
      dueDate: undefined,
    });
  });
});

// ---------------------------------------------------------------------------

let seq = 0;
const task = (over: Partial<UnifiedTask> = {}): UnifiedTask => {
  seq++;
  return {
    key: `personal:t${seq}`,
    source: 'personal',
    id: `t${seq}`,
    title: `Task ${seq}`,
    status: 'open',
    createdAt: 1_000 + seq,
    ...over,
  };
};

describe('bucketOf', () => {
  const today = '2026-10-16';

  it.each([
    [{ status: 'done', dueDate: '2026-10-01' }, 'done'],
    [{ status: 'done' }, 'done'],
    [{}, 'someday'],
    [{ dueDate: '2026-10-15' }, 'overdue'],
    [{ dueDate: '2025-12-31' }, 'overdue'],
    [{ dueDate: '2026-10-16' }, 'today'],
    [{ dueDate: '2026-10-17' }, 'upcoming'],
    [{ dueDate: '2027-01-01' }, 'upcoming'],
  ] as [Partial<UnifiedTask>, string][])('%p -> %p', (over, expected) => {
    expect(bucketOf(task(over), today)).toBe(expected);
  });

  it('defaults "today" to the current local date', () => {
    expect(bucketOf(task({ dueDate: toIsoDate(new Date()) }))).toBe('today');
  });
});

describe('sortTasks', () => {
  it('orders open before done, then by due date, priority and newest first', () => {
    const a = task({ title: 'no due, high', priority: 'high', createdAt: 1 });
    const b = task({ title: 'due 20, low', dueDate: '2026-10-20', priority: 'low' });
    const c = task({ title: 'due 18', dueDate: '2026-10-18' });
    const e = task({ title: 'due 20, high', dueDate: '2026-10-20', priority: 'high' });
    const f = task({
      title: 'due 20, medium (implicit), older',
      dueDate: '2026-10-20',
      createdAt: 5,
    });
    const g = task({
      title: 'due 20, medium, newer',
      dueDate: '2026-10-20',
      priority: 'medium',
      createdAt: 9,
    });
    const h = task({ title: 'no due, low', priority: 'low', createdAt: 2 });
    const done1 = task({ title: 'done early', status: 'done', completedAt: 100 });
    const done2 = task({ title: 'done late', status: 'done', completedAt: 200 });
    const done3 = task({ title: 'done, no timestamp', status: 'done' });

    const input = [done1, a, b, done3, c, e, f, h, done2, g];
    const snapshot = [...input];
    expect(sortTasks(input).map(t => t.title)).toEqual([
      'due 18',
      'due 20, high',
      'due 20, medium, newer',
      'due 20, medium (implicit), older',
      'due 20, low',
      'no due, high',
      'no due, low',
      'done late',
      'done early',
      'done, no timestamp',
    ]);
    expect(input).toEqual(snapshot); // not mutated
  });

  it('handles empty input', () => {
    expect(sortTasks([])).toEqual([]);
  });
});

describe('isMine', () => {
  const meetingTask = (owner?: string) =>
    task({ source: 'meeting', owner, meetingId: 'mtg_1', key: 'meeting:mtg_1:x' });

  it('personal tasks are always mine', () => {
    expect(isMine(task({ owner: 'Someone else' }), [])).toBe(true);
  });

  it.each(['Me', 'me', ' I ', 'myself', 'us', 'We'])('owner %p means the user', owner => {
    expect(isMine(meetingTask(owner), [])).toBe(true);
  });

  it('matches the configured names case-insensitively, including full names', () => {
    expect(isMine(meetingTask('Kshitij Thakkar'), ['kshitij'])).toBe(true);
    expect(isMine(meetingTask('KSHITIJ'), ['Kshitij'])).toBe(true);
  });

  it('does not match other owners, unowned items or empty configured names', () => {
    expect(isMine(meetingTask('Rahul Mehta'), ['Kshitij'])).toBe(false);
    expect(isMine(meetingTask(undefined), ['Kshitij'])).toBe(false);
    expect(isMine(meetingTask('   '), ['Kshitij'])).toBe(false);
    expect(isMine(meetingTask('Rahul'), ['', 'Kshitij'])).toBe(false);
    expect(isMine(meetingTask('Team'), [])).toBe(false);
  });

  // Regression (fixed; src/tasks/TaskStore.ts:245): names are matched with a raw substring
  // test, so a short configured name matches unrelated owners ("Al" -> "Sally",
  // "Raj" -> "Rajesh"), putting other people's action items in "Mine".
  it('matches configured names on word boundaries only', () => {
    expect(isMine(meetingTask('Sally'), ['Al'])).toBe(false);
    expect(isMine(meetingTask('Rajesh Kumar'), ['Raj'])).toBe(false);
  });
});

// ---------------------------------------------------------------------------

describe('taskStore (AsyncStorage + meetingStore integration)', () => {
  it('quickAdd persists a parsed personal task and all() merges meeting items', async () => {
    const created = await taskStore.quickAdd('send Acme proposal by Friday !high @Acme', NOW);
    expect(created).toMatchObject({
      title: 'send Acme proposal',
      dueDate: d(10, 23),
      priority: 'high',
      client: 'Acme',
      status: 'open',
    });
    expect(created!.id).toMatch(/^tsk_/);
    const saved = JSON.parse((await AsyncStorage.getItem('@liquid_personal_tasks'))!);
    expect(saved[0].id).toBe(created!.id);

    expect(await taskStore.quickAdd('   !high  ', NOW)).toBeNull();

    const m = makeMeeting({ actionItems: [action({ task: 'Share SOW', owner: 'Priya' })] });
    await meetingStore.create(m);
    const all = await taskStore.all();
    const mine = all.find(t => t.id === created!.id)!;
    expect(mine).toMatchObject({ source: 'personal', owner: 'Me', key: `personal:${created!.id}` });
    const fromMeeting = all.find(t => t.meetingId === m.id)!;
    expect(fromMeeting).toMatchObject({
      source: 'meeting',
      title: 'Share SOW',
      owner: 'Priya',
      client: 'Acme',
      meetingTitle: 'Acme kickoff',
    });

    await taskStore.setStatus(fromMeeting, 'done');
    expect((await meetingStore.get(m.id))!.actionItems[0]).toMatchObject({ status: 'done' });
    await taskStore.setDue(fromMeeting, '2026-11-01', '1 Nov');
    expect((await meetingStore.get(m.id))!.actionItems[0]).toMatchObject({
      dueDate: '2026-11-01',
      dueText: '1 Nov',
      manual: true,
    });

    await taskStore.setStatus(mine, 'done');
    const after = (await taskStore.all()).find(t => t.id === created!.id)!;
    expect(after.status).toBe('done');
    expect(after.completedAt).toEqual(expect.any(Number));

    await taskStore.deletePersonal(created!.id);
    expect((await taskStore.all()).some(t => t.id === created!.id)).toBe(false);
  });
});
