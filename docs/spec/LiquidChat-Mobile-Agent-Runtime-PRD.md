LiquidChat — Mobile Agent Runtime

Product Requirements & Technical Design Specification

Project: LiquidChat
Repository: https://github.com/Mandark-droid/LiquidChat
Platform: Android / React Native
Inference Runtime: Cactus
Architecture: Offline-first, hybrid local/cloud AI agent
Design Inspiration: Hermes Agent, adapted for native Android
Document Status: Proposed architecture and implementation roadmap

---

1. Executive Summary

LiquidChat will evolve from a local AI chat application with Android tool-calling capabilities into a persistent, autonomous, privacy-aware mobile AI agent.

The objective is to create a Hermes-like agent experience optimized for smartphones, leveraging native Android APIs, local language models, persistent memory, reusable skills, scheduled workflows, and hybrid inference.

Cactus is the primary inference integration layer. Local models handle requests whenever they can satisfy the required quality, capability, latency, and resource constraints. More capable API-hosted models are used when local execution is insufficient and the user has authorized cloud inference.

Cloud fallback must be selective, observable, privacy-aware, and cost-controlled.

The system must distinguish between:

- Model inference: generating decisions, plans, and responses.
- Agent execution: orchestrating tools and verifying outcomes.
- Device integration: interacting with Android capabilities.
- Persistent state: storing memory, workflows, and task progress.
- Hybrid routing: deciding which model should handle a particular step.
- Security enforcement: ensuring model-generated instructions cannot bypass user permissions.

The architecture must support future expansion without requiring a complete rewrite.

2. Current Foundation

LiquidChat already provides a foundation for local AI inference and Android device interactions.

Known existing capabilities include:

- React Native Android application.
- Cactus-based on-device inference.
- Local model loading and management.
- LFM2.5-1.2B-Instruct fine-tuned for Android actions.
- Native Android tools for device interactions.
- Conversation management.
- Inference performance metrics.
- Conversation export functionality.

Before implementation, inspect the repository and confirm the current state of each feature.

Do not rewrite working components unnecessarily.

Extend the existing architecture using modular interfaces, adapters, and backward-compatible changes.

3. Product Objectives

3.1 Primary Objectives

1. Enable reliable multi-step agent execution.
2. Preserve local inference as the default operating mode.
3. Introduce intelligent fallback to API models when required.
4. Support persistent memory across conversations.
5. Enable reusable, composable agent skills.
6. Integrate deeply with Android capabilities.
7. Support scheduled and event-driven agent execution.
8. Introduce permission-aware, auditable tool execution.
9. Optimize inference for mobile battery, thermal, memory, and latency constraints.
10. Build an evaluation framework for continuous improvement.

3.2 Non-Goals for Initial Release

- Unrestricted autonomous control of all installed applications.
- Bypassing Android permission or security boundaries.
- Silent sending of messages, payments, or other sensitive operations.
- Continuous background execution without Android lifecycle constraints.
- Training or fine-tuning language models directly on the device.
- Automatically installing or executing arbitrary downloaded code.
- Building a separate cloud infrastructure dependency for basic operation.

4. System Architecture

                  LIQUIDCHAT UI
            React Native Application
                        |
              Conversation Manager
                        |
                Agent Controller
                        |
         +--------------+--------------+
         |              |              |
      Planner        Memory         Scheduler
         |              |              |
         +--------------+--------------+
                        |
                Model Router
                        |
             Capability Assessment
                        |
            +-----------+-----------+
            |                       |
       Local Inference         Remote Inference
            |                       |
       Cactus Runtime          Cactus Hybrid/API
            |                       |
       Local Models            API Providers
            |                       |
            +-----------+-----------+
                        |
                Agent Executor
                        |
                Tool Registry
                        |
             Permission Gateway
                        |
               Android Native
                  Services
                        |
                Result Verifier
                        |
              Agent State Store
                        |
                Final Response

The diagram represents logical components, not necessarily independent processes.

The implementation should minimize overhead and reuse the existing Cactus integration.

5. Core Agent Runtime

5.1 Agent Controller

Create a central Agent Controller responsible for coordinating the complete lifecycle of a user request.

Responsibilities:

- Interpret user requests.
- Determine whether tools are required.
- Select appropriate models.
- Generate execution plans.
- Execute tool calls.
- Process tool results.
- Detect failures.
- Recover from recoverable errors.
- Persist execution state.
- Produce final responses.

Suggested interface:

interface AgentController {
  execute(
    request: AgentRequest
  ): Promise<AgentResult>;

  resume(
    executionId: string
  ): Promise<AgentResult>;

  cancel(
    executionId: string
  ): Promise<void>;
}

The Agent Controller must not depend directly on a specific model implementation.

5.2 Agent Execution State Machine

Every agent execution should follow a defined state machine.

CREATED
   |
PLANNING
   |
ROUTING
   |
EXECUTING
   |
VERIFYING
   |
   +---- SUCCESS ----> COMPLETED
   |
   +---- FAILURE ----> RECOVERING
                           |
                       EXECUTING

Additional states:

- WAITING_FOR_PERMISSION
- WAITING_FOR_USER
- WAITING_FOR_NETWORK
- PAUSED
- CANCELLED
- FAILED

Persist state transitions to local storage.

After an application restart, recover unfinished executions only when the operation is safe to resume.

Avoid replaying non-idempotent operations such as sending messages.

Use execution IDs and tool-call IDs to support deduplication.

5.3 Multi-Step Planning

The planner converts user requests into structured executable plans.

Example:

User request:

"Find the PDF I downloaded yesterday, summarize it, and prepare an email."

Plan:

{
  "goal": "Summarize downloaded PDF and draft email",
  "steps": [
    {
      "id": "step_1",
      "tool": "files.search",
      "args": {
        "type": "pdf",
        "date": "yesterday"
      }
    },
    {
      "id": "step_2",
      "tool": "files.read",
      "depends_on": ["step_1"]
    },
    {
      "id": "step_3",
      "operation": "summarize",
      "depends_on": ["step_2"]
    },
    {
      "id": "step_4",
      "tool": "email.compose",
      "depends_on": ["step_3"]
    }
  ]
}

The plan schema must support:

- Dependencies.
- Execution status.
- Retry policies.
- Timeouts.
- Tool outputs.
- Failure handling.
- Required permissions.
- User confirmation requirements.

Plans must be validated before execution.

The model proposes plans; the runtime determines whether they are valid and authorized.

6. Hybrid Model Routing

6.1 Overview

Cactus supports hybrid inference workflows combining local models and API-based models.

LiquidChat should build a policy-driven model router on top of the available Cactus integration.

The exact Cactus API surface must be confirmed against the SDK version used in the repository.

Do not assume unsupported SDK methods exist.

The router must choose between local and remote inference based on:

- Task complexity.
- Required capabilities.
- Model availability.
- Local model confidence or estimated success probability.
- Prior evaluation results.
- Available RAM.
- Battery state.
- Thermal conditions.
- Network availability.
- User privacy preferences.
- Remote inference cost.
- Latency requirements.

6.2 Routing Modes

Provide three user-selectable modes.

Local Only

All inference must run on-device.

No remote inference is permitted.

If the task exceeds local capabilities, explain the limitation or request user intervention.

Hybrid — Default

Local inference is preferred.

Cloud fallback is permitted only when:

1. The request exceeds local capabilities or quality thresholds.
2. Remote inference is allowed by the user's settings.
3. The data is permitted to leave the device.
4. An eligible API model is available.
5. Cost and latency constraints are satisfied.

Cloud Preferred

Use remote inference for eligible requests, subject to privacy policies, availability, and cost limits.

Local inference remains available as an offline fallback.

6.3 Model Capability Registry

Maintain a registry describing available models.

interface ModelCapabilities {
  modelId: string;

  provider: "local" | "remote";

  supportsToolCalling: boolean;
  supportsVision: boolean;
  supportsStructuredOutput: boolean;
  supportsLongContext: boolean;

  maxContextTokens: number;

  estimatedMemoryMB?: number;
  averageLatencyMs?: number;
  averageTokensPerSecond?: number;

  qualityScores?: Record<string, number>;

  estimatedInputCostPerMillion?: number;
  estimatedOutputCostPerMillion?: number;
}

Capability metadata should be populated from verified model information and measured evaluations.

Do not infer model capabilities from parameter count alone.

6.4 Routing Decision

Suggested routing contract:

interface RoutingDecision {
  selectedModelId: string;

  executionMode: "local" | "remote";

  reason: string;

  estimatedLatencyMs?: number;

  estimatedCost?: number;

  confidence?: number;

  requiresUserApproval: boolean;
}

Routing should proceed in stages.

Stage 1 — Capability Filter

Eliminate models that cannot perform the required task.

Examples:

- Vision task requires image support.
- Structured tool calls require compatible output handling.
- Context size must accommodate the request.

Stage 2 — Policy Filter

Eliminate models that violate user preferences, privacy restrictions, network constraints, or budget limits.

Stage 3 — Quality-Aware Selection

Rank eligible models using historical evaluation results, expected task success, latency, and cost.

Stage 4 — Execution

Invoke the selected model.

Stage 5 — Outcome Verification

Determine whether the result satisfies the task requirements.

If verification fails, consider retrying or escalating to another eligible model.

6.5 Quality-Aware Routing

Avoid relying exclusively on a model's self-reported confidence.

Use measurable signals:

- Structured output validation.
- Tool-call argument validity.
- Task-specific evaluation scores.
- Historical success rates.
- Verifier results.
- Repeated failure patterns.
- Explicit uncertainty.
- Unsupported capability detection.

Example:

User Request
     |
Task Classification
     |
Capability Check
     |
Local Model Selected
     |
Local Execution
     |
Output Verification
     |
     +---- PASS ---> Continue
     |
     +---- FAIL ---> Escalation Check
                           |
                    Privacy Policy
                           |
                    Cost Policy
                           |
                    Remote Model
                           |
                       Verification

Do not automatically escalate every ambiguous answer.

Some failures should trigger clarification rather than cloud inference.

6.6 Remote Inference Privacy

Before sending data to an API model:

- Determine the minimum required context.
- Exclude unrelated conversation history.
- Remove secrets and sensitive data where possible.
- Respect user-defined privacy categories.
- Prevent unauthorized attachment uploads.
- Record the destination provider.
- Enforce user-configured cloud permissions.

The first transmission of sensitive content should require explicit user approval unless a sufficiently specific prior authorization exists.

6.7 Fallback Controls

Implement:

- Maximum remote calls per task.
- Maximum estimated spend per task.
- Daily or monthly spend limits.
- Retry limits.
- Provider timeout.
- Network failure handling.
- Provider circuit breakers.
- Cancellation support.

If the remote model fails, do not enter an infinite retry loop.

7. Android Tool System

7.1 Tool Registry

Create a unified tool registry.

interface AgentTool {
  name: string;

  description: string;

  inputSchema: object;

  requiredPermissions: string[];

  riskLevel:
    | "read_only"
    | "reversible"
    | "sensitive";

  execute(
    args: unknown,
    context: ToolContext
  ): Promise<ToolResult>;
}

Existing Android actions should be migrated behind this interface without breaking their current behavior.

7.2 Proposed Tool Categories

Device Control

- Flashlight.
- Volume.
- Brightness where permitted.
- Do Not Disturb with authorized policy access.
- Battery status.
- Network connectivity status.
- Open Android settings.

Personal Information

- Contacts.
- Calendar.
- Files and documents.
- User-authorized notification access.

Communication

- Compose email.
- Draft SMS.
- Share content.
- Open messaging applications.

Sending messages must require appropriate permissions and explicit approval.

Productivity

- Search documents.
- Summarize files.
- Create reminders.
- Open URLs.
- Extract structured information.

Context Awareness

- Current battery state.
- Thermal status where exposed.
- Network state.
- Foreground application information where permitted.
- Location with explicit user permission.

7.3 Permission Gateway

Every tool invocation must pass through the Permission Gateway.

Agent proposes tool call
          |
Tool schema validation
          |
Permission verification
          |
Risk classification
          |
User approval if required
          |
Native Android execution
          |
Structured result
          |
Audit record

A model must never be able to bypass this gateway.

7.4 Tool Result Format

interface ToolResult {
  success: boolean;

  data?: unknown;

  error?: {
    code: string;
    message: string;
    recoverable: boolean;
  };

  durationMs: number;
}

8. Persistent Memory

8.1 Memory Architecture

Implement three distinct memory categories.

Profile Memory

Explicitly saved user preferences.

Examples:

- Preferred response language.
- Preferred navigation application.
- Default inference mode.
- Approved recurring workflows.

Episodic Memory

Summaries of previous interactions and completed tasks.

Examples:

- Previously created documents.
- Recent workflow outcomes.
- User corrections.
- Prior task failures.

Procedural Memory

Reusable workflows and learned execution patterns.

Examples:

- Morning briefing workflow.
- Meeting preparation workflow.
- Document summarization workflow.

8.2 Storage

Use encrypted local persistence for sensitive records.

A possible implementation:

- SQLite for structured state.
- Full-text search for keyword retrieval.
- Optional vector index for semantic retrieval.
- Android Keystore-backed encryption keys.

The initial implementation should not require a vector database.

Start with structured memory and full-text search.

Introduce embeddings when retrieval evaluations demonstrate a meaningful benefit.

8.3 Memory Lifecycle

Memory operations:

- Create.
- Retrieve.
- Update.
- Delete.
- Export.
- Clear all.

The user must be able to inspect and remove stored memories.

Do not automatically treat every conversation as permanent memory.

8.4 Memory Retrieval

Before execution:

1. Classify the task.
2. Retrieve relevant memory.
3. Apply relevance and privacy filters.
4. Add selected memory to the model context.
5. Execute.
6. Optionally propose new memory updates.

Memory must be treated as contextual information, not as authority to override permissions.

9. Skills Engine

9.1 Purpose

Skills represent reusable, composable workflows.

A skill may combine:

- Instructions.
- Model inference.
- Tool calls.
- Conditions.
- User approvals.
- Error handling.
- Scheduled triggers.

9.2 Skill Manifest

Example:

name: meeting-preparation
version: 1.0.0
description: Prepare the phone for a meeting

permissions:
  - notifications.read
  - calendar.read
  - device.dnd

steps:
  - id: calendar
    tool: calendar.getUpcoming

  - id: notifications
    tool: notifications.getRecent

  - id: summarize
    operation: summarize

  - id: dnd
    tool: device.enableDnd
    requiresApproval: true

This is an illustrative format. The implementation must define a validated schema and explicit data dependencies.

9.3 Skill Execution

Skills must:

- Execute through the Agent Controller.
- Use the existing Tool Registry.
- Respect permission policies.
- Support cancellation.
- Persist progress.
- Handle partial failure.
- Expose execution history.

9.4 Skill Creation

Users should be able to create skills through natural language.

Example:

"Every morning, summarize important notifications and show my calendar."

LiquidChat generates a proposed skill definition.

The user reviews and approves it before activation.

Generated skills must not execute arbitrary JavaScript, shell commands, or downloaded code.

Use declarative workflows and allowlisted operations.

9.5 Future Skill Marketplace

A future release may support skill sharing.

Requirements:

- Versioned manifests.
- Publisher identity.
- Permission disclosure.
- Integrity verification.
- User approval.
- Revocation.
- Compatibility checks.

Remote skills must never be trusted merely because they were downloaded from a known source.

10. Notification Intelligence

10.1 Android Integration

Implement notification access through Android's NotificationListenerService.

The user must explicitly enable notification access in Android settings.

10.2 Features

- Summarize recent notifications.
- Group by application.
- Identify actionable items.
- Search notification history retained by LiquidChat.
- Generate daily briefings.
- Suggest draft responses.

10.3 Privacy

Provide:

- Application allowlists and blocklists.
- Local-only processing option.
- Configurable retention.
- Sensitive-content exclusion.
- Clear notification history action.

Avoid collecting notification content unrelated to enabled features.

11. Voice Interface

11.1 Architecture

Microphone
    |
Speech-to-Text
    |
Agent Controller
    |
Model Router
    |
Agent Execution
    |
Text-to-Speech

11.2 Initial Scope

- Push-to-talk.
- Offline speech recognition where supported.
- Voice-driven Android tool execution.
- Spoken confirmations.
- Interrupt and cancel support.

11.3 Future Scope

- Wake-word detection.
- Streaming transcription.
- Streaming TTS.
- Voice activity detection.
- Conversational interruption.

Continuous microphone use must comply with Android foreground-service requirements and battery constraints.

12. Screen-Aware Agent

12.1 Objective

Allow LiquidChat to understand and assist with the current screen.

Examples:

- Explain an error message.
- Extract information from an application.
- Help complete a form.
- Summarize displayed content.

12.2 Technical Approaches

- Android Accessibility APIs, where permitted and policy-compliant.
- User-authorized MediaProjection screen capture.
- OCR.
- Local vision models.
- Hybrid vision inference with explicit authorization.

12.3 Safety

Require explicit consent for screen access.

Avoid collecting passwords, authentication codes, or sensitive content.

Accessibility-based interactions must remain subject to Android policies and user authorization.

13. Background Execution and Scheduling

13.1 Runtime Design

The agent runtime must survive application lifecycle interruptions through persisted state.

Use Android-supported execution mechanisms:

- WorkManager for deferrable persistent work.
- AlarmManager for appropriate time-based triggers.
- Foreground services only for qualifying user-visible operations.
- Broadcast receivers for permitted system events.

Do not assume Android permits arbitrary continuous background execution.

13.2 Scheduled Skills

Example:

{
  "skill": "morning-briefing",
  "trigger": {
    "type": "daily",
    "time": "08:00"
  },
  "enabled": true
}

Scheduling must account for:

- Device reboot.
- Battery optimization.
- Doze mode.
- Permission changes.
- Missed executions.
- Timezone changes.

14. Energy-Aware Inference

14.1 Objective

Optimize model selection for smartphone resource constraints.

14.2 Inputs

- Battery percentage.
- Charging status.
- Available memory.
- Thermal status.
- Estimated model memory requirements.
- Expected inference duration.
- Model loading overhead.

14.3 Example Policies

Battery-Constrained Mode

- Prefer small local models.
- Reduce unnecessary inference.
- Avoid repeated large-model loading.
- Defer non-urgent tasks.
- Use cloud inference only if authorized and appropriate.

Balanced Mode

- Prefer local inference.
- Escalate when quality requirements are unmet.
- Optimize latency and energy.

Performance Mode

- Favor the highest-quality eligible model.
- Permit higher resource consumption within safe thermal limits.

Battery thresholds should be configurable and validated experimentally.

14.4 Model Loading

Avoid keeping multiple large models resident when memory is constrained.

Implement:

- Model loading lifecycle management.
- Model unloading.
- Memory pressure handling.
- Warm-model selection.
- Failure recovery.

15. Agent Observability and Evaluation

15.1 Structured Execution Traces

Capture:

- Execution ID.
- Task category.
- Model selected.
- Routing decision.
- Model latency.
- Token usage where available.
- Tool calls.
- Tool outcomes.
- Verification results.
- Retry counts.
- Failure classifications.
- User corrections.
- Battery and thermal measurements where supported.

15.2 Privacy

Traces must be local by default.

Sensitive payloads should be redacted.

Export must require user action or an explicit opt-in configuration.

15.3 Evaluation Metrics

Measure:

- Task completion rate.
- Tool-call accuracy.
- Argument validity.
- Multi-step workflow success.
- Recovery success.
- Incorrect action rate.
- Permission-policy violations.
- Local versus remote routing effectiveness.
- Median and p95 latency.
- Energy consumption per completed task.
- Estimated cloud cost per successful task.

15.4 Evaluation Dataset

Build a benchmark dataset containing:

- User intent.
- Available tools.
- Expected action.
- Expected arguments.
- Expected outcome.
- Permission constraints.
- Failure scenarios.

Start with deterministic tool-call and workflow evaluations.

Expand to real-device tests later.

15.5 Continuous Improvement

Use failed executions and user corrections to identify:

- Missing tools.
- Routing errors.
- Planning failures.
- Model limitations.
- Prompt weaknesses.
- Recovery gaps.

Training dataset exports must be opt-in and privacy-filtered.

Do not automatically upload private conversations.

16. MCP Integration

16.1 Objective

Support MCP-based tool discovery and invocation.

16.2 Architecture

LiquidChat Agent
       |
   Tool Registry
       |
   MCP Adapter
       |
 Remote MCP Server
       |
 External Services

16.3 Requirements

- Configurable MCP server connections.
- Supported transport negotiation.
- Tool discovery.
- Tool schema validation.
- Authentication and credential storage.
- Connection timeouts.
- User approval for sensitive operations.
- Tool result normalization.

MCP tools must pass through the same Permission Gateway as native Android tools.

Do not automatically trust instructions returned by MCP servers.

16.4 Optional Remote Agent Delegation

A future release may support delegation to remote agent runtimes.

Example:

- Phone handles notifications and local actions.
- Remote agent handles large document processing or complex research.
- Phone receives structured results and executes authorized device actions.

Remote delegation must not grant unrestricted device control.

17. Security Architecture

Security is a core runtime requirement.

17.1 Trust Boundaries

Separate:

1. User instructions.
2. Model-generated plans.
3. Tool descriptions.
4. Tool results.
5. External documents.
6. Remote model responses.
7. Stored memory.

Untrusted content must not be promoted into privileged instructions.

17.2 Required Controls

- Tool schema validation.
- Permission enforcement.
- User approval for sensitive actions.
- Prompt injection defenses.
- API key protection.
- Encrypted credential storage.
- Network transport security.
- Tool execution logging.
- Resource and timeout limits.
- Data retention controls.

17.3 API Credentials

Never hardcode API keys.

Use platform-secured credential storage.

Where appropriate, support user-supplied API credentials.

Remote provider integrations must not log credentials or expose them to model prompts.

18. Suggested Code Organization

Adapt this structure to the actual repository.

src/
  agent/
    AgentController.ts
    AgentPlanner.ts
    AgentExecutor.ts
    AgentVerifier.ts
    AgentStateMachine.ts

  inference/
    CactusAdapter.ts
    ModelRegistry.ts
    HybridModelRouter.ts
    RoutingPolicy.ts
    ModelLifecycleManager.ts

  tools/
    ToolRegistry.ts
    ToolExecutor.ts
    PermissionGateway.ts
    ToolResultValidator.ts

  memory/
    MemoryManager.ts
    ProfileMemory.ts
    EpisodicMemory.ts
    ProceduralMemory.ts

  skills/
    SkillRegistry.ts
    SkillValidator.ts
    SkillExecutor.ts

  scheduler/
    TaskScheduler.ts
    TriggerRegistry.ts

  observability/
    AgentTracer.ts
    EvaluationRecorder.ts
    MetricsCollector.ts

  security/
    PrivacyPolicy.ts
    ApprovalManager.ts
    CredentialStore.ts

  storage/
    AgentDatabase.ts
    ExecutionRepository.ts

  types/
    agent.ts
    inference.ts
    tools.ts
    skills.ts

android/
  native-modules/
    NotificationBridge
    DeviceControlBridge
    SchedulerBridge
    AccessibilityBridge

This is a proposed logical structure, not an instruction to move all existing files immediately.

19. Implementation Roadmap

Phase 0 — Repository Audit

Inspect the existing codebase.

Deliverables:

- Current architecture map.
- Existing tool inventory.
- Cactus integration analysis.
- Current persistence implementation.
- Android permission inventory.
- Existing tests.
- Identified compatibility risks.

Acceptance criteria:

- Existing application builds successfully.
- Existing features are documented.
- No regressions introduced.

Phase 1 — Agent Runtime

Implement:

- Agent Controller.
- Structured execution plans.
- Tool Registry.
- Permission Gateway.
- Execution state machine.
- Persistent execution state.
- Tool-result verification.
- Error recovery.

Acceptance criteria:

- At least three multi-step workflows execute end-to-end.
- Failed tool calls produce structured errors.
- Cancelled tasks stop safely.
- Restart recovery does not duplicate sensitive actions.
- Existing tools continue working.

Phase 2 — Hybrid Model Router

Implement:

- Local and remote model registry.
- Cactus adapter integration.
- Routing modes.
- Capability-based selection.
- Quality-aware fallback.
- Privacy controls.
- Cost limits.
- Routing telemetry.

Acceptance criteria:

- Local-only mode never invokes remote inference.
- Hybrid mode selects local models when suitable.
- Cloud fallback occurs only when policy permits.
- Remote failures are handled gracefully.
- Routing decisions are inspectable.
- Cost limits are enforced.

Phase 3 — Memory and Skills

Implement:

- Persistent memory.
- Memory management UI.
- Skill manifest schema.
- Skill executor.
- Skill creation UI.
- Skill permission checks.

Acceptance criteria:

- Memory persists across restarts.
- Users can inspect and delete memory.
- Skills execute through the standard agent runtime.
- Invalid or unauthorized skills are rejected.

Phase 4 — Native Android Intelligence

Implement:

- Notification intelligence.
- Device-context tools.
- Voice interaction.
- Background scheduling.
- Screen understanding where permitted.

Acceptance criteria:

- Permission requests are explicit.
- Disabled permissions do not crash workflows.
- Background tasks respect Android constraints.
- Sensitive operations require approval.

Phase 5 — Optimization and Ecosystem

Implement:

- Energy-aware routing.
- Model performance profiling.
- MCP integration.
- Remote agent delegation.
- Agent evaluation dashboard.
- Skill import/export.

Acceptance criteria:

- Routing quality is benchmarked.
- Resource usage is measurable.
- External tools respect security policies.
- Evaluation results are reproducible.

20. Testing Strategy

Unit Tests

Test:

- Routing policies.
- State transitions.
- Tool validation.
- Permission enforcement.
- Skill parsing.
- Memory retrieval.
- Retry logic.

Integration Tests

Test:

- Local inference to tool execution.
- Local failure to cloud fallback.
- Remote inference failure.
- Multi-step workflow completion.
- Persistence and restart recovery.
- Permission denial.
- Network loss.

Device Tests

Test on multiple Android versions and hardware profiles.

Include:

- Low-memory devices.
- Offline operation.
- Low battery.
- Thermal throttling.
- App backgrounding.
- Process termination.
- Device reboot.

Security Tests

Include:

- Prompt injection in notifications.
- Malicious tool responses.
- Unauthorized tool invocation.
- Sensitive data exfiltration attempts.
- Skill permission escalation.
- Duplicate execution of irreversible actions.

21. Initial Flagship Workflow

Meeting Preparation Agent

User request:

"I'm going into a meeting. Check my notifications, summarize urgent messages, enable Do Not Disturb, and prepare replies."

Expected behavior:

1. Classify the request.
2. Check notification access.
3. Read authorized notifications.
4. Summarize urgent items locally where possible.
5. Escalate to remote inference only if necessary and permitted.
6. Check Do Not Disturb access.
7. Enable Do Not Disturb if authorized.
8. Draft suggested responses.
9. Present the briefing.
10. Request approval before sending any response.
11. Record the execution outcome.
12. Offer to save the workflow as a reusable skill.

Success criteria:

- The workflow completes without requiring a cloud model when local models are capable.
- Unauthorized actions are blocked.
- No message is sent without approval.
- Failures are visible and recoverable.
- Execution metrics are recorded.

22. Engineering Principles

All implementation work must follow these principles:

1. Reuse existing LiquidChat components whenever practical.
2. Keep the inference layer model-agnostic.
3. Keep local inference as the default.
4. Treat cloud inference as an optional capability, not a requirement.
5. Separate model reasoning from privileged tool execution.
6. Persist execution state for reliable recovery.
7. Use typed interfaces and validated schemas.
8. Never trust model-generated tool arguments without validation.
9. Avoid unnecessary background services.
10. Optimize for memory, battery, and thermal constraints.
11. Make sensitive data collection and export opt-in.
12. Ensure users can understand why a model or tool was selected.
13. Measure task success rather than relying only on model confidence.
14. Prefer small, independently testable modules.
15. Preserve backward compatibility with existing features.

23. Instructions for the Coding Agent

You are implementing the next generation of LiquidChat.

Repository:
https://github.com/Mandark-droid/LiquidChat

Your first task is to inspect the repository and produce an implementation plan.

Do not immediately rewrite the application.

Perform the following steps:

1. Inspect the existing architecture and dependency versions.
2. Identify the current Cactus SDK integration.
3. Verify the supported local and hybrid inference APIs.
4. Identify existing Android tools and their interfaces.
5. Identify existing persistence, permissions, and state management.
6. Map current capabilities to the proposed architecture.
7. Identify components that can be reused.
8. Propose the minimum set of changes required for Phase 1.
9. Identify technical risks and Android platform restrictions.
10. Present a file-by-file implementation plan with acceptance tests.

After the audit, implement incrementally.

Start with the Agent Controller, Tool Registry, state machine, and persistence.

Do not implement every feature simultaneously.

Each phase must include tests, documentation, and a regression check.

Primary success metric: Percentage of authorized user tasks completed correctly and safely.

Secondary metrics: Local execution rate, task latency, energy consumption, remote inference cost, recovery success, and user intervention frequency.

---

Long-Term Product Vision

LiquidChat should become a phone-native AI agent operating system layer.

It should be able to:

- Understand natural-language requests.
- Select the appropriate model.
- Execute authorized Android actions.
- Coordinate multi-step workflows.
- Remember useful context.
- Reuse learned skills.
- Recover from failures.
- Operate offline whenever possible.
- Escalate intelligently to stronger remote models.
- Protect user privacy and device security.

The goal is not simply to reproduce Hermes on Android.

The goal is to build a reliable, privacy-first, hybrid AI agent that makes the smartphone itself programmable through natural language.