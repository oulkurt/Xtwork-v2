// @effect-diagnostics nodeBuiltinImport:off - hashes an MCP request identity for plugin storage.
import * as NodeCrypto from "node:crypto";
import * as Context from "effect/Context";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Option from "effect/Option";
import { McpSchema, McpServer, Tool } from "effect/ai";
import { HttpServerRequest } from "effect/http";
import { desktopContext, isImThread, pluginNeedsApproval, type CompanionScope } from "../im/XtworkImSecurity.ts";
import { XtworkIm } from "../im/XtworkImService.ts";
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
    const im = Option.getOrUndefined(yield* Effect.serviceOption(XtworkIm));
    const plugins = yield* Effect.serviceOption(XtworkPlugins);
    const host = Option.getOrUndefined(plugins)?.host;
    if (host === undefined) return;
    const tools = yield* Effect.tryPromise({
      try: (signal) => host.list(signal),
      catch: pluginHostError,
    });
    for (const tool of tools) {
      const readOnly = tool.name === "todo__list";
      const scoped = tool.name.startsWith("todo__");
      const inputSchema = scoped ? {
        ...tool.inputSchema,
        properties: {
          ...(isRecord(tool.inputSchema.properties) ? tool.inputSchema.properties : {}),
          scope: { type: "string", enum: ["current", "private"], description: "Use the current chat's records by default. Private records need a local approval in group chats." },
        },
      } : tool.inputSchema;
      yield* server.addTool({
        tool: new McpSchema.Tool({
          name: tool.name,
          title: tool.title,
          description: tool.description,
          inputSchema,
          ...(readOnly ? { annotations: { readOnlyHint: true } } : {}),
        }),
        annotations: readOnly ? Context.add(Context.empty(), Tool.Readonly, true) : Context.empty(),
        handle: (input) =>
          Effect.withFiber((fiber) => {
            const invocation = Option.getOrUndefined(
              Context.getOption(fiber.context, McpInvocationContext.McpInvocationContext),
            );
            const thread = invocation?.thread;
            if (thread === undefined)
              return Effect.succeed(toolError("This plugin tool requires a local chat session."));
            const execution = invocation?.imExecution;
            if (isImThread(thread.threadId) && !execution)
              return Effect.succeed(toolError("No active IM turn was found."));
            const context = execution?.context ?? desktopContext;
            const inputObject = isRecord(input) ? input : {};
            const { scope: requestedScope, ...toolArgs } = inputObject;
            const scope: CompanionScope = scoped && requestedScope !== "private" ? context.companionScope : "private";
            const needsApproval = pluginNeedsApproval(context, scope, tool.confirm === true);
            const request = Context.getOrUndefined(
              fiber.context,
              HttpServerRequest.HttpServerRequest,
            );
            return requestOperationKey(request, thread, tool.name).pipe(
              Effect.flatMap((operationKey) =>
                Effect.tryPromise({
                  try: async (signal) => {
                    if (needsApproval) {
                      if (!im) throw new Error("Local approval is unavailable.");
                      await im.approvals.require(execution ?? { turnId: thread.threadId, context },
                        tool.name, { input, scope }, signal);
                    }
                    return host.invoke(
                      tool.name,
                      (scoped ? toolArgs : input ?? {}) as typeof input & {},
                      { threadId: thread.threadId, operationKey, ...(scoped ? { scope } : {}) },
                      signal,
                      needsApproval,
                    );
                  },
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
