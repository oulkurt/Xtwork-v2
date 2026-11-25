/**
 * Comment threads in Feishu documents. A document is a group chat of its own:
 * people @ the bot in a comment, or in a reply to one, and the agent answers in that thread.
 *
 * Feishu pushes `drive.notice.comment_add_v1` to the app whenever the bot would get a comment
 * notification in the Feishu app: an @ in a comment or a reply, or a new reply in a thread the bot
 * is part of. Only an @ wakes the agent; the rest is kept as background, like a group.
 *
 * Adapted from earayu/Mingle@006220e880d2134665ce2745ab6233f52c8eabe9
 * (MIT License, Copyright (c) 2026 earayu).
 */

import type * as lark from "@larksuiteoapi/node-sdk";
import type { BotIdentity, ChatRef, Degradation, InboundMessage, OutboundMessage, SendResult } from "../channel.ts";
import { type Mention, mentionSpots } from "../mention.ts";

/** Read a document's comments and reply in them. Any one scope of each pair is enough on Feishu. */
export const DOC_COMMENT_SCOPES = ["docs:document.comment:read", "docs:document.comment:create"] as const;
/** The document's title and link, for the thread's name. Without it the thread is still answered. */
export const DOC_META_SCOPE = "drive:drive.metadata:readonly";
export const DOC_COMMENT_EVENT = "drive.notice.comment_add_v1";

const PREFIX = "doc:";
/** Earlier replies shown with an @, at most; each one cut at `CONTEXT_CHARS`. */
const CONTEXT_REPLIES = 10;
const CONTEXT_CHARS = 500;
const QUOTE_CHARS = 200;
const NAME_QUOTE_CHARS = 24;
/** Pages of 100 replies read per thread: a thread longer than that is read from its start. */
const REPLY_PAGES = 5;

type FileType = "doc" | "docx" | "sheet" | "file" | "slides" | "bitable";

export interface CommentThread {
  readonly fileType: string;
  readonly fileToken: string;
  readonly commentId: string;
}

/** `doc:<file type>:<file token>:<comment id>`: the thread's chat ID. Feishu's own chat IDs start with `oc_`. */
export function threadId(thread: CommentThread): string {
  return `${PREFIX}${thread.fileType}:${thread.fileToken}:${thread.commentId}`;
}

export function parseThread(platformId: string): CommentThread | undefined {
  if (!platformId.startsWith(PREFIX)) return undefined;
  const [fileType, fileToken, commentId] = platformId.slice(PREFIX.length).split(":");
  return fileType && fileToken && commentId ? { fileType, fileToken, commentId } : undefined;
}

type Element = {
  type: "text_run" | "docs_link" | "person";
  text_run?: { text: string };
  docs_link?: { url: string };
  person?: { user_id: string };
};

export interface Reply {
  readonly id: string;
  readonly userId: string;
  readonly elements: readonly Element[];
  /** Seconds, as Feishu reports them. */
  readonly createdAt: number;
}

type Client = Pick<lark.Client, "drive">;

/** The thread's anchor text and every reply, oldest first. Throws when the bot cannot read the document. */
export async function readThread(
  client: Client,
  thread: CommentThread,
): Promise<{ quote: string | undefined; replies: Reply[] }> {
  const fileType = thread.fileType as FileType;
  const comment = await client.drive.v1.fileComment.batchQuery({
    path: { file_token: thread.fileToken },
    params: { file_type: fileType, user_id_type: "open_id" },
    data: { comment_ids: [thread.commentId] },
  });
  const item = comment.data?.items?.[0];
  const replies: Reply[] = [];
  const add = (
    list: readonly {
      reply_id?: string | undefined;
      user_id?: string | undefined;
      content?: { elements?: Element[] | undefined } | undefined;
      create_time?: number | undefined;
    }[],
  ) => {
    for (const r of list) {
      if (!r.reply_id || replies.some((x) => x.id === r.reply_id)) continue;
      replies.push({
        id: r.reply_id,
        userId: r.user_id ?? "",
        elements: r.content?.elements ?? [],
        createdAt: r.create_time ?? 0,
      });
    }
  };
  add(item?.reply_list?.replies ?? []);
  if (!item || item.has_more) {
    let pageToken: string | undefined;
    for (let page = 0; page < REPLY_PAGES; page++) {
      const response = await client.drive.v1.fileCommentReply.list({
        path: { file_token: thread.fileToken, comment_id: thread.commentId },
        params: {
          file_type: fileType as "doc" | "docx" | "sheet" | "file" | "slides",
          user_id_type: "open_id",
          page_size: 100,
          ...(pageToken ? { page_token: pageToken } : {}),
        },
      });
      add(response.data?.items ?? []);
      if (!response.data?.has_more || !response.data.page_token) break;
      pageToken = response.data.page_token;
    }
  }
  replies.sort((a, b) => a.createdAt - b.createdAt);
  return { quote: item?.quote || undefined, replies };
}

/** The reply as text: links as their URL, people as `@name`, the bot's own mention left out. */
export async function replyText(
  reply: Reply,
  bot: BotIdentity,
  name: (openId: string) => Promise<string | undefined>,
): Promise<{ text: string; mentioned: boolean; mentions: { id: string; name: string; isBot: false }[] }> {
  let text = "";
  let mentioned = false;
  const mentions: { id: string; name: string; isBot: false }[] = [];
  for (const element of reply.elements) {
    if (element.type === "text_run") text += element.text_run?.text ?? "";
    else if (element.type === "docs_link") text += element.docs_link?.url ?? "";
    else if (element.type === "person") {
      const id = element.person?.user_id ?? "";
      if (id === bot.id) {
        mentioned = true;
        continue;
      }
      const who = (await name(id)) ?? "";
      text += who ? `@${who}` : "@";
      if (id && !mentions.some((m) => m.id === id)) mentions.push({ id, name: who, isBot: false });
    }
  }
  if (bot.name) text = text.replaceAll(`@${bot.name}`, "");
  return { text: text.replace(/[ \t]{2,}/g, " ").trim(), mentioned, mentions };
}

/**
 * The thread's chat: named after the document and the text the comment is on. One conversation
 * about one passage: once the agent answered there, what people reply in it is addressed to it,
 * without an @ each time.
 */
export function threadChat(thread: CommentThread, title: string | undefined, quote: string | undefined): ChatRef {
  const doc = title || "Feishu document";
  const on = quote ? ` · “${cut(oneLine(quote), NAME_QUOTE_CHARS)}”` : "";
  return { platformId: threadId(thread), kind: "thread", name: `${doc}${on}`, followUp: true };
}

/**
 * What the agent needs to answer an @ in a thread it may never have seen: the document, the text the
 * comment is on, and what was said before in the thread that it has not been shown yet, its own
 * comments included (it may have written them with another tool, outside Xtwork).
 */
export function threadContext(input: {
  title: string | undefined;
  url: string | undefined;
  quote: string | undefined;
  earlier: readonly { who: string; text: string }[];
}): string {
  const doc = input.title ? `“${input.title}”` : "a Feishu document";
  const lines = [`> Comment thread in ${doc}${input.url ? ` (${input.url})` : ""}`];
  if (input.quote) lines.push(`> On the text: “${cut(oneLine(input.quote), QUOTE_CHARS)}”`);
  for (const e of input.earlier.slice(-CONTEXT_REPLIES))
    lines.push(`> ${e.who}: ${cut(oneLine(e.text), CONTEXT_CHARS)}`);
  return lines.join("\n");
}

/** Remembers which replies of each thread the agent has been shown, so context is not repeated. */
export class ShownReplies {
  private readonly shown = new Map<string, Set<string>>();

  /** Replies before `upTo` the agent has not been shown yet; marks them and `upTo` as shown. */
  take(thread: string, replies: readonly Reply[], upTo: string): Reply[] {
    let seen = this.shown.get(thread);
    if (!seen) {
      seen = new Set();
      this.shown.set(thread, seen);
    }
    const out: Reply[] = [];
    for (const reply of replies) {
      if (reply.id === upTo) break;
      if (!seen.has(reply.id)) out.push(reply);
    }
    for (const reply of out) seen.add(reply.id);
    seen.add(upTo);
    return out;
  }

  /** The agent wrote this reply itself, through Xtwork. */
  add(thread: string, replyId: string): void {
    const seen = this.shown.get(thread) ?? new Set<string>();
    seen.add(replyId);
    this.shown.set(thread, seen);
  }
}

/** One comment event as an inbound message, or undefined when it is the bot's own. */
export async function commentInbound(input: {
  event: lark.CommentEvent;
  bot: BotIdentity;
  client: Client;
  shown: ShownReplies;
  name: (openId: string) => Promise<string | undefined>;
  meta: (thread: CommentThread) => Promise<{ title?: string; url?: string }>;
}): Promise<InboundMessage | undefined> {
  const { event, bot } = input;
  if (event.operator.openId === bot.id) return undefined;
  const thread = { fileType: event.fileType, fileToken: event.fileToken, commentId: event.commentId };
  const id = threadId(thread);
  const [meta, read] = await Promise.all([input.meta(thread), readThread(input.client, thread).catch(() => undefined)]);
  const sender = { id: event.operator.openId, name: (await input.name(event.operator.openId)) ?? "", isBot: false };
  if (!read) {
    // Not shared with the bot, or the comment is gone: still tell the agent it was asked.
    if (!event.mentionedBot) return undefined;
    return {
      platformId: event.replyId ?? event.commentId,
      chat: threadChat(thread, meta.title, undefined),
      sender,
      text: `[Xtwork could not read this comment. The document may not be shared with you.${meta.url ? ` ${meta.url}` : ""}]`,
      attachments: [],
      addressedToBot: true,
      mentioned: true,
      sentAt: event.timestamp,
    };
  }
  const reply =
    read.replies.find((r) => r.id === event.replyId) ??
    read.replies.findLast((r) => r.userId === event.operator.openId);
  if (!reply) return undefined;
  const body = await replyText(reply, bot, input.name);
  const mentioned = event.mentionedBot || body.mentioned;
  let text = body.text;
  if (mentioned) {
    const earlier = await Promise.all(
      input.shown.take(id, read.replies, reply.id).map(async (r) => ({
        who: r.userId === bot.id ? `${bot.name || "You"} (you)` : (await input.name(r.userId)) || "Someone",
        text: (await replyText(r, bot, input.name)).text,
      })),
    );
    text = `${threadContext({ title: meta.title, url: meta.url, quote: read.quote, earlier })}\n\n${text}`;
  }
  return {
    platformId: reply.id,
    chat: threadChat(thread, meta.title, read.quote),
    sender,
    text,
    attachments: [],
    addressedToBot: mentioned,
    mentioned,
    ...(body.mentions.length ? { mentions: body.mentions } : {}),
    sentAt: reply.createdAt ? reply.createdAt * 1000 : event.timestamp,
  };
}

/** Markdown the agent wrote, as a comment reply's plain text and @-mentions. */
export function replyElements(
  markdown: string,
  mentions: readonly Mention[] | undefined,
): { elements: Element[]; flattened: boolean } {
  const plain = flatten(markdown);
  const elements: Element[] = [];
  let at = 0;
  for (const spot of mentionSpots(plain, mentions ?? [])) {
    if (spot.start > at) elements.push({ type: "text_run", text_run: { text: plain.slice(at, spot.start) } });
    elements.push({ type: "person", person: { user_id: spot.mention.id } });
    at = spot.end;
  }
  if (at < plain.length) elements.push({ type: "text_run", text_run: { text: plain.slice(at) } });
  return { elements, flattened: plain !== markdown };
}

/** Send one reply into a comment thread. Comments carry text, links and mentions; no files, no formatting. */
export async function sendReply(client: Client, thread: CommentThread, message: OutboundMessage): Promise<SendResult> {
  if (!message.text.trim()) return { kind: "failed", code: "unknown", retryable: false, detail: "files_unsupported" };
  const { elements, flattened } = replyElements(message.text, message.mentions);
  const degraded: Degradation[] = [];
  if (flattened) degraded.push("markdown_flattened");
  if (message.files?.length) degraded.push("files_dropped");
  try {
    const response = await client.drive.v1.fileCommentReply.create({
      path: { file_token: thread.fileToken, comment_id: thread.commentId },
      params: { file_type: thread.fileType as FileType, user_id_type: "open_id" },
      data: { content: { elements } },
    });
    const id = response.data?.reply_id;
    if (!id) return { kind: "failed", code: "unknown", retryable: false };
    return { kind: "sent", platformId: id, ...(degraded.length ? { degraded } : {}) };
  } catch (error) {
    return replyFailure(error);
  }
}

/** Feishu's comment error codes (drive v1 file.comment docs). */
function replyFailure(error: unknown): SendResult {
  const response = (error as { response?: { status?: number; data?: { code?: number; msg?: string } } })?.response;
  const code = response?.data?.code;
  const detail = code ? `feishu_${code}` : undefined;
  const failed = (kind: "forbidden" | "chat_gone" | "rate_limited" | "too_large" | "unknown", retryable = false) =>
    ({ kind: "failed", code: kind, retryable, ...(detail ? { detail } : {}) }) as const;
  if (!response) return { kind: "uncertain" };
  if (code === 1069303) return failed("forbidden");
  if (code === 1069304 || code === 1069305 || code === 1069307) return failed("chat_gone");
  if (code === 1069308) return failed("too_large");
  if (code === 1069301) return failed("unknown", true);
  if (response.status === 429 || code === 99991400) return failed("rate_limited", true);
  if (response.status === 403) return failed("forbidden");
  return failed("unknown");
}

/** Comment replies show text as typed: drop the Markdown marks that would show as clutter. */
export function flatten(markdown: string): string {
  return markdown
    .replace(/^```[^\n]*\n?/gm, "")
    .replace(/^#{1,6}\s+/gm, "")
    .replace(/\*\*(.+?)\*\*/g, "$1")
    .replace(/__(.+?)__/g, "$1")
    .replace(/`([^`\n]+)`/g, "$1")
    .replace(/!?\[([^\]\n]+)\]\((\S+?)\)/g, (_, text: string, url: string) => (text === url ? url : `${text} ${url}`))
    .replace(/\n{3,}/g, "\n\n")
    .trim();
}

function oneLine(text: string): string {
  return text.replace(/\s+/g, " ").trim();
}

function cut(text: string, max: number): string {
  return text.length > max ? `${text.slice(0, max - 1)}…` : text;
}
