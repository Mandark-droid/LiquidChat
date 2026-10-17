import React from 'react';
import { StyleSheet, Text, View } from 'react-native';

import { theme } from '../config/theme';
import type { ChatMetrics } from '../types';
import PrivacyBadge from './PrivacyBadge';

interface MetricsBarProps {
  metrics: ChatMetrics | null;
  isGenerating: boolean;
  liveTokenCount: number;
  liveTokensPerSecond: number;
  modelName: string;
}

const MetricsBar: React.FC<MetricsBarProps> = ({
  metrics,
  isGenerating,
  liveTokenCount,
  liveTokensPerSecond,
  modelName,
}) => {
  return (
    <View style={styles.container}>
      <PrivacyBadge />
      <View style={styles.metric}>
        <Text style={styles.label} numberOfLines={1}>
          Tokens
        </Text>
        <Text style={styles.value} numberOfLines={1}>
          {isGenerating ? liveTokenCount : metrics?.totalTokens || 0}
        </Text>
      </View>
      <View style={styles.metric}>
        <Text style={styles.label} numberOfLines={1}>
          Speed
        </Text>
        <Text style={styles.value} numberOfLines={1}>
          {isGenerating
            ? liveTokensPerSecond > 0
              ? `${liveTokensPerSecond.toFixed(1)} t/s`
              : '...'
            : metrics?.tokensPerSecond
              ? `${metrics.tokensPerSecond.toFixed(1)} t/s`
              : '-'}
        </Text>
      </View>
      <View style={styles.metric}>
        <Text style={styles.label} numberOfLines={1}>
          TTFT
        </Text>
        <Text style={styles.value} numberOfLines={1}>
          {metrics?.timeToFirstTokenMs ? `${metrics.timeToFirstTokenMs}ms` : '-'}
        </Text>
      </View>
      <View style={styles.modelBadge}>
        <Text style={styles.modelText} numberOfLines={1}>
          {modelName}
        </Text>
      </View>
    </View>
  );
};

export default MetricsBar;

const styles = StyleSheet.create({
  container: {
    flexDirection: 'row',
    alignItems: 'center',
    paddingHorizontal: 16,
    paddingVertical: 8,
    backgroundColor: theme.colors.surface,
    borderBottomWidth: 1,
    borderBottomColor: theme.colors.border,
    columnGap: 14,
    rowGap: 6,
    // The model badge drops to its own line instead of squeezing the numbers into wrapping.
    flexWrap: 'wrap',
  },
  metric: { alignItems: 'center', flexShrink: 0 },
  label: { fontSize: 10, color: theme.colors.textMuted, textTransform: 'uppercase' },
  value: { fontSize: 13, fontWeight: '700', color: theme.colors.text, marginTop: 2 },
  modelBadge: {
    marginLeft: 'auto',
    backgroundColor: theme.colors.secondary,
    paddingHorizontal: 10,
    paddingVertical: 4,
    borderRadius: 12,
    maxWidth: '100%',
    flexShrink: 1,
  },
  modelText: { fontSize: 11, fontWeight: '600', color: '#FFF' },
});
