import {
  DeviceEventEmitter,
  type EmitterSubscription,
  NativeModules,
  PermissionsAndroid,
  Platform,
} from 'react-native';

import type { RecorderLevelEvent, RecorderSegmentEvent, RecorderStateEvent } from './types';

interface MeetingRecorderNative {
  start(opts: {
    dir: string;
    minSegmentSec?: number;
    maxSegmentSec?: number;
    startIndex?: number;
    startOffsetMs?: number;
    source?: string;
    foreground?: boolean;
    title?: string;
  }): Promise<void>;
  pause(): Promise<void>;
  resume(): Promise<void>;
  stop(): Promise<number>;
  setProcessing(text: string): Promise<void>;
  release(): Promise<void>;
  getStatus(): Promise<{
    state: 'idle' | 'recording' | 'paused' | 'stopping';
    elapsedMs: number;
    segmentsWritten: number;
    dir: string | null;
  }>;
  repairWav(path: string): Promise<number>;
  needsNotificationPermission(): Promise<boolean>;
}

interface MeetingDocsNative {
  renderPdf(html: string, outPath: string): Promise<string>;
  shareFile(
    path: string,
    opts: {
      mime?: string;
      subject?: string;
      text?: string;
      emails?: string[];
      chooserTitle?: string;
      emailOnly?: boolean;
    },
  ): Promise<boolean>;
  saveToDownloads(path: string, displayName: string, mime: string): Promise<string>;
}

function missing(name: string): never {
  throw new Error(
    `${name} native module is not linked. Rebuild the Android app (npm run android).`,
  );
}

export const Recorder: MeetingRecorderNative =
  NativeModules.MeetingRecorder ??
  new Proxy({} as MeetingRecorderNative, { get: () => () => missing('MeetingRecorder') });

export const Docs: MeetingDocsNative =
  NativeModules.MeetingDocs ??
  new Proxy({} as MeetingDocsNative, { get: () => () => missing('MeetingDocs') });

export const isRecorderAvailable = (): boolean =>
  Platform.OS === 'android' && !!NativeModules.MeetingRecorder;

export const RecorderEvents = {
  onSegment: (cb: (e: RecorderSegmentEvent) => void): EmitterSubscription =>
    DeviceEventEmitter.addListener('MeetingRecorder:segment', cb),
  onLevel: (cb: (e: RecorderLevelEvent) => void): EmitterSubscription =>
    DeviceEventEmitter.addListener('MeetingRecorder:level', cb),
  onState: (cb: (e: RecorderStateEvent) => void): EmitterSubscription =>
    DeviceEventEmitter.addListener('MeetingRecorder:state', cb),
  onError: (cb: (e: { message: string }) => void): EmitterSubscription =>
    DeviceEventEmitter.addListener('MeetingRecorder:error', cb),
  onSilenced: (cb: (e: { silenced: boolean }) => void): EmitterSubscription =>
    DeviceEventEmitter.addListener('MeetingRecorder:silenced', cb),
  onStopRequested: (cb: () => void): EmitterSubscription =>
    DeviceEventEmitter.addListener('MeetingRecorder:stopRequested', cb),
};

/** Mic is mandatory; notifications are best-effort (FGS still runs without them). */
export async function ensureRecordingPermissions(): Promise<boolean> {
  if (Platform.OS !== 'android') return false;
  const mic = await PermissionsAndroid.request(PermissionsAndroid.PERMISSIONS.RECORD_AUDIO, {
    title: 'Microphone',
    message: 'LiquidChat records meetings on-device. Audio never leaves your phone.',
    buttonPositive: 'Allow',
    buttonNegative: 'Deny',
  });
  if (mic !== PermissionsAndroid.RESULTS.GRANTED) return false;
  try {
    if (await Recorder.needsNotificationPermission()) {
      await PermissionsAndroid.request('android.permission.POST_NOTIFICATIONS' as any);
    }
  } catch {}
  return true;
}
