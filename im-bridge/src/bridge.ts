/**
 * Core IM Bridge service & JSONL RPC dispatcher (`im-bridge/src/bridge.ts`).
 *
 * Implements the bidirectional IPC wire protocol between T3 server and `im-bridge`:
 * - Requests: `bridge.hello`, `bridge.status`, `onboarding.start`/`submitCode`/`cancel`,
 *   `connections.list`/`pause`/`resume`/`disconnect`/`claimRefresh`/`permissions`,
 *   `access.list`/`decide`/`setAskAll`, `contacts.list`/`rename`/`note`,
 *   `people.link`/`unlink`, `messages.reply`/`send`/`liveStart`/`liveUpdate`/`liveFinish`/
 *   `react`/`read`/`search`, `files.download`, `inbound.ack`, `inbound.settle`, `bridge.shutdown`.
 * - Notifications: `onboarding.event`, `connection.state`, `access.held`,
 *   `inbound.dispatch`, `inbound.stop`.
 * - 15s clock-drift sleep-wake detector (>60s jump triggers reconnect of active connections).
 */

import { randomUUID } from "node:crypto";
import { lstatSync, mkdirSync, readlinkSync, realpathSync } from "node:fs";
import { dirname, isAbsolute, join, relative, resolve, sep } from "node:path";
import type {
  Channel,
  ChannelConnection,
  ChannelEvents,
  ChatRef,
  Credentials,
  InboundBatch,
  InboundMessage,
  LiveReply,
  Mention,
  OnboardingEvent,
  OutboundMessage,
  PermissionId,
  Platform,
  ReactionState,
  SendResult,
} from "./channels/channel.ts";
import type { ChannelMap } from "./channels/registry.ts";
import { CLAIM_TTL_MS, claimCode, gate } from "./core/access.ts";
import {
  excerpt,
  formatMessage,
  type ReplyAudience,
  type VerifiedSenderRole,
  wrapUntrustedMessage,
} from "./core/format.ts";
import { INBOUND, type InboundEvent } from "./core/inbound.ts";
import {
  BACKOFF_MS,
  createLinkMachine,
  type LifecycleState,
  type LinkEvent,
  type LinkMachine,
  stepMachine,
  stored,
} from "./core/link.ts";
import type { SecretStore } from "./platform/secrets.ts";
import {
  type Chat,
  type Connection,
  type Contact,
  contactName,
  type IngestOutcome,
  type LinkedBy,
  type Message,
  type Store,
} from "./store/store.ts";

export const PROTOCOL_VERSION = 1;
export const BRIDGE_VERSION = "0.1.0";
export const SLEEP_CHECK_INTERVAL_MS = 15_000;
export const SLEEP_DRIFT_THRESHOLD_MS = 60_000;
const MAX_SEND_ATTEMPTS = 3;

export interface RpcRequest {
  readonly id: string | number;
  readonly method: string;
  readonly params?: Record<string, unknown>;
}

export type RpcResponse =
  | { readonly id: string | number; readonly ok: true; readonly result: unknown }
  | { readonly id: string | number; readonly ok: false; readonly error: { readonly code: string; readonly message: string } };

export interface RpcNotification {
  readonly method: string;
  readonly params: Record<string, unknown>;
}

export class BridgeError extends Error {
  readonly code: string;

  constructor(code: string, message: string) {
    super(message);
    this.name = "BridgeError";
    this.code = code;
  }
}

export interface BridgeOptions {
  readonly store: Store;
  readonly secrets: SecretStore;
  readonly channels: ChannelMap;
  readonly notify: (notification: RpcNotification) => void;
  readonly now?: () => number;
  readonly backoffDelaysMs?: readonly number[];
  readonly sleepCheckIntervalMs?: number;
  readonly sleepDriftThresholdMs?: number;
  readonly agentName?: string;
}

interface ActiveOnboarding {
  readonly sessionId: string;
  readonly platform: Platform;
  readonly abort: AbortController;
  codeWaiter?: { resolve: (code: string) => void; reject: (err: Error) => void };
}

interface ManagedLink {
  machine: LinkMachine;
  live?: ChannelConnection;
  retryTimer?: NodeJS.Timeout;
}

/**
 * Resolve canonical real path including dangling symlinks (blocks dangling-symlink escapes
 * out of `allowedRoot`).
 */
function resolveRealPath(targetPath: string, depth = 0): string {
  if (depth > 40) throw new BridgeError("PATH_OUTSIDE_ALLOWED_ROOT", "Too many symbolic links in destPath");
  const abs = resolve(targetPath);
  const pending: string[] = [];
  let cursor = abs;
  for (;;) {
    try {
      const st = lstatSync(cursor);
      if (st.isSymbolicLink()) {
        const linkTarget = readlinkSync(cursor);
        const resolvedLink = isAbsolute(linkTarget) ? linkTarget : resolve(dirname(cursor), linkTarget);
        const fullTarget = pending.length ? join(resolvedLink, ...pending) : resolvedLink;
        return resolveRealPath(fullTarget, depth + 1);
      }
      const realBase = realpathSync(cursor);
      return pending.length ? join(realBase, ...pending) : realBase;
    } catch {
      const parent = dirname(cursor);
      if (parent === cursor) return abs;
      pending.unshift(cursor.slice(parent.length + (parent.endsWith(sep) ? 0 : 1)));
      cursor = parent;
    }
  }
}

/**
 * Validate `destPath` resolves strictly inside `allowedRoot` (blocking `..`, prefix collisions,
 * null bytes, and symlink escapes).
 */
export function validateDownloadPath(destPath: string, allowedRoot: string): string {
  if (!allowedRoot || !isAbsolute(allowedRoot) || allowedRoot.includes("\0")) {
    throw new BridgeError("INVALID_ALLOWED_ROOT", "allowedRoot must be a non-empty absolute path");
  }
  if (!destPath || destPath.includes("\0")) {
    throw new BridgeError("INVALID_DEST_PATH", "destPath must be a non-empty path");
  }
  const realRoot = resolveRealPath(allowedRoot);
  const candidate = isAbsolute(destPath) ? destPath : join(allowedRoot, destPath);
  const realDest = resolveRealPath(candidate);
  const rel = relative(realRoot, realDest);
  if (!rel || rel === "." || rel.startsWith("..") || isAbsolute(rel)) {
    throw new BridgeError(
      "PATH_OUTSIDE_ALLOWED_ROOT",
      `destPath "${destPath}" must resolve inside allowedRoot "${allowedRoot}"`,
    );
  }
  return realDest;
}

export class ImBridge {
  readonly store: Store;
  readonly secrets: SecretStore;
  readonly channels: ChannelMap;
  private readonly emit: (notification: RpcNotification) => void;
  private readonly now: () => number;
  private readonly backoffDelays: readonly number[];
  private readonly sleepIntervalMs: number;
  private readonly sleepDriftMs: number;
  private readonly agentName: string;
  private readonly startedAt: number;

  private readonly links = new Map<string, ManagedLink>();
  private readonly onboardings = new Map<string, ActiveOnboarding>();
  private readonly liveReplies = new Map<string, { readonly live: LiveReply; readonly connectionId: string; readonly chatId: string; readonly replyTo: string }>();

  private sleepTimer: NodeJS.Timeout | undefined;
  private lastClockTickAt: number;
  private started = false;
  private closed = false;
  private replayedOnHello = false;

  constructor(options: BridgeOptions) {
    this.store = options.store;
    this.secrets = options.secrets;
    this.channels = options.channels;
    this.emit = options.notify;
    this.now = options.now ?? Date.now;
    this.backoffDelays = options.backoffDelaysMs ?? BACKOFF_MS;
    this.sleepIntervalMs = options.sleepCheckIntervalMs ?? SLEEP_CHECK_INTERVAL_MS;
    this.sleepDriftMs = options.sleepDriftThresholdMs ?? SLEEP_DRIFT_THRESHOLD_MS;
    this.agentName = options.agentName ?? "Xtwork";
    this.startedAt = this.now();
    this.lastClockTickAt = this.startedAt;
  }

  /**
   * Start background timers and bring up existing non-idle, non-paused connections.
   * When there are zero bound connections (or all are `idle`), makes ZERO network calls (ADR-011 Invariant #3).
   */
  async start(): Promise<void> {
    if (this.started || this.closed) return;
    this.started = true;
    this.lastClockTickAt = this.now();

    for (const conn of this.store.connections()) {
      const machine = createLinkMachine(conn.lifecycleState);
      if (conn.paused) {
        this.links.set(conn.id, { machine: { ...machine, state: { kind: "paused" } } });
        continue;
      }
      this.links.set(conn.id, { machine });
      if (conn.lifecycleState === "active" || conn.lifecycleState === "pairing") {
        this.dispatchLinkEvent(conn.id, { kind: "connect" });
      }
    }

    if (this.sleepIntervalMs > 0) {
      this.sleepTimer = setInterval(() => this.checkSleepWake(), this.sleepIntervalMs);
      this.sleepTimer.unref?.();
    }
  }

  /**
   * Check wall-clock drift since previous tick; if jump exceeds `sleepDriftThresholdMs` (60s),
   * force reconnect of all active / pairing non-paused connections. Exported/public for deterministic tests.
   */
  checkSleepWake(): boolean {
    const current = this.now();
    const expected = this.lastClockTickAt + this.sleepIntervalMs;
    const drift = current - expected;
    this.lastClockTickAt = current;
    if (drift > this.sleepDriftMs) {
      this.reconnectAllActive();
      return true;
    }
    return false;
  }

  reconnectAllActive(): void {
    for (const conn of this.store.connections()) {
      if ((conn.lifecycleState === "active" || conn.lifecycleState === "pairing") && !conn.paused) {
        this.dispatchLinkEvent(conn.id, { kind: "sleep_wake" });
      }
    }
  }

  /** Replay all gate-approved unacked `received`/`delivered` triggers with their stable idempotency keys. */
  replayUnackedTriggers(): number {
    const pending = this.store.listUnackedTriggers();
    for (const msg of pending) {
      const chat = this.store.chat(msg.chatId);
      const conn = this.store.connection(msg.connectionId);
      if (!chat || !conn) continue;
      const contact = msg.senderId ? this.store.contactByPlatformId(conn.id, msg.senderId) : undefined;
      this.emitDispatch(conn, chat, msg, contact);
    }
    return pending.length;
  }

  async shutdown(): Promise<void> {
    if (this.closed) return;
    this.closed = true;
    if (this.sleepTimer) {
      clearInterval(this.sleepTimer);
      this.sleepTimer = undefined;
    }
    for (const session of this.onboardings.values()) {
      session.abort.abort();
      session.codeWaiter?.reject(new Error("Bridge shutting down"));
    }
    this.onboardings.clear();
    this.liveReplies.clear();

    const closers: Promise<void>[] = [];
    for (const managed of this.links.values()) {
      if (managed.retryTimer) clearTimeout(managed.retryTimer);
      managed.retryTimer = undefined;
      if (managed.live) {
        const live = managed.live;
        managed.live = undefined;
        closers.push(live.close().catch(() => {}));
      }
    }
    this.links.clear();
    await Promise.all(closers);
    this.store.close();
  }

  // ----------------------------------------------------------------- JSONL RPC

  async handleRequest(req: RpcRequest): Promise<RpcResponse> {
    try {
      const result = await this.routeRequest(req.method, req.params ?? {});
      return { id: req.id, ok: true, result };
    } catch (error) {
      if (error instanceof BridgeError) {
        return { id: req.id, ok: false, error: { code: error.code, message: error.message } };
      }
      const code = (error as { code?: unknown })?.code;
      return {
        id: req.id,
        ok: false,
        error: {
          code: typeof code === "string" ? code : "INTERNAL_ERROR",
          message: error instanceof Error ? error.message : String(error),
        },
      };
    }
  }

  private async routeRequest(method: string, params: Record<string, unknown>): Promise<unknown> {
    switch (method) {
      case "bridge.hello":
        return this.handleHello(params);
      case "bridge.status":
        return this.handleStatus();
      case "onboarding.start":
        return this.handleOnboardingStart(params);
      case "onboarding.submitCode":
        return this.handleOnboardingSubmitCode(params);
      case "onboarding.cancel":
        return this.handleOnboardingCancel(params);
      case "connections.list":
        return { connections: this.store.connections().map(sanitizeConnection) };
      case "connections.pause":
        return this.handleConnectionPause(reqStr(params, "connectionId"));
      case "connections.resume":
        return this.handleConnectionResume(reqStr(params, "connectionId"));
      case "connections.disconnect":
        return this.handleConnectionDisconnect(reqStr(params, "connectionId"));
      case "connections.claimRefresh":
        return this.handleClaimRefresh(reqStr(params, "connectionId"));
      case "connections.permissions":
        return this.handleConnectionPermissions(reqStr(params, "connectionId"));
      case "access.list":
        return this.handleAccessList(optStr(params, "connectionId"));
      case "access.decide":
        return this.handleAccessDecide(params);
      case "access.setAskAll":
        return this.handleSetAskAll(reqStr(params, "connectionId"), Boolean(params.askAll));
      case "contacts.list":
        return { contacts: this.store.contacts(optStr(params, "connectionId")) };
      case "contacts.rename":
        return this.handleContactRename(reqStr(params, "contactId"), params.name === null ? null : reqStr(params, "name"));
      case "contacts.note":
        return this.handleContactNote(params);
      case "people.link":
        return this.handlePeopleLink(params);
      case "people.unlink":
        return this.handlePeopleUnlink(params);
      case "messages.reply":
        return this.handleMessagesReply(params);
      case "messages.send":
        return this.handleMessagesSend(params);
      case "messages.liveStart":
        return this.handleLiveStart(params);
      case "messages.liveUpdate":
        return this.handleLiveUpdate(params);
      case "messages.liveFinish":
        return this.handleLiveFinish(params);
      case "messages.react":
        return this.handleMessagesReact(params);
      case "messages.read":
        return this.handleMessagesRead(params);
      case "messages.search":
        return this.handleMessagesSearch(params);
      case "files.download":
        return this.handleFilesDownload(params);
      case "inbound.ack":
        return this.handleInboundAck(params);
      case "inbound.settle":
        return this.handleInboundSettle(params);
      case "bridge.shutdown":
        await this.shutdown();
        return { shutdown: true };
      default:
        throw new BridgeError("METHOD_NOT_FOUND", `Unknown method: ${method}`);
    }
  }

  private handleHello(params: Record<string, unknown>) {
    if (params.protocolVersion !== undefined && params.protocolVersion !== PROTOCOL_VERSION) {
      throw new BridgeError(
        "UNSUPPORTED_PROTOCOL",
        `Unsupported protocolVersion ${String(params.protocolVersion)}; expected ${PROTOCOL_VERSION}`,
      );
    }
    const platforms = Object.keys(this.channels).sort();
    // Schedule crash-recovery redelivery right after hello response flushes.
    if (!this.replayedOnHello) {
      this.replayedOnHello = true;
      queueMicrotask(() => {
        if (!this.closed) this.replayUnackedTriggers();
      });
    }
    return {
      protocolVersion: PROTOCOL_VERSION,
      bridgeVersion: BRIDGE_VERSION,
      nodeVersion: process.versions.node,
      platforms,
    };
  }

  private handleStatus() {
    const connections = this.store.connections();
    const lifecycle: LifecycleState = connections.some((c) => c.lifecycleState === "active")
      ? "active"
      : connections.some((c) => c.lifecycleState === "pairing")
        ? "pairing"
        : "idle";
    return {
      protocolVersion: PROTOCOL_VERSION,
      bridgeVersion: BRIDGE_VERSION,
      uptimeMs: Math.max(0, this.now() - this.startedAt),
      lifecycle,
      platforms: Object.keys(this.channels).sort(),
      connections: connections.map(sanitizeConnection),
      unackedCount: this.store.listUnackedTriggers().length,
    };
  }

  // ---------------------------------------------------------------- onboarding

  private async handleOnboardingStart(params: Record<string, unknown>) {
    const platform = reqStr(params, "platform") as Platform;
    const channel = this.channels[platform];
    if (!channel) {
      throw new BridgeError("UNSUPPORTED_PLATFORM", `Channel adapter not loaded for platform "${platform}"`);
    }
    const credentials = params.credentials as Credentials | undefined;
    const agentName = optStr(params, "agentName") ?? this.agentName;
    const reauthorizeConnectionId = optStr(params, "reauthorizeConnectionId");
    const adding = Array.isArray(params.adding) ? (params.adding as PermissionId[]) : undefined;

    let reauthorize: Credentials | undefined;
    if (reauthorizeConnectionId) {
      const existing = this.store.connection(reauthorizeConnectionId);
      if (!existing || !existing.secretRef) {
        throw new BridgeError("CONNECTION_NOT_FOUND", `Connection not found: ${reauthorizeConnectionId}`);
      }
      const raw = await this.secrets.get(existing.secretRef);
      if (!raw) throw new BridgeError("CREDENTIALS_MISSING", "Existing credentials missing from secure store");
      reauthorize = JSON.parse(raw) as Credentials;
    }

    const sessionId = `onb-${randomUUID()}`;
    const abort = new AbortController();
    const session: ActiveOnboarding = { sessionId, platform, abort };
    this.onboardings.set(sessionId, session);

    const knownCredentials = async (): Promise<readonly Credentials[]> => {
      const out: Credentials[] = [];
      for (const conn of this.store.connections().filter((c) => c.platform === platform).reverse()) {
        if (!conn.secretRef) continue;
        const raw = await this.secrets.get(conn.secretRef).catch(() => undefined);
        if (raw) {
          try {
            out.push(JSON.parse(raw) as Credentials);
          } catch {
            // Skip malformed entry.
          }
        }
      }
      return out;
    };

    const awaitCode = () =>
      new Promise<string>((resolveCode, rejectCode) => {
        session.codeWaiter = { resolve: resolveCode, reject: rejectCode };
        abort.signal.addEventListener("abort", () => rejectCode(new Error("Onboarding cancelled")), { once: true });
      });

    void this.runOnboarding(session, channel, credentials, {
      agentName,
      awaitCode,
      knownCredentials,
      ...(reauthorize ? { reauthorize } : {}),
      ...(adding ? { adding } : {}),
    }, reauthorizeConnectionId);

    return { sessionId, platform };
  }

  private async runOnboarding(
    session: ActiveOnboarding,
    channel: Channel,
    credentials: Credentials | undefined,
    context: {
      readonly agentName: string;
      readonly awaitCode: () => Promise<string>;
      readonly knownCredentials: () => Promise<readonly Credentials[]>;
      readonly reauthorize?: Credentials;
      readonly adding?: readonly PermissionId[];
    },
    reauthorizeConnectionId?: string,
  ): Promise<void> {
    try {
      for await (const event of channel.onboard(credentials, session.abort.signal, context)) {
        if (this.closed) return;
        if (event.kind === "succeeded") {
          await this.finalizeOnboardingSuccess(session, event, reauthorizeConnectionId);
          return;
        }
        this.emit({
          method: "onboarding.event",
          params: { sessionId: session.sessionId, platform: session.platform, event },
        });
        if (event.kind === "failed") return;
      }
    } catch (error) {
      if (!this.closed) {
        this.emit({
          method: "onboarding.event",
          params: {
            sessionId: session.sessionId,
            platform: session.platform,
            event: {
              kind: "failed",
              code: session.abort.signal.aborted ? "cancelled" : "unknown",
              detail: error instanceof Error ? error.message : String(error),
            },
          },
        });
      }
    } finally {
      this.onboardings.delete(session.sessionId);
    }
  }

  private async finalizeOnboardingSuccess(
    session: ActiveOnboarding,
    event: Extract<OnboardingEvent, { kind: "succeeded" }>,
    reauthorizeConnectionId?: string,
  ): Promise<void> {
    const existing = reauthorizeConnectionId ? this.store.connection(reauthorizeConnectionId) : undefined;
    const secretRef = existing?.secretRef ?? `im:${session.platform}:${randomUUID()}`;

    // Fail-closed: credentials MUST be stored & verified in OS secure store BEFORE creating/updating connection!
    try {
      await this.secrets.set(secretRef, JSON.stringify(event.credentials));
    } catch (error) {
      this.emit({
        method: "onboarding.event",
        params: {
          sessionId: session.sessionId,
          platform: session.platform,
          event: {
            kind: "failed",
            code: "secret_store_unavailable",
            message: error instanceof Error ? error.message : String(error),
          },
        },
      });
      return;
    }

    let conn: Connection;
    if (existing) {
      conn = this.store.updateConnection(existing.id, {
        botId: event.bot.id,
        botName: event.bot.name,
        ...(event.ownerId && !existing.ownerId
          ? { ownerId: event.ownerId, lifecycleState: "active", claimCode: null, claimExpiresAt: null, claimAttempts: 0 }
          : {}),
      })!;
    } else if (event.ownerId) {
      conn = this.store.createConnection({
        platform: session.platform,
        secretRef,
        botId: event.bot.id,
        botName: event.bot.name,
        lifecycleState: "active",
        ownerId: event.ownerId,
      });
      const ownerContact = this.store.touchContact(conn.id, event.ownerId, null);
      this.store.setContactAccess(ownerContact.id, "allowed");
    } else {
      // Missing ownerId -> enter strict `pairing` state with 6-digit 10m TTL claim code!
      conn = this.store.createConnection({
        platform: session.platform,
        secretRef,
        botId: event.bot.id,
        botName: event.bot.name,
        lifecycleState: "pairing",
        ownerId: null,
        claimCode: claimCode(),
        claimExpiresAt: this.now() + CLAIM_TTL_MS,
      });
    }

    // Never leak raw credentials over IPC!
    this.emit({
      method: "onboarding.event",
      params: {
        sessionId: session.sessionId,
        platform: session.platform,
        event: {
          kind: "succeeded",
          connectionId: conn.id,
          bot: event.bot,
          ownerId: conn.ownerId,
          lifecycleState: conn.lifecycleState,
          claimCode: conn.claimCode,
          claimExpiresAt: conn.claimExpiresAt,
          pendingApproval: event.pendingApproval ?? false,
        },
      },
    });

    if (!this.links.has(conn.id)) {
      this.links.set(conn.id, { machine: createLinkMachine(conn.lifecycleState) });
    }
    this.dispatchLinkEvent(conn.id, { kind: "connect" });
  }

  private handleOnboardingSubmitCode(params: Record<string, unknown>) {
    const sessionId = reqStr(params, "sessionId");
    const code = reqStr(params, "code");
    const session = this.onboardings.get(sessionId);
    if (!session?.codeWaiter) {
      throw new BridgeError("NO_PENDING_CODE", `No code request pending for onboarding session "${sessionId}"`);
    }
    const waiter = session.codeWaiter;
    session.codeWaiter = undefined;
    waiter.resolve(code);
    return { accepted: true };
  }

  private handleOnboardingCancel(params: Record<string, unknown>) {
    const sessionId = reqStr(params, "sessionId");
    const session = this.onboardings.get(sessionId);
    if (session) {
      session.abort.abort();
      session.codeWaiter?.reject(new Error("Onboarding cancelled"));
      this.onboardings.delete(sessionId);
    }
    return { cancelled: Boolean(session) };
  }

  // --------------------------------------------------------------- connections

  private handleConnectionPause(connectionId: string) {
    const conn = this.requireConnection(connectionId);
    this.store.updateConnection(conn.id, { paused: true });
    this.store.pauseConnectionMessages(conn.id);
    this.dispatchLinkEvent(conn.id, { kind: "pause" });
    return { connection: sanitizeConnection(this.store.connection(conn.id)!) };
  }

  private handleConnectionResume(connectionId: string) {
    const conn = this.requireConnection(connectionId);
    this.store.updateConnection(conn.id, { paused: false });
    this.dispatchLinkEvent(conn.id, { kind: "resume" });
    return { connection: sanitizeConnection(this.store.connection(conn.id)!) };
  }

  private async handleConnectionDisconnect(connectionId: string) {
    const conn = this.requireConnection(connectionId);
    this.dispatchLinkEvent(conn.id, { kind: "remove" });
    const managed = this.links.get(conn.id);
    if (managed?.retryTimer) clearTimeout(managed.retryTimer);
    if (managed?.live) {
      await managed.live.close().catch(() => {});
    }
    this.links.delete(conn.id);
    if (conn.secretRef) {
      await this.secrets.delete(conn.secretRef).catch(() => {});
    }
    this.store.deleteConnection(conn.id);
    this.emit({
      method: "connection.state",
      params: {
        connectionId: conn.id,
        platform: conn.platform,
        lifecycleState: "idle",
        state: "idle",
        stateDetail: "disconnected",
        ownerId: null,
        claimCode: null,
        claimExpiresAt: null,
      },
    });
    return { disconnected: true, connectionId: conn.id };
  }

  private handleClaimRefresh(connectionId: string) {
    const conn = this.requireConnection(connectionId);
    if (conn.ownerId || conn.lifecycleState !== "pairing") {
      throw new BridgeError("ALREADY_CLAIMED", `Connection "${connectionId}" is not in pairing state`);
    }
    const nextCode = claimCode();
    const nextExpiresAt = this.now() + CLAIM_TTL_MS;
    const updated = this.store.updateConnection(conn.id, {
      claimCode: nextCode,
      claimExpiresAt: nextExpiresAt,
      claimAttempts: 0,
    })!;
    this.emitConnectionState(updated);
    return { connectionId: updated.id, claimCode: updated.claimCode, claimExpiresAt: updated.claimExpiresAt };
  }

  private async handleConnectionPermissions(connectionId: string) {
    const conn = this.requireConnection(connectionId);
    const live = this.links.get(conn.id)?.live;
    if (!live?.permissions) {
      return { connectionId: conn.id, permissions: [] };
    }
    const permissions = await live.permissions().catch(() => []);
    return { connectionId: conn.id, permissions };
  }

  // -------------------------------------------------------------------- access

  private handleAccessList(connectionId?: string) {
    const held = this.store.heldMessages(connectionId);
    const contacts = this.store.contacts(connectionId);
    const groups = this.store.chats(connectionId).filter((c) => c.kind === "group");
    return { held, contacts, groups };
  }

  private handleAccessDecide(params: Record<string, unknown>) {
    const targetKind = reqStr(params, "targetKind");
    const targetId = reqStr(params, "targetId");
    const decision = reqStr(params, "decision");
    if (decision !== "allowed" && decision !== "blocked") {
      throw new BridgeError("INVALID_DECISION", `decision must be "allowed" or "blocked"`);
    }

    let heldList: Message[] = [];
    if (targetKind === "contact") {
      const updated = this.store.setContactAccess(targetId, decision);
      if (!updated) throw new BridgeError("CONTACT_NOT_FOUND", `Contact not found: ${targetId}`);
      heldList = this.store.heldMessagesForContact(targetId);
    } else if (targetKind === "chat") {
      const updated = this.store.setChatAccess(targetId, decision);
      if (!updated) throw new BridgeError("CHAT_NOT_FOUND", `Chat not found: ${targetId}`);
      heldList = this.store.heldMessagesForChat(targetId);
    } else {
      throw new BridgeError("INVALID_TARGET", `targetKind must be "contact" or "chat"`);
    }

    if (decision === "blocked") {
      const movedIds = this.store.moveInbound(
        heldList.map((m) => m.id),
        "refuse",
      );
      return { targetKind, targetId, decision, affectedMessages: movedIds };
    }

    // Re-evaluate gate() per held message: approving a contact MUST NOT admit held messages
    // in unapproved groups, and approving a group MUST NOT admit held messages from blocked contacts.
    const toAdmit: string[] = [];
    const toRefuse: string[] = [];
    for (const held of heldList) {
      const conn = this.store.connection(held.connectionId);
      const chat = this.store.chat(held.chatId);
      if (!conn || !chat) continue;
      const parent = chat.parentId ? this.store.chat(chat.parentId) : undefined;
      const contact = held.senderId ? this.store.contactByPlatformId(conn.id, held.senderId) : undefined;
      const trust = this.channels[conn.platform]?.trust ?? "public";
      const verdict = gate({
        lifecycleState: conn.lifecycleState,
        trust,
        askAll: conn.askAll,
        isOwner: Boolean(conn.ownerId && held.senderId === conn.ownerId),
        chatKind: chat.kind,
        contact: contact?.access ?? null,
        group: chat.kind === "thread" ? (parent?.access ?? chat.access) : chat.access,
      });
      if (verdict === "deliver") toAdmit.push(held.id);
      else if (verdict === "drop") toRefuse.push(held.id);
    }

    if (toRefuse.length > 0) {
      this.store.moveInbound(toRefuse, "refuse");
    }
    const admittedIds = this.store.moveInbound(toAdmit, "admit");
    for (const msgId of admittedIds) {
      const msg = this.store.message(msgId);
      if (!msg) continue;
      const conn = this.store.connection(msg.connectionId);
      const chat = this.store.chat(msg.chatId);
      if (!conn || !chat) continue;
      const contact = msg.senderId ? this.store.contactByPlatformId(conn.id, msg.senderId) : undefined;
      this.emitDispatch(conn, chat, msg, contact);
    }

    return { targetKind, targetId, decision, affectedMessages: admittedIds };
  }

  private handleSetAskAll(connectionId: string, askAll: boolean) {
    const conn = this.requireConnection(connectionId);
    const updated = this.store.updateConnection(conn.id, { askAll })!;
    return { connection: sanitizeConnection(updated) };
  }

  // --------------------------------------------------------- contacts & people

  private handleContactRename(contactId: string, name: string | null) {
    const updated = this.store.nameContact(contactId, name);
    if (!updated) throw new BridgeError("CONTACT_NOT_FOUND", `Contact not found: ${contactId}`);
    return { contact: updated };
  }

  private handleContactNote(params: Record<string, unknown>) {
    const contactId = optStr(params, "contactId");
    const personId = optStr(params, "personId");
    const note = params.note === null ? null : reqStr(params, "note");
    const targetPersonId = personId ?? (contactId ? this.store.ensurePerson(contactId).id : undefined);
    if (!targetPersonId) {
      throw new BridgeError("INVALID_PARAMS", "Either contactId or personId is required");
    }
    const person = this.store.updatePerson(targetPersonId, { note });
    if (!person) throw new BridgeError("PERSON_NOT_FOUND", `Person not found: ${targetPersonId}`);
    return { person };
  }

  private handlePeopleLink(params: Record<string, unknown>) {
    const contactIds = params.contactIds;
    if (!Array.isArray(contactIds) || contactIds.some((x) => typeof x !== "string")) {
      throw new BridgeError("INVALID_PARAMS", "contactIds must be an array of contact ID strings");
    }
    if (params.by !== "agent" && params.by !== "owner") {
      throw new BridgeError("INVALID_PARAMS", "by must be explicitly set to \"agent\" or \"owner\"");
    }
    const by: LinkedBy = params.by;
    const person = this.store.linkContacts(contactIds, by);
    return { person, contacts: this.store.personContacts(person.id) };
  }

  private handlePeopleUnlink(params: Record<string, unknown>) {
    const contactId = reqStr(params, "contactId");
    if (params.by !== "agent" && params.by !== "owner") {
      throw new BridgeError("INVALID_PARAMS", "by must be explicitly set to \"agent\" or \"owner\"");
    }
    const by: LinkedBy = params.by;
    this.store.unlinkContact(contactId, by);
    return { unlinked: true, contactId };
  }

  // ------------------------------------------------------------------ messages

  private async handleMessagesReply(params: Record<string, unknown>) {
    const messageId = reqStr(params, "messageId");
    const text = reqStr(params, "text");
    const target = this.store.message(messageId);
    if (!target) throw new BridgeError("MESSAGE_NOT_FOUND", `Message not found: ${messageId}`);
    const chat = this.store.chat(target.chatId);
    if (!chat) throw new BridgeError("CHAT_NOT_FOUND", `Chat not found: ${target.chatId}`);
    const live = this.requireActiveChat(chat);

    const outRecord = this.store.insertOutbound({
      connectionId: chat.connectionId,
      chatId: chat.id,
      body: text,
      replyTo: target.id,
    });

    const outbound: OutboundMessage = {
      chat: toChatRef(chat, this.store),
      text,
      ...(target.platformMsgId ? { replyTo: target.platformMsgId } : {}),
      ...(Array.isArray(params.files) ? { files: params.files as OutboundMessage["files"] } : {}),
      ...(Array.isArray(params.mentions) ? { mentions: params.mentions as readonly Mention[] } : {}),
      ...(params.inThread ? { inThread: params.inThread as { readonly title: string } } : {}),
      ...(params.inChat === true ? { inChat: true } : {}),
    };

    const result = await sendWithRetry(live, outbound);
    this.store.setOutboundResult(
      outRecord.id,
      result.kind === "sent" ? "sent" : result.kind === "uncertain" ? "uncertain" : "failed",
      result.kind === "sent" ? result.platformId : null,
    );
    if (result.kind === "sent" || result.kind === "uncertain") {
      this.store.moveInbound([target.id], "reply");
    }
    return { message: this.store.message(outRecord.id), result };
  }

  private async handleMessagesSend(params: Record<string, unknown>) {
    const chatId = reqStr(params, "chatId");
    const text = reqStr(params, "text");
    const chat = this.store.chat(chatId);
    if (!chat) throw new BridgeError("CHAT_NOT_FOUND", `Chat not found: ${chatId}`);
    const live = this.requireActiveChat(chat);

    const replyToId = optStr(params, "replyTo");
    const replyTarget = replyToId ? this.store.message(replyToId) : undefined;

    const outRecord = this.store.insertOutbound({
      connectionId: chat.connectionId,
      chatId: chat.id,
      body: text,
      replyTo: replyTarget?.id ?? null,
    });

    const outbound: OutboundMessage = {
      chat: toChatRef(chat, this.store),
      text,
      ...(replyTarget?.platformMsgId ? { replyTo: replyTarget.platformMsgId } : replyToId ? { replyTo: replyToId } : {}),
      ...(Array.isArray(params.files) ? { files: params.files as OutboundMessage["files"] } : {}),
      ...(Array.isArray(params.mentions) ? { mentions: params.mentions as readonly Mention[] } : {}),
      ...(params.inThread ? { inThread: params.inThread as { readonly title: string } } : {}),
      ...(params.inChat === true ? { inChat: true } : {}),
    };

    const result = await sendWithRetry(live, outbound);
    this.store.setOutboundResult(
      outRecord.id,
      result.kind === "sent" ? "sent" : result.kind === "uncertain" ? "uncertain" : "failed",
      result.kind === "sent" ? result.platformId : null,
    );
    if (result.kind === "sent" || result.kind === "uncertain") {
      if (replyTarget) this.store.moveInbound([replyTarget.id], "reply");
      else this.store.settleChatOnSend(chat.id);
    }
    return { message: this.store.message(outRecord.id), result };
  }

  private async handleLiveStart(params: Record<string, unknown>) {
    const chatId = reqStr(params, "chatId");
    const replyTo = reqStr(params, "replyTo");
    const initial = reqStr(params, "initial");
    const mention = optStr(params, "mention");
    const chat = this.store.chat(chatId);
    if (!chat) throw new BridgeError("CHAT_NOT_FOUND", `Chat not found: ${chatId}`);
    const liveConn = this.requireActiveChat(chat);
    if (!liveConn.startLive) {
      return { supported: false };
    }
    const targetMsg = this.store.message(replyTo);
    const platformReplyTo = targetMsg?.platformMsgId ?? replyTo;
    const handle = await liveConn.startLive(toChatRef(chat, this.store), {
      replyTo: platformReplyTo,
      initial,
      ...(mention ? { mention } : {}),
    });
    const liveId = `live-${randomUUID()}`;
    this.liveReplies.set(liveId, { live: handle, connectionId: chat.connectionId, chatId: chat.id, replyTo: targetMsg?.id ?? replyTo });
    return { supported: true, liveId, ...(handle.until !== undefined ? { until: handle.until } : {}) };
  }

  private async handleLiveUpdate(params: Record<string, unknown>) {
    const liveId = reqStr(params, "liveId");
    const markdown = reqStr(params, "markdown");
    const entry = this.liveReplies.get(liveId);
    if (!entry) throw new BridgeError("LIVE_NOT_FOUND", `Live reply not found: ${liveId}`);
    await entry.live.update(markdown);
    return { updated: true };
  }

  private async handleLiveFinish(params: Record<string, unknown>) {
    const liveId = reqStr(params, "liveId");
    const markdown = reqStr(params, "markdown");
    const mentions = Array.isArray(params.mentions) ? (params.mentions as readonly Mention[]) : undefined;
    const entry = this.liveReplies.get(liveId);
    if (!entry) throw new BridgeError("LIVE_NOT_FOUND", `Live reply not found: ${liveId}`);
    this.liveReplies.delete(liveId);
    const result = await entry.live.finish(markdown, mentions);
    if (result.kind === "sent") {
      const out = this.store.insertOutbound({
        connectionId: entry.connectionId,
        chatId: entry.chatId,
        body: markdown,
        replyTo: this.store.message(entry.replyTo)?.id ?? null,
      });
      this.store.setOutboundResult(out.id, "sent", result.platformId);
      if (this.store.message(entry.replyTo)) {
        this.store.moveInbound([entry.replyTo], "reply");
      }
    }
    return { result };
  }

  private async handleMessagesReact(params: Record<string, unknown>) {
    const chatId = reqStr(params, "chatId");
    const platformMessageId = reqStr(params, "platformMessageId");
    const state = reqStr(params, "state") as ReactionState;
    const chat = this.store.chat(chatId);
    if (!chat) throw new BridgeError("CHAT_NOT_FOUND", `Chat not found: ${chatId}`);
    const live = this.requireLiveConnection(chat.connectionId);
    await live.react(toChatRef(chat, this.store), platformMessageId, state);
    return { ok: true };
  }

  private handleMessagesRead(params: Record<string, unknown>) {
    const chatId = reqStr(params, "chatId");
    const chat = this.store.chat(chatId);
    if (!chat) throw new BridgeError("CHAT_NOT_FOUND", `Chat not found: ${chatId}`);
    if (this.store.isChatBlocked(chatId)) {
      throw new BridgeError("CHAT_BLOCKED", `Cannot read blocked chat: ${chatId}`);
    }
    const limit = typeof params.limit === "number" ? Math.max(1, Math.min(200, Math.floor(params.limit))) : 50;
    const around = optStr(params, "around");
    const since = optStr(params, "since");
    const before = optStr(params, "before");
    const messages = around
      ? (this.store.chatAround(chatId, around, limit) ?? [])
      : since
        ? (this.store.chatSince(chatId, since, limit) ?? [])
        : this.store.chatMessages(chatId, limit, before);
    return { chat, messages };
  }

  private handleMessagesSearch(params: Record<string, unknown>) {
    const query = reqStr(params, "query");
    const chatId = optStr(params, "chatId");
    const connectionId = optStr(params, "connectionId");
    const limit = typeof params.limit === "number" ? Math.max(1, Math.min(100, Math.floor(params.limit))) : 20;
    const matches = this.store.search(query, { chatId, connectionId, limit });
    return {
      query,
      results: matches.map((m) => ({
        message: m,
        excerpt: excerpt(m.body, query),
      })),
    };
  }

  // --------------------------------------------------------------------- files

  private async handleFilesDownload(params: Record<string, unknown>) {
    const fileId = reqStr(params, "fileId");
    const destPath = reqStr(params, "destPath");
    const allowedRoot = reqStr(params, "allowedRoot");

    // Enforce strict confinement inside `allowedRoot` BEFORE any filesystem write or network call!
    const safeDest = validateDownloadPath(destPath, allowedRoot);

    const found = this.store.attachment(fileId);
    if (!found) throw new BridgeError("FILE_NOT_FOUND", `Attachment not found: ${fileId}`);
    const live = this.requireLiveConnection(found.chat.connectionId);

    mkdirSync(dirname(safeDest), { recursive: true });
    await live.download(
      {
        id: found.attachment.ref,
        name: found.attachment.name,
        ...(found.attachment.size !== undefined ? { size: found.attachment.size } : {}),
        ...(found.attachment.mime !== undefined ? { mime: found.attachment.mime } : {}),
      },
      safeDest,
    );
    return { fileId, destPath: safeDest, name: found.attachment.name };
  }

  // ----------------------------------------------------------- inbound ack/settle

  private handleInboundAck(params: Record<string, unknown>) {
    const messageId = optStr(params, "messageId");
    const idempotencyKey = optStr(params, "idempotencyKey");
    const t3ThreadId = reqStr(params, "t3ThreadId");
    const t3TurnId = reqStr(params, "t3TurnId");
    if (!messageId && !idempotencyKey) {
      throw new BridgeError("INVALID_PARAMS", "Either messageId or idempotencyKey is required");
    }
    const updated = this.store.ackInbound({ messageId, idempotencyKey }, { t3ThreadId, t3TurnId });
    if (!updated) throw new BridgeError("MESSAGE_NOT_FOUND", "Inbound message not found");
    return { message: updated };
  }

  private handleInboundSettle(params: Record<string, unknown>) {
    const messageId = optStr(params, "messageId");
    const idempotencyKey = optStr(params, "idempotencyKey");
    const rawEvent = reqStr(params, "event");
    if (!Object.hasOwn(INBOUND, rawEvent)) {
      throw new BridgeError("INVALID_PARAMS", `Invalid inbound settle event: "${rawEvent}"`);
    }
    const event = rawEvent as InboundEvent;
    const retryAt = typeof params.retryAt === "number" ? params.retryAt : undefined;
    const msg = messageId
      ? this.store.message(messageId)
      : idempotencyKey
        ? this.store.messageByIdempotencyKey(idempotencyKey)
        : undefined;
    if (!msg) throw new BridgeError("MESSAGE_NOT_FOUND", "Inbound message not found");
    const moved = this.store.moveInbound([msg.id], event, retryAt);
    return { moved: moved.length > 0, message: this.store.message(msg.id) };
  }

  // ------------------------------------------------------------- link lifecycle

  private dispatchLinkEvent(connectionId: string, event: LinkEvent): void {
    const conn = this.store.connection(connectionId);
    if (!conn) return;
    let managed = this.links.get(connectionId);
    if (!managed) {
      managed = { machine: createLinkMachine(conn.lifecycleState) };
      this.links.set(connectionId, managed);
    }

    const { machine: nextMachine, effect } = stepMachine(managed.machine, event, this.now(), this.backoffDelays);
    managed.machine = nextMachine;

    const persisted = stored(nextMachine.state);
    const updated = this.store.updateConnection(connectionId, {
      state: persisted.state,
      stateDetail: persisted.stateDetail,
    });
    if (updated) this.emitConnectionState(updated);

    if (effect === "close" || effect === "retry_later" || effect === "connect") {
      if (managed.retryTimer) {
        clearTimeout(managed.retryTimer);
        managed.retryTimer = undefined;
      }
      if (managed.live) {
        const old = managed.live;
        managed.live = undefined;
        void old.close().catch(() => {});
      }
    }

    if (effect === "retry_later" && nextMachine.state.kind === "waiting") {
      const waitMs = Math.max(0, nextMachine.state.retryAt - this.now());
      managed.retryTimer = setTimeout(() => {
        if (!this.closed) this.dispatchLinkEvent(connectionId, { kind: "timer" });
      }, waitMs);
      managed.retryTimer.unref?.();
    } else if (effect === "connect") {
      void this.openAdapterConnection(connectionId, nextMachine.generation);
    }
  }

  private async openAdapterConnection(connectionId: string, generation: number): Promise<void> {
    const conn = this.store.connection(connectionId);
    if (!conn || this.closed) return;
    const channel = this.channels[conn.platform];
    if (!channel) {
      this.dispatchLinkEvent(connectionId, { kind: "failed", code: "unknown", generation });
      return;
    }
    if (!conn.secretRef) {
      this.dispatchLinkEvent(connectionId, { kind: "failed", code: "credentials_missing", generation });
      return;
    }

    let rawCreds: string | undefined;
    try {
      rawCreds = await this.secrets.get(conn.secretRef);
    } catch {
      this.dispatchLinkEvent(connectionId, { kind: "failed", code: "credentials_missing", generation });
      return;
    }
    if (!rawCreds) {
      this.dispatchLinkEvent(connectionId, { kind: "failed", code: "credentials_missing", generation });
      return;
    }
    const credentials = JSON.parse(rawCreds) as Credentials;
    const trust = channel.trust ?? "public";
    const initialCursor = this.store.getConnectionCursor(connectionId);

    const events: ChannelEvents = {
      onMessage: async (message: InboundMessage) => {
        if (this.links.get(connectionId)?.machine.generation !== generation) return;
        const outcome = this.store.ingestInbound(connectionId, trust, message);
        this.handleIngestOutcome(connectionId, outcome);
      },
      onMessageBatch: async (batch: InboundBatch) => {
        if (this.links.get(connectionId)?.machine.generation !== generation) return;
        const { outcomes } = this.store.persistInboundBatch(connectionId, trust, batch);
        for (const outcome of outcomes) {
          this.handleIngestOutcome(connectionId, outcome);
        }
      },
      onCursorCommit: (cursor: string) => {
        if (this.links.get(connectionId)?.machine.generation !== generation) return;
        this.store.setConnectionCursor(connectionId, cursor);
      },
      onState: (state) => {
        if (!this.closed) this.dispatchLinkEvent(connectionId, { kind: "reported", state, generation });
      },
      onMembership: ({ chat, joined }) => {
        if (this.links.get(connectionId)?.machine.generation !== generation) return;
        if (joined) {
          this.store.upsertChat({
            connectionId,
            platformId: chat.platformId,
            kind: chat.kind,
            name: chat.name,
          });
        }
      },
    };

    try {
      const live = await channel.connect(
        credentials,
        events,
        initialCursor !== undefined ? { initialCursor } : undefined,
      );
      const managed = this.links.get(connectionId);
      if (this.closed || !managed || managed.machine.generation !== generation) {
        await live.close().catch(() => {});
        return;
      }
      managed.live = live;
      this.dispatchLinkEvent(connectionId, { kind: "opened", generation });
    } catch (error) {
      if (this.closed) return;
      const code = classifyConnectError(error);
      this.dispatchLinkEvent(connectionId, { kind: "failed", code, generation });
    }
  }

  private handleIngestOutcome(connectionId: string, outcome: IngestOutcome): void {
    const conn = this.store.connection(connectionId);
    if (!conn) return;

    switch (outcome.kind) {
      case "pairing_claimed": {
        const managed = this.links.get(connectionId);
        if (managed) {
          managed.machine = stepMachine(managed.machine, { kind: "activate" }, this.now(), this.backoffDelays).machine;
        }
        this.emitConnectionState(conn);
        // Never wake T3 for pairing claim DM!
        return;
      }
      case "pairing_rejected": {
        // Refresh emitted state if attempts exhausted cleared claim code.
        if (outcome.decision.kind === "wrong_code" && outcome.decision.exhausted) {
          this.emitConnectionState(conn);
        }
        return;
      }
      case "held": {
        this.emit({
          method: "access.held",
          params: {
            connectionId: conn.id,
            platform: conn.platform,
            chatId: outcome.chat.id,
            chatKind: outcome.chat.kind,
            chatName: outcome.chat.name,
            contactId: outcome.contact.id,
            senderId: outcome.message.senderId,
            senderName: contactName(outcome.contact) ?? outcome.message.senderName,
            messageId: outcome.message.id,
            body: outcome.message.body,
            createdAt: outcome.message.createdAt,
          },
        });
        return;
      }
      case "stop": {
        this.emit({
          method: "inbound.stop",
          params: {
            connectionId: conn.id,
            platform: conn.platform,
            chatId: outcome.chat.id,
            threadId: outcome.chat.threadId,
            messageId: outcome.message.id,
            platformMsgId: outcome.message.platformMsgId,
            senderId: outcome.message.senderId,
            createdAt: outcome.message.createdAt,
            verifiedOwner: true,
            senderRole: "owner",
          },
        });
        return;
      }
      case "dispatch": {
        this.emitDispatch(conn, outcome.chat, outcome.message, outcome.contact);
        return;
      }
      default:
        return;
    }
  }

  private emitConnectionState(conn: Connection): void {
    this.emit({
      method: "connection.state",
      params: {
        connectionId: conn.id,
        platform: conn.platform,
        lifecycleState: conn.lifecycleState,
        state: conn.state,
        stateDetail: conn.stateDetail,
        paused: conn.paused,
        ownerId: conn.ownerId,
        claimCode: conn.claimCode,
        claimExpiresAt: conn.claimExpiresAt,
      },
    });
  }

  private emitDispatch(conn: Connection, chat: Chat, msg: Message, contact?: Contact): void {
    const isOwner = Boolean(conn.ownerId && msg.senderId === conn.ownerId);
    const senderRole: VerifiedSenderRole = isOwner ? "owner" : contact?.isBot ? "bot" : "member";
    const replyAudience: ReplyAudience = chat.kind === "dm" && isOwner ? "owner_dm" : "group";
    const unseen = chat.kind === "dm" ? 0 : this.store.unseen(chat.id, msg.createdAt);

    let quoted: { readonly from: string; readonly body: string } | undefined;
    if (msg.replyTo) {
      const parent = this.store.message(msg.replyTo);
      if (parent) {
        const parentContact = parent.senderId ? this.store.contactByPlatformId(conn.id, parent.senderId) : undefined;
        const from =
          parent.direction === "out"
            ? this.agentName
            : (contactName(parentContact) ?? parent.senderName ?? parent.senderId ?? "unknown");
        quoted = { from, body: parent.body };
      }
    }

    const formatted = formatMessage(msg, chat, conn.platform, {
      ownerId: conn.ownerId,
      agentName: this.agentName,
      contact,
      unseen,
      quoted,
    });
    const senderDisplayName = contactName(contact) ?? msg.senderName;
    const envelope = wrapUntrustedMessage(formatted, {
      platform: conn.platform,
      connectionId: conn.id,
      chatId: chat.id,
      chatKind: chat.kind,
      messageId: msg.id,
      senderRole,
      replyAudience,
      senderName: senderDisplayName,
    });

    this.emit({
      method: "inbound.dispatch",
      params: {
        connectionId: conn.id,
        platform: conn.platform,
        chatId: chat.id,
        chatKind: chat.kind,
        chatName: chat.name,
        parentChatId: chat.parentId,
        threadId: chat.threadId,
        messageId: msg.id,
        platformMsgId: msg.platformMsgId,
        idempotencyKey: msg.idempotencyKey,
        senderId: msg.senderId,
        senderName: senderDisplayName,
        contactId: contact?.id ?? null,
        personId: contact?.personId ?? null,
        senderRole,
        replyAudience,
        isOwner,
        body: msg.body,
        attachments: msg.attachments,
        replyTo: msg.replyTo,
        unseen,
        formatted,
        envelope,
        createdAt: msg.createdAt,
      },
    });
  }

  private requireConnection(connectionId: string): Connection {
    const conn = this.store.connection(connectionId);
    if (!conn) throw new BridgeError("CONNECTION_NOT_FOUND", `Connection not found: ${connectionId}`);
    return conn;
  }

  private requireLiveConnection(connectionId: string): ChannelConnection {
    this.requireConnection(connectionId);
    const live = this.links.get(connectionId)?.live;
    if (!live) throw new BridgeError("CONNECTION_OFFLINE", `Connection "${connectionId}" is not currently connected`);
    return live;
  }

  private requireActiveChat(chat: Chat): ChannelConnection {
    const connection = this.requireConnection(chat.connectionId);
    if (connection.lifecycleState !== "active") {
      throw new BridgeError("CONNECTION_INACTIVE", `Connection "${connection.id}" is not active`);
    }
    if (this.store.isChatBlocked(chat.id)) {
      throw new BridgeError("CHAT_BLOCKED", `Cannot send to blocked chat: ${chat.id}`);
    }
    return this.requireLiveConnection(connection.id);
  }
}

async function sendWithRetry(live: ChannelConnection, outbound: OutboundMessage): Promise<SendResult> {
  let last: SendResult = { kind: "failed", code: "unknown", retryable: false };
  let current = outbound;
  for (let attempt = 1; attempt <= MAX_SEND_ATTEMPTS; attempt++) {
    last = await live.send(current);
    if (last.kind === "sent" || last.kind === "uncertain" || !last.retryable) {
      return last;
    }
    if (last.textSent && current.files?.length) {
      current = { ...current, text: "" };
    }
  }
  return last;
}

function classifyConnectError(error: unknown): "credentials_revoked" | "permission_missing" | "network" | "unknown" {
  const msg = error instanceof Error ? error.message : String(error);
  if (/revoked|auth|invalid.*secret|unauthorized|forbidden/i.test(msg)) return "credentials_revoked";
  if (/permission|scope/i.test(msg)) return "permission_missing";
  if (/timeout|network|econn|enotfound|fetch/i.test(msg)) return "network";
  return "unknown";
}

function toChatRef(chat: Chat, store: Store): ChatRef {
  const parent = chat.parentId ? store.chat(chat.parentId) : undefined;
  return {
    platformId: chat.platformId,
    kind: chat.kind,
    ...(chat.name ? { name: chat.name } : {}),
    ...(parent ? { parent: { platformId: parent.platformId, ...(parent.name ? { name: parent.name } : {}) } } : {}),
    ...(chat.followUp ? { followUp: true } : {}),
  };
}

function sanitizeConnection(conn: Connection) {
  return {
    id: conn.id,
    platform: conn.platform,
    botId: conn.botId,
    botName: conn.botName,
    lifecycleState: conn.lifecycleState,
    state: conn.state,
    stateDetail: conn.stateDetail,
    paused: conn.paused,
    ownerId: conn.ownerId,
    claimCode: conn.claimCode,
    claimExpiresAt: conn.claimExpiresAt,
    claimAttempts: conn.claimAttempts,
    askAll: conn.askAll,
    createdAt: conn.createdAt,
    updatedAt: conn.updatedAt,
  };
}

function reqStr(params: Record<string, unknown>, key: string): string {
  const val = params[key];
  if (typeof val !== "string" || !val.length) {
    throw new BridgeError("INVALID_PARAMS", `Missing required string parameter "${key}"`);
  }
  return val;
}

function optStr(params: Record<string, unknown>, key: string): string | undefined {
  const val = params[key];
  if (val === undefined || val === null) return undefined;
  if (typeof val !== "string") {
    throw new BridgeError("INVALID_PARAMS", `Parameter "${key}" must be a string`);
  }
  return val;
}
