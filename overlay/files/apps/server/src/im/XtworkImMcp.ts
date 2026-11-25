// @effect-diagnostics nodeBuiltinImport:off globalTimers:off globalDate:off globalDateInEffect:off globalJsonInEffect:off effectTryWithoutCatch:off globalErrorInEffectCatch:off globalErrorInEffectFailure:off effectFnOpportunity:off deterministicKeys:off matchBooleanToIsSuccess:off
import * as Context from "effect/Context";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Option from "effect/Option";
import { McpSchema, McpServer, Tool } from "effect/ai";
import { McpInvocationContext } from "../mcp/McpInvocationContext.ts";
import { type BridgePayload, isRecord } from "./XtworkImBridgeHost.ts";
import { memoryScope } from "./XtworkImMemory.ts";
import { imError, isImThread, memoryNeedsApproval, nativeNeedsApproval, scopedPath, untrustedEnvelope } from "./XtworkImSecurity.ts";
import { XtworkIm } from "./XtworkImService.ts";

const field = { type: "string" } as const;
const inThreadField = { type: "object", properties: { title: field }, required: ["title"], additionalProperties: false } as const;
const schemas = {
  im__reply: ["Reply to the message that started this turn.", { text: field, inThread: inThreadField, inChat: { type: "boolean" } }, ["text"]],
  im__send: ["Send a text message to an IM chat.", { text: field, chatId: field, connectionId: field }, ["text", "chatId"]],
  im__read: ["Read recent IM messages.", { chatId: field, connectionId: field }, []],
  im__search: ["Search messages in the current chat or an approved chat.", { query: field, chatId: field, connectionId: field }, ["query"]],
  im__file_get: ["Download an attachment from this message into the task workspace.", { fileId: field, destPath: field }, ["fileId", "destPath"]],
  im__contact_list: ["List contacts for the current IM chat.", {}, []],
  im__contact_name: ["Set a contact's display name.", { contactId: field, name: field }, ["contactId", "name"]],
  im__contact_note: ["Set a contact's note.", { contactId: field, note: field }, ["contactId", "note"]],
  im__contact_link: ["Link contacts to an existing person.", { contactIds: { type: "array", items: field, minItems: 2 }, }, ["contactIds"]],
  im__memory_read: ["Read companion memory or a Markdown note.", { scope: field, note: field }, []],
  im__memory_write: ["Write companion memory or a Markdown note.", { scope: field, note: field, text: field }, ["text"]],
  im__native_policy: ["Internal Pi permission hook.", { toolName: field, args: { type: "object" } }, ["toolName", "args"]],
} as const;

type ToolName = keyof typeof schemas;
type ToolService = Pick<XtworkIm["Service"], "approvals" | "host" | "memory" | "markReplySucceeded">;
type ImExecution = NonNullable<Effect.Success<ReturnType<NonNullable<XtworkIm["Service"]["dispatch"]>["resolveExecution"]>>>;
const readOnly = new Set<ToolName>(["im__read", "im__search", "im__contact_list", "im__memory_read"]);
const rpcMethods = {
  im__reply: "messages.reply",
  im__send: "messages.send",
  im__read: "messages.read",
  im__search: "messages.search",
  im__contact_list: "contacts.list",
  im__contact_name: "contacts.rename",
  im__contact_note: "contacts.note",
  im__contact_link: "people.link",
} as const;

const textField = (input: BridgePayload, key: string) => {
  const value = input[key];
  if (typeof value !== "string") throw new Error(`Expected ${key}.`);
  return value;
};

export const imToolAllowed = (threadId: string | undefined, tool: string, listing: boolean) =>
  threadId !== undefined && isImThread(threadId)
    ? (Object.hasOwn(schemas, tool) && (!listing || tool !== "im__native_policy")) || /^todo__[a-z]+$/u.test(tool)
    : !tool.startsWith("im__");

export async function runImTool(service: ToolService, execution: ImExecution, name: ToolName, args: BridgePayload, signal: AbortSignal) {
  const { context, turnId, inbound } = execution;
  const approve = (details: BridgePayload = args) => service.approvals.require(execution, name, details, signal);
  if (name === "im__native_policy") {
    const toolName = textField(args, "toolName");
    if (await nativeNeedsApproval(context, toolName, args.args)) {
      await service.approvals.require(execution, toolName, args.args, signal);
    }
    return { allowed: true };
  }
  if (name === "im__memory_read" || name === "im__memory_write") {
    if (!service.memory) throw new Error("Companion memory is unavailable.");
    const scope = memoryScope(args.scope ?? context.companionScope);
    const note = args.note === undefined ? undefined : textField(args, "note");
    if (memoryNeedsApproval(context, scope) && (name === "im__memory_write" || scope !== "role")) {
      await approve({ ...args, scope });
    }
    if (name === "im__memory_read") return untrustedEnvelope(await service.memory.read(scope, note), context);
    await service.memory.write(scope, textField(args, "text"), note);
    return { saved: true };
  }
  const host = service.host;
  if (!host) throw new Error("The IM bridge is unavailable.");
  const target = { connectionId: context.connectionId, chatId: context.chatId, platformMsgId: inbound.platformMsgId, turnId };
  const replySucceeded = (result: unknown) =>
    isRecord(result) && isRecord(result.result) && ["sent", "uncertain"].includes(String(result.result.kind));
  if (name === "im__reply") {
    if (!inbound.messageId) throw new Error("The current message has no internal message ID.");
    const result = await host.request("messages.reply", {
      messageId: inbound.messageId,
      text: textField(args, "text"),
      ...(isRecord(args.inThread) ? { inThread: args.inThread } : {}),
      ...(args.inChat === true ? { inChat: true } : {}),
    }, signal);
    if (replySucceeded(result)) service.markReplySucceeded(turnId);
    return untrustedEnvelope(result ?? {}, context);
  }
  if (name === "im__file_get") {
    if (!context.isolatedWorkspaceRoot) throw new Error("This turn has no isolated workspace.");
    const fileId = textField(args, "fileId");
    const attachments = inbound.message.attachments;
    if (!Array.isArray(attachments) || !attachments.some((attachment) => isRecord(attachment) && attachment.id === fileId)) {
      throw new Error("This attachment does not belong to the current message.");
    }
    const destPath = await scopedPath(context.isolatedWorkspaceRoot, textField(args, "destPath"));
    const result = await host.request("files.download", {
      fileId,
      destPath,
      allowedRoot: context.isolatedWorkspaceRoot,
    }, signal);
    return untrustedEnvelope(result ?? { destPath }, context);
  }
  if (name === "im__contact_link") {
    const contactIds = args.contactIds;
    if (!Array.isArray(contactIds) || contactIds.some((contactId) => typeof contactId !== "string")) {
      throw new Error("Expected contactIds.");
    }
    await approve();
    const result = await host.request("people.link", { contactIds, by: "agent" }, signal);
    return untrustedEnvelope(result ?? {}, context);
  }
  const chatId = args.chatId === undefined ? target.chatId : textField(args, "chatId");
  const connectionId = args.connectionId === undefined ? target.connectionId : textField(args, "connectionId");
  if (name === "im__send" || name === "im__read" || name === "im__search") {
    if (!connectionId || !chatId) throw new Error("An explicit destination is required.");
    if (chatId !== target.chatId || connectionId !== target.connectionId) await approve({ ...args, chatId, connectionId });
  }
  if (["im__contact_name", "im__contact_note", "im__contact_link"].includes(name)) {
    await approve();
  }
  const result = await host.request(rpcMethods[name], { ...args, ...target, chatId, connectionId }, signal);
  return untrustedEnvelope(result ?? {}, context);
}

export const layer = Layer.effectDiscard(Effect.gen(function* () {
  const server = yield* McpServer.McpServer;
  const services = Option.getOrUndefined(yield* Effect.serviceOption(XtworkIm));
  if (!services?.dispatch) return;
  for (const name of Object.keys(schemas) as ToolName[]) {
    const [description, properties, required] = schemas[name];
    yield* server.addTool({
      tool: new McpSchema.Tool({
        name, description,
        inputSchema: { type: "object", properties, required: [...required], additionalProperties: false },
        ...(readOnly.has(name) ? { annotations: { readOnlyHint: true } } : {}),
      }),
      annotations: readOnly.has(name) ? Context.add(Context.empty(), Tool.Readonly, true) : Context.empty(),
      handle: Effect.fnUntraced(function* (input) {
        const scope = Option.getOrUndefined(yield* Effect.serviceOption(McpInvocationContext));
        const execution = scope?.imExecution;
        if (!execution) return yield* imError("This tool requires an active IM turn.");
        return yield* Effect.tryPromise({
          try: (signal) => runImTool(services, execution, name, isRecord(input) ? input : {}, signal),
          catch: imError,
        });
      }, Effect.match({
        onFailure: (error) => new McpSchema.CallToolResult({ isError: true, content: [{ type: "text", text: error.message }] }),
        onSuccess: (value) => new McpSchema.CallToolResult({
          isError: false,
          content: [{ type: "text", text: typeof value === "string" ? value : JSON.stringify(value) }],
          ...(isRecord(value) ? { structuredContent: value } : {}),
        }),
      })),
    });
  }
}));
