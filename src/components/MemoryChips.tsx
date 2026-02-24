import React from 'react';
import {
  View,
  Text,
  ScrollView,
  TouchableOpacity,
  StyleSheet,
  Alert,
} from 'react-native';
import { theme } from '../config/theme';
import { triggerLightHaptic } from '../utils/haptics';
import type { MemoryResult } from '../types';

interface MemoryChipsProps {
  memories: MemoryResult[];
  onDismiss: () => void;
}

export default function MemoryChips({ memories, onDismiss }: MemoryChipsProps) {
  if (memories.length === 0) return null;

  const handleChipPress = (memory: MemoryResult) => {
    triggerLightHaptic();
    Alert.alert(
      'Recalled Memory',
      memory.text,
      [{ text: 'OK' }],
    );
  };

  return (
    <View style={styles.container}>
      <Text style={styles.sectionLabel}>FROM MEMORY</Text>
      <ScrollView
        horizontal
        showsHorizontalScrollIndicator={false}
        contentContainerStyle={styles.scrollContent}
      >
        {memories.map((memory) => (
          <TouchableOpacity
            key={memory.id}
            style={styles.chip}
            onPress={() => handleChipPress(memory)}
          >
            <Text style={styles.chipText} numberOfLines={1}>
              {'\uD83E\uDDE0'}{' '}
              {memory.text.length > 55
                ? memory.text.slice(0, 55) + '...'
                : memory.text}
            </Text>
          </TouchableOpacity>
        ))}
        <TouchableOpacity style={styles.dismissChip} onPress={onDismiss}>
          <Text style={styles.dismissText}>Clear</Text>
        </TouchableOpacity>
      </ScrollView>
    </View>
  );
}

const styles = StyleSheet.create({
  container: {
    maxHeight: 56,
    marginBottom: theme.spacing.sm,
  },
  sectionLabel: {
    fontSize: 9,
    fontWeight: '700',
    color: theme.colors.textMuted,
    letterSpacing: 1,
    marginLeft: theme.spacing.sm,
    marginBottom: 3,
  },
  scrollContent: {
    paddingHorizontal: theme.spacing.xs,
    gap: theme.spacing.sm,
  },
  chip: {
    backgroundColor: theme.colors.memoryChipBg,
    borderRadius: theme.borderRadius.full,
    paddingHorizontal: theme.spacing.lg,
    paddingVertical: theme.spacing.sm,
    borderWidth: 1,
    borderColor: theme.colors.memoryChipBorder,
    maxWidth: 220,
  },
  chipText: {
    fontSize: 13,
    color: theme.colors.memoryChipText,
    fontWeight: '600',
  },
  dismissChip: {
    backgroundColor: theme.colors.surfaceLight,
    borderRadius: theme.borderRadius.full,
    paddingHorizontal: theme.spacing.lg,
    paddingVertical: theme.spacing.sm,
    borderWidth: 1,
    borderColor: theme.colors.border,
  },
  dismissText: {
    fontSize: 13,
    color: theme.colors.textSecondary,
    fontWeight: '600',
  },
});
