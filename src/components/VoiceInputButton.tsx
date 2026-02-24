import React, { useEffect, useRef } from 'react';
import {
  TouchableOpacity,
  Text,
  View,
  ActivityIndicator,
  Animated,
  StyleSheet,
} from 'react-native';
import { useVoiceInput, type VoiceInputState } from '../hooks/useVoiceInput';
import { triggerLightHaptic } from '../utils/haptics';
import { theme } from '../config/theme';

interface VoiceInputButtonProps {
  sttModel: string;
  disabled?: boolean;
  speaking?: boolean;
  onTranscription: (text: string) => void;
  onError?: (message: string) => void;
  onRecordingStart?: () => void;
  onRecordingEnd?: () => void;
}

function SpeakingBars() {
  const bar1 = useRef(new Animated.Value(0.4)).current;
  const bar2 = useRef(new Animated.Value(0.6)).current;
  const bar3 = useRef(new Animated.Value(0.3)).current;

  useEffect(() => {
    const animate = (anim: Animated.Value, delay: number) =>
      Animated.loop(
        Animated.sequence([
          Animated.delay(delay),
          Animated.timing(anim, {
            toValue: 1,
            duration: 300,
            useNativeDriver: true,
          }),
          Animated.timing(anim, {
            toValue: 0.3,
            duration: 300,
            useNativeDriver: true,
          }),
        ]),
      );

    const a1 = animate(bar1, 0);
    const a2 = animate(bar2, 100);
    const a3 = animate(bar3, 200);
    a1.start();
    a2.start();
    a3.start();

    return () => {
      a1.stop();
      a2.stop();
      a3.stop();
    };
  }, []);

  return (
    <View style={speakingStyles.container}>
      {[bar1, bar2, bar3].map((anim, i) => (
        <Animated.View
          key={i}
          style={[
            speakingStyles.bar,
            { transform: [{ scaleY: anim }] },
          ]}
        />
      ))}
    </View>
  );
}

const speakingStyles = StyleSheet.create({
  container: {
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'center',
    gap: 3,
    height: 18,
  },
  bar: {
    width: 3,
    height: 14,
    borderRadius: 1.5,
    backgroundColor: theme.colors.accent,
  },
});

export default function VoiceInputButton({
  sttModel,
  disabled,
  speaking,
  onTranscription,
  onError,
  onRecordingStart,
  onRecordingEnd,
}: VoiceInputButtonProps) {
  const {
    state,
    recordingDurationMs,
    sttDownloading,
    sttDownloadProgress,
    sttInitializing,
    toggleRecording,
  } = useVoiceInput({
    sttModel,
    onTranscription,
    onError,
  });

  const scaleAnim = useRef(new Animated.Value(1)).current;
  const prevStateRef = useRef<VoiceInputState>(state);

  useEffect(() => {
    // Fire callbacks on state transitions
    if (state === 'recording' && prevStateRef.current !== 'recording') {
      onRecordingStart?.();
    }
    if (state !== 'recording' && prevStateRef.current === 'recording') {
      onRecordingEnd?.();
    }
    prevStateRef.current = state;
  }, [state]);

  useEffect(() => {
    if (state === 'recording') {
      const animation = Animated.loop(
        Animated.sequence([
          Animated.timing(scaleAnim, {
            toValue: 1.15,
            duration: 600,
            useNativeDriver: true,
          }),
          Animated.timing(scaleAnim, {
            toValue: 1.0,
            duration: 600,
            useNativeDriver: true,
          }),
        ]),
      );
      animation.start();
      return () => animation.stop();
    } else {
      scaleAnim.setValue(1);
    }
  }, [state]);

  const handlePress = async () => {
    triggerLightHaptic();
    await toggleRecording();
  };

  const formatDuration = (ms: number): string => {
    const totalSec = Math.floor(ms / 1000);
    const min = Math.floor(totalSec / 60);
    const sec = totalSec % 60;
    return `${min}:${sec.toString().padStart(2, '0')}`;
  };

  const isDisabled = disabled || state === 'transcribing' || sttDownloading || sttInitializing;

  const renderContent = () => {
    if (sttDownloading) {
      return <Text style={styles.progressText}>{sttDownloadProgress}%</Text>;
    }
    if (sttInitializing || state === 'transcribing') {
      return <ActivityIndicator size="small" color={theme.colors.agentThinking} />;
    }
    if (speaking) {
      return <SpeakingBars />;
    }
    if (state === 'recording') {
      return <Text style={styles.iconEmoji}>{'\u23F9\uFE0F'}</Text>;
    }
    return <Text style={styles.iconEmoji}>{'\uD83C\uDFA4\uFE0F'}</Text>;
  };

  const getButtonStyle = () => {
    if (state === 'recording') return styles.recordingButton;
    if (speaking) return styles.speakingButton;
    return styles.idleButton;
  };

  return (
    <View style={styles.wrapper}>
      <Animated.View
        style={[
          state === 'recording' && { transform: [{ scale: scaleAnim }] },
        ]}
      >
        <TouchableOpacity
          style={[
            styles.button,
            getButtonStyle(),
            isDisabled && state !== 'recording' && styles.disabledButton,
          ]}
          onPress={handlePress}
          disabled={isDisabled}
          activeOpacity={0.7}
        >
          {renderContent()}
        </TouchableOpacity>
      </Animated.View>
      {state === 'recording' && (
        <Text style={styles.durationText}>
          {formatDuration(recordingDurationMs)}
        </Text>
      )}
    </View>
  );
}

const styles = StyleSheet.create({
  wrapper: {
    alignItems: 'center',
    marginRight: 4,
  },
  button: {
    width: 40,
    height: 40,
    borderRadius: 20,
    justifyContent: 'center',
    alignItems: 'center',
  },
  idleButton: {
    backgroundColor: 'transparent',
    borderWidth: 2,
    borderColor: theme.colors.accent,
  },
  recordingButton: {
    backgroundColor: 'transparent',
    borderWidth: 2,
    borderColor: theme.colors.agentListening,
  },
  speakingButton: {
    backgroundColor: 'transparent',
    borderWidth: 2,
    borderColor: theme.colors.accent,
  },
  disabledButton: {
    opacity: 0.4,
  },
  iconEmoji: {
    fontSize: 18,
  },
  progressText: {
    fontSize: 10,
    fontWeight: '700',
    color: theme.colors.accent,
  },
  durationText: {
    fontSize: 9,
    color: theme.colors.agentListening,
    fontWeight: '600',
    marginTop: 1,
  },
});
