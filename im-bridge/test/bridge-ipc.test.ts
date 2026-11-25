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
      // Restore leader-default to active before testing S6 historical replay / held approval for active leader-default.
      await bridge.handleRequest({
        id: 601,
        method: "connections.syncBindings",
        params: { bindings: [], defaultLeaderPaused: false },
      });

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

      // S17: Recovered `pending` outbound row (crash after provider accepted liveFinish before result persistence)
      // MUST be promoted to `uncertain` on retry via messages.reply and NEVER send a second message!
      const msgCrash = store.ingestInbound(conn.id, "org", {
        platformId: "s17-crash-pending",
        chat: { platformId: "dm-owner", kind: "dm" },
        sender: { id: "owner-1", name: "Owner", isBot: false },
        text: "crash mid-finish",
        attachments: [],
        addressedToBot: true,
        sentAt: 1_700_000_101_500,
      });
      assert.equal(msgCrash.kind, "dispatch");
      store.moveInbound([msgCrash.message.id], "deliver");
      const crashOpKey = `${msgCrash.message.idempotencyKey}:final`;
      const pendingOut = store.insertOutbound({
        connectionId: conn.id,
        chatId: msgCrash.chat.id,
        body: "Already sent before crash",
        replyTo: msgCrash.message.id,
        operationKey: crashOpKey,
      });
      assert.equal(pendingOut.state, "pending");
      const recoveredRetry = await bridge.handleRequest({
        id: 601,
        method: "messages.reply",
        params: { messageId: msgCrash.message.id, text: "Already sent before crash", operationKey: crashOpKey },
      });
      assert.equal(recoveredRetry.ok, true);
      assert.equal(mock.sent.length, 1);
      if (recoveredRetry.ok) {
        const res = recoveredRetry.result as { deduplicated?: boolean; result?: { kind?: string } };
        assert.equal(res.deduplicated, true);
        assert.equal(res.result?.kind, "uncertain");
      }
      assert.equal(store.message(pendingOut.id)?.state, "uncertain");
      assert.equal(store.message(msgCrash.message.id)?.state, "replied");

      // S17: Retrying `messages.liveFinish` after bridge restart (in-memory live handle is gone!)
      // MUST STILL settle the inbound row via the persisted outbound row's `replyTo`!
      const msgCrashLive = store.ingestInbound(conn.id, "org", {
        platformId: "s17-crash-live-restart",
        chat: { platformId: "dm-owner", kind: "dm" },
        sender: { id: "owner-1", name: "Owner", isBot: false },
        text: "crash mid-liveFinish before restart",
        attachments: [],
        addressedToBot: true,
        sentAt: 1_700_000_101_750,
      });
      assert.equal(msgCrashLive.kind, "dispatch");
      store.moveInbound([msgCrashLive.message.id], "deliver");
      const liveCrashOpKey = `${msgCrashLive.message.idempotencyKey}:final`;
      const pendingLiveOut = store.insertOutbound({
        connectionId: conn.id,
        chatId: msgCrashLive.chat.id,
        body: "Finished before restart",
        replyTo: msgCrashLive.message.id,
        operationKey: liveCrashOpKey,
      });
      assert.equal(pendingLiveOut.state, "pending");
      // Call messages.liveFinish with a dead liveId (not in liveReplies map, simulating bridge restart)
      const retriedLiveFinish = await bridge.handleRequest({
        id: 602,
        method: "messages.liveFinish",
        params: { liveId: "live-gone-after-restart", markdown: "Finished before restart", operationKey: liveCrashOpKey },
      });
      assert.equal(retriedLiveFinish.ok, true);
      assert.equal(mock.sent.length, 1);
      if (retriedLiveFinish.ok) {
        const res = retriedLiveFinish.result as { deduplicated?: boolean; result?: { kind?: string } };
        assert.equal(res.deduplicated, true);
        assert.equal(res.result?.kind, "uncertain");
      }
      assert.equal(store.message(pendingLiveOut.id)?.state, "uncertain");
      assert.equal(store.message(msgCrashLive.message.id)?.state, "replied");

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

      // S23: Bridge stamps observed `pauseGeneration` on emit, updates on syncBindings, and emits
      // fresh `pauseGeneration` on explicit `paused.decide` replay with the original idempotencyKey!
      notifications.length = 0;
      await mock.events!.onMessage({
        platformId: "s23-pre-pause",
        chat: { platformId: "dm-owner", kind: "dm" },
        sender: { id: "owner-1", name: "Owner", isBot: false },
        text: "emitted before bridge sees pause",
        attachments: [],
        addressedToBot: true,
        sentAt: 1_700_000_108_000,
      });
      const prePauseDispatches = notifications.filter((n) => n.method === "inbound.dispatch");
      assert.equal(prePauseDispatches.length, 1);
      assert.equal(prePauseDispatches[0]!.params.pauseGeneration, 0);
      const s23MsgId = String(prePauseDispatches[0]!.params.messageId);
      const s23Key = String(prePauseDispatches[0]!.params.idempotencyKey);

      // Pause sync arrives at bridge (gen=1) -> moves unacked message to `paused_pending`
      await bridge.handleRequest({
        id: 230,
        method: "connections.syncBindings",
        params: {
          bindings: [
            {
              connectionId: conn.id,
              leaderId: "leader-c",
              bindingId: "bind-c-3",
              bindingEpoch: 3,
              leaderPaused: true,
              pauseGeneration: 1,
            },
          ],
          leaderPauseGenerations: { "leader-c": 1 },
        },
      });
      assert.equal(store.getLeaderPauseGeneration("leader-c"), 1);
      assert.equal(store.message(s23MsgId)?.state, "paused_pending");

      // Resume sync arrives (gen=1, unpaused) -> message stays in `paused_pending`
      await bridge.handleRequest({
        id: 231,
        method: "connections.syncBindings",
        params: {
          bindings: [
            {
              connectionId: conn.id,
              leaderId: "leader-c",
              bindingId: "bind-c-3",
              bindingEpoch: 3,
              leaderPaused: false,
              pauseGeneration: 1,
            },
          ],
          leaderPauseGenerations: { "leader-c": 1 },
        },
      });
      assert.equal(store.message(s23MsgId)?.state, "paused_pending");

      // Explicit Replay stamps fresh pauseGeneration=1 with original idempotencyKey!
      notifications.length = 0;
      const replayedS23 = await bridge.handleRequest({
        id: 232,
        method: "paused.decide",
        params: { messageIds: [s23MsgId], decision: "replay", leaderId: "leader-c", pauseGeneration: 1 },
      });
      assert.equal(replayedS23.ok, true);
      const postReplayDispatches = notifications.filter((n) => n.method === "inbound.dispatch");
      assert.equal(postReplayDispatches.length, 1);
      assert.equal(postReplayDispatches[0]!.params.idempotencyKey, s23Key);
      assert.equal(postReplayDispatches[0]!.params.pauseGeneration, 1);

      await bridge.shutdown();
    } finally {
      // store closed by bridge.shutdown()
    }
  });

  it("preserves pause_generation on startup redelivery (S24), inherits default pause on new onboarding (S25), and defers held approvals during pause (S26)", async () => {
    const dir = mkdtempSync(join(tmpdir(), "xtwork-s24-s26-"));
    const dbPath = join(dir, "im.sqlite");
    try {
      // S24: Message becomes dispatchable at generation 0, bridge goes down, Pause + Resume happen while down
      {
        const store1 = new Store(dbPath);
        const notifications1: RpcNotification[] = [];
        const mock1 = createMockChannel({ platform: "feishu", trust: "org", onboardOwnerId: "owner-1" });
        const bridge1 = new ImBridge({
          store: store1,
          secrets: memorySecrets(),
          channels: { feishu: mock1.channel },
          notify: (n) => notifications1.push(n),
          sleepCheckIntervalMs: 0,
        });
        await bridge1.start();
        const conn = store1.createConnection({
          platform: "feishu",
          secretRef: null,
          lifecycleState: "active",
          ownerId: "owner-1",
          askAll: false,
        });
        const ingested = store1.ingestInbound(conn.id, "org", {
          platformId: "s24-down-msg",
          chat: { platformId: "dm-owner", kind: "dm" },
          sender: { id: "owner-1", name: "Owner", isBot: false },
          text: "arrived at gen 0 before crash",
          attachments: [],
          addressedToBot: true,
          sentAt: 1_700_000_200_000,
        });
        assert.equal(ingested.kind, "dispatch");
        assert.equal(ingested.message.pauseGeneration, 0);
        await bridge1.shutdown();
      }

      // Bridge restarts AFTER Pause (0 -> 1) + Resume (active, gen=1) happened while down
      {
        const store2 = new Store(dbPath);
        const notifications2: RpcNotification[] = [];
        const mock2 = createMockChannel({ platform: "feishu", trust: "org", onboardOwnerId: "owner-1" });
        const bridge2 = new ImBridge({
          store: store2,
          secrets: memorySecrets(),
          channels: { feishu: mock2.channel },
          notify: (n) => notifications2.push(n),
          sleepCheckIntervalMs: 0,
        });
        const conn = store2.connections()[0]!;
        await bridge2.handleRequest({ id: 1, method: "bridge.hello", params: { protocolVersion: 1, deferReplay: true } });
        await bridge2.handleRequest({
          id: 2,
          method: "connections.syncBindings",
          params: {
            bindings: [
              {
                connectionId: conn.id,
                leaderId: "leader-default",
                bindingId: "bind-default-1",
                bindingEpoch: 1,
                leaderPaused: false,
                pauseGeneration: 1,
              },
            ],
            leaderPauseGenerations: { "leader-default": 1 },
            leaderPausedById: { "leader-default": false },
            defaultLeaderPaused: false,
            defaultLeaderPauseGeneration: 1,
            triggerReplay: true,
          },
        });
        await new Promise((r) => setTimeout(r, 20));
        const startupDispatches = notifications2.filter((n) => n.method === "inbound.dispatch");
        assert.equal(startupDispatches.length, 1);
        // MUST reuse persisted generation 0 (NOT upgrade to 1!)
        assert.equal(startupDispatches[0]!.params.pauseGeneration, 0);
        const msgId = String(startupDispatches[0]!.params.messageId);
        const origKey = String(startupDispatches[0]!.params.idempotencyKey);

        // T3 rejects gen 0 -> settles as pause -> explicit Replay refreshes generation to 1!
        await bridge2.handleRequest({ id: 3, method: "inbound.settle", params: { idempotencyKey: origKey, event: "pause" } });
        assert.equal(store2.message(msgId)?.state, "paused_pending");
        notifications2.length = 0;
        const replayed = await bridge2.handleRequest({
          id: 4,
          method: "paused.decide",
          params: { messageIds: [msgId], decision: "replay", leaderId: "leader-default", pauseGeneration: 1 },
        });
        assert.equal(replayed.ok, true);
        const replayDispatches = notifications2.filter((n) => n.method === "inbound.dispatch");
        assert.equal(replayDispatches.length, 1);
        assert.equal(replayDispatches[0]!.params.idempotencyKey, origKey);
        assert.equal(replayDispatches[0]!.params.pauseGeneration, 1);
        assert.equal(store2.message(msgId)?.pauseGeneration, 1);
        await bridge2.shutdown();
      }

      // S25 & S26: Fresh bridge with default Leader paused -> onboard new Feishu connection ->
      // (S25) Owner DM before T3 reconciles binding enters `paused_pending` (ZERO dispatch!)
      // (S26) Approving a held stranger message during Pause moves it to `paused_pending` (ZERO dispatch!)
      {
        const store3 = new Store(":memory:");
        const notifications3: RpcNotification[] = [];
        const mock3 = createMockChannel({ platform: "feishu", trust: "public", onboardOwnerId: "owner-1" });
        const bridge3 = new ImBridge({
          store: store3,
          secrets: memorySecrets(),
          channels: { feishu: mock3.channel },
          notify: (n) => notifications3.push(n),
          sleepCheckIntervalMs: 0,
        });
        await bridge3.start();
        // Pause default Leader while there are ZERO connections yet!
        await bridge3.handleRequest({
          id: 1,
          method: "connections.syncBindings",
          params: {
            bindings: [],
            leaderPauseGenerations: { "leader-default": 1 },
            leaderPausedById: { "leader-default": true },
            defaultLeaderPaused: true,
            defaultLeaderPauseGeneration: 1,
          },
        });
        assert.equal(store3.getLeaderPaused("leader-default"), true);

        // Onboard mock Feishu connection during Pause
        const onboard = await bridge3.handleRequest({
          id: 2,
          method: "onboarding.start",
          params: { platform: "feishu", mode: "qr" },
        });
        assert.equal(onboard.ok, true);
        await new Promise((r) => setTimeout(r, 30));
        const newConn = store3.connections()[0]!;
        assert.equal(newConn.leaderPaused, true);

        // S25: Owner sends DM before T3 reconciles binding -> MUST enter `paused_pending`, NOT emit `inbound.dispatch`!
        notifications3.length = 0;
        await mock3.events!.onMessage({
          platformId: "s25-owner-dm",
          chat: { platformId: "dm-owner", kind: "dm" },
          sender: { id: "owner-1", name: "Owner", isBot: false },
          text: "arrived right after onboarding while paused",
          attachments: [],
          addressedToBot: true,
          sentAt: 1_700_000_201_000,
        });
        assert.equal(notifications3.filter((n) => n.method === "inbound.dispatch").length, 0);
        assert.equal(store3.pausedPendingMessages({ leaderId: "leader-default" }).length, 1);

        // S26: Stranger sends DM -> `held`; Owner approves contact while Leader is STILL paused ->
        // MUST move to `paused_pending` and emit ZERO `inbound.dispatch`!
        notifications3.length = 0;
        await mock3.events!.onMessage({
          platformId: "s26-stranger-dm",
          chat: { platformId: "dm-stranger", kind: "dm" },
          sender: { id: "stranger-1", name: "Stranger", isBot: false },
          text: "held while paused",
          attachments: [],
          addressedToBot: true,
          sentAt: 1_700_000_202_000,
        });
        const heldList = store3.heldMessages(newConn.id);
        assert.equal(heldList.length, 1);
        const heldMsg = heldList[0]!;

        notifications3.length = 0;
        const approved = await bridge3.handleRequest({
          id: 3,
          method: "access.decide",
          params: { targetKind: "contact", targetId: heldMsg.contactId, decision: "allowed" },
        });
        assert.equal(approved.ok, true);
        assert.equal(notifications3.filter((n) => n.method === "inbound.dispatch").length, 0);
        assert.equal(notifications3.filter((n) => n.method === "inbound.paused").length, 1);
        assert.equal(store3.message(heldMsg.id)?.state, "paused_pending");

        // Only after Resume + explicit Owner Replay is the approved message dispatched!
        await bridge3.handleRequest({
          id: 4,
          method: "connections.syncBindings",
          params: {
            bindings: [
              {
                connectionId: newConn.id,
                leaderId: "leader-default",
                bindingId: "bind-default-1",
                bindingEpoch: 1,
                leaderPaused: false,
                pauseGeneration: 1,
              },
            ],
            leaderPauseGenerations: { "leader-default": 1 },
            leaderPausedById: { "leader-default": false },
            defaultLeaderPaused: false,
            defaultLeaderPauseGeneration: 1,
          },
        });
        notifications3.length = 0;
        const replayedHeld = await bridge3.handleRequest({
          id: 5,
          method: "paused.decide",
          params: { messageIds: [heldMsg.id], decision: "replay", leaderId: "leader-default", pauseGeneration: 1 },
        });
        assert.equal(replayedHeld.ok, true);
        const dispatchesAfterReplay = notifications3.filter((n) => n.method === "inbound.dispatch");
        assert.equal(dispatchesAfterReplay.length, 1);
        assert.equal(dispatchesAfterReplay[0]!.params.messageId, heldMsg.id);
        assert.equal(dispatchesAfterReplay[0]!.params.pauseGeneration, 1);

        await bridge3.shutdown();
      }

      // S27, S28, S29: Atomic state+generation commit (fail-closed on null), paused startup
      // sweeping unacked `delivered` while keeping ACKed runs, and monotonic `pauseVersion`
      // rejecting late out-of-order `Active(0)` after `Pause(1)` and `Pause(1)` after `Resume(2)`.
      {
        const dbPath2 = join(dir, "s27-28-29.sqlite");

        // Part A (S27 + S28): Seed unacked `delivered` + ACKed `delivered` + NULL-gen `received`, then restart paused & active.
        const storeA = new Store(dbPath2);
        const connA = storeA.createConnection({
          platform: "feishu",
          secretRef: null,
          lifecycleState: "active",
          ownerId: "owner-1",
          askAll: false,
        });
        const unackedDel = storeA.ingestInbound(connA.id, "org", {
          platformId: "s28-unacked-delivered",
          chat: { platformId: "dm-owner", kind: "dm" },
          sender: { id: "owner-1", name: "Owner", isBot: false },
          text: "unacked delivered before paused restart",
          attachments: [],
          addressedToBot: true,
          sentAt: 1_700_000_300_000,
        });
        assert.equal(unackedDel.kind, "dispatch");
        storeA.moveInbound([unackedDel.message.id], "deliver");
        assert.equal(storeA.message(unackedDel.message.id)?.state, "delivered");

        const ackedDel = storeA.ingestInbound(connA.id, "org", {
          platformId: "s28-acked-delivered",
          chat: { platformId: "dm-owner", kind: "dm" },
          sender: { id: "owner-1", name: "Owner", isBot: false },
          text: "committed in-flight run before paused restart",
          attachments: [],
          addressedToBot: true,
          sentAt: 1_700_000_301_000,
        });
        assert.equal(ackedDel.kind, "dispatch");
        storeA.ackInbound(
          { idempotencyKey: ackedDel.message.idempotencyKey! },
          { t3ThreadId: "xtwork-im-dm-acked", t3TurnId: "run-committed-s28" },
        );

        const nullGenMsg = storeA.ingestInbound(connA.id, "org", {
          platformId: "s27-null-gen",
          chat: { platformId: "dm-owner", kind: "dm" },
          sender: { id: "owner-1", name: "Owner", isBot: false },
          text: "legacy null pause_generation row",
          attachments: [],
          addressedToBot: true,
          sentAt: 1_700_000_302_000,
        });
        assert.equal(nullGenMsg.kind, "dispatch");
        // Simulate corrupted/legacy row lacking pause_generation
        storeA.db.prepare("UPDATE messages SET pause_generation = NULL WHERE id = ?").run(nullGenMsg.message.id);
        storeA.close();

        // Restart bridge in PAUSED mode (Pause gen=1, ver=1) -> S28: unacked `delivered` & `received`
        // move into `paused_pending` (and appear in `paused.list`), while ACKed run stays `delivered`!
        const storeB = new Store(dbPath2);
        const notificationsB: RpcNotification[] = [];
        const mockB = createMockChannel({ platform: "feishu", trust: "public", onboardOwnerId: "owner-1" });
        const bridgeB = new ImBridge({
          store: storeB,
          secrets: memorySecrets(),
          channels: { feishu: mockB.channel },
          notify: (n) => notificationsB.push(n),
          sleepCheckIntervalMs: 0,
        });
        await bridgeB.handleRequest({ id: 1, method: "bridge.hello", params: { protocolVersion: 1, deferReplay: true } });
        await bridgeB.handleRequest({
          id: 2,
          method: "connections.syncBindings",
          params: {
            bindings: [
              {
                connectionId: connA.id,
                leaderId: "leader-default",
                bindingId: "bind-default-1",
                bindingEpoch: 1,
                leaderPaused: true,
                pauseGeneration: 1,
                pauseVersion: 1,
              },
            ],
            leaderStates: { "leader-default": { paused: true, pauseGeneration: 1, pauseVersion: 1 } },
            defaultLeaderPaused: true,
            defaultLeaderPauseGeneration: 1,
            defaultLeaderPauseVersion: 1,
            triggerReplay: true,
          },
        });
        await new Promise((r) => setTimeout(r, 20));
        assert.equal(notificationsB.filter((n) => n.method === "inbound.dispatch").length, 0);
        assert.equal(storeB.message(unackedDel.message.id)?.state, "paused_pending");
        assert.equal(storeB.message(nullGenMsg.message.id)?.state, "paused_pending");
        assert.equal(storeB.message(ackedDel.message.id)?.state, "delivered");
        const pausedListed = await bridgeB.handleRequest({
          id: 3,
          method: "paused.list",
          params: { leaderId: "leader-default" },
        });
        assert.equal(pausedListed.ok, true);
        if (pausedListed.ok) {
          const items = (pausedListed.result as { items: Array<{ id: string }> }).items;
          assert.equal(items.some((i) => i.id === unackedDel.message.id), true);
          assert.equal(items.some((i) => i.id === ackedDel.message.id), false);
        }

        // S29 (part 1): Late stale Active(gen=0, ver=0) arriving AFTER Pause(gen=1, ver=1)
        // MUST NOT clear Leader pause or connection pause! Newly onboarded connection still starts paused!
        await bridgeB.handleRequest({
          id: 4,
          method: "connections.syncBindings",
          params: {
            bindings: [
              {
                connectionId: connA.id,
                leaderId: "leader-default",
                bindingId: "bind-default-1",
                bindingEpoch: 1,
                leaderPaused: false,
                pauseGeneration: 0,
                pauseVersion: 0,
              },
            ],
            leaderStates: { "leader-default": { paused: false, pauseGeneration: 0, pauseVersion: 0 } },
            defaultLeaderPaused: false,
            defaultLeaderPauseGeneration: 0,
            defaultLeaderPauseVersion: 0,
          },
        });
        assert.equal(storeB.getLeaderPaused("leader-default"), true);
        assert.equal(storeB.getLeaderPauseState("leader-default").pauseVersion, 1);
        assert.equal(storeB.connection(connA.id)?.leaderPaused, true);
        const onboardAfterStale = await bridgeB.handleRequest({
          id: 5,
          method: "onboarding.start",
          params: { platform: "feishu", mode: "qr" },
        });
        assert.equal(onboardAfterStale.ok, true);
        await new Promise((r) => setTimeout(r, 30));
        const newestConn = storeB.connections().find((c) => c.id !== connA.id)!;
        assert.equal(newestConn.leaderPaused, true);

        // S29 (part 2): Resume(gen=1, ver=2) followed by late stale Pause(gen=1, ver=1)
        // MUST keep Leader active (`paused=false, ver=2`) so Replay succeeds immediately!
        await bridgeB.handleRequest({
          id: 6,
          method: "connections.syncBindings",
          params: {
            bindings: [
              {
                connectionId: connA.id,
                leaderId: "leader-default",
                bindingId: "bind-default-1",
                bindingEpoch: 1,
                leaderPaused: false,
                pauseGeneration: 1,
                pauseVersion: 2,
              },
            ],
            leaderStates: { "leader-default": { paused: false, pauseGeneration: 1, pauseVersion: 2 } },
            defaultLeaderPaused: false,
            defaultLeaderPauseGeneration: 1,
            defaultLeaderPauseVersion: 2,
          },
        });
        assert.equal(storeB.getLeaderPaused("leader-default"), false);
        assert.equal(storeB.connection(connA.id)?.leaderPaused, false);
        // Late stale Pause(gen=1, ver=1) arrives AFTER Resume(gen=1, ver=2) -> MUST be rejected!
        await bridgeB.handleRequest({
          id: 7,
          method: "connections.syncBindings",
          params: {
            bindings: [
              {
                connectionId: connA.id,
                leaderId: "leader-default",
                bindingId: "bind-default-1",
                bindingEpoch: 1,
                leaderPaused: true,
                pauseGeneration: 1,
                pauseVersion: 1,
              },
            ],
            leaderStates: { "leader-default": { paused: true, pauseGeneration: 1, pauseVersion: 1 } },
            defaultLeaderPaused: true,
            defaultLeaderPauseGeneration: 1,
            defaultLeaderPauseVersion: 1,
          },
        });
        assert.equal(storeB.getLeaderPaused("leader-default"), false);
        assert.equal(storeB.getLeaderPauseState("leader-default").pauseVersion, 2);
        assert.equal(storeB.connection(connA.id)?.leaderPaused, false);

        // Replay of `unackedDel` succeeds with atomic `pauseGeneration = 1`!
        notificationsB.length = 0;
        const replayAfterStalePause = await bridgeB.handleRequest({
          id: 8,
          method: "paused.decide",
          params: {
            messageIds: [unackedDel.message.id],
            decision: "replay",
            leaderId: "leader-default",
            pauseGeneration: 1,
            pauseVersion: 2,
          },
        });
        assert.equal(replayAfterStalePause.ok, true);
        const replayedDispatches = notificationsB.filter((n) => n.method === "inbound.dispatch");
        assert.equal(replayedDispatches.length, 1);
        assert.equal(replayedDispatches[0]!.params.messageId, unackedDel.message.id);
        assert.equal(replayedDispatches[0]!.params.pauseGeneration, 1);
        assert.equal(storeB.message(unackedDel.message.id)?.pauseGeneration, 1);

        // S27: Verify a corrupted/legacy `received` row with NULL `pause_generation` NEVER gets
        // upgraded to the Leader's newer generation (1) on automatic startup redelivery — fails closed to 0!
        storeB.db
          .prepare("UPDATE messages SET state = 'received', pause_generation = NULL WHERE id = ?")
          .run(nullGenMsg.message.id);
        notificationsB.length = 0;
        bridgeB.replayUnackedTriggers();
        const nullGenDispatch = notificationsB.find(
          (n) => n.method === "inbound.dispatch" && n.params.messageId === nullGenMsg.message.id,
        );
        assert.ok(nullGenDispatch);
        assert.equal(nullGenDispatch.params.pauseGeneration, 0);

        await bridgeB.shutdown();
      }
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
});
