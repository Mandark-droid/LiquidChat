---
name: build-apk-liquidchat
description: Build debug or release APKs for the LiquidChat Android app. Use when the user wants to compile, build, or install the LiquidChat APK on a device.
argument-hint: [debug|release]
disable-model-invocation: false
allowed-tools: Bash
---

Build debug or release APKs for the LiquidChat React Native Android app.

## Arguments

`$ARGUMENTS` should be `debug` or `release`. If not specified, ask the user which build type they want and whether they have a device connected.

## Project facts (verified)

- App ID: `com.liquidchat`
- React Native: 0.81.1
- compileSdk / targetSdk: 36, minSdk: 24 (Android 7+)
- NDK: 27.1.12297006 (required for Cactus native module)
- JS engine: Hermes
- Key dependency: `cactus-react-native` 1.13.1 (on-device inference)
- **Product flavors** (dimension `distribution`), exposed to JS as `NativeModules.DeviceContext.distribution`:
  - `full` — sideload build, includes the AccessibilityService (`src/full/AndroidManifest.xml`) for UI automation
  - `play` — Google Play policy-safe build, no AccessibilityService declared
  - Variants are therefore `fullDebug`, `fullRelease`, `playDebug`, `playRelease`; plain `assembleDebug` builds **both** flavors.

Ask the user which flavor they want if it is not obvious; default to `full` for personal/sideload testing and `play` for anything going to the Play Store.

## Step 0: Prerequisites check

```bash
node --version    # Must be >=20
java -version     # Must be JDK 17+
echo $ANDROID_HOME
adb devices
```

## Step 1: Install dependencies

```bash
npm install
```

## Step 2A: Debug build

Run on connected device or emulator (Metro must be reachable):
```bash
npx react-native run-android --mode fullDebug   # or --mode playDebug
```
(`npm run android` without `--mode` is ambiguous once flavors exist; pass the mode.)

Build APK files only (no device needed):
```bash
cd android && ./gradlew assembleFullDebug     # full flavor
cd android && ./gradlew assemblePlayDebug     # play flavor
```

Outputs:
- `android/app/build/outputs/apk/full/debug/app-full-debug.apk`
- `android/app/build/outputs/apk/play/debug/app-play-debug.apk`

Install on device:
```bash
adb install -r android/app/build/outputs/apk/full/debug/app-full-debug.apk
```

Lint (what CI runs):
```bash
cd android && ./gradlew lintFullDebug
```

## Step 2B: Release build

Quick release (uses debug keystore — fine for internal testing):
```bash
cd android && ./gradlew assembleFullRelease -PreactNativeArchitectures=arm64-v8a
```

Output: `android/app/build/outputs/apk/full/release/app-full-release.apk`

`npm run build:android` runs `react-native build-android` without a mode; with flavors it builds every release variant. Prefer the explicit Gradle tasks above/below.

Play Store bundle (AAB format — always the **play** flavor):
```bash
cd android && ./gradlew bundlePlayRelease
```

Output: `android/app/build/outputs/bundle/playRelease/app-play-release.aab`

## Production signing (for Play Store distribution)

Generate a release keystore (one-time):
```bash
keytool -genkey -v \
  -keystore android/app/release.keystore \
  -alias liquidchat-release \
  -keyalg RSA -keysize 2048 -validity 10000
```

Then update `android/app/build.gradle` → `signingConfigs.release` to use it.
**Never commit release.keystore to git.**

## Current signing state

- Debug: `android/app/debug.keystore` (in repo, password: `android`)
- Release: currently falls back to debug keystore (OK for internal testing)
- ProGuard: disabled (`enableProguardInReleaseBuilds = false`)

## Clean build (fixes most errors)

```bash
cd android && ./gradlew clean && cd ..
npm install
npm run android
```

## Common errors

| Error | Fix |
|-------|-----|
| `SDK location not found` | Set `ANDROID_HOME` or create `android/local.properties` with `sdk.dir=...` |
| `NDK version mismatch` | Install NDK 27.1.12297006 via Android Studio SDK Manager |
| `Could not resolve cactus-react-native` | Run `npm install` first, then `./gradlew clean` |
| `Metro bundler error` | Run `npm start` in a separate terminal first |
| `adb: device not found` | Enable USB debugging on device; run `adb kill-server && adb start-server` |
| App crashes on launch | Check `adb logcat *:E` for error messages |
| `Task 'assembleDebug' is ambiguous` / `run-android` picks the wrong variant | Pass the flavor: `--mode fullDebug` or `./gradlew assembleFullDebug` |
| Debug APK shows "Unable to load script" though Metro runs | Check `react { debuggableVariants = ["fullDebug", "playDebug"] }` in `android/app/build.gradle` |

## View logs on device

```bash
adb logcat | grep -E "LiquidChat|cactus|ReactNative"
# platform layer (alarms, notification listener):
adb logcat -s LiquidChatAlarms LiquidChatNotif
```

## APK locations summary

```
Full debug:    android/app/build/outputs/apk/full/debug/app-full-debug.apk
Play debug:    android/app/build/outputs/apk/play/debug/app-play-debug.apk
Full release:  android/app/build/outputs/apk/full/release/app-full-release.apk
Play AAB:      android/app/build/outputs/bundle/playRelease/app-play-release.aab
```

CI (`.github/workflows/ci.yml`) builds `assembleFullDebug assemblePlayDebug lintFullDebug` and uploads both debug APKs as the `liquidchat-debug-apks` artifact.

## Version bump (before release)

In `android/app/build.gradle`:
```gradle
versionCode 2        // Increment by 1 for each Play Store upload
versionName "1.1.0"  // Human-readable version
```
