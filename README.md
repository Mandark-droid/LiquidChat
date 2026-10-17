<p align="center">
  <img src="LiquidChatIcon.jpg" width="200" alt="LiquidChat Icon"/>
</p>

<h1 align="center">LiquidChat</h1>

<p align="center">
  Fully local personal agent — on-device LLM inference with real native Android tool execution.
</p>

<p align="center">
  <a href="https://www.liquid.ai"><img src="https://img.shields.io/badge/Powered%20by-Liquid%20AI-6366f1?style=flat-square" alt="Liquid AI"/></a>
  <a href="https://github.com/cactus-compute/cactus"><img src="https://img.shields.io/badge/Runtime-Cactus%20Engine-22c55e?style=flat-square" alt="Cactus Engine"/></a>
  <a href="https://huggingface.co/kshitijthakkar"><img src="https://img.shields.io/badge/Models-Hugging%20Face-ff9d00?style=flat-square&logo=huggingface&logoColor=white" alt="Hugging Face"/></a>
  <img src="https://img.shields.io/badge/Platform-Android-3ddc84?style=flat-square&logo=android&logoColor=white" alt="Android"/>
  <img src="https://img.shields.io/badge/React%20Native-0.81.1-61dafb?style=flat-square&logo=react&logoColor=white" alt="React Native"/>
</p>

<p align="center">
  <img src="docs/demo/liquidchat-v1.1-demo.gif" width="300" alt="LiquidChat v1.1 demo: streaming chat, model routing, Hugging Face search, speaker-labelled meeting minutes, creating and running a skill, agent dashboard"/>
  <br/>
  <sub>v1.1 on a Nothing Phone 2a, sped up: chat on LFM2.5-350M → tool request routed to LFM2.5-1.2B (Hugging Face search) → 5-speaker meeting with owners → a skill created from one sentence and run → loaded models and MCP settings.</sub>
</p>

---

## Overview

LiquidChat is a React Native mobile application and personal agent platform built on the [Cactus React Native](https://github.com/cactus-compute/cactus) inference engine. All model execution happens entirely on-device — no cloud APIs, no network required.

The working prototype (v0.x) demonstrates the core loop: a LoRA fine-tuned LFM2.5-1.2B-Instruct model translates natural language into structured function calls that execute real Android device actions. The v1.0 roadmap expands this into a full multi-model orchestrator with voice input, vision pipeline, persistent semantic memory, and 30+ native tools.

> **Current release: v1.1**
> A local-first agent: streaming on-device chat, 35+ native tools, a permission-gated multi-step agent runtime, meeting recording with speaker-labelled transcripts and client-ready minutes, tasks, an email drafter, and MCP servers (Hugging Face built in). See [What's new in v1.1](#whats-new-in-v11).

## What's new in v1.1

**Chat & agent**
- **Fast, streaming chat.** Plain conversation answers directly with a short prompt and streams tokens (first word in about a second on a mid-range phone). Tool and task requests go to the agent runtime. Live tokens, speed and time-to-first-token are shown.
- **Smarter tool use.** The agent asks for details it wasn't given (an email address, a phone number) instead of inventing them; near-miss tool names from small models are repaired; alarms, timers, contacts and settings pages work on Android 11+ (they were silently failing).
- **Hugging Face MCP server built in.** Search models, datasets and Spaces and read repo details from chat; uses your Hugging Face token if you saved one. Add any other MCP server in Agent settings.
- **Task-based model routing.** Quick chat replies stay on the small LFM2.5-350M; tool calls, planning and structured work go to LFM2.5-1.2B. Only tools relevant to the request are sent to the model, which cut the wait before the first word from ~17 s to ~6 s.
- **Skills from one sentence.** "Every evening summarize my open tasks" becomes a reviewed, schedulable skill in seconds; the five built-in skills (meeting prep, morning brief, focus mode, meeting follow-up, end of day) are unchanged.
- **Updated model weights.** Chat, speech, embedding and speaker models use the v1.14 weights that match the Cactus 1.13 engine; the app replaces older copies once.

**Meetings**
- **Speaker identification.** Voice fingerprints separate speakers; names come from introductions ("I'm Priya") and from who answers whom; rename a speaker once and every line and the minutes follow. Action-item owners come from who actually said "I'll…".
- **Upload or share a recording.** Pick any audio or video file (m4a, aac, mp3, wav, ogg, opus, amr, 3gp, mp4) or use *Share → LiquidChat* from your recorder app, then get the transcript and minutes.
- **Auto-detect language, translate to English by default** (Whisper; Hindi/English code-switching), with an English fallback.
- **Every exported MoM carries the LiquidChat footer** — logo, name and "Generated using LiquidChat" — on PDF, Word, Markdown and shared text.
- Hardened transcription: loops, punctuation stalls and copied template text are filtered, with a sampling retry.

**Tasks, email & the rest**
- Tasks: calendar hand-off works, due dates and quick-add are reliable, editing sheet fixed. Email drafter uses a model that fits in memory and never leaves `[Your Name]` placeholders.
- Speech speed setting (text-to-speech was playing at about 3×).
- Text no longer clips under Android's *Bold text* setting; bottom bars clear the navigation bar; every dialog closes with Back; long menus use a proper sheet; Back navigates instead of exiting.

## How It Works

1. User sends a natural language command (e.g., *"Turn on the flashlight"*)
2. The on-device LLM processes the request with tool definitions in the system prompt
3. The model outputs a structured function call (e.g., `[{"name": "turn_on_flashlight", "arguments": {}}]`)
4. The app parses the function call and executes the real native Android action
5. The tool result is displayed in the chat

## Tools

### Core tools

| Tool | Description | Implementation |
|------|-------------|----------------|
| `turn_on_flashlight` | Turns the device flashlight on | `react-native-torch` |
| `turn_off_flashlight` | Turns the device flashlight off | `react-native-torch` |
| `open_wifi_settings` | Opens Android Wi-Fi settings | `Linking.sendIntent` |
| `create_calendar_event` | Creates a calendar event | Calendar content intent |
| `send_email` | Composes an email | `mailto:` URL scheme |
| `show_map` | Shows a location on the map | `geo:` URL scheme |
| `create_contact` | Creates a new contact | Contacts content intent |

### System controls

| Tool | Description |
|------|-------------|
| `set_brightness` | Set screen brightness (0–100) |
| `set_volume` | Set volume for a given stream |
| `toggle_bluetooth` | Enable/disable Bluetooth |
| `toggle_airplane_mode` | Toggle airplane mode |
| `toggle_dnd` | Toggle Do Not Disturb |
| `set_alarm` | Set an alarm by time and label |
| `set_timer` | Start a countdown timer |
| `take_screenshot` | Capture the current screen |
| `toggle_rotation_lock` | Lock/unlock screen rotation |
| `open_settings_page` | Open any Android settings page |

### UI automation (sideload build)

`tap_element`, `long_press_element`, `scroll_screen`, `swipe_screen`, `type_text`, `read_screen`, `find_element`, `go_back`, `go_home` and `open_recents` run through an Android Accessibility Service. They are only in the `full` flavor; the `play` flavor (Play Store policy) does not declare the service.

### Agent, memory and context tools

`tasks.add`, `tasks.list`, `meetings.latest`, `meetings.search`, `memory.search`, `memory.remember`, `device.context`, `notifications.recent`, `time.now`, `dates.resolve` — plus any tools from connected MCP servers.

### Planned

- **App navigation:** launch apps, open URLs, share text, web search, phone calls, SMS, file open, set wallpaper

## Model Details

| Parameter | Value |
|-----------|-------|
| **Base model** | [LiquidAI/LFM2.5-1.2B-Instruct](https://huggingface.co/LiquidAI/LFM2.5-1.2B-Instruct) |
| **Fine-tuned model** | [kshitijthakkar/LFM2.5-1.2B-Instruct-mobile-actions](https://huggingface.co/kshitijthakkar/LFM2.5-1.2B-Instruct-mobile-actions) |
| **Training dataset** | [kshitijthakkar/liquidchat-lora-dataset](https://huggingface.co/datasets/kshitijthakkar/liquidchat-lora-dataset) (31,550 train / 643 eval) |
| **Method** | SFT with LoRA (r=16, alpha=16) via Unsloth on HF Jobs |
| **Eval accuracy** | 100% on 20 held-out examples |
| **Training scripts** | [GitHub](https://github.com/Mandark-droid/LFM2.5-1.2B-Instruct-mobile-actions) |

## Meetings, Tasks & Email (new)

Everything below runs on the phone; audio, transcripts and drafts never leave it.

- **Meeting recorder** — tap record, lock the phone. A foreground service captures 16 kHz mono audio, cuts it into ~20–30 s segments at pauses, and transcribes each one while the meeting is still going (Whisper, Parakeet TDT v3 or Moonshine). Client and attendee names are fed to Whisper as context; Language is auto-detected per segment and translated to English by default (Hindi, Marathi, Gujarati, Tamil, Telugu, Bengali and more with Whisper). Pause/resume/stop from the notification; mark important moments with ★.
- **Minutes of meeting** — when you stop, an on-device LLM writes a summary, key points, decisions, open questions, next steps and action items (owner + due date, "by Friday" resolved to a real date). Long meetings are summarised in windows and merged. Everything is editable before it goes to a client.
- **Speaker identification** — each transcript line carries a speaker; names are suggested from introductions and attendee lists, can be renamed in one tap, and action-item owners come from who spoke.
- **Upload or share recordings** — pick an audio/video file (including `.aac`/`.m4a` from your phone's recorder) or share it to LiquidChat, then get a transcript and minutes.
- **Import transcripts** — paste from Zoom, Google Meet, Teams, Otter or a `.vtt` file and get the same minutes.
- **Client-ready documents** — export the MoM as **PDF**, **Word (.docx)**, Markdown or text, with a LiquidChat footer on every export — logo, name and *Generated using LiquidChat* (optional organisation letterhead in Meeting settings). Share to any app, save to `Downloads/LiquidChat`, or email it to attendees with the file attached.
- **Tasks** — one list for your own to-dos and every meeting's action items. Natural-language quick add (`send Acme proposal by Friday !high @Acme`), voice add, Today / Upcoming / Done views, "Mine" and per-client filters, add to calendar.
- **Email drafter** — follow-up after a meeting, a new email from one line of intent, or a reply to a pasted email. Pick a tone, refine with instructions ("shorter", "more formal"), then open it in your mail app or send it with the MoM PDF attached.
- **Ask about a meeting** — opens a chat grounded in that meeting's minutes and transcript.

## Agent runtime (new)

LiquidChat is now a local-first agent, not just a chat with tools. Spec: [`docs/spec/LiquidChat-Mobile-Agent-Runtime-PRD.md`](docs/spec/LiquidChat-Mobile-Agent-Runtime-PRD.md); implementation map: [`docs/agent-runtime.md`](docs/agent-runtime.md); Android layer: [`docs/android-native.md`](docs/android-native.md).

- **Multi-step tasks** — requests are planned into validated steps, executed through a permission gateway, verified (e.g. DnD read back after enabling it), retried, cancellable, and resumable after the app is killed — without ever repeating a send.
- **Per-step hybrid routing** — every model step is routed on its own: planning and phone actions stay on-device; a single hard reasoning step can go to a cloud model you configured (Anthropic, OpenAI-compatible, Gemini) if your privacy policy and budget allow, then control returns on-device. Modes: on-device only / hybrid / cloud first; battery, heat and RAM aware.
- **Privacy** — only public data may leave the phone by default; personal data needs your policy *and* a first-time approval per provider; notification content is on-device-only. Keys live in Keystore-encrypted storage; the agent database is SQLCipher-encrypted.
- **Approvals** — anything sensitive asks first (spoken in voice mode); sending is never "always allowed".
- **Memory** — remembers preferences and past outcomes only with your OK; inspect, edit, pin, export or wipe it.
- **Skills & routines** — Meeting preparation, Morning briefing, Focus mode, Meeting follow-up, End of day; create your own in plain language, save a workflow that worked, import/export. Skills are declarative — they cannot run code.
- **MCP servers** as extra tools — the read-only **Hugging Face** server (model/dataset/Space search and repo details) is preinstalled and can be disabled or removed; calls that leave the phone follow your privacy and approval settings.
- **Notification summaries** (opt-in), **insights** (completion, routing, latency, cost) and an **offline evaluation set**.

### Code quality

`npm run check` runs strict TypeScript, ESLint (incl. import sorting and hooks rules), Prettier and Jest — the equivalents of mypy, pylint, isort, black and pytest. CI runs it plus Android debug builds for both flavors (`full`, `play`) and Android lint.

## Features

- **On-device inference** — All model execution happens locally on the device via Cactus framework
- **Token streaming** — Real-time token-by-token generation display
- **Tool call parsing** — Supports both JSON (`google/mobile-actions` format) and native LFM2.5 `<|tool_call_start|>` format
- **Auto tool execution** — Parsed function calls are automatically executed as native device actions
- **Multi-model support** — Browse and download Liquid AI models (LFM2 350M to 2.6B, vision, audio) with tier-based lifecycle management
- **Custom model loading** — Load Cactus weight folders or GGUF files from device storage
- **Configurable system prompt** — Edit the system prompt with tool definitions from Settings
- **Chat history** — Persistent chat storage with multiple conversations
- **HuggingFace Hub export** — Push chat history as JSONL datasets for LoRA retraining
- **Inference metrics** — Live tokens/second, time-to-first-token display
- **Text-to-speech** — Optional auto-speak for assistant responses
- **Haptic feedback** — Vibration on send and tool execution
- **Agent dashboard** — Loaded model states, RAM usage, action history
- **Speech speed** — adjustable text-to-speech rate with a voice preview
- **Share to LiquidChat** — send audio from other apps straight into a new meeting

## Project Structure

```
LiquidChat/
├── src/
│   ├── App.tsx                             # Entry point, tab navigation
│   ├── screens/
│   │   ├── ChatScreen.tsx                  # Main chat with streaming + tool calling
│   │   ├── ChatListScreen.tsx              # Chat history list
│   │   ├── ModelSelectionScreen.tsx        # Model browser + downloads + tier badges
│   │   ├── SettingsScreen.tsx              # Configuration + HF Hub export
│   │   └── AgentDashboardScreen.tsx        # Model states, RAM, action log (Phase 5)
│   ├── components/
│   │   ├── MessageBubble.tsx               # Chat message rendering
│   │   ├── ToolCallCard.tsx                # Tool call display + execution status
│   │   ├── ModelCard.tsx                   # Model info card + tier badge
│   │   ├── MetricsBar.tsx                  # Live token/s display
│   │   ├── ActionChainProgress.tsx         # Multi-step action progress (Phase 5)
│   │   ├── VoiceInputButton.tsx            # Voice recording button (Phase 2)
│   │   ├── ScreenshotPreview.tsx           # Screenshot preview (Phase 4)
│   │   └── MemoryChips.tsx                 # Recalled memory context (Phase 3)
│   ├── tools/
│   │   ├── registry.ts                     # Tool definitions (7 → 30+ tools)
│   │   ├── flashlight.ts                   # Flashlight on/off
│   │   ├── wifiSettings.ts                 # Open WiFi settings
│   │   ├── calendarEvent.ts                # Create calendar events
│   │   ├── email.ts                        # Send emails
│   │   ├── maps.ts                         # Show maps
│   │   ├── contacts.ts                     # Create contacts
│   │   └── [Phase 1-3 tools]               # brightness, volume, bluetooth, alarm, ...
│   ├── services/
│   │   ├── huggingfaceApi.ts               # HF Hub push-to-hub API
│   │   ├── chatExport.ts                   # Chat history JSONL export
│   │   ├── ModelLifecycleManager.ts        # Hot/warm/cold tier loading + LRU eviction
│   │   ├── IntentRouter.ts                 # Route intents to action/query/reason/chat
│   │   ├── MemoryService.ts                # CactusIndex + embedding for recall (Phase 3)
│   │   ├── VisionAgent.ts                  # See-then-act with LFM2-VL-450M (Phase 4)
│   │   └── ActionChainExecutor.ts          # Multi-step action planning + execution
│   ├── hooks/
│   │   ├── useVoiceAgent.ts                # VAD + STT pipeline (Phase 2)
│   │   ├── useModelManager.ts              # Model lifecycle hook
│   │   └── useMemory.ts                    # Memory recall hook (Phase 3)
│   ├── utils/
│   │   ├── storage.ts                      # AsyncStorage persistence
│   │   ├── toolParser.ts                   # Parse tool calls (dual format + chains)
│   │   ├── chatHelpers.ts                  # ID generation, timestamps
│   │   ├── deviceMetrics.ts                # Battery, memory, RAM tier detection
│   │   ├── haptics.ts                      # Haptic feedback
│   │   └── ttsManager.ts                   # Text-to-speech
│   ├── config/
│   │   ├── models.ts                       # Liquid AI model registry + tier assignments
│   │   ├── modelTiers.ts                   # Hot/warm/cold tier configuration
│   │   └── theme.ts                        # Desert/cactus themed design
│   └── types/
│       └── index.ts                        # TypeScript types
├── android/
│   └── app/src/main/java/.../
│       ├── SystemControlsModule.java       # Native bridge for Phase 1 tools
│       └── LiquidChatAccessibilityService.java  # UI automation (Phase 3)
├── .claude/
│   └── skills/
│       ├── unsloth-jobs-training/          # /unsloth-jobs-training — submit LoRA training to HF Jobs
│       ├── lora-to-cactus-hub/             # /lora-to-cactus-hub — convert to Cactus format + push Hub
│       └── build-apk-liquidchat/           # /build-apk-liquidchat — build debug/release APK
├── release/
│   └── LiquidChat.apk                     # Pre-built release APK
├── package.json
├── metro.config.js
└── react-native.config.js
```

## Multi-Model Architecture

LiquidChat v1.0 orchestrates up to 9 specialized models, loaded on demand based on available device RAM:

| Tier | Model | Size (INT8) | Purpose |
|------|-------|-------------|---------|
| **Hot** | LFM2.5-1.2B-Instruct + LoRA | ~750MB | Core brain — every interaction |
| **Hot** | LFM2-350M | 272MB | Fast chat fallback |
| **Hot** | silero-vad | ~5MB | Always-on voice detection |
| **Warm** | whisper-small | 210MB | Speech-to-text |
| **Warm** | Qwen3-Embedding-0.6B | 394MB | Memory embeddings + RAG |
| **Warm** | LFM2-VL-450M | 420MB | Vision — screenshot understanding |
| **Warm** | LFM2-1.2B-Tool | 722MB | Structured API / tool-heavy tasks |
| **Cold** | LFM2.5-1.2B-Thinking | ~750MB | Multi-step planning |
| **Cold** | LFM2.5-VL-1.6B | 1440MB | Detailed image analysis |

The `ModelLifecycleManager` handles LRU eviction of warm/cold models to stay within the device RAM budget. Hot tier models are never evicted.

## Roadmap

### Phase 0 — Foundation (Done)
LoRA trained, 7 tools working, token streaming, HF Hub export, APK shipping.

### Phase 1 — System Controls (Done)
+10 system control tools, `SystemControlsModule` native bridge, compound actions through the agent runtime. LoRA retrain on the expanded dataset is still open.

### Phase 2 — Voice Input
Integrate `useCactusVAD` + `useCactusSTT` hooks, `VoiceInputButton` component, full voice loop via existing `ttsManager.ts`.

### Phase 3 — Memory & RAG
`MemoryService.ts` with CactusIndex + Qwen3-Embedding-0.6B, RAG corpus manager in Settings, `LFM2-1.2B-RAG` for document Q&A.

### Phase 4 — Vision + UI Automation
LFM2-VL-450M see-then-act pattern, `LiquidChatAccessibilityService.java` + React Native bridge, 10 UI automation tools.

### Phase 5 — Model Orchestration
`ModelLifecycleManager` + `IntentRouter` + `AgentDashboard`, `LFM2.5-1.2B-Thinking` for multi-step planning, device-adaptive model configs.

### Phase 6 — iOS Parity
iOS native modules, Shortcuts/Intents integration, XCUITest-style automation.

> **LoRA Improvement Loop:** The HF Hub export feature (`chatExport.ts` + `huggingfaceApi.ts`) creates a continuous flywheel: real user interactions are exported as JSONL, curated, and fed back into LoRA training after each phase. Target dataset grows from 31,550 → ~41,000+ samples.

## Training Pipeline

LoRA training uses [Unsloth](https://github.com/unslothai/unsloth) on Hugging Face Jobs cloud GPUs. Three Claude Code skills automate the full model-to-APK pipeline:

| Skill | Command | Purpose |
|-------|---------|---------|
| Unsloth Jobs Training | `/unsloth-jobs-training` | Submit LoRA fine-tuning job to HF Jobs (A10G/A100) |
| LoRA to Cactus Hub | `/lora-to-cactus-hub` | Merge adapter + convert to Cactus binary format + push Hub |
| Build APK | `/build-apk-liquidchat` | Build debug or release Android APK |

Training defaults: LFM2.5-1.2B-Instruct base, LoRA r=16/alpha=16, batch size 8 (effective 32), 3 epochs, 2e-4 LR, A100 80GB. Monitoring via [Trackio](https://huggingface.co/spaces/kshitijthakkar/trackio).

## Installation

### Pre-built APK

Download and install `release/LiquidChat.apk` on your Android device (Android 7+).

### Build from Source

**Prerequisites:**
- Node.js >= 20
- JDK 17+
- Android SDK with NDK 27.1.12297006
- `ANDROID_HOME` environment variable set

```bash
# Install dependencies
npm install

# Debug build (run on connected device)
npm run android

# Release APKs (two flavors: `full` = sideload with UI automation, `play` = Play Store policy-safe)
cd android && ./gradlew assembleFullRelease -PreactNativeArchitectures=arm64-v8a
```

APK output: `android/app/build/outputs/apk/full/release/app-full-release.apk`. Release builds are currently signed with the debug keystore (fine for sideloading; add your own keystore before publishing to Play).

### Model Setup

Models are downloaded in-app via the Model Selection screen. Cactus stores weights in `files/cactus/models/<slug>-<int4|int8>`; after upgrading from the 1.7 engine the app offers a one-time re-download. For manual sideloading:

```bash
adb push weights/lfm25-mobile-actions/ /data/local/tmp/lfm25-mobile-actions/
adb shell run-as com.liquidchat cp -r /data/local/tmp/lfm25-mobile-actions /data/user/0/com.liquidchat/files/models/
```

## Tech Stack

| Component | Technology |
|-----------|-----------|
| **Framework** | React Native 0.81.1 |
| **LLM Runtime** | Cactus React Native 1.13.1 (on-device inference) |
| **Model Format** | Cactus binary format (CACT header + quantized tensors) |
| **State** | React hooks + AsyncStorage |
| **Navigation** | Custom state-based (no react-navigation dependency) |
| **Flashlight** | react-native-torch |
| **Camera/Images** | react-native-image-picker |
| **File System** | @dr.pogodin/react-native-fs |
| **TTS** | react-native-tts |
| **Haptics** | react-native-haptic-feedback |
| **Training** | Unsloth + TRL on Hugging Face Jobs |
| **Model Hub** | Hugging Face Hub (datasets + model weights) |

## License

This project is for research and testing purposes. The base model ([LiquidAI/LFM2.5-1.2B-Instruct](https://huggingface.co/LiquidAI/LFM2.5-1.2B-Instruct)) is subject to Liquid AI's license terms.

## Author

Developed by **Kshitij Thakkar**

*github.com/Mandark-droid · huggingface.co/kshitijthakkar*
