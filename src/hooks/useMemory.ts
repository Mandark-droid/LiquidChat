import { useState, useCallback, useEffect, useRef } from 'react';
import { memoryService } from '../services/MemoryService';
import type { MemoryResult } from '../types';

export interface UseMemoryReturn {
  isReady: boolean;
  isInitializing: boolean;
  isRecalling: boolean;
  relevantMemories: MemoryResult[];
  recallForMessage: (text: string) => Promise<MemoryResult[]>;
  rememberInteraction: (userMsg: string, assistantMsg: string) => Promise<void>;
  clearRecalled: () => void;
}

export function useMemory(enabled: boolean, embeddingModel?: string): UseMemoryReturn {
  const [isReady, setIsReady] = useState(memoryService.isInitialized);
  const [isInitializing, setIsInitializing] = useState(false);
  const [isRecalling, setIsRecalling] = useState(false);
  const [relevantMemories, setRelevantMemories] = useState<MemoryResult[]>([]);
  const initAttempted = useRef(false);

  useEffect(() => {
    if (!enabled) {
      setIsReady(false);
      return;
    }

    if (memoryService.isInitialized) {
      setIsReady(true);
      return;
    }

    if (initAttempted.current) return;
    initAttempted.current = true;

    setIsInitializing(true);
    memoryService
      .init(embeddingModel)
      .then(() => {
        setIsReady(true);
      })
      .catch(e => {
        console.warn('[useMemory] Init failed:', e);
        setIsReady(false);
      })
      .finally(() => {
        setIsInitializing(false);
      });
  }, [enabled, embeddingModel]);

  const recallForMessage = useCallback(
    async (text: string): Promise<MemoryResult[]> => {
      if (!enabled || !memoryService.isInitialized) return [];

      setIsRecalling(true);
      try {
        const results = await memoryService.recall(text, 3);
        const filtered = results.filter(r => r.score >= 0.7);
        setRelevantMemories(filtered);
        return filtered;
      } catch (e) {
        console.warn('[useMemory] Recall failed:', e);
        return [];
      } finally {
        setIsRecalling(false);
      }
    },
    [enabled],
  );

  const rememberInteraction = useCallback(
    async (userMsg: string, assistantMsg: string): Promise<void> => {
      if (!enabled || !memoryService.isInitialized) return;

      try {
        // Create a concise summary for embedding
        const userSnippet = userMsg.length > 100 ? userMsg.slice(0, 100) + '...' : userMsg;
        const assistantSnippet = assistantMsg.length > 100 ? assistantMsg.slice(0, 100) + '...' : assistantMsg;
        const summary = `User asked about ${userSnippet}. Assistant responded: ${assistantSnippet}`;
        await memoryService.remember(summary, {
          type: 'interaction',
          userMessage: userMsg,
          assistantMessage: assistantMsg,
        });
      } catch (e) {
        console.warn('[useMemory] Remember failed:', e);
      }
    },
    [enabled],
  );

  const clearRecalled = useCallback(() => {
    setRelevantMemories([]);
  }, []);

  return {
    isReady,
    isInitializing,
    isRecalling,
    relevantMemories,
    recallForMessage,
    rememberInteraction,
    clearRecalled,
  };
}
