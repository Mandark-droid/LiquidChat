import { meetingSession } from '../../src/meetings/MeetingSession';
import { meetingStore } from '../../src/meetings/MeetingStore';
import { Recorder } from '../../src/meetings/native';
import type { ImportProgressEvent, PickedAudio } from '../../src/meetings/types';

let progressCb: ((e: ImportProgressEvent) => void) | null = null;

jest.mock('../../src/meetings/native', () => ({
  Recorder: {
    importAudio: jest.fn(),
    cancelImport: jest.fn(async () => undefined),
    setProcessing: jest.fn(async () => undefined),
    release: jest.fn(async () => undefined),
    getStatus: jest.fn(async () => ({ state: 'idle', elapsedMs: 0 })),
  },
  RecorderEvents: {
    onImportProgress: (cb: (e: ImportProgressEvent) => void) => {
      progressCb = cb;
      return { remove: () => (progressCb = null) };
    },
  },
  ensureRecordingPermissions: async () => true,
}));

jest.mock('../../src/meetings/Transcriber', () => ({
  transcriber: {
    prepare: jest.fn(async () => undefined),
    release: jest.fn(async () => undefined),
    drain: jest.fn(async () => undefined),
    getStatus: () => ({ model: null }),
  },
}));

jest.mock('../../src/services/ModelLifecycleManager', () => ({
  modelLifecycle: { release: jest.fn(), ensure: jest.fn(), getLoadedModels: () => [] },
}));

const importAudio = Recorder.importAudio as jest.Mock;

const FILE: PickedAudio = {
  uri: 'content://com.android.providers.downloads/document/42',
  name: 'Client sync 16 Oct.m4a',
  size: 5_000_000,
  durationMs: 75_000,
  mime: 'audio/mp4',
};

const flush = () => new Promise(r => setTimeout(r, 0));

async function waitFor(check: () => Promise<boolean> | boolean, ms = 2000) {
  const end = Date.now() + ms;
  while (Date.now() < end) {
    if (await check()) return;
    await new Promise(r => setTimeout(r, 10));
  }
  throw new Error('timed out');
}

describe('meetingSession.importRecording', () => {
  let processSpy: jest.SpyInstance;

  beforeEach(() => {
    importAudio.mockReset();
    // The real processMeeting ends by returning the session to idle; mirror that.
    processSpy = jest.spyOn(meetingSession, 'processMeeting').mockImplementation(async () => {
      (meetingSession as unknown as { set(p: object): void }).set({
        phase: 'idle',
        meetingId: null,
      });
    });
  });
  afterEach(() => processSpy.mockRestore());

  it('creates an import meeting named after the file, registers decoded segments, then processes with minutes', async () => {
    let finish!: (v: unknown) => void;
    importAudio.mockReturnValue(new Promise(r => (finish = r)));

    const id = await meetingSession.importRecording({ file: FILE, client: 'Acme' });
    const created = await meetingStore.get(id);
    expect(created).toMatchObject({
      title: 'Client sync 16 Oct',
      source: 'import',
      status: 'transcribing',
      client: 'Acme',
      durationMs: 75_000,
    });
    await flush();
    expect(importAudio).toHaveBeenCalledWith(FILE.uri, meetingStore.audioDir(id), {
      segmentSec: 30,
    });

    progressCb?.({ decodedMs: 30_000, totalMs: 75_000 });
    expect(meetingSession.live).toMatchObject({
      meetingId: id,
      phase: 'transcribing',
      progressLabel: 'Decoding audio 40%',
    });

    const dir = meetingStore.audioDir(id);
    finish({
      durationMs: 74_500,
      segments: [
        {
          index: 0,
          path: `${dir}/seg_00000.wav`,
          startMs: 0,
          durationMs: 30_000,
          speechRatio: 0.7,
          meanDb: -30,
        },
        {
          index: 1,
          path: `${dir}/seg_00001.wav`,
          startMs: 30_000,
          durationMs: 30_000,
          speechRatio: 0.6,
          meanDb: -32,
        },
        {
          index: 2,
          path: `${dir}/seg_00002.wav`,
          startMs: 60_000,
          durationMs: 14_500,
          speechRatio: 0.2,
          meanDb: -41,
        },
      ],
    });
    await waitFor(() => processSpy.mock.calls.length > 0);

    expect(processSpy).toHaveBeenCalledWith(id, { forceMinutes: true });
    const m = (await meetingStore.get(id))!;
    expect(m.durationMs).toBe(74_500);
    expect(m.segments.map(s => [s.audioFile, s.status, s.startMs])).toEqual([
      ['seg_00000.wav', 'pending', 0],
      ['seg_00001.wav', 'pending', 30_000],
      ['seg_00002.wav', 'pending', 60_000],
    ]);
    expect(m.segments[1].wallStartMs).toBe(m.startedAt + 30_000);
  });

  it('marks the meeting as failed with the decoder error and frees the session', async () => {
    importAudio.mockRejectedValue(new Error('No audio track found in this file'));
    const id = await meetingSession.importRecording({ file: FILE });
    await waitFor(async () => (await meetingStore.get(id))?.status === 'error');

    expect((await meetingStore.get(id))!.error).toBe('No audio track found in this file');
    expect(processSpy).not.toHaveBeenCalled();
    expect(meetingSession.live.phase).toBe('idle');
    expect(meetingSession.isBusy(id)).toBe(false);
  });

  it('treats a file with no decodable audio as an error instead of writing minutes', async () => {
    importAudio.mockResolvedValue({ durationMs: 0, segments: [] });
    const id = await meetingSession.importRecording({ file: FILE, title: 'Empty' });
    await waitFor(async () => (await meetingStore.get(id))?.status === 'error');

    expect((await meetingStore.get(id))!.error).toMatch(/No audio could be decoded/);
    expect(processSpy).not.toHaveBeenCalled();
  });

  it('refuses to start while another meeting is being processed', async () => {
    let finish!: (v: unknown) => void;
    importAudio.mockReturnValue(new Promise(r => (finish = r)));
    const first = await meetingSession.importRecording({ file: FILE });
    await flush();

    await expect(meetingSession.importRecording({ file: FILE })).rejects.toThrow(
      /Finish the current meeting/,
    );

    finish({ durationMs: 0, segments: [] });
    await waitFor(async () => (await meetingStore.get(first))?.status === 'error');
  });

  it('forwards cancel to the native decoder', async () => {
    await meetingSession.cancelImport();
    expect(Recorder.cancelImport).toHaveBeenCalled();
  });
});
