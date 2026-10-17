import AsyncStorage from '@react-native-async-storage/async-storage';

import { resolveDue, toIsoDate } from '../meetings/dateResolver';
import { meetingStore } from '../meetings/MeetingStore';
import type { ActionItem, ActionPriority } from '../meetings/types';

/**
 * Personal tasks + a unified view over meeting action items.
 *
 * Personal tasks are small, so they live in AsyncStorage. Meeting action items
 * stay owned by their meeting (single source of truth); the unified list
 * reads them and writes status changes back through meetingStore.
 */

export interface PersonalTask {
  id: string;
  title: string;
  notes?: string;
  dueDate?: string; // YYYY-MM-DD
  dueText?: string;
  priority?: ActionPriority;
  client?: string;
  status: 'open' | 'done';
  createdAt: number;
  completedAt?: number;
  calendarAdded?: boolean;
}

export type TaskSource = 'personal' | 'meeting';

export interface UnifiedTask {
  key: string; // `${source}:${id}` (+ meeting id)
  source: TaskSource;
  id: string;
  title: string;
  owner?: string;
  client?: string;
  dueDate?: string;
  dueText?: string;
  priority?: ActionPriority;
  status: 'open' | 'done';
  createdAt: number;
  completedAt?: number;
  meetingId?: string;
  meetingTitle?: string;
  notes?: string;
}

export type TaskBucket = 'overdue' | 'today' | 'upcoming' | 'someday' | 'done';

const KEY = '@liquid_personal_tasks';

type Listener = () => void;

class TaskStoreImpl {
  private tasks: PersonalTask[] | null = null;
  private listeners = new Set<Listener>();
  private chain: Promise<void> = Promise.resolve();

  constructor() {
    meetingStore.subscribe(() => this.notify());
  }

  subscribe(l: Listener): () => void {
    this.listeners.add(l);
    return () => {
      this.listeners.delete(l);
    };
  }
  private notify() {
    for (const l of this.listeners) {
      try {
        l();
      } catch {}
    }
  }

  private async load(): Promise<PersonalTask[]> {
    if (this.tasks) return this.tasks;
    try {
      const raw = await AsyncStorage.getItem(KEY);
      this.tasks = raw ? JSON.parse(raw) : [];
    } catch {
      this.tasks = [];
    }
    return this.tasks!;
  }

  private persist() {
    const snap = JSON.stringify(this.tasks ?? []);
    this.chain = this.chain.then(() => AsyncStorage.setItem(KEY, snap)).catch(() => {});
    this.notify();
    return this.chain;
  }

  async addPersonal(
    t: Omit<PersonalTask, 'id' | 'createdAt' | 'status'> & { status?: 'open' | 'done' },
  ): Promise<PersonalTask> {
    const list = await this.load();
    const task: PersonalTask = {
      ...t,
      id: `tsk_${Date.now().toString(36)}${Math.random().toString(36).slice(2, 6)}`,
      status: t.status ?? 'open',
      createdAt: Date.now(),
    };
    list.unshift(task);
    await this.persist();
    return task;
  }

  /** Parses quick-add text: "Send proposal to Acme by Friday !high @Acme". */
  async quickAdd(text: string, now = new Date()): Promise<PersonalTask | null> {
    const parsed = parseQuickAdd(text, now);
    if (!parsed.title) return null;
    return this.addPersonal(parsed);
  }

  async updatePersonal(id: string, patch: Partial<PersonalTask>): Promise<void> {
    const list = await this.load();
    const t = list.find(x => x.id === id);
    if (!t) return;
    Object.assign(t, patch);
    await this.persist();
  }

  async deletePersonal(id: string): Promise<void> {
    const list = await this.load();
    this.tasks = list.filter(x => x.id !== id);
    await this.persist();
  }

  async setStatus(task: UnifiedTask, status: 'open' | 'done'): Promise<void> {
    const completedAt = status === 'done' ? Date.now() : undefined;
    if (task.source === 'personal') {
      await this.updatePersonal(task.id, { status, completedAt });
    } else if (task.meetingId) {
      await meetingStore.update(task.meetingId, m => {
        const a = m.actionItems.find(x => x.id === task.id);
        if (a) {
          a.status = status;
          a.completedAt = completedAt;
        }
      });
    }
  }

  async setDue(task: UnifiedTask, dueDate: string | undefined, dueText?: string): Promise<void> {
    if (task.source === 'personal') {
      await this.updatePersonal(task.id, { dueDate, dueText });
    } else if (task.meetingId) {
      await meetingStore.update(task.meetingId, m => {
        const a = m.actionItems.find(x => x.id === task.id);
        if (a) {
          a.dueDate = dueDate;
          a.dueText = dueText ?? a.dueText;
          a.manual = true;
        }
      });
    }
  }

  async markCalendarAdded(task: UnifiedTask): Promise<void> {
    if (task.source === 'personal') await this.updatePersonal(task.id, { calendarAdded: true });
    else if (task.meetingId) {
      await meetingStore.update(task.meetingId, m => {
        const a = m.actionItems.find(x => x.id === task.id);
        if (a) a.calendarAdded = true;
      });
    }
  }

  async all(): Promise<UnifiedTask[]> {
    const personal = (await this.load()).map<UnifiedTask>(t => ({
      key: `personal:${t.id}`,
      source: 'personal',
      id: t.id,
      title: t.title,
      owner: 'Me',
      client: t.client,
      dueDate: t.dueDate,
      dueText: t.dueText,
      priority: t.priority,
      status: t.status,
      createdAt: t.createdAt,
      completedAt: t.completedAt,
      notes: t.notes,
    }));
    const fromMeetings = (await meetingStore.allActionItems()).map<UnifiedTask>(
      ({ meeting, item }) => ({
        key: `meeting:${meeting.id}:${item.id}`,
        source: 'meeting',
        id: item.id,
        title: item.task,
        owner: item.owner,
        client: meeting.client,
        dueDate: item.dueDate,
        dueText: item.dueText,
        priority: item.priority,
        status: item.status,
        createdAt: item.createdAt,
        completedAt: item.completedAt,
        meetingId: meeting.id,
        meetingTitle: meeting.title,
      }),
    );
    return [...personal, ...fromMeetings];
  }
}

export const taskStore = new TaskStoreImpl();

// ---------------------------------------------------------------------------

const PRIORITY_RANK: Record<string, number> = { high: 0, medium: 1, low: 2 };

export function bucketOf(t: UnifiedTask, today = toIsoDate(new Date())): TaskBucket {
  if (t.status === 'done') return 'done';
  if (!t.dueDate) return 'someday';
  if (t.dueDate < today) return 'overdue';
  if (t.dueDate === today) return 'today';
  return 'upcoming';
}

export function sortTasks(xs: UnifiedTask[]): UnifiedTask[] {
  return [...xs].sort((a, b) => {
    if (a.status !== b.status) return a.status === 'open' ? -1 : 1;
    if (a.status === 'done') return (b.completedAt ?? 0) - (a.completedAt ?? 0);
    const da = a.dueDate ?? '9999',
      db = b.dueDate ?? '9999';
    if (da !== db) return da < db ? -1 : 1;
    const pa = PRIORITY_RANK[a.priority ?? 'medium'],
      pb = PRIORITY_RANK[b.priority ?? 'medium'];
    if (pa !== pb) return pa - pb;
    return b.createdAt - a.createdAt;
  });
}

/** Names that mean "the user" when an action item owner is extracted from a meeting. */
export function isMine(t: UnifiedTask, myNames: string[]): boolean {
  if (t.source === 'personal') return true;
  const o = (t.owner ?? '').toLowerCase().trim();
  if (!o) return false;
  return (
    ['me', 'i', 'myself', 'us', 'we'].includes(o) ||
    myNames.some(n => {
      const name = n.trim().toLowerCase();
      if (!name) return false;
      // Whole-word match: "Al" must not claim "Sally"'s tasks.
      const esc = name.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
      return new RegExp(`(^|[^\\p{L}])${esc}($|[^\\p{L}])`, 'u').test(o);
    })
  );
}

export function parseQuickAdd(
  text: string,
  now = new Date(),
): Omit<PersonalTask, 'id' | 'createdAt' | 'status'> {
  let t = ` ${text.trim()} `;
  let priority: ActionPriority | undefined;
  let client: string | undefined;

  const pm = t.match(/\s!(high|h|medium|med|m|low|l|!{1,2})\s/i);
  if (pm) {
    const v = pm[1].toLowerCase();
    priority =
      v.startsWith('h') || v === '!!'
        ? 'high'
        : v.startsWith('l')
          ? 'low'
          : v === '!'
            ? 'high'
            : 'medium';
    t = t.replace(pm[0], ' ');
  }
  const cm = t.match(/\s@([\w&.-]+(?:\s[A-Z][\w&.-]*)?)/);
  if (cm) {
    client = cm[1];
    t = t.replace(cm[0], ' ');
  }

  // Deadline phrase: "by/on/before/due X" or a trailing date word.
  let dueText: string | undefined;
  const dm =
    t.match(
      /\s(?:by|on|before|due|until)\s+((?:the\s)?(?:end of (?:the )?(?:day|week|month|next week)|next \w+|this \w+|coming \w+|tomorrow|today|tonight|day after tomorrow|in \d+ (?:days?|weeks?|months?)|\d{1,2}(?:st|nd|rd|th)?(?: of)? [a-z]{3,9}|[a-z]{3,9} \d{1,2}(?:st|nd|rd|th)?|\d{1,2}[/-]\d{1,2}(?:[/-]\d{2,4})?|monday|tuesday|wednesday|thursday|friday|saturday|sunday|eod|eow))\b/i,
    ) ??
    t.match(
      /\s((?:tomorrow|today|tonight|next week|(?:next |this )?(?:monday|tuesday|wednesday|thursday|friday|saturday|sunday)))\s*$/i,
    );
  let dueDate: string | undefined;
  if (dm) {
    // Only strip the phrase if it really is a date ("on page 5" stays in the title).
    dueDate = resolveDue(dm[1].trim(), now);
    if (dueDate) {
      dueText = dm[1].trim();
      t = t.replace(dm[0], ' ');
    }
  }
  return {
    title: t.replace(/\s+/g, ' ').trim(),
    dueText: dueDate ? dueText : undefined,
    dueDate,
    priority,
    client,
  };
}

export type { ActionItem };
