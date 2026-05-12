# LIQUID CHAT
## Fully Local Personal Agent — Design Specification v1.0

**React Native · Cactus Engine · Liquid AI LFM2.5**

| | |
|---|---|
| **Base Model** | LiquidAI/LFM2.5-1.2B-Instruct |
| **LoRA** | kshitijthakkar/LFM2.5-1.2B-Instruct-mobile-actions |
| **Dataset** | google/mobile-actions (8,693 train / 961 eval) |
| **Runtime** | Cactus Compute v1.x (fully on-device, zero cloud) |
| **Platform** | React Native 0.81.1 (Android shipping, iOS planned) |
| **Author** | Kshitij Thakkar |
| **Date** | February 2026 |

---

## 1. Executive Summary

Liquid Chat is a fully local, privacy-first personal agent running entirely on-device via the Cactus Compute inference engine. The working prototype already demonstrates the core loop: the fine-tuned LFM2.5-1.2B-Instruct-mobile-actions model translates natural language into structured function calls that execute real Android device actions, all without network connectivity.

This specification describes the evolution from the current 7-tool prototype into a comprehensive personal agent orchestrating the full 21-model Cactus catalog. The agent gains voice input, screenshot understanding, multi-step action planning, persistent semantic memory, document Q&A, and 30+ native device actions.

> **Current State (Phases 0–5 shipped on `feature/phase1-system-controls`)**
> LFM2.5-1.2B-Instruct + LoRA via Unsloth. **27 tools** registered in `src/tools/registry.ts` (7 baseline + 10 system controls + 10 UI automation). Voice input via Whisper STT. On-device semantic memory + document RAG (`MemoryService`, `VectorStore`). Vision pipeline (`VisionAgent`) with screenshot preview. Intent router + model lifecycle manager + agent dashboard. Accessibility service (`LiquidChatAccessibilityService.kt`) implementing 10 UI automation actions. Token streaming, HF Hub dataset export, multi-model browser, custom model loading, TTS, haptics.

> **Remaining for v1.0**
> Phase 2 app-navigation tools (launch_app, send_sms, share_text, search_web, make_phone_call, open_url, open_file, set_wallpaper). Skill-card / deeplink skills system (post-spike, scoped down — see §5.4 revised). Scene-grounded intent rewrite (§3.2). Working/long-term memory split (§9). LoRA retrain covering the full 30+ tool surface. iOS parity (Phase 6).

---

## 2. Current Architecture (v0.x Baseline)

### 2.1 Project Structure

| Layer | Files | Function |
|-------|-------|----------|
| Screens | ChatScreen, ChatList, ModelSelection, Settings | Tab navigation, chat as primary |
| Components | MessageBubble, ToolCallCard, ModelCard, MetricsBar | Chat UI, tool viz, live tok/s |
| Tools | registry.ts + 6 tool files | 7 tools in google/mobile-actions format |
| Services | huggingfaceApi.ts, chatExport.ts | Push-to-hub JSONL for retraining |
| Utils | toolParser.ts, storage.ts, ttsManager, haptics | JSON parsing, AsyncStorage, TTS, vibration |

### 2.2 Tool Calling Flow (Preserved)

1. **System Prompt:** Tool definitions injected from registry.ts in google/mobile-actions JSON format.
2. **Generation:** CactusLM streams tokens with tool context.
3. **Parse:** toolParser.ts extracts `[{"name":"...", "arguments":{...}}]` from output.
4. **Execute:** Dispatches to native modules (react-native-torch, Linking.sendIntent, etc.).
5. **Display:** ToolCallCard renders result inline.

### 2.3 Limitations Remaining (post Phase 5)

- App-navigation tools (launch_app, send_sms, share_text, search_web, make_phone_call, open_url, open_file, set_wallpaper) — not yet added to registry
- Scene-grounded intent rewrite not yet wired between `VisionAgent` and `IntentRouter` (see §3.2)
- Memory is single-store; working/long-term split not yet implemented (see §9)
- Skill-card / deeplink-skill system not built (see §5.4 revised)
- LoRA trained against the original 7-tool surface; needs retrain for 27+ tools
- iOS native modules not implemented (Phase 6)

---

## 3. Target Architecture (v1.0)

### 3.1 Multi-Model Orchestrator

| Layer | Component | Model(s) | Status |
|-------|-----------|----------|--------|
| Input | Text | N/A | DONE |
| Input | Voice Pipeline | silero-vad + whisper-small | NEW |
| Input | Vision Pipeline | LFM2-VL-450M | NEW |
| Brain | Intent Router + Actions | LFM2.5-1.2B + LoRA | EXTEND |
| Brain | Reasoning Engine | LFM2.5-1.2B-Thinking | NEW |
| Exec | Mobile Actions (30+) | LoRA + native bridges | EXTEND |
| Exec | Tool Dispatch | LFM2-1.2B-Tool | NEW |
| Exec | Document QA | LFM2-1.2B-RAG | NEW |
| Exec | Quick Chat | LFM2-350M | NEW |
| Memory | Embeddings + Index | Qwen3-Embedding-0.6B + CactusIndex | NEW |

### 3.2 Data Flow

```
USER INPUT (voice | text | screenshot | camera)
    |
    +-- voice -> silero-vad -> whisper-small -> text
    +-- screenshot/camera -> LFM2-VL-450M -> scene description
    v
SCENE-GROUNDED INTENT REWRITE  (only when visual context present)
    raw utterance + scene description -> rewritten utterance with resolved referents
    e.g. "how much is this?" + camera(Evian spray) -> "price of Evian spray"
    v
INTENT ROUTER (LFM2.5-1.2B + LoRA)
    +-- ACTION  -> LoRA tool_call JSON -> native execution
    +-- QUERY   -> embed -> CactusIndex -> LFM2-1.2B-RAG
    +-- REASON  -> LFM2.5-1.2B-Thinking -> action plan -> ACTION loop
    +-- TOOL    -> LFM2-1.2B-Tool (structured API calls)
    +-- CHAT    -> LFM2-350M (fast fallback)
    v
WORKING MEMORY (current task: screenshots, observations, execution state)
    v
LONG-TERM MEMORY (embedded interaction summaries + distilled user profile)
```

> **Design Principle:** The existing ChatScreen flow, toolParser.ts, registry.ts, and all 7 native tools remain untouched. The orchestrator wraps them. New tools use the same registry pattern. The LoRA stays the primary brain.

> **Scene-Grounded Intent Rewrite (new):** When the user provides visual context (camera frame or screenshot) alongside their utterance, the VLM first produces a scene description, then a lightweight rewrite step expands deictic references ("this", "that", "it") and resolves implicit subjects against the scene before the IntentRouter sees the query. This single step substantially improves routing and tool-arg quality on multimodal inputs without changing downstream components.

---

## 4. Model Catalog & Memory Budget

### 4.1 Tier 1 — Hot (Always Loaded)

| Model | INT8 Size | Why Hot |
|-------|-----------|---------|
| LFM2.5-1.2B-Instruct + LoRA | ~750MB | Core brain, every interaction |
| LFM2-350M | 272MB | Ultra-fast chat fallback |
| silero-vad | ~5MB | Always-on voice detection |

**Hot budget:** ~927MB. Fits on 4GB+ devices.

### 4.2 Tier 2 — Warm (On Demand)

| Model | INT8 Size | Load Trigger |
|-------|-----------|-------------|
| whisper-small | 210MB | First voice input |
| Qwen3-Embedding-0.6B | 394MB | First memory/RAG operation |
| LFM2-VL-450M | 420MB | First screenshot/camera |
| LFM2-1.2B-Tool | 722MB | Tool-heavy workflow |
| LFM2-1.2B-RAG | 722MB | Document corpus activated |

### 4.3 Tier 3 — Cold (Available via Model Browser)

| Model | INT8 Size | Use Case |
|-------|-----------|----------|
| LFM2.5-1.2B-Thinking | ~750MB | Complex multi-step planning |
| LFM2.5-VL-1.6B | 1440MB | Detailed image analysis (flagship) |
| whisper-medium | 646MB | Higher accuracy STT |
| Qwen3-1.7B | 1161MB | Large chat + tools |
| LFM2-2.6B | ~1500MB | Highest quality responses |
| LFM2-700M / 350M | 467/233MB | Low-end device fallbacks |
| nomic-embed-v2-moe | 533MB | MoE embeddings |
| LFM2-350M | ~172MB | Ultra-light function calling |
| moonshine-base | ~100MB | Alternative STT |

### 4.4 Model Lifecycle Manager

```typescript
// src/services/ModelLifecycleManager.ts
type ModelState = 'not_downloaded' | 'downloaded' | 'loading' | 'ready' | 'evicting';

interface ManagedModel {
  slug: string;
  tier: 'hot' | 'warm' | 'cold';
  state: ModelState;
  instance: CactusLM | CactusSTT | CactusVAD | null;
  lastUsed: number;
  ramMb: number;
}

class ModelLifecycleManager {
  private models: Map<string, ManagedModel>;
  private maxRamMb: number; // detected at startup via deviceMetrics.ts

  async ensure(slug: string): Promise<CactusLM | CactusSTT | CactusVAD> {
    const model = this.models.get(slug);
    if (model?.state === 'ready') return model.instance!;
    await this.evictIfNeeded(model!.ramMb);
    // download if needed, init, return
  }

  private async evictIfNeeded(neededMb: number) {
    // LRU eviction of warm/cold models until budget fits
    // Never evict hot tier models
  }
}
```

---

## 5. Expanded Mobile Actions (7 → 30+ Tools)

### 5.1 Current Tools (Shipping)

| Tool | Implementation | Status |
|------|---------------|--------|
| turn_on_flashlight / turn_off_flashlight | react-native-torch | ✅ DONE |
| open_wifi_settings | Linking.sendIntent | ✅ DONE |
| create_calendar_event | Calendar content intent | ✅ DONE |
| send_email | mailto: URL scheme | ✅ DONE |
| show_map | geo: URL scheme | ✅ DONE |
| create_contact | Contacts content intent | ✅ DONE |

### 5.2 Phase 1 — System Controls (+10 tools) — ✅ SHIPPED

All 10 tools registered in `src/tools/registry.ts` and implemented via `SystemControlsModule.kt`. `take_screenshot` uses `GLOBAL_ACTION_TAKE_SCREENSHOT` from the a11y service (no notification, API 30+) — not `MediaProjection` as originally drafted.

| Tool | Parameters | Android Implementation |
|------|-----------|----------------------|
| set_brightness | level: 0-100 | Settings.System.SCREEN_BRIGHTNESS |
| set_volume | stream, level: 0-100 | AudioManager.setStreamVolume |
| toggle_bluetooth | enable: bool | BluetoothAdapter.enable/disable |
| toggle_airplane_mode | enable: bool | Settings intent |
| toggle_dnd | enable: bool | NotificationManager |
| set_alarm | hour, minute, label | ACTION_SET_ALARM intent |
| set_timer | seconds, label | ACTION_SET_TIMER intent |
| take_screenshot | none | a11y service GLOBAL_ACTION_TAKE_SCREENSHOT |
| toggle_rotation_lock | enable: bool | Settings.System |
| open_settings_page | page: string | Settings.ACTION_* intents |

### 5.3 Phase 2 — App Navigation (+8 tools) — ⏳ NOT YET BUILT

| Tool | Parameters | Android Implementation |
|------|-----------|----------------------|
| launch_app | package_name or app_name | getLaunchIntentForPackage |
| open_url | url: string | ACTION_VIEW intent |
| share_text | text, app? | ACTION_SEND intent |
| search_web | query: string | ACTION_WEB_SEARCH |
| make_phone_call | number: string | ACTION_DIAL intent |
| send_sms | number, message | ACTION_SENDTO sms: scheme |
| open_file | path, mime_type | FileProvider URI |
| set_wallpaper | image_path | WallpaperManager |

### 5.4 Phase 3 — UI Automation & Skill Cloning

UI automation in v1.0 is a **three-tier strategy**, picked dynamically per task. Tier 2 (a11y service + 10 actions) is **already shipped**; Tier 1 is scoped down post-spike and not yet built; Tier 3 reuses existing intent-based tools from §5.3.

#### Tier 1 — Skill cards (cloned trajectories, +2 tools) — ⏳ NOT YET BUILT (post-spike scope)

| Tool | Parameters | Implementation |
|------|-----------|---------------|
| clone_skill | name, description | While user demos a flow, capture each foreground Activity's launch Intent via `dumpsys activity top` (action, data URI, extras) + a VLM-generated page summary. Persist as a "skill card" in AsyncStorage. |
| replay_skill | name_or_query, params? | Match query against stored skill cards, fire the captured Intent directly via `startActivity`. Multi-tier launch fallback: (a) full Intent with all extras → (b) action+data only → (c) `LAUNCHER` category for the package → (d) task-stack restore via `ActivityManager.moveTaskToFront`. |

Skill cards turn user-demoed navigation into reusable one-shot jumps — e.g. "Meituan flash-sale page" or "CapCut one-tap video editor" become single Intent fires rather than multi-step UI walks. This is robust to UI drift, ads, and intermediate page changes.

#### Tier 2 — Hybrid UI grounding (+10 tools, Accessibility Service) — ✅ SHIPPED (a11y portion); OCR/VLM fallback deferred

All 10 tools implemented in `LiquidChatAccessibilityService.kt` and routed via `AccessibilityBridgeModule.kt`. Currently a11y-tree-only — VLM/OCR fallback paths described below are deferred until a real-world coverage gap proves them necessary (see §11.5 F4).

When no skill card matches, fall back to direct UI manipulation. Hybrid grounding combines three signals — the system picks whichever is most reliable per element:

- **XML (a11y tree)** — primary when `resource_id` / `content_desc` are present
- **VLM visual grounding** (LFM2-VL-450M) — for ad-heavy or visually cluttered screens where XML is misleading or missing spatial info
- **OCR** — for elements rendered as bitmaps (banners, custom-drawn buttons)

| Tool | Parameters | Implementation |
|------|-----------|---------------|
| tap_element | text / content_desc / resource_id | AccessibilityNodeInfo CLICK, with VLM/OCR fallback for spatial tap |
| long_press_element | target, duration_ms | LONG_CLICK action |
| scroll_screen | direction: up/down/left/right | performGlobalAction SCROLL |
| type_text_in_field | target, text | ACTION_SET_TEXT |
| read_screen | none (returns UI tree + OCR overlay) | getRootInActiveWindow + on-device OCR |
| find_element | query text | findNodeInfosByText, fallback to VLM grounding |
| go_back | none | GLOBAL_ACTION_BACK |
| go_home | none | GLOBAL_ACTION_HOME |
| open_recents | none | GLOBAL_ACTION_RECENTS |
| swipe | start_xy, end_xy, duration | GestureDescription.Builder |

#### Tier 3 — Deeplink / Intent direct entry

Even without a cloned skill, many requests resolve to a known `<target_app, action, params>` triple → application-native entry point (e.g. `geo:`, `tel:`, package-specific deeplinks). This reuses §5.3 tools and avoids UI walks entirely. The IntentRouter prefers this path when the triple can be confidently resolved.

> **Accessibility Service Architecture:** `LiquidChatAccessibilityService.java` runs as a background Android service. React Native communicates via BroadcastReceiver. User enables it manually in Settings > Accessibility. Same pattern as Tasker and MacroDroid. Without it, Tier 2 tools degrade to intent-based fallbacks; Tier 1 and Tier 3 remain fully functional.

### 5.5 Tool Registry Pattern (Unchanged)

New tools follow the exact same pattern as existing ones:

```typescript
// src/tools/brightness.ts
import { NativeModules } from 'react-native';

export const setBrightnessTool = {
  name: 'set_brightness',
  description: 'Set the screen brightness level',
  parameters: {
    type: 'object',
    properties: {
      level: { type: 'number', description: 'Brightness 0-100' },
    },
    required: ['level'],
  },
  execute: async (args: { level: number }) => {
    await NativeModules.SystemControls.setBrightness(args.level);
    return { success: true, brightness: args.level };
  },
};
```

---

## 6. LoRA Retraining Plan

The current LoRA covers 7 tools from 8,693 google/mobile-actions samples. Supporting 30+ tools requires additional synthetic training data.

| Data Source | Samples | Coverage |
|------------|---------|----------|
| google/mobile-actions (existing) | 8,693 | Current 7 tools |
| Synthetic: System controls | ~5,000 | 10 new system tools |
| Synthetic: App navigation | ~4,000 | 8 new nav tools |
| Synthetic: UI automation | ~6,000 | 10 accessibility tools |
| Synthetic: Compound actions | ~5,000 | Multi-step chains (2-5 steps) |
| Synthetic: Intent boundaries | ~2,000 | ACTION vs QUERY vs CHAT routing |
| Synthetic: Error recovery + safety | ~1,500 | Failures, refusals, retries |
| Real user data (via HF export) | ongoing | Continuous improvement |

**Total:** ~32,000 new + 8,693 existing = ~41,000 samples. Same LoRA config (r=16, alpha=16), Unsloth training. The HF Hub export creates a natural flywheel for continuous improvement.

### 6.1 Tool Format Migration

The current LoRA outputs google/mobile-actions JSON. New training data should use native LFM2.5 format:

```
// Current (keep for backward compat):
[{"name": "turn_on_flashlight", "arguments": {}}]

// New tools (native LFM2.5 format):
<|tool_call_start|>
[set_brightness(level=50)]
<|tool_call_end|>
```

A dual parser in toolParser.ts handles both formats. The Cactus SDK's built-in `functionCalls` parsing handles the native format automatically via `CactusLMTool` definitions passed to `complete()`.

---

## 7. Voice Input Pipeline

| Stage | Hook | Model | Latency |
|-------|------|-------|---------|
| Wake Detection | useCactusVAD | silero-vad (~5MB) | Real-time |
| Streaming STT | useCactusSTT.streamTranscribe* | whisper-small (210MB) | <2s TTFT |
| Intent + Action | useCactusLM.complete | LFM2.5-1.2B + LoRA | ~45ms TTFT |

```typescript
// src/hooks/useVoiceAgent.ts
export function useVoiceAgent() {
  const vad = useCactusVAD({ model: 'silero-vad' });
  const stt = useCactusSTT({ model: 'whisper-small' });

  const startListening = async () => {
    await stt.streamTranscribeStart({ confirmationThreshold: 0.99 });
    // Feed audio chunks from microphone
    // When VAD detects silence, finalize:
    const final = await stt.streamTranscribeStop();

    // Route through the action brain
    const result = await brain.complete({
      messages: [
        { role: 'system', content: systemPromptWithTools },
        { role: 'user', content: final.confirmed },
      ],
      tools: allRegisteredTools,
    });

    if (result.functionCalls?.length) {
      await executeToolCalls(result.functionCalls);
    }
  };
}
```

---

## 8. Vision Pipeline (See-Then-Act)

The VLM enables the agent to understand the screen before acting — critical for UI automation where the agent needs spatial awareness.

```typescript
// src/services/VisionAgent.ts
const vlm = new CactusLM({ model: 'lfm2-vl-450m' });

async function seeAndAct(screenshotPath: string, userIntent: string) {
  // Step 1: Describe UI
  const scene = await vlm.complete({
    messages: [{
      role: 'user',
      content: 'Describe all UI elements with their positions.',
      images: [screenshotPath],
    }],
  });

  // Step 2: Plan action from scene + intent
  const action = await brain.complete({
    messages: [
      { role: 'system', content: systemPromptWithTools },
      { role: 'user', content: `Screen: ${scene.response}\nIntent: ${userIntent}` },
    ],
    tools: uiAutomationTools,
  });

  // Step 3: Execute
  if (action.functionCalls) await executeToolCalls(action.functionCalls);
}
```

Two vision modes:

- **Screenshot Analysis:** User triggers a screenshot, VLM describes the UI layout, action LoRA uses that description to plan taps/scrolls. This is the "see then act" pattern.
- **Camera Input:** User points camera at something (already partially supported via react-native-image-picker in the codebase). VLM describes the content.

---

## 9. Persistent Memory

Current: AsyncStorage for chat history. New: a **two-layer memory model** that separates short-lived task state from durable user knowledge, plus strict separation of memory *production* from *consumption*.

#### 9.1 Working Memory (per-task, in-RAM, no embeddings)

Holds the active task's state so a multi-step chain can resume after an interruption (ad, app switch, mid-chain failure). Lives on `ActionChainExecutor`, cleared when the task completes or the user starts a new chain.

| Field | Purpose |
|-------|---------|
| current_screenshot | Latest screen capture for VLM verification between steps |
| observation_log | Compressed scene descriptions per step |
| tool_results | Outputs of each executed tool call in the chain |
| execution_state | Step index, retry count, last error |

#### 9.2 Long-Term Memory (cross-session, persistent)

| Store | Tech | Purpose |
|-------|------|---------|
| Chat History | AsyncStorage (existing) | Full message logs |
| Semantic Memory | CactusIndex + Qwen3-Embedding-0.6B | Embedded interaction summaries |
| Document Corpus | CactusLM corpusDir (RAG mode) | User .txt files for grounded Q&A |
| Action Log | AsyncStorage (new) | Tool call history with outcomes |
| Skill Cards | AsyncStorage (new) | Cloned trajectory Intents (see §5.4 Tier 1) |
| Gallery Memory | Markdown file + CactusIndex | Per-image semantic record {objects, scene, event, timestamp} distilled by VLM during idle time |
| User Profile | Markdown file | Slowly-updated user facts distilled from interactions (preferences, recurring contacts, frequent apps) |

#### 9.3 Production vs. Consumption

Memory-producing flows (gallery scan, profile distillation, summarisation) are isolated as background skills that write to the stores. Memory-consuming flows (retrieval for RAG, profile injection into system prompt) only *read*. They never share code paths. Rationale: production is slow, failure-prone, and runs idle; consumption is hot-path. Mixing them has historically caused cascading failures.

#### 9.4 Privacy Filter (write-side)

Every write to long-term memory passes through a redaction step: strip phone numbers, emails, SMS bodies, and OTP-shaped tokens unless the user has explicitly opted in per-store. User controls in Settings: enable/disable gallery memory, clear user profile, export/clear semantic index.

```typescript
// src/services/MemoryService.ts
const embedder = new CactusLM({ model: 'qwen3-embedding-0.6b' });
const index = new CactusIndex('liquid-memory', 1024);

async function remember(text: string) {
  const { embedding } = await embedder.embed({ text });
  await index.add({
    ids: [Date.now()],
    documents: [text],
    embeddings: [embedding],
  });
}

async function recall(query: string, topK = 3) {
  const { embedding } = await embedder.embed({ text: query });
  return index.query({
    embeddings: [embedding],
    options: { topK, scoreThreshold: 0.7 },
  });
}
```

---

## 10. UI Changes

### 10.1 ChatScreen Extensions
- Microphone button for voice input (VoiceInputButton component)
- Screenshot capture button for vision pipeline
- Multi-step progress indicator (ActionChainProgress component)
- Memory context chips when relevant memories are recalled

### 10.2 New: AgentDashboard Screen
- Loaded models with RAM usage from ModelLifecycleManager
- Action history log with success/failure rates
- Memory index stats (count, size)
- Device metrics (battery, RAM, temperature) from deviceMetrics.ts

### 10.3 ModelSelectionScreen Extensions
- Tier badges (Hot / Warm / Cold) on ModelCard
- "Active" indicator for loaded models
- RAM estimate before download

### 10.4 SettingsScreen Extensions
- Voice: wake sensitivity, STT model choice (whisper-small vs medium)
- Memory: auto-remember toggle, index clear/export
- RAG: corpus file manager (add/remove .txt files)
- Accessibility service guided setup

---

## 11. Expanded Project Structure

```
LiquidChat/
  src/
    App.tsx                                   # + AgentDashboard tab
    screens/
      ChatScreen.tsx                          # + voice, screenshot, memory
      ChatListScreen.tsx                      # unchanged
      ModelSelectionScreen.tsx                 # + tier badges, RAM display
      SettingsScreen.tsx                       # + voice, memory, a11y config
      AgentDashboardScreen.tsx                 # NEW
    components/
      MessageBubble.tsx                        # unchanged
      ToolCallCard.tsx                         # + multi-step chain rendering
      ModelCard.tsx                            # + tier badge, active indicator
      MetricsBar.tsx                           # + model RAM usage
      VoiceInputButton.tsx                     # NEW
      ScreenshotPreview.tsx                    # NEW
      MemoryChips.tsx                          # NEW
      ActionChainProgress.tsx                  # NEW
    tools/
      registry.ts                              # EXTEND: 7 -> 30+ entries
      flashlight.ts ... contacts.ts            # unchanged
      brightness.ts                            # NEW
      volume.ts                                # NEW
      bluetooth.ts                             # NEW
      alarm.ts                                 # NEW
      appLauncher.ts                           # NEW
      sms.ts                                   # NEW
      phoneCall.ts                             # NEW
      uiAutomation.ts                          # NEW (a11y bridge)
      ... (all Phase 1-3 tools)
    services/
      huggingfaceApi.ts                        # unchanged
      chatExport.ts                            # unchanged
      ModelLifecycleManager.ts                 # NEW
      IntentRouter.ts                          # NEW
      MemoryService.ts                         # NEW
      VisionAgent.ts                           # NEW
      ActionChainExecutor.ts                   # NEW
    hooks/
      useVoiceAgent.ts                         # NEW
      useModelManager.ts                       # NEW
      useMemory.ts                             # NEW
    utils/
      toolParser.ts                            # EXTEND: dual format + chains
      storage.ts                               # unchanged
      ttsManager.ts                            # unchanged
      haptics.ts                               # unchanged
      deviceMetrics.ts                         # EXTEND: RAM tier detection
    config/
      models.ts                                # EXTEND: tier assignments
      theme.ts                                 # unchanged
      toolCategories.ts                        # NEW: tool groupings
    types/
      index.ts                                 # EXTEND: new types
  android/
    app/src/main/java/.../
      LiquidChatAccessibilityService.java      # NEW
      SystemControlsModule.java                # NEW (native bridge)
      AccessibilityBridge.java                 # NEW (RN <-> a11y)
```

---

## 11.5 Feasibility Assumptions (Pre-Build Spikes Required)

Mobile development punishes optimism. The following design elements depend on Android platform behaviors that are not guaranteed on stock, non-rooted devices and **must be validated by a short feasibility spike before the relevant phase is committed**. If a spike fails, the spec downgrades to the stated fallback rather than the team discovering the limitation mid-implementation.

| # | Assumption | Status | Spec section affected | Resolution |
|---|-----------|--------|----------------------|------------|
| F1 | `dumpsys activity top` is callable from app process to retrieve current Activity's full launch Intent including extras | ❌ **FAILS** (verified via static analysis on `targetSdk 36`) | §5.4 Tier 1 skill cards | Requires signature-level `android.permission.DUMP`, not grantable to third-party apps. **Spec downgrade applied** — see §5.4 Tier 1 revised below. |
| F2 | Foreground Activity (`<package, class>`) can be captured during user demo via existing accessibility service | ✅ **WORKS** (verified — `LiquidChatAccessibilityService.onAccessibilityEvent` exists, currently no-op at line 44) | §5.4 Tier 1 capture path | Use `TYPE_WINDOW_STATE_CHANGED` events. No new permissions needed. Captures package + activity class name only — **no Intent extras, no data URI**. |
| F3 | Captured `<package, class>` can be replayed to restore exact in-app state | ⚠️ **PARTIAL** | §5.4 Tier 1 replay | Works only when target Activity has `android:exported="true"`. Most in-app deep Activities are not exported → `SecurityException`. Realistic capability: "open the app the user demoed in" + optional curated per-app deeplink templates. **Not** "restore exact page". |
| F4 | On-device OCR feasible inside RN | ✅ Available via ML Kit on-device English model (~3MB, no Play Services required) | §5.4 Tier 2 hybrid grounding | Adds `com.google.mlkit:text-recognition` Gradle dep — non-Cactus inference engine. Architectural decision: ship without OCR in Phase 4; add only if real screens prove a11y+VLM insufficient. |
| F5 | LFM2-VL-450M inference on idle-time gallery photos stays within thermal/battery budget | ⏳ Unvalidated (needs real-device spike) | §9.2 Gallery Memory | Default: cap at 20 most-recent photos per scan, user-initiated only, no background scan, until thermal data exists. |
| F6 | `WorkManager` reliably triggers idle-time scans on Xiaomi/Oppo/Samsung battery-aggressive OEMs | ⏳ Unvalidated | §9.2 Gallery Memory scheduling | Foreground-only scan + manual "scan now" button. Skip `WorkManager` for v1.0. |
| F7 | `take_screenshot` works without persistent notification | ✅ **ALREADY SOLVED** | §5.2 take_screenshot | Existing `LiquidChatAccessibilityService.kt:289` uses `GLOBAL_ACTION_TAKE_SCREENSHOT` (API 30+). No notification, no `MediaProjection` needed. |
| F8 | Accessibility-tree UI automation works on top apps (WhatsApp, Instagram, banking) | ⏳ Unvalidated per-app | §5.4 Tier 2 | Maintain a `docs/a11y-coverage.md` matrix; banking apps are likely to block a11y by FLAG_SECURE — route those to deeplinks only. |

### 11.5.1 Spike-driven revision: Tier 1 Skill Cards (replaces §5.4 Tier 1 as drafted)

Based on F1 failure and F3 partial result, Tier 1 is redesigned as **two distinct, complementary capabilities** instead of one:

**(a) App Skill Cards** — automatic, captures during user demo via the existing a11y service. Stores `<package, last_foreground_activity_class>`. Replay attempts `Intent.setComponent(...)` first, falls back to `getLaunchIntentForPackage(pkg)`. Honest scope: "jump back to the app I was using to do X" — not exact page restoration. Skill-card storage in AsyncStorage, no new native bridge required.

**(b) Curated Deeplink Skills** — manual, the user (or a community-maintained registry) defines deeplink templates for popular apps (`youtube://watch?v={video_id}`, `geo:0,0?q={query}`, `meituan://...`). Stored as parameterised templates. The IntentRouter resolves natural-language requests to template + slot values. This is what actually delivers the paper's "Meituan flash-sale page" use case — but requires per-app curation, not automatic capture.

The spec should **not** promise automatic exact-page restoration. That feature requires either platform partnership (OPPO's situation) or signature-level permissions.

**Spike protocol:** each remaining ⏳ assumption gets a ≤1-day throwaway-branch spike on a real device before its phase is committed. Confirmed assumptions unlock the phase; failures trigger a documented spec downgrade rather than a mid-phase scramble.

---

## 12. Implementation Roadmap

### Phase 0: Foundation — ✅ SHIPPED (`ef24bb2`)
- LoRA trained, 7 tools, streaming, HF export, APK

### Phase 1: System Controls — ✅ SHIPPED (`173d806`)
- 10 system tools + `SystemControlsModule.kt`
- Compound parser in `toolParser.ts`
- Synthetic training data generator (LoRA retrain pending — still on 7-tool LoRA)

### Phase 2: Voice Input — ✅ SHIPPED (`34440d0`)
- `useVoiceInput` hook + `VoiceInputButton`, Whisper STT
- TTS loop via existing `ttsManager.ts`

### Phase 3: Memory & RAG — ✅ SHIPPED (`269a780`)
- `MemoryService`, `VectorStore`, `useMemory`, `MemoryChips`
- RAG corpus path in `SettingsScreen`

### Phase 4: Vision + UI Automation — ✅ SHIPPED (`f21d096`)
- `VisionAgent` + `ScreenshotPreview` + `VisionModeOverlay`
- `LiquidChatAccessibilityService.kt` + `AccessibilityBridgeModule.kt`
- All 10 UI automation tools registered

### Phase 5: Model Orchestration — ✅ SHIPPED (`db12cfa`)
- `ModelLifecycleManager`, `IntentRouter`, `AgentDashboardScreen`
- `TierBadge`, `RamUsageBar`, `useModelManager`
- Hot-fixes: `ca0e04c` (RAM budget), `9a8df32` (custom-model load path)

### Phase 6 (next): Paper-inspired upgrades + Phase 2 nav tools (3-4 weeks)
The unfinished v1.0 work, in priority order:
1. **Scene-grounded intent rewrite** (§3.2) — smallest change, biggest UX lift. Wire `VisionAgent` output into `IntentRouter` as a query-rewrite step. Pure TS, no native code.
2. **Working/long-term memory split** (§9) — refactor `MemoryService`; add `WorkingMemory` object on `ActionChainExecutor`. Pure TS.
3. **App navigation tools** (§5.3) — 8 tools, all `Linking.sendIntent` / URL-scheme based. No new permissions needed (all already declared except `CALL_PHONE` for `make_phone_call`).
4. **LoRA retrain** covering the full 27+ tool surface using synthetic data already scaffolded in Phase 1.
5. **Skill cards (post-spike scope)** (§5.4 Tier 1) — app-level skill cards via existing a11y `onAccessibilityEvent` + curated deeplink registry. Defer until 1–4 are done.

### Phase 7: iOS Parity (4+ weeks)
- iOS native modules for system controls
- iOS Shortcuts/Intents integration for app actions
- No a11y equivalent; UI automation features will be limited surface

> **Continuous: LoRA Improvement Loop**
> The existing HF Hub export feature (chatExport.ts + huggingfaceApi.ts) creates a natural flywheel: real user interactions are exported as JSONL, curated, and fed back into LoRA training. Each phase produces new training data from both synthetic generation and real usage. Target: push a new LoRA checkpoint to HuggingFace after each phase.

---

## 13. Risks & Mitigations

| Risk | Impact | Mitigation |
|------|--------|-----------|
| RAM pressure on mid-range devices | High | Tier loading + LRU eviction + INT4 fallback |
| Accessibility Service permission friction | High | Guided in-app setup + graceful degradation |
| Tool format mismatch (JSON vs native tokens) | Medium | Dual parser + gradual migration |
| Compound action mid-chain failures | Medium | Rollback + screenshot verification between steps |
| iOS automation limitations | High | Shortcuts + limited API surface (no a11y equivalent) |
| Model download size on cellular | Medium | WiFi-only default + progressive download (hot tier first) |
| VLM accuracy on small UI elements | Medium | Fallback to Accessibility tree text-based search |
| Whisper hallucination on noise | Low | VAD pre-filter + confidence threshold + cloud handoff option |

---

*github.com/Mandark-droid · huggingface.co/kshitijthakkar*