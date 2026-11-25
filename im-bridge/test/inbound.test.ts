import assert from "node:assert/strict";
import { describe, it } from "node:test";
import {
  FINAL_INBOUND,
  INBOUND,
  type InboundEvent,
  type InboundState,
  isDeliverableInbound,
  isFinalInbound,
  nextInbound,
} from "../src/core/inbound.ts";

describe("inbound message state machine", () => {
  it("handles all 9 states and valid transitions", () => {
    assert.equal(nextInbound("held", "admit"), "received");
    assert.equal(nextInbound("held", "refuse"), "blocked");
    assert.equal(nextInbound("held", "deliver"), undefined);

    assert.equal(nextInbound("received", "deliver"), "delivered");
    assert.equal(nextInbound("delivered", "requeue"), "received");
    assert.equal(nextInbound("delivered", "give_up"), "unanswered");
    assert.equal(nextInbound("received", "fail"), "failed");
    assert.equal(nextInbound("delivered", "fail"), "failed");
    assert.equal(nextInbound("received", "hold"), "waiting");
    assert.equal(nextInbound("delivered", "hold"), "waiting");
    assert.equal(nextInbound("waiting", "resume"), "received");
    assert.equal(nextInbound("waiting", "retry"), "received");
    assert.equal(nextInbound("failed", "retry"), "received");
    assert.equal(nextInbound("unanswered", "retry"), "received");
    assert.equal(nextInbound("delivered", "reply"), "replied");
    assert.equal(nextInbound("failed", "reply"), "replied");
    assert.equal(nextInbound("delivered", "send"), "replied");
    assert.equal(nextInbound("failed", "send"), undefined);
    assert.equal(nextInbound("received", "pause"), "paused_pending");
    assert.equal(nextInbound("waiting", "pause"), "paused_pending");
    // S28: Unacked `delivered` messages may be paused (store enforces `acked_at IS NULL AND t3_turn_id IS NULL`).
    assert.equal(nextInbound("delivered", "pause"), "paused_pending");
    assert.equal(nextInbound("held", "admit_paused"), "paused_pending");
    assert.equal(nextInbound("paused_pending", "replay_paused"), "received");
    assert.equal(nextInbound("paused_pending", "dismiss_paused"), "ignored");
    assert.equal(nextInbound("failed", "ignore"), "ignored");
  });

  it("keeps replied, ignored, and blocked strictly terminal", () => {
    assert.deepEqual(FINAL_INBOUND, ["replied", "ignored", "blocked"]);
    const events = Object.keys(INBOUND) as InboundEvent[];
    for (const terminal of FINAL_INBOUND) {
      assert.equal(isFinalInbound(terminal), true);
      for (const event of events) {
        assert.equal(nextInbound(terminal, event), undefined, `${terminal} must reject ${event}`);
      }
    }
  });

  it("marks ONLY received and delivered as deliverable for crash-recovery replay", () => {
    const allStates: InboundState[] = [
      "held",
      "paused_pending",
      "received",
      "delivered",
      "waiting",
      "replied",
      "unanswered",
      "failed",
      "ignored",
      "blocked",
    ];
    for (const state of allStates) {
      assert.equal(isDeliverableInbound(state), state === "received" || state === "delivered");
    }
  });
});
