/**
 * Explicit inbound message state machine.
 *
 * Adapted from earayu/Mingle (MIT, commit 006220e880d2134665ce2745ab6233f52c8eabe9),
 * src/core/inbound.ts, extended with ADR-011 `blocked` terminal state.
 *
 * Transitions:
 *   deliver: received ──▶ delivered
 *   requeue: delivered ──▶ received
 *   give_up: delivered ──▶ unanswered
 *   fail:    received, delivered ──▶ failed
 *   hold:    received, delivered ──▶ waiting
 *   resume:  waiting ──▶ received
 *   reply:   received, delivered, waiting, unanswered, failed ──▶ replied
 *   send:    delivered, unanswered ──▶ replied
 *   retry:   waiting, failed, unanswered ──▶ received
 *   ignore:  waiting, failed, unanswered ──▶ ignored
 *   pause:          received, delivered (unacked), waiting ──▶ paused_pending
 *   admit_paused:   held ──▶ paused_pending
 *   replay_paused:  paused_pending ──▶ received
 *   dismiss_paused: paused_pending ──▶ ignored
 *   admit:          held ──▶ received
 *   refuse:         held ──▶ blocked
 *
 * `replied`, `ignored`, and `blocked` are terminal.
 * `paused_pending` is a dedicated Leader-pause review backlog state (neither terminal nor `held`).
 * Only gate-approved trigger messages in `received` or `delivered` are ever eligible
 * for T3 dispatch / crash-recovery redelivery (`listUnackedTriggers`).
 */

export type InboundState =
  | "held"
  | "paused_pending"
  | "received"
  | "delivered"
  | "waiting"
  | "replied"
  | "unanswered"
  | "failed"
  | "ignored"
  | "blocked";

export type InboundEvent =
  /** Dispatched/acknowledged by T3. */
  | "deliver"
  /** Returned to queue before execution started. */
  | "requeue"
  /** Could not be handed over, or the turn failed. */
  | "fail"
  /** Passing failure (rate limit / busy provider): retry at a scheduled time. */
  | "hold"
  /** Retry time reached: back to queue. */
  | "resume"
  /** Turn ended without answering this message. */
  | "give_up"
  /** Answered by quoting/replying to it (or verified owner `/stop`). */
  | "reply"
  /** Plain send to its chat settling delivered/unanswered messages. */
  | "send"
  /** Owner asks to retry: back to queue. */
  | "retry"
  /** Owner dismisses it. */
  | "ignore"
  /** Owner paused the Leader/connection: defer unacked triggers without touching ACKed runs. */
  | "pause"
  /** Owner approved a held sender/group while its Leader is paused: enters paused review backlog directly. */
  | "admit_paused"
  /** Owner selectively replays a paused backlog item under its original idempotency key. */
  | "replay_paused"
  /** Owner dismisses a paused backlog item. */
  | "dismiss_paused"
  /** Access gate changed to ask while paused: return item to owner approval queue. */
  | "rehold_paused"
  /** Owner approved the held sender or group: enters delivery queue. */
  | "admit"
  /** Owner rejected the held sender or group: permanently blocked. */
  | "refuse";

export const INBOUND: Readonly<
  Record<InboundEvent, { readonly from: readonly InboundState[]; readonly to: InboundState }>
> = {
  deliver: { from: ["received"], to: "delivered" },
  requeue: { from: ["delivered"], to: "received" },
  fail: { from: ["received", "delivered"], to: "failed" },
  hold: { from: ["received", "delivered"], to: "waiting" },
  resume: { from: ["waiting"], to: "received" },
  give_up: { from: ["delivered"], to: "unanswered" },
  reply: { from: ["received", "delivered", "waiting", "unanswered", "failed"], to: "replied" },
  send: { from: ["delivered", "unanswered"], to: "replied" },
  retry: { from: ["waiting", "failed", "unanswered"], to: "received" },
  ignore: { from: ["waiting", "failed", "unanswered"], to: "ignored" },
  pause: { from: ["received", "delivered", "waiting"], to: "paused_pending" },
  admit_paused: { from: ["held"], to: "paused_pending" },
  replay_paused: { from: ["paused_pending"], to: "received" },
  dismiss_paused: { from: ["paused_pending"], to: "ignored" },
  rehold_paused: { from: ["paused_pending"], to: "held" },
  admit: { from: ["held"], to: "received" },
  refuse: { from: ["held", "paused_pending"], to: "blocked" },
};

export const FINAL_INBOUND: readonly InboundState[] = ["replied", "ignored", "blocked"];

export function isFinalInbound(state: InboundState): boolean {
  return FINAL_INBOUND.includes(state);
}

/** States eligible for unacked trigger replay to T3 (ADR-011 Invariant #7). */
export function isDeliverableInbound(state: InboundState): boolean {
  return state === "received" || state === "delivered";
}

/** The state `event` moves a message in `state` to, or undefined when the transition is disallowed. */
export function nextInbound(state: InboundState, event: InboundEvent): InboundState | undefined {
  const rule = INBOUND[event];
  return rule.from.includes(state) ? rule.to : undefined;
}
