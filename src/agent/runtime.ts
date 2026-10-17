/**
 * The app-wide agent runtime: AgentRuntime wired to the Android native layer,
 * the file-backed meeting and task stores, and the UI approval queue.
 * Imported once by App.tsx so the database key provider is installed before
 * any screen touches SQLite.
 */
import { getModelBySlug } from '../config/models';
import { meetingStore } from '../meetings/MeetingStore';
import { memoryProposals } from '../memory/proposals';
import { platform } from '../platform/android';
import { approvals } from '../security/ApprovalManager';
import { setDatabaseKeyProvider } from '../storage/db';
import { bucketOf, taskStore } from '../tasks/TaskStore';
import type { MeetingsPort, TasksPort } from '../tools/builtin/app';
import { listDownloadedCactusModels } from '../utils/engineMigration';
import { storage } from '../utils/storage';
import { AgentRuntime } from './AgentRuntime';

setDatabaseKeyProvider(() => platform.credentials.databaseKey());

const lower = (s?: string) => (s ?? '').toLowerCase();

export const meetingsPort: MeetingsPort = {
  async latest(client) {
    const list = (await meetingStore.list())
      .filter(
        m =>
          !client ||
          lower(m.client).includes(lower(client)) ||
          lower(m.title).includes(lower(client)),
      )
      .sort((a, b) => b.startedAt - a.startedAt);
    if (!list.length) return null;
    const m = await meetingStore.get(list[0].id);
    if (!m) return null;
    return {
      id: m.id,
      title: m.title,
      client: m.client,
      startedAt: m.startedAt,
      summary: m.minutes?.summary,
      decisions: m.minutes?.decisions ?? [],
      actionItems: m.actionItems.map(a => ({
        task: a.task,
        owner: a.owner,
        due: a.dueDate ?? a.dueText,
        status: a.status,
      })),
      attendees: m.attendees.map(a => ({ name: a.name, email: a.email })),
    };
  },
  async search(query, limit) {
    const terms = lower(query).split(/\s+/).filter(Boolean);
    const list = await meetingStore.list();
    const hits: { id: string; title: string; client?: string; startedAt: number; score: number }[] =
      [];
    for (const m of list) {
      let hay = `${lower(m.title)} ${lower(m.client)}`;
      let score = terms.filter(t => hay.includes(t)).length;
      if (!score && m.hasMinutes) {
        const full = await meetingStore.get(m.id);
        hay += ` ${lower(full?.minutes?.summary)} ${lower(full?.minutes?.keyPoints.join(' '))}`;
        score = terms.filter(t => hay.includes(t)).length * 0.5;
      }
      if (score)
        hits.push({ id: m.id, title: m.title, client: m.client, startedAt: m.startedAt, score });
    }
    return hits
      .sort((a, b) => b.score - a.score || b.startedAt - a.startedAt)
      .slice(0, limit)
      .map(({ score: _s, ...h }) => h);
  },
};

export const tasksPort: TasksPort = {
  async add(t) {
    const task = await taskStore.addPersonal({
      title: t.title,
      dueDate: t.dueDate,
      dueText: t.dueText,
      priority: t.priority,
      client: t.client,
    });
    return { id: task.id, title: task.title, dueDate: task.dueDate };
  },
  async list(view, limit) {
    const all = await taskStore.all();
    const pick = all.filter(t => {
      if (t.status !== 'open') return false;
      const b = bucketOf(t);
      return view === 'open'
        ? true
        : view === 'overdue'
          ? b === 'overdue'
          : b === 'today' || b === 'overdue';
    });
    return pick.slice(0, limit).map(t => ({
      title: t.title,
      dueDate: t.dueDate,
      source: t.source === 'meeting' ? `meeting: ${t.meetingTitle ?? ''}` : 'personal',
      status: t.status,
    }));
  },
};

let preferredModel: string | undefined;
let downloaded: Set<string> | null = null;

/** Refreshes the cached set of downloaded local models (call after a download or delete). */
export async function refreshLocalModels(): Promise<void> {
  downloaded = new Set((await listDownloadedCactusModels()).map(m => m.slug));
  const s = await storage.getSettings().catch(() => null);
  preferredModel = s?.model;
}

export const agentRuntime = new AgentRuntime({
  platform,
  meetings: meetingsPort,
  tasks: tasksPort,
  approvals,
  preferredLocalModel: () => preferredModel,
  localAvailability: async id => {
    if (!downloaded) await refreshLocalModels();
    return !!downloaded?.has(id) || !getModelBySlug(id);
  },
  onMemoryProposal: (p, executionId) => memoryProposals.add(p, executionId),
});

/** Starts the runtime once at app launch; failures are reported, not thrown. */
export async function startAgentRuntime(): Promise<string | null> {
  try {
    await refreshLocalModels();
    await agentRuntime.ready();
    return null;
  } catch (e) {
    return e instanceof Error ? e.message : String(e);
  }
}
