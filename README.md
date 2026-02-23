<p align="center">
  <img src="LiquidChatIcon.jpg" width="200" alt="LiquidChat Icon"/>
</p>

<h1 align="center">LiquidChat</h1>

<p align="center">
  On-device mobile chat app for testing fine-tuned Liquid AI models with real native Android tool execution.
</p>

---

## Overview

LiquidChat is a React Native mobile application built to test and validate the fine-tuned model [`kshitijthakkar/LFM2.5-1.2B-Instruct-mobile-actions`](https://huggingface.co/kshitijthakkar/LFM2.5-1.2B-Instruct-mobile-actions). The model was fine-tuned on the [`google/mobile-actions`](https://huggingface.co/datasets/google/mobile-actions) dataset to translate natural language instructions into executable function calls for Android system tools.

The app uses the [Cactus React Native](https://github.com/cactus-compute/cactus) framework for fully on-device LLM inference — no cloud APIs, no network required for generation.

## How It Works

1. User sends a natural language command (e.g., *"Turn on the flashlight"*)
2. The on-device LLM processes the request with tool definitions in the system prompt
3. The model outputs a structured function call (e.g., `[{"name": "turn_on_flashlight", "arguments": {}}]`)
4. The app parses the function call and executes the real native Android action
5. The tool result is displayed in the chat

## Supported Tools

The model was trained on 7 mobile action tools, all of which execute real device actions:

| Tool | Description | Implementation |
|------|-------------|----------------|
| `turn_on_flashlight` | Turns the device flashlight on | `react-native-torch` |
| `turn_off_flashlight` | Turns the device flashlight off | `react-native-torch` |
| `open_wifi_settings` | Opens Android Wi-Fi settings | `Linking.sendIntent` |
| `create_calendar_event` | Creates a calendar event | Calendar content intent |
| `send_email` | Composes an email | `mailto:` URL scheme |
| `show_map` | Shows a location on the map | `geo:` URL scheme |
| `create_contact` | Creates a new contact | Contacts content intent |

## Features

- **On-device inference** — All model execution happens locally on the device via Cactus framework
- **Token streaming** — Real-time token-by-token generation display
- **Tool call parsing** — Supports JSON format matching the `google/mobile-actions` training format
- **Auto tool execution** — Parsed function calls are automatically executed as native device actions
- **Quick actions** — Pre-built shortcut chips for common tool commands
- **Multi-model support** — Browse and download Liquid AI models (LFM2 350M to 2.6B, vision, audio)
- **Custom model loading** — Load Cactus v1.x weight folders or GGUF files from device storage
- **Configurable system prompt** — Edit the system prompt with tool definitions from Settings
- **Chat history** — Persistent chat storage with multiple conversations
- **HuggingFace Hub export** — Push chat history as JSONL datasets for further fine-tuning
- **Inference metrics** — Live tokens/second, time-to-first-token display
- **Text-to-speech** — Optional auto-speak for assistant responses
- **Haptic feedback** — Vibration on send and tool execution

## Model Details

| Parameter | Value |
|-----------|-------|
| **Base model** | [LiquidAI/LFM2.5-1.2B-Instruct](https://huggingface.co/LiquidAI/LFM2.5-1.2B-Instruct) |
| **Fine-tune** | [kshitijthakkar/LFM2.5-1.2B-Instruct-mobile-actions](https://huggingface.co/kshitijthakkar/LFM2.5-1.2B-Instruct-mobile-actions) |
| **Dataset** | [google/mobile-actions](https://huggingface.co/datasets/google/mobile-actions) (8,693 train / 961 eval) |
| **Method** | SFT with LoRA (r=16, alpha=16) via Unsloth |
| **Eval accuracy** | 100% on 20 held-out examples |
| **Training details** | [GitHub](https://github.com/Mandark-droid/LFM2.5-1.2B-Instruct-mobile-actions) |

## Project Structure

```
LiquidChat/
├── src/
│   ├── App.tsx                         # Entry point, tab navigation
│   ├── screens/
│   │   ├── ChatScreen.tsx              # Main chat with streaming + tool calling
│   │   ├── ChatListScreen.tsx          # Chat history list
│   │   ├── ModelSelectionScreen.tsx     # Model browser + downloads
│   │   └── SettingsScreen.tsx          # Configuration + HF Hub export
│   ├── components/
│   │   ├── MessageBubble.tsx           # Chat message rendering
│   │   ├── ToolCallCard.tsx            # Tool call display + execution status
│   │   ├── ModelCard.tsx               # Model info card
│   │   └── MetricsBar.tsx              # Live token/s display
│   ├── tools/
│   │   ├── registry.ts                 # Tool definitions (google/mobile-actions format)
│   │   ├── flashlight.ts              # Flashlight on/off
│   │   ├── wifiSettings.ts            # Open WiFi settings
│   │   ├── calendarEvent.ts           # Create calendar events
│   │   ├── email.ts                   # Send emails
│   │   ├── maps.ts                    # Show maps
│   │   └── contacts.ts               # Create contacts
│   ├── services/
│   │   ├── huggingfaceApi.ts          # HF Hub push-to-hub API
│   │   └── chatExport.ts             # Chat history JSONL export
│   ├── utils/
│   │   ├── storage.ts                 # AsyncStorage persistence
│   │   ├── toolParser.ts              # Parse model tool call output
│   │   ├── chatHelpers.ts             # ID generation, timestamps
│   │   ├── deviceMetrics.ts           # Battery, memory info
│   │   ├── haptics.ts                 # Haptic feedback
│   │   └── ttsManager.ts             # Text-to-speech
│   ├── config/
│   │   ├── models.ts                  # Liquid AI model registry
│   │   └── theme.ts                   # Desert/cactus themed design
│   ├── types/
│   │   └── index.ts                   # TypeScript types
│   └── assets/
│       ├── liquidchat_logo.png        # App logo
│       └── liquidchat_icon.png        # App icon
├── android/                            # Android native project
├── release/
│   └── LiquidChat.apk                 # Pre-built release APK
├── package.json
├── metro.config.js
└── react-native.config.js
```

## Installation

### Pre-built APK

Download and install `release/LiquidChat.apk` on your Android device.

### Build from Source

**Prerequisites:**
- Node.js >= 20
- React Native CLI
- Android SDK
- [Cactus React Native SDK](https://github.com/cactus-compute/cactus) at `../cactus_framework/cactus-react-native`

```bash
# Install dependencies
npm install

# Build release APK
cd android && ./gradlew assembleRelease
```

The APK will be at `android/app/build/outputs/apk/release/app-release.apk`.

### Model Setup

The fine-tuned model weights must be pushed to the device in Cactus v1.x format:

1. Convert LoRA weights to Cactus format using the Cactus CLI or conversion script
2. Push the weight folder to the device:
   ```bash
   adb push weights/lfm25-mobile-actions/ /data/local/tmp/lfm25-mobile-actions/
   adb shell run-as com.liquidchat cp -r /data/local/tmp/lfm25-mobile-actions /data/user/0/com.liquidchat/files/models/
   ```
3. Launch the app — the model loads automatically from `files/models/lfm25-mobile-actions/`

## Tech Stack

| Component | Technology |
|-----------|-----------|
| **Framework** | React Native 0.81.1 |
| **LLM Runtime** | Cactus React Native (on-device inference) |
| **Model Format** | Cactus v1.x weight folders |
| **State** | React hooks + AsyncStorage |
| **Navigation** | Custom state-based (no react-navigation dependency) |
| **Flashlight** | react-native-torch |
| **Camera/Images** | react-native-image-picker |
| **File System** | @dr.pogodin/react-native-fs |
| **TTS** | react-native-tts |
| **Haptics** | react-native-haptic-feedback |

## License

This project is for research and testing purposes. The base model ([LiquidAI/LFM2.5-1.2B-Instruct](https://huggingface.co/LiquidAI/LFM2.5-1.2B-Instruct)) is subject to Liquid AI's license terms.

## Author

Developed by **Kshitij Thakkar**
