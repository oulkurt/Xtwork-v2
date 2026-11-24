/**
 * Explicit connection state machine with generation tokens, exponential backoff,
 * and ADR-011 four-state lifecycle (`idle` | `pairing` | `active` + pause/stop).
 *
 * Adapted from earayu/Mingle (MIT, commit 006220e880d2134665ce2745ab6233f52c8eabe9),
 * src/core/link.ts.
 */

import type { ConnectionState } from "../channels/channel.ts";

/** ADR-011 connection lifecycle phase. */
export type LifecycleState = "idle" | "pairing" | "active";

/** Problems the bridge cannot fix by retrying: the user must act. */
export type StopCode = "credentials_revoked" | "permission_missing" | "credentials_missing";
/** Transient problems: the bridge retries automatically with backoff. */
export type WaitCode = "network" | "unknown";

export type LinkState =
  /** Unbound / silent: zero network activity. */
  | { readonly kind: "idle" }
  /** Explicitly paused by the owner: live connection closed, no auto-reconnect. */
  | { readonly kind: "paused" }
  /** A connect attempt is running, or the adapter is reconnecting by itself. */
  | { readonly kind: "connecting"; readonly attempt: number }
  | { readonly kind: "connected" }
  | { readonly kind: "awaiting_approval" }
  /** Offline; the next attempt starts at `retryAt`. */
  | { readonly kind: "waiting"; readonly attempt: number; readonly code: WaitCode; readonly retryAt: number }
  /** Offline until the person acts (reconnect, reauthorize, or rebind). */
  | { readonly kind: "stopped"; readonly code: StopCode }
  | { readonly kind: "removed" };

export type LinkEvent =
  /** Start, wake from sleep, or explicit reconnect: a fresh attempt now. */
  | { readonly kind: "connect" }
  /** The connect attempt resolved with a live connection. */
  | { readonly kind: "opened"; readonly generation?: number }
  /** The connect attempt threw. `code` is what the adapter reported, if anything. */
  | { readonly kind: "failed"; readonly code?: StopCode | WaitCode; readonly generation?: number }
  /** The adapter reported a state of its live connection. */
  | { readonly kind: "reported"; readonly state: ConnectionState; readonly generation?: number }
  /** The retry timer fired. */
  | { readonly kind: "timer" }
  /** Owner paused the connection. */
  | { readonly kind: "pause" }
  /** Owner resumed the connection. */
  | { readonly kind: "resume" }
  /** System woke from sleep (>60s clock drift): force fresh reconnect of active links. */
  | { readonly kind: "sleep_wake" }
  /** Enter pairing phase (temporary connection accepting ONLY 6-digit claim DM). */
  | { readonly kind: "enter_pairing" }
  /** Claim succeeded or onboarding returned ownerId: enter active phase. */
  | { readonly kind: "activate" }
  /** Disconnected / removed permanently. */
  | { readonly kind: "remove" };

export type LinkEffect =
  /** Close the current live connection (if any) and start a connect attempt. */
  | "connect"
  /** Close the current live connection and arm the retry timer. */
  | "retry_later"
  /** Close the current live connection; nothing runs until the person acts. */
  | "close"
  /** The attempt resolved too late (generation or state moved on): close the returned connection. */
  | "discard"
  | "none";

/** Full link machine state carrying lifecycle phase and monotonically increasing generation token. */
export interface LinkMachine {
  readonly lifecycle: LifecycleState;
  readonly state: LinkState;
  readonly generation: number;
}

/** Waits between automatic attempts (`5s, 15s, 30s, 1m, 2m, 5m`); the last one repeats. */
export const BACKOFF_MS: readonly number[] = [5_000, 15_000, 30_000, 60_000, 120_000, 300_000];

export function backoff(attempt: number, delays: readonly number[] = BACKOFF_MS): number {
  return delays[Math.min(Math.max(0, attempt), delays.length - 1)] ?? 300_000;
}

const STOPS: readonly string[] = ["credentials_revoked", "permission_missing", "credentials_missing"];

export function createLinkMachine(lifecycle: LifecycleState = "idle"): LinkMachine {
  return {
    lifecycle,
    state: lifecycle === "idle" ? { kind: "idle" } : { kind: "connecting", attempt: 0 },
    generation: 0,
  };
}

function offline(
  attempt: number,
  code: StopCode | WaitCode | undefined,
  now: number,
  delays: readonly number[],
): LinkState {
  if (code && STOPS.includes(code)) return { kind: "stopped", code: code as StopCode };
  return {
    kind: "waiting",
    attempt: attempt + 1,
    code: (code as WaitCode) ?? "network",
    retryAt: now + backoff(attempt, delays),
  };
}

function settle(next: LinkState): { state: LinkState; effect: LinkEffect } {
  return { state: next, effect: next.kind === "waiting" ? "retry_later" : "close" };
}

function attemptOf(state: LinkState): number {
  return state.kind === "connecting" || state.kind === "waiting" ? state.attempt : 0;
}

/**
 * Pure transition for `LinkState` (Mingle-compatible).
 * Prefer `stepMachine` when tracking `generation` tokens and `idle`/`pairing`/`active` lifecycles.
 */
export function step(
  state: LinkState,
  event: LinkEvent,
  now: number,
  delays: readonly number[] = BACKOFF_MS,
): { state: LinkState; effect: LinkEffect } {
  if (state.kind === "removed") return { state, effect: event.kind === "opened" ? "discard" : "none" };
  switch (event.kind) {
    case "remove":
      return { state: { kind: "removed" }, effect: "close" };
    case "pause":
      if (state.kind === "idle" || state.kind === "paused") return { state, effect: "none" };
      return { state: { kind: "paused" }, effect: "close" };
    case "resume":
      if (state.kind !== "paused") return { state, effect: "none" };
      return { state: { kind: "connecting", attempt: 0 }, effect: "connect" };
    case "enter_pairing":
    case "activate":
      if (state.kind === "idle") return { state: { kind: "connecting", attempt: 0 }, effect: "connect" };
      return { state, effect: "none" };
    case "sleep_wake":
      if (state.kind === "idle" || state.kind === "paused" || state.kind === "stopped") {
        return { state, effect: "none" };
      }
      return { state: { kind: "connecting", attempt: 0 }, effect: "connect" };
    case "connect":
      return { state: { kind: "connecting", attempt: 0 }, effect: "connect" };
    case "timer":
      return state.kind === "waiting"
        ? { state: { kind: "connecting", attempt: state.attempt }, effect: "connect" }
        : { state, effect: "none" };
    case "opened":
      if (state.kind === "connecting") return { state: { kind: "connected" }, effect: "none" };
      if (state.kind === "connected" || state.kind === "awaiting_approval") return { state, effect: "none" };
      return { state, effect: "discard" };
    case "failed":
      if (state.kind === "waiting" || state.kind === "stopped" || state.kind === "paused" || state.kind === "idle") {
        return { state, effect: "none" };
      }
      return settle(offline(attemptOf(state), event.code, now, delays));
    case "reported": {
      if (state.kind === "idle" || state.kind === "paused") return { state, effect: "none" };
      const reported = event.state;
      if (reported.kind === "connected") return { state: { kind: "connected" }, effect: "none" };
      if (reported.kind === "awaiting_approval") return { state: { kind: "awaiting_approval" }, effect: "none" };
      if (reported.kind === "connecting" || reported.kind === "reconnecting") {
        return { state: { kind: "connecting", attempt: attemptOf(state) }, effect: "none" };
      }
      if (state.kind === "waiting" || state.kind === "stopped") return { state, effect: "none" };
      return settle(offline(attemptOf(state), reported.code, now, delays));
    }
  }
}

/**
 * Pure generation-guarded transition for `LinkMachine`.
 *
 * Every new connect attempt increments `generation`. Stale `opened` callbacks from an older
 * generation immediately return `effect: "discard"` so orphaned sockets are closed; stale
 * `failed` / `reported` callbacks are ignored cleanly.
 */
export function stepMachine(
  machine: LinkMachine,
  event: LinkEvent,
  now: number,
  delays: readonly number[] = BACKOFF_MS,
): { machine: LinkMachine; effect: LinkEffect } {
  if (machine.state.kind === "removed") {
    return { machine, effect: event.kind === "opened" ? "discard" : "none" };
  }

  // Discard stale async results from superseded generations.
  if (
    (event.kind === "opened" || event.kind === "failed" || event.kind === "reported") &&
    event.generation !== undefined &&
    event.generation !== machine.generation
  ) {
    return { machine, effect: event.kind === "opened" ? "discard" : "none" };
  }

  switch (event.kind) {
    case "remove":
      return {
        machine: { lifecycle: "idle", state: { kind: "removed" }, generation: machine.generation + 1 },
        effect: "close",
      };
    case "enter_pairing": {
      const nextGen = machine.state.kind === "idle" ? machine.generation + 1 : machine.generation;
      const shouldConnect = machine.state.kind === "idle";
      return {
        machine: {
          lifecycle: "pairing",
          state: shouldConnect ? { kind: "connecting", attempt: 0 } : machine.state,
          generation: nextGen,
        },
        effect: shouldConnect ? "connect" : "none",
      };
    }
    case "activate": {
      const shouldConnect = machine.state.kind === "idle";
      return {
        machine: {
          lifecycle: "active",
          state: shouldConnect ? { kind: "connecting", attempt: 0 } : machine.state,
          generation: shouldConnect ? machine.generation + 1 : machine.generation,
        },
        effect: shouldConnect ? "connect" : "none",
      };
    }
    case "connect": {
      if (machine.lifecycle === "idle") {
        return { machine, effect: "none" };
      }
      return {
        machine: {
          lifecycle: machine.lifecycle,
          state: { kind: "connecting", attempt: 0 },
          generation: machine.generation + 1,
        },
        effect: "connect",
      };
    }
    case "pause": {
      if (machine.state.kind === "idle" || machine.state.kind === "paused") {
        return { machine, effect: "none" };
      }
      return {
        machine: {
          lifecycle: machine.lifecycle,
          state: { kind: "paused" },
          generation: machine.generation + 1,
        },
        effect: "close",
      };
    }
    case "resume": {
      if (machine.state.kind !== "paused" || machine.lifecycle === "idle") {
        return { machine, effect: "none" };
      }
      return {
        machine: {
          lifecycle: machine.lifecycle,
          state: { kind: "connecting", attempt: 0 },
          generation: machine.generation + 1,
        },
        effect: "connect",
      };
    }
    case "sleep_wake": {
      if (
        machine.lifecycle === "idle" ||
        machine.state.kind === "idle" ||
        machine.state.kind === "paused" ||
        machine.state.kind === "stopped"
      ) {
        return { machine, effect: "none" };
      }
      return {
        machine: {
          lifecycle: machine.lifecycle,
          state: { kind: "connecting", attempt: 0 },
          generation: machine.generation + 1,
        },
        effect: "connect",
      };
    }
    case "timer": {
      if (machine.lifecycle === "idle" || machine.state.kind !== "waiting") {
        return { machine, effect: "none" };
      }
      return {
        machine: {
          lifecycle: machine.lifecycle,
          state: { kind: "connecting", attempt: machine.state.attempt },
          generation: machine.generation + 1,
        },
        effect: "connect",
      };
    }
    default: {
      const next = step(machine.state, event, now, delays);
      const bumped = next.effect === "close" || next.effect === "retry_later" ? machine.generation + 1 : machine.generation;
      return {
        machine: { lifecycle: machine.lifecycle, state: next.state, generation: bumped },
        effect: next.effect,
      };
    }
  }
}

export type StoredLinkState = "idle" | "paused" | "reconnecting" | "connected" | "awaiting_approval" | "error";

/** How a link state is persisted in `connections` and emitted to T3. */
export function stored(state: LinkState): {
  state: StoredLinkState;
  stateDetail: string | null;
} {
  switch (state.kind) {
    case "idle":
      return { state: "idle", stateDetail: null };
    case "paused":
      return { state: "paused", stateDetail: null };
    case "connecting":
    case "removed":
      return { state: "reconnecting", stateDetail: null };
    case "connected":
      return { state: "connected", stateDetail: null };
    case "awaiting_approval":
      return { state: "awaiting_approval", stateDetail: null };
    case "waiting":
    case "stopped":
      return { state: "error", stateDetail: state.code };
  }
}
