import * as RNFS from '@dr.pogodin/react-native-fs';
import { AppState, type EmitterSubscription } from 'react-native';
import { modelLifecycle } from '../services/ModelLifecycleManager';
import { getModelTier } from '../config/modelTiers';
import { memoryService } from '../services/MemoryService';
import { meetingStore } from './MeetingStore';
import { defaultTitle, generateMinutes, transcriptPlain } from './MinutesGenerator';
import { Recorder, RecorderEvents, ensureRecordingPermissions } from './native';
import { getMeetingSettings } from './settings';
import { transcriber } from './Transcriber';
import type { Attendee, Meeting, RecorderSegmentEvent, TranscriptSegment } from './types';
import { buildMinutesMarkdown } from './documents';

/**
 * Owns the single active recording and the post-processing pipeline:
 *
 *   native segment ─▶ store(pending) ─▶ transcriber ─▶ store(done)
 *   stop ─▶ drain STT ─▶ minutes (LLM) ─▶ ready
 *
 * Every step persists, so a crash at any point is recoverable via
 * recoverInterrupted() / processMeeting().
 */

export interface LiveState {
  meetingId: string | null;
  phase: 'idle' | 'starting' | 'recording' | 'paused' | 'stopping' | 'transcribing' | 'summarizing';
  elapsedMs: number;
  levelDb: number;
  isSpeech: boolean;
  silenced: boolean;
  pendingSegments: number;
  progressLabel?: string;
  progress?: number;
  error?: string;
}

type Listener = (s: LiveState) => void;

const IDLE: LiveState = {
  meetingId: null, phase: 'idle', elapsedMs: 0, levelDb: -90, isSpeech: false, silenced: false, pendingSegments: 0,
};

class MeetingSessionImpl {
  private state: LiveState = { ...IDLE };
  private listeners = new Set<Listener>();
  private subs: EmitterSubscription[] = [];
  private segmentChain: Promise<void> = Promise.resolve();
  private processing = new Set<string>();

  subscribe(l: Listener): () => void {
    this.listeners.add(l);
    l(this.state);
    return () => { this.listeners.delete(l); };
  }
  get live(): LiveState { return this.state; }
  private set(p: Partial<LiveState>) {
    this.state = { ...this.state, ...p };
    for (const l of this.listeners) { try { l(this.state); } catch {} }
  }

  syncElapsed(elapsedMs: number) {
    if (this.state.phase === 'recording' || this.state.phase === 'paused') this.set({ elapsedMs });
  }

  isBusy(id?: string): boolean {
    if (id) return (this.state.meetingId === id && this.state.phase !== 'idle') || this.processing.has(id);
    return this.state.phase !== 'idle';
  }

  // ---------------------------------------------------------------------
  // Recording

  async start(params: {
    title?: string;
    client?: string;
    project?: string;
    attendees?: Attendee[];
    agenda?: string;
    continueMeetingId?: string;
  }): Promise<string> {
    if (this.state.phase !== 'idle') throw new Error('A meeting is already in progress');
    this.set({ ...IDLE, phase: 'starting' });
    try {
      if (!(await ensureRecordingPermissions())) throw new Error('Microphone permission is required');
      const settings = await getMeetingSettings();

      let meeting: Meeting;
      if (params.continueMeetingId) {
        const existing = await meetingStore.get(params.continueMeetingId);
        if (!existing) throw new Error('Meeting not found');
        meeting = (await meetingStore.update(existing.id, m => { m.status = 'recording'; }))!;
      } else {
        const now = Date.now();
        meeting = await meetingStore.create({
          schemaVersion: 1,
          id: meetingStore.newId(),
          title: params.title?.trim() || defaultTitle(now, params.client?.trim()),
          client: params.client?.trim() || undefined,
          project: params.project?.trim() || undefined,
          attendees: params.attendees ?? [],
          agenda: params.agenda?.trim() || undefined,
          startedAt: now,
          durationMs: 0,
          status: 'recording',
          source: 'recording',
          language: settings.language,
          sttModel: settings.sttModel,
          segments: [],
          markers: [],
          actionItems: [],
          updatedAt: now,
        });
      }

      this.attach(meeting.id);
      const lastIndex = meeting.segments.reduce((n, s) => Math.max(n, s.index), -1);
      await Recorder.start({
        dir: meetingStore.audioDir(meeting.id),
        source: settings.audioSource,
        title: meeting.title,
        startIndex: lastIndex + 1,
        startOffsetMs: meeting.durationMs,
        foreground: true,
      });
      this.set({ meetingId: meeting.id, phase: 'recording', elapsedMs: meeting.durationMs });

      // Warm up STT while the first segment fills (~20 s); failures surface per segment.
      transcriber.prepare(settings.sttModel).catch(e =>
        this.set({ error: `Speech model: ${e instanceof Error ? e.message : String(e)}` }),
      );
      return meeting.id;
    } catch (e) {
      this.detach();
      this.set({ ...IDLE, error: e instanceof Error ? e.message : String(e) });
      throw e;
    }
  }

  async pause() {
    await Recorder.pause();
    if (this.state.meetingId) await meetingStore.update(this.state.meetingId, m => { m.status = 'paused'; });
  }

  async resume() {
    await Recorder.resume();
    if (this.state.meetingId) await meetingStore.update(this.state.meetingId, m => { m.status = 'recording'; });
  }

  async addMarker(note: string) {
    const id = this.state.meetingId;
    if (!id) return;
    const at = this.state.elapsedMs;
    await meetingStore.update(id, m => { m.markers.push({ atMs: at, note: note.trim() }); });
  }

  /** Stops capture, then transcribes the backlog and (optionally) writes minutes. */
  async stop(): Promise<void> {
    const id = this.state.meetingId;
    if (!id || (this.state.phase !== 'recording' && this.state.phase !== 'paused')) return;
    this.set({ phase: 'stopping' });
    let elapsed = this.state.elapsedMs;
    try {
      elapsed = await Recorder.stop();
    } catch (e) {
      console.warn('[MeetingSession] stop failed', e);
    }
    // Final segment event is posted just before stop() resolves; give it a beat.
    await new Promise(r => setTimeout(r, 400));
    await this.segmentChain;
    await meetingStore.update(id, m => {
      m.endedAt = Date.now();
      m.durationMs = Math.max(m.durationMs, elapsed);
      m.status = 'transcribing';
    });
    this.detach();
    this.set({ phase: 'idle', meetingId: null });
    await this.processMeeting(id);
  }

  // ---------------------------------------------------------------------
  // Post-processing (also used for recovery and "retry")

  async processMeeting(id: string, opts: { forceMinutes?: boolean } = {}): Promise<void> {
    if (this.processing.has(id)) return;
    this.processing.add(id);
    const settings = await getMeetingSettings();
    try {
      await Recorder.setProcessing('Transcribing meeting…').catch(() => {});
      this.set({ meetingId: id, phase: 'transcribing', progressLabel: 'Transcribing', progress: 0 });
      await this.transcribePending(id);

      const meeting = await meetingStore.get(id);
      if (!meeting) return;
      const hasText = meeting.segments.some(s => s.status === 'done' && s.text);
      const wantMinutes = opts.forceMinutes || (settings.autoGenerateMinutes && !meeting.minutes?.edited);

      if (hasText && wantMinutes) {
        await meetingStore.update(id, m => { m.status = 'summarizing'; });
        await Recorder.setProcessing('Writing minutes…').catch(() => {});
        this.set({ phase: 'summarizing', progressLabel: 'Writing minutes', progress: 0 });
        await generateMinutes(id, settings.summaryModel, (label, p) =>
          this.set({ progressLabel: label, progress: p }),
        );
        if (getModelTier(settings.summaryModel) !== 'hot') {
          await modelLifecycle.release(settings.summaryModel).catch(() => {});
        }
      } else {
        await meetingStore.update(id, m => {
          m.status = 'ready';
          if (!hasText) m.error = 'No speech was transcribed.';
        });
      }

      if (!settings.keepAudio) await meetingStore.deleteAudio(id);
      if (settings.indexForChat) await this.indexForChat(id).catch(() => {});
    } catch (e) {
      const msg = e instanceof Error ? e.message : String(e);
      await meetingStore.update(id, m => { m.status = 'error'; m.error = msg; });
      this.set({ error: msg });
    } finally {
      this.processing.delete(id);
      await transcriber.release();
      await Recorder.release().catch(() => {});
      this.set({ ...IDLE });
    }
  }

  /** Marks meetings left mid-flight by a crash and repairs their last WAV. */
  async recoverInterrupted(): Promise<string[]> {
    const status = await Recorder.getStatus().catch(() => null);
    const live = status && status.state !== 'idle';
    const out: string[] = [];
    for (const e of await meetingStore.list()) {
      if (!['recording', 'paused', 'transcribing', 'summarizing'].includes(e.status)) continue;
      if (live || this.processing.has(e.id) || this.state.meetingId === e.id) continue;
      await this.adoptOrphanSegments(e.id);
      await meetingStore.update(e.id, m => { m.status = 'interrupted'; });
      out.push(e.id);
    }
    return out;
  }

  // ---------------------------------------------------------------------

  private attach(meetingId: string) {
    this.detach();
    this.subs = [
      RecorderEvents.onSegment(seg => {
        this.segmentChain = this.segmentChain.then(() => this.onSegment(meetingId, seg)).catch(() => {});
      }),
      RecorderEvents.onLevel(l => this.set({ levelDb: l.db, elapsedMs: l.elapsedMs, isSpeech: l.isSpeech })),
      RecorderEvents.onState(s => {
        if (s.state === 'recording' || s.state === 'paused') this.set({ phase: s.state, elapsedMs: s.elapsedMs });
        meetingStore.update(meetingId, m => { m.durationMs = Math.max(m.durationMs, s.elapsedMs); });
      }),
      RecorderEvents.onError(e => this.set({ error: e.message })),
      RecorderEvents.onSilenced(e => this.set({ silenced: e.silenced })),
      RecorderEvents.onStopRequested(() => { this.stop().catch(() => {}); }),
    ];
  }

  private detach() {
    for (const s of this.subs) s.remove();
    this.subs = [];
  }

  private async onSegment(meetingId: string, e: RecorderSegmentEvent) {
    const file = e.path.split('/').pop()!;
    const seg: TranscriptSegment = {
      index: e.index,
      startMs: e.startMs,
      durationMs: e.durationMs,
      wallStartMs: e.wallStartMs,
      speechRatio: e.speechRatio,
      audioFile: file,
      text: '',
      status: 'pending',
    };
    await meetingStore.update(meetingId, m => {
      if (!m.segments.some(s => s.index === seg.index)) m.segments.push(seg);
      m.segments.sort((a, b) => a.index - b.index);
      m.durationMs = Math.max(m.durationMs, e.startMs + e.durationMs);
    });
    this.set({ pendingSegments: this.state.pendingSegments + 1 });
    // Fire-and-forget: the transcriber queue serialises; we don't block new segments.
    this.transcribeSegment(meetingId, seg.index).finally(() =>
      this.set({ pendingSegments: Math.max(0, this.state.pendingSegments - 1) }),
    );
  }

  private async transcribeSegment(meetingId: string, index: number): Promise<void> {
    const settings = await getMeetingSettings();
    const m = await meetingStore.get(meetingId);
    const seg = m?.segments.find(s => s.index === index);
    if (!m || !seg || !seg.audioFile) return;
    if (!transcriber.getStatus().model) transcriber.prepare(m.sttModel ?? settings.sttModel).catch(() => {});

    const prev = [...m.segments].reverse().find(s => s.index < index && s.status === 'done' && s.text);
    const glossary = [
      m.client,
      m.project,
      ...m.attendees.map(a => a.name),
      settings.vocabulary,
    ].filter(Boolean).join(', ');

    const outcome = await transcriber.enqueue({
      audioPath: `${meetingStore.audioDir(meetingId)}/${seg.audioFile}`,
      speechRatio: seg.speechRatio,
      glossary,
      previousText: prev?.text ?? '',
      language: m.language || settings.language,
      task: settings.task,
      contextPrompting: settings.contextPrompting,
    });
    await meetingStore.update(meetingId, mm => {
      const s = mm.segments.find(x => x.index === index);
      if (!s) return;
      s.text = outcome.text;
      s.status = outcome.status;
      s.error = outcome.error;
    });
  }

  private async transcribePending(id: string): Promise<void> {
    // Segments queued during recording are still 'pending' in the store until the
    // queue reaches them; let it finish first so nothing is transcribed twice.
    await transcriber.drain();
    const m = await meetingStore.get(id);
    if (!m) return;
    const settings = await getMeetingSettings();
    const todo = m.segments.filter(s => (s.status === 'pending' || s.status === 'error') && s.audioFile);
    if (todo.length === 0) { await transcriber.drain(); return; }
    await transcriber.prepare(m.sttModel ?? settings.sttModel);
    let done = 0;
    for (const s of todo) {
      await this.transcribeSegment(id, s.index);
      done++;
      this.set({ progress: done / todo.length, progressLabel: `Transcribing ${done}/${todo.length}` });
    }
    await transcriber.drain();
  }

  /** Registers WAV files on disk that never made it into meeting.json (crash). */
  private async adoptOrphanSegments(id: string): Promise<void> {
    const dir = meetingStore.audioDir(id);
    if (!(await RNFS.exists(dir))) return;
    const files = (await RNFS.readDir(dir)).filter(f => /^seg_\d+\.wav$/.test(f.name));
    const m = await meetingStore.get(id);
    if (!m) return;
    const known = new Set(m.segments.map(s => s.audioFile));
    const orphans = files.filter(f => !known.has(f.name)).sort((a, b) => a.name.localeCompare(b.name));
    if (!orphans.length) return;
    let offset = m.segments.reduce((n, s) => Math.max(n, s.startMs + s.durationMs), 0);
    const added: TranscriptSegment[] = [];
    for (const f of orphans) {
      const bytes = await Recorder.repairWav(f.path).catch(() => Math.max(0, Number(f.size) - 44));
      const durationMs = Math.round((bytes / 2 / 16000) * 1000);
      if (durationMs < 300) continue;
      added.push({
        index: parseInt(f.name.slice(4, 9), 10),
        startMs: offset,
        durationMs,
        wallStartMs: m.startedAt + offset,
        speechRatio: 1, // unknown; let STT decide
        audioFile: f.name,
        text: '',
        status: 'pending',
      });
      offset += durationMs;
    }
    await meetingStore.update(id, mm => {
      mm.segments.push(...added);
      mm.segments.sort((a, b) => a.index - b.index);
      mm.durationMs = Math.max(mm.durationMs, offset);
    });
  }

  /** Adds transcript + minutes to the RAG document store so chat can recall them. */
  async indexForChat(id: string): Promise<void> {
    const m = await meetingStore.get(id);
    if (!m) return;
    const path = `${meetingStore.exportsDir(id)}/${id}_index.txt`;
    await RNFS.mkdir(meetingStore.exportsDir(id));
    const body = `${buildMinutesMarkdown(m)}\n\n## Transcript\n${transcriptPlain(m)}`;
    await RNFS.writeFile(path, body, 'utf8');
    await memoryService.addDocument(path);
  }
}

export const meetingSession = new MeetingSessionImpl();

// Keep elapsed time honest when returning from background (level events pause in Doze).
AppState.addEventListener('change', st => {
  if (st !== 'active') return;
  Recorder.getStatus()
    .then(s => {
      if (s.state === 'recording' || s.state === 'paused') meetingSession.syncElapsed(s.elapsedMs);
    })
    .catch(() => {});
});
