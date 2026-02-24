import React from 'react';
import { View, Text, StyleSheet } from 'react-native';
import { theme } from '../config/theme';

interface RamUsageBarProps {
  usedMb: number;
  budgetMb: number;
}

const RamUsageBar: React.FC<RamUsageBarProps> = ({ usedMb, budgetMb }) => {
  const ratio = budgetMb > 0 ? usedMb / budgetMb : 0;
  const percentage = Math.min(ratio * 100, 100);

  let barColor = theme.colors.success; // green <60%
  if (ratio >= 0.8) {
    barColor = theme.colors.error; // red >=80%
  } else if (ratio >= 0.6) {
    barColor = theme.colors.warning; // yellow 60-80%
  }

  return (
    <View style={styles.container}>
      <View style={styles.labelRow}>
        <Text style={styles.label}>RAM Usage</Text>
        <Text style={styles.value}>
          {usedMb}MB / {budgetMb}MB
        </Text>
      </View>
      <View style={styles.track}>
        <View style={[styles.fill, { width: `${percentage}%`, backgroundColor: barColor }]} />
      </View>
    </View>
  );
};

export default RamUsageBar;

const styles = StyleSheet.create({
  container: {
    marginVertical: 8,
  },
  labelRow: {
    flexDirection: 'row',
    justifyContent: 'space-between',
    marginBottom: 4,
  },
  label: {
    fontSize: 12,
    color: theme.colors.textSecondary,
    fontWeight: '500',
  },
  value: {
    fontSize: 12,
    color: theme.colors.text,
    fontWeight: '600',
  },
  track: {
    height: 8,
    backgroundColor: theme.colors.surfaceLight,
    borderRadius: 4,
    overflow: 'hidden',
  },
  fill: {
    height: '100%',
    borderRadius: 4,
  },
});
