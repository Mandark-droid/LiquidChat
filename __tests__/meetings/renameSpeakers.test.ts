import { defaultSpeakerLabel, renameSpeakers, speakerLabel } from '../../src/meetings/speakers';
import type { ActionItem, Meeting, Minutes } from '../../src/meetings/types';

const minutes = (over: Partial<Minutes> = {}): Minutes => ({
  summary: 'Speaker 1 walked Speaker 2 through the plan.',
  keyPoints: ['Speaker 2 owns the rollout', 'Speaker 12 joined late'],
  decisions: [],
  openQuestions: [],
  nextSteps: ['Speaker 1 sends the deck'],
  generatedAt: 1,
  model: 'test',
  edited: false,
  ...over,
});

const action = (owner?: string): ActionItem => ({
  id: owner ?? 'none',
  task: 'Do it',
  owner,
  status: 'open',
  createdAt: 1,
});

type Part = Pick<Meeting, 'speakers' | 'minutes' | 'actionItems'>;

describe('defaultSpeakerLabel', () => {
  it('numbers on-device ids by their own number and Space ids by position', () => {
    const speakers = [{ id: 'SPEAKER_00' }, { id: 'SPEAKER_03' }];
    expect(defaultSpeakerLabel(undefined, 'S4')).toBe('Speaker 4');
    expect(defaultSpeakerLabel(speakers, 'SPEAKER_03')).toBe('Speaker 2');
    expect(speakerLabel(speakers, 'SPEAKER_00')).toBe('Speaker 1');
  });
});

describe('renameSpeakers', () => {
  it('renames owners and minutes text without touching similar labels', () => {
    const m: Part = {
      speakers: [{ id: 'S1' }, { id: 'S2' }, { id: 'S12' }],
      minutes: minutes(),
      actionItems: [action('Speaker 2'), action('speaker 1'), action('Speaker 12'), action()],
    };
    expect(renameSpeakers(m, { S1: 'Priya', S2: ' Vikram ' })).toBe(true);
    expect(m.speakers).toEqual([
      { id: 'S1', name: 'Priya', nameSource: 'user' },
      { id: 'S2', name: 'Vikram', nameSource: 'user' },
      { id: 'S12' },
    ]);
    expect(m.minutes!.summary).toBe('Priya walked Vikram through the plan.');
    expect(m.minutes!.keyPoints).toEqual(['Vikram owns the rollout', 'Speaker 12 joined late']);
    expect(m.minutes!.nextSteps).toEqual(['Priya sends the deck']);
    expect(m.actionItems.map(a => a.owner)).toEqual(['Vikram', 'Priya', 'Speaker 12', undefined]);
  });

  it('swaps two speakers without the names colliding', () => {
    const m: Part = {
      speakers: [
        { id: 'S1', name: 'Asha', nameSource: 'auto' },
        { id: 'S2', name: 'Ravi', nameSource: 'auto' },
      ],
      minutes: minutes({ summary: 'Asha asked Ravi.' }),
      actionItems: [action('Asha'), action('Ravi')],
    };
    renameSpeakers(m, { S1: 'Ravi', S2: 'Asha' });
    expect(m.minutes!.summary).toBe('Ravi asked Asha.');
    expect(m.actionItems.map(a => a.owner)).toEqual(['Ravi', 'Asha']);
  });

  it('extends a first name without doubling the surname already written', () => {
    const m: Part = {
      speakers: [{ id: 'S1', name: 'Vikram', nameSource: 'auto' }],
      minutes: minutes({ summary: 'Vikram Shah presented; Vikram will follow up.' }),
      actionItems: [],
    };
    renameSpeakers(m, { S1: 'Vikram Shah' });
    expect(m.minutes!.summary).toBe('Vikram Shah presented; Vikram Shah will follow up.');
  });

  it('clearing a name brings back the numbered label; no change reports false', () => {
    const m: Part = {
      speakers: [{ id: 'S3', name: 'Neha', nameSource: 'user' }],
      minutes: minutes({ summary: 'Neha agreed.' }),
      actionItems: [action('Neha')],
    };
    expect(renameSpeakers(m, { S3: 'Neha' })).toBe(false);
    expect(renameSpeakers(m, { S3: '' })).toBe(true);
    expect(m.speakers).toEqual([{ id: 'S3' }]);
    expect(m.minutes!.summary).toBe('Speaker 3 agreed.');
    expect(m.actionItems[0].owner).toBe('Speaker 3');
  });

  it('handles Devanagari names as whole words', () => {
    const m: Part = {
      speakers: [{ id: 'S1', name: 'राम', nameSource: 'auto' }],
      minutes: minutes({ summary: 'राम ने कहा, रामू नहीं।' }),
      actionItems: [],
    };
    renameSpeakers(m, { S1: 'Ram' });
    expect(m.minutes!.summary).toBe('Ram ने कहा, रामू नहीं।');
  });
});
