# Android native platform layer (PRD Phase 4)

The agent runtime talks to Android only through the contracts in
`src/platform/types.ts`. `src/platform/android.ts` implements them over four
Kotlin modules in `android/app/src/main/java/com/liquidchat/platform/`;
`src/platform/fakes.ts` implements them in memory for Jest.

```ts
import { platform } from '../platform/android';
// platform.device / permissions / credentials / alarms / notifications / deviceState
```

All modules are legacy `ReactContextBaseJavaModule`s (`@ReactMethod` + `Promise`) running
through the new-architecture interop layer, registered by `PlatformPackage` in
`MainApplication.kt`. When a module is missing (stale APK) every call throws
`"<Name> native module is not linked…"`.

## Distribution flavors

`android/app/build.gradle` declares `flavorDimensions "distribution"`:

| Flavor | `BuildConfig.DISTRIBUTION` | AccessibilityService | Use |
|---|---|---|---|
| `full` | `"full"` | declared in `src/full/AndroidManifest.xml` | sideload / personal |
| `play` | `"play"` | not declared | Google Play |

The Kotlin classes (including `LiquidChatAccessibilityService`) stay in `src/main`; only the
`<service>` declaration differs, so the play build cannot be bound as an accessibility service.
JS reads the flavor via `platform.device.distribution()` (constant `DeviceContext.distribution`);
when the module is missing it reports `'play'`, which hides `'full'`-only tools.

`react.debuggableVariants = ["fullDebug", "playDebug"]` keeps debug variants on Metro.
Run with `npx react-native run-android --mode fullDebug`.

## Modules

### `DeviceContext` → `DeviceContextProvider`, `DeviceStateReader`, special permissions

| Method | Source | Notes |
|---|---|---|
| `getConstants().distribution` | `BuildConfig.DISTRIBUTION` | |
| `snapshot()` | `BatteryManager` (capacity, `isCharging`), `PowerManager` (`isPowerSaveMode`, `currentThermalStatus` API 29+, else `"unknown"`), `ConnectivityManager.getNetworkCapabilities(activeNetwork)` (online = INTERNET && VALIDATED; unmetered = online && NOT_METERED), `ActivityManager.MemoryInfo` | RAM in MiB; `batteryPercent` -1 if unknown |
| `getInterruptionFilter()` | `NotificationManager.currentInterruptionFilter` | `all/priority/alarms/none/unknown` |
| `getStreamVolumePercent(stream)` | `AudioManager` | same stream names as `SystemControls.setVolume` |
| `checkSpecial(id)` | see table below | rejects `UNKNOWN_PERMISSION` for unknown ids |
| `openSpecialSettings(id)` | starts the Settings screen with `FLAG_ACTIVITY_NEW_TASK` | resolves `false` for `special:network` |

| Permission id | Check | Settings screen |
|---|---|---|
| `special:notification_policy` | `NotificationManager.isNotificationPolicyAccessGranted` | `ACTION_NOTIFICATION_POLICY_ACCESS_SETTINGS` |
| `special:write_settings` | `Settings.System.canWrite` | `ACTION_MANAGE_WRITE_SETTINGS` (`package:` URI) |
| `special:accessibility` | `ENABLED_ACCESSIBILITY_SERVICES` contains `LiquidChatAccessibilityService` (same logic as `AccessibilityBridgeModule`) | `ACTION_ACCESSIBILITY_SETTINGS` |
| `special:notification_listener` | `NotificationManagerCompat.getEnabledListenerPackages` contains our package | `ACTION_NOTIFICATION_LISTENER_SETTINGS` |
| `special:network` | always `true` | — |

`PermissionChecker` in `android.ts`: `special:*` → `checkSpecial`; `android.permission.*` →
`PermissionsAndroid.check/request`. `request()` on a special permission opens the Settings
screen and re-checks immediately; since the user comes back later, callers should re-check on
`AppState` → `active`. `POST_NOTIFICATIONS` is treated as granted below API 33.

New manifest permission: `ACCESS_NETWORK_STATE` (needed for `getNetworkCapabilities`).

### `CredentialStore` → `CredentialStore`

* AES-256-GCM key generated inside AndroidKeyStore, alias `liquidchat_credentials`
  (no user-auth requirement, randomized IV).
* Values stored in private SharedPreferences `liquidchat_credentials` as
  `base64(iv[12] || ciphertext || tag[16])`, key prefix `v:`.
* `databaseKey()`: 32 `SecureRandom` bytes, hex-encoded, created once, stored encrypted under
  `__database_key__`. If it can no longer be decrypted it **rejects** (`DECRYPT_FAILED`) rather
  than silently creating a new key that would orphan the SQLCipher database.
* Error codes: `KEYSTORE_UNAVAILABLE`, `ENCRYPT_FAILED`, `DECRYPT_FAILED`, `CREDENTIAL_ERROR`.
* `android:allowBackup="false"` is already set, so ciphertexts are never restored onto a device
  without the matching Keystore key.

### `AlarmScheduler` → `AlarmScheduler` (+ `AlarmReceiver`, `BootReceiver`, `AlarmStore`, `LaunchPayload`)

* `schedule({id, triggerAtMs, title, body, payload})` persists the spec as JSON in
  SharedPreferences `liquidchat_alarms` and calls
  `AlarmManager.setAndAllowWhileIdle(RTC_WAKEUP, …)` with a broadcast `PendingIntent`
  (unique per id via request code + data URI, `FLAG_IMMUTABLE`). No exact-alarm permission is
  needed; Android may delay delivery (Doze: up to ~9 min windows, more in deep idle / App Standby
  buckets). Re-scheduling an id replaces it.
* `AlarmReceiver` (action `com.liquidchat.platform.ALARM_FIRE`) removes the alarm from the store
  (all alarms are one-shot; recurrence belongs to the JS scheduler) and posts a notification on
  channel `agent_routines` (IMPORTANCE_DEFAULT). Without `POST_NOTIFICATIONS` (API 33+) or with
  notifications disabled it logs and returns.
* Tapping the notification opens `MainActivity` with extra `liquidchat_payload`.
  `MainActivity.onCreate` (cold start) and `onNewIntent` (warm, `singleTask`) hand the intent to
  `LaunchPayload.capture`, which stores the payload and strips the extra.
  `consumeLaunchPayload()` returns it once. On a warm launch the module also emits
  `AlarmScheduler:launchPayload` (`platform.alarms.onLaunchPayload(cb)`); JS should call
  `consumeLaunchPayload()` both at startup and on that event.
* `BootReceiver` re-registers every stored alarm on `BOOT_COMPLETED`, `MY_PACKAGE_REPLACED`,
  `TIME_SET` and `TIMEZONE_CHANGED`. Alarms whose time passed while the phone was off fire
  immediately after boot. `LOCKED_BOOT_COMPLETED` is intentionally not handled: the store lives
  in credential-encrypted storage, so alarms resume after first unlock.
* `listScheduled()` (extra, for debugging) returns the stored specs.
* New manifest permission: `RECEIVE_BOOT_COMPLETED`.

### `Notifications` → `NotificationSource` (+ `LiquidChatNotificationListener`, `NotificationInbox`)

* `LiquidChatNotificationListener` (`NotificationListenerService`, `exported=true`, guarded by
  `BIND_NOTIFICATION_LISTENER_SERVICE`) runs whenever the user grants notification access,
  even with the UI closed. It skips: our own package, `isOngoing`, `FLAG_FOREGROUND_SERVICE`,
  `FLAG_GROUP_SUMMARY`, empty notifications, packages in the block list, and — when the allow
  list is non-empty — anything not on it.
* Extracts `EXTRA_TITLE` (fallback `EXTRA_TITLE_BIG`), `EXTRA_BIG_TEXT` (fallback `EXTRA_TEXT`),
  `category`, and the app label (from the `android.appInfo` extra the system attaches, falling
  back to `PackageManager`, then the package name).
* **OTP redaction happens natively, before anything touches disk**: 4–8 digit numbers (and
  `123 456` / `123-456`) within 40 chars of `otp`, `one time`, `passcode`, `password`, `pin`,
  `verification`, `verify`, `security code`, `code`, `पासवर्ड`, `ओटीपी`, `सत्यापन`, `कोड`
  become `[REDACTED]`, and everything after the word `OTP`/`ओटीपी` is replaced. Applied to
  title and text.
* Entries are appended as JSON lines to `files/notifications/inbox.jsonl`; above 2 MB the file
  is trimmed to its newest ~1.5 MB. `drain()` returns entries no older than `retentionDays` and
  truncates the file. If a React instance is alive, `Notifications:posted` is emitted with the
  same `CapturedNotification` shape (`platform.notifications.subscribe(cb)`); the entry is still
  queued, so dedupe by `key` + `postedAt` if you both subscribe and drain.
* `setFilters({allow, block, retentionDays})` → SharedPreferences
  `liquidchat_notification_filters` (default retention 7 days).
* `isAccessGranted()` / `openAccessSettings()` (`ACTION_NOTIFICATION_LISTENER_SETTINGS`).

## What must be validated on a device

Nothing in this layer has been compiled or run yet; the sandbox that produced it has no
Android SDK. Before relying on it:

1. **Build**: `./gradlew assembleFullDebug assemblePlayDebug lintFullDebug` (CI does this).
   Fix any Kotlin compile or lint errors first.
2. **Flavors**: in the play APK, `adb shell dumpsys package com.liquidchat | grep -i accessib`
   must show no service and `DeviceContext.distribution === 'play'`; full APK shows the service
   and `'full'`. Debug variants must load JS from Metro.
3. **Snapshot**: battery %/charging change when plugging in; power-saver toggles;
   online/unmetered flip on Wi-Fi ↔ mobile data ↔ airplane mode (captive portals show
   `online=false` because of `VALIDATED`); thermal on API 29+; RAM numbers plausible.
4. **Special permissions**: each `checkSpecial` id before/after granting in Settings; each
   `openSpecialSettings` lands on the right screen (OEM skins vary — Xiaomi/Samsung in particular).
5. **CredentialStore**: set/get round-trip; values survive app restart; `databaseKey()` is
   stable across restarts and app updates; behaviour after changing/removing the lock screen
   (key should survive since it is not auth-bound — confirm); uninstall/reinstall yields a new
   key (expected).
6. **Alarms**: fire with screen off and in Doze (`adb shell dumpsys deviceidle force-idle`);
   measure delivery latency; survive reboot (`adb reboot`), app update (`adb install -r`), and
   manual time/time-zone changes; cancel works; a fired alarm is removed from `listScheduled()`.
   Tap notification from a killed app (cold start) and from background (warm) — payload must be
   returned exactly once in both cases; Linking must not report a spurious initial URL.
   Android 13+ with `POST_NOTIFICATIONS` denied: no crash, alarm silently consumed.
   Check OEM battery optimisers (MIUI, OneUI, ColorOS) that kill alarms of "restricted" apps.
7. **Notification listener**: grant access; post from WhatsApp/Gmail/SMS; check skipping of
   ongoing (music, navigation), foreground-service and group-summary notifications; allow/block
   lists; OTP redaction with real bank/UPI SMS formats (English and Hindi); `Notifications:posted`
   arrives while the app is open; `drain()` returns captures made while the app was closed;
   2 MB cap under a flood; listener reconnects after reboot and after the app is updated.
   On Android 15+, check whether sensitive notifications (OTPs) are already redacted by the
   system for non-privileged listeners.
8. **Play policy**: the play build declares a `NotificationListenerService`, which Play reviews
   (prominent disclosure + core-functionality justification needed); confirm before submitting.
