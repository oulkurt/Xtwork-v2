// @effect-diagnostics nodeBuiltinImport:off globalTimers:off globalDate:off globalJsonInEffect:off effectTryWithoutCatch:off
import { EnvironmentId, ProjectId, RuntimeRequestId, ThreadId } from "@t3tools/contracts";
import * as NodeSqliteClient from "@t3tools/shared/nodeSqliteClient";
import * as DateTime from "effect/DateTime";
import * as Effect from "effect/Effect";
import { mkdir, mkdtemp, readFile, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vite-plus/test";
import type { AgentAwarenessThread } from "../orchestration-v2/ProjectionStore.ts";
import { dispatchIdentity, inboundMessage, sameAudience } from "./XtworkImDispatch.ts";
import { imToolAllowed, runImTool } from "./XtworkImMcp.ts";
import { XtworkImMemory } from "./XtworkImMemory.ts";
import {
  DEFAULT_LEADER_ID,
  ImApprovals,
  canReuseProviderSession,
  desktopContext,
  evaluateThreadAccess,
  narrowDelegatedPolicy,
  normalizeExecutionContext,
  type Execution,
  type TurnExecutionContext,
} from "./XtworkImSecurity.ts";
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

        // Persist execution policy BEFORE launch
        const pol1 = yield* store.persistPolicyBeforeLaunch({
          commandId: "im:conn-feishu:msg-1",
          threadId: derivedThreadId,
          context: ctx1,
        });
        expect(store.isProtectedThreadSync(derivedThreadId)).toBe(true);
        expect(imToolAllowed(derivedThreadId, "im__reply", true, store.isProtectedThreadSync(derivedThreadId))).toBe(true);
        expect(imToolAllowed(derivedThreadId, "im__native_policy", true, store.isProtectedThreadSync(derivedThreadId))).toBe(false);
        expect(imToolAllowed(derivedThreadId, "im__native_policy", false, store.isProtectedThreadSync(derivedThreadId))).toBe(true);

        // Before runId attaches, freshly persisted unattached policy is valid
        expect(store.resolveProviderPolicySync(derivedThreadId, "run-1")).toEqual({
          protected: true,
          policyDigest: pol1.policyDigest,
          failClosed: false,
        });

        // Attach run-1
        yield* store.attachRunId("im:conn-feishu:msg-1", "run-1");
        expect(store.hasRunPolicySync({ runId: "run-1" })).toBe(true);
        expect(store.resolveProviderPolicySync(derivedThreadId, "run-1").failClosed).toBe(false);

        // A rogue/scheduled run on the SAME protected thread without its own persisted policy MUST fail closed!
        expect(store.hasRunPolicySync({ commandId: "scheduled-unpersisted-cmd" })).toBe(false);
        expect(store.resolveProviderPolicySync(derivedThreadId, "run-rogue")).toEqual({
          protected: true,
          policyDigest: null,
          failClosed: true,
        });

        // An unpersisted xtwork-im-* thread also fails closed
        expect(store.resolveProviderPolicySync("xtwork-im-group-unpersisted")).toEqual({
          protected: true,
          policyDigest: null,
          failClosed: true,
        });

        // Policy digest change forces fresh provider session
        const narrower = narrowDelegatedPolicy(ctx1, { isolatedWorkspaceRoot: "/tmp/ws/ops/sub" });
        expect(canReuseProviderSession(ctx1.policyDigest, narrower.policyDigest)).toBe(false);
        expect(canReuseProviderSession(ctx1.policyDigest, ctx1.policyDigest)).toBe(true);
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
      }).pipe(Effect.provide(NodeSqliteClient.layer({ filename: ":memory:" }))),
    );
  });

  it("binds group private-memory sharing to an exact content snapshot hash and never grants live read access", async () => {
    const dir = await mkdtemp(join(tmpdir(), "xtwork-snapshot-share-"));
    const memory = new XtworkImMemory(dir);
    await memory.write("private", "Q4 roadmap: launch Leader Slice 1.", "roadmap.md", DEFAULT_LEADER_ID);

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
    expect(req.contentPreview).toContain("launch Leader Slice 1");

    // 1. status_read summary MUST NEVER expose raw details or contentPreview
    const summary = approvals.listStatusSummary(new Set(["xtwork-im-group-team"]));
    expect(summary).toEqual({ totalCount: 1, countByThreadId: { "xtwork-im-group-team": 1 } });
    expect(JSON.stringify(summary)).not.toContain("Q4 roadmap");

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

  it("migrates legacy companion/ directory idempotently without clobbering existing Leader files", async () => {
    const dir = await mkdtemp(join(tmpdir(), "xtwork-legacy-migrate-"));
    await mkdir(join(dir, "private", "notes"), { recursive: true });
    await mkdir(join(dir, "groups", "g1"), { recursive: true });
    await writeFile(join(dir, "ROLE.md"), "Legacy role prompt", "utf8");
    await writeFile(join(dir, "private", "MEMORY.md"), "Legacy private memory", "utf8");
    await writeFile(join(dir, "private", "notes", "plan.md"), "Legacy note", "utf8");
    await writeFile(join(dir, "groups", "g1", "MEMORY.md"), "Legacy group memory", "utf8");

    const memory = new XtworkImMemory(dir);
    await memory.ensureMigrated(DEFAULT_LEADER_ID);

    expect(await memory.read("role", undefined, DEFAULT_LEADER_ID)).toBe("Legacy role prompt");
    expect(await memory.read("private", undefined, DEFAULT_LEADER_ID)).toBe("Legacy private memory");
    expect(await memory.read("private", "plan.md", DEFAULT_LEADER_ID)).toBe("Legacy note");
    expect(await memory.read("group:g1", undefined, DEFAULT_LEADER_ID)).toBe("Legacy group memory");

    // Mutate Leader's ROLE.md and re-run ensureMigrated -> MUST NOT overwrite newer Leader file!
    await memory.write("role", "Updated Leader role", undefined, DEFAULT_LEADER_ID);
    await memory.ensureMigrated(DEFAULT_LEADER_ID);
    expect(await memory.read("role", undefined, DEFAULT_LEADER_ID)).toBe("Updated Leader role");
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
        yield* store.persistPolicyBeforeLaunch({
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
        expect(reopened.resolveProviderPolicySync("derived-restart-thread", "run-restart-1").failClosed).toBe(false);
        expect(reopened.resolveProviderPolicySync("derived-restart-thread", "run-unknown").failClosed).toBe(true);
      }).pipe(Effect.provide(NodeSqliteClient.layer({ filename: dbPath }))),
    );
  });
});
