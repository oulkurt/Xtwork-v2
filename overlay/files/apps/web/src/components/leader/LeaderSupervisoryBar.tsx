import { useEffect, useState, type FormEvent, type ReactNode } from "react";
import { useNavigate } from "@tanstack/react-router";
import {
  AlertCircleIcon,
  ArchiveIcon,
  CheckCircle2Icon,
  ChevronDownIcon,
  ChevronUpIcon,
  ClipboardCopyIcon,
  Link2Icon,
  Loader2Icon,
  PauseIcon,
  PlayIcon,
  RotateCcwIcon,
  Settings2Icon,
  ShieldAlertIcon,
  ShieldCheckIcon,
  XIcon,
} from "lucide-react";
import type { EnvironmentId } from "@t3tools/contracts";
import { useProjects } from "../../state/entities";
import { Button } from "../ui/button";
import { Input } from "../ui/input";
import {
  DEFAULT_IM_DELEGATION_POLICY,
  LEADER_ROLE_TEMPLATES,
  emitNavigatorsChanged,
  leaderRequest,
  navigatorChannelLabel,
  normalizeImPolicy,
  useNavigatorLang,
  type ImDelegationMode,
  type ImDelegationPolicy,
  type ImProgressReportMode,
  type LeaderListItem,
  type LeaderOverview,
} from "./leaderTypes";

export interface LeaderSupervisoryBarProps {
  readonly threadId: string;
  readonly environmentId: EnvironmentId;
  readonly rightPanelOpen?: boolean;
  readonly renderHeader?: (headerContent: ReactNode) => ReactNode;
  readonly fallbackHeader?: ReactNode;
  readonly onOpenThread?: (threadId: string) => void;
  readonly availableProjects?: readonly { readonly id: string; readonly title: string }[];
}

const pendingNavigatorNoticeByLeaderId = new Map<string, string>();

export function LeaderSupervisoryBar({
  threadId,
  environmentId,
  rightPanelOpen = false,
  renderHeader,
  fallbackHeader,
  onOpenThread,
  availableProjects,
}: LeaderSupervisoryBarProps) {
  const desktop = typeof window !== "undefined" && Boolean(window.desktopBridge);
  const lang = useNavigatorLang();
  const isEn = lang === "en";
  const navigate = useNavigate();
  const storeProjects = useProjects();
  const selectableProjects =
    availableProjects ??
    storeProjects
      .filter((project) => project.environmentId === environmentId && project.archivedAt === null && !project.isScratch)
      .map((project) => ({ id: project.id, title: project.title }));

  const [allLeaders, setAllLeaders] = useState<readonly LeaderListItem[]>([]);
  const [matchedLeaderId, setMatchedLeaderId] = useState<string | null>(null);
  const [overview, setOverview] = useState<LeaderOverview | null>(null);
  const [loadedThreadId, setLoadedThreadId] = useState<string | null>(null);
  const [expanded, setExpanded] = useState(false);
  const [configOpen, setConfigOpen] = useState(false);
  const [busy, setBusy] = useState(false);
  const [notice, setNotice] = useState("");
  const [error, setError] = useState("");

  const [draftName, setDraftName] = useState("");
  const [draftAvatar, setDraftAvatar] = useState("");
  const [draftRole, setDraftRole] = useState("");
  const [draftAwarenessKind, setDraftAwarenessKind] = useState<"all_local" | "projects" | "none">("all_local");
  const [draftProjectIds, setDraftProjectIds] = useState<readonly string[]>([]);
  const [draftImPolicy, setDraftImPolicy] = useState<ImDelegationPolicy>(DEFAULT_IM_DELEGATION_POLICY);

  const audienceLabel = (audience: "local_only" | "owner_dm" | "group") => {
    if (isEn) {
      return audience === "local_only" ? "Local" : audience === "owner_dm" ? "DM" : "Group";
    }
    return audience === "local_only" ? "本机" : audience === "owner_dm" ? "私聊" : "群聊";
  };

  const phaseLabel = (phase: string, fallback: string) => {
    if (isEn) {
      const map: Record<string, string> = {
        waiting_for_approval: "Needs approval",
        waiting_for_input: "Needs input",
        failed: "Failed",
        running: "Running",
        starting: "Starting",
        completed: "Done",
      };
      return map[phase] ?? fallback;
    }
    const map: Record<string, string> = {
      waiting_for_approval: "等待批准",
      waiting_for_input: "等你决定",
      failed: "失败",
      running: "进行中",
      starting: "启动中",
      completed: "已完成",
    };
    return map[phase] ?? fallback;
  };

  useEffect(() => {
    setMatchedLeaderId(null);
    setOverview(null);
    setLoadedThreadId(null);
    setExpanded(false);
    setConfigOpen(false);
    setError("");
    setNotice("");
    if (!desktop) return;
    const controller = new AbortController();
    let timer: ReturnType<typeof setTimeout>;
    const sync = async () => {
      try {
        const listRes = await leaderRequest<{ leaders?: LeaderListItem[] }>("leaders", undefined, controller.signal);
        if (controller.signal.aborted) return;
        const list = Array.isArray(listRes.leaders) ? listRes.leaders : [];
        setAllLeaders(list);
        const match = list.find((item) => item.leader.pinnedThreadId === threadId);
        if (!match) {
          setMatchedLeaderId(null);
          setOverview(null);
          setLoadedThreadId(null);
          return;
        }
        setMatchedLeaderId(match.leader.id);
        const detail = await leaderRequest<LeaderOverview>(
          `leaders/${match.leader.id}/overview`,
          undefined,
          controller.signal,
        );
        if (!controller.signal.aborted) {
          setOverview(detail);
          setLoadedThreadId(threadId);
          const pendingNotice = pendingNavigatorNoticeByLeaderId.get(detail.leader.id);
          if (pendingNotice) {
            pendingNavigatorNoticeByLeaderId.delete(detail.leader.id);
            setNotice(pendingNotice);
          }
        }
      } catch {
      } finally {
        if (!controller.signal.aborted) {
          timer = setTimeout(() => void sync(), 2500);
        }
      }
    };
    void sync();
    return () => {
      controller.abort();
      clearTimeout(timer);
    };
  }, [desktop, threadId]);

  useEffect(() => {
    if (!overview || configOpen) return;
    setDraftName(overview.leader.name);
    setDraftAvatar(overview.leader.avatar);
    setDraftRole(overview.leader.role);
    setDraftAwarenessKind(overview.leader.awarenessScope.kind);
    setDraftProjectIds(overview.leader.awarenessScope.projectIds);
    setDraftImPolicy(normalizeImPolicy(overview.leader.imPolicy));
  }, [overview, configOpen]);

  const nonApprovalNeedsYou =
    overview?.needsYou.threads.filter(
      (t) =>
        t.pendingApprovalCount === 0 &&
        (t.phase === "waiting_for_approval" || t.phase === "waiting_for_input" || t.phase === "failed"),
    ).length ?? 0;
  const totalAttention =
    (overview?.approvals.length ?? 0) +
    (overview?.pausedPending.length ?? 0) +
    nonApprovalNeedsYou;

  if (
    !desktop ||
    !matchedLeaderId ||
    !overview ||
    loadedThreadId !== threadId ||
    overview.leader.pinnedThreadId !== threadId
  ) {
    return renderHeader ? <>{renderHeader(fallbackHeader ?? null)}</> : null;
  }

  const leader = overview.leader;
  const isPaused = leader.status === "paused";
  const isDefaultNavigator = leader.id === "leader-default";

  async function refreshOverview() {
    if (!matchedLeaderId) return;
    const [listRes, detail] = await Promise.all([
      leaderRequest<{ leaders?: LeaderListItem[] }>("leaders"),
      leaderRequest<LeaderOverview>(`leaders/${matchedLeaderId}/overview`),
    ]);
    if (Array.isArray(listRes.leaders)) setAllLeaders(listRes.leaders);
    setOverview(detail);
    emitNavigatorsChanged();
  }

  async function runAction(work: () => Promise<string | void>, successMessage?: string) {
    setBusy(true);
    setError("");
    setNotice("");
    try {
      const customNotice = await work();
      await refreshOverview();
      const message = typeof customNotice === "string" ? customNotice : successMessage;
      if (message) setNotice(message);
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : isEn ? "Action failed. Please try again." : "操作失败，请重试。");
    } finally {
      setBusy(false);
    }
  }

  async function handleSaveConfig(event: FormEvent) {
    event.preventDefault();
    await runAction(async () => {
      const normalizedProjects = draftAwarenessKind === "projects" ? [...new Set(draftProjectIds)] : [];
      const scopeChanged =
        draftAwarenessKind !== leader.awarenessScope.kind ||
        normalizedProjects.length !== leader.awarenessScope.projectIds.length ||
        normalizedProjects.some((id, idx) => leader.awarenessScope.projectIds[idx] !== id);
      const currentPolicy = normalizeImPolicy(leader.imPolicy);
      const nextPolicy = normalizeImPolicy(draftImPolicy);
      const policyChanged = JSON.stringify(currentPolicy) !== JSON.stringify(nextPolicy);
      await leaderRequest(`leaders/${leader.id}/update`, {
        name: draftName,
        avatar: draftAvatar,
        role: draftRole,
        ...(scopeChanged
          ? { awarenessScope: { kind: draftAwarenessKind, projectIds: normalizedProjects } }
          : {}),
        ...(policyChanged ? { imPolicy: nextPolicy } : {}),
      });
      setConfigOpen(false);
    }, isEn ? "Navigator settings saved." : "领航者设置已保存。");
  }

  async function handleRebindConnection(connectionId: string, nextLeaderId: string) {
    if (!nextLeaderId || nextLeaderId === leader.id) return;
    await runAction(async () => {
      const res = await leaderRequest<{ syncPending?: boolean }>("connections/rebind", {
        connectionId,
        leaderId: nextLeaderId,
      });
      const target = allLeaders.find((item) => item.leader.id === nextLeaderId)?.leader.name ?? nextLeaderId;
      if (res.syncPending) {
        return isEn
          ? `Rebind to ${target} saved; waiting for IM bridge sync retry.`
          : `已保存换绑至「${target}」，远程桥接同步待重试确认。`;
      }
      return isEn
        ? `Connection rebound to ${target}. New messages route there while history stays preserved.`
        : `连接已换绑至「${target}」，新消息将由该领航者承接，历史归属保持不变。`;
    });
  }

  async function handleArchiveNavigator() {
    if (isDefaultNavigator) return;
    setBusy(true);
    setError("");
    setNotice("");
    try {
      const payload = overview.connections.length > 0 ? { rebindToLeaderId: "leader-default" } : {};
      const archiveRes = await leaderRequest<{ syncPending?: boolean }>(`leaders/${leader.id}/archive`, payload);
      if (archiveRes.syncPending) {
        pendingNavigatorNoticeByLeaderId.set(
          "leader-default",
          isEn
            ? "Navigator archived and rebind saved to default Navigator; waiting for IM bridge sync retry."
            : "已归档领航者并保存换绑至默认领航者，远程桥接同步待重试确认。",
        );
      }
      emitNavigatorsChanged();
      setConfigOpen(false);
      const fallback = await leaderRequest<{ threadId: string }>("leaders/leader-default/open-thread", {});
      if (fallback.threadId) {
        jumpToThread(fallback.threadId);
      }
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : isEn ? "Failed to archive Navigator." : "归档领航者失败。");
    } finally {
      setBusy(false);
    }
  }

  async function handleCopyDiagnostics() {
    await runAction(async () => {
      const res = await leaderRequest<{ text: string }>(`leaders/${leader.id}/diagnostics`);
      if (typeof navigator !== "undefined" && navigator.clipboard?.writeText) {
        await navigator.clipboard.writeText(res.text);
      }
    }, isEn ? "Redacted diagnostics copied." : "已复制脱敏诊断信息。");
  }

  async function handleResetSession() {
    await runAction(async () => {
      const res = await leaderRequest<{ threadId: string }>(`leaders/${leader.id}/reset-session`, {});
      if (res.threadId) {
        jumpToThread(res.threadId);
      }
    }, isEn
      ? "Started a fresh model context. History, memory, todos, and IM bindings remain intact."
      : "已开启全新模型上下文，历史消息、记忆、待办与聊天软件连接均已保留。");
  }

  function jumpToThread(targetThreadId: string) {
    if (onOpenThread) {
      onOpenThread(targetThreadId);
    } else {
      void navigate({
        to: "/$environmentId/$threadId",
        params: { environmentId, threadId: targetThreadId },
      });
    }
  }

  const allSelectableProjects = [
    ...selectableProjects,
    ...draftProjectIds
      .filter((id) => !selectableProjects.some((p) => p.id === id))
      .map((id) => ({ id, title: id })),
  ];

  const allOwnerDmPolicyProjects = [
    ...selectableProjects,
    ...draftImPolicy.ownerDm.allowedProjectIds
      .filter((id) => !selectableProjects.some((p) => p.id === id))
      .map((id) => ({ id, title: id })),
  ];

  const headerRow = (
    <div
      data-testid="leader-supervisory-bar"
      aria-label={isEn ? "Navigator supervisory header" : "领航者控制栏"}
      className={`flex h-full min-w-0 flex-1 items-center justify-between gap-2 [-webkit-app-region:no-drag] ${
        rightPanelOpen ? "pr-10" : "pr-24"
      }`}
    >
      <div data-testid="leader-header-identity" className="flex min-w-0 items-center gap-2">
        <span className="flex size-7 shrink-0 items-center justify-center rounded-lg border border-foreground/12 bg-background/60 text-xs font-semibold leading-none text-foreground shadow-2xs">
          {leader.avatar || Array.from(leader.name)[0] || "瞳"}
        </span>
        <div className="flex min-w-0 items-center gap-2">
          <span className="truncate text-sm font-semibold leading-none text-foreground">{leader.name}</span>
          <span
            className={`inline-flex h-5 items-center gap-1 rounded-full px-2 text-[11px] font-medium leading-none ${
              isPaused
                ? "bg-amber-500/15 text-amber-700 dark:text-amber-300"
                : "bg-emerald-500/15 text-emerald-700 dark:text-emerald-300"
            }`}
          >
            <span
              className={`size-1.5 rounded-full ${isPaused ? "bg-amber-500" : "bg-emerald-500"}`}
              aria-hidden="true"
            />
            {isPaused ? (isEn ? "Paused" : "已暂停") : isEn ? "Active" : "活跃"}
          </span>
          {overview.connections.map((conn, idx) => (
            <span
              key={conn.id ?? `${conn.platform}-${idx}`}
              className="hidden h-5 items-center rounded-full border border-foreground/10 bg-background/50 px-2 text-[11px] leading-none text-muted-foreground sm:inline-flex"
            >
              {navigatorChannelLabel(conn.platform, lang)}
            </span>
          ))}
          {overview.needsYou.runningCount > 0 ? (
            <span className="hidden text-xs leading-none text-muted-foreground md:inline">
              {isEn ? `${overview.needsYou.runningCount} running` : `${overview.needsYou.runningCount} 项进行中`}
            </span>
          ) : null}
        </div>
      </div>

      <div className="flex shrink-0 items-center gap-1.5">
        <Button
          size="sm"
          variant={totalAttention > 0 ? "default" : "outline"}
          className="h-7 min-h-7 px-2.5 text-xs"
          onClick={() => {
            setConfigOpen(false);
            setExpanded((value) => !value);
          }}
        >
          {totalAttention > 0 ? (
            <ShieldAlertIcon className="mr-1 size-3.5" aria-hidden="true" />
          ) : (
            <CheckCircle2Icon className="mr-1 size-3.5" aria-hidden="true" />
          )}
          Needs You ({totalAttention})
          {expanded ? (
            <ChevronUpIcon className="ml-1 size-3.5" aria-hidden="true" />
          ) : (
            <ChevronDownIcon className="ml-1 size-3.5" aria-hidden="true" />
          )}
        </Button>
        <Button
          size="sm"
          variant="outline"
          className="h-7 min-h-7 px-2.5 text-xs"
          disabled={busy}
          onClick={() =>
            void runAction(
              async () => {
                await leaderRequest(`leaders/${leader.id}/${isPaused ? "resume" : "pause"}`, {});
              },
              isPaused
                ? isEn
                  ? "Navigator resumed. Review queued messages below to replay or dismiss."
                  : "领航者已恢复接单，可在下方选择重投暂停期间的消息。"
                : isEn
                  ? "Navigator paused. In-flight tasks will finish and /stop remains available."
                  : "领航者已暂停接单，在途任务将继续完成且 /stop 保持可用。",
            )
          }
        >
          {isPaused ? (
            <>
              <PlayIcon className="mr-1 size-3.5" aria-hidden="true" />
              {isEn ? "Resume" : "恢复"}
            </>
          ) : (
            <>
              <PauseIcon className="mr-1 size-3.5" aria-hidden="true" />
              {isEn ? "Pause" : "暂停"}
            </>
          )}
        </Button>
        <Button
          size="sm"
          variant="outline"
          className="h-7 min-h-7 px-2.5 text-xs"
          onClick={() => {
            setExpanded(false);
            setConfigOpen((value) => !value);
          }}
        >
          <Settings2Icon className="mr-1 size-3.5" aria-hidden="true" />
          {isEn ? "Manage" : "管理"}
        </Button>
      </div>
    </div>
  );

  const drawersContent =
    notice || error || expanded || configOpen ? (
      <div className={renderHeader ? "shrink-0 px-3 pb-2 sm:px-5" : "mt-2"}>
        {notice ? (
          <p className="mb-1.5 text-xs text-emerald-700 dark:text-emerald-400" role="status">
            {notice}
          </p>
        ) : null}
        {error ? (
          <p className="mb-1.5 text-xs text-destructive" role="alert">
            {error}
          </p>
        ) : null}

      {expanded ? (
        <div
          data-testid="leader-needs-you-panel"
          className="max-h-[70vh] overflow-y-auto space-y-3 rounded-2xl border border-border/80 bg-popover/95 p-4 shadow-lg backdrop-blur-md"
        >
          {overview.approvals.length > 0 ? (
            <div className="space-y-2">
              <h3 className="text-xs font-semibold text-foreground">
                {isEn ? "Pending approvals" : "待你批准的操作"}
              </h3>
              {overview.approvals.map((item) => {
                const isSnapshotShare = Boolean(item.snapshotHash);
                const fullSnapshot = item.contentSnapshot ?? item.contentPreview;
                const destinationLabel =
                  item.targetChatName || item.targetChatId || item.targetScope || audienceLabel(item.replyAudience);
                const canApprove =
                  !busy &&
                  Boolean(item.turnId) &&
                  (!isSnapshotShare || (typeof fullSnapshot === "string" && fullSnapshot.length > 0));
                return (
                  <div
                    key={item.id}
                    className="flex flex-col gap-2 rounded-xl border border-amber-500/30 bg-amber-500/5 p-3"
                  >
                    <div className="flex flex-wrap items-center justify-between gap-2">
                      <div className="flex flex-wrap items-center gap-2 text-xs">
                        <AlertCircleIcon className="size-3.5 text-amber-600" aria-hidden="true" />
                        <span className="font-mono font-semibold text-foreground">{item.toolName}</span>
                        <span className="rounded bg-muted px-1.5 py-0.5 text-[11px] text-muted-foreground">
                          {audienceLabel(item.replyAudience)}
                        </span>
                        {item.targetChatName || item.targetChatId || item.targetScope ? (
                          <span
                            data-testid={`approval-destination-${item.id}`}
                            className="rounded bg-amber-500/15 px-1.5 py-0.5 text-[11px] font-medium text-amber-800 dark:text-amber-200"
                          >
                            {isEn ? `Target: ${destinationLabel}` : `目标：${destinationLabel}`}
                          </span>
                        ) : null}
                        {item.snapshotHash ? (
                          <span className="rounded bg-muted px-1.5 py-0.5 font-mono text-[10px] text-muted-foreground">
                            {isEn ? `Snapshot ${item.snapshotHash.slice(0, 8)}` : `快照 ${item.snapshotHash.slice(0, 8)}`}
                          </span>
                        ) : null}
                      </div>
                      <div className="flex items-center gap-1.5">
                        <Button
                          size="sm"
                          disabled={!canApprove}
                          onClick={() =>
                            void runAction(async () => {
                              await leaderRequest("approvals/decide", {
                                id: item.id,
                                approved: true,
                                expectedRunId: item.turnId,
                                expectedAudience: item.replyAudience,
                                ...(item.snapshotHash ? { expectedSnapshotHash: item.snapshotHash } : {}),
                              });
                            }, isEn ? "Approved once." : "已单次批准该操作。")
                          }
                        >
                          {isEn ? "Allow once" : "允许一次"}
                        </Button>
                        <Button
                          size="sm"
                          variant="outline"
                          disabled={busy || !item.turnId}
                          onClick={() =>
                            void runAction(async () => {
                              await leaderRequest("approvals/decide", {
                                id: item.id,
                                approved: false,
                                expectedRunId: item.turnId,
                                expectedAudience: item.replyAudience,
                              });
                            }, isEn ? "Declined." : "已拒绝该操作。")
                          }
                        >
                          {isEn ? "Decline" : "拒绝"}
                        </Button>
                      </div>
                    </div>
                    {isSnapshotShare ? (
                      <div className="space-y-1">
                        <div className="text-[11px] text-amber-800 dark:text-amber-200">
                          {isEn
                            ? `This complete immutable snapshot (${fullSnapshot?.length ?? 0} chars) will be copied once to the target group without granting live private memory access:`
                            : `以下完整不可变快照（共 ${fullSnapshot?.length ?? 0} 字符）将在批准后一次性复制到目标群聊，不会开放私有记忆实时读取：`}
                        </div>
                        <pre
                          data-testid={`approval-snapshot-${item.id}`}
                          className="max-h-60 overflow-auto whitespace-pre-wrap break-all rounded-lg bg-muted/60 p-2 font-mono text-[11px] text-foreground"
                        >
                          {fullSnapshot ?? ""}
                        </pre>
                      </div>
                    ) : (
                      <pre className="max-h-40 overflow-auto whitespace-pre-wrap break-all rounded-lg bg-muted/60 p-2 font-mono text-[11px] text-foreground">
                        {item.details}
                      </pre>
                    )}
                  </div>
                );
              })}
            </div>
          ) : null}

          {overview.pausedPending.length > 0 ? (
            <div className="space-y-2">
              <h3 className="text-xs font-semibold text-foreground">
                {isEn ? "Queued while paused" : "暂停期间积压消息（待审重投）"}
              </h3>
              {overview.pausedPending.map((item) => (
                <div
                  key={item.id}
                  className="flex flex-wrap items-center justify-between gap-2 rounded-xl border border-border bg-card/70 px-3 py-2 text-xs"
                >
                  <div className="min-w-0 flex-1">
                    <div className="font-medium text-foreground">
                      {navigatorChannelLabel(item.platform, lang)} ·{" "}
                      {item.chatName || item.senderName || (isEn ? "Remote message" : "远程消息")}
                    </div>
                    <p className="truncate text-muted-foreground">{item.body}</p>
                  </div>
                  <div className="flex gap-1.5">
                    <Button
                      size="sm"
                      variant="outline"
                      disabled={busy || isPaused}
                      onClick={() =>
                        void runAction(async () => {
                          const res = await leaderRequest<{
                            count?: number;
                            blockedIds?: string[];
                            heldIds?: string[];
                            skippedIds?: string[];
                          }>(`leaders/${leader.id}/paused-decide`, {
                            messageIds: [item.id],
                            decision: "replay",
                          });
                          if ((res.count ?? 0) > 0) return isEn ? "Replayed with original idempotency key." : "已按原幂等键重新投递。";
                          if (res.blockedIds && res.blockedIds.length > 0) {
                            return isEn ? "Chat or contact is blocked; replay refused." : "该消息所属聊天或联系人已被屏蔽，已拒绝重投。";
                          }
                          if (res.heldIds && res.heldIds.length > 0) {
                            return isEn ? "Access policy changed to require approval; returned to held list." : "该消息权限已变更为需审批，已退回待批准列表。";
                          }
                          if (res.skippedIds && res.skippedIds.length > 0) {
                            return isEn
                              ? "Connection or Navigator is paused/inactive; message stays queued."
                              : "当前连接或领航者处于暂停/未激活状态，消息仍保留在暂停积压队列中。";
                          }
                          return isEn ? "No replayable message found." : "未找到可重投的积压消息。";
                        })
                      }
                    >
                      {isEn ? "Replay" : "重投"}
                    </Button>
                    <Button
                      size="sm"
                      variant="outline"
                      disabled={busy}
                      onClick={() =>
                        void runAction(async () => {
                          await leaderRequest(`leaders/${leader.id}/paused-decide`, {
                            messageIds: [item.id],
                            decision: "dismiss",
                          });
                        }, isEn ? "Queued message dismissed." : "已忽略该积压消息。")
                      }
                    >
                      {isEn ? "Dismiss" : "忽略"}
                    </Button>
                  </div>
                </div>
              ))}
            </div>
          ) : null}

          <div className="space-y-1.5">
            <h3 className="text-xs font-semibold text-foreground">
              {isEn
                ? `Scoped task activity (${overview.needsYou.threads.length})`
                : `受权范围任务动态（${overview.needsYou.threads.length}）`}
            </h3>
            {overview.needsYou.threads.length === 0 ? (
              <p className="text-xs text-muted-foreground">
                {isEn ? "No active or blocked tasks need your attention right now." : "当前没有需要关注的进行中或待处理任务。"}
              </p>
            ) : (
              <div className="grid gap-1.5">
                {overview.needsYou.threads.slice(0, 8).map((item) => (
                  <button
                    key={item.threadId}
                    type="button"
                    onClick={() => jumpToThread(item.threadId)}
                    className="flex items-center justify-between gap-2 rounded-xl border border-border/70 bg-card/50 px-3 py-2 text-left text-xs transition-colors hover:bg-accent/50"
                  >
                    <span className="min-w-0 flex-1 truncate font-medium text-foreground">
                      {item.title}
                    </span>
                    <span className="flex shrink-0 items-center gap-1.5 text-[11px] text-muted-foreground">
                      <span>{audienceLabel(item.replyAudience)}</span>
                      <span className="rounded bg-muted px-1.5 py-0.5 text-foreground">
                        {phaseLabel(item.phase, item.headline)}
                      </span>
                    </span>
                  </button>
                ))}
              </div>
            )}
          </div>
        </div>
      ) : null}

      {configOpen ? (
        <div
          data-testid="leader-config-panel"
          className="max-h-[75vh] overflow-y-auto space-y-4 rounded-2xl border border-border/80 bg-popover/95 p-4 shadow-lg backdrop-blur-md"
        >
          <div className="flex items-center justify-between">
            <h3 className="text-sm font-semibold text-foreground">
              {isEn ? `Navigator settings · ${leader.name}` : `领航者设置 · ${leader.name}`}
            </h3>
            <button
              type="button"
              aria-label={isEn ? "Close Navigator settings" : "关闭领航者设置"}
              onClick={() => setConfigOpen(false)}
              className="rounded-md p-1 text-muted-foreground hover:bg-accent hover:text-foreground"
            >
              <XIcon className="size-4" aria-hidden="true" />
            </button>
          </div>

          <form className="space-y-4" onSubmit={(event) => void handleSaveConfig(event)}>
            <div className="grid grid-cols-1 gap-3 sm:grid-cols-4">
              <label className="grid gap-1 text-xs font-medium text-foreground sm:col-span-3">
                {isEn ? "Name" : "名字"}
                <Input
                  value={draftName}
                  onChange={(e) => setDraftName(e.target.value)}
                  placeholder={isEn ? "Name this Navigator" : "给领航者起个名字"}
                  required
                />
              </label>
              <label className="grid gap-1 text-xs font-medium text-foreground">
                {isEn ? "Badge" : "头像徽章"}
                <Input
                  value={draftAvatar}
                  onChange={(e) => setDraftAvatar(e.target.value)}
                  maxLength={4}
                  placeholder="瞳"
                />
              </label>
            </div>

            <div className="space-y-1.5">
              <div className="flex flex-wrap items-center justify-between gap-1">
                <label className="text-xs font-medium text-foreground" htmlFor={`leader-role-${leader.id}`}>
                  {isEn ? "Public role profile (ROLE.md)" : "公开角色介绍（ROLE.md）"}
                </label>
                <span className="text-[11px] text-amber-700 dark:text-amber-300">
                  {isEn
                    ? "Shared across all connected chats; keep private notes in private memory"
                    : "所有已连接聊天都会使用这份角色介绍；私人背景请写入私有记忆"}
                </span>
              </div>
              <textarea
                id={`leader-role-${leader.id}`}
                rows={3}
                value={draftRole}
                onChange={(e) => setDraftRole(e.target.value)}
                placeholder={isEn ? "Describe who this Navigator is and what it owns..." : "告诉它它是谁、负责什么..."}
                className="w-full rounded-xl border border-input bg-background px-3 py-2 text-xs text-foreground outline-none focus-visible:ring-2 focus-visible:ring-ring"
              />
              <div className="flex flex-wrap gap-1.5">
                {LEADER_ROLE_TEMPLATES.map((tpl) => (
                  <button
                    key={tpl.id}
                    type="button"
                    onClick={() => setDraftRole(isEn ? tpl.promptEn : tpl.prompt)}
                    className="rounded-full border border-border bg-muted/50 px-2.5 py-1 text-[11px] text-foreground transition-colors hover:bg-accent"
                  >
                    {isEn ? tpl.labelEn : tpl.label}
                  </button>
                ))}
              </div>
            </div>

            <div className="space-y-2 rounded-xl border border-border/70 bg-muted/25 px-3.5 py-3 text-xs">
              <div className="flex flex-wrap items-center justify-between gap-2">
                <div>
                  <div className="font-medium text-foreground">
                    {isEn ? "Desktop cross-thread status awareness" : "桌面跨对话状态感知"}
                  </div>
                  <p className="text-[11px] text-muted-foreground">
                    {isEn
                      ? "Controls which local desktop threads appear in Needs You; remote IM chats remain isolated by default"
                      : "仅授权桌面控制面主动聚合本机任务进展与 Needs You；群聊与私聊默认保持隔离"}
                  </p>
                </div>
                <select
                  aria-label={isEn ? "Desktop cross-thread status awareness" : "桌面跨对话状态感知"}
                  value={draftAwarenessKind}
                  onChange={(e) => {
                    const value = e.target.value;
                    setDraftAwarenessKind(
                      value === "none" ? "none" : value === "projects" ? "projects" : "all_local",
                    );
                  }}
                  className="rounded-lg border border-input bg-background px-2.5 py-1.5 text-xs text-foreground"
                >
                  <option value="all_local">{isEn ? "All local tasks" : "全部本机任务"}</option>
                  <option value="projects">{isEn ? "Selected folders" : "指定文件夹"}</option>
                  <option value="none">{isEn ? "Remote tasks only" : "仅此领航者远程任务"}</option>
                </select>
              </div>
              {draftAwarenessKind === "projects" ? (
                <div data-testid="leader-project-scope-picker" className="space-y-1.5 border-t border-border/60 pt-2">
                  <div className="text-[11px] text-muted-foreground">
                    {isEn ? "Select folders visible to this Navigator:" : "选择允许此领航者感知状态的文件夹："}
                  </div>
                  {allSelectableProjects.length === 0 ? (
                    <p className="text-[11px] text-muted-foreground">
                      {isEn ? "No local folders available." : "暂无可选本机文件夹。"}
                    </p>
                  ) : (
                    <div className="flex flex-wrap gap-2">
                      {allSelectableProjects.map((project) => {
                        const checked = draftProjectIds.includes(project.id);
                        return (
                          <label
                            key={project.id}
                            className="inline-flex cursor-pointer items-center gap-1.5 rounded-md border border-border bg-background px-2 py-1 text-[11px] text-foreground"
                          >
                            <input
                              type="checkbox"
                              checked={checked}
                              onChange={() =>
                                setDraftProjectIds((prev) =>
                                  prev.includes(project.id)
                                    ? prev.filter((id) => id !== project.id)
                                    : [...prev, project.id],
                                )
                              }
                            />
                            <span>{project.title}</span>
                          </label>
                        );
                      })}
                    </div>
                  )}
                </div>
              ) : null}
            </div>

            <div
              data-testid="leader-bindings-section"
              className="space-y-2 rounded-xl border border-border/70 bg-muted/25 px-3.5 py-3 text-xs"
            >
              <div className="flex flex-wrap items-center justify-between gap-2">
                <div>
                  <div className="font-medium text-foreground">
                    {isEn ? "Bound IM channels" : "已绑定的远程渠道"}
                  </div>
                  <p className="text-[11px] text-muted-foreground">
                    {isEn
                      ? "Rebinding starts a fresh binding epoch for new messages while preserving historical ownership"
                      : "换绑后仅新消息路由至目标领航者，历史任务与暂停积压保留原领航者归属"}
                  </p>
                </div>
                <Button
                  type="button"
                  size="sm"
                  variant="outline"
                  onClick={() => void navigate({ to: "/settings/remote-connections" })}
                >
                  <Link2Icon className="mr-1 size-3.5" aria-hidden="true" />
                  {isEn ? "Add / Manage channels" : "管理 / 添加聊天软件"}
                </Button>
              </div>
              {overview.connections.length === 0 ? (
                <p className="text-[11px] text-muted-foreground">
                  {isEn ? "No IM channels bound to this Navigator yet." : "当前领航者暂未绑定任何聊天软件连接。"}
                </p>
              ) : (
                <div className="space-y-1.5 pt-1">
                  {overview.connections.map((conn, idx) => {
                    const connId = conn.id ?? `${conn.platform}-${idx}`;
                    const bridgeOwnerMismatch = Boolean(conn.syncPending && conn.leaderId && conn.leaderId !== leader.id);
                    return (
                      <div
                        key={connId}
                        className="flex flex-wrap items-center justify-between gap-2 rounded-lg border border-border/70 bg-background/80 px-2.5 py-1.5"
                      >
                        <div className="flex flex-wrap items-center gap-2">
                          <span className="font-medium text-foreground">
                            {navigatorChannelLabel(conn.platform, lang)}
                          </span>
                          {conn.botName ? (
                            <span className="text-[11px] text-muted-foreground">{conn.botName}</span>
                          ) : null}
                          {conn.syncPending ? (
                            <span
                              data-testid={`leader-conn-sync-pending-${connId}`}
                              className="rounded-full bg-amber-500/15 px-1.5 py-0.5 text-[10px] font-medium text-amber-700 dark:text-amber-300"
                            >
                              {isEn ? "Sync pending" : "同步中…"}
                            </span>
                          ) : null}
                          {bridgeOwnerMismatch ? (
                            <span className="text-[10px] text-amber-700/90 dark:text-amber-300/90">
                              {isEn
                                ? "Bridge still routing to previous Navigator until synced"
                                : "桥接同步完成前仍向原领航者投递"}
                            </span>
                          ) : null}
                        </div>
                        {conn.id && allLeaders.length > 1 ? (
                          <label className="flex items-center gap-1.5 text-[11px] text-muted-foreground">
                            <span>{isEn ? "Assign to" : "换绑至"}</span>
                            <select
                              data-testid={`leader-rebind-select-${conn.id}`}
                              aria-label={isEn ? `Rebind ${conn.platform} connection` : `换绑 ${navigatorChannelLabel(conn.platform, lang)} 连接`}
                              value={conn.desiredLeaderId ?? leader.id}
                              disabled={busy}
                              onChange={(event) => void handleRebindConnection(conn.id!, event.target.value)}
                              className="rounded-md border border-input bg-background px-2 py-1 text-[11px] text-foreground"
                            >
                              {allLeaders.map((candidate) => (
                                <option key={candidate.leader.id} value={candidate.leader.id}>
                                  {candidate.leader.name}
                                </option>
                              ))}
                            </select>
                          </label>
                        ) : null}
                      </div>
                    );
                  })}
                </div>
              )}
            </div>

            <div
              data-testid="leader-im-policy-section"
              className="space-y-3 rounded-xl border border-border/70 bg-muted/25 px-3.5 py-3 text-xs"
            >
              <div className="flex items-start gap-2">
                <ShieldCheckIcon className="mt-0.5 size-4 shrink-0 text-primary" aria-hidden="true" />
                <div>
                  <div className="font-medium text-foreground">
                    {isEn ? "IM delegation & progress reporting policy" : "IM 跨对话委派与进展汇报审批策略"}
                  </div>
                  <p className="text-[11px] text-muted-foreground">
                    {isEn
                      ? "Restricted by default. Group chats strictly enforce capability attenuation and can never auto-delegate or read private memory."
                      : "默认最小权限：所有跨对话操作均需桌面确认；群聊遵循权限收窄原则，不可开启自动委派或读取私有记忆。"}
                  </p>
                </div>
              </div>

              <div className="grid grid-cols-1 gap-3 md:grid-cols-2">
                <div className="space-y-2 rounded-lg border border-border/70 bg-background/80 p-3">
                  <div className="font-medium text-foreground">
                    {isEn ? "Owner DM (owner_dm)" : "我的私聊（Owner 私聊）"}
                  </div>
                  <label className="grid gap-1 text-[11px] text-muted-foreground">
                    {isEn ? "Cross-thread delegation" : "跨对话委派审批"}
                    <select
                      data-testid="im-policy-owner-dm-delegation"
                      aria-label={isEn ? "Owner DM delegation policy" : "私聊跨对话委派策略"}
                      value={draftImPolicy.ownerDm.delegationMode}
                      onChange={(e) => {
                        const mode = e.target.value as ImDelegationMode;
                        setDraftImPolicy((prev) => ({
                          ...prev,
                          ownerDm: {
                            ...prev.ownerDm,
                            delegationMode: mode,
                            allowedProjectIds: mode === "scoped_auto" ? prev.ownerDm.allowedProjectIds : [],
                          },
                        }));
                      }}
                      className="rounded-md border border-input bg-background px-2 py-1 text-xs text-foreground"
                    >
                      <option value="always_ask">{isEn ? "Always ask on desktop (Default)" : "每次询问桌面确认（默认）"}</option>
                      <option value="scoped_auto">{isEn ? "Auto-allow status checks for selected folders" : "仅指定文件夹内免审批查进度"}</option>
                      <option value="deny">{isEn ? "Deny cross-thread queries & actions" : "禁止跨对话查询与跨群操作"}</option>
                    </select>
                  </label>
                  {draftImPolicy.ownerDm.delegationMode === "scoped_auto" ? (
                    <div data-testid="im-policy-owner-dm-projects" className="space-y-1 pt-1">
                      <div className="text-[11px] text-muted-foreground">
                        {isEn ? "Authorized folders for Owner DM auto-delegation:" : "允许私聊自动委派的文件夹："}
                      </div>
                      {allOwnerDmPolicyProjects.length === 0 ? (
                        <p className="text-[11px] text-muted-foreground">
                          {isEn ? "No folders available." : "暂无可选文件夹。"}
                        </p>
                      ) : (
                        <div className="flex flex-wrap gap-1.5">
                          {allOwnerDmPolicyProjects.map((project) => {
                            const checked = draftImPolicy.ownerDm.allowedProjectIds.includes(project.id);
                            return (
                              <label
                                key={project.id}
                                className="inline-flex cursor-pointer items-center gap-1 rounded border border-border bg-background px-2 py-0.5 text-[11px] text-foreground"
                              >
                                <input
                                  type="checkbox"
                                  checked={checked}
                                  onChange={() =>
                                    setDraftImPolicy((prev) => ({
                                      ...prev,
                                      ownerDm: {
                                        ...prev.ownerDm,
                                        allowedProjectIds: prev.ownerDm.allowedProjectIds.includes(project.id)
                                          ? prev.ownerDm.allowedProjectIds.filter((id) => id !== project.id)
                                          : [...prev.ownerDm.allowedProjectIds, project.id],
                                      },
                                    }))
                                  }
                                />
                                <span>{project.title}</span>
                              </label>
                            );
                          })}
                        </div>
                      )}
                    </div>
                  ) : null}
                  <label className="grid gap-1 text-[11px] text-muted-foreground">
                    {isEn ? "Progress reporting" : "进度汇报频率"}
                    <select
                      data-testid="im-policy-owner-dm-report"
                      aria-label={isEn ? "Owner DM progress report mode" : "私聊进度汇报模式"}
                      value={draftImPolicy.ownerDm.progressReportMode}
                      onChange={(e) => {
                        const mode = e.target.value as ImProgressReportMode;
                        setDraftImPolicy((prev) => ({
                          ...prev,
                          ownerDm: { ...prev.ownerDm, progressReportMode: mode },
                        }));
                      }}
                      className="rounded-md border border-input bg-background px-2 py-1 text-xs text-foreground"
                    >
                      <option value="completion_and_blocked">{isEn ? "Completion & blocked only (Default)" : "仅回报完成与阻塞（默认）"}</option>
                      <option value="phase_summary">{isEn ? "Live phase summaries" : "实时回报阶段进展"}</option>
                      <option value="silent">{isEn ? "Final reply only (Silent)" : "静默（仅发送最终结果）"}</option>
                    </select>
                  </label>
                </div>

                <div className="space-y-2 rounded-lg border border-border/70 bg-background/80 p-3">
                  <div className="font-medium text-foreground">
                    {isEn ? "Group chats (group)" : "群聊（受限受众）"}
                  </div>
                  <label className="grid gap-1 text-[11px] text-muted-foreground">
                    {isEn ? "Cross-thread delegation" : "跨对话委派审批"}
                    <select
                      data-testid="im-policy-group-delegation"
                      aria-label={isEn ? "Group delegation policy" : "群聊跨对话委派策略"}
                      value={draftImPolicy.group.delegationMode}
                      onChange={(e) => {
                        const mode: ImDelegationMode = e.target.value === "deny" ? "deny" : "always_ask";
                        setDraftImPolicy((prev) => ({
                          ...prev,
                          group: { ...prev.group, delegationMode: mode, allowedProjectIds: [] },
                        }));
                      }}
                      className="rounded-md border border-input bg-background px-2 py-1 text-xs text-foreground"
                    >
                      <option value="always_ask">{isEn ? "Always ask on desktop (Default)" : "每次询问桌面确认（默认）"}</option>
                      <option value="deny">{isEn ? "Deny cross-thread delegation" : "禁止跨对话委派"}</option>
                    </select>
                  </label>
                  <label className="grid gap-1 text-[11px] text-muted-foreground">
                    {isEn ? "Progress reporting" : "进度汇报频率"}
                    <select
                      data-testid="im-policy-group-report"
                      aria-label={isEn ? "Group progress report mode" : "群聊进度汇报模式"}
                      value={draftImPolicy.group.progressReportMode}
                      onChange={(e) => {
                        const mode = e.target.value as ImProgressReportMode;
                        setDraftImPolicy((prev) => ({
                          ...prev,
                          group: { ...prev.group, progressReportMode: mode },
                        }));
                      }}
                      className="rounded-md border border-input bg-background px-2 py-1 text-xs text-foreground"
                    >
                      <option value="completion_and_blocked">{isEn ? "Completion & blocked only (Default)" : "仅回报完成与阻塞（默认）"}</option>
                      <option value="phase_summary">{isEn ? "Live phase summaries" : "实时回报阶段进展"}</option>
                      <option value="silent">{isEn ? "Final reply only (Silent)" : "静默（仅发送最终结果）"}</option>
                    </select>
                  </label>
                </div>
              </div>
            </div>

            <div className="flex flex-wrap items-center justify-between gap-2 pt-1">
              <div className="flex flex-wrap gap-2">
                <Button
                  type="button"
                  size="sm"
                  variant="outline"
                  disabled={busy}
                  onClick={() => void handleResetSession()}
                >
                  <RotateCcwIcon className="mr-1 size-3.5" aria-hidden="true" />
                  {isEn ? "Reset context" : "重置对话"}
                </Button>
                <Button
                  type="button"
                  size="sm"
                  variant="outline"
                  disabled={busy}
                  onClick={() => void handleCopyDiagnostics()}
                >
                  <ClipboardCopyIcon className="mr-1 size-3.5" aria-hidden="true" />
                  {isEn ? "Copy diagnostics" : "复制脱敏诊断"}
                </Button>
                {!isDefaultNavigator ? (
                  <Button
                    type="button"
                    size="sm"
                    variant="outline"
                    data-testid="leader-archive-button"
                    disabled={busy || overview.pausedPending.length > 0}
                    title={
                      overview.pausedPending.length > 0
                        ? isEn
                          ? "Resolve queued paused messages in Needs You before archiving"
                          : "请先在 Needs You 中处理暂停积压消息后再归档"
                        : undefined
                    }
                    onClick={() => void handleArchiveNavigator()}
                  >
                    <ArchiveIcon className="mr-1 size-3.5" aria-hidden="true" />
                    {isEn ? "Archive Navigator" : "归档领航者"}
                  </Button>
                ) : null}
              </div>
              <Button type="submit" size="sm" disabled={busy}>
                {busy ? <Loader2Icon className="mr-1 size-3.5 animate-spin" aria-hidden="true" /> : null}
                {isEn ? "Save settings" : "保存设置"}
              </Button>
            </div>
          </form>
        </div>
      ) : null}
      </div>
    ) : null;

  if (renderHeader) {
    return (
      <>
        {renderHeader(headerRow)}
        {drawersContent}
      </>
    );
  }

  return (
    <section className="w-full px-3 py-1.5 sm:px-5">
      {headerRow}
      {drawersContent}
    </section>
  );
}
