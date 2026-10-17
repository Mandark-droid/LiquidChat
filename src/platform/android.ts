/**
 * Android implementations of the platform contracts (src/platform/types.ts) over the
 * Kotlin modules in android/app/src/main/java/com/liquidchat/platform/.
 *
 * The runtime should depend on the interfaces, not on this file, so tests can swap in
 * src/platform/fakes.ts.
 */
import {
  DeviceEventEmitter,
  NativeModules,
  type Permission,
  PermissionsAndroid,
  Platform,
} from 'react-native';

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

// --- Native module shapes ----------------------------------------------------------

type SpecialPermissionId = Exclude<PermissionId, `android.permission.${string}`>;

interface DeviceContextNative {
  getConstants?(): { distribution?: string };
  distribution?: string;
  snapshot(): Promise<DeviceSnapshot>;
  getInterruptionFilter(): Promise<'all' | 'priority' | 'alarms' | 'none' | 'unknown'>;
  getStreamVolumePercent(stream: string): Promise<number>;
  checkSpecial(id: SpecialPermissionId): Promise<boolean>;
  openSpecialSettings(id: SpecialPermissionId): Promise<boolean>;
}

interface CredentialStoreNative {
  get(key: string): Promise<string | null>;
  set(key: string, value: string): Promise<void>;
  delete(key: string): Promise<void>;
  has(key: string): Promise<boolean>;
  databaseKey(): Promise<string>;
}

interface AlarmSchedulerNative {
  schedule(alarm: AlarmSpec): Promise<void>;
  cancel(id: string): Promise<void>;
  consumeLaunchPayload(): Promise<string | null>;
  listScheduled(): Promise<AlarmSpec[]>;
}

interface NotificationsNative {
  isAccessGranted(): Promise<boolean>;
  openAccessSettings(): Promise<void>;
  drain(): Promise<CapturedNotification[]>;
  setFilters(filters: { allow: string[]; block: string[]; retentionDays: number }): Promise<void>;
}

export const NATIVE_EVENTS = {
  notificationPosted: 'Notifications:posted',
  launchPayload: 'AlarmScheduler:launchPayload',
} as const;

function missing(name: string): never {
  throw new Error(
    `${name} native module is not linked. Rebuild the Android app (npx react-native run-android --mode fullDebug).`,
  );
}

function nativeModule<T extends object>(name: string): T {
  const mod = (NativeModules as Record<string, T | undefined>)[name];
  return mod ?? new Proxy({} as T, { get: () => () => missing(name) });
}

const DeviceContextNativeModule = nativeModule<DeviceContextNative>('DeviceContext');
const CredentialStoreNativeModule = nativeModule<CredentialStoreNative>('CredentialStore');
const AlarmSchedulerNativeModule = nativeModule<AlarmSchedulerNative>('AlarmScheduler');
const NotificationsNativeModule = nativeModule<NotificationsNative>('Notifications');

export const isPlatformAvailable = (): boolean =>
  Platform.OS === 'android' && !!NativeModules.DeviceContext;

export function isSpecialPermission(id: PermissionId): id is SpecialPermissionId {
  return id.startsWith('special:');
}

// --- DeviceContextProvider -------------------------------------------------------

function readDistribution(): Distribution {
  const mod = NativeModules.DeviceContext as DeviceContextNative | undefined;
  if (!mod) return 'play';
  let value: string | undefined;
  try {
    value = typeof mod.getConstants === 'function' ? mod.getConstants().distribution : undefined;
  } catch {}
  value = value ?? mod.distribution;
  // Unknown or missing → the restrictive flavor, so 'full'-only tools stay hidden.
  return value === 'full' ? 'full' : 'play';
}

let cachedDistribution: Distribution | null = null;

export const device: DeviceContextProvider = {
  snapshot: () => DeviceContextNativeModule.snapshot(),
  distribution: () => (cachedDistribution ??= readDistribution()),
};

// --- DeviceStateReader --------------------------------------------------------------

export const deviceState: DeviceStateReader = {
  getInterruptionFilter: () => DeviceContextNativeModule.getInterruptionFilter(),
  getStreamVolumePercent: stream => DeviceContextNativeModule.getStreamVolumePercent(stream),
};

// --- PermissionChecker --------------------------------------------------------------

/** POST_NOTIFICATIONS only exists on API 33+; below that it is implicitly granted. */
function isImplicitlyGranted(permission: PermissionId): boolean {
  return (
    permission === 'android.permission.POST_NOTIFICATIONS' &&
    Platform.OS === 'android' &&
    typeof Platform.Version === 'number' &&
    Platform.Version < 33
  );
}

export const permissions: PermissionChecker = {
  async check(permission) {
    if (isSpecialPermission(permission)) {
      return DeviceContextNativeModule.checkSpecial(permission);
    }
    if (isImplicitlyGranted(permission)) return true;
    return PermissionsAndroid.check(permission as Permission);
  },

  async request(permission) {
    if (isSpecialPermission(permission)) {
      if (await DeviceContextNativeModule.checkSpecial(permission)) return true;
      // Special access is granted in a Settings screen; the caller re-checks when the app
      // returns to the foreground. We re-check once immediately in case it already changed.
      await DeviceContextNativeModule.openSpecialSettings(permission);
      return DeviceContextNativeModule.checkSpecial(permission);
    }
    if (isImplicitlyGranted(permission)) return true;
    const result = await PermissionsAndroid.request(permission as Permission);
    return result === PermissionsAndroid.RESULTS.GRANTED;
  },
};

// --- CredentialStore ----------------------------------------------------------------

export const credentials: CredentialStore = {
  get: key => CredentialStoreNativeModule.get(key),
  set: (key, value) => CredentialStoreNativeModule.set(key, value),
  delete: key => CredentialStoreNativeModule.delete(key),
  has: key => CredentialStoreNativeModule.has(key),
  databaseKey: () => CredentialStoreNativeModule.databaseKey(),
};

// --- AlarmScheduler -------------------------------------------------------------

export const alarms: AlarmScheduler & {
  /** Fires when a routine notification is tapped while JS is running. */
  onLaunchPayload(cb: () => void): () => void;
  listScheduled(): Promise<AlarmSpec[]>;
} = {
  schedule: alarm =>
    AlarmSchedulerNativeModule.schedule({
      id: alarm.id,
      triggerAtMs: alarm.triggerAtMs,
      title: alarm.title,
      body: alarm.body,
      payload: alarm.payload,
    }),
  cancel: id => AlarmSchedulerNativeModule.cancel(id),
  consumeLaunchPayload: () => AlarmSchedulerNativeModule.consumeLaunchPayload(),
  listScheduled: () => AlarmSchedulerNativeModule.listScheduled(),
  onLaunchPayload(cb) {
    const sub = DeviceEventEmitter.addListener(NATIVE_EVENTS.launchPayload, () => cb());
    return () => sub.remove();
  },
};

// --- NotificationSource ---------------------------------------------------------

export const notifications: NotificationSource = {
  isAccessGranted: () => NotificationsNativeModule.isAccessGranted(),
  openAccessSettings: () => NotificationsNativeModule.openAccessSettings(),
  drain: () => NotificationsNativeModule.drain(),
  setFilters: filters =>
    NotificationsNativeModule.setFilters({
      allow: [...filters.allow],
      block: [...filters.block],
      retentionDays: filters.retentionDays,
    }),
  subscribe(cb) {
    const sub = DeviceEventEmitter.addListener(
      NATIVE_EVENTS.notificationPosted,
      (n: CapturedNotification) => cb(n),
    );
    return () => sub.remove();
  },
};

export const platform = {
  device,
  permissions,
  credentials,
  alarms,
  notifications,
  deviceState,
};

export type AndroidPlatform = typeof platform;
