import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { DatabaseSync } from "node:sqlite";
import { describe, it } from "node:test";
import type { InboundMessage } from "../src/channels/channel.ts";
import { CLAIM_TTL_MS } from "../src/core/access.ts";
import { makeIdempotencyKey, MAX_PERSON_NOTE_BYTES, Store } from "../src/store/store.ts";

function msg(overrides: Partial<InboundMessage> = {}): InboundMessage {
  return {
    platformId: overrides.platformId ?? "pm-1",
    chat: overrides.chat ?? { platformId: "chat-1", kind: "group", name: "Ops Group" },
    sender: overrides.sender ?? { id: "user-2", name: "Bob", isBot: false },
    text: overrides.text ?? "hello world",
    attachments: overrides.attachments ?? [],
    addressedToBot: overrides.addressedToBot ?? false,
    sentAt: overrides.sentAt ?? 1_700_000_000_000,
    ...(overrides.replyTo ? { replyTo: overrides.replyTo } : {}),
    ...(overrides.mentioned !== undefined ? { mentioned: overrides.mentioned } : {}),
    ...(overrides.earlier ? { earlier: overrides.earlier } : {}),
  };
}

describe("SQLite store invariants (ADR-011 S5/S6)", () => {
  it("enforces gate-before-background and FTS5 trigram search over allowed chats only", () => {
    const store = new Store(":memory:");
    try {
      const conn = store.createConnection({
        platform: "feishu",
        secretRef: "sec:1",
        lifecycleState: "active",
        ownerId: "owner-1",
        askAll: true,
      });

      // 1. Unapproved group background message MUST be dropped (not stored, not searchable!)
      const bgDrop = store.ingestInbound(
        conn.id,
        "org",
        msg({ platformId: "m-unapproved-bg", text: "secret project omega chatter", addressedToBot: false }),
      );
      assert.equal(bgDrop.kind, "unapproved_background_dropped");
      assert.equal(store.search("project omega").length, 0);
      assert.equal(store.listUnackedTriggers().length, 0);

      // 2. Unapproved group trigger message is stored ONLY as `held` (not in FTS5, not in unacked triggers!)
      const held = store.ingestInbound(
        conn.id,
        "org",
        msg({ platformId: "m-held-1", text: "please inspect omega budget", addressedToBot: true }),
      );
      assert.equal(held.kind, "held");
      assert.equal(store.search("omega budget").length, 0);
      assert.equal(store.listUnackedTriggers().length, 0);

      // 3. Approve the group -> admit held trigger -> now searchable AND in unacked triggers
      store.setChatAccess(held.chat.id, "allowed");
      store.moveInbound([held.message.id], "admit");
      assert.equal(store.search("omega budget").length, 1);
      assert.equal(store.listUnackedTriggers().length, 1);

      // 4. Allowed group background chatter enters FTS5 + unseen(), NEVER enters listUnackedTriggers()
      const allowedBg = store.ingestInbound(
        conn.id,
        "org",
        msg({
          platformId: "m-bg-1",
          text: "关于季度发布计划的讨论",
          addressedToBot: false,
          sentAt: 1_700_000_005_000,
        }),
      );
      assert.equal(allowedBg.kind, "background");
      assert.equal(allowedBg.message.state, "ignored");
      assert.equal(store.search("季度发布").length, 1);
      // Short 2-char CJK fallback search works over allowed chats!
      assert.equal(store.search("季度").length, 1);
      assert.equal(store.unseen(held.chat.id, 1_700_000_010_000), 1);
      assert.equal(store.listUnackedTriggers().length, 1); // still only m-held-1

      // 5. Blocked contact's messages NEVER enter background search or unacked triggers
      const badContact = store.touchContact(conn.id, "bad-user", "Mallory");
      store.setContactAccess(badContact.id, "blocked");
      const blocked = store.ingestInbound(
        conn.id,
        "org",
        msg({
          platformId: "m-blocked-1",
          sender: { id: "bad-user", name: "Mallory", isBot: false },
          text: "malicious payload injection",
          addressedToBot: true,
        }),
      );
      assert.equal(blocked.kind, "blocked");
      assert.equal(store.search("malicious").length, 0);
      assert.equal(store.listUnackedTriggers().length, 1);

      // 6. Blocking the group immediately purges its entries from FTS5!
      store.setChatAccess(held.chat.id, "blocked");
      assert.equal(store.search("季度发布").length, 0);
      assert.equal(store.search("季度").length, 0);
    } finally {
      store.close();
    }
  });

  it("enforces strict pairing isolation and 5-attempt lockout", () => {
    let now = 1_700_000_000_000;
    const store = new Store(":memory:", () => now);
    try {
      const conn = store.createConnection({
        platform: "wecom",
        secretRef: "sec:wecom",
        lifecycleState: "pairing",
        claimCode: "123456",
        claimExpiresAt: now + CLAIM_TTL_MS,
      });

      // Group message with valid code is rejected and never wakes T3
      const groupAttempt = store.ingestInbound(
        conn.id,
        "org",
        msg({ platformId: "p1", chat: { platformId: "g1", kind: "group" }, text: "123456", addressedToBot: true }),
      );
      assert.equal(groupAttempt.kind, "pairing_rejected");
      assert.equal(store.listUnackedTriggers().length, 0);

      // 4 wrong DM codes increment attempts
      for (let i = 1; i <= 4; i++) {
        const bad = store.ingestInbound(
          conn.id,
          "org",
          msg({ platformId: `bad-${i}`, chat: { platformId: "u1", kind: "dm" }, text: "999999", addressedToBot: true }),
        );
        assert.equal(bad.kind, "pairing_rejected");
        assert.equal(store.connection(conn.id)?.claimAttempts, i);
      }

      // 5th wrong DM code invalidates claim code
      const fifth = store.ingestInbound(
        conn.id,
        "org",
        msg({ platformId: "bad-5", chat: { platformId: "u1", kind: "dm" }, text: "999999", addressedToBot: true }),
      );
      assert.equal(fifth.kind, "pairing_rejected");
      assert.equal(store.connection(conn.id)?.claimCode, null);

      // Refresh claim code -> valid DM claims owner -> transitions to active without waking T3!
      store.updateConnection(conn.id, { claimCode: "778899", claimExpiresAt: now + CLAIM_TTL_MS, claimAttempts: 0 });
      const claimed = store.ingestInbound(
        conn.id,
        "org",
        msg({
          platformId: "claim-ok",
          chat: { platformId: "u_owner", kind: "dm" },
          sender: { id: "u_owner", name: "Owner", isBot: false },
          text: "778899",
          addressedToBot: true,
        }),
      );
      assert.equal(claimed.kind, "pairing_claimed");
      assert.equal(store.connection(conn.id)?.lifecycleState, "active");
      assert.equal(store.connection(conn.id)?.ownerId, "u_owner");
      assert.equal(store.listUnackedTriggers().length, 0);
    } finally {
      store.close();
    }
  });

  it("persists WeChat batch + dedup + cursor atomically and recovers unacked triggers", () => {
    const store = new Store(":memory:");
    try {
      const conn = store.createConnection({
        platform: "wechat",
        secretRef: "sec:wx",
        lifecycleState: "active",
        ownerId: "wx_owner",
      });

      const batch1 = store.persistInboundBatch(conn.id, "owner", {
        messages: [
          msg({
            platformId: "wx-1",
            chat: { platformId: "wx_owner", kind: "dm" },
            sender: { id: "wx_owner", name: "", isBot: false },
            text: "Create a todo for tomorrow",
            addressedToBot: true,
          }),
          // Duplicate inside same batch is deduplicated
          msg({
            platformId: "wx-1",
            chat: { platformId: "wx_owner", kind: "dm" },
            sender: { id: "wx_owner", name: "", isBot: false },
            text: "Create a todo for tomorrow",
            addressedToBot: true,
          }),
          // Stranger on owner-trust WeChat is held
          msg({
            platformId: "wx-2",
            chat: { platformId: "wx_stranger", kind: "dm" },
            sender: { id: "wx_stranger", name: "", isBot: false },
            text: "Hi stranger",
            addressedToBot: true,
          }),
        ],
        nextCursor: "cursor-v1",
      });

      assert.equal(batch1.cursorUpdated, true);
      assert.equal(store.getConnectionCursor(conn.id), "cursor-v1");
      assert.deepEqual(
        batch1.outcomes.map((o) => o.kind),
        ["dispatch", "duplicate", "held"],
      );

      // Crash-recovery replay returns ONLY gate-approved unacked trigger `wx-1`, NEVER `held` `wx-2`!
      const unacked = store.listUnackedTriggers();
      assert.equal(unacked.length, 1);
      assert.equal(unacked[0]!.platformMsgId, "wx-1");
      assert.equal(unacked[0]!.idempotencyKey, makeIdempotencyKey(conn.id, "wx-1"));

      // Once T3 acks it, it leaves unacked trigger queue
      const acked = store.ackInbound(
        { idempotencyKey: unacked[0]!.idempotencyKey! },
        { t3ThreadId: "thread-1", t3TurnId: "turn-1" },
      );
      assert.equal(acked?.state, "delivered");
      assert.equal(acked?.t3ThreadId, "thread-1");
      assert.equal(store.listUnackedTriggers().length, 0);

      // Transaction rollback safety: invalid connectionId rolls back without advancing anything
      assert.throws(() =>
        store.persistInboundBatch("missing-conn", "owner", {
          messages: [msg({ platformId: "wx-9" })],
          nextCursor: "cursor-bad",
        }),
      );
      assert.equal(store.getConnectionCursor(conn.id), "cursor-v1");
    } finally {
      store.close();
    }
  });

  it("enforces agent linkContacts security invariant and 2 KB person note limit", () => {
    const store = new Store(":memory:");
    try {
      const c1 = store.createConnection({ platform: "feishu", secretRef: "s1", lifecycleState: "active", ownerId: "u_owner_fs" });
      const c2 = store.createConnection({ platform: "wechat", secretRef: "s2", lifecycleState: "active", ownerId: "u_owner_wx" });

      const ownerFs = store.touchContact(c1.id, "u_owner_fs", "Owner FS");
      const aliceFs = store.touchContact(c1.id, "u_alice_fs", "Alice FS");
      const aliceWx = store.touchContact(c2.id, "u_alice_wx", "Alice WX");
      store.setContactAccess(aliceFs.id, "allowed");
      store.setContactAccess(aliceWx.id, null);

      // Agent MUST NOT touch owner contacts
      assert.throws(() => store.linkContacts([ownerFs.id, aliceFs.id], "agent"), /owner contact/i);

      // Owner can link owner + non-owner or two owner accounts, then agent MUST NOT merge into that person
      const ownerWx = store.touchContact(c2.id, "u_owner_wx", "Owner WX");
      store.linkContacts([ownerFs.id, ownerWx.id], "owner");
      assert.throws(() => store.linkContacts([ownerWx.id, aliceWx.id], "agent"), /owner contact/i);

      // Agent CAN link two non-owner contacts, and access permissions are NEVER transferred!
      const person = store.linkContacts([aliceFs.id, aliceWx.id], "agent");
      assert.equal(store.contact(aliceFs.id)?.personId, person.id);
      assert.equal(store.contact(aliceWx.id)?.personId, person.id);
      assert.equal(store.contact(aliceFs.id)?.linkedBy, "agent");
      assert.equal(store.contact(aliceWx.id)?.linkedBy, "agent");
      // Permission invariance: aliceWx remains undecided (`null`), NOT promoted to `"allowed"`!
      assert.equal(store.contact(aliceFs.id)?.access, "allowed");
      assert.equal(store.contact(aliceWx.id)?.access, null);

      // Note <= 2 KB succeeds; > 2 KB throws
      store.updatePerson(person.id, { note: "x".repeat(MAX_PERSON_NOTE_BYTES) });
      assert.throws(() => store.updatePerson(person.id, { note: "x".repeat(MAX_PERSON_NOTE_BYTES + 1) }), /2048/);

      // Regression (#22.3): agent merging an owner-linked person must NOT downgrade `linked_by = 'owner'` to `'agent'`
      const bob1 = store.touchContact(c1.id, "u_bob_1", "Bob 1");
      const bob2 = store.touchContact(c2.id, "u_bob_2", "Bob 2");
      const bob3 = store.touchContact(c1.id, "u_bob_3", "Bob 3");
      store.linkContacts([bob1.id, bob2.id], "owner");
      assert.equal(store.contact(bob1.id)?.linkedBy, "owner");
      assert.equal(store.contact(bob2.id)?.linkedBy, "owner");

      // Create separate person for bob3, then have agent merge bob3 + bob1
      store.ensurePerson(bob3.id);
      store.linkContacts([bob3.id, bob1.id], "agent");
      assert.equal(store.contact(bob1.id)?.linkedBy, "owner");
      assert.equal(store.contact(bob2.id)?.linkedBy, "owner");
      assert.equal(store.contact(bob3.id)?.linkedBy, "agent");
      // Agent MUST STILL be blocked from unlinking owner-linked contacts!
      assert.throws(() => store.unlinkContact(bob1.id, "agent"), /owner/i);
      assert.throws(() => store.unlinkContact(bob2.id, "agent"), /owner/i);
    } finally {
      store.close();
    }
  });

  it("blocks unseen/search/attachment on child threads when parent group is blocked (#22.2)", () => {
    const store = new Store(":memory:");
    try {
      const conn = store.createConnection({
        platform: "feishu",
        secretRef: "s-parent",
        lifecycleState: "active",
        ownerId: "owner-1",
        askAll: false,
      });
      const parent = store.upsertChat({ connectionId: conn.id, platformId: "grp-parent", kind: "group", name: "Parent" });
      store.setChatAccess(parent.id, "allowed");
      const threadMsg = store.ingestInbound(
        conn.id,
        "org",
        msg({
          platformId: "thr-bg-1",
          chat: { platformId: "grp-parent:root1", kind: "thread", parent: { platformId: "grp-parent", name: "Parent" } },
          text: "thread confidential update",
          addressedToBot: false,
          sentAt: 1_700_000_005_000,
        }),
      );
      assert.equal(threadMsg.kind, "background");
      assert.equal(store.unseen(threadMsg.chat.id, 1_700_000_010_000), 1);
      assert.equal(store.search("confidential").length, 1);

      // Block parent group -> child thread becomes blocked too!
      store.setChatAccess(parent.id, "blocked");
      assert.equal(store.isChatBlocked(threadMsg.chat.id), true);
      assert.equal(store.unseen(threadMsg.chat.id, 1_700_000_010_000), 0);
      assert.equal(store.search("confidential").length, 0);
    } finally {
      store.close();
    }
  });

  it("includes contactId on heldMessages so held DMs can be approved by contact", () => {
    const store = new Store(":memory:");
    try {
      const conn = store.createConnection({
        platform: "wechat",
        secretRef: "sec:held-dm",
        lifecycleState: "active",
        ownerId: "wx_owner",
      });
      const held = store.ingestInbound(
        conn.id,
        "owner",
        msg({
          platformId: "dm-held-1",
          chat: { platformId: "wx_alice", kind: "dm" },
          sender: { id: "wx_alice", name: "Alice", isBot: false },
          text: "Hi, can I chat?",
          addressedToBot: true,
        }),
      );
      assert.equal(held.kind, "held");
      const list = store.heldMessages(conn.id);
      assert.equal(list.length, 1);
      assert.equal(list[0]!.chat.kind, "dm");
      assert.ok(list[0]!.contactId, "held DM must expose contactId");

      store.setContactAccess(list[0]!.contactId!, "allowed");
      const toAdmit = store.heldMessagesForContact(list[0]!.contactId!);
      assert.equal(toAdmit.length, 1);
      store.moveInbound([toAdmit[0]!.id], "admit");
      assert.equal(store.heldMessages(conn.id).length, 0);
      assert.equal(store.listUnackedTriggers(conn.id).length, 1);
    } finally {
      store.close();
    }
  });

  it("defers triggers into paused_pending while Leader is paused, keeps /stop working, and replays selected items with original idempotency key", () => {
    const store = new Store(":memory:");
    try {
      const conn = store.createConnection({
        platform: "feishu",
        secretRef: null,
        lifecycleState: "active",
        ownerId: "owner_1",
      });
      // In-flight delivered message before pause must NOT be turned into ignored.
      const first = store.ingestInbound(
        conn.id,
        "public",
        msg({
          platformId: "m_inflight",
          chat: { platformId: "dm_owner", kind: "dm" },
          sender: { id: "owner_1", name: "Owner", isBot: false },
          text: "running task",
        }),
      );
      assert.equal(first.kind, "dispatch");
      // ACKed in-flight run stays `delivered` on Pause, whereas an unacked `delivered` row moves to `paused_pending` (S28)!
      store.ackInbound(
        { idempotencyKey: first.message.idempotencyKey! },
        { t3ThreadId: "xtwork-im-dm-acked", t3TurnId: "run-acked-1" },
      );
      const unackedDelivered = store.ingestInbound(
        conn.id,
        "public",
        msg({
          platformId: "m_unacked_delivered",
          chat: { platformId: "dm_owner", kind: "dm" },
          sender: { id: "owner_1", name: "Owner", isBot: false },
          text: "unacked delivered trigger",
        }),
      );
      assert.equal(unackedDelivered.kind, "dispatch");
      store.moveInbound([unackedDelivered.message.id], "deliver");
      assert.equal(store.message(unackedDelivered.message.id)?.state, "delivered");

      // Leader pauses: connection stays active, ACKed in-flight stays delivered, unacked delivered & new triggers enter paused_pending.
      store.updateConnection(conn.id, { leaderPaused: true });
      store.pauseConnectionMessages(conn.id);
      assert.equal(store.message(first.message.id)?.state, "delivered");
      assert.equal(store.message(unackedDelivered.message.id)?.state, "paused_pending");

      const deferred = store.ingestInbound(
        conn.id,
        "public",
        msg({
          platformId: "m_while_paused",
          chat: { platformId: "dm_owner", kind: "dm" },
          sender: { id: "owner_1", name: "Owner", isBot: false },
          text: "do this later",
        }),
      );
      assert.equal(deferred.kind, "paused_pending");
      assert.equal(deferred.message.state, "paused_pending");
      assert.equal(deferred.message.idempotencyKey, `im:${conn.id}:m_while_paused`);
      assert.equal(store.heldMessages(conn.id).length, 0);
      assert.equal(store.listUnackedTriggers(conn.id).length, 0);
      assert.equal(store.pausedPendingMessages([conn.id]).length, 2);

      // Verified Owner /stop still works while Leader is paused!
      const stopOutcome = store.ingestInbound(
        conn.id,
        "public",
        msg({
          platformId: "m_stop",
          chat: { platformId: "dm_owner", kind: "dm" },
          sender: { id: "owner_1", name: "Owner", isBot: false },
          text: "/stop",
        }),
      );
      assert.equal(stopOutcome.kind, "stop");

      // Resume Leader and selectively replay paused item under the exact original idempotency key.
      store.updateConnection(conn.id, { leaderPaused: false });
      const replayed = store.decidePausedPending([deferred.message.id], "replay");
      assert.equal(replayed.length, 1);
      assert.equal(replayed[0]!.state, "received");
      assert.equal(replayed[0]!.idempotencyKey, `im:${conn.id}:m_while_paused`);
      assert.equal(store.pausedPendingMessages([conn.id]).length, 1);
    } finally {
      store.close();
    }
  });

  it("reconciles ack arriving after pause into delivered so reply settles it, and preserves stamped Leader binding identity across rebinds (S3/S6)", () => {
    const store = new Store(":memory:");
    try {
      const conn = store.createConnection({
        platform: "feishu",
        secretRef: null,
        lifecycleState: "active",
        ownerId: "owner_1",
      });
      store.syncConnectionBinding({
        connectionId: conn.id,
        leaderId: "leader-a",
        bindingId: "bind-a-1",
        bindingEpoch: 1,
        leaderPaused: false,
      });

      // S3: Dispatched (`received`, unacked) -> paused -> late `ackInbound` arrives for committed run!
      const inFlight = store.ingestInbound(
        conn.id,
        "public",
        msg({
          platformId: "m_race",
          chat: { platformId: "dm_owner", kind: "dm" },
          sender: { id: "owner_1", name: "Owner", isBot: false },
          text: "committed before pause",
        }),
      );
      assert.equal(inFlight.kind, "dispatch");
      assert.equal(inFlight.message.leaderId, "leader-a");
      assert.equal(inFlight.message.bindingId, "bind-a-1");
      assert.equal(inFlight.message.bindingEpoch, 1);

      store.syncConnectionBinding({
        connectionId: conn.id,
        leaderId: "leader-a",
        bindingId: "bind-a-1",
        bindingEpoch: 1,
        leaderPaused: true,
      });
      assert.equal(store.message(inFlight.message.id)?.state, "paused_pending");

      // Committed run ack arrives -> MUST reconcile back to `delivered` and exit paused backlog!
      const acked = store.ackInbound(
        { idempotencyKey: inFlight.message.idempotencyKey! },
        { t3ThreadId: "xtwork-im-dm-1", t3TurnId: "run-committed-1" },
      );
      assert.equal(acked?.state, "delivered");
      assert.equal(store.pausedPendingMessages({ leaderId: "leader-a" }).length, 0);
      // Reply can now settle it!
      assert.deepEqual(store.moveInbound([inFlight.message.id], "reply"), [inFlight.message.id]);
      assert.equal(store.message(inFlight.message.id)?.state, "replied");

      // S6: New message paused under Leader A keeps Leader A binding even after connection rebinds to Leader B!
      const pausedA = store.ingestInbound(
        conn.id,
        "public",
        msg({
          platformId: "m_leader_a_backlog",
          chat: { platformId: "dm_owner", kind: "dm" },
          sender: { id: "owner_1", name: "Owner", isBot: false },
          text: "backlog for leader A",
        }),
      );
      assert.equal(pausedA.kind, "paused_pending");
      assert.equal(pausedA.message.leaderId, "leader-a");
      assert.equal(pausedA.message.bindingId, "bind-a-1");

      // Rebind connection to Leader B
      store.syncConnectionBinding({
        connectionId: conn.id,
        leaderId: "leader-b",
        bindingId: "bind-b-2",
        bindingEpoch: 2,
        leaderPaused: false,
      });
      assert.equal(store.pausedPendingMessages({ leaderId: "leader-b" }).length, 0);
      const leaderABacklog = store.pausedPendingMessages({ leaderId: "leader-a" });
      assert.equal(leaderABacklog.length, 1);
      assert.equal(leaderABacklog[0]!.id, pausedA.message.id);
      assert.equal(leaderABacklog[0]!.bindingId, "bind-a-1");
      assert.equal(leaderABacklog[0]!.bindingEpoch, 1);
    } finally {
      store.close();
    }
  });

  it("backfills legacy pre-Leader inbound rows to leader-default epoch 1 on migration (S6)", () => {
    const dir = mkdtempSync(join(tmpdir(), "xtwork-im-migrate-"));
    const dbPath = join(dir, "im.sqlite");
    try {
      // Seed an older v3 database with NULL leader_id / binding_id / binding_epoch on legacy inbound rows
      const initial = new Store(dbPath);
      const conn = initial.createConnection({
        platform: "feishu",
        secretRef: null,
        lifecycleState: "active",
        ownerId: "owner_1",
        askAll: true,
      });
      const held = initial.ingestInbound(
        conn.id,
        "public",
        msg({
          platformId: "legacy_held_1",
          chat: { platformId: "dm_stranger", kind: "dm" },
          sender: { id: "stranger_1", name: "Stranger", isBot: false },
          text: "hello before upgrade",
        }),
      );
      assert.equal(held.kind, "held");
      initial.close();

      const raw = new DatabaseSync(dbPath);
      raw.exec("UPDATE messages SET leader_id = NULL, binding_id = NULL, binding_epoch = NULL");
      raw.exec("PRAGMA user_version = 3");
      raw.close();

      // Reopen via Store -> runs v4 backfill
      const upgraded = new Store(dbPath);
      try {
        const backfilled = upgraded.message(held.message.id);
        assert.equal(backfilled?.leaderId, "leader-default");
        assert.equal(backfilled?.bindingId, null);
        assert.equal(backfilled?.bindingEpoch, 1);

        // Even after rebinding to Leader B, backlog queries use historical message identity
        upgraded.syncConnectionBinding({
          connectionId: conn.id,
          leaderId: "leader-b",
          bindingId: "bind-b-2",
          bindingEpoch: 2,
          leaderPaused: false,
        });
        upgraded.moveInbound([held.message.id], "admit");
        upgraded.moveInbound([held.message.id], "pause");
        assert.equal(upgraded.pausedPendingMessages({ leaderId: "leader-b" }).length, 0);
        assert.equal(upgraded.pausedPendingMessages({ leaderId: "leader-default" }).length, 1);
      } finally {
        upgraded.close();
      }
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it("backfills legacy ADR-011 DM thread pointers on upgrade and preserves them across initial default-binding sync (S20)", () => {
    const dir = mkdtempSync(join(tmpdir(), "xtwork-im-s20-"));
    const dbPath = join(dir, "im.sqlite");
    try {
      // Simulate an ADR-011 DB where DM chat already has thread_id and an acked message, before thread_* columns existed
      const initial = new Store(dbPath);
      const conn = initial.createConnection({
        platform: "feishu",
        secretRef: null,
        lifecycleState: "active",
        ownerId: "owner_1",
      });
      const dm = initial.ingestInbound(
        conn.id,
        "public",
        msg({
          platformId: "legacy_dm_1",
          chat: { platformId: "dm_owner", kind: "dm" },
          sender: { id: "owner_1", name: "Owner", isBot: false },
          text: "remember this dm",
        }),
      );
      assert.equal(dm.kind, "dispatch");
      initial.ackInbound({ idempotencyKey: dm.message.idempotencyKey! }, { t3ThreadId: "xtwork-im-dm-legacy", t3TurnId: "run-1" });
      initial.close();

      // Strip Leader-era pointer ownership columns to reproduce an ADR-011 pre-upgrade database
      const raw = new DatabaseSync(dbPath);
      raw.exec("UPDATE messages SET leader_id = NULL, binding_id = NULL, binding_epoch = NULL");
      raw.exec("UPDATE chats SET thread_leader_id = NULL, thread_binding_id = NULL, thread_binding_epoch = NULL");
      raw.exec("PRAGMA user_version = 1");
      raw.close();

      const upgraded = new Store(dbPath);
      try {
        const beforeSync = upgraded.chat(dm.chat.id);
        assert.equal(beforeSync?.threadId, "xtwork-im-dm-legacy");
        assert.equal(beforeSync?.threadLeaderId, "leader-default");
        assert.equal(beforeSync?.threadBindingEpoch, 1);

        // Initial default-binding sync MUST preserve the existing DM thread pointer and stamp bindingId
        upgraded.syncConnectionBinding({
          connectionId: conn.id,
          leaderId: "leader-default",
          bindingId: "bind-default-1",
          bindingEpoch: 1,
          leaderPaused: false,
        });
        const afterDefaultSync = upgraded.chat(dm.chat.id);
        assert.equal(afterDefaultSync?.threadId, "xtwork-im-dm-legacy");
        assert.equal(afterDefaultSync?.threadBindingId, "bind-default-1");

        // Rebinding to Leader B (epoch 2) MUST clear the stale pointer
        upgraded.syncConnectionBinding({
          connectionId: conn.id,
          leaderId: "leader-b",
          bindingId: "bind-b-2",
          bindingEpoch: 2,
          leaderPaused: false,
        });
        assert.equal(upgraded.chat(dm.chat.id)?.threadId, null);
      } finally {
        upgraded.close();
      }
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
});
