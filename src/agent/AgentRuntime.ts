/**
 * Composition root for the agent runtime (PRD §5, §19). Wires the controller,
 * planner, executor, permission gateway, tool registry, inference stack,
 * memory, skills, scheduler, notifications, MCP and observability together
 * from injected platform implementations — production passes the Android
 * native layer, tests pass the fakes in src/platform/fakes.ts.
 *
 * Nothing here decides policy: routing lives in ModelRouter, approval rules in
 * PermissionGateway, skill safety in SkillValidator. This file only connects.
 */
import { createInferenceStack, type InferenceStack } from '../inference/InferenceService';
import type { FetchLike } from '../inference/providers/http';
import { McpClient } from '../mcp/McpClient';
import { McpServerStore, mcpTokenKey } from '../mcp/McpServerStore';
import { adaptMcpTools, discoverMcpTools } from '../mcp/McpToolAdapter';
import { learnFromRun } from '../memory/learning';
import { MemoryManager, type MemoryProposal } from '../memory/MemoryManager';
import { NotificationStore } from '../notifications/NotificationStore';
import { type AgentTracer, createTracer } from '../observability/AgentTracer';
import { type EvalCase, evalCases } from '../observability/evalset';
import {
  type EvalPlanner,
  type EvalRunResult,
  runEvaluation,
} from '../observability/EvaluationRunner';
import { MetricsCollector } from '../observability/MetricsCollector';
import type {
  AlarmScheduler,
  CredentialStore,
  DeviceContextProvider,
  DeviceStateReader,
  NotificationSource,
  PermissionChecker,
} from '../platform/types';
import { TaskScheduler } from '../scheduler/TaskScheduler';
import type { Trigger } from '../scheduler/triggers';
import { ApprovalManager } from '../security/ApprovalManager';
import { SkillGenerator } from '../skills/SkillGenerator';
import { SkillRegistry } from '../skills/SkillRegistry';
import { getDatabase, type SqlDb } from '../storage/db';
import { ExecutionRepository } from '../storage/ExecutionRepository';
import {
  createAppTools,
  type MeetingsPort,
  type NotificationsPort,
  type TasksPort,
} from '../tools/builtin/app';
import { createDeviceTools, setDeviceStateReader } from '../tools/builtin/device';
import { PermissionGateway } from '../tools/PermissionGateway';
import { ToolRegistry } from '../tools/ToolRegistry';
import type { Distribution } from '../tools/types';
import { AgentControllerImpl } from './AgentController';
import { AgentExecutor } from './AgentExecutor';
import { AgentPlanner } from './AgentPlanner';
import type { InferenceRunner } from './ports';
import type { AgentEvent, AgentRequest, AgentResult, Plan } from './types';
import { AgentError } from './types';

export interface RuntimePlatform {
  device: DeviceContextProvider;
  permissions: PermissionChecker;
  credentials: CredentialStore;
  alarms: AlarmScheduler;
  notifications?: NotificationSource;
  deviceState?: DeviceStateReader;
}

export interface AgentRuntimeDeps {
  platform: RuntimePlatform;
  meetings: MeetingsPort;
  tasks: TasksPort;
  /** Overrides the routed inference stack (tests, evals with a scripted model). */
  inference?: InferenceRunner;
  fetch?: FetchLike;
  preferredLocalModel?: () => string | undefined;
  localAvailability?: (modelId: string) => boolean | Promise<boolean>;
  approvals?: ApprovalManager;
  db?: () => Promise<SqlDb>;
  tracer?: AgentTracer;
  onMemoryProposal?: (p: MemoryProposal, executionId: string) => void;
  now?: () => Date;
  systemPrompt?: () => string;
  /** Bearer token for a server with none stored (e.g. the app's Hugging Face token). */
  mcpTokenFallback?: (serverId: string) => Promise<string | undefined>;
}

/**
 * Tools of built-in servers an on-device model can actually drive. Hugging Face's `hf_fs` takes a
 * required list of filesystem-style commands and has a 3 KB description; small models call it with
 * no arguments, so it stays out unless a server has no entry here (all its tools are offered).
 */
const MCP_TOOL_ALLOWLIST: Record<string, string[]> = {
  huggingface: ['hf_whoami', 'hub_repo_search', 'hub_repo_details'],
};

export function mcpToolAllowed(serverId: string, registeredName: string): boolean {
  const allow = MCP_TOOL_ALLOWLIST[serverId];
  return !allow || allow.includes(registeredName.slice(registeredName.lastIndexOf('.') + 1));
}

export interface ReadyReport {
  builtinSkills: { installed: string[]; skipped: { name: string; reason: string }[] };
  mcpTools: number;
  notificationsIngested: number;
}

const SCHEDULABLE = new Set(['daily', 'interval', 'once']);

export class AgentRuntime {
  readonly registry = new ToolRegistry();
  readonly repo: ExecutionRepository;
  readonly approvals: ApprovalManager;
  readonly memory: MemoryManager;
  readonly gateway: PermissionGateway;
  readonly skills: SkillRegistry;
  readonly generator: SkillGenerator;
  readonly planner: AgentPlanner;
  readonly executor: AgentExecutor;
  readonly controller: AgentControllerImpl;
  readonly scheduler: TaskScheduler;
  readonly notificationStore: NotificationStore;
  readonly mcpServers: McpServerStore;
  readonly metrics: MetricsCollector;
  readonly tracer: AgentTracer;
  /** Routed inference stack (null when a runner was injected). */
  readonly inferenceStack: InferenceStack | null;
  readonly inference: InferenceRunner;

  private readonly distribution: () => Distribution;
  private readonly mcpToolNames = new Map<string, string[]>();
  private readyPromise: Promise<ReadyReport> | null = null;

  constructor(private readonly deps: AgentRuntimeDeps) {
    const db = deps.db ?? (() => getDatabase());
    const p = deps.platform;
    this.distribution = () => p.device.distribution();
    this.tracer = deps.tracer ?? createTracer(db);
    this.repo = new ExecutionRepository(db);
    this.approvals = deps.approvals ?? new ApprovalManager();
    this.memory = new MemoryManager(db);
    this.notificationStore = new NotificationStore({ getDb: db });
    this.mcpServers = new McpServerStore(db, Date.now, p.credentials);
    this.metrics = new MetricsCollector(db);
    this.scheduler = new TaskScheduler({
      getDb: db,
      alarms: p.alarms,
      now: () => (deps.now ? deps.now().getTime() : Date.now()),
    });

    if (deps.inference) {
      this.inferenceStack = null;
      this.inference = deps.inference;
    } else {
      const stack = createInferenceStack({
        credentials: p.credentials,
        device: p.device,
        tracer: this.tracer,
        fetch: deps.fetch,
        db,
        preferredLocalModel: deps.preferredLocalModel,
        localAvailability: deps.localAvailability,
      });
      this.inferenceStack = stack;
      // InferenceService.run already returns {result, decision, …}; adapt the options.
      this.inference = {
        run: (ctx, req, o) =>
          stack.service.run(ctx, req, { signal: o?.signal, approve: o?.approve }),
      };
    }

    setDeviceStateReader(p.deviceState ?? null);
    for (const t of createDeviceTools()) this.registry.register(t);
    const notificationsPort: NotificationsPort | undefined = p.notifications
      ? {
          recent: async o => {
            await this.ingestNotifications();
            const rows = await this.notificationStore.recent(o);
            return rows.map(n => ({
              app: n.appLabel || n.packageName,
              title: n.title,
              text: n.text,
              postedAt: n.postedAt,
            }));
          },
        }
      : undefined;
    for (const t of createAppTools({
      meetings: deps.meetings,
      tasks: deps.tasks,
      memory: this.memory,
      device: p.device,
      notifications: notificationsPort,
      now: deps.now,
    }))
      this.registry.register(t);

    const notificationTool = this.registry.get('notifications.recent');
    if (notificationTool) {
      // "Keep notification content on this phone" (default on) is enforced by taint.
      notificationTool.localOnlyOutput = async () =>
        (await this.notificationStore.getSettings()).localOnly;
    }

    this.gateway = new PermissionGateway({
      registry: this.registry,
      permissions: p.permissions,
      approvals: this.approvals,
      repo: this.repo,
      distribution: this.distribution,
      tracer: this.tracer,
    });
    this.skills = new SkillRegistry(this.registry, this.distribution, db);
    this.generator = new SkillGenerator(this.registry, this.inference, this.distribution);
    this.planner = new AgentPlanner({
      registry: this.registry,
      inference: this.inference,
      skills: this.skills,
      distribution: this.distribution,
      systemPrompt: deps.systemPrompt,
      now: deps.now,
    });
    this.executor = new AgentExecutor({
      registry: this.registry,
      gateway: this.gateway,
      inference: this.inference,
      repo: this.repo,
      approvals: this.approvals,
      permissions: p.permissions,
      distribution: this.distribution,
      tracer: this.tracer,
    });
    this.controller = new AgentControllerImpl({
      planner: this.planner,
      executor: this.executor,
      repo: this.repo,
      memory: this.memory,
      tracer: this.tracer,
      onMemoryProposal: deps.onMemoryProposal,
      learn: run => learnFromRun(this.memory, run),
      approvals: this.approvals,
    });
  }

  /** Idempotent startup: built-in skills, cached MCP tools, alarm sync, notification filters. */
  ready(): Promise<ReadyReport> {
    if (!this.readyPromise) {
      this.readyPromise = this.init().catch(e => {
        this.readyPromise = null; // allow retry after a failed start
        throw e;
      });
    }
    return this.readyPromise;
  }

  private async init(): Promise<ReadyReport> {
    const builtinSkills = await this.skills.installBuiltins();
    let mcpTools = 0;
    for (const s of await this.mcpServers.list({ enabledOnly: true })) {
      if (s.tools?.length) mcpTools += this.registerMcpTools(s.id, s.name, s.url, s.tools);
      // A server added by a migration (or never reachable) has no cached tools yet.
      else
        this.refreshMcpServer(s.id).catch(e =>
          console.warn(`[MCP] ${s.name}: tool discovery failed: ${(e as Error).message}`),
        );
    }
    const n = this.deps.platform.notifications;
    let notificationsIngested = 0;
    if (n) {
      await this.notificationStore.applyFiltersTo(n).catch(() => {});
      notificationsIngested = await this.ingestNotifications();
    }
    await this.scheduler.sync(this.deps.platform.alarms).catch(() => {});
    return { builtinSkills, mcpTools, notificationsIngested };
  }

  // --- requests -------------------------------------------------------------------

  async execute(request: AgentRequest, onEvent?: (e: AgentEvent) => void): Promise<AgentResult> {
    await this.ready();
    return this.controller.execute(request, onEvent);
  }

  cancel(executionId: string): Promise<void> {
    return this.controller.cancel(executionId);
  }

  async runSkill(
    skillId: string,
    opts: {
      inputs?: Record<string, unknown>;
      source?: AgentRequest['source'];
      onEvent?: (e: AgentEvent) => void;
    } = {},
  ): Promise<AgentResult> {
    await this.ready();
    const skill = await this.skills.get(skillId);
    if (!skill) throw new AgentError('NOT_FOUND', `Skill ${skillId} not found`);
    if (!skill.enabled)
      throw new AgentError('SKILL_DISABLED', `${skill.manifest.name} is disabled`);
    const result = await this.controller.execute(
      {
        text: `Run skill ${skill.manifest.name}`,
        source: opts.source ?? 'skill',
        skillId: skill.id,
        skillInputs: opts.inputs,
      },
      opts.onEvent,
    );
    await this.skills.markRun(skill.id).catch(() => {});
    return result;
  }

  // --- scheduling (PRD §15) ---------------------------------------------------------

  /** Mirrors a skill's time triggers into schedules and re-arms alarms. */
  async scheduleSkill(skillId: string): Promise<number> {
    const skill = await this.skills.get(skillId);
    if (!skill) throw new AgentError('NOT_FOUND', `Skill ${skillId} not found`);
    await this.scheduler.removeForSkill(skillId);
    let n = 0;
    if (skill.enabled) {
      for (const t of skill.manifest.triggers ?? []) {
        if (!SCHEDULABLE.has(t.type)) continue;
        await this.scheduler.create({ skillId, trigger: t as Trigger });
        n++;
      }
    }
    // Routines announce themselves with a notification (runtime permission on Android 13+).
    if (n > 0) {
      const perm = 'android.permission.POST_NOTIFICATIONS' as const;
      const p = this.deps.platform.permissions;
      if (!(await p.check(perm).catch(() => true))) await p.request(perm).catch(() => false);
    }
    await this.scheduler.sync(this.deps.platform.alarms);
    return n;
  }

  /** Deletes a skill and cancels its OS alarms first (no orphan routines). */
  async removeSkill(skillId: string): Promise<void> {
    await this.unscheduleSkill(skillId);
    await this.skills.remove(skillId);
  }

  async unscheduleSkill(skillId: string): Promise<void> {
    await this.scheduler.removeForSkill(skillId);
    await this.scheduler.sync(this.deps.platform.alarms);
  }

  /**
   * Runs the routine whose notification launched the app, if any. The user tapped
   * it, so approvals go to the normal UI. Returns null when there was no payload.
   */
  async handleLaunchPayload(onEvent?: (e: AgentEvent) => void): Promise<AgentResult | null> {
    await this.ready();
    const raw = await this.deps.platform.alarms.consumeLaunchPayload();
    if (!raw) return null;
    const fired = await this.scheduler.onFired(raw);
    if (!fired) return null;
    const skill = await this.skills.get(fired.skillId);
    if (!skill?.enabled) return null;
    return this.runSkill(fired.skillId, { source: 'schedule', onEvent });
  }

  /** Routines that came due while the phone was off or the app was killed. */
  async missedRoutines(): Promise<
    { scheduleId: string; skillId: string; name: string; dueAt: number }[]
  > {
    await this.ready();
    const out = [];
    for (const m of await this.scheduler.checkMissed()) {
      const skill = await this.skills.get(m.schedule.skillId);
      if (!skill?.enabled) {
        await this.scheduler.skipMissed(m.schedule.id);
        continue;
      }
      out.push({
        scheduleId: m.schedule.id,
        skillId: skill.id,
        name: skill.manifest.name,
        dueAt: m.dueAt,
      });
    }
    return out;
  }

  /** The user chose "run now" for a missed routine. */
  async runMissed(
    scheduleId: string,
    onEvent?: (e: AgentEvent) => void,
  ): Promise<AgentResult | null> {
    const s = await this.scheduler.get(scheduleId);
    if (!s) return null;
    const fired = await this.scheduler.onFired({ scheduleId, skillId: s.skillId });
    if (!fired) return null;
    return this.runSkill(fired.skillId, { source: 'schedule', onEvent });
  }

  skipMissed(scheduleId: string): Promise<unknown> {
    return this.scheduler.skipMissed(scheduleId);
  }

  // --- notifications (PRD §11) ------------------------------------------------------

  async ingestNotifications(): Promise<number> {
    const n = this.deps.platform.notifications;
    if (!n) return 0;
    try {
      if (!(await n.isAccessGranted())) return 0;
      return (await this.notificationStore.drainFrom(n)).stored;
    } catch {
      return 0;
    }
  }

  // --- MCP (PRD §16) ----------------------------------------------------------------

  private client(id: string, name: string, url: string): McpClient {
    const store = this.deps.platform.credentials;
    const fallback = this.deps.mcpTokenFallback;
    const credentials: CredentialStore = fallback
      ? {
          get: async key =>
            (await store.get(key)) ??
            (key === mcpTokenKey(id) ? ((await fallback(id)) ?? null) : null),
          set: (key, value) => store.set(key, value),
          delete: key => store.delete(key),
          has: key => store.has(key),
          databaseKey: () => store.databaseKey(),
        }
      : store;
    return new McpClient({ id, name, url }, { credentials, fetch: this.deps.fetch });
  }

  private registerMcpTools(
    id: string,
    name: string,
    url: string,
    tools: Parameters<typeof adaptMcpTools>[1],
  ): number {
    for (const old of this.mcpToolNames.get(id) ?? []) this.registry.unregister(old);
    const adapted = adaptMcpTools(this.client(id, name, url), tools).filter(t =>
      mcpToolAllowed(id, t.name),
    );
    for (const t of adapted) this.registry.register(t);
    this.mcpToolNames.set(
      id,
      adapted.map(t => t.name),
    );
    return adapted.length;
  }

  /** Connects to a server, refreshes its tool list and (re)registers its tools. */
  async refreshMcpServer(id: string, signal?: AbortSignal): Promise<number> {
    const s = await this.mcpServers.get(id);
    if (!s) throw new AgentError('NOT_FOUND', `MCP server ${id} not found`);
    this.removeMcpTools(id);
    if (!s.enabled) return 0;
    const client = this.client(s.id, s.name, s.url);
    const adapted = (
      await discoverMcpTools(client, t => this.mcpServers.setTools(s.id, t), signal)
    ).filter(t => mcpToolAllowed(id, t.name));
    for (const t of adapted) this.registry.register(t);
    this.mcpToolNames.set(
      id,
      adapted.map(t => t.name),
    );
    return adapted.length;
  }

  removeMcpTools(id: string): void {
    for (const old of this.mcpToolNames.get(id) ?? []) this.registry.unregister(old);
    this.mcpToolNames.delete(id);
  }

  // --- evaluation (PRD §13) ---------------------------------------------------------

  /**
   * Runs the offline evaluation set through the real planner (skills excluded so
   * plans come from the model) and stores the run. Nothing is executed.
   */
  async evaluate(
    opts: {
      modelId?: string;
      cases?: EvalCase[];
      onProgress?: (done: number, total: number) => void;
    } = {},
  ): Promise<EvalRunResult> {
    await this.ready();
    const plannerNoSkills = new AgentPlanner({
      registry: this.registry,
      inference: this.inference,
      distribution: this.distribution,
      now: this.deps.now,
    });
    const planner: EvalPlanner = async (req, ctx) => {
      const out = await plannerNoSkills.plan(req, { executionId: `eval-${ctx.evalCase.id}` });
      if (out.kind === 'plan') return out.plan;
      const empty: Plan = { goal: req.text, steps: [], source: 'planner' };
      return empty;
    };
    return runEvaluation({
      cases: opts.cases ?? evalCases(),
      planner,
      modelId: opts.modelId ?? this.deps.preferredLocalModel?.() ?? 'auto',
      onProgress: opts.onProgress ? (d, t) => opts.onProgress?.(d, t) : undefined,
    });
  }
}

export function createAgentRuntime(deps: AgentRuntimeDeps): AgentRuntime {
  return new AgentRuntime(deps);
}
