import { AuthOrchestrationOperateScope, AuthOrchestrationReadScope, ProjectId, ThreadId } from "@t3tools/contracts";
import * as NodeServices from "@effect/platform-node/NodeServices";
import * as NodeSqliteClient from "@t3tools/shared/nodeSqliteClient";
import * as DateTime from "effect/DateTime";
import * as Effect from "effect/Effect";
import * as Etag from "effect/http/Etag";
import * as HttpPlatform from "effect/http/HttpPlatform";
import * as HttpRouter from "effect/http/HttpRouter";
import * as Layer from "effect/Layer";
import { describe, expect, it } from "vite-plus/test";
import { EnvironmentAuth } from "../auth/EnvironmentAuth.ts";
import type { AgentAwarenessThread } from "../orchestration-v2/ProjectionStore.ts";
import { runImTool } from "./XtworkImMcp.ts";
import {
  DEFAULT_IM_DELEGATION_POLICY,
  DEFAULT_LEADER_ID,
  ImApprovals,
  containsLeaderArchivedError,
  evaluateImDelegationPolicy,
  hashArgs,
  imError,
  normalizeExecutionContext,
  resolveProgressReportMode,
  sanitizeImDelegationPolicy,
  type Execution,
} from "./XtworkImSecurity.ts";
import { XtworkIm, makeBridgeEventHandler, makeDeliverySync, route as xtworkImRoute } from "./XtworkImService.ts";
import { makeLeaderStore } from "./XtworkLeaderStore.ts";

function makeAwarenessThread(id: string, projectId: string, title: string): AgentAwarenessThread {
  const now = DateTime.nowUnsafe();
  return {
    id: ThreadId.make(id),
    projectId: ProjectId.make(projectId),
    title,
    status: "running",
    activityRunStatus: "running",
    lineage: {
      parentThreadId: null,
      rootThreadId: ThreadId.make(id),
      relationshipToParent: null,
    },
    latestRunBackgroundWake: false,
    latestRunStopRequested: false,
    modelSelection: { instanceId: "pi-bundled", model: "xtwork/standard" } as AgentAwarenessThread["modelSelection"],
    pendingBackgroundTasks: [],
    pendingRuntimeRequest: null,
    settledOverride: null,
    updatedAt: now,
    creationSource: "web",
    latestRunCompletedAt: null,
    archivedAt: null,
    snoozedUntil: null,
    snoozedAt: null,
    pendingGuestMessageCount: 0,
    activeRunId: null,
    latestRunId: null,
    hasActionableProposedPlan: false,
  };
}

function parseEnvelopeJson<T>(raw: unknown): T {
  const match = String(raw).match(/\{[\s\S]*\}/u);
  if (!match) throw new Error(`Missing JSON payload in envelope: ${String(raw)}`);
  return JSON.parse(match[0]) as T;
}

describe("ADR-013 Slice 2: Multi-Navigator archive, connection rebinding, and IM approval policies", () => {
  it("enforces restricted-by-default IM delegation policy and hard group capability attenuation", () => {
    expect(DEFAULT_IM_DELEGATION_POLICY.ownerDm.delegationMode).toBe("always_ask");
    expect(DEFAULT_IM_DELEGATION_POLICY.ownerDm.progressReportMode).toBe("completion_and_blocked");
    expect(DEFAULT_IM_DELEGATION_POLICY.group.delegationMode).toBe("always_ask");
    expect(DEFAULT_IM_DELEGATION_POLICY.group.progressReportMode).toBe("completion_and_blocked");

    const spoofed = sanitizeImDelegationPolicy({
      ownerDm: {
        delegationMode: "scoped_auto",
        progressReportMode: "phase_summary",
        allowedProjectIds: ["proj-a", "proj-a", "", "proj-b"],
      },
      group: {
        delegationMode: "scoped_auto",
        progressReportMode: "silent",
        allowedProjectIds: ["proj-secret"],
      },
    });
    expect(spoofed.ownerDm).toEqual({
      delegationMode: "scoped_auto",
      progressReportMode: "phase_summary",
      allowedProjectIds: ["proj-a", "proj-b"],
    });
    expect(spoofed.group).toEqual({
      delegationMode: "always_ask",
      progressReportMode: "silent",
      allowedProjectIds: [],
    });

    const ownerDmCaller = normalizeExecutionContext({
      source: "im",
      leaderId: DEFAULT_LEADER_ID,
      connectionId: "conn-1",
      chatId: "dm-1",
      chatKind: "dm",
      senderRole: "owner",
      replyAudience: "owner_dm",
      isolatedWorkspaceRoot: "/tmp/ws/dm",
      companionScope: "private",
    });
    const groupCaller = normalizeExecutionContext({
      source: "im",
      leaderId: DEFAULT_LEADER_ID,
      connectionId: "conn-1",
      chatId: "grp-1",
      chatKind: "group",
      senderRole: "member",
      replyAudience: "group",
      isolatedWorkspaceRoot: "/tmp/ws/grp",
      companionScope: "group:g1",
    });

    expect(
      evaluateImDelegationPolicy({ caller: ownerDmCaller, policy: spoofed, targetProjectId: "proj-a" }).decision,
    ).toBe("allow");
    expect(
      evaluateImDelegationPolicy({ caller: ownerDmCaller, policy: spoofed, targetProjectId: "proj-other" }).decision,
    ).toBe("require_approval");
    expect(
      evaluateImDelegationPolicy({ caller: groupCaller, policy: spoofed, targetProjectId: "proj-secret" }).decision,
    ).toBe("require_approval");

    const denied = sanitizeImDelegationPolicy({
      ownerDm: { delegationMode: "deny", progressReportMode: "silent", allowedProjectIds: ["proj-a"] },
      group: { delegationMode: "deny", progressReportMode: "silent", allowedProjectIds: [] },
    });
    expect(denied.ownerDm.allowedProjectIds).toEqual([]);
    expect(
      evaluateImDelegationPolicy({ caller: ownerDmCaller, policy: denied, targetProjectId: "proj-a" }).decision,
    ).toBe("deny");
    expect(evaluateImDelegationPolicy({ caller: groupCaller, policy: denied }).decision).toBe("deny");
    expect(resolveProgressReportMode(ownerDmCaller, spoofed)).toBe("phase_summary");
    expect(resolveProgressReportMode(groupCaller, spoofed)).toBe("silent");
  });

  it("blocks cross-chat MCP calls immediately when Navigator IM policy denies delegation", async () => {
    const dbLayer = NodeSqliteClient.layer({ filename: ":memory:" });
    const signal = new AbortController().signal;
    await Effect.runPromise(
      Effect.gen(function* () {
        const leaders = yield* makeLeaderStore();
        yield* leaders.updateLeader(DEFAULT_LEADER_ID, {
          imPolicy: sanitizeImDelegationPolicy({
            ownerDm: { delegationMode: "always_ask", progressReportMode: "completion_and_blocked", allowedProjectIds: [] },
            group: { delegationMode: "deny", progressReportMode: "silent", allowedProjectIds: [] },
          }),
        });
        const approvals = new ImApprovals();
        const execution: Execution & { readonly inbound: undefined } = {
          turnId: "run-group-deny",
          threadId: "xtwork-im-group-1",
          context: normalizeExecutionContext({
            source: "im",
            leaderId: DEFAULT_LEADER_ID,
            connectionId: "conn-feishu",
            chatId: "chat-a",
            chatKind: "group",
            senderRole: "member",
            replyAudience: "group",
            isolatedWorkspaceRoot: "/tmp/ws/a",
            companionScope: "group:a",
          }),
          inbound: undefined,
        };
        const hostCalls: string[] = [];
        const fakeHost = {
          available: true,
          request: async (method: string) => {
            hostCalls.push(method);
            return {};
          },
        };
        const result = yield* Effect.tryPromise({
          try: () =>
            runImTool(
              {
                approvals,
                host: fakeHost as never,
                leaders,
                markReplySucceeded: () => undefined,
              },
              execution as never,
              "im__send",
              { chatId: "chat-b", connectionId: "conn-feishu", text: "cross-chat leak" },
              signal,
            ),
          catch: imError,
        }).pipe(Effect.result);
        expect(result._tag).toBe("Failure");
        expect(approvals.list()).toHaveLength(0);
        expect(hostCalls).toHaveLength(0);

        yield* leaders.updateLeader(DEFAULT_LEADER_ID, {
          imPolicy: sanitizeImDelegationPolicy({
            ownerDm: { delegationMode: "always_ask", progressReportMode: "completion_and_blocked", allowedProjectIds: [] },
            group: { delegationMode: "always_ask", progressReportMode: "completion_and_blocked", allowedProjectIds: [] },
          }),
        });
        for (const toolName of ["im__read", "im__search"] as const) {
          const crossGroupRead = yield* Effect.tryPromise({
            try: () =>
              runImTool(
                {
                  approvals,
                  host: fakeHost as never,
                  leaders,
                  markReplySucceeded: () => undefined,
                },
                execution as never,
                toolName,
                toolName === "im__read"
                  ? { chatId: "chat-b", connectionId: "conn-feishu" }
                  : { query: "secret", chatId: "chat-b", connectionId: "conn-feishu" },
                signal,
              ),
            catch: imError,
          }).pipe(Effect.result);
          expect(crossGroupRead._tag).toBe("Failure");
        }
        expect(approvals.list()).toHaveLength(0);
        expect(hostCalls).toHaveLength(0);

        const dmExec: Execution & { readonly inbound: undefined } = {
          turnId: "run-dm-recheck",
          threadId: "xtwork-im-dm-recheck",
          context: normalizeExecutionContext({
            source: "im",
            leaderId: DEFAULT_LEADER_ID,
            connectionId: "conn-feishu",
            chatId: "dm-owner",
            chatKind: "dm",
            senderRole: "owner",
            replyAudience: "owner_dm",
            isolatedWorkspaceRoot: "/tmp/ws/dm",
            companionScope: "private",
          }),
          inbound: undefined,
        };
        const pendingCrossSend = runImTool(
          {
            approvals,
            host: fakeHost as never,
            leaders,
            markReplySucceeded: () => undefined,
          },
          dmExec as never,
          "im__send",
          { chatId: "chat-b", connectionId: "conn-feishu", text: "after policy flip" },
          signal,
        );
        yield* Effect.sleep("15 millis");
        expect(approvals.list()).toHaveLength(1);
        const sendApprovalId = approvals.list()[0]!.id;
        yield* leaders.updateLeader(DEFAULT_LEADER_ID, {
          imPolicy: sanitizeImDelegationPolicy({
            ownerDm: { delegationMode: "deny", progressReportMode: "silent", allowedProjectIds: [] },
            group: { delegationMode: "deny", progressReportMode: "silent", allowedProjectIds: [] },
          }),
        });
        expect(
          approvals.decide(sendApprovalId, true, {
            desktopOwnerVerified: true,
            expectedRunId: "run-dm-recheck",
            expectedAudience: "owner_dm",
          }),
        ).toBe(true);
        const postDenySend = yield* Effect.tryPromise({ try: () => pendingCrossSend, catch: imError }).pipe(Effect.result);
        expect(postDenySend._tag).toBe("Failure");
        expect(hostCalls).toHaveLength(0);
      }).pipe(Effect.provide(dbLayer)),
    );
  });

  it("honors Owner DM scoped_auto in im__workspace_status without bypassing approval for unlisted folders or groups", async () => {
    const dbLayer = NodeSqliteClient.layer({ filename: ":memory:" });
    const signal = new AbortController().signal;
    const snapshotThreads = [
      makeAwarenessThread("desktop-eng-1", "proj-eng", "Eng Release"),
      makeAwarenessThread("desktop-secret-1", "proj-secret", "Secret HR"),
    ];
    await Effect.runPromise(
      Effect.gen(function* () {
        const leaders = yield* makeLeaderStore();
        yield* leaders.updateLeader(DEFAULT_LEADER_ID, {
          imPolicy: sanitizeImDelegationPolicy({
            ownerDm: {
              delegationMode: "scoped_auto",
              progressReportMode: "completion_and_blocked",
              allowedProjectIds: ["proj-eng"],
            },
            group: {
              delegationMode: "scoped_auto",
              progressReportMode: "completion_and_blocked",
              allowedProjectIds: ["proj-eng"],
            },
          }),
        });
        const approvals = new ImApprovals();
        const fakeProjection = {
          getAgentAwarenessSnapshot: () =>
            Effect.succeed({
              snapshotSequence: 7,
              threads: snapshotThreads,
            }),
        };

        const ownerDmExec: Execution & { readonly inbound: undefined } = {
          turnId: "run-dm-status",
          threadId: "xtwork-im-dm-status",
          context: normalizeExecutionContext({
            source: "im",
            leaderId: DEFAULT_LEADER_ID,
            connectionId: "conn-1",
            chatId: "dm-owner",
            chatKind: "dm",
            senderRole: "owner",
            replyAudience: "owner_dm",
            isolatedWorkspaceRoot: "/tmp/ws/dm",
            companionScope: "private",
          }),
          inbound: undefined,
        };

        const autoAllowed = yield* Effect.promise(() =>
          runImTool(
            {
              approvals,
              leaders,
              projection: fakeProjection as never,
              markReplySucceeded: () => undefined,
            },
            ownerDmExec as never,
            "im__workspace_status",
            { projectId: "proj-eng" },
            signal,
          ),
        );
        expect(approvals.list()).toHaveLength(0);
        const parsedAuto = parseEnvelopeJson<{ threads: Array<{ threadId: string; projectId: string }> }>(autoAllowed);
        expect(parsedAuto.threads.map((t) => t.threadId)).toEqual(["desktop-eng-1"]);

        const pendingUnlistedPromise = runImTool(
          {
            approvals,
            leaders,
            projection: fakeProjection as never,
            markReplySucceeded: () => undefined,
          },
          ownerDmExec as never,
          "im__workspace_status",
          { projectId: "proj-secret" },
          signal,
        );
        yield* Effect.sleep("15 millis");
        expect(approvals.list()).toHaveLength(1);
        expect(approvals.hasPendingForRun("run-dm-status")).toBe(true);
        const approvalId = approvals.list()[0]!.id;
        expect(
          approvals.decide(approvalId, true, {
            desktopOwnerVerified: true,
            expectedRunId: "run-dm-status",
            expectedAudience: "owner_dm",
          }),
        ).toBe(true);
        const afterApprove = yield* Effect.promise(() => pendingUnlistedPromise);
        const parsedApproved = parseEnvelopeJson<{ threads: Array<{ threadId: string }> }>(afterApprove);
        expect(parsedApproved.threads.map((t) => t.threadId)).toEqual(["desktop-secret-1"]);

        const groupExec: Execution & { readonly inbound: undefined } = {
          turnId: "run-grp-status",
          threadId: "xtwork-im-grp-status",
          context: normalizeExecutionContext({
            source: "im",
            leaderId: DEFAULT_LEADER_ID,
            connectionId: "conn-1",
            chatId: "grp-1",
            chatKind: "group",
            senderRole: "member",
            replyAudience: "group",
            isolatedWorkspaceRoot: "/tmp/ws/grp",
            companionScope: "group:g1",
          }),
          inbound: undefined,
        };
        const groupStatusPromise = runImTool(
          {
            approvals,
            leaders,
            projection: fakeProjection as never,
            markReplySucceeded: () => undefined,
          },
          groupExec as never,
          "im__workspace_status",
          { projectId: "proj-eng" },
          signal,
        );
        yield* Effect.sleep("15 millis");
        expect(approvals.list()).toHaveLength(1);
        const grpApprovalId = approvals.list()[0]!.id;
        approvals.decide(grpApprovalId, true, {
          desktopOwnerVerified: true,
          expectedRunId: "run-grp-status",
          expectedAudience: "group",
        });
        const grpRes = yield* Effect.promise(() => groupStatusPromise);
        const parsedGrp = parseEnvelopeJson<{ threads: Array<{ threadId: string }> }>(grpRes);
        expect(parsedGrp.threads).toEqual([]);

        const pendingStatusBeforeDeny = runImTool(
          {
            approvals,
            leaders,
            projection: fakeProjection as never,
            markReplySucceeded: () => undefined,
          },
          ownerDmExec as never,
          "im__workspace_status",
          { projectId: "proj-secret" },
          signal,
        );
        yield* Effect.sleep("15 millis");
        expect(approvals.list()).toHaveLength(1);
        const statusApprovalId = approvals.list()[0]!.id;
        yield* leaders.updateLeader(DEFAULT_LEADER_ID, {
          imPolicy: sanitizeImDelegationPolicy({
            ownerDm: { delegationMode: "deny", progressReportMode: "silent", allowedProjectIds: [] },
            group: { delegationMode: "deny", progressReportMode: "silent", allowedProjectIds: [] },
          }),
        });
        expect(
          approvals.decide(statusApprovalId, true, {
            desktopOwnerVerified: true,
            expectedRunId: "run-dm-status",
            expectedAudience: "owner_dm",
          }),
        ).toBe(true);
        const deniedAfterApproval = yield* Effect.tryPromise({
          try: () => pendingStatusBeforeDeny,
          catch: imError,
        }).pipe(Effect.result);
        expect(deniedAfterApproval._tag).toBe("Failure");

        const secondary = yield* leaders.createLeader({
          id: "leader-archive-race",
          name: "Race Nav",
          imPolicy: sanitizeImDelegationPolicy({
            ownerDm: {
              delegationMode: "scoped_auto",
              progressReportMode: "completion_and_blocked",
              allowedProjectIds: ["proj-eng"],
            },
            group: { delegationMode: "always_ask", progressReportMode: "completion_and_blocked", allowedProjectIds: [] },
          }),
        });
        let releaseSnapshot!: () => void;
        const slowProjection = {
          getAgentAwarenessSnapshot: () =>
            Effect.promise(
              () =>
                new Promise<{ snapshotSequence: number; threads: typeof snapshotThreads }>((resolve) => {
                  releaseSnapshot = () => resolve({ snapshotSequence: 8, threads: snapshotThreads });
                }),
            ),
        };
        const raceExec: Execution & { readonly inbound: undefined } = {
          turnId: "run-race-archive",
          threadId: "xtwork-im-dm-race",
          context: normalizeExecutionContext({
            source: "im",
            leaderId: secondary.id,
            connectionId: "conn-1",
            chatId: "dm-owner",
            chatKind: "dm",
            senderRole: "owner",
            replyAudience: "owner_dm",
            isolatedWorkspaceRoot: "/tmp/ws/dm",
            companionScope: "private",
          }),
          inbound: undefined,
        };
        const inflightStatus = runImTool(
          {
            approvals,
            leaders,
            projection: slowProjection as never,
            markReplySucceeded: () => undefined,
          },
          raceExec as never,
          "im__workspace_status",
          { projectId: "proj-eng" },
          signal,
        );
        yield* Effect.sleep("15 millis");
        yield* leaders.archiveLeader(secondary.id);
        releaseSnapshot();
        const afterArchiveStatus = yield* Effect.tryPromise({
          try: () => inflightStatus,
          catch: imError,
        }).pipe(Effect.result);
        expect(afterArchiveStatus._tag).toBe("Failure");
      }).pipe(Effect.provide(dbLayer)),
    );
  });

  it("enforces progressReportMode, detects running IM approvals, and preserves inbound state until final reply", async () => {
    const makeRow = (modeContext: ReturnType<typeof normalizeExecutionContext>, key: string) => ({
      key,
      threadId: "xtwork-im-dm-progress",
      contextJson: JSON.stringify(modeContext),
      payloadJson: JSON.stringify({
        connectionId: "conn-1",
        platformMsgId: key,
        chatId: "chat-1",
        chatKind: "dm",
        senderRole: "owner",
        replyAudience: "owner_dm",
        message: { messageId: `msg-${key}`, platformMsgId: key, chatId: "chat-1", chatKind: "dm" },
      }),
    });
    const ctx = normalizeExecutionContext({
      source: "im",
      leaderId: DEFAULT_LEADER_ID,
      connectionId: "conn-1",
      chatId: "chat-1",
      chatKind: "dm",
      senderRole: "owner",
      replyAudience: "owner_dm",
      isolatedWorkspaceRoot: "/tmp/ws/dm",
      companionScope: "private",
    });

    const runScenario = async (
      mode: "silent" | "completion_and_blocked" | "phase_summary",
      runStatus: "running" | "waiting",
      pendingApproval = false,
    ) => {
      const calls: Array<{ method: string; params: Record<string, unknown> }> = [];
      const host = {
        available: true,
        request: async (method: string, params: Record<string, unknown> = {}) => {
          calls.push({ method, params });
          if (method === "inbound.ack") return { message: { state: "delivered" } };
          if (method === "messages.liveStart") return { supported: true, liveId: "live-1" };
          return { result: { kind: "sent" } };
        },
      };
      const row = makeRow(ctx, `k-${mode}-${runStatus}-${pendingApproval}`);
      const userMessageId = `xtwork-im:${hashArgs(`im:conn-1:${row.key}`)}`;
      const fakeDispatch = {
        orchestrator: {
          getThreadRecords: () =>
            Effect.succeed({
              runs: [{ id: "run-1", status: runStatus, userMessageId }],
              messages: [{ runId: "run-1", role: "assistant", text: "Working on step 1" }],
            }),
        },
        settle: () => Effect.void,
      };
      const { sync } = makeDeliverySync(
        host,
        fakeDispatch as never,
        () => false,
        () => mode,
        (runId) => pendingApproval && runId === "run-1",
      );
      await Effect.runPromise(sync(row));
      return calls;
    };

    expect((await runScenario("phase_summary", "running")).map((c) => c.method)).toContain("messages.liveStart");
    expect((await runScenario("completion_and_blocked", "running", false)).map((c) => c.method)).not.toContain("messages.liveStart");
    expect((await runScenario("completion_and_blocked", "running", false)).map((c) => c.method)).not.toContain("messages.send");

    const waitingCalls = await runScenario("completion_and_blocked", "waiting", false);
    const waitingSend = waitingCalls.find((c) => c.method === "messages.send");
    expect(waitingSend?.params.preserveInboundState).toBe(true);
    expect(waitingCalls.map((c) => c.method)).not.toContain("messages.reply");

    const runningApprovalCalls = await runScenario("completion_and_blocked", "running", true);
    const approvalSend = runningApprovalCalls.find((c) => c.method === "messages.send");
    expect(approvalSend?.params.preserveInboundState).toBe(true);

    expect((await runScenario("silent", "waiting")).map((c) => c.method)).not.toContain("messages.send");
    expect((await runScenario("silent", "running")).map((c) => c.method)).not.toContain("messages.liveStart");

    let inboundState = "delivered";
    let runStatus: "running" | "completed" = "running";
    let settledLocal = false;
    const lifecycleCalls: Array<{ method: string; params: Record<string, unknown> }> = [];
    const lifecycleHost = {
      available: true,
      request: async (method: string, params: Record<string, unknown> = {}) => {
        lifecycleCalls.push({ method, params });
        if (method === "inbound.ack") return { message: { state: inboundState } };
        if (method === "messages.send") {
          if (params.preserveInboundState !== true) inboundState = "replied";
          return { result: { kind: "sent" } };
        }
        if (method === "messages.reply") {
          inboundState = "replied";
          return { result: { kind: "sent" } };
        }
        if (method === "inbound.settle") {
          inboundState = "replied";
          return { moved: true, message: { state: "replied" } };
        }
        return {};
      },
    };
    const row = makeRow(ctx, "k-lifecycle-1");
    const userMessageId = `xtwork-im:${hashArgs(`im:conn-1:${row.key}`)}`;
    const lifecycleDispatch = {
      orchestrator: {
        getThreadRecords: () =>
          Effect.succeed({
            runs: [{ id: "run-life", status: runStatus, userMessageId }],
            messages: [{ runId: "run-life", role: "assistant", text: "Final answer delivered" }],
          }),
      },
      settle: () =>
        Effect.sync(() => {
          settledLocal = true;
        }),
    };
    const { sync, clearCaches } = makeDeliverySync(
      lifecycleHost,
      lifecycleDispatch as never,
      () => false,
      () => "completion_and_blocked",
      (runId) => runStatus === "running" && runId === "run-life",
    );
    await Effect.runPromise(sync(row));
    expect(inboundState).toBe("delivered");
    expect(lifecycleCalls.some((c) => c.method === "messages.send" && c.params.preserveInboundState === true)).toBe(true);

    clearCaches();
    runStatus = "completed";
    await Effect.runPromise(sync(row));
    expect(lifecycleCalls.some((c) => c.method === "messages.reply" && c.params.text === "Final answer delivered")).toBe(true);
    expect(settledLocal).toBe(true);
  });

  it("supports HTTP multi-Navigator lifecycle, paused-queue archive protection, archived immutability, and syncPending recovery", async () => {
    const dbLayer = NodeSqliteClient.layer({ filename: ":memory:" });
    const bridgeCalls: Array<{ method: string; params: Record<string, unknown> }> = [];
    const orchestratorDispatches: Array<Record<string, unknown>> = [];
    const roleWrites: Array<{ scope: string; text: string; leaderId?: string }> = [];
    let syncMode: "ok" | "throw" | "empty" | "stale_epoch" = "ok";
    let bridgeLeaderId = DEFAULT_LEADER_ID;
    let bridgeBindingId = "";
    let bridgeBindingEpoch = 0;
    let pausedQueueByLeader: Record<string, Array<{ id: string }>> = {};
    let heldCountByLeader: Record<string, number> = {};

    const fakeHost: {
      available: boolean;
      request: (method: string, params?: Record<string, unknown>) => Promise<Record<string, unknown>>;
    } = {
      available: true,
      request: async (method: string, params: Record<string, unknown> = {}): Promise<Record<string, unknown>> => {
        bridgeCalls.push({ method, params });
        if (method === "connections.list") {
          return {
            connections: [
              {
                id: "conn-feishu-1",
                platform: "feishu",
                lifecycleState: "active",
                state: "connected",
                leaderId: bridgeLeaderId,
                bindingId: bridgeBindingId,
                bindingEpoch: bridgeBindingEpoch,
              },
            ],
          };
        }
        if (method === "connections.syncBindings") {
          if (syncMode === "throw") {
            throw new Error("bridge temporarily offline");
          }
          if (syncMode === "empty") {
            return { synced: 0, connections: [] };
          }
          if (syncMode === "stale_epoch") {
            return {
              synced: 1,
              connections: [
                {
                  id: "conn-feishu-1",
                  platform: "feishu",
                  lifecycleState: "active",
                  state: "connected",
                  leaderId: bridgeLeaderId,
                  bindingId: bridgeBindingId,
                  bindingEpoch: bridgeBindingEpoch,
                },
              ],
            };
          }
          const bindings = Array.isArray(params.bindings)
            ? (params.bindings as Array<{ connectionId: string; leaderId: string; bindingId: string; bindingEpoch: number }>)
            : [];
          const hit = bindings.find((b) => b.connectionId === "conn-feishu-1");
          if (hit) {
            bridgeLeaderId = hit.leaderId;
            bridgeBindingId = hit.bindingId;
            bridgeBindingEpoch = hit.bindingEpoch;
          }
          return {
            synced: hit ? 1 : 0,
            connections: hit
              ? [
                  {
                    id: "conn-feishu-1",
                    platform: "feishu",
                    lifecycleState: "active",
                    state: "connected",
                    leaderId: bridgeLeaderId,
                    bindingId: bridgeBindingId,
                    bindingEpoch: bridgeBindingEpoch,
                  },
                ]
              : [],
          };
        }
        if (method === "paused.list") {
          const leaderId = typeof params.leaderId === "string" ? params.leaderId : "";
          return { items: pausedQueueByLeader[leaderId] ?? [], heldCount: heldCountByLeader[leaderId] ?? 0 };
        }
        return { ok: true };
      },
    };
    const fakeMemory = {
      read: async () => "current role",
      write: async (scope: string, text: string, _note?: string, leaderId?: string) => {
        roleWrites.push({ scope, text, ...(leaderId ? { leaderId } : {}) });
      },
    };
    const fakeOrchestrator = {
      dispatch: (command: Record<string, unknown>) => {
        orchestratorDispatches.push(command);
        return Effect.succeed({ storedEvents: [] });
      },
      getThreadShell: () => Effect.succeed(null),
    };

    const testAuthLayer = Layer.succeed(EnvironmentAuth, {
      authenticateHttpRequest: () =>
        Effect.succeed({
          subject: "desktop-bootstrap",
          scopes: [AuthOrchestrationReadScope, AuthOrchestrationOperateScope],
        }),
    } as never);

    await Effect.runPromise(
      Effect.gen(function* () {
        const leaders = yield* makeLeaderStore();
        const approvals = new ImApprovals();
        const pendingBindingSyncs = new Map<string, string>();
        const serviceLayer = Layer.succeed(XtworkIm, {
          host: fakeHost as never,
          leaders,
          memory: fakeMemory as never,
          orchestrator: fakeOrchestrator as never,
          approvals,
          pendingBindingSyncs,
          markReplySucceeded: () => undefined,
          hasReplySucceeded: () => false,
          eventsSince: () => [],
        });

        const fullLayer = Layer.mergeAll(
          xtworkImRoute.pipe(Layer.provide(Layer.mergeAll(serviceLayer, testAuthLayer))),
          testAuthLayer,
          HttpPlatform.layer.pipe(Layer.provide(NodeServices.layer)),
          Etag.layerWeak,
          NodeServices.layer,
        );
        const { handler, dispose } = HttpRouter.toWebHandler(fullLayer as never);
        const api = (method: "GET" | "POST", path: string, body?: unknown) =>
          Effect.promise(async () => {
            const res = await handler(
              new Request(`http://localhost/api/xtwork/im/${path}`, {
                method,
                headers: {
                  Authorization: "Bearer test-token",
                  ...(body !== undefined ? { "Content-Type": "application/json" } : {}),
                },
                ...(body !== undefined ? { body: JSON.stringify(body) } : {}),
              }),
            );
            return { status: res.status, json: (await res.json()) as Record<string, unknown> };
          });

        try {
          const created = yield* api("POST", "leaders", {
            name: "研发领航者",
            avatar: "研",
            role: "专注工程交付",
            imPolicy: {
              ownerDm: { delegationMode: "scoped_auto", progressReportMode: "phase_summary", allowedProjectIds: ["proj-eng"] },
              group: { delegationMode: "scoped_auto", progressReportMode: "silent", allowedProjectIds: ["proj-leak"] },
            },
          });
          expect(created.status).toBe(200);
          const engLeader = created.json.leader as { id: string; imPolicy: { ownerDm: { delegationMode: string; allowedProjectIds: string[] }; group: { delegationMode: string; allowedProjectIds: string[] } } };
          expect(engLeader.imPolicy.ownerDm.delegationMode).toBe("scoped_auto");
          expect(engLeader.imPolicy.ownerDm.allowedProjectIds).toEqual(["proj-eng"]);
          expect(engLeader.imPolicy.group.delegationMode).toBe("always_ask");
          expect(engLeader.imPolicy.group.allowedProjectIds).toEqual([]);

          const connsBefore = yield* api("GET", "connections");
          expect(connsBefore.status).toBe(200);
          const listBefore = connsBefore.json.connections as Array<{ id: string; leaderId: string; bindingId: string; bindingEpoch: number; syncPending?: boolean }>;
          expect(listBefore[0]?.leaderId).toBe(DEFAULT_LEADER_ID);
          expect(listBefore[0]?.bindingEpoch).toBe(1);
          expect(listBefore[0]?.syncPending).toBe(false);
          const initialBindingId = listBefore[0]!.bindingId;

          syncMode = "empty";
          const reboundEmpty = yield* api("POST", "connections/rebind", {
            connectionId: "conn-feishu-1",
            leaderId: engLeader.id,
          });
          expect(reboundEmpty.status).toBe(200);
          expect(reboundEmpty.json.syncPending).toBe(true);
          expect(pendingBindingSyncs.has("conn-feishu-1")).toBe(true);
          const engBindingId = (reboundEmpty.json.binding as { bindingId: string }).bindingId;

          syncMode = "stale_epoch";
          const connsStillPending = yield* api("GET", "connections");
          const listPending = connsStillPending.json.connections as Array<{
            id: string;
            leaderId: string;
            bindingId: string;
            bindingEpoch: number;
            desiredLeaderId?: string;
            desiredBindingId?: string;
            desiredBindingEpoch?: number;
            syncPending?: boolean;
          }>;
          expect(listPending[0]?.syncPending).toBe(true);
          expect(listPending[0]?.leaderId).toBe(DEFAULT_LEADER_ID);
          expect(listPending[0]?.bindingId).toBe(initialBindingId);
          expect(listPending[0]?.bindingEpoch).toBe(1);
          expect(listPending[0]?.desiredLeaderId).toBe(engLeader.id);
          expect(listPending[0]?.desiredBindingId).toBe(engBindingId);
          expect(listPending[0]?.desiredBindingEpoch).toBe(2);

          const overviewPending = yield* api("GET", `leaders/${engLeader.id}/overview`);
          const ovPendingConns = overviewPending.json.connections as Array<{
            leaderId: string;
            bindingEpoch: number;
            desiredLeaderId?: string;
            syncPending?: boolean;
          }>;
          expect(ovPendingConns[0]?.syncPending).toBe(true);
          expect(ovPendingConns[0]?.leaderId).toBe(DEFAULT_LEADER_ID);
          expect(ovPendingConns[0]?.bindingEpoch).toBe(1);
          expect(ovPendingConns[0]?.desiredLeaderId).toBe(engLeader.id);

          syncMode = "ok";
          const overviewRecovered = yield* api("GET", `leaders/${engLeader.id}/overview`);
          const ovRecoveredConns = overviewRecovered.json.connections as Array<{
            leaderId: string;
            bindingId: string;
            bindingEpoch: number;
            syncPending?: boolean;
          }>;
          expect(ovRecoveredConns[0]?.syncPending).toBe(false);
          expect(ovRecoveredConns[0]?.leaderId).toBe(engLeader.id);
          expect(ovRecoveredConns[0]?.bindingId).toBe(engBindingId);
          expect(ovRecoveredConns[0]?.bindingEpoch).toBe(2);
          expect(pendingBindingSyncs.has("conn-feishu-1")).toBe(false);

          yield* leaders.updateLeader(engLeader.id, { pinnedThreadId: ThreadId.make(`xtwork-leader-${engLeader.id}-01`) });
          const renamed = yield* api("POST", `leaders/${engLeader.id}/update`, { name: "工程总监" });
          expect(renamed.status).toBe(200);
          expect(
            orchestratorDispatches.some(
              (cmd) =>
                cmd.type === "thread.metadata.update" &&
                cmd.threadId === `xtwork-leader-${engLeader.id}-01` &&
                cmd.title === "工程总监",
            ),
          ).toBe(true);

          const archiveDefault = yield* api("POST", `leaders/${DEFAULT_LEADER_ID}/archive`, {});
          expect(archiveDefault.status).toBe(400);

          yield* api("POST", `leaders/${engLeader.id}/pause`, {});
          yield* api("POST", `leaders/${engLeader.id}/resume`, {});
          fakeHost.available = false;
          const archiveOfflineAfterResume = yield* api("POST", `leaders/${engLeader.id}/archive`, {
            rebindToLeaderId: DEFAULT_LEADER_ID,
          });
          expect(archiveOfflineAfterResume.status).toBe(503);
          fakeHost.available = true;

          pausedQueueByLeader = { [engLeader.id]: [{ id: "paused-msg-1" }] };
          const archiveBlockedByPaused = yield* api("POST", `leaders/${engLeader.id}/archive`, {
            rebindToLeaderId: DEFAULT_LEADER_ID,
          });
          expect(archiveBlockedByPaused.status).toBe(409);
          pausedQueueByLeader = {};

          heldCountByLeader = { [engLeader.id]: 1 };
          const archiveBlockedByHeld = yield* api("POST", `leaders/${engLeader.id}/archive`, {
            rebindToLeaderId: DEFAULT_LEADER_ID,
          });
          expect(archiveBlockedByHeld.status).toBe(409);
          heldCountByLeader = {};

          const origRequest = fakeHost.request;
          fakeHost.request = async (method: string, params: Record<string, unknown> = {}) => {
            if (method === "paused.list") return {};
            return origRequest(method, params);
          };
          const archiveMalformedQueue = yield* api("POST", `leaders/${engLeader.id}/archive`, {
            rebindToLeaderId: DEFAULT_LEADER_ID,
          });
          expect(archiveMalformedQueue.status).toBe(503);

          fakeHost.request = async (method: string, params: Record<string, unknown> = {}) => {
            if (method === "paused.list") return { items: [] };
            return origRequest(method, params);
          };
          const archiveMissingHeldCount = yield* api("POST", `leaders/${engLeader.id}/archive`, {
            rebindToLeaderId: DEFAULT_LEADER_ID,
          });
          expect(archiveMissingHeldCount.status).toBe(503);
          fakeHost.request = origRequest;

          const archiveBlockedByBindings = yield* api("POST", `leaders/${engLeader.id}/archive`, {});
          expect(archiveBlockedByBindings.status).toBe(409);

          syncMode = "empty";
          const archiveSyncUnconfirmed = yield* api("POST", `leaders/${engLeader.id}/archive`, {
            rebindToLeaderId: DEFAULT_LEADER_ID,
          });
          expect(archiveSyncUnconfirmed.status).toBe(503);
          const stillUnarchived = yield* leaders.getLeader(engLeader.id);
          expect(stillUnarchived?.status).not.toBe("archived");
          syncMode = "ok";

          const rebindBack = yield* api("POST", "connections/rebind", {
            connectionId: "conn-feishu-1",
            leaderId: engLeader.id,
          });
          expect(rebindBack.status).toBe(200);
          expect(rebindBack.json.syncPending).toBe(false);

          let pausedCheckCount = 0;
          fakeHost.request = async (method: string, params: Record<string, unknown> = {}) => {
            if (method === "paused.list") {
              pausedCheckCount += 1;
              if (pausedCheckCount === 2) {
                return { items: [{ id: "raced-paused-msg" }], heldCount: 0 };
              }
              return { items: [], heldCount: 0 };
            }
            return origRequest(method, params);
          };
          const archiveCaughtRaceQueue = yield* api("POST", `leaders/${engLeader.id}/archive`, {
            rebindToLeaderId: DEFAULT_LEADER_ID,
          });
          expect(archiveCaughtRaceQueue.status).toBe(409);
          expect((yield* leaders.getLeader(engLeader.id))?.status).not.toBe("archived");
          fakeHost.request = origRequest;

          const rebindForFinalArchive = yield* api("POST", "connections/rebind", {
            connectionId: "conn-feishu-1",
            leaderId: engLeader.id,
          });
          expect(rebindForFinalArchive.status).toBe(200);

          const archiveOk = yield* api("POST", `leaders/${engLeader.id}/archive`, {
            rebindToLeaderId: DEFAULT_LEADER_ID,
          });
          expect(archiveOk.status).toBe(200);
          expect(archiveOk.json.syncPending).toBe(false);
          const reboundBindings = archiveOk.json.reboundBindings as Array<{ leaderId: string; epoch: number }>;
          expect(reboundBindings).toHaveLength(1);
          expect(reboundBindings[0]?.leaderId).toBe(DEFAULT_LEADER_ID);
          expect(reboundBindings[0]?.epoch).toBe(7);

          const handlerCalls: Array<{ method: string; params: Record<string, unknown> }> = [];
          const handlerHost = {
            available: true,
            request: async (method: string, params: Record<string, unknown> = {}) => {
              handlerCalls.push({ method, params });
              return { ok: true };
            },
          };
          const archivedDispatchHandler = makeBridgeEventHandler(
            handlerHost,
            {
              accept: () => Effect.fail(imError("LEADER_ARCHIVED: Navigator is archived; new IM tasks are rejected.")),
              firstContext: () => Effect.undefined,
              stop: () => Effect.void,
            } as never,
            leaders,
          );
          yield* archivedDispatchHandler({
            sequence: 1,
            event: "inbound.dispatch",
            payload: {
              connectionId: "conn-feishu-1",
              idempotencyKey: "im:conn-feishu-1:late-archived",
              leaderId: engLeader.id,
            },
          });
          expect(
            handlerCalls.some(
              (c) =>
                c.method === "inbound.settle" &&
                c.params.idempotencyKey === "im:conn-feishu-1:late-archived" &&
                c.params.event === "fail",
            ),
          ).toBe(true);
          expect(handlerCalls.some((c) => c.method === "connections.syncBindings")).toBe(true);

          const thirdLeaderRes = yield* api("POST", "leaders", { name: "并发测试领航者" });
          const thirdId = (thirdLeaderRes.json.leader as { id: string }).id;
          let releaseSlowSync!: () => void;
          let interceptFirstSync = true;
          fakeHost.request = async (method: string, params: Record<string, unknown> = {}) => {
            if (method === "connections.syncBindings" && interceptFirstSync) {
              interceptFirstSync = false;
              await new Promise<void>((resolve) => {
                releaseSlowSync = resolve;
              });
              throw new Error("stale slow sync failed");
            }
            return origRequest(method, params);
          };
          const slowRebindPromise = handler(
            new Request("http://localhost/api/xtwork/im/connections/rebind", {
              method: "POST",
              headers: { Authorization: "Bearer test-token", "Content-Type": "application/json" },
              body: JSON.stringify({ connectionId: "conn-feishu-1", leaderId: thirdId }),
            }),
          );
          yield* Effect.sleep("15 millis");
          let holdGetLeaderOnce = false;
          let releaseGetLeader!: () => void;
          const origGetLeader = leaders.getLeader;
          const origActiveBinding = leaders.activeBindingForConnection;
          let getLeaderCallsAfterRebind = 0;
          let failActiveBindingCheck = false;
          const mutableLeaders = leaders as {
            getLeader: typeof leaders.getLeader;
            activeBindingForConnection: typeof leaders.activeBindingForConnection;
          };
          mutableLeaders.getLeader = (id: string) => {
            if (holdGetLeaderOnce && id === DEFAULT_LEADER_ID) {
              getLeaderCallsAfterRebind += 1;
              if (getLeaderCallsAfterRebind === 2) {
                holdGetLeaderOnce = false;
                return Effect.promise(
                  () =>
                    new Promise<void>((resolve) => {
                      releaseGetLeader = resolve;
                    }),
                ).pipe(Effect.flatMap(() => origGetLeader(id)));
              }
            }
            return origGetLeader(id);
          };
          mutableLeaders.activeBindingForConnection = (connId: string) =>
            failActiveBindingCheck ? Effect.fail(imError("db read glitch")) : origActiveBinding(connId);

          holdGetLeaderOnce = true;
          const fastRebindPromise = handler(
            new Request("http://localhost/api/xtwork/im/connections/rebind", {
              method: "POST",
              headers: { Authorization: "Bearer test-token", "Content-Type": "application/json" },
              body: JSON.stringify({ connectionId: "conn-feishu-1", leaderId: DEFAULT_LEADER_ID }),
            }),
          );
          yield* Effect.sleep("15 millis");
          failActiveBindingCheck = true;
          releaseSlowSync();
          yield* Effect.promise(() => slowRebindPromise);
          expect(pendingBindingSyncs.has("conn-feishu-1")).toBe(false);
          failActiveBindingCheck = false;
          releaseGetLeader();
          const fastRebindRes = yield* Effect.promise(() => fastRebindPromise);
          expect(fastRebindRes.status).toBe(200);
          expect(pendingBindingSyncs.has("conn-feishu-1")).toBe(false);
          mutableLeaders.getLeader = origGetLeader;
          mutableLeaders.activeBindingForConnection = origActiveBinding;
          fakeHost.request = origRequest;

          syncMode = "empty";
          const archiveWhileBridgeUnsynced = yield* api("POST", `leaders/${thirdId}/archive`, {});
          expect(archiveWhileBridgeUnsynced.status).toBe(503);
          expect((yield* leaders.getLeader(thirdId))?.status).toBe("active");
          syncMode = "ok";

          let holdRoleWrite = false;
          let releaseRoleWrite!: () => void;
          const origMemWrite = fakeMemory.write;
          fakeMemory.write = async (scope: string, text: string, note?: string, lId?: string) => {
            if (holdRoleWrite) {
              await new Promise<void>((resolve) => {
                releaseRoleWrite = resolve;
              });
            }
            await origMemWrite(scope, text, note, lId);
          };
          holdRoleWrite = true;
          const inflightRoleRes = handler(
            new Request("http://localhost/api/xtwork/im/companion/role", {
              method: "POST",
              headers: { Authorization: "Bearer test-token", "Content-Type": "application/json" },
              body: JSON.stringify({ leaderId: thirdId, text: "role before archive" }),
            }),
          );
          yield* Effect.sleep("15 millis");
          const archiveThirdPromise = handler(
            new Request(`http://localhost/api/xtwork/im/leaders/${thirdId}/archive`, {
              method: "POST",
              headers: { Authorization: "Bearer test-token", "Content-Type": "application/json" },
              body: JSON.stringify({}),
            }),
          );
          yield* Effect.sleep("15 millis");
          expect((yield* leaders.getLeader(thirdId))?.status).toBe("active");
          releaseRoleWrite();
          holdRoleWrite = false;
          fakeMemory.write = origMemWrite;
          const roleFinal = yield* Effect.promise(() => inflightRoleRes);
          const archiveThird = yield* Effect.promise(() => archiveThirdPromise);
          expect(roleFinal.status).toBe(200);
          expect(archiveThird.status).toBe(200);
          expect((yield* leaders.getLeader(thirdId))?.role).toBe("role before archive");
          expect((yield* leaders.getLeader(thirdId))?.status).toBe("archived");

          const navARes = yield* api("POST", "leaders", { name: "并发领航者A" });
          const navBRes = yield* api("POST", "leaders", { name: "并发领航者B" });
          const navAId = (navARes.json.leader as { id: string }).id;
          const navBId = (navBRes.json.leader as { id: string }).id;
          const bindToB = yield* api("POST", "connections/rebind", {
            connectionId: "conn-feishu-1",
            leaderId: navBId,
          });
          expect(bindToB.status).toBe(200);

          let holdNavAPostCheck = true;
          let releaseNavAPostCheck!: () => void;
          let navAPausedCalls = 0;
          fakeHost.request = async (method: string, params: Record<string, unknown> = {}) => {
            if (method === "paused.list" && params.leaderId === navAId) {
              navAPausedCalls += 1;
              if (navAPausedCalls === 2 && holdNavAPostCheck) {
                holdNavAPostCheck = false;
                await new Promise<void>((resolve) => {
                  releaseNavAPostCheck = resolve;
                });
              }
            }
            return origRequest(method, params);
          };
          const archiveAPromise = handler(
            new Request(`http://localhost/api/xtwork/im/leaders/${navAId}/archive`, {
              method: "POST",
              headers: { Authorization: "Bearer test-token", "Content-Type": "application/json" },
              body: JSON.stringify({}),
            }),
          );
          yield* Effect.sleep("15 millis");
          const archiveBIntoAPromise = handler(
            new Request(`http://localhost/api/xtwork/im/leaders/${navBId}/archive`, {
              method: "POST",
              headers: { Authorization: "Bearer test-token", "Content-Type": "application/json" },
              body: JSON.stringify({ rebindToLeaderId: navAId }),
            }),
          );
          yield* Effect.sleep("15 millis");
          expect((yield* leaders.activeBindingForConnection("conn-feishu-1"))?.leaderId).toBe(navBId);
          releaseNavAPostCheck();
          const [archiveARes, archiveBIntoARes] = yield* Effect.promise(() =>
            Promise.all([archiveAPromise, archiveBIntoAPromise]),
          );
          expect(archiveARes.status).toBe(200);
          expect(archiveBIntoARes.status).toBe(400);
          expect(bridgeLeaderId).toBe(navBId);
          expect((yield* leaders.getLeader(navAId))?.status).toBe("archived");
          expect((yield* leaders.getLeader(navBId))?.status).toBe("active");
          fakeHost.request = origRequest;
          const cleanupB = yield* api("POST", `leaders/${navBId}/archive`, {
            rebindToLeaderId: DEFAULT_LEADER_ID,
          });
          expect(cleanupB.status).toBe(200);

          const reviveAttempt = yield* api("POST", `leaders/${engLeader.id}/resume`, {});
          expect(reviveAttempt.status).toBe(404);
          const updateArchivedAttempt = yield* api("POST", `leaders/${engLeader.id}/update`, { name: "不应复活" });
          expect(updateArchivedAttempt.status).toBe(404);
          const roleWriteCountBefore = roleWrites.length;
          const legacyRoleAttempt = yield* api("POST", "companion/role", { leaderId: engLeader.id, text: "stale role write" });
          expect(legacyRoleAttempt.status).toBe(404);
          expect(roleWrites.length).toBe(roleWriteCountBefore);

          const archivedCtx = normalizeExecutionContext({
            source: "im",
            leaderId: engLeader.id,
            bindingId: engBindingId,
            bindingEpoch: 2,
            connectionId: "conn-feishu-1",
            chatId: "dm-owner",
            chatKind: "dm",
            senderRole: "owner",
            replyAudience: "owner_dm",
            isolatedWorkspaceRoot: "/tmp/ws/archived",
            companionScope: "private",
          });
          yield* leaders.persistPolicyBeforeLaunch({
            commandId: "im:conn-feishu-1:archived-msg",
            threadId: "xtwork-im-archived-1",
            context: archivedCtx,
          });
          const bindArchived = yield* leaders
            .bindRunPolicySql("im:conn-feishu-1:archived-msg", "xtwork-im-archived-1", "run-archived-1")
            .pipe(Effect.result);
          expect(bindArchived._tag).toBe("Failure");
          if (bindArchived._tag === "Failure") {
            expect(containsLeaderArchivedError(bindArchived.failure)).toBe(true);
          }

          const archivedRow = yield* leaders.getLeader(engLeader.id);
          expect(archivedRow?.status).toBe("archived");

          const listed = yield* api("GET", "leaders");
          const ids = (listed.json.leaders as Array<{ leader: { id: string } }>).map((item) => item.leader.id);
          expect(ids).toEqual([DEFAULT_LEADER_ID]);
        } finally {
          yield* Effect.promise(() => dispose());
        }
      }).pipe(Effect.provide(dbLayer)),
    );
  });
});
