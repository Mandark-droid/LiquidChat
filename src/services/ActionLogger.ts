import AsyncStorage from '@react-native-async-storage/async-storage';

const STORAGE_KEY = '@liquidchat_action_log';
const MAX_ENTRIES = 500;

export interface ActionLogEntry {
  id: string;
  timestamp: number;
  toolName: string;
  arguments: Record<string, any>;
  success: boolean;
  message: string;
  modelSlug: string;
  durationMs: number;
}

interface ToolStats {
  toolName: string;
  totalCalls: number;
  successCount: number;
  failCount: number;
  avgDurationMs: number;
}

class ActionLogger {
  private entries: ActionLogEntry[] = [];
  private initialized = false;

  async init(): Promise<void> {
    if (this.initialized) return;
    try {
      const raw = await AsyncStorage.getItem(STORAGE_KEY);
      if (raw) {
        this.entries = JSON.parse(raw);
      }
    } catch (e) {
      console.warn('[ActionLogger] Failed to load:', e);
      this.entries = [];
    }
    this.initialized = true;
  }

  async log(entry: Omit<ActionLogEntry, 'id' | 'timestamp'>): Promise<void> {
    if (!this.initialized) await this.init();

    const full: ActionLogEntry = {
      ...entry,
      id: Date.now().toString(36) + Math.random().toString(36).slice(2, 6),
      timestamp: Date.now(),
    };

    this.entries.push(full);

    // Ring buffer: drop oldest when over limit
    if (this.entries.length > MAX_ENTRIES) {
      this.entries = this.entries.slice(this.entries.length - MAX_ENTRIES);
    }

    this.persist();
  }

  getRecent(count: number = 20): ActionLogEntry[] {
    return this.entries.slice(-count).reverse();
  }

  getStats(): { total: number; success: number; fail: number; avgDurationMs: number } {
    const total = this.entries.length;
    const success = this.entries.filter(e => e.success).length;
    const fail = total - success;
    const avgDurationMs = total > 0
      ? Math.round(this.entries.reduce((sum, e) => sum + e.durationMs, 0) / total)
      : 0;
    return { total, success, fail, avgDurationMs };
  }

  getStatsByTool(): ToolStats[] {
    const map = new Map<string, { total: number; success: number; totalDuration: number }>();

    for (const entry of this.entries) {
      const existing = map.get(entry.toolName) ?? { total: 0, success: 0, totalDuration: 0 };
      existing.total++;
      if (entry.success) existing.success++;
      existing.totalDuration += entry.durationMs;
      map.set(entry.toolName, existing);
    }

    return Array.from(map.entries()).map(([toolName, stats]) => ({
      toolName,
      totalCalls: stats.total,
      successCount: stats.success,
      failCount: stats.total - stats.success,
      avgDurationMs: Math.round(stats.totalDuration / stats.total),
    }));
  }

  async clear(): Promise<void> {
    this.entries = [];
    await AsyncStorage.removeItem(STORAGE_KEY);
  }

  private async persist(): Promise<void> {
    try {
      await AsyncStorage.setItem(STORAGE_KEY, JSON.stringify(this.entries));
    } catch (e) {
      console.warn('[ActionLogger] Failed to persist:', e);
    }
  }
}

export const actionLogger = new ActionLogger();
