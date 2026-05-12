import { useState, useCallback, useRef } from 'react';
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

/**
 * Lazy-init memory hook.
 * The embedding model is NOT loaded eagerly on mount — it initializes on first
 * use (recall or remember). This avoids native-level conflicts with the chat
 * model's init() and complete() calls, which deadlock when two CactusLM
 * instances run init() concurrently.
 */
export function useMemory(enabled: boolean, embeddingModel?: string): UseMemoryReturn {
  const [isReady, setIsReady] = useState(memoryService.isInitialized);
  const [isInitializing, setIsInitializing] = useState(false);
  const [isRecalling, setIsRecalling] = useState(false);
  const [relevantMemories, setRelevantMemories] = useState<MemoryResult[]>([]);
  const initPromiseRef = useRef<Promise<boolean> | null>(null);

  const ensureInit = useCallback(async (): Promise<boolean> => {
    if (!enabled) return false;
    if (memoryService.isInitialized) {
      setIsReady(true);
      return true;
    }

    // Deduplicate concurrent init calls
    if (initPromiseRef.current) return initPromiseRef.current;

    const promise = (async () => {
      setIsInitializing(true);
      try {
        await memoryService.init(embeddingModel);
        setIsReady(true);
        return true;
      } catch (e) {
        console.warn('[useMemory] Init failed:', e);
        setIsReady(false);
        return false;
      } finally {
        setIsInitializing(false);
        initPromiseRef.current = null;
      }
    })();

    initPromiseRef.current = promise;
    return promise;
  }, [enabled, embeddingModel]);

  const recallForMessage = useCallback(
    async (text: string): Promise<MemoryResult[]> => {
      if (!enabled) return [];

      const ready = await ensureInit();
      if (!ready) return [];

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
    [enabled, ensureInit],
  );

  const rememberInteraction = useCallback(
    async (userMsg: string, assistantMsg: string): Promise<void> => {
      if (!enabled) return;

      const ready = await ensureInit();
      if (!ready) return;

      try {
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
    [enabled, ensureInit],
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
