// @effect-diagnostics nodeBuiltinImport:off globalTimers:off globalDate:off globalJsonInEffect:off effectTryWithoutCatch:off
import { EnvironmentId, ProjectId, RuntimeRequestId, ThreadId } from "@t3tools/contracts";
import * as NodeFileSystem from "@effect/platform-node/NodeFileSystem";
import * as NodeSqliteClient from "@t3tools/shared/nodeSqliteClient";
import * as SqlClient from "effect/sql/SqlClient";
import * as DateTime from "effect/DateTime";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import { mkdir, mkdtemp, readFile, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vite-plus/test";
import type { AgentAwarenessThread } from "../orchestration-v2/ProjectionStore.ts";
import { OrchestratorV2 } from "../orchestration-v2/Orchestrator.ts";
import { ManagedProjectFolders } from "../project/ManagedProjectFolders.ts";
import { ServerSettingsService } from "../serverSettings.ts";
import { bridgeRpcError } from "./XtworkImBridgeHost.ts";
import { dispatchIdentity, inboundMessage, makeDispatcher, sameAudience } from "./XtworkImDispatch.ts";
import { imToolAllowed, runImTool } from "./XtworkImMcp.ts";
import { XtworkImMemory } from "./XtworkImMemory.ts";
import {
  DEFAULT_LEADER_ID,
  ImApprovals,
  canReuseProviderSession,
  desktopContext,
  evaluateThreadAccess,
  hashArgs,
  narrowDelegatedPolicy,
  normalizeExecutionContext,
  type Execution,
  type TurnExecutionContext,
} from "./XtworkImSecurity.ts";
import { classifyDeliverySendOutcome, makeDeliverySync } from "./XtworkImService.ts";
import { buildOwnerNeedsYou, buildScopedAwareness, redactDiagnosticText } from "./XtworkLeaderAwareness.ts";
import { makeLeaderStore } from "./XtworkLeaderStore.ts";

function makeAwarenessThread(input: {
  readonly id: string;
  readonly projectId: string;
  readonly title: string;
  readonly status?: AgentAwarenessThread["status"];
  readonly activityRunStatus?: AgentAwarenessThread["activityRunStatus"];
  readonly pendingRuntimeRequest?: AgentAwarenessThread["pendingRuntimeRequest"];
}): AgentAwarenessThread {
  const now = DateTime.nowUnsafe();
  return {
    id: ThreadId.make(input.id),
    projectId: ProjectId.make(input.projectId),
    title: input.title,
    status: input.status ?? "running",
    activityRunStatus: input.activityRunStatus ?? "running",
    lineage: {
      parentThreadId: null,
      rootThreadId: ThreadId.make(input.id),
      relationshipToParent: null,
    },
    latestRunBackgroundWake: false,
    latestRunStopRequested: false,
    modelSelection: { instanceId: "pi-bundled", model: "xtwork/standard" } as AgentAwarenessThread["modelSelection"],
    pendingBackgroundTasks: [],
    pendingRuntimeRequest: input.pendingRuntimeRequest ?? null,
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

describe("ADR-013 Slice 1: Leader security, persistence, awareness, and isolation", () => {
  it("blocks guessed thread IDs and enforces strict cross-group isolation before counting", () => {
    const groupACaller = normalizeExecutionContext({
      source: "im",
      leaderId: DEFAULT_LEADER_ID,
      bindingId: "bind-1",
      bindingEpoch: 1,
      connectionId: "conn-feishu",
      chatId: "chat-A",
      chatKind: "group",
      senderRole: "member",
      replyAudience: "group",
      isolatedWorkspaceRoot: "/tmp/ws/a",
      companionScope: "group:a",
    });

    // Guessed Group B thread ID
    expect(
      evaluateThreadAccess({
        caller: groupACaller,
        awarenessScope: { kind: "all_local", projectIds: [] },
        action: "status_read",
        target: {
          threadId: "xtwork-im-group-secret-b",
          projectId: "proj-scratch",
          isProtected: true,
          replyAudience: "group",
          leaderId: DEFAULT_LEADER_ID,
          connectionId: "conn-feishu",
          chatId: "chat-B",
        },
      }).allowed,
    ).toBe(false);

    // Guessed desktop private thread ID
    expect(
      evaluateThreadAccess({
        caller: groupACaller,
        awarenessScope: { kind: "all_local", projectIds: [] },
        action: "status_read",
        target: {
          threadId: "thread-local-finance",
          projectId: "proj-finance",
          isProtected: false,
          replyAudience: "local_only",
          leaderId: null,
        },
      }).allowed,
    ).toBe(false);

    // Owner DM cannot see desktop local sessions by default unless explicitly granted
    const ownerDmCaller = normalizeExecutionContext({
      source: "im",
      leaderId: DEFAULT_LEADER_ID,
      connectionId: "conn-feishu",
      chatId: "dm-owner",
      chatKind: "dm",
      senderRole: "owner",
      replyAudience: "owner_dm",
      isolatedWorkspaceRoot: "/tmp/ws/dm",
      companionScope: "private",
    });
    expect(
      evaluateThreadAccess({
        caller: ownerDmCaller,
        awarenessScope: { kind: "all_local", projectIds: [] },
        action: "status_read",
        target: {
          threadId: "thread-local-finance",
          projectId: "proj-finance",
          isProtected: false,
          replyAudience: "local_only",
        },
      }).allowed,
    ).toBe(false);

    // Explicit grant allows Owner DM to inspect granted local thread
    expect(
      evaluateThreadAccess({
        caller: ownerDmCaller,
        awarenessScope: { kind: "all_local", projectIds: [] },
        ownerDmDesktopGrants: new Set(["thread-local-finance"]),
        action: "status_read",
        target: {
          threadId: "thread-local-finance",
          projectId: "proj-finance",
          isProtected: false,
          replyAudience: "local_only",
        },
      }).allowed,
    ).toBe(true);
  });

  it("protects prefixless derived threads, fails closed on missing run policy, and detects policy digest changes", async () => {
    await Effect.runPromise(
      Effect.gen(function* () {
        const store = yield* makeLeaderStore();
        const derivedThreadId = "derived-subagent-9821"; // intentionally NO `xtwork-im-` prefix!
        const ctx1 = normalizeExecutionContext({
          source: "im",
          leaderId: DEFAULT_LEADER_ID,
          bindingId: "bind-1",
          bindingEpoch: 1,
          connectionId: "conn-feishu",
          chatId: "chat-ops",
          chatKind: "group",
          senderRole: "member",
          replyAudience: "group",
          isolatedWorkspaceRoot: "/tmp/ws/ops",
          companionScope: "group:ops",
        });

        // Persist execution policy BEFORE launch (unattached — run_id IS NULL)
        const pol1 = yield* store.persistPolicyBeforeLaunch({
          commandId: "im:conn-feishu:msg-1",
          threadId: derivedThreadId,
          context: ctx1,
        });
        expect(store.isProtectedThreadSync(derivedThreadId)).toBe(true);
        expect(imToolAllowed(derivedThreadId, "im__reply", true, store.isProtectedThreadSync(derivedThreadId))).toBe(true);
        expect(imToolAllowed(derivedThreadId, "im__native_policy", true, store.isProtectedThreadSync(derivedThreadId))).toBe(false);
        expect(imToolAllowed(derivedThreadId, "im__native_policy", false, store.isProtectedThreadSync(derivedThreadId))).toBe(true);

        // S1: Unattached policy (no bindRunPolicy yet, or missing runId) MUST fail closed!
        expect(store.resolveProviderPolicySync(derivedThreadId)).toEqual({
          protected: true,
          policyDigest: null,
          failClosed: true,
          policyChanged: false,
        });
        expect(store.resolveProviderPolicySync(derivedThreadId, "run-1")).toEqual({
          protected: true,
          policyDigest: null,
          failClosed: true,
          policyChanged: false,
        });

        // S1: Binding wrong commandId/threadId fails closed
        const badBind = yield* store.bindRunPolicy("im:conn-feishu:unknown", derivedThreadId, "run-1").pipe(Effect.result);
        expect(badBind._tag).toBe("Failure");

        // Bind exact (commandId, threadId) -> run-1 before provider launch
        yield* store.bindRunPolicy("im:conn-feishu:msg-1", derivedThreadId, "run-1");
        expect(store.hasRunPolicySync({ runId: "run-1" })).toBe(true);
        expect(store.resolveProviderPolicySync(derivedThreadId, "run-1")).toEqual({
          protected: true,
          policyDigest: pol1.policyDigest,
          failClosed: false,
          policyChanged: false,
        });

        // A rogue/scheduled run on the SAME protected thread without its own bound policy MUST fail closed!
        expect(store.hasRunPolicySync({ commandId: "scheduled-unpersisted-cmd" })).toBe(false);
        expect(store.resolveProviderPolicySync(derivedThreadId, "run-rogue")).toEqual({
          protected: true,
          policyDigest: null,
          failClosed: true,
          policyChanged: false,
        });

        // An unpersisted xtwork-im-* thread also fails closed
        expect(store.resolveProviderPolicySync("xtwork-im-group-unpersisted", "run-x")).toEqual({
          protected: true,
          policyDigest: null,
          failClosed: true,
          policyChanged: false,
        });

        // S2: Run A opens Pi with policy X -> Run B queues with policy Y and is cancelled before opening Pi ->
        // Run C also uses policy Y -> comparing against native session A ("native-pi-1") MUST STILL detect policyChanged=true!
        const narrower = narrowDelegatedPolicy(ctx1, { isolatedWorkspaceRoot: "/tmp/ws/ops/sub" });
        expect(canReuseProviderSession(ctx1.policyDigest, narrower.policyDigest)).toBe(false);
        expect(canReuseProviderSession(ctx1.policyDigest, ctx1.policyDigest)).toBe(true);
        yield* store.recordNativeThreadPolicy(derivedThreadId, "native-pi-1", pol1.policyDigest);

        // Run B binds policy Y (never opens Pi / cancelled)
        yield* store.persistPolicyBeforeLaunch({
          commandId: "im:conn-feishu:msg-2",
          threadId: derivedThreadId,
          context: narrower,
        });
        yield* store.bindRunPolicy("im:conn-feishu:msg-2", derivedThreadId, "run-2");

        // Run C also binds policy Y and tries to resume native-pi-1 (which belongs to policy X!)
        yield* store.persistPolicyBeforeLaunch({
          commandId: "im:conn-feishu:msg-3",
          threadId: derivedThreadId,
          context: narrower,
        });
        yield* store.bindRunPolicy("im:conn-feishu:msg-3", derivedThreadId, "run-3");

        expect(store.resolveProviderPolicySync(derivedThreadId, "run-3", "native-pi-1")).toEqual({
          protected: true,
          policyDigest: narrower.policyDigest!,
          failClosed: false,
          policyChanged: true,
        });
        // Once Run C opens a clean conversation "native-pi-2" and records policy Y, subsequent turns with Y reuse it cleanly!
        yield* store.recordNativeThreadPolicy(derivedThreadId, "native-pi-2", narrower.policyDigest!);
        expect(store.resolveProviderPolicySync(derivedThreadId, "run-3", "native-pi-2")).toEqual({
          protected: true,
          policyDigest: narrower.policyDigest!,
          failClosed: false,
          policyChanged: false,
        });
        // Unknown / unrecorded native session also triggers policyChanged=true (fail-closed)
        expect(store.resolveProviderPolicySync(derivedThreadId, "run-3", "native-unknown").policyChanged).toBe(true);
        // Run-1 retains its exact original policy digest even after run-2/run-3 are queued/bound!
        expect(store.resolveProviderPolicySync(derivedThreadId, "run-1", "native-pi-1")).toEqual({
          protected: true,
          policyDigest: pol1.policyDigest,
          failClosed: false,
          policyChanged: false,
        });

        // S12: bindRunPolicySql inside a rolled-back transaction leaves BOTH SQLite and in-memory cache untouched!
        yield* store.persistPolicyBeforeLaunch({
          commandId: "im:conn-feishu:msg-rollback",
          threadId: derivedThreadId,
          context: ctx1,
        });
        const sqlClient = yield* SqlClient.SqlClient;
        const rolledBack = yield* sqlClient.withTransaction(
          Effect.gen(function* () {
            yield* store.bindRunPolicySql("im:conn-feishu:msg-rollback", derivedThreadId, "run-reusable-ordinal");
            return yield* Effect.fail("simulated-crash-before-commit");
          }),
        ).pipe(Effect.result);
        expect(rolledBack._tag).toBe("Failure");
        expect(store.resolveProviderPolicySync(derivedThreadId, "run-reusable-ordinal").failClosed).toBe(true);
        // Another message after restart can bind the exact same ordinal run_id without hitting UNIQUE constraint!
        yield* store.persistPolicyBeforeLaunch({
          commandId: "im:conn-feishu:msg-after-crash",
          threadId: derivedThreadId,
          context: ctx1,
        });
        const boundAfterCrash = yield* store.bindRunPolicy("im:conn-feishu:msg-after-crash", derivedThreadId, "run-reusable-ordinal");
        expect(boundAfterCrash.runId).toBe("run-reusable-ordinal");
        expect(store.resolveProviderPolicySync(derivedThreadId, "run-reusable-ordinal").failClosed).toBe(false);
      }).pipe(Effect.provide(NodeSqliteClient.layer({ filename: ":memory:" }))),
    );
  });

  it("isolates Leader rebinding epochs so crash replays never collide with a new Leader's thread or session", async () => {
    await Effect.runPromise(
      Effect.gen(function* () {
        const store = yield* makeLeaderStore();
        const leaderA = yield* store.ensureDefaultLeader();
        const leaderB = yield* store.createLeader({ name: "研发主管", avatar: "研", role: "工程交付主管" });

        const binding1 = yield* store.ensureBinding("conn-wecom", leaderA.id);
        expect(binding1.epoch).toBe(1);
        expect(binding1.leaderId).toBe(leaderA.id);

        const route = inboundMessage({
          connectionId: "conn-wecom",
          platformMsgId: "msg-100",
          chatId: "group-eng",
          chatKind: "group",
          senderRole: "member",
          text: "Check CI",
        });
        const idEpoch1 = dispatchIdentity(route, "/tmp/im", undefined, binding1);

        // Rebind connection to Leader B -> bumps epoch and assigns new bindingId
        const binding2 = yield* store.rebindConnection("conn-wecom", leaderB.id);
        expect(binding2).toBeDefined();
        expect(binding2!.epoch).toBe(2);
        expect(binding2!.bindingId).not.toBe(binding1.bindingId);
        expect(binding2!.leaderId).toBe(leaderB.id);

        const idEpoch2 = dispatchIdentity(route, "/tmp/im", undefined, binding2!);
        expect(idEpoch2.threadId).not.toBe(idEpoch1.threadId);
        expect(sameAudience(idEpoch1.context, idEpoch2.context)).toBe(false);
        expect(idEpoch1.context.leaderId).toBe(leaderA.id);
        expect(idEpoch2.context.leaderId).toBe(leaderB.id);

        // S7: Legacy pre-ADR-013 context (bindingId=null, bindingEpoch=null) matches initial default epoch-1 binding,
        // preserving linked chat threads on upgrade while NEVER matching rebound epoch-2!
        const legacyCtx = dispatchIdentity(route, "/tmp/im").context;
        expect(legacyCtx.bindingId).toBeNull();
        expect(legacyCtx.bindingEpoch).toBeNull();
        expect(sameAudience(legacyCtx, idEpoch1.context)).toBe(true);
        expect(sameAudience(legacyCtx, idEpoch2.context)).toBe(false);
      }).pipe(Effect.provide(NodeSqliteClient.layer({ filename: ":memory:" }))),
    );
  });

  it("binds group private-memory sharing to an exact full content snapshot hash, enforces runId+audience, and never grants live read access (S8/S9)", async () => {
    const dir = await mkdtemp(join(tmpdir(), "xtwork-snapshot-share-"));
    const memory = new XtworkImMemory(dir);
    // S9: Ensure snapshot > 1200 chars is NOT truncated in approval payload!
    const fullNote = `Q4 roadmap: launch Leader Slice 1.\n${"detail-line ".repeat(150)}END_OF_COMPLETE_SNAPSHOT`;
    expect(fullNote.length).toBeGreaterThan(1500);
    await memory.write("private", fullNote, "roadmap.md", DEFAULT_LEADER_ID);

    const approvals = new ImApprovals();
    const groupCtx = normalizeExecutionContext({
      source: "im",
      leaderId: DEFAULT_LEADER_ID,
      connectionId: "conn-feishu",
      chatId: "chat-team",
      chatKind: "group",
      senderRole: "member",
      replyAudience: "group",
      isolatedWorkspaceRoot: dir,
      companionScope: "group:team",
    });
    const execution: Execution & { readonly inbound?: ReturnType<typeof inboundMessage> } = {
      turnId: "run-share-1",
      threadId: "xtwork-im-group-team",
      context: groupCtx,
      inbound: inboundMessage({
        connectionId: "conn-feishu",
        platformMsgId: "pm-share-1",
        chatId: "chat-team",
        chatName: "核心研发群",
        chatKind: "group",
        senderRole: "member",
      }),
    };

    const controller = new AbortController();
    const sharePromise = runImTool(
      { approvals, memory, markReplySucceeded: () => {} },
      execution,
      "im__memory_read",
      { scope: "private", note: "roadmap.md" },
      controller.signal,
    );

    // Wait a microtask for approval request to register
    await new Promise((r) => setTimeout(r, 10));
    const pending = approvals.list();
    expect(pending).toHaveLength(1);
    const req = pending[0]!;
    expect(req.toolName).toBe("im__memory_share");
    expect(req.snapshotHash).toBeTruthy();
    const snapshotHash = req.snapshotHash!;
    expect(req.targetScope).toBe("group:team");
    expect(req.targetChatName).toBe("核心研发群");
    expect(req.contentSnapshot).toBe(fullNote);
    expect(req.contentSnapshot).toContain("END_OF_COMPLETE_SNAPSHOT");

    // 1. status_read summary MUST NEVER expose raw details or contentSnapshot
    const summary = approvals.listStatusSummary(new Set(["xtwork-im-group-team"]));
    expect(summary).toEqual({ totalCount: 1, countByThreadId: { "xtwork-im-group-team": 1 } });
    expect(JSON.stringify(summary)).not.toContain("Q4 roadmap");

    // 2. S8: Missing expectedRunId or missing expectedAudience MUST be rejected!
    expect(
      approvals.decide(req.id, true, {
        desktopOwnerVerified: true,
        expectedRunId: undefined,
        expectedAudience: "group",
        expectedSnapshotHash: snapshotHash,
      }),
    ).toBe(false);
    expect(
      approvals.decide(req.id, true, {
        desktopOwnerVerified: true,
        expectedRunId: "run-share-1",
        expectedAudience: undefined,
        expectedSnapshotHash: snapshotHash,
      }),
    ).toBe(false);

    // 2. Non-desktop caller MUST be rejected
    expect(
      approvals.decide(req.id, true, {
        desktopOwnerVerified: false,
        expectedRunId: "run-share-1",
        expectedAudience: "group",
        expectedSnapshotHash: snapshotHash,
      }),
    ).toBe(false);

    // 3. Approving WITHOUT expectedSnapshotHash MUST be rejected
    expect(
      approvals.decide(req.id, true, {
        desktopOwnerVerified: true,
        expectedRunId: "run-share-1",
        expectedAudience: "group",
      }),
    ).toBe(false);

    // 4. Wrong snapshotHash or wrong runId or wrong audience MUST be rejected
    expect(
      approvals.decide(req.id, true, {
        desktopOwnerVerified: true,
        expectedRunId: "run-other",
        expectedAudience: "group",
        expectedSnapshotHash: snapshotHash,
      }),
    ).toBe(false);
    expect(
      approvals.decide(req.id, true, {
        desktopOwnerVerified: true,
        expectedRunId: "run-share-1",
        expectedAudience: "owner_dm",
        expectedSnapshotHash: snapshotHash,
      }),
    ).toBe(false);
    expect(
      approvals.decide(req.id, true, {
        desktopOwnerVerified: true,
        expectedRunId: "run-share-1",
        expectedAudience: "group",
        expectedSnapshotHash: "tampered-hash",
      }),
    ).toBe(false);

    // 5. Verified desktop Owner with matching runId, audience, and snapshotHash succeeds
    expect(
      approvals.decide(req.id, true, {
        desktopOwnerVerified: true,
        expectedRunId: "run-share-1",
        expectedAudience: "group",
        expectedSnapshotHash: snapshotHash,
      }),
    ).toBe(true);

    const result = (await sharePromise) as { shared: boolean; note: string; snapshotHash: string; content: string };
    expect(result.shared).toBe(true);
    expect(result.snapshotHash).toBe(req.snapshotHash);
    expect(result.note).toMatch(/^shared-[a-f0-9]+\.md$/u);

    // 6. Snapshot was copied into group scope; mutating private note afterwards does NOT alter group snapshot
    await memory.write("private", "TOP SECRET SALARY DATA", "roadmap.md", DEFAULT_LEADER_ID);
    const groupCopy = await memory.read("group:team", result.note, DEFAULT_LEADER_ID);
    expect(groupCopy).toContain("launch Leader Slice 1");
    expect(groupCopy).not.toContain("TOP SECRET SALARY DATA");
  });

  it("migrates legacy companion/ directory per-file idempotently and finishes interrupted partial copies (S10)", async () => {
    const dir = await mkdtemp(join(tmpdir(), "xtwork-legacy-migrate-"));
    await mkdir(join(dir, "private", "notes"), { recursive: true });
    await mkdir(join(dir, "groups", "g1"), { recursive: true });
    await mkdir(join(dir, "groups", "g2"), { recursive: true });
    await writeFile(join(dir, "ROLE.md"), "Legacy role prompt", "utf8");
    await writeFile(join(dir, "private", "MEMORY.md"), "Legacy private memory", "utf8");
    await writeFile(join(dir, "private", "notes", "plan.md"), "Legacy note", "utf8");
    await writeFile(join(dir, "groups", "g1", "MEMORY.md"), "Legacy group g1 memory", "utf8");
    await writeFile(join(dir, "groups", "g2", "MEMORY.md"), "Legacy group g2 memory", "utf8");

    // Simulate a crash mid-migration where `leaders/leader-default/private/` and `groups/g1/`
    // were partially created with ONE file, leaving the remaining files uncopied!
    await mkdir(join(dir, "leaders", DEFAULT_LEADER_ID, "private"), { recursive: true });
    await writeFile(join(dir, "leaders", DEFAULT_LEADER_ID, "private", "MEMORY.md"), "Newer existing memory", "utf8");

    const memory = new XtworkImMemory(dir);
    await memory.ensureMigrated(DEFAULT_LEADER_ID);

    expect(await memory.read("role", undefined, DEFAULT_LEADER_ID)).toBe("Legacy role prompt");
    // Existing Leader file MUST NOT be clobbered!
    expect(await memory.read("private", undefined, DEFAULT_LEADER_ID)).toBe("Newer existing memory");
    // Missing sibling files inside already-existing directories MUST still be copied!
    expect(await memory.read("private", "plan.md", DEFAULT_LEADER_ID)).toBe("Legacy note");
    expect(await memory.read("group:g1", undefined, DEFAULT_LEADER_ID)).toBe("Legacy group g1 memory");
    expect(await memory.read("group:g2", undefined, DEFAULT_LEADER_ID)).toBe("Legacy group g2 memory");

    // Original legacy file remains untouched as backup
    expect(await readFile(join(dir, "ROLE.md"), "utf8")).toBe("Legacy role prompt");
  });

  it("prevents narrowDelegatedPolicy from widening authority and redacts secrets/home paths in diagnostics", () => {
    const groupCtx = normalizeExecutionContext({
      source: "im",
      leaderId: DEFAULT_LEADER_ID,
      connectionId: "conn-1",
      chatId: "chat-1",
      chatKind: "group",
      senderRole: "member",
      replyAudience: "group",
      isolatedWorkspaceRoot: "/tmp/ws/group1",
      companionScope: "group:g1",
    });

    // Attempt to widen group -> owner_dm / desktop / private scope MUST stay strictly narrowed
    const attempted = narrowDelegatedPolicy(groupCtx, {
      source: "desktop",
      senderRole: "owner",
      replyAudience: "owner_dm",
      companionScope: "private",
      isolatedWorkspaceRoot: "/etc",
    });
    expect(attempted.source).toBe("im");
    expect(attempted.senderRole).toBe("member");
    expect(attempted.replyAudience).toBe("group");
    expect(attempted.companionScope).toBe("group:g1");
    expect(attempted.isolatedWorkspaceRoot).toBe("/tmp/ws/group1");

    const redacted = redactDiagnosticText(
      JSON.stringify({
        auth: "Bearer super_secret_token_987654321",
        appSecret: "my-feishu-app-secret",
        key: "sk_live_abcdefgh123456",
        macPath: "/Users/alice/Documents/secret.txt",
        linuxPath: "/home/bob/.ssh/id_rsa",
        winPath: "C:\\Users\\charlie\\secrets.env",
      }),
    );
    expect(redacted).not.toContain("super_secret_token_987654321");
    expect(redacted).not.toContain("my-feishu-app-secret");
    expect(redacted).not.toContain("sk_live_abcdefgh123456");
    expect(redacted).not.toContain("/Users/alice");
    expect(redacted).not.toContain("/home/bob");
    expect(redacted).not.toContain("C:\\Users\\charlie");
    expect(redacted).toContain("[REDACTED]");
  });

  it("aggregates Needs You across local and IM threads for desktop Owner while keeping group views isolated", async () => {
    await Effect.runPromise(
      Effect.gen(function* () {
        const store = yield* makeLeaderStore();
        const leader = yield* store.ensureDefaultLeader();

        const groupAThreadId = "xtwork-im-group-a";
        const groupBThreadId = "xtwork-im-group-b";
        const localThreadId = "local-thread-build";

        const groupACtx: TurnExecutionContext = normalizeExecutionContext({
          source: "im",
          leaderId: leader.id,
          connectionId: "conn-feishu",
          chatId: "chat-A",
          chatKind: "group",
          senderRole: "member",
          replyAudience: "group",
          isolatedWorkspaceRoot: "/tmp/ws/a",
          companionScope: "group:a",
        });
        const groupBCtx: TurnExecutionContext = normalizeExecutionContext({
          source: "im",
          leaderId: leader.id,
          connectionId: "conn-feishu",
          chatId: "chat-B",
          chatKind: "group",
          senderRole: "member",
          replyAudience: "group",
          isolatedWorkspaceRoot: "/tmp/ws/b",
          companionScope: "group:b",
        });

        yield* store.persistPolicyBeforeLaunch({ commandId: "im:conn-feishu:a1", threadId: groupAThreadId, context: groupACtx, runId: "run-a1" });
        yield* store.persistPolicyBeforeLaunch({ commandId: "im:conn-feishu:b1", threadId: groupBThreadId, context: groupBCtx, runId: "run-b1" });

        const approvals = new ImApprovals();
        const pendingApproval = approvals.require(
          { turnId: "run-a1", threadId: groupAThreadId, context: groupACtx },
          "bash",
          { command: "cat /etc/hosts" },
        );

        const snapshotThreads: AgentAwarenessThread[] = [
          makeAwarenessThread({ id: groupAThreadId, projectId: "proj-scratch", title: "群聊 A 任务", status: "running", activityRunStatus: "running" }),
          makeAwarenessThread({ id: groupBThreadId, projectId: "proj-scratch", title: "群聊 B 机密任务", status: "running", activityRunStatus: "running" }),
          makeAwarenessThread({
            id: localThreadId,
            projectId: "proj-app",
            title: "本机发版检查",
            status: "waiting",
            activityRunStatus: "waiting",
            pendingRuntimeRequest: {
              id: RuntimeRequestId.make("req-1"),
              kind: "user_input",
              createdAt: DateTime.nowUnsafe(),
            },
          }),
        ];

        // 1. Desktop Owner sees all authorized tasks + Group A approval in Needs You
        const ownerView = buildOwnerNeedsYou({
          caller: { ...desktopContext, leaderId: leader.id },
          leader,
          snapshotSequence: 42,
          snapshotThreads,
          leaderStore: store,
          approvals,
          environmentId: EnvironmentId.make("local"),
        });
        expect(ownerView.approvals).toHaveLength(1);
        expect(ownerView.awareness.threads.map((t) => t.threadId)).toEqual(
          expect.arrayContaining([groupAThreadId, groupBThreadId, localThreadId]),
        );
        expect(ownerView.awareness.needsYouCount).toBe(2); // Group A (IM approval) + Local (waiting_for_input)

        // 2. Group B caller MUST see ONLY Group B — zero leak of Group A title, approval, or Local task!
        const groupBView = buildScopedAwareness({
          caller: groupBCtx,
          leader,
          snapshotSequence: 42,
          snapshotThreads,
          leaderStore: store,
          approvals,
          environmentId: EnvironmentId.make("local"),
        });
        expect(groupBView.threads.map((t) => t.threadId)).toEqual([groupBThreadId]);
        expect(groupBView.pendingApprovalCount).toBe(0);
        expect(groupBView.needsYouCount).toBe(0);
        expect(JSON.stringify(groupBView)).not.toContain("群聊 A");
        expect(JSON.stringify(groupBView)).not.toContain("本机发版检查");
        expect(JSON.stringify(groupBView)).not.toContain("/etc/hosts");

        // 3. Approve Group A's pending request -> clears from Owner Needs You
        const req = ownerView.approvals[0]!;
        expect(
          approvals.decide(req.id, true, {
            desktopOwnerVerified: true,
            expectedRunId: "run-a1",
            expectedAudience: "group",
          }),
        ).toBe(true);
        yield* Effect.promise(() => pendingApproval);

        const afterView = buildOwnerNeedsYou({
          caller: { ...desktopContext, leaderId: leader.id },
          leader,
          snapshotSequence: 43,
          snapshotThreads,
          leaderStore: store,
          approvals,
          environmentId: EnvironmentId.make("local"),
        });
        expect(afterView.approvals).toHaveLength(0);
        expect(afterView.awareness.pendingApprovalCount).toBe(0);
        expect(afterView.awareness.needsYouCount).toBe(1); // Only local waiting_for_input remains
      }).pipe(Effect.provide(NodeSqliteClient.layer({ filename: ":memory:" }))),
    );
  });

  it("persists Leaders, bindings, protected threads, and run policies across SQLite restarts", async () => {
    const dir = await mkdtemp(join(tmpdir(), "xtwork-leader-sqlite-"));
    const dbPath = join(dir, "state.sqlite");

    await Effect.runPromise(
      Effect.gen(function* () {
        const store = yield* makeLeaderStore();
        yield* store.ensureDefaultLeader();
        yield* store.updateLeader(DEFAULT_LEADER_ID, { name: "小瞳总管", status: "paused" });
        yield* store.ensureBinding("conn-wechat", DEFAULT_LEADER_ID);
        const persisted = yield* store.persistPolicyBeforeLaunch({
          commandId: "im:conn-wechat:m1",
          threadId: "derived-restart-thread",
          runId: "run-restart-1",
          context: normalizeExecutionContext({
            source: "im",
            leaderId: DEFAULT_LEADER_ID,
            connectionId: "conn-wechat",
            chatId: "wx-dm",
            chatKind: "dm",
            senderRole: "owner",
            replyAudience: "owner_dm",
            isolatedWorkspaceRoot: "/tmp/ws/wx",
            companionScope: "private",
          }),
        });
        yield* store.recordNativeThreadPolicy("derived-restart-thread", "native-restart-1", persisted.policyDigest);
      }).pipe(Effect.provide(NodeSqliteClient.layer({ filename: dbPath }))),
    );

    // Reopen fresh LeaderStore against the exact same SQLite file
    await Effect.runPromise(
      Effect.gen(function* () {
        const reopened = yield* makeLeaderStore();
        const leader = yield* reopened.getLeader(DEFAULT_LEADER_ID);
        expect(leader?.name).toBe("小瞳总管");
        expect(leader?.status).toBe("paused");
        expect(reopened.isProtectedThreadSync("derived-restart-thread")).toBe(true);
        const sameNative = reopened.resolveProviderPolicySync("derived-restart-thread", "run-restart-1", "native-restart-1");
        expect(sameNative.failClosed).toBe(false);
        expect(sameNative.policyChanged).toBe(false);
        // Unknown native session fails closed (`policyChanged: true`) even after restart
        const unknownNative = reopened.resolveProviderPolicySync("derived-restart-thread", "run-restart-1", "native-unseen");
        expect(unknownNative.failClosed).toBe(false);
        expect(unknownNative.policyChanged).toBe(true);
        expect(reopened.resolveProviderPolicySync("derived-restart-thread", "run-unknown").failClosed).toBe(true);
        // S6: Historical binding tuple lookup survives restart
        const tuple = yield* reopened.findBindingByTuple("conn-wechat", DEFAULT_LEADER_ID, 1);
        expect(tuple?.leaderId).toBe(DEFAULT_LEADER_ID);
        expect(yield* reopened.findBindingByTuple("conn-wechat", "leader-other", 1)).toBeUndefined();
      }).pipe(Effect.provide(NodeSqliteClient.layer({ filename: dbPath }))),
    );
  });

  it("keeps lost-ACK runs pending across temporary CONNECTION_OFFLINE errors and never settles unsent replies as replied (S3)", async () => {
    const inbound = inboundMessage({
      connectionId: "conn-feishu",
      platformMsgId: "pm-offline-1",
      messageId: "m-offline-1",
      chatId: "chat-1",
      chatKind: "dm",
      senderRole: "owner",
    });
    const threadId = "xtwork-im-dm-offline";
    const userMessageId = `xtwork-im:${hashArgs(inbound.key)}`;
    const settledKeys: string[] = [];
    const bridgeCalls: Array<{ method: string; params: Record<string, unknown> | undefined }> = [];
    let bridgeOnline = false;
    let bridgeMsgState = "paused_pending";

    const fakeHost = {
      available: true,
      async request(method: string, params?: Record<string, unknown>) {
        bridgeCalls.push({ method, params });
        if (method === "inbound.ack") {
          if (bridgeMsgState === "paused_pending") bridgeMsgState = "delivered";
          return { message: { state: bridgeMsgState } };
        }
        if (method === "messages.reply") {
          if (!bridgeOnline) {
            throw bridgeRpcError('Connection "conn-feishu" is not currently connected', "CONNECTION_OFFLINE");
          }
          bridgeMsgState = "replied";
          return { result: { kind: "sent", platformId: "out-1" } };
        }
        if (method === "inbound.settle") {
          const event = String(params?.event ?? "");
          if (event === "reply" && bridgeMsgState === "replied") {
            return { moved: false, message: { state: "replied" } };
          }
          if (event === "fail" && bridgeMsgState === "delivered") {
            bridgeMsgState = "failed";
            return { moved: true, message: { state: "failed" } };
          }
          return { moved: false, message: { state: bridgeMsgState } };
        }
        return {};
      },
    };

    const fakeDispatch = {
      orchestrator: {
        getThreadRecords: () =>
          Effect.succeed({
            runs: [{ id: "run-s3-1", userMessageId, status: "completed" }],
            messages: [{ runId: "run-s3-1", role: "assistant", text: "Task finished!" }],
          }),
      },
      settle: (key: string) =>
        Effect.sync(() => {
          settledKeys.push(key);
        }),
    } as never;

    const { sync } = makeDeliverySync(fakeHost, fakeDispatch, () => false);
    const row = {
      key: inbound.key,
      threadId,
      contextJson: "{}",
      payloadJson: JSON.stringify(inbound),
    };

    // Tick 1: Lost ACK reconciled (`paused_pending` -> `delivered`), reply hits CONNECTION_OFFLINE -> MUST NOT settle!
    await Effect.runPromise(sync(row));
    expect(bridgeMsgState).toBe("delivered");
    expect(settledKeys).toEqual([]);
    expect(bridgeCalls.filter((c) => c.method === "inbound.settle")).toHaveLength(0);

    // Tick 2: Connection comes back online -> reply succeeds -> settles locally cleanly!
    bridgeOnline = true;
    await Effect.runPromise(sync(row));
    expect(bridgeMsgState).toBe("replied");
    expect(settledKeys).toEqual([inbound.key]);

    // Permanent failure classification settles as "fail", never "reply"
    expect(classifyDeliverySendOutcome(undefined, { code: "CONNECTION_OFFLINE" })).toBe("temporary_failure");
    expect(classifyDeliverySendOutcome({ result: { kind: "failed", code: "rate_limited", retryable: true } })).toBe(
      "temporary_failure",
    );
    expect(classifyDeliverySendOutcome(undefined, { code: "CHAT_BLOCKED" })).toBe("permanent_failure");
    expect(classifyDeliverySendOutcome({ result: { kind: "failed", code: "forbidden", retryable: false } })).toBe(
      "permanent_failure",
    );
    expect(classifyDeliverySendOutcome({ result: { kind: "uncertain" } })).toBe("sent");
  });

  it("preserves same-policy reuse across mid-turn Pi native session switches while still failing closed on policy change (S16)", async () => {
    await Effect.runPromise(
      Effect.gen(function* () {
        const store = yield* makeLeaderStore();
        yield* store.ensureDefaultLeader();

        const policyX = normalizeExecutionContext({
          source: "im",
          leaderId: DEFAULT_LEADER_ID,
          connectionId: "conn-feishu",
          chatId: "chat-handoff",
          chatKind: "group",
          senderRole: "member",
          replyAudience: "group",
          isolatedWorkspaceRoot: "/tmp/ws/handoff",
          companionScope: "group:handoff",
        });
        const policyY = normalizeExecutionContext({
          ...policyX,
          isolatedWorkspaceRoot: "/tmp/ws/handoff-v2",
        });

        // Turn 1 starts on native-pi-1 under policy X
        const run1 = yield* store.persistPolicyBeforeLaunch({
          commandId: "cmd-s16-1",
          threadId: "thread-s16",
          runId: "run-s16-1",
          context: policyX,
        });
        yield* store.recordNativeThreadPolicy("thread-s16", "native-pi-1", run1.policyDigest);

        // Mid-turn Pi extension calls ctx.newSession() -> replacement native-pi-child recorded with active run's digest
        const activePolicy = store.resolveProviderPolicySync("thread-s16", "run-s16-1");
        expect(activePolicy.failClosed).toBe(false);
        expect(activePolicy.policyDigest).toBe(run1.policyDigest);
        yield* store.recordNativeThreadPolicy("thread-s16", "native-pi-child", activePolicy.policyDigest!);

        // Turn 2 with SAME policy X resumes native-pi-child WITHOUT forcing a fresh conversation!
        yield* store.persistPolicyBeforeLaunch({
          commandId: "cmd-s16-2",
          threadId: "thread-s16",
          runId: "run-s16-2",
          context: policyX,
        });
        const turn2Check = store.resolveProviderPolicySync("thread-s16", "run-s16-2", "native-pi-child");
        expect(turn2Check.failClosed).toBe(false);
        expect(turn2Check.policyChanged).toBe(false);

        // Turn 3 with DIFFERENT policy Y MUST still see policyChanged: true on native-pi-child!
        yield* store.persistPolicyBeforeLaunch({
          commandId: "cmd-s16-3",
          threadId: "thread-s16",
          runId: "run-s16-3",
          context: policyY,
        });
        const turn3Check = store.resolveProviderPolicySync("thread-s16", "run-s16-3", "native-pi-child");
        expect(turn3Check.failClosed).toBe(false);
        expect(turn3Check.policyChanged).toBe(true);
      }).pipe(Effect.provide(NodeSqliteClient.layer({ filename: ":memory:" }))),
    );
  });

  it("rejects replayed known delivery keys when bindingId is supplied without matching leaderId and bindingEpoch (S6)", async () => {
    const dir = await mkdtemp(join(tmpdir(), "xtwork-s6-replay-"));
    const memory = new XtworkImMemory(dir);
    const fakeDeps = Layer.mergeAll(
      NodeFileSystem.layer,
      NodeSqliteClient.layer({ filename: ":memory:" }),
      Layer.succeed(OrchestratorV2, {
        getThreadRecords: () => Effect.succeed({ runs: [], messages: [] }),
        dispatch: () => Effect.succeed({}),
      } as never),
      Layer.succeed(ManagedProjectFolders, {
        ensure: () => Effect.succeed(ProjectId.make("proj-1")),
      } as never),
      Layer.succeed(ServerSettingsService, {
        getSettings: Effect.succeed({}),
      } as never),
    );

    await Effect.runPromise(
      Effect.gen(function* () {
        const sql = yield* SqlClient.SqlClient;
        const leaders = yield* makeLeaderStore();
        yield* leaders.ensureDefaultLeader();
        const binding = yield* leaders.ensureBinding("conn-feishu", DEFAULT_LEADER_ID);
        const dispatcher = yield* makeDispatcher(dir, memory, leaders);

        const inbound = inboundMessage({
          connectionId: "conn-feishu",
          platformMsgId: "pm-replay-1",
          chatId: "chat-dm",
          chatKind: "dm",
          senderRole: "owner",
          leaderId: binding.leaderId,
          bindingId: binding.bindingId,
          bindingEpoch: binding.epoch,
        });
        const storedCtx = normalizeExecutionContext({
          source: "im",
          leaderId: binding.leaderId,
          bindingId: binding.bindingId,
          bindingEpoch: binding.epoch,
          connectionId: "conn-feishu",
          chatId: "chat-dm",
          chatKind: "dm",
          senderRole: "owner",
          replyAudience: "owner_dm",
          isolatedWorkspaceRoot: dir,
          companionScope: "private",
        });
        // Seed existing committed delivery row under `inbound.key`
        yield* sql`INSERT INTO xtwork_im_delivery (key, thread_id, message_id, context_json, payload_json, settled)
          VALUES (${inbound.key}, 'xtwork-im-dm-replay', 'msg-1', ${JSON.stringify(storedCtx)}, ${JSON.stringify(inbound)}, 0)`;

        // Replaying the SAME key with bindingId but OMITTED leaderId/bindingEpoch MUST be rejected BEFORE dedupe!
        const missingFields = yield* dispatcher
          .accept({
            connectionId: "conn-feishu",
            platformMsgId: "pm-replay-1",
            chatId: "chat-dm",
            chatKind: "dm",
            senderRole: "owner",
            bindingId: binding.bindingId,
          })
          .pipe(Effect.result);
        expect(missingFields._tag).toBe("Failure");
        if (missingFields._tag === "Failure") {
          expect(missingFields.failure.message).toContain("mismatched Leader binding tuple");
        }

        // Replaying the SAME key with mismatched epoch MUST also be rejected!
        const wrongEpoch = yield* dispatcher
          .accept({
            connectionId: "conn-feishu",
            platformMsgId: "pm-replay-1",
            chatId: "chat-dm",
            chatKind: "dm",
            senderRole: "owner",
            leaderId: binding.leaderId,
            bindingId: binding.bindingId,
            bindingEpoch: 99,
          })
          .pipe(Effect.result);
        expect(wrongEpoch._tag).toBe("Failure");
      }).pipe(Effect.provide(fakeDeps)),
    );
  });

  it("shares one final operationKey across liveFinish and fallback reply and clears cached ACK on dropped send response (S17)", async () => {
    const inbound = inboundMessage({
      connectionId: "conn-feishu",
      platformMsgId: "pm-s17-drop",
      messageId: "m-s17-drop",
      chatId: "chat-1",
      chatKind: "dm",
      senderRole: "owner",
    });
    const threadId = "xtwork-im-dm-s17";
    const userMessageId = `xtwork-im:${hashArgs(inbound.key)}`;
    const settledKeys: string[] = [];
    const opKeysSeen: Array<{ method: string; operationKey: unknown }> = [];
    let platformSendCount = 0;
    let bridgeCommittedKey: string | null = null;
    let dropFirstReplyResponse = true;

    const fakeHost = {
      available: true,
      async request(method: string, params?: Record<string, unknown>) {
        if (method === "inbound.ack") {
          return { message: { state: bridgeCommittedKey ? "replied" : "delivered" } };
        }
        if (method === "messages.liveStart") {
          return { supported: true, liveId: "live-1" };
        }
        if (method === "messages.liveFinish") {
          opKeysSeen.push({ method, operationKey: params?.operationKey });
          // Simulate bridge committing liveFinish on platform, THEN dropping the RPC response!
          platformSendCount++;
          bridgeCommittedKey = String(params?.operationKey ?? "");
          throw new Error("The IM bridge disconnected.");
        }
        if (method === "messages.reply") {
          opKeysSeen.push({ method, operationKey: params?.operationKey });
          const opKey = String(params?.operationKey ?? "");
          if (bridgeCommittedKey === opKey) {
            return { result: { kind: "sent", platformId: "live-out-1" }, deduplicated: true };
          }
          platformSendCount++;
          bridgeCommittedKey = opKey;
          if (dropFirstReplyResponse) {
            dropFirstReplyResponse = false;
            throw new Error("The IM bridge disconnected.");
          }
          return { result: { kind: "sent", platformId: "out-1" } };
        }
        if (method === "inbound.settle") {
          return { moved: true, message: { state: "replied" } };
        }
        return {};
      },
    };

    let runStatus = "running";
    const fakeDispatch = {
      orchestrator: {
        getThreadRecords: () =>
          Effect.succeed({
            runs: [{ id: "run-s17-1", userMessageId, status: runStatus }],
            messages: [{ runId: "run-s17-1", role: "assistant", text: "Final output" }],
          }),
      },
      settle: (key: string) =>
        Effect.sync(() => {
          settledKeys.push(key);
        }),
    } as never;

    const { sync } = makeDeliverySync(fakeHost, fakeDispatch, () => false);
    const row = {
      key: inbound.key,
      threadId,
      contextJson: "{}",
      payloadJson: JSON.stringify(inbound),
    };

    // Tick 1 (running): starts live card
    await Effect.runPromise(sync(row));
    // Tick 2 (completed): liveFinish commits then drops response -> fallback reply uses SAME operationKey -> deduplicated!
    runStatus = "completed";
    await Effect.runPromise(sync(row));

    expect(platformSendCount).toBe(1);
    expect(settledKeys).toEqual([inbound.key]);
    expect(opKeysSeen).toEqual([
      { method: "messages.liveFinish", operationKey: `${inbound.key}:final` },
      { method: "messages.reply", operationKey: `${inbound.key}:final` },
    ]);
  });
});
