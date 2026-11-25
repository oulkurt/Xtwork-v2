import { describe, expect, it } from "vite-plus/test";
import { accessTarget, applyOnboardingEvent } from "./RemoteImSettings";

describe("RemoteImSettings", () => {
  it("keeps onboarding events scoped to the active platform", () => {
    const current = { platform: "feishu" as const, id: "one", state: "connecting" };
    expect(applyOnboardingEvent(current, { onboardingId: "two", platform: "wecom", state: "connected" })).toEqual(current);
    expect(applyOnboardingEvent(current, { onboardingId: "one", platform: "feishu", state: "pairing", claimCode: "123456" })).toMatchObject({
      state: "pairing",
      claim: "123456",
    });
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
