import { Platform } from 'react-native';
import Tts from 'react-native-tts';

import type * as TtsManager from '../../src/utils/ttsManager';

describe('speech speed', () => {
  beforeEach(async () => {
    jest.resetModules();
    await require('@react-native-async-storage/async-storage').clear();
    Platform.OS = 'android';
  });

  const load = (): typeof TtsManager => require('../../src/utils/ttsManager');

  it('clamps to 0.5–2.0 and defaults to normal speed', () => {
    const { clampSpeechSpeed } = load();
    expect(clampSpeechSpeed(undefined)).toBe(1);
    expect(clampSpeechSpeed(0.1)).toBe(0.5);
    expect(clampSpeechSpeed(9)).toBe(2);
    expect(clampSpeechSpeed(0.84)).toBe(0.8);
  });

  it('passes the multiplier to Android untransformed (1.0 = normal, not 3x)', async () => {
    const spy = jest.spyOn(require('react-native-tts'), 'setDefaultRate');
    const { speak } = load();
    await speak('hello');
    expect(spy).toHaveBeenLastCalledWith(1, true);
  });

  it('uses the saved setting, ignoring the legacy ttsRate field', async () => {
    const { speak } = load();
    // Same module registry as the freshly loaded ttsManager.
    await require('../../src/utils/storage').storage.saveSettings({
      ttsRate: 1.0,
      speechSpeed: 0.8,
    });
    const spy = jest.spyOn(require('react-native-tts'), 'setDefaultRate');
    await speak('hello');
    expect(spy).toHaveBeenLastCalledWith(0.8, true);
  });

  it('applies a changed speed to the next utterance', async () => {
    const { speak, setSpeechSpeed } = load();
    const spy = jest.spyOn(require('react-native-tts'), 'setDefaultRate');
    await setSpeechSpeed(1.3);
    await speak('hello');
    expect(spy).toHaveBeenLastCalledWith(1.3, true);
  });

  it('maps to the iOS rate scale', async () => {
    Platform.OS = 'ios';
    const { speak } = load();
    const spy = jest.spyOn(require('react-native-tts'), 'setDefaultRate');
    await speak('hello');
    expect(spy).toHaveBeenLastCalledWith(0.5);
  });

  it('keeps the Tts mock importable', () => expect(Tts).toBeDefined());
});
