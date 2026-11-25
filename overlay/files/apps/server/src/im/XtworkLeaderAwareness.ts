// @effect-diagnostics nodeBuiltinImport:off globalTimers:off globalDate:off globalDateInEffect:off globalJsonInEffect:off effectTryWithoutCatch:off globalErrorInEffectCatch:off globalErrorInEffectFailure:off effectFnOpportunity:off deterministicKeys:off matchBooleanToIsSuccess:off
import { EnvironmentId } from "@t3tools/contracts";
import { projectThreadAwarenessV2, type AgentAwarenessPhase } from "@t3tools/shared/agentAwareness";
import type { AgentAwarenessThread } from "../orchestration-v2/ProjectionStore.ts";
import {
  DEFAULT_LEADER_ID,
  evaluateThreadAccess,
  type ApprovalRequest,
  type ImApprovals,
  type ReplyAudience,
  type TurnExecutionContext,
} from "./XtworkImSecurity.ts";
import type { LeaderRecord, LeaderStore } from "./XtworkLeaderStore.ts";

export interface ScopedThreadSummary {
  readonly threadId: string;
  readonly projectId: string;
  readonly projectTitle: string;
  readonly title: string;
  readonly phase: AgentAwarenessPhase;
  readonly headline: string;
  readonly detail?: string;
  readonly replyAudience: ReplyAudience;
  readonly isProtected: boolean;
  readonly updatedAt: string;
  readonly pendingApprovalCount: number;
}

export interface ScopedAwarenessView {
  readonly snapshotSequence: number;
  readonly needsYouCount: number;
  readonly runningCount: number;
  readonly completedCount: number;
  readonly failedCount: number;
  readonly pendingApprovalCount: number;
  readonly threads: readonly ScopedThreadSummary[];
}

export interface OwnerNeedsYouView {
  readonly awareness: ScopedAwarenessView;
  readonly approvals: readonly ApprovalRequest[];
}

const NEEDS_YOU_PHASES = new Set<AgentAwarenessPhase>(["waiting_for_input", "waiting_for_approval", "failed"]);

/**
 * Build a strictly audience-filtered cross-session status view from T3's atomic
 * `getAgentAwarenessSnapshot()` plus scoped `ImApprovals` counts.
 *
 * Enforces ADR-013 §3:
 * - Pre-filters threads via `evaluateThreadAccess(..., action: "status_read")` BEFORE counting,
 *   paging, or returning titles/blockers.
 * - Never exposes raw `ImApprovals.details` or approval actions in `status_read` output.
 * - Produces zero "read / delivered" side effects (unlike `t3_thread_read`).
 */
export function buildScopedAwareness(input: {
  readonly caller: TurnExecutionContext;
  readonly leader: LeaderRecord;
  readonly snapshotSequence: number;
  readonly snapshotThreads: readonly AgentAwarenessThread[];
  readonly projectTitleById?: ReadonlyMap<string, string>;
  readonly leaderStore: Pick<LeaderStore, "isProtectedThreadSync" | "getProtectedContextSync">;
  readonly approvals: Pick<ImApprovals, "listStatusSummary">;
  readonly environmentId?: EnvironmentId;
  readonly excludeThreadId?: string | null;
}): ScopedAwarenessView {
  const {
    caller,
    leader,
    snapshotSequence,
    snapshotThreads,
    projectTitleById,
    leaderStore,
    approvals,
    excludeThreadId,
  } = input;
  const environmentId = input.environmentId ?? EnvironmentId.make("local");
  const ownerDmGrants = new Set(leader.ownerDmDesktopGrants);

  // Step 1: Pre-filter visible threads BEFORE counting, projecting, or querying approval counts.
  const authorizedThreads: Array<{
    readonly thread: AgentAwarenessThread;
    readonly isProtected: boolean;
    readonly replyAudience: ReplyAudience;
  }> = [];
  const allowedThreadIds = new Set<string>();

  for (const thread of snapshotThreads) {
    if (excludeThreadId && thread.id === excludeThreadId) continue;
    const isProtected = leaderStore.isProtectedThreadSync(thread.id);
    const protectedCtx = isProtected ? leaderStore.getProtectedContextSync(thread.id) : undefined;
    const replyAudience: ReplyAudience = protectedCtx?.replyAudience ?? (isProtected ? "group" : "local_only");

    const decision = evaluateThreadAccess({
      caller,
      callerLeaderId: leader.id,
      awarenessScope: leader.awarenessScope,
      ownerDmDesktopGrants: ownerDmGrants,
      action: "status_read",
      target: {
        threadId: thread.id,
        projectId: thread.projectId,
        isProtected,
        replyAudience,
        leaderId: protectedCtx?.leaderId ?? (isProtected ? DEFAULT_LEADER_ID : null),
        connectionId: protectedCtx?.connectionId ?? null,
        chatId: protectedCtx?.chatId ?? null,
      },
    });
    if (!decision.allowed) continue;

    allowedThreadIds.add(thread.id);
    authorizedThreads.push({ thread, isProtected, replyAudience });
  }

  // Step 2: Aggregate IM approval COUNTS strictly over authorized threads (zero raw `details`).
  const approvalSummary = approvals.listStatusSummary(allowedThreadIds);

  // Step 3: Project phase via T3's `projectThreadAwarenessV2` and elevate threads with pending IM approvals.
  const summaries: ScopedThreadSummary[] = [];
  let needsYouCount = 0;
  let runningCount = 0;
  let completedCount = 0;
  let failedCount = 0;

  for (const { thread, isProtected, replyAudience } of authorizedThreads) {
    const projectTitle = projectTitleById?.get(thread.projectId) ?? "本机对话";
    const projected = projectThreadAwarenessV2({
      environmentId,
      project: { title: projectTitle },
      thread,
    });
    const pendingForThread = approvalSummary.countByThreadId[thread.id] ?? 0;

    if (!projected && pendingForThread === 0) continue;

    const phase: AgentAwarenessPhase =
      pendingForThread > 0 ? "waiting_for_approval" : (projected?.phase ?? "waiting_for_approval");
    const headline =
      pendingForThread > 0
        ? `等待批准 (${pendingForThread})`
        : (projected?.headline ?? "需要你决定");

    if (NEEDS_YOU_PHASES.has(phase)) needsYouCount += 1;
    if (phase === "running" || phase === "starting") runningCount += 1;
    if (phase === "completed") completedCount += 1;
    if (phase === "failed") failedCount += 1;

    summaries.push({
      threadId: thread.id,
      projectId: thread.projectId,
      projectTitle,
      title: thread.title,
      phase,
      headline,
      ...(projected?.detail ? { detail: projected.detail } : {}),
      replyAudience,
      isProtected,
      updatedAt: projected?.updatedAt ?? new Date().toISOString(),
      pendingApprovalCount: pendingForThread,
    });
  }

  // Sort Needs You items first, then running, then newest updatedAt.
  const rank = (phase: AgentAwarenessPhase) =>
    phase === "waiting_for_approval"
      ? 0
      : phase === "waiting_for_input"
        ? 1
        : phase === "failed"
          ? 2
          : phase === "running" || phase === "starting"
            ? 3
            : 4;
  summaries.sort((a, b) => rank(a.phase) - rank(b.phase) || b.updatedAt.localeCompare(a.updatedAt));

  return {
    snapshotSequence,
    needsYouCount,
    runningCount,
    completedCount,
    failedCount,
    pendingApprovalCount: approvalSummary.totalCount,
    threads: summaries,
  };
}

/**
 * Full Needs You payload for verified desktop Owner only: includes scoped awareness plus
 * raw `ImApprovals` entries belonging to this Leader so Owner can inspect args & approve.
 */
export function buildOwnerNeedsYou(input: {
  readonly caller: TurnExecutionContext;
  readonly leader: LeaderRecord;
  readonly snapshotSequence: number;
  readonly snapshotThreads: readonly AgentAwarenessThread[];
  readonly projectTitleById?: ReadonlyMap<string, string>;
  readonly leaderStore: Pick<LeaderStore, "isProtectedThreadSync" | "getProtectedContextSync">;
  readonly approvals: Pick<ImApprovals, "list" | "listStatusSummary">;
  readonly environmentId?: EnvironmentId;
}): OwnerNeedsYouView {
  const awareness = buildScopedAwareness({
    ...input,
    excludeThreadId: input.leader.pinnedThreadId,
  });
  const isVerifiedDesktopOwner =
    input.caller.source === "desktop" &&
    input.caller.replyAudience === "local_only" &&
    input.caller.senderRole === "owner";
  const approvals = isVerifiedDesktopOwner
    ? input.approvals.list().filter((item) => item.leaderId === input.leader.id)
    : [];
  return { awareness, approvals };
}

/**
 * Redact tokens, secrets, and user home paths before exporting diagnostic snapshots (ADR-013 §4).
 */
export function redactDiagnosticText(raw: string): string {
  return raw
    .replace(/Bearer\s+[A-Za-z0-9._~+/=-]{8,}/giu, "Bearer [REDACTED]")
    .replace(/("(?:appSecret|secret|botSecret|token|accessToken|apiKey|authorization|password)"\s*:\s*")[^"]*(")/giu, "$1[REDACTED]$2")
    .replace(/\b(?:sk|cli|t3|xoxb|ghp)_[A-Za-z0-9_-]{8,}\b/gu, "[REDACTED_SECRET]")
    .replace(/\/Users\/[^/\s"']+/gu, "/Users/[REDACTED]")
    .replace(/\/home\/[^/\s"']+/gu, "/home/[REDACTED]")
    .replace(/[A-Za-z]:\\Users\\[^\\\s"']+/gu, "C:\\Users\\[REDACTED]");
}
