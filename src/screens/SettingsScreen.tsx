import React, { useEffect, useState, useCallback } from 'react';
import {
  View,
  Text,
  Image,
  TextInput,
  TouchableOpacity,
  ScrollView,
  StyleSheet,
  Switch,
  Alert,
  ActivityIndicator,
} from 'react-native';
import { SafeAreaView } from 'react-native-safe-area-context';
import { storage } from '../utils/storage';
import { validateHFToken, pushDatasetToHub } from '../services/huggingfaceApi';
import { exportForFineTuning } from '../services/chatExport';
import { memoryService } from '../services/MemoryService';
import { getDefaultSystemPrompt } from '../tools/registry';
import { theme } from '../config/theme';
import type { ChatSettings } from '../types';
import { DEFAULT_SETTINGS } from '../types';

interface SettingsScreenProps {
  onOpenModelSelector: (
    currentModel: string,
    onSelect: (model: string) => void,
  ) => void;
}

export default function SettingsScreen({
  onOpenModelSelector,
}: SettingsScreenProps) {
  const [settings, setSettings] = useState<ChatSettings>(DEFAULT_SETTINGS);
  const [hfUsername, setHfUsername] = useState<string | null>(null);
  const [hfValidating, setHfValidating] = useState(false);
  const [hfPushing, setHfPushing] = useState(false);
  const [memoryStats, setMemoryStats] = useState({ memoryCount: 0, documentCount: 0, documentFiles: [] as string[] });
  const [docPath, setDocPath] = useState('');
  const [isImporting, setIsImporting] = useState(false);

  useEffect(() => {
    loadSettings();
    refreshMemoryStats();
  }, []);

  const loadSettings = async () => {
    const saved = await storage.getSettings();
    if (saved) {
      // Auto-populate system prompt with default if empty
      if (!saved.systemPrompt) {
        saved.systemPrompt = getDefaultSystemPrompt();
      }
      setSettings(saved);
    } else {
      // First launch - populate default system prompt
      const defaults = { ...DEFAULT_SETTINGS, systemPrompt: getDefaultSystemPrompt() };
      setSettings(defaults);
    }
  };

  const updateSetting = useCallback(
    <K extends keyof ChatSettings>(key: K, value: ChatSettings[K]) => {
      setSettings(prev => {
        const updated = { ...prev, [key]: value };
        storage.saveSettings(updated); // fire-and-forget async
        return updated;
      });
    },
    [],
  );

  const handleSelectModel = () => {
    onOpenModelSelector(settings.model, (newModel: string) => {
      updateSetting('model', newModel);
    });
  };

  const handleValidateToken = async () => {
    const token = settings.hfToken.trim();
    if (!token) {
      Alert.alert('Error', 'Please enter a HuggingFace token.');
      return;
    }

    setHfValidating(true);
    try {
      const result = await validateHFToken(token);
      if (result.valid) {
        setHfUsername(result.username || null);
        Alert.alert(
          'Token Valid',
          `Authenticated as ${result.username}`,
        );
      } else {
        setHfUsername(null);
        Alert.alert('Token Invalid', result.error || 'Could not validate token.');
      }
    } catch {
      Alert.alert('Error', 'Network error while validating token.');
    } finally {
      setHfValidating(false);
    }
  };

  const handlePushToHub = async () => {
    const token = settings.hfToken.trim();
    if (!token) {
      Alert.alert('Error', 'Please enter and validate your HuggingFace token first.');
      return;
    }

    const chats = await storage.getAllChats();
    if (chats.length === 0) {
      Alert.alert('No Data', 'No chat history to export.');
      return;
    }

    Alert.alert(
      'Push to Hub',
      `Export ${chats.length} chat(s) to HuggingFace Hub?`,
      [
        { text: 'Cancel', style: 'cancel' },
        {
          text: 'Push',
          onPress: async () => {
            setHfPushing(true);
            try {
              const jsonl = exportForFineTuning(chats);
              if (!jsonl.trim()) {
                Alert.alert('No Data', 'No chats with enough messages to export.');
                return;
              }

              const result = await pushDatasetToHub(token, jsonl, {
                isPrivate: settings.hfPrivateDataset,
              });

              if (result.success) {
                Alert.alert(
                  'Push Successful',
                  `Dataset uploaded to:\n${result.url}`,
                );
              } else {
                Alert.alert('Push Failed', result.error || 'Unknown error.');
              }
            } catch (error) {
              Alert.alert(
                'Error',
                error instanceof Error
                  ? error.message
                  : 'Failed to push to Hub.',
              );
            } finally {
              setHfPushing(false);
            }
          },
        },
      ],
    );
  };

  const refreshMemoryStats = () => {
    try {
      const stats = memoryService.getStats();
      setMemoryStats(stats);
    } catch {
      // Service may not be initialized yet
    }
  };

  const handleClearMemory = () => {
    Alert.alert(
      'Clear Memory',
      'Delete all stored memories? This cannot be undone.',
      [
        { text: 'Cancel', style: 'cancel' },
        {
          text: 'Clear',
          style: 'destructive',
          onPress: async () => {
            await memoryService.clearMemory();
            refreshMemoryStats();
            Alert.alert('Done', 'All memories cleared.');
          },
        },
      ],
    );
  };

  const handleClearDocuments = () => {
    Alert.alert(
      'Clear Documents',
      'Delete all imported documents? This cannot be undone.',
      [
        { text: 'Cancel', style: 'cancel' },
        {
          text: 'Clear',
          style: 'destructive',
          onPress: async () => {
            await memoryService.clearDocuments();
            refreshMemoryStats();
            Alert.alert('Done', 'All documents cleared.');
          },
        },
      ],
    );
  };

  const handleImportDocument = async () => {
    const path = docPath.trim();
    if (!path) {
      Alert.alert('Error', 'Please enter a file path.');
      return;
    }

    setIsImporting(true);
    try {
      const chunkCount = await memoryService.addDocument(path);
      refreshMemoryStats();
      setDocPath('');
      Alert.alert('Import Successful', `Added ${chunkCount} chunks from document.`);
    } catch (e) {
      Alert.alert('Import Failed', e instanceof Error ? e.message : 'Could not import document.');
    } finally {
      setIsImporting(false);
    }
  };

  const handleResetSettings = () => {
    Alert.alert(
      'Reset Settings',
      'Reset all settings to default values?',
      [
        { text: 'Cancel', style: 'cancel' },
        {
          text: 'Reset',
          style: 'destructive',
          onPress: async () => {
            setSettings(DEFAULT_SETTINGS);
            await storage.saveSettings(DEFAULT_SETTINGS);
            setHfUsername(null);
          },
        },
      ],
    );
  };

  const renderSection = (title: string, children: React.ReactNode) => (
    <View style={styles.section}>
      <Text style={styles.sectionTitle}>{title}</Text>
      <View style={styles.sectionContent}>{children}</View>
    </View>
  );

  const renderSlider = (
    label: string,
    value: number,
    min: number,
    max: number,
    step: number,
    key: keyof ChatSettings,
  ) => (
    <View style={styles.settingRow}>
      <View style={styles.settingLabelRow}>
        <Text style={styles.settingLabel}>{label}</Text>
        <Text style={styles.settingValue}>{value.toFixed(step < 1 ? 1 : 0)}</Text>
      </View>
      <View style={styles.sliderRow}>
        <TouchableOpacity
          style={styles.sliderButton}
          onPress={() => {
            const newVal = Math.max(min, value - step);
            updateSetting(key, newVal as any);
          }}
        >
          <Text style={styles.sliderButtonText}>-</Text>
        </TouchableOpacity>
        <View style={styles.sliderTrack}>
          <View
            style={[
              styles.sliderFill,
              { width: `${((value - min) / (max - min)) * 100}%` },
            ]}
          />
        </View>
        <TouchableOpacity
          style={styles.sliderButton}
          onPress={() => {
            const newVal = Math.min(max, value + step);
            updateSetting(key, newVal as any);
          }}
        >
          <Text style={styles.sliderButtonText}>+</Text>
        </TouchableOpacity>
      </View>
    </View>
  );

  const renderToggle = (
    label: string,
    value: boolean,
    key: keyof ChatSettings,
    description?: string,
  ) => (
    <View style={styles.toggleRow}>
      <View style={styles.toggleLabel}>
        <Text style={styles.settingLabel}>{label}</Text>
        {description && (
          <Text style={styles.settingDescription}>{description}</Text>
        )}
      </View>
      <Switch
        value={value}
        onValueChange={(val: boolean) => updateSetting(key, val as any)}
        trackColor={{
          false: theme.colors.surfaceLight,
          true: theme.colors.secondary,
        }}
        thumbColor={theme.colors.text}
      />
    </View>
  );

  return (
    <SafeAreaView style={styles.container}>
      <View style={styles.header}>
        <Text style={styles.headerTitle}>Settings</Text>
        <TouchableOpacity onPress={handleResetSettings}>
          <Text style={styles.resetButton}>Reset</Text>
        </TouchableOpacity>
      </View>

      <ScrollView
        style={styles.scrollView}
        contentContainerStyle={styles.scrollContent}
      >
        {renderSection('Model', (
          <TouchableOpacity
            style={styles.modelSelector}
            onPress={handleSelectModel}
          >
            <Text style={styles.modelSelectorLabel}>Current Model</Text>
            <Text style={styles.modelSelectorValue}>{settings.model}</Text>
          </TouchableOpacity>
        ))}

        {renderSection('Generation Parameters', (
          <>
            {renderSlider('Temperature', settings.temperature, 0.0, 2.0, 0.1, 'temperature')}
            {renderSlider('Top P', settings.topP, 0.0, 1.0, 0.1, 'topP')}
            {renderSlider('Top K', settings.topK, 1, 100, 1, 'topK')}
            {renderSlider('Max Tokens', settings.maxTokens, 64, 4096, 64, 'maxTokens')}
          </>
        ))}

        {renderSection('System Prompt', (
          <>
            <TextInput
              style={styles.systemPromptInput}
              value={settings.systemPrompt}
              onChangeText={text => updateSetting('systemPrompt', text)}
              placeholder="System prompt with tool definitions..."
              placeholderTextColor={theme.colors.textMuted}
              multiline
              numberOfLines={6}
              textAlignVertical="top"
            />
            <TouchableOpacity
              style={styles.resetPromptButton}
              onPress={() => updateSetting('systemPrompt', getDefaultSystemPrompt())}
            >
              <Text style={styles.resetPromptText}>Reset to Default</Text>
            </TouchableOpacity>
          </>
        ))}

        {renderSection('Tools', (
          <>
            {renderToggle(
              'Auto-Execute Tools',
              settings.autoExecuteTools,
              'autoExecuteTools',
              'Automatically run tool calls from the model',
            )}
          </>
        ))}

        {renderSection('Interaction', (
          <>
            {renderToggle(
              'Haptic Feedback',
              settings.enableHaptics,
              'enableHaptics',
              'Vibration on send and tool execution',
            )}
            {renderToggle(
              'Auto Text-to-Speech',
              settings.autoTTS,
              'autoTTS',
              'Speak assistant responses aloud',
            )}
            {settings.autoTTS && (
              <>
                {renderSlider('TTS Rate', settings.ttsRate, 0.5, 2.0, 0.1, 'ttsRate')}
                <View style={styles.settingRow}>
                  <Text style={styles.settingLabel}>TTS Voice</Text>
                  <TextInput
                    style={styles.inlineInput}
                    value={settings.ttsVoice}
                    onChangeText={text => updateSetting('ttsVoice', text)}
                    placeholder="en-US-language"
                    placeholderTextColor={theme.colors.textMuted}
                  />
                </View>
              </>
            )}
          </>
        ))}

        {renderSection('Voice Input', (
          <>
            {renderToggle(
              'Enable Voice Input',
              settings.voiceInputEnabled,
              'voiceInputEnabled',
              'Show microphone button in chat',
            )}
            {settings.voiceInputEnabled && (
              <>
                <View style={styles.settingRow}>
                  <Text style={styles.settingLabel}>STT Model</Text>
                  <View style={styles.sttModelRow}>
                    <TouchableOpacity
                      style={[
                        styles.sttModelOption,
                        settings.sttModel === 'whisper-small' && styles.sttModelOptionActive,
                      ]}
                      onPress={() => updateSetting('sttModel', 'whisper-small')}
                    >
                      <Text
                        style={[
                          styles.sttModelOptionText,
                          settings.sttModel === 'whisper-small' && styles.sttModelOptionTextActive,
                        ]}
                      >
                        Small (244 MB)
                      </Text>
                    </TouchableOpacity>
                    <TouchableOpacity
                      style={[
                        styles.sttModelOption,
                        settings.sttModel === 'whisper-medium' && styles.sttModelOptionActive,
                      ]}
                      onPress={() => updateSetting('sttModel', 'whisper-medium')}
                    >
                      <Text
                        style={[
                          styles.sttModelOptionText,
                          settings.sttModel === 'whisper-medium' && styles.sttModelOptionTextActive,
                        ]}
                      >
                        Medium (769 MB)
                      </Text>
                    </TouchableOpacity>
                  </View>
                </View>
                {renderToggle(
                  'Auto-Send After Transcription',
                  settings.autoSendVoice,
                  'autoSendVoice',
                  'Send message immediately after voice transcription',
                )}
              </>
            )}
          </>
        ))}

        {renderSection('Memory', (
          <>
            {renderToggle(
              'Enable Memory',
              settings.memoryEnabled,
              'memoryEnabled',
              'Semantic memory across chat sessions',
            )}
            {settings.memoryEnabled && (
              <>
                {renderToggle(
                  'Auto-Remember',
                  settings.autoRemember,
                  'autoRemember',
                  'Automatically store interactions',
                )}
                <View style={styles.settingRow}>
                  <Text style={styles.settingLabel}>Memory Stats</Text>
                  <Text style={styles.memoryStatsText}>
                    {memoryStats.memoryCount} memories, {memoryStats.documentCount} doc chunks
                    {memoryStats.documentFiles.length > 0 && (
                      ` (${memoryStats.documentFiles.join(', ')})`
                    )}
                  </Text>
                </View>
                <TouchableOpacity
                  style={styles.memoryActionButton}
                  onPress={handleClearMemory}
                >
                  <Text style={styles.memoryActionText}>Clear Memory</Text>
                </TouchableOpacity>
                <View style={styles.settingRow}>
                  <Text style={styles.settingLabel}>Import Document (.txt)</Text>
                  <TextInput
                    style={styles.inlineInput}
                    value={docPath}
                    onChangeText={setDocPath}
                    placeholder="/path/to/document.txt"
                    placeholderTextColor={theme.colors.textMuted}
                    autoCapitalize="none"
                    autoCorrect={false}
                  />
                </View>
                <View style={styles.memoryButtonRow}>
                  <TouchableOpacity
                    style={[styles.memoryActionButton, isImporting && styles.pushButtonDisabled]}
                    onPress={handleImportDocument}
                    disabled={isImporting}
                  >
                    {isImporting ? (
                      <ActivityIndicator size="small" color={theme.colors.text} />
                    ) : (
                      <Text style={styles.memoryActionText}>Import</Text>
                    )}
                  </TouchableOpacity>
                  <TouchableOpacity
                    style={styles.memoryActionButton}
                    onPress={handleClearDocuments}
                  >
                    <Text style={styles.memoryActionText}>Clear Documents</Text>
                  </TouchableOpacity>
                </View>
              </>
            )}
          </>
        ))}

        {renderSection('HuggingFace Hub', (
          <>
            <View style={styles.settingRow}>
              <Text style={styles.settingLabel}>API Token</Text>
              <TextInput
                style={styles.tokenInput}
                value={settings.hfToken}
                onChangeText={text => updateSetting('hfToken', text)}
                placeholder="hf_..."
                placeholderTextColor={theme.colors.textMuted}
                secureTextEntry
                autoCapitalize="none"
                autoCorrect={false}
              />
            </View>

            <View style={styles.hfButtonRow}>
              <TouchableOpacity
                style={styles.hfButton}
                onPress={handleValidateToken}
                disabled={hfValidating}
              >
                {hfValidating ? (
                  <ActivityIndicator size="small" color={theme.colors.text} />
                ) : (
                  <Text style={styles.hfButtonText}>Validate Token</Text>
                )}
              </TouchableOpacity>

              {hfUsername && (
                <Text style={styles.hfUsername}>
                  Authenticated: {hfUsername}
                </Text>
              )}
            </View>

            {renderToggle(
              'Private Dataset',
              settings.hfPrivateDataset,
              'hfPrivateDataset',
              'Make uploaded dataset private',
            )}

            <TouchableOpacity
              style={[
                styles.pushButton,
                (!settings.hfToken || hfPushing) && styles.pushButtonDisabled,
              ]}
              onPress={handlePushToHub}
              disabled={!settings.hfToken || hfPushing}
            >
              {hfPushing ? (
                <ActivityIndicator size="small" color={theme.colors.text} />
              ) : (
                <Text style={styles.pushButtonText}>
                  Push Chat History to Hub
                </Text>
              )}
            </TouchableOpacity>
          </>
        ))}

        <View style={styles.footer}>
          <Image
            source={require('../assets/liquidchat_logo.png')}
            style={styles.footerLogo}
          />
          <Text style={styles.footerBranding}>🌵💧</Text>
          <Text style={styles.footerAppName}>LiquidChat</Text>
          <Text style={styles.footerText}>Powered by Liquid AI</Text>
          <Text style={styles.footerDeveloper}>
            Developed by Kshitij Thakkar
          </Text>
        </View>
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
    flexDirection: 'row',
    justifyContent: 'space-between',
    alignItems: 'center',
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
  resetButton: {
    color: '#FFAAAA',
    fontSize: theme.fontSize.md,
    fontWeight: '600',
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
  modelSelector: {
    paddingVertical: theme.spacing.sm,
  },
  modelSelectorLabel: {
    fontSize: theme.fontSize.sm,
    color: theme.colors.textSecondary,
    marginBottom: theme.spacing.xs,
  },
  modelSelectorValue: {
    fontSize: theme.fontSize.lg,
    fontWeight: '600',
    color: theme.colors.text,
  },
  settingRow: {
    marginBottom: theme.spacing.lg,
  },
  settingLabelRow: {
    flexDirection: 'row',
    justifyContent: 'space-between',
    alignItems: 'center',
    marginBottom: theme.spacing.sm,
  },
  settingLabel: {
    fontSize: theme.fontSize.md,
    color: theme.colors.text,
    fontWeight: '500',
  },
  settingValue: {
    fontSize: theme.fontSize.md,
    color: theme.colors.accent,
    fontWeight: '600',
  },
  settingDescription: {
    fontSize: theme.fontSize.sm,
    color: theme.colors.textMuted,
    marginTop: 2,
  },
  sliderRow: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: theme.spacing.sm,
  },
  sliderButton: {
    width: 36,
    height: 36,
    borderRadius: theme.borderRadius.sm,
    backgroundColor: theme.colors.surfaceLight,
    justifyContent: 'center',
    alignItems: 'center',
  },
  sliderButtonText: {
    color: theme.colors.text,
    fontSize: theme.fontSize.xl,
    fontWeight: '700',
  },
  sliderTrack: {
    flex: 1,
    height: 6,
    backgroundColor: theme.colors.surfaceLight,
    borderRadius: 3,
    overflow: 'hidden',
  },
  sliderFill: {
    height: '100%',
    backgroundColor: theme.colors.secondary,
    borderRadius: 3,
  },
  toggleRow: {
    flexDirection: 'row',
    justifyContent: 'space-between',
    alignItems: 'center',
    paddingVertical: theme.spacing.sm,
    marginBottom: theme.spacing.sm,
  },
  toggleLabel: {
    flex: 1,
    marginRight: theme.spacing.md,
  },
  systemPromptInput: {
    backgroundColor: theme.colors.inputBg,
    borderRadius: theme.borderRadius.sm,
    padding: theme.spacing.md,
    color: theme.colors.text,
    fontSize: theme.fontSize.sm,
    minHeight: 120,
    borderWidth: 1,
    borderColor: theme.colors.border,
  },
  resetPromptButton: {
    marginTop: theme.spacing.sm,
    alignSelf: 'flex-end',
    paddingHorizontal: theme.spacing.lg,
    paddingVertical: theme.spacing.sm,
    backgroundColor: theme.colors.surfaceLight,
    borderRadius: theme.borderRadius.sm,
  },
  resetPromptText: {
    fontSize: theme.fontSize.sm,
    color: theme.colors.accent,
    fontWeight: '600',
  },
  inlineInput: {
    backgroundColor: theme.colors.inputBg,
    borderRadius: theme.borderRadius.sm,
    paddingHorizontal: theme.spacing.md,
    paddingVertical: theme.spacing.sm,
    color: theme.colors.text,
    fontSize: theme.fontSize.md,
    marginTop: theme.spacing.sm,
    borderWidth: 1,
    borderColor: theme.colors.border,
  },
  sttModelRow: {
    flexDirection: 'row',
    gap: theme.spacing.sm,
    marginTop: theme.spacing.sm,
  },
  sttModelOption: {
    flex: 1,
    backgroundColor: theme.colors.surfaceLight,
    borderRadius: theme.borderRadius.sm,
    paddingVertical: theme.spacing.md,
    alignItems: 'center',
    borderWidth: 1,
    borderColor: theme.colors.border,
  },
  sttModelOptionActive: {
    backgroundColor: theme.colors.secondary,
    borderColor: theme.colors.secondary,
  },
  sttModelOptionText: {
    fontSize: theme.fontSize.sm,
    fontWeight: '600',
    color: theme.colors.text,
  },
  sttModelOptionTextActive: {
    color: theme.colors.textLight,
  },
  memoryStatsText: {
    fontSize: theme.fontSize.sm,
    color: theme.colors.textSecondary,
    marginTop: theme.spacing.sm,
  },
  memoryActionButton: {
    backgroundColor: theme.colors.surfaceLight,
    borderRadius: theme.borderRadius.sm,
    paddingHorizontal: theme.spacing.lg,
    paddingVertical: theme.spacing.sm,
    marginBottom: theme.spacing.sm,
    alignSelf: 'flex-start',
  },
  memoryActionText: {
    color: theme.colors.accent,
    fontSize: theme.fontSize.md,
    fontWeight: '600',
  },
  memoryButtonRow: {
    flexDirection: 'row',
    gap: theme.spacing.sm,
  },
  tokenInput: {
    backgroundColor: theme.colors.inputBg,
    borderRadius: theme.borderRadius.sm,
    paddingHorizontal: theme.spacing.md,
    paddingVertical: theme.spacing.sm,
    color: theme.colors.text,
    fontSize: theme.fontSize.md,
    marginTop: theme.spacing.sm,
    borderWidth: 1,
    borderColor: theme.colors.border,
  },
  hfButtonRow: {
    flexDirection: 'row',
    alignItems: 'center',
    marginBottom: theme.spacing.md,
    gap: theme.spacing.md,
  },
  hfButton: {
    backgroundColor: theme.colors.surfaceLight,
    borderRadius: theme.borderRadius.sm,
    paddingHorizontal: theme.spacing.lg,
    paddingVertical: theme.spacing.sm,
  },
  hfButtonText: {
    color: theme.colors.accent,
    fontSize: theme.fontSize.md,
    fontWeight: '600',
  },
  hfUsername: {
    fontSize: theme.fontSize.sm,
    color: theme.colors.success,
    fontWeight: '500',
  },
  pushButton: {
    backgroundColor: theme.colors.secondary,
    borderRadius: theme.borderRadius.md,
    paddingVertical: theme.spacing.md,
    alignItems: 'center',
    marginTop: theme.spacing.sm,
  },
  pushButtonDisabled: {
    opacity: 0.4,
  },
  pushButtonText: {
    color: theme.colors.textLight,
    fontSize: theme.fontSize.md,
    fontWeight: '700',
  },
  footer: {
    alignItems: 'center',
    paddingVertical: theme.spacing.xxl,
    paddingHorizontal: theme.spacing.lg,
    width: '100%',
  },
  footerLogo: {
    width: 72,
    height: 72,
    borderRadius: 16,
    marginBottom: theme.spacing.sm,
  },
  footerBranding: {
    fontSize: 24,
    marginBottom: theme.spacing.sm,
  },
  footerAppName: {
    fontSize: 20,
    fontWeight: '700',
    color: theme.colors.text,
    marginBottom: 6,
    textAlign: 'center',
  },
  footerText: {
    fontSize: 14,
    color: theme.colors.textSecondary,
    textAlign: 'center',
    marginBottom: 4,
  },
  footerDeveloper: {
    fontSize: 14,
    color: theme.colors.textSecondary,
    marginTop: theme.spacing.sm,
    textAlign: 'center',
  },
});
