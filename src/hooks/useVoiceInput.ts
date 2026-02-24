import { useState, useRef, useCallback, useEffect } from 'react';
import { PermissionsAndroid, Platform } from 'react-native';
import AudioRecorderPlayer from 'react-native-audio-recorder-player';
import * as RNFS from '@dr.pogodin/react-native-fs';
import { useCactusSTT } from 'cactus-react-native';

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

  const recorderRef = useRef<AudioRecorderPlayer | null>(null);
  const tempFileRef = useRef<string | null>(null);
  const mountedRef = useRef(true);

  const cactusSTT = useCactusSTT({ model: sttModel });

  useEffect(() => {
    mountedRef.current = true;
    return () => {
      mountedRef.current = false;
      cleanup();
    };
  }, []);

  const cleanup = async () => {
    try {
      if (recorderRef.current) {
        await recorderRef.current.stopRecorder();
        recorderRef.current.removeRecordBackListener();
      }
    } catch {}
    try {
      if (tempFileRef.current && (await RNFS.exists(tempFileRef.current))) {
        await RNFS.unlink(tempFileRef.current);
      }
    } catch {}
    tempFileRef.current = null;
  };

  const requestMicPermission = async (): Promise<boolean> => {
    if (Platform.OS !== 'android') return true;
    try {
      const granted = await PermissionsAndroid.request(
        PermissionsAndroid.PERMISSIONS.RECORD_AUDIO,
        {
          title: 'Microphone Permission',
          message: 'LiquidChat needs microphone access for voice input.',
          buttonPositive: 'Allow',
          buttonNegative: 'Deny',
        },
      );
      return granted === PermissionsAndroid.RESULTS.GRANTED;
    } catch {
      return false;
    }
  };

  const ensureSttReady = async (): Promise<boolean> => {
    if (sttReady) return true;

    try {
      if (!cactusSTT.isDownloaded && !cactusSTT.isDownloading) {
        await cactusSTT.download();
      }

      if (!sttReady) {
        setSttInitializing(true);
        await cactusSTT.init();
        if (mountedRef.current) {
          setSttReady(true);
          setSttInitializing(false);
        }
      }
      return true;
    } catch (e) {
      if (mountedRef.current) {
        setSttInitializing(false);
        const msg = e instanceof Error ? e.message : 'Failed to initialize STT';
        setError(msg);
        onError?.(msg);
      }
      return false;
    }
  };

  const prepareStt = useCallback(async () => {
    await ensureSttReady();
  }, [sttReady, cactusSTT.isDownloaded]);

  const startRecording = async () => {
    const hasPermission = await requestMicPermission();
    if (!hasPermission) {
      const msg = 'Microphone permission denied. Enable it in Settings.';
      setError(msg);
      onError?.(msg);
      return;
    }

    setError(null);
    setRecordingDurationMs(0);

    // Lazy init STT on first recording
    const ready = await ensureSttReady();
    if (!ready || !mountedRef.current) return;

    const timestamp = Date.now();
    const filePath = `${RNFS.CachesDirectoryPath}/voice_input_${timestamp}.wav`;
    tempFileRef.current = filePath;

    const recorder = new AudioRecorderPlayer();
    recorderRef.current = recorder;

    recorder.addRecordBackListener((e) => {
      if (mountedRef.current) {
        setRecordingDurationMs(Math.floor(e.currentPosition));
      }
    });

    try {
      await recorder.startRecorder(filePath, {
        SampleRate: 16000,
        Channels: 1,
        AudioEncodingBitRate: 256000,
      });
      if (mountedRef.current) {
        setState('recording');
      }
    } catch (e) {
      const msg = e instanceof Error ? e.message : 'Failed to start recording';
      setError(msg);
      onError?.(msg);
      tempFileRef.current = null;
    }
  };

  const stopRecordingAndTranscribe = async () => {
    if (!recorderRef.current || !tempFileRef.current) {
      setState('idle');
      return;
    }

    const filePath = tempFileRef.current;

    try {
      await recorderRef.current.stopRecorder();
      recorderRef.current.removeRecordBackListener();
    } catch {}

    if (!mountedRef.current) return;

    // Check for very short recordings
    if (recordingDurationMs < 500) {
      setError(null);
      setState('idle');
      await cleanupTempFile(filePath);
      return;
    }

    setState('transcribing');

    try {
      const result = await cactusSTT.transcribe({
        audioFilePath: filePath,
      });

      if (!mountedRef.current) return;

      const text = result.response?.trim();
      if (text) {
        onTranscription(text);
        setError(null);
      } else {
        setError('No speech detected. Try speaking louder or longer.');
        onError?.('No speech detected. Try speaking louder or longer.');
      }
    } catch (e) {
      if (mountedRef.current) {
        const msg = e instanceof Error ? e.message : 'Transcription failed';
        setError(msg);
        onError?.(msg);
      }
    } finally {
      await cleanupTempFile(filePath);
      if (mountedRef.current) {
        setState('idle');
        setRecordingDurationMs(0);
      }
    }
  };

  const cleanupTempFile = async (filePath: string) => {
    try {
      if (await RNFS.exists(filePath)) {
        await RNFS.unlink(filePath);
      }
    } catch {}
    if (tempFileRef.current === filePath) {
      tempFileRef.current = null;
    }
  };

  const toggleRecording = useCallback(async () => {
    if (state === 'recording') {
      await stopRecordingAndTranscribe();
    } else if (state === 'idle') {
      await startRecording();
    }
    // Ignore taps during 'transcribing'
  }, [state, sttReady, recordingDurationMs]);

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
