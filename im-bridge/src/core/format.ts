/**
 * Structured message header formatting, 200-char reply quotes, search excerpts,
 * and ADR-011 L1 `<im_untrusted_message ...>` prompt-injection defense envelopes.
 *
 * Adapted from earayu/Mingle (MIT, commit 006220e880d2134665ce2745ab6233f52c8eabe9),
 * src/core/format.ts.
 */

import type { ChatKind, Platform } from "../channels/channel.ts";
import { searchTerms } from "./terms.ts";

/** Minimal chat shape required for formatting (satisfied by `Store` `Chat`). */
export interface FormattableChat {
  readonly id: string;
  readonly platformId: string;
  readonly kind: ChatKind;
  readonly name: string | null;
  readonly parentId: string | null;
}

/** Minimal contact shape required for formatting (satisfied by `Store` `Contact`). */
export interface FormattableContact {
  readonly id: string;
  readonly name: string | null;
  readonly alias: string | null;
  readonly isBot: boolean;
  readonly personId: string | null;
  readonly personName: string | null;
}

/** Minimal attachment shape required for formatting. */
export interface FormattableAttachment {
  readonly id: string;
  readonly name: string;
}

/** Minimal message shape required for formatting (satisfied by `Store` `Message`). */
export interface FormattableMessage {
  readonly id: string;
  readonly direction: "in" | "out";
  readonly senderId: string | null;
  readonly senderName: string | null;
  readonly body: string;
  readonly attachments: readonly FormattableAttachment[];
  readonly replyTo: string | null;
  readonly createdAt: number;
  readonly notice?: boolean;
}

/** What to call a contact: person name > alias > platform name > null. */
export function resolveContactName(
  contact: (Pick<FormattableContact, "name" | "alias"> & { readonly personName?: string | null }) | undefined,
): string | null {
  return contact?.personName || contact?.alias || contact?.name || null;
}

/** ISO 8601 in local time with offset, minute precision: `2026-11-24T14:02+08:00`. */
export function localTime(ms: number): string {
  const d = new Date(ms);
  const pad = (n: number) => String(n).padStart(2, "0");
  const offset = -d.getTimezoneOffset();
  const sign = offset >= 0 ? "+" : "-";
  const abs = Math.abs(offset);
  return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}T${pad(d.getHours())}:${pad(d.getMinutes())}${sign}${pad(Math.floor(abs / 60))}:${pad(abs % 60)}`;
}

const quote = (s: string) => `"${s.replaceAll('"', "'").replaceAll("\n", " ").replaceAll("\r", " ")}"`;

/** Characters of a replied-to message quoted on delivery. */
export const REPLY_QUOTE_CHARS = 200;

export function clipText(text: string, max: number): string {
  const chars = [...text];
  return chars.length > max ? `${chars.slice(0, max).join("").trimEnd()}…` : text;
}

function quoteLines(text: string): string {
  return text
    .split("\n")
    .map((line) => `> ${line}`)
    .join("\n");
}

/** The Mingle-style header line plus optional 200-char reply quote and body. */
export function formatMessage(
  message: FormattableMessage,
  chat: FormattableChat,
  platform: Platform,
  opts: {
    readonly ownerId?: string | null;
    readonly agentName?: string;
    readonly bridgeName?: string;
    readonly contact?: FormattableContact | undefined;
    /** Messages in the chat around this one that did not reach the assistant. */
    readonly unseen?: number;
    /** The message this one replies to, quoted under the header (clipped to 200 chars). */
    readonly quoted?: { readonly from: string; readonly body: string };
  } = {},
): string {
  const parts = [`msg=${message.id}`, `chat=${chat.id}`, `im=${platform}`];
  parts.push(chat.kind === "dm" ? "dm" : `group=${quote(chat.name ?? chat.platformId)}`);
  if (chat.parentId) parts.push(`in=${chat.parentId}`);
  if (message.direction === "out" && message.notice) {
    parts.push(`from=${quote(opts.bridgeName ?? "Xtwork")}`, "notice");
  } else if (message.direction === "out") {
    parts.push(`from=${quote(opts.agentName ?? "you")}`, "you");
  } else {
    const name = resolveContactName(opts.contact) ?? (message.senderName !== message.senderId ? message.senderName : null);
    if (name) parts.push(`from=${quote(name)}`);
    if (opts.contact) parts.push(`user=${opts.contact.id}`);
    if (opts.contact?.personId) parts.push(`person=${opts.contact.personId}`);
    if (opts.ownerId && message.senderId === opts.ownerId) parts.push("owner");
    else if (opts.contact?.isBot) parts.push("bot");
  }
  if (message.replyTo) parts.push(`reply_to=${message.replyTo}`);
  for (const a of message.attachments) {
    parts.push(message.direction === "out" ? `sent_file=${quote(a.name)}` : `file=${a.id}:${quote(a.name)}`);
  }
  parts.push(`time=${localTime(message.createdAt)}`);
  if (opts.unseen) parts.push(`unseen=${opts.unseen}`);
  const quoted = opts.quoted
    ? `${quoteLines(`${opts.quoted.from}: ${clipText(opts.quoted.body, REPLY_QUOTE_CHARS)}`)}\n`
    : "";
  return `[${parts.join(" ")}]\n${quoted}${message.body}`;
}

const EXCERPT_BEFORE = 80;
const EXCERPT_AFTER = 120;

/**
 * Window of `body` around the first match of `query`, wrapped in `<match></match>`.
 */
export function excerpt(body: string, query: string, before = EXCERPT_BEFORE, after = EXCERPT_AFTER): string {
  const chars = [...body];
  const offsets: number[] = [];
  for (const [index, char] of chars.entries()) {
    for (let i = 0; i < char.toLowerCase().length; i++) offsets.push(index);
  }
  const hay = body.toLowerCase();
  let start = 0;
  let size = 0;
  for (const term of [query.trim(), ...searchTerms(query)]) {
    if (!term) continue;
    const folded = term.toLowerCase();
    const at = hay.indexOf(folded);
    if (at >= 0) {
      start = offsets[at] ?? 0;
      size = (offsets[at + folded.length - 1] ?? start) - start + 1;
      break;
    }
  }
  const width = size + before + after;
  const from = Math.max(0, Math.min(start - before, chars.length - width));
  const to = Math.min(chars.length, from + width);
  const slice = (a: number, b: number) => chars.slice(a, b).join("");
  const win =
    size > 0
      ? `${slice(from, start)}<match>${slice(start, start + size)}</match>${slice(start + size, to)}`
      : slice(from, to);
  return `${from > 0 ? "…" : ""}${win}${to < chars.length ? "…" : ""}`;
}

// -------------------------------------------------- ADR-011 L1 untrusted data envelope

export type VerifiedSenderRole = "owner" | "member" | "bot";
export type ReplyAudience = "owner_dm" | "group";

function escapeAttr(value: string): string {
  return value
    .replaceAll("&", "&amp;")
    .replaceAll('"', "&quot;")
    .replaceAll("<", "&lt;")
    .replaceAll(">", "&gt;")
    .replaceAll("\n", " ")
    .replaceAll("\r", " ");
}

/**
 * Neutralize any attempt inside untrusted IM text to forge or prematurely close the
 * `<im_untrusted_message>` (or custom) envelope tag, regardless of casing or internal whitespace.
 */
export function escapeEnvelopeTags(text: string, tagName = "im_untrusted_message"): string {
  const escaped = tagName.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
  const pattern = new RegExp(`<(\\s*/?\\s*${escaped}\\b)`, "gi");
  return text.replace(pattern, "&lt;$1");
}

export interface UntrustedEnvelopeMeta {
  readonly platform: Platform;
  readonly connectionId: string;
  readonly chatId: string;
  readonly chatKind: ChatKind;
  readonly messageId: string;
  readonly senderRole: VerifiedSenderRole;
  readonly replyAudience: ReplyAudience;
  readonly senderName?: string | null;
}

/**
 * Wrap formatted IM inbound content inside an ADR-011 L1 `<im_untrusted_message ...>` boundary.
 * Server-verified metadata (`senderRole`, `chatKind`, `replyAudience`) is injected in attributes,
 * while all untrusted body/quote/nickname text inside the tag has closing/opening envelope tags escaped.
 */
export function wrapUntrustedMessage(content: string, meta: UntrustedEnvelopeMeta): string {
  const attrs = [
    `platform="${escapeAttr(meta.platform)}"`,
    `connection_id="${escapeAttr(meta.connectionId)}"`,
    `chat_id="${escapeAttr(meta.chatId)}"`,
    `chat_kind="${escapeAttr(meta.chatKind)}"`,
    `msg_id="${escapeAttr(meta.messageId)}"`,
    `sender_role="${escapeAttr(meta.senderRole)}"`,
    `reply_audience="${escapeAttr(meta.replyAudience)}"`,
    ...(meta.senderName ? [`sender_name="${escapeAttr(meta.senderName)}"`] : []),
    `trust="untrusted_external_data"`,
  ];
  const safeContent = escapeEnvelopeTags(content, "im_untrusted_message");
  return [
    `<im_untrusted_message ${attrs.join(" ")}>`,
    safeContent,
    `</im_untrusted_message>`,
  ].join("\n");
}

/**
 * Wrap group background search results / history excerpts inside `<im_untrusted_background ...>`.
 */
export function wrapUntrustedBackground(
  content: string,
  meta: { readonly platform: Platform; readonly chatId: string; readonly chatKind: ChatKind },
): string {
  const attrs = [
    `platform="${escapeAttr(meta.platform)}"`,
    `chat_id="${escapeAttr(meta.chatId)}"`,
    `chat_kind="${escapeAttr(meta.chatKind)}"`,
    `trust="untrusted_external_data"`,
  ];
  const safeContent = escapeEnvelopeTags(content, "im_untrusted_background");
  return [`<im_untrusted_background ${attrs.join(" ")}>`, safeContent, `</im_untrusted_background>`].join("\n");
}
