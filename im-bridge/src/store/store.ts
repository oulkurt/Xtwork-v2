/**
 * Lightweight `node:sqlite` persistence store for `im-bridge`.
 *
 * Adapted from earayu/Mingle (MIT, commit 006220e880d2134665ce2745ab6233f52c8eabe9),
 * src/store/store.ts, tailored for ADR-011:
 * - Zero Agent runtime tables (T3 `statev2.sqlite` is the sole orchestration source of truth).
 * - Gate-before-background enforcement: `blocked` messages never enter background search;
 *   `held` stores pending triggers only; `messages_fts` (FTS5 `trigram`) indexes allowed chats only.
 * - Atomic `persistInboundBatch()` persists gated messages + dedup + poll cursor in ONE SQLite txn.
 * - `listUnackedTriggers()` returns ONLY gate-approved unacked `received`/`delivered` triggers.
 * - `linkContacts(..., "agent")` cannot touch owner contacts or transfer permissions.
 */

import { DatabaseSync, type SQLInputValue, type StatementSync } from "node:sqlite";
import type { ChatKind, InboundMessage, Platform, Trust } from "../channels/channel.ts";
import { type Access, evaluatePairingClaim, gate, type PairingDecision } from "../core/access.ts";
import { shortId } from "../core/ids.ts";
import { INBOUND, type InboundEvent, type InboundState } from "../core/inbound.ts";
import type { LifecycleState, StoredLinkState } from "../core/link.ts";
import { searchTerms } from "../core/terms.ts";

export type { Access } from "../core/access.ts";
export type { InboundState } from "../core/inbound.ts";

export type OutboundState = "pending" | "sent" | "failed" | "uncertain";
export type LinkedBy = "owner" | "agent";

/** Maximum UTF-8 byte length for `people.note` (2 KB per ADR-011). */
export const MAX_PERSON_NOTE_BYTES = 2048;

export interface Connection {
  readonly id: string;
  readonly platform: Platform;
  readonly botId: string | null;
  readonly botName: string | null;
  readonly lifecycleState: LifecycleState;
  readonly state: StoredLinkState;
  readonly stateDetail: string | null;
  readonly paused: boolean;
  readonly leaderPaused: boolean;
  readonly leaderId: string;
  readonly bindingId: string | null;
  readonly bindingEpoch: number;
  readonly secretRef: string | null;
  readonly ownerId: string | null;
  readonly claimCode: string | null;
  readonly claimExpiresAt: number | null;
  readonly claimAttempts: number;
  readonly askAll: boolean;
  readonly cursorJson: string | null;
  readonly createdAt: number;
  readonly updatedAt: number;
}

export interface Chat {
  readonly id: string;
  readonly connectionId: string;
  readonly platformId: string;
  readonly kind: ChatKind;
  readonly name: string | null;
  readonly access: Access;
  readonly parentId: string | null;
  readonly followUp: boolean;
  readonly threadId: string | null;
  readonly threadLeaderId: string | null;
  readonly threadBindingId: string | null;
  readonly threadBindingEpoch: number | null;
  readonly peerId: string | null;
  readonly createdAt: number;
  readonly updatedAt: number;
}

export interface Contact {
  readonly id: string;
  readonly connectionId: string;
  readonly platformId: string;
  readonly name: string | null;
  readonly alias: string | null;
  readonly access: Access;
  readonly isBot: boolean;
  readonly personId: string | null;
  readonly personName: string | null;
  readonly linkedBy: LinkedBy | null;
  readonly profile: string | null;
  readonly createdAt: number;
  readonly updatedAt: number;
}

export interface Person {
  readonly id: string;
  readonly name: string | null;
  readonly note: string | null;
  readonly createdAt: number;
  readonly updatedAt: number;
}

export interface Attachment {
  readonly id: string;
  readonly ref: string;
  readonly name: string;
  readonly size?: number;
  readonly mime?: string;
}

export interface Message {
  readonly id: string;
  readonly connectionId: string;
  readonly chatId: string;
  readonly direction: "in" | "out";
  readonly platformMsgId: string | null;
  readonly idempotencyKey: string | null;
  readonly senderId: string | null;
  readonly senderName: string | null;
  readonly body: string;
  readonly attachments: readonly Attachment[];
  readonly replyTo: string | null;
  readonly replyToPlatformId: string | null;
  readonly triggers: boolean;
  readonly state: InboundState | OutboundState;
  readonly t3ThreadId: string | null;
  readonly t3TurnId: string | null;
  readonly leaderId: string | null;
  readonly bindingId: string | null;
  readonly bindingEpoch: number | null;
  readonly pauseGeneration: number | null;
  readonly ackedAt: number | null;
  readonly retryAt: number | null;
  readonly notice: boolean;
  readonly createdAt: number;
}

export type IngestOutcome =
  | { readonly kind: "duplicate"; readonly platformMsgId: string }
  | { readonly kind: "ignored_idle" }
  | { readonly kind: "pairing_claimed"; readonly ownerId: string; readonly chat: Chat; readonly contact: Contact }
  | { readonly kind: "pairing_rejected"; readonly decision: Exclude<PairingDecision, { kind: "claimed" }> }
  | { readonly kind: "blocked"; readonly platformMsgId: string }
  | { readonly kind: "unapproved_background_dropped"; readonly platformMsgId: string }
  | { readonly kind: "held"; readonly message: Message; readonly chat: Chat; readonly contact: Contact }
  | { readonly kind: "paused_pending"; readonly message: Message; readonly chat: Chat; readonly contact: Contact }
  | { readonly kind: "background"; readonly message: Message; readonly chat: Chat; readonly contact: Contact }
  | { readonly kind: "stop"; readonly message: Message; readonly chat: Chat; readonly contact: Contact }
  | { readonly kind: "dispatch"; readonly message: Message; readonly chat: Chat; readonly contact: Contact };

export interface PersistBatchResult {
  readonly outcomes: readonly IngestOutcome[];
  readonly cursorUpdated: boolean;
}

/** Build the stable ADR-011 end-to-end idempotency key for an inbound message. */
export function makeIdempotencyKey(connectionId: string, platformMsgId: string): string {
  return `im:${connectionId}:${platformMsgId}`;
}

export function contactName(
  contact: (Pick<Contact, "name" | "alias"> & { readonly personName?: string | null }) | undefined,
): string | null {
  return contact?.personName || contact?.alias || contact?.name || null;
}

type Row = Record<string, SQLInputValue>;

const CONTACTS_SELECT = "SELECT k.*, p.name AS person_name FROM contacts k LEFT JOIN people p ON p.id = k.person_id";

const SCHEMA_V1 = `
CREATE TABLE IF NOT EXISTS connections (
  id TEXT PRIMARY KEY,
  platform TEXT NOT NULL,
  bot_id TEXT,
  bot_name TEXT,
  lifecycle_state TEXT NOT NULL DEFAULT 'idle',
  state TEXT NOT NULL DEFAULT 'idle',
  state_detail TEXT,
  paused INTEGER NOT NULL DEFAULT 0,
  leader_paused INTEGER NOT NULL DEFAULT 0,
  leader_id TEXT NOT NULL DEFAULT 'leader-default',
  binding_id TEXT,
  binding_epoch INTEGER NOT NULL DEFAULT 1,
  secret_ref TEXT,
  owner_id TEXT,
  claim_code TEXT,
  claim_expires_at INTEGER,
  claim_attempts INTEGER NOT NULL DEFAULT 0,
  ask_all INTEGER NOT NULL DEFAULT 0,
  cursor_json TEXT,
  created_at INTEGER NOT NULL,
  updated_at INTEGER NOT NULL
);

CREATE TABLE IF NOT EXISTS people (
  id TEXT PRIMARY KEY,
  name TEXT,
  note TEXT,
  created_at INTEGER NOT NULL,
  updated_at INTEGER NOT NULL
);

CREATE TABLE IF NOT EXISTS chats (
  id TEXT PRIMARY KEY,
  connection_id TEXT NOT NULL REFERENCES connections(id) ON DELETE CASCADE,
  platform_id TEXT NOT NULL,
  kind TEXT NOT NULL,
  name TEXT,
  access TEXT,
  parent_id TEXT REFERENCES chats(id) ON DELETE SET NULL,
  follow_up INTEGER NOT NULL DEFAULT 0,
  thread_id TEXT,
  thread_leader_id TEXT,
  thread_binding_id TEXT,
  thread_binding_epoch INTEGER,
  peer_id TEXT,
  created_at INTEGER NOT NULL,
  updated_at INTEGER NOT NULL,
  UNIQUE(connection_id, platform_id)
);

CREATE TABLE IF NOT EXISTS contacts (
  id TEXT PRIMARY KEY,
  connection_id TEXT NOT NULL REFERENCES connections(id) ON DELETE CASCADE,
  platform_id TEXT NOT NULL,
  name TEXT,
  alias TEXT,
  access TEXT,
  is_bot INTEGER NOT NULL DEFAULT 0,
  person_id TEXT REFERENCES people(id) ON DELETE SET NULL,
  linked_by TEXT,
  profile TEXT,
  created_at INTEGER NOT NULL,
  updated_at INTEGER NOT NULL,
  UNIQUE(connection_id, platform_id)
);

CREATE TABLE IF NOT EXISTS messages (
  id TEXT PRIMARY KEY,
  connection_id TEXT NOT NULL REFERENCES connections(id) ON DELETE CASCADE,
  chat_id TEXT NOT NULL REFERENCES chats(id) ON DELETE CASCADE,
  direction TEXT NOT NULL,
  platform_msg_id TEXT,
  idempotency_key TEXT,
  sender_id TEXT,
  sender_name TEXT,
  body TEXT NOT NULL,
  attachments TEXT,
  reply_to TEXT,
  reply_to_platform_id TEXT,
  triggers INTEGER NOT NULL DEFAULT 0,
  state TEXT NOT NULL,
  t3_thread_id TEXT,
  t3_turn_id TEXT,
  leader_id TEXT,
  binding_id TEXT,
  binding_epoch INTEGER,
  pause_generation INTEGER,
  acked_at INTEGER,
  retry_at INTEGER,
  notice INTEGER NOT NULL DEFAULT 0,
  created_at INTEGER NOT NULL
);

CREATE UNIQUE INDEX IF NOT EXISTS idx_messages_conn_platform
  ON messages(connection_id, platform_msg_id)
  WHERE platform_msg_id IS NOT NULL;

CREATE UNIQUE INDEX IF NOT EXISTS idx_messages_idempotency
  ON messages(idempotency_key)
  WHERE idempotency_key IS NOT NULL;

CREATE INDEX IF NOT EXISTS idx_messages_chat_time
  ON messages(chat_id, created_at);

CREATE INDEX IF NOT EXISTS idx_messages_unacked
  ON messages(direction, triggers, state, acked_at);

CREATE TABLE IF NOT EXISTS leader_pause_generations (
  leader_id TEXT PRIMARY KEY,
  pause_generation INTEGER NOT NULL DEFAULT 0,
  paused INTEGER NOT NULL DEFAULT 0,
  pause_version INTEGER NOT NULL DEFAULT 0
);

CREATE VIRTUAL TABLE IF NOT EXISTS messages_fts USING fts5(
  msg_id UNINDEXED,
  body,
  tokenize='trigram'
);

CREATE TRIGGER IF NOT EXISTS trg_messages_fts_delete
AFTER DELETE ON messages
BEGIN
  DELETE FROM messages_fts WHERE msg_id = OLD.id;
END;
`;

export class Store {
  readonly db: DatabaseSync;
  private readonly now: () => number;
  private readonly statements = new Map<string, StatementSync>();

  constructor(path: string, now: () => number = Date.now) {
    this.now = now;
    this.db = new DatabaseSync(path);
    this.db.exec("PRAGMA journal_mode = WAL; PRAGMA foreign_keys = ON; PRAGMA busy_timeout = 5000;");
    this.migrate();
  }

  private stmt(sql: string): StatementSync {
    let compiled = this.statements.get(sql);
    if (!compiled) {
      compiled = this.db.prepare(sql);
      this.statements.set(sql, compiled);
    }
    return compiled;
  }

  close(): void {
    this.statements.clear();
    this.db.close();
  }

  private migrate(): void {
    const row = this.db.prepare("PRAGMA user_version").get() as Row;
    const version = Number(row.user_version ?? 0);
    if (version >= 9) return;
    this.db.exec("BEGIN");
    try {
      if (version < 1) {
        this.db.exec(SCHEMA_V1);
      } else {
        const connCols = (this.db.prepare("PRAGMA table_info(connections)").all() as Row[]).map((c) => String(c.name));
        if (!connCols.includes("leader_paused")) {
          this.db.exec("ALTER TABLE connections ADD COLUMN leader_paused INTEGER NOT NULL DEFAULT 0");
        }
        if (!connCols.includes("leader_id")) {
          this.db.exec("ALTER TABLE connections ADD COLUMN leader_id TEXT NOT NULL DEFAULT 'leader-default'");
        }
        if (!connCols.includes("binding_id")) {
          this.db.exec("ALTER TABLE connections ADD COLUMN binding_id TEXT");
        }
        if (!connCols.includes("binding_epoch")) {
          this.db.exec("ALTER TABLE connections ADD COLUMN binding_epoch INTEGER NOT NULL DEFAULT 1");
        }
        const chatCols = (this.db.prepare("PRAGMA table_info(chats)").all() as Row[]).map((c) => String(c.name));
        if (!chatCols.includes("thread_leader_id")) {
          this.db.exec("ALTER TABLE chats ADD COLUMN thread_leader_id TEXT");
        }
        if (!chatCols.includes("thread_binding_id")) {
          this.db.exec("ALTER TABLE chats ADD COLUMN thread_binding_id TEXT");
        }
        if (!chatCols.includes("thread_binding_epoch")) {
          this.db.exec("ALTER TABLE chats ADD COLUMN thread_binding_epoch INTEGER");
        }
        const msgCols = (this.db.prepare("PRAGMA table_info(messages)").all() as Row[]).map((c) => String(c.name));
        if (!msgCols.includes("leader_id")) {
          this.db.exec("ALTER TABLE messages ADD COLUMN leader_id TEXT");
        }
        if (!msgCols.includes("binding_id")) {
          this.db.exec("ALTER TABLE messages ADD COLUMN binding_id TEXT");
        }
        if (!msgCols.includes("binding_epoch")) {
          this.db.exec("ALTER TABLE messages ADD COLUMN binding_epoch INTEGER");
        }
        if (!msgCols.includes("pause_generation")) {
          this.db.exec("ALTER TABLE messages ADD COLUMN pause_generation INTEGER");
        }
        // S6: Backfill pre-Leader legacy inbound rows so they retain their historical
        // default-Leader epoch-1 identity even after the connection is rebound.
        this.db.exec(
          `UPDATE messages
           SET leader_id = COALESCE(leader_id, 'leader-default'),
               binding_epoch = COALESCE(binding_epoch, 1)
           WHERE direction = 'in' AND (leader_id IS NULL OR binding_epoch IS NULL)`,
        );
        // S24: Backfill already-dispatchable pre-v8 inbound rows with generation 0 so automatic
        // startup redelivery after an upgrade never upgrades their generation to a newer one.
        this.db.exec(
          `UPDATE messages
           SET pause_generation = 0
           WHERE direction = 'in' AND triggers = 1 AND state IN ('received', 'delivered') AND pause_generation IS NULL`,
        );
        // S20: Backfill existing chat thread pointers from their acknowledged message (or default
        // Leader epoch 1) so upgrading an ADR-011 DB preserves DM/thread pointers across the
        // initial default-binding sync while still clearing them on rebind to another Leader.
        this.db.exec(
          `UPDATE chats
           SET thread_leader_id = COALESCE(
                 thread_leader_id,
                 (SELECT COALESCE(m.leader_id, 'leader-default')
                  FROM messages m
                  WHERE m.chat_id = chats.id AND m.t3_thread_id = chats.thread_id
                  ORDER BY COALESCE(m.acked_at, m.created_at) DESC, m.rowid DESC
                  LIMIT 1),
                 'leader-default'
               ),
               thread_binding_id = COALESCE(
                 thread_binding_id,
                 (SELECT m.binding_id
                  FROM messages m
                  WHERE m.chat_id = chats.id AND m.t3_thread_id = chats.thread_id
                  ORDER BY COALESCE(m.acked_at, m.created_at) DESC, m.rowid DESC
                  LIMIT 1)
               ),
               thread_binding_epoch = COALESCE(
                 thread_binding_epoch,
                 (SELECT COALESCE(m.binding_epoch, 1)
                  FROM messages m
                  WHERE m.chat_id = chats.id AND m.t3_thread_id = chats.thread_id
                  ORDER BY COALESCE(m.acked_at, m.created_at) DESC, m.rowid DESC
                  LIMIT 1),
                 1
               )
           WHERE thread_id IS NOT NULL
             AND (thread_leader_id IS NULL OR thread_binding_epoch IS NULL)`,
        );
        // S23/S25: Track per-Leader pause generations & pause flags in the bridge so emitted
        // dispatches stamp the exact generation observed at emit time and newly onboarded
        // connections inherit default Leader pause state immediately.
        this.db.exec(
          `CREATE TABLE IF NOT EXISTS leader_pause_generations (
            leader_id TEXT PRIMARY KEY,
            pause_generation INTEGER NOT NULL DEFAULT 0,
            paused INTEGER NOT NULL DEFAULT 0,
            pause_version INTEGER NOT NULL DEFAULT 0
          )`,
        );
        const lpgCols = (this.db.prepare("PRAGMA table_info(leader_pause_generations)").all() as Row[]).map((c) =>
          String(c.name),
        );
        if (!lpgCols.includes("paused")) {
          this.db.exec("ALTER TABLE leader_pause_generations ADD COLUMN paused INTEGER NOT NULL DEFAULT 0");
        }
        if (!lpgCols.includes("pause_version")) {
          this.db.exec("ALTER TABLE leader_pause_generations ADD COLUMN pause_version INTEGER NOT NULL DEFAULT 0");
        }
      }
      this.db.exec("PRAGMA user_version = 9");
      this.db.exec("COMMIT");
    } catch (error) {
      this.db.exec("ROLLBACK");
      throw error;
    }
  }

  private mint(table: string, prefix: string, length: number): string {
    for (let i = 0; i < 20; i++) {
      const id = shortId(prefix, length);
      if (!this.db.prepare(`SELECT 1 FROM ${table} WHERE id = ?`).get(id)) return id;
    }
    return shortId(prefix, length + 3);
  }

  private mintFileId(): string {
    for (let i = 0; i < 20; i++) {
      const id = shortId("f", 4);
      if (!this.db.prepare("SELECT 1 FROM messages WHERE attachments LIKE ?").get(`%"id":"${id}"%`)) return id;
    }
    return shortId("f", 7);
  }

  private indexMessageInFts(msgId: string, body: string): void {
    if (!body) return;
    this.stmt("DELETE FROM messages_fts WHERE msg_id = ?").run(msgId);
    this.stmt("INSERT INTO messages_fts (msg_id, body) VALUES (?, ?)").run(msgId, body);
  }

  private removeChatFromFts(chatId: string): void {
    this.stmt("DELETE FROM messages_fts WHERE msg_id IN (SELECT id FROM messages WHERE chat_id = ?)").run(chatId);
  }

  private removeContactFromFts(connectionId: string, platformUserId: string): void {
    this.stmt(
      "DELETE FROM messages_fts WHERE msg_id IN (SELECT id FROM messages WHERE connection_id = ? AND direction = 'in' AND sender_id = ?)",
    ).run(connectionId, platformUserId);
  }

  // ---------------------------------------------------------------- connections

  createConnection(input: {
    readonly platform: Platform;
    readonly secretRef: string | null;
    readonly botId?: string | null;
    readonly botName?: string | null;
    readonly lifecycleState?: LifecycleState;
    readonly ownerId?: string | null;
    readonly claimCode?: string | null;
    readonly claimExpiresAt?: number | null;
    readonly askAll?: boolean;
    readonly leaderPaused?: boolean;
  }): Connection {
    const id = this.mint("connections", "n", 6);
    const t = this.now();
    const lifecycleState = input.lifecycleState ?? (input.ownerId ? "active" : "idle");
    const state: StoredLinkState = lifecycleState === "idle" ? "idle" : "reconnecting";
    // S25: Initialize new connections from the persisted default Leader pause flag so connections
    // onboarded during Pause never emit unpaused dispatches before T3 reconciles the binding!
    const leaderPaused = input.leaderPaused ?? this.getLeaderPaused("leader-default");
    this.db
      .prepare(
        `INSERT INTO connections
          (id, platform, bot_id, bot_name, lifecycle_state, state, leader_paused, secret_ref, owner_id, claim_code, claim_expires_at, claim_attempts, ask_all, created_at, updated_at)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 0, ?, ?, ?)`,
      )
      .run(
        id,
        input.platform,
        input.botId ?? null,
        input.botName ?? null,
        lifecycleState,
        state,
        leaderPaused ? 1 : 0,
        input.secretRef,
        input.ownerId ?? null,
        input.claimCode ?? null,
        input.claimExpiresAt ?? null,
        input.askAll ? 1 : 0,
        t,
        t,
      );
    return this.connection(id) as Connection;
  }

  connection(id: string): Connection | undefined {
    const row = this.stmt("SELECT * FROM connections WHERE id = ?").get(id) as Row | undefined;
    return row && toConnection(row);
  }

  connections(): Connection[] {
    return (this.stmt("SELECT * FROM connections ORDER BY created_at ASC").all() as Row[]).map(toConnection);
  }

  updateConnection(
    id: string,
    patch: Partial<{
      botId: string | null;
      botName: string | null;
      lifecycleState: LifecycleState;
      state: StoredLinkState;
      stateDetail: string | null;
      paused: boolean;
      leaderPaused: boolean;
      leaderId: string;
      bindingId: string | null;
      bindingEpoch: number;
      secretRef: string | null;
      ownerId: string | null;
      claimCode: string | null;
      claimExpiresAt: number | null;
      claimAttempts: number;
      askAll: boolean;
      cursorJson: string | null;
    }>,
  ): Connection | undefined {
    const map: Record<string, string> = {
      botId: "bot_id",
      botName: "bot_name",
      lifecycleState: "lifecycle_state",
      state: "state",
      stateDetail: "state_detail",
      paused: "paused",
      leaderPaused: "leader_paused",
      leaderId: "leader_id",
      bindingId: "binding_id",
      bindingEpoch: "binding_epoch",
      secretRef: "secret_ref",
      ownerId: "owner_id",
      claimCode: "claim_code",
      claimExpiresAt: "claim_expires_at",
      claimAttempts: "claim_attempts",
      askAll: "ask_all",
      cursorJson: "cursor_json",
    };
    const entries = Object.entries(patch).filter(([, v]) => v !== undefined);
    if (!entries.length) return this.connection(id);
    const sets = entries.map(([k]) => `${map[k]} = ?`).join(", ");
    const values: SQLInputValue[] = entries.map(([k, v]) => {
      if (k === "paused" || k === "leaderPaused" || k === "askAll") return v ? 1 : 0;
      return v as SQLInputValue;
    });
    this.db.prepare(`UPDATE connections SET ${sets}, updated_at = ? WHERE id = ?`).run(...values, this.now(), id);
    return this.connection(id);
  }

  setConnectionCursor(id: string, cursor: string | null): void {
    const json = cursor === null ? null : JSON.stringify({ cursor });
    this.stmt("UPDATE connections SET cursor_json = ?, updated_at = ? WHERE id = ?").run(json, this.now(), id);
  }

  getConnectionCursor(id: string): string | undefined {
    const conn = this.connection(id);
    if (!conn?.cursorJson) return undefined;
    try {
      const parsed = JSON.parse(conn.cursorJson) as { cursor?: unknown };
      return typeof parsed.cursor === "string" ? parsed.cursor : undefined;
    } catch {
      return undefined;
    }
  }

  deleteConnection(id: string): void {
    this.db.exec("BEGIN");
    try {
      this.db
        .prepare("DELETE FROM messages_fts WHERE msg_id IN (SELECT id FROM messages WHERE connection_id = ?)")
        .run(id);
      this.db.prepare("DELETE FROM connections WHERE id = ?").run(id);
      this.db.exec("COMMIT");
    } catch (error) {
      this.db.exec("ROLLBACK");
      throw error;
    }
  }

  // ---------------------------------------------------------------------- chats

  upsertChat(input: {
    readonly connectionId: string;
    readonly platformId: string;
    readonly kind: ChatKind;
    readonly name?: string;
    readonly parentId?: string;
    readonly followUp?: boolean;
    readonly peerId?: string;
  }): Chat {
    const existing = this.stmt("SELECT * FROM chats WHERE connection_id = ? AND platform_id = ?").get(
      input.connectionId,
      input.platformId,
    ) as Row | undefined;
    const t = this.now();
    if (existing) {
      const id = String(existing.id);
      if (input.name && input.name !== existing.name) {
        this.stmt("UPDATE chats SET name = ?, updated_at = ? WHERE id = ?").run(input.name, t, id);
      }
      if (input.parentId && input.parentId !== existing.parent_id) {
        this.stmt("UPDATE chats SET parent_id = ?, updated_at = ? WHERE id = ?").run(input.parentId, t, id);
      }
      if (input.followUp && existing.follow_up !== 1) {
        this.stmt("UPDATE chats SET follow_up = 1, updated_at = ? WHERE id = ?").run(t, id);
      }
      if (input.peerId && !existing.peer_id) {
        this.stmt("UPDATE chats SET peer_id = ?, updated_at = ? WHERE id = ?").run(input.peerId, t, id);
      }
      return this.chat(id) as Chat;
    }
    const id = this.mint("chats", "c", 4);
    this.db
      .prepare(
        `INSERT INTO chats (id, connection_id, platform_id, kind, name, parent_id, follow_up, peer_id, created_at, updated_at)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      )
      .run(
        id,
        input.connectionId,
        input.platformId,
        input.kind,
        input.name ?? null,
        input.parentId ?? null,
        input.followUp ? 1 : 0,
        input.peerId ?? null,
        t,
        t,
      );
    return this.chat(id) as Chat;
  }

  chat(id: string): Chat | undefined {
    const row = this.stmt("SELECT * FROM chats WHERE id = ?").get(id) as Row | undefined;
    return row && toChat(row);
  }

  chatByPlatformId(connectionId: string, platformId: string): Chat | undefined {
    const row = this.stmt("SELECT * FROM chats WHERE connection_id = ? AND platform_id = ?").get(
      connectionId,
      platformId,
    ) as Row | undefined;
    return row && toChat(row);
  }

  chats(connectionId?: string): Chat[] {
    const rows = connectionId
      ? (this.stmt("SELECT * FROM chats WHERE connection_id = ? ORDER BY updated_at DESC").all(connectionId) as Row[])
      : (this.stmt("SELECT * FROM chats ORDER BY updated_at DESC").all() as Row[]);
    return rows.map(toChat);
  }

  setChatAccess(id: string, access: Access): Chat | undefined {
    const chat = this.chat(id);
    if (!chat) return undefined;
    this.stmt("UPDATE chats SET access = ?, updated_at = ? WHERE id = ?").run(access, this.now(), id);
    if (access === "blocked") {
      this.removeChatFromFts(id);
      // Also purge child threads of this group from FTS5.
      const children = this.stmt("SELECT id FROM chats WHERE parent_id = ?").all(id) as Row[];
      for (const child of children) this.removeChatFromFts(String(child.id));
    }
    return this.chat(id);
  }

  setChatThreadId(
    id: string,
    threadId: string | null,
    binding?: { readonly leaderId: string; readonly bindingId: string | null; readonly bindingEpoch: number },
  ): void {
    this.stmt(
      `UPDATE chats
       SET thread_id = ?, thread_leader_id = ?, thread_binding_id = ?, thread_binding_epoch = ?, updated_at = ?
       WHERE id = ?`,
    ).run(
      threadId,
      threadId === null ? null : (binding?.leaderId ?? null),
      threadId === null ? null : (binding?.bindingId ?? null),
      threadId === null ? null : (binding?.bindingEpoch ?? null),
      this.now(),
      id,
    );
  }

  /** Clear cached chat thread pointers on a connection that no longer match the active binding (S19/S20). */
  clearStaleChatThreadPointers(
    connectionId: string,
    binding: { readonly leaderId: string; readonly bindingId: string | null; readonly bindingEpoch: number },
  ): void {
    const now = this.now();
    this.stmt(
      `UPDATE chats
       SET thread_id = NULL, thread_leader_id = NULL, thread_binding_id = NULL, thread_binding_epoch = NULL, updated_at = ?
       WHERE connection_id = ?
         AND thread_id IS NOT NULL
         AND (
           thread_leader_id IS NOT ?
           OR thread_binding_epoch IS NOT ?
           OR (thread_binding_id IS NOT NULL AND ? IS NOT NULL AND thread_binding_id != ?)
         )`,
    ).run(now, connectionId, binding.leaderId, binding.bindingEpoch, binding.bindingId, binding.bindingId);
    // S20: Stamp the initial concrete bindingId onto preserved pre-sync pointers whose leaderId+epoch match.
    if (binding.bindingId !== null) {
      this.stmt(
        `UPDATE chats
         SET thread_binding_id = ?, updated_at = ?
         WHERE connection_id = ?
           AND thread_id IS NOT NULL
           AND thread_leader_id = ?
           AND thread_binding_epoch = ?
           AND thread_binding_id IS NULL`,
      ).run(binding.bindingId, now, connectionId, binding.leaderId, binding.bindingEpoch);
    }
  }

  /** Whether this chat or its parent group is explicitly blocked. */
  isChatBlocked(id: string): boolean {
    const chat = this.chat(id);
    if (!chat) return false;
    if (chat.access === "blocked") return true;
    if (chat.parentId) {
      const parent = this.chat(chat.parentId);
      if (parent?.access === "blocked") return true;
    }
    return false;
  }

  // ------------------------------------------------------------------- contacts

  touchContact(
    connectionId: string,
    platformId: string,
    name: string | null | undefined,
    isBot = false,
  ): Contact {
    const reported = name?.trim() && name.trim() !== platformId ? name.trim() : null;
    const existing = this.contactByPlatformId(connectionId, platformId);
    const t = this.now();
    if (existing) {
      if (reported && reported !== existing.name) {
        this.stmt("UPDATE contacts SET name = ?, updated_at = ? WHERE id = ?").run(reported, t, existing.id);
      }
      if (isBot && !existing.isBot) {
        this.stmt("UPDATE contacts SET is_bot = 1, updated_at = ? WHERE id = ?").run(t, existing.id);
      }
      return this.contact(existing.id) as Contact;
    }
    const id = this.mint("contacts", "u", 4);
    this.db
      .prepare(
        `INSERT INTO contacts (id, connection_id, platform_id, name, alias, is_bot, created_at, updated_at)
         VALUES (?, ?, ?, ?, NULL, ?, ?, ?)`,
      )
      .run(id, connectionId, platformId, reported, isBot ? 1 : 0, t, t);
    return this.contact(id) as Contact;
  }

  contact(id: string): Contact | undefined {
    const row = this.stmt(`${CONTACTS_SELECT} WHERE k.id = ?`).get(id) as Row | undefined;
    return row && toContact(row);
  }

  contactByPlatformId(connectionId: string, platformId: string): Contact | undefined {
    const row = this.stmt(`${CONTACTS_SELECT} WHERE k.connection_id = ? AND k.platform_id = ?`).get(
      connectionId,
      platformId,
    ) as Row | undefined;
    return row && toContact(row);
  }

  contacts(connectionId?: string): (Contact & { readonly platform: Platform; readonly isOwner: boolean })[] {
    const sql = connectionId
      ? `SELECT k.*, p.name AS person_name, n.platform,
                (n.owner_id IS NOT NULL AND n.owner_id = k.platform_id) AS is_owner
         FROM contacts k JOIN connections n ON n.id = k.connection_id
         LEFT JOIN people p ON p.id = k.person_id
         WHERE k.connection_id = ? ORDER BY k.updated_at DESC`
      : `SELECT k.*, p.name AS person_name, n.platform,
                (n.owner_id IS NOT NULL AND n.owner_id = k.platform_id) AS is_owner
         FROM contacts k JOIN connections n ON n.id = k.connection_id
         LEFT JOIN people p ON p.id = k.person_id
         ORDER BY k.updated_at DESC`;
    const rows = (connectionId ? this.db.prepare(sql).all(connectionId) : this.db.prepare(sql).all()) as Row[];
    return rows.map((r) => ({
      ...toContact(r),
      platform: String(r.platform) as Platform,
      isOwner: Number(r.is_owner) === 1,
    }));
  }

  isOwnerContact(contactId: string): boolean {
    const row = this.stmt(
      `SELECT 1 FROM contacts k JOIN connections n ON n.id = k.connection_id
       WHERE k.id = ? AND n.owner_id IS NOT NULL AND n.owner_id = k.platform_id`,
    ).get(contactId);
    return row !== undefined;
  }

  personHasOwnerContact(personId: string): boolean {
    const row = this.stmt(
      `SELECT 1 FROM contacts k JOIN connections n ON n.id = k.connection_id
       WHERE k.person_id = ? AND n.owner_id IS NOT NULL AND n.owner_id = k.platform_id`,
    ).get(personId);
    return row !== undefined;
  }

  setContactAccess(id: string, access: Access): Contact | undefined {
    const contact = this.contact(id);
    if (!contact) return undefined;
    this.stmt("UPDATE contacts SET access = ?, updated_at = ? WHERE id = ?").run(access, this.now(), id);
    if (access === "blocked") {
      this.removeContactFromFts(contact.connectionId, contact.platformId);
    }
    return this.contact(id);
  }

  setContactAlias(id: string, alias: string | null): Contact | undefined {
    this.stmt("UPDATE contacts SET alias = ?, updated_at = ? WHERE id = ?").run(alias, this.now(), id);
    return this.contact(id);
  }

  nameContact(id: string, name: string | null): Contact | undefined {
    const contact = this.contact(id);
    if (!contact) return undefined;
    if (contact.personId) this.updatePerson(contact.personId, { name });
    else this.setContactAlias(id, name);
    return this.contact(id);
  }

  // --------------------------------------------------------------------- people

  person(id: string): Person | undefined {
    const row = this.stmt("SELECT * FROM people WHERE id = ?").get(id) as Row | undefined;
    return row && toPerson(row);
  }

  people(): Person[] {
    return (this.stmt("SELECT * FROM people ORDER BY id ASC").all() as Row[]).map(toPerson);
  }

  personContacts(personId: string): Contact[] {
    return (this.stmt(`${CONTACTS_SELECT} WHERE k.person_id = ? ORDER BY k.created_at ASC`).all(personId) as Row[]).map(
      toContact,
    );
  }

  updatePerson(id: string, patch: { readonly name?: string | null; readonly note?: string | null }): Person | undefined {
    if (patch.note !== undefined && patch.note !== null) {
      const bytes = Buffer.byteLength(patch.note, "utf8");
      if (bytes > MAX_PERSON_NOTE_BYTES) {
        throw new Error(`Person note exceeds ${MAX_PERSON_NOTE_BYTES} bytes limit (${bytes} bytes)`);
      }
    }
    const t = this.now();
    if (patch.name !== undefined) {
      this.stmt("UPDATE people SET name = ?, updated_at = ? WHERE id = ?").run(patch.name, t, id);
    }
    if (patch.note !== undefined) {
      this.stmt("UPDATE people SET note = ?, updated_at = ? WHERE id = ?").run(patch.note, t, id);
    }
    return this.person(id);
  }

  ensurePerson(contactId: string): Person {
    const contact = this.contact(contactId);
    if (!contact) throw new Error(`Contact not found: ${contactId}`);
    if (contact.personId) return this.person(contact.personId) as Person;
    const id = this.mint("people", "p", 4);
    const t = this.now();
    this.db
      .prepare("INSERT INTO people (id, name, note, created_at, updated_at) VALUES (?, ?, NULL, ?, ?)")
      .run(id, contact.alias ?? null, t, t);
    this.stmt("UPDATE contacts SET person_id = ?, linked_by = NULL, updated_at = ? WHERE id = ?").run(id, t, contactId);
    return this.person(id) as Person;
  }

  /**
   * Link multiple contacts into one `Person`.
   *
   * ADR-011 security invariants:
   * - `by === "agent"` MUST NOT touch any owner contact or merge into any person containing an owner contact.
   * - Linking NEVER copies or elevates `contacts.access` (permissions are never transferred across contacts).
   */
  linkContacts(ids: readonly string[], by: LinkedBy): Person {
    const uniqueIds = [...new Set(ids)];
    if (uniqueIds.length < 2) {
      throw new Error("At least two distinct contacts are required to link");
    }
    const resolved: Contact[] = uniqueIds.map((id) => {
      const k = this.contact(id);
      if (!k) throw new Error(`Contact not found: ${id}`);
      return k;
    });

    if (by === "agent") {
      for (const k of resolved) {
        if (this.isOwnerContact(k.id)) {
          throw new Error(`Agent is forbidden from linking owner contact "${k.id}"`);
        }
        if (k.personId && this.personHasOwnerContact(k.personId)) {
          throw new Error(`Agent is forbidden from linking into person "${k.personId}" containing an owner contact`);
        }
      }
    }

    this.db.exec("BEGIN");
    try {
      const first = resolved.find((k) => k.personId) ?? resolved[0]!;
      const target = this.ensurePerson(first.id);
      let { name, note } = target;
      const t = this.now();

      for (const item of resolved) {
        const current = this.contact(item.id)!;
        if (current.personId && current.personId !== target.id) {
          const other = this.person(current.personId)!;
          name = name ?? other.name;
          const mergedNote = [note, other.note].filter(Boolean).join("\n\n") || null;
          if (mergedNote && Buffer.byteLength(mergedNote, "utf8") > MAX_PERSON_NOTE_BYTES) {
            throw new Error(`Merged person note exceeds ${MAX_PERSON_NOTE_BYTES} bytes limit`);
          }
          note = mergedNote;
          this.db
            .prepare(
              `UPDATE contacts SET person_id = ?, updated_at = ?${by === "agent" ? ", linked_by = COALESCE(linked_by, 'agent')" : ""} WHERE person_id = ?`,
            )
            .run(target.id, t, other.id);
          this.db.prepare("DELETE FROM people WHERE id = ?").run(other.id);
        } else if (!current.personId) {
          name = name ?? current.alias;
        }
        // Notice: `access` column is NEVER touched here.
        this.db
          .prepare(
            `UPDATE contacts SET person_id = ?, linked_by = ${by === "agent" ? "COALESCE(linked_by, 'agent')" : "'owner'"}, updated_at = ? WHERE id = ?`,
          )
          .run(target.id, t, item.id);
      }
      this.db.prepare("UPDATE people SET name = ?, note = ?, updated_at = ? WHERE id = ?").run(name, note, t, target.id);
      this.db.exec("COMMIT");
      return this.person(target.id) as Person;
    } catch (error) {
      this.db.exec("ROLLBACK");
      throw error;
    }
  }

  unlinkContact(id: string, by: LinkedBy = "owner"): void {
    const contact = this.contact(id);
    if (!contact?.personId) return;
    if (by === "agent") {
      if (this.isOwnerContact(id) || contact.linkedBy === "owner" || this.personHasOwnerContact(contact.personId)) {
        throw new Error(`Agent is forbidden from unlinking owner contact or owner-created link "${id}"`);
      }
    }
    const t = this.now();
    this.stmt("UPDATE contacts SET person_id = NULL, linked_by = NULL, updated_at = ? WHERE id = ?").run(t, id);
    const left = this.personContacts(contact.personId);
    if (left.length === 0) {
      this.stmt("DELETE FROM people WHERE id = ?").run(contact.personId);
    } else if (left.length === 1) {
      this.stmt("UPDATE contacts SET linked_by = NULL WHERE id = ?").run(left[0]!.id);
    }
  }

  // ------------------------------------------------------------------- messages

  /**
   * Gate, deduplicate, and persist a batch of inbound messages + optional poll cursor ATOMICALLY
   * in a single SQLite transaction (ADR-011 S5/S6).
   */
  persistInboundBatch(
    connectionId: string,
    trust: Trust,
    batch: { readonly messages: readonly InboundMessage[]; readonly nextCursor?: string },
  ): PersistBatchResult {
    this.db.exec("BEGIN IMMEDIATE");
    try {
      const outcomes: IngestOutcome[] = [];
      for (const msg of batch.messages) {
        outcomes.push(this.ingestOneInTxn(connectionId, trust, msg));
      }
      let cursorUpdated = false;
      if (batch.nextCursor !== undefined) {
        this.setConnectionCursor(connectionId, batch.nextCursor);
        cursorUpdated = true;
      }
      this.db.exec("COMMIT");
      return { outcomes, cursorUpdated };
    } catch (error) {
      this.db.exec("ROLLBACK");
      throw error;
    }
  }

  /** Convenience single-message wrapper around atomic transaction persistence. */
  ingestInbound(connectionId: string, trust: Trust, msg: InboundMessage): IngestOutcome {
    return this.persistInboundBatch(connectionId, trust, { messages: [msg] }).outcomes[0]!;
  }

  private ingestOneInTxn(connectionId: string, trust: Trust, msg: InboundMessage): IngestOutcome {
    const conn = this.connection(connectionId);
    if (!conn) throw new Error(`Connection not found: ${connectionId}`);

    // Deduplicate on (connection_id, platform_msg_id)
    const existingMsg = this.stmt(
      "SELECT 1 FROM messages WHERE connection_id = ? AND platform_msg_id = ?",
    ).get(connectionId, msg.platformId);
    if (existingMsg) {
      return { kind: "duplicate", platformMsgId: msg.platformId };
    }

    // 1. idle: drop silently, zero storage
    if (conn.lifecycleState === "idle") {
      return { kind: "ignored_idle" };
    }

    // 2. pairing: ONLY accept valid 6-digit claim DM; NEVER wake T3, NEVER store background/held
    if (conn.lifecycleState === "pairing") {
      const decision = evaluatePairingClaim({
        chatKind: msg.chat.kind,
        text: msg.text,
        expectedCode: conn.claimCode,
        expiresAt: conn.claimExpiresAt,
        attempts: conn.claimAttempts,
        now: this.now(),
      });
      if (decision.kind === "claimed") {
        this.updateConnection(connectionId, {
          ownerId: msg.sender.id,
          lifecycleState: "active",
          claimCode: null,
          claimExpiresAt: null,
          claimAttempts: 0,
        });
        const contact = this.touchContact(connectionId, msg.sender.id, msg.sender.name, msg.sender.isBot);
        this.setContactAccess(contact.id, "allowed");
        const chat = this.upsertChat({
          connectionId,
          platformId: msg.chat.platformId,
          kind: "dm",
          name: msg.chat.name,
          peerId: msg.sender.id,
        });
        return { kind: "pairing_claimed", ownerId: msg.sender.id, chat, contact: this.contact(contact.id)! };
      }
      if (decision.kind === "wrong_code") {
        this.updateConnection(connectionId, {
          claimAttempts: decision.attempts,
          ...(decision.exhausted ? { claimCode: null, claimExpiresAt: null } : {}),
        });
      }
      return { kind: "pairing_rejected", decision };
    }

    // 3. active: compute gate verdict BEFORE storing background or creating FTS entries!
    const isOwner = Boolean(conn.ownerId && msg.sender.id === conn.ownerId);
    const existingContact = this.contactByPlatformId(connectionId, msg.sender.id);
    const existingChat = this.chatByPlatformId(connectionId, msg.chat.platformId);
    const existingParent = msg.chat.parent
      ? this.chatByPlatformId(connectionId, msg.chat.parent.platformId)
      : existingChat?.parentId
        ? this.chat(existingChat.parentId)
        : undefined;
    const groupAccess: Access = msg.chat.kind === "thread"
      ? (existingParent?.access ?? existingChat?.access ?? null)
      : (existingChat?.access ?? null);

    const verdict = gate({
      lifecycleState: conn.lifecycleState,
      trust,
      askAll: conn.askAll,
      isOwner,
      chatKind: msg.chat.kind,
      contact: existingContact?.access ?? null,
      group: groupAccess,
    });

    // Determine whether this message triggers the assistant
    const isTrigger = this.shouldTrigger(msg, existingChat);

    // Gate verdict: DROP -> blocked; never store body in background or FTS5!
    if (verdict === "drop") {
      const chat = existingChat ?? this.upsertChat({
        connectionId,
        platformId: msg.chat.platformId,
        kind: msg.chat.kind,
        name: msg.chat.name,
        peerId: msg.chat.kind === "dm" ? msg.sender.id : undefined,
      });
      const id = this.mint("messages", "m", 5);
      // Dedup tombstone only: empty body, blocked state, NEVER indexed in FTS5!
      this.db
        .prepare(
          `INSERT INTO messages
            (id, connection_id, chat_id, direction, platform_msg_id, idempotency_key, sender_id, sender_name, body, attachments, reply_to, reply_to_platform_id, triggers, state, created_at)
           VALUES (?, ?, ?, 'in', ?, NULL, ?, NULL, '', NULL, NULL, NULL, 0, 'blocked', ?)`,
        )
        .run(id, connectionId, chat.id, msg.platformId, msg.sender.id, msg.sentAt);
      return { kind: "blocked", platformMsgId: msg.platformId };
    }

    // Gate verdict: ASK -> unapproved sender/group; ONLY persist trigger messages as `held` (never background, never FTS5!)
    if (verdict === "ask") {
      if (!isTrigger) {
        return { kind: "unapproved_background_dropped", platformMsgId: msg.platformId };
      }
      const { chat, contact } = this.ensureChatAndContact(connectionId, msg);
      const id = this.mint("messages", "m", 5);
      const attachments = msg.attachments.map((a) => ({
        id: this.mintFileId(),
        ref: a.id,
        name: a.name,
        ...(a.size !== undefined ? { size: a.size } : {}),
        ...(a.mime !== undefined ? { mime: a.mime } : {}),
      }));
      const replyTarget = msg.replyTo ? this.messageByPlatformId(connectionId, msg.replyTo) : undefined;
      this.db
        .prepare(
          `INSERT INTO messages
            (id, connection_id, chat_id, direction, platform_msg_id, idempotency_key, sender_id, sender_name, body, attachments, reply_to, reply_to_platform_id, triggers, state, leader_id, binding_id, binding_epoch, created_at)
           VALUES (?, ?, ?, 'in', ?, ?, ?, ?, ?, ?, ?, ?, 1, 'held', ?, ?, ?, ?)`,
        )
        .run(
          id,
          connectionId,
          chat.id,
          msg.platformId,
          makeIdempotencyKey(connectionId, msg.platformId),
          msg.sender.id,
          msg.sender.name || null,
          msg.text,
          attachments.length ? JSON.stringify(attachments) : null,
          replyTarget?.id ?? null,
          msg.replyTo ?? null,
          conn.leaderId,
          conn.bindingId,
          conn.bindingEpoch,
          msg.sentAt,
        );
      // NOTE: Deliberately NOT indexed in messages_fts while held!
      return { kind: "held", message: this.message(id)!, chat, contact };
    }

    // Gate verdict: DELIVER (allowed chat/contact)
    const { chat, contact } = this.ensureChatAndContact(connectionId, msg);
    const id = this.mint("messages", "m", 5);
    const attachments = msg.attachments.map((a) => ({
      id: this.mintFileId(),
      ref: a.id,
      name: a.name,
      ...(a.size !== undefined ? { size: a.size } : {}),
      ...(a.mime !== undefined ? { mime: a.mime } : {}),
    }));
    const replyTarget = msg.replyTo ? this.messageByPlatformId(connectionId, msg.replyTo) : undefined;

    // Verified owner `/stop` command (the ONLY IM command, ADR-011 §4)
    if (isTrigger && isOwner && msg.text.trim() === "/stop") {
      this.db
        .prepare(
          `INSERT INTO messages
            (id, connection_id, chat_id, direction, platform_msg_id, idempotency_key, sender_id, sender_name, body, attachments, reply_to, reply_to_platform_id, triggers, state, leader_id, binding_id, binding_epoch, acked_at, created_at)
           VALUES (?, ?, ?, 'in', ?, ?, ?, ?, ?, ?, ?, ?, 1, 'replied', ?, ?, ?, ?, ?)`,
        )
        .run(
          id,
          connectionId,
          chat.id,
          msg.platformId,
          makeIdempotencyKey(connectionId, msg.platformId),
          msg.sender.id,
          msg.sender.name || null,
          msg.text,
          attachments.length ? JSON.stringify(attachments) : null,
          replyTarget?.id ?? null,
          msg.replyTo ?? null,
          conn.leaderId,
          conn.bindingId,
          conn.bindingEpoch,
          this.now(),
          msg.sentAt,
        );
      return { kind: "stop", message: this.message(id)!, chat, contact };
    }

    const deferredByPause = isTrigger && (conn.leaderPaused || this.getLeaderPaused(conn.leaderId));
    const state: InboundState = !isTrigger ? "ignored" : deferredByPause ? "paused_pending" : "received";
    const idempotencyKey = isTrigger ? makeIdempotencyKey(connectionId, msg.platformId) : null;
    // S24: Persist the Leader's observed pause_generation the moment the message first becomes
    // dispatchable (`state === 'received'`) so automatic startup redelivery reuses it unchanged!
    const initialPauseGeneration = state === "received" ? this.getLeaderPauseGeneration(conn.leaderId) : null;
    this.db
      .prepare(
        `INSERT INTO messages
          (id, connection_id, chat_id, direction, platform_msg_id, idempotency_key, sender_id, sender_name, body, attachments, reply_to, reply_to_platform_id, triggers, state, leader_id, binding_id, binding_epoch, pause_generation, created_at)
         VALUES (?, ?, ?, 'in', ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      )
      .run(
        id,
        connectionId,
        chat.id,
        msg.platformId,
        idempotencyKey,
        msg.sender.id,
        msg.sender.name || null,
        msg.text,
        attachments.length ? JSON.stringify(attachments) : null,
        replyTarget?.id ?? null,
        msg.replyTo ?? null,
        isTrigger ? 1 : 0,
        state,
        conn.leaderId,
        conn.bindingId,
        conn.bindingEpoch,
        initialPauseGeneration,
        msg.sentAt,
      );
    // Allowed chat message -> index into FTS5 `trigram`!
    this.indexMessageInFts(id, msg.text);
    const saved = this.message(id)!;
    if (!isTrigger) return { kind: "background", message: saved, chat, contact };
    return deferredByPause
      ? { kind: "paused_pending", message: saved, chat, contact }
      : { kind: "dispatch", message: saved, chat, contact };
  }

  private shouldTrigger(msg: InboundMessage, existingChat: Chat | undefined): boolean {
    if (msg.earlier) return false;
    if (msg.chat.kind === "dm") return true;
    if (msg.addressedToBot) {
      if (msg.sender.isBot && msg.mentioned === false) return false;
      return true;
    }
    if (msg.chat.kind === "thread" && (msg.chat.followUp || existingChat?.followUp) && existingChat) {
      return this.hasSpokenInChat(existingChat.id);
    }
    return false;
  }

  private hasSpokenInChat(chatId: string): boolean {
    const row = this.stmt(
      "SELECT 1 FROM messages WHERE chat_id = ? AND direction = 'out' AND notice = 0 AND state IN ('sent', 'uncertain') LIMIT 1",
    ).get(chatId);
    return row !== undefined;
  }

  private ensureChatAndContact(connectionId: string, msg: InboundMessage): { chat: Chat; contact: Contact } {
    let parentId: string | undefined;
    if (msg.chat.parent) {
      const parent = this.upsertChat({
        connectionId,
        platformId: msg.chat.parent.platformId,
        kind: "group",
        name: msg.chat.parent.name,
      });
      parentId = parent.id;
    }
    const chat = this.upsertChat({
      connectionId,
      platformId: msg.chat.platformId,
      kind: msg.chat.kind,
      name: msg.chat.name,
      parentId,
      followUp: msg.chat.followUp,
      peerId: msg.chat.kind === "dm" ? msg.sender.id : undefined,
    });
    const contact = this.touchContact(connectionId, msg.sender.id, msg.sender.name, msg.sender.isBot);
    for (const mentioned of msg.mentions ?? []) {
      this.touchContact(connectionId, mentioned.id, mentioned.name, mentioned.isBot);
    }
    return { chat, contact };
  }

  /** Look up an outbound message previously recorded under an idempotent operationKey (S17). */
  findOutboundByOperationKey(operationKey: string): Message | undefined {
    const namespaced = `out:${operationKey}`;
    const row = this.stmt("SELECT * FROM messages WHERE direction = 'out' AND idempotency_key = ?").get(namespaced) as Row | undefined;
    return row ? toMessage(row) : undefined;
  }

  /** Reset a previously failed outbound operation row to pending before retrying under the same operationKey (S17). */
  resetOutboundForRetry(id: string, body: string, attachments?: readonly Omit<Attachment, "id">[]): Message {
    const nextAttachments = (attachments ?? []).map((a) => ({ ...a, id: this.mintFileId() }));
    this.stmt("UPDATE messages SET state = 'pending', body = ?, attachments = ? WHERE id = ? AND direction = 'out'").run(
      body,
      nextAttachments.length ? JSON.stringify(nextAttachments) : null,
      id,
    );
    const updated = this.message(id) as Message;
    const chat = this.chat(updated.chatId);
    if (chat && chat.access !== "blocked") {
      this.indexMessageInFts(id, body);
    }
    return updated;
  }

  insertOutbound(input: {
    readonly connectionId: string;
    readonly chatId: string;
    readonly body: string;
    readonly replyTo?: string | null;
    readonly operationKey?: string | null;
    readonly notice?: boolean;
    readonly attachments?: readonly Omit<Attachment, "id">[];
  }): Message {
    const id = this.mint("messages", "m", 5);
    const attachments = (input.attachments ?? []).map((a) => ({ ...a, id: this.mintFileId() }));
    const idempotencyKey = input.operationKey ? `out:${input.operationKey}` : null;
    this.db
      .prepare(
        `INSERT INTO messages
          (id, connection_id, chat_id, direction, idempotency_key, body, attachments, reply_to, triggers, state, notice, created_at)
         VALUES (?, ?, ?, 'out', ?, ?, ?, ?, 0, 'pending', ?, ?)`,
      )
      .run(
        id,
        input.connectionId,
        input.chatId,
        idempotencyKey,
        input.body,
        attachments.length ? JSON.stringify(attachments) : null,
        input.replyTo ?? null,
        input.notice ? 1 : 0,
        this.now(),
      );
    const chat = this.chat(input.chatId);
    if (chat && chat.access !== "blocked") {
      this.indexMessageInFts(id, input.body);
    }
    return this.message(id) as Message;
  }

  setOutboundResult(id: string, state: OutboundState, platformMsgId: string | null): void {
    try {
      this.stmt("UPDATE messages SET state = ?, platform_msg_id = ? WHERE id = ?").run(state, platformMsgId, id);
    } catch (error) {
      if (platformMsgId === null || !isUniqueViolation(error)) throw error;
      this.stmt("UPDATE messages SET state = ?, platform_msg_id = NULL WHERE id = ?").run(state, id);
    }
  }

  /**
   * Transition inbound messages strictly through the `inbound.ts` state machine inside one atomic
   * SQLite savepoint.
   * - `admit` / `replay_paused`: atomically commits `state = 'received'` AND `pause_generation` in
   *   the SAME UPDATE statement (S27).
   * - `admit_paused`: transitions `held -> paused_pending` directly + indexes FTS without ever
   *   committing `state = 'received'` (S26/S27).
   * - `pause`: accepts unacked `received`/`delivered`/`waiting` ONLY (`acked_at IS NULL AND
   *   t3_turn_id IS NULL`), preserving committed/ACKed runs (S28).
   * - `refuse`: scrubs body/attachments and removes from FTS5.
   */
  moveInbound(ids: readonly string[], event: InboundEvent, retryAt?: number, pauseGeneration?: number): string[] {
    if (!ids.length) return [];
    const rule = INBOUND[event];
    const placeholders = rule.from.map(() => "?").join(", ");
    const isHold = event === "hold" ? 1 : 0;
    const unackedGuard = event === "pause" ? " AND acked_at IS NULL AND t3_turn_id IS NULL" : "";
    const updatesPauseGeneration = event === "admit" || event === "replay_paused";
    const clearsPauseGeneration = event === "admit_paused" || event === "rehold_paused";

    const sql = updatesPauseGeneration
      ? `UPDATE messages
         SET state = ?,
             retry_at = CASE WHEN ? THEN ? ELSE NULL END,
             pause_generation = COALESCE(
               ?,
               (SELECT pause_generation FROM leader_pause_generations WHERE leader_id = COALESCE(messages.leader_id, 'leader-default')),
               0
             )
         WHERE id = ? AND direction = 'in' AND state IN (${placeholders})${unackedGuard}`
      : clearsPauseGeneration
        ? `UPDATE messages
           SET state = ?,
               retry_at = CASE WHEN ? THEN ? ELSE NULL END,
               pause_generation = NULL
           WHERE id = ? AND direction = 'in' AND state IN (${placeholders})${unackedGuard}`
        : `UPDATE messages
           SET state = ?,
               retry_at = CASE WHEN ? THEN ? ELSE NULL END
           WHERE id = ? AND direction = 'in' AND state IN (${placeholders})${unackedGuard}`;

    const stmt = this.db.prepare(sql);
    const moved: string[] = [];
    this.db.exec("SAVEPOINT move_inbound");
    try {
      for (const id of ids) {
        const res = updatesPauseGeneration
          ? stmt.run(rule.to, isHold, retryAt ?? null, pauseGeneration ?? null, id, ...rule.from)
          : stmt.run(rule.to, isHold, retryAt ?? null, id, ...rule.from);
        if (Number(res.changes) > 0) {
          moved.push(id);
          if (event === "admit" || event === "admit_paused") {
            const msg = this.message(id);
            if (msg) this.indexMessageInFts(msg.id, msg.body);
          } else if (event === "rehold_paused") {
            this.stmt("DELETE FROM messages_fts WHERE msg_id = ?").run(id);
          } else if (event === "refuse") {
            this.stmt("UPDATE messages SET body = '', attachments = NULL WHERE id = ?").run(id);
            this.stmt("DELETE FROM messages_fts WHERE msg_id = ?").run(id);
          }
        }
      }
      this.db.exec("RELEASE SAVEPOINT move_inbound");
      return moved;
    } catch (error) {
      this.db.exec("ROLLBACK TO SAVEPOINT move_inbound");
      this.db.exec("RELEASE SAVEPOINT move_inbound");
      throw error;
    }
  }

  /**
   * Atomically admit a single `held` message (S26/S27):
   * - If the message's stamped Leader (or connection) is paused, commits `held -> paused_pending`
   *   directly in one transaction (never transiently entering `received`).
   * - Otherwise commits `held -> received` AND `pause_generation` in one single SQL UPDATE.
   */
  admitHeldMessage(messageId: string):
    | { readonly kind: "paused_pending"; readonly message: Message; readonly conn: Connection; readonly chat: Chat }
    | { readonly kind: "received"; readonly message: Message; readonly conn: Connection; readonly chat: Chat; readonly pauseGeneration: number }
    | undefined {
    this.db.exec("SAVEPOINT admit_held");
    try {
      const msg = this.message(messageId);
      if (!msg || msg.direction !== "in" || msg.state !== "held") {
        this.db.exec("RELEASE SAVEPOINT admit_held");
        return undefined;
      }
      const conn = this.connection(msg.connectionId);
      const chat = this.chat(msg.chatId);
      if (!conn || !chat) {
        this.db.exec("RELEASE SAVEPOINT admit_held");
        return undefined;
      }
      const msgLeaderId = msg.leaderId ?? "leader-default";
      if (this.isLeaderPausedForConnection(msgLeaderId, conn)) {
        const moved = this.moveInbound([msg.id], "admit_paused");
        const updated = moved.length > 0 ? this.message(msg.id) : undefined;
        this.db.exec("RELEASE SAVEPOINT admit_held");
        return updated ? { kind: "paused_pending", message: updated, conn, chat } : undefined;
      }
      const freshGen = this.getLeaderPauseGeneration(msgLeaderId);
      const moved = this.moveInbound([msg.id], "admit", undefined, freshGen);
      const updated = moved.length > 0 ? this.message(msg.id) : undefined;
      this.db.exec("RELEASE SAVEPOINT admit_held");
      return updated ? { kind: "received", message: updated, conn, chat, pauseGeneration: freshGen } : undefined;
    } catch (error) {
      this.db.exec("ROLLBACK TO SAVEPOINT admit_held");
      this.db.exec("RELEASE SAVEPOINT admit_held");
      throw error;
    }
  }

  /** Record T3 acknowledgment for an inbound trigger message (idempotency boundary). */
  ackInbound(
    selector: { readonly messageId?: string; readonly idempotencyKey?: string },
    ack: { readonly t3ThreadId: string; readonly t3TurnId: string },
  ): Message | undefined {
    const msg = selector.messageId
      ? this.message(selector.messageId)
      : selector.idempotencyKey
        ? this.messageByIdempotencyKey(selector.idempotencyKey)
        : undefined;
    if (!msg || msg.direction !== "in") return undefined;
    const t = this.now();
    this.db.exec("BEGIN");
    try {
      this.stmt(
        `UPDATE messages
         SET t3_thread_id = ?, t3_turn_id = ?, acked_at = COALESCE(acked_at, ?),
             state = CASE WHEN state IN ('received', 'waiting', 'paused_pending') THEN 'delivered' ELSE state END
         WHERE id = ?`,
      ).run(ack.t3ThreadId, ack.t3TurnId, t, msg.id);
      const chat = this.chat(msg.chatId);
      const conn = this.connection(msg.connectionId);
      // S19: Always persist the ACK on the message row, but ONLY update the chat's live
      // thread pointer when the message belongs to the connection's CURRENT active binding!
      const msgLeaderId = msg.leaderId ?? "leader-default";
      const msgBindingEpoch = msg.bindingEpoch ?? 1;
      const matchesCurrentBinding =
        conn !== undefined &&
        msgLeaderId === conn.leaderId &&
        msgBindingEpoch === conn.bindingEpoch &&
        (conn.bindingId === null || msg.bindingId === null || msg.bindingId === conn.bindingId);
      if (chat && conn && matchesCurrentBinding && (chat.kind === "dm" || chat.kind === "thread")) {
        this.setChatThreadId(chat.id, ack.t3ThreadId, {
          leaderId: conn.leaderId,
          bindingId: conn.bindingId,
          bindingEpoch: conn.bindingEpoch,
        });
      }
      this.db.exec("COMMIT");
    } catch (error) {
      this.db.exec("ROLLBACK");
      throw error;
    }
    return this.message(msg.id);
  }

  /**
   * ADR-011 Invariant #7 & ADR-013 S18/S28: Return gate-approved unacked `received` / `delivered`
   * trigger messages on active connections. By default filters out paused connections/current paused
   * Leaders; when `includePaused: true` is passed (startup replay), returns ALL unacked triggers on
   * active connections so paused startup sweeps unacked `received` and `delivered` items into
   * `paused_pending` without stranding them.
   */
  listUnackedTriggers(
    filter?: string | { readonly connectionId?: string; readonly includePaused?: boolean },
  ): Message[] {
    const connectionId = typeof filter === "string" ? filter : filter?.connectionId;
    const includePaused = typeof filter === "object" && filter !== null ? Boolean(filter.includePaused) : false;
    const scope = connectionId ? "AND m.connection_id = ?" : "";
    const pauseFilter = includePaused
      ? ""
      : `AND n.paused = 0
         AND (n.leader_paused = 0 OR COALESCE(m.leader_id, 'leader-default') != n.leader_id)`;
    const sql = `
      SELECT m.*
      FROM messages m
      JOIN connections n ON n.id = m.connection_id
      WHERE m.direction = 'in'
        AND m.triggers = 1
        AND m.state IN ('received', 'delivered')
        AND m.acked_at IS NULL
        AND m.t3_turn_id IS NULL
        AND n.lifecycle_state = 'active'
        ${pauseFilter}
        ${scope}
      ORDER BY m.created_at ASC, m.rowid ASC
    `;
    const rows = (connectionId ? this.db.prepare(sql).all(connectionId) : this.db.prepare(sql).all()) as Row[];
    return rows.map(toMessage);
  }

  /** Held messages pending owner approval, oldest first. */
  heldMessages(
    connectionId?: string,
  ): (Message & { readonly chat: Chat; readonly platform: Platform; readonly contactId: string | null })[] {
    const scope = connectionId ? "AND m.connection_id = ?" : "";
    const sql = `
      SELECT m.*, n.platform
      FROM messages m
      JOIN connections n ON n.id = m.connection_id
      WHERE m.direction = 'in' AND m.state = 'held' ${scope}
      ORDER BY m.created_at ASC, m.rowid ASC
    `;
    const rows = (connectionId ? this.db.prepare(sql).all(connectionId) : this.db.prepare(sql).all()) as Row[];
    return rows.map((r) => {
      const m = toMessage(r);
      const contactId = m.senderId ? (this.contactByPlatformId(m.connectionId, m.senderId)?.id ?? null) : null;
      return { ...m, chat: this.chat(m.chatId)!, platform: String(r.platform) as Platform, contactId };
    });
  }

  /** Held messages belonging to a specific contact (across all chats on that connection). */
  heldMessagesForContact(contactId: string): Message[] {
    const contact = this.contact(contactId);
    if (!contact) return [];
    const rows = this.stmt(
      `SELECT * FROM messages
       WHERE connection_id = ? AND direction = 'in' AND sender_id = ? AND state = 'held'
       ORDER BY created_at ASC, rowid ASC`,
    ).all(contact.connectionId, contact.platformId) as Row[];
    return rows.map(toMessage);
  }

  /** Held messages belonging to a specific chat (and its child threads). */
  heldMessagesForChat(chatId: string): Message[] {
    const rows = this.stmt(
      `SELECT m.* FROM messages m
       JOIN chats c ON c.id = m.chat_id
       WHERE (c.id = ? OR c.parent_id = ?) AND m.direction = 'in' AND m.state = 'held'
       ORDER BY m.created_at ASC, m.rowid ASC`,
    ).all(chatId, chatId) as Row[];
    return rows.map(toMessage);
  }

  message(id: string): Message | undefined {
    const row = this.stmt("SELECT * FROM messages WHERE id = ?").get(id) as Row | undefined;
    return row && toMessage(row);
  }

  messageByIdempotencyKey(key: string): Message | undefined {
    const row = this.stmt("SELECT * FROM messages WHERE idempotency_key = ?").get(key) as Row | undefined;
    return row && toMessage(row);
  }

  messageByPlatformId(connectionId: string, platformMsgId: string): Message | undefined {
    const row = this.stmt("SELECT * FROM messages WHERE connection_id = ? AND platform_msg_id = ?").get(
      connectionId,
      platformMsgId,
    ) as Row | undefined;
    return row && toMessage(row);
  }

  /** Messages in a chat, oldest first. Excludes `blocked` and `held` messages. */
  chatMessages(chatId: string, limit = 50, before?: string): Message[] {
    const anchor = before
      ? (this.stmt("SELECT created_at, rowid FROM messages WHERE id = ?").get(before) as
          | { created_at: number; rowid: number }
          | undefined)
      : undefined;
    const at = anchor ? Number(anchor.created_at) : Number.MAX_SAFE_INTEGER;
    const row = anchor ? Number(anchor.rowid) : Number.MAX_SAFE_INTEGER;
    const rows = this.stmt(
      `SELECT * FROM messages
       WHERE chat_id = ? AND state NOT IN ('blocked', 'held')
         AND (created_at < ? OR (created_at = ? AND rowid < ?))
       ORDER BY created_at DESC, rowid DESC LIMIT ?`,
    ).all(chatId, at, at, row, limit) as Row[];
    return rows.map(toMessage).reverse();
  }

  chatAround(chatId: string, messageId: string, limit = 30): Message[] | undefined {
    const anchor = this.stmt(
      "SELECT rowid, * FROM messages WHERE id = ? AND chat_id = ? AND state NOT IN ('blocked', 'held')",
    ).get(messageId, chatId) as Row | undefined;
    if (!anchor) return undefined;
    const at = Number(anchor.created_at);
    const rowid = Number(anchor.rowid);
    const older = this.stmt(
      `SELECT * FROM messages WHERE chat_id = ? AND state NOT IN ('blocked', 'held')
         AND (created_at < ? OR (created_at = ? AND rowid < ?))
       ORDER BY created_at DESC, rowid DESC LIMIT ?`,
    ).all(chatId, at, at, rowid, Math.floor((limit - 1) / 2)) as Row[];
    const newer = this.stmt(
      `SELECT * FROM messages WHERE chat_id = ? AND state NOT IN ('blocked', 'held')
         AND (created_at > ? OR (created_at = ? AND rowid > ?))
       ORDER BY created_at ASC, rowid ASC LIMIT ?`,
    ).all(chatId, at, at, rowid, limit - 1 - older.length) as Row[];
    return [...older.map(toMessage).reverse(), toMessage(anchor), ...newer.map(toMessage)];
  }

  chatSince(chatId: string, messageId: string, limit = 50): Message[] | undefined {
    const anchor = this.stmt(
      "SELECT created_at, rowid FROM messages WHERE id = ? AND chat_id = ? AND state NOT IN ('blocked', 'held')",
    ).get(messageId, chatId) as Row | undefined;
    if (!anchor) return undefined;
    const rows = this.stmt(
      `SELECT * FROM messages WHERE chat_id = ? AND state NOT IN ('blocked', 'held')
         AND (created_at > ? OR (created_at = ? AND rowid > ?))
       ORDER BY created_at ASC, rowid ASC LIMIT ?`,
    ).all(chatId, Number(anchor.created_at), Number(anchor.created_at), Number(anchor.rowid), limit) as Row[];
    return rows.map(toMessage);
  }

  /**
   * Count of allowed-chat background (`triggers = 0`, `state = 'ignored'`) messages since the
   * assistant last spoke in this chat (or its parent group/threads).
   */
  unseen(chatId: string, before: number): number {
    const chat = this.chat(chatId);
    if (!chat || this.isChatBlocked(chatId)) return 0;
    const scope = chat.parentId ? [chat.id, chat.parentId] : [chat.id];
    const marks = scope.map(() => "?").join(", ");
    const spoke = this.db
      .prepare(
        `SELECT max(created_at) AS at FROM messages
         WHERE direction = 'out' AND notice = 0 AND state IN ('sent', 'uncertain')
           AND created_at <= ?
           AND chat_id IN (SELECT id FROM chats WHERE id IN (${marks}) OR parent_id IN (${marks}))`,
      )
      .get(before, ...scope, ...scope) as Row;
    const row = this.db
      .prepare(
        `SELECT count(*) AS n FROM messages
         WHERE chat_id IN (${marks}) AND direction = 'in' AND triggers = 0 AND state = 'ignored'
           AND created_at > ? AND created_at < ?`,
      )
      .get(...scope, spoke.at == null ? -1 : Number(spoke.at), before) as Row;
    return Number(row.n);
  }

  /**
   * Full-text search over allowed chats ONLY using FTS5 `trigram` (for >= 3-char terms) +
   * LIKE fallback joined through `messages_fts` (so blocked/held messages can NEVER match).
   */
  search(query: string, opts: { readonly chatId?: string; readonly connectionId?: string; readonly limit?: number } = {}): Message[] {
    const terms = searchTerms(query);
    if (terms.length === 0) return [];
    const limit = opts.limit ?? 20;
    const long = terms.filter((t) => [...t].length >= 3);
    const short = terms.filter((t) => [...t].length < 3);

    const where: string[] = [
      "m.state NOT IN ('blocked', 'held')",
      "COALESCE(c.access, '') <> 'blocked'",
      "COALESCE(p.access, '') <> 'blocked'",
    ];
    const args: SQLInputValue[] = [];

    if (long.length > 0) {
      const match = long.map((t) => `"${t.replaceAll('"', '""')}"`).join(" AND ");
      where.push("messages_fts MATCH ?");
      args.push(match);
    }
    for (const t of short) {
      where.push("m.body LIKE ? ESCAPE '\\'");
      args.push(`%${t.replace(/[\\%_]/g, (c) => `\\${c}`)}%`);
    }
    if (opts.chatId) {
      where.push("m.chat_id = ?");
      args.push(opts.chatId);
    }
    if (opts.connectionId) {
      where.push("m.connection_id = ?");
      args.push(opts.connectionId);
    }
    args.push(limit);

    // Always JOIN messages_fts so only gate-approved indexed messages are searchable!
    const sql = `
      SELECT m.*
      FROM messages_fts f
      JOIN messages m ON m.id = f.msg_id
      JOIN chats c ON c.id = m.chat_id
      LEFT JOIN chats p ON p.id = c.parent_id
      WHERE ${where.join(" AND ")}
      ORDER BY m.created_at DESC, m.rowid DESC
      LIMIT ?
    `;
    return (this.db.prepare(sql).all(...args) as Row[]).map(toMessage);
  }

  /** Find an inbound attachment by its short file ID (`f...`). */
  attachment(fileId: string): { readonly message: Message; readonly chat: Chat; readonly attachment: Attachment } | undefined {
    const rows = this.stmt(
      "SELECT * FROM messages WHERE direction = 'in' AND state NOT IN ('blocked', 'held') AND attachments LIKE ?",
    ).all(`%"id":"${fileId}"%`) as Row[];
    for (const row of rows) {
      const message = toMessage(row);
      const found = message.attachments.find((a) => a.id === fileId);
      if (found) {
        const chat = this.chat(message.chatId);
        if (chat && !this.isChatBlocked(chat.id)) return { message, chat, attachment: found };
      }
    }
    return undefined;
  }

  /** Settle delivered/unanswered messages in a chat after a plain outbound send. */
  settleChatOnSend(chatId: string): string[] {
    const rows = this.stmt(
      "SELECT id FROM messages WHERE chat_id = ? AND direction = 'in' AND state IN ('delivered', 'unanswered')",
    ).all(chatId) as Row[];
    if (!rows.length) return [];
    return this.moveInbound(
      rows.map((r) => String(r.id)),
      "send",
    );
  }

  /** Defer unacked queued/delivered/waiting inbound triggers for a paused connection/leader into `paused_pending` without touching ACKed runs (S28). */
  pauseConnectionMessages(connectionId: string, leaderId?: string): string[] {
    const rows = (
      leaderId
        ? this.stmt(
            `SELECT id FROM messages
             WHERE connection_id = ? AND direction = 'in'
               AND triggers = 1
               AND acked_at IS NULL AND t3_turn_id IS NULL
               AND state IN ('received', 'delivered', 'waiting')
               AND COALESCE(leader_id, 'leader-default') = ?`,
          ).all(connectionId, leaderId)
        : this.stmt(
            `SELECT id FROM messages
             WHERE connection_id = ? AND direction = 'in'
               AND triggers = 1
               AND acked_at IS NULL AND t3_turn_id IS NULL
               AND state IN ('received', 'delivered', 'waiting')`,
          ).all(connectionId)
    ) as Row[];
    if (!rows.length) return [];
    return this.moveInbound(
      rows.map((r) => String(r.id)),
      "pause",
    );
  }

  /** Defer all unacked queued/delivered/waiting inbound triggers owned by a paused Leader across all connections without touching ACKed runs (S28). */
  pauseLeaderMessages(leaderId: string): string[] {
    const rows = this.stmt(
      `SELECT id FROM messages
       WHERE direction = 'in'
         AND triggers = 1
         AND acked_at IS NULL AND t3_turn_id IS NULL
         AND state IN ('received', 'delivered', 'waiting')
         AND COALESCE(leader_id, 'leader-default') = ?`,
    ).all(leaderId) as Row[];
    if (!rows.length) return [];
    return this.moveInbound(
      rows.map((r) => String(r.id)),
      "pause",
    );
  }

  /** Read the full persisted pause state for a Leader (S23/S25/S29). */
  getLeaderPauseState(leaderId: string): {
    readonly exists: boolean;
    readonly pauseGeneration: number;
    readonly paused: boolean;
    readonly pauseVersion: number;
  } {
    const row = this.stmt(
      "SELECT pause_generation, paused, pause_version FROM leader_pause_generations WHERE leader_id = ?",
    ).get(leaderId) as Row | undefined;
    if (!row) {
      return { exists: false, pauseGeneration: 0, paused: false, pauseVersion: 0 };
    }
    return {
      exists: true,
      pauseGeneration: row.pause_generation == null ? 0 : Number(row.pause_generation),
      paused: Number(row.paused ?? 0) === 1,
      pauseVersion: row.pause_version == null ? 0 : Number(row.pause_version),
    };
  }

  /**
   * Monotonically reconcile a Leader's pause state (`pauseVersion`, `pauseGeneration`, `paused`)
   * and atomically mirror the authoritative `paused` flag onto all connections bound to that Leader (S23/S25/S29).
   * Stale out-of-order syncs (lower `pauseVersion` or lower `pauseGeneration`) are ignored completely.
   */
  setLeaderPauseState(
    leaderId: string,
    state: { readonly pauseGeneration?: number; readonly paused?: boolean; readonly pauseVersion?: number },
  ): {
    readonly applied: boolean;
    readonly pauseGeneration: number;
    readonly paused: boolean;
    readonly pauseVersion: number;
    readonly updatedConnectionIds: readonly string[];
  } {
    if (!leaderId) {
      return { applied: false, pauseGeneration: 0, paused: false, pauseVersion: 0, updatedConnectionIds: [] };
    }
    const incomingGen =
      typeof state.pauseGeneration === "number" && Number.isInteger(state.pauseGeneration) && state.pauseGeneration >= 0
        ? state.pauseGeneration
        : undefined;
    const incomingVer =
      typeof state.pauseVersion === "number" && Number.isInteger(state.pauseVersion) && state.pauseVersion >= 0
        ? state.pauseVersion
        : undefined;
    const incomingPaused = typeof state.paused === "boolean" ? state.paused : undefined;

    this.db.exec("SAVEPOINT set_leader_pause");
    try {
      const current = this.getLeaderPauseState(leaderId);
      let stale = false;
      if (incomingVer !== undefined) {
        if (current.exists && incomingVer < current.pauseVersion) {
          stale = true;
        } else if (current.exists && incomingVer === current.pauseVersion) {
          if (incomingGen !== undefined && incomingGen < current.pauseGeneration) {
            stale = true;
          } else if (
            current.pauseVersion > 0 &&
            (incomingGen === undefined || incomingGen === current.pauseGeneration)
          ) {
            // Same positive version cannot carry a conflicting Pause/Resume transition; treat as idempotent.
            stale = true;
          }
        }
      } else {
        // Unversioned fallback (S29):
        // 1. Never allow a lower pauseGeneration to overwrite newer state.
        // 2. Once a Leader has a known positive pauseVersion, reject ANY unversioned `paused`
        //    mutation (whether or not pauseGeneration was supplied) so partial or unversioned
        //    binding syncs can never clear or toggle a versioned Pause/Resume!
        if (incomingGen !== undefined && incomingGen < current.pauseGeneration) {
          stale = true;
        } else if (current.exists && current.pauseVersion > 0 && incomingPaused !== undefined) {
          stale = true;
        }
      }

      if (stale) {
        this.db.exec("RELEASE SAVEPOINT set_leader_pause");
        return {
          applied: false,
          pauseGeneration: current.pauseGeneration,
          paused: current.paused,
          pauseVersion: current.pauseVersion,
          updatedConnectionIds: [],
        };
      }

      const nextVersion =
        incomingVer !== undefined && incomingPaused !== undefined
          ? Math.max(current.pauseVersion, incomingVer)
          : current.pauseVersion;
      const nextGen = incomingGen !== undefined ? Math.max(current.pauseGeneration, incomingGen) : current.pauseGeneration;
      const nextPaused = incomingPaused !== undefined ? incomingPaused : current.paused;

      this.stmt(
        `INSERT INTO leader_pause_generations (leader_id, pause_generation, paused, pause_version)
         VALUES (?, ?, ?, ?)
         ON CONFLICT(leader_id) DO UPDATE SET
           pause_generation = excluded.pause_generation,
           paused = excluded.paused,
           pause_version = excluded.pause_version`,
      ).run(leaderId, nextGen, nextPaused ? 1 : 0, nextVersion);

      const updatedConnectionIds: string[] = [];
      if (incomingPaused !== undefined) {
        const affected = this.stmt(
          "SELECT id FROM connections WHERE leader_id = ? AND leader_paused != ?",
        ).all(leaderId, nextPaused ? 1 : 0) as Row[];
        if (affected.length > 0) {
          this.stmt("UPDATE connections SET leader_paused = ?, updated_at = ? WHERE leader_id = ?").run(
            nextPaused ? 1 : 0,
            this.now(),
            leaderId,
          );
          for (const r of affected) updatedConnectionIds.push(String(r.id));
        }
      }
      if (nextPaused) {
        this.pauseLeaderMessages(leaderId);
      }
      this.db.exec("RELEASE SAVEPOINT set_leader_pause");
      return {
        applied: true,
        pauseGeneration: nextGen,
        paused: nextPaused,
        pauseVersion: nextVersion,
        updatedConnectionIds,
      };
    } catch (error) {
      this.db.exec("ROLLBACK TO SAVEPOINT set_leader_pause");
      this.db.exec("RELEASE SAVEPOINT set_leader_pause");
      throw error;
    }
  }

  /** Record the latest pause generation synced from T3 for a Leader (S23). */
  setLeaderPauseGeneration(leaderId: string, pauseGeneration: number): void {
    this.setLeaderPauseState(leaderId, { pauseGeneration });
  }

  /** Read the pause generation currently known to the bridge for a Leader (S23). */
  getLeaderPauseGeneration(leaderId: string): number {
    return this.getLeaderPauseState(leaderId).pauseGeneration;
  }

  /** Read the persisted paused flag currently known to the bridge for a Leader (S25/S26). */
  getLeaderPaused(leaderId: string): boolean {
    return this.getLeaderPauseState(leaderId).paused;
  }

  /** Whether a message's target Leader (or its connection) is currently paused (S26). */
  isLeaderPausedForConnection(leaderId: string, conn: Connection): boolean {
    if (conn.paused) return true;
    if (this.getLeaderPaused(leaderId)) return true;
    return leaderId === conn.leaderId && conn.leaderPaused;
  }

  /** Reconcile Leader binding identity and pause flag onto a bridge connection atomically using monotonic pauseVersion (S4/S6/S29). */
  syncConnectionBinding(input: {
    readonly connectionId: string;
    readonly leaderId: string;
    readonly bindingId: string | null;
    readonly bindingEpoch: number;
    readonly leaderPaused?: boolean;
    readonly pauseGeneration?: number;
    readonly pauseVersion?: number;
  }): Connection | undefined {
    this.db.exec("SAVEPOINT sync_conn_binding");
    try {
      const hasPauseFields =
        typeof input.leaderPaused === "boolean" ||
        typeof input.pauseGeneration === "number" ||
        typeof input.pauseVersion === "number";
      const leaderState = hasPauseFields
        ? this.setLeaderPauseState(input.leaderId, {
            ...(typeof input.leaderPaused === "boolean" ? { paused: input.leaderPaused } : {}),
            ...(typeof input.pauseGeneration === "number" ? { pauseGeneration: input.pauseGeneration } : {}),
            ...(typeof input.pauseVersion === "number" ? { pauseVersion: input.pauseVersion } : {}),
          })
        : this.getLeaderPauseState(input.leaderId);
      const prev = this.connection(input.connectionId);
      const bindingStale = prev !== undefined && input.bindingEpoch < prev.bindingEpoch;
      // S29: Always apply the authoritative monotonic `leaderState.paused` (never a stale or omitted input flag!),
      // and never roll back a connection to an older binding epoch.
      const updated = bindingStale
        ? this.updateConnection(input.connectionId, {
            leaderPaused: this.getLeaderPaused(prev.leaderId),
          })
        : this.updateConnection(input.connectionId, {
            leaderId: input.leaderId,
            bindingId: input.bindingId,
            bindingEpoch: input.bindingEpoch,
            leaderPaused: leaderState.paused,
          });
      if (updated) {
        const bindingChanged =
          !prev ||
          prev.leaderId !== updated.leaderId ||
          prev.bindingId !== updated.bindingId ||
          prev.bindingEpoch !== updated.bindingEpoch;
        if (bindingChanged) {
          this.clearStaleChatThreadPointers(updated.id, {
            leaderId: updated.leaderId,
            bindingId: updated.bindingId,
            bindingEpoch: updated.bindingEpoch,
          });
        }
        if (updated.leaderPaused) {
          this.pauseConnectionMessages(updated.id, updated.leaderId);
        }
      }
      this.db.exec("RELEASE SAVEPOINT sync_conn_binding");
      return updated;
    } catch (error) {
      this.db.exec("ROLLBACK TO SAVEPOINT sync_conn_binding");
      this.db.exec("RELEASE SAVEPOINT sync_conn_binding");
      throw error;
    }
  }

  /** Re-evaluate current access gate for a stored inbound message before selective replay (S5). */
  evaluateInboundGate(msg: Message, trust: Trust): "deliver" | "ask" | "drop" {
    const conn = this.connection(msg.connectionId);
    const chat = this.chat(msg.chatId);
    if (!conn || !chat) return "drop";
    const isOwner = Boolean(conn.ownerId && msg.senderId === conn.ownerId);
    const contact = msg.senderId ? this.contactByPlatformId(conn.id, msg.senderId) : undefined;
    let groupAccess: Access = chat.kind === "dm" ? null : chat.access;
    if (chat.parentId) {
      const parent = this.chat(chat.parentId);
      if (parent?.access === "blocked") groupAccess = "blocked";
      else if (groupAccess === null && parent) groupAccess = parent.access;
    }
    return gate({
      lifecycleState: conn.lifecycleState,
      trust,
      askAll: conn.askAll,
      isOwner,
      chatKind: chat.kind,
      contact: contact?.access ?? null,
      group: groupAccess,
    });
  }

  /** Paused backlog messages awaiting Owner review on resume, oldest first. */
  heldMessageCountForLeader(leaderId: string): number {
    const row = this.stmt(
      `SELECT COUNT(*) AS count FROM messages
       WHERE direction = 'in' AND state = 'held'
         AND COALESCE(leader_id, 'leader-default') = ?`,
    ).get(leaderId) as { count?: number } | undefined;
    return Number(row?.count ?? 0);
  }

  pausedPendingMessages(
    filter?: readonly string[] | { readonly connectionIds?: readonly string[]; readonly leaderId?: string },
  ): (Message & { readonly chat: Chat; readonly platform: Platform; readonly contact?: Contact })[] {
    const isList = Array.isArray(filter);
    const opts = isList ? undefined : (filter as { readonly connectionIds?: readonly string[]; readonly leaderId?: string } | undefined);
    const connectionIds = isList ? (filter as readonly string[]) : opts?.connectionIds;
    const leaderId = opts?.leaderId;
    const clauses: string[] = ["m.direction = 'in'", "m.state = 'paused_pending'"];
    const args: SQLInputValue[] = [];
    if (connectionIds && connectionIds.length > 0) {
      clauses.push(`m.connection_id IN (${connectionIds.map(() => "?").join(", ")})`);
      args.push(...connectionIds);
    }
    if (leaderId) {
      // S6: Always filter by historical message identity (never the connection's current Leader after rebind).
      clauses.push("COALESCE(m.leader_id, 'leader-default') = ?");
      args.push(leaderId);
    }
    const sql = `
      SELECT m.*, n.platform
      FROM messages m
      JOIN connections n ON n.id = m.connection_id
      WHERE ${clauses.join(" AND ")}
      ORDER BY m.created_at ASC, m.rowid ASC
    `;
    const rows = this.db.prepare(sql).all(...args) as Row[];
    const out: (Message & { readonly chat: Chat; readonly platform: Platform; readonly contact?: Contact })[] = [];
    for (const r of rows) {
      const msg = toMessage(r);
      const chat = this.chat(msg.chatId);
      if (!chat) continue;
      const contact = msg.senderId ? this.contactByPlatformId(msg.connectionId, msg.senderId) : undefined;
      out.push({ ...msg, chat, platform: String(r.platform) as Platform, ...(contact ? { contact } : {}) });
    }
    return out;
  }

  /** Selectively replay (`paused_pending` -> `received`, atomically committing `pause_generation`) or dismiss (`paused_pending` -> `ignored`) paused backlog items (S27). */
  decidePausedPending(
    messageIds: readonly string[],
    decision: "replay" | "dismiss",
    pauseGeneration?: number,
  ): Message[] {
    if (!messageIds.length) return [];
    const changedIds = this.moveInbound(
      messageIds,
      decision === "replay" ? "replay_paused" : "dismiss_paused",
      undefined,
      decision === "replay" ? pauseGeneration : undefined,
    );
    return changedIds.map((id) => this.message(id)).filter((msg): msg is Message => Boolean(msg));
  }
}

// ----------------------------------------------------------------- row mappers

const str = (v: SQLInputValue | undefined): string | null => (v === null || v === undefined ? null : String(v));

function parseAccess(v: SQLInputValue | undefined): Access {
  return v === "allowed" || v === "blocked" ? v : null;
}

function toConnection(r: Row): Connection {
  return {
    id: String(r.id),
    platform: String(r.platform) as Platform,
    botId: str(r.bot_id),
    botName: str(r.bot_name),
    lifecycleState: String(r.lifecycle_state) as LifecycleState,
    state: String(r.state) as StoredLinkState,
    stateDetail: str(r.state_detail),
    paused: Number(r.paused) === 1,
    leaderPaused: Number(r.leader_paused ?? 0) === 1,
    leaderId: str(r.leader_id) ?? "leader-default",
    bindingId: str(r.binding_id),
    bindingEpoch: Number(r.binding_epoch ?? 1),
    secretRef: str(r.secret_ref),
    ownerId: str(r.owner_id),
    claimCode: str(r.claim_code),
    claimExpiresAt: r.claim_expires_at == null ? null : Number(r.claim_expires_at),
    claimAttempts: Number(r.claim_attempts ?? 0),
    askAll: Number(r.ask_all) === 1,
    cursorJson: str(r.cursor_json),
    createdAt: Number(r.created_at),
    updatedAt: Number(r.updated_at),
  };
}

function toChat(r: Row): Chat {
  return {
    id: String(r.id),
    connectionId: String(r.connection_id),
    platformId: String(r.platform_id),
    kind: String(r.kind) as ChatKind,
    name: str(r.name),
    access: parseAccess(r.access),
    parentId: str(r.parent_id),
    followUp: Number(r.follow_up) === 1,
    threadId: str(r.thread_id),
    threadLeaderId: str(r.thread_leader_id),
    threadBindingId: str(r.thread_binding_id),
    threadBindingEpoch: r.thread_binding_epoch == null ? null : Number(r.thread_binding_epoch),
    peerId: str(r.peer_id),
    createdAt: Number(r.created_at),
    updatedAt: Number(r.updated_at),
  };
}

function toContact(r: Row): Contact {
  return {
    id: String(r.id),
    connectionId: String(r.connection_id),
    platformId: String(r.platform_id),
    name: str(r.name),
    alias: str(r.alias),
    access: parseAccess(r.access),
    isBot: Number(r.is_bot) === 1,
    personId: str(r.person_id),
    personName: str(r.person_name),
    linkedBy: (str(r.linked_by) as LinkedBy | null) ?? null,
    profile: str(r.profile),
    createdAt: Number(r.created_at),
    updatedAt: Number(r.updated_at),
  };
}

function toPerson(r: Row): Person {
  return {
    id: String(r.id),
    name: str(r.name),
    note: str(r.note),
    createdAt: Number(r.created_at),
    updatedAt: Number(r.updated_at),
  };
}

function toMessage(r: Row): Message {
  return {
    id: String(r.id),
    connectionId: String(r.connection_id),
    chatId: String(r.chat_id),
    direction: String(r.direction) as "in" | "out",
    platformMsgId: str(r.platform_msg_id),
    idempotencyKey: str(r.idempotency_key),
    senderId: str(r.sender_id),
    senderName: str(r.sender_name),
    body: String(r.body),
    attachments: r.attachments ? (JSON.parse(String(r.attachments)) as Attachment[]) : [],
    replyTo: str(r.reply_to),
    replyToPlatformId: str(r.reply_to_platform_id),
    triggers: Number(r.triggers) === 1,
    state: String(r.state) as Message["state"],
    t3ThreadId: str(r.t3_thread_id),
    t3TurnId: str(r.t3_turn_id),
    leaderId: str(r.leader_id),
    bindingId: str(r.binding_id),
    bindingEpoch: r.binding_epoch == null ? null : Number(r.binding_epoch),
    pauseGeneration: r.pause_generation == null ? null : Number(r.pause_generation),
    ackedAt: r.acked_at == null ? null : Number(r.acked_at),
    retryAt: r.retry_at == null ? null : Number(r.retry_at),
    notice: Number(r.notice) === 1,
    createdAt: Number(r.created_at),
  };
}

function isUniqueViolation(error: unknown): boolean {
  const errcode = (error as { errcode?: number }).errcode;
  return errcode === 19 || (typeof errcode === "number" && (errcode & 0xff) === 19);
}
