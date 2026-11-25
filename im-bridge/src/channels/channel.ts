/**
 * The contract every IM adapter implements. The core only knows these types;
 * platform SDKs stay inside `src/channels/<platform>/`.
 *
 * Adapted from earayu/Mingle (MIT, commit 006220e880d2134665ce2745ab6233f52c8eabe9),
 * src/channels/channel.ts, with ADR-011 persist-before-cursor hooks for polling channels.
 *
 * Design rules:
 * - Semantics here, presentation in the adapter.
 * - Capabilities are reported per bot instance, not assumed per platform.
 * - An adapter never throws for "the platform cannot do this": it degrades and says so.
 * - Polling adapters (e.g. WeChat iLink) must persist inbound batches BEFORE advancing cursors.
 */

import type { Mention } from "./mention.ts";

export type { Mention } from "./mention.ts";

export type Platform =
  | "wechat"
  | "wecom"
  | "feishu"
  | "dingtalk"
  | "qq"
  | "slack"
  | "discord"
  | "telegram"
  | "imessage"
  | "github"
  | "local";

export type ChatKind = "dm" | "group" | "thread";

/**
 * Who can reach a bot on this platform.
 * - `org`: only people inside the workspace/organization the bot was created in.
 * - `public`: anyone who finds it can message it or add it to a group.
 * - `owner`: the bot is the owner's own account (personal WeChat, iMessage self-chat).
 */
export type Trust = "org" | "public" | "owner";

/** What this bot instance can actually do right now, given its granted permissions. */
export interface Capabilities {
  readonly quoteReply: boolean;
  readonly reactions: boolean;
  readonly typingIndicator: boolean;
  readonly fileUpload: boolean;
  readonly fileDownload: boolean;
  readonly listMembers: boolean;
  /**
   * Turns `@name` into a real mention, from `OutboundMessage.mentions`. Absent:
   * the name goes out as plain text, which notifies nobody and wakes no bot.
   */
  readonly mentions?: true;
  /**
   * Can open a thread under a message by replying into it (`OutboundMessage.inThread`): a Feishu
   * "reply in thread", a Discord thread started from a message. Absent: such a reply goes out as
   * a plain quoted reply.
   */
  readonly threads?: true;
  /** Largest text body one message can carry; longer bodies are split by the core. */
  readonly maxTextLength: number;
}

// ---------------------------------------------------------------- onboarding

/** How a user connects a bot on this platform. Drives the settings connect screen. */
export type OnboardingMethod =
  /** `desktopLink`: the QR's link also works when opened in a signed-in browser on this computer. */
  | { readonly kind: "qr"; readonly desktopLink?: boolean }
  /** A code the person enters on the platform's site while signed in as the bot's account (OAuth device flow). */
  | { readonly kind: "device" }
  | {
      readonly kind: "credentials";
      readonly fields: readonly CredentialField[];
      readonly setupUrl?: string;
    };

export interface CredentialField {
  readonly key: string;
  /** Message-catalog key for the label, not display text. */
  readonly labelKey: string;
  readonly secret: boolean;
}

export interface SetupCheck {
  readonly id: string;
  readonly state: "ok" | "missing" | "denied" | "unknown";
}

export interface ChannelSetup {
  check(): Promise<{
    readonly checks: readonly SetupCheck[];
    readonly app?: string;
  }>;
  act(action: string): Promise<void>;
  readonly actions: readonly string[];
}

export type OnboardingEvent =
  | { readonly kind: "qr_ready"; readonly qrContent: string; readonly expiresAt: number }
  | { readonly kind: "scanned" }
  | {
      readonly kind: "device_code";
      readonly userCode: string;
      readonly verificationUri: string;
      readonly expiresAt: number;
    }
  /** The platform wants a code typed on this computer (shown on the phone). Answer through `context.awaitCode`. */
  | { readonly kind: "needs_code"; readonly retry?: boolean }
  | { readonly kind: "awaiting_approval"; readonly detailKey?: string }
  | {
      readonly kind: "succeeded";
      readonly credentials: Credentials;
      readonly bot: BotIdentity;
      /** The person who scanned, when the platform reports it. Omit to trigger `pairing` claim flow. */
      readonly ownerId?: string;
      /** The bot exists but an admin still has to approve or enable it. */
      readonly pendingApproval?: boolean;
    }
  | { readonly kind: "failed"; readonly code: OnboardingFailure };

export interface OnboardingContext {
  /** Used to name the bot where the platform lets us suggest one. */
  readonly agentName?: string;
  /** Resolves with the code the user types after a `needs_code` event. */
  readonly awaitCode?: () => Promise<string>;
  /**
   * Credentials of this platform's bots already connected on this computer, newest first. Lets a
   * platform recognize a rebind instead of treating every scan as a new client. Read only on demand.
   */
  readonly knownCredentials?: () => Promise<readonly Credentials[]>;
  /**
   * Credentials of an already-connected bot being re-authorized (only where `Channel.reauthorize`
   * is set): the platform updates that app's grants instead of creating a new bot.
   */
  readonly reauthorize?: Credentials;
  /**
   * Optional permissions the owner turned on for this re-authorization. The app asks for them on
   * top of what it always asks for, and keeps those it was already granted.
   */
  readonly adding?: readonly PermissionId[];
}

export type OnboardingFailure =
  | "expired"
  | "denied"
  | "cancelled"
  | "invalid_credentials"
  | "insufficient_scope"
  | "network"
  | "already_bound"
  | "already_connected"
  | "permission_missing"
  | "not_signed_in"
  | "unknown";

/** Opaque to the core. Stored in the OS secure credential store, never in SQLite or logs. */
export type Credentials = Readonly<Record<string, string>>;

export interface BotIdentity {
  readonly id: string;
  readonly name: string;
  /**
   * The `Sender.id` this bot has in other bots' messages, where that is not `id`.
   */
  readonly senderId?: string;
}

// ----------------------------------------------------------------- lifecycle

export type ConnectionState =
  | { readonly kind: "connecting" }
  | { readonly kind: "connected" }
  | { readonly kind: "reconnecting"; readonly attempt: number }
  | { readonly kind: "awaiting_approval" }
  | { readonly kind: "error"; readonly code: "credentials_revoked" | "permission_missing" | "network" | "unknown" };

// ----------------------------------------------------------------- messaging

export interface ChatRef {
  /** Platform chat id; for a thread or topic, the adapter encodes both ids here. */
  readonly platformId: string;
  readonly kind: ChatKind;
  readonly name?: string;
  /**
   * For a thread: the group it belongs to, where the adapter stores the messages around it
   * that were not addressed to the bot.
   */
  readonly parent?: { readonly platformId: string; readonly name?: string };
  /**
   * A thread that is one conversation (once the agent has spoken in it, subsequent messages are
   * addressed to it without an `@` each time).
   */
  readonly followUp?: true;
}

export interface Sender {
  readonly id: string;
  readonly name: string;
  readonly isBot: boolean;
}

export interface InboundAttachment {
  /** Handle the adapter can later resolve to bytes. */
  readonly id: string;
  readonly name: string;
  readonly size?: number;
  readonly mime?: string;
}

export interface InboundMessage {
  readonly platformId: string;
  readonly chat: ChatRef;
  readonly sender: Sender;
  /** Plain text with the bot's own mention removed and other mentions rendered as @name. */
  readonly text: string;
  readonly attachments: readonly InboundAttachment[];
  /** Platform id of the message this one quotes or replies to. */
  readonly replyTo?: string;
  /** True when the bot was @-mentioned, or the message replies to one the bot sent. */
  readonly addressedToBot: boolean;
  /**
   * The text itself @-mentions the bot by name. Leave it out where the platform cannot tell;
   * the core then counts a group message addressed to the bot as a mention.
   */
  readonly mentioned?: boolean;
  /**
   * The others the text @-mentions, as the platform reports them.
   */
  readonly mentions?: readonly Sender[];
  readonly sentAt: number;
  /**
   * Read from the chat's history when the bot joined, not delivered as it was sent. The core keeps
   * it as background and never answers it, whatever it @-mentions.
   */
  readonly earlier?: true;
}

export interface OutboundMessage {
  readonly chat: ChatRef;
  /** Markdown. The adapter renders it the platform's way. */
  readonly text: string;
  /** Platform id of the message to quote. Ignored, and reported, where unsupported. */
  readonly replyTo?: string;
  readonly files?: readonly { readonly path: string; readonly name?: string }[];
  /**
   * People the text @-mentions by name. Where `Capabilities.mentions`, the adapter writes each spot
   * `mentionSpots` finds as a real mention; elsewhere the text goes out as written.
   */
  readonly mentions?: readonly Mention[];
  /**
   * Reply to `replyTo` in a thread under it, opening one if it has none (where `Capabilities.threads`).
   */
  readonly inThread?: { readonly title: string };
  /**
   * Outcome the whole chat should see, not only those following a thread under `replyTo`.
   */
  readonly inChat?: true;
}

export type SendResult =
  | {
      readonly kind: "sent";
      readonly platformId: string;
      readonly degraded?: readonly Degradation[];
      readonly chat?: string;
      readonly thread?: ChatRef;
    }
  /** The platform refused. `retryable` says whether trying again can help. */
  | {
      readonly kind: "failed";
      readonly code: "rate_limited" | "forbidden" | "too_large" | "chat_gone" | "network" | "unknown";
      readonly retryable: boolean;
      /** The platform's own error code, for the agent and the owner to act on. Never a secret. */
      readonly detail?: string;
      /**
       * The text is out and only the files failed. A retry must send the files alone, or the
       * person sees the text twice. `platformId` is the text's message.
       */
      readonly textSent?: { readonly platformId: string };
    }
  /** The request left but no answer came back. Never retried automatically. */
  | { readonly kind: "uncertain" };

/** A failure after the text went out: mark it so retries send the files alone. */
export function withTextSent(result: SendResult, textPlatformId: string): SendResult {
  return textPlatformId && result.kind === "failed" ? { ...result, textSent: { platformId: textPlatformId } } : result;
}

export type Degradation =
  | "quote_dropped"
  | "files_dropped"
  | "markdown_flattened"
  | "text_split"
  | "thread_dropped"
  | "mentions_plain";

// ------------------------------------------------------------------- adapter

/**
 * Atomic batch payload for cursor-based polling channels (ADR-011 S6, e.g. WeChat iLink).
 * The core gates, deduplicates, persists all messages and commits `nextCursor` in one SQLite
 * transaction before resolving. The adapter must NOT advance its in-memory cursor until resolved.
 */
export interface InboundBatch {
  readonly messages: readonly InboundMessage[];
  /** Opaque cursor representing the poll position AFTER this batch (e.g. WeChat `get_updates_buf`). */
  readonly nextCursor?: string;
}

export interface ConnectOptions {
  /** Previously persisted opaque cursor to resume polling from (e.g. WeChat `get_updates_buf`). */
  readonly initialCursor?: string;
}

export interface ChannelEvents {
  /**
   * Deliver one inbound message. May return a Promise so polling adapters can await durable
   * persistence before advancing a cursor when `onMessageBatch` is not used.
   */
  onMessage(message: InboundMessage): void | Promise<void>;
  /**
   * Deliver a polled batch + optional `nextCursor` atomically. When present, the core persists
   * every gated message, dedup entries, and `nextCursor` in one transaction before resolving.
   */
  onMessageBatch?(batch: InboundBatch): Promise<void>;
  /**
   * Persist an updated opaque poll cursor AFTER all messages up to that cursor have been persisted.
   * Safe to invoke idempotently (and used when an adapter awaits individual `onMessage` calls).
   */
  onCursorCommit?(cursor: string): void | Promise<void>;
  onState(state: ConnectionState): void;
  /** The bot was added to or removed from a chat. */
  onMembership(change: { readonly chat: ChatRef; readonly joined: boolean }): void;
}

export type ReactionState = "processing" | "done" | "error" | "none";

export interface LiveOptions {
  /** Platform ID of the message being answered. */
  readonly replyTo: string;
  /** Platform user ID to @-mention in the final answer (groups). */
  readonly mention?: string;
  /** First content, shown at once. Markdown. */
  readonly initial: string;
}

export interface LiveReply {
  /**
   * When the platform stops taking updates to this reply, if it does (WeCom's stream window).
   */
  readonly until?: number;
  /** Replace the progress content. Markdown. Best effort. */
  update(markdown: string): Promise<void>;
  /** Replace the content with the final answer and close the reply. `mentions` as in `OutboundMessage`. */
  finish(markdown: string, mentions?: readonly Mention[]): Promise<SendResult>;
}

/** One adapter instance per platform. Stateless across bots. */
export interface Channel {
  readonly platform: Platform;
  readonly onboarding: OnboardingMethod;
  /** For QR platforms: fields for binding an existing app by hand instead of scanning. */
  readonly manualFields?: readonly CredentialField[];
  /** Where to create the app for `manualFields` on the platform's developer site. */
  readonly manualSetupUrl?: string;
  /** Local prerequisites checked live before connecting. */
  readonly setup?: ChannelSetup;
  /**
   * This platform's onboarding can add permissions to an already-connected bot via
   * `OnboardingContext.reauthorize` and `OnboardingContext.adding`.
   */
  readonly reauthorize?: boolean;
  inviteUrl?(bot: BotIdentity): string;
  /**
   * Its bots can be sent every message in their groups, not only those that `@` them
   * (given the `group_messages` permission).
   */
  readonly groupMessages?: true;
  /** Who can reach its bots. Absent means `public`. */
  readonly trust?: Trust;
  /** False where nobody can message the bot directly. */
  readonly directMessages?: false;
  claimUrl?(bot: BotIdentity, code: string): string;
  readonly builtin?: true;

  /** Start connecting a new bot. Yields progress until `succeeded` or `failed`. */
  onboard(
    input: Credentials | undefined,
    signal: AbortSignal,
    context?: OnboardingContext,
  ): AsyncIterable<OnboardingEvent>;

  /** Open a live connection for one bot. */
  connect(credentials: Credentials, events: ChannelEvents, options?: ConnectOptions): Promise<ChannelConnection>;
}

/** A live connection for one bot. */
export interface ChannelConnection {
  readonly bot: BotIdentity;
  /** Talks only in the owner's own chat (no groups, nobody else). */
  readonly ownerOnly?: boolean;
  capabilities(): Capabilities;

  send(message: OutboundMessage): Promise<SendResult>;
  /** Best effort; never throws. */
  react(chat: ChatRef, platformMessageId: string, state: ReactionState): Promise<void>;
  /** Open a reply that can be rewritten in place (streaming card or editable stream). */
  startLive?(chat: ChatRef, options: LiveOptions): Promise<LiveReply>;
  /** Best effort; never throws. */
  setTyping(chat: ChatRef, typing: boolean): Promise<void>;

  download(attachment: InboundAttachment, toPath: string): Promise<void>;
  messageUser?(userId: string, text: string): Promise<{ chat: string; platformId?: string } | undefined>;
  openDirect?(userId: string): Promise<string>;
  listMembers(chat: ChatRef): Promise<readonly Sender[]>;
  /** Permissions the owner can grant this bot on the platform, read live. Best effort; never throws. */
  permissions?(): Promise<readonly BotPermission[]>;
  /** Organizational profile ("Dept · Title"), when enabled. Best effort; never throws. */
  profile?(userId: string): Promise<string | undefined>;

  close(): Promise<void>;
}

/**
 * A permission the owner grants a bot on the platform itself.
 */
export type PermissionId = "group_messages" | "bot_messages" | "doc_comments" | "member_profiles";

export interface BotPermission {
  readonly id: PermissionId;
  readonly granted: boolean;
  /**
   * Not asked for when the bot is created: the owner turns it on later from the bot's settings.
   */
  readonly optional?: boolean;
  readonly grant?: { readonly url: string; readonly steps?: string };
}
