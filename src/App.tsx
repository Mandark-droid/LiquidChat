import React, { useState, useCallback } from 'react';
import {
  View,
  Text,
  TouchableOpacity,
  StyleSheet,
  StatusBar,
} from 'react-native';
import {
  SafeAreaProvider,
  useSafeAreaInsets,
} from 'react-native-safe-area-context';
import ChatListScreen from './screens/ChatListScreen';
import ChatScreen from './screens/ChatScreen';
import ModelSelectionScreen from './screens/ModelSelectionScreen';
import SettingsScreen from './screens/SettingsScreen';
import AgentDashboardScreen from './screens/AgentDashboardScreen';
import { generateChatId } from './utils/chatHelpers';
import { storage } from './utils/storage';
import { DEFAULT_SETTINGS } from './types';
import { theme } from './config/theme';

type Tab = 'chats' | 'models' | 'agent' | 'settings';
type Screen =
  | { type: 'tabs' }
  | { type: 'chat'; chatId: string }
  | {
      type: 'modelSelection';
      currentModel: string;
      onSelect: (model: string) => void;
    };

const TAB_CONFIG: { key: Tab; label: string; icon: string }[] = [
  { key: 'chats', label: 'Chats', icon: '💬' },
  { key: 'models', label: 'Models', icon: '🤖' },
  { key: 'agent', label: 'Agent', icon: '🧠' },
  { key: 'settings', label: 'Settings', icon: '⚙️' },
];

function AppContent() {
  const insets = useSafeAreaInsets();
  const [activeTab, setActiveTab] = useState<Tab>('chats');
  const [screen, setScreen] = useState<Screen>({ type: 'tabs' });
  const [currentModel, setCurrentModel] = useState('lfm2-1.2b');

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

  const handleOpenModelSelector = useCallback(
    (model: string, onSelect: (m: string) => void) => {
      setScreen({
        type: 'modelSelection',
        currentModel: model,
        onSelect: (selected: string) => {
          onSelect(selected);
          setCurrentModel(selected);
          setScreen({ type: 'tabs' });
        },
      });
    },
    [],
  );

  const handleModelSelectFromTab = useCallback(
    (model: string, onSelect: (m: string) => void) => {
      setScreen({
        type: 'modelSelection',
        currentModel: model,
        onSelect: (selected: string) => {
          onSelect(selected);
          setCurrentModel(selected);
        },
      });
    },
    [],
  );

  const handleSelectModelDirect = useCallback(
    async (modelSlug: string) => {
      setCurrentModel(modelSlug);
      // Persist to storage so ChatScreen picks up the new model
      const saved = await storage.getSettings();
      const updated = { ...(saved ?? DEFAULT_SETTINGS), model: modelSlug };
      await storage.saveSettings(updated);
      setActiveTab('chats');
      setScreen({ type: 'tabs' });
    },
    [],
  );

  // Render current screen
  if (screen.type === 'chat') {
    return (
      <>
        <StatusBar
          barStyle="light-content"
          backgroundColor={theme.colors.primary}
        />
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
        <StatusBar
          barStyle="light-content"
          backgroundColor={theme.colors.primary}
        />
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
        return (
          <ChatListScreen
            onOpenChat={handleOpenChat}
            onNewChat={handleNewChat}
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
        return <AgentDashboardScreen />;
      case 'settings':
        return (
          <SettingsScreen
            onOpenModelSelector={handleModelSelectFromTab}
          />
        );
      default:
        return null;
    }
  };

  return (
    <View style={styles.container}>
      <StatusBar
        barStyle="light-content"
        backgroundColor={theme.colors.primary}
      />
      <View style={styles.content}>{renderTabContent()}</View>
      <View
        style={[
          styles.tabBar,
          { paddingBottom: Math.max(insets.bottom, 12) },
        ]}
      >
        {TAB_CONFIG.map(tab => (
          <TouchableOpacity
            key={tab.key}
            style={[
              styles.tabItem,
              activeTab === tab.key && styles.activeTabItem,
            ]}
            onPress={() => setActiveTab(tab.key)}
          >
            <Text style={styles.tabIcon}>{tab.icon}</Text>
            <Text
              style={[
                styles.tabLabel,
                activeTab === tab.key && styles.activeTabLabel,
              ]}
            >
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
    fontSize: 20,
    marginBottom: 2,
  },
  tabLabel: {
    fontSize: theme.fontSize.sm,
    fontWeight: '600',
    color: 'rgba(255,255,255,0.6)',
  },
  activeTabLabel: {
    color: theme.colors.sunsetOrange,
  },
});
