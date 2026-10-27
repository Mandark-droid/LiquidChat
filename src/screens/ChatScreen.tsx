import { CactusLM, type CactusLMMessage } from 'cactus-react-native';
import React, { useCallback, useEffect, useRef, useState } from 'react';
import {
  ActivityIndicator,
  Alert,
  Image,
  KeyboardAvoidingView,
  Platform,
  ScrollView,
  StatusBar,
  StyleSheet,
  Text,
  TextInput,
  TouchableOpacity,
  View,
} from 'react-native';
import {
  type ImagePickerResponse,
  launchCamera,
  launchImageLibrary,
} from 'react-native-image-picker';
import { SafeAreaView } from 'react-native-safe-area-context';

import { agentRuntime } from '../agent/runtime';
import type { AgentEvent, ExecutionState, Plan } from '../agent/types';
import ActionChainProgress from '../components/ActionChainProgress';
import AgentStateBar from '../components/AgentStateBar';
import MemoryChips from '../components/MemoryChips';
import MessageBubble from '../components/MessageBubble';
import MetricsBar from '../components/MetricsBar';
import ScreenshotPreview from '../components/ScreenshotPreview';
import VisionModeOverlay from '../components/VisionModeOverlay';
import VoiceInputButton from '../components/VoiceInputButton';
import { getModelBySlug, quantizationFor } from '../config/models';
import { theme } from '../config/theme';
import { useIntentRouter } from '../hooks/useIntentRouter';
import { useMemory } from '../hooks/useMemory';
import { askInCloud } from '../meetings/cloudMeeting';
import { meetingContext } from '../meetings/meetingQA';
import { meetingStore } from '../meetings/MeetingStore';
import { getMeetingSettings } from '../meetings/settings';
import { chatMemoryContext, saveIfRememberRequest } from '../memory/chatContext';
import { usageLedger } from '../observability/usageLedger';
import { actionLogger } from '../services/ActionLogger';
import { isPlainChat } from '../services/IntentRouter';
import { memoryService } from '../services/MemoryService';
import { modelLifecycle } from '../services/ModelLifecycleManager';
import { planToManifest } from '../skills/SkillGenerator';
import { executeTool, getDefaultSystemPrompt, isDefaultSystemPrompt } from '../tools/registry';
import type {
  ActionChainStep,
  AgentState,
  Chat,
  ChatMessage,
  ChatMetrics,
  ChatSettings,
  ToolCall,
  ToolResult,
} from '../types';
import { DEFAULT_SETTINGS } from '../types';
import { generateChatTitle } from '../utils/chatHelpers';
import { listDownloadedCactusModels } from '../utils/engineMigration';
import { triggerLightHaptic, triggerMediumHaptic } from '../utils/haptics';
import { triggerSuccessHaptic } from '../utils/haptics';
import { storage } from '../utils/storage';
import { parseCactusFunctionCalls, parseToolCalls } from '../utils/toolParser';
import { speak, stopSpeaking } from '../utils/ttsManager';

/** A legacy model whose successor is already on the device loads the successor instead. */
async function resolveSuperseded(slug: string): Promise<string> {
  const next = getModelBySlug(slug)?.supersededBy;
  if (!next) return slug;
  const downloaded = await listDownloadedCactusModels();
  return downloaded.some(m => m.slug === next) ? next : slug;
}

function decodeTokensPerSecond(tokens: number, firstTokenAt: number | null, now: number): number {
  return firstTokenAt && tokens > 1 && now > firstTokenAt
    ? ((tokens - 1) / (now - firstTokenAt)) * 1000
    : 0;
}

const PLAIN_CHAT_PROMPT =
  'You are LiquidChat, a helpful on-device assistant. Reply naturally and concisely.';

interface ChatScreenProps {
  chatId: string;
  onBack: () => void;
  onOpenModelSelector: (currentModel: string, onSelect: (model: string) => void) => void;
}

export default function ChatScreen({ chatId, onBack, onOpenModelSelector }: ChatScreenProps) {
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
  const [agentState, setAgentState] = useState<AgentState>({ kind: 'idle' });
  const [actionChainSteps, setActionChainSteps] = useState<ActionChainStep[]>([]);
  const [isVisionActive] = useState(false);

  const scrollViewRef = useRef<ScrollView>(null);
  const cactusLMRef = useRef<CactusLM | null>(null);
  const abortRef = useRef(false);
  const chatRef = useRef<Chat | null>(null);
  /** The loaded instance belongs to ModelLifecycleManager (shared with the agent runtime). */
  const managedModelRef = useRef(false);
  const executionRef = useRef<string | null>(null);
  /** A multi-step plan that just succeeded and could become a skill (PRD §21 step 12). */
  const [savablePlan, setSavablePlan] = useState<{ plan: Plan; request: string } | null>(null);

  // Intent routing hook
  const { routeAndLoad } = useIntentRouter();

  // Memory hook
  const { relevantMemories, showRecalled, rememberInteraction, clearRecalled } = useMemory(
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
      initializeModel(chat.settings.model, chat.settings);
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
      initializeModel(defaultSettings.model, defaultSettings);
    }
  };

  const releaseModel = async () => {
    if (managedModelRef.current) {
      // Lifecycle manager owns the instances; just clear refs
      cactusLMRef.current = null;
      setModelLoaded(false);
      return;
    }

    try {
      if (cactusLMRef.current) {
        await cactusLMRef.current.destroy();
        cactusLMRef.current = null;
      }
    } catch (e) {
      // Ignore destroy errors
    }
    setModelLoaded(false);
  };

  const initializeModel = async (requestedSlug: string, activeSettings?: ChatSettings | null) => {
    const modelSlug = await resolveSuperseded(requestedSlug);
    // Use passed-in settings to avoid stale React state closure on first call
    const currentSettings = activeSettings !== undefined ? activeSettings : settings;
    // A. Orchestration / agent runtime: ModelLifecycleManager owns the instance so the
    // chat and the agent's on-device steps share one loaded model.
    if (currentSettings?.orchestrationEnabled || currentSettings?.agentRuntimeEnabled !== false) {
      managedModelRef.current = true;
      setIsModelLoading(true);
      setLoadProgress(0);
      setModelLoaded(false);
      try {
        if (!modelLifecycle.initialized) await modelLifecycle.init();
        const managed = await modelLifecycle.ensure(modelSlug);
        cactusLMRef.current = managed.instance;
        setModelLoaded(true);
        setModelDisplayName(getModelBySlug(modelSlug)?.name || modelSlug);
        console.log(`[LiquidChat] Orchestration: loaded "${modelSlug}" via lifecycle manager`);
      } catch (error) {
        const errMsg = error instanceof Error ? error.message : String(error);
        Alert.alert('Model Error', `Failed to load model "${modelSlug}":\n\n${errMsg}`);
        cactusLMRef.current = null;
      } finally {
        setIsModelLoading(false);
      }
      return;
    }

    // Non-orchestration path: use CactusLM SDK directly
    setIsModelLoading(true);
    setLoadProgress(0);
    setModelLoaded(false);

    try {
      await releaseModel();
      managedModelRef.current = false;

      console.log(`[LiquidChat] Loading "${modelSlug}" via CactusLM SDK...`);
      const quantization = quantizationFor(modelSlug);
      const cactusLM = new CactusLM({
        model: modelSlug,
        options: quantization ? { quantization } : undefined,
      });
      cactusLMRef.current = cactusLM;

      await cactusLM.download({
        onProgress: (progress: number) => {
          setLoadProgress(Math.round(progress * 100));
        },
      });
      console.log(`[LiquidChat] Download complete for "${modelSlug}", initializing...`);

      await cactusLM.init();
      setModelLoaded(true);
      setModelDisplayName(getModelBySlug(modelSlug)?.name || modelSlug);
      console.log(`[LiquidChat] Model "${modelSlug}" loaded successfully`);
    } catch (error) {
      const errMsg = error instanceof Error ? error.message : String(error);
      console.error(`[LiquidChat] Failed to load "${modelSlug}": ${errMsg}`);
      Alert.alert(
        'Model Error',
        `Failed to load model "${modelSlug}":\n\n${errMsg}\n\nTry selecting a different model from the Models tab.`,
      );
      cactusLMRef.current = null;
    } finally {
      setIsModelLoading(false);
    }
  };

  const saveMessages = useCallback(async (updatedMessages: ChatMessage[]) => {
    if (!chatRef.current) return;
    chatRef.current.messages = updatedMessages;
    chatRef.current.updatedAt = Date.now();

    if (updatedMessages.length === 2 && chatRef.current.title === 'New Chat') {
      chatRef.current.title = generateChatTitle(updatedMessages);
    }

    await storage.saveChat(chatRef.current);
  }, []);

  const scrollToBottom = useCallback(() => {
    setTimeout(() => {
      scrollViewRef.current?.scrollToEnd({ animated: true });
    }, 100);
  }, []);

  const handlePickImage = () => {
    launchImageLibrary(
      { mediaType: 'photo', quality: 0.8, maxWidth: 1024, maxHeight: 1024 },
      (response: ImagePickerResponse) => {
        if (!response.didCancel && !response.errorCode && response.assets?.[0]?.uri) {
          setSelectedImage(response.assets[0].uri);
        }
      },
    );
  };

  const handleTakePhoto = () => {
    launchCamera(
      { mediaType: 'photo', quality: 0.8, maxWidth: 1024, maxHeight: 1024 },
      (response: ImagePickerResponse) => {
        if (!response.didCancel && !response.errorCode && response.assets?.[0]?.uri) {
          setSelectedImage(response.assets[0].uri);
        }
      },
    );
  };

  const clearSelectedImage = () => {
    setSelectedImage(null);
  };

  // Always call the latest handleSend (it reads messages/model state).
  const sendRef = useRef<(text?: string, opts?: { voice?: boolean }) => Promise<void>>(
    async () => {},
  );
  const handleVoiceTranscription = useCallback(
    (text: string) => {
      if (settings?.autoSendVoice) {
        sendRef.current(text, { voice: true });
      } else {
        setInputText(text);
      }
    },
    [settings?.autoSendVoice],
  );

  const handleSend = async (overrideText?: string, opts: { voice?: boolean } = {}) => {
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
    setAgentState({ kind: 'thinking' });
    setStreamingText('');
    setMetrics(null);
    setLiveTokenCount(0);
    setLiveTokensPerSecond(0);
    scrollToBottom();

    try {
      // "Remember that …": saved at once (the user asked), no model needed.
      if (settings?.memoryEnabled && text && !userMessage.images?.length) {
        const saved = await saveIfRememberRequest(text).catch(e => {
          console.warn('[Chat] could not save memory:', e);
          return null;
        });
        if (saved) {
          const reply: ChatMessage = {
            role: 'assistant',
            content: `Saved to memory: "${saved}". I'll use it in future chats (see Agent → Memory).`,
            timestamp: Date.now(),
          };
          const withReply = [...updatedMessages, reply];
          setMessages(withReply);
          await saveMessages(withReply);
          scrollToBottom();
          return;
        }
      }

      // Meeting Q&A: the minutes plus the passages that match this question; no tools, no routing.
      if (settings?.meetingId) {
        setAgentState({ kind: 'generating' });
        const meeting = await meetingStore.get(settings.meetingId);
        // With the LiquidChat Space engine, Gemma 4 reads the whole meeting; otherwise (or if
        // the Space is unreachable) the phone answers from the notes and matching passages.
        let answer = '';
        let turnMetrics: ChatMetrics | undefined;
        const ms = await getMeetingSettings();
        if (meeting && ms.engine === 'space' && settings.hfToken) {
          setStreamingText('Asking your LiquidChat Space…');
          answer = await askInCloud(meeting, text, {
            spaceId: ms.spaceId,
            token: settings.hfToken,
          }).catch(e => {
            console.warn(`[Chat] LiquidChat Space ask failed, answering on the phone: ${e}`);
            return '';
          });
          setStreamingText('');
        }
        if (!answer) {
          const context = meeting ? meetingContext(meeting, text) : '';
          const recent = updatedMessages.slice(-3); // the question plus one earlier exchange
          ({ text: answer, metrics: turnMetrics } = await generateResponse(recent, context));
        }
        if (abortRef.current) return;
        const reply: ChatMessage = {
          role: 'assistant',
          content: answer.trim() || 'I could not find that in the meeting.',
          timestamp: Date.now(),
          tokens: turnMetrics?.decodeTokens,
          timeToFirstTokenMs: turnMetrics?.timeToFirstTokenMs,
        };
        const withReply = [...updatedMessages, reply];
        setMessages(withReply);
        await saveMessages(withReply);
        scrollToBottom();
        if (opts.voice || settings?.autoTTS) speak(reply.content ?? '');
        return;
      }

      // C. Intent routing: when enabled, route message to best model
      if (settings?.orchestrationEnabled && settings?.intentRoutingEnabled && text) {
        const hasCorpus = memoryService.getStats().documentCount > 0;
        const { modelSlug: targetSlug, swapped } = await routeAndLoad(
          text,
          settings.model,
          hasCorpus,
        );
        if (swapped && targetSlug !== settings.model) {
          // Swap refs to the newly loaded model
          const managed = modelLifecycle.getLoadedModels().find(m => m.slug === targetSlug);
          if (managed) {
            cactusLMRef.current = managed.instance;
            setModelDisplayName(getModelBySlug(targetSlug)?.name || targetSlug);
          }
        }
      }

      // Agent runtime: plan → per-step routing → permission-gated tools → verified reply.
      // Images still use the direct multimodal path below.
      const plainChat = !userMessage.images?.length && isPlainChat(text);
      if (
        settings?.agentRuntimeEnabled !== false &&
        !userMessage.images?.length &&
        text &&
        !plainChat
      ) {
        await runAgent(text, updatedMessages, !!opts.voice);
        return;
      }
      setAgentState({ kind: 'generating' });

      // Saved memories, similar past conversations and matching document passages.
      const memoryContext = settings?.memoryEnabled
        ? await chatMemoryContext(text, showRecalled)
        : '';

      const {
        text: responseText,
        functionCalls,
        metrics: turnMetrics,
      } = await generateResponse(updatedMessages, memoryContext, plainChat);
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
        tokens: turnMetrics?.totalTokens,
        timeToFirstTokenMs: turnMetrics?.timeToFirstTokenMs,
        tokensPerSecond: turnMetrics?.tokensPerSecond,
        toolCalls: toolCalls.length > 0 ? toolCalls : undefined,
      };

      const withAssistant = [...updatedMessages, assistantMessage];
      setMessages(withAssistant);
      await saveMessages(withAssistant);
      scrollToBottom();

      // Auto-speak if enabled
      if (settings?.autoTTS && responseText) {
        speak(responseText);
      }

      // Auto-remember interaction if enabled
      if (settings?.memoryEnabled && settings?.autoRemember && responseText) {
        rememberInteraction(text, responseText);
      }

      // Execute tool calls if found and auto-execute is enabled. Never when retrieved memory or
      // document text was in the prompt: that text is data and must not be able to trigger tools.
      if (toolCalls.length > 0 && settings?.autoExecuteTools !== false && !memoryContext) {
        await handleToolExecution(withAssistant, toolCalls);
      }
    } catch (error) {
      if (abortRef.current) return;
      const errMsg = error instanceof Error ? error.message : 'Generation failed';
      setAgentState({ kind: 'error', message: errMsg });

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
      setAgentState({ kind: 'idle' });
    }
  };

  sendRef.current = handleSend;

  const runAgent = async (text: string, history: ChatMessage[], voice: boolean) => {
    const steps = new Map<string, ActionChainStep>();
    const order: string[] = [];
    let plan: Plan | null = null;
    setSavablePlan(null);
    let streamed = '';
    let tokenCount = 0;
    const startedAt = Date.now();
    let firstTokenAt: number | null = null;
    const publish = () => setActionChainSteps(order.map(id => steps.get(id)!));
    const onEvent = (e: AgentEvent) => {
      // Stop pressed before the first event: cancel as soon as the id is known.
      if (abortRef.current) {
        agentRuntime.cancel(e.executionId).catch(() => {});
        return;
      }
      executionRef.current = e.executionId;
      if (e.type === 'plan') {
        plan = e.plan;
        steps.clear();
        order.length = 0;
        for (const s of e.plan.steps) {
          order.push(s.id);
          steps.set(s.id, {
            toolName: s.kind === 'tool' ? s.tool : s.operation,
            status: 'pending',
          });
        }
        if (order.length > 1) publish();
      } else if (e.type === 'step') {
        const cur = steps.get(e.step.stepId);
        if (!cur) return;
        cur.status =
          e.step.status === 'succeeded'
            ? 'success'
            : e.step.status === 'failed' || e.step.status === 'skipped'
              ? 'error'
              : e.step.status === 'running' || e.step.status === 'waiting'
                ? 'running'
                : 'pending';
        cur.resultMessage = e.step.display ?? e.step.error?.message;
        if (cur.status === 'running') setAgentState({ kind: 'acting', toolName: cur.toolName });
        if (order.length > 1) publish();
      } else if (e.type === 'state') {
        setAgentState(agentStateFor(e.state));
      } else if (e.type === 'token') {
        streamed += e.token;
        tokenCount++;
        firstTokenAt ??= Date.now();
        setLiveTokenCount(tokenCount);
        // Decode speed: tokens after the first, over the time since the first (the wait for
        // the first token is prefill and shows separately as TTFT).
        const decodeMs = Date.now() - firstTokenAt;
        if (tokenCount > 1 && decodeMs > 0)
          setLiveTokensPerSecond(Math.round(((tokenCount - 1) / decodeMs) * 10000) / 10);
        // A tool call streams as markup or JSON; show progress, not raw syntax.
        if (!/^\s*(<\|tool_call|\[|\{)/.test(streamed)) setStreamingText(streamed);
      }
    };

    const result = await agentRuntime.execute(
      {
        text,
        // Voice turns get spoken approval prompts and a spoken reply.
        source: voice ? 'voice' : 'chat',
        conversationId: chatId,
        history: history
          .filter(m => (m.role === 'user' || m.role === 'assistant') && m.content)
          .slice(-7, -1)
          .map(m => ({ role: m.role as 'user' | 'assistant', content: m.content ?? '' })),
      },
      onEvent,
    );
    executionRef.current = null;
    if (abortRef.current || result.state === 'CANCELLED') return;

    const reply: ChatMessage = {
      role: 'assistant' as const,
      content: result.response || (result.state === 'FAILED' ? 'I could not complete that.' : ''),
      timestamp: Date.now(),
      tokens: tokenCount || undefined,
      timeToFirstTokenMs: firstTokenAt ? firstTokenAt - startedAt : undefined,
    };
    if (tokenCount) {
      const totalTimeMs = Date.now() - startedAt;
      setMetrics({
        totalTokens: tokenCount,
        timeToFirstTokenMs: firstTokenAt ? firstTokenAt - startedAt : 0,
        totalTimeMs,
        tokensPerSecond: decodeTokensPerSecond(tokenCount, firstTokenAt, Date.now()),
        prefillTokens: 0,
        decodeTokens: tokenCount,
      });
    }
    const withReply = [...history, reply];
    setMessages(withReply);
    await saveMessages(withReply);
    scrollToBottom();
    const finalPlan = plan as Plan | null;
    if (
      result.state === 'COMPLETED' &&
      finalPlan?.source === 'planner' &&
      finalPlan.steps.some(s => s.kind === 'tool')
    ) {
      setSavablePlan({ plan: finalPlan, request: text });
    }
    if (order.length > 1) {
      triggerSuccessHaptic();
      setTimeout(() => setActionChainSteps([]), 2500);
    }
    if ((voice || settings?.autoTTS) && reply.content) speak(reply.content);
    if (
      settings?.memoryEnabled &&
      settings?.autoRemember &&
      result.state === 'COMPLETED' &&
      reply.content
    )
      rememberInteraction(text, reply.content);
  };

  const generateResponse = async (
    allMessages: ChatMessage[],
    memoryContext?: string,
    plainChat = false,
  ): Promise<{
    text: string;
    functionCalls?: Array<{ name: string; arguments: string | Record<string, any> }>;
    metrics?: ChatMetrics;
  }> => {
    const systemPrompt =
      plainChat && isDefaultSystemPrompt(settings?.systemPrompt)
        ? PLAIN_CHAT_PROMPT + (memoryContext ?? '')
        : buildSystemPrompt(settings?.systemPrompt, memoryContext);

    const formattedMessages: CactusLMMessage[] = [{ role: 'system', content: systemPrompt }];

    for (const msg of allMessages) {
      if (msg.role === 'system') continue;
      const formatted: CactusLMMessage = {
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
        setLiveTokensPerSecond(Math.round((tokenCount / elapsed) * 1000 * 10) / 10);
      }

      if (tokenCount % 10 === 0) {
        scrollToBottom();
      }
    };

    if (!cactusLMRef.current) {
      throw new Error('No model loaded');
    }

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
    fullResponse = result.response || fullResponse;
    usageLedger.record('local', result.prefillTokens, result.decodeTokens || tokenCount);
    const functionCalls:
      Array<{ name: string; arguments: string | Record<string, any> }> | undefined =
      result.functionCalls;

    const totalTime = Date.now() - startTime;
    const turnMetrics = {
      totalTokens: result.totalTokens || tokenCount,
      timeToFirstTokenMs: firstTokenTime ? firstTokenTime - startTime : 0,
      totalTimeMs: result.totalTimeMs || totalTime,
      tokensPerSecond: result.decodeTps || (totalTime > 0 ? (tokenCount / totalTime) * 1000 : 0),
      prefillTokens: result.prefillTokens || 0,
      decodeTokens: result.decodeTokens || tokenCount,
    };
    setMetrics(turnMetrics);
    console.log(
      `[Chat] direct reply: ${turnMetrics.prefillTokens} prefill, ${turnMetrics.decodeTokens} decode, TTFT ${turnMetrics.timeToFirstTokenMs}ms, ${turnMetrics.tokensPerSecond.toFixed(1)} tok/s`,
    );

    return { text: fullResponse, functionCalls, metrics: turnMetrics };
  };

  const handleToolExecution = async (currentMessages: ChatMessage[], toolCalls: ToolCall[]) => {
    triggerMediumHaptic();
    let updatedMessages = [...currentMessages];

    // Initialize action chain steps
    const steps: ActionChainStep[] = toolCalls.map(tc => ({
      toolName: tc.name,
      status: 'pending' as const,
    }));
    setActionChainSteps([...steps]);

    for (let i = 0; i < toolCalls.length; i++) {
      const tc = toolCalls[i];
      setAgentState({ kind: 'acting', toolName: tc.name });

      // Mark current step running
      steps[i] = { ...steps[i], status: 'running' };
      setActionChainSteps([...steps]);

      const toolStart = Date.now();
      try {
        const result: ToolResult = await executeTool(tc.name, tc.arguments);

        // Mark step success
        steps[i] = { ...steps[i], status: 'success', resultMessage: result.message };
        setActionChainSteps([...steps]);

        // D. Log tool execution when orchestration is enabled
        if (settings?.orchestrationEnabled) {
          actionLogger.log({
            toolName: tc.name,
            arguments: tc.arguments,
            success: result.success,
            message: result.message,
            modelSlug: settings.model,
            durationMs: Date.now() - toolStart,
          });
        }

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
          message: error instanceof Error ? error.message : 'Tool execution failed',
        };

        // Mark step error
        steps[i] = { ...steps[i], status: 'error', resultMessage: errResult.message };
        setActionChainSteps([...steps]);

        // D. Log failed tool execution
        if (settings?.orchestrationEnabled) {
          actionLogger.log({
            toolName: tc.name,
            arguments: tc.arguments,
            success: false,
            message: errResult.message,
            modelSlug: settings.model,
            durationMs: Date.now() - toolStart,
          });
        }

        const toolMessage: ChatMessage = {
          role: 'tool' as any,
          content: `[${tc.name}]: Error - ${errResult.message}`,
          timestamp: Date.now(),
          toolResult: errResult,
        };

        updatedMessages = [...updatedMessages, toolMessage];
        setMessages(updatedMessages);
      }

      // Haptic between steps
      if (i < toolCalls.length - 1) {
        triggerLightHaptic();
      }
    }

    // Chain completed
    triggerSuccessHaptic();
    await saveMessages(updatedMessages);

    // Clear action chain after delay
    setTimeout(() => setActionChainSteps([]), 2000);

    // Generate follow-up response after tool execution
    try {
      setAgentState({ kind: 'thinking' });
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
          toolCalls: followUpToolCalls.length > 0 ? followUpToolCalls : undefined,
        };

        const withFollowUp = [...updatedMessages, followUpMessage];
        setMessages(withFollowUp);
        await saveMessages(withFollowUp);
        scrollToBottom();

        if (settings?.autoTTS && followUp) {
          speak(followUp);
        }
      }
    } catch {
      // Follow-up generation is best-effort
    } finally {
      setIsGenerating(false);
      setStreamingText('');
      setAgentState({ kind: 'idle' });
    }
  };

  const handleStop = () => {
    abortRef.current = true;
    if (executionRef.current) {
      agentRuntime.cancel(executionRef.current).catch(() => {});
      executionRef.current = null;
    }
    setIsGenerating(false);
    setAgentState({ kind: 'idle' });
    setActionChainSteps([]);
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
        await initializeModel(newModel, updated);
      }
    });
  };

  const renderHeader = () => (
    <View style={styles.header}>
      <TouchableOpacity onPress={onBack} style={styles.backButton}>
        <Text style={styles.backButtonText}>Back</Text>
      </TouchableOpacity>
      <TouchableOpacity onPress={handleModelSwitch} style={styles.modelNameContainer}>
        <Text style={styles.modelName} numberOfLines={1}>
          {modelDisplayName}
        </Text>
        {isModelLoading && <Text style={styles.loadingLabel}>{loadProgress}%</Text>}
      </TouchableOpacity>
      <View style={styles.headerRight}>
        {isModelLoading && <ActivityIndicator size="small" color={theme.colors.accent} />}
      </View>
    </View>
  );

  const renderMessages = () => (
    <View style={styles.messagesWrapper}>
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
          <MessageBubble key={`${msg.timestamp}-${index}`} message={msg} />
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
            <Text style={styles.thinkingText}>
              {/thinking/i.test(modelDisplayName) ? 'Thinking...' : 'Generating...'}
            </Text>
          </View>
        )}
      </ScrollView>
      <VisionModeOverlay active={isVisionActive} />
    </View>
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

  const handleQuickAction = (action: (typeof QUICK_ACTIONS)[0]) => {
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
            onError={err => Alert.alert('Voice Input Error', err)}
            onRecordingStart={() => setAgentState({ kind: 'listening' })}
            onRecordingEnd={() => setAgentState({ kind: 'idle' })}
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
          onSubmitEditing={() => handleSend()}
          blurOnSubmit={false}
        />

        {isGenerating ? (
          <TouchableOpacity onPress={handleStop} style={[styles.sendButton, styles.stopButton]}>
            <Text style={styles.sendButtonEmoji}>⏹️</Text>
          </TouchableOpacity>
        ) : (
          <TouchableOpacity
            onPress={() => handleSend()}
            style={[
              styles.sendButton,
              (!inputText.trim() && !selectedImage) || !modelLoaded
                ? styles.sendButtonDisabled
                : null,
            ]}
            disabled={(!inputText.trim() && !selectedImage) || !modelLoaded}
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
        <AgentStateBar agentState={agentState} />
        {renderMessages()}
        {actionChainSteps.length > 0 && (
          <ActionChainProgress steps={actionChainSteps} totalPlanned={actionChainSteps.length} />
        )}
        {savablePlan && !isGenerating ? (
          <View style={styles.saveSkillRow}>
            <Text style={styles.saveSkillText} numberOfLines={1}>
              Worked? Save these steps as a reusable skill.
            </Text>
            <TouchableOpacity onPress={() => setSavablePlan(null)}>
              <Text style={styles.saveSkillDismiss}>Not now</Text>
            </TouchableOpacity>
            <TouchableOpacity
              onPress={async () => {
                const { plan, request } = savablePlan;
                setSavablePlan(null);
                try {
                  const manifest = planToManifest(plan, request, request, agentRuntime.registry);
                  const skill = await agentRuntime.skills.install(manifest, 'generated');
                  Alert.alert(
                    'Saved as a skill',
                    `"${skill.manifest.name}" is in Agent → Skills. It stays off until you review its steps and permissions.`,
                  );
                } catch (e) {
                  Alert.alert('Could not save skill', e instanceof Error ? e.message : String(e));
                }
              }}
            >
              <Text style={styles.saveSkillAction}>Save</Text>
            </TouchableOpacity>
          </View>
        ) : null}
        {renderInputArea()}
      </KeyboardAvoidingView>
    </SafeAreaView>
  );
}

const styles = StyleSheet.create({
  saveSkillRow: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: 12,
    marginHorizontal: theme.spacing.md,
    marginBottom: 6,
    paddingHorizontal: theme.spacing.md,
    paddingVertical: 8,
    borderRadius: theme.borderRadius.lg,
    backgroundColor: theme.colors.surface,
    borderWidth: 1,
    borderColor: theme.colors.border,
  },
  saveSkillText: { flex: 1, color: theme.colors.text, fontSize: theme.fontSize.sm },
  saveSkillDismiss: { color: theme.colors.textSecondary, fontSize: theme.fontSize.sm },
  saveSkillAction: { color: theme.colors.accent, fontWeight: '700', fontSize: theme.fontSize.sm },
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
  messagesWrapper: {
    flex: 1,
    position: 'relative',
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

function agentStateFor(state: ExecutionState): AgentState {
  switch (state) {
    case 'FAILED':
      return { kind: 'error', message: 'Task failed' };
    case 'COMPLETED':
    case 'CANCELLED':
      return { kind: 'idle' };
    default:
      return { kind: 'thinking' };
  }
}
