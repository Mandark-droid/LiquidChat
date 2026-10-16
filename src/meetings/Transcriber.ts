import { CactusSTT } from 'cactus-react-native';
import { quantizationFor } from '../config/models';

/**
 * Serial on-device transcription for meeting segments.
 *
 * One CactusSTT instance is kept warm for the whole meeting. Segments arrive
 * every ~20–30 s from the native recorder and are processed in order so the
 * previous segment's tail can be fed back as Whisper context.
 */

export interface TranscribeJob {
  audioPath: string;
  speechRatio: number;
  /** Names / jargon to bias recognition (Whisper prompt). */
  glossary: string;
  /** Tail of the previous segment's text, for continuity across cuts. */
  previousText: string;
  language: string; // 'en' | 'hi' | … | 'auto'
  task: 'transcribe' | 'translate';
  contextPrompting: boolean;
}

export interface TranscribeOutcome {
  status: 'done' | 'skipped' | 'error';
  text: string;
  error?: string;
}

/** Below this fraction of speech frames a segment is treated as silence. */
const MIN_SPEECH_RATIO = 0.04;

// Classic Whisper hallucinations on silence / noise.
const HALLUCINATIONS = [
  /^thank(s| you)( so much)?( for watching)?[.!]*$/i,
  /^(you|bye|okay)[.!]*$/i,
  /^please subscribe.*$/i,
  /^subtitles? by.*$/i,
  /^[.\s…-]*$/,
  /^\[[^\]]*\]$/,
  /^\([^)]*\)$/,
  /^♪+$/,
];

export function cleanTranscript(raw: string): string {
  let t = (raw ?? '')
    .replace(/<\|[^|>]*\|>/g, ' ') // stray special tokens
    .replace(/\s+/g, ' ')
    .trim();
  t = collapseRepeats(t);
  if (HALLUCINATIONS.some(r => r.test(t))) return '';
  return t;
}

/** Collapses decoder loops such as "we will we will we will we will …". */
function collapseRepeats(text: string): string {
  let words = text.split(' ');
  for (let n = 1; n <= 8; n++) {
    const out: string[] = [];
    let i = 0;
    while (i < words.length) {
      const gram = words.slice(i, i + n).join(' ').toLowerCase();
      let reps = 1;
      if (i + n <= words.length) {
        while (
          words.slice(i + reps * n, i + (reps + 1) * n).join(' ').toLowerCase() === gram
        ) reps++;
      }
      if (reps >= 4) {
        out.push(...words.slice(i, i + 2 * n)); // keep two copies
        i += reps * n;
      } else {
        out.push(words[i]);
        i++;
      }
    }
    words = out;
  }
  return words.join(' ');
}

export function isWhisperModel(slug: string): boolean {
  return slug.startsWith('whisper');
}

export function buildWhisperPrompt(job: TranscribeJob): string {
  const lang = job.language === 'auto' ? '' : `<|${job.language}|>`;
  const task = `<|${job.task}|>`;
  const head = `<|startoftranscript|>${lang}${task}<|notimestamps|>`;
  if (!job.contextPrompting) return head;
  // Whisper conditions on at most ~224 prompt tokens; keep it short.
  const ctx = [job.glossary.trim(), job.previousText.trim().slice(-240)]
    .filter(Boolean)
    .join(' ')
    .slice(-400);
  return ctx ? `<|startofprev|> ${ctx}${head}` : head;
}

type Listener = (s: TranscriberStatus) => void;

export interface TranscriberStatus {
  model: string;
  phase: 'idle' | 'downloading' | 'initializing' | 'ready' | 'busy' | 'error';
  downloadProgress: number;
  queueLength: number;
  error?: string;
}

class TranscriberImpl {
  private stt: CactusSTT | null = null;
  private model = '';
  private queue: Array<{ job: TranscribeJob; resolve: (o: TranscribeOutcome) => void }> = [];
  private running = false;
  private promptSupported = true;
  private listeners = new Set<Listener>();
  private status: TranscriberStatus = { model: '', phase: 'idle', downloadProgress: 0, queueLength: 0 };
  private preparing: Promise<void> | null = null;

  subscribe(l: Listener): () => void {
    this.listeners.add(l);
    l(this.status);
    return () => { this.listeners.delete(l); };
  }

  getStatus(): TranscriberStatus { return this.status; }

  private set(p: Partial<TranscriberStatus>) {
    this.status = { ...this.status, ...p, queueLength: this.queue.length };
    for (const l of this.listeners) { try { l(this.status); } catch {} }
  }

  /** Downloads (if needed) and initialises the STT model. Idempotent. */
  prepare(model: string): Promise<void> {
    if (this.stt && this.model === model && this.status.phase !== 'error') return Promise.resolve();
    if (this.preparing && this.model === model) return this.preparing;
    this.preparing = (async () => {
      if (this.stt && this.model !== model) await this.release();
      this.model = model;
      this.promptSupported = true;
      const quantization = quantizationFor(model);
      const stt = new CactusSTT({ model, options: quantization ? { quantization } : undefined });
      try {
        this.set({ model, phase: 'downloading', downloadProgress: 0, error: undefined });
        await stt.download({ onProgress: p => this.set({ downloadProgress: p }) });
        this.set({ phase: 'initializing', downloadProgress: 1 });
        await stt.init();
        this.stt = stt;
        this.set({ phase: 'ready' });
      } catch (e) {
        const msg = e instanceof Error ? e.message : String(e);
        this.set({ phase: 'error', error: msg });
        try { await stt.destroy(); } catch {}
        throw e;
      } finally {
        this.preparing = null;
      }
    })();
    return this.preparing;
  }

  enqueue(job: TranscribeJob): Promise<TranscribeOutcome> {
    return new Promise(resolve => {
      this.queue.push({ job, resolve });
      this.set({});
      this.pump();
    });
  }

  /** Resolves once every queued segment has been processed. */
  async drain(): Promise<void> {
    while (this.running || this.queue.length > 0) {
      await new Promise(r => setTimeout(r, 250));
    }
  }

  private async pump() {
    if (this.running) return;
    this.running = true;
    try {
      while (this.queue.length > 0) {
        const { job, resolve } = this.queue.shift()!;
        this.set({ phase: 'busy' });
        resolve(await this.run(job));
      }
    } finally {
      this.running = false;
      if (this.stt) this.set({ phase: 'ready' });
    }
  }

  private async run(job: TranscribeJob): Promise<TranscribeOutcome> {
    if (job.speechRatio < MIN_SPEECH_RATIO) return { status: 'skipped', text: '' };
    try {
      if (!this.stt) await this.prepare(this.model || 'whisper-small');
      const stt = this.stt!;
      const whisper = isWhisperModel(this.model);
      const usePrompt = whisper && this.promptSupported;
      const prompt = whisper
        ? buildWhisperPrompt({ ...job, contextPrompting: job.contextPrompting && usePrompt })
        : undefined;

      let result = await stt.transcribe({
        audio: job.audioPath,
        prompt,
        options: { maxTokens: 448, temperature: 0 },
      });
      let text = cleanTranscript(result.response);

      // If context prompting confused the decoder (echoed the prompt or produced nothing
      // from a speech-heavy segment), retry plain once and stop prompting for this session.
      const ctxUsed = whisper && job.contextPrompting && usePrompt && (job.glossary || job.previousText);
      const echoed = !!job.glossary && text.length > 0 && text.startsWith(job.glossary.trim().slice(0, 40));
      if (ctxUsed && (echoed || (!text && job.speechRatio > 0.3))) {
        this.promptSupported = false;
        result = await stt.transcribe({
          audio: job.audioPath,
          prompt: buildWhisperPrompt({ ...job, contextPrompting: false }),
          options: { maxTokens: 448, temperature: 0 },
        });
        text = cleanTranscript(result.response);
      }
      return { status: text ? 'done' : 'skipped', text };
    } catch (e) {
      return { status: 'error', text: '', error: e instanceof Error ? e.message : String(e) };
    }
  }

  async release(): Promise<void> {
    const stt = this.stt;
    this.stt = null;
    if (stt) { try { await stt.destroy(); } catch {} }
    this.set({ phase: 'idle', downloadProgress: 0 });
  }
}

export const transcriber = new TranscriberImpl();
