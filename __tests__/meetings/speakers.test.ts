import * as RNFS from '@dr.pogodin/react-native-fs';

import { findCommitments, transcriptLines } from '../../src/meetings/MinutesGenerator';
import {
  assignSentences,
  clusterEmbeddings,
  inferSpeakerNames,
  labelUnits,
  matchToCentroids,
  speakerLabel,
  type SpeechUnit,
  splitSentences,
} from '../../src/meetings/speakers';
import type { Utterance } from '../../src/meetings/types';
import { ensurePinnedWeights, pinnedWeightsUrl } from '../../src/services/cactusWeights';
import { makeMeeting, seg } from './fixtures';

const { downloads } = require('react-native-nitro-modules') as {
  downloads: { model: string; url: string }[];
};

/** Unit vectors near one of `k` orthogonal directions, with a little noise. */
function voice(k: number, jitter: number, dim = 8): number[] {
  const v = Array.from({ length: dim }, (_, i) => (i === k ? 1 : 0));
  v[(k + 1) % dim] += jitter;
  return v;
}

describe('clusterEmbeddings', () => {
  it('finds five speakers and labels them by first appearance', () => {
    const order = [2, 0, 4, 1, 3, 0, 2, 4, 1, 3, 0];
    const labels = clusterEmbeddings(order.map((k, i) => voice(k, (i % 3) * 0.1)));
    expect(new Set(labels).size).toBe(5);
    expect(labels.slice(0, 5)).toEqual([0, 1, 2, 3, 4]);
    expect(labels[5]).toBe(labels[1]);
    expect(labels[6]).toBe(labels[0]);
  });

  it('merges down to the attendee cap even below the threshold', () => {
    const labels = clusterEmbeddings([voice(0, 0), voice(1, 0), voice(2, 0)], { maxSpeakers: 2 });
    expect(new Set(labels).size).toBe(2);
  });

  it('handles empty input', () => expect(clusterEmbeddings([])).toEqual([]));
});

describe('labelUnits', () => {
  const u = (startMs: number, endMs: number): SpeechUnit => ({ startMs, endMs, segmentIndex: 0 });

  it('gives short units the speaker of the nearer embedded neighbour', () => {
    const units = [u(0, 3000), u(3200, 3700), u(5000, 8000), u(8100, 8500)];
    const out = labelUnits(
      units,
      new Map([
        [0, 0],
        [2, 1],
      ]),
    );
    expect(out.map(x => x.speakerId)).toEqual(['S1', 'S1', 'S2', 'S2']);
  });

  it('falls back to S1 when nothing could be embedded', () => {
    expect(labelUnits([u(0, 500)], new Map())[0].speakerId).toBe('S1');
  });
});

describe('splitSentences', () => {
  it('keeps punctuation and handles the danda', () => {
    expect(splitSentences('Hi. Can you? Sure! ok')).toEqual(['Hi.', 'Can you?', 'Sure!', 'ok']);
    expect(splitSentences('मैं राहुल हूँ। ठीक है।')).toEqual(['मैं राहुल हूँ।', 'ठीक है।']);
  });
});

describe('assignSentences', () => {
  const units: SpeechUnit[] = [
    { startMs: 0, endMs: 4000, segmentIndex: 0, speakerId: 'S1' },
    { startMs: 4500, endMs: 6000, segmentIndex: 0, speakerId: 'S2' },
    { startMs: 6300, endMs: 10000, segmentIndex: 0, speakerId: 'S1' },
  ];

  it('gives each sentence to the speaker talking at that point of the window', () => {
    const out = assignSentences(
      {
        startMs: 0,
        durationMs: 10000,
        text: 'Okay, who can chase Acme for the credentials? I will take that. Great, thanks a lot, moving on to the next topic now.',
      },
      units,
      'S1',
    );
    expect(out.map(x => [x.speakerId, x.text])).toEqual([
      ['S1', 'Okay, who can chase Acme for the credentials?'],
      ['S2', 'I will take that.'],
      ['S1', 'Great, thanks a lot, moving on to the next topic now.'],
    ]);
  });

  it('gives a short reply between two turns of another speaker to the replier', () => {
    const out = assignSentences(
      {
        startMs: 60000,
        durationMs: 30000,
        text: "Decision then. We move the beta release to the 24th of October. Agreed. I'll schedule the demo with Acme leadership for next Monday. Thanks, everyone.",
      },
      [
        { startMs: 60500, endMs: 64800, segmentIndex: 2, speakerId: 'S1' },
        { startMs: 65200, endMs: 66000, segmentIndex: 2, speakerId: 'S3' },
        { startMs: 66400, endMs: 71000, segmentIndex: 2, speakerId: 'S1' },
      ],
      'S1',
    );
    expect(out.map(x => [x.speakerId, x.text])).toEqual([
      ['S1', 'Decision then. We move the beta release to the 24th of October.'],
      ['S3', 'Agreed.'],
      ['S1', "I'll schedule the demo with Acme leadership for next Monday. Thanks, everyone."],
    ]);
  });

  it('starts the answer after a question even when the asker talks faster', () => {
    const out = assignSentences(
      {
        startMs: 30000,
        durationMs: 30000,
        text: "I can confirm that. We saw timeouts in about one in five test runs. Okay, who could chase Acme for the new API credentials? I'll take that. I'll get the credentials from Acme by Wednesday.",
      },
      [
        { startMs: 30000, endMs: 35500, segmentIndex: 1, speakerId: 'S4' },
        { startMs: 36000, endMs: 39500, segmentIndex: 1, speakerId: 'S1' },
        { startMs: 40000, endMs: 46500, segmentIndex: 1, speakerId: 'S3' },
      ],
      'S4',
    );
    expect(out.map(x => x.speakerId)).toEqual(['S4', 'S1', 'S3']);
    expect(out[2].text).toBe("I'll take that. I'll get the credentials from Acme by Wednesday.");
  });

  it('uses the fallback speaker when the window has no speech units', () => {
    const out = assignSentences({ startMs: 30000, durationMs: 5000, text: 'Hello.' }, units, 'S2');
    expect(out).toEqual([{ speakerId: 'S2', startMs: 30000, endMs: 35000, text: 'Hello.' }]);
  });
});

describe('inferSpeakerNames', () => {
  const utt = (speakerId: string, text: string): Utterance => ({
    speakerId,
    text,
    startMs: 0,
    endMs: 0,
  });

  it('reads self-introductions in English, Hinglish and Hindi', () => {
    const names = inferSpeakerNames(
      [
        utt('S1', "Good morning, I'm Kshitij."),
        utt('S2', 'Hi, main Rahul, payments lead kar raha hoon.'),
        utt('S3', 'Priya here, I manage the client.'),
        utt('S4', 'मैं अनीता हूँ, क्यूए टीम से।'),
      ],
      [],
    );
    expect(Object.fromEntries(names)).toEqual({
      S1: 'Kshitij',
      S2: 'Rahul',
      S3: 'Priya',
      S4: 'अनीता',
    });
  });

  it('names whoever agrees when addressed', () => {
    const names = inferSpeakerNames(
      [utt('S1', 'Vikram, can you run a load test?'), utt('S5', "Sure, I'll do it by Friday.")],
      [],
    );
    expect(names.get('S5')).toBe('Vikram');
    expect(names.has('S1')).toBe(false);
  });

  it('maps to attendees and ignores names that are not attendees', () => {
    const names = inferSpeakerNames(
      [utt('S1', "I'm Rahul."), utt('S2', 'This is Acme calling.')],
      [{ name: 'Rahul Mehta' }, { name: 'Priya Shah' }],
    );
    expect(Object.fromEntries(names)).toEqual({ S1: 'Rahul Mehta' });
  });

  it('matches Whisper misspellings to the closest attendee', () => {
    const names = inferSpeakerNames(
      [utt('S1', 'This is Kshidjaj.'), utt('S2', "And I'm Vikran."), utt('S3', "I'm Bob.")],
      [{ name: 'Kshitij Thakkar' }, { name: 'Vikram' }, { name: 'Priya' }],
    );
    expect(Object.fromEntries(names)).toEqual({ S1: 'Kshitij Thakkar', S2: 'Vikram' });
  });

  it('does not take ordinary words or weekdays for names', () => {
    const names = inferSpeakerNames(
      [utt('S1', "I'm Sure about it. Main Wednesday tak bhej dunga.")],
      [],
    );
    expect(names.size).toBe(0);
  });

  it('never gives one name to two speakers', () => {
    const names = inferSpeakerNames([utt('S1', "I'm Priya."), utt('S2', "I'm Priya too.")], []);
    expect([...names.values()]).toEqual(['Priya']);
  });
});

describe('speaker-labelled transcript', () => {
  it('prefixes each utterance with the speaker name or "Speaker N"', () => {
    const m = makeMeeting({
      speakers: [{ id: 'S1', name: 'Priya' }, { id: 'S2' }],
      segments: [
        {
          ...seg(0, 'Who takes it? I will.'),
          utterances: [
            { speakerId: 'S2', startMs: 0, endMs: 2000, text: 'Who takes it?' },
            { speakerId: 'S1', startMs: 2500, endMs: 3500, text: 'I will.' },
          ],
        },
      ],
      markers: [],
    });
    expect(transcriptLines(m)).toEqual([
      '[00:00] Speaker 2: Who takes it?',
      '[00:02] Priya: I will.',
    ]);
    expect(speakerLabel(m.speakers, 'S1')).toBe('Priya');
  });
});

describe('ensurePinnedWeights', () => {
  const dir = `${RNFS.DocumentDirectoryPath}/cactus/models`;

  beforeEach(() => {
    downloads.length = 0;
  });

  it('replaces unpinned Whisper weights once with the v1.14 build', async () => {
    await RNFS.mkdir(`${dir}/whisper-small-int8`);
    await ensurePinnedWeights('whisper-small', 'int8');
    expect(downloads).toEqual([
      {
        model: 'whisper-small-int8',
        url: 'https://huggingface.co/Cactus-Compute/whisper-small/resolve/v1.14/weights/whisper-small-int8.zip',
      },
    ]);
    await ensurePinnedWeights('whisper-small', 'int8');
    expect(downloads).toHaveLength(1);
  });

  it('uses the repo name casing for the speaker model and ignores unpinned models', async () => {
    expect(pinnedWeightsUrl('wespeaker-voxceleb-resnet34-lm', 'int8')).toContain(
      '/wespeaker-voxceleb-resnet34-LM/resolve/v1.14/',
    );
    await ensurePinnedWeights('lfm2-1.2b', 'int8');
    expect(downloads).toHaveLength(0);
  });
});

describe('matchToCentroids', () => {
  it('assigns a short reply to the closest known speaker and drops weak matches', () => {
    const vectors = [voice(0, 0), voice(0, 0.1), voice(1, 0), voice(1, 0.1)];
    const labels = [0, 0, 1, 1];
    const out = matchToCentroids({ vectors, labels }, [
      { unit: 7, vector: voice(1, 0.3) },
      { unit: 9, vector: voice(5, 0) },
    ]);
    expect([...out.entries()]).toEqual([[7, 1]]);
  });
});

describe('findCommitments', () => {
  it('takes the owner from the speaker and the deadline from the line', () => {
    const lines = [
      '[00:47] Kshitij: Okay, who could chase Acme for the new API credentials?',
      "[00:52] Priya: I'll take that. I'll get the credentials from Acme by Wednesday.",
      '[01:00] Kshitij: Vikram, payment gateway ka load test kar sakte ho?',
      '[01:02] Vikram: Haan, main Friday tak kar dunga aur report share kar dunga.',
      "[01:06] Anita: Once Vikram's report is in, I'll update the regression suite. Give me till next Tuesday.",
      '[01:13] Rahul: And I will fix the timeout handling.',
      '[01:20] ★ FLAGGED BY USER: important moment',
    ];
    expect(findCommitments(lines)).toEqual([
      {
        owner: 'Priya',
        text: "I'll take that. I'll get the credentials from Acme by Wednesday.",
        previous: 'Kshitij: Okay, who could chase Acme for the new API credentials?',
        due: 'by Wednesday',
      },
      {
        owner: 'Vikram',
        text: 'Haan, main Friday tak kar dunga aur report share kar dunga.',
        previous: 'Kshitij: Vikram, payment gateway ka load test kar sakte ho?',
        due: 'Friday tak',
      },
      {
        owner: 'Anita',
        text: "Once Vikram's report is in, I'll update the regression suite. Give me till next Tuesday.",
        previous: 'Vikram: Haan, main Friday tak kar dunga aur report share kar dunga.',
        due: 'till next Tuesday',
      },
      {
        owner: 'Rahul',
        text: 'And I will fix the timeout handling.',
        previous:
          "Anita: Once Vikram's report is in, I'll update the regression suite. Give me till next Tuesday.",
        due: undefined,
      },
    ]);
  });

  it('ignores requests that nobody has taken on yet', () => {
    expect(findCommitments(['[00:00] Kshitij: Can you send the deck?'])).toEqual([]);
  });
});
