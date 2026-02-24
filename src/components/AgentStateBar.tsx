import React, { useEffect, useRef } from 'react';
import { View, Text, Animated, StyleSheet } from 'react-native';
import { theme } from '../config/theme';
import type { AgentState } from '../types';

interface AgentStateBarProps {
  agentState: AgentState;
}

const STATE_CONFIG: Record<
  string,
  { color: string; emoji: string; label: string }
> = {
  listening: {
    color: theme.colors.agentListening,
    emoji: '\uD83C\uDFA4',
    label: 'Listening...',
  },
  thinking: {
    color: theme.colors.agentThinking,
    emoji: '\uD83E\uDDE0',
    label: 'Thinking...',
  },
  acting: {
    color: theme.colors.agentActing,
    emoji: '\u2699\uFE0F',
    label: '',
  },
  vision: {
    color: theme.colors.agentVision,
    emoji: '\uD83D\uDC41\uFE0F',
    label: 'Vision active',
  },
  error: {
    color: theme.colors.agentError,
    emoji: '\u26A0\uFE0F',
    label: 'Error',
  },
};

export default function AgentStateBar({ agentState }: AgentStateBarProps) {
  const shimmerAnim = useRef(new Animated.Value(-1)).current;

  useEffect(() => {
    if (agentState.kind === 'idle') {
      shimmerAnim.setValue(-1);
      return;
    }

    const animation = Animated.loop(
      Animated.timing(shimmerAnim, {
        toValue: 1,
        duration: 1500,
        useNativeDriver: true,
      }),
    );
    animation.start();
    return () => animation.stop();
  }, [agentState.kind]);

  if (agentState.kind === 'idle') return null;

  const config = STATE_CONFIG[agentState.kind];
  if (!config) return null;

  const bgColor = config.color;
  let label = config.label;
  if (agentState.kind === 'acting') {
    label = agentState.toolName;
  } else if (agentState.kind === 'error') {
    label = agentState.message;
  }

  const shimmerTranslateX = shimmerAnim.interpolate({
    inputRange: [-1, 1],
    outputRange: [-200, 200],
  });

  return (
    <View style={styles.wrapper}>
      <View style={[styles.pill, { backgroundColor: bgColor }]}>
        <Animated.View
          style={[
            styles.shimmer,
            { transform: [{ translateX: shimmerTranslateX }] },
          ]}
        />
        <Text style={styles.emoji}>{config.emoji}</Text>
        <Text style={styles.label} numberOfLines={1}>
          {label}
        </Text>
      </View>
    </View>
  );
}

const styles = StyleSheet.create({
  wrapper: {
    alignItems: 'center',
    paddingVertical: 4,
    backgroundColor: theme.colors.surface,
  },
  pill: {
    flexDirection: 'row',
    alignItems: 'center',
    height: 32,
    borderRadius: 16,
    paddingHorizontal: 14,
    overflow: 'hidden',
  },
  shimmer: {
    position: 'absolute',
    top: 0,
    bottom: 0,
    width: 60,
    backgroundColor: 'rgba(255,255,255,0.2)',
  },
  emoji: {
    fontSize: 14,
    marginRight: 6,
  },
  label: {
    fontSize: 13,
    fontWeight: '700',
    color: '#FFFFFF',
    maxWidth: 200,
  },
});
