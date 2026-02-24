import React from 'react';
import { View, Text, StyleSheet } from 'react-native';
import { theme } from '../config/theme';
import type { ModelTier } from '../types';

interface TierBadgeProps {
  tier: ModelTier;
}

const TIER_COLORS: Record<ModelTier, string> = {
  hot: '#FF8C42',
  warm: theme.colors.accent,
  cold: theme.colors.textMuted,
};

const TIER_LABELS: Record<ModelTier, string> = {
  hot: 'Hot',
  warm: 'Warm',
  cold: 'Cold',
};

const TierBadge: React.FC<TierBadgeProps> = ({ tier }) => {
  const color = TIER_COLORS[tier];
  return (
    <View style={[styles.badge, { backgroundColor: `${color}20` }]}>
      <Text style={[styles.text, { color }]}>{TIER_LABELS[tier]}</Text>
    </View>
  );
};

export default TierBadge;

const styles = StyleSheet.create({
  badge: {
    paddingHorizontal: 8,
    paddingVertical: 3,
    borderRadius: 6,
  },
  text: {
    fontSize: 11,
    fontWeight: '600',
  },
});
