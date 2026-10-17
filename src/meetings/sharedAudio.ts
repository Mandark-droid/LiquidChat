import { AppState } from 'react-native';

import { isSharedAudioAvailable, Recorder, RecorderEvents } from './native';
import type { PickedAudio } from './types';

/** One upload at a time: the first shared file is used, the rest are reported as skipped. */
export function takeShared(files: PickedAudio[] | null | undefined): {
  file: PickedAudio | null;
  skipped: number;
} {
  const list = (files ?? []).filter(f => !!f?.uri);
  return { file: list[0] ?? null, skipped: Math.max(0, list.length - 1) };
}

/**
 * Delivers audio shared into the app (cold start and while running) to `onFile`.
 * Returns an unsubscribe function.
 */
export function watchSharedAudio(onFile: (file: PickedAudio, skipped: number) => void): () => void {
  if (!isSharedAudioAvailable()) return () => {};
  let active = true;
  const drain = () =>
    Recorder.consumeSharedAudio()
      .then(files => {
        const { file, skipped } = takeShared(files);
        if (active && file) onFile(file, skipped);
      })
      .catch(e => console.warn('[SharedAudio] could not read shared files:', e));
  const sub = RecorderEvents.onShared(drain);
  // Backstop for a missed event: sharing from another app always brings this one forward.
  const appSub = AppState.addEventListener('change', s => s === 'active' && drain());
  drain();
  return () => {
    active = false;
    sub.remove();
    appSub.remove();
  };
}
