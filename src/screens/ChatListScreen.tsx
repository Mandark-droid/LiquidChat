import React, { useEffect, useState, useCallback } from 'react';
import {
  View,
  Text,
  Image,
  TouchableOpacity,
  ScrollView,
  StyleSheet,
  Alert,
  RefreshControl,
} from 'react-native';
import { SafeAreaView } from 'react-native-safe-area-context';
import { storage } from '../utils/storage';
import { generateChatId, formatTimestamp } from '../utils/chatHelpers';
import { DEFAULT_SETTINGS, type Chat, type ChatSettings } from '../types';
import { theme } from '../config/theme';

interface ChatListScreenProps {
  onOpenChat: (chatId: string) => void;
  onNewChat: () => void;
}

export default function ChatListScreen({
  onOpenChat,
  onNewChat,
}: ChatListScreenProps) {
  const [chats, setChats] = useState<Chat[]>([]);
  const [refreshing, setRefreshing] = useState(false);

  useEffect(() => {
    loadChats();
  }, []);

  const loadChats = useCallback(async () => {
    const allChats = await storage.getAllChats();
    const sorted = allChats.sort((a, b) => b.updatedAt - a.updatedAt);
    setChats(sorted);
  }, []);

  const onRefresh = useCallback(async () => {
    setRefreshing(true);
    await loadChats();
    setRefreshing(false);
  }, [loadChats]);

  const handleNewChat = async () => {
    const chatId = generateChatId();
    const saved = await storage.getSettings();
    const settings: ChatSettings = saved ?? DEFAULT_SETTINGS;
    const newChat: Chat = {
      id: chatId,
      title: 'New Chat',
      messages: [],
      createdAt: Date.now(),
      updatedAt: Date.now(),
      model: settings.model,
      settings,
    };
    await storage.saveChat(newChat);
    onOpenChat(chatId);
  };

  const handleDeleteChat = (chatId: string, title: string) => {
    Alert.alert('Delete Chat', `Delete "${title}"?`, [
      { text: 'Cancel', style: 'cancel' },
      {
        text: 'Delete',
        style: 'destructive',
        onPress: async () => {
          await storage.deleteChat(chatId);
          await loadChats();
        },
      },
    ]);
  };

  const handleClearAll = () => {
    if (chats.length === 0) return;
    Alert.alert(
      'Clear All Chats',
      `This will delete all ${chats.length} chats. This cannot be undone.`,
      [
        { text: 'Cancel', style: 'cancel' },
        {
          text: 'Clear All',
          style: 'destructive',
          onPress: async () => {
            for (const chat of chats) {
              await storage.deleteChat(chat.id);
            }
            await loadChats();
          },
        },
      ],
    );
  };

  const getMessagePreview = (chat: Chat): string => {
    if (chat.messages.length === 0) return 'No messages yet';
    const last = chat.messages[chat.messages.length - 1];
    const prefix = last.role === 'user' ? 'You: ' : '';
    const content = last.content || '';
    return prefix + (content.length > 80 ? content.slice(0, 80) + '...' : content);
  };

  const getMessageCount = (chat: Chat): string => {
    const count = chat.messages.filter(m => m.role !== 'system').length;
    return `${count} message${count !== 1 ? 's' : ''}`;
  };

  return (
    <SafeAreaView style={styles.container}>
      <View style={styles.header}>
        <View style={styles.headerBrand}>
          <Image
            source={require('../assets/liquidchat_logo.png')}
            style={styles.headerLogo}
          />
          <Text style={styles.headerTitle}>LiquidChat</Text>
        </View>
        <View style={styles.headerActions}>
          {chats.length > 0 && (
            <TouchableOpacity onPress={handleClearAll} style={styles.clearButton}>
              <Text style={styles.clearButtonText}>Clear All</Text>
            </TouchableOpacity>
          )}
          <TouchableOpacity onPress={handleNewChat} style={styles.newChatButton}>
            <Text style={styles.newChatButtonText}>+ New</Text>
          </TouchableOpacity>
        </View>
      </View>

      <ScrollView
        style={styles.chatList}
        contentContainerStyle={
          chats.length === 0 ? styles.emptyContainer : styles.listContent
        }
        refreshControl={
          <RefreshControl
            refreshing={refreshing}
            onRefresh={onRefresh}
            tintColor={theme.colors.accent}
          />
        }
      >
        {chats.length === 0 ? (
          <View style={styles.emptyState}>
            <Image
              source={require('../assets/liquidchat_icon.png')}
              style={styles.emptyLogo}
            />
            <Text style={styles.emptyTitle}>No Chats Yet</Text>
            <Text style={styles.emptySubtitle}>
              Tap "+ New" to start a conversation
            </Text>
          </View>
        ) : (
          chats.map(chat => (
            <TouchableOpacity
              key={chat.id}
              style={styles.chatItem}
              onPress={() => onOpenChat(chat.id)}
              onLongPress={() => handleDeleteChat(chat.id, chat.title)}
              activeOpacity={0.7}
            >
              <View style={styles.chatItemContent}>
                <View style={styles.chatItemHeader}>
                  <Text style={styles.chatTitle} numberOfLines={1}>
                    {chat.title}
                  </Text>
                  <Text style={styles.chatTimestamp}>
                    {formatTimestamp(chat.updatedAt)}
                  </Text>
                </View>
                <Text style={styles.chatPreview} numberOfLines={2}>
                  {getMessagePreview(chat)}
                </Text>
                <View style={styles.chatMeta}>
                  <Text style={styles.chatModel}>{chat.model}</Text>
                  <Text style={styles.chatCount}>{getMessageCount(chat)}</Text>
                </View>
              </View>
            </TouchableOpacity>
          ))
        )}
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
  headerBrand: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: 10,
  },
  headerLogo: {
    width: 32,
    height: 32,
    borderRadius: 8,
  },
  headerTitle: {
    fontSize: theme.fontSize.xxl,
    fontWeight: '700',
    color: theme.colors.textLight,
  },
  headerActions: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: theme.spacing.sm,
  },
  clearButton: {
    paddingHorizontal: theme.spacing.md,
    paddingVertical: theme.spacing.sm,
  },
  clearButtonText: {
    color: '#FFAAAA',
    fontSize: theme.fontSize.sm,
    fontWeight: '600',
  },
  newChatButton: {
    backgroundColor: theme.colors.secondary,
    paddingHorizontal: theme.spacing.lg,
    paddingVertical: theme.spacing.sm,
    borderRadius: theme.borderRadius.sm,
  },
  newChatButtonText: {
    color: theme.colors.textLight,
    fontSize: theme.fontSize.md,
    fontWeight: '700',
  },
  chatList: {
    flex: 1,
  },
  listContent: {
    paddingVertical: theme.spacing.sm,
  },
  emptyContainer: {
    flex: 1,
    justifyContent: 'center',
    alignItems: 'center',
  },
  emptyState: {
    alignItems: 'center',
    paddingTop: 60,
  },
  emptyLogo: {
    width: 120,
    height: 140,
    resizeMode: 'contain',
    marginBottom: 20,
  },
  emptyTitle: {
    fontSize: theme.fontSize.xl,
    fontWeight: '700',
    color: theme.colors.text,
    marginBottom: theme.spacing.sm,
  },
  emptySubtitle: {
    fontSize: theme.fontSize.md,
    color: theme.colors.textSecondary,
  },
  chatItem: {
    backgroundColor: theme.colors.surface,
    marginHorizontal: theme.spacing.lg,
    marginVertical: theme.spacing.xs,
    borderRadius: theme.borderRadius.md,
    borderWidth: 1,
    borderColor: theme.colors.border,
  },
  chatItemContent: {
    padding: theme.spacing.lg,
  },
  chatItemHeader: {
    flexDirection: 'row',
    justifyContent: 'space-between',
    alignItems: 'center',
    marginBottom: theme.spacing.xs,
  },
  chatTitle: {
    flex: 1,
    fontSize: theme.fontSize.lg,
    fontWeight: '600',
    color: theme.colors.text,
    marginRight: theme.spacing.md,
  },
  chatTimestamp: {
    fontSize: theme.fontSize.xs,
    color: theme.colors.textMuted,
  },
  chatPreview: {
    fontSize: theme.fontSize.md,
    color: theme.colors.textSecondary,
    marginBottom: theme.spacing.sm,
    lineHeight: 20,
  },
  chatMeta: {
    flexDirection: 'row',
    justifyContent: 'space-between',
    alignItems: 'center',
  },
  chatModel: {
    fontSize: theme.fontSize.xs,
    color: theme.colors.accent,
    fontWeight: '500',
  },
  chatCount: {
    fontSize: theme.fontSize.xs,
    color: theme.colors.textMuted,
  },
});
