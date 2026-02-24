import React, { useEffect, useState, useCallback } from 'react';
import {
  View,
  Text,
  ScrollView,
  StyleSheet,
  Platform,
  NativeModules,
} from 'react-native';
import { SafeAreaView } from 'react-native-safe-area-context';
import { useModelManager } from '../hooks/useModelManager';
import { actionLogger, type ActionLogEntry } from '../services/ActionLogger';
import { memoryService } from '../services/MemoryService';
import TierBadge from '../components/TierBadge';
import RamUsageBar from '../components/RamUsageBar';
import { theme } from '../config/theme';

interface DeviceMetrics {
  totalRamGb: string;
  usedRamMb: string;
  arch: string;
  platform: string;
}

export default function AgentDashboardScreen() {
  const { loadedModels, totalRamMb, ramBudgetMb, deviceProfile } = useModelManager();
  const [recentActions, setRecentActions] = useState<ActionLogEntry[]>([]);
  const [actionStats, setActionStats] = useState({ total: 0, success: 0, fail: 0, avgDurationMs: 0 });
  const [memoryStats, setMemoryStats] = useState({ memoryCount: 0, documentCount: 0, documentFiles: [] as string[] });
  const [deviceMetrics, setDeviceMetrics] = useState<DeviceMetrics>({
    totalRamGb: '...',
    usedRamMb: '...',
    arch: Platform.OS === 'android' ? 'ARM64' : 'ARM64',
    platform: Platform.OS,
  });

  const refresh = useCallback(async () => {
    await actionLogger.init();
    setRecentActions(actionLogger.getRecent(20));
    setActionStats(actionLogger.getStats());

    try {
      setMemoryStats(memoryService.getStats());
    } catch {}

    // Device metrics
    try {
      if (Platform.OS === 'android' && NativeModules.DeviceInfoModule) {
        const totalMem = await NativeModules.DeviceInfoModule.getTotalMemory();
        setDeviceMetrics(prev => ({
          ...prev,
          totalRamGb: (totalMem / (1024 * 1024 * 1024)).toFixed(1),
        }));
      }
    } catch {}
  }, []);

  useEffect(() => {
    refresh();
  }, [refresh]);

  const renderSection = (title: string, children: React.ReactNode) => (
    <View style={styles.section}>
      <Text style={styles.sectionTitle}>{title}</Text>
      <View style={styles.sectionContent}>{children}</View>
    </View>
  );

  const renderLoadedModels = () => {
    if (loadedModels.length === 0) {
      return (
        <Text style={styles.emptyText}>
          No models currently loaded. Enable orchestration in Settings to manage models.
        </Text>
      );
    }

    return (
      <>
        <RamUsageBar usedMb={totalRamMb} budgetMb={ramBudgetMb} />
        {loadedModels.map(model => (
          <View key={model.slug} style={styles.modelRow}>
            <View style={styles.modelInfo}>
              <Text style={styles.modelName}>{model.slug}</Text>
              <Text style={styles.modelRam}>~{model.ramMb}MB</Text>
            </View>
            <TierBadge tier={model.tier} />
          </View>
        ))}
      </>
    );
  };

  const renderActionHistory = () => {
    if (recentActions.length === 0) {
      return (
        <Text style={styles.emptyText}>
          No tool executions yet. Tool calls will be logged here.
        </Text>
      );
    }

    const successRate = actionStats.total > 0
      ? Math.round((actionStats.success / actionStats.total) * 100)
      : 0;

    return (
      <>
        <View style={styles.statsRow}>
          <Text style={styles.statText}>Total: {actionStats.total}</Text>
          <Text style={styles.statText}>Success: {successRate}%</Text>
          <Text style={styles.statText}>Avg: {actionStats.avgDurationMs}ms</Text>
        </View>
        {recentActions.map(entry => (
          <View key={entry.id} style={styles.actionRow}>
            <View style={styles.actionIcon}>
              <Text style={{ fontSize: 12 }}>{entry.success ? '+' : 'x'}</Text>
            </View>
            <View style={styles.actionInfo}>
              <Text style={styles.actionName}>{entry.toolName}</Text>
              <Text style={styles.actionMeta}>
                {entry.modelSlug} - {entry.durationMs}ms
              </Text>
            </View>
            <Text style={styles.actionTime}>
              {new Date(entry.timestamp).toLocaleTimeString()}
            </Text>
          </View>
        ))}
      </>
    );
  };

  const renderMemoryStats = () => (
    <>
      <View style={styles.metricRow}>
        <Text style={styles.metricLabel}>Memories</Text>
        <Text style={styles.metricValue}>{memoryStats.memoryCount}</Text>
      </View>
      <View style={styles.metricRow}>
        <Text style={styles.metricLabel}>Document Chunks</Text>
        <Text style={styles.metricValue}>{memoryStats.documentCount}</Text>
      </View>
      {memoryStats.documentFiles.length > 0 && (
        <View style={styles.metricRow}>
          <Text style={styles.metricLabel}>Files</Text>
          <Text style={styles.metricValue}>{memoryStats.documentFiles.join(', ')}</Text>
        </View>
      )}
    </>
  );

  const renderDeviceMetrics = () => (
    <>
      <View style={styles.metricRow}>
        <Text style={styles.metricLabel}>Platform</Text>
        <Text style={styles.metricValue}>{deviceMetrics.platform}</Text>
      </View>
      <View style={styles.metricRow}>
        <Text style={styles.metricLabel}>Architecture</Text>
        <Text style={styles.metricValue}>{deviceMetrics.arch}</Text>
      </View>
      <View style={styles.metricRow}>
        <Text style={styles.metricLabel}>Total RAM</Text>
        <Text style={styles.metricValue}>{deviceMetrics.totalRamGb} GB</Text>
      </View>
      <View style={styles.metricRow}>
        <Text style={styles.metricLabel}>Device Profile</Text>
        <Text style={styles.metricValue}>
          {deviceProfile?.name ?? 'Not detected'}
          {deviceProfile ? ` (${deviceProfile.ramBudgetMb}MB budget)` : ''}
        </Text>
      </View>
      <View style={styles.metricRow}>
        <Text style={styles.metricLabel}>Max Concurrent Models</Text>
        <Text style={styles.metricValue}>
          {deviceProfile?.maxConcurrentModels ?? '-'}
        </Text>
      </View>
    </>
  );

  return (
    <SafeAreaView style={styles.container}>
      <View style={styles.header}>
        <Text style={styles.headerTitle}>Agent Dashboard</Text>
      </View>
      <ScrollView style={styles.scrollView} contentContainerStyle={styles.scrollContent}>
        {renderSection('Loaded Models', renderLoadedModels())}
        {renderSection('Action History', renderActionHistory())}
        {renderSection('Memory Stats', renderMemoryStats())}
        {renderSection('Device Metrics', renderDeviceMetrics())}
      </ScrollView>
    </SafeAreaView>
  );
}

const styles = StyleSheet.create({
  container: {
    flex: 1,
    backgroundColor: theme.colors.background,
  },
  header: {
    paddingHorizontal: theme.spacing.lg,
    paddingVertical: theme.spacing.md,
    backgroundColor: theme.colors.primary,
    borderBottomWidth: 1,
    borderBottomColor: theme.colors.border,
  },
  headerTitle: {
    fontSize: theme.fontSize.xxl,
    fontWeight: '700',
    color: theme.colors.textLight,
  },
  scrollView: {
    flex: 1,
  },
  scrollContent: {
    padding: theme.spacing.lg,
    paddingBottom: 100,
  },
  section: {
    marginBottom: theme.spacing.xxl,
  },
  sectionTitle: {
    fontSize: theme.fontSize.lg,
    fontWeight: '700',
    color: theme.colors.accent,
    marginBottom: theme.spacing.md,
    textTransform: 'uppercase',
    letterSpacing: 1,
  },
  sectionContent: {
    backgroundColor: theme.colors.surface,
    borderRadius: theme.borderRadius.md,
    padding: theme.spacing.lg,
    borderWidth: 1,
    borderColor: theme.colors.border,
  },
  emptyText: {
    fontSize: theme.fontSize.md,
    color: theme.colors.textSecondary,
    textAlign: 'center',
    paddingVertical: theme.spacing.lg,
  },
  modelRow: {
    flexDirection: 'row',
    justifyContent: 'space-between',
    alignItems: 'center',
    paddingVertical: theme.spacing.sm,
    borderBottomWidth: 1,
    borderBottomColor: theme.colors.border,
  },
  modelInfo: {
    flex: 1,
  },
  modelName: {
    fontSize: theme.fontSize.md,
    fontWeight: '600',
    color: theme.colors.text,
  },
  modelRam: {
    fontSize: theme.fontSize.sm,
    color: theme.colors.textSecondary,
  },
  statsRow: {
    flexDirection: 'row',
    justifyContent: 'space-around',
    paddingVertical: theme.spacing.sm,
    marginBottom: theme.spacing.sm,
    borderBottomWidth: 1,
    borderBottomColor: theme.colors.border,
  },
  statText: {
    fontSize: theme.fontSize.sm,
    color: theme.colors.textSecondary,
    fontWeight: '600',
  },
  actionRow: {
    flexDirection: 'row',
    alignItems: 'center',
    paddingVertical: theme.spacing.sm,
    borderBottomWidth: 1,
    borderBottomColor: theme.colors.border,
  },
  actionIcon: {
    width: 24,
    height: 24,
    borderRadius: 12,
    backgroundColor: theme.colors.surfaceLight,
    justifyContent: 'center',
    alignItems: 'center',
    marginRight: theme.spacing.sm,
  },
  actionInfo: {
    flex: 1,
  },
  actionName: {
    fontSize: theme.fontSize.md,
    fontWeight: '600',
    color: theme.colors.text,
  },
  actionMeta: {
    fontSize: theme.fontSize.xs,
    color: theme.colors.textMuted,
  },
  actionTime: {
    fontSize: theme.fontSize.xs,
    color: theme.colors.textMuted,
  },
  metricRow: {
    flexDirection: 'row',
    justifyContent: 'space-between',
    alignItems: 'center',
    paddingVertical: theme.spacing.sm,
    borderBottomWidth: 1,
    borderBottomColor: theme.colors.border,
  },
  metricLabel: {
    fontSize: theme.fontSize.md,
    color: theme.colors.textSecondary,
  },
  metricValue: {
    fontSize: theme.fontSize.md,
    fontWeight: '600',
    color: theme.colors.text,
    flexShrink: 1,
    textAlign: 'right',
  },
});
