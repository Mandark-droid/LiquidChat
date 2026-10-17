import React, { useCallback, useEffect, useState } from 'react';
import { AppState, StatusBar, StyleSheet, Text, TouchableOpacity, View } from 'react-native';
import { SafeAreaProvider, useSafeAreaInsets } from 'react-native-safe-area-context';

import { agentRuntime, refreshLocalModels, startAgentRuntime } from './agent/runtime';
import type { AgentResult } from './agent/types';
import ApprovalHost from './components/ApprovalHost';
import { theme } from './config/theme';
import { buildMinutesMarkdown } from './meetings/documents';
import { meetingStore } from './meetings/MeetingStore';
import { transcriptPlain } from './meetings/MinutesGenerator';
import { platform } from './platform/android';
import AgentDashboardScreen from './screens/AgentDashboardScreen';
import AgentInsightsScreen from './screens/AgentInsightsScreen';
import AgentSettingsScreen from './screens/AgentSettingsScreen';
import ChatListScreen from './screens/ChatListScreen';
import ChatScreen from './screens/ChatScreen';
import EmailDraftScreen from './screens/EmailDraftScreen';
import MeetingDetailScreen from './screens/MeetingDetailScreen';
import MeetingRecorderScreen from './screens/MeetingRecorderScreen';
import MeetingSettingsScreen from './screens/MeetingSettingsScreen';
import MeetingsScreen from './screens/MeetingsScreen';
import MemoryScreen from './screens/MemoryScreen';
import ModelSelectionScreen from './screens/ModelSelectionScreen';
import SettingsScreen from './screens/SettingsScreen';
import SkillsScreen from './screens/SkillsScreen';
import TasksScreen from './screens/TasksScreen';
import { type Chat, DEFAULT_SETTINGS } from './types';
import { generateChatId } from './utils/chatHelpers';
import { checkEngineMigration } from './utils/engineMigration';
import { storage } from './utils/storage';

type Tab = 'chats' | 'meetings' | 'tasks' | 'models' | 'agent' | 'settings';
type Screen =
  | { type: 'tabs' }
  | { type: 'chat'; chatId: string }
  | { type: 'meetingRecorder' }
  | { type: 'meetingDetail'; meetingId: string }
  | { type: 'meetingSettings' }
  | { type: 'emailDraft'; meetingId?: string; back: Screen }
  | { type: 'skills' }
  | { type: 'memory' }
  | { type: 'insights' }
  | { type: 'agentSettings' }
  | {
      type: 'modelSelection';
      currentModel: string;
      onSelect: (model: string) => void;
    };

const TAB_CONFIG: { key: Tab; label: string; icon: string }[] = [
  { key: 'chats', label: 'Chats', icon: '💬' },
  { key: 'meetings', label: 'Meetings', icon: '🎙️' },
  { key: 'tasks', label: 'Tasks', icon: '✅' },
  { key: 'models', label: 'Models', icon: '🤖' },
  { key: 'agent', label: 'Agent', icon: '🧠' },
  { key: 'settings', label: 'Settings', icon: '⚙️' },
];

function AppContent() {
  const insets = useSafeAreaInsets();
  const [activeTab, setActiveTab] = useState<Tab>('chats');
  const [screen, setScreen] = useState<Screen>({ type: 'tabs' });
  const [currentModel, setCurrentModel] = useState('lfm2.5-1.2b-instruct');

  /** Shows an agent result (routine, skill run) as a new chat the user can continue. */
  const openResultChat = useCallback(async (title: string, text: string) => {
    const base = (await storage.getSettings()) ?? DEFAULT_SETTINGS;
    const chatId = generateChatId();
    const now = Date.now();
    await storage.saveChat({
      id: chatId,
      title: title.slice(0, 50),
      messages: [{ role: 'assistant', content: text, timestamp: now }],
      createdAt: now,
      updatedAt: now,
      model: base.model,
      settings: base,
    });
    setScreen({ type: 'chat', chatId });
  }, []);

  useEffect(() => {
    checkEngineMigration();
    const showRoutine = async (r: AgentResult | null) => {
      if (!r?.response) return;
      const rec = await agentRuntime.repo.get(r.executionId);
      const skill = rec?.request.skillId
        ? await agentRuntime.skills.get(rec.request.skillId)
        : null;
      openResultChat(skill?.manifest.name ?? 'Routine', r.response);
    };
    startAgentRuntime().then(err => {
      if (err) {
        console.warn('[LiquidChat] agent runtime unavailable:', err);
        return;
      }
      // A routine notification tapped while the app was closed.
      agentRuntime
        .handleLaunchPayload()
        .then(showRoutine)
        .catch(() => {});
    });
    // …or while it was running.
    const offLaunch = platform.alarms.onLaunchPayload(() => {
      agentRuntime
        .handleLaunchPayload()
        .then(showRoutine)
        .catch(() => {});
    });
    const sub = AppState.addEventListener('change', st => {
      if (st === 'active') agentRuntime.ingestNotifications().catch(() => {});
    });
    return () => {
      offLaunch();
      sub.remove();
    };
  }, [openResultChat]);

  /** Opens a chat pre-loaded with a meeting's minutes and transcript as context. */
  const handleAskInChat = useCallback(async (meetingId: string) => {
    const m = await meetingStore.get(meetingId);
    if (!m) return;
    const saved = await storage.getSettings();
    const base = saved ?? DEFAULT_SETTINGS;
    const transcript = transcriptPlain(m);
    const context =
      'You answer questions about the meeting below. Use only this material; say so when something was not discussed.\n\n' +
      buildMinutesMarkdown(m) +
      (transcript ? `\n\n## Transcript (may be truncated)\n${transcript.slice(0, 6000)}` : '');
    const chatId = generateChatId();
    const chat: Chat = {
      id: chatId,
      title: `About: ${m.title}`.slice(0, 50),
      messages: [],
      createdAt: Date.now(),
      updatedAt: Date.now(),
      model: base.model,
      settings: {
        ...base,
        systemPrompt: context,
        autoExecuteTools: false,
        intentRoutingEnabled: false,
      },
    };
    await storage.saveChat(chat);
    setScreen({ type: 'chat', chatId });
  }, []);

  const handleOpenChat = useCallback((chatId: string) => {
    setScreen({ type: 'chat', chatId });
  }, []);

  const handleNewChat = useCallback(() => {
    const chatId = generateChatId();
    setScreen({ type: 'chat', chatId });
  }, []);

  const handleBackToTabs = useCallback(() => {
    setScreen({ type: 'tabs' });
  }, []);

  const handleOpenModelSelector = useCallback((model: string, onSelect: (m: string) => void) => {
    setScreen({
      type: 'modelSelection',
      currentModel: model,
      onSelect: (selected: string) => {
        onSelect(selected);
        setCurrentModel(selected);
        setScreen({ type: 'tabs' });
      },
    });
  }, []);

  const handleModelSelectFromTab = useCallback((model: string, onSelect: (m: string) => void) => {
    setScreen({
      type: 'modelSelection',
      currentModel: model,
      onSelect: (selected: string) => {
        onSelect(selected);
        setCurrentModel(selected);
      },
    });
  }, []);

  const handleSelectModelDirect = useCallback(async (modelSlug: string) => {
    setCurrentModel(modelSlug);
    // Persist to storage so ChatScreen picks up the new model
    const saved = await storage.getSettings();
    const updated = { ...(saved ?? DEFAULT_SETTINGS), model: modelSlug };
    await storage.saveSettings(updated);
    refreshLocalModels().catch(() => {});
    setActiveTab('chats');
    setScreen({ type: 'tabs' });
  }, []);

  // Render current screen
  const backToAgent = () => {
    setActiveTab('agent');
    setScreen({ type: 'tabs' });
  };
  if (screen.type === 'skills') {
    return (
      <SkillsScreen
        onBack={backToAgent}
        onRunResult={text => openResultChat('Skill result', text)}
      />
    );
  }
  if (screen.type === 'memory') return <MemoryScreen onBack={backToAgent} />;
  if (screen.type === 'insights') return <AgentInsightsScreen onBack={backToAgent} />;
  if (screen.type === 'agentSettings') return <AgentSettingsScreen onBack={backToAgent} />;

  if (screen.type === 'meetingRecorder') {
    return (
      <>
        <StatusBar barStyle="light-content" backgroundColor={theme.colors.primary} />
        <MeetingRecorderScreen
          onBack={() => {
            setActiveTab('meetings');
            setScreen({ type: 'tabs' });
          }}
          onFinished={meetingId => setScreen({ type: 'meetingDetail', meetingId })}
        />
      </>
    );
  }

  if (screen.type === 'meetingDetail') {
    return (
      <>
        <StatusBar barStyle="light-content" backgroundColor={theme.colors.primary} />
        <MeetingDetailScreen
          meetingId={screen.meetingId}
          onBack={() => setScreen({ type: 'tabs' })}
          onOpenRecorder={() => setScreen({ type: 'meetingRecorder' })}
          onDraftEmail={meetingId => setScreen({ type: 'emailDraft', meetingId, back: screen })}
          onAskInChat={handleAskInChat}
        />
      </>
    );
  }

  if (screen.type === 'meetingSettings') {
    return (
      <>
        <StatusBar barStyle="light-content" backgroundColor={theme.colors.primary} />
        <MeetingSettingsScreen onBack={() => setScreen({ type: 'tabs' })} />
      </>
    );
  }

  if (screen.type === 'emailDraft') {
    return (
      <>
        <StatusBar barStyle="light-content" backgroundColor={theme.colors.primary} />
        <EmailDraftScreen meetingId={screen.meetingId} onBack={() => setScreen(screen.back)} />
      </>
    );
  }

  if (screen.type === 'chat') {
    return (
      <>
        <StatusBar barStyle="light-content" backgroundColor={theme.colors.primary} />
        <ChatScreen
          chatId={screen.chatId}
          onBack={handleBackToTabs}
          onOpenModelSelector={handleOpenModelSelector}
        />
      </>
    );
  }

  if (screen.type === 'modelSelection') {
    return (
      <>
        <StatusBar barStyle="light-content" backgroundColor={theme.colors.primary} />
        <ModelSelectionScreen
          currentModel={screen.currentModel}
          onSelectModel={(model: string) => {
            screen.onSelect(model);
            setScreen({ type: 'tabs' });
          }}
          onBack={() => setScreen({ type: 'tabs' })}
        />
      </>
    );
  }

  // Tab screen
  const renderTabContent = () => {
    switch (activeTab) {
      case 'chats':
        return <ChatListScreen onOpenChat={handleOpenChat} onNewChat={handleNewChat} />;
      case 'meetings':
        return (
          <MeetingsScreen
            onOpenMeeting={meetingId => setScreen({ type: 'meetingDetail', meetingId })}
            onOpenRecorder={() => setScreen({ type: 'meetingRecorder' })}
            onOpenSettings={() => setScreen({ type: 'meetingSettings' })}
          />
        );
      case 'tasks':
        return (
          <TasksScreen
            onOpenMeeting={meetingId => setScreen({ type: 'meetingDetail', meetingId })}
            onDraftEmail={() => setScreen({ type: 'emailDraft', back: { type: 'tabs' } })}
          />
        );
      case 'models':
        return (
          <ModelSelectionScreen
            currentModel={currentModel}
            onSelectModel={handleSelectModelDirect}
            onBack={() => setActiveTab('chats')}
          />
        );
      case 'agent':
        return <AgentDashboardScreen onOpen={section => setScreen({ type: section })} />;
      case 'settings':
        return <SettingsScreen onOpenModelSelector={handleModelSelectFromTab} />;
      default:
        return null;
    }
  };

  return (
    <View style={styles.container}>
      <StatusBar barStyle="light-content" backgroundColor={theme.colors.primary} />
      <View style={styles.content}>{renderTabContent()}</View>
      <View style={[styles.tabBar, { paddingBottom: Math.max(insets.bottom, 12) }]}>
        {TAB_CONFIG.map(tab => (
          <TouchableOpacity
            key={tab.key}
            style={[styles.tabItem, activeTab === tab.key && styles.activeTabItem]}
            onPress={() => setActiveTab(tab.key)}
          >
            <Text style={styles.tabIcon}>{tab.icon}</Text>
            <Text style={[styles.tabLabel, activeTab === tab.key && styles.activeTabLabel]}>
              {tab.label}
            </Text>
          </TouchableOpacity>
        ))}
      </View>
    </View>
  );
}

export default function App() {
  return (
    <SafeAreaProvider>
      <AppContent />
      <ApprovalHost />
    </SafeAreaProvider>
  );
}

const styles = StyleSheet.create({
  container: {
    flex: 1,
    backgroundColor: theme.colors.background,
  },
  content: {
    flex: 1,
  },
  tabBar: {
    flexDirection: 'row',
    backgroundColor: theme.colors.primary,
    borderTopWidth: 1,
    borderTopColor: theme.colors.border,
    paddingTop: 4,
  },
  tabItem: {
    flex: 1,
    alignItems: 'center',
    paddingVertical: 10,
  },
  activeTabItem: {
    borderTopWidth: 2,
    borderTopColor: theme.colors.accent,
  },
  tabIcon: {
    fontSize: 19,
    marginBottom: 2,
  },
  tabLabel: {
    fontSize: theme.fontSize.xs + 1,
    fontWeight: '600',
    color: 'rgba(255,255,255,0.6)',
  },
  activeTabLabel: {
    color: theme.colors.sunsetOrange,
  },
});
