import { Recorder } from '../../src/meetings/native';
import { takeShared, watchSharedAudio } from '../../src/meetings/sharedAudio';
import type { PickedAudio } from '../../src/meetings/types';

let mockSharedCb: (() => void) | null = null;
let mockAppStateCb: ((s: string) => void) | null = null;

jest.mock('react-native', () => ({
  AppState: {
    addEventListener: (_: string, cb: (s: string) => void) => {
      mockAppStateCb = cb;
      return { remove: () => (mockAppStateCb = null) };
    },
  },
}));
let mockAvailable = true;

jest.mock('../../src/meetings/native', () => ({
  Recorder: { consumeSharedAudio: jest.fn() },
  RecorderEvents: {
    onShared: (cb: () => void) => {
      mockSharedCb = cb;
      return { remove: () => (mockSharedCb = null) };
    },
  },
  isSharedAudioAvailable: () => mockAvailable,
}));

const consume = Recorder.consumeSharedAudio as jest.Mock;
const file = (name: string): PickedAudio => ({
  uri: `file:///cache/shared/${name}`,
  name,
  size: 1000,
  durationMs: 0,
  mime: 'audio/aac',
});
const flush = () => new Promise(r => setImmediate(r));

beforeEach(() => {
  consume.mockReset();
  mockSharedCb = null;
  mockAvailable = true;
});

describe('takeShared', () => {
  it('uses the first file and counts the rest as skipped', () => {
    expect(takeShared([file('a.aac'), file('b.m4a'), file('c.mp3')])).toEqual({
      file: file('a.aac'),
      skipped: 2,
    });
  });

  it('handles nothing shared', () => {
    expect(takeShared([])).toEqual({ file: null, skipped: 0 });
    expect(takeShared(null)).toEqual({ file: null, skipped: 0 });
  });
});

describe('watchSharedAudio', () => {
  it('delivers a file shared before JS started (cold start)', async () => {
    consume.mockResolvedValueOnce([file('Recording 1.aac')]);
    const onFile = jest.fn();
    watchSharedAudio(onFile);
    await flush();
    expect(onFile).toHaveBeenCalledWith(file('Recording 1.aac'), 0);
  });

  it('delivers files shared while running when the native event fires', async () => {
    consume.mockResolvedValueOnce([]);
    const onFile = jest.fn();
    watchSharedAudio(onFile);
    await flush();
    expect(onFile).not.toHaveBeenCalled();

    consume.mockResolvedValueOnce([file('a.aac'), file('b.aac')]);
    mockSharedCb?.();
    await flush();
    expect(onFile).toHaveBeenCalledWith(file('a.aac'), 1);
  });

  it('drains when the app comes to the foreground even if the event was missed', async () => {
    consume.mockResolvedValueOnce([]);
    const onFile = jest.fn();
    watchSharedAudio(onFile);
    await flush();
    consume.mockResolvedValueOnce([file('from-recorder.aac')]);
    mockAppStateCb?.('background');
    mockAppStateCb?.('active');
    await flush();
    expect(onFile).toHaveBeenCalledTimes(1);
    expect(onFile).toHaveBeenCalledWith(file('from-recorder.aac'), 0);
  });

  it('stops delivering after unsubscribe', async () => {
    consume.mockResolvedValue([file('late.aac')]);
    const onFile = jest.fn();
    const stop = watchSharedAudio(onFile);
    stop();
    await flush();
    expect(onFile).not.toHaveBeenCalled();
    expect(mockSharedCb).toBeNull();
    expect(mockAppStateCb).toBeNull();
  });

  it('does nothing on builds without the native method', () => {
    mockAvailable = false;
    const onFile = jest.fn();
    watchSharedAudio(onFile)();
    expect(consume).not.toHaveBeenCalled();
  });

  it('logs and survives a native failure', async () => {
    const warn = jest.spyOn(console, 'warn').mockImplementation(() => {});
    consume.mockRejectedValueOnce(new Error('boom'));
    const onFile = jest.fn();
    watchSharedAudio(onFile);
    await flush();
    expect(onFile).not.toHaveBeenCalled();
    expect(warn).toHaveBeenCalled();
    warn.mockRestore();
  });
});
