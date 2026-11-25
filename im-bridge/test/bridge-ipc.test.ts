import assert from "node:assert/strict";
import { mkdtempSync, readFileSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { PassThrough } from "node:stream";
import { describe, it } from "node:test";
import { BridgeError, ImBridge, PROTOCOL_VERSION, type RpcNotification, type RpcResponse, validateDownloadPath } from "../src/bridge.ts";
import { loadChannels } from "../src/channels/registry.ts";
import type {
  Channel,
  ChannelConnection,
  ChannelEvents,
  ConnectOptions,
  Credentials,
  InboundAttachment,
  OutboundMessage,
} from "../src/channels/channel.ts";
import { runDaemon } from "../src/main.ts";
import { memorySecrets, type SecretStore } from "../src/platform/secrets.ts";
import { Store } from "../src/store/store.ts";

function createMockChannel(opts: {
  readonly platform: "feishu" | "wecom" | "wechat";
  readonly trust?: "org" | "public" | "owner";
  readonly onboardOwnerId?: string;
  readonly requireCode?: boolean;
}) {
  let connectCount = 0;
  let lastEvents: ChannelEvents | undefined;
  let lastConnectOptions: ConnectOptions | undefined;
  const sent: OutboundMessage[] = [];
  const reactions: { chat: string; msg: string; state: string }[] = [];
  const liveUpdates: string[] = [];
  let closedCount = 0;

  const channel: Channel = {
    platform: opts.platform,
    trust: opts.trust ?? "public",
    onboarding: { kind: "qr" },

    async *onboard(_input, _signal, context) {
      yield { kind: "qr_ready", qrContent: "https://example.test/qr", expiresAt: Date.now() + 60_000 };
      if (opts.requireCode) {
        yield { kind: "needs_code" };
        const code = await context?.awaitCode?.();
        if (code !== "999111") {
          yield { kind: "failed", code: "denied" };
          return;
        }
      }
      yield {
        kind: "succeeded",
        credentials: { token: "super-secret-token-never-over-ipc" },
        bot: { id: `bot-${opts.platform}`, name: `Mock ${opts.platform}` },
        ...(opts.onboardOwnerId ? { ownerId: opts.onboardOwnerId } : {}),
      };
    },

    async connect(_credentials: Credentials, events: ChannelEvents, connectOpts?: ConnectOptions): Promise<ChannelConnection> {
      connectCount++;
      lastEvents = events;
      lastConnectOptions = connectOpts;
      events.onState({ kind: "connected" });
      return {
        bot: { id: `bot-${opts.platform}`, name: `Mock ${opts.platform}` },
        capabilities: () => ({
          quoteReply: true,
          reactions: true,
          typingIndicator: false,
          fileUpload: true,
          fileDownload: true,
          listMembers: false,
          maxTextLength: 4000,
        }),
        async send(message) {
          sent.push(message);
          return { kind: "sent", platformId: `out-${sent.length}` };
        },
        async react(chat, platformMessageId, state) {
          reactions.push({ chat: chat.platformId, msg: platformMessageId, state });
        },
        async startLive(_chat, liveOpts) {
          liveUpdates.push(`init:${liveOpts.initial}`);
          return {
            until: Date.now() + 60_000,
            async update(md) {
              liveUpdates.push(`upd:${md}`);
            },
            async finish(md) {
              liveUpdates.push(`fin:${md}`);
              return { kind: "sent", platformId: "live-out-1" };
            },
          };
        },
        async setTyping() {},
        async download(attachment: InboundAttachment, toPath: string) {
          writeFileSync(toPath, `downloaded:${attachment.id}:${attachment.name}`);
        },
        async listMembers() {
          return [];
        },
        async permissions() {
          return [{ id: "group_messages", granted: false, optional: true }];
        },
        async close() {
          closedCount++;
        },
      };
    },
  };

  return {
    channel,
    get connectCount() {
      return connectCount;
    },
    get closedCount() {
      return closedCount;
    },
    get events() {
      return lastEvents;
    },
    get connectOptions() {
      return lastConnectOptions;
    },
    sent,
    reactions,
    liveUpdates,
  };
}

describe("JSONL IPC daemon & ImBridge end-to-end", () => {
  it("runs hello handshake, idle silence, pairing claim, dispatch/ack, owner /stop, and shutdown over JSONL", async () => {
    const dataDir = mkdtempSync(join(tmpdir(), "im-bridge-ipc-"));
    const stdin = new PassThrough();
    const stdout = new PassThrough();
    const lines: (RpcResponse | RpcNotification)[] = [];
    let buffer = "";
    stdout.on("data", (chunk: Buffer) => {
      buffer += chunk.toString("utf8");
      let nl = buffer.indexOf("\n");
      while (nl !== -1) {
        const line = buffer.slice(0, nl).trim();
        buffer = buffer.slice(nl + 1);
        if (line) lines.push(JSON.parse(line) as RpcResponse | RpcNotification);
        nl = buffer.indexOf("\n");
      }
    });

    const waitFor = async (predicate: () => boolean, timeoutMs = 2000) => {
      const start = Date.now();
      while (!predicate()) {
        if (Date.now() - start > timeoutMs) throw new Error("Timed out waiting for JSONL message");
        await new Promise((r) => setTimeout(r, 10));
      }
    };

    const sendReq = async (id: number, method: string, params?: Record<string, unknown>): Promise<RpcResponse> => {
      stdin.write(`${JSON.stringify({ id, method, ...(params ? { params } : {}) })}\n`);
      await waitFor(() => lines.some((l) => "id" in l && l.id === id));
      return lines.find((l): l is RpcResponse => "id" in l && l.id === id)!;
    };

    const mock = createMockChannel({ platform: "wecom", trust: "org", requireCode: true });
    const secrets = memorySecrets();

    try {
      const { done } = await runDaemon({
        dataDir,
        stdin,
        stdout,
        secrets,
        channels: { wecom: mock.channel },
      });

      // Idle invariant: zero network connect calls before onboarding!
      assert.equal(mock.connectCount, 0);

      // 1. bridge.hello handshake
      const hello = await sendReq(1, "bridge.hello", { protocolVersion: PROTOCOL_VERSION });
      assert.equal(hello.ok, true);
      if (hello.ok) {
        const r = hello.result as Record<string, unknown>;
        assert.equal(r.protocolVersion, 1);
        assert.equal(r.nodeVersion, process.versions.node);
        assert.deepEqual(r.platforms, ["wecom"]);
      }

      // 2. Onboarding with needs_code -> submitCode -> enters pairing (no ownerId)
      const start = await sendReq(2, "onboarding.start", { platform: "wecom" });
      assert.equal(start.ok, true);
      const sessionId = (start.ok ? (start.result as { sessionId: string }).sessionId : "");

      await waitFor(() =>
        lines.some((l) => !("id" in l) && l.method === "onboarding.event" && (l.params.event as { kind: string }).kind === "needs_code"),
      );
      const sub = await sendReq(3, "onboarding.submitCode", { sessionId, code: "999111" });
      assert.equal(sub.ok, true);

      await waitFor(() =>
        lines.some((l) => !("id" in l) && l.method === "onboarding.event" && (l.params.event as { kind: string }).kind === "succeeded"),
      );

      // Verify raw credentials NEVER leaked in any IPC notification!
      const rawWire = JSON.stringify(lines);
      assert.equal(rawWire.includes("super-secret-token-never-over-ipc"), false);

      const succeededNote = lines.find(
        (l): l is RpcNotification =>
          !("id" in l) && l.method === "onboarding.event" && (l.params.event as { kind: string }).kind === "succeeded",
      )!;
      const evt = succeededNote.params.event as { connectionId: string; lifecycleState: string; claimCode: string };
      assert.equal(evt.lifecycleState, "pairing");
      assert.match(evt.claimCode, /^\d{6}$/);

      await waitFor(() => mock.connectCount === 1);

      // 3. In pairing state, random messages MUST NOT emit inbound.dispatch!
      await mock.events!.onMessage({
        platformId: "pair-noise",
        chat: { platformId: "u-stranger", kind: "dm" },
        sender: { id: "u-stranger", name: "Stranger", isBot: false },
        text: "hello wake T3",
        attachments: [],
        addressedToBot: true,
        sentAt: Date.now(),
      });
      assert.equal(
        lines.some((l) => !("id" in l) && l.method === "inbound.dispatch"),
        false,
      );

      // 4. Send valid 6-digit claim DM -> transitions to active WITHOUT emitting inbound.dispatch!
      await mock.events!.onMessage({
        platformId: "pair-claim",
        chat: { platformId: "u-owner", kind: "dm" },
        sender: { id: "u-owner", name: "Alice", isBot: false },
        text: evt.claimCode,
        attachments: [],
        addressedToBot: true,
        sentAt: Date.now(),
      });
      assert.equal(
        lines.some((l) => !("id" in l) && l.method === "inbound.dispatch"),
        false,
      );

      // 5. Non-owner sending `/stop` MUST NOT emit `inbound.stop`!
      await mock.events!.onMessage({
        platformId: "non-owner-stop",
        chat: { platformId: "grp-1", kind: "group", name: "Team" },
        sender: { id: "u-member", name: "Bob", isBot: false },
        text: "/stop",
        attachments: [],
        addressedToBot: true,
        sentAt: Date.now(),
      });
      assert.equal(
        lines.some((l) => !("id" in l) && l.method === "inbound.stop"),
        false,
      );
      const memberDispatch = lines.find(
        (l): l is RpcNotification => !("id" in l) && l.method === "inbound.dispatch" && l.params.platformMsgId === "non-owner-stop",
      )!;
      assert.equal(memberDispatch.params.senderRole, "member");
      assert.equal(memberDispatch.params.replyAudience, "group");
      assert.equal(memberDispatch.params.idempotencyKey, `im:${evt.connectionId}:non-owner-stop`);

      // 6. Verified owner sending `/stop` emits `inbound.stop` (and NOT `inbound.dispatch`)!
      await mock.events!.onMessage({
        platformId: "owner-stop",
        chat: { platformId: "u-owner", kind: "dm" },
        sender: { id: "u-owner", name: "Alice", isBot: false },
        text: "  /stop  ",
        attachments: [],
        addressedToBot: true,
        sentAt: Date.now(),
      });
      assert.equal(
        lines.some((l) => !("id" in l) && l.method === "inbound.stop" && l.params.platformMsgId === "owner-stop"),
        true,
      );
      assert.equal(
        lines.some((l) => !("id" in l) && l.method === "inbound.dispatch" && l.params.platformMsgId === "owner-stop"),
        false,
      );

      // 7. Ack + reply + live reply + permissions
      const ackRes = await sendReq(4, "inbound.ack", {
        idempotencyKey: `im:${evt.connectionId}:non-owner-stop`,
        t3ThreadId: "thr-99",
        t3TurnId: "turn-1",
      });
      assert.equal(ackRes.ok, true);

      const replyRes = await sendReq(5, "messages.reply", {
        messageId: memberDispatch.params.messageId,
        text: "Acknowledged from T3",
      });
      assert.equal(replyRes.ok, true);
      assert.equal(mock.sent.length, 1);

      const liveStart = await sendReq(6, "messages.liveStart", {
        chatId: memberDispatch.params.chatId,
        replyTo: memberDispatch.params.messageId,
        initial: "Working...",
      });
      assert.equal(liveStart.ok, true);
      const liveId = (liveStart.ok ? (liveStart.result as { liveId: string }).liveId : "");
      assert.equal((await sendReq(7, "messages.liveUpdate", { liveId, markdown: "Halfway..." })).ok, true);
      assert.equal((await sendReq(8, "messages.liveFinish", { liveId, markdown: "Done!" })).ok, true);
      assert.deepEqual(mock.liveUpdates, ["init:Working...", "upd:Halfway...", "fin:Done!"]);

      const perms = await sendReq(9, "connections.permissions", { connectionId: evt.connectionId });
      assert.equal(perms.ok, true);

      // 8. Graceful shutdown closes adapter and resolves daemon
      const shut = await sendReq(10, "bridge.shutdown");
      assert.equal(shut.ok, true);
      await done;
      assert.equal(mock.closedCount, 1);
    } finally {
      rmSync(dataDir, { recursive: true, force: true });
    }
  });

  it("enforces files.download allowedRoot confinement, fail-closed onboarding, sleep-wake reconnect, and crash redelivery", async () => {
    const allowedRoot = mkdtempSync(join(tmpdir(), "im-bridge-dl-root-"));
    const outsideDir = mkdtempSync(join(tmpdir(), "im-bridge-dl-out-"));
    const notifications: RpcNotification[] = [];
    let now = 1_700_000_000_000;

    const mock = createMockChannel({ platform: "feishu", trust: "public", onboardOwnerId: "u-owner" });
    const store = new Store(":memory:", () => now);
    const secrets = memorySecrets();

    try {
      // Path validation unit checks (including dangling symlink escape!)
      const isOutsideErr = (err: unknown) => err instanceof BridgeError && err.code === "PATH_OUTSIDE_ALLOWED_ROOT";
      assert.throws(() => validateDownloadPath("../escape.txt", allowedRoot), isOutsideErr);
      assert.throws(() => validateDownloadPath("/etc/passwd", allowedRoot), isOutsideErr);
      assert.throws(() => validateDownloadPath(`${allowedRoot}2/file.txt`, allowedRoot), isOutsideErr);
      const symlinkEscape = join(allowedRoot, "link-out");
      symlinkSync(outsideDir, symlinkEscape);
      assert.throws(() => validateDownloadPath(join(symlinkEscape, "evil.txt"), allowedRoot), isOutsideErr);
      const danglingEscape = join(allowedRoot, "dangling-out.txt");
      symlinkSync(join(outsideDir, "nonexistent.txt"), danglingEscape);
      assert.throws(() => validateDownloadPath(danglingEscape, allowedRoot), isOutsideErr);

      // Dynamic registry loads cleanly even standalone without adapter files present
      const loaded = await loadChannels({ feishu: mock.channel });
      assert.equal(loaded.feishu, mock.channel);

      // Fail-closed secret store blocks onboarding without creating DB connection
      const brokenSecrets: SecretStore = {
        async get() {
          throw new Error("no keychain");
        },
        async set() {
          throw new Error("OS keychain unavailable");
        },
        async delete() {},
      };
      const brokenNotifications: RpcNotification[] = [];
      const brokenBridge = new ImBridge({
        store: new Store(":memory:"),
        secrets: brokenSecrets,
        channels: { feishu: mock.channel },
        notify: (n) => brokenNotifications.push(n),
      });
      await brokenBridge.handleRequest({ id: 1, method: "onboarding.start", params: { platform: "feishu" } });
      await new Promise((r) => setTimeout(r, 30));
      assert.equal(brokenBridge.store.connections().length, 0);
      assert.equal(
        brokenNotifications.some(
          (n) => n.method === "onboarding.event" && (n.params.event as { code?: string }).code === "secret_store_unavailable",
        ),
        true,
      );
      await brokenBridge.shutdown();

      // Normal bridge: connect, test download confinement + sleep-wake + crash redelivery
      await secrets.set("sec:fs", JSON.stringify({ appId: "a", appSecret: "s" }));
      const conn = store.createConnection({
        platform: "feishu",
        secretRef: "sec:fs",
        lifecycleState: "active",
        ownerId: "u-owner",
      });
      store.setConnectionCursor(conn.id, "saved-cursor-42");

      const bridge = new ImBridge({
        store,
        secrets,
        channels: { feishu: mock.channel },
        notify: (n) => notifications.push(n),
        now: () => now,
        sleepCheckIntervalMs: 15_000,
        sleepDriftThresholdMs: 60_000,
      });
      await bridge.start();
      await new Promise((r) => setTimeout(r, 20));
      assert.equal(mock.connectCount, 1);
      assert.equal(mock.connectOptions?.initialCursor, "saved-cursor-42");

      // Inbound message with attachment from owner -> dispatches
      await mock.events!.onMessage({
        platformId: "m-att-1",
        chat: { platformId: "u-owner", kind: "dm" },
        sender: { id: "u-owner", name: "Owner", isBot: false },
        text: "See attached",
        attachments: [{ id: "att-remote-1", name: "report.txt" }],
        addressedToBot: true,
        sentAt: now,
      });
      const dispatched = notifications.find((n) => n.method === "inbound.dispatch")!;
      const fileId = (dispatched.params.attachments as { id: string }[])[0]!.id;

      // Download outside allowedRoot fails
      const badDl = await bridge.handleRequest({
        id: 20,
        method: "files.download",
        params: { fileId, destPath: join(outsideDir, "escape.txt"), allowedRoot },
      });
      assert.equal(badDl.ok, false);

      // Download inside allowedRoot succeeds
      const goodPath = join(allowedRoot, "sub", "report.txt");
      const goodDl = await bridge.handleRequest({
        id: 21,
        method: "files.download",
        params: { fileId, destPath: goodPath, allowedRoot },
      });
      assert.equal(goodDl.ok, true);
      assert.equal(readFileSync(goodPath, "utf8"), "downloaded:att-remote-1:report.txt");

      // Crash-recovery replay: since m-att-1 was NOT acked yet, replayUnackedTriggers re-dispatches it!
      notifications.length = 0;
      const replayed = bridge.replayUnackedTriggers();
      assert.equal(replayed, 1);
      assert.equal(notifications.filter((n) => n.method === "inbound.dispatch").length, 1);

      // Sleep-wake clock-drift detector: normal 15s tick does NOT reconnect; >60s jump DOES reconnect!
      now += 15_000;
      assert.equal(bridge.checkSleepWake(), false);
      assert.equal(mock.connectCount, 1);

      now += 90_000; // 75s drift beyond 15s interval (>60s)
      assert.equal(bridge.checkSleepWake(), true);
      await new Promise((r) => setTimeout(r, 20));
      assert.equal(mock.connectCount, 2);

      await bridge.shutdown();
    } finally {
      rmSync(allowedRoot, { recursive: true, force: true });
      rmSync(outsideDir, { recursive: true, force: true });
    }
  });

  it("enforces gate re-evaluation on access.decide, blocks reading threads under blocked groups, and validates inbound.settle (#22.1/2/5)", async () => {
    const notifications: RpcNotification[] = [];
    const mock = createMockChannel({ platform: "feishu", trust: "public", onboardOwnerId: "u-owner" });
    const store = new Store(":memory:");
    const secrets = memorySecrets();
    try {
      await secrets.set("sec:fs2", JSON.stringify({ appId: "a", appSecret: "s" }));
      const conn = store.createConnection({
        platform: "feishu",
        secretRef: "sec:fs2",
        lifecycleState: "active",
        ownerId: "u-owner",
        askAll: true,
      });
      const bridge = new ImBridge({
        store,
        secrets,
        channels: { feishu: mock.channel },
        notify: (n) => notifications.push(n),
      });
      await bridge.start();
      await new Promise((r) => setTimeout(r, 20));

      // Stranger sends BOTH a DM trigger AND a group @bot trigger in an unapproved group!
      await mock.events!.onMessage({
        platformId: "stranger-dm-1",
        chat: { platformId: "u-stranger", kind: "dm" },
        sender: { id: "u-stranger", name: "Stranger", isBot: false },
        text: "DM question",
        attachments: [],
        addressedToBot: true,
        sentAt: 1_700_000_001_000,
      });
      await mock.events!.onMessage({
        platformId: "stranger-grp-1",
        chat: { platformId: "grp-unapproved", kind: "group", name: "Unapproved Group" },
        sender: { id: "u-stranger", name: "Stranger", isBot: false },
        text: "Group secret question",
        attachments: [],
        addressedToBot: true,
        sentAt: 1_700_000_002_000,
      });

      const contact = store.contactByPlatformId(conn.id, "u-stranger")!;
      const unapprovedGroup = store.chatByPlatformId(conn.id, "grp-unapproved")!;
      assert.equal(store.heldMessages(conn.id).length, 2);

      // Approving ONLY the contact MUST admit the DM, while leaving the unapproved-group message HELD!
      notifications.length = 0;
      const decideContact = await bridge.handleRequest({
        id: 30,
        method: "access.decide",
        params: { targetKind: "contact", targetId: contact.id, decision: "allowed" },
      });
      assert.equal(decideContact.ok, true);
      const dispatches = notifications.filter((n) => n.method === "inbound.dispatch");
      assert.equal(dispatches.length, 1);
      assert.equal(dispatches[0]!.params.platformMsgId, "stranger-dm-1");

      // The unapproved group trigger MUST still be held and NOT searchable!
      const grpMsg = store.messageByPlatformId(conn.id, "stranger-grp-1")!;
      assert.equal(grpMsg.state, "held");
      assert.equal(store.search("Group secret question").length, 0);

      // Now approving the group admits the held group message!
      notifications.length = 0;
      const decideGroup = await bridge.handleRequest({
        id: 31,
        method: "access.decide",
        params: { targetKind: "chat", targetId: unapprovedGroup.id, decision: "allowed" },
      });
      assert.equal(decideGroup.ok, true);
      assert.equal(notifications.filter((n) => n.method === "inbound.dispatch").length, 1);
      assert.equal(store.messageByPlatformId(conn.id, "stranger-grp-1")?.state, "received");

      // Child thread under a blocked parent group MUST be rejected by messages.read (#22.2)
      const threadChat = store.upsertChat({
        connectionId: conn.id,
        platformId: "grp-unapproved:root1",
        kind: "thread",
        parentId: unapprovedGroup.id,
      });
      store.setChatAccess(unapprovedGroup.id, "blocked");
      const readBlockedThread = await bridge.handleRequest({
        id: 32,
        method: "messages.read",
        params: { chatId: threadChat.id },
      });
      assert.equal(readBlockedThread.ok, false);
      if (!readBlockedThread.ok) assert.equal(readBlockedThread.error.code, "CHAT_BLOCKED");

      // Invalid inbound.settle event MUST return INVALID_PARAMS (#22.5)
      const dmMsg = store.messageByPlatformId(conn.id, "stranger-dm-1")!;
      const badSettle = await bridge.handleRequest({
        id: 33,
        method: "inbound.settle",
        params: { messageId: dmMsg.id, event: "__proto__" },
      });
      assert.equal(badSettle.ok, false);
      if (!badSettle.ok) assert.equal(badSettle.error.code, "INVALID_PARAMS");

      await bridge.shutdown();
    } finally {
      // store already closed by bridge.shutdown()
    }
  });

  it("defers startup replay until connections.syncBindings and validates pause + access gate before replaying paused_pending (S4/S5/S6)", async () => {
    const store = new Store(":memory:");
    const notifications: RpcNotification[] = [];
    const mock = createMockChannel({ platform: "feishu", trust: "org" });
    const bridge = new ImBridge({
      store,
      secrets: memorySecrets(),
      channels: { feishu: mock.channel },
      notify: (n) => notifications.push(n),
      sleepCheckIntervalMs: 0,
    });
    try {
      const conn = store.createConnection({
        platform: "feishu",
        lifecycleState: "active",
        ownerId: "owner-1",
        askAll: false,
      });
      // Unacked trigger exists before restart
      const preRestart = store.ingestInbound(conn.id, "org", {
        platformId: "pre-restart-1",
        chat: { platformId: "grp-1", kind: "group", name: "Ops" },
        sender: { id: "alice", name: "Alice", isBot: false },
        text: "pending before restart",
        attachments: [],
        addressedToBot: true,
        sentAt: 1_700_000_000_000,
      });
      assert.equal(preRestart.kind, "dispatch");

      // S4: hello with deferReplay=true does NOT emit dispatch until syncBindings reconciles leaderPaused!
      const hello = await bridge.handleRequest({
        id: 1,
        method: "bridge.hello",
        params: { protocolVersion: 1, deferReplay: true },
      });
      assert.equal(hello.ok, true);
      await new Promise((r) => setTimeout(r, 15));
      assert.equal(notifications.filter((n) => n.method === "inbound.dispatch").length, 0);

      // Sync leaderPaused=true + binding BEFORE triggering replay -> pre-restart message moves into paused_pending, NOT dispatched!
      const synced = await bridge.handleRequest({
        id: 2,
        method: "connections.syncBindings",
        params: {
          bindings: [
            {
              connectionId: conn.id,
              leaderId: "leader-default",
              bindingId: "bind-1",
              bindingEpoch: 1,
              leaderPaused: true,
            },
          ],
          triggerReplay: true,
        },
      });
      assert.equal(synced.ok, true);
      await new Promise((r) => setTimeout(r, 15));
      assert.equal(notifications.filter((n) => n.method === "inbound.dispatch").length, 0);
      assert.equal(store.message(preRestart.message.id)?.state, "paused_pending");

      // S5 (part 1): Replay click while still paused MUST NOT strand message out of paused_pending!
      const staleReplay = await bridge.handleRequest({
        id: 3,
        method: "paused.decide",
        params: { messageIds: [preRestart.message.id], decision: "replay", leaderId: "leader-default" },
      });
      assert.equal(staleReplay.ok, true);
      if (staleReplay.ok) {
        const res = staleReplay.result as { count: number; skippedIds: string[] };
        assert.equal(res.count, 0);
        assert.deepEqual(res.skippedIds, [preRestart.message.id]);
      }
      assert.equal(store.message(preRestart.message.id)?.state, "paused_pending");

      // S5 (part 2): Block the chat while paused, then unpause and attempt replay -> MUST block and NEVER dispatch!
      store.setChatAccess(preRestart.chat.id, "blocked");
      await bridge.handleRequest({
        id: 4,
        method: "connections.setLeaderPaused",
        params: { connectionIds: [conn.id], paused: false },
      });
      const blockedReplay = await bridge.handleRequest({
        id: 5,
        method: "paused.decide",
        params: { messageIds: [preRestart.message.id], decision: "replay", leaderId: "leader-default" },
      });
      assert.equal(blockedReplay.ok, true);
      if (blockedReplay.ok) {
        const res = blockedReplay.result as { count: number; blockedIds: string[] };
        assert.equal(res.count, 0);
        assert.deepEqual(res.blockedIds, [preRestart.message.id]);
      }
      assert.equal(store.message(preRestart.message.id)?.state, "blocked");
      assert.equal(notifications.filter((n) => n.method === "inbound.dispatch").length, 0);

      await bridge.shutdown();
    } finally {
      // store already closed by bridge.shutdown()
    }
  });
});
