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
import { ImDispatchAuthority, hashArgs, imError, untrustedEnvelope, type Execution, type TurnExecutionContext } from "./XtworkImSecurity.ts";
import type { XtworkImMemory } from "./XtworkImMemory.ts";

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
  return {
    key,
    connectionId,
    platformMsgId,
    chatId,
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

export const dispatchIdentity = (route: Route, dataDir: string, linkedThreadId?: string) => {
  const isGroup = route.chatKind !== "dm";
  const isOwnerPrivate = route.chatKind === "dm" && route.replyAudience === "owner_dm";
  const groupKey = hashArgs([route.connectionId, route.chatId]).slice(0, 32);
  const subkey = route.chatKind === "thread"
    ? route.chatId
    : isGroup
      ? route.message.topicId ?? route.message.rootId ?? route.message.threadRootId ?? route.platformMsgId
      : route.chatId;
  const threadId = ThreadId.make(linkedThreadId ?? `xtwork-im-${isGroup ? "group" : "dm"}-${hashArgs([route.connectionId, route.chatId, subkey]).slice(0, 32)}`);
  const context: TurnExecutionContext = Object.freeze({
    source: "im",
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

export const sameAudience = (a: TurnExecutionContext, b: TurnExecutionContext) =>
  a.replyAudience === b.replyAudience && a.connectionId === b.connectionId && a.chatId === b.chatId;

export const makeDispatcher = Effect.fnUntraced(function* (dataDir: string, memory: XtworkImMemory) {
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
  const contextOf = (row: StoredDelivery): TurnExecutionContext => Object.freeze(JSON.parse(row.contextJson));
  const firstContext = (threadId: ThreadId) => sql<StoredDelivery>`
    SELECT context_json AS "contextJson" FROM xtwork_im_delivery WHERE thread_id = ${threadId} LIMIT 1
  `.pipe(Effect.map(([row]) => row === undefined ? undefined : contextOf(row)));

  const accept = (payload: BridgePayload) => permits.withPermit(Effect.gen(function* () {
    const inbound = yield* Effect.try({ try: () => inboundMessage(payload), catch: imError });
    const commandId = CommandId.make(inbound.key);
    const [previous] = yield* stored(inbound.key);
    const requestedThread = typeof payload.threadId === "string" && payload.threadId.startsWith("xtwork-im-")
      ? ThreadId.make(payload.threadId)
      : undefined;
    const desired = dispatchIdentity(inbound, dataDir);
    const existingContext = requestedThread === undefined ? undefined : yield* firstContext(requestedThread);
    const identity = existingContext !== undefined && sameAudience(desired.context, existingContext)
      ? dispatchIdentity(inbound, dataDir, requestedThread)
      : desired;
    const threadId = previous ? ThreadId.make(previous.threadId) : identity.threadId;
    const context = previous ? contextOf(previous) : identity.context;
    const messageId = MessageId.make(`xtwork-im:${hashArgs(inbound.key)}`);
    let turnId: RunId | undefined;
    if (previous) {
      const records = yield* orchestrator.getThreadRecords(threadId, ["messages"], { messageIds: [messageId] });
      turnId = records.messages.find((message) => message.id === messageId)?.runId ?? undefined;
    }
    if (!turnId) {
      const current = yield* settings.getSettings;
      if (settings.bundledPi === undefined || current.providerInstances[PI_INSTANCE_ID]?.driver !== PI_DRIVER ||
          current.providerInstances[PI_INSTANCE_ID]?.enabled === false) {
        return yield* imError("Remote conversations require the bundled Pi assistant.");
      }
      yield* fs.makeDirectory(context.isolatedWorkspaceRoot!, { recursive: true, mode: 0o700 });
      const [contextJson, payloadJson] = serializeDelivery(context, payload);
      yield* sql`INSERT INTO xtwork_im_delivery (key, thread_id, message_id, context_json, payload_json)
        VALUES (${inbound.key}, ${threadId}, ${messageId}, ${contextJson}, ${payloadJson})
        ON CONFLICT(key) DO NOTHING`;
      const role = yield* Effect.tryPromise({ try: () => memory.read("role"), catch: imError });
      const memories = yield* Effect.tryPromise({ try: () => memory.read(context.companionScope), catch: imError });
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
          })).pipe(Effect.provideService(ImDispatchAuthority, true));
      const created = result.storedEvents.find(({ event }) => event.type === "run.created")?.event;
      turnId = created?.type === "run.created" ? created.payload.id : undefined;
    }
    if (!turnId) return yield* imError("No committed IM turn was found.");
    return { threadId, turnId, inbound };
  }));

  const resolveExecution = Effect.fnUntraced(function* (threadId: ThreadId) {
    const records = yield* orchestrator.getThreadRecords(threadId, ["runs"], { runStatuses: activeStatuses });
    const run = records.runs.at(-1);
    if (run === undefined) return undefined;
    const [row] = yield* sql<StoredDelivery>`
      SELECT context_json AS "contextJson", key, payload_json AS "payloadJson" FROM xtwork_im_delivery
      WHERE thread_id = ${threadId} AND message_id = ${run.userMessageId}`;
    if (row === undefined) return undefined;
    return { turnId: run.id, context: contextOf(row), inbound: decodeInbound(row.payloadJson) } as Execution & { inbound: Route };
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

  return { accept, firstContext, orchestrator, resolveExecution, settle, stored, unsettled, unsettledForChat };
});

export type ImDispatcher = Effect.Success<ReturnType<typeof makeDispatcher>>;
