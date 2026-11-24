/**
 * Offline tests for the Personal WeChat (Tencent iLink) channel adapter.
 * Uses injected mock `fetch` (zero real network calls) and strictly verifies
 * ADR-011 S6 persist-before-cursor crash safety!
 *
 * Adapted from earayu/Mingle@006220e880d2134665ce2745ab6233f52c8eabe9
 * (MIT License, Copyright (c) 2026 earayu).
 */

import assert from "node:assert/strict";
import { createCipheriv, createDecipheriv } from "node:crypto";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, it } from "node:test";
import type { ConnectionState, InboundBatch, InboundMessage, OnboardingEvent } from "../../src/channels/channel.ts";
import {
  mediaDownloadUrl,
  mediaKey,
  toInbound,
  trustedBaseUrl,
  trustedQrUrl,
  wechatApi,
  wechatChannel,
} from "../../src/channels/wechat/wechat.ts";

async function until(predicate: () => boolean, timeoutMs = 2000): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  while (!predicate()) {
    if (Date.now() > deadline) throw new Error("timed out waiting for condition");
    await new Promise((r) => setTimeout(r, 10));
  }
}

/** A fake iLink server: routes by endpoint, records requests. */
function fakeIlink(routes: Record<string, (body: unknown, url: URL) => unknown>) {
  const calls: { endpoint: string; url: URL; body: unknown; headers: Record<string, string> }[] = [];
  const fetchImpl = (async (input: URL | string, init?: RequestInit) => {
    const url = new URL(String(input));
    const endpoint = url.pathname.replace(/^\//, "");
    const body = init?.body ? JSON.parse(String(init.body)) : undefined;
    calls.push({ endpoint, url, body, headers: (init?.headers ?? {}) as Record<string, string> });
    const route = routes[endpoint];
    if (!route) return new Response("{}", { status: 404 });
    const result = await route(body, url);
    return new Response(JSON.stringify(result), { status: 200, headers: { "content-type": "application/json" } });
  }) as typeof fetch;
  return { fetchImpl, calls };
}

async function collect(iterable: AsyncIterable<OnboardingEvent>): Promise<OnboardingEvent[]> {
  const out: OnboardingEvent[] = [];
  for await (const e of iterable) out.push(e);
  return out;
}

describe("wechat login, Tencent host allowlist & multi-account local_token_list", () => {
  it("shows QR, follows Tencent redirect, handles verify code, and returns ownerId", async () => {
    const statuses = ["wait", "scaned_but_redirect", "need_verifycode", "confirmed"];
    const ilink = fakeIlink({
      "ilink/bot/get_bot_qrcode": () => ({
        qrcode: "QR1",
        qrcode_img_content: "https://liteapp.weixin.qq.com/q/abc?qrcode=QR1",
      }),
      "ilink/bot/get_qrcode_status": () => {
        const status = statuses.shift();
        if (status === "scaned_but_redirect") return { status, redirect_host: "sh.ilinkai.weixin.qq.com" };
        if (status === "confirmed") {
          return {
            status,
            bot_token: "tok",
            ilink_bot_id: "bot@im.bot",
            ilink_user_id: "owner@im.wechat",
            baseurl: "ilinkai.weixin.qq.com",
          };
        }
        return { status };
      },
    });
    const channel = wechatChannel({ api: wechatApi(ilink.fetchImpl) });
    const events = await collect(
      channel.onboard(undefined, new AbortController().signal, { agentName: "小瞳", awaitCode: async () => "123456" }),
    );
    assert.deepEqual(
      events.map((e) => e.kind),
      ["qr_ready", "scanned", "needs_code", "succeeded"],
    );
    const qrEvent = events[0];
    assert.ok(qrEvent && qrEvent.kind === "qr_ready");
    assert.equal(qrEvent.qrContent, "https://liteapp.weixin.qq.com/q/abc?qrcode=QR1");
    assert.deepEqual(events[3], {
      kind: "succeeded",
      credentials: { token: "tok", botId: "bot@im.bot", baseUrl: "https://ilinkai.weixin.qq.com/", name: "小瞳" },
      bot: { id: "bot@im.bot", name: "小瞳" },
      ownerId: "owner@im.wechat",
    });
    const codeCall = ilink.calls.find((c) => c.url.searchParams.get("verify_code"));
    assert.equal(codeCall?.url.searchParams.get("verify_code"), "123456");
    assert.equal(codeCall?.url.hostname, "sh.ilinkai.weixin.qq.com");
    assert.equal(ilink.calls[0]?.headers["iLink-App-Id"], "bot");
  });

  it("enforces Tencent-host allowlists for QR URLs, base URLs, and CDN media URLs", () => {
    assert.throws(() => trustedQrUrl("https://evil.example.com/q"), /outside Tencent/);
    assert.throws(() => trustedQrUrl("https://weixin.qq.com.evil.com/q"), /outside Tencent/);
    assert.throws(() => trustedQrUrl("http://liteapp.weixin.qq.com/q"), /outside Tencent/);
    assert.equal(trustedQrUrl("https://liteapp.weixin.qq.com/q/1"), "https://liteapp.weixin.qq.com/q/1");
    assert.equal(trustedQrUrl("https://open.wechat.com/q/1"), "https://open.wechat.com/q/1");

    assert.throws(() => trustedBaseUrl("https://evil.example.com", "https://ilinkai.weixin.qq.com/"), /outside Tencent/);
    assert.throws(() => trustedBaseUrl("http://ilinkai.weixin.qq.com", "x"), /outside Tencent/);
    assert.throws(() => trustedBaseUrl("https://ilinkai.weixin.qq.com:8443", "x"), /outside Tencent/);
    assert.equal(trustedBaseUrl("sh.ilinkai.weixin.qq.com", "x"), "https://sh.ilinkai.weixin.qq.com/");

    assert.throws(() => mediaDownloadUrl({ full_url: "https://evil.example.com/c2c/x" }), /outside its CDN/);
    assert.throws(() => mediaDownloadUrl({ full_url: "https://novac2c.cdn.weixin.qq.com/other/x" }), /outside its CDN/);
  });

  it("sends up to 10 existing local_token_list entries and distinguishes already_connected vs already_bound", async () => {
    const ilink1 = fakeIlink({
      "ilink/bot/get_bot_qrcode": () => ({ qrcode: "Q", qrcode_img_content: "https://liteapp.weixin.qq.com/q/x" }),
      "ilink/bot/get_qrcode_status": () => ({ status: "binded_redirect" }),
    });
    const known = Array.from({ length: 12 }, (_, i) => ({ token: `tok${i}`, botId: `b${i}` }));
    const events1 = await collect(
      wechatChannel({ api: wechatApi(ilink1.fetchImpl) }).onboard(undefined, new AbortController().signal, {
        knownCredentials: async () => [...known, { botId: "no-token" }],
      }),
    );
    const req1 = ilink1.calls.find((c) => c.endpoint === "ilink/bot/get_bot_qrcode");
    assert.deepEqual(req1?.body, { local_token_list: known.slice(0, 10).map((c) => c.token) });
    assert.deepEqual(events1.at(-1), { kind: "failed", code: "already_connected" });

    const ilink2 = fakeIlink({
      "ilink/bot/get_bot_qrcode": () => ({ qrcode: "Q", qrcode_img_content: "https://liteapp.weixin.qq.com/q/x" }),
      "ilink/bot/get_qrcode_status": () => ({ status: "binded_redirect" }),
    });
    const events2 = await collect(
      wechatChannel({ api: wechatApi(ilink2.fetchImpl) }).onboard(undefined, new AbortController().signal),
    );
    assert.deepEqual(events2.at(-1), { kind: "failed", code: "already_bound" });
  });
});

describe("wechat ADR-011 S6 persist-before-cursor crash safety", () => {
  it("onMessageBatch: resumes from initialCursor and NEVER advances cursor if batch persistence fails", async () => {
    const seenPollCursors: string[] = [];
    const committedBatches: InboundBatch[] = [];
    let failFirstPersist = true;
    let pollCount = 0;

    const ilink = fakeIlink({
      "ilink/bot/msg/notifystart": () => ({ ret: 0 }),
      "ilink/bot/msg/notifystop": () => ({ ret: 0 }),
      "ilink/bot/getupdates": (body) => {
        const cur = (body as { get_updates_buf: string }).get_updates_buf;
        seenPollCursors.push(cur);
        pollCount++;
        if (cur === "cursor-0") {
          return {
            ret: 0,
            get_updates_buf: "cursor-1",
            msgs: [
              {
                message_id: "m1",
                from_user_id: "u@im.wechat",
                context_token: "ctx-1",
                item_list: [{ type: 1, text_item: { text: "important task" } }],
              },
              {
                message_id: "m2",
                from_user_id: "u@im.wechat",
                context_token: "ctx-2",
                item_list: [{ type: 1, text_item: { text: "second message" } }],
              },
            ],
          };
        }
        if (cur === "cursor-1") {
          return { ret: 0, msgs: [], get_updates_buf: "cursor-2" };
        }
        return { ret: -14 };
      },
    });

    const states: ConnectionState[] = [];
    const connection = await wechatChannel({
      api: wechatApi(ilink.fetchImpl),
      retryDelayMs: () => 5,
    }).connect(
      { token: "tok", botId: "bot", baseUrl: "https://ilinkai.weixin.qq.com/" },
      {
        onMessage: () => {
          throw new Error("onMessage must not be called when onMessageBatch is provided");
        },
        async onMessageBatch(batch) {
          if (failFirstPersist) {
            failFirstPersist = false;
            // Simulate DB write failure / crash before commit
            throw new Error("SQLITE_BUSY: persistence failed");
          }
          await new Promise((r) => setTimeout(r, 10));
          committedBatches.push(batch);
        },
        onState: (s) => states.push(s),
        onMembership: () => {},
      },
      { initialCursor: "cursor-0" },
    );

    await until(() => states.some((s) => s.kind === "error"));
    await connection.close();

    // Poll 1 sent "cursor-0" -> persist threw -> Poll 2 MUST retry "cursor-0" (NOT "cursor-1")!
    // Poll 2 succeeded -> Poll 3 sent "cursor-1" -> empty batch updated to "cursor-2" -> Poll 4 sent "cursor-2".
    assert.equal(pollCount, 4);
    assert.deepEqual(seenPollCursors, ["cursor-0", "cursor-0", "cursor-1", "cursor-2"]);
    assert.equal(committedBatches.length, 2);
    assert.deepEqual(
      committedBatches[0]?.messages.map((m) => m.platformId),
      ["m1", "m2"],
    );
    assert.equal(committedBatches[0]?.nextCursor, "cursor-1");
    assert.deepEqual(committedBatches[1], { messages: [], nextCursor: "cursor-2" });
  });

  it("onMessage + onCursorCommit: strictly awaits every message before committing cursor, and never commits on mid-batch error", async () => {
    const timeline: string[] = [];
    let failSecondMessageOnce = true;
    let failCursorCommitOnce = true;

    const ilink = fakeIlink({
      "ilink/bot/msg/notifystart": () => ({ ret: 0 }),
      "ilink/bot/msg/notifystop": () => ({ ret: 0 }),
      "ilink/bot/getupdates": (body) => {
        const cur = (body as { get_updates_buf: string }).get_updates_buf;
        timeline.push(`poll:${cur}`);
        if (cur === "c0") {
          return {
            ret: 0,
            get_updates_buf: "c1",
            msgs: [
              { message_id: "m1", from_user_id: "u@im.wechat", item_list: [{ type: 1, text_item: { text: "one" } }] },
              { message_id: "m2", from_user_id: "u@im.wechat", item_list: [{ type: 1, text_item: { text: "two" } }] },
            ],
          };
        }
        return { ret: -14 };
      },
    });

    const states: ConnectionState[] = [];
    const connection = await wechatChannel({
      api: wechatApi(ilink.fetchImpl),
      retryDelayMs: () => 5,
    }).connect(
      { token: "tok", botId: "bot", baseUrl: "https://ilinkai.weixin.qq.com/" },
      {
        async onMessage(m) {
          timeline.push(`msg:${m.platformId}:start`);
          await new Promise((r) => setTimeout(r, 5));
          if (m.platformId === "m2" && failSecondMessageOnce) {
            failSecondMessageOnce = false;
            timeline.push("msg:m2:throw");
            throw new Error("disk full on m2");
          }
          timeline.push(`msg:${m.platformId}:end`);
        },
        async onCursorCommit(next) {
          timeline.push(`cursor:${next}:start`);
          if (failCursorCommitOnce) {
            failCursorCommitOnce = false;
            timeline.push(`cursor:${next}:throw`);
            throw new Error("cursor write failed");
          }
          await new Promise((r) => setTimeout(r, 5));
          timeline.push(`cursor:${next}:end`);
        },
        onState: (s) => states.push(s),
        onMembership: () => {},
      },
      { initialCursor: "c0" },
    );

    await until(() => states.some((s) => s.kind === "error"));
    await connection.close();

    assert.deepEqual(timeline, [
      // Attempt 1: m1 persisted, m2 threw -> cursor NOT committed, NOT advanced
      "poll:c0",
      "msg:m1:start",
      "msg:m1:end",
      "msg:m2:start",
      "msg:m2:throw",
      // Attempt 2: retried c0 -> m1 & m2 persisted -> cursor commit threw -> in-memory cursor STILL c0
      "poll:c0",
      "msg:m1:start",
      "msg:m1:end",
      "msg:m2:start",
      "msg:m2:end",
      "cursor:c1:start",
      "cursor:c1:throw",
      // Attempt 3: retried c0 -> m1 & m2 persisted -> cursor c1 committed -> next poll finally uses c1!
      "poll:c0",
      "msg:m1:start",
      "msg:m1:end",
      "msg:m2:start",
      "msg:m2:end",
      "cursor:c1:start",
      "cursor:c1:end",
      "poll:c1",
    ]);
  });

  it("does NOT commit cursor if connection closes mid-batch", async () => {
    const committed: string[] = [];
    const seen: string[] = [];
    let releaseFirst = () => {};
    const firstBlocked = new Promise<void>((resolve) => {
      releaseFirst = resolve;
    });
    let firstEntered = false;

    const ilink = fakeIlink({
      "ilink/bot/msg/notifystart": () => ({ ret: 0 }),
      "ilink/bot/msg/notifystop": () => ({ ret: 0 }),
      "ilink/bot/getupdates": () => ({
        ret: 0,
        get_updates_buf: "c1",
        msgs: [
          { message_id: "m1", from_user_id: "u@im.wechat", item_list: [{ type: 1, text_item: { text: "one" } }] },
          { message_id: "m2", from_user_id: "u@im.wechat", item_list: [{ type: 1, text_item: { text: "two" } }] },
        ],
      }),
    });

    const connection = await wechatChannel({ api: wechatApi(ilink.fetchImpl) }).connect(
      { token: "tok", botId: "bot", baseUrl: "https://ilinkai.weixin.qq.com/" },
      {
        async onMessage(m) {
          seen.push(m.platformId);
          if (m.platformId === "m1") {
            firstEntered = true;
            await firstBlocked;
          }
        },
        onCursorCommit(cur) {
          committed.push(cur);
        },
        onState: () => {},
        onMembership: () => {},
      },
    );

    await until(() => firstEntered);
    const closing = connection.close();
    releaseFirst();
    await closing;

    assert.deepEqual(seen, ["m1"]);
    assert.deepEqual(committed, []);
  });
});

describe("wechat messaging, typing indicator & AES-128-ECB CDN media", () => {
  it("maps text, voice, video/image placeholders, attachments, and skips bot echoes", () => {
    const inbound = toInbound({
      message_id: "7300000000000000001",
      from_user_id: "u@im.wechat",
      context_token: "ctx",
      create_time_ms: 1_700_000_000_000,
      item_list: [
        { type: 1, text_item: { text: "周六去哪？" } },
        { type: 3, voice_item: { text: "带水" } },
        { type: 2 },
        { type: 5 },
        { type: 4, file_item: { file_name: "route.gpx", len: "42", media: { encrypt_query_param: "q" } } },
      ],
    });
    assert.deepEqual(inbound, {
      platformId: "7300000000000000001",
      chat: { platformId: "u@im.wechat", kind: "dm" },
      sender: { id: "u@im.wechat", name: "", isBot: false },
      text: "周六去哪？\n带水\n[image]\n[video]",
      attachments: [{ id: "7300000000000000001#4", name: "route.gpx", size: 42 }],
      addressedToBot: true,
      sentAt: 1_700_000_000_000,
    });
    assert.equal(toInbound({ message_id: "1", from_user_id: "bot", message_type: 2 }), undefined);
  });

  it("sends text with context_token, toggles typing via react/setTyping, and stops on -14", async () => {
    let polls = 0;
    const ilink = fakeIlink({
      "ilink/bot/msg/notifystart": () => ({ ret: 0 }),
      "ilink/bot/msg/notifystop": () => ({ ret: 0 }),
      "ilink/bot/getupdates": () => {
        polls++;
        if (polls === 1) {
          return {
            ret: 0,
            get_updates_buf: "cursor-1",
            msgs: [
              {
                message_id: "m1",
                from_user_id: "u@im.wechat",
                context_token: "ctx-1",
                item_list: [{ type: 1, text_item: { text: "hi" } }],
              },
            ],
          };
        }
        return { ret: -14 };
      },
      "ilink/bot/sendmessage": () => ({ ret: 0 }),
      "ilink/bot/getconfig": () => ({ ret: 0, typing_ticket: "ticket-1" }),
      "ilink/bot/sendtyping": () => ({ ret: 0 }),
    });

    const received: InboundMessage[] = [];
    const states: ConnectionState[] = [];
    const connection = await wechatChannel({ api: wechatApi(ilink.fetchImpl) }).connect(
      { token: "tok", botId: "bot", baseUrl: "https://ilinkai.weixin.qq.com/", name: "小瞳" },
      { onMessage: (m) => { received.push(m); }, onState: (s) => states.push(s), onMembership: () => {} },
    );

    await until(() => received.length === 1);
    await until(() => states.some((s) => s.kind === "error"));
    assert.deepEqual(states.at(-1), { kind: "error", code: "credentials_revoked" });

    // Typing via react("processing") and react("done")
    const dm = { platformId: "u@im.wechat", kind: "dm" as const };
    await connection.react(dm, "m1", "processing");
    await connection.react(dm, "m1", "done");
    const typingCalls = ilink.calls.filter((c) => c.endpoint === "ilink/bot/sendtyping");
    assert.deepEqual(
      typingCalls.map((c) => (c.body as { typing_ticket: string; status: number }).status),
      [1, 2],
    );

    const res = await connection.send({ chat: dm, text: "hello", replyTo: "m1" });
    assert.ok(res.kind === "sent");
    assert.deepEqual(res.degraded, ["markdown_flattened", "quote_dropped"]);
    const sentBody = ilink.calls.find((c) => c.endpoint === "ilink/bot/sendmessage")?.body as {
      msg: { to_user_id: string; context_token: string; client_id: string; item_list: unknown[] };
      base_info: { bot_agent: string };
    };
    assert.equal(sentBody.msg.to_user_id, "u@im.wechat");
    assert.equal(sentBody.msg.context_token, "ctx-1");
    assert.ok(sentBody.msg.client_id.startsWith("xtwork-"));
    assert.equal(sentBody.base_info.bot_agent, "Xtwork/0.1");
    assert.deepEqual(sentBody.msg.item_list, [{ type: 1, text_item: { text: "hello" } }]);
    await connection.close();
  });

  it("encrypts AES-128-ECB CDN uploads for images/files and decrypts inbound media downloads", async () => {
    const uploads: { url: URL; body: Buffer }[] = [];
    const reserved: Record<string, unknown>[] = [];
    let polled = false;
    const peerKey = Buffer.alloc(16, 7);
    const peerCipher = createCipheriv("aes-128-ecb", peerKey, null);
    const peerFile = Buffer.concat([peerCipher.update("gpx data"), peerCipher.final()]);

    const ilink = fakeIlink({
      "ilink/bot/msg/notifystart": () => ({ ret: 0 }),
      "ilink/bot/msg/notifystop": () => ({ ret: 0 }),
      "ilink/bot/getupdates": async () => {
        if (polled) {
          await new Promise((r) => setTimeout(r, 30));
          return { ret: 0, msgs: [] };
        }
        polled = true;
        return {
          ret: 0,
          get_updates_buf: "c1",
          msgs: [
            {
              message_id: "m1",
              from_user_id: "u@im.wechat",
              context_token: "ctx",
              item_list: [
                {
                  type: 4,
                  file_item: {
                    file_name: "route.gpx",
                    media: {
                      encrypt_query_param: "dl",
                      aes_key: Buffer.from(peerKey.toString("hex")).toString("base64"),
                    },
                  },
                },
              ],
            },
          ],
        };
      },
      "ilink/bot/getuploadurl": (body) => {
        reserved.push(body as Record<string, unknown>);
        return { ret: 0, upload_param: `up${reserved.length}` };
      },
      "ilink/bot/sendmessage": () => ({ ret: 0 }),
    });

    const fetchImpl = (async (input: URL | string, init?: RequestInit) => {
      const url = new URL(String(input));
      if (url.hostname === "novac2c.cdn.weixin.qq.com" && url.pathname === "/c2c/upload") {
        uploads.push({ url, body: Buffer.from(init?.body as Uint8Array) });
        return new Response(null, { status: 200, headers: { "x-encrypted-param": `down${uploads.length}` } });
      }
      if (url.hostname === "novac2c.cdn.weixin.qq.com" && url.pathname === "/c2c/download") {
        return new Response(peerFile);
      }
      return ilink.fetchImpl(input, init);
    }) as typeof fetch;

    const received: InboundMessage[] = [];
    const connection = await wechatChannel({ api: wechatApi(fetchImpl) }).connect(
      { token: "tok", botId: "bot", baseUrl: "https://ilinkai.weixin.qq.com/" },
      { onMessage: (m) => { received.push(m); }, onState: () => {}, onMembership: () => {} },
    );

    const dir = await mkdtemp(join(tmpdir(), "xtwork-wechat-"));
    try {
      await until(() => received.length === 1);
      const att = received[0]?.attachments[0];
      assert.ok(att);
      assert.equal(att.name, "route.gpx");
      await connection.download(att, join(dir, "in.gpx"));
      assert.equal(await readFile(join(dir, "in.gpx"), "utf8"), "gpx data");

      await writeFile(join(dir, "photo.PNG"), "png bytes");
      await writeFile(join(dir, "notes.pdf"), "pdf bytes");
      const res = await connection.send({
        chat: { platformId: "u@im.wechat", kind: "dm" },
        text: "here you go",
        files: [{ path: join(dir, "photo.PNG") }, { path: join(dir, "notes.pdf") }],
      });
      assert.ok(res.kind === "sent");
      assert.deepEqual(res.degraded, ["markdown_flattened"]);
      assert.deepEqual(
        reserved.map((r) => [r.media_type, r.rawsize, r.to_user_id]),
        [
          [1, 9, "u@im.wechat"],
          [3, 9, "u@im.wechat"],
        ],
      );
      assert.equal(uploads[0]?.url.searchParams.get("encrypted_query_param"), "up1");
      assert.equal(uploads[0]?.url.searchParams.get("filekey"), reserved[0]?.filekey);

      const decipher = createDecipheriv("aes-128-ecb", Buffer.from(String(reserved[1]?.aeskey), "hex"), null);
      const decrypted = Buffer.concat([decipher.update(uploads[1]?.body as Buffer), decipher.final()]).toString();
      assert.equal(decrypted, "pdf bytes");

      const items = ilink.calls
        .filter((c) => c.endpoint === "ilink/bot/sendmessage")
        .map((c) => (c.body as { msg: { item_list: Record<string, unknown>[]; context_token: string } }).msg);
      assert.deepEqual(
        items.map((m) => m.context_token),
        ["ctx", "ctx", "ctx"],
      );
      const fileItem = items[2]?.item_list[0] as {
        type: number;
        file_item: { media: { aes_key: string }; file_name: string; len: string };
      };
      assert.equal(fileItem.type, 4);
      assert.equal(fileItem.file_item.file_name, "notes.pdf");
      assert.equal(fileItem.file_item.len, "9");
      assert.equal(mediaKey(fileItem.file_item).toString("hex"), reserved[1]?.aeskey);
    } finally {
      await rm(dir, { recursive: true, force: true });
      await connection.close();
    }
  });
});
