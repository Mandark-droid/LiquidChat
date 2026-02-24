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
import type { MemoryResult } from '../types';

interface MemoryChipsProps {
  memories: MemoryResult[];
  onDismiss: () => void;
}

export default function MemoryChips({ memories, onDismiss }: MemoryChipsProps) {
  if (memories.length === 0) return null;

  const handleChipPress = (memory: MemoryResult) => {
    Alert.alert(
      'Recalled Memory',
      memory.text,
      [{ text: 'OK' }],
    );
  };

  return (
    <View style={styles.container}>
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
              {memory.text.length > 60
                ? memory.text.slice(0, 60) + '...'
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
    maxHeight: 40,
    marginBottom: theme.spacing.sm,
  },
  scrollContent: {
    paddingHorizontal: theme.spacing.xs,
    gap: theme.spacing.sm,
  },
  chip: {
    backgroundColor: theme.colors.toolCallBg,
    borderRadius: theme.borderRadius.full,
    paddingHorizontal: theme.spacing.lg,
    paddingVertical: theme.spacing.sm,
    borderWidth: 1,
    borderColor: theme.colors.toolCallBorder,
    maxWidth: 220,
  },
  chipText: {
    fontSize: 13,
    color: theme.colors.accent,
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
