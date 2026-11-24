/**
 * Offline tests for the Feishu / Lark channel adapter and document comments.
 * Uses injected mock `FeishuApi` and mock `LarkChannelLike` (zero real network calls).
 *
 * Adapted from earayu/Mingle@006220e880d2134665ce2745ab6233f52c8eabe9
 * (MIT License, Copyright (c) 2026 earayu).
 */

import assert from "node:assert/strict";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, it } from "node:test";
import type { LarkChannelOptions, NormalizedMessage } from "@larksuiteoapi/node-sdk";
import * as sdk from "@larksuiteoapi/node-sdk";
import type { ChannelEvents, ConnectionState, InboundMessage, OnboardingEvent } from "../../src/channels/channel.ts";
import { flatten, parseThread, replyElements, threadId } from "../../src/channels/feishu/comments.ts";
import {
  BOT_MESSAGES_SCOPES,
  DOC_COMMENT_EVENT,
  DOC_COMMENT_SCOPES,
  DOC_META_SCOPE,
  FEISHU_MINIMAL_SCOPES,
  FEISHU_OPTIONAL_SCOPES,
  FEISHU_SCOPES,
  type FeishuApi,
  feishuChannel,
  feishuEventsForScopes,
  GROUP_MESSAGES_SCOPE,
  groupThread,
  type LarkChannelLike,
  PROFILE_SCOPES,
  resolveFeishuScopes,
  toInbound,
} from "../../src/channels/feishu/feishu.ts";

const bot = { id: "ou_bot", name: "Alex" };

async function until(predicate: () => boolean, timeoutMs = 2000): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  while (!predicate()) {
    if (Date.now() > deadline) throw new Error("timed out waiting for condition");
    await new Promise((r) => setTimeout(r, 10));
  }
}

function makeMessage(partial: Partial<NormalizedMessage>): NormalizedMessage {
  return {
    messageId: "om_1",
    chatId: "oc_1",
    chatType: "group",
    senderId: "ou_user",
    senderName: "张三",
    content: "周六天气怎么样？",
    rawContentType: "text",
    resources: [],
    mentions: [],
    mentionAll: false,
    mentionedBot: true,
    createTime: 1_700_000_000_000,
    ...partial,
  };
}

/** A stand-in for LarkChannel: records what was sent and lets tests emit events. */
function fakeLark() {
  const handlers = new Map<string, (arg: unknown) => unknown>();
  const sent: { to: string; input: unknown; opts: unknown }[] = [];
  const reactions: string[] = [];
  const cards: {
    replyTo: string;
    replyInThread?: boolean;
    contents: string[];
    streaming: boolean;
    summary?: string;
    sequences: number[];
  }[] = [];
  const failUpdates: number[] = [];
  const failFinal: number[] = [];
  const failSettings: number[] = [];
  let settingsCalls = 0;
  const cardAt = (cardId: string) => cards[Number(cardId.slice("card_".length))];
  const memberCalls: { chatId: string; pageToken: string | undefined }[] = [];
  const contactGets: string[] = [];
  let connected = false;
  let failNext: string | undefined;
  let failSecond: string | undefined;
  let history: unknown[] | undefined;
  const listed: unknown[] = [];
  const downloaded: { messageId: string; fileKey: string; type: string; toPath: string }[] = [];

  type DocElement = {
    type: string;
    text_run?: { text: string };
    person?: { user_id: string };
    docs_link?: { url: string };
  };
  type DocReply = { reply_id: string; user_id: string; create_time: number; content: { elements: DocElement[] } };
  const docThreads = new Map<string, { quote: string; replies: DocReply[] }>();
  const docCreated: { fileToken: string; commentId: string; fileType: string; elements: DocElement[] }[] = [];
  let docUnreadable = false;
  let docFailCreate: number | undefined;

  const channel = {
    async connect() {
      connected = true;
    },
    async disconnect() {
      connected = false;
    },
    on(name: string, handler: (arg: unknown) => unknown) {
      handlers.set(name, handler);
      return () => handlers.delete(name);
    },
    async send(to: string, input: unknown, opts: unknown) {
      if (failNext) {
        const code = failNext;
        failNext = undefined;
        throw Object.assign(new Error(code), { code });
      }
      if (failSecond && input !== null && typeof input === "object" && ("file" in input || "image" in input)) {
        const code = failSecond;
        failSecond = undefined;
        throw Object.assign(new Error(code), { code });
      }
      sent.push({ to, input, opts });
      return { messageId: `om_out_${sent.length}` };
    },
    async addReaction(_id: string, emoji: string) {
      reactions.push(`+${emoji}`);
      return `r-${emoji}`;
    },
    async removeReaction(_id: string, reactionId: string) {
      reactions.push(`-${reactionId}`);
    },
    async getChatInfo(chatId: string) {
      return { chatId, name: "周末徒步", chatType: "group" };
    },
    rawClient: {
      cardkit: {
        v1: {
          card: {
            async create({ data }: { data: { data: string } }) {
              const spec = JSON.parse(data.data);
              cards.push({ replyTo: "", contents: [spec.body.elements[0].content], streaming: true, sequences: [] });
              return { code: 0, data: { card_id: `card_${cards.length - 1}` } };
            },
            async settings({
              path,
              data,
            }: {
              path: { card_id: string };
              data: { settings: string; sequence: number };
            }) {
              const card = cardAt(path.card_id);
              const { config } = JSON.parse(data.settings);
              card?.sequences.push(data.sequence);
              settingsCalls++;
              const fail = failSettings.shift() ?? 0;
              if (fail) {
                throw Object.assign(new Error("Request failed with status code 400"), {
                  response: { data: { code: fail } },
                });
              }
              if (card) card.streaming = config.streaming_mode;
              if (card && config.summary) card.summary = config.summary.content;
              return { code: 0, data: {} };
            },
            async update({
              path,
              data,
            }: {
              path: { card_id: string };
              data: { card: { type: string; data: string }; sequence: number };
            }) {
              const card = cardAt(path.card_id);
              card?.sequences.push(data.sequence);
              const code = failFinal.shift() ?? 0;
              if (code) {
                throw Object.assign(new Error("Request failed with status code 400"), {
                  response: { data: { code } },
                });
              }
              const spec = JSON.parse(data.card.data);
              if (card) {
                card.streaming = spec.config.streaming_mode;
                if (spec.config.summary) card.summary = spec.config.summary.content;
                card.contents.push(spec.body.elements[0].content);
              }
              return { code: 0, data: {} };
            },
          },
          cardElement: {
            async content({ path, data }: { path: { card_id: string }; data: { content: string; sequence: number } }) {
              const card = cardAt(path.card_id);
              card?.sequences.push(data.sequence);
              const code = failUpdates.shift() ?? (card?.streaming ? 0 : 300309);
              if (code) {
                throw Object.assign(new Error("Request failed with status code 400"), {
                  response: { data: { code } },
                });
              }
              card?.contents.push(data.content);
              return { code: 0, data: {} };
            },
          },
        },
      },
      im: {
        v1: {
          message: {
            async reply({
              path,
              data,
            }: {
              path: { message_id: string };
              data: { content: string; reply_in_thread?: boolean };
            }) {
              const card = cardAt(JSON.parse(data.content).data.card_id);
              if (card) {
                card.replyTo = path.message_id;
                if (data.reply_in_thread !== undefined) card.replyInThread = data.reply_in_thread;
              }
              return { code: 0, data: { message_id: "om_card" } };
            },
            async list(request: unknown) {
              listed.push(request);
              if (!history) throw Object.assign(new Error("no permission"), { code: 230027 });
              return { code: 0, data: { items: history } };
            },
            async get({ path }: { path: { message_id: string } }) {
              const to = sent.find((_, i) => `om_out_${i + 1}` === path.message_id)?.to ?? "";
              return { code: 0, data: { items: [{ message_id: path.message_id, chat_id: `oc_dm_${to}` }] } };
            },
          },
          messageResource: {
            async get({ path, params }: { path: { message_id: string; file_key: string }; params: { type: string } }) {
              return {
                async writeFile(toPath: string) {
                  downloaded.push({ messageId: path.message_id, fileKey: path.file_key, type: params.type, toPath });
                  writeFileSync(toPath, `bytes:${path.file_key}`);
                },
              };
            },
          },
          chatMembers: {
            async get({ path, params }: { path: { chat_id: string }; params?: { page_token?: string } }) {
              memberCalls.push({ chatId: path.chat_id, pageToken: params?.page_token });
              return {
                data: {
                  items: params?.page_token
                    ? [{ member_id: "ou_2", name: "李四" }]
                    : [{ member_id: "ou_1", name: "张三" }],
                  has_more: !params?.page_token,
                  page_token: params?.page_token ? undefined : "next",
                },
              };
            },
          },
        },
      },
      async request({ url }: { url: string }) {
        if (url === "/open-apis/im/v1/chats/oc_1/members/bots") {
          return { code: 0, data: { items: [{ bot_id: "ou_other_bot", bot_name: "值班机器人" }] } };
        }
        throw new Error(`unexpected ${url}`);
      },
      contact: {
        v3: {
          user: {
            get: async ({ path }: { path: { user_id: string } }) => {
              contactGets.push(path.user_id);
              const names: Record<string, string> = { ou_li: "李四", ou_pm: "王五", ou_zhang: "张云杨" };
              return {
                data: {
                  user: {
                    name: names[path.user_id] ?? "李四",
                    job_title: "产品经理",
                    department_ids: ["od_pd", "od_gone"],
                  },
                },
              };
            },
          },
          department: {
            get: async ({ path }: { path: { department_id: string } }) => {
              if (path.department_id !== "od_pd") throw Object.assign(new Error("no authority"), { code: 41050 });
              return { data: { department: { name: "产品部" } } };
            },
          },
        },
      },
      drive: {
        v1: {
          meta: {
            async batchQuery() {
              return {
                data: {
                  metas: [{ title: "产品方案评审", url: "https://example.feishu.cn/docx/doxTOKEN" }],
                },
              };
            },
          },
          fileComment: {
            async batchQuery({ data }: { data: { comment_ids: string[] } }) {
              if (docUnreadable) {
                throw Object.assign(new Error("403"), { response: { status: 403, data: { code: 1069303 } } });
              }
              const id = data.comment_ids[0] ?? "";
              const thread = docThreads.get(id);
              return {
                data: {
                  items: thread
                    ? [{ comment_id: id, quote: thread.quote, has_more: false, reply_list: { replies: thread.replies } }]
                    : [],
                },
              };
            },
          },
          fileCommentReply: {
            async list({ path }: { path: { comment_id: string } }) {
              return { data: { items: docThreads.get(path.comment_id)?.replies ?? [], has_more: false } };
            },
            async create({
              path,
              params,
              data,
            }: {
              path: { file_token: string; comment_id: string };
              params: { file_type: string };
              data: { content: { elements: DocElement[] } };
            }) {
              if (docFailCreate) {
                const code = docFailCreate;
                docFailCreate = undefined;
                throw Object.assign(new Error("400"), { response: { status: 400, data: { code } } });
              }
              docCreated.push({
                fileToken: path.file_token,
                commentId: path.comment_id,
                fileType: params.file_type,
                elements: data.content.elements,
              });
              const reply_id = `r_out_${docCreated.length}`;
              docThreads.get(path.comment_id)?.replies.push({
                reply_id,
                user_id: bot.id,
                create_time: 1_800_000_000 + docCreated.length,
                content: data.content,
              });
              return { data: { reply_id } };
            },
          },
        },
      },
    },
    botIdentity: { openId: bot.id, name: bot.name },
  } as unknown as LarkChannelLike;

  return {
    channel,
    sent,
    memberCalls,
    contactGets,
    isConnected: () => connected,
    reactions,
    cards,
    failUpdates,
    failFinal,
    failSettings,
    settingsCalls: () => settingsCalls,
    emit: (name: string, arg: unknown) => handlers.get(name)?.(arg),
    failNextSend: (code: string) => {
      failNext = code;
    },
    failSecondSend: (code: string) => {
      failSecond = code;
    },
    setHistory: (items: unknown[] | undefined) => {
      history = items;
    },
    listed,
    downloaded,
    docThreads,
    docCreated,
    setDocUnreadable: (on: boolean) => {
      docUnreadable = on;
    },
    failDocCreate: (code: number) => {
      docFailCreate = code;
    },
  };
}

function fakeApi(options: {
  activated: () => boolean;
  deny?: boolean;
  errorCode?: string;
  omitOwnerId?: boolean;
  failBotInfo?: boolean;
  hold?: Promise<void>;
  scopes?: () => ReadonlyMap<string, boolean>;
  onRegister?: (options: { appId: string | undefined; agentName: string | undefined; scopes: readonly string[] }) => void;
}): FeishuApi {
  return {
    async register({ appId, agentName, scopes, onQRCodeReady }) {
      options.onRegister?.({ appId, agentName, scopes });
      onQRCodeReady({ url: "https://open.feishu.cn/page/launcher?user_code=ABCD", expireIn: 600 });
      await (options.hold ?? new Promise((r) => setTimeout(r, 10)));
      if (options.deny) throw Object.assign(new Error("denied"), { code: "access_denied" });
      if (options.errorCode) throw Object.assign(new Error(options.errorCode), { code: options.errorCode });
      return {
        appId: "cli_1",
        appSecret: "secret",
        ...(options.omitOwnerId ? {} : { ownerId: "ou_owner" }),
        domain: "feishu",
      };
    },
    async botInfo() {
      if (options.failBotInfo) throw new Error("invalid credentials");
      return { name: "Alex", openId: "ou_bot", activated: options.activated() };
    },
    async scopes() {
      if (!options.scopes) throw new Error("offline");
      return options.scopes();
    },
  };
}

async function collect(iterable: AsyncIterable<OnboardingEvent>): Promise<OnboardingEvent[]> {
  const out: OnboardingEvent[] = [];
  for await (const event of iterable) out.push(event);
  return out;
}

const noopEvents: ChannelEvents = {
  onMessage: () => {},
  onState: () => {},
  onMembership: () => {},
};

describe("feishu ADR-011 minimal scopes & optional upgrades", () => {
  it("requests ONLY minimal default scopes on initial QR setup, excluding all sensitive scopes", async () => {
    assert.deepEqual(FEISHU_MINIMAL_SCOPES, [
      "im:message.p2p_msg:readonly",
      "im:message.group_at_msg:readonly",
      "im:message:readonly",
      "im:message:send_as_bot",
      "im:message.reactions:write_only",
      "im:resource",
      "im:chat:readonly",
      "contact:user.base:readonly",
    ]);
    assert.deepEqual(FEISHU_SCOPES, FEISHU_MINIMAL_SCOPES);

    const requested: (readonly string[])[] = [];
    const channel = feishuChannel({
      api: fakeApi({ activated: () => true, onRegister: ({ scopes }) => requested.push(scopes) }),
    });
    await collect(channel.onboard(undefined, new AbortController().signal, { agentName: "小瞳" }));

    assert.equal(requested.length, 1);
    const initial = requested[0] ?? [];
    const initialSet = new Set<string>(initial);
    assert.deepEqual([...initial], [...FEISHU_MINIMAL_SCOPES]);

    // None of the sensitive upgrade scopes may appear in initial onboarding!
    const sensitive: readonly string[] = [
      GROUP_MESSAGES_SCOPE,
      ...BOT_MESSAGES_SCOPES,
      ...DOC_COMMENT_SCOPES,
      DOC_META_SCOPE,
      ...PROFILE_SCOPES,
    ];
    for (const scope of sensitive) {
      assert.ok(!initialSet.has(scope), `minimal scopes must not include sensitive scope ${scope}`);
    }

    // Minimal event subscription must also omit document comments event.
    assert.deepEqual(feishuEventsForScopes(initial), ["im.message.receive_v1", "im.chat.member.bot.added_v1"]);
    assert.ok(!feishuEventsForScopes(initial).includes(DOC_COMMENT_EVENT));
  });

  it("upgrades each sensitive permission on demand via reauthorize + adding and preserves prior grants", async () => {
    const requested: { appId: string | undefined; scopes: readonly string[] }[] = [];
    let granted = new Map<string, boolean>();
    const channel = feishuChannel({
      api: fakeApi({
        activated: () => true,
        scopes: () => granted,
        onRegister: ({ appId, scopes }) => requested.push({ appId, scopes }),
      }),
    });
    const ctrl = new AbortController();
    const app = { appId: "cli_1", appSecret: "s" };

    // 1. Add group_messages (unmentioned group background)
    await collect(channel.onboard(undefined, ctrl.signal, { reauthorize: app, adding: ["group_messages"] }));
    assert.equal(requested[0]?.appId, "cli_1");
    assert.deepEqual(requested[0]?.scopes, [...FEISHU_MINIMAL_SCOPES, GROUP_MESSAGES_SCOPE]);

    // 2. Simulate group_messages now granted, then add bot_messages + doc_comments
    granted = new Map([[GROUP_MESSAGES_SCOPE, true]]);
    await collect(
      channel.onboard(undefined, ctrl.signal, { reauthorize: app, adding: ["bot_messages", "doc_comments"] }),
    );
    assert.deepEqual(requested[1]?.scopes, [
      ...FEISHU_MINIMAL_SCOPES,
      GROUP_MESSAGES_SCOPE,
      ...BOT_MESSAGES_SCOPES,
      ...DOC_COMMENT_SCOPES,
      DOC_META_SCOPE,
    ]);
    assert.ok(feishuEventsForScopes(requested[1]?.scopes ?? []).includes(DOC_COMMENT_EVENT));

    // 3. Simulate group_messages + member_profiles already granted, plain reauthorize preserves both
    granted = new Map([
      [GROUP_MESSAGES_SCOPE, true],
      ...PROFILE_SCOPES.map((s) => [s, true] as const),
    ]);
    await collect(channel.onboard(undefined, ctrl.signal, { reauthorize: app }));
    assert.deepEqual(requested[2]?.scopes, [...FEISHU_MINIMAL_SCOPES, GROUP_MESSAGES_SCOPE, ...PROFILE_SCOPES]);

    // Direct helper check for all 4 optional buckets
    assert.deepEqual(Object.keys(FEISHU_OPTIONAL_SCOPES).sort(), [
      "bot_messages",
      "doc_comments",
      "group_messages",
      "member_profiles",
    ]);
    assert.deepEqual(
      resolveFeishuScopes({ adding: ["member_profiles"] }),
      [...FEISHU_MINIMAL_SCOPES, ...PROFILE_SCOPES],
    );
  });

  it("reports all four sensitive permission groups as optional and refreshes after TTL", async () => {
    let granted = new Map<string, boolean>();
    let now = 1_700_000_000_000;
    const realNow = Date.now;
    Date.now = () => now;
    try {
      const channel = feishuChannel({
        api: fakeApi({ activated: () => true, scopes: () => granted }),
        createChannel: () => fakeLark().channel,
      });
      const connection = await channel.connect({ appId: "cli_1", appSecret: "s", domain: "lark" }, noopEvents);
      assert.deepEqual(await connection.permissions?.(), [
        { id: "group_messages", granted: false, optional: true },
        { id: "bot_messages", granted: false, optional: true },
        { id: "doc_comments", granted: false, optional: true },
        { id: "member_profiles", granted: false, optional: true },
      ]);

      granted = new Map([[GROUP_MESSAGES_SCOPE, true]]);
      // Still cached within 15s TTL
      assert.equal((await connection.permissions?.())?.[0]?.granted, false);
      now += 20_000;
      assert.deepEqual(await connection.permissions?.(), [
        { id: "group_messages", granted: true, optional: true },
        { id: "bot_messages", granted: false, optional: true },
        { id: "doc_comments", granted: false, optional: true },
        { id: "member_profiles", granted: false, optional: true },
      ]);
      // Member profiles remain off until granted
      assert.equal(await connection.profile?.("ou_2"), undefined);

      now += 20_000;
      granted = new Map([
        ...granted,
        ...BOT_MESSAGES_SCOPES.map((s) => [s, true] as const),
        ...DOC_COMMENT_SCOPES.map((s) => [s, true] as const),
        ...PROFILE_SCOPES.map((s) => [s, true] as const),
      ]);
      assert.deepEqual(await connection.permissions?.(), [
        { id: "group_messages", granted: true, optional: true },
        { id: "bot_messages", granted: true, optional: true },
        { id: "doc_comments", granted: true, optional: true },
        { id: "member_profiles", granted: true, optional: true },
      ]);
      assert.equal(await connection.profile?.("ou_2"), "产品部 · 产品经理");
      await connection.close();
    } finally {
      Date.now = realNow;
    }
  });
});

describe("feishu onboarding & pairing", () => {
  it("yields QR then succeeded with ownerId when Feishu reports scanner", async () => {
    const channel = feishuChannel({ api: fakeApi({ activated: () => true }) });
    const events = await collect(channel.onboard(undefined, new AbortController().signal, { agentName: "Xtwork" }));
    assert.deepEqual(
      events.map((e) => e.kind),
      ["qr_ready", "succeeded"],
    );
    const first = events[0];
    assert.ok(first && first.kind === "qr_ready");
    assert.ok(first.qrContent.includes("user_code=ABCD"));
    assert.deepEqual(events[1], {
      kind: "succeeded",
      credentials: { appId: "cli_1", appSecret: "secret", domain: "feishu" },
      bot: { id: "ou_bot", name: "Alex" },
      ownerId: "ou_owner",
      pendingApproval: false,
    });
  });

  it("omits ownerId on QR succeeded when Feishu omits scanner so bridge enters pairing state", async () => {
    const channel = feishuChannel({ api: fakeApi({ activated: () => true, omitOwnerId: true }) });
    const events = await collect(channel.onboard(undefined, new AbortController().signal));
    const last = events.at(-1);
    assert.ok(last && last.kind === "succeeded");
    assert.equal("ownerId" in last, false);
  });

  it("binds manually by App ID/Secret without ownerId (enters pairing) and maps invalid credentials", async () => {
    const pending = feishuChannel({ api: fakeApi({ activated: () => false }) });
    const okEvents = await collect(pending.onboard({ appId: "cli_9", appSecret: "s" }, new AbortController().signal));
    assert.deepEqual(okEvents, [
      {
        kind: "succeeded",
        credentials: { appId: "cli_9", appSecret: "s", domain: "feishu" },
        bot: { id: "ou_bot", name: "Alex" },
        pendingApproval: true,
      },
    ]);

    const bad = feishuChannel({ api: fakeApi({ activated: () => true, failBotInfo: true }) });
    const failEvents = await collect(bad.onboard({ appId: "cli_9", appSecret: "bad" }, new AbortController().signal));
    assert.deepEqual(failEvents, [{ kind: "failed", code: "invalid_credentials" }]);
  });

  it("maps declined, expired, and cancelled QR onboarding errors", async () => {
    for (const [errorCode, expected] of [
      ["access_denied", "denied"],
      ["expired_token", "expired"],
      ["abort", "cancelled"],
    ] as const) {
      const channel = feishuChannel({ api: fakeApi({ activated: () => true, errorCode }) });
      const events = await collect(channel.onboard(undefined, new AbortController().signal));
      assert.deepEqual(events.at(-1), { kind: "failed", code: expected });
    }
  });
});

describe("feishu per-connection DefaultCache isolation & inbound mapping", () => {
  it("gives each bot its own DefaultCache so two bots in one process never collide on dedup", async () => {
    const captured: LarkChannelOptions[] = [];
    const channel = feishuChannel({
      api: fakeApi({ activated: () => true }),
      createChannel: (o) => {
        captured.push(o);
        return fakeLark().channel;
      },
    });
    const a = await channel.connect({ appId: "cli_a", appSecret: "s" }, noopEvents);
    const b = await channel.connect({ appId: "cli_b", appSecret: "s" }, noopEvents);
    const first = captured[0]?.cache;
    const second = captured[1]?.cache;
    assert.ok(first !== undefined);
    assert.ok(second !== undefined);
    assert.notEqual(first, second);
    assert.notEqual(first, sdk.internalCache);
    assert.equal(captured[0]?.source, "xtwork");
    assert.equal(captured[0]?.includeRawEvent, true);
    assert.equal(captured[0]?.policy?.requireMention, false);

    await first.set("om_same", "1", Date.now() + 60_000, { namespace: "channel:seen" });
    assert.equal(await second.get("om_same", { namespace: "channel:seen" }), undefined);
    await a.close();
    await b.close();
  });

  it("maps group @-mentions, DMs, threads, attachments, and strips typed @Name", () => {
    const groupMsg = toInbound(makeMessage({}), bot, "周末徒步");
    assert.deepEqual(groupMsg, {
      platformId: "om_1",
      chat: { platformId: "oc_1", kind: "group", name: "周末徒步" },
      sender: { id: "ou_user", name: "张三", isBot: false },
      text: "周六天气怎么样？",
      attachments: [],
      addressedToBot: true,
      mentioned: true,
      sentAt: 1_700_000_000_000,
    });

    assert.equal(toInbound(makeMessage({ chatType: "p2p", mentionedBot: false }), bot, undefined)?.addressedToBot, true);
    assert.equal(toInbound(makeMessage({ mentionedBot: false }), bot, undefined)?.addressedToBot, false);
    assert.equal(toInbound(makeMessage({ senderId: "ou_bot" }), bot, undefined), undefined);

    const threaded = toInbound(
      makeMessage({ threadId: "omt_1", rootId: "om_0", replyToMessageId: "om_0", mentionedBot: false }),
      bot,
      "周末徒步",
    );
    assert.deepEqual(threaded?.chat, {
      platformId: "oc_1:om_0",
      kind: "thread",
      parent: { platformId: "oc_1", name: "周末徒步" },
      followUp: true,
    });
    assert.deepEqual(groupThread("oc_1:om_0"), { chat: "oc_1", root: "om_0" });
    assert.equal(groupThread("oc_1"), undefined);
    assert.equal(groupThread("doc:docx:tok:c1"), undefined);

    const withFiles = toInbound(
      makeMessage({
        content: "@Alex 看看这个路线",
        replyToMessageId: "om_0",
        resources: [
          { type: "file", fileKey: "file_k", fileName: "route.gpx" },
          { type: "image", fileKey: "img_k" },
        ],
        mentions: [
          { key: "@_user_1", openId: "ou_bot", name: "Alex", isBot: true },
          { key: "@_user_2", openId: "ou_other", name: "李四", isBot: false },
        ],
      }),
      bot,
      undefined,
    );
    assert.equal(withFiles?.text, "看看这个路线");
    assert.equal(withFiles?.replyTo, "om_0");
    assert.deepEqual(withFiles?.attachments, [
      { id: "om_1|file|file_k", name: "route.gpx" },
      { id: "om_1|image|img_k", name: "image-2.png", mime: "image/png" },
    ]);
    assert.deepEqual(withFiles?.mentions, [{ id: "ou_other", name: "李四", isBot: false }]);
  });
});

describe("feishu connection, messaging, live cards & comments", () => {
  it("waits for admin approval, then connects and relays messages", async () => {
    let active = false;
    const lark = fakeLark();
    const channel = feishuChannel({
      api: fakeApi({ activated: () => active }),
      approvalPollMs: 15,
      createChannel: () => lark.channel,
    });
    const states: ConnectionState[] = [];
    const received: InboundMessage[] = [];
    const connection = await channel.connect(
      { appId: "cli_1", appSecret: "s" },
      { onMessage: (m) => { received.push(m); }, onState: (s) => states.push(s), onMembership: () => {} },
    );
    assert.deepEqual(states, [{ kind: "awaiting_approval" }]);
    assert.equal(lark.isConnected(), false);
    assert.equal((await connection.send({ chat: { platformId: "oc_1", kind: "group" }, text: "hi" })).kind, "failed");

    active = true;
    await until(() => lark.isConnected());
    assert.deepEqual(states.at(-1), { kind: "connected" });

    await lark.emit("message", makeMessage({}));
    await until(() => received.length === 1);
    assert.equal(received[0]?.chat.name, "周末徒步");
    await connection.close();
  });

  it("sends Markdown, mentions, threads, files, downloads attachments, and maps errors", async () => {
    const lark = fakeLark();
    const channel = feishuChannel({ api: fakeApi({ activated: () => true }), createChannel: () => lark.channel });
    const connection = await channel.connect({ appId: "cli_1", appSecret: "s" }, noopEvents);

    const dir = mkdtempSync(join(tmpdir(), "xtwork-feishu-"));
    try {
      writeFileSync(join(dir, "plan.pdf"), "pdf");
      writeFileSync(join(dir, "map.png"), "png");
      const res = await connection.send({
        chat: { platformId: "oc_1", kind: "group", name: "周末徒步" },
        text: "@王五 **周六**晴",
        replyTo: "om_1",
        mentions: [{ id: "ou_pm", name: "王五" }],
        files: [{ path: join(dir, "plan.pdf") }, { path: join(dir, "map.png") }],
      });
      assert.deepEqual(res, { kind: "sent", platformId: "om_out_3" });
      assert.deepEqual(lark.sent[0]?.input, { markdown: '<at user_id="ou_pm">王五</at> **周六**晴' });
      assert.deepEqual(
        lark.sent.map((s) => Object.keys(s.input as object)[0]),
        ["markdown", "file", "image"],
      );

      // Thread send + inChat send + openDirect
      const opened = await connection.send({
        chat: { platformId: "oc_1", kind: "group", name: "周末徒步" },
        text: "收到",
        replyTo: "om_1",
        inThread: { title: "修登录" },
      });
      assert.ok(opened.kind === "sent");
      assert.equal(opened.thread?.platformId, "oc_1:om_1");
      assert.deepEqual(lark.sent.at(-1)?.opts, { replyTo: "om_1", replyInThread: true });

      await connection.send({ chat: { platformId: "oc_1", kind: "group" }, text: "结论", replyTo: "om_1", inChat: true });
      assert.deepEqual(lark.sent.at(-1)?.opts, {});

      const directTarget = await connection.openDirect?.("ou_9");
      assert.equal(directTarget, "ou_9");
      const directSent = await connection.send({ chat: { platformId: "ou_9", kind: "dm" }, text: "hi" });
      assert.deepEqual(directSent, { kind: "sent", platformId: "om_out_6", chat: "oc_dm_ou_9" });

      // Download attachment
      const dlPath = join(dir, "dl.bin");
      await connection.download({ id: "om_1|file|file_k", name: "route.gpx" }, dlPath);
      assert.equal(readFileSync(dlPath, "utf8"), "bytes:file_k");

      // Error mapping & withTextSent
      lark.failNextSend("rate_limited");
      assert.deepEqual(await connection.send({ chat: { platformId: "oc_1", kind: "group" }, text: "x" }), {
        kind: "failed",
        code: "rate_limited",
        retryable: true,
      });
      lark.failNextSend("send_timeout");
      assert.deepEqual(await connection.send({ chat: { platformId: "oc_1", kind: "group" }, text: "x" }), {
        kind: "uncertain",
      });
      lark.failSecondSend("upload_failed");
      const partial = await connection.send({
        chat: { platformId: "oc_1", kind: "group" },
        text: "with file",
        files: [{ path: join(dir, "plan.pdf") }],
      });
      assert.ok(partial.kind === "failed");
      assert.equal(partial.code, "too_large");
      assert.ok(partial.textSent?.platformId);
    } finally {
      rmSync(dir, { recursive: true, force: true });
      await connection.close();
    }
  });

  it("handles reactions, streaming card renewal past 8 min, and boundedHttp timeouts", async () => {
    let now = 1_700_000_000_000;
    const realNow = Date.now;
    Date.now = () => now;
    let capturedHttp: LarkChannelOptions["httpInstance"];
    const lark = fakeLark();
    const channel = feishuChannel({
      api: fakeApi({ activated: () => true }),
      createChannel: (o) => {
        capturedHttp = o.httpInstance;
        return lark.channel;
      },
    });
    const connection = await channel.connect({ appId: "cli_1", appSecret: "s" }, noopEvents);

    try {
      const chat = { platformId: "oc_1", kind: "group" as const };
      await connection.react(chat, "om_1", "processing");
      await connection.react(chat, "om_1", "done");
      assert.deepEqual(lark.reactions, ["+OnIt", "-r-OnIt", "+DONE"]);

      const live = await connection.startLive?.(chat, { replyTo: "om_1", mention: "ou_asker", initial: "思考中" });
      // Recover from 300309 closed stream
      lark.failUpdates.push(300309);
      await live?.update("处理中 9 分钟");
      assert.equal(lark.cards[0]?.contents.at(-1), "处理中 9 分钟");

      // Proactive renewal after 8 minutes
      now += 8 * 60_000 + 1;
      const beforeSeq = lark.cards[0]?.sequences.length ?? 0;
      await live?.update("处理中 17 分钟");
      assert.equal(lark.cards[0]?.sequences.length, beforeSeq + 2);

      const finishRes = await live?.finish("**完成**");
      assert.deepEqual(finishRes, { kind: "sent", platformId: "om_card" });
      assert.equal(lark.cards[0]?.streaming, false);
      assert.equal(lark.cards[0]?.contents.at(-1), "<at id=ou_asker></at> **完成**");

      // boundedHttp adds 15s timeout only to CardKit, reply, and tenant_access_token
      assert.ok(capturedHttp);
      const origRequest = sdk.defaultHttpInstance.request;
      const origPost = sdk.defaultHttpInstance.post;
      const seenReq: unknown[] = [];
      const seenPost: unknown[] = [];
      sdk.defaultHttpInstance.request = (async (opts: unknown) => {
        seenReq.push(opts);
        return { code: 0, data: {} };
      }) as typeof origRequest;
      sdk.defaultHttpInstance.post = (async (_url: string, _data: unknown, opts: unknown) => {
        seenPost.push(opts);
        return { code: 0, data: {} };
      }) as typeof origPost;
      try {
        await capturedHttp.request({ url: "https://open.feishu.cn/open-apis/cardkit/v1/cards/card_1", method: "PUT" });
        assert.equal((seenReq.at(-1) as { timeout?: number }).timeout, 15_000);
        await capturedHttp.request({ url: "https://open.feishu.cn/open-apis/im/v1/messages/om_1/reply", method: "POST" });
        assert.equal((seenReq.at(-1) as { timeout?: number }).timeout, 15_000);
        await capturedHttp.request({ url: "https://open.feishu.cn/open-apis/im/v1/files/f1", method: "POST" });
        assert.equal((seenReq.at(-1) as { timeout?: number }).timeout, undefined);
        await capturedHttp.post("https://open.feishu.cn/open-apis/auth/v3/tenant_access_token/internal", {});
        assert.equal((seenPost.at(-1) as { timeout?: number } | undefined)?.timeout, 15_000);
        await capturedHttp.post("https://open.feishu.cn/open-apis/im/v1/messages", {});
        assert.equal((seenPost.at(-1) as { timeout?: number } | undefined)?.timeout, undefined);
      } finally {
        sdk.defaultHttpInstance.request = origRequest;
        sdk.defaultHttpInstance.post = origPost;
      }
    } finally {
      Date.now = realNow;
      await connection.close();
    }
  });

  it("reads group history on botAdded, lists human+bot members, and marks other bots without contact lookup", async () => {
    const lark = fakeLark();
    lark.setHistory([
      {
        message_id: "om_4",
        msg_type: "text",
        create_time: "1700000004000",
        chat_id: "oc_9",
        sender: { id: "cli_1", id_type: "app_id", sender_type: "app" },
        body: { content: JSON.stringify({ text: "own old msg" }) },
      },
      {
        message_id: "om_3",
        msg_type: "text",
        create_time: "1700000003000",
        chat_id: "oc_9",
        sender: { id: "cli_ci", id_type: "app_id", sender_type: "app" },
        body: { content: JSON.stringify({ text: "deploy failed" }) },
      },
      {
        message_id: "om_2",
        msg_type: "text",
        create_time: "1700000002000",
        chat_id: "oc_9",
        sender: { id: "ou_li", id_type: "open_id", sender_type: "user" },
        body: { content: JSON.stringify({ text: "@_user_1 周六去哪？" }) },
        mentions: [{ key: "@_user_1", id: "ou_bot", id_type: "open_id", name: "Alex" }],
      },
      { message_id: "om_1", msg_type: "system", chat_id: "oc_9", sender: { id: "x", id_type: "", sender_type: "" } },
    ]);
    const received: InboundMessage[] = [];
    const joined: string[] = [];
    const channel = feishuChannel({ api: fakeApi({ activated: () => true }), createChannel: () => lark.channel });
    const connection = await channel.connect(
      { appId: "cli_1", appSecret: "s" },
      {
        onMessage: (m) => { received.push(m); },
        onState: () => {},
        onMembership: (m) => joined.push(m.chat.platformId),
      },
    );

    await lark.emit("botAdded", { chatId: "oc_9" });
    await until(() => received.length === 2);
    assert.deepEqual(joined, ["oc_9"]);
    assert.deepEqual(
      received.map((m) => [m.platformId, m.text, m.sender.isBot, m.earlier]),
      [
        ["om_2", "周六去哪？", false, true],
        ["om_3", "deploy failed", true, true],
      ],
    );
    assert.deepEqual(lark.contactGets, ["ou_li"]);

    const members = await connection.listMembers({ platformId: "oc_1", kind: "group" });
    assert.deepEqual(members, [
      { id: "ou_1", name: "张三", isBot: false },
      { id: "ou_2", name: "李四", isBot: false },
      { id: "ou_other_bot", name: "值班机器人", isBot: true },
    ]);
    await connection.close();
  });

  it("handles Feishu document comments inbound, outbound, and unreadable fallback", async () => {
    assert.deepEqual(parseThread(threadId({ fileType: "docx", fileToken: "tok", commentId: "c1" })), {
      fileType: "docx",
      fileToken: "tok",
      commentId: "c1",
    });
    assert.equal(flatten("## 结论\n**改成** `Modio`，见 [文档](https://x.cn/a)"), "结论\n改成 Modio，见 文档 https://x.cn/a");
    assert.equal(replyElements("纯文本", undefined).flattened, false);

    const lark = fakeLark();
    const received: InboundMessage[] = [];
    const connection = await feishuChannel({
      api: fakeApi({ activated: () => true }),
      createChannel: () => lark.channel,
    }).connect(
      { appId: "cli_1", appSecret: "s" },
      { onMessage: (m) => { received.push(m); }, onState: () => {}, onMembership: () => {} },
    );

    lark.docThreads.set("c1", {
      quote: "需求评审段落",
      replies: [
        {
          reply_id: "r1",
          user_id: "ou_pm",
          create_time: 1_800_000_000,
          content: { elements: [{ type: "text_run", text_run: { text: "先看一下" } }] },
        },
        {
          reply_id: "r2",
          user_id: "ou_zhang",
          create_time: 1_800_000_010,
          content: {
            elements: [
              { type: "person", person: { user_id: bot.id } },
              { type: "text_run", text_run: { text: " 请总结一下" } },
            ],
          },
        },
      ],
    });
    await lark.emit("comment", {
      fileToken: "doxTOKEN",
      fileType: "docx",
      commentId: "c1",
      replyId: "r2",
      operator: { openId: "ou_zhang" },
      mentionedBot: true,
      timestamp: 1_800_000_010_000,
    });
    await until(() => received.length === 1);
    assert.equal(received[0]?.chat.platformId, "doc:docx:doxTOKEN:c1");
    assert.ok(received[0]?.text.includes("王五: 先看一下"));
    assert.ok(received[0]?.text.endsWith("请总结一下"));

    const sendRes = await connection.send({
      chat: { platformId: "doc:docx:doxTOKEN:c1", kind: "thread" },
      text: "@张云杨 **已整理**",
      mentions: [{ id: "ou_zhang", name: "张云杨" }],
    });
    assert.deepEqual(sendRes, { kind: "sent", platformId: "r_out_1", degraded: ["markdown_flattened"] });

    // Unreadable document reports Xtwork brand (not Mingle)
    lark.setDocUnreadable(true);
    await lark.emit("comment", {
      fileToken: "doxTOKEN",
      fileType: "docx",
      commentId: "c2",
      replyId: "r9",
      operator: { openId: "ou_zhang" },
      mentionedBot: true,
      timestamp: 1_800_000_020_000,
    });
    await until(() => received.length === 2);
    assert.ok(received[1]?.text.includes("Xtwork could not read this comment"));

    lark.failDocCreate(1069303);
    assert.deepEqual(await connection.send({ chat: { platformId: "doc:docx:doxTOKEN:c1", kind: "thread" }, text: "hi" }), {
      kind: "failed",
      code: "forbidden",
      retryable: false,
      detail: "feishu_1069303",
    });
    await connection.close();
  });
});
