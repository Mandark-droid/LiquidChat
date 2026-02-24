import React from 'react';
import { View, Text, TouchableOpacity, StyleSheet } from 'react-native';
import { theme } from '../config/theme';
import TierBadge from './TierBadge';
import type { LiquidModel, ModelTier } from '../types';

interface ModelCardProps {
  model: LiquidModel;
  isSelected: boolean;
  isDownloaded?: boolean;
  downloadProgress?: number;
  onSelect: () => void;
  onDownload?: () => void;
  onDelete?: () => void;
  tier?: ModelTier;
  isLoaded?: boolean;
}

const ModelCard: React.FC<ModelCardProps> = ({
  model,
  isSelected,
  isDownloaded,
  downloadProgress,
  onSelect,
  onDownload,
  onDelete,
  tier,
  isLoaded,
}) => {
  const getCategoryIcon = () => {
    switch (model.category) {
      case 'text': return '💬';
      case 'vision': return '👁️';
      case 'audio': return '🎤';
      case 'specialized': return '🔧';
      case 'custom': return '⚡';
      default: return '🤖';
    }
  };

  return (
    <TouchableOpacity
      style={[styles.card, isSelected && styles.cardSelected]}
      onPress={onSelect}
    >
      <View style={styles.header}>
        <Text style={styles.categoryIcon}>{getCategoryIcon()}</Text>
        <View style={styles.titleContainer}>
          <Text style={styles.name}>{model.name}</Text>
          <Text style={styles.description}>{model.description}</Text>
        </View>
      </View>

      <View style={styles.details}>
        <View style={styles.sizeBadge}>
          <Text style={styles.sizeText}>{model.sizeMb >= 1000 ? `${(model.sizeMb / 1000).toFixed(1)}GB` : `${model.sizeMb}MB`}</Text>
        </View>
        {model.supportsToolCalling && (
          <View style={[styles.capBadge, { backgroundColor: 'rgba(0, 212, 255, 0.2)' }]}>
            <Text style={[styles.capText, { color: theme.colors.accent }]}>Tools</Text>
          </View>
        )}
        {model.supportsVision && (
          <View style={[styles.capBadge, { backgroundColor: 'rgba(108, 99, 255, 0.2)' }]}>
            <Text style={[styles.capText, { color: theme.colors.secondary }]}>Vision</Text>
          </View>
        )}
        {model.supportsAudio && (
          <View style={[styles.capBadge, { backgroundColor: 'rgba(255, 215, 64, 0.2)' }]}>
            <Text style={[styles.capText, { color: theme.colors.warning }]}>Audio</Text>
          </View>
        )}
        {tier && <TierBadge tier={tier} />}
        {isLoaded && (
          <View style={[styles.capBadge, { backgroundColor: 'rgba(0, 230, 118, 0.2)' }]}>
            <Text style={[styles.capText, { color: theme.colors.success }]}>Loaded</Text>
          </View>
        )}
        {isDownloaded && (
          <View style={[styles.capBadge, { backgroundColor: 'rgba(0, 230, 118, 0.2)' }]}>
            <Text style={[styles.capText, { color: theme.colors.success }]}>Downloaded</Text>
          </View>
        )}
        {isSelected && (
          <View style={[styles.capBadge, { backgroundColor: theme.colors.secondary }]}>
            <Text style={[styles.capText, { color: '#FFF' }]}>Active</Text>
          </View>
        )}
      </View>

      {downloadProgress !== undefined && (
        <View style={styles.progressContainer}>
          <View style={[styles.progressBar, { width: `${downloadProgress}%` }]} />
          <Text style={styles.progressText}>{downloadProgress}%</Text>
        </View>
      )}

      {onDownload && !isDownloaded && downloadProgress === undefined && (
        <TouchableOpacity style={styles.downloadButton} onPress={onDownload}>
          <Text style={styles.downloadText}>Download</Text>
        </TouchableOpacity>
      )}

      {onDelete && isDownloaded && (
        <TouchableOpacity style={styles.deleteButton} onPress={onDelete}>
          <Text style={styles.deleteText}>Delete</Text>
        </TouchableOpacity>
      )}
    </TouchableOpacity>
  );
};

export default ModelCard;

const styles = StyleSheet.create({
  card: {
    backgroundColor: theme.colors.surface,
    borderRadius: 12,
    padding: 16,
    marginBottom: 10,
    borderWidth: 1,
    borderColor: theme.colors.border,
  },
  cardSelected: { borderColor: theme.colors.secondary },
  header: { flexDirection: 'row', gap: 12, marginBottom: 10 },
  categoryIcon: { fontSize: 28 },
  titleContainer: { flex: 1 },
  name: { fontSize: 16, fontWeight: '700', color: theme.colors.text },
  description: { fontSize: 12, color: theme.colors.textSecondary, marginTop: 2 },
  details: { flexDirection: 'row', gap: 6, flexWrap: 'wrap' },
  sizeBadge: { backgroundColor: 'rgba(255,255,255,0.1)', paddingHorizontal: 8, paddingVertical: 3, borderRadius: 6 },
  sizeText: { fontSize: 11, color: theme.colors.textSecondary, fontWeight: '600' },
  capBadge: { paddingHorizontal: 8, paddingVertical: 3, borderRadius: 6 },
  capText: { fontSize: 11, fontWeight: '600' },
  progressContainer: {
    marginTop: 10,
    height: 24,
    backgroundColor: 'rgba(255,255,255,0.1)',
    borderRadius: 12,
    overflow: 'hidden',
    justifyContent: 'center',
  },
  progressBar: {
    position: 'absolute',
    left: 0,
    top: 0,
    bottom: 0,
    backgroundColor: theme.colors.secondary,
    borderRadius: 12,
  },
  progressText: { textAlign: 'center', fontSize: 11, fontWeight: '700', color: theme.colors.textLight },
  downloadButton: {
    marginTop: 10,
    backgroundColor: 'rgba(108, 99, 255, 0.2)',
    padding: 8,
    borderRadius: 8,
    alignItems: 'center',
  },
  downloadText: { color: theme.colors.secondary, fontSize: 13, fontWeight: '600' },
  deleteButton: {
    marginTop: 10,
    backgroundColor: 'rgba(255, 82, 82, 0.15)',
    padding: 8,
    borderRadius: 8,
    alignItems: 'center',
  },
  deleteText: { color: theme.colors.error, fontSize: 13, fontWeight: '600' },
});
