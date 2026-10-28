import * as RNFS from '@dr.pogodin/react-native-fs';

import { modelLifecycle } from '../services/ModelLifecycleManager';
import { meetingStore } from './MeetingStore';
import {
  assignSentences,
  clusterEmbeddings,
  EMBED_CROP_MS,
  inferSpeakerNames,
  labelUnits,
  matchToCentroids,
  MIN_EMBED_MS,
  MIN_SHORT_EMBED_MS,
  type SpeechUnit,
} from './speakers';
import type { Speaker, TranscriptSegment, Utterance } from './types';
import { WAV_RATE, writeWavSlice } from './wavSlice';

const VAD_MODEL = 'silero-vad';
const SPEAKER_MODEL = 'wespeaker-voxceleb-resnet34-lm';

export interface SpeakerResult {
  speakers: number;
  units: number;
}

/**
 * Labels who said what in a transcribed meeting: VAD per segment, a speaker embedding
 * per speech unit, clustering, then each window's sentences are given to the speaker
 * who was talking. Must run with no other Cactus model busy (they share a thread pool).
 */
export async function identifySpeakers(
  id: string,
  onProgress?: (label: string, fraction: number) => void,
): Promise<SpeakerResult | null> {
  const meeting = await meetingStore.get(id);
  if (!meeting || meeting.audioDeleted) return null;
  const dir = meetingStore.audioDir(id);
  const segs: TranscriptSegment[] = [];
  for (const s of meeting.segments)
    if (
      s.status === 'done' &&
      s.text &&
      s.audioFile &&
      (await RNFS.exists(`${dir}/${s.audioFile}`))
    )
      segs.push(s);
  if (!segs.length) return null;

  onProgress?.('Preparing speaker models', 0);
  const tmp = `${dir}/speakers_tmp`;
  try {
    const vad = await modelLifecycle.ensureAudio(VAD_MODEL, { pin: true });
    const emb = await modelLifecycle.ensureAudio(SPEAKER_MODEL, { pin: true });
    await RNFS.mkdir(tmp);

    const units: SpeechUnit[] = [];
    for (const [k, s] of segs.entries()) {
      const r = await vad.vad({
        audio: `${dir}/${s.audioFile}`,
        options: { minSilenceDurationMs: 200 },
      });
      for (const g of r.segments)
        units.push({
          startMs: s.startMs + (g.start * 1000) / WAV_RATE,
          endMs: s.startMs + (g.end * 1000) / WAV_RATE,
          segmentIndex: s.index,
        });
      onProgress?.('Finding who spoke when', (0.15 * (k + 1)) / segs.length);
    }
    if (!units.length) return null;

    const length = (u: SpeechUnit) => u.endMs - u.startMs;
    const longs = units.flatMap((u, i) => (length(u) >= MIN_EMBED_MS ? [i] : []));
    const shorts = units.flatMap((u, i) =>
      length(u) >= MIN_SHORT_EMBED_MS && length(u) < MIN_EMBED_MS ? [i] : [],
    );
    const total = longs.length + shorts.length;
    let done = 0;
    const embedUnit = async (i: number): Promise<number[] | null> => {
      const u = units[i];
      const seg = segs.find(s => s.index === u.segmentIndex)!;
      const mid = (u.startMs + u.endMs) / 2 - seg.startMs;
      const half = Math.min(EMBED_CROP_MS, length(u)) / 2;
      const clip = `${tmp}/u${i}.wav`;
      await writeWavSlice(`${dir}/${seg.audioFile}`, mid - half, mid + half, clip);
      const e = await emb.embedSpeaker({ audio: clip });
      onProgress?.('Identifying speakers', 0.15 + (0.8 * ++done) / total);
      if (e.success && e.embedding.length) return e.embedding;
      console.warn(`[Speakers] embedding failed for unit ${i}: ${e.error ?? 'empty'}`);
      return null;
    };

    const vectors: number[][] = [];
    const embedded: number[] = [];
    for (const i of longs) {
      const v = await embedUnit(i);
      if (v) {
        vectors.push(v);
        embedded.push(i);
      }
    }
    // Attendee lists usually leave out the person recording.
    const cap = meeting.attendees.length >= 2 ? meeting.attendees.length + 1 : undefined;
    const labels = clusterEmbeddings(vectors, { maxSpeakers: cap });
    const assigned = new Map(embedded.map((i, k) => [i, labels[k]]));

    // Short replies are matched to known speakers only, so they never invent one.
    const shortVectors: { unit: number; vector: number[] }[] = [];
    if (vectors.length)
      for (const i of shorts) {
        const v = await embedUnit(i);
        if (v) shortVectors.push({ unit: i, vector: v });
      }
    matchToCentroids({ vectors, labels }, shortVectors).forEach((label, i) =>
      assigned.set(i, label),
    );
    const labelled = labelUnits(units, assigned);

    const bySegment = new Map<number, Utterance[]>();
    let previous = labelled[0].speakerId!;
    for (const s of segs) {
      const utt = assignSentences(
        s,
        labelled.filter(u => u.segmentIndex === s.index),
        previous,
      );
      if (utt.length) previous = utt[utt.length - 1].speakerId;
      bySegment.set(s.index, utt);
    }

    // Renumber S1..Sn by first appearance in the transcript.
    const order: string[] = [];
    bySegment.forEach(utt =>
      utt.forEach(u => order.includes(u.speakerId) || order.push(u.speakerId)),
    );
    const renumber = new Map(order.map((old, k) => [old, `S${k + 1}`]));
    bySegment.forEach(utt => utt.forEach(u => (u.speakerId = renumber.get(u.speakerId)!)));
    const names = inferSpeakerNames([...bySegment.values()].flat(), meeting.attendees);
    const speakers: Speaker[] = order.map((_, k) => {
      const sid = `S${k + 1}`;
      const name = names.get(sid);
      return name ? { id: sid, name, nameSource: 'auto' } : { id: sid };
    });

    await meetingStore.update(id, m => {
      m.speakers = speakers;
      for (const s of m.segments) {
        const utt = bySegment.get(s.index);
        if (utt) s.utterances = utt;
      }
    });
    console.log(
      `[Speakers] ${id}: ${speakers.length} speakers from ${units.length} speech units (${embedded.length} embedded)`,
    );
    return { speakers: speakers.length, units: units.length };
  } finally {
    await RNFS.unlink(tmp).catch(() => {});
    await modelLifecycle.release(VAD_MODEL).catch(() => {});
    await modelLifecycle.release(SPEAKER_MODEL).catch(() => {});
  }
}
