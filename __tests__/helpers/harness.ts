/**
 * Test harness: the real runtime (controller, planner, executor, gateway,
 * registry, SQLite repository) wired to scripted inference and fake native layers.
 */
import { AgentControllerImpl } from '../../src/agent/AgentController';
import { AgentExecutor } from '../../src/agent/AgentExecutor';
import { AgentPlanner } from '../../src/agent/AgentPlanner';
import type { InferenceRunner, InferenceRunOptions } from '../../src/agent/ports';
import type {
  InferenceRequest,
  InferenceResult,
  RoutingContext,
  RoutingDecision,
} from '../../src/inference/types';
import { MemoryManager } from '../../src/memory/MemoryManager';
import type { PermissionChecker } from '../../src/platform/types';
import {
  type ApprovalDecision,
  ApprovalManager,
  type ApprovalRequest,
} from '../../src/security/ApprovalManager';
import { SkillRegistry } from '../../src/skills/SkillRegistry';
import { resetDatabaseForTests } from '../../src/storage/db';
import { ExecutionRepository } from '../../src/storage/ExecutionRepository';
import {
  createAppTools,
  type MeetingsPort,
  type NotificationsPort,
  type TasksPort,
} from '../../src/tools/builtin/app';
import { createDeviceTools, setLegacyExecutor } from '../../src/tools/builtin/device';
import { PermissionGateway } from '../../src/tools/PermissionGateway';
import { ToolRegistry } from '../../src/tools/ToolRegistry';
import type { Distribution, PermissionId } from '../../src/tools/types';

export type Responder = (
  ctx: RoutingContext,
  req: InferenceRequest,
  opts?: InferenceRunOptions,
) =>
  | (Partial<InferenceResult> & { text: string })
  | Promise<Partial<InferenceResult> & { text: string }>;

export interface InferenceCall {
  ctx: RoutingContext;
  req: InferenceRequest;
  decision: RoutingDecision;
}

export class ScriptedInference implements InferenceRunner {
  calls: InferenceCall[] = [];
  constructor(public responder: Responder) {}
  async run(ctx: RoutingContext, req: InferenceRequest, opts?: InferenceRunOptions) {
    const r = await this.responder(ctx, req, opts);
    const result: InferenceResult = {
      modelId: 'lfm2.5-1.2b-instruct',
      provider: 'cactus',
      mode: 'local',
      latencyMs: 5,
      ...r,
    };
    const decision: RoutingDecision = {
      selectedModelId: result.modelId,
      providerId: result.provider,
      executionMode: result.mode,
      reason: 'scripted',
      requiresUserApproval: false,
      rejected: [],
    };
    this.calls.push({ ctx, req, decision });
    return { result, decision };
  }
}

export class FakePermissions implements PermissionChecker {
  granted = new Set<string>();
  requests: string[] = [];
  grantOnRequest = false;
  async check(p: PermissionId) {
    return this.granted.has(p);
  }
  async request(p: PermissionId) {
    this.requests.push(p);
    if (this.grantOnRequest) this.granted.add(p);
    return this.granted.has(p);
  }
}

export interface LegacyCall {
  name: string;
  args: Record<string, unknown>;
}

export interface Harness {
  registry: ToolRegistry;
  repo: ExecutionRepository;
  approvals: ApprovalManager;
  approvalLog: ApprovalRequest[];
  permissions: FakePermissions;
  inference: ScriptedInference;
  gateway: PermissionGateway;
  executor: AgentExecutor;
  planner: AgentPlanner;
  controller: AgentControllerImpl;
  memory: MemoryManager;
  skills: SkillRegistry;
  legacyCalls: LegacyCall[];
  tasksAdded: { title: string; dueDate?: string }[];
  setApproval(fn: (r: ApprovalRequest) => ApprovalDecision): void;
  setLegacyResult(
    fn: (call: LegacyCall) => { success: boolean; message: string; data?: unknown },
  ): void;
}

export function makeHarness(
  opts: {
    responder?: Responder;
    distribution?: Distribution;
    meetings?: Partial<MeetingsPort>;
    notifications?: NotificationsPort;
  } = {},
): Harness {
  resetDatabaseForTests();
  (require('@op-engineering/op-sqlite') as { __resetAll: () => void }).__resetAll();

  const legacyCalls: LegacyCall[] = [];
  let legacyResult = (c: LegacyCall) => ({ success: true, message: `${c.name} ok` });
  setLegacyExecutor(async (name, args) => {
    const call = { name, args };
    legacyCalls.push(call);
    return legacyResult(call);
  });

  const tasksAdded: { title: string; dueDate?: string }[] = [];
  const tasks: TasksPort = {
    add: async t => {
      tasksAdded.push(t);
      return { id: `t${tasksAdded.length}`, title: t.title, dueDate: t.dueDate };
    },
    list: async () => [],
  };
  const meetings: MeetingsPort = {
    latest: async () => null,
    search: async () => [],
    ...opts.meetings,
  };
  const memory = new MemoryManager();
  const registry = new ToolRegistry();
  for (const t of createDeviceTools()) registry.register(t);
  for (const t of createAppTools({
    meetings,
    tasks,
    memory,
    notifications: opts.notifications,
    now: () => new Date(2026, 9, 17, 9, 0),
  }))
    registry.register(t);

  const repo = new ExecutionRepository();
  const approvals = new ApprovalManager();
  const approvalLog: ApprovalRequest[] = [];
  let approvalFn: (r: ApprovalRequest) => ApprovalDecision = () => 'approve_once';
  approvals.setHandler(async r => {
    approvalLog.push(r);
    return approvalFn(r);
  });
  const permissions = new FakePermissions();
  const distribution = () => opts.distribution ?? 'full';
  const inference = new ScriptedInference(opts.responder ?? (() => ({ text: 'ok' })));
  const gateway = new PermissionGateway({ registry, permissions, approvals, repo, distribution });
  const executor = new AgentExecutor({
    registry,
    gateway,
    inference,
    repo,
    approvals,
    permissions,
    distribution,
    sleep: async () => {},
  });
  const skills = new SkillRegistry(registry, distribution);
  const planner = new AgentPlanner({
    registry,
    inference,
    skills,
    distribution,
    now: () => new Date(2026, 9, 17, 9, 0),
  });
  const controller = new AgentControllerImpl({ planner, executor, repo, memory, approvals });

  return {
    registry,
    repo,
    approvals,
    approvalLog,
    permissions,
    inference,
    gateway,
    executor,
    planner,
    controller,
    memory,
    skills,
    legacyCalls,
    tasksAdded,
    setApproval: fn => {
      approvalFn = fn;
    },
    setLegacyResult: fn => {
      legacyResult = fn as typeof legacyResult;
    },
  };
}

/** A tool-call reply in the google/mobile-actions JSON format the fine-tuned model emits. */
export function toolCallsText(
  calls: { name: string; arguments: Record<string, unknown> }[],
): string {
  return JSON.stringify(calls.map(c => ({ name: c.name, arguments: c.arguments })));
}
