import React, { useState, useEffect } from 'react';
import { View, Text, TouchableOpacity, StyleSheet, ActivityIndicator } from 'react-native';
import { executeTool } from '../tools/registry';
import { theme } from '../config/theme';
import type { ToolCall, ToolResult } from '../types';

interface ToolCallCardProps {
  toolCall: ToolCall;
  autoExecute?: boolean;
  onResult?: (result: ToolResult) => void;
}

type ExecutionStatus = 'pending' | 'executing' | 'success' | 'error';

const TOOL_ICONS: Record<string, string> = {
  turn_on_flashlight: '🔦',
  turn_off_flashlight: '🔦',
  open_wifi_settings: '📶',
  create_calendar_event: '📅',
  send_email: '✉️',
  show_map: '🗺️',
  create_contact: '👤',
};

const ToolCallCard: React.FC<ToolCallCardProps> = ({
  toolCall,
  autoExecute = true,
  onResult,
}) => {
  const [status, setStatus] = useState<ExecutionStatus>('pending');
  const [result, setResult] = useState<ToolResult | null>(null);

  useEffect(() => {
    if (autoExecute && status === 'pending') {
      handleExecute();
    }
  }, [autoExecute]);

  const handleExecute = async () => {
    setStatus('executing');
    try {
      const execResult = await executeTool(toolCall.name, toolCall.arguments);
      setResult(execResult);
      setStatus(execResult.success ? 'success' : 'error');
      onResult?.(execResult);
    } catch (error) {
      const errorResult: ToolResult = {
        success: false,
        message: `Execution failed: ${error instanceof Error ? error.message : String(error)}`,
      };
      setResult(errorResult);
      setStatus('error');
      onResult?.(errorResult);
    }
  };

  const icon = TOOL_ICONS[toolCall.name] || '⚙️';
  const statusColor =
    status === 'success' ? theme.colors.success :
    status === 'error' ? theme.colors.error :
    status === 'executing' ? theme.colors.warning :
    theme.colors.textMuted;

  return (
    <View style={styles.container}>
      <View style={styles.header}>
        <Text style={styles.icon}>{icon}</Text>
        <Text style={styles.functionName}>{toolCall.name}</Text>
        <View style={[styles.statusBadge, { backgroundColor: statusColor }]}>
          <Text style={styles.statusText}>
            {status === 'executing' ? 'Running...' : status}
          </Text>
        </View>
      </View>

      {Object.keys(toolCall.arguments).length > 0 && (
        <View style={styles.params}>
          {Object.entries(toolCall.arguments).map(([key, value]) => (
            <View key={key} style={styles.paramRow}>
              <Text style={styles.paramKey}>{key}:</Text>
              <Text style={styles.paramValue}>{String(value)}</Text>
            </View>
          ))}
        </View>
      )}

      {status === 'executing' && (
        <ActivityIndicator size="small" color={theme.colors.accent} style={styles.spinner} />
      )}

      {result && (
        <View style={[styles.resultContainer, !result.success && styles.resultError]}>
          <Text style={styles.resultText}>{result.message}</Text>
        </View>
      )}

      {status === 'pending' && !autoExecute && (
        <TouchableOpacity style={styles.executeButton} onPress={handleExecute}>
          <Text style={styles.executeButtonText}>Execute</Text>
        </TouchableOpacity>
      )}
    </View>
  );
};

export default ToolCallCard;

const styles = StyleSheet.create({
  container: {
    backgroundColor: theme.colors.toolCallBg,
    borderRadius: 12,
    borderWidth: 1,
    borderColor: theme.colors.toolCallBorder,
    padding: 12,
    marginVertical: 4,
  },
  header: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: 8,
    marginBottom: 8,
  },
  icon: { fontSize: 20 },
  functionName: {
    flex: 1,
    fontSize: 14,
    fontWeight: '700',
    color: theme.colors.accent,
    fontFamily: 'monospace',
  },
  statusBadge: {
    paddingHorizontal: 8,
    paddingVertical: 2,
    borderRadius: 10,
  },
  statusText: {
    fontSize: 10,
    fontWeight: '600',
    color: '#000',
    textTransform: 'uppercase',
  },
  params: {
    backgroundColor: 'rgba(0,0,0,0.05)',
    borderRadius: 8,
    padding: 8,
    marginBottom: 8,
  },
  paramRow: {
    flexDirection: 'row',
    gap: 8,
    marginBottom: 2,
  },
  paramKey: {
    fontSize: 12,
    color: theme.colors.textMuted,
    fontFamily: 'monospace',
  },
  paramValue: {
    fontSize: 12,
    color: theme.colors.text,
    flex: 1,
  },
  spinner: { marginVertical: 8 },
  resultContainer: {
    backgroundColor: 'rgba(0, 230, 118, 0.1)',
    borderRadius: 8,
    padding: 8,
    borderLeftWidth: 3,
    borderLeftColor: theme.colors.success,
  },
  resultError: {
    backgroundColor: 'rgba(255, 82, 82, 0.1)',
    borderLeftColor: theme.colors.error,
  },
  resultText: {
    fontSize: 12,
    color: theme.colors.textSecondary,
  },
  executeButton: {
    backgroundColor: theme.colors.accent,
    borderRadius: 8,
    paddingVertical: 8,
    alignItems: 'center',
  },
  executeButtonText: {
    color: '#000',
    fontWeight: '700',
    fontSize: 14,
  },
});
