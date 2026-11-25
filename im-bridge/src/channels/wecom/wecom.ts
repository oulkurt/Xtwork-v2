/**
 * WeCom (企业微信) intelligent bot: created by scanning with the WeCom app, then a
 * WebSocket through the official SDK. Replies can stream, which is how the live
 * progress view works here.
 *
 * ADR-011 adaptations:
 * - Preserves QR bot creation + manual BotID/Secret onboarding + WebSocket long connection,
 *   9-minute streaming window handoff, errcode 846605/846608 active-send fallback, and
 *   image/file upload & download.
 * - Keeps `ownerId` unset on `succeeded` so connections naturally enter `pairing` state
 *   for 6-digit claim DM verification.
 *
 * Adapted from earayu/Mingle@006220e880d2134665ce2745ab6233f52c8eabe9
 * (MIT License, Copyright (c) 2026 earayu).
 *
 * The QR endpoints follow dsh-im's implementation, src/channels/wecom/qr-auth.mjs,
 * https://github.com/xmanrui/dsh-im (MIT, Copyright (c) xmanrui).
 */

import { randomUUID } from "node:crypto";
import { readFile, writeFile } from "node:fs/promises";
import { basename, extname } from "node:path";
import { WSClient } from "@wecom/aibot-node-sdk";
import type {
  Capabilities,
  Channel,
  ChannelConnection,
  ChannelEvents,
  ChatRef,
  Credentials,
  InboundAttachment,
  InboundMessage,
  LiveOptions,
  LiveReply,
  OnboardingEvent,
  OutboundMessage,
  SendResult,
} from "../channel.ts";
import { withTextSent } from "../channel.ts";

const GENERATE_URL = "https://work.weixin.qq.com/ai/qc/generate";
const POLL_URL = "https://work.weixin.qq.com/ai/qc/query_result";
const QR_TTL_MS = 5 * 60_000;
const POLL_EVERY_MS = 3000;
/** WeCom splits markdown above roughly 4 KB; stay under it. */
const MAX_TEXT = 3500;
/**
 * Inbound frames kept for streaming replies. A local bound on how long the passive reply
 * credential is trusted, not a platform guarantee; a clearly refused frame falls back to
 * active send (errcode below).
 */
export const FRAME_TTL_MS = 30 * 60_000;
/** The passive reply credential is no longer valid: the req_id is unknown, or the stream expired. */
export const FRAME_REJECTED = new Set([846605, 846608]);
/**
 * A stream reply ends by itself ten minutes after it began (the platform docs; to be verified on
 * a real bot). The caller hands over to active send a minute before that.
 */
export const STREAM_WINDOW_MS = 9 * 60_000;

const CAPABILITIES: Capabilities = {
  quoteReply: true,
  reactions: false,
  typingIndicator: false,
  fileUpload: true,
  fileDownload: true,
  listMembers: false,
  maxTextLength: MAX_TEXT,
};

type Fetch = typeof fetch;

/** The part of WSClient the adapter uses. Injected so tests run offline. */
export interface WecomClientLike {
  connect(): unknown;
  disconnect(): void;
  on(event: string, listener: (...args: never[]) => void): unknown;
  replyStream(frame: Frame, streamId: string, content: string, finish?: boolean): Promise<unknown>;
  sendMessage(chatid: string, body: { msgtype: "markdown"; markdown: { content: string } }): Promise<unknown>;
  uploadMedia(buffer: Buffer, options: { type: "file" | "image"; filename: string }): Promise<{ media_id: string }>;
  sendMediaMessage(chatid: string, type: "file" | "image", mediaId: string): Promise<unknown>;
  downloadFile(url: string, aesKey?: string): Promise<{ buffer: Buffer; filename?: string }>;
}

export interface Frame {
  headers: { req_id: string; [key: string]: unknown };
  body?: WecomMessage;
}

export interface WecomMessage {
  msgid: string;
  chattype?: "single" | "group";
  chatid?: string;
  from?: { userid?: string };
  create_time?: number;
  msgtype?: string;
  text?: { content?: string };
  voice?: { content?: string };
  image?: { url?: string; aeskey?: string };
  file?: { url?: string; aeskey?: string; filename?: string };
  mixed?: { msg_item?: { msgtype: string; text?: { content?: string }; image?: { url?: string; aeskey?: string } }[] };
}

export function trustedAuthUrl(value: unknown): string | undefined {
  if (typeof value !== "string") return undefined;
  try {
    const url = new URL(value);
    return url.protocol === "https:" && url.hostname === "work.weixin.qq.com" ? url.toString() : undefined;
  } catch {
    return undefined;
  }
}

export interface WecomOptions {
  readonly fetch?: Fetch;
  readonly createClient?: (credentials: { botId: string; secret: string }) => WecomClientLike;
  readonly pollEveryMs?: number;
  readonly connectTimeoutMs?: number;
  readonly source?: string;
  readonly streamWindowMs?: number;
  readonly frameTtlMs?: number;
}

export function wecomChannel(options: WecomOptions = {}): Channel {
  const fetchImpl = options.fetch ?? fetch;
  const pollEvery = options.pollEveryMs ?? POLL_EVERY_MS;
  const sourceTag = options.source ?? "xtwork";
  const streamWindowMs = options.streamWindowMs ?? STREAM_WINDOW_MS;
  const frameTtlMs = options.frameTtlMs ?? FRAME_TTL_MS;
  const create =
    options.createClient ??
    ((c) =>
      new WSClient({
        botId: c.botId,
        secret: c.secret,
        logger: { debug() {}, info() {}, warn() {}, error() {} },
      }) as unknown as WecomClientLike);

  const getJson = async (url: URL, signal: AbortSignal) => {
    const response = await fetchImpl(url, {
      redirect: "error",
      headers: { accept: "application/json" },
      signal: AbortSignal.any([signal, AbortSignal.timeout(10_000)]),
    });
    if (!response.ok) throw new Error(`WeCom HTTP ${response.status}`);
    return (await response.json()) as { data?: Record<string, unknown> };
  };

  return {
    platform: "wecom",
    // Only people in the organization can message the bot or add it to a group.
    trust: "org",
    onboarding: { kind: "qr" },
    manualFields: [
      { key: "botId", labelKey: "wecom.botId", secret: false },
      { key: "secret", labelKey: "wecom.secret", secret: true },
    ],

    async *onboard(input, signal, context): AsyncIterable<OnboardingEvent> {
      if (input?.botId && input.secret) {
        // A manual binding is checked by connecting once.
        // Intentionally leaves ownerId unset so the bridge enters `pairing` state for claim DM.
        const ok = await verify({ botId: input.botId, secret: input.secret });
        const name = context?.agentName ?? "Xtwork";
        yield ok
          ? {
              kind: "succeeded",
              credentials: { botId: input.botId, secret: input.secret, name },
              bot: { id: input.botId, name },
            }
          : { kind: "failed", code: "invalid_credentials" };
        return;
      }

      let scode: string;
      try {
        const url = new URL(GENERATE_URL);
        url.searchParams.set("source", sourceTag);
        url.searchParams.set("plat", process.platform === "win32" ? "2" : process.platform === "linux" ? "3" : "1");
        const body = await getJson(url, signal);
        const authUrl = trustedAuthUrl(body.data?.auth_url);
        scode = typeof body.data?.scode === "string" ? body.data.scode : "";
        if (!authUrl || !scode) throw new Error("WeCom returned no QR");
        yield { kind: "qr_ready", qrContent: authUrl, expiresAt: Date.now() + QR_TTL_MS };
      } catch {
        yield { kind: "failed", code: signal.aborted ? "cancelled" : "network" };
        return;
      }

      const deadline = Date.now() + QR_TTL_MS;
      while (!signal.aborted && Date.now() < deadline) {
        await abortableDelay(pollEvery, signal);
        if (signal.aborted) break;
        let data: Record<string, unknown> | undefined;
        try {
          const url = new URL(POLL_URL);
          url.searchParams.set("scode", scode);
          data = (await getJson(url, signal)).data;
        } catch {
          continue; // A failed poll is retried until the code expires.
        }
        const status = String(data?.status ?? "").toLowerCase();
        if (status === "success") {
          const info = data?.bot_info as { botid?: string; secret?: string } | undefined;
          if (!info?.botid || !info.secret) {
            yield { kind: "failed", code: "unknown" };
            return;
          }
          const name = context?.agentName ?? "Xtwork";
          // Intentionally leaves ownerId unset so the bridge enters `pairing` state for claim DM.
          yield {
            kind: "succeeded",
            credentials: { botId: info.botid, secret: info.secret, name },
            bot: { id: info.botid, name },
          };
          return;
        }
        if (status === "expired" || status === "timeout") {
          yield { kind: "failed", code: "expired" };
          return;
        }
        if (["fail", "failed", "error"].includes(status)) {
          yield { kind: "failed", code: "denied" };
          return;
        }
      }
      yield { kind: "failed", code: signal.aborted ? "cancelled" : "expired" };
    },

    async connect(credentials: Credentials, events: ChannelEvents): Promise<ChannelConnection> {
      const botId = credentials.botId ?? "";
      const client = create({ botId, secret: credentials.secret ?? "" });
      const frames = new Map<string, { frame: Frame; at: number }>();
      const files = new Map<string, { url: string; aeskey?: string }>();

      const remember = (id: string, frame: Frame) => {
        frames.set(id, { frame, at: Date.now() });
        for (const [key, value] of frames) {
          if (Date.now() - value.at > frameTtlMs) frames.delete(key);
        }
      };

      /** The cached inbound frame a reply can still ride on; expired entries are dropped on read. */
      const freshFrame = (id: string): Frame | undefined => {
        const known = frames.get(id);
        if (!known) return undefined;
        if (Date.now() - known.at > frameTtlMs) {
          frames.delete(id);
          return undefined;
        }
        return known.frame;
      };

      client.on("message", ((frame: Frame) => {
        const inbound = toInbound(frame);
        if (!inbound || !frame.body) return;
        remember(inbound.platformId, frame);
        for (const a of inbound.attachments) {
          const source = attachmentSource(frame.body, a.id);
          if (source) files.set(a.id, source);
        }
        events.onMessage(inbound);
      }) as never);
      client.on("reconnecting", ((attempt: number) => events.onState({ kind: "reconnecting", attempt })) as never);
      client.on("authenticated", (() => events.onState({ kind: "connected" })) as never);
      client.on("error", ((error: Error) => {
        if (/auth/i.test(error.message)) events.onState({ kind: "error", code: "credentials_revoked" });
      }) as never);

      await authenticate(client, options.connectTimeoutMs ?? 15_000);

      const chatIdOf = (chat: ChatRef) => chat.platformId;

      return {
        bot: { id: botId, name: credentials.name ?? "Xtwork" },
        capabilities: () => CAPABILITIES,

        async send(message: OutboundMessage): Promise<SendResult> {
          let textId = "";
          try {
            let frame = message.replyTo ? freshFrame(message.replyTo) : undefined;
            if (message.text) {
              if (frame) {
                try {
                  await client.replyStream(frame, randomUUID(), message.text, true);
                } catch (error) {
                  // The credential was refused outright: drop it and send actively, once. An
                  // ambiguous failure (a timeout, a broken socket) keeps the old error contract.
                  if (!FRAME_REJECTED.has(wecomErrcode(error) ?? 0)) throw error;
                  if (message.replyTo && frames.get(message.replyTo)?.frame === frame) frames.delete(message.replyTo);
                  frame = undefined;
                }
              }
              if (!frame) {
                await client.sendMessage(chatIdOf(message.chat), {
                  msgtype: "markdown",
                  markdown: { content: message.text },
                });
              }
              textId = `out-${randomUUID()}`;
            }
            for (const file of message.files ?? []) {
              const name = file.name ?? basename(file.path);
              const type = [".png", ".jpg", ".jpeg", ".gif"].includes(extname(name).toLowerCase()) ? "image" : "file";
              const { media_id } = await client.uploadMedia(await readFile(file.path), { type, filename: name });
              await client.sendMediaMessage(chatIdOf(message.chat), type, media_id);
            }
            return {
              kind: "sent",
              platformId: `out-${randomUUID()}`,
              ...(message.replyTo && !frame ? { degraded: ["quote_dropped" as const] } : {}),
            };
          } catch (error) {
            return withTextSent(
              {
                kind: "failed",
                code: /timeout/i.test((error as Error).message) ? "network" : "unknown",
                retryable: true,
              },
              textId,
            );
          }
        },

        // Intelligent bots cannot react; the live stream shows that work has started.
        async react() {},

        async startLive(_chat: ChatRef, liveOptions: LiveOptions): Promise<LiveReply> {
          const frame = freshFrame(liveOptions.replyTo);
          if (!frame) throw new Error("no inbound frame to stream a reply to");
          const streamId = randomUUID();
          // The window starts when the stream does (the docs count from the start), not when the
          // first write returns.
          const until = Date.now() + streamWindowMs;
          await client.replyStream(frame, streamId, liveOptions.initial, false);
          return {
            until,
            update: async (markdown) => {
              await client.replyStream(frame, streamId, markdown, false).catch(() => {});
            },
            finish: async (markdown) => {
              try {
                await client.replyStream(frame, streamId, markdown, true);
                return { kind: "sent", platformId: `stream-${streamId}` };
              } catch (error) {
                if (FRAME_REJECTED.has(wecomErrcode(error) ?? 0) && frames.get(liveOptions.replyTo)?.frame === frame) {
                  frames.delete(liveOptions.replyTo);
                }
                // The stream may have expired; the caller then sends the answer as a new message.
                return { kind: "failed", code: "unknown", retryable: false };
              }
            },
          };
        },

        async setTyping() {},

        async download(attachment: InboundAttachment, toPath: string) {
          const source = files.get(attachment.id);
          if (!source) throw new Error("this file is no longer available; ask for it to be sent again");
          const { buffer } = await client.downloadFile(source.url, source.aeskey);
          await writeFile(toPath, buffer);
        },

        async listMembers() {
          return [];
        },

        async close() {
          client.disconnect();
        },
      };
    },
  };

  async function verify(credentials: { botId: string; secret: string }): Promise<boolean> {
    const client = create(credentials);
    try {
      await authenticate(client, options.connectTimeoutMs ?? 15_000);
      return true;
    } catch {
      return false;
    } finally {
      client.disconnect();
    }
  }
}

function abortableDelay(ms: number, signal: AbortSignal): Promise<void> {
  if (signal.aborted || ms <= 0) return Promise.resolve();
  return new Promise((resolve) => {
    const onAbort = () => {
      clearTimeout(timer);
      resolve();
    };
    const timer = setTimeout(() => {
      signal.removeEventListener("abort", onAbort);
      resolve();
    }, ms);
    signal.addEventListener("abort", onAbort, { once: true });
  });
}

/** The errcode of a refused WeCom call: the SDK rejects with the plain ack frame. */
function wecomErrcode(error: unknown): number | undefined {
  const code = (error as { errcode?: unknown } | null | undefined)?.errcode;
  return typeof code === "number" ? code : undefined;
}

function authenticate(client: WecomClientLike, timeoutMs: number): Promise<void> {
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error("WeCom did not authenticate in time")), timeoutMs);
    client.on("authenticated", (() => {
      clearTimeout(timer);
      resolve();
    }) as never);
    client.on("error", ((error: Error) => {
      if (/auth/i.test(error.message)) {
        clearTimeout(timer);
        reject(error);
      }
    }) as never);
    client.connect();
  });
}

function attachmentSource(body: WecomMessage, id: string): { url: string; aeskey?: string } | undefined {
  const index = Number(id.split(":").at(-1));
  const sources: { url?: string; aeskey?: string }[] = [];
  if (body.image) sources.push(body.image);
  if (body.file) sources.push(body.file);
  for (const item of body.mixed?.msg_item ?? []) if (item.image) sources.push(item.image);
  const source = sources[index];
  return source?.url ? { url: source.url, ...(source.aeskey ? { aeskey: source.aeskey } : {}) } : undefined;
}

/** Map an inbound WeCom frame to channel's shape. Exported for tests. */
export function toInbound(frame: Frame): InboundMessage | undefined {
  const body = frame.body;
  const sender = body?.from?.userid;
  if (!body?.msgid || !sender) return undefined;
  const group = body.chattype === "group" && body.chatid;
  const parts: string[] = [];
  const attachments: InboundAttachment[] = [];
  const addFile = (name: string, mime?: string) =>
    attachments.push({ id: `${body.msgid}:${attachments.length}`, name, ...(mime ? { mime } : {}) });

  if (body.text?.content) parts.push(body.text.content);
  if (body.voice?.content) parts.push(body.voice.content);
  if (body.image?.url) addFile(`image-${body.msgid}.jpg`, "image/jpeg");
  if (body.file?.url) addFile(body.file.filename ?? `file-${body.msgid}`);
  for (const item of body.mixed?.msg_item ?? []) {
    if (item.msgtype === "text" && item.text?.content) parts.push(item.text.content);
    if (item.msgtype === "image" && item.image?.url)
      addFile(`image-${body.msgid}-${attachments.length}.jpg`, "image/jpeg");
  }
  // In groups the bot only receives messages that @ it; drop the leading mention.
  const text = parts
    .join("\n")
    .replace(/^@\S+\s*/u, "")
    .trim();

  return {
    platformId: body.msgid,
    chat: group ? { platformId: body.chatid as string, kind: "group" } : { platformId: sender, kind: "dm" },
    sender: { id: sender, name: "", isBot: false },
    text,
    attachments,
    addressedToBot: true,
    sentAt: body.create_time ? body.create_time * 1000 : Date.now(),
  };
}
