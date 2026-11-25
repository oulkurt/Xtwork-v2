// @effect-diagnostics nodeBuiltinImport:off globalTimers:off globalDate:off globalDateInEffect:off globalJsonInEffect:off effectTryWithoutCatch:off globalErrorInEffectCatch:off globalErrorInEffectFailure:off effectFnOpportunity:off deterministicKeys:off matchBooleanToIsSuccess:off
import { AuthOrchestrationOperateScope, AuthOrchestrationReadScope, CommandId, ThreadId } from "@t3tools/contracts";
import * as ByteSize from "effect/ByteSize";
import * as Clock from "effect/Clock";
import * as Context from "effect/Context";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Option from "effect/Option";
import * as Queue from "effect/Queue";
import * as Schedule from "effect/Schedule";
import { Headers, HttpRouter, HttpServerRequest, HttpServerResponse } from "effect/http";
import { EnvironmentAuth, parseBearerToken } from "../auth/EnvironmentAuth.ts";
import { forkParked } from "../serverActivation.ts";
import { bridgeOptions, type BridgePayload, isRecord, XtworkImBridgeHost } from "./XtworkImBridgeHost.ts";
import { activeStatuses, decodeInbound, isTerminal, makeDispatcher, type ImDispatcher } from "./XtworkImDispatch.ts";
import { XtworkImMemory } from "./XtworkImMemory.ts";
import { hashArgs, imError, ImApprovals } from "./XtworkImSecurity.ts";

interface ImService {
  readonly host?: XtworkImBridgeHost;
  readonly memory?: XtworkImMemory;
  readonly dispatch?: ImDispatcher;
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

const makeDeliveryWorker = (host: XtworkImBridgeHost, dispatch: ImDispatcher, hasReplySucceeded: (turnId: string) => boolean) => {
  const live = new Map<string, { text: string; liveId: string | null }>();
  const sync = Effect.fnUntraced(function* (row: Effect.Success<ImDispatcher["unsettled"]>[number]) {
    const inbound = decodeInbound(row.payloadJson);
    const threadId = ThreadId.make(row.threadId);
    const messageId = `xtwork-im:${hashArgs(inbound.key)}`;
    const records = yield* dispatch.orchestrator.getThreadRecords(threadId, ["runs", "messages"]);
    const run = records.runs.find((run) => run.userMessageId === messageId);
    if (run === undefined) return;
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
      yield* call(host, "inbound.settle", { idempotencyKey: inbound.key, event });
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
  const defaultService = {
    approvals,
    markReplySucceeded: (turnId: string) => { repliedTurns.add(turnId); },
    hasReplySucceeded: (turnId: string) => repliedTurns.has(turnId),
    eventsSince: (after: number) => events.filter((item) => item.sequence > after),
  };
  const options = yield* Effect.try({ try: bridgeOptions, catch: imError }).pipe(Effect.orElseSucceed(() => undefined));
  if (options === undefined) return defaultService;
  const memory = new XtworkImMemory(options.companionDir);
  const dispatch = yield* makeDispatcher(options.dataDir, memory);
  const queue = yield* Queue.unbounded<BridgeEvent>();
  const epoch = (yield* Clock.currentTimeMillis) * 1000;
  let sequence = epoch;
  const host = yield* Effect.acquireRelease(
    Effect.sync(() => {
      const host = new XtworkImBridgeHost(options, (event, payload) => {
        const item = { sequence: ++sequence, event, payload };
        if (["onboarding.event", "connection.state", "access.held"].includes(event)) {
          events.push(item);
          if (events.length > 200) events.shift();
        }
        if (event === "inbound.dispatch" || event === "inbound.stop") Queue.offerUnsafe(queue, item);
      });
      host.start();
      return host;
    }),
    (host) => Effect.promise(() => host.close()),
  );

  const handle = Effect.fnUntraced(function* ({ event, payload }: BridgeEvent) {
    if (event === "inbound.dispatch") {
      const { threadId, turnId, inbound } = yield* dispatch.accept(payload);
      yield* call(host, "inbound.ack", {
        idempotencyKey: inbound.key, t3ThreadId: threadId, t3TurnId: turnId,
      });
      return;
    }
    if (payload.senderRole !== "owner" && payload.verifiedOwner !== true) return;
    if (typeof payload.connectionId !== "string" || typeof payload.chatId !== "string") return;
    const explicitThread = typeof payload.threadId === "string" && payload.threadId.startsWith("xtwork-im-")
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
]);
const writeMethods = new Set([
  "onboarding.start", "onboarding.submitCode", "onboarding.cancel",
  "connections.pause", "connections.resume", "connections.disconnect", "connections.claimRefresh",
  "connections.permissions", "access.decide", "access.setAskAll",
  "contacts.rename", "contacts.note", "people.link", "people.unlink",
]);
const response = (value: unknown, status = 200) =>
  HttpServerResponse.jsonUnsafe(value ?? {}, { status, headers: { "cache-control": "no-store" } });
const failure = (error: string, status: number) => response({ error }, status);

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
  const action = url.pathname.slice("/api/xtwork/im/".length).replaceAll("/", ".");
  if (["approvals", "onboarding.events", "companion.role", "contacts", "people", "access"].includes(action) &&
      session.value.subject !== "desktop-bootstrap") {
    return failure("请从本机桌面查看此数据。", 403);
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
    return typeof params.id === "string" && typeof params.approved === "boolean" &&
      service.approvals.decide(params.id, params.approved)
      ? response({ decided: true })
      : failure("此审批已处理或过期。", 409);
  }
  if (action === "companion.role" && service.memory) {
    const memory = service.memory;
    if (writing && typeof params.text !== "string") return failure("需要角色说明文本。", 400);
    return yield* tryWork(async () => {
      if (typeof params.text === "string" && writing) await memory.write("role", params.text);
      return { text: await memory.read("role") };
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
