jest.mock('@dr.pogodin/react-native-fs', () => ({}));
jest.mock('cactus-react-native', () => ({}));

import {
  applyCloudTranscript,
  meetingContextText,
  ownerName,
} from '../../src/meetings/cloudMeeting';
import { parseEventStream, SpaceClient, SpaceError, spaceUrl } from '../../src/services/hfSpace';
import { makeMeeting, seg } from './fixtures';

describe('Space client', () => {
  it('maps a Space id to its app URL', () => {
    expect(spaceUrl('kshitijthakkar/LiquidChat')).toBe(
      'https://kshitijthakkar-liquidchat.hf.space',
    );
    expect(spaceUrl('a_b/c.d')).toBe('https://a-b-c-d.hf.space');
    expect(spaceUrl('https://x.hf.space/')).toBe('https://x.hf.space');
    expect(() => spaceUrl('not a space')).toThrow(SpaceError);
  });

  it('reads the result or the error from the event stream', () => {
    expect(
      parseEventStream('event: heartbeat\ndata: null\n\nevent: complete\ndata: [{"a":1}]\n'),
    ).toEqual({ a: 1 });
    expect(() => parseEventStream('event: error\ndata: "Upload a recording first."\n')).toThrow(
      'The Space reported: Upload a recording first.',
    );
    expect(() => parseEventStream('event: error\ndata: null\n')).toThrow(
      'The Space reported an error.',
    );
    expect(() => parseEventStream('')).toThrow('no result');
  });

  it('queues a call, then reads its stream, sending the token for ZeroGPU quota', async () => {
    const calls: { url: string; init: RequestInit }[] = [];
    const fake = (async (url: string, init: RequestInit) => {
      calls.push({ url, init });
      if (url.endsWith('/gradio_api/call/minutes'))
        return { ok: true, status: 200, json: async () => ({ event_id: 'e1' }) };
      return {
        ok: true,
        status: 200,
        text: async () => 'event: complete\ndata: [{"title":"T"}]\n',
      };
    }) as unknown as typeof fetch;
    const c = new SpaceClient('kshitijthakkar/LiquidChat', 'hf_x', fake);
    expect(await c.call('minutes', ['{}', ''])).toEqual({ title: 'T' });
    expect(calls[0].url).toBe('https://kshitijthakkar-liquidchat.hf.space/gradio_api/call/minutes');
    expect(JSON.parse(String(calls[0].init.body))).toEqual({ data: ['{}', ''] });
    expect((calls[0].init.headers as Record<string, string>)['x-hf-authorization']).toBe(
      'Bearer hf_x',
    );
    expect(calls[1].url).toBe(
      'https://kshitijthakkar-liquidchat.hf.space/gradio_api/call/minutes/e1',
    );
  });

  it('explains a rejected token', async () => {
    const fake = (async () => ({ ok: false, status: 401 })) as unknown as typeof fetch;
    await expect(new SpaceClient('a/b', 'bad', fake).call('start', [])).rejects.toThrow(
      'token was rejected',
    );
  });
});

describe('cloud results on the meeting', () => {
  // Three recorded pieces; the middle one was 20 s long and starts at 30 s on the meeting timeline.
  const pieces = [
    { index: 0, offsetS: 0, durationS: 30 },
    { index: 1, offsetS: 30, durationS: 20 },
    { index: 2, offsetS: 50, durationS: 30 },
  ];

  function meeting() {
    return makeMeeting({ segments: [seg(0, 'old'), seg(1, 'old', 30_000), seg(2, 'old', 60_000)] });
  }

  it('puts each utterance on the right segment and meeting time', () => {
    const m = meeting();
    applyCloudTranscript(
      m,
      [
        { start: 2, end: 5, speaker: 'SPEAKER_00', text: 'Hello all.' },
        { start: 31, end: 35, speaker: 'SPEAKER_01', text: 'Sandip will onboard them.' },
        { start: 52.5, end: 55, speaker: 'SPEAKER_00', text: 'Logs by tomorrow.' },
      ],
      pieces,
      ['SPEAKER_00', 'SPEAKER_01', 'SPEAKER_02'],
      'space:hinglish',
    );
    expect(m.segments[1].utterances).toEqual([
      {
        speakerId: 'SPEAKER_01',
        startMs: 31_000,
        endMs: 35_000,
        text: 'Sandip will onboard them.',
      },
    ]);
    // Piece 2 starts at 50 s in the export but 60 s on the meeting timeline.
    expect(m.segments[2].utterances?.[0].startMs).toBe(62_500);
    expect(m.segments.map(s => s.text)).toEqual([
      'Hello all.',
      'Sandip will onboard them.',
      'Logs by tomorrow.',
    ]);
    // A speaker with no words left after cleanup is not listed.
    expect(m.speakers?.map(s => s.id)).toEqual(['SPEAKER_00', 'SPEAKER_01']);
    expect(m.sttModel).toBe('space:hinglish');
  });

  it('marks a piece with no speech as skipped and keeps names the user set', () => {
    const m = meeting();
    m.speakers = [{ id: 'SPEAKER_00', name: 'Kshitij', nameSource: 'user' }];
    applyCloudTranscript(
      m,
      [{ start: 1, end: 2, speaker: 'SPEAKER_00', text: 'Hi' }],
      pieces,
      ['SPEAKER_00'],
      'm',
    );
    expect(m.segments[1].status).toBe('skipped');
    expect(m.speakers).toEqual([{ id: 'SPEAKER_00', name: 'Kshitij', nameSource: 'user' }]);
  });

  it('turns speaker labels in owners into names', () => {
    const speakers = [{ id: 'SPEAKER_00', name: 'Lalit' }, { id: 'SPEAKER_01' }];
    expect(ownerName('SPEAKER_00', speakers)).toBe('Lalit');
    expect(ownerName('SPEAKER_01', speakers)).toBe('Speaker 2');
    expect(ownerName('Sandip', speakers)).toBe('Sandip');
    expect(ownerName('', speakers)).toBeUndefined();
  });

  it('gives the minutes model the title, date and attendees', () => {
    const text = meetingContextText(
      makeMeeting({ title: 'Gateway review', attendees: [{ name: 'Lalit' }] }),
    );
    expect(text).toContain('Title: Gateway review');
    expect(text).toContain('Attendees: Lalit');
  });
});

describe('Space endpoint contracts', () => {
  // Gradio rejects a call with fewer inputs than the endpoint declares; these must match space/app.py.
  const fs = require('fs');
  const path = require('path');
  const app: string = fs.readFileSync(path.join(__dirname, '../../space/app.py'), 'utf8');
  const inputs = (api: string) => {
    const m = new RegExp(String.raw`click\(\w+, \[([^\]]*)\][^\n]*api_name="${api}"`).exec(app);
    if (!m) throw new Error(`no ${api} endpoint in space/app.py`);
    return m[1].split(',').filter(s => s.trim()).length;
  };

  it('the app sends every input each endpoint takes', async () => {
    const sent: Record<string, number> = {};
    const client = {
      call: async (api: string, data: unknown[]) => {
        sent[api] = data.length;
        return api === 'minutes' ? { title: 'T', summary: 'S', action_items: [] } : '';
      },
    };
    const { writeMinutesInCloud } = require('../../src/meetings/cloudMeeting');
    const store = require('../../src/meetings/MeetingStore').meetingStore;
    const m = makeMeeting({ segments: [seg(0, 'We will ship on Friday.')] });
    jest.spyOn(store, 'update').mockImplementation(async (_id: unknown, f: unknown) => {
      (f as (x: typeof m) => void)(m);
      return m;
    });
    await writeMinutesInCloud(m, client).catch(() => undefined);
    expect(sent.minutes).toBe(inputs('minutes'));
    expect(inputs('start')).toBe(4); // processMeetingInCloud sends [file, true, 0, maxSpeakers]
    expect(inputs('transcribe_part')).toBe(5);
    expect(inputs('ask')).toBe(3);
    expect(inputs('chat')).toBe(4); // HfSpaceProvider sends [messages, maxTokens, temperature, model]
  });
});
