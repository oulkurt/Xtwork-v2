// @effect-diagnostics nodeBuiltinImport:off globalTimers:off globalDate:off globalDateInEffect:off globalJsonInEffect:off effectTryWithoutCatch:off globalErrorInEffectCatch:off globalErrorInEffectFailure:off effectFnOpportunity:off deterministicKeys:off matchBooleanToIsSuccess:off
import { AuthOrchestrationOperateScope, AuthOrchestrationReadScope, CommandId, RunId, ThreadId } from "@t3tools/contracts";
import * as ByteSize from "effect/ByteSize";
import * as Clock from "effect/Clock";
import * as Context from "effect/Context";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Option from "effect/Option";
import * as Queue from "effect/Queue";
import * as Schedule from "effect/Schedule";
import * as Semaphore from "effect/Semaphore";
import { Headers, HttpRouter, HttpServerRequest, HttpServerResponse } from "effect/http";
import { randomUUID } from "node:crypto";
import { EnvironmentAuth, parseBearerToken } from "../auth/EnvironmentAuth.ts";
import { OrchestratorV2 } from "../orchestration-v2/Orchestrator.ts";
import { ProjectionStoreV2 } from "../orchestration-v2/ProjectionStore.ts";
import { ManagedProjectFolders } from "../project/ManagedProjectFolders.ts";
import { forkParked } from "../serverActivation.ts";
import { PI_INSTANCE_ID } from "../xtwork/bundledPiSettings.ts";
import { MODEL_PROVIDER, STANDARD_MODEL } from "../xtwork/gateway.ts";
import { bridgeOptions, type BridgePayload, isRecord, XtworkImBridgeHost } from "./XtworkImBridgeHost.ts";
import { activeStatuses, decodeInbound, isTerminal, makeDispatcher, type ImDispatcher } from "./XtworkImDispatch.ts";
import { MAX_COMPANION_FILE_BYTES, XtworkImMemory, memoryScope } from "./XtworkImMemory.ts";
import {
  DEFAULT_LEADER_ID,
  containsLeaderArchivedError,
  containsLeaderPausedError,
  desktopContext,
  hashArgs,
  imError,
  ImApprovals,
  isImThread,
  normalizeExecutionContext,
  resolveProgressReportMode,
  sanitizeImDelegationPolicy,
  untrustedEnvelope,
  type AwarenessScope,
  type ImDelegationPolicy,
  type ImError,
  type ImProgressReportMode,
  type ReplyAudience,
  type TurnExecutionContext,
} from "./XtworkImSecurity.ts";
import { makeLeaderStore, sanitizeBindingPlatform, type LeaderStore, type PersistedRunPolicy, type ProviderPolicyState } from "./XtworkLeaderStore.ts";
import { buildOwnerNeedsYou, redactDiagnosticText } from "./XtworkLeaderAwareness.ts";

export interface XtworkPolicyHook {
  readonly isProtectedThread: (threadId: string | undefined) => boolean;
  readonly resolveProviderPolicy: (
    threadId: string,
    runId?: string | null,
    resumingNativeThreadId?: string | null,
  ) => ProviderPolicyState;
  readonly hasPersistedRunPolicy: (query: { readonly runId?: string | null; readonly commandId?: string | null; readonly threadId?: string | null }) => boolean;
  readonly bindRunPolicyInTxn: (
    commandId: string,
    threadId: string,
    runId: string,
  ) => Effect.Effect<PersistedRunPolicy, ImError>;
  readonly publishBoundRunPolicySync: (record: PersistedRunPolicy) => void;
  readonly recordNativeThreadPolicy: (
    threadId: string,
    nativeThreadId: string,
    policyDigest: string,
  ) => Effect.Effect<void, ImError>;
  readonly getProtectedContext: (threadId: string | undefined) => TurnExecutionContext | undefined;
}

let activePolicyHook: XtworkPolicyHook | undefined;

export function setActiveXtworkPolicyHook(hook: XtworkPolicyHook | undefined): void {
  activePolicyHook = hook;
}

export function isProtectedXtworkThread(threadId: string | undefined): boolean {
  if (!threadId) return false;
  if (activePolicyHook) return activePolicyHook.isProtectedThread(threadId);
  return isImThread(threadId);
}

export function resolveXtworkProviderPolicy(
  threadId: string,
  runId?: string | null,
  resumingNativeThreadId?: string | null,
): ProviderPolicyState {
  if (activePolicyHook) return activePolicyHook.resolveProviderPolicy(threadId, runId, resumingNativeThreadId);
  if (isImThread(threadId)) {
    return { protected: true, policyDigest: null, failClosed: true, policyChanged: false };
  }
  return { protected: false, policyDigest: null, failClosed: false, policyChanged: false };
}

export function hasPersistedXtworkRunPolicy(query: { readonly runId?: string | null; readonly commandId?: string | null; readonly threadId?: string | null }): boolean {
  if (activePolicyHook) return activePolicyHook.hasPersistedRunPolicy(query);
  return false;
}

export function bindXtworkRunPolicyInTxn(
  commandId: string,
  threadId: string,
  runId: string,
): Effect.Effect<PersistedRunPolicy | undefined, ImError> {
  if (activePolicyHook) return activePolicyHook.bindRunPolicyInTxn(commandId, threadId, runId);
  if (isImThread(threadId)) {
    return Effect.fail(imError("Protected run refused: Leader policy service is unavailable."));
  }
  return Effect.undefined;
}

export function publishXtworkBoundRunPolicySync(record: PersistedRunPolicy): void {
  activePolicyHook?.publishBoundRunPolicySync(record);
}

export function recordXtworkNativeThreadPolicy(
  threadId: string,
  nativeThreadId: string,
  policyDigest: string,
): Effect.Effect<void, ImError> {
  if (activePolicyHook) return activePolicyHook.recordNativeThreadPolicy(threadId, nativeThreadId, policyDigest);
  return Effect.void;
}

interface ImService {
  readonly host?: XtworkImBridgeHost;
  readonly memory?: XtworkImMemory;
  readonly dispatch?: ImDispatcher;
  readonly leaders?: LeaderStore;
  readonly projection?: ProjectionStoreV2["Service"];
  readonly orchestrator?: OrchestratorV2["Service"];
  readonly projects?: ManagedProjectFolders["Service"];
  readonly approvals: ImApprovals;
  readonly pendingBindingSyncs?: Map<string, string>;
  readonly markReplySucceeded: (turnId: string) => void;
  readonly hasReplySucceeded: (turnId: string) => boolean;
  readonly eventsSince: (after: number) => ReadonlyArray<BridgeEvent>;
}

interface BridgeEvent {
  readonly sequence: number;
  readonly event: string;
  readonly payload: BridgePayload;
}

export class XtworkIm extends Context.Service<XtworkIm, ImService>()("t3/im/XtworkImService/XtworkIm") {}

const tryWork = <A>(work: (signal: AbortSignal) => Promise<A>) =>
  Effect.tryPromise({ try: work, catch: imError });

const call = (host: XtworkImBridgeHost, method: string, params: BridgePayload) =>
  tryWork((signal) => host.request(method, params, signal));

const TERMINAL_BRIDGE_STATES = new Set(["replied", "ignored", "blocked", "unanswered", "failed"]);
const TEMPORARY_BRIDGE_ERROR_CODES = new Set(["CONNECTION_OFFLINE", "CONNECTION_INACTIVE"]);
const PERMANENT_BRIDGE_ERROR_CODES = new Set([
  "CHAT_BLOCKED",
  "CHAT_NOT_FOUND",
  "MESSAGE_NOT_FOUND",
  "CONNECTION_NOT_FOUND",
  "INVALID_PARAMS",
]);

export type DeliverySendOutcome = "sent" | "temporary_failure" | "permanent_failure";

export function classifyDeliverySendOutcome(
  response: unknown,
  error?: { readonly code?: string | undefined; readonly message?: string | undefined },
): DeliverySendOutcome {
  if (error !== undefined) {
    if (error.code && PERMANENT_BRIDGE_ERROR_CODES.has(error.code)) return "permanent_failure";
    if (error.code && TEMPORARY_BRIDGE_ERROR_CODES.has(error.code)) return "temporary_failure";
    // Disconnected bridge, abort, timeout, or unknown transient RPC error -> retry rather than falsely settling!
    return "temporary_failure";
  }
  if (isRecord(response) && isRecord(response.result)) {
    const kind = String(response.result.kind ?? "");
    if (kind === "sent" || kind === "uncertain") return "sent";
    if (kind === "failed") {
      return response.result.retryable === true ? "temporary_failure" : "permanent_failure";
    }
  }
  return "temporary_failure";
}

export interface DeliveryWorkerHost {
  readonly available: boolean;
  request(method: string, params?: BridgePayload, signal?: AbortSignal): Promise<unknown>;
}

export const makeDeliverySync = (
  host: DeliveryWorkerHost,
  dispatch: Pick<ImDispatcher, "orchestrator" | "settle">,
  hasReplySucceeded: (turnId: string) => boolean,
  resolveProgressMode?: (context: TurnExecutionContext) => ImProgressReportMode,
  hasPendingApproval?: (runId: string) => boolean,
) => {
  const live = new Map<string, { text: string; liveId: string | null }>();
  const ackedInBridge = new Set<string>();
  const blockedNotified = new Set<string>();
  const clearCaches = () => {
    live.clear();
    ackedInBridge.clear();
    blockedNotified.clear();
  };
  const parseContextSafe = (raw: string): TurnExecutionContext | undefined => {
    try {
      return normalizeExecutionContext(JSON.parse(raw) as TurnExecutionContext);
    } catch {
      return undefined;
    }
  };
  const sync = Effect.fnUntraced(function* (row: Effect.Success<ImDispatcher["unsettled"]>[number]) {
    const inbound = decodeInbound(row.payloadJson);
    const threadId = ThreadId.make(row.threadId);
    const messageId = `xtwork-im:${hashArgs(inbound.key)}`;
    const records = yield* dispatch.orchestrator.getThreadRecords(threadId, ["runs", "messages"]);
    const run = records.runs.find((run) => run.userMessageId === messageId);
    if (run === undefined) return;
    // S3: Reconcile any lost `inbound.ack` FIRST so a committed run stranded in `paused_pending`
    // or `received` transitions to `delivered` before sending or settling its reply!
    if (!ackedInBridge.has(inbound.key)) {
      const ackRes = yield* tryWork((signal) =>
        host.request(
          "inbound.ack",
          {
            idempotencyKey: inbound.key,
            t3ThreadId: threadId,
            t3TurnId: run.id,
          },
          signal,
        ),
      ).pipe(Effect.match({ onFailure: () => undefined, onSuccess: (value) => value }));
      if (ackRes === undefined) return;
      const ackedState =
        isRecord(ackRes) && isRecord(ackRes.message) && typeof ackRes.message.state === "string"
          ? ackRes.message.state
          : "";
      if (TERMINAL_BRIDGE_STATES.has(ackedState)) {
        live.delete(inbound.key);
        ackedInBridge.delete(inbound.key);
        yield* dispatch.settle(inbound.key);
        return;
      }
      ackedInBridge.add(inbound.key);
    }
    const text = records.messages.filter((message) => message.runId === run.id && message.role === "assistant")
      .map((message) => message.text).filter(Boolean).join("\n\n");
    const current = live.get(inbound.key);
    const alreadyReplied = hasReplySucceeded(run.id);
    if (isTerminal(run.status)) {
      const finalText = text || current?.text || "";
      // S17: One idempotent operationKey shared by liveFinish AND fallback messages.reply so a
      // dropped RPC response after bridge commits a send NEVER triggers a duplicate reply!
      const finalOperationKey = `${inbound.key}:final`;
      let replied = alreadyReplied;
      let sendOutcome: "not_needed" | DeliverySendOutcome = alreadyReplied ? "sent" : "not_needed";
      if (!alreadyReplied && current?.liveId) {
        const finished = yield* tryWork((signal) =>
          host.request(
            "messages.liveFinish",
            {
              liveId: current.liveId,
              markdown: finalText,
              operationKey: finalOperationKey,
            },
            signal,
          ),
        ).pipe(Effect.result);
        const finishOutcome =
          finished._tag === "Success"
            ? classifyDeliverySendOutcome(finished.success)
            : classifyDeliverySendOutcome(undefined, finished.failure);
        if (finishOutcome === "sent") {
          replied = true;
          sendOutcome = "sent";
        } else if (finalText && inbound.messageId) {
          const fallback = yield* tryWork((signal) =>
            host.request(
              "messages.reply",
              {
                messageId: inbound.messageId,
                text: finalText,
                operationKey: finalOperationKey,
              },
              signal,
            ),
          ).pipe(Effect.result);
          sendOutcome =
            fallback._tag === "Success"
              ? classifyDeliverySendOutcome(fallback.success)
              : classifyDeliverySendOutcome(undefined, fallback.failure);
          replied = sendOutcome === "sent";
        } else {
          sendOutcome = finishOutcome;
        }
      } else if (!alreadyReplied && finalText && inbound.messageId) {
        const replyRes = yield* tryWork((signal) =>
          host.request(
            "messages.reply",
            {
              messageId: inbound.messageId,
              text: finalText,
              operationKey: finalOperationKey,
            },
            signal,
          ),
        ).pipe(Effect.result);
        sendOutcome =
          replyRes._tag === "Success"
            ? classifyDeliverySendOutcome(replyRes.success)
            : classifyDeliverySendOutcome(undefined, replyRes.failure);
        replied = sendOutcome === "sent";
      }
      // S3/S17: Keep temporary send failures (e.g. CONNECTION_OFFLINE, dropped response, network)
      // pending for retry and drop cached ACK so the next tick re-checks bridge state!
      if (sendOutcome === "temporary_failure") {
        ackedInBridge.delete(inbound.key);
        if (!replied && current?.liveId) {
          live.delete(inbound.key);
        }
        return;
      }
      live.delete(inbound.key);
      // S3: NEVER settle as "reply" unless a send actually succeeded (sent/uncertain) or alreadyReplied!
      const event = replied
        ? "reply"
        : sendOutcome === "permanent_failure" || run.status === "failed"
          ? "fail"
          : "give_up";
      const settled = yield* tryWork((signal) =>
        host.request("inbound.settle", { idempotencyKey: inbound.key, event }, signal),
      );
      const bridgeMoved = isRecord(settled) && settled.moved === true;
      const bridgeState =
        isRecord(settled) && isRecord(settled.message) && typeof settled.message.state === "string"
          ? settled.message.state
          : "";
      // S3: Only mark local delivery settled once bridge confirms settlement or terminal state!
      if (!bridgeMoved && !TERMINAL_BRIDGE_STATES.has(bridgeState)) {
        ackedInBridge.delete(inbound.key);
        return;
      }
      ackedInBridge.delete(inbound.key);
      blockedNotified.delete(inbound.key);
      yield* dispatch.settle(inbound.key);
      return;
    }
    const rowContext = parseContextSafe(row.contextJson);
    const reportMode: ImProgressReportMode =
      resolveProgressMode && rowContext ? resolveProgressMode(rowContext) : "phase_summary";
    const isBlocked =
      run.status === "waiting" ||
      (run.status === "running" && (hasPendingApproval?.(run.id) ?? false));
    if (
      !alreadyReplied &&
      isBlocked &&
      reportMode === "completion_and_blocked" &&
      !blockedNotified.has(inbound.key)
    ) {
      const sent = yield* tryWork((signal) =>
        host.request(
          "messages.send",
          {
            chatId: inbound.chatId,
            text: "任务等待桌面确认中，完成后将继续回报结果。",
            operationKey: `${inbound.key}:blocked`,
            preserveInboundState: true,
          },
          signal,
        ),
      ).pipe(Effect.result);
      if (sent._tag === "Success" && classifyDeliverySendOutcome(sent.success) === "sent") {
        blockedNotified.add(inbound.key);
      }
      return;
    }
    if (reportMode !== "phase_summary") return;
    if (alreadyReplied || run.status !== "running" || !text || text === current?.text) return;
    if (current === undefined) {
      const result = yield* tryWork((signal) =>
        host.request(
          "messages.liveStart",
          {
            chatId: inbound.chatId,
            replyTo: inbound.messageId ?? inbound.platformMsgId,
            initial: text,
            operationKey: `${inbound.key}:live`,
          },
          signal,
        ),
      ).pipe(Effect.match({ onFailure: () => undefined, onSuccess: (value) => value }));
      if (isRecord(result) && result.supported === true && typeof result.liveId === "string") {
        live.set(inbound.key, { text, liveId: result.liveId });
      } else if (isRecord(result) && result.supported === false) {
        live.set(inbound.key, { text, liveId: null });
      }
    } else if (current.liveId !== null) {
      yield* tryWork((signal) =>
        host.request("messages.liveUpdate", { liveId: current.liveId, markdown: text }, signal),
      );
      current.text = text;
    } else {
      current.text = text;
    }
  });
  return { sync, clearCaches };
};

const callHost = (host: DeliveryWorkerHost, method: string, params: BridgePayload) =>
  tryWork((signal) => host.request(method, params, signal));

const isConnectionClaimed = (conn: Record<string, unknown>): boolean => {
  if (conn.stateDetail === "disconnected") return false;
  if (conn.lifecycleState === "pairing" || conn.lifecycleState === "idle") return false;
  return conn.lifecycleState === "active" || (conn.lifecycleState === undefined && conn.state === "connected");
};

export const makeBridgeEventHandler = (
  host: DeliveryWorkerHost,
  dispatch: ImDispatcher,
  leaders: LeaderStore,
) =>
  Effect.fnUntraced(function* ({ event, payload }: BridgeEvent) {
    if (event === "connection.state") {
      const connId = typeof payload.connectionId === "string" ? payload.connectionId : "";
      const connPlatform = sanitizeBindingPlatform(payload.platform) ?? undefined;
      if (connId && payload.stateDetail === "disconnected") {
        yield* leaders.deactivateBindingOnDisconnect(connId, connPlatform, false).pipe(Effect.ignore);
        return;
      }
      if (connId && host.available) {
        const claimed = isConnectionClaimed(payload);
        const binding = yield* leaders
          .ensureBinding(connId, DEFAULT_LEADER_ID, connPlatform, claimed)
          .pipe(Effect.orElseSucceed(() => undefined));
        if (!binding) return;
        const ownerLeader = yield* leaders.getLeader(binding.leaderId);
        const desiredPaused = ownerLeader?.status === "paused";
        const needsSync =
          payload.leaderId !== binding.leaderId ||
          payload.bindingId !== binding.bindingId ||
          payload.bindingEpoch !== binding.epoch ||
          Boolean(payload.leaderPaused) !== desiredPaused;
        if (needsSync) {
          const ownerPauseGen = ownerLeader?.pauseGeneration ?? 0;
          const ownerPauseVer = ownerLeader?.pauseVersion ?? 0;
          yield* callHost(host, "connections.syncBindings", {
            bindings: [
              {
                connectionId: connId,
                leaderId: binding.leaderId,
                bindingId: binding.bindingId,
                bindingEpoch: binding.epoch,
                leaderPaused: desiredPaused,
                pauseGeneration: ownerPauseGen,
                pauseVersion: ownerPauseVer,
              },
            ],
            leaderStates: {
              [binding.leaderId]: {
                paused: desiredPaused,
                pauseGeneration: ownerPauseGen,
                pauseVersion: ownerPauseVer,
              },
            },
            leaderPauseGenerations: { [binding.leaderId]: ownerPauseGen },
            leaderPausedById: { [binding.leaderId]: desiredPaused },
            leaderPauseVersions: { [binding.leaderId]: ownerPauseVer },
          }).pipe(Effect.ignore);
        }
      }
      return;
    }
    if (event === "inbound.dispatch") {
      // S23: Trust ONLY the bridge-stamped `pauseGeneration` (captured when the bridge emitted
      // this dispatch) — never re-stamp with T3's newer generation on ingress!
      const bridgePauseGen =
        typeof payload.pauseGeneration === "number" && Number.isInteger(payload.pauseGeneration)
          ? payload.pauseGeneration
          : undefined;
      const accepted = yield* dispatch.accept(payload, bridgePauseGen).pipe(Effect.result);
      if (accepted._tag === "Failure") {
        // S4/S14/S23: If a trigger raced with Leader pause (or pause -> resume), defer ONLY the
        // stamped inbound message and sync the connection's CURRENT active binding + pauseGeneration.
        if (containsLeaderPausedError(accepted.failure) || containsLeaderArchivedError(accepted.failure)) {
          const isArchived = containsLeaderArchivedError(accepted.failure);
          const connId = typeof payload.connectionId === "string" ? payload.connectionId : undefined;
          const idempotencyKey = typeof payload.idempotencyKey === "string" ? payload.idempotencyKey : undefined;
          if (idempotencyKey) {
            yield* callHost(host, "inbound.settle", {
              idempotencyKey,
              event: isArchived ? "fail" : "pause",
            }).pipe(Effect.ignore);
          }
          if (connId) {
            const activeBinding = yield* leaders.activeBindingForConnection(connId).pipe(Effect.orElseSucceed(() => undefined));
            const currentBinding =
              activeBinding ?? (yield* leaders.ensureBinding(connId, DEFAULT_LEADER_ID).pipe(Effect.orElseSucceed(() => undefined)));
            if (currentBinding) {
              const currentLeader = yield* leaders.getLeader(currentBinding.leaderId).pipe(Effect.orElseSucceed(() => undefined));
              const currentPaused = currentLeader?.status === "paused";
              const currentPauseGen = currentLeader?.pauseGeneration ?? 0;
              const currentPauseVer = currentLeader?.pauseVersion ?? 0;
              yield* callHost(host, "connections.syncBindings", {
                bindings: [
                  {
                    connectionId: connId,
                    leaderId: currentBinding.leaderId,
                    bindingId: currentBinding.bindingId,
                    bindingEpoch: currentBinding.epoch,
                    leaderPaused: currentPaused,
                    pauseGeneration: currentPauseGen,
                    pauseVersion: currentPauseVer,
                  },
                ],
                leaderStates: {
                  [currentBinding.leaderId]: {
                    paused: currentPaused,
                    pauseGeneration: currentPauseGen,
                    pauseVersion: currentPauseVer,
                  },
                },
                leaderPauseGenerations: { [currentBinding.leaderId]: currentPauseGen },
                leaderPausedById: { [currentBinding.leaderId]: currentPaused },
                leaderPauseVersions: { [currentBinding.leaderId]: currentPauseVer },
              }).pipe(Effect.ignore);
            }
          }
          return;
        }
        return yield* accepted.failure;
      }
      const { threadId, turnId, inbound } = accepted.success;
      yield* callHost(host, "inbound.ack", {
        idempotencyKey: inbound.key, t3ThreadId: threadId, t3TurnId: turnId,
      });
      return;
    }
    if (payload.senderRole !== "owner" && payload.verifiedOwner !== true) return;
    if (typeof payload.connectionId !== "string" || typeof payload.chatId !== "string") return;
    const activeBinding = yield* leaders.activeBindingForConnection(payload.connectionId).pipe(
      Effect.orElseSucceed(() => undefined),
    );
    const rawExplicitThread = typeof payload.threadId === "string" && leaders.isProtectedThreadSync(payload.threadId)
      ? payload.threadId
      : undefined;
    // S19: Verify an explicit thread pointer matches the connection's CURRENT binding before trusting it!
    let verifiedExplicitThread: string | undefined;
    if (rawExplicitThread) {
      const ctx = yield* dispatch.firstContext(ThreadId.make(rawExplicitThread));
      const bindingMatches =
        ctx !== undefined &&
        ctx.connectionId === payload.connectionId &&
        ctx.chatId === payload.chatId &&
        (activeBinding === undefined ||
          ((ctx.leaderId ?? DEFAULT_LEADER_ID) === activeBinding.leaderId &&
            (ctx.bindingEpoch == null || ctx.bindingEpoch === activeBinding.epoch) &&
            (ctx.bindingId == null || ctx.bindingId === activeBinding.bindingId)));
      if (bindingMatches) verifiedExplicitThread = rawExplicitThread;
    }
    const candidates = verifiedExplicitThread
      ? [{ threadId: verifiedExplicitThread }]
      : yield* dispatch.unsettledForChat(payload.connectionId, payload.chatId);
    const interrupted = new Set<string>();
    for (const candidate of candidates) {
      if (interrupted.has(candidate.threadId)) continue;
      interrupted.add(candidate.threadId);
      const threadId = ThreadId.make(candidate.threadId);
      const context = yield* dispatch.firstContext(threadId);
      if (context === undefined || context.connectionId !== payload.connectionId || context.chatId !== payload.chatId) continue;
      if (
        activeBinding !== undefined &&
        ((context.leaderId ?? DEFAULT_LEADER_ID) !== activeBinding.leaderId ||
          (context.bindingEpoch != null && context.bindingEpoch !== activeBinding.epoch))
      ) {
        continue;
      }
      const { runs } = yield* dispatch.orchestrator.getThreadRecords(threadId, ["runs"], { runStatuses: activeStatuses });
      const run = runs.at(-1);
      if (run === undefined) continue;
      yield* dispatch.orchestrator.dispatch({
        type: "run.interrupt", threadId, runId: run.id,
        commandId: CommandId.make(`im-stop:${hashArgs([payload.connectionId, payload.platformMsgId ?? "stop", run.id])}`),
        reason: "IM owner requested /stop.",
      });
    }
  });

const makeDeliveryWorker = (
  host: XtworkImBridgeHost,
  dispatch: ImDispatcher,
  leaders: LeaderStore,
  approvals: ImApprovals,
  pendingBindingSyncs: Map<string, string>,
  hasReplySucceeded: (turnId: string) => boolean,
) => {
  const { sync, clearCaches } = makeDeliverySync(
    host,
    dispatch,
    hasReplySucceeded,
    (context) => resolveProgressReportMode(context, leaders.getImPolicySync(context.leaderId ?? DEFAULT_LEADER_ID)),
    (runId) => approvals.hasPendingForRun(runId),
  );
  return Effect.gen(function* () {
    if (!host.available) {
      clearCaches();
      return;
    }
    if (pendingBindingSyncs.size > 0) {
      for (const [connectionId] of [...pendingBindingSyncs.entries()]) {
        const bindingRes = yield* leaders.activeBindingForConnection(connectionId).pipe(Effect.result);
        if (bindingRes._tag === "Failure") {
          continue;
        }
        const binding = bindingRes.success;
        if (!binding) {
          pendingBindingSyncs.delete(connectionId);
          continue;
        }
        const ownerRes = yield* leaders.getLeader(binding.leaderId).pipe(Effect.result);
        if (ownerRes._tag === "Failure" || !ownerRes.success) {
          continue;
        }
        const syncedPauseVersion = ownerRes.success.pauseVersion;
        const syncRes = yield* syncLeaderStateAndBindingsToBridge(host, ownerRes.success, [binding]).pipe(Effect.result);
        const confirmed =
          syncRes._tag === "Success"
            ? extractConfirmedBindings(syncRes.success).get(binding.connectionId)
            : undefined;
        const tupleConfirmed =
          confirmed !== undefined &&
          bindingMatchesConnection(confirmed, binding, ownerRes.success.status === "paused");
        if (tupleConfirmed) {
          const latestRes = yield* leaders.activeBindingForConnection(connectionId).pipe(Effect.result);
          const latestOwnerRes = yield* leaders.getLeader(binding.leaderId).pipe(Effect.result);
          if (
            latestRes._tag === "Success" &&
            latestRes.success?.bindingId === binding.bindingId &&
            latestOwnerRes._tag === "Success" &&
            latestOwnerRes.success !== undefined &&
            syncedPauseVersion >= latestOwnerRes.success.pauseVersion
          ) {
            pendingBindingSyncs.delete(connectionId);
          }
        }
      }
    }
    const rows = yield* dispatch.unsettled;
    yield* Effect.forEach(rows, (row) => sync(row).pipe(Effect.ignore), { concurrency: 4, discard: true });
  }).pipe(Effect.ignore, Effect.repeat(Schedule.spaced("1 second")));
};

export const layer = Layer.effect(XtworkIm, Effect.gen(function* () {
  const approvals = new ImApprovals();
  const pendingBindingSyncs = new Map<string, string>();
  const events: BridgeEvent[] = [];
  const repliedTurns = new Set<string>();
  const projection = Option.getOrUndefined(yield* Effect.serviceOption(ProjectionStoreV2));
  const orchestrator = Option.getOrUndefined(yield* Effect.serviceOption(OrchestratorV2));
  const projects = Option.getOrUndefined(yield* Effect.serviceOption(ManagedProjectFolders));
  const leaders = yield* makeLeaderStore().pipe(Effect.orElseSucceed(() => undefined));

  if (leaders) {
    const hook: XtworkPolicyHook = {
      isProtectedThread: leaders.isProtectedThreadSync,
      resolveProviderPolicy: leaders.resolveProviderPolicySync,
      hasPersistedRunPolicy: leaders.hasRunPolicySync,
      bindRunPolicyInTxn: (commandId, threadId, runId) =>
        leaders.bindRunPolicySql(commandId, threadId, runId).pipe(Effect.mapError(imError)),
      publishBoundRunPolicySync: leaders.publishBoundRunPolicySync,
      recordNativeThreadPolicy: (threadId, nativeThreadId, policyDigest) =>
        leaders.recordNativeThreadPolicy(threadId, nativeThreadId, policyDigest).pipe(Effect.mapError(imError)),
      getProtectedContext: leaders.getProtectedContextSync,
    };
    yield* Effect.acquireRelease(
      Effect.sync(() => {
        setActiveXtworkPolicyHook(hook);
        return hook;
      }),
      (registered) =>
        Effect.sync(() => {
          if (activePolicyHook === registered) setActiveXtworkPolicyHook(undefined);
        }),
    );
  }

  const defaultService: ImService = {
    approvals,
    pendingBindingSyncs,
    ...(leaders ? { leaders } : {}),
    ...(projection ? { projection } : {}),
    ...(orchestrator ? { orchestrator } : {}),
    ...(projects ? { projects } : {}),
    markReplySucceeded: (turnId: string) => { repliedTurns.add(turnId); },
    hasReplySucceeded: (turnId: string) => repliedTurns.has(turnId),
    eventsSince: (after: number) => events.filter((item) => item.sequence > after),
  };
  const options = yield* Effect.try({ try: bridgeOptions, catch: imError }).pipe(Effect.orElseSucceed(() => undefined));
  if (options === undefined || leaders === undefined) return defaultService;
  const memory = new XtworkImMemory(options.companionDir);
  yield* tryWork(() => memory.ensureMigrated(DEFAULT_LEADER_ID)).pipe(Effect.ignore);
  // Sync default Leader's role from migrated ROLE.md if database role is empty.
  const migratedRole = yield* tryWork(() => memory.read("role", undefined, DEFAULT_LEADER_ID)).pipe(
    Effect.orElseSucceed(() => ""),
  );
  const defaultLeader = yield* leaders.ensureDefaultLeader();
  if (migratedRole && !defaultLeader.role) {
    yield* leaders.updateLeader(DEFAULT_LEADER_ID, { role: migratedRole });
  }

  const dispatch = yield* makeDispatcher(options.dataDir, memory, leaders);
  const queue = yield* Queue.unbounded<BridgeEvent>();
  const epoch = (yield* Clock.currentTimeMillis) * 1000;
  let sequence = epoch;
  const syncBridgeBindings = Effect.fnUntraced(function* (
    callRaw: (method: string, params?: BridgePayload, signal?: AbortSignal) => Promise<unknown>,
    triggerReplay = false,
  ) {
    const defaultLdr = yield* leaders.ensureDefaultLeader();
    const allLeaders = yield* leaders.listLeaders();
    const leaderById = new Map(allLeaders.map((l) => [l.id, l]));
    const leaderPauseGenerations = Object.fromEntries(allLeaders.map((l) => [l.id, l.pauseGeneration]));
    const leaderPausedById = Object.fromEntries(allLeaders.map((l) => [l.id, l.status === "paused"]));
    const leaderPauseVersions = Object.fromEntries(allLeaders.map((l) => [l.id, l.pauseVersion]));
    const leaderStates = Object.fromEntries(
      allLeaders.map((l) => [
        l.id,
        { paused: l.status === "paused", pauseGeneration: l.pauseGeneration, pauseVersion: l.pauseVersion },
      ]),
    );
    const listed = yield* tryWork((signal) => callRaw("connections.list", {}, signal)).pipe(
      Effect.map((val) => (isRecord(val) && Array.isArray(val.connections) ? val.connections : [])),
      Effect.orElseSucceed(() => []),
    );
    const bindingsPayload: Array<Record<string, unknown>> = [];
    for (const conn of listed) {
      if (!isRecord(conn) || typeof conn.id !== "string") continue;
      const connPlatform = sanitizeBindingPlatform(conn.platform) ?? undefined;
      const claimed = isConnectionClaimed(conn);
      const binding = yield* leaders
        .ensureBinding(conn.id, DEFAULT_LEADER_ID, connPlatform, claimed)
        .pipe(Effect.orElseSucceed(() => undefined));
      if (!binding) continue;
      const leaderRecord = leaderById.get(binding.leaderId);
      const leaderPaused = leaderRecord?.status === "paused";
      bindingsPayload.push({
        connectionId: conn.id,
        leaderId: binding.leaderId,
        bindingId: binding.bindingId,
        bindingEpoch: binding.epoch,
        leaderPaused,
        pauseGeneration: leaderRecord?.pauseGeneration ?? 0,
        pauseVersion: leaderRecord?.pauseVersion ?? 0,
      });
    }
    yield* tryWork((signal) =>
      callRaw(
        "connections.syncBindings",
        {
          bindings: bindingsPayload,
          leaderStates,
          leaderPauseGenerations,
          leaderPausedById,
          leaderPauseVersions,
          defaultLeaderPaused: defaultLdr.status === "paused",
          defaultLeaderPauseGeneration: defaultLdr.pauseGeneration,
          defaultLeaderPauseVersion: defaultLdr.pauseVersion,
          ...(triggerReplay ? { triggerReplay: true } : {}),
        },
        signal,
      ),
    ).pipe(Effect.ignore);
  });

  const runSync = Effect.runPromiseWith(yield* Effect.context<never>());
  const host = yield* Effect.acquireRelease(
    Effect.sync(() => {
      const host = new XtworkImBridgeHost(
        options,
        (event, payload) => {
          const item = { sequence: ++sequence, event, payload };
          if (["onboarding.event", "connection.state", "access.held", "inbound.paused"].includes(event)) {
            events.push(item);
            if (events.length > 200) events.shift();
          }
          if (event === "inbound.dispatch" || event === "inbound.stop" || event === "connection.state") {
            Queue.offerUnsafe(queue, item);
          }
        },
        async (callRaw) => {
          await runSync(syncBridgeBindings(callRaw, true));
        },
      );
      host.start();
      return host;
    }),
    (host) => Effect.promise(() => host.close()),
  );

  const handle = makeBridgeEventHandler(host, dispatch, leaders);

  yield* forkParked(Queue.take(queue).pipe(
    Effect.flatMap(handle),
    Effect.catch(() => Effect.logWarning("An IM bridge notification could not be processed.")),
    Effect.forever,
  ));
  yield* forkParked(makeDeliveryWorker(host, dispatch, leaders, approvals, pendingBindingSyncs, defaultService.hasReplySucceeded));
  return { ...defaultService, host, memory, dispatch };
}));

const readMethods = new Map([
  ["status", "bridge.status"],
  ["connections", "connections.list"],
  ["access", "access.list"],
  ["contacts", "contacts.list"],
  ["people", "contacts.list"],
  ["paused", "paused.list"],
]);
const writeMethods = new Set([
  "onboarding.start", "onboarding.submitCode", "onboarding.cancel",
  "connections.pause", "connections.resume", "connections.disconnect", "connections.claimRefresh",
  "connections.permissions", "access.decide", "access.setAskAll",
  "contacts.rename", "contacts.note", "people.link", "people.unlink",
  "paused.decide",
]);
const response = (value: unknown, status = 200) =>
  HttpServerResponse.jsonUnsafe(value ?? {}, { status, headers: { "cache-control": "no-store" } });
const failure = (error: string, status: number) => response({ error }, status);

const ensureLeaderDesktopThread = Effect.fnUntraced(function* (
  service: ImService,
  leaderId: string,
  forceNew: boolean,
) {
  if (!service.leaders || !service.orchestrator || !service.projects) {
    return yield* imError("Leader workspace service is unavailable.");
  }
  const leader = yield* service.leaders.getLeader(leaderId);
  if (!leader || leader.status === "archived") return yield* imError("Leader not found.");
  if (!forceNew && leader.pinnedThreadId) {
    const existing = yield* service.orchestrator.getThreadShell(ThreadId.make(leader.pinnedThreadId)).pipe(
      Effect.orElseSucceed(() => null),
    );
    if (existing !== null && existing.deletedAt === null && existing.archivedAt === null) {
      return { leader, threadId: leader.pinnedThreadId };
    }
  }
  const { projectId } = yield* service.projects.ensureScratchProject;
  const threadId = ThreadId.make(`xtwork-leader-${leader.id}-${randomUUID().slice(0, 8)}`);
  const commandId = CommandId.make(`leader-thread:${leader.id}:${Date.now()}:${randomUUID().slice(0, 6)}`);
  yield* service.orchestrator.dispatch({
    type: "thread.create",
    commandId,
    threadId,
    projectId,
    title: leader.name,
    modelSelection: { instanceId: PI_INSTANCE_ID, model: `${MODEL_PROVIDER}/${STANDARD_MODEL}` },
    worktreePath: null,
    branch: null,
    runtimeMode: "approval-required",
    interactionMode: "default",
    createdBy: "user",
    creationSource: "server",
  });
  const updated = (yield* service.leaders.updateLeader(leader.id, { pinnedThreadId: threadId })) ?? leader;
  return { leader: updated, threadId };
});

const fetchLeaderOverview = Effect.fnUntraced(function* (service: ImService, leaderId: string) {
  if (!service.leaders) return yield* imError("Leader service is unavailable.");
  const leader =
    (yield* service.leaders.getLeader(leaderId)) ??
    (leaderId === DEFAULT_LEADER_ID ? yield* service.leaders.ensureDefaultLeader() : undefined);
  if (!leader) return yield* imError("Leader not found.");
  const bindings = yield* service.leaders.listBindings(leader.id);
  const rawConnections = service.host?.available
    ? yield* call(service.host, "connections.list", {}).pipe(
        Effect.map((val) => (isRecord(val) && Array.isArray(val.connections) ? val.connections : [])),
        Effect.orElseSucceed(() => []),
      )
    : [];
  // Ensure every active bridge connection has a Leader binding & synced pause state (S4/S6).
  const allLeaders = yield* service.leaders.listLeaders();
  const leaderById = new Map(allLeaders.map((l) => [l.id, l]));
  const leaderPauseGenerations = Object.fromEntries(allLeaders.map((l) => [l.id, l.pauseGeneration]));
  const leaderPausedById = Object.fromEntries(allLeaders.map((l) => [l.id, l.status === "paused"]));
  const leaderPauseVersions = Object.fromEntries(allLeaders.map((l) => [l.id, l.pauseVersion]));
  const leaderStates = Object.fromEntries(
    allLeaders.map((l) => [
      l.id,
      { paused: l.status === "paused", pauseGeneration: l.pauseGeneration, pauseVersion: l.pauseVersion },
    ]),
  );
  const toSync: Array<Record<string, unknown>> = [];
  const syncAttemptPauseVersionByConn = new Map<string, number>();
  for (const conn of rawConnections) {
    if (isRecord(conn) && typeof conn.id === "string") {
      const connPlatform = sanitizeBindingPlatform(conn.platform) ?? undefined;
      const claimed = isConnectionClaimed(conn);
      const binding = yield* service.leaders.ensureBinding(conn.id, DEFAULT_LEADER_ID, connPlatform, claimed).pipe(
        Effect.orElseSucceed(() => undefined),
      );
      if (binding && ((connPlatform && binding.platform !== connPlatform) || (claimed && !binding.claimed))) {
        yield* service.leaders
          .recordBindingPlatform(conn.id, connPlatform ?? binding.platform ?? "", claimed)
          .pipe(Effect.ignore);
      }
      if (binding) {
        const leaderRec = leaderById.get(binding.leaderId);
        const desiredPaused = leaderRec?.status === "paused";
        const desiredPauseVersion = leaderRec?.pauseVersion ?? 0;
        if (
          conn.leaderId !== binding.leaderId ||
          conn.bindingId !== binding.bindingId ||
          conn.bindingEpoch !== binding.epoch ||
          Boolean(conn.leaderPaused) !== desiredPaused ||
          service.pendingBindingSyncs?.has(conn.id) === true
        ) {
          syncAttemptPauseVersionByConn.set(conn.id, desiredPauseVersion);
          toSync.push({
            connectionId: conn.id,
            leaderId: binding.leaderId,
            bindingId: binding.bindingId,
            bindingEpoch: binding.epoch,
            leaderPaused: desiredPaused,
            pauseGeneration: leaderRec?.pauseGeneration ?? 0,
            pauseVersion: desiredPauseVersion,
          });
        }
      }
    }
  }
  let confirmedByConnId: ReadonlyMap<string, Record<string, unknown>> = new Map();
  let syncSucceeded = false;
  if (service.host?.available && toSync.length > 0) {
    const syncRes = yield* call(service.host, "connections.syncBindings", {
      bindings: toSync,
      leaderStates,
      leaderPauseGenerations,
      leaderPausedById,
      leaderPauseVersions,
    }).pipe(Effect.result);
    if (syncRes._tag === "Success") {
      syncSucceeded = true;
      confirmedByConnId = extractConfirmedBindings(syncRes.success);
    }
  }
  const pausedPending = service.host?.available
    ? yield* call(service.host, "paused.list", { leaderId: leader.id }).pipe(
        Effect.map((val) => (isRecord(val) && Array.isArray(val.items) ? val.items : [])),
        Effect.orElseSucceed(() => []),
      )
    : [];

  const snapshot = service.projection
    ? yield* service.projection.getAgentAwarenessSnapshot().pipe(
        Effect.orElseSucceed(() => ({ snapshotSequence: 0, threads: [] })),
      )
    : { snapshotSequence: 0, threads: [] };

  const latestLeader = (yield* service.leaders.getLeader(leader.id)) ?? leader;
  const refreshedBindings = yield* service.leaders.listBindings(latestLeader.id);
  const bindingByConnId = new Map(refreshedBindings.map((b) => [b.connectionId, b]));
  const connections = yield* Effect.forEach(
    rawConnections.filter((conn) => isRecord(conn) && typeof conn.id === "string" && bindingByConnId.has(conn.id)),
    (conn) => {
      if (!isRecord(conn) || typeof conn.id !== "string") return Effect.succeed(conn);
      const b = bindingByConnId.get(conn.id);
      if (!b) return Effect.succeed(conn);
      const freshConn = confirmedByConnId.get(conn.id) ?? conn;
      const syncedInThisCall = syncSucceeded && confirmedByConnId.has(conn.id);
      const confirmedPauseVersion = syncedInThisCall
        ? (syncAttemptPauseVersionByConn.get(conn.id) ?? leader.pauseVersion)
        : leader.pauseVersion;
      const hasUnconfirmedPending = !syncedInThisCall && service.pendingBindingSyncs?.has(conn.id) === true;
      const tupleMatches =
        !hasUnconfirmedPending &&
        confirmedPauseVersion >= latestLeader.pauseVersion &&
        bindingMatchesConnection(freshConn, b, latestLeader.status === "paused");
      if (tupleMatches) {
        return clearPendingBindingSyncIfCurrent(service, b, confirmedPauseVersion).pipe(
          Effect.map((cleared) => ({
            ...freshConn,
            ...(cleared
              ? { syncPending: false }
              : {
                  desiredLeaderId: b.leaderId,
                  desiredBindingId: b.bindingId,
                  desiredBindingEpoch: b.epoch,
                  syncPending: true,
                }),
          })),
        );
      }
      return markPendingBindingSyncIfCurrent(service, b, latestLeader.pauseVersion).pipe(
        Effect.as({
          ...freshConn,
          desiredLeaderId: b.leaderId,
          desiredBindingId: b.bindingId,
          desiredBindingEpoch: b.epoch,
          syncPending: true,
        }),
      );
    },
  );

  const ownerNeedsYou = buildOwnerNeedsYou({
    caller: { ...desktopContext, leaderId: latestLeader.id },
    leader: latestLeader,
    snapshotSequence: snapshot.snapshotSequence,
    snapshotThreads: snapshot.threads,
    leaderStore: service.leaders,
    approvals: service.approvals,
  });

  const boundPlatforms = yield* service.leaders.listBoundPlatforms(latestLeader.id);

  return {
    leader: latestLeader,
    bindings: refreshedBindings,
    boundPlatforms,
    connections,
    pausedPending,
    needsYou: ownerNeedsYou.awareness,
    approvals: ownerNeedsYou.approvals,
  };
});

const syncLeaderStateAndBindingsToBridge = (
  host: DeliveryWorkerHost,
  leader: { readonly id: string; readonly status: string; readonly pauseGeneration: number; readonly pauseVersion: number },
  bindings: ReadonlyArray<{ readonly connectionId: string; readonly leaderId: string; readonly bindingId: string; readonly epoch: number }>,
) => {
  const paused = leader.status === "paused";
  const bindingsPayload = bindings.map((b) => ({
    connectionId: b.connectionId,
    leaderId: b.leaderId,
    bindingId: b.bindingId,
    bindingEpoch: b.epoch,
    leaderPaused: paused,
    pauseGeneration: leader.pauseGeneration,
    pauseVersion: leader.pauseVersion,
  }));
  return callHost(host, "connections.syncBindings", {
    bindings: bindingsPayload,
    leaderStates: {
      [leader.id]: {
        paused,
        pauseGeneration: leader.pauseGeneration,
        pauseVersion: leader.pauseVersion,
      },
    },
    leaderPauseGenerations: { [leader.id]: leader.pauseGeneration },
    leaderPausedById: { [leader.id]: paused },
    leaderPauseVersions: { [leader.id]: leader.pauseVersion },
    ...(leader.id === DEFAULT_LEADER_ID
      ? {
          defaultLeaderPaused: paused,
          defaultLeaderPauseGeneration: leader.pauseGeneration,
          defaultLeaderPauseVersion: leader.pauseVersion,
        }
      : {}),
  });
};

const extractConfirmedBindings = (value: unknown): ReadonlyMap<string, Record<string, unknown>> => {
  const map = new Map<string, Record<string, unknown>>();
  if (!isRecord(value) || !Array.isArray(value.connections)) return map;
  for (const conn of value.connections) {
    if (isRecord(conn) && typeof conn.id === "string") {
      map.set(conn.id, conn);
    }
  }
  return map;
};

const bindingMatchesConnection = (
  conn: Record<string, unknown>,
  binding: { readonly leaderId: string; readonly bindingId: string; readonly epoch: number },
  expectedLeaderPaused?: boolean,
): boolean =>
  conn.leaderId === binding.leaderId &&
  conn.bindingId === binding.bindingId &&
  conn.bindingEpoch === binding.epoch &&
  (expectedLeaderPaused === undefined || Boolean(conn.leaderPaused) === expectedLeaderPaused);

const serviceLeaderLocks = new WeakMap<ImService, Map<string, Semaphore.Semaphore>>();
const serviceHighestEpochByConn = new WeakMap<ImService, Map<string, number>>();

const recordBindingEpoch = (service: ImService, connectionId: string, epoch: number): void => {
  let epochs = serviceHighestEpochByConn.get(service);
  if (!epochs) {
    epochs = new Map();
    serviceHighestEpochByConn.set(service, epochs);
  }
  const prev = epochs.get(connectionId) ?? 0;
  if (epoch > prev) {
    epochs.set(connectionId, epoch);
  }
};

const getHighestBindingEpoch = (service: ImService, connectionId: string): number =>
  serviceHighestEpochByConn.get(service)?.get(connectionId) ?? 0;

const withLeaderLocks = <A, E, R>(
  service: ImService,
  leaderIds: readonly string[],
  effect: Effect.Effect<A, E, R>,
): Effect.Effect<A, E, R> => {
  const ordered = [...new Set(leaderIds.filter((id) => id.length > 0))].sort();
  let locks = serviceLeaderLocks.get(service);
  if (!locks) {
    locks = new Map();
    serviceLeaderLocks.set(service, locks);
  }
  let wrapped = effect;
  for (let i = ordered.length - 1; i >= 0; i -= 1) {
    const id = ordered[i]!;
    let sem = locks.get(id);
    if (!sem) {
      sem = Semaphore.makeUnsafe(1);
      locks.set(id, sem);
    }
    wrapped = sem.withPermit(wrapped);
  }
  return wrapped;
};

const withLeaderLock = <A, E, R>(
  service: ImService,
  leaderId: string,
  effect: Effect.Effect<A, E, R>,
): Effect.Effect<A, E, R> => withLeaderLocks(service, [leaderId], effect);

const bindingSyncToken = (bindingId: string, pauseVersion: number): string =>
  `${bindingId}@pv:${pauseVersion}`;

const markPendingBindingSyncIfCurrent = Effect.fnUntraced(function* (
  service: ImService,
  binding: { readonly connectionId: string; readonly bindingId: string; readonly leaderId?: string; readonly epoch: number },
  expectedPauseVersion = 0,
) {
  if (!service.pendingBindingSyncs) return;
  if (binding.epoch < getHighestBindingEpoch(service, binding.connectionId)) return;
  if (!service.leaders) {
    service.pendingBindingSyncs.set(binding.connectionId, bindingSyncToken(binding.bindingId, expectedPauseVersion));
    return;
  }
  const currentRes = yield* service.leaders.activeBindingForConnection(binding.connectionId).pipe(Effect.result);
  if (binding.epoch < getHighestBindingEpoch(service, binding.connectionId)) return;
  if (currentRes._tag === "Failure") {
    service.pendingBindingSyncs.set(binding.connectionId, bindingSyncToken(binding.bindingId, expectedPauseVersion));
    return;
  }
  if (currentRes.success?.bindingId === binding.bindingId) {
    const ownerRes = yield* service.leaders.getLeader(currentRes.success.leaderId).pipe(Effect.result);
    const livePauseVersion = ownerRes._tag === "Success" ? (ownerRes.success?.pauseVersion ?? 0) : expectedPauseVersion;
    const tokenPauseVersion = Math.max(expectedPauseVersion, livePauseVersion);
    service.pendingBindingSyncs.set(binding.connectionId, bindingSyncToken(binding.bindingId, tokenPauseVersion));
  }
});

const clearPendingBindingSyncIfCurrent = Effect.fnUntraced(function* (
  service: ImService,
  binding: { readonly connectionId: string; readonly bindingId: string; readonly leaderId?: string; readonly epoch: number },
  confirmedPauseVersion?: number,
) {
  recordBindingEpoch(service, binding.connectionId, binding.epoch);
  if (!service.leaders) {
    if (service.pendingBindingSyncs) {
      const existingToken = service.pendingBindingSyncs.get(binding.connectionId);
      if (existingToken === binding.bindingId || existingToken?.startsWith(`${binding.bindingId}@pv:`)) {
        service.pendingBindingSyncs.delete(binding.connectionId);
      }
    }
    return true;
  }
  const currentRes = yield* service.leaders.activeBindingForConnection(binding.connectionId).pipe(Effect.result);
  if (currentRes._tag !== "Success" || currentRes.success?.bindingId !== binding.bindingId) {
    return false;
  }
  const ownerRes = yield* service.leaders.getLeader(currentRes.success.leaderId).pipe(Effect.result);
  if (ownerRes._tag !== "Success" || !ownerRes.success) {
    return false;
  }
  if (confirmedPauseVersion !== undefined && confirmedPauseVersion < ownerRes.success.pauseVersion) {
    return false;
  }
  service.pendingBindingSyncs?.delete(binding.connectionId);
  return true;
});

const trySyncLeaderBindingsToBridge = Effect.fnUntraced(function* (
  service: ImService,
  leader: { readonly id: string; readonly status: string; readonly pauseGeneration: number; readonly pauseVersion: number },
  bindings: ReadonlyArray<{ readonly connectionId: string; readonly leaderId: string; readonly bindingId: string; readonly epoch: number }>,
) {
  if (bindings.length === 0) {
    return { synced: true, confirmedByConnId: new Map<string, Record<string, unknown>>() };
  }
  for (const binding of bindings) {
    recordBindingEpoch(service, binding.connectionId, binding.epoch);
  }
  if (!service.host?.available) {
    for (const binding of bindings) {
      yield* markPendingBindingSyncIfCurrent(service, binding, leader.pauseVersion);
    }
    return { synced: false, confirmedByConnId: new Map<string, Record<string, unknown>>() };
  }
  const res = yield* syncLeaderStateAndBindingsToBridge(service.host, leader, bindings).pipe(Effect.result);
  if (res._tag === "Success") {
    const confirmedByConnId = extractConfirmedBindings(res.success);
    const expectedPaused = leader.status === "paused";
    let allConfirmed = true;
    for (const binding of bindings) {
      const confirmed = confirmedByConnId.get(binding.connectionId);
      if (confirmed !== undefined && bindingMatchesConnection(confirmed, binding, expectedPaused)) {
        const cleared = yield* clearPendingBindingSyncIfCurrent(service, binding, leader.pauseVersion);
        if (!cleared) {
          allConfirmed = false;
        }
      } else {
        allConfirmed = false;
        yield* markPendingBindingSyncIfCurrent(service, binding, leader.pauseVersion);
      }
    }
    return { synced: allConfirmed, confirmedByConnId };
  }
  for (const binding of bindings) {
    yield* markPendingBindingSyncIfCurrent(service, binding, leader.pauseVersion);
  }
  return { synced: false, confirmedByConnId: new Map<string, Record<string, unknown>>() };
});

const serve = Effect.fnUntraced(function* (service: ImService) {
  const request = yield* HttpServerRequest.HttpServerRequest;
  if (parseBearerToken(request) === null) return failure("请先连接本机服务。", 401);
  const auth = yield* EnvironmentAuth;
  const bearer = request.modify({ headers: Headers.remove(request.headers, "cookie") });
  const session = yield* auth.authenticateHttpRequest(bearer).pipe(Effect.option);
  if (Option.isNone(session)) return failure("请先连接本机服务。", 401);
  const writing = request.method !== "GET";
  if (!session.value.scopes.includes(writing ? AuthOrchestrationOperateScope : AuthOrchestrationReadScope) ||
      (writing && session.value.subject !== "desktop-bootstrap")) {
    return failure("当前会话没有远程连接管理权限。", 403);
  }
  const url = new URL(request.url, "http://localhost");
  const rawPath = url.pathname.slice("/api/xtwork/im/".length);
  const action = rawPath.replaceAll("/", ".");
  const isLeaderPath = rawPath === "leaders" || rawPath.startsWith("leaders/");
  if ((isLeaderPath || ["approvals", "onboarding.events", "companion.role", "contacts", "people", "access", "paused", "connections.rebind"].includes(action)) &&
      session.value.subject !== "desktop-bootstrap") {
    return failure("请从本机桌面查看此数据。", 403);
  }

  if (isLeaderPath) {
    if (!service.leaders) return failure("领航员服务暂不可用。", 503);
    const segments = rawPath.split("/").filter(Boolean);
    const body = writing
      ? yield* request.json.pipe(
          Effect.provideService(HttpServerRequest.MaxBodySize, ByteSize.kibibytes(80)),
          Effect.option,
        )
      : Option.some({} as unknown);
    const params = Option.isSome(body) && isRecord(body.value) ? body.value : {};

    if (!writing && segments.length === 1) {
      yield* service.leaders.ensureDefaultLeader();
      const leaders = yield* service.leaders.listLeaders();
      const items = yield* Effect.forEach(leaders, (leader) =>
        fetchLeaderOverview(service, leader.id).pipe(
          Effect.map((overview) => {
            const nonApprovalNeedsYou = overview.needsYou.threads.filter(
              (t) =>
                t.pendingApprovalCount === 0 &&
                (t.phase === "waiting_for_approval" || t.phase === "waiting_for_input" || t.phase === "failed"),
            ).length;
            return {
              leader: overview.leader,
              bindings: overview.bindings,
              boundPlatforms: overview.boundPlatforms,
              connections: overview.connections,
              needsYouCount: overview.approvals.length + overview.pausedPending.length + nonApprovalNeedsYou,
              startingCount: overview.needsYou.startingCount,
              runningCount: overview.needsYou.runningCount,
              waitingCount: overview.needsYou.waitingCount,
              failedCount: overview.needsYou.failedCount,
              completedCount: overview.needsYou.completedCount,
              latestCompletedKey: overview.needsYou.latestCompletedKey,
              latestCompletedAtMs: overview.needsYou.latestCompletedAtMs,
              pendingApprovalCount: overview.approvals.length,
              pausedPendingCount: overview.pausedPending.length,
            };
          }),
        ),
      );
      return response({ leaders: items });
    }

    if (writing && segments.length === 1) {
      const name = typeof params.name === "string" ? params.name : "";
      if (!name.trim()) return failure("请填写领航员名字。", 400);
      const roleText = typeof params.role === "string" ? params.role : undefined;
      if (roleText !== undefined && Buffer.byteLength(roleText, "utf8") > MAX_COMPANION_FILE_BYTES) {
        return failure("角色说明不能超过 64 KiB。", 400);
      }
      const awarenessScope = isRecord(params.awarenessScope)
        ? ({
            kind:
              params.awarenessScope.kind === "none" ||
              params.awarenessScope.kind === "projects" ||
              params.awarenessScope.kind === "all_local"
                ? params.awarenessScope.kind
                : "all_local",
            projectIds: Array.isArray(params.awarenessScope.projectIds)
              ? params.awarenessScope.projectIds.filter((id): id is string => typeof id === "string")
              : [],
          } satisfies AwarenessScope)
        : undefined;
      const imPolicy = isRecord(params.imPolicy) ? sanitizeImDelegationPolicy(params.imPolicy) : undefined;
      const newLeaderId = `leader-${randomUUID().slice(0, 8)}`;
      if (service.memory && roleText) {
        const writeRole = yield* tryWork(() => service.memory!.write("role", roleText, undefined, newLeaderId)).pipe(
          Effect.result,
        );
        if (writeRole._tag === "Failure") {
          return failure(writeRole.failure.message, 400);
        }
      }
      const created = yield* service.leaders
        .createLeader({
          id: newLeaderId,
          name,
          ...(typeof params.avatar === "string" ? { avatar: params.avatar } : {}),
          ...(roleText !== undefined ? { role: roleText } : {}),
          ...(awarenessScope ? { awarenessScope } : {}),
          ...(imPolicy ? { imPolicy } : {}),
        })
        .pipe(Effect.mapError((cause) => imError(cause)), Effect.result);
      if (created._tag === "Failure") {
        return failure(created.failure.message, 400);
      }
      return response({ leader: created.success });
    }

    const leaderId = segments[1] ?? DEFAULT_LEADER_ID;
    const subAction = segments[2] ?? "overview";

    if (!writing && subAction === "overview") {
      return yield* fetchLeaderOverview(service, leaderId).pipe(
        Effect.match({ onSuccess: (val) => response(val), onFailure: (err) => failure(err.message, 400) }),
      );
    }

    if (!writing && subAction === "diagnostics") {
      return yield* fetchLeaderOverview(service, leaderId).pipe(
        Effect.map((overview) => {
          const payload = {
            generatedAt: new Date().toISOString(),
            leader: {
              id: overview.leader.id,
              name: overview.leader.name,
              status: overview.leader.status,
              awarenessScope: overview.leader.awarenessScope,
              imPolicy: overview.leader.imPolicy,
            },
            connections: overview.connections.map((conn) =>
              isRecord(conn)
                ? {
                    id: conn.id,
                    platform: conn.platform,
                    lifecycleState: conn.lifecycleState,
                    state: conn.state,
                    stateDetail: conn.stateDetail,
                    paused: conn.paused,
                    leaderPaused: conn.leaderPaused,
                  }
                : conn,
            ),
            needsYou: {
              needsYouCount: overview.needsYou.needsYouCount,
              runningCount: overview.needsYou.runningCount,
              pendingApprovalCount: overview.needsYou.pendingApprovalCount,
              pausedPendingCount: overview.pausedPending.length,
            },
          };
          return response({ text: redactDiagnosticText(JSON.stringify(payload, null, 2)) });
        }),
        Effect.catch((err) => Effect.succeed(failure(err.message, 400))),
      );
    }

    if (writing && subAction === "open-thread") {
      return yield* ensureLeaderDesktopThread(service, leaderId, false).pipe(
        Effect.match({ onSuccess: (val) => response(val), onFailure: (err) => failure(err.message, 400) }),
      );
    }

    if (writing && subAction === "reset-session") {
      return yield* ensureLeaderDesktopThread(service, leaderId, true).pipe(
        Effect.match({ onSuccess: (val) => response(val), onFailure: (err) => failure(err.message, 400) }),
      );
    }

    if (writing && subAction === "archive") {
      if (leaderId === DEFAULT_LEADER_ID) {
        return failure("默认领航员不可归档。", 400);
      }
      const rebindToLeaderId =
        typeof params.rebindToLeaderId === "string" && params.rebindToLeaderId.trim().length > 0
          ? params.rebindToLeaderId.trim()
          : undefined;
      return yield* withLeaderLocks(
        service,
        rebindToLeaderId ? [leaderId, rebindToLeaderId] : [leaderId],
        Effect.gen(function* () {
          const leadersStore = service.leaders!;
          const existingTarget = yield* leadersStore.getLeader(leaderId);
          if (!existingTarget || existingTarget.status === "archived") {
            return failure("找不到对应的领航员。", 404);
          }
          if (!service.host?.available) {
            return failure("远程连接服务离线，无法确认暂停积压队列是否已清空，暂不可归档。", 503);
          }
          const checkEmptyPausedQueue = Effect.gen(function* () {
            const pausedRes = yield* call(service.host!, "paused.list", { leaderId: existingTarget.id }).pipe(
              Effect.result,
            );
            if (
              pausedRes._tag === "Failure" ||
              !isRecord(pausedRes.success) ||
              !Array.isArray(pausedRes.success.items) ||
              typeof pausedRes.success.heldCount !== "number"
            ) {
              return { ok: false as const, status: 503, message: "无法确认暂停积压与待审批消息状态，请稍后再尝试归档。" };
            }
            if (pausedRes.success.items.length > 0 || pausedRes.success.heldCount > 0) {
              return {
                ok: false as const,
                status: 409,
                message: "该领航员仍有暂停积压或待审批入站消息，请先在 Needs You / 访问审批中处理后再归档。",
              };
            }
            return { ok: true as const };
          });

          const preQueueCheck = yield* checkEmptyPausedQueue;
          if (!preQueueCheck.ok) {
            return failure(preQueueCheck.message, preQueueCheck.status);
          }

          const listedRes = yield* call(service.host, "connections.list", {}).pipe(Effect.result);
          if (listedRes._tag === "Failure" || !isRecord(listedRes.success) || !Array.isArray(listedRes.success.connections)) {
            return failure("无法确认远程连接归属状态，请稍后再尝试归档。", 503);
          }
          const liveBridgeConns = listedRes.success.connections.filter(
            (c): c is Record<string, unknown> & { readonly id: string } => isRecord(c) && typeof c.id === "string",
          );
          const liveBridgeConnIds = new Set(liveBridgeConns.map((c) => c.id));
          const bridgePointingAtTarget = liveBridgeConns
            .filter((c) => c.leaderId === existingTarget.id)
            .map((c) => c.id);

          const allActiveBindings = yield* leadersStore.listBindings(leaderId);
          for (const binding of allActiveBindings) {
            if (!liveBridgeConnIds.has(binding.connectionId)) {
              service.pendingBindingSyncs?.delete(binding.connectionId);
              yield* leadersStore.deactivateBindingOnDisconnect(binding.connectionId).pipe(Effect.ignore);
            }
          }
          const activeBindings = allActiveBindings.filter((binding) => liveBridgeConnIds.has(binding.connectionId));
          if (activeBindings.length > 0) {
            if (!rebindToLeaderId) {
              return failure("该领航员仍绑定着远程连接，请先换绑或指定接管领航员后再归档。", 409);
            }
            if (rebindToLeaderId === leaderId) {
              return failure("目标领航员不能与待归档领航员相同。", 400);
            }
            const targetLeader = yield* leadersStore.getLeader(rebindToLeaderId);
            if (!targetLeader || targetLeader.status === "archived") {
              return failure("目标领航员不存在或已归档。", 400);
            }
          }

          const liveConnById = new Map(liveBridgeConns.map((c) => [c.id, c]));
          const reboundBindings = [];
          for (const binding of activeBindings) {
            const liveConn = liveConnById.get(binding.connectionId);
            const connPlatform = sanitizeBindingPlatform(liveConn?.platform) ?? undefined;
            const connClaimed = liveConn ? isConnectionClaimed(liveConn) : undefined;
            const nextBinding = yield* leadersStore.rebindConnection(
              binding.connectionId,
              rebindToLeaderId!,
              connPlatform,
              connClaimed,
            );
            if (!nextBinding) {
              return failure("目标领航员不存在或已归档。", 400);
            }
            recordBindingEpoch(service, nextBinding.connectionId, nextBinding.epoch);
            reboundBindings.push(nextBinding);
          }

          const detachIds = new Set<string>([
            ...reboundBindings.map((b) => b.connectionId).filter((id) => liveBridgeConnIds.has(id)),
            ...bridgePointingAtTarget,
            ...liveBridgeConns.map((c) => c.id),
          ]);
          for (const connId of detachIds) {
            const liveConn = liveConnById.get(connId);
            const connPlatform = sanitizeBindingPlatform(liveConn?.platform) ?? undefined;
            const connClaimed = liveConn ? isConnectionClaimed(liveConn) : false;
            const currentBinding =
              (yield* leadersStore.activeBindingForConnection(connId)) ??
              (yield* leadersStore
                .ensureBinding(connId, DEFAULT_LEADER_ID, connPlatform, connClaimed)
                .pipe(Effect.orElseSucceed(() => undefined)));
            if (!currentBinding) continue;
            recordBindingEpoch(service, currentBinding.connectionId, currentBinding.epoch);
            if (currentBinding.leaderId === existingTarget.id) {
              return failure("该领航员仍绑定着远程连接，请先换绑或指定接管领航员后再归档。", 409);
            }
            const ownerLeader = yield* leadersStore.getLeader(currentBinding.leaderId);
            if (!ownerLeader) {
              return failure("目标领航员不存在或已归档。", 503);
            }
            const { synced } = yield* trySyncLeaderBindingsToBridge(service, ownerLeader, [currentBinding]);
            if (!synced) {
              return failure("远程桥接尚未确认连接换绑完成，请稍后重试归档以避免暂停消息滞留。", 503);
            }
          }

          const verifyListedRes = yield* call(service.host, "connections.list", {}).pipe(Effect.result);
          if (
            verifyListedRes._tag === "Failure" ||
            !isRecord(verifyListedRes.success) ||
            !Array.isArray(verifyListedRes.success.connections)
          ) {
            return failure("无法确认远程连接归属状态，请稍后再尝试归档。", 503);
          }
          if (
            verifyListedRes.success.connections.some(
              (c) => isRecord(c) && c.leaderId === existingTarget.id,
            )
          ) {
            return failure("远程桥接仍有连接指向待归档领航员，请稍后重试归档。", 503);
          }

          const postQueueCheck = yield* checkEmptyPausedQueue;
          if (!postQueueCheck.ok) {
            return failure(postQueueCheck.message, postQueueCheck.status);
          }

          const archived = yield* leadersStore
            .archiveLeader(leaderId)
            .pipe(Effect.mapError((cause) => imError(cause)), Effect.result);
          if (archived._tag === "Failure") {
            const status = archived.failure.code === "LEADER_HAS_ACTIVE_BINDINGS" ? 409 : 400;
            return failure(archived.failure.message, status);
          }
          if (!archived.success) {
            return failure("找不到对应的领航员。", 404);
          }
          return response({ leader: archived.success.leader, reboundBindings, syncPending: false });
        }),
      );
    }

    if (writing && subAction === "update") {
      if (params.name !== undefined && (typeof params.name !== "string" || params.name.trim().length === 0)) {
        return failure("领航员名字不能为空。", 400);
      }
      const roleText = typeof params.role === "string" ? params.role : undefined;
      if (roleText !== undefined && Buffer.byteLength(roleText, "utf8") > MAX_COMPANION_FILE_BYTES) {
        return failure("角色说明不能超过 64 KiB。", 400);
      }
      return yield* withLeaderLock(
        service,
        leaderId,
        Effect.gen(function* () {
          const leadersStore = service.leaders!;
          const existing = yield* leadersStore.getLeader(leaderId);
          if (!existing || existing.status === "archived") return failure("找不到对应的领航员。", 404);
          const awarenessScope = isRecord(params.awarenessScope)
            ? ({
                kind:
                  params.awarenessScope.kind === "none" ||
                  params.awarenessScope.kind === "projects" ||
                  params.awarenessScope.kind === "all_local"
                    ? params.awarenessScope.kind
                    : "all_local",
                projectIds: Array.isArray(params.awarenessScope.projectIds)
                  ? params.awarenessScope.projectIds.filter((id): id is string => typeof id === "string")
                  : [],
              } satisfies AwarenessScope)
            : undefined;
          const rawPolicy = isRecord(params.imPolicy) ? params.imPolicy : undefined;
          const rawOwnerDm = rawPolicy && isRecord(rawPolicy.ownerDm) ? rawPolicy.ownerDm : undefined;
          const rawGroup = rawPolicy && isRecord(rawPolicy.group) ? rawPolicy.group : undefined;
          const imPolicy: ImDelegationPolicy | undefined = rawPolicy
            ? sanitizeImDelegationPolicy({
                ownerDm: rawOwnerDm
                  ? {
                      ...existing.imPolicy.ownerDm,
                      ...rawOwnerDm,
                    }
                  : existing.imPolicy.ownerDm,
                group: rawGroup
                  ? {
                      ...existing.imPolicy.group,
                      ...rawGroup,
                    }
                  : existing.imPolicy.group,
              })
            : undefined;
          if (roleText !== undefined && service.memory) {
            const writeRole = yield* tryWork(() => service.memory!.write("role", roleText, undefined, existing.id)).pipe(
              Effect.result,
            );
            if (writeRole._tag === "Failure") {
              return failure(writeRole.failure.message, 400);
            }
          }
          const updated = yield* leadersStore.updateLeader(leaderId, {
            ...(typeof params.name === "string" ? { name: params.name } : {}),
            ...(typeof params.avatar === "string" ? { avatar: params.avatar } : {}),
            ...(roleText !== undefined ? { role: roleText } : {}),
            ...(awarenessScope ? { awarenessScope } : {}),
            ...(imPolicy ? { imPolicy } : {}),
          });
          if (!updated) return failure("找不到对应的领航员。", 404);
          if (
            typeof params.name === "string" &&
            params.name.trim().length > 0 &&
            updated.name !== existing.name &&
            updated.pinnedThreadId &&
            service.orchestrator
          ) {
            yield* service.orchestrator
              .dispatch({
                type: "thread.metadata.update",
                commandId: CommandId.make(`leader-rename:${updated.id}:${Date.now()}:${randomUUID().slice(0, 6)}`),
                threadId: ThreadId.make(updated.pinnedThreadId),
                title: updated.name,
              })
              .pipe(Effect.ignore);
          }
          return response({ leader: updated });
        }),
      );
    }

    if (writing && (subAction === "pause" || subAction === "resume")) {
      const nextPaused = subAction === "pause";
      return yield* withLeaderLock(
        service,
        leaderId,
        Effect.gen(function* () {
          const leadersStore = service.leaders!;
          const updated = yield* leadersStore.updateLeader(leaderId, { status: nextPaused ? "paused" : "active" });
          if (!updated) return failure("找不到对应的领航员。", 404);
          const bindings = yield* leadersStore.listBindings(updated.id);
          for (const binding of bindings) {
            yield* markPendingBindingSyncIfCurrent(service, binding, updated.pauseVersion);
          }
          let pausedPending: unknown[] = [];
          if (service.host?.available) {
            if (bindings.length > 0) {
              yield* trySyncLeaderBindingsToBridge(service, updated, bindings).pipe(Effect.ignore);
            } else {
              yield* syncLeaderStateAndBindingsToBridge(service.host, updated, bindings).pipe(Effect.ignore);
            }
            const listed = yield* call(service.host, "paused.list", { leaderId: updated.id }).pipe(
              Effect.orElseSucceed(() => ({})),
            );
            if (isRecord(listed) && Array.isArray(listed.items)) pausedPending = listed.items;
          }
          return response({ leader: updated, pausedPending });
        }),
      );
    }

    if (writing && subAction === "paused-decide") {
      if (!service.host?.available) return failure("远程连接服务暂不可用。", 503);
      const leader = yield* service.leaders.getLeader(leaderId);
      if (!leader) return failure("找不到对应的领航员。", 404);
      const allowedList = yield* call(service.host, "paused.list", { leaderId: leader.id }).pipe(
        Effect.map((val) => (isRecord(val) && Array.isArray(val.items) ? val.items : [])),
        Effect.orElseSucceed(() => []),
      );
      const allowedIds = new Set(
        allowedList
          .filter((item): item is Record<string, unknown> => isRecord(item) && typeof item.id === "string")
          .map((item) => item.id as string),
      );
      const requestedIds = Array.isArray(params.messageIds)
        ? params.messageIds.filter((id): id is string => typeof id === "string")
        : [];
      const scopedIds = requestedIds.filter((id) => allowedIds.has(id));
      if (requestedIds.length > 0 && scopedIds.length === 0) {
        return failure("所选积压消息不属于该领航员。", 403);
      }
      if (params.decision === "replay" && leader.status === "paused") {
        return response({
          decision: "replay",
          count: 0,
          messageIds: [],
          blockedIds: [],
          heldIds: [],
          skippedIds: scopedIds,
        });
      }
      return yield* call(service.host, "paused.decide", {
        ...params,
        leaderId: leader.id,
        pauseGeneration: leader.pauseGeneration,
        pauseVersion: leader.pauseVersion,
        messageIds: scopedIds,
      }).pipe(
        Effect.match({ onSuccess: (val) => response(val), onFailure: (err) => failure(err.message, 400) }),
      );
    }

    if (writing && subAction === "handoff") {
      if (!service.memory) return failure("伴侣记忆服务暂不可用。", 503);
      const existing = yield* service.leaders.getLeader(leaderId);
      if (!existing || existing.status === "archived") return failure("找不到对应的领航员。", 404);
      const summary = typeof params.summary === "string" ? params.summary.trim() : "";
      if (!summary) return failure("请提供交接摘要内容。", 400);
      const targetScope = yield* Effect.try({
        try: () => memoryScope(params.targetScope ?? "private"),
        catch: imError,
      }).pipe(Effect.match({ onSuccess: (s) => s, onFailure: () => undefined }));
      if (!targetScope || targetScope === "role") return failure("无效的交接目标记忆范围。", 400);
      const sourceLabel = typeof params.sourceLabel === "string" ? params.sourceLabel.trim() : "manual-handoff";
      const digest = hashArgs({ leaderId, targetScope, sourceLabel, summary }).slice(0, 10);
      const note = `handoff-${digest}.md`;
      const bodyText = [
        `# Handoff (${sourceLabel})`,
        "",
        untrustedEnvelope({ sourceLabel, summary, digest }, { ...desktopContext, leaderId }),
      ].join("\n");
      return yield* tryWork(() => service.memory!.write(targetScope, bodyText, note, leaderId)).pipe(
        Effect.match({
          onSuccess: () => response({ saved: true, note, targetScope, digest }),
          onFailure: (err) => failure(err.message, 400),
        }),
      );
    }

    return failure("找不到对应的领航员操作。", 404);
  }

  if (!writing && action === "status" && !service.host?.available) {
    return response({ state: service.host ? "starting" : "unavailable", installed: service.host !== undefined });
  }
  if (!writing && action === "onboarding.events") {
    const after = Number(url.searchParams.get("after") ?? 0);
    return response(service.eventsSince(after));
  }
  if (!writing && action === "approvals") return response(service.approvals.list());

  const input = writing
    ? yield* request.json.pipe(
      Effect.provideService(HttpServerRequest.MaxBodySize, ByteSize.kibibytes(80)),
      Effect.option,
    )
    : Option.some(Object.fromEntries(url.searchParams));
  if (Option.isNone(input) || !isRecord(input.value)) return failure("需要有效的请求数据。", 400);
  const params = input.value;
  if (writing && action === "approvals.decide") {
    const expectedRunId = typeof params.expectedRunId === "string" && params.expectedRunId.length > 0
      ? params.expectedRunId
      : undefined;
    const expectedAudience =
      params.expectedAudience === "local_only" ||
      params.expectedAudience === "owner_dm" ||
      params.expectedAudience === "group"
        ? (params.expectedAudience as ReplyAudience)
        : undefined;
    const expectedSnapshotHash = typeof params.expectedSnapshotHash === "string" ? params.expectedSnapshotHash : undefined;
    if (typeof params.id !== "string" || typeof params.approved !== "boolean" || !expectedRunId || !expectedAudience) {
      return failure("此审批缺少必需的运行标识或范围校验参数。", 409);
    }
    const pending = service.approvals.get(params.id);
    if (!pending) {
      return failure("此审批已处理、已过期或权限校验不匹配。", 409);
    }
    // S8: Re-verify against active execution when approving a live thread turn.
    if (params.approved && pending.threadId && service.dispatch) {
      const activeExec = yield* service.dispatch
        .resolveExecution(ThreadId.make(pending.threadId), RunId.make(expectedRunId))
        .pipe(Effect.orElseSucceed(() => undefined));
      if (!activeExec || activeExec.context.replyAudience !== expectedAudience) {
        return failure("目标任务已结束或上下文已变化，已拒绝本次授权。", 409);
      }
    }
    return service.approvals.decide(params.id, params.approved, {
      desktopOwnerVerified: session.value.subject === "desktop-bootstrap",
      expectedRunId,
      expectedAudience,
      ...(expectedSnapshotHash !== undefined ? { expectedSnapshotHash } : {}),
    })
      ? response({ decided: true })
      : failure("此审批已处理、已过期或权限校验不匹配。", 409);
  }
  if (action === "companion.role" && service.memory) {
    const memory = service.memory;
    const leaderId = typeof params.leaderId === "string" ? params.leaderId : DEFAULT_LEADER_ID;
    if (!writing) {
      const readRes = yield* tryWork(async () => ({ text: await memory.read("role", undefined, leaderId) })).pipe(
        Effect.result,
      );
      if (readRes._tag === "Failure") return failure(readRes.failure.message, 400);
      return response(readRes.success);
    }
    if (typeof params.text !== "string") return failure("需要角色说明文本。", 400);
    const nextRoleText = params.text;
    if (Buffer.byteLength(nextRoleText, "utf8") > MAX_COMPANION_FILE_BYTES) {
      return failure("角色说明不能超过 64 KiB。", 400);
    }
    return yield* withLeaderLock(
      service,
      leaderId,
      Effect.gen(function* () {
        if (service.leaders) {
          const existingLeader = yield* service.leaders.getLeader(leaderId);
          if (!existingLeader || existingLeader.status === "archived") {
            return failure("找不到对应的领航员。", 404);
          }
        }
        const roleResult = yield* tryWork(async () => {
          await memory.write("role", nextRoleText, undefined, leaderId);
          return { text: await memory.read("role", undefined, leaderId) };
        }).pipe(Effect.result);
        if (roleResult._tag === "Failure") return failure(roleResult.failure.message, 400);
        if (service.leaders) {
          const updated = yield* service.leaders
            .updateLeader(leaderId, { role: nextRoleText })
            .pipe(Effect.mapError((cause) => imError(cause)), Effect.result);
          if (updated._tag === "Failure") {
            return failure(updated.failure.message, 500);
          }
          if (!updated.success) {
            return failure("找不到对应的领航员。", 404);
          }
        }
        return response(roleResult.success);
      }),
    );
  }
  if (writing && action === "connections.rebind") {
    if (!service.leaders) return failure("领航员服务暂不可用。", 503);
    const connectionId = typeof params.connectionId === "string" ? params.connectionId.trim() : "";
    const targetLeaderId = typeof params.leaderId === "string" ? params.leaderId.trim() : "";
    if (!connectionId || connectionId.includes(":") || !targetLeaderId) {
      return failure("请提供有效的连接标识与目标领航员。", 400);
    }
    return yield* withLeaderLock(
      service,
      targetLeaderId,
      Effect.gen(function* () {
        const leadersStore = service.leaders!;
        const targetLeader = yield* leadersStore.getLeader(targetLeaderId);
        if (!targetLeader || targetLeader.status === "archived") {
          return failure("目标领航员不存在或已归档。", 404);
        }
        let matchedPlatform: string | undefined;
        let matchedClaimed: boolean | undefined;
        let bridgeVerified = false;
        if (service.host?.available) {
          const listed = yield* call(service.host, "connections.list", {}).pipe(
            Effect.map((val) => (isRecord(val) && Array.isArray(val.connections) ? val.connections : undefined)),
            Effect.orElseSucceed(() => undefined),
          );
          if (listed !== undefined) {
            bridgeVerified = true;
            const matchedConn = listed.find((conn) => isRecord(conn) && conn.id === connectionId);
            if (!matchedConn) {
              return failure("找不到对应的远程连接。", 404);
            }
            matchedPlatform = isRecord(matchedConn) ? (sanitizeBindingPlatform(matchedConn.platform) ?? undefined) : undefined;
            matchedClaimed = isRecord(matchedConn) ? isConnectionClaimed(matchedConn) : undefined;
          }
        }
        if (!bridgeVerified) {
          const existingActive = yield* leadersStore.activeBindingForConnection(connectionId);
          if (!existingActive) {
            return failure("找不到对应的远程连接。", 404);
          }
        }
        const binding = yield* leadersStore.rebindConnection(
          connectionId,
          targetLeader.id,
          matchedPlatform,
          matchedClaimed,
          !bridgeVerified,
        );
        if (!binding) {
          return failure(bridgeVerified ? "目标领航员不存在或已归档。" : "找不到对应的远程连接。", 404);
        }
        recordBindingEpoch(service, binding.connectionId, binding.epoch);
        const freshLeader = (yield* leadersStore.getLeader(targetLeader.id)) ?? targetLeader;
        const { synced } = yield* trySyncLeaderBindingsToBridge(service, freshLeader, [binding]);
        return response({ binding, leader: freshLeader, syncPending: !synced });
      }),
    );
  }
  const method = writing ? writeMethods.has(action) ? action : undefined : readMethods.get(action);
  if (method === undefined) return failure("找不到远程连接操作。", 404);
  if (!service.host?.available) return failure("远程连接服务暂不可用。", 503);
  const rpcParams = method === "people.link" || method === "people.unlink"
    ? { ...params, by: "owner" }
    : params;
  return yield* call(service.host, method, rpcParams).pipe(Effect.flatMap((value) => {
    if (writing && action === "connections.disconnect" && service.leaders) {
      const disconnectedId = (
        isRecord(value) && typeof value.connectionId === "string"
          ? value.connectionId
          : typeof params.connectionId === "string"
            ? params.connectionId
            : ""
      ).trim();
      if (disconnectedId) {
        service.pendingBindingSyncs?.delete(disconnectedId);
        return service.leaders
          .deactivateBindingOnDisconnect(disconnectedId)
          .pipe(Effect.ignore, Effect.as(response(value)));
      }
      return Effect.succeed(response(value));
    }
    if (!writing && action === "connections" && service.leaders && isRecord(value) && Array.isArray(value.connections)) {
      const leadersStore = service.leaders;
      const rawConnections = value.connections;
      return Effect.gen(function* () {
        const processed = yield* Effect.forEach(rawConnections, (conn) => {
          if (!isRecord(conn) || typeof conn.id !== "string") {
            return Effect.succeed({ raw: conn, connId: null as string | null, bindingId: null as string | null, confirmedPauseVersion: 0, syncPending: false });
          }
          const connId = conn.id as string;
          return Effect.gen(function* () {
            const connPlatform = sanitizeBindingPlatform(conn.platform) ?? undefined;
            const claimed = isConnectionClaimed(conn);
            const binding = yield* leadersStore
              .ensureBinding(connId, DEFAULT_LEADER_ID, connPlatform, claimed)
              .pipe(Effect.orElseSucceed(() => undefined));
            if (!binding) return null;
            if ((connPlatform && binding.platform !== connPlatform) || (claimed && !binding.claimed)) {
              yield* leadersStore.recordBindingPlatform(connId, connPlatform ?? binding.platform ?? "", claimed);
            }
            const ownerLeader = yield* leadersStore.getLeader(binding.leaderId);
            const expectedPaused = ownerLeader?.status === "paused";
            const hasPending = service.pendingBindingSyncs?.has(connId) === true;
            if (!hasPending && ownerLeader && bindingMatchesConnection(conn, binding, expectedPaused)) {
              const cleared = yield* clearPendingBindingSyncIfCurrent(service, binding, ownerLeader.pauseVersion);
              const stillActive = yield* leadersStore.activeBindingForConnection(connId);
              if (!stillActive) return null;
              if (cleared && stillActive.bindingId === binding.bindingId) {
                return {
                  raw: conn,
                  connId,
                  bindingId: binding.bindingId,
                  confirmedPauseVersion: ownerLeader.pauseVersion,
                  syncPending: false,
                };
              }
            }
            const syncOut = ownerLeader
              ? yield* trySyncLeaderBindingsToBridge(service, ownerLeader, [binding])
              : { synced: false, confirmedByConnId: new Map<string, Record<string, unknown>>() };
            const stillActive = yield* leadersStore.activeBindingForConnection(connId);
            if (!stillActive) return null;
            const latestOwner = yield* leadersStore.getLeader(stillActive.leaderId);
            const actualConn = syncOut.confirmedByConnId.get(connId) ?? conn;
            const syncedAndCurrent =
              syncOut.synced &&
              stillActive.bindingId === binding.bindingId &&
              latestOwner !== undefined &&
              ownerLeader !== undefined &&
              ownerLeader.pauseVersion >= latestOwner.pauseVersion &&
              service.pendingBindingSyncs?.has(connId) !== true &&
              bindingMatchesConnection(actualConn, stillActive, latestOwner.status === "paused");
            return {
              raw: actualConn,
              connId,
              bindingId: stillActive.bindingId,
              confirmedPauseVersion: ownerLeader?.pauseVersion ?? 0,
              syncPending: !syncedAndCurrent,
            };
          }).pipe(Effect.orElseSucceed(() => null));
        });
        const finalSnapshots = yield* leadersStore.listActiveBindingsWithLeaderState();
        const snapshotByConnId = new Map(finalSnapshots.map((entry) => [entry.connectionId, entry]));
        const finalConnections: unknown[] = [];
        for (const item of processed) {
          if (item === null) continue;
          if (item.connId === null) {
            finalConnections.push(item.raw);
            continue;
          }
          const stillActive = snapshotByConnId.get(item.connId);
          if (!stillActive) continue;
          const rawConn = isRecord(item.raw) ? item.raw : {};
          const stillSynced =
            !item.syncPending &&
            stillActive.bindingId === item.bindingId &&
            item.confirmedPauseVersion >= stillActive.leaderPauseVersion &&
            service.pendingBindingSyncs?.has(item.connId) !== true &&
            bindingMatchesConnection(rawConn, stillActive, stillActive.leaderStatus === "paused");
          if (stillSynced) {
            finalConnections.push({
              ...rawConn,
              syncPending: false,
            });
          } else {
            finalConnections.push({
              ...rawConn,
              desiredLeaderId: stillActive.leaderId,
              desiredBindingId: stillActive.bindingId,
              desiredBindingEpoch: stillActive.epoch,
              syncPending: true,
            });
          }
        }
        return response({ ...value, connections: finalConnections });
      });
    }
    return Effect.succeed(response(value));
  }), Effect.catch((error) => Effect.succeed(failure(error.message, 400))));
});

export const route = Layer.unwrap(Effect.map(XtworkIm, (service) => Layer.mergeAll(
  HttpRouter.add("GET", "/api/xtwork/im/*", serve(service)),
  HttpRouter.add("POST", "/api/xtwork/im/*", serve(service)),
)));
