// @effect-diagnostics nodeBuiltinImport:off
import * as NodeCrypto from "@effect/platform-node/NodeCrypto";
import * as NodeServices from "@effect/platform-node/NodeServices";
import { describe, expect, it } from "@effect/vitest";
import {
  CheckpointScopeId,
  CommandId,
  EnvironmentId,
  GitCommandError,
  MessageId,
  NodeId,
  ProjectId,
  ProviderDriverKind,
  ProviderInstanceId,
  ProviderSessionId,
  ProviderThreadId,
  RunAttemptId,
  RunId,
  ServerSettingsError,
  ThreadId,
  type CodingAgentTurnOverride,
  type OrchestrationV2ServerCommand,
  type OrchestrationV2StoredEvent,
  type OrchestrationV2Subagent,
  type OrchestrationV2ThreadProjection,
  type Project,
  type ServerProvider,
} from "@t3tools/contracts";
import * as IdAllocator from "@t3tools/provider-core/server/IdAllocator";
import type * as ProviderAdapter from "@t3tools/provider-core/server/ProviderAdapter";
import * as AcpRegistrySupport from "@t3tools/provider-acp-registry/server/AcpRegistrySupport";
import * as DateTime from "effect/DateTime";
import * as Deferred from "effect/Deferred";
import * as Effect from "effect/Effect";
import * as Fiber from "effect/Fiber";
import * as Layer from "effect/Layer";
import * as Queue from "effect/Queue";
import * as Ref from "effect/Ref";
import * as Stream from "effect/Stream";
import { McpSchema, McpServer } from "effect/ai";
import * as NodeChildProcess from "node:child_process";
import * as NodeFS from "node:fs";
import * as NodeOS from "node:os";
import * as NodePath from "node:path";

import * as ServerSecretStore from "../auth/ServerSecretStore.ts";
import * as ServerConfig from "../config.ts";
import * as ManagedPolicy from "../policy/ManagedPolicy.ts";
import * as GitWorkflow from "../git/GitWorkflowService.ts";
import { imToolAllowed } from "../im/XtworkImMcp.ts";
import { desktopContext, type TurnExecutionContext } from "../im/XtworkImSecurity.ts";
import { setActiveXtworkPolicyHook, type XtworkPolicyHook } from "../im/XtworkImService.ts";
import * as McpHttpServer from "../mcp/McpHttpServer.ts";
import * as McpInvocationContext from "../mcp/McpInvocationContext.ts";
import * as OrchestratorMcpService from "../mcp/OrchestratorMcpService.ts";
import * as CommandReceiptStore from "../orchestration-v2/CommandReceiptStore.ts";
import * as ContextHandoffService from "../orchestration-v2/ContextHandoffService.ts";
import * as EventSink from "../orchestration-v2/EventSink.ts";
import * as Orchestrator from "../orchestration-v2/Orchestrator.ts";
import * as ProjectionStore from "../orchestration-v2/ProjectionStore.ts";
import * as ProviderAdapterRegistry from "../orchestration-v2/ProviderAdapterRegistry.ts";
import * as ProviderSessionManager from "../orchestration-v2/ProviderSessionManager.ts";
import * as ProviderTurnStartService from "../orchestration-v2/ProviderTurnStartService.ts";
import * as RunExecutionService from "../orchestration-v2/RunExecutionService.ts";
import * as RuntimePolicy from "../orchestration-v2/RuntimePolicy.ts";
import * as ThreadLaunchService from "../orchestration-v2/ThreadLaunchService.ts";
import * as ThreadManagementService from "../orchestration-v2/ThreadManagementService.ts";
import * as TurnItemPositionStore from "../orchestration-v2/TurnItemPositionStore.ts";
import * as PeerForwarding from "../peer/PeerForwarding.ts";
import * as PeerLinkRequests from "../peer/PeerLinkRequests.ts";
import * as PeerLinks from "../peer/PeerLinks.ts";
import * as RemoteDelegation from "../peer/RemoteDelegation.ts";
import * as SqlitePersistence from "../persistence/Sqlite.ts";
import * as ManagedProjectFolders from "../project/ManagedProjectFolders.ts";
import * as ProjectService from "../project/ProjectService.ts";
import * as ProviderAuthService from "../provider/ProviderAuthService.ts";
import * as ProviderRegistry from "../provider/ProviderRegistry.ts";
import * as ScheduledTaskService from "../scheduledTasks/ScheduledTaskService.ts";
import * as SecretRequests from "../secrets/SecretRequests.ts";
import * as ServerSettings from "../serverSettings.ts";
import * as ProviderUsageAnalytics from "../telemetry/ProviderUsageAnalytics.ts";
import * as GitVcsDriver from "../vcs/GitVcsDriver.ts";
import { PI_DRIVER, PI_INSTANCE_ID } from "./bundledPiSettings.ts";
import {
  CODING_AGENT_BUILTIN_ONCE_CODE,
  CODING_AGENT_UNAVAILABLE_CODE,
  IM_DELEGATION_DENIED_CODE,
  assessCodingAgentReadiness,
} from "./codingAgentDelegation.ts";
import { KIMI_CODE_INSTANCE_ID } from "./codingAgentSeed.ts";
import {
  InstallConsentStore,
  XtworkInstallConsent,
  acpConsentGateLayer,
  makeXtworkInstallConsentService,
} from "./installConsent.ts";

const STRUCTURED_BRIEF_EN = [
  "1. Goal & Acceptance Criteria: Fix the auth test failure and ensure unit tests pass.",
  "2. Constraints & Scope: Only edit auth module files; do not touch database migrations.",
  "3. File/Attachment Paths: apps/server/src/auth.ts, apps/server/src/auth.test.ts",
  "4. Privacy/Secret Redaction: Exclude unrelated chat history and secrets.",
  "5. Verification Summary: Report edited files and test output.",
].join("\n");

const STRUCTURED_BRIEF_ZH = [
  "## 目标与验收标准",
  "在当前 scratch 目录创建 script.py 并验证运行输出正确。",
  "## 约束与范围",
  "仅修改 scratch 目录下的脚本，不修改其他项目文件。",
  "## 相关文件路径",
  "script.py",
].join("\n");

const claudeId = ProviderInstanceId.make("claudeAgent");
const codexId = ProviderInstanceId.make("codex");
const kimiId = KIMI_CODE_INSTANCE_ID;

const environmentId = EnvironmentId.make("env:m1c-gate2");
const parentThreadId = ThreadId.make("thread:m1c-gate2-parent");
const parentRunId = RunId.make("run:m1c-gate2-parent");
const parentNodeId = NodeId.make("node:m1c-gate2-parent-root");
const childThreadId = ThreadId.make("thread:m1c-gate2-child");
const childRunId = RunId.make("run:m1c-gate2-child");
const childNodeId = NodeId.make("node:m1c-gate2-child-root");
const taskId = NodeId.make("node:m1c-gate2-task");
const projectId = ProjectId.make("project:m1c-gate2");

function makeProvider(
  instanceId: ProviderInstanceId,
  driver: string,
  model: string,
  overrides: Partial<ServerProvider> = {},
): ServerProvider {
  return {
    instanceId,
    driver: ProviderDriverKind.make(driver),
    enabled: true,
    installed: true,
    version: "1.0.0",
    status: "ready",
    auth: { status: "authenticated" },
    checkedAt: "2026-11-25T00:00:00.000Z",
    models: [{ slug: model, name: model, isCustom: false, capabilities: null }],
    slashCommands: [],
    skills: [],
    ...overrides,
  };
}

function makeScope(overrides?: {
  readonly threadId?: ThreadId;
  readonly providerInstanceId?: ProviderInstanceId;
  readonly imExecution?: McpInvocationContext.McpInvocationScope["imExecution"];
}): McpInvocationContext.McpInvocationScope {
  return {
    environmentId,
    issuedAt: 0,
    client: undefined,
    requestNamespace: `thread:${overrides?.threadId ?? parentThreadId}`,
    capabilities: new Set(["orchestration"]),
    thread: {
      threadId: overrides?.threadId ?? parentThreadId,
      providerSessionId: "session:m1c-gate2",
      providerInstanceId: overrides?.providerInstanceId ?? PI_INSTANCE_ID,
    },
    ...(overrides?.imExecution === undefined ? {} : { imExecution: overrides.imExecution }),
  };
}

function makeParentProjection(options?: {
  readonly threadId?: ThreadId;
  readonly projectId?: ProjectId;
  readonly worktreePath?: string | null;
  readonly branch?: string | null;
  readonly subagents?: ReadonlyArray<unknown>;
}): OrchestrationV2ThreadProjection {
  const tid = options?.threadId ?? parentThreadId;
  return {
    thread: {
      id: tid,
      projectId: options?.projectId ?? projectId,
      title: "Parent Desktop Thread",
      modelSelection: { instanceId: PI_INSTANCE_ID, model: "xtwork/standard" },
      runtimeMode: "full-access",
      interactionMode: "default",
      worktreePath: options?.worktreePath ?? null,
      branch: options?.branch ?? null,
      archivedAt: null,
      deletedAt: null,
      lineage: { parentThreadId: null, relationshipToParent: null },
    },
    runs: [
      {
        id: parentRunId,
        ordinal: 1,
        status: "running",
        rootNodeId: parentNodeId,
        providerInstanceId: PI_INSTANCE_ID,
      },
    ],
    subagents: options?.subagents ?? [],
  } as unknown as OrchestrationV2ThreadProjection;
}

function makeAdapterRegistryLayer(instanceIds: ReadonlyArray<ProviderInstanceId>) {
  const byId = new Map<ProviderInstanceId, ProviderAdapter.ProviderAdapterV2["Service"]>(
    instanceIds.map((id) => {
      const driver =
        id === PI_INSTANCE_ID
          ? PI_DRIVER
          : id === claudeId
            ? ProviderDriverKind.make("claudeAgent")
            : id === codexId
              ? ProviderDriverKind.make("codex")
              : ProviderDriverKind.make("acpRegistry");
      return [
        id,
        {
          instanceId: id,
          driver,
          getCapabilities: () => Effect.die("unused"),
          planSelectionTransition: () => Effect.die("unused"),
          openSession: () => Effect.die("unused"),
        } as unknown as ProviderAdapter.ProviderAdapterV2["Service"],
      ];
    }),
  );
  return Layer.succeed(
    ProviderAdapterRegistry.ProviderAdapterRegistryV2,
    ProviderAdapterRegistry.ProviderAdapterRegistryV2.of({
      get: (id) => {
        const adapter = byId.get(id);
        return adapter
          ? Effect.succeed(adapter)
          : Effect.fail(new ProviderAdapterRegistry.ProviderAdapterRegistryLookupError({ instanceId: id }));
      },
      list: () => Effect.succeed([...byId.keys()]),
    }),
  );
}

const mcpTestClient = McpSchema.McpServerClient.of({
  clientId: 1,
  protocolVersion: "2025-06-18",
  clientCapabilities: {},
  clientInfo: { name: "m1c-gate2-test", version: "1.0.0" },
  initializePayload: {
    protocolVersion: "2025-06-18",
    capabilities: {},
    clientInfo: { name: "m1c-gate2-test", version: "1.0.0" },
  },
  getClient: Effect.die("unused"),
});

describe("M1c-Gate 2 integration: deterministic routing, workspace contract, cancel, recovery, and IM hard-deny", () => {
  it.effect(
    "routes deterministically to codingAgent.instanceId and returns structured coding_agent_unavailable without silent fallback or download",
    () =>
      Effect.gen(function* () {
        const readyPi = makeProvider(PI_INSTANCE_ID, "pi", "xtwork/standard", {
          displayName: "小瞳",
        });
        const readyClaude = makeProvider(claudeId, "claudeAgent", "claude-sonnet-4-6", {
          displayName: "Claude Code",
        });
        const readyCodex = makeProvider(codexId, "codex", "gpt-5.4", {
          displayName: "Codex",
        });

        // 1. Ready locked provider: overrides omitted target AND mismatched external target (`codex`).
        const dispatchedCommands: Array<OrchestrationV2ServerCommand> = [];
        const taskRecord = {
          id: taskId,
          threadId: parentThreadId,
          runId: parentRunId,
          parentNodeId,
          origin: "app_owned",
          providerInstanceId: claudeId,
          driver: "claudeAgent",
          childThreadId,
          model: "claude-sonnet-4-6",
          status: "running",
          result: null,
        };
        const childProjection = {
          thread: {
            id: childThreadId,
            title: "Child",
            modelSelection: { instanceId: claudeId, model: "claude-sonnet-4-6" },
            lineage: { parentThreadId, relationshipToParent: "subagent" },
          },
          runs: [{ id: childRunId, ordinal: 1, status: "running", rootNodeId: childNodeId }],
          nodes: [{ id: childNodeId, runId: childRunId }],
          subagents: [],
          providerThreads: [],
          providerTurns: [],
          runtimeRequests: [],
          contextTransfers: [],
          messages: [],
          turnItems: [],
        } as unknown as OrchestrationV2ThreadProjection;

        const routedDeps = Layer.mergeAll(
          NodeServices.layer,
          NodeCrypto.layer,
          Layer.mock(ThreadManagementService.ThreadManagementService)({
            hasReceipt: () => Effect.succeed(false),
            isProviderInstanceEnabledForProject: () => Effect.succeed(true),
            getThreadRecords: (tid) =>
              Effect.succeed(
                tid === parentThreadId
                  ? makeParentProjection({ subagents: [taskRecord] })
                  : childProjection,
              ),
            delegatedTaskResultPending: () => Effect.succeed(false),
            dispatch: (command) =>
              Effect.sync(() => {
                dispatchedCommands.push(command);
                return {
                  sequence: 1,
                  storedEvents: [{ event: { type: "subagent.updated", payload: taskRecord } }],
                } as never;
              }),
          }),
          ServerSettings.layerTest({
            codingAgent: { mode: "provider", instanceId: claudeId, model: "claude-sonnet-4-6" },
          }),
          Layer.mock(ProviderRegistry.ProviderRegistry)({
            getProviders: Effect.succeed([readyPi, readyClaude, readyCodex]),
          }),
          makeAdapterRegistryLayer([PI_INSTANCE_ID, claudeId, codexId]),
          Layer.mock(ThreadLaunchService.ThreadLaunchService)({}),
          Layer.mock(GitVcsDriver.GitVcsDriver)({}),
          Layer.mock(ProjectService.ProjectService)({}),
          Layer.mock(SecretRequests.SecretRequests)({}),
          Layer.mock(RemoteDelegation.RemoteDelegation)({}),
          Layer.mock(ScheduledTaskService.ScheduledTaskService)({}),
        );

        yield* Effect.gen(function* () {
          const service = yield* OrchestratorMcpService.OrchestratorMcpService;
          const result = yield* service.delegateTask(makeScope(), {
            task: STRUCTURED_BRIEF_EN,
            target: { providerInstanceId: codexId, model: "gpt-5.4" },
            mode: "async",
            clientRequestId: "m1c-routed-1",
          });
          expect(result.providerInstanceId).toBe(claudeId);
          expect(dispatchedCommands).toHaveLength(1);
          const delegated = dispatchedCommands[0] as Extract<
            OrchestrationV2ServerCommand,
            { readonly type: "delegated_task.request" }
          >;
          expect(delegated.modelSelection).toEqual({
            instanceId: claudeId,
            model: "claude-sonnet-4-6",
          });
        }).pipe(Effect.provide(OrchestratorMcpService.layer.pipe(Layer.provide(routedDeps))));

        // 2. Blocked locked provider (uninstalled, update_required, unauthenticated, disabled, not_found)
        //    with `codex` ready: MUST return coding_agent_unavailable, ZERO dispatch, ZERO refresh/download!
        const blockedScenarios = [
          {
            label: "not_installed",
            lockedId: kimiId,
            providers: [
              readyPi,
              readyCodex,
              makeProvider(kimiId, "acpRegistry", "default", {
                displayName: "Kimi Code",
                installed: false,
                status: "warning",
              }),
            ],
            expectedReason: "not_installed",
            canInstall: true,
            canLogin: false,
          },
          {
            label: "update_required",
            lockedId: kimiId,
            providers: [
              readyPi,
              readyCodex,
              makeProvider(kimiId, "acpRegistry", "default", {
                displayName: "Kimi Code",
                installed: true,
                status: "warning",
                message:
                  "ACP Registry agent 'kimi-code' has update v2.0.0 available. Confirm in provider settings to update.",
              }),
            ],
            expectedReason: "update_required",
            canInstall: true,
            canLogin: false,
          },
          {
            label: "not_authenticated",
            lockedId: claudeId,
            providers: [
              readyPi,
              readyCodex,
              makeProvider(claudeId, "claudeAgent", "claude-sonnet-4-6", {
                displayName: "Claude Code",
                installed: true,
                status: "warning",
                auth: { status: "unauthenticated" },
                setup: { canAuthenticate: true, canInstall: true },
              }),
            ],
            expectedReason: "not_authenticated",
            canInstall: false,
            canLogin: true,
          },
          {
            label: "disabled",
            lockedId: claudeId,
            providers: [
              readyPi,
              readyCodex,
              makeProvider(claudeId, "claudeAgent", "claude-sonnet-4-6", {
                displayName: "Claude Code",
                enabled: false,
                status: "disabled",
              }),
            ],
            expectedReason: "disabled",
            canInstall: false,
            canLogin: false,
          },
          {
            label: "not_found",
            lockedId: ProviderInstanceId.make("deletedAgent"),
            providers: [readyPi, readyCodex],
            expectedReason: "not_found",
            canInstall: false,
            canLogin: false,
          },
        ] as const;

        for (const scenario of blockedScenarios) {
          let refreshCount = 0;
          let dispatchCount = 0;
          const blockedDeps = Layer.mergeAll(
            NodeServices.layer,
            NodeCrypto.layer,
            Layer.mock(ThreadManagementService.ThreadManagementService)({
              hasReceipt: () => Effect.succeed(false),
              isProviderInstanceEnabledForProject: () => Effect.succeed(true),
              getThreadRecords: () => Effect.succeed(makeParentProjection()),
              getThreadShell: () =>
                Effect.succeed({
                  id: parentThreadId,
                  projectId,
                  title: "Parent Desktop Thread",
                  runtimeMode: "full-access",
                  interactionMode: "default",
                  archivedAt: null,
                  deletedAt: null,
                  activeRunId: parentRunId,
                  providerInstanceId: PI_INSTANCE_ID,
                  pendingBackgroundTasks: [],
                  lineage: { parentThreadId: null, relationshipToParent: null },
                } as never),
              dispatch: () =>
                Effect.sync(() => {
                  dispatchCount += 1;
                  return { sequence: 1, storedEvents: [] } as never;
                }),
            }),
            ServerSettings.layerTest({
              codingAgent: { mode: "provider", instanceId: scenario.lockedId },
            }),
            Layer.mock(ProviderRegistry.ProviderRegistry)({
              getProviders: Effect.succeed(scenario.providers),
              refreshInstance: () =>
                Effect.sync(() => {
                  refreshCount += 1;
                  return scenario.providers;
                }),
            }),
            makeAdapterRegistryLayer([PI_INSTANCE_ID, claudeId, codexId, kimiId]),
            Layer.mock(ThreadLaunchService.ThreadLaunchService)({}),
            Layer.mock(GitVcsDriver.GitVcsDriver)({}),
            Layer.mock(ProjectService.ProjectService)({}),
            Layer.mock(SecretRequests.SecretRequests)({}),
            Layer.mock(RemoteDelegation.RemoteDelegation)({}),
            Layer.mock(ScheduledTaskService.ScheduledTaskService)({}),
            Layer.mock(PeerForwarding.PeerForwarding)({}),
            Layer.mock(PeerLinkRequests.PeerLinkRequests)({}),
            Layer.mock(PeerLinks.PeerLinks)({}),
          );

          const toolkitLayer = McpHttpServer.layerOrchestratorToolkit.pipe(
            Layer.provideMerge(McpHttpServer.layerInProcessMcpServer),
            Layer.provide(blockedDeps),
          );

          yield* Effect.gen(function* () {
            const server = yield* McpServer.McpServer;
            const callResult = yield* server
              .callTool({
                name: "delegate_task",
                arguments: {
                  task: "Refactor module",
                  target: { providerInstanceId: codexId },
                },
              })
              .pipe(
                Effect.provideService(McpSchema.McpServerClient, mcpTestClient),
                Effect.provideService(McpInvocationContext.McpInvocationContext, makeScope()),
              );
            expect(callResult.isError, scenario.label).toBe(true);
            const firstText = callResult.content[0];
            expect(firstText?.type).toBe("text");
            const payload = JSON.parse(firstText?.type === "text" ? firstText.text : "{}") as Record<
              string,
              unknown
            >;
            expect(payload, scenario.label).toMatchObject({
              blocked: true,
              code: CODING_AGENT_UNAVAILABLE_CODE,
              reason: scenario.expectedReason,
              instanceId: scenario.lockedId,
              canInstall: scenario.canInstall,
              canLogin: scenario.canLogin,
            });
            expect(dispatchCount, scenario.label).toBe(0);
            expect(refreshCount, scenario.label).toBe(0);
          }).pipe(Effect.provide(toolkitLayer));
        }
      }),
  );

  it.effect(
    "supports scratch/ first-message delegation with isolation: 'shared', refuses worktree on scratch/ and non-Git, and recursively cancels delegated child on parent stop",
    () =>
      Effect.gen(function* () {
        const scratchRoot = "/tmp/xtwork-m1c-scratch-test/scratch";
        const scratchThreadDir = `${scratchRoot}/2026-11-25-first-message`;
        const scratchProjectId = ProjectId.make("project:scratch-m1c");
        const nonGitProjectId = ProjectId.make("project:non-git-m1c");
        const nonGitThreadId = ThreadId.make("thread:non-git-parent");

        let gitResolveCalls = 0;

        const readyPi = makeProvider(PI_INSTANCE_ID, "pi", "xtwork/standard", {
          displayName: "小瞳",
        });
        const readyClaude = makeProvider(claudeId, "claudeAgent", "claude-sonnet-4-6", {
          displayName: "Claude Code",
        });

        // Stateful in-memory Orchestrator backing the REAL ThreadManagementService + OrchestratorMcpService!
        const threads = new Map<ThreadId, OrchestrationV2ThreadProjection>([
          [
            parentThreadId,
            makeParentProjection({
              threadId: parentThreadId,
              projectId: scratchProjectId,
              worktreePath: scratchThreadDir,
              branch: null,
              subagents: [],
            }),
          ],
          [
            nonGitThreadId,
            makeParentProjection({
              threadId: nonGitThreadId,
              projectId: nonGitProjectId,
              worktreePath: null,
              branch: null,
              subagents: [],
            }),
          ],
        ]);
        const stoppedThreads: Array<ThreadId> = [];

        const mockOrchestratorLayer = Layer.mock(Orchestrator.OrchestratorV2)({
          getThreadRecords: (tid) =>
            Effect.sync(() => {
              const found = threads.get(tid);
              if (!found) throw new Error(`Missing test thread ${tid}`);
              return found;
            }),
          getThreadShell: (tid) =>
            Effect.sync(() => (threads.get(tid)?.thread ?? null) as never),
          dispatch: (command) =>
            Effect.sync(() => {
              if (command.type === "delegated_task.request") {
                const parentProj = threads.get(command.parentThreadId)!;
                const task: OrchestrationV2Subagent = {
                  id: taskId,
                  threadId: command.parentThreadId,
                  runId: command.parentRunId,
                  parentNodeId: command.parentNodeId,
                  origin: "app_owned",
                  createdBy: "agent",
                  driver: ProviderDriverKind.make("claudeAgent"),
                  providerInstanceId: command.modelSelection.instanceId,
                  providerThreadId: null,
                  childThreadId,
                  nativeTaskRef: null,
                  prompt: command.task,
                  title: command.title ?? "Delegated task",
                  model: command.modelSelection.model,
                  modelSelection: command.modelSelection,
                  status: "running",
                  result: null,
                  startedAt: DateTime.makeUnsafe("2026-11-25T08:00:00Z"),
                  completedAt: null,
                  updatedAt: DateTime.makeUnsafe("2026-11-25T08:00:00Z"),
                };
                const childProj = {
                  thread: {
                    id: childThreadId,
                    projectId: parentProj.thread.projectId,
                    title: task.title ?? "Delegated child",
                    modelSelection: command.modelSelection,
                    runtimeMode: command.runtimeMode,
                    interactionMode: command.interactionMode,
                    worktreePath:
                      command.workspaceStrategy === undefined
                        ? parentProj.thread.worktreePath
                        : null,
                    branch:
                      command.workspaceStrategy === undefined ? parentProj.thread.branch : null,
                    archivedAt: null,
                    deletedAt: null,
                    lineage: {
                      parentThreadId: command.parentThreadId,
                      relationshipToParent: "subagent",
                    },
                  },
                  runs: [
                    {
                      id: childRunId,
                      ordinal: 1,
                      status: "running",
                      rootNodeId: childNodeId,
                      providerInstanceId: command.modelSelection.instanceId,
                    },
                  ],
                  nodes: [{ id: childNodeId, runId: childRunId }],
                  subagents: [],
                  providerThreads: [],
                  providerTurns: [],
                  runtimeRequests: [],
                  contextTransfers: [],
                  messages: [],
                  turnItems: [],
                } as unknown as OrchestrationV2ThreadProjection;
                threads.set(childThreadId, childProj);
                threads.set(command.parentThreadId, {
                  ...parentProj,
                  subagents: [...parentProj.subagents, task],
                });
                return {
                  sequence: 1,
                  storedEvents: [{ event: { type: "subagent.updated", payload: task } }],
                } as never;
              }
              if (command.type === "thread.stop") {
                stoppedThreads.push(command.threadId);
                const existing = threads.get(command.threadId);
                if (existing) {
                  threads.set(command.threadId, {
                    ...existing,
                    runs: existing.runs.map((run) => ({ ...run, status: "interrupted" as const })),
                  });
                }
                return { sequence: 2, storedEvents: [] } as never;
              }
              return { sequence: 1, storedEvents: [] } as never;
            }),
        });

        const settingsLayer = ServerSettings.layerTest({
          codingAgent: { mode: "provider", instanceId: claudeId, model: "claude-sonnet-4-6" },
        });
        const adaptersLayer = makeAdapterRegistryLayer([PI_INSTANCE_ID, claudeId]);
        const receiptsLayer = CommandReceiptStore.layer.pipe(
          Layer.provide(SqlitePersistence.layerMemory),
        );
        const threadManagementLayer = ThreadManagementService.layer.pipe(
          Layer.provide(mockOrchestratorLayer),
          Layer.provide(settingsLayer),
          Layer.provide(receiptsLayer),
          Layer.provide(Layer.mock(ProviderSessionManager.ProviderSessionManagerV2)({})),
        );

        const scratchProject = {
          id: scratchProjectId,
          title: "No project",
          workspaceRoot: scratchRoot,
        } as unknown as Project;
        const nonGitProject = {
          id: nonGitProjectId,
          title: "Plain Folder",
          workspaceRoot: "/tmp/xtwork-plain-folder",
        } as unknown as Project;

        const deps = Layer.mergeAll(
          NodeServices.layer,
          NodeCrypto.layer,
          mockOrchestratorLayer,
          threadManagementLayer,
          settingsLayer,
          adaptersLayer,
          Layer.mock(ProviderRegistry.ProviderRegistry)({
            getProviders: Effect.succeed([readyPi, readyClaude]),
          }),
          Layer.mock(ProjectService.ProjectService)({
            getById: (id) =>
              id === scratchProjectId
                ? Effect.succeedSome(scratchProject)
                : id === nonGitProjectId
                  ? Effect.succeedSome(nonGitProject)
                  : Effect.succeedNone,
          }),
          Layer.mock(ManagedProjectFolders.ManagedProjectFolders)({
            namedProjectsRoot: "/tmp/xtwork-m1c-scratch-test/projects",
            scratchRoot: Effect.succeedSome(scratchRoot),
            isScratchProject: (id) => Effect.succeed(id === scratchProjectId),
          }),
          Layer.mock(GitVcsDriver.GitVcsDriver)({
            resolveCommit: () =>
              Effect.sync(() => {
                gitResolveCalls += 1;
              }).pipe(
                Effect.andThen(
                  Effect.fail(
                    new GitCommandError({
                      operation: "rev-parse",
                      command: "git rev-parse HEAD",
                      cwd: "/tmp/xtwork-plain-folder",
                      detail: "not a git repository",
                    }),
                  ),
                ),
              ),
          }),
          Layer.mock(ThreadLaunchService.ThreadLaunchService)({}),
          Layer.mock(SecretRequests.SecretRequests)({}),
          Layer.mock(RemoteDelegation.RemoteDelegation)({}),
          Layer.mock(ScheduledTaskService.ScheduledTaskService)({}),
        );

        yield* Effect.gen(function* () {
          const threadManagement = yield* ThreadManagementService.ThreadManagementService;
          const mcp = yield* OrchestratorMcpService.OrchestratorMcpService;

          // 1. isolation: "worktree" on scratch/ is cleanly refused WITHOUT calling git!
          const scratchWorktreeErr = yield* mcp
            .delegateTask(makeScope(), {
              task: STRUCTURED_BRIEF_ZH,
              isolation: "worktree",
              mode: "async",
              clientRequestId: "scratch-worktree-refuse",
            })
            .pipe(Effect.flip);
          expect(scratchWorktreeErr.code).toBe("invalid_request");
          expect(scratchWorktreeErr.message).toContain("scratch/");
          expect(scratchWorktreeErr.message).toContain('isolation: "shared"');
          expect(gitResolveCalls).toBe(0);

          // 2. isolation: "shared" on scratch/ first-message delegation succeeds cleanly!
          const sharedDelegation = yield* mcp.delegateTask(makeScope(), {
            task: STRUCTURED_BRIEF_ZH,
            isolation: "shared",
            mode: "async",
            clientRequestId: "scratch-shared-ok",
          });
          expect(sharedDelegation.providerInstanceId).toBe(claudeId);
          expect(sharedDelegation.model).toBe("claude-sonnet-4-6");
          expect(sharedDelegation.childThreadId).toBe(childThreadId);
          expect(gitResolveCalls).toBe(0);

          const delegatedChild = threads.get(childThreadId)!;
          expect(delegatedChild.thread.projectId).toBe(scratchProjectId);
          expect(delegatedChild.thread.worktreePath).toBe(scratchThreadDir);
          expect(delegatedChild.thread.branch).toBeNull();

          // 3. Parent stop recursively cancels delegated external Coding Agent child via existing ThreadManagementService.stopDelegatedTasks!
          yield* threadManagement.stopDelegatedTasks({
            threadId: parentThreadId,
            commandId: CommandId.make("cmd:parent-stop"),
            reason: "User stopped parent",
          });
          expect(stoppedThreads).toContain(childThreadId);
          expect(threads.get(childThreadId)?.runs[0]?.status).toBe("interrupted");

          // 4. Non-Git folder also cleanly refuses isolation: "worktree" with shared guidance!
          const nonGitWorktreeErr = yield* mcp
            .delegateTask(makeScope({ threadId: nonGitThreadId }), {
              task: STRUCTURED_BRIEF_EN,
              isolation: "worktree",
              mode: "async",
              clientRequestId: "non-git-worktree-refuse",
            })
            .pipe(Effect.flip);
          expect(nonGitWorktreeErr.code).toBe("invalid_request");
          expect(nonGitWorktreeErr.message).toContain('isolation: "shared"');
          expect(gitResolveCalls).toBe(1);
        }).pipe(
          Effect.provide(OrchestratorMcpService.layer.pipe(Layer.provideMerge(deps))),
        );
      }),
  );

  it.effect(
    "handles approval-wait and child process crash recovery cleanly without hanging the parent",
    () =>
      Effect.gen(function* () {
        const readyPi = makeProvider(PI_INSTANCE_ID, "pi", "xtwork/standard");
        const readyClaude = makeProvider(claudeId, "claudeAgent", "claude-sonnet-4-6");

        // 1. Approval-wait: pending approval wakes mode: "wait" immediately with pendingApproval handle.
        const approvalSubscribed = yield* Deferred.make<void>();
        const approvalEvents = yield* Queue.unbounded<OrchestrationV2StoredEvent>();
        let approvalPending = false;
        const approvalTask = {
          id: taskId,
          threadId: parentThreadId,
          runId: parentRunId,
          parentNodeId,
          origin: "app_owned",
          providerInstanceId: claudeId,
          driver: "claudeAgent",
          childThreadId,
          model: "claude-sonnet-4-6",
          status: "running",
          result: null,
        };
        const approvalChild = () =>
          ({
            thread: { id: childThreadId, title: "Claude child" },
            runs: [{ id: childRunId, ordinal: 1, status: "running", rootNodeId: childNodeId }],
            nodes: [{ id: childNodeId, runId: childRunId }],
            subagents: [],
            providerThreads: [],
            providerTurns: [],
            contextTransfers: [],
            messages: [],
            turnItems: [],
            runtimeRequests: approvalPending
              ? [
                  {
                    id: "req:claude-approval-1",
                    nodeId: childNodeId,
                    kind: "command",
                    status: "pending",
                    responseCapability: { type: "live" },
                    createdAt: DateTime.makeUnsafe(0),
                  },
                ]
              : [],
          }) as unknown as OrchestrationV2ThreadProjection;

        const approvalDeps = Layer.mergeAll(
          NodeServices.layer,
          NodeCrypto.layer,
          Layer.mock(ThreadManagementService.ThreadManagementService)({
            hasReceipt: () => Effect.succeed(false),
            isProviderInstanceEnabledForProject: () => Effect.succeed(true),
            getThreadRecords: (tid) =>
              Effect.sync(() =>
                tid === parentThreadId
                  ? makeParentProjection({ subagents: [approvalTask] })
                  : approvalChild(),
              ),
            getThreadEventSequence: () => Effect.succeed(0),
            delegatedTaskResultPending: () => Effect.succeed(false),
            streamStoredEventsFrom: (input) =>
              input?.threadId === childThreadId && input.eventType === "runtime-request.updated"
                ? Stream.fromEffect(Deferred.succeed(approvalSubscribed, undefined)).pipe(
                    Stream.drain,
                    Stream.concat(Stream.fromQueue(approvalEvents)),
                  )
                : Stream.never,
            dispatch: () =>
              Effect.succeed({
                sequence: 1,
                storedEvents: [{ event: { type: "subagent.updated", payload: approvalTask } }],
              } as never),
          }),
          ServerSettings.layerTest({
            codingAgent: { mode: "provider", instanceId: claudeId, model: "claude-sonnet-4-6" },
          }),
          Layer.mock(ProviderRegistry.ProviderRegistry)({
            getProviders: Effect.succeed([readyPi, readyClaude]),
          }),
          makeAdapterRegistryLayer([PI_INSTANCE_ID, claudeId]),
          Layer.mock(ThreadLaunchService.ThreadLaunchService)({}),
          Layer.mock(GitVcsDriver.GitVcsDriver)({}),
          Layer.mock(ProjectService.ProjectService)({}),
          Layer.mock(SecretRequests.SecretRequests)({}),
          Layer.mock(RemoteDelegation.RemoteDelegation)({}),
          Layer.mock(ScheduledTaskService.ScheduledTaskService)({}),
        );

        yield* Effect.gen(function* () {
          const service = yield* OrchestratorMcpService.OrchestratorMcpService;
          const waiting = yield* service
            .delegateTask(makeScope(), {
              task: STRUCTURED_BRIEF_EN,
              mode: "wait",
              clientRequestId: "m1c-approval-wait",
            })
            .pipe(Effect.forkChild);
          yield* Deferred.await(approvalSubscribed);
          approvalPending = true;
          yield* Queue.offer(approvalEvents, {
            sequence: 2,
            event: {
              type: "runtime-request.updated",
              threadId: childThreadId,
              payload: { id: "req:claude-approval-1" },
            },
          } as unknown as OrchestrationV2StoredEvent);
          const result = yield* Fiber.join(waiting);
          expect(result.waitTimedOut).toBe(false);
          expect(result.pendingApproval).toEqual({
            requestId: "req:claude-approval-1",
            kind: "command",
            runId: childRunId,
          });
        }).pipe(Effect.provide(OrchestratorMcpService.layer.pipe(Layer.provide(approvalDeps))));

        // 2. Child process crash recovery: child transitions to failed and wakes parent cleanly.
        const crashSubscribed = yield* Deferred.make<void>();
        const crashEvents = yield* Queue.unbounded<OrchestrationV2StoredEvent>();
        let crashed = false;
        const crashTask = () => ({
          id: taskId,
          threadId: parentThreadId,
          runId: parentRunId,
          parentNodeId,
          origin: "app_owned",
          providerInstanceId: claudeId,
          driver: "claudeAgent",
          childThreadId,
          model: "claude-sonnet-4-6",
          status: crashed ? "failed" : "running",
          result: crashed ? "Claude Code process exited unexpectedly (SIGKILL)." : null,
        });
        const crashChild = () =>
          ({
            thread: { id: childThreadId, title: "Claude child" },
            runs: [
              {
                id: childRunId,
                ordinal: 1,
                status: crashed ? "failed" : "running",
                rootNodeId: childNodeId,
                startedAt: DateTime.makeUnsafe(100),
                completedAt: crashed ? DateTime.makeUnsafe(200) : null,
              },
            ],
            nodes: [{ id: childNodeId, runId: childRunId }],
            subagents: [],
            providerThreads: [],
            providerTurns: [],
            runtimeRequests: [],
            contextTransfers: [],
            messages: [],
            turnItems: [],
          }) as unknown as OrchestrationV2ThreadProjection;

        const crashDeps = Layer.mergeAll(
          NodeServices.layer,
          NodeCrypto.layer,
          Layer.mock(ThreadManagementService.ThreadManagementService)({
            hasReceipt: () => Effect.succeed(false),
            isProviderInstanceEnabledForProject: () => Effect.succeed(true),
            getThreadRecords: (tid) =>
              Effect.sync(() =>
                tid === parentThreadId
                  ? makeParentProjection({ subagents: [crashTask()] })
                  : crashChild(),
              ),
            getThreadEventSequence: () => Effect.succeed(0),
            delegatedTaskResultPending: () => Effect.succeed(false),
            streamStoredEventsFrom: (input) =>
              input?.threadId === parentThreadId && input.eventType === "subagent.updated"
                ? Stream.fromEffect(Deferred.succeed(crashSubscribed, undefined)).pipe(
                    Stream.drain,
                    Stream.concat(Stream.fromQueue(crashEvents)),
                  )
                : Stream.never,
            dispatch: () =>
              Effect.succeed({
                sequence: 1,
                storedEvents: [{ event: { type: "subagent.updated", payload: crashTask() } }],
              } as never),
          }),
          ServerSettings.layerTest({
            codingAgent: { mode: "provider", instanceId: claudeId, model: "claude-sonnet-4-6" },
          }),
          Layer.mock(ProviderRegistry.ProviderRegistry)({
            getProviders: Effect.succeed([readyPi, readyClaude]),
          }),
          makeAdapterRegistryLayer([PI_INSTANCE_ID, claudeId]),
          Layer.mock(ThreadLaunchService.ThreadLaunchService)({}),
          Layer.mock(GitVcsDriver.GitVcsDriver)({}),
          Layer.mock(ProjectService.ProjectService)({}),
          Layer.mock(SecretRequests.SecretRequests)({}),
          Layer.mock(RemoteDelegation.RemoteDelegation)({}),
          Layer.mock(ScheduledTaskService.ScheduledTaskService)({}),
        );

        yield* Effect.gen(function* () {
          const service = yield* OrchestratorMcpService.OrchestratorMcpService;
          const waiting = yield* service
            .delegateTask(makeScope(), {
              task: STRUCTURED_BRIEF_EN,
              mode: "wait",
              clientRequestId: "m1c-crash-wait",
            })
            .pipe(Effect.forkChild);
          yield* Deferred.await(crashSubscribed);
          crashed = true;
          yield* Queue.offer(crashEvents, {
            sequence: 2,
            event: {
              type: "subagent.updated",
              threadId: parentThreadId,
              payload: crashTask(),
            },
          } as unknown as OrchestrationV2StoredEvent);
          const result = yield* Fiber.join(waiting);
          expect(result.waitTimedOut).toBe(false);
          expect(result.status).toBe("failed");
          expect(result.latestTerminalStatus).toBe("failed");
          expect(result.workState).toBe("result_available");
          expect(result.summary).toContain("SIGKILL");
        }).pipe(Effect.provide(OrchestratorMcpService.layer.pipe(Layer.provide(crashDeps))));
      }),
  );

  it.effect(
    "enforces IM and group hard-deny at BOTH XtworkImMcp.imToolAllowed AND OrchestratorMcpService.delegateTask even when codingAgent.mode === 'provider'",
    () =>
      Effect.gen(function* () {
        // Defense layer 1: XtworkImMcp tool whitelist strictly excludes delegate_task.
        expect(imToolAllowed("xtwork-im-dm-owner", "delegate_task", true)).toBe(false);
        expect(imToolAllowed("xtwork-im-dm-owner", "delegate_task", false)).toBe(false);
        expect(imToolAllowed("xtwork-im-group-team", "delegate_task", true)).toBe(false);
        expect(imToolAllowed("xtwork-im-group-team", "delegate_task", false)).toBe(false);
        expect(imToolAllowed("thread:custom-protected", "delegate_task", false, true)).toBe(false);

        // Defense layer 2: OrchestratorMcpService.delegateTask hard-denies IM/group turns.
        let dispatchCount = 0;
        const readyPi = makeProvider(PI_INSTANCE_ID, "pi", "xtwork/standard");
        const readyClaude = makeProvider(claudeId, "claudeAgent", "claude-sonnet-4-6");
        const deps = Layer.mergeAll(
          NodeServices.layer,
          NodeCrypto.layer,
          Layer.mock(ThreadManagementService.ThreadManagementService)({
            hasReceipt: () => Effect.succeed(false),
            isProviderInstanceEnabledForProject: () => Effect.succeed(true),
            getThreadRecords: (tid) => Effect.succeed(makeParentProjection({ threadId: tid })),
            dispatch: () =>
              Effect.sync(() => {
                dispatchCount += 1;
                return { sequence: 1, storedEvents: [] } as never;
              }),
          }),
          ServerSettings.layerTest({
            codingAgent: { mode: "provider", instanceId: claudeId, model: "claude-sonnet-4-6" },
          }),
          Layer.mock(ProviderRegistry.ProviderRegistry)({
            getProviders: Effect.succeed([readyPi, readyClaude]),
          }),
          makeAdapterRegistryLayer([PI_INSTANCE_ID, claudeId]),
          Layer.mock(ThreadLaunchService.ThreadLaunchService)({}),
          Layer.mock(GitVcsDriver.GitVcsDriver)({}),
          Layer.mock(ProjectService.ProjectService)({}),
          Layer.mock(SecretRequests.SecretRequests)({}),
          Layer.mock(RemoteDelegation.RemoteDelegation)({}),
          Layer.mock(ScheduledTaskService.ScheduledTaskService)({}),
        );

        const groupContext: TurnExecutionContext = {
          ...desktopContext,
          source: "im",
          connectionId: "conn-wecom",
          chatId: "group-42",
          chatKind: "group",
          senderRole: "member",
          replyAudience: "group",
          companionScope: "group:42",
        };

        const protectedThreadId = ThreadId.make("thread:leader-protected-custom");
        const hook: XtworkPolicyHook = {
          isProtectedThread: (tid) => tid === protectedThreadId,
          resolveProviderPolicy: () => ({
            protected: true,
            policyDigest: "digest-1",
            failClosed: false,
            policyChanged: false,
          }),
          hasPersistedRunPolicy: () => false,
          bindRunPolicyInTxn: () => Effect.succeed(undefined as never),
          publishBoundRunPolicySync: () => {},
          recordNativeThreadPolicy: () => Effect.void,
          getProtectedContext: () => groupContext,
        };

        yield* Effect.acquireUseRelease(
          Effect.sync(() => setActiveXtworkPolicyHook(hook)),
          () =>
            Effect.gen(function* () {
              const service = yield* OrchestratorMcpService.OrchestratorMcpService;

              const imDmErr = yield* service
                .delegateTask(
                  makeScope({ threadId: ThreadId.make("xtwork-im-dm-owner-1") }),
                  { task: "Edit repo", target: { providerInstanceId: claudeId } },
                )
                .pipe(Effect.flip);
              expect(imDmErr.code).toBe(IM_DELEGATION_DENIED_CODE);
              expect(imDmErr.blocked).toBe(true);

              const groupContextErr = yield* service
                .delegateTask(
                  makeScope({
                    threadId: ThreadId.make("thread:non-prefixed-group"),
                    imExecution: {
                      turnId: "run:group-1",
                      threadId: "thread:non-prefixed-group",
                      context: groupContext,
                      inbound: { message: {} },
                    } as unknown as NonNullable<
                      McpInvocationContext.McpInvocationScope["imExecution"]
                    >,
                  }),
                  { task: "Edit repo", target: { providerInstanceId: claudeId } },
                )
                .pipe(Effect.flip);
              expect(groupContextErr.code).toBe(IM_DELEGATION_DENIED_CODE);
              expect(groupContextErr.blocked).toBe(true);

              const hookProtectedErr = yield* service
                .delegateTask(makeScope({ threadId: protectedThreadId }), {
                  task: "Edit repo",
                })
                .pipe(Effect.flip);
              expect(hookProtectedErr.code).toBe(IM_DELEGATION_DENIED_CODE);
              expect(hookProtectedErr.blocked).toBe(true);

              expect(dispatchCount).toBe(0);
            }).pipe(Effect.provide(OrchestratorMcpService.layer.pipe(Layer.provide(deps)))),
          () => Effect.sync(() => setActiveXtworkPolicyHook(undefined)),
        );
      }),
  );

  it.effect(
    "injects Coding Agent delegation instructions in ProviderTurnStartService ONLY on desktop xtworkPi turns when mode === 'provider'",
    () =>
      Effect.gen(function* () {
        const runTurnScenario = (options: {
          readonly threadId: ThreadId;
          readonly codingAgent:
            | { readonly mode: "auto" }
            | {
                readonly mode: "provider";
                readonly instanceId: ProviderInstanceId;
                readonly model?: string;
              };
        }) =>
          Effect.gen(function* () {
            const sentPrompts = yield* Ref.make<Array<string>>([]);
            const runId = RunId.make(`run:${options.threadId}`);
            const attemptId = RunAttemptId.make(`attempt:${options.threadId}`);
            const rootNodeId = NodeId.make(`node:${options.threadId}`);
            const providerThreadId = ProviderThreadId.make(`pt:${options.threadId}`);
            const providerSessionId = ProviderSessionId.make(`ps:${options.threadId}`);
            const messageId = MessageId.make(`msg:${options.threadId}`);
            const checkpointScopeId = CheckpointScopeId.make(`cp:${options.threadId}`);
            const now = DateTime.makeUnsafe("2026-11-25T08:00:00Z");

            const run = {
              id: runId,
              threadId: options.threadId,
              ordinal: 1,
              status: "starting" as const,
              rootNodeId,
              activeAttemptId: attemptId,
              providerThreadId,
              providerInstanceId: PI_INSTANCE_ID,
              userMessageId: messageId,
              modelSelection: { instanceId: PI_INSTANCE_ID, model: "xtwork/standard" },
              requestedAt: now,
              startedAt: null,
              completedAt: null,
            };
            const providerThread = {
              id: providerThreadId,
              driver: PI_DRIVER,
              providerInstanceId: PI_INSTANCE_ID,
              providerSessionId,
              appThreadId: options.threadId,
              ownerNodeId: null,
              nativeThreadRef: null,
              status: "not_loaded" as const,
              firstRunOrdinal: null,
              lastRunOrdinal: null,
              handoffIds: [],
              forkedFrom: null,
              contextUsage: null,
              createdAt: now,
              updatedAt: now,
            };
            const projection = {
              thread: {
                id: options.threadId,
                projectId,
                title: "Test thread",
                modelSelection: { instanceId: PI_INSTANCE_ID, model: "xtwork/standard" },
                runtimeMode: "full-access" as const,
                interactionMode: "default" as const,
                worktreePath: "/tmp/xtwork-scratch/scratch/2026-11-25-turn",
                branch: null,
                activeProviderThreadId: providerThreadId,
                lineage: { parentThreadId: null, relationshipToParent: null, sideChat: false },
              },
              runs: [run],
              nodes: [
                {
                  id: rootNodeId,
                  runId,
                  checkpointScopeId,
                  status: "starting",
                },
              ],
              attempts: [
                { id: attemptId, runId, providerThreadId, status: "starting", attemptOrdinal: 1 },
              ],
              providerThreads: [providerThread],
              providerSessions: [],
              providerTurns: [],
              messages: [
                {
                  id: messageId,
                  text: "Please refactor src/app.ts",
                  attachments: [],
                  createdBy: "user",
                  creationSource: "web",
                },
              ],
              checkpointScopes: [{ id: checkpointScopeId }],
              contextHandoffs: [],
              contextTransfers: [],
              turnItems: [],
              subagents: [],
              hasConversation: false,
            } as unknown as OrchestrationV2ThreadProjection;

            const fakeSession = {
              driver: PI_DRIVER,
              providerSession: {
                id: providerSessionId,
                capabilities: {
                  turns: { supportsNativeGoals: false },
                  threads: { canForkWhileSourceRunning: false },
                  checkpointing: { providerCanRollbackConversation: false },
                },
              },
              ensureThread: () => Effect.succeed(providerThread),
              startTurn: (turnInput: { readonly message: { readonly text: string } }) =>
                Ref.update(sentPrompts, (list) => [...list, turnInput.message.text]),
            };

            let currentStatus: "starting" | "running" = "starting";

            const layer = ProviderTurnStartService.layer.pipe(
              Layer.provide(
                Layer.mergeAll(
                  NodeServices.layer,
                  NodeCrypto.layer,
                  IdAllocator.layer,
                  Layer.mock(ServerConfig.ServerConfig)({
                    baseDir: "/tmp/xtwork-scratch",
                    worktreesDir: "/tmp/wt",
                  } as never),
                  ServerSettings.layerTest({
                    codingAgent: options.codingAgent,
                    providerInstances: {
                      [claudeId]: {
                        driver: ProviderDriverKind.make("claudeAgent"),
                        displayName: "Claude Code",
                        enabled: true,
                      },
                    },
                  }),
                  Layer.mock(EventSink.EventSinkV2)({
                    writeIfRunCurrent: () =>
                      Effect.sync(() => {
                        currentStatus = "running";
                        return { committed: true, sequence: 1, storedEvents: [] } as never;
                      }),
                    write: () => Effect.succeed({ sequence: 2, storedEvents: [] } as never),
                  }),
                  Layer.mock(ProviderUsageAnalytics.ProviderTurnAnalytics)({
                    runSettled: () => Effect.void,
                  }),
                  Layer.mock(ContextHandoffService.ContextHandoffServiceV2)({}),
                  Layer.mock(GitWorkflow.GitWorkflowService)({}),
                  Layer.mock(ProjectService.ProjectService)({
                    getById: () =>
                      Effect.succeedSome({
                        id: projectId,
                        title: "No project",
                        workspaceRoot: "/tmp/xtwork-scratch/scratch",
                      } as unknown as Project),
                  }),
                  Layer.mock(ManagedProjectFolders.ManagedProjectFolders)({
                    namedProjectsRoot: "/tmp/xtwork-scratch/projects",
                    scratchRoot: Effect.succeedSome("/tmp/xtwork-scratch/scratch"),
                    isScratchProject: () => Effect.succeed(true),
                  }),
                  Layer.mock(ProviderAuthService.ProviderAuthService)({}),
                  Layer.mock(ProjectionStore.ProjectionStoreV2)({
                    getThreadRecords: () => Effect.succeed(projection as never),
                    getTurnStartContext: () => Effect.succeed(projection as never),
                    getRuntimeRecoveryProjection: () => Effect.succeed(projection as never),
                    getTurnStartHistory: () => Effect.succeed([]),
                    getRun: () =>
                      Effect.sync(() => ({ ...run, status: currentStatus }) as never),
                  }),
                  Layer.mock(ProviderSessionManager.ProviderSessionManagerV2)({
                    open: () => Effect.succeed(fakeSession as never),
                    isLive: () => Effect.succeed(false),
                    get: () => Effect.succeedNone,
                  }),
                  Layer.mock(RunExecutionService.RunExecutionServiceV2)({
                    forkBaseline: () => Effect.succeed(undefined as never),
                    startRootRun: (input) =>
                      input.session
                        .startTurn({
                          appThread: input.appThread,
                          providerThread: input.providerThread,
                          message: input.message,
                          modelSelection: input.modelSelection,
                          runtimePolicy: input.runtimePolicy,
                          attemptId: input.attemptId,
                        } as never)
                        .pipe(Effect.orDie),
                  }),
                  Layer.mock(RuntimePolicy.RuntimePolicyV2)({
                    resolve: () =>
                      Effect.succeed({
                        cwd: "/tmp/xtwork-scratch/scratch/2026-11-25-turn",
                        runtimeMode: "full-access",
                        interactionMode: "default",
                      } as never),
                  }),
                  Layer.mock(TurnItemPositionStore.TurnItemPositionStoreV2)({
                    allocate: () => Effect.succeed(1),
                  }),
                ),
              ),
            );

            yield* Effect.gen(function* () {
              const turnStart = yield* ProviderTurnStartService.ProviderTurnStartServiceV2;
              yield* turnStart.start({ threadId: options.threadId, runId });
            }).pipe(Effect.provide(layer));

            return yield* Ref.get(sentPrompts);
          });

        const desktopDelegated = yield* runTurnScenario({
          threadId: ThreadId.make("thread:desktop-turn-provider"),
          codingAgent: { mode: "provider", instanceId: claudeId, model: "claude-sonnet-4-6" },
        });
        expect(desktopDelegated).toHaveLength(1);
        expect(desktopDelegated[0]).toContain("<coding_agent_delegation>");
        expect(desktopDelegated[0]).toContain('providerInstanceId: "claudeAgent"');
        expect(desktopDelegated[0]).toContain('model: "claude-sonnet-4-6"');
        expect(desktopDelegated[0]).toContain("Goal & Acceptance Criteria");
        expect(desktopDelegated[0]).toContain('isolation: "shared"');

        const desktopAuto = yield* runTurnScenario({
          threadId: ThreadId.make("thread:desktop-turn-auto"),
          codingAgent: { mode: "auto" },
        });
        expect(desktopAuto).toHaveLength(1);
        expect(desktopAuto[0]).not.toContain("<coding_agent_delegation>");

        const imTurn = yield* runTurnScenario({
          threadId: ThreadId.make("xtwork-im-group-turn-1"),
          codingAgent: { mode: "provider", instanceId: claudeId },
        });
        expect(imTurn).toHaveLength(1);
        expect(imTurn[0]).not.toContain("<coding_agent_delegation>");
      }),
  );

  it.effect(
    "blocks remote delegation bypass when xtworkPi has a configured local Coding Agent (ready or unready)",
    () =>
      Effect.gen(function* () {
        const remoteEnvId = EnvironmentId.make("env:remote-vps");
        const readyPi = makeProvider(PI_INSTANCE_ID, "pi", "xtwork/standard", {
          displayName: "小瞳",
        });
        const readyCodex = makeProvider(codexId, "codex", "gpt-5.4", { displayName: "Codex" });
        const readyClaude = makeProvider(claudeId, "claudeAgent", "claude-sonnet-4-6", {
          displayName: "Claude Code",
        });
        const uninstalledClaude = makeProvider(claudeId, "claudeAgent", "claude-sonnet-4-6", {
          displayName: "Claude Code",
          installed: false,
          status: "warning",
        });

        const runRemoteAttempt = (providers: ReadonlyArray<ServerProvider>) =>
          Effect.gen(function* () {
            let remoteCalls = 0;
            const deps = Layer.mergeAll(
              NodeServices.layer,
              NodeCrypto.layer,
              Layer.mock(ThreadManagementService.ThreadManagementService)({
                getThreadShell: () =>
                  Effect.succeed({
                    id: parentThreadId,
                    lineage: { parentThreadId: null, rootThreadId: parentThreadId },
                  } as never),
                getThreadRecords: () => Effect.succeed(makeParentProjection()),
                getMessagesById: () => Effect.succeed(new Map()),
              }),
              ServerSettings.layerTest({
                codingAgent: { mode: "provider", instanceId: claudeId, model: "claude-sonnet-4-6" },
              }),
              Layer.mock(ProviderRegistry.ProviderRegistry)({
                getProviders: Effect.succeed(providers),
              }),
              makeAdapterRegistryLayer([PI_INSTANCE_ID, claudeId, codexId]),
              Layer.mock(ThreadLaunchService.ThreadLaunchService)({}),
              Layer.mock(GitVcsDriver.GitVcsDriver)({}),
              Layer.mock(ProjectService.ProjectService)({}),
              Layer.mock(SecretRequests.SecretRequests)({}),
              Layer.mock(RemoteDelegation.RemoteDelegation)({
                delegate: () =>
                  Effect.sync(() => {
                    remoteCalls += 1;
                    return { taskId };
                  }),
              }),
              Layer.mock(ScheduledTaskService.ScheduledTaskService)({}),
            );

            const error = yield* Effect.gen(function* () {
              const service = yield* OrchestratorMcpService.OrchestratorMcpService;
              return yield* service
                .delegateTask(makeScope(), {
                  task: STRUCTURED_BRIEF_EN,
                  target: { environmentId: remoteEnvId, providerInstanceId: codexId },
                  mode: "async",
                  clientRequestId: "remote-bypass-attempt",
                })
                .pipe(Effect.flip);
            }).pipe(Effect.provide(OrchestratorMcpService.layer.pipe(Layer.provide(deps))));

            expect(remoteCalls).toBe(0);
            return error;
          });

        const readyErr = yield* runRemoteAttempt([readyPi, readyClaude, readyCodex]);
        expect(readyErr.code).toBe("invalid_request");
        expect(readyErr.blocked).toBe(true);
        expect(readyErr.instanceId).toBe(claudeId);
        expect(readyErr.message).toContain("Remote environment delegation is blocked");

        const unreadyErr = yield* runRemoteAttempt([readyPi, uninstalledClaude, readyCodex]);
        expect(unreadyErr.code).toBe(CODING_AGENT_UNAVAILABLE_CODE);
        expect(unreadyErr.blocked).toBe(true);
        expect(unreadyErr.reason).toBe("not_installed");
        expect(unreadyErr.instanceId).toBe(claudeId);
      }),
  );

  it.effect(
    "walks parentThreadId ancestry in BOTH OrchestratorMcpService and ProviderTurnStartService to hard-deny prefixless derived IM/group children",
    () =>
      Effect.gen(function* () {
        const imGroupRoot = ThreadId.make("xtwork-im-group-team-42");
        const midDerived = ThreadId.make("derived-mid-3141");
        const leafDerived = ThreadId.make("derived-subagent-9821");

        const shells = new Map<ThreadId, { readonly lineage: { readonly parentThreadId: ThreadId | null; readonly rootThreadId: ThreadId } }>([
          [leafDerived, { lineage: { parentThreadId: midDerived, rootThreadId: imGroupRoot } }],
          [midDerived, { lineage: { parentThreadId: imGroupRoot, rootThreadId: imGroupRoot } }],
          [imGroupRoot, { lineage: { parentThreadId: null, rootThreadId: imGroupRoot } }],
        ]);

        // 1. OrchestratorMcpService.delegateTask hard-denies prefixless derived child!
        let dispatchCount = 0;
        const mcpDeps = Layer.mergeAll(
          NodeServices.layer,
          NodeCrypto.layer,
          Layer.mock(ThreadManagementService.ThreadManagementService)({
            getThreadShell: (tid) => Effect.succeed((shells.get(tid) ?? null) as never),
            getThreadRecords: (tid) => Effect.succeed(makeParentProjection({ threadId: tid })),
            dispatch: () =>
              Effect.sync(() => {
                dispatchCount += 1;
                return { sequence: 1, storedEvents: [] } as never;
              }),
          }),
          ServerSettings.layerTest({
            codingAgent: { mode: "provider", instanceId: claudeId, model: "claude-sonnet-4-6" },
          }),
          Layer.mock(ProviderRegistry.ProviderRegistry)({
            getProviders: Effect.succeed([
              makeProvider(PI_INSTANCE_ID, "pi", "xtwork/standard"),
              makeProvider(claudeId, "claudeAgent", "claude-sonnet-4-6"),
            ]),
          }),
          makeAdapterRegistryLayer([PI_INSTANCE_ID, claudeId]),
          Layer.mock(ThreadLaunchService.ThreadLaunchService)({}),
          Layer.mock(GitVcsDriver.GitVcsDriver)({}),
          Layer.mock(ProjectService.ProjectService)({}),
          Layer.mock(SecretRequests.SecretRequests)({}),
          Layer.mock(RemoteDelegation.RemoteDelegation)({}),
          Layer.mock(ScheduledTaskService.ScheduledTaskService)({}),
        );

        yield* Effect.gen(function* () {
          const service = yield* OrchestratorMcpService.OrchestratorMcpService;
          const err = yield* service
            .delegateTask(makeScope({ threadId: leafDerived }), {
              task: STRUCTURED_BRIEF_EN,
              target: { providerInstanceId: claudeId },
            })
            .pipe(Effect.flip);
          expect(err.code).toBe(IM_DELEGATION_DENIED_CODE);
          expect(err.blocked).toBe(true);
          expect(dispatchCount).toBe(0);
        }).pipe(Effect.provide(OrchestratorMcpService.layer.pipe(Layer.provide(mcpDeps))));

        // 2. ProviderTurnStartService walks parentThreadId ancestry and omits delegation instructions!
        const sentPrompts = yield* Ref.make<Array<string>>([]);
        const runId = RunId.make("run:derived-im-child");
        const attemptId = RunAttemptId.make("attempt:derived-im-child");
        const rootNodeId = NodeId.make("node:derived-im-child");
        const providerThreadId = ProviderThreadId.make("pt:derived-im-child");
        const providerSessionId = ProviderSessionId.make("ps:derived-im-child");
        const messageId = MessageId.make("msg:derived-im-child");
        const checkpointScopeId = CheckpointScopeId.make("cp:derived-im-child");
        const now = DateTime.makeUnsafe("2026-11-25T08:00:00Z");

        const run = {
          id: runId,
          threadId: leafDerived,
          ordinal: 1,
          status: "starting" as const,
          rootNodeId,
          activeAttemptId: attemptId,
          providerThreadId,
          providerInstanceId: PI_INSTANCE_ID,
          userMessageId: messageId,
          modelSelection: { instanceId: PI_INSTANCE_ID, model: "xtwork/standard" },
          requestedAt: now,
          startedAt: null,
          completedAt: null,
        };
        const providerThread = {
          id: providerThreadId,
          driver: PI_DRIVER,
          providerInstanceId: PI_INSTANCE_ID,
          providerSessionId,
          appThreadId: leafDerived,
          ownerNodeId: null,
          nativeThreadRef: null,
          status: "not_loaded" as const,
          firstRunOrdinal: null,
          lastRunOrdinal: null,
          handoffIds: [],
          forkedFrom: null,
          contextUsage: null,
          createdAt: now,
          updatedAt: now,
        };
        // Note: intentionally set rootThreadId to null so the test proves parentThreadId multi-hop walk!
        const projection = {
          thread: {
            id: leafDerived,
            projectId,
            title: "Derived Subagent",
            modelSelection: { instanceId: PI_INSTANCE_ID, model: "xtwork/standard" },
            runtimeMode: "full-access" as const,
            interactionMode: "default" as const,
            worktreePath: null,
            branch: null,
            activeProviderThreadId: providerThreadId,
            lineage: {
              parentThreadId: midDerived,
              relationshipToParent: "subagent",
              sideChat: false,
            },
          },
          runs: [run],
          nodes: [{ id: rootNodeId, runId, checkpointScopeId, status: "starting" }],
          attempts: [
            { id: attemptId, runId, providerThreadId, status: "starting", attemptOrdinal: 1 },
          ],
          providerThreads: [providerThread],
          providerSessions: [],
          providerTurns: [],
          messages: [
            {
              id: messageId,
              text: "Refactor src/app.ts",
              attachments: [],
              createdBy: "user",
              creationSource: "web",
            },
          ],
          checkpointScopes: [{ id: checkpointScopeId }],
          contextHandoffs: [],
          contextTransfers: [],
          turnItems: [],
          subagents: [],
          hasConversation: false,
        } as unknown as OrchestrationV2ThreadProjection;

        let currentStatus: "starting" | "running" = "starting";
        const turnStartLayer = ProviderTurnStartService.layer.pipe(
          Layer.provide(
            Layer.mergeAll(
              NodeServices.layer,
              NodeCrypto.layer,
              IdAllocator.layer,
              Layer.mock(ServerConfig.ServerConfig)({
                baseDir: "/tmp/xtwork-ancestry-test",
                worktreesDir: "/tmp/wt",
              } as never),
              ServerSettings.layerTest({
                codingAgent: { mode: "provider", instanceId: claudeId, model: "claude-sonnet-4-6" },
              }),
              Layer.mock(EventSink.EventSinkV2)({
                writeIfRunCurrent: () =>
                  Effect.sync(() => {
                    currentStatus = "running";
                    return { committed: true, sequence: 1, storedEvents: [] } as never;
                  }),
                write: () => Effect.succeed({ sequence: 2, storedEvents: [] } as never),
              }),
              Layer.mock(ProviderUsageAnalytics.ProviderTurnAnalytics)({
                runSettled: () => Effect.void,
              }),
              Layer.mock(ContextHandoffService.ContextHandoffServiceV2)({}),
              Layer.mock(GitWorkflow.GitWorkflowService)({}),
              Layer.mock(ProjectService.ProjectService)({
                getById: () =>
                  Effect.succeedSome({
                    id: projectId,
                    title: "Repo",
                    workspaceRoot: "/tmp/repo",
                  } as unknown as Project),
              }),
              Layer.mock(ProviderAuthService.ProviderAuthService)({}),
              Layer.mock(ProjectionStore.ProjectionStoreV2)({
                getThreadShell: (tid) =>
                  Effect.succeed(
                    (tid === midDerived
                      ? { lineage: { parentThreadId: imGroupRoot } }
                      : tid === imGroupRoot
                        ? { lineage: { parentThreadId: null } }
                        : null) as never,
                  ),
                getThreadRecords: () => Effect.succeed(projection as never),
                getTurnStartContext: () => Effect.succeed(projection as never),
                getRuntimeRecoveryProjection: () => Effect.succeed(projection as never),
                getTurnStartHistory: () => Effect.succeed([]),
                getRun: () => Effect.sync(() => ({ ...run, status: currentStatus }) as never),
              }),
              Layer.mock(ProviderSessionManager.ProviderSessionManagerV2)({
                open: () =>
                  Effect.succeed({
                    driver: PI_DRIVER,
                    providerSession: {
                      id: providerSessionId,
                      capabilities: {
                        turns: { supportsNativeGoals: false },
                        threads: { canForkWhileSourceRunning: false },
                        checkpointing: { providerCanRollbackConversation: false },
                      },
                    },
                    ensureThread: () => Effect.succeed(providerThread),
                    startTurn: (turnInput: { readonly message: { readonly text: string } }) =>
                      Ref.update(sentPrompts, (list) => [...list, turnInput.message.text]),
                  } as never),
                isLive: () => Effect.succeed(false),
                get: () => Effect.succeedNone,
              }),
              Layer.mock(RunExecutionService.RunExecutionServiceV2)({
                forkBaseline: () => Effect.succeed(undefined as never),
                startRootRun: (input) =>
                  input.session
                    .startTurn({
                      appThread: input.appThread,
                      providerThread: input.providerThread,
                      message: input.message,
                      modelSelection: input.modelSelection,
                      runtimePolicy: input.runtimePolicy,
                      attemptId: input.attemptId,
                    } as never)
                    .pipe(Effect.orDie),
              }),
              Layer.mock(RuntimePolicy.RuntimePolicyV2)({
                resolve: () =>
                  Effect.succeed({
                    cwd: "/tmp/repo",
                    runtimeMode: "full-access",
                    interactionMode: "default",
                  } as never),
              }),
              Layer.mock(TurnItemPositionStore.TurnItemPositionStoreV2)({
                allocate: () => Effect.succeed(1),
              }),
            ),
          ),
        );

        yield* Effect.gen(function* () {
          const turnStart = yield* ProviderTurnStartService.ProviderTurnStartServiceV2;
          yield* turnStart.start({ threadId: leafDerived, runId });
        }).pipe(Effect.provide(turnStartLayer));

        const prompts = yield* Ref.get(sentPrompts);
        expect(prompts).toHaveLength(1);
        expect(prompts[0]).not.toContain("<coding_agent_delegation>");
      }),
  );

  it.effect(
    "enforces deterministic server-side one-turn codingAgentOverride: 'builtin_once' in ProviderTurnStartService & OrchestratorMcpService, then resumes provider mode on the next turn without mutating global settings",
    () =>
      Effect.gen(function* () {
        const turn1MsgId = MessageId.make("msg:builtin-once-turn-1");
        const turn2MsgId = MessageId.make("msg:normal-turn-2");
        const threadId = ThreadId.make("thread:builtin-once-e2e");
        const readyPi = makeProvider(PI_INSTANCE_ID, "pi", "xtwork/standard");
        const readyClaude = makeProvider(claudeId, "claudeAgent", "claude-sonnet-4-6");

        // Part A: ProviderTurnStartService omits <coding_agent_delegation> on Turn 1 (builtin_once),
        // then resumes injecting <coding_agent_delegation> on Turn 2 (normal turn).
        const runTurnPrompt = (override?: CodingAgentTurnOverride) =>
          Effect.gen(function* () {
            const sentPrompts = yield* Ref.make<Array<string>>([]);
            const runId = RunId.make(`run:override-${override ?? "none"}`);
            const attemptId = RunAttemptId.make(`attempt:override-${override ?? "none"}`);
            const rootNodeId = NodeId.make(`node:override-${override ?? "none"}`);
            const providerThreadId = ProviderThreadId.make(`pt:override-${override ?? "none"}`);
            const providerSessionId = ProviderSessionId.make(`ps:override-${override ?? "none"}`);
            const msgId = override ? turn1MsgId : turn2MsgId;
            const checkpointScopeId = CheckpointScopeId.make(`cp:override-${override ?? "none"}`);
            const now = DateTime.makeUnsafe("2026-11-25T08:00:00Z");

            const run = {
              id: runId,
              threadId,
              ordinal: override ? 1 : 2,
              status: "starting" as const,
              rootNodeId,
              activeAttemptId: attemptId,
              providerThreadId,
              providerInstanceId: PI_INSTANCE_ID,
              userMessageId: msgId,
              modelSelection: { instanceId: PI_INSTANCE_ID, model: "xtwork/standard" },
              requestedAt: now,
              startedAt: null,
              completedAt: null,
            };
            const providerThread = {
              id: providerThreadId,
              driver: PI_DRIVER,
              providerInstanceId: PI_INSTANCE_ID,
              providerSessionId,
              appThreadId: threadId,
              ownerNodeId: null,
              nativeThreadRef: null,
              status: "not_loaded" as const,
              firstRunOrdinal: null,
              lastRunOrdinal: null,
              handoffIds: [],
              forkedFrom: null,
              contextUsage: null,
              createdAt: now,
              updatedAt: now,
            };
            const projection = {
              thread: {
                id: threadId,
                projectId,
                title: "Desktop Thread",
                modelSelection: { instanceId: PI_INSTANCE_ID, model: "xtwork/standard" },
                runtimeMode: "full-access" as const,
                interactionMode: "default" as const,
                worktreePath: null,
                branch: null,
                activeProviderThreadId: providerThreadId,
                lineage: { parentThreadId: null, relationshipToParent: null, sideChat: false },
              },
              runs: [run],
              nodes: [{ id: rootNodeId, runId, checkpointScopeId, status: "starting" }],
              attempts: [
                { id: attemptId, runId, providerThreadId, status: "starting", attemptOrdinal: 1 },
              ],
              providerThreads: [providerThread],
              providerSessions: [],
              providerTurns: [],
              messages: [
                {
                  id: msgId,
                  text: "Fix src/auth.ts",
                  attachments: [],
                  createdBy: "user",
                  creationSource: "web",
                  ...(override
                    ? { context: { version: 1 as const, codingAgentOverride: override, records: [] } }
                    : {}),
                },
              ],
              checkpointScopes: [{ id: checkpointScopeId }],
              contextHandoffs: [],
              contextTransfers: [],
              turnItems: [],
              subagents: [],
              hasConversation: false,
            } as unknown as OrchestrationV2ThreadProjection;

            let currentStatus: "starting" | "running" = "starting";
            const settingsLayer = ServerSettings.layerTest({
              codingAgent: { mode: "provider", instanceId: claudeId, model: "claude-sonnet-4-6" },
            });
            const layer = ProviderTurnStartService.layer.pipe(
              Layer.provide(
                Layer.mergeAll(
                  NodeServices.layer,
                  NodeCrypto.layer,
                  IdAllocator.layer,
                  Layer.mock(ServerConfig.ServerConfig)({
                    baseDir: "/tmp/xtwork-override-test",
                    worktreesDir: "/tmp/wt",
                  } as never),
                  settingsLayer,
                  Layer.mock(EventSink.EventSinkV2)({
                    writeIfRunCurrent: () =>
                      Effect.sync(() => {
                        currentStatus = "running";
                        return { committed: true, sequence: 1, storedEvents: [] } as never;
                      }),
                    write: () => Effect.succeed({ sequence: 2, storedEvents: [] } as never),
                  }),
                  Layer.mock(ProviderUsageAnalytics.ProviderTurnAnalytics)({
                    runSettled: () => Effect.void,
                  }),
                  Layer.mock(ContextHandoffService.ContextHandoffServiceV2)({}),
                  Layer.mock(GitWorkflow.GitWorkflowService)({}),
                  Layer.mock(ProjectService.ProjectService)({
                    getById: () =>
                      Effect.succeedSome({
                        id: projectId,
                        title: "Repo",
                        workspaceRoot: "/tmp/repo",
                      } as unknown as Project),
                  }),
                  Layer.mock(ProviderAuthService.ProviderAuthService)({}),
                  Layer.mock(ProjectionStore.ProjectionStoreV2)({
                    getThreadShell: () => Effect.succeed(null),
                    getThreadRecords: () => Effect.succeed(projection as never),
                    getTurnStartContext: () => Effect.succeed(projection as never),
                    getRuntimeRecoveryProjection: () => Effect.succeed(projection as never),
                    getTurnStartHistory: () => Effect.succeed([]),
                    getRun: () => Effect.sync(() => ({ ...run, status: currentStatus }) as never),
                  }),
                  Layer.mock(ProviderSessionManager.ProviderSessionManagerV2)({
                    open: () =>
                      Effect.succeed({
                        driver: PI_DRIVER,
                        providerSession: {
                          id: providerSessionId,
                          capabilities: {
                            turns: { supportsNativeGoals: false },
                            threads: { canForkWhileSourceRunning: false },
                            checkpointing: { providerCanRollbackConversation: false },
                          },
                        },
                        ensureThread: () => Effect.succeed(providerThread),
                        startTurn: (turnInput: { readonly message: { readonly text: string } }) =>
                          Ref.update(sentPrompts, (list) => [...list, turnInput.message.text]),
                      } as never),
                    isLive: () => Effect.succeed(false),
                    get: () => Effect.succeedNone,
                  }),
                  Layer.mock(RunExecutionService.RunExecutionServiceV2)({
                    forkBaseline: () => Effect.succeed(undefined as never),
                    startRootRun: (input) =>
                      input.session
                        .startTurn({
                          appThread: input.appThread,
                          providerThread: input.providerThread,
                          message: input.message,
                          modelSelection: input.modelSelection,
                          runtimePolicy: input.runtimePolicy,
                          attemptId: input.attemptId,
                        } as never)
                        .pipe(Effect.orDie),
                  }),
                  Layer.mock(RuntimePolicy.RuntimePolicyV2)({
                    resolve: () =>
                      Effect.succeed({
                        cwd: "/tmp/repo",
                        runtimeMode: "full-access",
                        interactionMode: "default",
                      } as never),
                  }),
                  Layer.mock(TurnItemPositionStore.TurnItemPositionStoreV2)({
                    allocate: () => Effect.succeed(1),
                  }),
                ),
              ),
            );

            yield* Effect.gen(function* () {
              const turnStart = yield* ProviderTurnStartService.ProviderTurnStartServiceV2;
              yield* turnStart.start({ threadId, runId });
            }).pipe(Effect.provide(layer));

            return (yield* Ref.get(sentPrompts))[0] ?? "";
          });

        const turn1Prompt = yield* runTurnPrompt("builtin_once");
        expect(turn1Prompt).not.toContain("<coding_agent_delegation>");
        const turn2Prompt = yield* runTurnPrompt(undefined);
        expect(turn2Prompt).toContain("<coding_agent_delegation>");

        // Part B: OrchestratorMcpService rejects delegate_task on Turn 1 (builtin_once),
        // then routes normally to claudeAgent on Turn 2 while global settings.codingAgent stays unchanged!
        let activeMessageId = turn1MsgId;
        let dispatchCount = 0;
        const messagesById = new Map<MessageId, { readonly id: MessageId; readonly context?: { readonly version: 1; readonly codingAgentOverride?: CodingAgentTurnOverride; readonly records: ReadonlyArray<never> } }>([
          [
            turn1MsgId,
            {
              id: turn1MsgId,
              context: { version: 1, codingAgentOverride: "builtin_once", records: [] },
            },
          ],
          [turn2MsgId, { id: turn2MsgId }],
        ]);
        const taskRecord = {
          id: taskId,
          threadId,
          runId: parentRunId,
          parentNodeId,
          origin: "app_owned",
          providerInstanceId: claudeId,
          driver: "claudeAgent",
          childThreadId,
          model: "claude-sonnet-4-6",
          status: "running",
          result: null,
        };
        const childProjection = {
          thread: {
            id: childThreadId,
            title: "Child",
            modelSelection: { instanceId: claudeId, model: "claude-sonnet-4-6" },
            lineage: { parentThreadId: threadId, relationshipToParent: "subagent" },
          },
          runs: [{ id: childRunId, ordinal: 1, status: "running", rootNodeId: childNodeId }],
          nodes: [{ id: childNodeId, runId: childRunId }],
          subagents: [],
          providerThreads: [],
          providerTurns: [],
          runtimeRequests: [],
          contextTransfers: [],
          messages: [],
          turnItems: [],
        } as unknown as OrchestrationV2ThreadProjection;

        const settingsLayer = ServerSettings.layerTest({
          codingAgent: { mode: "provider", instanceId: claudeId, model: "claude-sonnet-4-6" },
        });
        const mcpDeps = Layer.mergeAll(
          NodeServices.layer,
          NodeCrypto.layer,
          settingsLayer,
          Layer.mock(ThreadManagementService.ThreadManagementService)({
            hasReceipt: () => Effect.succeed(false),
            isProviderInstanceEnabledForProject: () => Effect.succeed(true),
            getThreadShell: () =>
              Effect.succeed({
                id: threadId,
                lineage: { parentThreadId: null, rootThreadId: threadId },
              } as never),
            getMessagesById: (_tid, ids) =>
              Effect.sync(() => {
                const map = new Map<MessageId, unknown>();
                for (const id of ids) {
                  const found = messagesById.get(id);
                  if (found) map.set(id, found);
                }
                return map as never;
              }),
            getThreadRecords: (tid) =>
              Effect.sync(() =>
                tid === threadId
                  ? ({
                      ...makeParentProjection({ threadId, subagents: [taskRecord] }),
                      runs: [
                        {
                          id: parentRunId,
                          ordinal: activeMessageId === turn1MsgId ? 1 : 2,
                          status: "running",
                          rootNodeId: parentNodeId,
                          providerInstanceId: PI_INSTANCE_ID,
                          userMessageId: activeMessageId,
                        },
                      ],
                    } as unknown as OrchestrationV2ThreadProjection)
                  : childProjection,
              ),
            delegatedTaskResultPending: () => Effect.succeed(false),
            dispatch: () =>
              Effect.sync(() => {
                dispatchCount += 1;
                return {
                  sequence: 1,
                  storedEvents: [{ event: { type: "subagent.updated", payload: taskRecord } }],
                } as never;
              }),
          }),
          Layer.mock(ProviderRegistry.ProviderRegistry)({
            getProviders: Effect.succeed([readyPi, readyClaude]),
          }),
          makeAdapterRegistryLayer([PI_INSTANCE_ID, claudeId]),
          Layer.mock(ThreadLaunchService.ThreadLaunchService)({}),
          Layer.mock(GitVcsDriver.GitVcsDriver)({}),
          Layer.mock(ProjectService.ProjectService)({}),
          Layer.mock(SecretRequests.SecretRequests)({}),
          Layer.mock(RemoteDelegation.RemoteDelegation)({}),
          Layer.mock(ScheduledTaskService.ScheduledTaskService)({}),
        );

        yield* Effect.gen(function* () {
          const service = yield* OrchestratorMcpService.OrchestratorMcpService;
          const settingsSvc = yield* ServerSettings.ServerSettingsService;

          // Turn 1: builtin_once deterministically blocks delegate_task!
          const turn1Err = yield* service
            .delegateTask(makeScope({ threadId }), {
              task: STRUCTURED_BRIEF_EN,
              target: { providerInstanceId: claudeId },
              mode: "async",
              clientRequestId: "builtin-once-t1",
            })
            .pipe(Effect.flip);
          expect(turn1Err.code).toBe(CODING_AGENT_BUILTIN_ONCE_CODE);
          expect(turn1Err.blocked).toBe(true);
          expect(dispatchCount).toBe(0);

          // Global setting was NOT mutated!
          const currentSettings = yield* settingsSvc.getSettings;
          expect(currentSettings.codingAgent).toEqual({
            mode: "provider",
            instanceId: claudeId,
            model: "claude-sonnet-4-6",
          });

          // Turn 2: normal turn resumes deterministic delegation to claudeAgent!
          activeMessageId = turn2MsgId;
          const turn2Result = yield* service.delegateTask(makeScope({ threadId }), {
            task: STRUCTURED_BRIEF_EN,
            mode: "async",
            clientRequestId: "builtin-once-t2",
          });
          expect(turn2Result.providerInstanceId).toBe(claudeId);
          expect(dispatchCount).toBe(1);
        }).pipe(
          Effect.provide(OrchestratorMcpService.layer.pipe(Layer.provideMerge(mcpDeps))),
        );
      }),
  );

  it.effect(
    "enforces structured handoff brief sections, real versionAdvisory behind_latest, real InstallConsentStore gate, and real temp Git/non-Git/symlinked scratch workspaces",
    () =>
      Effect.gen(function* () {
        const tmpRoot = NodeFS.mkdtempSync(NodePath.join(NodeOS.tmpdir(), "xtwork-m1c-real-"));
        try {
          // 1. Real temp Git repo (valid HEAD), 0-commit unborn Git repo, non-Git folder, and symlinked scratch/!
          const gitWithHeadDir = NodePath.join(tmpRoot, "git-with-head");
          const gitUnbornDir = NodePath.join(tmpRoot, "git-unborn");
          const plainNonGitDir = NodePath.join(tmpRoot, "plain-folder");
          const realScratchRoot = NodePath.join(tmpRoot, "t3-data", "scratch");
          const symlinkToScratch = NodePath.join(tmpRoot, "project-link");

          NodeFS.mkdirSync(gitWithHeadDir, { recursive: true });
          NodeFS.mkdirSync(gitUnbornDir, { recursive: true });
          NodeFS.mkdirSync(plainNonGitDir, { recursive: true });
          NodeFS.mkdirSync(realScratchRoot, { recursive: true });
          NodeFS.symlinkSync(realScratchRoot, symlinkToScratch, "dir");

          NodeChildProcess.execFileSync("git", ["init", "-q"], { cwd: gitWithHeadDir });
          NodeChildProcess.execFileSync("git", ["config", "user.email", "test@xtwork.local"], {
            cwd: gitWithHeadDir,
          });
          NodeChildProcess.execFileSync("git", ["config", "user.name", "Xtwork Test"], {
            cwd: gitWithHeadDir,
          });
          NodeFS.writeFileSync(NodePath.join(gitWithHeadDir, "README.md"), "hello\n");
          NodeChildProcess.execFileSync("git", ["add", "README.md"], { cwd: gitWithHeadDir });
          NodeChildProcess.execFileSync("git", ["commit", "-q", "-m", "init"], {
            cwd: gitWithHeadDir,
          });
          NodeChildProcess.execFileSync("git", ["init", "-q"], { cwd: gitUnbornDir });

          // Real Git rev-parse HEAD runner backing GitVcsDriver.resolveCommit!
          const realGitResolveCommit = (cwd: string, revision: string) =>
            Effect.try({
              try: () => ({
                commitSha: NodeChildProcess.execFileSync("git", ["rev-parse", "--verify", revision], {
                  cwd,
                  encoding: "utf8",
                  stdio: ["ignore", "pipe", "pipe"],
                }).trim(),
              }),
              catch: (err) =>
                new GitCommandError({
                  operation: "rev-parse",
                  command: `git rev-parse --verify ${revision}`,
                  cwd,
                  detail: err instanceof Error ? err.message : String(err),
                }),
            });

          const projGitHead = ProjectId.make("project:real-git-head");
          const projGitUnborn = ProjectId.make("project:real-git-unborn");
          const projPlain = ProjectId.make("project:real-plain");
          const projSymlinkScratch = ProjectId.make("project:real-symlink-scratch");
          const thGitHead = ThreadId.make("thread:real-git-head");
          const thGitUnborn = ThreadId.make("thread:real-git-unborn");
          const thPlain = ThreadId.make("thread:real-plain");
          const thSymlink = ThreadId.make("thread:real-symlink");

          const projectsById = new Map<ProjectId, Project>([
            [
              projGitHead,
              { id: projGitHead, title: "Git Head Repo", workspaceRoot: gitWithHeadDir } as Project,
            ],
            [
              projGitUnborn,
              {
                id: projGitUnborn,
                title: "Git Unborn Repo",
                workspaceRoot: gitUnbornDir,
              } as Project,
            ],
            [
              projPlain,
              { id: projPlain, title: "Plain Non-Git", workspaceRoot: plainNonGitDir } as Project,
            ],
            [
              projSymlinkScratch,
              {
                id: projSymlinkScratch,
                title: "Symlinked Scratch",
                workspaceRoot: symlinkToScratch,
              } as Project,
            ],
          ]);

          const threadToProject = new Map<ThreadId, ProjectId>([
            [thGitHead, projGitHead],
            [thGitUnborn, projGitUnborn],
            [thPlain, projPlain],
            [thSymlink, projSymlinkScratch],
          ]);

          const readyPi = makeProvider(PI_INSTANCE_ID, "pi", "xtwork/standard");
          const readyClaude = makeProvider(claudeId, "claudeAgent", "claude-sonnet-4-6");
          let dispatchCount = 0;
          const makeChildProj = (tid: ThreadId) =>
            ({
              thread: {
                id: childThreadId,
                title: "Child",
                modelSelection: { instanceId: claudeId, model: "claude-sonnet-4-6" },
                lineage: { parentThreadId: tid, relationshipToParent: "subagent" },
              },
              runs: [{ id: childRunId, ordinal: 1, status: "running", rootNodeId: childNodeId }],
              nodes: [{ id: childNodeId, runId: childRunId }],
              subagents: [],
              providerThreads: [],
              providerTurns: [],
              runtimeRequests: [],
              contextTransfers: [],
              messages: [],
              turnItems: [],
            }) as unknown as OrchestrationV2ThreadProjection;

          const makeTaskRec = (tid: ThreadId) => ({
            id: taskId,
            threadId: tid,
            runId: parentRunId,
            parentNodeId,
            origin: "app_owned",
            providerInstanceId: claudeId,
            driver: "claudeAgent",
            childThreadId,
            model: "claude-sonnet-4-6",
            status: "running",
            result: null,
          });

          const realFsDeps = Layer.mergeAll(
            NodeServices.layer,
            NodeCrypto.layer,
            ServerSettings.layerTest({
              codingAgent: { mode: "provider", instanceId: claudeId, model: "claude-sonnet-4-6" },
            }),
            Layer.mock(ProviderRegistry.ProviderRegistry)({
              getProviders: Effect.succeed([readyPi, readyClaude]),
            }),
            makeAdapterRegistryLayer([PI_INSTANCE_ID, claudeId]),
            Layer.mock(ProjectService.ProjectService)({
              getById: (id) => {
                const found = projectsById.get(id);
                return found ? Effect.succeedSome(found) : Effect.succeedNone;
              },
            }),
            Layer.mock(ManagedProjectFolders.ManagedProjectFolders)({
              namedProjectsRoot: NodePath.join(tmpRoot, "projects"),
              scratchRoot: Effect.succeedSome(realScratchRoot),
              // Intentionally false for symlink project to prove realpathSync canonicalization catches it!
              isScratchProject: () => Effect.succeed(false),
            }),
            Layer.mock(GitVcsDriver.GitVcsDriver)({
              resolveCommit: ({ cwd, revision }) => realGitResolveCommit(cwd, revision),
            }),
            Layer.mock(ThreadManagementService.ThreadManagementService)({
              hasReceipt: () => Effect.succeed(false),
              isProviderInstanceEnabledForProject: () => Effect.succeed(true),
              getThreadShell: (tid) =>
                Effect.succeed({
                  id: tid,
                  lineage: { parentThreadId: null, rootThreadId: tid },
                } as never),
              getMessagesById: () => Effect.succeed(new Map()),
              getThreadRecords: (tid) =>
                Effect.sync(() =>
                  tid === childThreadId
                    ? makeChildProj(thGitHead)
                    : makeParentProjection({
                        threadId: tid,
                        projectId: threadToProject.get(tid) ?? projGitHead,
                        subagents: [makeTaskRec(tid)],
                      }),
                ),
              delegatedTaskResultPending: () => Effect.succeed(false),
              dispatch: (command) =>
                Effect.sync(() => {
                  dispatchCount += 1;
                  const parentTid =
                    command.type === "delegated_task.request" ? command.parentThreadId : thGitHead;
                  return {
                    sequence: dispatchCount,
                    storedEvents: [{ event: { type: "subagent.updated", payload: makeTaskRec(parentTid) } }],
                  } as never;
                }),
            }),
            Layer.mock(ThreadLaunchService.ThreadLaunchService)({}),
            Layer.mock(SecretRequests.SecretRequests)({}),
            Layer.mock(RemoteDelegation.RemoteDelegation)({}),
            Layer.mock(ScheduledTaskService.ScheduledTaskService)({}),
          );

          yield* Effect.gen(function* () {
            const mcp = yield* OrchestratorMcpService.OrchestratorMcpService;

            // A. Bare free-form brief MUST be rejected server-side with missing sections!
            const bareErr = yield* mcp
              .delegateTask(makeScope({ threadId: thGitHead }), {
                task: "Fix auth test failure",
                mode: "async",
                clientRequestId: "brief-bare-reject",
              })
              .pipe(Effect.flip);
            expect(bareErr.code).toBe("invalid_request");
            expect(bareErr.message).toContain("Goal & Acceptance Criteria");
            expect(bareErr.message).toContain("Constraints & Scope");
            expect(bareErr.message).toContain("File/Attachment Paths");
            expect(dispatchCount).toBe(0);

            // B. Real Git repo WITH commit allows isolation: "worktree"!
            const validWorktree = yield* mcp.delegateTask(makeScope({ threadId: thGitHead }), {
              task: STRUCTURED_BRIEF_EN,
              isolation: "worktree",
              mode: "async",
              clientRequestId: "real-git-head-wt",
            });
            expect(validWorktree.providerInstanceId).toBe(claudeId);
            expect(dispatchCount).toBe(1);

            // C. Real 0-commit unborn Git repo refuses isolation: "worktree"!
            const unbornErr = yield* mcp
              .delegateTask(makeScope({ threadId: thGitUnborn }), {
                task: STRUCTURED_BRIEF_EN,
                isolation: "worktree",
                mode: "async",
                clientRequestId: "real-git-unborn-wt",
              })
              .pipe(Effect.flip);
            expect(unbornErr.code).toBe("invalid_request");
            expect(unbornErr.message).toContain('isolation: "shared"');

            // D. Real non-Git directory refuses isolation: "worktree"!
            const plainErr = yield* mcp
              .delegateTask(makeScope({ threadId: thPlain }), {
                task: STRUCTURED_BRIEF_EN,
                isolation: "worktree",
                mode: "async",
                clientRequestId: "real-plain-wt",
              })
              .pipe(Effect.flip);
            expect(plainErr.code).toBe("invalid_request");
            expect(plainErr.message).toContain('isolation: "shared"');

            // E. Real symlinked scratch/ workspace refuses isolation: "worktree" even though isScratchProject is false!
            const symlinkErr = yield* mcp
              .delegateTask(makeScope({ threadId: thSymlink }), {
                task: STRUCTURED_BRIEF_EN,
                isolation: "worktree",
                mode: "async",
                clientRequestId: "real-symlink-scratch-wt",
              })
              .pipe(Effect.flip);
            expect(symlinkErr.code).toBe("invalid_request");
            expect(symlinkErr.message).toContain("scratch/");
            expect(symlinkErr.message).toContain('isolation: "shared"');
            expect(dispatchCount).toBe(1);
          }).pipe(Effect.provide(OrchestratorMcpService.layer.pipe(Layer.provide(realFsDeps))));

          // 2. Real InstallConsentStore + AcpInstallConsentGate + versionAdvisory behind_latest!
          const consentBaseDir = NodePath.join(tmpRoot, "consent-home");
          const consentStore = new InstallConsentStore(consentBaseDir);
          const consentKey = {
            instanceId: String(kimiId),
            source: "acp-registry",
            version: "1.0.0",
            distribution: "npx",
            installDir: NodePath.join(consentBaseDir, "acp", "kimi-code"),
            artifactSpec: "@kimi/acp@1.0.0",
          };
          const consentLayer = acpConsentGateLayer.pipe(
            Layer.provide(
              Layer.succeed(XtworkInstallConsent, makeXtworkInstallConsentService(consentBaseDir)),
            ),
          );

          // Unconsented -> AcpInstallConsentGate returns false -> provider snapshot is unprepared -> blocked not_installed!
          const hasConsentBefore = yield* Effect.gen(function* () {
            const gate = yield* AcpRegistrySupport.AcpInstallConsentGate;
            return yield* gate.hasConsent(consentKey);
          }).pipe(Effect.provide(consentLayer));
          expect(hasConsentBefore).toBe(false);

          const unconsentedProvider = makeProvider(kimiId, "acpRegistry", "default", {
            displayName: "Kimi Code",
            installed: hasConsentBefore,
            status: hasConsentBefore ? "ready" : "warning",
            message: "ACP Registry agent 'kimi-code' has not been installed on this environment.",
          });
          const unconsentedReadiness = assessCodingAgentReadiness({
            instanceId: kimiId,
            providers: [unconsentedProvider],
          });
          expect(unconsentedReadiness.ready).toBe(false);
          if (!unconsentedReadiness.ready) {
            expect(unconsentedReadiness.blocked.reason).toBe("not_installed");
            expect(unconsentedReadiness.blocked.canInstall).toBe(true);
          }

          // Grant consent for v1.0.0, then check v2.0.0 -> AcpInstallConsentGate rejects v2.0.0 -> update_required!
          consentStore.grantConsent(consentKey);
          const hasV1Consent = yield* Effect.gen(function* () {
            const gate = yield* AcpRegistrySupport.AcpInstallConsentGate;
            return yield* gate.hasConsent(consentKey);
          }).pipe(Effect.provide(consentLayer));
          const hasV2Consent = yield* Effect.gen(function* () {
            const gate = yield* AcpRegistrySupport.AcpInstallConsentGate;
            return yield* gate.hasConsent({
              ...consentKey,
              version: "2.0.0",
              artifactSpec: "@kimi/acp@2.0.0",
            });
          }).pipe(Effect.provide(consentLayer));
          expect(hasV1Consent).toBe(true);
          expect(hasV2Consent).toBe(false);

          // Provider with versionAdvisory.status === "behind_latest" blocks delegate_task with update_required BEFORE dispatch!
          const behindClaude = makeProvider(claudeId, "claudeAgent", "claude-sonnet-4-6", {
            displayName: "Claude Code",
            installed: true,
            status: "ready",
            version: "1.0.0",
            versionAdvisory: {
              status: "behind_latest",
              currentVersion: "1.0.0",
              latestVersion: "2.0.0",
              updateCommand: null,
              canUpdate: true,
              canInstallVersion: true,
              checkedAt: "2026-11-25T00:00:00.000Z",
              message: "Claude Code v2.0.0 update is available.",
            },
          });
          let behindDispatchCount = 0;
          const behindDeps = Layer.mergeAll(
            NodeServices.layer,
            NodeCrypto.layer,
            ServerSettings.layerTest({
              codingAgent: { mode: "provider", instanceId: claudeId, model: "claude-sonnet-4-6" },
            }),
            Layer.mock(ProviderRegistry.ProviderRegistry)({
              getProviders: Effect.succeed([readyPi, behindClaude]),
            }),
            makeAdapterRegistryLayer([PI_INSTANCE_ID, claudeId]),
            Layer.mock(ThreadManagementService.ThreadManagementService)({
              hasReceipt: () => Effect.succeed(false),
              isProviderInstanceEnabledForProject: () => Effect.succeed(true),
              getThreadShell: () =>
                Effect.succeed({
                  id: parentThreadId,
                  lineage: { parentThreadId: null, rootThreadId: parentThreadId },
                } as never),
              getMessagesById: () => Effect.succeed(new Map()),
              getThreadRecords: () => Effect.succeed(makeParentProjection()),
              dispatch: () =>
                Effect.sync(() => {
                  behindDispatchCount += 1;
                  return { sequence: 1, storedEvents: [] } as never;
                }),
            }),
            Layer.mock(ThreadLaunchService.ThreadLaunchService)({}),
            Layer.mock(GitVcsDriver.GitVcsDriver)({}),
            Layer.mock(ProjectService.ProjectService)({}),
            Layer.mock(SecretRequests.SecretRequests)({}),
            Layer.mock(RemoteDelegation.RemoteDelegation)({}),
            Layer.mock(ScheduledTaskService.ScheduledTaskService)({}),
          );

          yield* Effect.gen(function* () {
            const mcp = yield* OrchestratorMcpService.OrchestratorMcpService;
            const err = yield* mcp
              .delegateTask(makeScope(), {
                task: STRUCTURED_BRIEF_EN,
                mode: "async",
                clientRequestId: "version-advisory-behind",
              })
              .pipe(Effect.flip);
            expect(err.code).toBe(CODING_AGENT_UNAVAILABLE_CODE);
            expect(err.blocked).toBe(true);
            expect(err.reason).toBe("update_required");
            expect(err.canInstall).toBe(true);
            expect(err.message).toContain("2.0.0");
            expect(behindDispatchCount).toBe(0);
          }).pipe(Effect.provide(OrchestratorMcpService.layer.pipe(Layer.provide(behindDeps))));
        } finally {
          NodeFS.rmSync(tmpRoot, { recursive: true, force: true });
        }
      }),
  );

  it.effect(
    "fails closed when ServerSettings read fails, active turn override read fails, ancestor lookup fails, or ancestry depth exceeds 64 hops",
    () =>
      Effect.gen(function* () {
        const readyPi = makeProvider(PI_INSTANCE_ID, "pi", "xtwork/standard");
        const readyClaude = makeProvider(claudeId, "claudeAgent", "claude-sonnet-4-6");
        const readyCodex = makeProvider(codexId, "codex", "gpt-5.4");
        const activeMsgId = MessageId.make("msg:fail-closed-active");

        // 1. ServerSettings read failure MUST fail closed on BOTH local AND remote delegation!
        let settingsFailDispatches = 0;
        let settingsFailRemotes = 0;
        const failingSettingsErr = new ServerSettingsError({
          settingsPath: "/tmp/corrupt-settings.json",
          operation: "read-file",
          cause: "disk read error",
        });
        const failingSettingsLayer = Layer.succeed(
          ServerSettings.ServerSettingsService,
          ServerSettings.ServerSettingsService.of({
            getSettings: Effect.fail(failingSettingsErr),
            getTrustedSettings: Effect.fail(failingSettingsErr),
            updateSettings: () => Effect.die("unused"),
            streamChanges: Stream.empty,
            managedPolicy: undefined,
          } as never),
        );
        const settingsFailDeps = Layer.mergeAll(
          NodeServices.layer,
          NodeCrypto.layer,
          failingSettingsLayer,
          Layer.mock(ThreadManagementService.ThreadManagementService)({
            hasReceipt: () => Effect.succeed(false),
            isProviderInstanceEnabledForProject: () => Effect.succeed(true),
            getThreadShell: () =>
              Effect.succeed({
                id: parentThreadId,
                lineage: { parentThreadId: null, rootThreadId: parentThreadId },
              } as never),
            getMessagesById: () => Effect.succeed(new Map([[activeMsgId, { id: activeMsgId }]] as never)),
            getThreadRecords: () =>
              Effect.succeed({
                ...makeParentProjection(),
                runs: [
                  {
                    id: parentRunId,
                    ordinal: 1,
                    status: "running",
                    rootNodeId: parentNodeId,
                    providerInstanceId: PI_INSTANCE_ID,
                    userMessageId: activeMsgId,
                  },
                ],
              } as unknown as OrchestrationV2ThreadProjection),
            dispatch: () =>
              Effect.sync(() => {
                settingsFailDispatches += 1;
                return { sequence: 1, storedEvents: [] } as never;
              }),
          }),
          Layer.mock(ProviderRegistry.ProviderRegistry)({
            getProviders: Effect.succeed([readyPi, readyClaude, readyCodex]),
          }),
          makeAdapterRegistryLayer([PI_INSTANCE_ID, claudeId, codexId]),
          Layer.mock(ThreadLaunchService.ThreadLaunchService)({}),
          Layer.mock(GitVcsDriver.GitVcsDriver)({}),
          Layer.mock(ProjectService.ProjectService)({}),
          Layer.mock(SecretRequests.SecretRequests)({}),
          Layer.mock(RemoteDelegation.RemoteDelegation)({
            delegate: () =>
              Effect.sync(() => {
                settingsFailRemotes += 1;
                return { taskId };
              }),
          }),
          Layer.mock(ScheduledTaskService.ScheduledTaskService)({}),
        );

        yield* Effect.gen(function* () {
          const mcp = yield* OrchestratorMcpService.OrchestratorMcpService;
          const localErr = yield* mcp
            .delegateTask(makeScope(), {
              task: STRUCTURED_BRIEF_EN,
              target: { providerInstanceId: codexId },
              clientRequestId: "fail-closed-settings-local",
            })
            .pipe(Effect.flip);
          expect(localErr.code).toBe("orchestration_error");
          expect(localErr.blocked).toBe(true);

          const remoteErr = yield* mcp
            .delegateTask(makeScope(), {
              task: STRUCTURED_BRIEF_EN,
              target: { environmentId: EnvironmentId.make("env:remote-box"), providerInstanceId: codexId },
              clientRequestId: "fail-closed-settings-remote",
            })
            .pipe(Effect.flip);
          expect(remoteErr.code).toBe("orchestration_error");
          expect(remoteErr.blocked).toBe(true);
          expect(settingsFailDispatches).toBe(0);
          expect(settingsFailRemotes).toBe(0);
        }).pipe(Effect.provide(OrchestratorMcpService.layer.pipe(Layer.provide(settingsFailDeps))));

        // 2. Active turn/message override read failure MUST fail closed (never silently drop builtin_once)!
        let overrideFailDispatches = 0;
        const overrideFailDeps = Layer.mergeAll(
          NodeServices.layer,
          NodeCrypto.layer,
          ServerSettings.layerTest({
            codingAgent: { mode: "provider", instanceId: claudeId, model: "claude-sonnet-4-6" },
          }),
          Layer.mock(ThreadManagementService.ThreadManagementService)({
            hasReceipt: () => Effect.succeed(false),
            isProviderInstanceEnabledForProject: () => Effect.succeed(true),
            getThreadShell: () =>
              Effect.succeed({
                id: parentThreadId,
                lineage: { parentThreadId: null, rootThreadId: parentThreadId },
              } as never),
            getMessagesById: () => Effect.fail(new Error("projection store offline") as never),
            getThreadRecords: () =>
              Effect.succeed({
                ...makeParentProjection(),
                runs: [
                  {
                    id: parentRunId,
                    ordinal: 1,
                    status: "running",
                    rootNodeId: parentNodeId,
                    providerInstanceId: PI_INSTANCE_ID,
                    userMessageId: activeMsgId,
                  },
                ],
              } as unknown as OrchestrationV2ThreadProjection),
            dispatch: () =>
              Effect.sync(() => {
                overrideFailDispatches += 1;
                return { sequence: 1, storedEvents: [] } as never;
              }),
          }),
          Layer.mock(ProviderRegistry.ProviderRegistry)({
            getProviders: Effect.succeed([readyPi, readyClaude]),
          }),
          makeAdapterRegistryLayer([PI_INSTANCE_ID, claudeId]),
          Layer.mock(ThreadLaunchService.ThreadLaunchService)({}),
          Layer.mock(GitVcsDriver.GitVcsDriver)({}),
          Layer.mock(ProjectService.ProjectService)({}),
          Layer.mock(SecretRequests.SecretRequests)({}),
          Layer.mock(RemoteDelegation.RemoteDelegation)({}),
          Layer.mock(ScheduledTaskService.ScheduledTaskService)({}),
        );

        yield* Effect.gen(function* () {
          const mcp = yield* OrchestratorMcpService.OrchestratorMcpService;
          const err = yield* mcp
            .delegateTask(makeScope(), {
              task: STRUCTURED_BRIEF_EN,
              target: { providerInstanceId: claudeId },
              clientRequestId: "fail-closed-override-read",
            })
            .pipe(Effect.flip);
          expect(err.code).toBe("orchestration_error");
          expect(err.blocked).toBe(true);
          expect(err.message).toContain("codingAgentOverride");
          expect(overrideFailDispatches).toBe(0);
        }).pipe(Effect.provide(OrchestratorMcpService.layer.pipe(Layer.provide(overrideFailDeps))));

        // 3. Ancestor lookup failure AND >64-hop ancestry chain MUST fail closed in BOTH
        //    OrchestratorMcpService.delegateTask AND ProviderTurnStartService!
        const childOfFailing = ThreadId.make("thread:child-of-failing-ancestor");
        const failingAncestor = ThreadId.make("thread:unreadable-ancestor");
        const deepLeaf = ThreadId.make("thread:deep-chain-0");
        const deepParents = new Map<ThreadId, ThreadId | null>();
        for (let i = 0; i <= 70; i += 1) {
          deepParents.set(
            ThreadId.make(`thread:deep-chain-${i}`),
            i < 70 ? ThreadId.make(`thread:deep-chain-${i + 1}`) : null,
          );
        }

        let ancestryFailDispatches = 0;
        const ancestryFailMcpDeps = Layer.mergeAll(
          NodeServices.layer,
          NodeCrypto.layer,
          ServerSettings.layerTest({
            codingAgent: { mode: "provider", instanceId: claudeId, model: "claude-sonnet-4-6" },
          }),
          Layer.mock(ThreadManagementService.ThreadManagementService)({
            getThreadShell: (tid) => {
              if (tid === childOfFailing) {
                return Effect.succeed({
                  id: tid,
                  lineage: { parentThreadId: failingAncestor },
                } as never);
              }
              if (tid === failingAncestor) {
                return Effect.fail(new Error("ancestor store read failed") as never);
              }
              if (deepParents.has(tid)) {
                return Effect.succeed({
                  id: tid,
                  lineage: { parentThreadId: deepParents.get(tid) ?? null },
                } as never);
              }
              return Effect.succeed(null);
            },
            dispatch: () =>
              Effect.sync(() => {
                ancestryFailDispatches += 1;
                return { sequence: 1, storedEvents: [] } as never;
              }),
          }),
          Layer.mock(ProviderRegistry.ProviderRegistry)({
            getProviders: Effect.succeed([readyPi, readyClaude]),
          }),
          makeAdapterRegistryLayer([PI_INSTANCE_ID, claudeId]),
          Layer.mock(ThreadLaunchService.ThreadLaunchService)({}),
          Layer.mock(GitVcsDriver.GitVcsDriver)({}),
          Layer.mock(ProjectService.ProjectService)({}),
          Layer.mock(SecretRequests.SecretRequests)({}),
          Layer.mock(RemoteDelegation.RemoteDelegation)({}),
          Layer.mock(ScheduledTaskService.ScheduledTaskService)({}),
        );

        yield* Effect.gen(function* () {
          const mcp = yield* OrchestratorMcpService.OrchestratorMcpService;
          const lookupErr = yield* mcp
            .delegateTask(makeScope({ threadId: childOfFailing }), {
              task: STRUCTURED_BRIEF_EN,
              target: { providerInstanceId: claudeId },
            })
            .pipe(Effect.flip);
          expect(lookupErr.code).toBe(IM_DELEGATION_DENIED_CODE);
          expect(lookupErr.blocked).toBe(true);

          const depthErr = yield* mcp
            .delegateTask(makeScope({ threadId: deepLeaf }), {
              task: STRUCTURED_BRIEF_EN,
              target: { providerInstanceId: claudeId },
            })
            .pipe(Effect.flip);
          expect(depthErr.code).toBe(IM_DELEGATION_DENIED_CODE);
          expect(depthErr.blocked).toBe(true);
          expect(ancestryFailDispatches).toBe(0);
        }).pipe(
          Effect.provide(OrchestratorMcpService.layer.pipe(Layer.provide(ancestryFailMcpDeps))),
        );

        // ProviderTurnStartService also omits delegation instructions on ancestor lookup failure and >64 depth!
        const runTurnWithAncestry = (
          tid: ThreadId,
          parentTid: ThreadId,
          getShell: (id: ThreadId) => Effect.Effect<unknown, string>,
        ) =>
          Effect.gen(function* () {
            const sentPrompts = yield* Ref.make<Array<string>>([]);
            const runId = RunId.make(`run:${tid}`);
            const attemptId = RunAttemptId.make(`attempt:${tid}`);
            const rootNodeId = NodeId.make(`node:${tid}`);
            const providerThreadId = ProviderThreadId.make(`pt:${tid}`);
            const providerSessionId = ProviderSessionId.make(`ps:${tid}`);
            const messageId = MessageId.make(`msg:${tid}`);
            const checkpointScopeId = CheckpointScopeId.make(`cp:${tid}`);
            const now = DateTime.makeUnsafe("2026-11-25T08:00:00Z");

            const run = {
              id: runId,
              threadId: tid,
              ordinal: 1,
              status: "starting" as const,
              rootNodeId,
              activeAttemptId: attemptId,
              providerThreadId,
              providerInstanceId: PI_INSTANCE_ID,
              userMessageId: messageId,
              modelSelection: { instanceId: PI_INSTANCE_ID, model: "xtwork/standard" },
              requestedAt: now,
              startedAt: null,
              completedAt: null,
            };
            const providerThread = {
              id: providerThreadId,
              driver: PI_DRIVER,
              providerInstanceId: PI_INSTANCE_ID,
              providerSessionId,
              appThreadId: tid,
              ownerNodeId: null,
              nativeThreadRef: null,
              status: "not_loaded" as const,
              firstRunOrdinal: null,
              lastRunOrdinal: null,
              handoffIds: [],
              forkedFrom: null,
              contextUsage: null,
              createdAt: now,
              updatedAt: now,
            };
            const projection = {
              thread: {
                id: tid,
                projectId,
                title: "Derived Thread",
                modelSelection: { instanceId: PI_INSTANCE_ID, model: "xtwork/standard" },
                runtimeMode: "full-access" as const,
                interactionMode: "default" as const,
                worktreePath: null,
                branch: null,
                activeProviderThreadId: providerThreadId,
                lineage: { parentThreadId: parentTid, relationshipToParent: "subagent", sideChat: false },
              },
              runs: [run],
              nodes: [{ id: rootNodeId, runId, checkpointScopeId, status: "starting" }],
              attempts: [
                { id: attemptId, runId, providerThreadId, status: "starting", attemptOrdinal: 1 },
              ],
              providerThreads: [providerThread],
              providerSessions: [],
              providerTurns: [],
              messages: [
                {
                  id: messageId,
                  text: "Refactor src/app.ts",
                  attachments: [],
                  createdBy: "user",
                  creationSource: "web",
                },
              ],
              checkpointScopes: [{ id: checkpointScopeId }],
              contextHandoffs: [],
              contextTransfers: [],
              turnItems: [],
              subagents: [],
              hasConversation: false,
            } as unknown as OrchestrationV2ThreadProjection;

            let currentStatus: "starting" | "running" = "starting";
            const turnLayer = ProviderTurnStartService.layer.pipe(
              Layer.provide(
                Layer.mergeAll(
                  NodeServices.layer,
                  NodeCrypto.layer,
                  IdAllocator.layer,
                  Layer.mock(ServerConfig.ServerConfig)({
                    baseDir: "/tmp/xtwork-fail-closed-ancestry",
                    worktreesDir: "/tmp/wt",
                  } as never),
                  ServerSettings.layerTest({
                    codingAgent: { mode: "provider", instanceId: claudeId, model: "claude-sonnet-4-6" },
                  }),
                  Layer.mock(EventSink.EventSinkV2)({
                    writeIfRunCurrent: () =>
                      Effect.sync(() => {
                        currentStatus = "running";
                        return { committed: true, sequence: 1, storedEvents: [] } as never;
                      }),
                    write: () => Effect.succeed({ sequence: 2, storedEvents: [] } as never),
                  }),
                  Layer.mock(ProviderUsageAnalytics.ProviderTurnAnalytics)({
                    runSettled: () => Effect.void,
                  }),
                  Layer.mock(ContextHandoffService.ContextHandoffServiceV2)({}),
                  Layer.mock(GitWorkflow.GitWorkflowService)({}),
                  Layer.mock(ProjectService.ProjectService)({
                    getById: () =>
                      Effect.succeedSome({
                        id: projectId,
                        title: "Repo",
                        workspaceRoot: "/tmp/repo",
                      } as unknown as Project),
                  }),
                  Layer.mock(ProviderAuthService.ProviderAuthService)({}),
                  Layer.mock(ProjectionStore.ProjectionStoreV2)({
                    getThreadShell: (id) => getShell(id) as never,
                    getThreadRecords: () => Effect.succeed(projection as never),
                    getTurnStartContext: () => Effect.succeed(projection as never),
                    getRuntimeRecoveryProjection: () => Effect.succeed(projection as never),
                    getTurnStartHistory: () => Effect.succeed([]),
                    getRun: () => Effect.sync(() => ({ ...run, status: currentStatus }) as never),
                  }),
                  Layer.mock(ProviderSessionManager.ProviderSessionManagerV2)({
                    open: () =>
                      Effect.succeed({
                        driver: PI_DRIVER,
                        providerSession: {
                          id: providerSessionId,
                          capabilities: {
                            turns: { supportsNativeGoals: false },
                            threads: { canForkWhileSourceRunning: false },
                            checkpointing: { providerCanRollbackConversation: false },
                          },
                        },
                        ensureThread: () => Effect.succeed(providerThread),
                        startTurn: (turnInput: { readonly message: { readonly text: string } }) =>
                          Ref.update(sentPrompts, (list) => [...list, turnInput.message.text]),
                      } as never),
                    isLive: () => Effect.succeed(false),
                    get: () => Effect.succeedNone,
                  }),
                  Layer.mock(RunExecutionService.RunExecutionServiceV2)({
                    forkBaseline: () => Effect.succeed(undefined as never),
                    startRootRun: (input) =>
                      input.session
                        .startTurn({
                          appThread: input.appThread,
                          providerThread: input.providerThread,
                          message: input.message,
                          modelSelection: input.modelSelection,
                          runtimePolicy: input.runtimePolicy,
                          attemptId: input.attemptId,
                        } as never)
                        .pipe(Effect.orDie),
                  }),
                  Layer.mock(RuntimePolicy.RuntimePolicyV2)({
                    resolve: () =>
                      Effect.succeed({
                        cwd: "/tmp/repo",
                        runtimeMode: "full-access",
                        interactionMode: "default",
                      } as never),
                  }),
                  Layer.mock(TurnItemPositionStore.TurnItemPositionStoreV2)({
                    allocate: () => Effect.succeed(1),
                  }),
                ),
              ),
            );

            yield* Effect.gen(function* () {
              const turnStart = yield* ProviderTurnStartService.ProviderTurnStartServiceV2;
              yield* turnStart.start({ threadId: tid, runId });
            }).pipe(Effect.provide(turnLayer));

            return (yield* Ref.get(sentPrompts))[0] ?? "";
          });

        const promptOnLookupError = yield* runTurnWithAncestry(
          childOfFailing,
          failingAncestor,
          () => Effect.fail("shell read failed"),
        );
        expect(promptOnLookupError).not.toContain("<coding_agent_delegation>");

        const promptOnDeepChain = yield* runTurnWithAncestry(
          deepLeaf,
          ThreadId.make("thread:deep-chain-1"),
          (id) =>
            Effect.succeed(
              deepParents.has(id)
                ? { lineage: { parentThreadId: deepParents.get(id) ?? null } }
                : null,
            ),
        );
        expect(promptOnDeepChain).not.toContain("<coding_agent_delegation>");

        // 4. Sol R3 fail-closed edge cases:
        //    (a) Corrupt settings.json on disk via real ServerSettings.layer -> getTrustedSettings fails ->
        //        local AND remote delegation refuse instead of silently falling back to `auto`!
        let corruptSettingsDispatches = 0;
        let corruptSettingsRemotes = 0;
        const corruptBaseConfigLayer = Layer.fresh(
          ServerConfig.layerTest(process.cwd(), { prefix: "xtwork-corrupt-settings-" }),
        );
        const realCorruptSettingsLayer = ServerSettings.layer.pipe(
          Layer.provide(ServerSecretStore.layer),
          Layer.provide(ManagedPolicy.layerTest()),
          Layer.provide(Layer.fresh(SqlitePersistence.layerMemory)),
          Layer.provideMerge(corruptBaseConfigLayer),
          Layer.provideMerge(NodeServices.layer),
          Layer.provide(NodeCrypto.layer),
        );
        yield* Effect.gen(function* () {
          const config = yield* ServerConfig.ServerConfig;
          NodeFS.mkdirSync(NodePath.dirname(config.settingsPath), { recursive: true });
          NodeFS.writeFileSync(config.settingsPath, "{not-valid-json", "utf8");
          const settingsSvc = yield* ServerSettings.ServerSettingsService;
          // Standard getSettings returns safe defaults so server still boots...
          const fallbackDefaults = yield* settingsSvc.getSettings;
          expect(fallbackDefaults.codingAgent.mode).toBe("auto");
          // ...while getTrustedSettings fails closed so delegation cannot silently fall back to `auto`!
          const trustedErr = yield* settingsSvc.getTrustedSettings.pipe(Effect.flip);
          expect(trustedErr.operation).toBe("read-file");

          const corruptMcpDeps = Layer.mergeAll(
            NodeServices.layer,
            NodeCrypto.layer,
            Layer.succeed(ServerSettings.ServerSettingsService, settingsSvc),
            Layer.mock(ThreadManagementService.ThreadManagementService)({
              hasReceipt: () => Effect.succeed(false),
              isProviderInstanceEnabledForProject: () => Effect.succeed(true),
              getThreadShell: () =>
                Effect.succeed({
                  id: parentThreadId,
                  lineage: { parentThreadId: null, rootThreadId: parentThreadId },
                } as never),
              getMessagesById: () =>
                Effect.succeed(new Map([[activeMsgId, { id: activeMsgId }]] as never)),
              getThreadRecords: () =>
                Effect.succeed({
                  ...makeParentProjection(),
                  runs: [
                    {
                      id: parentRunId,
                      ordinal: 1,
                      status: "running",
                      rootNodeId: parentNodeId,
                      providerInstanceId: PI_INSTANCE_ID,
                      userMessageId: activeMsgId,
                    },
                  ],
                } as unknown as OrchestrationV2ThreadProjection),
              dispatch: () =>
                Effect.sync(() => {
                  corruptSettingsDispatches += 1;
                  return { sequence: 1, storedEvents: [] } as never;
                }),
            }),
            Layer.mock(ProviderRegistry.ProviderRegistry)({
              getProviders: Effect.succeed([readyPi, readyClaude, readyCodex]),
            }),
            makeAdapterRegistryLayer([PI_INSTANCE_ID, claudeId, codexId]),
            Layer.mock(ThreadLaunchService.ThreadLaunchService)({}),
            Layer.mock(GitVcsDriver.GitVcsDriver)({}),
            Layer.mock(ProjectService.ProjectService)({}),
            Layer.mock(SecretRequests.SecretRequests)({}),
            Layer.mock(RemoteDelegation.RemoteDelegation)({
              delegate: () =>
                Effect.sync(() => {
                  corruptSettingsRemotes += 1;
                  return { taskId };
                }),
            }),
            Layer.mock(ScheduledTaskService.ScheduledTaskService)({}),
          );
          yield* Effect.gen(function* () {
            const mcp = yield* OrchestratorMcpService.OrchestratorMcpService;
            const localErr = yield* mcp
              .delegateTask(makeScope(), {
                task: STRUCTURED_BRIEF_EN,
                target: { providerInstanceId: codexId },
                clientRequestId: "corrupt-settings-local",
              })
              .pipe(Effect.flip);
            expect(localErr.code).toBe("orchestration_error");
            expect(localErr.blocked).toBe(true);

            const remoteErr = yield* mcp
              .delegateTask(makeScope(), {
                task: STRUCTURED_BRIEF_EN,
                target: {
                  environmentId: EnvironmentId.make("env:remote-box"),
                  providerInstanceId: codexId,
                },
                clientRequestId: "corrupt-settings-remote",
              })
              .pipe(Effect.flip);
            expect(remoteErr.code).toBe("orchestration_error");
            expect(remoteErr.blocked).toBe(true);
            expect(corruptSettingsDispatches).toBe(0);
            expect(corruptSettingsRemotes).toBe(0);
          }).pipe(Effect.provide(OrchestratorMcpService.layer.pipe(Layer.provide(corruptMcpDeps))));
        }).pipe(Effect.provide(realCorruptSettingsLayer));

        //    (b) Referenced ancestor returning `null` (not found) MUST fail closed in BOTH
        //        OrchestratorMcpService (local + remote) AND ProviderTurnStartService!
        const childOfMissing = ThreadId.make("thread:child-of-missing-ancestor");
        const missingAncestor = ThreadId.make("thread:missing-ancestor-null");
        let missingAncestorRemotes = 0;
        const missingAncestorMcpDeps = Layer.mergeAll(
          NodeServices.layer,
          NodeCrypto.layer,
          ServerSettings.layerTest({
            codingAgent: { mode: "provider", instanceId: claudeId, model: "claude-sonnet-4-6" },
          }),
          Layer.mock(ThreadManagementService.ThreadManagementService)({
            getThreadShell: (tid) =>
              tid === childOfMissing
                ? Effect.succeed({
                    id: tid,
                    lineage: { parentThreadId: missingAncestor },
                  } as never)
                : Effect.succeed(null),
          }),
          Layer.mock(ProviderRegistry.ProviderRegistry)({
            getProviders: Effect.succeed([readyPi, readyClaude]),
          }),
          makeAdapterRegistryLayer([PI_INSTANCE_ID, claudeId]),
          Layer.mock(ThreadLaunchService.ThreadLaunchService)({}),
          Layer.mock(GitVcsDriver.GitVcsDriver)({}),
          Layer.mock(ProjectService.ProjectService)({}),
          Layer.mock(SecretRequests.SecretRequests)({}),
          Layer.mock(RemoteDelegation.RemoteDelegation)({
            delegate: () =>
              Effect.sync(() => {
                missingAncestorRemotes += 1;
                return { taskId };
              }),
          }),
          Layer.mock(ScheduledTaskService.ScheduledTaskService)({}),
        );
        yield* Effect.gen(function* () {
          const mcp = yield* OrchestratorMcpService.OrchestratorMcpService;
          const remoteErr = yield* mcp
            .delegateTask(makeScope({ threadId: childOfMissing }), {
              task: STRUCTURED_BRIEF_EN,
              target: {
                environmentId: EnvironmentId.make("env:remote-box"),
                providerInstanceId: claudeId,
              },
            })
            .pipe(Effect.flip);
          expect(remoteErr.code).toBe(IM_DELEGATION_DENIED_CODE);
          expect(remoteErr.blocked).toBe(true);
          expect(missingAncestorRemotes).toBe(0);
        }).pipe(
          Effect.provide(OrchestratorMcpService.layer.pipe(Layer.provide(missingAncestorMcpDeps))),
        );

        const promptOnMissingAncestor = yield* runTurnWithAncestry(
          childOfMissing,
          missingAncestor,
          () => Effect.succeed(null),
        );
        expect(promptOnMissingAncestor).not.toContain("<coding_agent_delegation>");

        //    (c) Active run with `userMessageId` whose `getMessagesById` returns an empty Map
        //        MUST fail closed on BOTH local AND remote delegation!
        let missingMsgRemotes = 0;
        const missingMsgMcpDeps = Layer.mergeAll(
          NodeServices.layer,
          NodeCrypto.layer,
          ServerSettings.layerTest({
            codingAgent: { mode: "provider", instanceId: claudeId, model: "claude-sonnet-4-6" },
          }),
          Layer.mock(ThreadManagementService.ThreadManagementService)({
            hasReceipt: () => Effect.succeed(false),
            isProviderInstanceEnabledForProject: () => Effect.succeed(true),
            getThreadShell: () =>
              Effect.succeed({
                id: parentThreadId,
                lineage: { parentThreadId: null, rootThreadId: parentThreadId },
              } as never),
            getMessagesById: () => Effect.succeed(new Map()),
            getThreadRecords: () =>
              Effect.succeed({
                ...makeParentProjection(),
                runs: [
                  {
                    id: parentRunId,
                    ordinal: 1,
                    status: "running",
                    rootNodeId: parentNodeId,
                    providerInstanceId: PI_INSTANCE_ID,
                    userMessageId: activeMsgId,
                  },
                ],
              } as unknown as OrchestrationV2ThreadProjection),
          }),
          Layer.mock(ProviderRegistry.ProviderRegistry)({
            getProviders: Effect.succeed([readyPi, readyClaude]),
          }),
          makeAdapterRegistryLayer([PI_INSTANCE_ID, claudeId]),
          Layer.mock(ThreadLaunchService.ThreadLaunchService)({}),
          Layer.mock(GitVcsDriver.GitVcsDriver)({}),
          Layer.mock(ProjectService.ProjectService)({}),
          Layer.mock(SecretRequests.SecretRequests)({}),
          Layer.mock(RemoteDelegation.RemoteDelegation)({
            delegate: () =>
              Effect.sync(() => {
                missingMsgRemotes += 1;
                return { taskId };
              }),
          }),
          Layer.mock(ScheduledTaskService.ScheduledTaskService)({}),
        );
        yield* Effect.gen(function* () {
          const mcp = yield* OrchestratorMcpService.OrchestratorMcpService;
          const remoteErr = yield* mcp
            .delegateTask(makeScope(), {
              task: STRUCTURED_BRIEF_EN,
              target: {
                environmentId: EnvironmentId.make("env:remote-box"),
                providerInstanceId: claudeId,
              },
            })
            .pipe(Effect.flip);
          expect(remoteErr.code).toBe("orchestration_error");
          expect(remoteErr.blocked).toBe(true);
          expect(remoteErr.message).toContain("codingAgentOverride");
          expect(missingMsgRemotes).toBe(0);
        }).pipe(Effect.provide(OrchestratorMcpService.layer.pipe(Layer.provide(missingMsgMcpDeps))));
      }),
  );
});
