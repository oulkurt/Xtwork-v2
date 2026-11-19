// @effect-diagnostics nodeBuiltinImport:off - hashes an MCP request identity for plugin storage.
import * as NodeCrypto from "node:crypto";
import * as Context from "effect/Context";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Option from "effect/Option";
import { McpSchema, McpServer } from "effect/ai";
import { HttpServerRequest } from "effect/http";
import * as McpInvocationContext from "./McpInvocationContext.ts";
import { isRecord } from "./XtworkPluginHost.ts";
import { pluginHostError, XtworkPlugins } from "./XtworkPluginService.ts";

const toolError = (message: string) =>
  new McpSchema.CallToolResult({ isError: true, content: [{ type: "text", text: message }] });

const requestOperationKey = (
  request: HttpServerRequest.HttpServerRequest | undefined,
  thread: McpInvocationContext.McpThreadCaller,
  tool: string,
) => {
  const sessionId = request?.headers["mcp-session-id"];
  if (sessionId === undefined || request === undefined) return Effect.undefined;
  // Effect caches the request body. The tool handler receives only the arguments,
  // so read the original JSON-RPC id from that body.
  return request.json.pipe(
    Effect.map((message) => {
      if (
        !isRecord(message) ||
        message.method !== "tools/call" ||
        (typeof message.id !== "string" && typeof message.id !== "number")
      ) {
        return undefined;
      }
      return NodeCrypto.createHash("sha256")
        .update(JSON.stringify([thread.providerSessionId, sessionId, tool, message.id]))
        .digest("hex");
    }),
    Effect.orElseSucceed(() => undefined),
  );
};

export const layer = Layer.effectDiscard(
  Effect.gen(function* () {
    const server = yield* McpServer.McpServer;
    const plugins = yield* Effect.serviceOption(XtworkPlugins);
    const host = Option.getOrUndefined(plugins)?.host;
    if (host === undefined) return;
    const tools = yield* Effect.tryPromise({
      try: (signal) => host.list(signal),
      catch: pluginHostError,
    });
    for (const tool of tools) {
      yield* server.addTool({
        tool: new McpSchema.Tool({
          name: tool.name,
          title: tool.title,
          description: tool.description,
          inputSchema: tool.inputSchema,
        }),
        annotations: Context.empty(),
        handle: (input) =>
          Effect.withFiber((fiber) => {
            const thread = Option.getOrUndefined(
              Context.getOption(fiber.context, McpInvocationContext.McpInvocationContext),
            )?.thread;
            if (thread === undefined)
              return Effect.succeed(toolError("This plugin tool requires a local chat session."));
            const request = Context.getOrUndefined(
              fiber.context,
              HttpServerRequest.HttpServerRequest,
            );
            return requestOperationKey(request, thread, tool.name).pipe(
              Effect.flatMap((operationKey) =>
                Effect.tryPromise({
                  try: (signal) =>
                    host.invoke(
                      tool.name,
                      input ?? {},
                      { threadId: thread.threadId, operationKey },
                      signal,
                    ),
                  catch: pluginHostError,
                }),
              ),
              Effect.match({
                onFailure: (error) => toolError(error.message),
                onSuccess: (value) =>
                  new McpSchema.CallToolResult({
                    isError: false,
                    content: [
                      {
                        type: "text",
                        text: typeof value === "string" ? value : JSON.stringify(value),
                      },
                    ],
                    ...(isRecord(value) ? { structuredContent: value } : {}),
                  }),
              }),
            );
          }),
      });
    }
  }).pipe(Effect.catch((error) => Effect.logWarning("Could not load Xtwork plugin tools", error))),
);
