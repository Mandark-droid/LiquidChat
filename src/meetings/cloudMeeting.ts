/**
 * High-accuracy mode: the recording goes to a LiquidChat Space (Whisper large-v3 or a Hinglish
 * fine-tune, speaker identification, Gemma 4 minutes) and the results come back into the same
 * meeting, so the transcript, speakers, action items and exports work exactly as for on-device
 * meetings. The Space charges the user's own ZeroGPU quota through their Hugging Face token.
 */
import { SpaceClient } from '../services/hfSpace';
import { type AudioPiece, exportAudio } from './documents';
import { notes } from './meetingQA';
import { meetingStore } from './MeetingStore';
import { applyMinutes, type MinutesProgress, normalizePartial } from './MinutesGenerator';
import type { Meeting, Speaker, Utterance } from './types';

export interface CloudSegment {
  start: number;
  end: number;
  speaker: string;
  text: string;
}

interface StartResult {
  job_id: string;
  parts: number;
  speakers: string[];
  duration_s: number;
}

export interface CloudOptions {
  spaceId: string;
  token: string;
  asrModel: 'hinglish' | 'large-v3';
  /** Injected in tests. */
  client?: Pick<SpaceClient, 'upload' | 'call'>;
}

/** Title, date and people, so the minutes model can name speakers and resolve "tomorrow". */
export function meetingContextText(m: Meeting): string {
  const d = new Date(m.startedAt);
  return [
    `Title: ${m.title}`,
    `Date: ${d.toDateString()}`,
    m.client ? `Client: ${m.client}` : '',
    m.attendees.length ? `Attendees: ${m.attendees.map(a => a.name).join(', ')}` : '',
    m.agenda ? `Agenda: ${m.agenda}` : '',
  ]
    .filter(Boolean)
    .join('\n');
}

/**
 * Puts the Space's segments back on the meeting timeline: the export joined the recorded pieces
 * back to back, so a time in the export falls inside exactly one piece.
 */
export function applyCloudTranscript(
  m: Meeting,
  segments: CloudSegment[],
  pieces: AudioPiece[],
  speakerIds: string[],
  model: string,
): void {
  const byIndex = new Map(m.segments.map(s => [s.index, s]));
  const pieceAt = (t: number) =>
    pieces.find(p => t >= p.offsetS && t < p.offsetS + p.durationS) ?? pieces[pieces.length - 1];
  const utterances = new Map<number, Utterance[]>();
  for (const c of segments) {
    if (!c.text?.trim()) continue;
    const p = pieceAt(c.start);
    const seg = p && byIndex.get(p.index);
    if (!seg) continue;
    const toMs = (t: number) => Math.round(seg.startMs + (t - p.offsetS) * 1000);
    const list = utterances.get(seg.index) ?? [];
    list.push({
      speakerId: c.speaker || 'SPEAKER_00',
      startMs: toMs(c.start),
      endMs: toMs(Math.max(c.start, c.end)),
      text: c.text.trim(),
    });
    utterances.set(seg.index, list);
  }
  for (const seg of m.segments) {
    if (!pieces.some(p => p.index === seg.index)) continue;
    const list = utterances.get(seg.index) ?? [];
    seg.utterances = list;
    seg.text = list.map(u => u.text).join(' ');
    seg.status = list.length ? 'done' : 'skipped';
    seg.error = undefined;
  }
  const used = new Set(segments.map(s => s.speaker || 'SPEAKER_00'));
  m.speakers = speakerIds
    .filter(id => used.has(id))
    .map(id => m.speakers?.find(s => s.id === id && s.nameSource === 'user') ?? { id });
  m.sttModel = model;
}

/** "SPEAKER_01" owners become the name the minutes model found, or "Speaker 2". */
export function ownerName(owner: string | undefined, speakers: Speaker[]): string | undefined {
  const o = (owner ?? '').trim();
  if (!o) return undefined;
  const i = speakers.findIndex(s => s.id === o);
  if (i < 0) return o;
  return speakers[i].name || `Speaker ${i + 1}`;
}

export async function processMeetingInCloud(
  meetingId: string,
  opts: CloudOptions,
  onProgress?: MinutesProgress,
): Promise<Meeting> {
  const meeting = await meetingStore.get(meetingId);
  if (!meeting) throw new Error('Meeting not found');
  if (!opts.token)
    throw new Error('Add your Hugging Face token in Settings to use the LiquidChat Space.');
  const client = opts.client ?? new SpaceClient(opts.spaceId, opts.token);

  onProgress?.('Preparing the recording', 0.02);
  const audio = await exportAudio(meetingId);
  onProgress?.('Uploading to your LiquidChat Space', 0.06);
  const file = await client.upload(audio.path, audio.name, audio.mime);

  onProgress?.('Finding who spoke when', 0.12);
  // The Space counts the voices itself; the attendee list (plus the person recording, who is
  // rarely on it) only caps the count so stray fragments do not become extra people.
  const maxSpeakers = meeting.attendees.length ? meeting.attendees.length + 1 : 0;
  const job = await client.call<StartResult>('start', [file, true, 0, maxSpeakers]);
  const segments: CloudSegment[] = [];
  try {
    for (let p = 0; p < job.parts; p++) {
      onProgress?.(`Transcribing part ${p + 1} of ${job.parts}`, 0.2 + (0.55 * p) / job.parts);
      const r = await client.call<{ segments: CloudSegment[] }>('transcribe_part', [
        job.job_id,
        p,
        opts.asrModel,
        '',
        'transcribe',
      ]);
      segments.push(...r.segments);
    }
  } finally {
    // Awaited (about a second): a call still open when the next one starts would hold it in its trace.
    await client.call('finish', [job.job_id]).catch(() => undefined);
  }
  if (!segments.length) throw new Error('No speech was found in the recording.');

  const model = `space:${opts.asrModel}`;
  const updated = await meetingStore.update(meetingId, m => {
    applyCloudTranscript(m, segments, audio.pieces, job.speakers, model);
  });

  return writeMinutesInCloud(updated!, client, segments, onProgress);
}

/** The meeting's transcript with speaker ids (SPEAKER_00 …), as the Space produced it. */
function transcriptSegments(m: Meeting): CloudSegment[] {
  return m.segments.flatMap(s =>
    s.status === 'done' && s.text
      ? s.utterances?.length
        ? s.utterances.map(u => ({
            start: u.startMs / 1000,
            end: u.endMs / 1000,
            speaker: u.speakerId,
            text: u.text,
          }))
        : [
            {
              start: Math.max(0, s.startMs) / 1000,
              end: (Math.max(0, s.startMs) + s.durationMs) / 1000,
              speaker: '',
              text: s.text,
            },
          ]
      : [],
  );
}

/**
 * Minutes from Gemma 4 on the Space for a meeting that already has a transcript (after a Space
 * run, or "Regenerate minutes" in Space mode), so no audio is uploaded again.
 */
export async function writeMinutesInCloud(
  meeting: Meeting,
  client: Pick<SpaceClient, 'call'>,
  segments: CloudSegment[] = transcriptSegments(meeting),
  onProgress?: MinutesProgress,
): Promise<Meeting> {
  if (!segments.length) throw new Error('This meeting has no transcript yet.');
  onProgress?.('Writing minutes', 0.8);
  const raw = await client.call<Record<string, unknown>>('minutes', [
    JSON.stringify({ segments }),
    meetingContextText(meeting),
    'gemma',
  ]);
  // Names the model recognised (introductions, being addressed) label the speakers.
  const names = (raw.speaker_names ?? {}) as Record<string, unknown>;
  const updated = await meetingStore.update(meeting.id, m => {
    for (const s of m.speakers ?? []) {
      const n = typeof names[s.id] === 'string' ? (names[s.id] as string).trim() : '';
      if (n && s.nameSource !== 'user') {
        s.name = n;
        s.nameSource = 'auto';
      }
    }
  });
  const partial = normalizePartial(raw, '');
  partial.actionItems = partial.actionItems.map(a => ({
    ...a,
    owner: ownerName(a.owner, updated!.speakers ?? []),
  }));
  return applyMinutes(updated!, partial, 'space:gemma-4-12b', onProgress);
}

/** Minutes only, on the Space (see writeMinutesInCloud). */
export async function minutesInCloud(
  meetingId: string,
  opts: CloudOptions,
  onProgress?: MinutesProgress,
): Promise<Meeting> {
  const meeting = await meetingStore.get(meetingId);
  if (!meeting) throw new Error('Meeting not found');
  if (!opts.token)
    throw new Error('Add your Hugging Face token in Settings to use the LiquidChat Space.');
  return writeMinutesInCloud(
    meeting,
    opts.client ?? new SpaceClient(opts.spaceId, opts.token),
    undefined,
    onProgress,
  );
}

/** The whole meeting as Space segments, with speaker names where known. */
export function meetingSegments(m: Meeting): CloudSegment[] {
  const label = (id: string) => {
    const i = (m.speakers ?? []).findIndex(s => s.id === id);
    return i < 0 ? id : m.speakers![i].name || `Speaker ${i + 1}`;
  };
  const out: CloudSegment[] = [];
  for (const s of m.segments) {
    if (s.status !== 'done' || !s.text) continue;
    if (s.utterances?.length)
      for (const u of s.utterances)
        out.push({
          start: u.startMs / 1000,
          end: u.endMs / 1000,
          speaker: label(u.speakerId),
          text: u.text,
        });
    else
      out.push({
        start: Math.max(0, s.startMs) / 1000,
        end: (Math.max(0, s.startMs) + s.durationMs) / 1000,
        speaker: '',
        text: s.text,
      });
  }
  return out;
}

/** "Ask about this meeting" on the Space's Gemma 4, which reads the whole transcript at once. */
export async function askInCloud(
  m: Meeting,
  question: string,
  opts: Pick<CloudOptions, 'spaceId' | 'token' | 'client'>,
): Promise<string> {
  const client = opts.client ?? new SpaceClient(opts.spaceId, opts.token);
  const answer = await client.call<string>('ask', [
    question,
    JSON.stringify({ segments: meetingSegments(m) }),
    notes(m),
  ]);
  return String(answer ?? '').trim();
}
