import React, { useEffect, useState, useRef, useCallback } from 'react';
import {
  View,
  Text,
  Image,
  TextInput,
  TouchableOpacity,
  ScrollView,
  StyleSheet,
  ActivityIndicator,
  Platform,
  KeyboardAvoidingView,
  StatusBar,
  Alert,
} from 'react-native';
import { SafeAreaView } from 'react-native-safe-area-context';
import {
  launchCamera,
  launchImageLibrary,
  type ImagePickerResponse,
} from 'react-native-image-picker';
import { CactusLM, type Message } from 'cactus-react-native';
import { Cactus } from 'cactus-react-native/src/native';
import * as RNFS from '@dr.pogodin/react-native-fs';
import { storage } from '../utils/storage';
import { generateChatTitle } from '../utils/chatHelpers';
import { triggerLightHaptic, triggerMediumHaptic } from '../utils/haptics';
import { speak, stopSpeaking } from '../utils/ttsManager';
import {
  parseToolCalls,
  parseCactusFunctionCalls,
} from '../utils/toolParser';
import {
  executeTool,
  getToolDefinitionsJSON,
  getDefaultSystemPrompt,
} from '../tools/registry';
import { getModelBySlug } from '../config/models';
import MessageBubble from '../components/MessageBubble';
import MetricsBar from '../components/MetricsBar';
import VoiceInputButton from '../components/VoiceInputButton';
import MemoryChips from '../components/MemoryChips';
import ScreenshotPreview from '../components/ScreenshotPreview';
import { useMemory } from '../hooks/useMemory';
import { theme } from '../config/theme';
import type {
  Chat,
  ChatMessage,
  ChatMetrics,
  ChatSettings,
  ToolCall,
  ToolResult,
} from '../types';
import { DEFAULT_SETTINGS } from '../types';

interface ChatScreenProps {
  chatId: string;
  onBack: () => void;
  onOpenModelSelector: (
    currentModel: string,
    onSelect: (model: string) => void,
  ) => void;
}

export default function ChatScreen({
  chatId,
  onBack,
  onOpenModelSelector,
}: ChatScreenProps) {
  const [messages, setMessages] = useState<ChatMessage[]>([]);
  const [inputText, setInputText] = useState('');
  const [isGenerating, setIsGenerating] = useState(false);
  const [isModelLoading, setIsModelLoading] = useState(false);
  const [modelLoaded, setModelLoaded] = useState(false);
  const [settings, setSettings] = useState<ChatSettings | null>(null);
  const [metrics, setMetrics] = useState<ChatMetrics | null>(null);
  const [streamingText, setStreamingText] = useState('');
  const [selectedImage, setSelectedImage] = useState<string | null>(null);
  const [modelDisplayName, setModelDisplayName] = useState('');
  const [loadProgress, setLoadProgress] = useState(0);
  const [liveTokenCount, setLiveTokenCount] = useState(0);
  const [liveTokensPerSecond, setLiveTokensPerSecond] = useState(0);

  const scrollViewRef = useRef<ScrollView>(null);
  const cactusLMRef = useRef<CactusLM | null>(null);
  const nativeCactusRef = useRef<any>(null);
  const isCustomModelRef = useRef(false);
  const abortRef = useRef(false);
  const chatRef = useRef<Chat | null>(null);

  // Memory hook
  const {
    relevantMemories,
    recallForMessage,
    rememberInteraction,
    clearRecalled,
  } = useMemory(
    settings?.memoryEnabled ?? false,
    settings?.embeddingModel,
  );

  // Use the system prompt from settings (pre-populated with training format + tool definitions)
  const buildSystemPrompt = useCallback(
    (settingsPrompt?: string, memoryContext?: string): string => {
      const base = settingsPrompt || getDefaultSystemPrompt();
      return memoryContext ? base + memoryContext : base;
    },
    [],
  );

  // Load chat data
  useEffect(() => {
    loadChat();
    return () => {
      releaseModel();
    };
  }, [chatId]);

  const loadChat = async () => {
    const chat = await storage.getChat(chatId);
    if (chat) {
      chatRef.current = chat;
      setMessages(chat.messages);
      setSettings(chat.settings);
      setModelDisplayName(chat.model);
      initializeModel(chat.settings.model);
    } else {
      const saved = await storage.getSettings();
      const defaultSettings = saved ?? DEFAULT_SETTINGS;
      const newChat: Chat = {
        id: chatId,
        title: 'New Chat',
        messages: [],
        createdAt: Date.now(),
        updatedAt: Date.now(),
        model: defaultSettings.model,
        settings: defaultSettings,
      };
      chatRef.current = newChat;
      setSettings(defaultSettings);
      setModelDisplayName(defaultSettings.model);
      await storage.saveChat(newChat);
      initializeModel(defaultSettings.model);
    }
  };

  const releaseModel = async () => {
    try {
      if (cactusLMRef.current) {
        await cactusLMRef.current.destroy();
        cactusLMRef.current = null;
      }
      if (nativeCactusRef.current) {
        await nativeCactusRef.current.destroy();
        nativeCactusRef.current = null;
      }
    } catch (e) {
      // Ignore destroy errors
    }
    setModelLoaded(false);
  };

  const initializeModel = async (modelSlug: string) => {
    setIsModelLoading(true);
    setLoadProgress(0);
    setModelLoaded(false);
    isCustomModelRef.current = false;

    try {
      await releaseModel();

      console.log(`[LiquidChat] ==================== MODEL INIT START ====================`);
      console.log(`[LiquidChat] initializeModel called with slug: "${modelSlug}"`);

      // Step 1: Check if model is in CactusLM registry (may fail if offline)
      let modelInfo: any = null;
      try {
        const tempCactusLM = new CactusLM();
        const models = await tempCactusLM.getModels();
        console.log(`[LiquidChat] Available registry models:`, models.map((m: any) => ({ name: m.name, slug: m.slug })));
        modelInfo = models.find((m: any) => m.slug === modelSlug) || null;
        console.log(`[LiquidChat] Model "${modelSlug}" in registry:`, modelInfo ? 'YES' : 'NO');
        await tempCactusLM.destroy();
      } catch (registryErr) {
        console.log(`[LiquidChat] Registry check failed (offline?): ${registryErr}`);
        console.log(`[LiquidChat] Falling through to local model detection...`);
      }

      if (modelInfo) {
        // Step 2a: Registry model - use standard CactusLM flow
        console.log(`[LiquidChat] Using registry model: "${modelSlug}"`);
        const cactusLM = new CactusLM({ model: modelSlug });
        cactusLMRef.current = cactusLM;

        console.log('[LiquidChat] Starting download (or verifying model exists)...');
        await cactusLM.download({
          onProgress: (progress: number) => {
            console.log(`[LiquidChat] Download progress: ${(progress * 100).toFixed(1)}%`);
            setLoadProgress(Math.round(progress * 100));
          },
        });
        console.log('[LiquidChat] Download completed/verified');

        console.log('[LiquidChat] Calling cactusLM.init()...');
        try {
          await cactusLM.init();
          setModelLoaded(true);
          setModelDisplayName(getModelBySlug(modelSlug)?.name || modelSlug);
        } catch (initErr) {
          // CactusLM.init() failed (likely device registration issue)
          // Fall back to native Cactus with the already-downloaded model files
          console.log(`[LiquidChat] CactusLM init failed: ${initErr}`);
          console.log('[LiquidChat] Falling back to native Cactus for registry model...');
          cactusLMRef.current = null;

          // Get the model path from CactusFileSystem
          const { CactusFileSystem } = require('cactus-react-native/src/native');
          const modelPath = await CactusFileSystem.getModelPath(modelSlug);
          console.log(`[LiquidChat] Native model path: ${modelPath}`);

          const nativeCactus = new Cactus();
          await nativeCactus.init(modelPath, 2048);
          nativeCactusRef.current = nativeCactus;
          isCustomModelRef.current = true;
          setModelLoaded(true);
          setModelDisplayName(getModelBySlug(modelSlug)?.name || modelSlug);
          console.log('[LiquidChat] Native Cactus fallback succeeded!');
        }
      } else {
        // Step 2b: Not in registry - check for local model files
        console.log(`[LiquidChat] Model not in registry, checking for local models...`);

        if (!RNFS || !RNFS.DocumentDirectoryPath) {
          throw new Error('File system not available');
        }

        // Search both the user models dir and the CactusLM SDK models dir
        const userModelsDir = `${RNFS.DocumentDirectoryPath}/models`;
        const cactusModelsDir = `${RNFS.DocumentDirectoryPath}/cactus/models`;

        if (!(await RNFS.exists(userModelsDir))) {
          await RNFS.mkdir(userModelsDir);
        }

        let files: any[] = [];
        try {
          files = [...(await RNFS.readDir(userModelsDir))];
        } catch {}
        try {
          if (await RNFS.exists(cactusModelsDir)) {
            files = [...files, ...(await RNFS.readDir(cactusModelsDir))];
          }
        } catch {}

        console.log(`[LiquidChat] All model entries found:`, files.map((f: any) => f.name));

        // Check for Cactus v1.x weight folders (directories with config.txt)
        const cactusWeightDirs: any[] = [];
        for (const f of files) {
          if (f.isDirectory()) {
            const hasConfig = await RNFS.exists(`${f.path}/config.txt`);
            if (hasConfig) {
              cactusWeightDirs.push(f);
            }
          }
        }
        console.log(`[LiquidChat] Found ${cactusWeightDirs.length} Cactus weight folders:`, cactusWeightDirs.map((f: any) => f.name));

        const ggufFiles = files.filter((f: any) => f.name.endsWith('.gguf'));
        console.log(`[LiquidChat] Found ${ggufFiles.length} GGUF files:`, ggufFiles.map((f: any) => f.name));

        let modelPath: string;
        let modelName: string;

        // Try Cactus weight folders first, then GGUF
        let matchedDir = cactusWeightDirs.find((f: any) => f.name === modelSlug);
        if (!matchedDir) {
          matchedDir = cactusWeightDirs.find((f: any) =>
            f.name.toLowerCase().includes(modelSlug.toLowerCase()),
          );
        }

        if (matchedDir) {
          modelPath = matchedDir.path;
          modelName = matchedDir.name;
          console.log(`[LiquidChat] Using Cactus weight folder: ${matchedDir.name}`);
        } else if (cactusWeightDirs.length > 0) {
          modelPath = cactusWeightDirs[0].path;
          modelName = cactusWeightDirs[0].name;
          console.log(`[LiquidChat] No slug match, using first Cactus weight folder: ${modelName}`);
        } else if (ggufFiles.length > 0) {
          let matchedFile = ggufFiles.find((f: any) => f.name === `${modelSlug}.gguf`);
          if (!matchedFile) {
            matchedFile = ggufFiles.find((f: any) =>
              f.name.toLowerCase().includes(modelSlug.toLowerCase()),
            );
          }
          if (matchedFile) {
            modelPath = matchedFile.path;
            modelName = matchedFile.name.replace('.gguf', '');
          } else {
            modelPath = ggufFiles[0].path;
            modelName = ggufFiles[0].name.replace('.gguf', '');
          }
          console.log(`[LiquidChat] Using GGUF file: ${modelName}`);
        } else {
          throw new Error(
            `No model files found for "${modelSlug}". Push model weights to the device or select a registry model.`,
          );
        }

        // Update chat to reflect the actually loaded model
        if (chatRef.current && chatRef.current.model !== modelName) {
          chatRef.current.model = modelName;
          await storage.saveChat(chatRef.current);
          console.log(`[LiquidChat] Updated chat model to: ${modelName}`);
        }

        // Initialize with native Cactus
        console.log(`[LiquidChat] Initializing native Cactus with path: ${modelPath}`);
        const nativeCactus = new Cactus();
        await nativeCactus.init(modelPath, 2048);
        nativeCactusRef.current = nativeCactus;
        isCustomModelRef.current = true;
        setModelLoaded(true);
        setModelDisplayName(modelName);
        console.log(`[LiquidChat] Native Cactus initialized successfully`);
      }

      console.log('[LiquidChat] ==================== MODEL INIT SUCCESS ====================');
    } catch (error) {
      const errMsg =
        error instanceof Error ? error.message : String(error);
      console.error('[LiquidChat] ==================== MODEL INIT FAILED ====================');
      console.error('[LiquidChat] Error:', errMsg);
      Alert.alert(
        'Model Error',
        `Failed to load model "${modelSlug}":\n\n${errMsg}\n\nTry selecting a different model from the Models tab.`,
      );

      // Clean up on error
      isCustomModelRef.current = false;
      nativeCactusRef.current = null;
      cactusLMRef.current = null;
    } finally {
      setIsModelLoading(false);
    }
  };

  const saveMessages = useCallback(
    async (updatedMessages: ChatMessage[]) => {
      if (!chatRef.current) return;
      chatRef.current.messages = updatedMessages;
      chatRef.current.updatedAt = Date.now();

      if (
        updatedMessages.length === 2 &&
        chatRef.current.title === 'New Chat'
      ) {
        chatRef.current.title = generateChatTitle(updatedMessages);
      }

      await storage.saveChat(chatRef.current);
    },
    [],
  );

  const scrollToBottom = useCallback(() => {
    setTimeout(() => {
      scrollViewRef.current?.scrollToEnd({ animated: true });
    }, 100);
  }, []);

  const handlePickImage = () => {
    launchImageLibrary(
      { mediaType: 'photo', quality: 0.8, maxWidth: 1024, maxHeight: 1024 },
      (response: ImagePickerResponse) => {
        if (
          !response.didCancel &&
          !response.errorCode &&
          response.assets?.[0]?.uri
        ) {
          setSelectedImage(response.assets[0].uri);
        }
      },
    );
  };

  const handleTakePhoto = () => {
    launchCamera(
      { mediaType: 'photo', quality: 0.8, maxWidth: 1024, maxHeight: 1024 },
      (response: ImagePickerResponse) => {
        if (
          !response.didCancel &&
          !response.errorCode &&
          response.assets?.[0]?.uri
        ) {
          setSelectedImage(response.assets[0].uri);
        }
      },
    );
  };

  const clearSelectedImage = () => {
    setSelectedImage(null);
  };

  const handleVoiceTranscription = useCallback((text: string) => {
    if (settings?.autoSendVoice) {
      handleSend(text);
    } else {
      setInputText(text);
    }
  }, [settings?.autoSendVoice]);

  const handleSend = async (overrideText?: string) => {
    const text = (overrideText ?? inputText).trim();
    if (!text && !selectedImage) return;
    if (!modelLoaded || isGenerating) return;

    abortRef.current = false;
    triggerLightHaptic();

    const userMessage: ChatMessage = {
      role: 'user' as const,
      content: text,
      timestamp: Date.now(),
      images: selectedImage ? [selectedImage] : undefined,
    };

    const updatedMessages = [...messages, userMessage];
    setMessages(updatedMessages);
    setInputText('');
    setSelectedImage(null);
    setIsGenerating(true);
    setStreamingText('');
    setMetrics(null);
    setLiveTokenCount(0);
    setLiveTokensPerSecond(0);
    scrollToBottom();

    try {
      // Recall relevant memories before generating
      let memoryContext = '';
      if (settings?.memoryEnabled) {
        const memories = await recallForMessage(text);
        if (memories.length > 0) {
          memoryContext = '\n\nRelevant context from previous interactions:\n' +
            memories.map(m => `- ${m.text}`).join('\n');
        }
      }

      const { text: responseText, functionCalls } = await generateResponse(updatedMessages, memoryContext);
      if (abortRef.current) return;

      // Parse tool calls from response text or from CactusLM functionCalls
      let toolCalls = parseToolCalls(responseText);
      if (toolCalls.length === 0 && functionCalls && functionCalls.length > 0) {
        toolCalls = parseCactusFunctionCalls(functionCalls);
      }

      const assistantMessage: ChatMessage = {
        role: 'assistant' as const,
        content: responseText,
        timestamp: Date.now(),
        tokens: metrics?.totalTokens,
        timeToFirstTokenMs: metrics?.timeToFirstTokenMs,
        tokensPerSecond: metrics?.tokensPerSecond,
        toolCalls: toolCalls.length > 0 ? toolCalls : undefined,
      };

      const withAssistant = [...updatedMessages, assistantMessage];
      setMessages(withAssistant);
      await saveMessages(withAssistant);
      scrollToBottom();

      // Auto-speak if enabled
      if (settings?.autoTTS && responseText) {
        speak(responseText, {
          rate: settings.ttsRate,
          voice: settings.ttsVoice,
        });
      }

      // Auto-remember interaction if enabled
      if (settings?.memoryEnabled && settings?.autoRemember && responseText) {
        rememberInteraction(text, responseText);
      }

      // Execute tool calls if found and auto-execute is enabled
      if (
        toolCalls.length > 0 &&
        settings?.autoExecuteTools !== false
      ) {
        await handleToolExecution(withAssistant, toolCalls);
      }
    } catch (error) {
      if (abortRef.current) return;
      const errMsg =
        error instanceof Error ? error.message : 'Generation failed';

      const errorMessage: ChatMessage = {
        role: 'assistant' as const,
        content: `Error: ${errMsg}`,
        timestamp: Date.now(),
      };
      const withError = [...updatedMessages, errorMessage];
      setMessages(withError);
      await saveMessages(withError);
    } finally {
      setIsGenerating(false);
      setStreamingText('');
    }
  };

  const generateResponse = async (
    allMessages: ChatMessage[],
    memoryContext?: string,
  ): Promise<{ text: string; functionCalls?: Array<{ name: string; arguments: string }> }> => {
    const systemPrompt = buildSystemPrompt(settings?.systemPrompt, memoryContext);

    const formattedMessages: Message[] = [
      { role: 'system', content: systemPrompt },
    ];

    for (const msg of allMessages) {
      if (msg.role === 'system') continue;
      const formatted: Message = {
        role: msg.role as 'user' | 'assistant',
        content: msg.content,
      };
      if (msg.images && msg.images.length > 0) {
        formatted.images = msg.images;
      }
      formattedMessages.push(formatted);
    }

    let fullResponse = '';
    let tokenCount = 0;
    const startTime = Date.now();
    let firstTokenTime: number | null = null;

    const onToken = (token: string) => {
      if (abortRef.current) return;
      tokenCount++;
      if (!firstTokenTime) {
        firstTokenTime = Date.now();
      }
      fullResponse += token;
      setStreamingText(fullResponse);
      setLiveTokenCount(tokenCount);

      const elapsed = Date.now() - startTime;
      if (elapsed > 0) {
        setLiveTokensPerSecond(
          Math.round((tokenCount / elapsed) * 1000 * 10) / 10,
        );
      }

      if (tokenCount % 10 === 0) {
        scrollToBottom();
      }
    };

    let functionCalls: Array<{ name: string; arguments: string }> | undefined;

    if (isCustomModelRef.current && nativeCactusRef.current) {
      // Native Cactus path for custom models
      const result = await nativeCactusRef.current.complete(
        formattedMessages,
        settings?.maxTokens ?? 512,
        {
          temperature: settings?.temperature ?? 0.7,
          topP: settings?.topP ?? 0.9,
          topK: settings?.topK ?? 40,
          maxTokens: settings?.maxTokens ?? 512,
        },
        undefined, // tools
        (token: string, _tokenId: number) => onToken(token),
      );
      fullResponse = result.text || fullResponse;
      functionCalls = result.functionCalls;
    } else if (cactusLMRef.current) {
      // CactusLM path for registry models
      const result = await cactusLMRef.current.complete({
        messages: formattedMessages,
        options: {
          temperature: settings?.temperature ?? 0.7,
          topP: settings?.topP ?? 0.9,
          topK: settings?.topK ?? 40,
          maxTokens: settings?.maxTokens ?? 512,
        },
        onToken,
      });
      fullResponse = result.text || fullResponse;
      functionCalls = result.functionCalls;

      if (result.timings) {
        const totalTime = Date.now() - startTime;
        setMetrics({
          totalTokens: result.timings.predicted_n || tokenCount,
          timeToFirstTokenMs: firstTokenTime
            ? firstTokenTime - startTime
            : 0,
          totalTimeMs: totalTime,
          tokensPerSecond:
            result.timings.predicted_per_second ||
            (tokenCount / totalTime) * 1000,
          prefillTokens: result.timings.prompt_n || 0,
          decodeTokens: result.timings.predicted_n || tokenCount,
        });
      }
    } else {
      throw new Error('No model loaded');
    }

    // Compute metrics if not already set
    if (!metrics) {
      const totalTime = Date.now() - startTime;
      setMetrics({
        totalTokens: tokenCount,
        timeToFirstTokenMs: firstTokenTime
          ? firstTokenTime - startTime
          : 0,
        totalTimeMs: totalTime,
        tokensPerSecond: totalTime > 0 ? (tokenCount / totalTime) * 1000 : 0,
        prefillTokens: 0,
        decodeTokens: tokenCount,
      });
    }

    return { text: fullResponse, functionCalls };
  };

  const handleToolExecution = async (
    currentMessages: ChatMessage[],
    toolCalls: ToolCall[],
  ) => {
    triggerMediumHaptic();
    let updatedMessages = [...currentMessages];

    for (const tc of toolCalls) {
      try {
        const result: ToolResult = await executeTool(
          tc.name,
          tc.arguments,
        );

        const toolMessage: ChatMessage = {
          role: 'tool' as any,
          content: `[${tc.name}]: ${result.message}`,
          timestamp: Date.now(),
          toolResult: result,
        };

        updatedMessages = [...updatedMessages, toolMessage];
        setMessages(updatedMessages);
        scrollToBottom();
      } catch (error) {
        const errResult: ToolResult = {
          success: false,
          message:
            error instanceof Error
              ? error.message
              : 'Tool execution failed',
        };

        const toolMessage: ChatMessage = {
          role: 'tool' as any,
          content: `[${tc.name}]: Error - ${errResult.message}`,
          timestamp: Date.now(),
          toolResult: errResult,
        };

        updatedMessages = [...updatedMessages, toolMessage];
        setMessages(updatedMessages);
      }
    }

    await saveMessages(updatedMessages);

    // Generate follow-up response after tool execution
    try {
      setIsGenerating(true);
      setStreamingText('');
      setLiveTokenCount(0);
      setLiveTokensPerSecond(0);
      const { text: followUp, functionCalls } = await generateResponse(updatedMessages);

      if (!abortRef.current) {
        let followUpToolCalls = parseToolCalls(followUp);
        if (followUpToolCalls.length === 0 && functionCalls && functionCalls.length > 0) {
          followUpToolCalls = parseCactusFunctionCalls(functionCalls);
        }

        const followUpMessage: ChatMessage = {
          role: 'assistant' as const,
          content: followUp,
          timestamp: Date.now(),
          toolCalls:
            followUpToolCalls.length > 0
              ? followUpToolCalls
              : undefined,
        };

        const withFollowUp = [...updatedMessages, followUpMessage];
        setMessages(withFollowUp);
        await saveMessages(withFollowUp);
        scrollToBottom();

        if (settings?.autoTTS && followUp) {
          speak(followUp, {
            rate: settings.ttsRate,
            voice: settings.ttsVoice,
          });
        }
      }
    } catch {
      // Follow-up generation is best-effort
    } finally {
      setIsGenerating(false);
      setStreamingText('');
    }
  };

  const handleStop = () => {
    abortRef.current = true;
    setIsGenerating(false);
    stopSpeaking();

    if (streamingText) {
      const assistantMessage: ChatMessage = {
        role: 'assistant' as const,
        content: streamingText + ' [stopped]',
        timestamp: Date.now(),
      };
      const updated = [...messages, assistantMessage];
      setMessages(updated);
      saveMessages(updated);
    }
  };

  const handleModelSwitch = () => {
    const currentModel = settings?.model || '';
    onOpenModelSelector(currentModel, async (newModel: string) => {
      if (newModel !== currentModel && settings) {
        const updated = { ...settings, model: newModel };
        setSettings(updated);
        if (chatRef.current) {
          chatRef.current.settings = updated;
          chatRef.current.model = newModel;
          await storage.saveChat(chatRef.current);
        }
        await initializeModel(newModel);
      }
    });
  };

  const renderHeader = () => (
    <View style={styles.header}>
      <TouchableOpacity onPress={onBack} style={styles.backButton}>
        <Text style={styles.backButtonText}>Back</Text>
      </TouchableOpacity>
      <TouchableOpacity
        onPress={handleModelSwitch}
        style={styles.modelNameContainer}
      >
        <Text style={styles.modelName} numberOfLines={1}>
          {modelDisplayName}
        </Text>
        {isModelLoading && (
          <Text style={styles.loadingLabel}>{loadProgress}%</Text>
        )}
      </TouchableOpacity>
      <View style={styles.headerRight}>
        {isModelLoading && (
          <ActivityIndicator size="small" color={theme.colors.accent} />
        )}
      </View>
    </View>
  );

  const renderMessages = () => (
    <ScrollView
      ref={scrollViewRef}
      style={styles.messagesContainer}
      contentContainerStyle={styles.messagesContent}
      onContentSizeChange={scrollToBottom}
      keyboardShouldPersistTaps="handled"
    >
      {messages.length === 0 && !isGenerating && (
        <View style={styles.emptyState}>
          <Image
            source={require('../assets/liquidchat_logo.png')}
            style={styles.emptyLogoImage}
          />
          <Text style={styles.emptyBranding}>🌵💧</Text>
          <Text style={styles.emptyTitle}>LiquidChat</Text>
          <Text style={styles.emptySubtitle}>
            {modelLoaded
              ? 'Model loaded. Start chatting!'
              : isModelLoading
                ? 'Loading model...'
                : 'Select a model to begin'}
          </Text>
        </View>
      )}

      {messages.map((msg, index) => (
        <MessageBubble
          key={`${msg.timestamp}-${index}`}
          message={msg}
        />
      ))}

      {isGenerating && streamingText && (
        <MessageBubble
          message={{
            role: 'assistant',
            content: streamingText,
            timestamp: Date.now(),
          }}
          isStreaming={true}
        />
      )}

      {isGenerating && !streamingText && (
        <View style={styles.thinkingContainer}>
          <ActivityIndicator size="small" color={theme.colors.accent} />
          <Text style={styles.thinkingText}>Thinking...</Text>
        </View>
      )}
    </ScrollView>
  );

  const renderImagePreview = () => {
    if (!selectedImage) return null;
    return (
      <View style={styles.imagePreview}>
        <ScreenshotPreview uri={selectedImage} onRemove={clearSelectedImage} />
      </View>
    );
  };

  const QUICK_ACTIONS = [
    { label: '🔦 On', text: 'Turn on the flashlight' },
    { label: '🔦 Off', text: 'Turn off the flashlight' },
    { label: '📶 WiFi', text: 'Open WiFi settings' },
    { label: '📅 Calendar', text: 'Create a calendar event for ' },
    { label: '✉️ Email', text: 'Send an email to ' },
    { label: '🗺️ Maps', text: 'Show me a map of ' },
    { label: '👤 Contact', text: 'Create a new contact for ' },
    { label: '🔆 Bright', text: 'Set the brightness to ' },
    { label: '🔊 Volume', text: 'Set the volume to ' },
    { label: '📡 BT', text: 'Turn on Bluetooth' },
    { label: '🔕 DND', text: 'Enable Do Not Disturb' },
    { label: '⏰ Alarm', text: 'Set an alarm for ' },
    { label: '⏱️ Timer', text: 'Set a timer for ' },
    { label: '⚙️ Settings', text: 'Open settings for ' },
  ];

  const handleQuickAction = (action: typeof QUICK_ACTIONS[0]) => {
    setInputText(action.text);
  };

  const renderQuickActions = () => (
    <ScrollView
      horizontal
      showsHorizontalScrollIndicator={false}
      style={styles.quickActionsRow}
      contentContainerStyle={styles.quickActionsContent}
    >
      {QUICK_ACTIONS.map((action, idx) => (
        <TouchableOpacity
          key={idx}
          style={styles.quickActionChip}
          onPress={() => handleQuickAction(action)}
          disabled={isGenerating}
        >
          <Text style={styles.quickActionText}>{action.label}</Text>
        </TouchableOpacity>
      ))}
    </ScrollView>
  );

  const renderInputArea = () => (
    <View style={styles.inputArea}>
      <MemoryChips memories={relevantMemories} onDismiss={clearRecalled} />
      {renderQuickActions()}
      {renderImagePreview()}
      <View style={styles.inputRow}>
        <TouchableOpacity
          onPress={handleTakePhoto}
          style={styles.iconButton}
          disabled={isGenerating}
        >
          <Text style={styles.iconButtonEmoji}>📸</Text>
        </TouchableOpacity>

        <TouchableOpacity
          onPress={handlePickImage}
          style={styles.iconButton}
          disabled={isGenerating}
        >
          <Text style={styles.iconButtonEmoji}>🖼️</Text>
        </TouchableOpacity>

        {settings?.voiceInputEnabled !== false && (
          <VoiceInputButton
            sttModel={settings?.sttModel || 'whisper-small'}
            disabled={isGenerating || !modelLoaded}
            onTranscription={handleVoiceTranscription}
            onError={(err) => Alert.alert('Voice Input Error', err)}
          />
        )}

        <TextInput
          style={styles.textInput}
          value={inputText}
          onChangeText={setInputText}
          placeholder="Message..."
          placeholderTextColor={theme.colors.textMuted}
          multiline
          maxLength={4096}
          editable={!isGenerating}
          onSubmitEditing={handleSend}
          blurOnSubmit={false}
        />

        {isGenerating ? (
          <TouchableOpacity
            onPress={handleStop}
            style={[styles.sendButton, styles.stopButton]}
          >
            <Text style={styles.sendButtonEmoji}>⏹️</Text>
          </TouchableOpacity>
        ) : (
          <TouchableOpacity
            onPress={handleSend}
            style={[
              styles.sendButton,
              (!inputText.trim() && !selectedImage) ||
              !modelLoaded
                ? styles.sendButtonDisabled
                : null,
            ]}
            disabled={
              (!inputText.trim() && !selectedImage) || !modelLoaded
            }
          >
            <Text style={styles.sendButtonEmoji}>💧</Text>
          </TouchableOpacity>
        )}
      </View>
    </View>
  );

  return (
    <SafeAreaView style={styles.container}>
      <StatusBar barStyle="light-content" backgroundColor={theme.colors.primary} />
      <KeyboardAvoidingView
        style={styles.flex}
        behavior={Platform.OS === 'ios' ? 'padding' : undefined}
        keyboardVerticalOffset={Platform.OS === 'ios' ? 0 : 0}
      >
        {renderHeader()}
        <MetricsBar
          metrics={metrics}
          isGenerating={isGenerating}
          liveTokenCount={liveTokenCount}
          liveTokensPerSecond={liveTokensPerSecond}
          modelName={modelDisplayName}
        />
        {renderMessages()}
        {renderInputArea()}
      </KeyboardAvoidingView>
    </SafeAreaView>
  );
}

const styles = StyleSheet.create({
  container: {
    flex: 1,
    backgroundColor: theme.colors.background,
  },
  flex: {
    flex: 1,
  },
  header: {
    flexDirection: 'row',
    alignItems: 'center',
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
  modelNameContainer: {
    flex: 1,
    alignItems: 'center',
    flexDirection: 'row',
    justifyContent: 'center',
  },
  modelName: {
    color: theme.colors.textLight,
    fontSize: theme.fontSize.lg,
    fontWeight: '700',
  },
  loadingLabel: {
    color: theme.colors.accent,
    fontSize: theme.fontSize.sm,
    marginLeft: theme.spacing.sm,
  },
  headerRight: {
    width: 40,
    alignItems: 'flex-end',
  },
  messagesContainer: {
    flex: 1,
  },
  messagesContent: {
    paddingHorizontal: theme.spacing.lg,
    paddingVertical: theme.spacing.md,
    flexGrow: 1,
  },
  emptyState: {
    flex: 1,
    justifyContent: 'center',
    alignItems: 'center',
    paddingTop: 100,
    paddingHorizontal: theme.spacing.lg,
  },
  emptyLogoImage: {
    width: 80,
    height: 80,
    borderRadius: 20,
    marginBottom: theme.spacing.sm,
  },
  emptyBranding: {
    fontSize: 28,
    marginBottom: theme.spacing.sm,
  },
  emptyTitle: {
    fontSize: theme.fontSize.title,
    fontWeight: '700',
    color: theme.colors.text,
    marginBottom: theme.spacing.sm,
    textAlign: 'center',
  },
  emptySubtitle: {
    fontSize: theme.fontSize.lg,
    color: theme.colors.textSecondary,
    textAlign: 'center',
  },
  thinkingContainer: {
    flexDirection: 'row',
    alignItems: 'center',
    padding: theme.spacing.md,
    marginVertical: theme.spacing.xs,
  },
  thinkingText: {
    color: theme.colors.textSecondary,
    fontSize: theme.fontSize.md,
    marginLeft: theme.spacing.sm,
  },
  quickActionsRow: {
    maxHeight: 40,
    marginBottom: theme.spacing.sm,
  },
  quickActionsContent: {
    paddingHorizontal: theme.spacing.xs,
    gap: theme.spacing.sm,
  },
  quickActionChip: {
    backgroundColor: theme.colors.surfaceLight,
    borderRadius: theme.borderRadius.full,
    paddingHorizontal: theme.spacing.lg,
    paddingVertical: theme.spacing.sm,
    borderWidth: 1,
    borderColor: theme.colors.border,
  },
  quickActionText: {
    fontSize: 13,
    color: theme.colors.accent,
    fontWeight: '600',
  },
  inputArea: {
    backgroundColor: theme.colors.surface,
    borderTopWidth: 1,
    borderTopColor: theme.colors.border,
    paddingHorizontal: theme.spacing.md,
    paddingVertical: theme.spacing.sm,
  },
  imagePreview: {
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'space-between',
    backgroundColor: theme.colors.surfaceLight,
    borderRadius: theme.borderRadius.sm,
    paddingHorizontal: theme.spacing.md,
    paddingVertical: theme.spacing.sm,
    marginBottom: theme.spacing.sm,
  },
  imagePreviewText: {
    color: theme.colors.accent,
    fontSize: theme.fontSize.sm,
  },
  imageRemoveText: {
    color: theme.colors.error,
    fontSize: theme.fontSize.sm,
    fontWeight: '600',
  },
  inputRow: {
    flexDirection: 'row',
    alignItems: 'flex-end',
  },
  iconButton: {
    width: 40,
    height: 40,
    borderRadius: theme.borderRadius.sm,
    backgroundColor: theme.colors.surfaceLight,
    justifyContent: 'center',
    alignItems: 'center',
    marginRight: theme.spacing.xs,
  },
  iconButtonEmoji: {
    fontSize: 18,
  },
  iconButtonText: {
    color: theme.colors.accent,
    fontSize: theme.fontSize.xs,
    fontWeight: '700',
  },
  disabledText: {
    color: theme.colors.textMuted,
  },
  textInput: {
    flex: 1,
    backgroundColor: theme.colors.inputBg,
    borderRadius: theme.borderRadius.md,
    paddingHorizontal: theme.spacing.md,
    paddingVertical: Platform.OS === 'ios' ? theme.spacing.md : theme.spacing.sm,
    color: theme.colors.text,
    fontSize: theme.fontSize.md,
    maxHeight: 120,
    marginRight: theme.spacing.sm,
  },
  sendButton: {
    backgroundColor: theme.colors.secondary,
    borderRadius: theme.borderRadius.sm,
    paddingHorizontal: theme.spacing.lg,
    height: 40,
    justifyContent: 'center',
    alignItems: 'center',
  },
  sendButtonDisabled: {
    opacity: 0.4,
  },
  stopButton: {
    backgroundColor: theme.colors.error,
  },
  sendButtonEmoji: {
    fontSize: 20,
  },
  sendButtonText: {
    color: theme.colors.textLight,
    fontSize: theme.fontSize.sm,
    fontWeight: '700',
  },
});
