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
        secretRef: null,
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

      // S4: Pausing default Leader MUST NOT overwrite pause flag on a connection bound to another Leader!
      const connB = store.createConnection({
        platform: "feishu",
        secretRef: null,
        lifecycleState: "active",
        ownerId: "owner-1",
      });
      store.syncConnectionBinding({
        connectionId: connB.id,
        leaderId: "leader-b",
        bindingId: "bind-b-1",
        bindingEpoch: 1,
        leaderPaused: false,
      });
      const pauseDefaultOnly = await bridge.handleRequest({
        id: 6,
        method: "connections.syncBindings",
        params: { bindings: [], defaultLeaderPaused: true },
      });
      assert.equal(pauseDefaultOnly.ok, true);
      assert.equal(store.connection(connB.id)?.leaderPaused, false);

      // S6: Pre-sync message (`leader-default / null / epoch 1`) replayed after rebind MUST NOT mix in Leader B's bindingId!
      const connC = store.createConnection({
        platform: "feishu",
        secretRef: null,
        lifecycleState: "active",
        ownerId: "owner-1",
        askAll: false,
      });
      store.updateConnection(connC.id, { leaderPaused: true });
      const preSyncMsg = store.ingestInbound(connC.id, "org", {
        platformId: "pre-sync-msg",
        chat: { platformId: "grp-c", kind: "group", name: "Group C" },
        sender: { id: "alice", name: "Alice", isBot: false },
        text: "arrived before first binding sync",
        attachments: [],
        addressedToBot: true,
        sentAt: 1_700_000_010_000,
      });
      assert.equal(preSyncMsg.kind, "paused_pending");
      assert.equal(preSyncMsg.message.leaderId, "leader-default");
      assert.equal(preSyncMsg.message.bindingId, null);
      assert.equal(preSyncMsg.message.bindingEpoch, 1);

      // Rebind connC to Leader B
      store.syncConnectionBinding({
        connectionId: connC.id,
        leaderId: "leader-b",
        bindingId: "bind-c-2",
        bindingEpoch: 2,
        leaderPaused: false,
      });
      notifications.length = 0;
      const replayedPreSync = await bridge.handleRequest({
        id: 7,
        method: "paused.decide",
        params: { messageIds: [preSyncMsg.message.id], decision: "replay", leaderId: "leader-default" },
      });
      assert.equal(replayedPreSync.ok, true);
      const dispatches = notifications.filter((n) => n.method === "inbound.dispatch");
      assert.equal(dispatches.length, 1);
      assert.equal(dispatches[0]!.params.leaderId, "leader-default");
      assert.equal(dispatches[0]!.params.bindingId, null);
      assert.equal(dispatches[0]!.params.bindingEpoch, 1);

      // S14: Deferring ONLY a historical paused Leader A message via inbound.settle + syncing Leader B's active binding
      // MUST leave Leader B's queued message on connC completely untouched (in `received`, NOT `paused_pending`).
      const leaderBMsg = store.ingestInbound(connC.id, "org", {
        platformId: "leader-b-msg",
        chat: { platformId: "grp-c", kind: "group", name: "Group C" },
        sender: { id: "bob", name: "Bob", isBot: false },
        text: "for active leader B",
        attachments: [],
        addressedToBot: true,
        sentAt: 1_700_000_020_000,
      });
      assert.equal(leaderBMsg.kind, "dispatch");
      const deferOnlyA = await bridge.handleRequest({
        id: 8,
        method: "inbound.settle",
        params: { idempotencyKey: preSyncMsg.message.idempotencyKey, event: "pause" },
      });
      assert.equal(deferOnlyA.ok, true);
      await bridge.handleRequest({
        id: 9,
        method: "connections.syncBindings",
        params: {
          bindings: [
            {
              connectionId: connC.id,
              leaderId: "leader-b",
              bindingId: "bind-c-2",
              bindingEpoch: 2,
              leaderPaused: false,
            },
          ],
        },
      });
      assert.equal(store.message(preSyncMsg.message.id)?.state, "paused_pending");
      assert.equal(store.message(leaderBMsg.message.id)?.state, "received");
      assert.equal(store.connection(connC.id)?.leaderPaused, false);

      // S6: Legacy held row (with null leader/binding/epoch before backfill or from v2 upgrade) approved
      // AFTER rebinding connC to Leader B MUST still dispatch under ('leader-default', null, 1), NEVER Leader B!
      const connLegacy = store.createConnection({
        platform: "wechat",
        secretRef: null,
        lifecycleState: "active",
        ownerId: "owner-1",
        askAll: true,
      });
      const legacyHeld = store.ingestInbound(connLegacy.id, "public", {
        platformId: "legacy-held-1",
        chat: { platformId: "dm-stranger", kind: "dm" },
        sender: { id: "stranger-1", name: "Stranger", isBot: false },
        text: "held before upgrade",
        attachments: [],
        addressedToBot: true,
        sentAt: 1_700_000_030_000,
      });
      assert.equal(legacyHeld.kind, "held");
      // Simulate pre-v3 schema where message tuple columns were NULL
      (store as unknown as { db: { prepare: (s: string) => { run: (...a: unknown[]) => void } } }).db
        .prepare("UPDATE messages SET leader_id = NULL, binding_id = NULL, binding_epoch = NULL WHERE id = ?")
        .run(legacyHeld.message.id);
      store.syncConnectionBinding({
        connectionId: connLegacy.id,
        leaderId: "leader-b",
        bindingId: "bind-legacy-2",
        bindingEpoch: 2,
        leaderPaused: false,
      });
      notifications.length = 0;
      const admitted = await bridge.handleRequest({
        id: 10,
        method: "access.decide",
        params: { targetKind: "contact", targetId: legacyHeld.contact.id, decision: "allowed" },
      });
      assert.equal(admitted.ok, true);
      const legacyDispatches = notifications.filter((n) => n.method === "inbound.dispatch");
      assert.equal(legacyDispatches.length, 1);
      assert.equal(legacyDispatches[0]!.params.leaderId, "leader-default");
      assert.equal(legacyDispatches[0]!.params.bindingId, null);
      assert.equal(legacyDispatches[0]!.params.bindingEpoch, 1);

      await bridge.shutdown();
    } finally {
      // store already closed by bridge.shutdown()
    }
  });

  it("deduplicates final sends across liveFinish/reply (S17), isolates Leader pause across rebind (S18), and scopes DM /stop pointers to current binding (S19)", async () => {
    const store = new Store(":memory:");
    const secrets = memorySecrets();
    const notifications: RpcNotification[] = [];
    const mock = createMockChannel({ platform: "feishu", trust: "org", onboardOwnerId: "owner-1" });
    const bridge = new ImBridge({
      store,
      secrets,
      channels: { feishu: mock.channel },
      notify: (n) => notifications.push(n),
      sleepCheckIntervalMs: 0,
    });
    try {
      await bridge.start();
      // Onboard + connect live feishu connection
      const started = await bridge.handleRequest({
        id: 1,
        method: "onboarding.start",
        params: { platform: "feishu", mode: "qr" },
      });
      assert.equal(started.ok, true);
      await new Promise((r) => setTimeout(r, 30));
      const conn = store.connections()[0]!;
      assert.equal(conn.lifecycleState, "active");

      // Bind to Leader A (epoch 1)
      store.syncConnectionBinding({
        connectionId: conn.id,
        leaderId: "leader-a",
        bindingId: "bind-a-1",
        bindingEpoch: 1,
        leaderPaused: false,
      });

      // S17: Live finish + fallback reply sharing ONE operationKey MUST send only once!
      const msg1 = store.ingestInbound(conn.id, "org", {
        platformId: "s17-m1",
        chat: { platformId: "dm-owner", kind: "dm" },
        sender: { id: "owner-1", name: "Owner", isBot: false },
        text: "summarize report",
        attachments: [],
        addressedToBot: true,
        sentAt: 1_700_000_100_000,
      });
      assert.equal(msg1.kind, "dispatch");
      store.moveInbound([msg1.message.id], "deliver");
      const liveStart = await bridge.handleRequest({
        id: 2,
        method: "messages.liveStart",
        params: { chatId: msg1.chat.id, replyTo: msg1.message.id, initial: "Working..." },
      });
      assert.equal(liveStart.ok, true);
      const liveId = (liveStart.ok ? (liveStart.result as { liveId: string }).liveId : "");
      const sharedOpKey = `${msg1.message.idempotencyKey}:final`;
      const fin = await bridge.handleRequest({
        id: 3,
        method: "messages.liveFinish",
        params: { liveId, markdown: "Final answer!", operationKey: sharedOpKey },
      });
      assert.equal(fin.ok, true);
      assert.equal(mock.sent.length, 0);
      assert.equal(mock.liveUpdates.filter((u) => u.startsWith("fin:")).length, 1);

      // Simulate dropped RPC response -> fallback messages.reply with SAME operationKey MUST NOT send a second message!
      const fallback = await bridge.handleRequest({
        id: 4,
        method: "messages.reply",
        params: { messageId: msg1.message.id, text: "Final answer!", operationKey: sharedOpKey },
      });
      assert.equal(fallback.ok, true);
      assert.equal(mock.sent.length, 0);
      if (fallback.ok) {
        assert.equal((fallback.result as { deduplicated?: boolean }).deduplicated, true);
      }

      // Also test direct messages.reply retry with same operationKey sends only ONCE!
      const msg2 = store.ingestInbound(conn.id, "org", {
        platformId: "s17-m2",
        chat: { platformId: "dm-owner", kind: "dm" },
        sender: { id: "owner-1", name: "Owner", isBot: false },
        text: "second task",
        attachments: [],
        addressedToBot: true,
        sentAt: 1_700_000_101_000,
      });
      assert.equal(msg2.kind, "dispatch");
      store.moveInbound([msg2.message.id], "deliver");
      const replyOpKey = `${msg2.message.idempotencyKey}:final`;
      const firstReply = await bridge.handleRequest({
        id: 5,
        method: "messages.reply",
        params: { messageId: msg2.message.id, text: "Done!", operationKey: replyOpKey },
      });
      assert.equal(firstReply.ok, true);
      assert.equal(mock.sent.length, 1);
      const retryReply = await bridge.handleRequest({
        id: 6,
        method: "messages.reply",
        params: { messageId: msg2.message.id, text: "Done!", operationKey: replyOpKey },
      });
      assert.equal(retryReply.ok, true);
      assert.equal(mock.sent.length, 1);

      // S18: Rebind from active Leader A to PAUSED Leader B -> A's queued trigger & paused backlog MUST NOT be blocked by B's pause!
      const msgAQueued = store.ingestInbound(conn.id, "org", {
        platformId: "s18-a-queued",
        chat: { platformId: "dm-owner", kind: "dm" },
        sender: { id: "owner-1", name: "Owner", isBot: false },
        text: "queued for A",
        attachments: [],
        addressedToBot: true,
        sentAt: 1_700_000_102_000,
      });
      assert.equal(msgAQueued.kind, "dispatch");
      const msgABacklog = store.ingestInbound(conn.id, "org", {
        platformId: "s18-a-backlog",
        chat: { platformId: "dm-owner", kind: "dm" },
        sender: { id: "owner-1", name: "Owner", isBot: false },
        text: "backlog for A",
        attachments: [],
        addressedToBot: true,
        sentAt: 1_700_000_103_000,
      });
      assert.equal(msgABacklog.kind, "dispatch");
      store.moveInbound([msgABacklog.message.id], "pause");

      // Rebind conn to PAUSED Leader B (epoch 2)
      store.syncConnectionBinding({
        connectionId: conn.id,
        leaderId: "leader-b",
        bindingId: "bind-b-2",
        bindingEpoch: 2,
        leaderPaused: true,
      });
      const msgBPaused = store.ingestInbound(conn.id, "org", {
        platformId: "s18-b-paused",
        chat: { platformId: "dm-owner", kind: "dm" },
        sender: { id: "owner-1", name: "Owner", isBot: false },
        text: "paused for B",
        attachments: [],
        addressedToBot: true,
        sentAt: 1_700_000_104_000,
      });
      assert.equal(msgBPaused.kind, "paused_pending");

      // Startup recovery (`listUnackedTriggers`) STILL returns A's queued message even while B is paused!
      const unacked = store.listUnackedTriggers(conn.id);
      assert.equal(unacked.some((m) => m.id === msgAQueued.message.id), true);
      assert.equal(unacked.some((m) => m.id === msgBPaused.message.id), false);

      // Manual replay of A's backlog SUCCEEDS while B is paused, whereas B's backlog is skipped!
      notifications.length = 0;
      const replayA = await bridge.handleRequest({
        id: 7,
        method: "paused.decide",
        params: { messageIds: [msgABacklog.message.id], decision: "replay", leaderId: "leader-a" },
      });
      assert.equal(replayA.ok, true);
      if (replayA.ok) {
        assert.equal((replayA.result as { count: number }).count, 1);
      }
      const replayB = await bridge.handleRequest({
        id: 8,
        method: "paused.decide",
        params: { messageIds: [msgBPaused.message.id], decision: "replay", leaderId: "leader-b" },
      });
      assert.equal(replayB.ok, true);
      if (replayB.ok) {
        assert.equal((replayB.result as { count: number; skippedIds: string[] }).count, 0);
        assert.deepEqual((replayB.result as { skippedIds: string[] }).skippedIds, [msgBPaused.message.id]);
      }

      // S19: Resume Leader B, ACK B's DM (`thread-B`), then a delayed ACK from A (`thread-A`) arrives ->
      // A's delayed ACK MUST stay on A's message row and NEVER overwrite B's chat pointer or hijack `/stop`!
      store.syncConnectionBinding({
        connectionId: conn.id,
        leaderId: "leader-b",
        bindingId: "bind-b-2",
        bindingEpoch: 2,
        leaderPaused: false,
      });
      const msgBActive = store.ingestInbound(conn.id, "org", {
        platformId: "s19-b-active",
        chat: { platformId: "dm-owner", kind: "dm" },
        sender: { id: "owner-1", name: "Owner", isBot: false },
        text: "run for B",
        attachments: [],
        addressedToBot: true,
        sentAt: 1_700_000_105_000,
      });
      assert.equal(msgBActive.kind, "dispatch");
      store.ackInbound(
        { idempotencyKey: msgBActive.message.idempotencyKey! },
        { t3ThreadId: "thread-B", t3TurnId: "run-B-1" },
      );
      assert.equal(store.chat(msgBActive.chat.id)?.threadId, "thread-B");

      // Delayed ACK for historical Leader A message arrives AFTER rebind to B!
      const ackedA = store.ackInbound(
        { idempotencyKey: msgAQueued.message.idempotencyKey! },
        { t3ThreadId: "thread-A", t3TurnId: "run-A-1" },
      );
      assert.equal(ackedA?.t3ThreadId, "thread-A");
      assert.equal(store.chat(msgBActive.chat.id)?.threadId, "thread-B");

      // Owner sends `/stop` -> MUST emit `threadId: "thread-B"` (NOT `"thread-A"`)!
      notifications.length = 0;
      await mock.events!.onMessage({
        platformId: "s19-stop-1",
        chat: { platformId: "dm-owner", kind: "dm" },
        sender: { id: "owner-1", name: "Owner", isBot: false },
        text: "/stop",
        attachments: [],
        addressedToBot: true,
        sentAt: 1_700_000_106_000,
      });
      const stops = notifications.filter((n) => n.method === "inbound.stop");
      assert.equal(stops.length, 1);
      assert.equal(stops[0]!.params.threadId, "thread-B");
      assert.equal(stops[0]!.params.leaderId, "leader-b");
      assert.equal(stops[0]!.params.bindingEpoch, 2);

      // Rebind to Leader C (epoch 3) before C ACKs anything -> stale pointer cleared, `/stop` emits `threadId: null`!
      store.syncConnectionBinding({
        connectionId: conn.id,
        leaderId: "leader-c",
        bindingId: "bind-c-3",
        bindingEpoch: 3,
        leaderPaused: false,
      });
      notifications.length = 0;
      await mock.events!.onMessage({
        platformId: "s19-stop-2",
        chat: { platformId: "dm-owner", kind: "dm" },
        sender: { id: "owner-1", name: "Owner", isBot: false },
        text: "/stop",
        attachments: [],
        addressedToBot: true,
        sentAt: 1_700_000_107_000,
      });
      const stopsAfterC = notifications.filter((n) => n.method === "inbound.stop");
      assert.equal(stopsAfterC.length, 1);
      assert.equal(stopsAfterC[0]!.params.threadId, null);

      await bridge.shutdown();
    } finally {
      // store closed by bridge.shutdown()
    }
  });
});
