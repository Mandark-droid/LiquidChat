import * as RNFS from '@dr.pogodin/react-native-fs';
import { useCactusSTT } from 'cactus-react-native';
import { useCallback, useEffect, useRef, useState } from 'react';

import { quantizationFor } from '../config/models';
import { meetingSession } from '../meetings/MeetingSession';
import {
  ensureRecordingPermissions,
  isRecorderAvailable,
  Recorder,
  RecorderEvents,
} from '../meetings/native';
import { cleanTranscript } from '../meetings/Transcriber';
import type { RecorderSegmentEvent } from '../meetings/types';

/**
 * Push-to-talk voice input.
 *
 * Captures through the native MeetingRecorder (16 kHz mono PCM16 WAV), which
 * is what Cactus STT expects. The previous implementation recorded AAC via
 * MediaRecorder into a ".wav"-named file and called transcribe() with a
 * non-existent `audioFilePath` option, so Whisper never received audio.
 */

export type VoiceInputState = 'idle' | 'recording' | 'transcribing';

interface UseVoiceInputReturn {
  state: VoiceInputState;
  recordingDurationMs: number;
  sttReady: boolean;
  sttDownloading: boolean;
  sttDownloadProgress: number;
  sttInitializing: boolean;
  error: string | null;
  toggleRecording: () => Promise<void>;
  prepareStt: () => Promise<void>;
}

interface UseVoiceInputParams {
  sttModel: string;
  onTranscription: (text: string) => void;
  onError?: (message: string) => void;
}

const MAX_UTTERANCE_SEC = 120;
const VOICE_DIR = `${RNFS.CachesDirectoryPath}/voice_input`;

export function useVoiceInput({
  sttModel,
  onTranscription,
  onError,
}: UseVoiceInputParams): UseVoiceInputReturn {
  const [state, setState] = useState<VoiceInputState>('idle');
  const [recordingDurationMs, setRecordingDurationMs] = useState(0);
  const [sttReady, setSttReady] = useState(false);
  const [sttInitializing, setSttInitializing] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const mountedRef = useRef(true);
  const segmentRef = useRef<RecorderSegmentEvent | null>(null);
  const subsRef = useRef<Array<{ remove: () => void }>>([]);
  const durationRef = useRef(0);
  const stoppingRef = useRef(false);
  const stateRef = useRef<VoiceInputState>('idle');
  stateRef.current = state;

  const quantization = quantizationFor(sttModel);
  const cactusSTT = useCactusSTT({
    model: sttModel,
    options: quantization ? { quantization } : undefined,
  });

  useEffect(() => {
    mountedRef.current = true;
    return () => {
      mountedRef.current = false;
      detach();
      if (stateRef.current === 'recording') Recorder.stop().catch(() => {});
    };
  }, []);

  const fail = (msg: string) => {
    if (!mountedRef.current) return;
    setError(msg);
    onError?.(msg);
  };

  const detach = () => {
    subsRef.current.forEach(s => s.remove());
    subsRef.current = [];
  };

  const ensureSttReady = async (): Promise<boolean> => {
    if (sttReady) return true;
    try {
      if (!cactusSTT.isDownloaded && !cactusSTT.isDownloading) {
        await cactusSTT.download();
      }
      setSttInitializing(true);
      await cactusSTT.init();
      if (mountedRef.current) {
        setSttReady(true);
        setSttInitializing(false);
      }
      return true;
    } catch (e) {
      if (mountedRef.current) setSttInitializing(false);
      fail(e instanceof Error ? e.message : 'Failed to initialize STT');
      return false;
    }
  };

  const prepareStt = useCallback(async () => {
    await ensureSttReady();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [sttReady, cactusSTT.isDownloaded]);

  const startRecording = async () => {
    if (!isRecorderAvailable()) {
      fail('Recorder native module missing — rebuild the app.');
      return;
    }
    if (meetingSession.isBusy()) {
      fail('A meeting is being recorded. Stop it to use voice input.');
      return;
    }
    if (!(await ensureRecordingPermissions())) {
      fail('Microphone permission denied. Enable it in Settings.');
      return;
    }
    setError(null);
    setRecordingDurationMs(0);
    durationRef.current = 0;
    segmentRef.current = null;
    stoppingRef.current = false;

    const ready = await ensureSttReady();
    if (!ready || !mountedRef.current) return;

    await RNFS.mkdir(VOICE_DIR);
    detach();
    subsRef.current = [
      RecorderEvents.onSegment(seg => {
        segmentRef.current = seg;
      }),
      RecorderEvents.onLevel(l => {
        durationRef.current = l.elapsedMs;
        if (mountedRef.current) setRecordingDurationMs(l.elapsedMs);
        if (l.elapsedMs > MAX_UTTERANCE_SEC * 1000) stopRecordingAndTranscribe();
      }),
    ];
    try {
      await Recorder.start({
        dir: VOICE_DIR,
        // One segment for the whole utterance; no silence cuts.
        minSegmentSec: MAX_UTTERANCE_SEC + 10,
        maxSegmentSec: MAX_UTTERANCE_SEC + 10,
        foreground: false,
        source: 'voice_recognition',
      });
      if (mountedRef.current) setState('recording');
    } catch (e) {
      detach();
      fail(e instanceof Error ? e.message : 'Failed to start recording');
    }
  };

  const stopRecordingAndTranscribe = async () => {
    if (stoppingRef.current) return;
    stoppingRef.current = true;
    try {
      await Recorder.stop();
    } catch {}
    // The final segment event is posted right before stop() resolves.
    await new Promise(r => setTimeout(r, 250));
    detach();
    const seg = segmentRef.current;
    if (!mountedRef.current) return;

    if (!seg || durationRef.current < 500) {
      setState('idle');
      if (seg) await RNFS.unlink(seg.path).catch(() => {});
      return;
    }

    setState('transcribing');
    try {
      const result = await cactusSTT.transcribe({ audio: seg.path });
      if (!mountedRef.current) return;
      const text = cleanTranscript(result.response ?? '');
      if (text) {
        onTranscription(text);
        setError(null);
      } else {
        fail('No speech detected. Try speaking louder or longer.');
      }
    } catch (e) {
      fail(e instanceof Error ? e.message : 'Transcription failed');
    } finally {
      await RNFS.unlink(seg.path).catch(() => {});
      if (mountedRef.current) {
        setState('idle');
        setRecordingDurationMs(0);
      }
    }
  };

  const toggleRecording = useCallback(async () => {
    if (state === 'recording') {
      await stopRecordingAndTranscribe();
    } else if (state === 'idle') {
      await startRecording();
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [state, sttReady]);

  return {
    state,
    recordingDurationMs,
    sttReady,
    sttDownloading: cactusSTT.isDownloading,
    sttDownloadProgress: Math.round(cactusSTT.downloadProgress * 100),
    sttInitializing,
    error,
    toggleRecording,
    prepareStt,
  };
}
