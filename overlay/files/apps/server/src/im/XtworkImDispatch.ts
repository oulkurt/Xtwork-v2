// @effect-diagnostics nodeBuiltinImport:off globalTimers:off globalDate:off globalDateInEffect:off globalJsonInEffect:off effectTryWithoutCatch:off globalErrorInEffectCatch:off globalErrorInEffectFailure:off effectFnOpportunity:off deterministicKeys:off matchBooleanToIsSuccess:off
import { CommandId, MessageId, RunId, ThreadId, type OrchestrationV2Run } from "@t3tools/contracts";
import * as Effect from "effect/Effect";
import * as Semaphore from "effect/Semaphore";
import * as SqlClient from "effect/sql/SqlClient";
import * as FileSystem from "effect/FileSystem";
import { join } from "node:path";
import { OrchestratorV2 } from "../orchestration-v2/Orchestrator.ts";
import { ManagedProjectFolders } from "../project/ManagedProjectFolders.ts";
import { ServerSettingsService } from "../serverSettings.ts";
import { PI_DRIVER, PI_INSTANCE_ID } from "../xtwork/bundledPiSettings.ts";
import { MODEL_PROVIDER, STANDARD_MODEL } from "../xtwork/gateway.ts";
import { type BridgePayload, isRecord } from "./XtworkImBridgeHost.ts";
import {
  DEFAULT_LEADER_ID,
  ImDispatchAuthority,
  LEADER_PAUSED_ERROR,
  containsLeaderPausedError,
  hashArgs,
  imError,
  normalizeExecutionContext,
  untrustedEnvelope,
  type Execution,
  type TurnExecutionContext,
} from "./XtworkImSecurity.ts";
import type { XtworkImMemory } from "./XtworkImMemory.ts";
import type { LeaderBindingRecord, LeaderStore } from "./XtworkLeaderStore.ts";

const serializeDelivery = (context: TurnExecutionContext, payload: BridgePayload) =>
  [JSON.stringify(context), JSON.stringify(payload)] as const;
export const decodeInbound = (json: string) => inboundMessage(JSON.parse(json));

export const activeStatuses = ["starting", "running", "waiting"] as const;
export const isTerminal = (status: OrchestrationV2Run["status"]) =>
  ["completed", "failed", "cancelled", "interrupted", "rolled_back"].includes(status);

export const inboundMessage = (payload: BridgePayload) => {
  const message = isRecord(payload.message) ? payload.message : payload;
  const connectionId = payload.connectionId ?? message.connectionId;
  const platformMsgId = message.platformMsgId ?? message.messageId ?? payload.platformMsgId;
  const chatId = message.chatId ?? payload.chatId;
  const chatKind = message.chatKind ?? payload.chatKind;
  const senderRole = payload.senderRole ?? message.senderRole;
  const replyAudience = payload.replyAudience ?? message.replyAudience;
  if (
    typeof connectionId !== "string" || !connectionId || connectionId.includes(":") ||
    typeof platformMsgId !== "string" || !platformMsgId ||
    typeof chatId !== "string" || !chatId ||
    (chatKind !== "dm" && chatKind !== "group" && chatKind !== "thread") ||
    (senderRole !== "owner" && senderRole !== "member" && senderRole !== "bot") ||
    (replyAudience !== undefined && replyAudience !== "owner_dm" && replyAudience !== "group")
  ) throw new Error("Invalid IM delivery metadata.");
  const key = `im:${connectionId}:${platformMsgId}`;
  if (payload.idempotencyKey !== undefined && payload.idempotencyKey !== key) {
    throw new Error("Invalid IM delivery key.");
  }
  const chatName =
    typeof payload.chatName === "string" && payload.chatName
      ? payload.chatName
      : typeof message.chatName === "string" && message.chatName
        ? message.chatName
        : undefined;
  const leaderId =
    typeof payload.leaderId === "string" && payload.leaderId
      ? payload.leaderId
      : typeof message.leaderId === "string" && message.leaderId
        ? message.leaderId
        : undefined;
  const bindingId =
    typeof payload.bindingId === "string" && payload.bindingId
      ? payload.bindingId
      : typeof message.bindingId === "string" && message.bindingId
        ? message.bindingId
        : undefined;
  const rawEpoch = payload.bindingEpoch ?? message.bindingEpoch;
  const bindingEpoch = typeof rawEpoch === "number" && Number.isInteger(rawEpoch) ? rawEpoch : undefined;
  return {
    key,
    connectionId,
    platformMsgId,
    chatId,
    ...(chatName ? { chatName } : {}),
    ...(leaderId ? { leaderId } : {}),
    ...(bindingId ? { bindingId } : {}),
    ...(bindingEpoch !== undefined ? { bindingEpoch } : {}),
    chatKind,
    senderRole,
    replyAudience: (replyAudience === "owner_dm" || replyAudience === undefined) && chatKind === "dm" && senderRole === "owner"
      ? "owner_dm"
      : "group",
    messageId: typeof message.messageId === "string" ? message.messageId : undefined,
    message,
  } as const;
};

type Route = ReturnType<typeof inboundMessage>;
type StoredDelivery = {
  readonly key: string;
  readonly threadId: string;
  readonly contextJson: string;
  readonly payloadJson: string;
};

export const dispatchIdentity = (
  route: Route,
  dataDir: string,
  linkedThreadId?: string,
  binding?: Pick<LeaderBindingRecord, "leaderId" | "bindingId" | "epoch">,
) => {
  const leaderId = binding?.leaderId ?? DEFAULT_LEADER_ID;
  const bindingId = binding?.bindingId ?? null;
  const bindingEpoch = binding?.epoch ?? null;
  const isGroup = route.chatKind !== "dm";
  const isOwnerPrivate = route.chatKind === "dm" && route.replyAudience === "owner_dm";
  const groupKey = hashArgs([route.connectionId, route.chatId]).slice(0, 32);
  const subkey = route.chatKind === "thread"
    ? route.chatId
    : isGroup
      ? route.message.topicId ?? route.message.rootId ?? route.message.threadRootId ?? route.platformMsgId
      : route.chatId;
  // Include bindingId + bindingEpoch when present so rebinding a connection to a new Leader
  // NEVER collides with or resumes an old binding's thread or Provider session (ADR-013 §1).
  const threadKeyParts = bindingId
    ? [leaderId, bindingId, bindingEpoch, route.connectionId, route.chatId, subkey]
    : [route.connectionId, route.chatId, subkey];
  const threadId = ThreadId.make(
    linkedThreadId ?? `xtwork-im-${isGroup ? "group" : "dm"}-${hashArgs(threadKeyParts).slice(0, 32)}`,
  );
  const context: TurnExecutionContext = normalizeExecutionContext({
    source: "im",
    leaderId,
    bindingId,
    bindingEpoch,
    connectionId: route.connectionId,
    chatId: route.chatId,
    chatKind: route.chatKind,
    senderRole: route.senderRole,
    replyAudience: route.replyAudience,
    isolatedWorkspaceRoot: join(dataDir, "workspaces", isOwnerPrivate ? "private" : groupKey, threadId),
    companionScope: isOwnerPrivate ? "private" : `group:${groupKey}`,
  });
  return { threadId, context };
};

export const sameAudience = (a: TurnExecutionContext, b: TurnExecutionContext) => {
  if (
    a.replyAudience !== b.replyAudience ||
    a.connectionId !== b.connectionId ||
    a.chatId !== b.chatId ||
    (a.leaderId ?? DEFAULT_LEADER_ID) !== (b.leaderId ?? DEFAULT_LEADER_ID)
  ) {
    return false;
  }
  const aBinding = a.bindingId ?? null;
  const bBinding = b.bindingId ?? null;
  const aEpoch = a.bindingEpoch ?? null;
  const bEpoch = b.bindingEpoch ?? null;
  if (aBinding === bBinding && aEpoch === bEpoch) return true;
  // S7: Allow legacy pre-ADR-013 rows (no bindingId/epoch, default Leader) to match
  // the initial default Leader binding (epoch 1) without weakening epoch >= 2 rebind isolation!
  const leader = a.leaderId ?? DEFAULT_LEADER_ID;
  if (leader !== DEFAULT_LEADER_ID) return false;
  const aLegacy = aBinding === null && aEpoch === null;
  const bLegacy = bBinding === null && bEpoch === null;
  return (aLegacy && bEpoch === 1) || (bLegacy && aEpoch === 1);
};

export { LEADER_PAUSED_ERROR };

export const makeDispatcher = Effect.fnUntraced(function* (
  dataDir: string,
  memory: XtworkImMemory,
  leaders: LeaderStore,
) {
  const sql = yield* SqlClient.SqlClient;
  const fs = yield* FileSystem.FileSystem;
  const orchestrator = yield* OrchestratorV2;
  const projects = yield* ManagedProjectFolders;
  const settings = yield* ServerSettingsService;
  const permits = yield* Semaphore.make(1);
  yield* sql`CREATE TABLE IF NOT EXISTS xtwork_im_delivery (
    key TEXT PRIMARY KEY, thread_id TEXT NOT NULL, message_id TEXT UNIQUE NOT NULL, context_json TEXT NOT NULL,
    payload_json TEXT NOT NULL, settled INTEGER NOT NULL DEFAULT 0
  )`;
  yield* sql`CREATE INDEX IF NOT EXISTS xtwork_im_delivery_thread ON xtwork_im_delivery(thread_id)`;

  const stored = (key: string) => sql<StoredDelivery>`
    SELECT key, thread_id AS "threadId", context_json AS "contextJson", payload_json AS "payloadJson"
    FROM xtwork_im_delivery WHERE key = ${key}`;
  const contextOf = (row: StoredDelivery): TurnExecutionContext =>
    normalizeExecutionContext(JSON.parse(row.contextJson) as TurnExecutionContext);
  const firstContext = (threadId: ThreadId) => sql<StoredDelivery>`
    SELECT context_json AS "contextJson" FROM xtwork_im_delivery WHERE thread_id = ${threadId} LIMIT 1
  `.pipe(Effect.map(([row]) => (row === undefined ? undefined : contextOf(row))));

  // S7: Backfill legacy ADR-011 delivery rows to the initial default Leader binding while
  // preserving their original thread_id and idempotency key untouched.
  const legacyRows = yield* sql<StoredDelivery>`
    SELECT key, thread_id AS "threadId", context_json AS "contextJson", payload_json AS "payloadJson"
    FROM xtwork_im_delivery
  `;
  for (const row of legacyRows) {
    const ctx = contextOf(row);
    if (!ctx.connectionId || ctx.bindingId) continue;
    const binding = yield* leaders.ensureBinding(ctx.connectionId, ctx.leaderId ?? DEFAULT_LEADER_ID);
    const migrated = normalizeExecutionContext({
      ...ctx,
      leaderId: binding.leaderId,
      bindingId: binding.bindingId,
      bindingEpoch: binding.epoch,
    });
    yield* sql`UPDATE xtwork_im_delivery SET context_json = ${JSON.stringify(migrated)} WHERE key = ${row.key}`;
    yield* leaders.registerLegacyProtectedThread(row.threadId, migrated);
  }

  const accept = (payload: BridgePayload, observedPauseGeneration?: number) => permits.withPermit(Effect.gen(function* () {
    const inbound = yield* Effect.try({ try: () => inboundMessage(payload), catch: imError });
    const commandId = CommandId.make(inbound.key);
    const [previous] = yield* stored(inbound.key);

    // S6: Validate any supplied binding tuple UNCONDITIONALLY BEFORE the dedupe path so even
    // replayed delivery keys with missing/mismatched `leaderId` or `bindingEpoch` are rejected!
    let binding: LeaderBindingRecord | undefined;
    const prevContext = previous ? contextOf(previous) : undefined;
    if (inbound.bindingId) {
      const stamped = yield* leaders.getBindingById(inbound.bindingId);
      if (
        !stamped ||
        stamped.connectionId !== inbound.connectionId ||
        inbound.leaderId === undefined ||
        stamped.leaderId !== inbound.leaderId ||
        inbound.bindingEpoch === undefined ||
        stamped.epoch !== inbound.bindingEpoch
      ) {
        return yield* imError("Rejected IM dispatch with mismatched Leader binding tuple.");
      }
      if (
        prevContext &&
        ((prevContext.leaderId ?? DEFAULT_LEADER_ID) !== stamped.leaderId ||
          (prevContext.bindingId != null && prevContext.bindingId !== stamped.bindingId) ||
          (prevContext.bindingEpoch != null && prevContext.bindingEpoch !== stamped.epoch))
      ) {
        return yield* imError("Rejected replayed IM dispatch whose binding tuple conflicts with stored delivery.");
      }
      binding = stamped;
    } else if (inbound.leaderId !== undefined || inbound.bindingEpoch !== undefined) {
      const expectedLeader = inbound.leaderId ?? DEFAULT_LEADER_ID;
      const expectedEpoch = inbound.bindingEpoch ?? 1;
      const historical = yield* leaders.findBindingByTuple(
        inbound.connectionId,
        expectedLeader,
        expectedEpoch,
      );
      if (historical) {
        binding = historical;
      } else if (!previous && expectedEpoch === 1 && !(yield* leaders.hasAnyBindingForConnection(inbound.connectionId))) {
        binding = yield* leaders.ensureBinding(inbound.connectionId, expectedLeader);
      } else if (
        previous &&
        (prevContext?.leaderId ?? DEFAULT_LEADER_ID) === expectedLeader &&
        (prevContext?.bindingEpoch == null || prevContext.bindingEpoch === expectedEpoch)
      ) {
        // Stored delivery already matches the historical tuple (e.g. legacy pre-sync delivery).
      } else {
        return yield* imError("Rejected IM dispatch whose stamped historical binding tuple does not exist.");
      }
      if (
        prevContext &&
        ((prevContext.leaderId ?? DEFAULT_LEADER_ID) !== expectedLeader ||
          (prevContext.bindingEpoch != null && prevContext.bindingEpoch !== expectedEpoch))
      ) {
        return yield* imError("Rejected replayed IM dispatch whose historical tuple conflicts with stored delivery.");
      }
    } else if (!previous) {
      binding = yield* leaders.ensureBinding(inbound.connectionId, DEFAULT_LEADER_ID);
    }
    const activeLeaderId = prevContext
      ? (prevContext.leaderId ?? DEFAULT_LEADER_ID)
      : (binding?.leaderId ?? DEFAULT_LEADER_ID);

    const requestedThread = typeof payload.threadId === "string" && payload.threadId.length > 0
      ? ThreadId.make(payload.threadId)
      : undefined;
    const desired = dispatchIdentity(inbound, dataDir, undefined, binding);
    const existingContext = requestedThread === undefined ? undefined : yield* firstContext(requestedThread);
    // Only reuse requestedThread if audience AND Leader binding + epoch match exactly!
    const identity = existingContext !== undefined && sameAudience(desired.context, existingContext)
      ? dispatchIdentity(inbound, dataDir, requestedThread, binding)
      : desired;
    const threadId = previous ? ThreadId.make(previous.threadId) : identity.threadId;
    const context = previous ? contextOf(previous) : identity.context;
    const messageId = MessageId.make(`xtwork-im:${hashArgs(inbound.key)}`);
    let turnId: RunId | undefined;
    if (previous) {
      const records = yield* orchestrator.getThreadRecords(threadId, ["messages"], { messageIds: [messageId] });
      turnId = records.messages.find((message) => message.id === messageId)?.runId ?? undefined;
      if (turnId) {
        yield* leaders.attachRunId(commandId, turnId);
      }
    }
    if (!turnId) {
      // S4/S21/S23: Whenever no committed run exists yet (including replays after an earlier failed
      // dispatch that saved a delivery row without committing a run), snapshot the target Leader's
      // pause generation and enforce both status and generation BEFORE creating a new turn!
      const startLeader = yield* leaders.getLeader(activeLeaderId);
      const expectedPauseGeneration = observedPauseGeneration ?? startLeader?.pauseGeneration ?? 0;
      if (
        startLeader?.status === "paused" ||
        (startLeader !== undefined && startLeader.pauseGeneration !== expectedPauseGeneration)
      ) {
        return yield* imError(`${LEADER_PAUSED_ERROR}: Leader is currently paused; new IM tasks are deferred.`);
      }
      const current = yield* settings.getSettings;
      if (settings.bundledPi === undefined || current.providerInstances[PI_INSTANCE_ID]?.driver !== PI_DRIVER ||
          current.providerInstances[PI_INSTANCE_ID]?.enabled === false) {
        return yield* imError("Remote conversations require the bundled Pi assistant.");
      }
      yield* fs.makeDirectory(context.isolatedWorkspaceRoot!, { recursive: true, mode: 0o700 });

      // ADR-013 §2 + S23: Persist the run's execution policy and pause generation BEFORE Orchestrator dispatches!
      yield* leaders.persistPolicyBeforeLaunch({ commandId, threadId, context, expectedPauseGeneration });

      const [contextJson, payloadJson] = serializeDelivery(context, payload);
      yield* sql`INSERT INTO xtwork_im_delivery (key, thread_id, message_id, context_json, payload_json)
        VALUES (${inbound.key}, ${threadId}, ${messageId}, ${contextJson}, ${payloadJson})
        ON CONFLICT(key) DO NOTHING`;
      const leaderId = context.leaderId ?? DEFAULT_LEADER_ID;
      const role = yield* Effect.tryPromise({ try: () => memory.read("role", undefined, leaderId), catch: imError });
      const memories = yield* Effect.tryPromise({
        try: () => memory.read(context.companionScope, undefined, leaderId),
        catch: imError,
      });
      const modelSelection = { instanceId: PI_INSTANCE_ID, model: `${MODEL_PROVIDER}/${STANDARD_MODEL}` };
      const content = typeof payload.formatted === "string"
        ? payload.formatted
        : typeof payload.body === "string"
          ? payload.body
          : inbound.message;
      const text = [
        role ? `Companion role:\n${role}` : "",
        memories ? `Companion notes:\n${untrustedEnvelope(memories, context)}` : "",
        untrustedEnvelope(content, context),
      ].filter(Boolean).join("\n\n");
      const initialMessage = { messageId, text, attachments: [] };
      // S22/S23: Re-check Leader status AND pause_generation immediately before dispatching
      // (in addition to the atomic SQLite check inside `EventSink.commitCommand` -> `bindRunPolicySql`)
      // so a pause -> resume cycle cannot let an earlier in-flight dispatch bypass the paused backlog!
      const latestLeader = yield* leaders.getLeader(activeLeaderId);
      if (
        latestLeader?.status === "paused" ||
        (latestLeader !== undefined && latestLeader.pauseGeneration !== expectedPauseGeneration)
      ) {
        return yield* imError(`${LEADER_PAUSED_ERROR}: Leader pause state changed during dispatch; IM task deferred.`);
      }
      const thread = yield* orchestrator.getThreadShell(threadId);
      const result = yield* (thread === null
        ? Effect.gen(function* () {
            const { projectId } = yield* projects.ensureScratchProject;
            return yield* orchestrator.dispatch({
              type: "thread.create", commandId, threadId, projectId,
              title: context.replyAudience === "owner_dm" ? "IM · 私聊" : context.chatKind === "dm" ? "IM · 联系人私聊" : "IM · 群聊任务",
              modelSelection, worktreePath: context.isolatedWorkspaceRoot!, branch: null,
              runtimeMode: "approval-required", interactionMode: "default", createdBy: "user", creationSource: "server", initialMessage,
            });
          })
        : orchestrator.dispatch({
            type: "message.dispatch", createdBy: "user", creationSource: "server", commandId, threadId, ...initialMessage, modelSelection,
            dispatchMode: { type: "queue_after_active" },
          })).pipe(
        Effect.provideService(ImDispatchAuthority, true),
        Effect.mapError((cause) =>
          containsLeaderPausedError(cause)
            ? imError(`${LEADER_PAUSED_ERROR}: Leader is currently paused; new IM tasks are deferred.`)
            : cause,
        ),
      );
      const created = result.storedEvents.find(({ event }) => event.type === "run.created")?.event;
      turnId = created?.type === "run.created" ? created.payload.id : undefined;
      if (turnId) {
        yield* leaders.attachRunId(commandId, turnId);
      }
    }
    if (!turnId) return yield* imError("No committed IM turn was found.");
    return { threadId, turnId, inbound };
  }));

  /**
   * Resolve persisted per-run execution policy for MCP tool enforcement and approval checks (S1).
   * Strictly requires an explicit `runId` bound in `xtwork_run_policies` for the exact `threadId`
   * and an active run on that thread. NEVER falls back to `runs.at(-1)` or unverified delivery rows.
   */
  const resolveExecution = Effect.fnUntraced(function* (threadId: ThreadId, explicitRunId?: RunId) {
    if (!explicitRunId) return undefined;
    const persisted = yield* leaders.resolvePolicy({ runId: explicitRunId });
    if (!persisted || persisted.threadId !== threadId) return undefined;

    const records = yield* orchestrator.getThreadRecords(threadId, ["runs"], { runStatuses: activeStatuses });
    const run = records.runs.find((candidate) => candidate.id === explicitRunId);
    if (run === undefined) return undefined;

    const [row] = yield* sql<StoredDelivery>`
      SELECT context_json AS "contextJson", key, payload_json AS "payloadJson" FROM xtwork_im_delivery
      WHERE key = ${persisted.commandId} AND thread_id = ${threadId} LIMIT 1`;
    const inbound = row ? decodeInbound(row.payloadJson) : undefined;
    return {
      turnId: run.id,
      threadId,
      context: persisted.context,
      ...(inbound ? { inbound } : {}),
    } as Execution & { readonly inbound?: Route };
  });

  const settle = (key: string) => sql`UPDATE xtwork_im_delivery SET settled = 1 WHERE key = ${key}`.pipe(Effect.asVoid);
  const unsettled = sql<StoredDelivery>`
    SELECT key, thread_id AS "threadId", context_json AS "contextJson", payload_json AS "payloadJson"
    FROM xtwork_im_delivery WHERE settled = 0
  `;
  const unsettledForChat = (connectionId: string, chatId: string) => sql<{ readonly threadId: string; readonly payloadJson: string }>`
    SELECT thread_id AS "threadId", payload_json AS "payloadJson"
    FROM xtwork_im_delivery WHERE settled = 0
  `.pipe(Effect.map((rows) => rows.filter((row) => {
    try {
      const inbound = decodeInbound(row.payloadJson);
      return inbound.connectionId === connectionId && inbound.chatId === chatId;
    } catch {
      return false;
    }
  })));

  return {
    accept,
    firstContext,
    orchestrator,
    projects,
    leaders,
    resolveExecution,
    settle,
    stored,
    unsettled,
    unsettledForChat,
  };
});

export type ImDispatcher = Effect.Success<ReturnType<typeof makeDispatcher>>;
