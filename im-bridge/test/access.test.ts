import assert from "node:assert/strict";
import { describe, it } from "node:test";
import {
  CLAIM_MAX_ATTEMPTS,
  CLAIM_TTL_MS,
  claimAttempt,
  claimCode,
  evaluatePairingClaim,
  gate,
} from "../src/core/access.ts";

describe("access gate and pairing claim verification", () => {
  it("enforces owner, blocked contact, chat access, trust, and askAll rules", () => {
    // Owner always allowed when active
    assert.equal(
      gate({ trust: "public", askAll: true, isOwner: true, chatKind: "dm", contact: "blocked", group: "blocked" }),
      "deliver",
    );
    // Blocked contact stays dropped even in an allowed group
    assert.equal(
      gate({ trust: "org", askAll: false, isOwner: false, chatKind: "group", contact: "blocked", group: "allowed" }),
      "drop",
    );
    // Allowed group lets undecided members collaborate
    assert.equal(
      gate({ trust: "public", askAll: true, isOwner: false, chatKind: "group", contact: null, group: "allowed" }),
      "deliver",
    );
    // Blocked group drops undecided members
    assert.equal(
      gate({ trust: "org", askAll: false, isOwner: false, chatKind: "group", contact: "allowed", group: "blocked" }),
      "drop",
    );
    // Org default delivers unless askAll=true
    assert.equal(
      gate({ trust: "org", askAll: false, isOwner: false, chatKind: "group", contact: null, group: null }),
      "deliver",
    );
    assert.equal(
      gate({ trust: "org", askAll: true, isOwner: false, chatKind: "group", contact: null, group: null }),
      "ask",
    );
    // Public and owner platforms ask on undecided strangers
    assert.equal(
      gate({ trust: "public", askAll: false, isOwner: false, chatKind: "dm", contact: null, group: null }),
      "ask",
    );
    assert.equal(
      gate({ trust: "owner", askAll: false, isOwner: false, chatKind: "dm", contact: null, group: null }),
      "ask",
    );
  });

  it("drops everything in idle or pairing lifecycle states", () => {
    assert.equal(
      gate({ lifecycleState: "idle", trust: "org", askAll: false, isOwner: true, chatKind: "dm", contact: "allowed", group: "allowed" }),
      "drop",
    );
    assert.equal(
      gate({ lifecycleState: "pairing", trust: "org", askAll: false, isOwner: false, chatKind: "dm", contact: "allowed", group: "allowed" }),
      "drop",
    );
  });

  it("generates 6-digit claim codes and parses claim attempts", () => {
    for (let i = 0; i < 20; i++) {
      assert.match(claimCode(), /^\d{6}$/);
    }
    assert.equal(claimAttempt("123456"), "123456");
    assert.equal(claimAttempt("  /start 042918 "), "042918");
    assert.equal(claimAttempt("hello 123456"), undefined);
    assert.equal(claimAttempt("12345"), undefined);
    assert.equal(claimAttempt("1234567"), undefined);
  });

  it("enforces strict pairing rules: DM only, 10m TTL, max 5 wrong attempts", () => {
    const now = 1_700_000_000_000;
    const expiresAt = now + CLAIM_TTL_MS;
    assert.equal(CLAIM_TTL_MS, 600_000);
    assert.equal(CLAIM_MAX_ATTEMPTS, 5);

    // Group message with exact code MUST be rejected
    assert.deepEqual(
      evaluatePairingClaim({ chatKind: "group", text: "654321", expectedCode: "654321", expiresAt, attempts: 0, now }),
      { kind: "reject", reason: "not_dm" },
    );
    // Non-code DM MUST be rejected
    assert.deepEqual(
      evaluatePairingClaim({ chatKind: "dm", text: "hello bot", expectedCode: "654321", expiresAt, attempts: 0, now }),
      { kind: "reject", reason: "not_claim_format" },
    );
    // Wrong attempts count up to 5 and exhaust on 5th
    for (let a = 0; a < 5; a++) {
      assert.deepEqual(
        evaluatePairingClaim({ chatKind: "dm", text: "000000", expectedCode: "654321", expiresAt, attempts: a, now }),
        { kind: "wrong_code", attempts: a + 1, exhausted: a + 1 >= 5 },
      );
    }
    // Once attempts === 5, even the right code is rejected
    assert.deepEqual(
      evaluatePairingClaim({ chatKind: "dm", text: "654321", expectedCode: "654321", expiresAt, attempts: 5, now }),
      { kind: "reject", reason: "exhausted" },
    );
    // Expired code rejected
    assert.deepEqual(
      evaluatePairingClaim({ chatKind: "dm", text: "654321", expectedCode: "654321", expiresAt, attempts: 0, now: expiresAt + 1 }),
      { kind: "reject", reason: "expired" },
    );
    // Valid DM within TTL succeeds
    assert.deepEqual(
      evaluatePairingClaim({ chatKind: "dm", text: "/start 654321", expectedCode: "654321", expiresAt, attempts: 4, now: expiresAt }),
      { kind: "claimed" },
    );
  });
});
