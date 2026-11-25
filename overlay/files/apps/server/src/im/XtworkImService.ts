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
import { activeStatuses, decodeInbound, isTerminal, LEADER_PAUSED_ERROR, makeDispatcher, type ImDispatcher } from "./XtworkImDispatch.ts";
import { XtworkImMemory, memoryScope } from "./XtworkImMemory.ts";
import {
  DEFAULT_LEADER_ID,
  desktopContext,
  hashArgs,
  imError,
  ImApprovals,
  isImThread,
  untrustedEnvelope,
  type AwarenessScope,
  type ImError,
  type ReplyAudience,
  type TurnExecutionContext,
} from "./XtworkImSecurity.ts";
import { makeLeaderStore, type LeaderStore, type PersistedRunPolicy, type ProviderPolicyState } from "./XtworkLeaderStore.ts";
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

const makeDeliveryWorker = (host: XtworkImBridgeHost, dispatch: ImDispatcher, hasReplySucceeded: (turnId: string) => boolean) => {
  const live = new Map<string, { text: string; liveId: string | null }>();
  const ackedInBridge = new Set<string>();
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
      const ackRes = yield* call(host, "inbound.ack", {
        idempotencyKey: inbound.key,
        t3ThreadId: threadId,
        t3TurnId: run.id,
      }).pipe(Effect.match({ onFailure: () => undefined, onSuccess: (value) => value }));
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
      let replied = alreadyReplied;
      const finalText = text || current?.text || "";
      if (!alreadyReplied && current?.liveId) {
        const finished = yield* call(host, "messages.liveFinish", {
          liveId: current.liveId,
          markdown: finalText,
          operationKey: `${inbound.key}:finish`,
        }).pipe(Effect.match({ onFailure: () => undefined, onSuccess: (value) => value }));
        replied = isRecord(finished) && isRecord(finished.result) && finished.result.kind !== "failed";
        if (!replied && finalText && inbound.messageId) {
          const fallback = yield* call(host, "messages.reply", {
            messageId: inbound.messageId,
            text: finalText,
            operationKey: `${inbound.key}:reply`,
          }).pipe(Effect.match({ onFailure: () => undefined, onSuccess: (value) => value }));
          replied = isRecord(fallback) && isRecord(fallback.result) && ["sent", "uncertain"].includes(String(fallback.result.kind));
        }
      } else if (!alreadyReplied && finalText && inbound.messageId) {
        const result = yield* call(host, "messages.reply", {
          messageId: inbound.messageId,
          text: finalText,
          operationKey: `${inbound.key}:reply`,
        }).pipe(Effect.match({ onFailure: () => undefined, onSuccess: (value) => value }));
        replied = isRecord(result) && isRecord(result.result) && ["sent", "uncertain"].includes(String(result.result.kind));
      }
      live.delete(inbound.key);
      const event = replied ? "reply" : run.status === "failed" ? "fail" : run.status === "completed" && finalText ? "reply" : "give_up";
      const settled = yield* call(host, "inbound.settle", { idempotencyKey: inbound.key, event });
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
      yield* dispatch.settle(inbound.key);
      return;
    }
    if (alreadyReplied || run.status !== "running" || !text || text === current?.text) return;
    if (current === undefined) {
      const result = yield* call(host, "messages.liveStart", {
        chatId: inbound.chatId,
        replyTo: inbound.messageId ?? inbound.platformMsgId,
        initial: text,
        operationKey: `${inbound.key}:live`,
      }).pipe(Effect.match({ onFailure: () => undefined, onSuccess: (value) => value }));
      if (isRecord(result) && result.supported === true && typeof result.liveId === "string") {
        live.set(inbound.key, { text, liveId: result.liveId });
      } else if (isRecord(result) && result.supported === false) {
        live.set(inbound.key, { text, liveId: null });
      }
    } else if (current.liveId !== null) {
      yield* call(host, "messages.liveUpdate", { liveId: current.liveId, markdown: text });
      current.text = text;
    } else {
      current.text = text;
    }
  });
  return Effect.gen(function* () {
    if (!host.available) {
      live.clear();
      ackedInBridge.clear();
      return;
    }
    const rows = yield* dispatch.unsettled;
    yield* Effect.forEach(rows, (row) => sync(row).pipe(Effect.ignore), { concurrency: 4, discard: true });
  }).pipe(Effect.ignore, Effect.repeat(Schedule.spaced("1 second")));
};

export const layer = Layer.effect(XtworkIm, Effect.gen(function* () {
  const approvals = new ImApprovals();
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
    const leaderStatusById = new Map(allLeaders.map((l) => [l.id, l.status]));
    const listed = yield* tryWork((signal) => callRaw("connections.list", {}, signal)).pipe(
      Effect.map((val) => (isRecord(val) && Array.isArray(val.connections) ? val.connections : [])),
      Effect.orElseSucceed(() => []),
    );
    const bindingsPayload: Array<Record<string, unknown>> = [];
    for (const conn of listed) {
      if (!isRecord(conn) || typeof conn.id !== "string") continue;
      const binding = yield* leaders.ensureBinding(conn.id, DEFAULT_LEADER_ID);
      const leaderPaused = leaderStatusById.get(binding.leaderId) === "paused";
      bindingsPayload.push({
        connectionId: conn.id,
        leaderId: binding.leaderId,
        bindingId: binding.bindingId,
        bindingEpoch: binding.epoch,
        leaderPaused,
      });
    }
    yield* tryWork((signal) =>
      callRaw(
        "connections.syncBindings",
        {
          bindings: bindingsPayload,
          defaultLeaderPaused: defaultLdr.status === "paused",
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

  const handle = Effect.fnUntraced(function* ({ event, payload }: BridgeEvent) {
    if (event === "connection.state") {
      const connId = typeof payload.connectionId === "string" ? payload.connectionId : "";
      if (connId && host.available) {
        const binding = yield* leaders.ensureBinding(connId, DEFAULT_LEADER_ID);
        const ownerLeader = yield* leaders.getLeader(binding.leaderId);
        const desiredPaused = ownerLeader?.status === "paused";
        const needsSync =
          payload.leaderId !== binding.leaderId ||
          payload.bindingId !== binding.bindingId ||
          payload.bindingEpoch !== binding.epoch ||
          Boolean(payload.leaderPaused) !== desiredPaused;
        if (needsSync) {
          yield* call(host, "connections.syncBindings", {
            bindings: [
              {
                connectionId: connId,
                leaderId: binding.leaderId,
                bindingId: binding.bindingId,
                bindingEpoch: binding.epoch,
                leaderPaused: desiredPaused,
              },
            ],
          }).pipe(Effect.ignore);
        }
      }
      return;
    }
    if (event === "inbound.dispatch") {
      const accepted = yield* dispatch.accept(payload).pipe(Effect.result);
      if (accepted._tag === "Failure") {
        // S4: If a trigger raced with Leader pause, durably defer it into `paused_pending`!
        if (accepted.failure.message.includes(LEADER_PAUSED_ERROR)) {
          const connId = typeof payload.connectionId === "string" ? payload.connectionId : undefined;
          const idempotencyKey = typeof payload.idempotencyKey === "string" ? payload.idempotencyKey : undefined;
          if (connId) {
            yield* call(host, "connections.setLeaderPaused", { connectionIds: [connId], paused: true }).pipe(Effect.ignore);
          }
          if (idempotencyKey) {
            yield* call(host, "inbound.settle", { idempotencyKey, event: "pause" }).pipe(Effect.ignore);
          }
          return;
        }
        return yield* accepted.failure;
      }
      const { threadId, turnId, inbound } = accepted.success;
      yield* call(host, "inbound.ack", {
        idempotencyKey: inbound.key, t3ThreadId: threadId, t3TurnId: turnId,
      });
      return;
    }
    if (payload.senderRole !== "owner" && payload.verifiedOwner !== true) return;
    if (typeof payload.connectionId !== "string" || typeof payload.chatId !== "string") return;
    const explicitThread = typeof payload.threadId === "string" && leaders.isProtectedThreadSync(payload.threadId)
      ? payload.threadId
      : undefined;
    const candidates = explicitThread
      ? [{ threadId: explicitThread }]
      : yield* dispatch.unsettledForChat(payload.connectionId, payload.chatId);
    const interrupted = new Set<string>();
    for (const candidate of candidates) {
      if (interrupted.has(candidate.threadId)) continue;
      interrupted.add(candidate.threadId);
      const threadId = ThreadId.make(candidate.threadId);
      const context = yield* dispatch.firstContext(threadId);
      if (context === undefined || context.connectionId !== payload.connectionId || context.chatId !== payload.chatId) continue;
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

  yield* forkParked(Queue.take(queue).pipe(
    Effect.flatMap(handle),
    Effect.catch(() => Effect.logWarning("An IM bridge notification could not be processed.")),
    Effect.forever,
  ));
  yield* forkParked(makeDeliveryWorker(host, dispatch, defaultService.hasReplySucceeded));
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
  if (!leader) return yield* imError("Leader not found.");
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
  const leaderStatusById = new Map(allLeaders.map((l) => [l.id, l.status]));
  const toSync: Array<Record<string, unknown>> = [];
  for (const conn of rawConnections) {
    if (isRecord(conn) && typeof conn.id === "string") {
      const binding = yield* service.leaders.ensureBinding(conn.id, DEFAULT_LEADER_ID).pipe(
        Effect.orElseSucceed(() => undefined),
      );
      if (binding) {
        const desiredPaused = leaderStatusById.get(binding.leaderId) === "paused";
        if (
          conn.leaderId !== binding.leaderId ||
          conn.bindingId !== binding.bindingId ||
          conn.bindingEpoch !== binding.epoch ||
          Boolean(conn.leaderPaused) !== desiredPaused
        ) {
          toSync.push({
            connectionId: conn.id,
            leaderId: binding.leaderId,
            bindingId: binding.bindingId,
            bindingEpoch: binding.epoch,
            leaderPaused: desiredPaused,
          });
        }
      }
    }
  }
  if (service.host?.available && toSync.length > 0) {
    yield* call(service.host, "connections.syncBindings", { bindings: toSync }).pipe(Effect.ignore);
  }
  const refreshedBindings = yield* service.leaders.listBindings(leader.id);
  const boundConnectionIds = new Set(refreshedBindings.map((b) => b.connectionId));
  const connections = rawConnections.filter(
    (conn) => isRecord(conn) && typeof conn.id === "string" && boundConnectionIds.has(conn.id),
  );
  // S6: Query paused backlog strictly by stamped `leaderId` so rebinding preserves original Leader ownership.
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

  const ownerNeedsYou = buildOwnerNeedsYou({
    caller: { ...desktopContext, leaderId: leader.id },
    leader,
    snapshotSequence: snapshot.snapshotSequence,
    snapshotThreads: snapshot.threads,
    leaderStore: service.leaders,
    approvals: service.approvals,
  });

  return {
    leader,
    bindings: refreshedBindings,
    connections,
    pausedPending,
    needsYou: ownerNeedsYou.awareness,
    approvals: ownerNeedsYou.approvals,
  };
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
  if ((isLeaderPath || ["approvals", "onboarding.events", "companion.role", "contacts", "people", "access", "paused"].includes(action)) &&
      session.value.subject !== "desktop-bootstrap") {
    return failure("请从本机桌面查看此数据。", 403);
  }

  // Leader Control Plane HTTP endpoints (desktop-bootstrap Owner only).
  if (isLeaderPath) {
    if (!service.leaders) return failure("Leader 服务暂不可用。", 503);
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
              connections: overview.connections,
              needsYouCount: overview.approvals.length + overview.pausedPending.length + nonApprovalNeedsYou,
              runningCount: overview.needsYou.runningCount,
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
      if (!name.trim()) return failure("请填写 Leader 名字。", 400);
      const created = yield* service.leaders
        .createLeader({
          name,
          ...(typeof params.avatar === "string" ? { avatar: params.avatar } : {}),
          ...(typeof params.role === "string" ? { role: params.role } : {}),
        })
        .pipe(Effect.mapError((cause) => imError(cause)));
      if (service.memory && created.role) {
        yield* tryWork(() => service.memory!.write("role", created.role, undefined, created.id)).pipe(Effect.ignore);
      }
      return response({ leader: created });
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

    if (writing && subAction === "update") {
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
      const updated = yield* service.leaders.updateLeader(leaderId, {
        ...(typeof params.name === "string" ? { name: params.name } : {}),
        ...(typeof params.avatar === "string" ? { avatar: params.avatar } : {}),
        ...(typeof params.role === "string" ? { role: params.role } : {}),
        ...(awarenessScope ? { awarenessScope } : {}),
      });
      if (!updated) return failure("找不到对应的 Leader。", 404);
      if (typeof params.role === "string" && service.memory) {
        yield* tryWork(() => service.memory!.write("role", params.role as string, undefined, updated.id)).pipe(
          Effect.ignore,
        );
      }
      return response({ leader: updated });
    }

    if (writing && (subAction === "pause" || subAction === "resume")) {
      const nextPaused = subAction === "pause";
      const updated = yield* service.leaders.updateLeader(leaderId, { status: nextPaused ? "paused" : "active" });
      if (!updated) return failure("找不到对应的 Leader。", 404);
      const bindings = yield* service.leaders.listBindings(updated.id);
      let pausedPending: unknown[] = [];
      if (service.host?.available) {
        // S4: Reconcile binding + leaderPaused for all bound connections (and default Leader fallback).
        const bindingsPayload = bindings.map((b) => ({
          connectionId: b.connectionId,
          leaderId: b.leaderId,
          bindingId: b.bindingId,
          bindingEpoch: b.epoch,
          leaderPaused: nextPaused,
        }));
        yield* call(service.host, "connections.syncBindings", {
          bindings: bindingsPayload,
          ...(updated.id === DEFAULT_LEADER_ID ? { defaultLeaderPaused: nextPaused } : {}),
        }).pipe(Effect.ignore);
        const listed = yield* call(service.host, "paused.list", { leaderId: updated.id }).pipe(
          Effect.orElseSucceed(() => ({})),
        );
        if (isRecord(listed) && Array.isArray(listed.items)) pausedPending = listed.items;
      }
      return response({ leader: updated, pausedPending });
    }

    if (writing && subAction === "paused-decide") {
      if (!service.host?.available) return failure("远程连接服务暂不可用。", 503);
      const leader = yield* service.leaders.getLeader(leaderId);
      if (!leader) return failure("找不到对应的 Leader。", 404);
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
        return failure("所选积压消息不属于该 Leader。", 403);
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
        messageIds: scopedIds,
      }).pipe(
        Effect.match({ onSuccess: (val) => response(val), onFailure: (err) => failure(err.message, 400) }),
      );
    }

    if (writing && subAction === "handoff") {
      if (!service.memory) return failure("伴侣记忆服务暂不可用。", 503);
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

    return failure("找不到对应的 Leader 操作。", 404);
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
    if (writing && typeof params.text !== "string") return failure("需要角色说明文本。", 400);
    return yield* tryWork(async () => {
      if (typeof params.text === "string" && writing) await memory.write("role", params.text, undefined, leaderId);
      return { text: await memory.read("role", undefined, leaderId) };
    }).pipe(Effect.match({ onSuccess: (value) => response(value), onFailure: (error) => failure(error.message, 400) }));
  }
  const method = writing ? writeMethods.has(action) ? action : undefined : readMethods.get(action);
  if (method === undefined) return failure("找不到远程连接操作。", 404);
  if (!service.host?.available) return failure("远程连接服务暂不可用。", 503);
  const rpcParams = method === "people.link" || method === "people.unlink"
    ? { ...params, by: "owner" }
    : params;
  return yield* call(service.host, method, rpcParams).pipe(Effect.match({
    onSuccess: (value) => response(value),
    onFailure: (error) => failure(error.message, 400),
  }));
});

export const route = Layer.unwrap(Effect.map(XtworkIm, (service) => Layer.mergeAll(
  HttpRouter.add("GET", "/api/xtwork/im/*", serve(service)),
  HttpRouter.add("POST", "/api/xtwork/im/*", serve(service)),
)));
