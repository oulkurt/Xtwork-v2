import * as Context from "effect/Context";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Option from "effect/Option";
import { McpSchema, McpServer } from "effect/ai";
import * as McpInvocationContext from "./McpInvocationContext.ts";
import { isRecord } from "./XtworkPluginHost.ts";
import { pluginHostError, XtworkPlugins } from "./XtworkPluginService.ts";

const toolError = (message: string) =>
  new McpSchema.CallToolResult({ isError: true, content: [{ type: "text", text: message }] });

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
            return Effect.tryPromise({
              try: (signal) => host.invoke(tool.name, input ?? {}, thread.threadId, signal),
              catch: pluginHostError,
            }).pipe(
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
