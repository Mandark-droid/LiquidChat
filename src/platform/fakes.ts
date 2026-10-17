/**
 * In-memory implementations of every platform contract, for Jest. Each fake exposes
 * its state so tests can arrange and assert without touching NativeModules.
 */
import type { Distribution, PermissionId } from '../tools/types';
import type {
  AlarmScheduler,
  AlarmSpec,
  CapturedNotification,
  CredentialStore,
  DeviceContextProvider,
  DeviceSnapshot,
  DeviceStateReader,
  NotificationSource,
  PermissionChecker,
} from './types';

export const DEFAULT_SNAPSHOT: DeviceSnapshot = {
  batteryPercent: 80,
  charging: false,
  powerSaveMode: false,
  thermal: 'none',
  online: true,
  unmetered: true,
  availableRamMb: 4096,
  totalRamMb: 8192,
  lowMemory: false,
  timestamp: 0,
};

// --- DeviceContextProvider -------------------------------------------------------

export class FakeDeviceContext implements DeviceContextProvider {
  snapshotValue: DeviceSnapshot;
  distributionValue: Distribution;
  snapshotCalls = 0;

  constructor(opts: { snapshot?: Partial<DeviceSnapshot>; distribution?: Distribution } = {}) {
    this.snapshotValue = { ...DEFAULT_SNAPSHOT, ...opts.snapshot };
    this.distributionValue = opts.distribution ?? 'full';
  }

  setSnapshot(patch: Partial<DeviceSnapshot>): void {
    this.snapshotValue = { ...this.snapshotValue, ...patch };
  }

  async snapshot(): Promise<DeviceSnapshot> {
    this.snapshotCalls++;
    return { ...this.snapshotValue, timestamp: this.snapshotValue.timestamp || Date.now() };
  }

  distribution(): Distribution {
    return this.distributionValue;
  }
}

// --- PermissionChecker --------------------------------------------------------------

export class FakePermissionChecker implements PermissionChecker {
  readonly granted: Map<PermissionId, boolean>;
  /** What request() turns a permission into (default: grants it). */
  readonly requestOutcome = new Map<PermissionId, boolean>();
  readonly requested: PermissionId[] = [];

  constructor(initial: Partial<Record<PermissionId, boolean>> = {}) {
    this.granted = new Map(Object.entries(initial) as [PermissionId, boolean][]);
    if (!this.granted.has('special:network')) this.granted.set('special:network', true);
  }

  set(permission: PermissionId, granted: boolean): void {
    this.granted.set(permission, granted);
  }

  /** Make request(permission) resolve to `outcome` (false = user denies). */
  onRequest(permission: PermissionId, outcome: boolean): void {
    this.requestOutcome.set(permission, outcome);
  }

  async check(permission: PermissionId): Promise<boolean> {
    return this.granted.get(permission) ?? false;
  }

  async request(permission: PermissionId): Promise<boolean> {
    this.requested.push(permission);
    if (this.granted.get(permission)) return true;
    const outcome = this.requestOutcome.get(permission) ?? true;
    this.granted.set(permission, outcome);
    return outcome;
  }
}

// --- CredentialStore ----------------------------------------------------------------

export class FakeCredentialStore implements CredentialStore {
  readonly values = new Map<string, string>();
  private dbKey: string | null = null;
  /** When set, every call rejects with this error (simulates a Keystore failure). */
  failWith: Error | null = null;

  private guard(): void {
    if (this.failWith) throw this.failWith;
  }

  async get(key: string): Promise<string | null> {
    this.guard();
    return this.values.get(key) ?? null;
  }

  async set(key: string, value: string): Promise<void> {
    this.guard();
    this.values.set(key, value);
  }

  async delete(key: string): Promise<void> {
    this.guard();
    this.values.delete(key);
  }

  async has(key: string): Promise<boolean> {
    this.guard();
    return this.values.has(key);
  }

  async databaseKey(): Promise<string> {
    this.guard();
    if (!this.dbKey) {
      let hex = '';
      for (let i = 0; i < 32; i++) {
        hex += Math.floor(Math.random() * 256)
          .toString(16)
          .padStart(2, '0');
      }
      this.dbKey = hex;
    }
    return this.dbKey;
  }
}

// --- AlarmScheduler -------------------------------------------------------------

export class FakeAlarmScheduler implements AlarmScheduler {
  readonly alarms = new Map<string, AlarmSpec>();
  /** Payload of the last "tapped" routine notification (like the native holder: latest wins). */
  private launchPayload: string | null = null;
  readonly fired: AlarmSpec[] = [];

  async schedule(alarm: AlarmSpec): Promise<void> {
    if (!alarm.id) throw new Error('alarm.id is required');
    this.alarms.set(alarm.id, { ...alarm });
  }

  async cancel(id: string): Promise<void> {
    this.alarms.delete(id);
  }

  async consumeLaunchPayload(): Promise<string | null> {
    const p = this.launchPayload;
    this.launchPayload = null;
    return p;
  }

  /** Scheduled alarms sorted by trigger time. */
  list(): AlarmSpec[] {
    return [...this.alarms.values()].sort((a, b) => a.triggerAtMs - b.triggerAtMs);
  }

  /**
   * Simulates AlarmManager: fires (and removes) every alarm due at `nowMs`.
   * If `tap` is true the last fired alarm's payload becomes the launch payload.
   */
  advanceTo(nowMs: number, tap = false): AlarmSpec[] {
    const due = this.list().filter(a => a.triggerAtMs <= nowMs);
    for (const a of due) {
      this.alarms.delete(a.id);
      this.fired.push(a);
    }
    if (tap && due.length > 0) this.launchPayload = due[due.length - 1].payload;
    return due;
  }

  /** Simulates the user tapping a routine notification. */
  tap(payload: string): void {
    this.launchPayload = payload;
  }
}

// --- NotificationSource ---------------------------------------------------------

export interface NotificationFilters {
  allow: string[];
  block: string[];
  retentionDays: number;
}

export class FakeNotificationSource implements NotificationSource {
  accessGranted: boolean;
  filters: NotificationFilters = { allow: [], block: [], retentionDays: 7 };
  openSettingsCalls = 0;
  private queue: CapturedNotification[] = [];
  private readonly listeners = new Set<(n: CapturedNotification) => void>();

  constructor(opts: { accessGranted?: boolean } = {}) {
    this.accessGranted = opts.accessGranted ?? true;
  }

  async isAccessGranted(): Promise<boolean> {
    return this.accessGranted;
  }

  async openAccessSettings(): Promise<void> {
    this.openSettingsCalls++;
  }

  async drain(): Promise<CapturedNotification[]> {
    const out = this.queue;
    this.queue = [];
    return out;
  }

  async setFilters(filters: NotificationFilters): Promise<void> {
    this.filters = {
      allow: [...filters.allow],
      block: [...filters.block],
      retentionDays: filters.retentionDays,
    };
  }

  subscribe(cb: (n: CapturedNotification) => void): () => void {
    this.listeners.add(cb);
    return () => {
      this.listeners.delete(cb);
    };
  }

  /**
   * Simulates the native listener: applies access + package filters, queues and emits.
   * Returns false if the notification was dropped.
   */
  post(partial: Partial<CapturedNotification> & { packageName: string }): boolean {
    if (!this.accessGranted) return false;
    const { allow, block } = this.filters;
    if (block.includes(partial.packageName)) return false;
    if (allow.length > 0 && !allow.includes(partial.packageName)) return false;
    const n: CapturedNotification = {
      key: partial.key ?? `${partial.packageName}|${this.queue.length}|${Date.now()}`,
      packageName: partial.packageName,
      appLabel: partial.appLabel ?? partial.packageName,
      title: partial.title ?? '',
      text: partial.text ?? '',
      category: partial.category,
      postedAt: partial.postedAt ?? Date.now(),
      isOngoing: partial.isOngoing ?? false,
    };
    if (n.isOngoing) return false;
    this.queue.push(n);
    for (const l of this.listeners) l(n);
    return true;
  }

  pending(): readonly CapturedNotification[] {
    return this.queue;
  }
}

// --- DeviceStateReader --------------------------------------------------------------

export class FakeDeviceStateReader implements DeviceStateReader {
  interruptionFilter: 'all' | 'priority' | 'alarms' | 'none' | 'unknown' = 'all';
  readonly volumes = new Map<string, number>();

  async getInterruptionFilter(): Promise<'all' | 'priority' | 'alarms' | 'none' | 'unknown'> {
    return this.interruptionFilter;
  }

  async getStreamVolumePercent(stream: string): Promise<number> {
    return this.volumes.get(stream) ?? 50;
  }
}

// --- Bundle -------------------------------------------------------------------------

export interface FakePlatform {
  device: FakeDeviceContext;
  permissions: FakePermissionChecker;
  credentials: FakeCredentialStore;
  alarms: FakeAlarmScheduler;
  notifications: FakeNotificationSource;
  deviceState: FakeDeviceStateReader;
}

export function createFakePlatform(
  opts: {
    snapshot?: Partial<DeviceSnapshot>;
    distribution?: Distribution;
    permissions?: Partial<Record<PermissionId, boolean>>;
    notificationAccess?: boolean;
  } = {},
): FakePlatform {
  return {
    device: new FakeDeviceContext({ snapshot: opts.snapshot, distribution: opts.distribution }),
    permissions: new FakePermissionChecker(opts.permissions),
    credentials: new FakeCredentialStore(),
    alarms: new FakeAlarmScheduler(),
    notifications: new FakeNotificationSource({ accessGranted: opts.notificationAccess }),
    deviceState: new FakeDeviceStateReader(),
  };
}
