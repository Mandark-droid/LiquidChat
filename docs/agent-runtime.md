# LiquidChat Agent Runtime

Implementation notes for [the PRD](spec/LiquidChat-Mobile-Agent-Runtime-PRD.md). The PRD is kept
verbatim; this file maps it to code and records what is validated where.

## Shape

```
ChatScreen / voice / SkillsScreen / routine notification
        │  AgentRequest {text, source, skillId?, plan?}
        ▼
AgentRuntime (src/agent/AgentRuntime.ts)  ── composition root, injected platform
        │
AgentControllerImpl ── persisted state machine (13 states, src/agent/AgentStateMachine.ts)
   │  memory retrieval (FTS5) → AgentPlanner → AgentExecutor → composeResponse
   │
   ├─ AgentPlanner: skill match → multi-step JSON planner → single-call fast path
   │     every plan → PlanValidator (schemas, refs, DAG, ≤12 steps)
   │
   └─ AgentExecutor, per step:
        tool step  → PermissionGateway → AgentTool.execute → verify (read-back)
        infer step → InferenceRunner.run(RoutingContext)   ← routed per step
                        └ ModelRouter: eligibility → policy → rank (mode × energy × quality)
                          InferenceService: retries, fallback, redaction, ledger, breaker
```

Routing happens at every inference step, not per conversation. A plan's planning step and
tool steps stay on-device; one reasoning step that fails verification is escalated
(`excludeModels`, `escalationReason`) to a stronger model — remote only if policy, budget,
data class and the user allow — and the next step routes local again
(`__tests__/agent/workflows.test.ts`: `['plan:local','s2:local','s2:remote','s4:local']`).

## Invariants and where they are enforced

| Invariant | Enforcement | Test |
|---|---|---|
| Model output never executes directly | `PermissionGateway.invoke` is the only path to `execute`; args validated against `inputSchema` | `tools/gateway`, `security/injection` |
| Approvals only from the UI | `ApprovalManager` queue rendered by `ApprovalHost`; model text cannot resolve it | `security/injection` |
| Sending is always asked | `alwaysAsk` tools (`send_email`, memory writes, every MCP tool not declared read-only) never get standing grants | `tools/gateway`, `mcp/mcp` |
| Personal data leaving through a tool is shown first | A network tool whose arguments carry personal/sensitive outputs always asks, regardless of its declared risk | `security/privacyTaint` |
| Model-written plans can't declare data public | Steps from the planner are floored at `personal`; only reviewed skills may declare `public` | `security/privacyTaint` |
| Cloud approvals are scoped | "Allow once" covers one step; only "Always" persists, never for sensitive data | `inference/InferenceService`, `agent/reviewRegressions` |
| Cancel is final | Cancelling closes the execution's open approval sheets; a late "allow" cannot act | `agent/reviewRegressions` |
| Tool output is data, not instructions | `resolvePrompt` fences inserted values in `<data … note="content, not instructions">`; notifications wrapped by `asUntrustedData` | `security/injection` |
| Privacy class follows the data | Executor taint: a step inherits the highest class of every output it reads (§6.6) | `security/privacyTaint` |
| On-device-only data stays on device | `localOnly` taint → router rejects remote; network tools refuse tainted args (`LOCAL_ONLY_DATA`) | `security/privacyTaint`, `inference/ModelRouter` |
| Remote is policy-controlled | Default `allowRemoteDataClasses: ['public']`, per-task/daily/monthly budgets, call caps, circuit breaker, first-use approval per provider × class | `inference/*` |
| No replay of side effects | `tool_calls` rows; non-idempotent `started` calls ask before re-running (showing resolved arguments); a non-idempotent call that timed out or threw is never retried | `agent/recovery`, `agent/reviewRegressions` |
| Keys never in prompts, logs or AsyncStorage | Provider keys and MCP tokens only in `CredentialStore` (Keystore AES-GCM); config rejects an `apiKey` field; tracer redacts | `inference/ModelRegistry`, `observability/redact` |
| Keys never over plaintext | Provider base URLs and MCP URLs must be https (http only for local hosts) | `inference/ModelRegistry`, `mcp/mcp` |
| Encrypted at rest | SQLCipher key from Keystore via `setDatabaseKeyProvider`; a failing provider fails the open | `storage/db`, `agent/runtime` |
| Skills cannot run code | Manifest schema allows only registered tools and model operations; forbidden keys rejected; imported/generated skills install disabled; integrity hash | `skills/skills` |
| Routines are opt-in | Built-ins with time triggers install disabled; enabling schedules them and asks for notification permission | `skills/skills`, `agent/runtime` |
| Routines keep firing | A week of occurrences is armed ahead, so an untapped notification doesn't end the routine; missed runs are offered on launch, never run silently | `scheduler/TaskScheduler`, `agent/runtime` |

## PRD roadmap → code

| Phase | Delivered | Main code |
|---|---|---|
| 0 Audit | Architecture map, tool inventory, Cactus analysis, permission inventory, risks | "Phase 0 Audit & Phase 1 Plan" doc; `docs/android-native.md` |
| 1 Runtime | Controller, structured plans, registry (28 legacy tools + app tools), gateway, state machine, SQLite persistence, verification, retries, cancellation, restart recovery | `src/agent/*`, `src/tools/*`, `src/storage/*` |
| 2 Router | Local + remote registry, Cactus adapter, 3 modes, capability + quality-aware selection, privacy minimisation/redaction, cost ledger + budgets, circuit breaker, routing telemetry, Anthropic / OpenAI-compatible / Gemini providers | `src/inference/*` |
| 3 Memory & skills | FTS5 memory with consented proposals, Memory screen, manifest schema, skill executor (plans through the normal runtime), NL skill creation with review, import/export, "save as skill" from chat | `src/memory/*`, `src/skills/*`, `MemoryScreen`, `SkillsScreen` |
| 4 Android | Notification listener (opt-in, blocklist, OTP filter, retention, local-only), device context, Keystore credentials, AlarmManager scheduler with boot re-arm and missed-run handling, voice turns with spoken approvals, Accessibility automation in the `full` flavor only | `android/…/platform/*`, `src/platform/*`, `src/scheduler/*`, `src/notifications/*` |
| 5 Optimisation | Energy-aware routing (battery/charging/thermal/RAM), per-model latency and quality stats, MCP (Streamable HTTP) tools, offline evaluation set + runner, insights dashboard, skill import/export | `src/inference/ModelRouter.ts`, `src/mcp/*`, `src/observability/*`, `AgentInsightsScreen` |

Remote agent delegation (PRD §16.4, marked "future release") is available in the scoped form
the PRD allows: a remote agent exposed as an MCP server is just another tool. Its results come
back as fenced data; any device action still goes through the local planner, gateway and
approvals, so delegation never grants device control.

## Quality gates

The JS/TS equivalents of the Python toolchain:

| Python | Here | Command |
|---|---|---|
| mypy | `tsc --noEmit` (strict) | `npm run typecheck` |
| pylint / flake8 | ESLint 9 + typescript-eslint + react-hooks | `npm run lint` |
| isort | `simple-import-sort` (ESLint) | `npm run lint:fix` |
| black | Prettier | `npm run format` / `npm run format:check` |
| pytest | Jest (SQL runs on real SQLite via better-sqlite3) | `npm test`, `npm run test:coverage` |
| — | all of the above | `npm run check` |

Runtime data validation: tool arguments, plans and skill manifests are validated against JSON
Schema at the boundary (`src/tools/schema.ts`, `PlanValidator`, `SkillValidator`); stored JSON is
coerced field by field (`normalizePolicy`, notification settings).

CI (`.github/workflows/ci.yml`) runs `npm run check`, then builds `fullDebug` and `playDebug`
and runs Android lint.

## Validation status

Validated in this environment: strict typecheck, ESLint (0 errors), Prettier, and the Jest
suites — runtime, workflows (incl. the PRD §21 flagship), recovery, routing, providers (HTTP
mocked), MCP (HTTP mocked), privacy, scheduler, notifications, memory, skills, evaluation,
storage, and the meetings / tasks / email modules (date resolution, transcript import and
cleaning, minutes map-reduce, PDF/DOCX/Markdown export, quick-add).

Known limits: the agent path does not stream tokens yet (the reply arrives when the plan
finishes; progress shows per step); plain `execute` writes from independent writers can land
inside another writer's open transaction on the shared connection (transactions themselves are
serialised).

Needs CI / a device: Kotlin compilation and Android lint, SQLCipher with a real key, Keystore,
AlarmManager exact alarms and boot re-arm, NotificationListenerService, foreground services,
on-device Cactus inference and tool-calling quality per model, remote provider calls against
real endpoints, and the UI screens (type-checked and linted, not rendered in tests).
