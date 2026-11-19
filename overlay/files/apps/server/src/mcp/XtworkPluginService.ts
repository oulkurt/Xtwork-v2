import { AuthOrchestrationOperateScope, AuthOrchestrationReadScope } from "@t3tools/contracts";
import * as ByteSize from "effect/ByteSize";
import * as Context from "effect/Context";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Option from "effect/Option";
import * as Schema from "effect/Schema";
import { Headers, HttpRouter, HttpServerRequest, HttpServerResponse } from "effect/http";
import { EnvironmentAuth, parseBearerToken } from "../auth/EnvironmentAuth.ts";
import { ServerConfig } from "../config.ts";
import { requestUrl } from "../requestUrl.ts";
import { pluginHostOptions, XtworkPluginHost } from "./XtworkPluginHost.ts";

class PluginHostRequestError extends Schema.TaggedError<
  PluginHostRequestError,
  { readonly brand: unique symbol }
>()("PluginHostRequestError", { cause: Schema.Defect(), message: Schema.String }) {}

export const pluginHostError = (cause: unknown) =>
  new PluginHostRequestError({
    cause,
    message: cause instanceof Error ? cause.message : "The plugin host request failed.",
  });

export class XtworkPlugins extends Context.Service<
  XtworkPlugins,
  { readonly host: XtworkPluginHost | undefined }
>()("t3/mcp/XtworkPluginService/XtworkPlugins") {}

export const layer = Layer.effect(
  XtworkPlugins,
  Effect.gen(function* () {
    const config = yield* ServerConfig;
    const options = yield* Effect.try({
      try: () => pluginHostOptions(config.stateDir),
      catch: pluginHostError,
    }).pipe(
      Effect.catch((error) => Effect.logWarning("Invalid Xtwork plugin host configuration", error)),
    );
    if (options === undefined) return { host: undefined };
    const host = yield* Effect.acquireRelease(
      Effect.sync(() => new XtworkPluginHost(options)),
      (host) => Effect.promise(() => host.close()),
    );
    return { host };
  }),
);

const routePath = "/api/xtwork/todo";
const response = (payload: unknown, status: number) =>
  HttpServerResponse.jsonUnsafe(payload, { status, headers: { "cache-control": "no-store" } });
const errorResponse = (message: string, status: number) => response({ error: message }, status);
const filters = ["all", "today", "week", "done", "overdue"];
const decodeJson = Schema.decodeUnknownEffect(Schema.Json);
const writeMethods = ["POST", "PATCH", "DELETE"];

const serveTodo = Effect.fn("XtworkPlugins.serveTodo")(function* (
  host: XtworkPluginHost | undefined,
) {
  const request = yield* HttpServerRequest.HttpServerRequest;
  // The panel dispatches through an authenticated host page, never from its iframe.
  if (parseBearerToken(request) === null) return errorResponse("Sign in to view your todos.", 401);
  const auth = yield* EnvironmentAuth;
  const bearerRequest = request.modify({ headers: Headers.remove(request.headers, "cookie") });
  const session = yield* auth.authenticateHttpRequest(bearerRequest).pipe(Effect.option);
  if (Option.isNone(session)) return errorResponse("Sign in to view your todos.", 401);
  const creating = request.method === "POST";
  const writing = writeMethods.includes(request.method);
  const listing = request.method === "GET";
  if (
    !session.value.scopes.includes(
      writing ? AuthOrchestrationOperateScope : AuthOrchestrationReadScope,
    ) ||
    (writing && session.value.subject !== "desktop-bootstrap")
  ) {
    return errorResponse("This session does not have permission to access todos.", 403);
  }
  if (host === undefined) return errorResponse("The todo plugin is unavailable.", 503);
  const url = requestUrl(request);
  if (Option.isNone(url)) return errorResponse("Invalid request URL.", 400);
  const filter = url.value.searchParams.get("filter") ?? "all";
  const fullNotes = url.value.searchParams.get("fullNotes") === "true";
  if (listing && !filters.includes(filter)) return errorResponse("Invalid todo filter.", 400);
  const offset = Number(url.value.searchParams.get("offset") ?? 0);
  if (listing && (!Number.isInteger(offset) || offset < 0 || offset > 1000)) {
    return errorResponse("Invalid todo offset.", 400);
  }
  const input = listing
    ? Option.some({ filter, offset, ...(fullNotes ? { fullNotes: true } : {}) })
    : yield* request.json.pipe(
        Effect.provideService(HttpServerRequest.MaxBodySize, ByteSize.kibibytes(16)),
        Effect.flatMap(decodeJson),
        Effect.option,
      );
  if (Option.isNone(input)) return errorResponse("Expected a JSON todo.", 400);
  const operation = input.value;
  const operationObject =
    typeof operation === "object" && operation !== null && !Array.isArray(operation)
      ? (operation as Readonly<Record<string, Schema.Json>>)
      : undefined;
  if (
    request.method === "PATCH" &&
    operationObject?.action !== undefined &&
    operationObject.action !== "update" &&
    operationObject.action !== "complete"
  ) {
    return errorResponse("Invalid todo action.", 400);
  }
  const name = creating
    ? "todo__create"
    : listing
      ? "todo__list"
      : request.method === "PATCH"
        ? operationObject?.action === "complete"
          ? "todo__complete"
          : "todo__update"
        : "todo__delete";
  const callInput =
    request.method === "PATCH" && operationObject?.action !== undefined
      ? Object.fromEntries(Object.entries(operationObject).filter(([key]) => key !== "action"))
      : operation;
  return yield* Effect.tryPromise({
    try: (signal) => host.callView(name, callInput, signal),
    catch: pluginHostError,
  }).pipe(
    Effect.match({
      onFailure: (error) => errorResponse(error.message, 400),
      onSuccess: (value) => response(value, creating ? 201 : 200),
    }),
  );
});

export const route = Layer.unwrap(
  Effect.map(XtworkPlugins, ({ host }) =>
    Layer.mergeAll(
      HttpRouter.add("GET", routePath, serveTodo(host)),
      HttpRouter.add("POST", routePath, serveTodo(host)),
      HttpRouter.add("PATCH", routePath, serveTodo(host)),
      HttpRouter.add("DELETE", routePath, serveTodo(host)),
    ),
  ),
);
