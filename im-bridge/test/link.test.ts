import assert from "node:assert/strict";
import { describe, it } from "node:test";
import {
  BACKOFF_MS,
  backoff,
  createLinkMachine,
  step,
  stepMachine,
  stored,
} from "../src/core/link.ts";

describe("link state machine", () => {
  it("uses exact ADR-011 backoff schedule (5s, 15s, 30s, 1m, 2m, 5m) and clamps at 5m", () => {
    assert.deepEqual(BACKOFF_MS, [5_000, 15_000, 30_000, 60_000, 120_000, 300_000]);
    assert.equal(backoff(0), 5_000);
    assert.equal(backoff(1), 15_000);
    assert.equal(backoff(2), 30_000);
    assert.equal(backoff(3), 60_000);
    assert.equal(backoff(4), 120_000);
    assert.equal(backoff(5), 300_000);
    assert.equal(backoff(99), 300_000);
  });

  it("stays silent in idle lifecycle with zero network attempts", () => {
    const idle = createLinkMachine("idle");
    assert.equal(idle.state.kind, "idle");
    const r1 = stepMachine(idle, { kind: "connect" }, 1000);
    assert.equal(r1.effect, "none");
    assert.equal(r1.machine.state.kind, "idle");

    const r2 = stepMachine(idle, { kind: "sleep_wake" }, 2000);
    assert.equal(r2.effect, "none");
    assert.equal(r2.machine.state.kind, "idle");
  });

  it("transitions idle -> pairing -> active and tracks generation tokens", () => {
    let m = createLinkMachine("idle");
    let res = stepMachine(m, { kind: "enter_pairing" }, 1000);
    assert.equal(res.effect, "connect");
    assert.equal(res.machine.lifecycle, "pairing");
    assert.equal(res.machine.state.kind, "connecting");
    assert.equal(res.machine.generation, 1);
    m = res.machine;

    res = stepMachine(m, { kind: "opened", generation: 1 }, 1100);
    assert.equal(res.effect, "none");
    assert.equal(res.machine.state.kind, "connected");
    m = res.machine;

    // Claim succeeded -> activate keeps live connection without reconnecting
    res = stepMachine(m, { kind: "activate" }, 1200);
    assert.equal(res.effect, "none");
    assert.equal(res.machine.lifecycle, "active");
    assert.equal(res.machine.state.kind, "connected");
  });

  it("discards stale opened callbacks and ignores stale failures from old generations", () => {
    let m = createLinkMachine("active");
    let res = stepMachine(m, { kind: "connect" }, 1000);
    const gen1 = res.machine.generation;
    m = res.machine;

    // Sleep-wake forces a fresh generation
    res = stepMachine(m, { kind: "sleep_wake" }, 2000);
    const gen2 = res.machine.generation;
    assert.ok(gen2 > gen1);
    assert.equal(res.effect, "connect");
    m = res.machine;

    // Late `opened` from gen1 must be discarded!
    const staleOpen = stepMachine(m, { kind: "opened", generation: gen1 }, 2100);
    assert.equal(staleOpen.effect, "discard");
    assert.equal(staleOpen.machine.state.kind, "connecting");

    // Late `failed` from gen1 must be ignored!
    const staleFail = stepMachine(m, { kind: "failed", code: "credentials_revoked", generation: gen1 }, 2200);
    assert.equal(staleFail.effect, "none");
    assert.equal(staleFail.machine.state.kind, "connecting");

    // Current gen2 opens cleanly
    const currentOpen = stepMachine(m, { kind: "opened", generation: gen2 }, 2300);
    assert.equal(currentOpen.effect, "none");
    assert.equal(currentOpen.machine.state.kind, "connected");
  });

  it("retries transient network failures with backoff and stops on revoked credentials", () => {
    let m = createLinkMachine("active");
    let res = stepMachine(m, { kind: "connect" }, 1000);
    m = res.machine;

    res = stepMachine(m, { kind: "failed", code: "network", generation: m.generation }, 1000);
    assert.equal(res.effect, "retry_later");
    assert.deepEqual(res.machine.state, { kind: "waiting", attempt: 1, code: "network", retryAt: 6_000 });
    assert.deepEqual(stored(res.machine.state), { state: "error", stateDetail: "network" });
    m = res.machine;

    res = stepMachine(m, { kind: "timer" }, 6_000);
    assert.equal(res.effect, "connect");
    assert.deepEqual(res.machine.state, { kind: "connecting", attempt: 1 });
    m = res.machine;

    res = stepMachine(m, { kind: "failed", code: "network", generation: m.generation }, 6_000);
    assert.equal(res.effect, "retry_later");
    assert.deepEqual(res.machine.state, { kind: "waiting", attempt: 2, code: "network", retryAt: 21_000 });
    m = res.machine;

    // Permanent auth failure stops automatic retries
    res = stepMachine(m, { kind: "connect" }, 25_000);
    m = res.machine;
    res = stepMachine(m, { kind: "failed", code: "credentials_revoked", generation: m.generation }, 25_100);
    assert.equal(res.effect, "close");
    assert.deepEqual(res.machine.state, { kind: "stopped", code: "credentials_revoked" });
  });

  it("supports pause, resume, and pure step removal", () => {
    let m = createLinkMachine("active");
    m = stepMachine(m, { kind: "connect" }, 0).machine;
    m = stepMachine(m, { kind: "opened", generation: m.generation }, 10).machine;

    const paused = stepMachine(m, { kind: "pause" }, 20);
    assert.equal(paused.effect, "close");
    assert.equal(paused.machine.state.kind, "paused");
    assert.deepEqual(stored(paused.machine.state), { state: "paused", stateDetail: null });

    // Sleep wake while paused must NOT reconnect
    assert.equal(stepMachine(paused.machine, { kind: "sleep_wake" }, 100_000).effect, "none");

    const resumed = stepMachine(paused.machine, { kind: "resume" }, 100_100);
    assert.equal(resumed.effect, "connect");
    assert.equal(resumed.machine.state.kind, "connecting");

    const removed = step({ kind: "connected" }, { kind: "remove" }, 200);
    assert.equal(removed.state.kind, "removed");
    assert.equal(removed.effect, "close");
    assert.equal(step(removed.state, { kind: "opened" }, 201).effect, "discard");
  });
});
