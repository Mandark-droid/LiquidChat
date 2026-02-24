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
  onTranscription: (text: string) => void;
  onError?: (message: string) => void;
}

export default function VoiceInputButton({
  sttModel,
  disabled,
  onTranscription,
  onError,
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

  const pulseAnim = useRef(new Animated.Value(1)).current;

  useEffect(() => {
    if (state === 'recording') {
      const animation = Animated.loop(
        Animated.sequence([
          Animated.timing(pulseAnim, {
            toValue: 0.5,
            duration: 600,
            useNativeDriver: true,
          }),
          Animated.timing(pulseAnim, {
            toValue: 1,
            duration: 600,
            useNativeDriver: true,
          }),
        ]),
      );
      animation.start();
      return () => animation.stop();
    } else {
      pulseAnim.setValue(1);
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
      return <ActivityIndicator size="small" color={theme.colors.accent} />;
    }
    if (state === 'recording') {
      return <Text style={styles.iconEmoji}>⏹️</Text>;
    }
    return <Text style={styles.iconEmoji}>🎙️</Text>;
  };

  return (
    <View style={styles.wrapper}>
      <Animated.View
        style={[
          state === 'recording' && { opacity: pulseAnim },
        ]}
      >
        <TouchableOpacity
          style={[
            styles.button,
            state === 'recording' && styles.recordingButton,
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
    borderRadius: 8,
    backgroundColor: theme.colors.surfaceLight,
    justifyContent: 'center',
    alignItems: 'center',
  },
  recordingButton: {
    backgroundColor: theme.colors.error,
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
    color: theme.colors.error,
    fontWeight: '600',
    marginTop: 1,
  },
});
