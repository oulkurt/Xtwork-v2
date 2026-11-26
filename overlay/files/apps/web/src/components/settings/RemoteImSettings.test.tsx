import { describe, expect, it } from "vite-plus/test";
import { accessTarget, applyOnboardingEvent, resolveChannelStatus } from "./RemoteImSettings";
import {
  formatOnboardingFailure,
  REMOTE_IM_CARD_DESCRIPTION,
  REMOTE_IM_CHANNEL_ORDER,
  REMOTE_IM_CHANNELS,
} from "./remoteImThemes";

describe("RemoteImSettings", () => {
  it("keeps onboarding events scoped to the active platform and bound session id", () => {
    const current = { platform: "feishu" as const, id: "one", state: "connecting" };
    expect(applyOnboardingEvent(current, { onboardingId: "two", platform: "wecom", state: "connected" })).toEqual(current);
    expect(applyOnboardingEvent(current, { onboardingId: "one", platform: "feishu", state: "pairing", claimCode: "123456" })).toMatchObject({
      state: "pairing",
      claim: "123456",
    });
    // An unbound replacement session must ignore late events from a cancelled older session.
    const unbound = { platform: "feishu" as const, state: "connecting" };
    expect(
      applyOnboardingEvent(unbound, {
        sessionId: "old-session",
        platform: "feishu",
        event: { kind: "failed", code: "cancelled" },
      }),
    ).toEqual(unbound);
    expect(
      applyOnboardingEvent(unbound, { sessionId: "new-session", platform: "feishu" }, { allowBind: true }),
    ).toMatchObject({ id: "new-session", state: "connecting" });
  });

  it("treats succeeded with lifecycleState active as terminal while preserving pairing claim flow", () => {
    const wechat = { platform: "wechat" as const, id: "s-wx", state: "qr_ready", qr: "https://weixin.qq.com/qr" };
    expect(
      applyOnboardingEvent(wechat, {
        sessionId: "s-wx",
        platform: "wechat",
        event: { kind: "succeeded", lifecycleState: "active", connectionId: "conn-1" },
      }),
    ).toMatchObject({ state: "succeeded", connectionId: "conn-1" });

    const wecom = { platform: "wecom" as const, id: "s-wc", state: "connecting" };
    expect(
      applyOnboardingEvent(wecom, {
        sessionId: "s-wc",
        platform: "wecom",
        event: { kind: "succeeded", lifecycleState: "pairing", connectionId: "conn-2", claimCode: "654321" },
      }),
    ).toMatchObject({ state: "pairing", connectionId: "conn-2", claim: "654321" });
  });

  it("derives card status badges from transport state rather than lifecycle alone", () => {
    expect(
      resolveChannelStatus("feishu", [{ platform: "feishu", lifecycleState: "active", state: "error" }]),
    ).toEqual({ label: "连接异常", tone: "error" });
    expect(
      resolveChannelStatus("feishu", [{ platform: "feishu", lifecycleState: "active", state: "awaiting_approval" }]),
    ).toEqual({ label: "等待管理员审批", tone: "warning" });
    expect(
      resolveChannelStatus("feishu", [
        { platform: "feishu", lifecycleState: "active", state: "connected" },
        { platform: "feishu", lifecycleState: "active", state: "error" },
      ]),
    ).toEqual({ label: "已连接", tone: "connected" });
    expect(
      resolveChannelStatus("feishu", [
        { platform: "feishu", lifecycleState: "active", state: "connected" },
        { platform: "feishu", lifecycleState: "active", state: "connected" },
      ]),
    ).toEqual({ label: "已连接 · 2", tone: "connected" });
    expect(
      resolveChannelStatus(
        "feishu",
        [{ platform: "feishu", lifecycleState: "active", state: "connected" }],
        false,
      ),
    ).toEqual({ label: "无法确认在线", tone: "warning" });
    expect(resolveChannelStatus("feishu", [], false)).toEqual({ label: "暂不可用", tone: "idle" });
  });

  it("maps onboarding failure codes to human-readable Chinese messages", () => {
    const current = { platform: "wecom" as const, id: "s1", state: "connecting" };
    expect(
      applyOnboardingEvent(current, {
        sessionId: "s1",
        platform: "wecom",
        event: { kind: "failed", code: "invalid_credentials" },
      }),
    ).toMatchObject({
      state: "failed",
      errorCode: "invalid_credentials",
      message: formatOnboardingFailure("invalid_credentials"),
    });
    expect(formatOnboardingFailure("expired")).toContain("已过期");
  });

  it("exposes Feishu, WeCom, and WeChat cards with the exact description and manual support flags", () => {
    expect(REMOTE_IM_CHANNEL_ORDER).toEqual(["feishu", "wecom", "wechat"]);
    expect(REMOTE_IM_CARD_DESCRIPTION).toBe("点击翻转扫描二维码即刻连接你的聊天软件");
    expect(REMOTE_IM_CHANNELS.feishu.supportsManual).toBe(true);
    expect(REMOTE_IM_CHANNELS.wecom.supportsManual).toBe(true);
    expect(REMOTE_IM_CHANNELS.wechat.supportsManual).toBe(false);
  });

  it("maps held DM, group, and thread requests to the right access.decide target", () => {
    expect(accessTarget({ chatId: "c_dm", contactId: "k_alice", chat: { kind: "dm", parentId: null } })).toEqual({
      targetKind: "contact",
      targetId: "k_alice",
    });
    expect(accessTarget({ chatId: "c_grp", contactId: "k_bob", chat: { kind: "group", parentId: null } })).toEqual({
      targetKind: "chat",
      targetId: "c_grp",
    });
    expect(accessTarget({ chatId: "c_thr", contactId: "k_bob", chat: { kind: "thread", parentId: "c_grp" } })).toEqual({
      targetKind: "chat",
      targetId: "c_grp",
    });
  });
});
