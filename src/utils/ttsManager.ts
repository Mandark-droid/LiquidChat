import Tts from 'react-native-tts';

let isInitialized = false;

export async function initTTS(rate: number = 1.0): Promise<void> {
  if (isInitialized) return;

  try {
    await Tts.setDefaultLanguage('en-US');
    await Tts.setDefaultRate(rate);
    await Tts.setDefaultPitch(1.0);
    isInitialized = true;
  } catch (error) {
    console.error('Error initializing TTS:', error);
  }
}

export async function speak(text: string, rate?: number): Promise<void> {
  try {
    if (!isInitialized) {
      await initTTS(rate);
    }
    if (rate !== undefined) {
      await Tts.setDefaultRate(rate);
    }
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

export async function getAvailableVoices(): Promise<any[]> {
  try {
    const voices = await Tts.voices();
    return voices;
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
