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
- Key dependency: `cactus-react-native` 1.7.0 (on-device inference)

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

Run on connected device or emulator:
```bash
npm run android
```

Build APK file only (no device needed):
```bash
cd android && ./gradlew assembleDebug
```

Output: `android/app/build/outputs/apk/debug/app-debug.apk`

Install on device:
```bash
adb install -r android/app/build/outputs/apk/debug/app-debug.apk
```

## Step 2B: Release build

Quick release (uses debug keystore — fine for internal testing):
```bash
cd android && ./gradlew assembleRelease
```

Output: `android/app/build/outputs/apk/release/app-release.apk`

Optimised build (from package.json — arm64-v8a only):
```bash
npm run build:android
```

Play Store bundle (AAB format — preferred for Google Play):
```bash
cd android && ./gradlew bundleRelease
```

Output: `android/app/build/outputs/bundle/release/app-release.aab`

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

## View logs on device

```bash
adb logcat | grep -E "LiquidChat|cactus|ReactNative"
```

## APK locations summary

```
Debug:       android/app/build/outputs/apk/debug/app-debug.apk
Release APK: android/app/build/outputs/apk/release/app-release.apk
Release AAB: android/app/build/outputs/bundle/release/app-release.aab
```

## Version bump (before release)

In `android/app/build.gradle`:
```gradle
versionCode 2        // Increment by 1 for each Play Store upload
versionName "1.1.0"  // Human-readable version
```
