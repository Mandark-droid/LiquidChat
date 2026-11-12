import * as RNFS from '@dr.pogodin/react-native-fs';
import { AppState, type EmitterSubscription } from 'react-native';

import { getModelTier } from '../config/modelTiers';
import { autoIndexer } from '../memory/autoIndex';
import { modelLifecycle } from '../services/ModelLifecycleManager';
import { storage } from '../utils/storage';
import { minutesInCloud, processMeetingInCloud } from './cloudMeeting';
import { meetingStore } from './MeetingStore';
import { traceMeeting } from './meetingTrace';
import { defaultTitle, generateMinutes } from './MinutesGenerator';
import { ensureRecordingPermissions, Recorder, RecorderEvents } from './native';
import { getMeetingSettings } from './settings';
import { identifySpeakers } from './SpeakerIdentifier';
import { transcriber } from './Transcriber';
import type {
  Attendee,
  Meeting,
  PickedAudio,
  RecorderSegmentEvent,
  TranscriptSegment,
} from './types';

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
  /** Processing runs on the LiquidChat Space rather than the phone. */
  remote?: boolean;
  error?: string;
}

type Listener = (s: LiveState) => void;

const SATURATED_DB = -10;

/** Thrown from a progress callback once the user stops processing; unwinds the pipeline. */
export class ProcessingStopped extends Error {
  constructor() {
    super('Processing stopped');
    this.name = 'ProcessingStopped';
  }
}

function warn(what: string, e: unknown) {
  console.warn(`[MeetingSession] ${what} failed: ${e instanceof Error ? e.message : String(e)}`);
}

const IDLE: LiveState = {
  meetingId: null,
  phase: 'idle',
  elapsedMs: 0,
  levelDb: -90,
  isSpeech: false,
  silenced: false,
  pendingSegments: 0,
};

class MeetingSessionImpl {
  private state: LiveState = { ...IDLE };
  private listeners = new Set<Listener>();
  private subs: EmitterSubscription[] = [];
  private segmentChain: Promise<void> = Promise.resolve();
  private processing = new Set<string>();
  private stopRequested = new Set<string>();
  /** Engine of the active recording: on 'space' the phone does not transcribe while recording. */
  private liveEngine: 'device' | 'space' = 'device';

  subscribe(l: Listener): () => void {
    this.listeners.add(l);
    l(this.state);
    return () => {
      this.listeners.delete(l);
    };
  }
  get live(): LiveState {
    return this.state;
  }
  /** Whether the active recording is transcribed on the phone as it goes. */
  get transcribesLive(): boolean {
    return this.liveEngine === 'device';
  }
  private set(p: Partial<LiveState>) {
    this.state = { ...this.state, ...p };
    for (const l of this.listeners) {
      try {
        l(this.state);
      } catch {}
    }
  }

  syncElapsed(elapsedMs: number) {
    if (this.state.phase === 'recording' || this.state.phase === 'paused') this.set({ elapsedMs });
  }

  isBusy(id?: string): boolean {
    if (id)
      return (
        (this.state.meetingId === id && this.state.phase !== 'idle') || this.processing.has(id)
      );
    return this.state.phase !== 'idle';
  }

  /**
   * Stops on-device or Space processing of a meeting at its next step (a segment, a minutes
   * part, a Space call). What was already transcribed is kept.
   */
  stopProcessing(id: string): void {
    if (!this.processing.has(id)) return;
    this.stopRequested.add(id);
    if (this.state.meetingId === id) this.set({ progressLabel: 'Stopping' });
  }

  /** Progress reporter for one meeting's pipeline; throws once a stop was requested. */
  private progressFor(id: string) {
    return (label: string, progress: number) => {
      this.checkStop(id);
      this.set({ progressLabel: label, progress });
    };
  }

  private checkStop(id: string): void {
    if (this.stopRequested.has(id)) throw new ProcessingStopped();
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
      if (!(await ensureRecordingPermissions()))
        throw new Error('Microphone permission is required');
      const settings = await getMeetingSettings();

      let meeting: Meeting;
      if (params.continueMeetingId) {
        const existing = await meetingStore.get(params.continueMeetingId);
        if (!existing) throw new Error('Meeting not found');
        meeting = (await meetingStore.update(existing.id, m => {
          m.status = 'recording';
        }))!;
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

      this.liveEngine = settings.engine;
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
      // On the Space engine the whole recording is transcribed there afterwards instead.
      if (settings.engine === 'device')
        transcriber
          .prepare(settings.sttModel)
          .catch(e =>
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
    if (this.state.meetingId)
      await meetingStore.update(this.state.meetingId, m => {
        m.status = 'paused';
      });
  }

  async resume() {
    await Recorder.resume();
    if (this.state.meetingId)
      await meetingStore.update(this.state.meetingId, m => {
        m.status = 'recording';
      });
  }

  async addMarker(note: string) {
    const id = this.state.meetingId;
    if (!id) return;
    const at = this.state.elapsedMs;
    await meetingStore.update(id, m => {
      m.markers.push({ atMs: at, note: note.trim() });
    });
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
  // Uploaded recordings

  /**
   * Creates a meeting from an audio/video file and returns its id at once; decoding,
   * transcription and minutes then run in the background through processMeeting().
   */
  async importRecording(params: {
    file: PickedAudio;
    title?: string;
    client?: string;
    attendees?: Attendee[];
    agenda?: string;
  }): Promise<string> {
    if (this.state.phase !== 'idle') throw new Error('Finish the current meeting first');
    const settings = await getMeetingSettings();
    const now = Date.now();
    const meeting = await meetingStore.create({
      schemaVersion: 1,
      id: meetingStore.newId(),
      title:
        params.title?.trim() ||
        params.file.name.replace(/\.[^.]+$/, '') ||
        defaultTitle(now, params.client?.trim()),
      client: params.client?.trim() || undefined,
      attendees: params.attendees ?? [],
      agenda: params.agenda?.trim() || undefined,
      startedAt: now,
      durationMs: params.file.durationMs,
      status: 'transcribing',
      source: 'import',
      language: settings.language,
      sttModel: settings.sttModel,
      segments: [],
      markers: [],
      actionItems: [],
      updatedAt: now,
    });
    this.runImport(meeting.id, params.file.uri, settings.sttModel).catch(e => warn('import', e));
    return meeting.id;
  }

  cancelImport(): Promise<void> {
    return Recorder.cancelImport();
  }

  private async runImport(id: string, uri: string, sttModel: string): Promise<void> {
    this.processing.add(id);
    const sub = RecorderEvents.onImportProgress(e => {
      const p = e.totalMs > 0 ? Math.min(1, e.decodedMs / e.totalMs) : 0;
      this.set({ progress: p, progressLabel: `Decoding audio ${Math.round(p * 100)}%` });
    });
    try {
      await Recorder.setProcessing('Importing recording…').catch(() => {});
      this.set({
        ...IDLE,
        meetingId: id,
        phase: 'transcribing',
        progressLabel: 'Decoding audio',
        progress: 0,
      });
      transcriber.prepare(sttModel).catch(e => warn('STT prepare', e));
      const res = await Recorder.importAudio(uri, meetingStore.audioDir(id), { segmentSec: 30 });
      sub.remove();
      for (const s of res.segments) {
        if (s.meanDb > SATURATED_DB)
          console.warn(
            `[MeetingSession] Imported segment ${s.index}: mean level ${s.meanDb.toFixed(1)} dBFS, audio looks clipped or noisy`,
          );
      }
      await meetingStore.update(id, m => {
        m.segments = res.segments.map(s => ({
          index: s.index,
          startMs: s.startMs,
          durationMs: s.durationMs,
          wallStartMs: m.startedAt + s.startMs,
          speechRatio: s.speechRatio,
          audioFile: s.path.split('/').pop()!,
          text: '',
          status: 'pending' as const,
        }));
        m.durationMs = res.durationMs || m.durationMs;
        m.endedAt = m.startedAt + m.durationMs;
        if (!res.segments.length) {
          m.status = 'error';
          m.error = 'No audio could be decoded from this file.';
        }
      });
      if (!res.segments.length) throw new Error('No audio could be decoded from this file.');
    } catch (e) {
      sub.remove();
      const msg = e instanceof Error ? e.message : String(e);
      console.error(`[MeetingSession] Import ${id} failed: ${msg}`);
      await meetingStore.update(id, m => {
        m.status = 'error';
        m.error = msg;
      });
      this.processing.delete(id);
      await transcriber.release();
      await Recorder.release().catch(() => {});
      this.set({ ...IDLE, error: msg });
      return;
    }
    this.processing.delete(id);
    await this.processMeeting(id, { forceMinutes: true });
  }

  // ---------------------------------------------------------------------
  // Post-processing (also used for recovery and "retry")

  processMeeting(id: string, opts: { forceMinutes?: boolean } = {}): Promise<void> {
    return traceMeeting(id, 'process', () => this.processMeetingTraced(id, opts));
  }

  private async processMeetingTraced(id: string, opts: { forceMinutes?: boolean }): Promise<void> {
    if (this.processing.has(id)) return;
    const settings = await getMeetingSettings();
    this.stopRequested.delete(id);
    if (settings.engine === 'space') {
      // Minutes alone only when the transcript is complete; otherwise the Space transcribes too
      // (an import or a stopped run would else be transcribed on the phone).
      const current = await meetingStore.get(id);
      const transcribed =
        !!current?.segments.some(s => s.status === 'done') &&
        !current.segments.some(s => s.status === 'pending' || s.status === 'error');
      const done =
        opts.forceMinutes && transcribed
          ? await this.minutesInCloud(id)
          : await this.processInCloud(id, { fallback: true });
      // Stopped on the Space: not a reason to start over on the phone.
      if (done || this.stopRequested.delete(id)) return;
    }
    this.processing.add(id);
    const progress = this.progressFor(id);
    try {
      await Recorder.setProcessing('Transcribing meeting…').catch(() => {});
      this.set({
        meetingId: id,
        phase: 'transcribing',
        progressLabel: 'Transcribing',
        progress: 0,
      });
      await this.transcribePending(id);

      const transcribed = await meetingStore.get(id);
      if (transcribed && !transcribed.speakers?.length) {
        // Cactus models share one native thread pool: Whisper must be idle (released).
        await transcriber.release();
        await Recorder.setProcessing('Identifying speakers…').catch(() => {});
        this.set({ progressLabel: 'Identifying speakers', progress: 0 });
        await identifySpeakers(id, progress).catch(e => {
          if (e instanceof ProcessingStopped) throw e;
          warn('speakers', e);
        });
      }
      this.checkStop(id);

      const meeting = await meetingStore.get(id);
      if (!meeting) return;
      const hasText = meeting.segments.some(s => s.status === 'done' && s.text);
      const wantMinutes =
        opts.forceMinutes || (settings.autoGenerateMinutes && !meeting.minutes?.edited);

      if (hasText && wantMinutes) {
        await meetingStore.update(id, m => {
          m.status = 'summarizing';
        });
        await Recorder.setProcessing('Writing minutes…').catch(() => {});
        this.set({ phase: 'summarizing', progressLabel: 'Writing minutes', progress: 0 });
        const done = await generateMinutes(id, settings.summaryModel, progress);
        const used = done.minutes?.model ?? settings.summaryModel;
        if (getModelTier(used) !== 'hot') {
          await modelLifecycle.release(used).catch(e => warn(`release ${used}`, e));
        }
      } else {
        await meetingStore.update(id, m => {
          m.status = 'ready';
          if (!hasText) m.error = 'No speech was transcribed.';
        });
      }

      if (!settings.keepAudio) await meetingStore.deleteAudio(id);
      if (settings.indexForChat) autoIndexer.enqueue(id);
    } catch (e) {
      if (e instanceof ProcessingStopped) {
        await this.markStopped(id);
        return;
      }
      const msg = e instanceof Error ? e.message : String(e);
      console.error(`[MeetingSession] Processing ${id} failed: ${msg}`);
      await meetingStore.update(id, m => {
        m.status = 'error';
        m.error = msg;
      });
      this.set({ error: msg });
    } finally {
      this.processing.delete(id);
      this.stopRequested.delete(id);
      await transcriber.release();
      await Recorder.release().catch(() => {});
      this.set({ ...IDLE });
    }
  }

  /**
   * High-accuracy mode: transcript, speakers and minutes from the LiquidChat Space, written into the
   * meeting only once everything has come back. Returns false when it did not complete; with
   * `fallback` the caller then processes on the phone, and the meeting says why.
   */
  processInCloud(id: string, opts: { fallback?: boolean } = {}): Promise<boolean> {
    return traceMeeting(id, 'process_space', () => this.processInCloudTraced(id, opts));
  }

  private async processInCloudTraced(id: string, opts: { fallback?: boolean }): Promise<boolean> {
    if (this.processing.has(id)) return false;
    const settings = await getMeetingSettings();
    const token = (await storage.getSettings())?.hfToken?.trim() ?? '';
    if (!token) {
      if (!opts.fallback)
        throw new Error('Add your Hugging Face token in Settings to use the LiquidChat Space.');
      await meetingStore.update(id, m => {
        m.error = 'No Hugging Face token, so this meeting was processed on the phone.';
      });
      return false;
    }
    const before = await meetingStore.get(id);
    if (!before) return false;
    this.processing.add(id);
    const progress = this.progressFor(id);
    try {
      // The phone's speech model is not needed while the Space works; free its memory.
      await transcriber.release();
      await Recorder.setProcessing('Processing on your LiquidChat Space…').catch(() => {});
      await meetingStore.update(id, m => {
        m.status = 'transcribing';
        m.error = undefined;
      });
      this.set({
        meetingId: id,
        phase: 'transcribing',
        progressLabel: 'Starting',
        progress: 0,
        remote: true,
      });
      await processMeetingInCloud(
        id,
        { spaceId: settings.spaceId, token, asrModel: settings.spaceAsrModel },
        (label, p) => {
          progress(label, p);
          this.set({ phase: p >= 0.8 ? 'summarizing' : 'transcribing' });
        },
      );
      if (!settings.keepAudio) await meetingStore.deleteAudio(id);
      if (settings.indexForChat) autoIndexer.enqueue(id);
      return true;
    } catch (e) {
      if (e instanceof ProcessingStopped) {
        await this.markStopped(id, before.status);
        return false;
      }
      const msg = e instanceof Error ? e.message : String(e);
      console.error(`[MeetingSession] LiquidChat Space failed for ${id}: ${msg}`);
      await meetingStore.update(id, m => {
        m.status =
          before.status === 'transcribing' || before.status === 'summarizing'
            ? 'ready'
            : before.status;
        m.error = opts.fallback
          ? `LiquidChat Space unavailable (${msg}); processed on the phone instead.`
          : `LiquidChat Space: ${msg}`;
      });
      if (!opts.fallback) this.set({ error: msg });
      return false;
    } finally {
      this.processing.delete(id);
      // With fallback the caller reads the stop request (and clears it) before going on.
      if (!opts.fallback) this.stopRequested.delete(id);
      await Recorder.release().catch(() => {});
      this.set({ ...IDLE });
    }
  }

  /** "Regenerate minutes" in Space mode: Gemma 4 on the existing transcript; false falls back to the phone. */
  private async minutesInCloud(id: string): Promise<boolean> {
    const settings = await getMeetingSettings();
    const token = (await storage.getSettings())?.hfToken?.trim() ?? '';
    if (!token || this.processing.has(id)) return false;
    this.processing.add(id);
    const progress = this.progressFor(id);
    try {
      await meetingStore.update(id, m => {
        m.status = 'summarizing';
        m.error = undefined;
      });
      this.set({
        meetingId: id,
        phase: 'summarizing',
        progressLabel: 'Writing minutes',
        progress: 0.8,
        remote: true,
      });
      await minutesInCloud(
        id,
        { spaceId: settings.spaceId, token, asrModel: settings.spaceAsrModel },
        progress,
      );
      if (settings.indexForChat) autoIndexer.enqueue(id);
      return true;
    } catch (e) {
      if (e instanceof ProcessingStopped) {
        await this.markStopped(id);
        return false;
      }
      const msg = e instanceof Error ? e.message : String(e);
      console.error(`[MeetingSession] LiquidChat Space minutes failed for ${id}: ${msg}`);
      await meetingStore.update(id, m => {
        m.status = 'ready';
        m.error = `LiquidChat Space unavailable (${msg}); minutes written on the phone instead.`;
      });
      return false;
    } finally {
      this.processing.delete(id);
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
      await meetingStore.update(e.id, m => {
        m.status = 'interrupted';
        m.error = undefined; // the banner then explains a crash, not an earlier stop
      });
      out.push(e.id);
    }
    return out;
  }

  // ---------------------------------------------------------------------

  private attach(meetingId: string) {
    this.detach();
    this.subs = [
      RecorderEvents.onSegment(seg => {
        this.segmentChain = this.segmentChain
          .then(() => this.onSegment(meetingId, seg))
          .catch(e => warn(`segment ${seg.index}`, e));
      }),
      RecorderEvents.onLevel(l =>
        this.set({ levelDb: l.db, elapsedMs: l.elapsedMs, isSpeech: l.isSpeech }),
      ),
      RecorderEvents.onState(s => {
        if (s.state === 'recording' || s.state === 'paused')
          this.set({ phase: s.state, elapsedMs: s.elapsedMs });
        meetingStore.update(meetingId, m => {
          m.durationMs = Math.max(m.durationMs, s.elapsedMs);
        });
      }),
      RecorderEvents.onError(e => this.set({ error: e.message })),
      RecorderEvents.onSilenced(e => this.set({ silenced: e.silenced })),
      RecorderEvents.onStopRequested(() => {
        this.stop().catch(() => {});
      }),
    ];
  }

  private detach() {
    for (const s of this.subs) s.remove();
    this.subs = [];
  }

  private async onSegment(meetingId: string, e: RecorderSegmentEvent) {
    const file = e.path.split('/').pop()!;
    // Speech averages roughly -35..-20 dBFS; a mean near full scale means the mic delivered
    // noise or clipped audio, which Whisper turns into repetition loops.
    if (e.meanDb > SATURATED_DB) {
      console.warn(
        `[MeetingSession] Segment ${e.index}: mean level ${e.meanDb.toFixed(1)} dBFS, input looks saturated or noisy (source may be misbehaving)`,
      );
    }
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
    if (this.liveEngine === 'space') return; // stays pending; the Space transcribes it after
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
    if (!transcriber.getStatus().model)
      transcriber.prepare(m.sttModel ?? settings.sttModel).catch(e => warn('STT prepare', e));

    const prev = [...m.segments]
      .reverse()
      .find(s => s.index < index && s.status === 'done' && s.text);
    const glossary = [m.client, m.project, ...m.attendees.map(a => a.name), settings.vocabulary]
      .filter(Boolean)
      .join(', ');

    const outcome = await transcriber.enqueue({
      audioPath: `${meetingStore.audioDir(meetingId)}/${seg.audioFile}`,
      speechRatio: seg.speechRatio,
      glossary,
      previousText: prev?.text ?? '',
      language: m.language || settings.language,
      task: settings.task,
      contextPrompting: settings.contextPrompting,
    });
    if (outcome.status === 'error') {
      console.warn(`[MeetingSession] Segment ${index} transcription failed: ${outcome.error}`);
    }
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
    const todo = m.segments.filter(
      s => (s.status === 'pending' || s.status === 'error') && s.audioFile,
    );
    if (todo.length === 0) {
      await transcriber.drain();
      return;
    }
    await transcriber.prepare(m.sttModel ?? settings.sttModel);
    let done = 0;
    for (const s of todo) {
      this.checkStop(id);
      await this.transcribeSegment(id, s.index);
      done++;
      this.set({
        progress: done / todo.length,
        progressLabel: `Transcribing ${done}/${todo.length}`,
      });
    }
    await transcriber.drain();
  }

  /** After a stop: the meeting keeps what was done and says how to finish it. */
  private async markStopped(id: string, previous?: Meeting['status']): Promise<void> {
    console.log(`[MeetingSession] Processing ${id} stopped by the user`);
    await meetingStore.update(id, m => {
      const unfinished = m.segments.some(s => s.status === 'pending' || s.status === 'error');
      m.status =
        previous && previous !== 'transcribing' && previous !== 'summarizing'
          ? previous
          : unfinished && !m.minutes
            ? 'interrupted'
            : 'ready';
      m.error = 'Processing was stopped. Run it again from the ⋯ menu when you are ready.';
    });
  }

  /** Registers WAV files on disk that never made it into meeting.json (crash). */
  private async adoptOrphanSegments(id: string): Promise<void> {
    const dir = meetingStore.audioDir(id);
    if (!(await RNFS.exists(dir))) return;
    const files = (await RNFS.readDir(dir)).filter(f => /^seg_\d+\.wav$/.test(f.name));
    const m = await meetingStore.get(id);
    if (!m) return;
    const known = new Set(m.segments.map(s => s.audioFile));
    const orphans = files
      .filter(f => !known.has(f.name))
      .sort((a, b) => a.name.localeCompare(b.name));
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
}

export const meetingSession = new MeetingSessionImpl();
// Indexing waits while a meeting is recorded or processed.
autoIndexer.setBusyCheck(() => meetingSession.isBusy());

// Keep elapsed time honest when returning from background (level events pause in Doze).
AppState.addEventListener('change', st => {
  if (st !== 'active') return;
  Recorder.getStatus()
    .then(s => {
      if (s.state === 'recording' || s.state === 'paused') meetingSession.syncElapsed(s.elapsedMs);
    })
    .catch(() => {});
});
