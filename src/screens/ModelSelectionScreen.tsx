import React, { useEffect, useState, useCallback } from 'react';
import {
  View,
  Text,
  TextInput,
  TouchableOpacity,
  ScrollView,
  StyleSheet,
  ActivityIndicator,
  Alert,
} from 'react-native';
import { SafeAreaView } from 'react-native-safe-area-context';
import * as RNFS from '@dr.pogodin/react-native-fs';
import { CactusLM } from 'cactus-react-native';
import {
  LIQUID_MODELS,
  getModelsByCategory,
  getModelBySlug,
} from '../config/models';
import ModelCard from '../components/ModelCard';
import { theme } from '../config/theme';
import type { LiquidModel, ModelCategory } from '../types';

type Tab = 'local' | 'hub';

const CATEGORIES: { key: ModelCategory; label: string }[] = [
  { key: 'text', label: 'Text' },
  { key: 'vision', label: 'Vision' },
  { key: 'audio', label: 'Audio' },
  { key: 'specialized', label: 'Specialized' },
  { key: 'custom', label: 'Custom' },
];

interface ModelSelectionScreenProps {
  currentModel: string;
  onSelectModel: (modelSlug: string) => void;
  onBack: () => void;
}

export default function ModelSelectionScreen({
  currentModel,
  onSelectModel,
  onBack,
}: ModelSelectionScreenProps) {
  const [activeTab, setActiveTab] = useState<Tab>('local');
  const [activeCategory, setActiveCategory] = useState<ModelCategory>('text');
  const [searchQuery, setSearchQuery] = useState('');
  const [downloadProgress, setDownloadProgress] = useState<
    Record<string, number>
  >({});
  const [downloadedModels, setDownloadedModels] = useState<Set<string>>(
    new Set(),
  );
  const [hfSearchQuery, setHfSearchQuery] = useState('');
  const [hfResults, setHfResults] = useState<any[]>([]);
  const [hfSearching, setHfSearching] = useState(false);

  useEffect(() => {
    checkDownloadedModels();
  }, []);

  const checkDownloadedModels = async () => {
    const modelsDir = `${RNFS.DocumentDirectoryPath}/models`;
    try {
      const exists = await RNFS.exists(modelsDir);
      if (!exists) return;
      const files = await RNFS.readDir(modelsDir);
      const downloaded = new Set<string>();
      for (const file of files) {
        if (file.name.endsWith('.gguf')) {
          downloaded.add(file.name.replace('.gguf', ''));
        }
        // Also detect Cactus v1.x weight folders (directories with config.txt)
        if (file.isDirectory()) {
          const hasConfig = await RNFS.exists(`${file.path}/config.txt`);
          if (hasConfig) {
            downloaded.add(file.name);
          }
        }
      }
      setDownloadedModels(downloaded);
    } catch {
      // Models directory may not exist yet
    }
  };

  const getFilteredModels = useCallback((): LiquidModel[] => {
    let models = getModelsByCategory(activeCategory);
    if (searchQuery.trim()) {
      const query = searchQuery.toLowerCase();
      models = models.filter(
        m =>
          m.name.toLowerCase().includes(query) ||
          m.slug.toLowerCase().includes(query) ||
          m.description.toLowerCase().includes(query),
      );
    }
    return models;
  }, [activeCategory, searchQuery]);

  const handleSelectModel = (model: LiquidModel) => {
    onSelectModel(model.slug);
    onBack();
  };

  const handleDownloadModel = async (model: LiquidModel) => {
    setDownloadProgress(prev => ({ ...prev, [model.slug]: 0 }));

    try {
      if (!model.isCustom) {
        // Check if model exists in CactusLM registry first
        let inRegistry = false;
        try {
          const tempCactus = new CactusLM();
          const models = await tempCactus.getModels();
          inRegistry = models.some((m: any) => m.slug === model.slug);
          await tempCactus.destroy();
        } catch {
          // Registry check failed, try anyway
          inRegistry = true;
        }

        if (!inRegistry) {
          setDownloadProgress(prev => {
            const next = { ...prev };
            delete next[model.slug];
            return next;
          });
          Alert.alert(
            'Not Available',
            `"${model.name}" is not currently available in the CactusLM registry. It may be added in a future update.`,
          );
          return;
        }

        // CactusLM registry model - use built-in download
        const cactus = new CactusLM({ model: model.slug });
        await cactus.download({
          onProgress: (progress: number) => {
            setDownloadProgress(prev => ({
              ...prev,
              [model.slug]: Math.round(progress * 100),
            }));
          },
        });
      } else if (model.hfRepo) {
        // Custom model - download from HuggingFace
        const modelsDir = `${RNFS.DocumentDirectoryPath}/models`;
        try {
          const exists = await RNFS.exists(modelsDir);
          if (!exists) {
            await RNFS.mkdir(modelsDir);
          }
        } catch {
          // ignore
        }

        // Fetch the repo file list from HuggingFace API
        const apiUrl = `https://huggingface.co/api/models/${model.hfRepo}`;
        const apiResponse = await fetch(apiUrl);
        if (!apiResponse.ok) {
          throw new Error(`Failed to fetch model info from HuggingFace (HTTP ${apiResponse.status})`);
        }
        const repoInfo = await apiResponse.json();
        const siblings: Array<{ rfilename: string }> = repoInfo.siblings || [];
        const filesToDownload = siblings
          .map((s: { rfilename: string }) => s.rfilename)
          .filter((name: string) => !name.startsWith('.'));

        if (filesToDownload.length === 0) {
          throw new Error('No files found in HuggingFace repo');
        }

        // Check if this is a cactus-format repo (has config.txt) or a single GGUF
        const isCactusFormat = filesToDownload.some((f: string) => f === 'config.txt');

        if (isCactusFormat) {
          // Download all files into a named directory (cactus weight folder)
          const modelDir = `${modelsDir}/${model.slug}`;
          try {
            if (!(await RNFS.exists(modelDir))) {
              await RNFS.mkdir(modelDir);
            }
          } catch {
            // ignore
          }

          let downloadedCount = 0;
          for (const fileName of filesToDownload) {
            // Create subdirectories if needed
            const parts = fileName.split('/');
            if (parts.length > 1) {
              const subDir = `${modelDir}/${parts.slice(0, -1).join('/')}`;
              try {
                if (!(await RNFS.exists(subDir))) {
                  await RNFS.mkdir(subDir);
                }
              } catch {
                // ignore
              }
            }

            const fileUrl = `https://huggingface.co/${model.hfRepo}/resolve/main/${fileName}`;
            const destPath = `${modelDir}/${fileName}`;
            const result = RNFS.downloadFile({
              fromUrl: fileUrl,
              toFile: destPath,
              progress: res => {
                const fileProgress = res.contentLength > 0
                  ? res.bytesWritten / res.contentLength
                  : 0;
                const overall = (downloadedCount + fileProgress) / filesToDownload.length;
                setDownloadProgress(prev => ({
                  ...prev,
                  [model.slug]: Math.round(overall * 100),
                }));
              },
              progressInterval: 500,
            });

            const response = await result.promise;
            if (response.statusCode !== 200) {
              throw new Error(`Failed to download ${fileName} (HTTP ${response.statusCode})`);
            }
            downloadedCount++;
            setDownloadProgress(prev => ({
              ...prev,
              [model.slug]: Math.round((downloadedCount / filesToDownload.length) * 100),
            }));
          }
        } else {
          // Single GGUF file download
          const ggufFile = filesToDownload.find((f: string) => f.endsWith('.gguf'));
          if (!ggufFile) {
            throw new Error('No GGUF file found in repo');
          }
          const destPath = `${modelsDir}/${model.slug}.gguf`;
          const downloadUrl = `https://huggingface.co/${model.hfRepo}/resolve/main/${ggufFile}`;
          const result = RNFS.downloadFile({
            fromUrl: downloadUrl,
            toFile: destPath,
            progress: res => {
              const progress = res.bytesWritten / res.contentLength;
              setDownloadProgress(prev => ({
                ...prev,
                [model.slug]: Math.round(progress * 100),
              }));
            },
            progressInterval: 500,
          });

          const response = await result.promise;
          if (response.statusCode !== 200) {
            throw new Error(`HTTP ${response.statusCode} - GGUF file not found in repo`);
          }
        }
      } else {
        setDownloadProgress(prev => {
          const next = { ...prev };
          delete next[model.slug];
          return next;
        });
        Alert.alert(
          'Manual Setup Required',
          'This model requires weight conversion first. Place the converted GGUF file in the models directory on your device.',
        );
        return;
      }

      setDownloadedModels(prev => new Set([...prev, model.slug]));
      setDownloadProgress(prev => {
        const next = { ...prev };
        delete next[model.slug];
        return next;
      });
      Alert.alert('Download Complete', `${model.name} is ready to use.`);
    } catch (error) {
      setDownloadProgress(prev => {
        const next = { ...prev };
        delete next[model.slug];
        return next;
      });
      Alert.alert(
        'Download Failed',
        error instanceof Error ? error.message : 'Unknown error',
      );
    }
  };

  const handleDeleteModel = (model: LiquidModel) => {
    Alert.alert('Delete Model', `Delete ${model.name} from device?`, [
      { text: 'Cancel', style: 'cancel' },
      {
        text: 'Delete',
        style: 'destructive',
        onPress: async () => {
          const filePath = `${RNFS.DocumentDirectoryPath}/models/${model.slug}.gguf`;
          try {
            await RNFS.unlink(filePath);
            setDownloadedModels(prev => {
              const next = new Set(prev);
              next.delete(model.slug);
              return next;
            });
          } catch {
            // File may already be gone
          }
        },
      },
    ]);
  };

  const handleHFSearch = async () => {
    const query = hfSearchQuery.trim();
    if (!query) return;

    setHfSearching(true);
    try {
      const response = await fetch(
        `https://huggingface.co/api/models?search=${encodeURIComponent(query)}&filter=gguf&limit=20`,
      );
      if (response.ok) {
        const data = await response.json();
        setHfResults(data);
      } else {
        setHfResults([]);
      }
    } catch {
      Alert.alert('Search Error', 'Failed to search HuggingFace Hub.');
      setHfResults([]);
    } finally {
      setHfSearching(false);
    }
  };

  const handleDownloadHFModel = (repoId: string) => {
    Alert.alert(
      'Download from Hub',
      `Download model from ${repoId}? This may take a while depending on model size.`,
      [
        { text: 'Cancel', style: 'cancel' },
        {
          text: 'Download',
          onPress: async () => {
            const customModel: LiquidModel = {
              name: repoId.split('/').pop() || repoId,
              slug: repoId.replace('/', '_'),
              category: 'custom',
              sizeMb: 0,
              description: `Custom model from ${repoId}`,
              supportsCompletion: true,
              supportsToolCalling: false,
              supportsVision: false,
              supportsAudio: false,
              isCustom: true,
              hfRepo: repoId,
            };
            handleDownloadModel(customModel);
          },
        },
      ],
    );
  };

  const renderTabs = () => (
    <View style={styles.tabContainer}>
      <TouchableOpacity
        style={[styles.tab, activeTab === 'local' && styles.activeTab]}
        onPress={() => setActiveTab('local')}
      >
        <Text
          style={[
            styles.tabText,
            activeTab === 'local' && styles.activeTabText,
          ]}
        >
          Local Models
        </Text>
      </TouchableOpacity>
      <TouchableOpacity
        style={[styles.tab, activeTab === 'hub' && styles.activeTab]}
        onPress={() => setActiveTab('hub')}
      >
        <Text
          style={[
            styles.tabText,
            activeTab === 'hub' && styles.activeTabText,
          ]}
        >
          HuggingFace Hub
        </Text>
      </TouchableOpacity>
    </View>
  );

  const renderCategories = () => (
    <ScrollView
      horizontal
      showsHorizontalScrollIndicator={false}
      style={styles.categoryScroll}
      contentContainerStyle={styles.categoryContent}
    >
      {CATEGORIES.map(cat => (
        <TouchableOpacity
          key={cat.key}
          style={[
            styles.categoryChip,
            activeCategory === cat.key && styles.activeCategoryChip,
          ]}
          onPress={() => setActiveCategory(cat.key)}
        >
          <Text
            style={[
              styles.categoryText,
              activeCategory === cat.key && styles.activeCategoryText,
            ]}
          >
            {cat.label}
          </Text>
        </TouchableOpacity>
      ))}
    </ScrollView>
  );

  const renderLocalModels = () => {
    const models = getFilteredModels();
    return (
      <ScrollView style={styles.modelList} contentContainerStyle={styles.modelListContent}>
        <TextInput
          style={styles.searchInput}
          value={searchQuery}
          onChangeText={setSearchQuery}
          placeholder="Search models..."
          placeholderTextColor={theme.colors.textMuted}
        />
        {renderCategories()}
        {models.length === 0 ? (
          <View style={styles.emptyState}>
            <Text style={styles.emptyText}>No models found</Text>
          </View>
        ) : (
          models.map(model => (
            <ModelCard
              key={model.slug}
              model={model}
              isSelected={model.slug === currentModel}
              isDownloaded={downloadedModels.has(model.slug)}
              downloadProgress={downloadProgress[model.slug]}
              onSelect={() => handleSelectModel(model)}
              onDownload={() => handleDownloadModel(model)}
              onDelete={() => handleDeleteModel(model)}
            />
          ))
        )}
      </ScrollView>
    );
  };

  const renderHubSearch = () => (
    <ScrollView style={styles.modelList} contentContainerStyle={styles.modelListContent}>
      <View style={styles.hfSearchRow}>
        <TextInput
          style={[styles.searchInput, styles.hfSearchInput]}
          value={hfSearchQuery}
          onChangeText={setHfSearchQuery}
          placeholder="Search GGUF models on HuggingFace..."
          placeholderTextColor={theme.colors.textMuted}
          onSubmitEditing={handleHFSearch}
          returnKeyType="search"
        />
        <TouchableOpacity
          style={styles.hfSearchButton}
          onPress={handleHFSearch}
          disabled={hfSearching}
        >
          {hfSearching ? (
            <ActivityIndicator size="small" color={theme.colors.text} />
          ) : (
            <Text style={styles.hfSearchButtonText}>Search</Text>
          )}
        </TouchableOpacity>
      </View>

      {hfResults.length === 0 && !hfSearching && (
        <View style={styles.emptyState}>
          <Text style={styles.emptyText}>
            Search for GGUF models on HuggingFace Hub
          </Text>
          <Text style={styles.emptySubtext}>
            Results will show compatible quantized models
          </Text>
        </View>
      )}

      {hfResults.map((item: any) => (
        <TouchableOpacity
          key={item.id || item.modelId}
          style={styles.hfResultItem}
          onPress={() => handleDownloadHFModel(item.id || item.modelId)}
        >
          <Text style={styles.hfResultName}>{item.id || item.modelId}</Text>
          {item.downloads !== undefined && (
            <Text style={styles.hfResultMeta}>
              Downloads: {item.downloads?.toLocaleString() || '0'}
            </Text>
          )}
          {item.tags && (
            <View style={styles.hfTagRow}>
              {item.tags.slice(0, 5).map((tag: string) => (
                <View key={tag} style={styles.hfTag}>
                  <Text style={styles.hfTagText}>{tag}</Text>
                </View>
              ))}
            </View>
          )}
        </TouchableOpacity>
      ))}
    </ScrollView>
  );

  return (
    <SafeAreaView style={styles.container}>
      <View style={styles.header}>
        <TouchableOpacity onPress={onBack} style={styles.backButton}>
          <Text style={styles.backButtonText}>Back</Text>
        </TouchableOpacity>
        <Text style={styles.headerTitle}>Models</Text>
        <View style={styles.headerSpacer} />
      </View>
      {renderTabs()}
      {activeTab === 'local' ? renderLocalModels() : renderHubSearch()}
    </SafeAreaView>
  );
}

const styles = StyleSheet.create({
  container: {
    flex: 1,
    backgroundColor: theme.colors.background,
  },
  header: {
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'space-between',
    paddingHorizontal: theme.spacing.lg,
    paddingVertical: theme.spacing.md,
    backgroundColor: theme.colors.primary,
    borderBottomWidth: 1,
    borderBottomColor: theme.colors.border,
  },
  backButton: {
    paddingRight: theme.spacing.md,
  },
  backButtonText: {
    color: theme.colors.skyBlue,
    fontSize: theme.fontSize.md,
    fontWeight: '600',
  },
  headerTitle: {
    fontSize: theme.fontSize.xl,
    fontWeight: '700',
    color: theme.colors.textLight,
  },
  headerSpacer: {
    width: 50,
  },
  tabContainer: {
    flexDirection: 'row',
    backgroundColor: theme.colors.surface,
    borderBottomWidth: 1,
    borderBottomColor: theme.colors.border,
  },
  tab: {
    flex: 1,
    paddingVertical: theme.spacing.md,
    alignItems: 'center',
  },
  activeTab: {
    borderBottomWidth: 2,
    borderBottomColor: theme.colors.accent,
  },
  tabText: {
    fontSize: theme.fontSize.md,
    color: theme.colors.textSecondary,
    fontWeight: '600',
  },
  activeTabText: {
    color: theme.colors.accent,
  },
  categoryScroll: {
    maxHeight: 48,
    marginBottom: theme.spacing.sm,
  },
  categoryContent: {
    paddingHorizontal: theme.spacing.sm,
    gap: theme.spacing.sm,
  },
  categoryChip: {
    paddingHorizontal: theme.spacing.lg,
    paddingVertical: theme.spacing.sm,
    borderRadius: theme.borderRadius.full,
    backgroundColor: theme.colors.surfaceLight,
    borderWidth: 1,
    borderColor: theme.colors.border,
  },
  activeCategoryChip: {
    backgroundColor: theme.colors.secondary,
    borderColor: theme.colors.secondary,
  },
  categoryText: {
    fontSize: theme.fontSize.sm,
    color: theme.colors.textSecondary,
    fontWeight: '600',
  },
  activeCategoryText: {
    color: theme.colors.text,
  },
  modelList: {
    flex: 1,
  },
  modelListContent: {
    padding: theme.spacing.lg,
  },
  searchInput: {
    backgroundColor: theme.colors.inputBg,
    borderRadius: theme.borderRadius.md,
    paddingHorizontal: theme.spacing.lg,
    paddingVertical: theme.spacing.md,
    color: theme.colors.text,
    fontSize: theme.fontSize.md,
    marginBottom: theme.spacing.md,
    borderWidth: 1,
    borderColor: theme.colors.border,
  },
  emptyState: {
    alignItems: 'center',
    paddingTop: 60,
  },
  emptyText: {
    fontSize: theme.fontSize.lg,
    color: theme.colors.textSecondary,
    marginBottom: theme.spacing.sm,
  },
  emptySubtext: {
    fontSize: theme.fontSize.sm,
    color: theme.colors.textMuted,
  },
  hfSearchRow: {
    flexDirection: 'row',
    marginBottom: theme.spacing.md,
    gap: theme.spacing.sm,
  },
  hfSearchInput: {
    flex: 1,
    marginBottom: 0,
  },
  hfSearchButton: {
    backgroundColor: theme.colors.secondary,
    borderRadius: theme.borderRadius.md,
    paddingHorizontal: theme.spacing.xl,
    justifyContent: 'center',
    alignItems: 'center',
  },
  hfSearchButtonText: {
    color: theme.colors.textLight,
    fontSize: theme.fontSize.md,
    fontWeight: '700',
  },
  hfResultItem: {
    backgroundColor: theme.colors.surface,
    borderRadius: theme.borderRadius.md,
    padding: theme.spacing.lg,
    marginBottom: theme.spacing.sm,
    borderWidth: 1,
    borderColor: theme.colors.border,
  },
  hfResultName: {
    fontSize: theme.fontSize.md,
    fontWeight: '600',
    color: theme.colors.text,
    marginBottom: theme.spacing.xs,
  },
  hfResultMeta: {
    fontSize: theme.fontSize.sm,
    color: theme.colors.textSecondary,
    marginBottom: theme.spacing.sm,
  },
  hfTagRow: {
    flexDirection: 'row',
    flexWrap: 'wrap',
    gap: theme.spacing.xs,
  },
  hfTag: {
    backgroundColor: theme.colors.surfaceLight,
    borderRadius: theme.borderRadius.sm,
    paddingHorizontal: theme.spacing.sm,
    paddingVertical: 2,
  },
  hfTagText: {
    fontSize: theme.fontSize.xs,
    color: theme.colors.textMuted,
  },
});
