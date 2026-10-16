/**
 * Contracts between the TypeScript runtime and Android native modules.
 * Implementations live in src/platform/android.ts (NativeModules) and tests
 * use in-memory fakes, so the runtime never imports NativeModules directly.
 */
import type { Distribution, PermissionId } from '../tools/types';

export type ThermalStatus =
  'none' | 'light' | 'moderate' | 'severe' | 'critical' | 'emergency' | 'shutdown' | 'unknown';

export interface DeviceSnapshot {
  batteryPercent: number; // 0-100, -1 unknown
  charging: boolean;
  powerSaveMode: boolean;
  thermal: ThermalStatus;
  online: boolean;
  unmetered: boolean;
  availableRamMb: number;
  totalRamMb: number;
  lowMemory: boolean;
  timestamp: number;
}

export interface DeviceContextProvider {
  snapshot(): Promise<DeviceSnapshot>;
  distribution(): Distribution;
}

export interface PermissionChecker {
  check(permission: PermissionId): Promise<boolean>;
  /** Shows the system dialog or opens the right settings screen. Resolves to the new state. */
  request(permission: PermissionId): Promise<boolean>;
}

export interface CredentialStore {
  get(key: string): Promise<string | null>;
  set(key: string, value: string): Promise<void>;
  delete(key: string): Promise<void>;
  has(key: string): Promise<boolean>;
  /** 32-byte hex key for SQLCipher, created on first use, wrapped by Android Keystore. */
  databaseKey(): Promise<string>;
}

export interface AlarmSpec {
  id: string; // schedule id
  triggerAtMs: number;
  title: string;
  body: string;
  /** Delivered back to JS when the user taps the notification. */
  payload: string;
}

export interface AlarmScheduler {
  schedule(alarm: AlarmSpec): Promise<void>;
  cancel(id: string): Promise<void>;
  /** Payload of the notification that launched the app, consumed once. */
  consumeLaunchPayload(): Promise<string | null>;
}

export interface CapturedNotification {
  key: string;
  packageName: string;
  appLabel: string;
  title: string;
  text: string;
  category?: string;
  postedAt: number;
  isOngoing: boolean;
}

export interface NotificationSource {
  isAccessGranted(): Promise<boolean>;
  openAccessSettings(): Promise<void>;
  /** Notifications captured by the native listener since the last drain. */
  drain(): Promise<CapturedNotification[]>;
  setFilters(filters: { allow: string[]; block: string[]; retentionDays: number }): Promise<void>;
  subscribe(cb: (n: CapturedNotification) => void): () => void;
}

export interface DeviceStateReader {
  /** For verifiers: read back state after a tool changed it. */
  getInterruptionFilter(): Promise<'all' | 'priority' | 'alarms' | 'none' | 'unknown'>;
  getStreamVolumePercent(stream: string): Promise<number>;
}
