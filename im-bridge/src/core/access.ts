/**
 * Access gate and pairing claim-code verification.
 *
 * Adapted from earayu/Mingle (MIT, commit 006220e880d2134665ce2745ab6233f52c8eabe9),
 * src/core/access.ts, enforcing ADR-011 strict `pairing` isolation:
 * - While a connection is in `idle` or `pairing`, `gate()` NEVER returns `deliver` or `ask`.
 * - In `pairing`, ONLY a direct message containing the valid 6-digit claim code (10m TTL,
 *   max 5 wrong attempts) can claim the Owner role; T3 is never woken.
 */

import { randomInt, timingSafeEqual } from "node:crypto";
import type { ChatKind, Trust } from "../channels/channel.ts";
import type { LifecycleState } from "./link.ts";

/** Whether a person or group may interact with the assistant: null until decided. */
export type Access = "allowed" | "blocked" | null;

/**
 * Gate outcome:
 * - `deliver`: allowed; trigger messages proceed to T3, group background enters allowed-chat cache.
 * - `ask`: pending owner review (`held` for trigger messages only; background chatter is dropped).
 * - `drop`: refused/blocked or connection not active; silently dropped and never enters background search.
 */
export type Verdict = "deliver" | "ask" | "drop";

export interface GateInput {
  /** Connection lifecycle phase; defaults to `"active"` when omitted by pure unit tests. */
  readonly lifecycleState?: LifecycleState;
  /** What the bot's chat app declares about who can reach it. */
  readonly trust: Trust;
  /** Owner requested approval for all new people and groups regardless of platform trust. */
  readonly askAll: boolean;
  readonly isOwner: boolean;
  readonly chatKind: ChatKind;
  readonly contact: Access;
  /** For a group or thread: the group's access (a thread inherits its group's access). */
  readonly group: Access;
}

export function gate(input: GateInput): Verdict {
  // ADR-011 §2: `idle` and `pairing` connections MUST NEVER wake T3 or store held/background traffic.
  if (input.lifecycleState !== undefined && input.lifecycleState !== "active") {
    return "drop";
  }
  if (input.isOwner) return "deliver";
  // Someone the owner refused stays refused everywhere, groups included.
  if (input.contact === "blocked") return "drop";
  const decided = input.chatKind === "dm" ? input.contact : input.group;
  if (decided === "allowed") return "deliver";
  if (decided === "blocked") return "drop";
  return input.trust !== "org" || input.askAll ? "ask" : "deliver";
}

/** Claim code lifetime: 10 minutes. */
export const CLAIM_TTL_MS = 10 * 60_000;
/** Maximum wrong claim codes before the active code is invalidated. */
export const CLAIM_ATTEMPTS = 5;
export const CLAIM_MAX_ATTEMPTS = CLAIM_ATTEMPTS;

/** Generate a cryptographically random 6-digit claim code. */
export function claimCode(): string {
  return String(randomInt(0, 1_000_000)).padStart(6, "0");
}

/**
 * Extract a 6-digit claim attempt: either `/start 123456` or bare `123456`.
 * Returns undefined for any other text.
 */
export function claimAttempt(text: string): string | undefined {
  return /^(?:\/start\s+)?(\d{6})$/i.exec(text.trim())?.[1];
}

export interface PairingCheckInput {
  readonly chatKind: ChatKind;
  readonly text: string;
  readonly expectedCode: string | null;
  readonly expiresAt: number | null;
  readonly attempts: number;
  readonly now: number;
}

export type PairingDecision =
  | { readonly kind: "claimed" }
  | { readonly kind: "wrong_code"; readonly attempts: number; readonly exhausted: boolean }
  | { readonly kind: "reject"; readonly reason: "not_dm" | "no_active_code" | "expired" | "exhausted" | "not_claim_format" };

/**
 * Strictly evaluate an inbound message received while a connection is in `pairing` state.
 * Only a DM carrying the exact unexpired 6-digit claim code (with fewer than 5 failed attempts)
 * succeeds. Every other message is rejected without waking T3 or polluting background storage.
 */
export function evaluatePairingClaim(input: PairingCheckInput): PairingDecision {
  if (input.chatKind !== "dm") {
    return { kind: "reject", reason: "not_dm" };
  }
  if (!input.expectedCode || input.expiresAt === null) {
    return { kind: "reject", reason: "no_active_code" };
  }
  if (input.now > input.expiresAt) {
    return { kind: "reject", reason: "expired" };
  }
  if (input.attempts >= CLAIM_MAX_ATTEMPTS) {
    return { kind: "reject", reason: "exhausted" };
  }
  const candidate = claimAttempt(input.text);
  if (!candidate) {
    return { kind: "reject", reason: "not_claim_format" };
  }
  const a = Buffer.from(candidate, "utf8");
  const b = Buffer.from(input.expectedCode, "utf8");
  if (a.length === b.length && timingSafeEqual(a, b)) {
    return { kind: "claimed" };
  }
  const nextAttempts = input.attempts + 1;
  return {
    kind: "wrong_code",
    attempts: nextAttempts,
    exhausted: nextAttempts >= CLAIM_MAX_ATTEMPTS,
  };
}
