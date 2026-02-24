import React, { useEffect, useRef } from 'react';
import { View, Text, Animated, StyleSheet } from 'react-native';
import { theme } from '../config/theme';

interface VisionModeOverlayProps {
  active: boolean;
}

export default function VisionModeOverlay({ active }: VisionModeOverlayProps) {
  const shimmerAnim = useRef(new Animated.Value(-1)).current;

  useEffect(() => {
    if (!active) {
      shimmerAnim.setValue(-1);
      return;
    }

    const animation = Animated.loop(
      Animated.timing(shimmerAnim, {
        toValue: 1,
        duration: 2000,
        useNativeDriver: true,
      }),
    );
    animation.start();
    return () => animation.stop();
  }, [active]);

  if (!active) return null;

  const shimmerTranslateY = shimmerAnim.interpolate({
    inputRange: [-1, 1],
    outputRange: [-400, 400],
  });

  return (
    <View style={styles.overlay} pointerEvents="none">
      <Animated.View
        style={[
          styles.shimmer,
          { transform: [{ translateY: shimmerTranslateY }] },
        ]}
      />
      <View style={styles.labelContainer}>
        <Text style={styles.label}>{'\uD83D\uDC41\uFE0F'} Vision Mode</Text>
      </View>
    </View>
  );
}

const styles = StyleSheet.create({
  overlay: {
    ...StyleSheet.absoluteFillObject,
    borderWidth: 3,
    borderColor: theme.colors.agentVision,
    borderRadius: theme.borderRadius.md,
    overflow: 'hidden',
    justifyContent: 'center',
    alignItems: 'center',
  },
  shimmer: {
    position: 'absolute',
    left: 0,
    right: 0,
    height: 80,
    backgroundColor: 'rgba(236,72,153,0.06)',
  },
  labelContainer: {
    backgroundColor: 'rgba(236,72,153,0.15)',
    paddingHorizontal: 16,
    paddingVertical: 8,
    borderRadius: 20,
  },
  label: {
    fontSize: 14,
    fontWeight: '700',
    color: theme.colors.agentVision,
  },
});
