import { Platform } from 'react-native';
import Tts from 'react-native-tts';

import { storage } from './storage';

let isInitialized = false;

export const DEFAULT_SPEECH_SPEED = 1.0;
export const MIN_SPEECH_SPEED = 0.5;
export const MAX_SPEECH_SPEED = 2.0;

/** User-facing multiplier: 1.0 is the voice's normal pace. */
let speechSpeed: number | null = null;
/** Voice id from Settings; '' or an id the engine no longer has means the engine's default. */
let voiceId: string | null = null;
let appliedVoice: string | null = null;

export interface TTSVoice {
  id: string;
  name: string;
  language: string;
  quality: number;
  /** Streams from the network (Google's online voices). */
  network: boolean;
}

export function clampSpeechSpeed(speed: unknown): number {
  const n = typeof speed === 'number' && Number.isFinite(speed) ? speed : DEFAULT_SPEECH_SPEED;
  return Math.round(Math.min(MAX_SPEECH_SPEED, Math.max(MIN_SPEECH_SPEED, n)) * 10) / 10;
}

async function currentSpeed(): Promise<number> {
  if (speechSpeed === null) {
    const saved = await storage.getSettings().catch(() => null);
    speechSpeed = clampSpeechSpeed(saved?.speechSpeed);
  }
  return speechSpeed;
}

async function currentVoice(): Promise<string> {
  if (voiceId === null) {
    const saved = await storage.getSettings().catch(() => null);
    voiceId = saved?.ttsVoice ?? '';
  }
  return voiceId;
}

async function applyVoice(id: string): Promise<void> {
  if (!id || id === appliedVoice) return;
  try {
    await Tts.setDefaultVoice(id);
    appliedVoice = id;
  } catch (error) {
    // Uninstalled or unknown voice (e.g. the old free-text default): keep the engine's default.
    console.warn(`[TTS] Voice "${id}" unavailable:`, error);
    appliedVoice = id;
  }
}

/** Called when the user picks a voice so the next utterance uses it ('' = engine default). */
export async function setVoice(id: string): Promise<void> {
  voiceId = id;
  appliedVoice = null;
  if (!id) {
    // No API to reset to the default voice; the language default is the closest.
    await Tts.setDefaultLanguage('en-US').catch(() => {});
    return;
  }
  if (isInitialized) await applyVoice(id);
}

async function applyRate(speed: number): Promise<void> {
  // Without skipTransform, react-native-tts on Android maps r -> r*4-1, so 1.0 played at 3x.
  if (Platform.OS === 'android') await Tts.setDefaultRate(speed, true);
  else await Tts.setDefaultRate(speed * 0.5); // AVSpeechUtterance default rate is 0.5
}

export async function initTTS(): Promise<void> {
  if (isInitialized) return;

  try {
    await Tts.setDefaultLanguage('en-US');
    await Tts.setDefaultPitch(1.0);
    await applyRate(await currentSpeed());
    await applyVoice(await currentVoice());
    isInitialized = true;
  } catch (error) {
    console.error('Error initializing TTS:', error);
  }
}

/** Called when the user changes the setting so the next utterance uses it. */
export async function setSpeechSpeed(speed: number): Promise<void> {
  speechSpeed = clampSpeechSpeed(speed);
  if (isInitialized) await applyRate(speechSpeed).catch(() => {});
}

export async function speak(text: string): Promise<void> {
  try {
    if (!isInitialized) await initTTS();
    await applyRate(await currentSpeed());
    await Tts.stop();
    Tts.speak(text);
  } catch (error) {
    console.error('Error speaking:', error);
  }
}

export async function stopSpeaking(): Promise<void> {
  try {
    await Tts.stop();
  } catch (error) {
    console.error('Error stopping TTS:', error);
  }
}

/** Installed voices, by language then name. */
export async function getAvailableVoices(): Promise<TTSVoice[]> {
  try {
    if (!isInitialized) await initTTS();
    const voices = await Tts.voices();
    return voices
      .filter(v => !v.notInstalled)
      .map(v => ({
        id: v.id,
        name: v.name,
        language: v.language,
        quality: v.quality,
        network: !!v.networkConnectionRequired,
      }))
      .sort((a, b) => a.language.localeCompare(b.language) || a.name.localeCompare(b.name));
  } catch (error) {
    console.error('Error getting voices:', error);
    return [];
  }
}

export function addTTSListeners(callbacks: {
  onStart?: () => void;
  onFinish?: () => void;
  onCancel?: () => void;
  onError?: (error: any) => void;
}): void {
  if (callbacks.onStart) {
    Tts.addEventListener('tts-start', callbacks.onStart);
  }
  if (callbacks.onFinish) {
    Tts.addEventListener('tts-finish', callbacks.onFinish);
  }
  if (callbacks.onCancel) {
    Tts.addEventListener('tts-cancel', callbacks.onCancel);
  }
}

export function removeTTSListeners(): void {
  try {
    Tts.removeAllListeners('tts-start');
    Tts.removeAllListeners('tts-finish');
    Tts.removeAllListeners('tts-cancel');
  } catch (error) {
    // Listeners may not exist
  }
}
