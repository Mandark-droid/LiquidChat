import React from 'react';
import { View, Text, StyleSheet } from 'react-native';
import { theme } from '../config/theme';
import type { ChatMetrics } from '../types';

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
      <View style={styles.metric}>
        <Text style={styles.label}>Tokens</Text>
        <Text style={styles.value}>
          {isGenerating ? liveTokenCount : (metrics?.totalTokens || 0)}
        </Text>
      </View>
      <View style={styles.metric}>
        <Text style={styles.label}>Speed</Text>
        <Text style={styles.value}>
          {isGenerating
            ? liveTokensPerSecond > 0 ? `${liveTokensPerSecond.toFixed(1)} t/s` : '...'
            : metrics?.tokensPerSecond ? `${metrics.tokensPerSecond.toFixed(1)} t/s` : '-'}
        </Text>
      </View>
      <View style={styles.metric}>
        <Text style={styles.label}>TTFT</Text>
        <Text style={styles.value}>
          {metrics?.timeToFirstTokenMs ? `${metrics.timeToFirstTokenMs}ms` : '-'}
        </Text>
      </View>
      <View style={styles.modelBadge}>
        <Text style={styles.modelText} numberOfLines={1}>{modelName}</Text>
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
    gap: 16,
  },
  metric: { alignItems: 'center' },
  label: { fontSize: 10, color: theme.colors.textMuted, textTransform: 'uppercase' },
  value: { fontSize: 13, fontWeight: '700', color: theme.colors.text, marginTop: 2 },
  modelBadge: {
    marginLeft: 'auto',
    backgroundColor: theme.colors.secondary,
    paddingHorizontal: 10,
    paddingVertical: 4,
    borderRadius: 12,
    maxWidth: 140,
  },
  modelText: { fontSize: 11, fontWeight: '600', color: '#FFF' },
});
