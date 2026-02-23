import React, { useState } from 'react';
import {
  View,
  Text,
  TouchableOpacity,
  StyleSheet,
  Alert,
  Share,
} from 'react-native';
import ToolCallCard from './ToolCallCard';
import { theme } from '../config/theme';
import type { ChatMessage, ToolResult } from '../types';

interface MessageBubbleProps {
  message: ChatMessage;
  isStreaming?: boolean;
  autoExecuteTools?: boolean;
  onToolResult?: (result: ToolResult) => void;
}

const MessageBubble: React.FC<MessageBubbleProps> = ({
  message,
  isStreaming = false,
  autoExecuteTools = true,
  onToolResult,
}) => {
  const [expandedThinking, setExpandedThinking] = useState(false);
  const isUser = message.role === 'user';
  const isTool = message.role === 'tool';

  const handleLongPress = () => {
    const cleanedContent = stripThinkingTags(cleanSpecialTokens(message.content));
    Alert.alert(
      isUser ? 'Message Options' : 'Assistant Message',
      'Choose an action:',
      [
        {
          text: 'Copy',
          onPress: () => {
            // Use Clipboard API
            try {
              const { Clipboard } = require('react-native');
              Clipboard.setString(cleanedContent);
            } catch {}
          },
        },
        {
          text: 'Share',
          onPress: async () => {
            try { await Share.share({ message: cleanedContent }); } catch {}
          },
        },
        { text: 'Cancel', style: 'cancel' },
      ]
    );
  };

  const parseThinkingContent = (content: string) => {
    content = cleanSpecialTokens(content);
    const thinkRegex = /<think>([\s\S]*?)<\/think>/g;
    const parts: Array<{ type: 'text' | 'thinking'; content: string }> = [];
    let lastIndex = 0;
    let match;

    while ((match = thinkRegex.exec(content)) !== null) {
      if (match.index > lastIndex) {
        parts.push({ type: 'text', content: content.substring(lastIndex, match.index) });
      }
      parts.push({ type: 'thinking', content: match[1].trim() });
      lastIndex = match.index + match[0].length;
    }

    if (lastIndex < content.length) {
      parts.push({ type: 'text', content: content.substring(lastIndex) });
    }

    return parts.length > 0 ? parts : [{ type: 'text' as const, content }];
  };

  if (isTool && message.toolResult) {
    return (
      <View style={styles.toolResultContainer}>
        <Text style={styles.toolResultLabel}>Tool Result</Text>
        <Text style={[
          styles.toolResultText,
          message.toolResult.success ? styles.toolResultSuccess : styles.toolResultError,
        ]}>
          {message.toolResult.message}
        </Text>
      </View>
    );
  }

  return (
    <View style={[styles.row, isUser ? styles.userRow : styles.assistantRow]}>
      <TouchableOpacity
        activeOpacity={0.8}
        onLongPress={handleLongPress}
        style={[styles.bubble, isUser ? styles.userBubble : styles.assistantBubble]}
      >
        {parseThinkingContent(message.content).map((part, idx) => {
          if (part.type === 'thinking') {
            return (
              <View key={idx} style={styles.thinkingContainer}>
                <TouchableOpacity
                  style={styles.thinkingHeader}
                  onPress={() => setExpandedThinking(!expandedThinking)}
                >
                  <Text style={styles.thinkingLabel}>Thinking {expandedThinking ? '▼' : '▶'}</Text>
                </TouchableOpacity>
                {expandedThinking && (
                  <Text style={styles.thinkingText}>{part.content}</Text>
                )}
              </View>
            );
          }
          return part.content.trim() ? (
            <Text key={idx} style={[styles.messageText, isUser && styles.userMessageText]} selectable={!isUser}>
              {part.content}
            </Text>
          ) : null;
        })}

        {message.toolCalls && message.toolCalls.map((tc, idx) => (
          <ToolCallCard
            key={idx}
            toolCall={tc}
            autoExecute={autoExecuteTools}
            onResult={onToolResult}
          />
        ))}

        {isStreaming && (
          <Text style={styles.streamingIndicator}>●</Text>
        )}

        {message.tokens && !isStreaming && (
          <Text style={styles.tokenInfo}>
            {message.tokens} tokens
            {message.timeToFirstTokenMs ? ` · TTFT: ${message.timeToFirstTokenMs}ms` : ''}
            {message.tokensPerSecond ? ` · ${message.tokensPerSecond.toFixed(1)} t/s` : ''}
          </Text>
        )}
      </TouchableOpacity>
    </View>
  );
};

function stripThinkingTags(text: string): string {
  return text.replace(/<think>[\s\S]*?<\/think>/g, '');
}

function cleanSpecialTokens(text: string): string {
  return text
    .replace(/<\|?im_end\|?>/g, '')
    .replace(/<\|?im_start\|?>/g, '')
    .replace(/<\|?endoftext\|?>/g, '')
    .trim();
}

export default MessageBubble;

const styles = StyleSheet.create({
  row: { flexDirection: 'row', marginBottom: 8, paddingHorizontal: 4 },
  userRow: { justifyContent: 'flex-end' },
  assistantRow: { justifyContent: 'flex-start' },
  bubble: { padding: 12, borderRadius: 16, maxWidth: '85%', flexShrink: 1 },
  userBubble: { backgroundColor: theme.colors.userBubble, borderBottomRightRadius: 4 },
  assistantBubble: { backgroundColor: theme.colors.assistantBubble, borderBottomLeftRadius: 4, borderWidth: 1, borderColor: theme.colors.border },
  messageText: { fontSize: 15, color: theme.colors.text, lineHeight: 22, flexWrap: 'wrap' },
  userMessageText: { color: '#FFFFFF' },
  thinkingContainer: {
    backgroundColor: 'rgba(74, 103, 65, 0.1)',
    borderRadius: 8,
    padding: 8,
    marginVertical: 4,
    borderWidth: 1,
    borderColor: 'rgba(74, 103, 65, 0.3)',
  },
  thinkingHeader: { flexDirection: 'row', alignItems: 'center' },
  thinkingLabel: { fontSize: 12, fontWeight: '600', color: theme.colors.secondary },
  thinkingText: { fontSize: 12, color: theme.colors.textSecondary, marginTop: 6, fontStyle: 'italic' },
  tokenInfo: { fontSize: 10, color: theme.colors.textMuted, marginTop: 6 },
  streamingIndicator: { color: theme.colors.accent, fontSize: 16, marginTop: 4 },
  toolResultContainer: {
    marginHorizontal: 12,
    marginBottom: 8,
    padding: 8,
    borderRadius: 8,
    backgroundColor: theme.colors.surface,
  },
  toolResultLabel: { fontSize: 10, color: theme.colors.textMuted, marginBottom: 4, textTransform: 'uppercase' },
  toolResultText: { fontSize: 12, color: theme.colors.text },
  toolResultSuccess: { color: theme.colors.success },
  toolResultError: { color: theme.colors.error },
});
