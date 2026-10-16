import * as RNFS from '@dr.pogodin/react-native-fs';
import type { ActionItem, Meeting, MeetingIndexEntry } from './types';

/**
 * File-backed meeting store.
 *
 *   <Documents>/meetings/<id>/meeting.json
 *   <Documents>/meetings/<id>/audio/seg_00000.wav …
 *   <Documents>/meetings/<id>/exports/…
 *   <Documents>/meetings/index.json      (list cache, rebuildable)
 *
 * AsyncStorage is avoided on purpose: an hour of transcript plus history
 * quickly outgrows its per-key limits, and audio has to live on disk anyway.
 * Writes are serialised per meeting and go through a temp file.
 */

const ROOT = `${RNFS.DocumentDirectoryPath}/meetings`;
const INDEX = `${ROOT}/index.json`;

type Listener = () => void;

class MeetingStoreImpl {
  private meetings = new Map<string, Meeting>();
  private index: MeetingIndexEntry[] | null = null;
  private writeChains = new Map<string, Promise<void>>();
  private indexChain: Promise<void> = Promise.resolve();
  private listeners = new Set<Listener>();
  private loaded = false;

  dir(id: string) { return `${ROOT}/${id}`; }
  audioDir(id: string) { return `${ROOT}/${id}/audio`; }
  exportsDir(id: string) { return `${ROOT}/${id}/exports`; }

  newId(): string {
    const d = new Date();
    const stamp = `${d.getFullYear()}${String(d.getMonth() + 1).padStart(2, '0')}${String(d.getDate()).padStart(2, '0')}`;
    return `mtg_${stamp}_${Math.random().toString(36).slice(2, 8)}`;
  }

  subscribe(l: Listener): () => void {
    this.listeners.add(l);
    return () => { this.listeners.delete(l); };
  }
  private notify() { for (const l of this.listeners) { try { l(); } catch {} } }

  async ensureLoaded(): Promise<void> {
    if (this.loaded) return;
    await RNFS.mkdir(ROOT);
    try {
      if (await RNFS.exists(INDEX)) {
        this.index = JSON.parse(await RNFS.readFile(INDEX, 'utf8'));
      }
    } catch {
      this.index = null;
    }
    if (!this.index) await this.rebuildIndex();
    this.loaded = true;
  }

  async rebuildIndex(): Promise<void> {
    const entries: MeetingIndexEntry[] = [];
    const dirs = (await RNFS.readDir(ROOT)).filter(d => d.isDirectory());
    for (const d of dirs) {
      const m = await this.readMeetingFile(d.name);
      if (m) entries.push(toIndexEntry(m));
    }
    this.index = entries.sort((a, b) => b.startedAt - a.startedAt);
    await this.persistIndex();
  }

  async list(): Promise<MeetingIndexEntry[]> {
    await this.ensureLoaded();
    return [...(this.index ?? [])];
  }

  async get(id: string): Promise<Meeting | null> {
    await this.ensureLoaded();
    const cached = this.meetings.get(id);
    if (cached) return cached;
    const m = await this.readMeetingFile(id);
    if (m) this.meetings.set(id, m);
    return m;
  }

  /** Returns the live in-memory object (mutate via update()). */
  peek(id: string): Meeting | undefined {
    return this.meetings.get(id);
  }

  async create(m: Meeting): Promise<Meeting> {
    await this.ensureLoaded();
    await RNFS.mkdir(this.audioDir(m.id));
    this.meetings.set(m.id, m);
    await this.save(m);
    return m;
  }

  /** Applies a mutation to the cached meeting and persists it. */
  async update(id: string, mutate: (m: Meeting) => void): Promise<Meeting | null> {
    const m = await this.get(id);
    if (!m) return null;
    mutate(m);
    m.updatedAt = Date.now();
    await this.save(m);
    return m;
  }

  async delete(id: string): Promise<void> {
    await this.ensureLoaded();
    this.meetings.delete(id);
    try { await RNFS.unlink(this.dir(id)); } catch {}
    this.index = (this.index ?? []).filter(e => e.id !== id);
    await this.persistIndex();
    this.notify();
  }

  async deleteAudio(id: string): Promise<void> {
    try { await RNFS.unlink(this.audioDir(id)); } catch {}
    await RNFS.mkdir(this.audioDir(id));
    await this.update(id, m => {
      m.audioDeleted = true;
      for (const s of m.segments) s.audioFile = undefined;
    });
  }

  async storageBytes(id: string): Promise<number> {
    try {
      const files = await RNFS.readDir(this.audioDir(id));
      return files.reduce((n, f) => n + Number(f.size || 0), 0);
    } catch {
      return 0;
    }
  }

  async allActionItems(): Promise<{ meeting: MeetingIndexEntry; item: ActionItem }[]> {
    const out: { meeting: MeetingIndexEntry; item: ActionItem }[] = [];
    for (const e of await this.list()) {
      if (e.totalActions === 0) continue;
      const m = await this.get(e.id);
      if (!m) continue;
      for (const item of m.actionItems) out.push({ meeting: e, item });
    }
    return out;
  }

  async knownClients(): Promise<string[]> {
    const set = new Map<string, number>();
    for (const e of await this.list()) {
      if (e.client) set.set(e.client, (set.get(e.client) ?? 0) + 1);
    }
    return [...set.entries()].sort((a, b) => b[1] - a[1]).map(([c]) => c);
  }

  // ---------------------------------------------------------------------

  private async readMeetingFile(id: string): Promise<Meeting | null> {
    const path = `${this.dir(id)}/meeting.json`;
    try {
      if (!(await RNFS.exists(path))) return null;
      return JSON.parse(await RNFS.readFile(path, 'utf8')) as Meeting;
    } catch (e) {
      console.warn(`[MeetingStore] unreadable ${id}:`, e);
      return null;
    }
  }

  private save(m: Meeting): Promise<void> {
    const snapshot = JSON.stringify(m);
    const entry = toIndexEntry(m);
    const prev = this.writeChains.get(m.id) ?? Promise.resolve();
    const next = prev.then(async () => {
      const dir = this.dir(m.id);
      const tmp = `${dir}/meeting.json.tmp`;
      const dst = `${dir}/meeting.json`;
      await RNFS.mkdir(dir);
      await RNFS.writeFile(tmp, snapshot, 'utf8');
      if (await RNFS.exists(dst)) await RNFS.unlink(dst);
      await RNFS.moveFile(tmp, dst);
    }).catch(e => console.warn('[MeetingStore] save failed', e));
    this.writeChains.set(m.id, next);

    const idx = this.index ?? [];
    const i = idx.findIndex(e => e.id === m.id);
    if (i >= 0) idx[i] = entry; else idx.unshift(entry);
    this.index = idx.sort((a, b) => b.startedAt - a.startedAt);
    this.persistIndex();
    this.notify();
    return next;
  }

  private persistIndex(): Promise<void> {
    const snapshot = JSON.stringify(this.index ?? []);
    this.indexChain = this.indexChain
      .then(() => RNFS.writeFile(INDEX, snapshot, 'utf8'))
      .catch(() => {});
    return this.indexChain;
  }
}

function toIndexEntry(m: Meeting): MeetingIndexEntry {
  return {
    id: m.id,
    title: m.title,
    client: m.client,
    startedAt: m.startedAt,
    durationMs: m.durationMs,
    status: m.status,
    openActions: m.actionItems.filter(a => a.status === 'open').length,
    totalActions: m.actionItems.length,
    hasMinutes: !!m.minutes,
    updatedAt: m.updatedAt,
  };
}

export const meetingStore = new MeetingStoreImpl();

export function newActionId(): string {
  return `act_${Date.now().toString(36)}${Math.random().toString(36).slice(2, 6)}`;
}
