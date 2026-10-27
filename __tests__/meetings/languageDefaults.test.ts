import type AsyncStorageStatic from '@react-native-async-storage/async-storage';
import { CactusSTT } from 'cactus-react-native';

import type { getMeetingSettings as getMeetingSettingsType } from '../../src/meetings/settings';
import {
  buildWhisperPrompt,
  normalizeLanguageCode,
  type TranscribeJob,
  transcriber,
} from '../../src/meetings/Transcriber';

const KEY = '@liquid_meeting_settings';

const job = (over: Partial<TranscribeJob> = {}): TranscribeJob => ({
  audioPath: '/tmp/seg_00001.wav',
  speechRatio: 0.7,
  glossary: '',
  previousText: '',
  language: 'auto',
  task: 'translate',
  contextPrompting: false,
  ...over,
});

describe('meeting language defaults', () => {
  // Fresh module registry per test so the settings cache starts empty; AsyncStorage must
  // come from the same registry as the settings module.
  let AsyncStorage: typeof AsyncStorageStatic;
  let load: () => typeof getMeetingSettingsType;
  beforeEach(async () => {
    jest.resetModules();
    const mod = require('@react-native-async-storage/async-storage');
    AsyncStorage = mod.default ?? mod;
    await AsyncStorage.clear();
    load = () => require('../../src/meetings/settings').getMeetingSettings;
  });

  it('defaults new installs to auto-detect + translate to English', async () => {
    const s = await load()();
    expect(s.language).toBe('auto');
    expect(s.task).toBe('translate');
  });

  it('migrates saved pre-v2 settings once, keeping everything else', async () => {
    await AsyncStorage.setItem(
      KEY,
      JSON.stringify({ language: 'hi', task: 'transcribe', vocabulary: 'UPI' }),
    );
    const s = await load()();
    expect(s).toMatchObject({ language: 'auto', task: 'translate', vocabulary: 'UPI' });
    expect(JSON.parse((await AsyncStorage.getItem(KEY))!).defaultsVersion).toBe(3);
  });

  it('turns on chat indexing once for v2 settings, without touching the language choice', async () => {
    await AsyncStorage.setItem(
      KEY,
      JSON.stringify({
        language: 'hi',
        task: 'transcribe',
        indexForChat: false,
        defaultsVersion: 2,
      }),
    );
    const s = await load()();
    expect(s).toMatchObject({ language: 'hi', task: 'transcribe', indexForChat: true });
  });

  it('keeps indexing off when the user turns it off after the migration', async () => {
    await AsyncStorage.setItem(KEY, JSON.stringify({ indexForChat: false, defaultsVersion: 3 }));
    expect((await load()()).indexForChat).toBe(false);
  });

  it('keeps a choice the user makes after the migration', async () => {
    await AsyncStorage.setItem(
      KEY,
      JSON.stringify({ language: 'hi', task: 'transcribe', defaultsVersion: 3 }),
    );
    const s = await load()();
    expect(s).toMatchObject({ language: 'hi', task: 'transcribe' });
  });
});

describe('auto-detect + translate prompt', () => {
  afterEach(async () => {
    jest.restoreAllMocks();
    await transcriber.release();
  });
  it('normalises detected language tags', () => {
    expect(normalizeLanguageCode('<|hi|>')).toBe('hi');
    expect(normalizeLanguageCode(' EN ')).toBe('en');
    expect(normalizeLanguageCode('')).toBeNull();
    expect(normalizeLanguageCode('unknown-lang')).toBeNull();
  });

  it('never asks Whisper to translate English into English', () => {
    expect(buildWhisperPrompt(job({ language: 'en' }))).toBe(
      '<|startoftranscript|><|en|><|transcribe|><|notimestamps|>',
    );
  });

  it('detects the language per segment and forces translate with that language token', async () => {
    const detect = jest
      .spyOn(CactusSTT.prototype, 'detectLanguage')
      .mockResolvedValue({ language: '<|hi|>', confidence: 0.9 });
    const transcribe = jest.spyOn(CactusSTT.prototype, 'transcribe').mockResolvedValue({
      success: true,
      response: 'We will ship the pilot next month.',
    } as never);
    const out = await transcriber.enqueue(job());
    expect(out.status).toBe('done');
    expect(detect).toHaveBeenCalledTimes(1);
    expect(transcribe.mock.calls[0][0]).toMatchObject({
      prompt: '<|startoftranscript|><|hi|><|translate|><|notimestamps|>',
    });
  });

  it('falls back to English transcription when detection fails', async () => {
    jest.spyOn(CactusSTT.prototype, 'detectLanguage').mockRejectedValue(new Error('boom'));
    const transcribe = jest
      .spyOn(CactusSTT.prototype, 'transcribe')
      .mockResolvedValue({ success: true, response: 'Hello everyone, let us begin.' } as never);
    const warn = jest.spyOn(console, 'warn').mockImplementation(() => {});
    await transcriber.enqueue(job());
    expect(transcribe.mock.calls[0][0]).toMatchObject({
      prompt: '<|startoftranscript|><|en|><|transcribe|><|notimestamps|>',
    });
    expect(warn).toHaveBeenCalledWith(expect.stringContaining('language detection failed'));
  });

  it('retries detection without VAD, then falls back to English on "unknown"', async () => {
    const detect = jest
      .spyOn(CactusSTT.prototype, 'detectLanguage')
      .mockResolvedValue({ language: 'unknown' } as never);
    const transcribe = jest
      .spyOn(CactusSTT.prototype, 'transcribe')
      .mockResolvedValue({ success: true, response: 'Good morning everyone.' } as never);
    jest.spyOn(console, 'warn').mockImplementation(() => {});
    await transcriber.enqueue(job());
    expect(detect.mock.calls.map(c => c[0].options?.useVad)).toEqual([true, false]);
    expect(transcribe.mock.calls[0][0].prompt).toBe(
      '<|startoftranscript|><|en|><|transcribe|><|notimestamps|>',
    );
  });
});
