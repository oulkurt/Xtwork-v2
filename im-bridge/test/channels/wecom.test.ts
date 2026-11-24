/**
 * Offline tests for the WeCom (企业微信) intelligent bot channel adapter.
 * Uses injected mock `fetch` and mock `WecomClientLike` (zero real network calls).
 *
 * Adapted from earayu/Mingle@006220e880d2134665ce2745ab6233f52c8eabe9
 * (MIT License, Copyright (c) 2026 earayu).
 */

import assert from "node:assert/strict";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, it } from "node:test";
import type { ConnectionState, InboundMessage, OnboardingEvent } from "../../src/channels/channel.ts";
import {
  type Frame,
  STREAM_WINDOW_MS,
  toInbound,
  trustedAuthUrl,
  type WecomClientLike,
  wecomChannel,
} from "../../src/channels/wecom/wecom.ts";

async function until(predicate: () => boolean, timeoutMs = 2000): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  while (!predicate()) {
    if (Date.now() > deadline) throw new Error("timed out waiting for condition");
    await new Promise((r) => setTimeout(r, 10));
  }
}

/** A stand-in for @wecom/aibot-node-sdk WSClient. */
function fakeClient(options: { authFails?: boolean; replyFails?: unknown[]; uploadFails?: Error } = {}) {
  const handlers = new Map<string, ((...args: unknown[]) => void)[]>();
  const calls: { method: string; args: unknown[] }[] = [];
  const emit = (event: string, ...args: unknown[]) => {
    for (const h of handlers.get(event) ?? []) h(...args);
  };
  const client: WecomClientLike = {
    connect() {
      setTimeout(
        () =>
          options.authFails ? emit("error", new Error("Authentication failed: invalid secret")) : emit("authenticated"),
        5,
      );
    },
    disconnect() {
      calls.push({ method: "disconnect", args: [] });
    },
    on(event, listener) {
      handlers.set(event, [...(handlers.get(event) ?? []), listener as (...args: unknown[]) => void]);
    },
    async replyStream(...args) {
      calls.push({ method: "replyStream", args });
      const failure = options.replyFails?.shift();
      if (failure !== undefined) throw failure;
    },
    async sendMessage(...args) {
      calls.push({ method: "sendMessage", args });
    },
    async uploadMedia(buffer, opts) {
      calls.push({ method: "uploadMedia", args: [buffer.toString("utf8"), opts] });
      if (options.uploadFails) throw options.uploadFails;
      return { media_id: `m_${opts.type}_${opts.filename}` };
    },
    async sendMediaMessage(...args) {
      calls.push({ method: "sendMediaMessage", args });
    },
    async downloadFile(url, aesKey) {
      calls.push({ method: "downloadFile", args: [url, aesKey] });
      return { buffer: Buffer.from(`decrypted:${url}:${aesKey ?? ""}`) };
    },
  };
  return { client, calls, emit };
}

const makeFrame = (body: Partial<NonNullable<Frame["body"]>>): Frame => ({
  headers: { req_id: "req-1" },
  body: { msgid: "msg1", from: { userid: "zhangsan" }, chattype: "single", msgtype: "text", ...body },
});

describe("wecom inbound mapping", () => {
  it("maps direct and group messages, dropping the leading @mention", () => {
    const dm = toInbound(makeFrame({ text: { content: "周六天气？" }, create_time: 1_700_000_000 }));
    assert.deepEqual(dm, {
      platformId: "msg1",
      chat: { platformId: "zhangsan", kind: "dm" },
      sender: { id: "zhangsan", name: "", isBot: false },
      text: "周六天气？",
      attachments: [],
      addressedToBot: true,
      sentAt: 1_700_000_000_000,
    });

    const grp = toInbound(makeFrame({ chattype: "group", chatid: "wr123", text: { content: "@Xtwork 周六天气？" } }));
    assert.deepEqual(grp?.chat, { platformId: "wr123", kind: "group" });
    assert.equal(grp?.text, "周六天气？");
  });

  it("maps voice, images, files, and mixed messages", () => {
    const inbound = toInbound(
      makeFrame({
        msgtype: "mixed",
        voice: { content: "语音补充" },
        file: { url: "https://wecom.cdn/f1", filename: "spec.pdf", aeskey: "key1" },
        mixed: {
          msg_item: [
            { msgtype: "text", text: { content: "看图" } },
            { msgtype: "image", image: { url: "https://wecom.cdn/i1", aeskey: "key2" } },
          ],
        },
      }),
    );
    assert.equal(inbound?.text, "语音补充\n看图");
    assert.deepEqual(inbound?.attachments, [
      { id: "msg1:0", name: "spec.pdf" },
      { id: "msg1:1", name: "image-msg1-1.jpg", mime: "image/jpeg" },
    ]);
  });
});

describe("wecom onboarding & pairing", () => {
  it("creates QR bot with xtwork source and leaves ownerId unset so bridge enters pairing", async () => {
    let polls = 0;
    const fetchImpl = (async (input: URL | string) => {
      const url = new URL(String(input));
      if (url.pathname.endsWith("/generate")) {
        assert.equal(url.searchParams.get("source"), "xtwork");
        return Response.json({ data: { scode: "S1", auth_url: "https://work.weixin.qq.com/ai/qc/auth?scode=S1" } });
      }
      polls++;
      return Response.json({
        data: polls < 2 ? { status: "waiting" } : { status: "success", bot_info: { botid: "aib1", secret: "sec" } },
      });
    }) as typeof fetch;

    const channel = wecomChannel({ fetch: fetchImpl, pollEveryMs: 5 });
    const events: OnboardingEvent[] = [];
    for await (const e of channel.onboard(undefined, new AbortController().signal, { agentName: "小瞳" })) {
      events.push(e);
    }
    assert.deepEqual(
      events.map((e) => e.kind),
      ["qr_ready", "succeeded"],
    );
    const firstEvent = events[0];
    assert.ok(firstEvent && firstEvent.kind === "qr_ready");
    assert.equal(firstEvent.qrContent, "https://work.weixin.qq.com/ai/qc/auth?scode=S1");
    const secondEvent = events[1];
    assert.ok(secondEvent && secondEvent.kind === "succeeded");
    assert.deepEqual(secondEvent, {
      kind: "succeeded",
      credentials: { botId: "aib1", secret: "sec", name: "小瞳" },
      bot: { id: "aib1", name: "小瞳" },
    });
    assert.equal("ownerId" in secondEvent, false);
  });

  it("refuses untrusted authorization URLs outside work.weixin.qq.com", async () => {
    assert.equal(trustedAuthUrl("https://evil.example/qc"), undefined);
    assert.equal(trustedAuthUrl("http://work.weixin.qq.com/ai/qc"), undefined);
    assert.equal(trustedAuthUrl("https://work.weixin.qq.com/ai/qc?s=1"), "https://work.weixin.qq.com/ai/qc?s=1");

    const fetchImpl = (async () =>
      Response.json({ data: { scode: "S1", auth_url: "https://evil.example/qc" } })) as typeof fetch;
    const events: OnboardingEvent[] = [];
    for await (const e of wecomChannel({ fetch: fetchImpl }).onboard(undefined, new AbortController().signal)) {
      events.push(e);
    }
    assert.deepEqual(events, [{ kind: "failed", code: "network" }]);
  });

  it("validates manual BotID/Secret by connecting once, leaving ownerId unset for pairing", async () => {
    const good = fakeClient();
    const okEvents: OnboardingEvent[] = [];
    for await (const e of wecomChannel({ createClient: () => good.client, connectTimeoutMs: 500 }).onboard(
      { botId: "b1", secret: "good" },
      new AbortController().signal,
    )) {
      okEvents.push(e);
    }
    assert.deepEqual(okEvents, [
      {
        kind: "succeeded",
        credentials: { botId: "b1", secret: "good", name: "Xtwork" },
        bot: { id: "b1", name: "Xtwork" },
      },
    ]);
    assert.equal("ownerId" in (okEvents[0] as object), false);

    const bad = fakeClient({ authFails: true });
    const failEvents: OnboardingEvent[] = [];
    for await (const e of wecomChannel({ createClient: () => bad.client, connectTimeoutMs: 500 }).onboard(
      { botId: "b1", secret: "wrong" },
      new AbortController().signal,
    )) {
      failEvents.push(e);
    }
    assert.deepEqual(failEvents, [{ kind: "failed", code: "invalid_credentials" }]);
  });

  it("maps expired, denied, and aborted QR onboarding states", async () => {
    for (const [status, expected] of [
      ["expired", "expired"],
      ["failed", "denied"],
    ] as const) {
      const fetchImpl = (async (input: URL | string) => {
        const url = new URL(String(input));
        if (url.pathname.endsWith("/generate")) {
          return Response.json({ data: { scode: "S1", auth_url: "https://work.weixin.qq.com/ai/qc?s=1" } });
        }
        return Response.json({ data: { status } });
      }) as typeof fetch;
      const events: OnboardingEvent[] = [];
      for await (const e of wecomChannel({ fetch: fetchImpl, pollEveryMs: 5 }).onboard(
        undefined,
        new AbortController().signal,
      )) {
        events.push(e);
      }
      assert.deepEqual(events.at(-1), { kind: "failed", code: expected });
    }
  });
});

describe("wecom streaming 9-minute handoff, errcode fallback & media", () => {
  it("streams live reply with 9-minute window `until` and supports handoff to active send", async () => {
    let now = 1_700_000_000_000;
    const realNow = Date.now;
    Date.now = () => now;
    try {
      const fake = fakeClient();
      const received: InboundMessage[] = [];
      const states: ConnectionState[] = [];
      const connection = await wecomChannel({ createClient: () => fake.client }).connect(
        { botId: "aib1", secret: "s", name: "Xtwork" },
        { onMessage: (m) => { received.push(m); }, onState: (s) => states.push(s), onMembership: () => {} },
      );
      assert.deepEqual(connection.bot, { id: "aib1", name: "Xtwork" });
      assert.deepEqual(states.at(-1), { kind: "connected" });

      const inbound = makeFrame({ text: { content: "请跑一个长任务" } });
      fake.emit("message", inbound);
      await until(() => received.length === 1);

      const live = await connection.startLive?.(
        { platformId: "zhangsan", kind: "dm" },
        { replyTo: "msg1", initial: "正在思考" },
      );
      assert.ok(live);
      assert.equal(live.until, now + STREAM_WINDOW_MS);
      assert.equal(STREAM_WINDOW_MS, 9 * 60_000);

      await live.update("正在处理");
      // Advance past 9-minute handoff window: caller closes live reply and hands final answer to active send
      now += STREAM_WINDOW_MS + 1;
      assert.ok(now >= (live.until ?? 0));
      const closed = await live.finish("任务耗时较长，结果将通过新消息发送…");
      assert.equal(closed.kind, "sent");

      const active = await connection.send({ chat: { platformId: "zhangsan", kind: "dm" }, text: "最终结果" });
      assert.equal(active.kind, "sent");

      const streams = fake.calls.filter((c) => c.method === "replyStream");
      assert.deepEqual(
        streams.map((c) => [c.args[2], c.args[3]]),
        [
          ["正在思考", false],
          ["正在处理", false],
          ["任务耗时较长，结果将通过新消息发送…", true],
        ],
      );
      assert.equal(fake.calls.filter((c) => c.method === "sendMessage").length, 1);
      assert.deepEqual(fake.calls.find((c) => c.method === "sendMessage")?.args, [
        "zhangsan",
        { msgtype: "markdown", markdown: { content: "最终结果" } },
      ]);
      await connection.close();
    } finally {
      Date.now = realNow;
    }
  });

  it("sends actively once the cached frame exceeds 30-minute TTL", async () => {
    let now = 1_700_000_000_000;
    const realNow = Date.now;
    Date.now = () => now;
    try {
      const fake = fakeClient();
      const received: InboundMessage[] = [];
      const connection = await wecomChannel({ createClient: () => fake.client }).connect(
        { botId: "aib1", secret: "s" },
        { onMessage: (m) => { received.push(m); }, onState: () => {}, onMembership: () => {} },
      );
      fake.emit("message", makeFrame({ text: { content: "hi" } }));
      await until(() => received.length === 1);

      now += 31 * 60_000;
      const res = await connection.send({
        chat: { platformId: "zhangsan", kind: "dm" },
        text: "答案",
        replyTo: "msg1",
      });
      assert.ok(res.kind === "sent");
      assert.deepEqual(res.degraded, ["quote_dropped"]);
      assert.equal(fake.calls.filter((c) => c.method === "replyStream").length, 0);
      assert.equal(fake.calls.filter((c) => c.method === "sendMessage").length, 1);
      await assert.rejects(() =>
        connection.startLive!({ platformId: "zhangsan", kind: "dm" }, { replyTo: "msg1", initial: "…" }),
      );
      await connection.close();
    } finally {
      Date.now = realNow;
    }
  });

  it("falls back once to active send on errcode 846605 and 846608, dropping dead frame", async () => {
    for (const failure of [Object.assign(new Error("invalid req_id"), { errcode: 846605 }), { errcode: 846608 }]) {
      const fake = fakeClient({ replyFails: [failure] });
      const received: InboundMessage[] = [];
      const connection = await wecomChannel({ createClient: () => fake.client }).connect(
        { botId: "aib1", secret: "s" },
        { onMessage: (m) => { received.push(m); }, onState: () => {}, onMembership: () => {} },
      );
      fake.emit("message", makeFrame({ text: { content: "hi" } }));
      await until(() => received.length === 1);

      const first = await connection.send({
        chat: { platformId: "zhangsan", kind: "dm" },
        text: "答案",
        replyTo: "msg1",
      });
      assert.ok(first.kind === "sent");
      assert.deepEqual(first.degraded, ["quote_dropped"]);
      assert.equal(fake.calls.filter((c) => c.method === "replyStream").length, 1);
      assert.equal(fake.calls.filter((c) => c.method === "sendMessage").length, 1);

      // Refused frame was evicted: next reply skips replyStream and goes straight to sendMessage
      await connection.send({ chat: { platformId: "zhangsan", kind: "dm" }, text: "补充", replyTo: "msg1" });
      assert.equal(fake.calls.filter((c) => c.method === "replyStream").length, 1);
      assert.equal(fake.calls.filter((c) => c.method === "sendMessage").length, 2);
      await connection.close();
    }
  });

  it("evicts dead frame if startLive.finish hits errcode 846608 so fallback send goes active directly", async () => {
    const fake = fakeClient({ replyFails: [undefined, { errcode: 846608 }] });
    const received: InboundMessage[] = [];
    const connection = await wecomChannel({ createClient: () => fake.client }).connect(
      { botId: "aib1", secret: "s" },
      { onMessage: (m) => { received.push(m); }, onState: () => {}, onMembership: () => {} },
    );
    fake.emit("message", makeFrame({ text: { content: "hi" } }));
    await until(() => received.length === 1);

    const live = await connection.startLive!({ platformId: "zhangsan", kind: "dm" }, { replyTo: "msg1", initial: "…" });
    const finished = await live.finish("最终内容");
    assert.deepEqual(finished, { kind: "failed", code: "unknown", retryable: false });

    // Because 846608 dropped the frame, the fallback send goes straight to active sendMessage
    const fallback = await connection.send({
      chat: { platformId: "zhangsan", kind: "dm" },
      text: "最终内容",
      replyTo: "msg1",
    });
    assert.ok(fallback.kind === "sent");
    assert.deepEqual(fallback.degraded, ["quote_dropped"]);
    assert.equal(fake.calls.filter((c) => c.method === "replyStream").length, 2);
    assert.equal(fake.calls.filter((c) => c.method === "sendMessage").length, 1);
    await connection.close();
  });

  it("does NOT fall back to active send on ambiguous timeout errors", async () => {
    const fake = fakeClient({ replyFails: [new Error("socket timeout")] });
    const received: InboundMessage[] = [];
    const connection = await wecomChannel({ createClient: () => fake.client }).connect(
      { botId: "aib1", secret: "s" },
      { onMessage: (m) => { received.push(m); }, onState: () => {}, onMembership: () => {} },
    );
    fake.emit("message", makeFrame({ text: { content: "hi" } }));
    await until(() => received.length === 1);

    const res = await connection.send({ chat: { platformId: "zhangsan", kind: "dm" }, text: "答案", replyTo: "msg1" });
    assert.deepEqual(res, { kind: "failed", code: "network", retryable: true });
    assert.equal(fake.calls.filter((c) => c.method === "sendMessage").length, 0);
    await connection.close();
  });

  it("uploads images/files, downloads inbound attachments with aeskey, and reports textSent on partial failure", async () => {
    const fake = fakeClient();
    const received: InboundMessage[] = [];
    const connection = await wecomChannel({ createClient: () => fake.client }).connect(
      { botId: "aib1", secret: "s" },
      { onMessage: (m) => { received.push(m); }, onState: () => {}, onMembership: () => {} },
    );

    const dir = mkdtempSync(join(tmpdir(), "xtwork-wecom-"));
    try {
      fake.emit(
        "message",
        makeFrame({
          msgtype: "file",
          file: { url: "https://wecom.cdn/doc1", aeskey: "secret-aes", filename: "report.pdf" },
        }),
      );
      await until(() => received.length === 1);
      const att = received[0]?.attachments[0];
      assert.ok(att);
      const outPath = join(dir, "report.pdf");
      await connection.download(att, outPath);
      assert.equal(readFileSync(outPath, "utf8"), "decrypted:https://wecom.cdn/doc1:secret-aes");

      writeFileSync(join(dir, "img.png"), "png-data");
      writeFileSync(join(dir, "doc.txt"), "txt-data");
      const sent = await connection.send({
        chat: { platformId: "wr123", kind: "group" },
        text: "附件如下",
        files: [{ path: join(dir, "img.png") }, { path: join(dir, "doc.txt") }],
      });
      assert.equal(sent.kind, "sent");
      const uploads = fake.calls.filter((c) => c.method === "uploadMedia");
      assert.deepEqual(uploads.map((u) => u.args), [
        ["png-data", { type: "image", filename: "img.png" }],
        ["txt-data", { type: "file", filename: "doc.txt" }],
      ]);
      const mediaSends = fake.calls.filter((c) => c.method === "sendMediaMessage");
      assert.deepEqual(mediaSends.map((s) => s.args), [
        ["wr123", "image", "m_image_img.png"],
        ["wr123", "file", "m_file_doc.txt"],
      ]);

      // Partial failure after text sent sets textSent
      const failFake = fakeClient({ uploadFails: new Error("upload boom") });
      const conn2 = await wecomChannel({ createClient: () => failFake.client }).connect(
        { botId: "aib1", secret: "s" },
        { onMessage: () => {}, onState: () => {}, onMembership: () => {} },
      );
      const partial = await conn2.send({
        chat: { platformId: "wr123", kind: "group" },
        text: "正文已发",
        files: [{ path: join(dir, "doc.txt") }],
      });
      assert.ok(partial.kind === "failed");
      assert.ok(partial.textSent?.platformId.startsWith("out-"));
      await conn2.close();
    } finally {
      rmSync(dir, { recursive: true, force: true });
      await connection.close();
    }
  });
});
