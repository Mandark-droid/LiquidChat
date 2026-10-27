/**
 * Background indexing jobs: keeps meetings searchable in chat (the RAG documents store) without
 * the user pressing anything. A meeting is (re)indexed once its minutes exist or change, chunks of
 * deleted meetings are removed, and jobs run one at a time, never while a meeting is being
 * recorded or processed (both want the phone's memory and CPU).
 */
import * as RNFS from '@dr.pogodin/react-native-fs';
import AsyncStorage from '@react-native-async-storage/async-storage';

import { buildMinutesMarkdown } from '../meetings/documents';
import { meetingStore } from '../meetings/MeetingStore';
import { transcriptPlain } from '../meetings/MinutesGenerator';
import { getMeetingSettings } from '../meetings/settings';
import type { Meeting } from '../meetings/types';
import { memoryService } from '../services/MemoryService';

const KEY = '@liquid_autoindex_v1';
const RETRY_MS = 60_000;

/** What was indexed: changes when minutes are regenerated or the transcript is redone. */
export function meetingVersion(m: Meeting): string | null {
  if (!m.minutes || m.status !== 'ready') return null;
  const spoken = m.segments.filter(s => s.status === 'done').length;
  return `${m.minutes.generatedAt}:${m.sttModel ?? ''}:${spoken}`;
}

export function indexFileName(meetingId: string): string {
  return `${meetingId}_index.txt`;
}

/** Which meetings need (re)indexing and which indexed meetings no longer exist. */
export function planIndexJobs(
  meetings: { id: string; version: string | null }[],
  indexed: Record<string, string>,
): { index: string[]; remove: string[] } {
  const present = new Set(meetings.map(m => m.id));
  return {
    index: meetings.filter(m => m.version && indexed[m.id] !== m.version).map(m => m.id),
    remove: Object.keys(indexed).filter(id => !present.has(id)),
  };
}

class AutoIndexer {
  private queue: string[] = [];
  private running = false;
  private timer: ReturnType<typeof setTimeout> | null = null;
  private busy: () => boolean = () => false;

  /** Set by the meeting session (avoids an import cycle). */
  setBusyCheck(fn: () => boolean): void {
    this.busy = fn;
  }

  /** Queue one meeting (after its minutes are written). */
  enqueue(meetingId: string): void {
    if (!this.queue.includes(meetingId)) this.queue.push(meetingId);
    this.kick();
  }

  /** Catch up: index what is missing or stale, drop what was deleted. */
  async sweep(): Promise<void> {
    const settings = await getMeetingSettings();
    if (!settings.indexForChat) return;
    const indexed = await this.load();
    const metas: { id: string; version: string | null }[] = [];
    for (const e of await meetingStore.list()) {
      const m = e.hasMinutes ? await meetingStore.get(e.id) : null;
      metas.push({ id: e.id, version: m ? meetingVersion(m) : null });
    }
    const plan = planIndexJobs(metas, indexed);
    if (plan.remove.length) {
      await memoryService.loadStores();
      for (const id of plan.remove) {
        memoryService.removeSource(indexFileName(id));
        delete indexed[id];
      }
      await this.store(indexed);
    }
    for (const id of plan.index) this.enqueue(id);
  }

  private kick(): void {
    if (this.running || this.timer || !this.queue.length) return;
    if (this.busy()) {
      this.timer = setTimeout(() => {
        this.timer = null;
        this.kick();
      }, RETRY_MS);
      return;
    }
    this.running = true;
    this.run().finally(() => {
      this.running = false;
      if (this.queue.length) this.kick();
    });
  }

  private async run(): Promise<void> {
    while (this.queue.length && !this.busy()) {
      const id = this.queue.shift()!;
      try {
        if (!(await getMeetingSettings()).indexForChat) {
          this.queue = [];
          return;
        }
        const m = await meetingStore.get(id);
        const version = m && meetingVersion(m);
        if (!m || !version) continue;
        const indexed = await this.load();
        if (indexed[id] === version && (await memoryService.hasSource(indexFileName(id)))) continue;
        const dir = meetingStore.exportsDir(id);
        await RNFS.mkdir(dir);
        const path = `${dir}/${indexFileName(id)}`;
        await RNFS.writeFile(
          path,
          `${buildMinutesMarkdown(m)}\n\n## Transcript\n${transcriptPlain(m)}`,
          'utf8',
        );
        const chunks = await memoryService.addDocument(path);
        await RNFS.unlink(path).catch(() => undefined);
        indexed[id] = version;
        await this.store(indexed);
        console.log(`[AutoIndex] ${id}: ${chunks} chunks`);
      } catch (e) {
        console.warn(`[AutoIndex] ${id} not indexed:`, e);
      }
    }
  }

  private async load(): Promise<Record<string, string>> {
    try {
      return JSON.parse((await AsyncStorage.getItem(KEY)) ?? '{}');
    } catch {
      return {};
    }
  }

  private store(v: Record<string, string>): Promise<void> {
    return AsyncStorage.setItem(KEY, JSON.stringify(v));
  }
}

export const autoIndexer = new AutoIndexer();
