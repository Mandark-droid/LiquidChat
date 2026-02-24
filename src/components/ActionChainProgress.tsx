import React from 'react';
import { View, Text, ActivityIndicator, StyleSheet } from 'react-native';
import { theme } from '../config/theme';
import type { ActionChainStep } from '../types';

interface ActionChainProgressProps {
  steps: ActionChainStep[];
  totalPlanned: number;
}

function StatusIcon({ status }: { status: ActionChainStep['status'] }) {
  switch (status) {
    case 'success':
      return <Text style={[styles.icon, { color: theme.colors.agentActing }]}>{'\u2714'}</Text>;
    case 'running':
      return (
        <View style={styles.runningRow}>
          <Text style={[styles.icon, { color: theme.colors.accent }]}>{'\u25B6'}</Text>
          <ActivityIndicator size="small" color={theme.colors.accent} style={styles.spinner} />
        </View>
      );
    case 'error':
      return <Text style={[styles.icon, { color: theme.colors.agentError }]}>{'\u2718'}</Text>;
    default:
      return <Text style={[styles.icon, { color: theme.colors.textMuted }]}>{'\u25CB'}</Text>;
  }
}

export default function ActionChainProgress({
  steps,
  totalPlanned,
}: ActionChainProgressProps) {
  if (steps.length === 0) return null;

  return (
    <View style={styles.card}>
      <Text style={styles.header}>
        Plan created ({totalPlanned} step{totalPlanned !== 1 ? 's' : ''})
      </Text>
      {steps.map((step, idx) => (
        <View key={idx} style={styles.stepRow}>
          <StatusIcon status={step.status} />
          <View style={styles.stepContent}>
            <Text
              style={[
                styles.toolName,
                step.status === 'running' && styles.toolNameActive,
                step.status === 'success' && styles.toolNameDone,
                step.status === 'error' && styles.toolNameError,
              ]}
              numberOfLines={1}
            >
              {step.toolName}
            </Text>
            {step.resultMessage && (
              <Text style={styles.resultMsg} numberOfLines={1}>
                {step.resultMessage}
              </Text>
            )}
          </View>
        </View>
      ))}
    </View>
  );
}

const styles = StyleSheet.create({
  card: {
    backgroundColor: theme.colors.surface,
    borderWidth: 1,
    borderColor: theme.colors.border,
    borderRadius: theme.borderRadius.md,
    marginHorizontal: theme.spacing.md,
    marginVertical: theme.spacing.xs,
    padding: theme.spacing.md,
  },
  header: {
    fontSize: 12,
    fontWeight: '700',
    color: theme.colors.textSecondary,
    textTransform: 'uppercase',
    marginBottom: theme.spacing.sm,
  },
  stepRow: {
    flexDirection: 'row',
    alignItems: 'center',
    marginVertical: 3,
  },
  runningRow: {
    flexDirection: 'row',
    alignItems: 'center',
  },
  icon: {
    fontSize: 14,
    width: 20,
    textAlign: 'center',
  },
  spinner: {
    marginLeft: 2,
    transform: [{ scale: 0.6 }],
  },
  stepContent: {
    flex: 1,
    marginLeft: theme.spacing.sm,
  },
  toolName: {
    fontSize: 13,
    fontWeight: '600',
    color: theme.colors.text,
  },
  toolNameActive: {
    color: theme.colors.accent,
  },
  toolNameDone: {
    color: theme.colors.textSecondary,
  },
  toolNameError: {
    color: theme.colors.agentError,
  },
  resultMsg: {
    fontSize: 11,
    color: theme.colors.textMuted,
    marginTop: 1,
  },
});
