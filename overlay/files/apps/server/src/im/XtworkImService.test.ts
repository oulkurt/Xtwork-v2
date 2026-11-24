import { describe, expect, it } from "vite-plus/test";
import { dispatchIdentity, inboundMessage, sameAudience } from "./XtworkImDispatch.ts";

describe("XtworkImService routing", () => {
  it("normalizes the end-to-end idempotency key", () => {
    const route = inboundMessage({
      connectionId: "connection",
      platformMsgId: "message",
      chatId: "chat",
      chatKind: "dm",
      senderRole: "owner",
      text: "hello",
    });
    const identity = dispatchIdentity(route, "/tmp/im");
    expect(route.key).toBe("im:connection:message");
    expect(route.replyAudience).toBe("owner_dm");
    expect(identity.threadId).toContain("xtwork-im-dm-");
    expect(identity.context.companionScope).toBe("private");
    expect(identity.context.isolatedWorkspaceRoot).toContain("/workspaces/private/");
  });

  it("isolates non-owner DMs and owner group messages from owner private scope", () => {
    const memberDm = inboundMessage({
      connectionId: "connection",
      platformMsgId: "dm-member",
      chatId: "chat-member",
      chatKind: "dm",
      senderRole: "member",
      replyAudience: "owner_dm",
    });
    const memberIdentity = dispatchIdentity(memberDm, "/tmp/im");
    expect(memberIdentity.context.replyAudience).toBe("group");
    expect(memberIdentity.context.companionScope).toMatch(/^group:/u);
    expect(memberIdentity.context.isolatedWorkspaceRoot).not.toContain("/workspaces/private/");

    const ownerGroup = inboundMessage({
      connectionId: "connection",
      platformMsgId: "grp-owner",
      chatId: "chat-group",
      chatKind: "group",
      senderRole: "owner",
      replyAudience: "owner_dm",
    });
    const ownerGroupIdentity = dispatchIdentity(ownerGroup, "/tmp/im");
    expect(ownerGroupIdentity.context.replyAudience).toBe("group");
    expect(ownerGroupIdentity.context.companionScope).toMatch(/^group:/u);
    expect(ownerGroupIdentity.context.isolatedWorkspaceRoot).not.toContain("/workspaces/private/");
  });

  it("keeps group and private audiences separate", () => {
    const group = inboundMessage({
      connectionId: "connection",
      platformMsgId: "message",
      chatId: "chat",
      chatKind: "group",
      senderRole: "member",
    });
    const identity = dispatchIdentity(group, "/tmp/im");
    expect(identity.context.replyAudience).toBe("group");
    expect(identity.context.companionScope).toMatch(/^group:/u);
    expect(sameAudience(identity.context, { ...identity.context, replyAudience: "owner_dm" })).toBe(false);
  });

  it("rejects a mismatched idempotency key", () => {
    expect(() => inboundMessage({
      connectionId: "connection",
      platformMsgId: "message",
      chatId: "chat",
      chatKind: "dm",
      senderRole: "owner",
      idempotencyKey: "wrong",
    })).toThrow("delivery key");
  });
});
