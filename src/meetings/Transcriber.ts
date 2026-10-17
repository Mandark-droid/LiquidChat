import { CactusSTT } from 'cactus-react-native';

import { quantizationFor } from '../config/models';
import { ensurePinnedWeights } from '../services/cactusWeights';

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
    .replace(/\[(?:BLANK_AUDIO|MUSIC|NOISE|SILENCE|INAUDIBLE)\]/gi, ' ') // non-speech markers
    .replace(/\((?:music|applause|laughter|noise|silence|inaudible)\)/gi, ' ')
    // Decoder stalls show up as long runs of punctuation (",,,,,,,", ". . . .").
    .replace(/(?:[,.;:!?\-–—…]\s*){3,}/g, ' ')
    .replace(/\s+/g, ' ')
    .trim();
  if (!t) return '';
  if (isDegenerateLoop(t)) return '';
  t = collapseRepeats(t);
  if (HALLUCINATIONS.some(r => r.test(t))) return '';
  return t;
}

/**
 * Whisper on noise often emits one token looped to maxTokens, sometimes joined by
 * hyphens ("spea-courge-courge-courge…") so word-level collapsing never sees it.
 */
function isDegenerateLoop(text: string): boolean {
  const words = text
    .toLowerCase()
    .split(/[\s\-–—,.]+/)
    .filter(Boolean);
  if (words.length < 20) return false;
  return new Set(words).size / words.length < 0.15;
}

/** Collapses decoder loops such as "we will we will we will we will …". */
function collapseRepeats(text: string): string {
  let words = text.split(' ');
  for (let n = 1; n <= 8; n++) {
    const out: string[] = [];
    let i = 0;
    while (i < words.length) {
      const gram = words
        .slice(i, i + n)
        .join(' ')
        .toLowerCase();
      let reps = 1;
      if (i + n <= words.length) {
        // Bounded: past the end slice() yields '' which would equal an empty gram forever.
        while (
          i + (reps + 1) * n <= words.length &&
          words
            .slice(i + reps * n, i + (reps + 1) * n)
            .join(' ')
            .toLowerCase() === gram
        )
          reps++;
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

/** Cactus may report "en", "<|en|>" or "English"-like tags; keep a bare ISO code or null. */
export function normalizeLanguageCode(raw: string | undefined | null): string | null {
  const code = (raw ?? '').replace(/[<|>\s]/g, '').toLowerCase();
  return /^[a-z]{2,3}$/.test(code) ? code : null;
}

export function buildWhisperPrompt(job: TranscribeJob): string {
  const lang = job.language === 'auto' ? '' : `<|${job.language}|>`;
  // Translating English to English only degrades output.
  const task = `<|${job.language === 'en' ? 'transcribe' : job.task}|>`;
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
  /** Detection that failed once (e.g. weights without language heads) fails every time. */
  private detectionWorks = true;
  private listeners = new Set<Listener>();
  private status: TranscriberStatus = {
    model: '',
    phase: 'idle',
    downloadProgress: 0,
    queueLength: 0,
  };
  private preparing: Promise<void> | null = null;

  subscribe(l: Listener): () => void {
    this.listeners.add(l);
    l(this.status);
    return () => {
      this.listeners.delete(l);
    };
  }

  getStatus(): TranscriberStatus {
    return this.status;
  }

  private set(p: Partial<TranscriberStatus>) {
    this.status = { ...this.status, ...p, queueLength: this.queue.length };
    for (const l of this.listeners) {
      try {
        l(this.status);
      } catch {}
    }
  }

  /** Downloads (if needed) and initialises the STT model. Idempotent. */
  prepare(model: string): Promise<void> {
    if (this.stt && this.model === model && this.status.phase !== 'error') return Promise.resolve();
    if (this.preparing && this.model === model) return this.preparing;
    this.preparing = (async () => {
      if (this.stt && this.model !== model) await this.release();
      this.model = model;
      this.promptSupported = true;
      this.detectionWorks = true;
      const quantization = quantizationFor(model);
      const stt = new CactusSTT({ model, options: quantization ? { quantization } : undefined });
      try {
        this.set({ model, phase: 'downloading', downloadProgress: 0, error: undefined });
        await ensurePinnedWeights(model, quantization ?? 'int8', p =>
          this.set({ downloadProgress: p }),
        );
        await stt.download({ onProgress: p => this.set({ downloadProgress: p }) });
        this.set({ phase: 'initializing', downloadProgress: 1 });
        await stt.init();
        this.stt = stt;
        this.set({ phase: 'ready' });
      } catch (e) {
        const msg = e instanceof Error ? e.message : String(e);
        console.warn(`[Transcriber] Preparing ${model} failed: ${msg}`);
        this.set({ phase: 'error', error: msg });
        try {
          await stt.destroy();
        } catch {}
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
      if (whisper && job.language === 'auto')
        job = { ...job, language: await this.detect(stt, job) };
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
      const ctxUsed =
        whisper && job.contextPrompting && usePrompt && (job.glossary || job.previousText);
      const echoed =
        !!job.glossary && text.length > 0 && text.startsWith(job.glossary.trim().slice(0, 40));
      if (ctxUsed && (echoed || (!text && job.speechRatio > 0.3))) {
        this.promptSupported = false;
        result = await stt.transcribe({
          audio: job.audioPath,
          prompt: buildWhisperPrompt({ ...job, contextPrompting: false }),
          options: { maxTokens: 448, temperature: 0 },
        });
        text = cleanTranscript(result.response);
      }
      // Greedy decoding can lock into a loop ("in in in …") on a speech segment. Like
      // Whisper's reference decoder, fall back to sampling, without the context prompt.
      for (const temperature of whisper ? [0.4, 0.8] : []) {
        if (text || job.speechRatio <= 0.3 || !(result.response ?? '').trim()) break;
        result = await stt.transcribe({
          audio: job.audioPath,
          prompt: buildWhisperPrompt({ ...job, contextPrompting: false }),
          options: { maxTokens: 448, temperature },
        });
        text = cleanTranscript(result.response);
      }
      if (!text && job.speechRatio > 0.3)
        console.warn(
          `[Transcriber] ${job.audioPath.split('/').pop()}: no usable text from speech (raw: ${JSON.stringify((result.response ?? '').slice(0, 160))})`,
        );
      return { status: text ? 'done' : 'skipped', text };
    } catch (e) {
      const error = e instanceof Error ? e.message : String(e);
      console.warn(`[Transcriber] ${job.audioPath.split('/').pop()} failed: ${error}`);
      return { status: 'error', text: '', error };
    }
  }

  /** Per segment, so code-switched meetings (e.g. Hindi/English) are handled. */
  private async detect(stt: CactusSTT, job: TranscribeJob): Promise<string> {
    for (const useVad of this.detectionWorks ? [true, false] : []) {
      try {
        const r = await stt.detectLanguage({ audio: job.audioPath, options: { useVad } });
        const code = normalizeLanguageCode(r.language);
        if (code) return code;
        console.warn(
          `[Transcriber] unrecognised detected language "${r.language}" (vad=${useVad})`,
        );
      } catch (e) {
        console.warn(`[Transcriber] language detection failed: ${(e as Error).message}`);
      }
    }
    if (this.detectionWorks) {
      this.detectionWorks = false;
      console.warn('[Transcriber] language detection unavailable; using English for this model');
    }
    // A translate task with no language token derails Whisper (it emits rows of commas).
    // Forcing English transcribes English speech and renders other speech in English.
    return 'en';
  }

  async release(): Promise<void> {
    const stt = this.stt;
    this.stt = null;
    this.detectionWorks = true;
    if (stt) {
      try {
        await stt.destroy();
      } catch {}
    }
    this.set({ phase: 'idle', downloadProgress: 0 });
  }
}

export const transcriber = new TranscriberImpl();
