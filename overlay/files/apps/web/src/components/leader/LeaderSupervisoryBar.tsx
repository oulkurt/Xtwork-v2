import { useEffect, useState, type FormEvent } from "react";
import { useNavigate } from "@tanstack/react-router";
import {
  AlertCircleIcon,
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
  XIcon,
} from "lucide-react";
import type { EnvironmentId } from "@t3tools/contracts";
import { useProjects } from "../../state/entities";
import { Button } from "../ui/button";
import { Input } from "../ui/input";
import { REMOTE_IM_CHANNELS } from "../settings/remoteImThemes";
import {
  LEADER_ROLE_TEMPLATES,
  leaderRequest,
  type LeaderListItem,
  type LeaderOverview,
} from "./leaderTypes";

export interface LeaderSupervisoryBarProps {
  readonly threadId: string;
  readonly environmentId: EnvironmentId;
  readonly onOpenThread?: (threadId: string) => void;
  readonly availableProjects?: readonly { readonly id: string; readonly title: string }[];
}

const AUDIENCE_LABEL: Record<"local_only" | "owner_dm" | "group", string> = {
  local_only: "本机",
  owner_dm: "私聊",
  group: "群聊",
};

const PHASE_LABEL: Record<string, string> = {
  waiting_for_approval: "等待批准",
  waiting_for_input: "等你决定",
  failed: "失败",
  running: "进行中",
  starting: "启动中",
  completed: "已完成",
};

/**
 * Compact Leader Supervisory Header, Needs You queue, and Leader configuration panel.
 * Renders ONLY when the active thread is a Leader's fixed `local_only` supervisory thread.
 */
export function LeaderSupervisoryBar({
  threadId,
  environmentId,
  onOpenThread,
  availableProjects,
}: LeaderSupervisoryBarProps) {
  const desktop = typeof window !== "undefined" && Boolean(window.desktopBridge);
  const navigate = useNavigate();
  const storeProjects = useProjects();
  const selectableProjects =
    availableProjects ??
    storeProjects
      .filter((project) => project.environmentId === environmentId && project.archivedAt === null)
      .map((project) => ({ id: project.id, title: project.title }));
  const [matchedLeaderId, setMatchedLeaderId] = useState<string | null>(null);
  const [overview, setOverview] = useState<LeaderOverview | null>(null);
  const [expanded, setExpanded] = useState(false);
  const [configOpen, setConfigOpen] = useState(false);
  const [busy, setBusy] = useState(false);
  const [notice, setNotice] = useState("");
  const [error, setError] = useState("");

  // Editable Leader settings form state (S11: preserve full awarenessScope including `projects` & projectIds)
  const [draftName, setDraftName] = useState("");
  const [draftAvatar, setDraftAvatar] = useState("");
  const [draftRole, setDraftRole] = useState("");
  const [draftAwarenessKind, setDraftAwarenessKind] = useState<"all_local" | "projects" | "none">("all_local");
  const [draftProjectIds, setDraftProjectIds] = useState<readonly string[]>([]);

  useEffect(() => {
    if (!desktop) return;
    const controller = new AbortController();
    let timer: ReturnType<typeof setTimeout>;
    const sync = async () => {
      try {
        const listRes = await leaderRequest<{ leaders?: LeaderListItem[] }>("leaders", undefined, controller.signal);
        if (controller.signal.aborted) return;
        const match = listRes.leaders?.find((item) => item.leader.pinnedThreadId === threadId);
        if (!match) {
          setMatchedLeaderId(null);
          setOverview(null);
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
        }
      } catch {
        // Silent retry on next poll tick.
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

  if (!desktop || !matchedLeaderId || !overview) return null;

  const leader = overview.leader;
  const isPaused = leader.status === "paused";

  async function refreshOverview() {
    if (!matchedLeaderId) return;
    const detail = await leaderRequest<LeaderOverview>(`leaders/${matchedLeaderId}/overview`);
    setOverview(detail);
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
      setError(cause instanceof Error ? cause.message : "操作失败，请重试。");
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
      await leaderRequest(`leaders/${leader.id}/update`, {
        name: draftName,
        avatar: draftAvatar,
        role: draftRole,
        ...(scopeChanged
          ? { awarenessScope: { kind: draftAwarenessKind, projectIds: normalizedProjects } }
          : {}),
      });
      setConfigOpen(false);
    }, "Leader 设置已保存。");
  }

  async function handleCopyDiagnostics() {
    await runAction(async () => {
      const res = await leaderRequest<{ text: string }>(`leaders/${leader.id}/diagnostics`);
      if (typeof navigator !== "undefined" && navigator.clipboard?.writeText) {
        await navigator.clipboard.writeText(res.text);
      }
    }, "已复制脱敏诊断信息。");
  }

  async function handleResetSession() {
    await runAction(async () => {
      const res = await leaderRequest<{ threadId: string }>(`leaders/${leader.id}/reset-session`, {});
      if (res.threadId) {
        if (onOpenThread) {
          onOpenThread(res.threadId);
        } else {
          void navigate({
            to: "/$environmentId/$threadId",
            params: { environmentId, threadId: res.threadId },
          });
        }
      }
    }, "已开启全新模型上下文，历史消息、记忆、待办与聊天软件连接均已保留。");
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

  return (
    <section
      data-testid="leader-supervisory-bar"
      className="border-b border-border/70 bg-card/70 px-4 py-2.5 backdrop-blur-xs"
      aria-label="Leader 主管状态栏"
    >
      <div className="mx-auto flex max-w-4xl flex-wrap items-center justify-between gap-2">
        <div className="flex min-w-0 items-center gap-2.5">
          <span className="flex size-7 shrink-0 items-center justify-center rounded-lg border border-border bg-background text-xs font-semibold text-foreground">
            {leader.avatar || Array.from(leader.name)[0] || "瞳"}
          </span>
          <div className="min-w-0">
            <div className="flex items-center gap-2">
              <span className="truncate text-sm font-semibold text-foreground">{leader.name}</span>
              <span
                className={`inline-flex items-center rounded-full px-2 py-0.5 text-[11px] font-medium ${
                  isPaused
                    ? "bg-amber-500/15 text-amber-700 dark:text-amber-300"
                    : "bg-emerald-500/15 text-emerald-700 dark:text-emerald-300"
                }`}
              >
                {isPaused ? "已暂停" : "活跃"}
              </span>
              {overview.connections.map((conn, idx) => (
                <span
                  key={conn.id ?? `${conn.platform}-${idx}`}
                  className="inline-flex items-center rounded-full border border-border/70 bg-background/80 px-2 py-0.5 text-[11px] text-muted-foreground"
                >
                  {REMOTE_IM_CHANNELS[conn.platform]?.name ?? conn.platform}
                </span>
              ))}
            </div>
            <p className="truncate text-xs text-muted-foreground">
              {overview.needsYou.runningCount > 0
                ? `${overview.needsYou.runningCount} 项进行中 · `
                : ""}
              {totalAttention > 0
                ? `${totalAttention} 项需要你决定`
                : "桌面主管控制面 · 各任务仍在独立对话中隔离执行"}
            </p>
          </div>
        </div>

        <div className="flex flex-wrap items-center gap-1.5">
          <Button
            size="sm"
            variant={totalAttention > 0 ? "default" : "outline"}
            onClick={() => setExpanded((value) => !value)}
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
            disabled={busy}
            onClick={() =>
              void runAction(
                async () => {
                  await leaderRequest(`leaders/${leader.id}/${isPaused ? "resume" : "pause"}`, {});
                },
                isPaused ? "Leader 已恢复接单，可在下方选择重投暂停期间的消息。" : "Leader 已暂停接单，在途任务将继续完成且 /stop 保持可用。",
              )
            }
          >
            {isPaused ? (
              <>
                <PlayIcon className="mr-1 size-3.5" aria-hidden="true" />
                恢复
              </>
            ) : (
              <>
                <PauseIcon className="mr-1 size-3.5" aria-hidden="true" />
                暂停
              </>
            )}
          </Button>
          <Button size="sm" variant="outline" onClick={() => setConfigOpen((value) => !value)}>
            <Settings2Icon className="mr-1 size-3.5" aria-hidden="true" />
            管理
          </Button>
        </div>
      </div>

      {notice ? (
        <p className="mx-auto mt-2 max-w-4xl text-xs text-emerald-700 dark:text-emerald-400" role="status">
          {notice}
        </p>
      ) : null}
      {error ? (
        <p className="mx-auto mt-2 max-w-4xl text-xs text-destructive" role="alert">
          {error}
        </p>
      ) : null}

      {/* Expandable Needs You + Scoped Awareness Queue */}
      {expanded ? (
        <div
          data-testid="leader-needs-you-panel"
          className="mx-auto mt-3 max-w-4xl space-y-3 rounded-xl border border-border/80 bg-background/90 p-3.5"
        >
          {overview.approvals.length > 0 ? (
            <div className="space-y-2">
              <h3 className="text-xs font-semibold text-foreground">待你批准的操作</h3>
              {overview.approvals.map((item) => {
                const isSnapshotShare = Boolean(item.snapshotHash);
                const fullSnapshot = item.contentSnapshot ?? item.contentPreview;
                const destinationLabel =
                  item.targetChatName || item.targetChatId || item.targetScope || AUDIENCE_LABEL[item.replyAudience];
                const canApprove =
                  !busy &&
                  Boolean(item.turnId) &&
                  (!isSnapshotShare || (typeof fullSnapshot === "string" && fullSnapshot.length > 0));
                return (
                  <div
                    key={item.id}
                    className="flex flex-col gap-2 rounded-lg border border-amber-500/30 bg-amber-500/5 p-2.5"
                  >
                    <div className="flex flex-wrap items-center justify-between gap-2">
                      <div className="flex flex-wrap items-center gap-2 text-xs">
                        <AlertCircleIcon className="size-3.5 text-amber-600" aria-hidden="true" />
                        <span className="font-mono font-semibold text-foreground">{item.toolName}</span>
                        <span className="rounded bg-muted px-1.5 py-0.5 text-[11px] text-muted-foreground">
                          {AUDIENCE_LABEL[item.replyAudience]}
                        </span>
                        {item.targetChatName || item.targetChatId || item.targetScope ? (
                          <span
                            data-testid={`approval-destination-${item.id}`}
                            className="rounded bg-amber-500/15 px-1.5 py-0.5 text-[11px] font-medium text-amber-800 dark:text-amber-200"
                          >
                            目标：{destinationLabel}
                          </span>
                        ) : null}
                        {item.snapshotHash ? (
                          <span className="rounded bg-muted px-1.5 py-0.5 font-mono text-[10px] text-muted-foreground">
                            快照 {item.snapshotHash.slice(0, 8)}
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
                            }, "已单次批准该操作。")
                          }
                        >
                          允许一次
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
                            }, "已拒绝该操作。")
                          }
                        >
                          拒绝
                        </Button>
                      </div>
                    </div>
                    {isSnapshotShare ? (
                      <div className="space-y-1">
                        <div className="text-[11px] text-amber-800 dark:text-amber-200">
                          以下完整不可变快照（共 {fullSnapshot?.length ?? 0} 字符）将在批准后一次性复制到目标群聊，不会开放私有记忆实时读取：
                        </div>
                        <pre
                          data-testid={`approval-snapshot-${item.id}`}
                          className="max-h-60 overflow-auto whitespace-pre-wrap break-all rounded bg-muted/60 p-2 font-mono text-[11px] text-foreground"
                        >
                          {fullSnapshot ?? ""}
                        </pre>
                      </div>
                    ) : (
                      <pre className="max-h-40 overflow-auto whitespace-pre-wrap break-all rounded bg-muted/60 p-2 font-mono text-[11px] text-foreground">
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
              <h3 className="text-xs font-semibold text-foreground">暂停期间积压消息（待审重投）</h3>
              {overview.pausedPending.map((item) => (
                <div
                  key={item.id}
                  className="flex flex-wrap items-center justify-between gap-2 rounded-lg border border-border bg-card/70 px-2.5 py-2 text-xs"
                >
                  <div className="min-w-0 flex-1">
                    <div className="font-medium text-foreground">
                      {REMOTE_IM_CHANNELS[item.platform]?.name ?? item.platform} ·{" "}
                      {item.chatName || item.senderName || "远程消息"}
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
                          if ((res.count ?? 0) > 0) return "已按原幂等键重新投递。";
                          if (res.blockedIds && res.blockedIds.length > 0) {
                            return "该消息所属聊天或联系人已被屏蔽，已拒绝重投。";
                          }
                          if (res.heldIds && res.heldIds.length > 0) {
                            return "该消息权限已变更为需审批，已退回待批准列表。";
                          }
                          if (res.skippedIds && res.skippedIds.length > 0) {
                            return "当前连接或 Leader 处于暂停/未激活状态，消息仍保留在暂停积压队列中。";
                          }
                          return "未找到可重投的积压消息。";
                        })
                      }
                    >
                      重投
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
                        }, "已忽略该积压消息。")
                      }
                    >
                      忽略
                    </Button>
                  </div>
                </div>
              ))}
            </div>
          ) : null}

          <div className="space-y-1.5">
            <h3 className="text-xs font-semibold text-foreground">
              受权范围任务动态（{overview.needsYou.threads.length}）
            </h3>
            {overview.needsYou.threads.length === 0 ? (
              <p className="text-xs text-muted-foreground">当前没有需要关注的进行中或待处理任务。</p>
            ) : (
              <div className="grid gap-1.5">
                {overview.needsYou.threads.slice(0, 8).map((item) => (
                  <button
                    key={item.threadId}
                    type="button"
                    onClick={() => jumpToThread(item.threadId)}
                    className="flex items-center justify-between gap-2 rounded-lg border border-border/70 bg-card/50 px-2.5 py-1.5 text-left text-xs hover:bg-accent/50"
                  >
                    <span className="min-w-0 flex-1 truncate font-medium text-foreground">
                      {item.title}
                    </span>
                    <span className="flex shrink-0 items-center gap-1.5 text-[11px] text-muted-foreground">
                      <span>{AUDIENCE_LABEL[item.replyAudience]}</span>
                      <span className="rounded bg-muted px-1.5 py-0.5 text-foreground">
                        {PHASE_LABEL[item.phase] ?? item.headline}
                      </span>
                    </span>
                  </button>
                ))}
              </div>
            )}
          </div>
        </div>
      ) : null}

      {/* Mingle-inspired Leader Management Sheet */}
      {configOpen ? (
        <div
          data-testid="leader-config-panel"
          className="mx-auto mt-3 max-w-4xl space-y-4 rounded-xl border border-border bg-background p-4 shadow-sm"
        >
          <div className="flex items-center justify-between">
            <h3 className="text-sm font-semibold text-foreground">Leader 设置 · {leader.name}</h3>
            <button
              type="button"
              aria-label="关闭 Leader 设置"
              onClick={() => setConfigOpen(false)}
              className="rounded-md p-1 text-muted-foreground hover:bg-accent hover:text-foreground"
            >
              <XIcon className="size-4" aria-hidden="true" />
            </button>
          </div>

          <form className="space-y-3" onSubmit={(event) => void handleSaveConfig(event)}>
            <div className="grid grid-cols-1 gap-3 sm:grid-cols-4">
              <label className="grid gap-1 text-xs font-medium text-foreground sm:col-span-3">
                名字
                <Input
                  value={draftName}
                  onChange={(e) => setDraftName(e.target.value)}
                  placeholder="给 Leader 起个名字"
                  required
                />
              </label>
              <label className="grid gap-1 text-xs font-medium text-foreground">
                头像徽章
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
                  公开角色介绍（ROLE.md）
                </label>
                <span className="text-[11px] text-amber-700 dark:text-amber-300">
                  所有已连接聊天都会使用这份角色介绍；私人背景请写入私有记忆
                </span>
              </div>
              <textarea
                id={`leader-role-${leader.id}`}
                rows={3}
                value={draftRole}
                onChange={(e) => setDraftRole(e.target.value)}
                placeholder="告诉它它是谁、负责什么..."
                className="w-full rounded-lg border border-input bg-background px-3 py-2 text-xs text-foreground outline-none focus-visible:ring-2 focus-visible:ring-ring"
              />
              <div className="flex flex-wrap gap-1.5">
                {LEADER_ROLE_TEMPLATES.map((tpl) => (
                  <button
                    key={tpl.id}
                    type="button"
                    onClick={() => setDraftRole(tpl.prompt)}
                    className="rounded-full border border-border bg-muted/50 px-2.5 py-1 text-[11px] text-foreground hover:bg-accent"
                  >
                    {tpl.label}
                  </button>
                ))}
              </div>
            </div>

            <div className="space-y-2 rounded-lg border border-border/70 bg-muted/30 px-3 py-2 text-xs">
              <div className="flex flex-wrap items-center justify-between gap-2">
                <div>
                  <div className="font-medium text-foreground">桌面跨对话状态感知</div>
                  <p className="text-[11px] text-muted-foreground">
                    仅授权桌面控制面主动聚合本机任务进展与 Needs You；群聊与私聊默认保持隔离
                  </p>
                </div>
                <select
                  aria-label="桌面跨对话状态感知"
                  value={draftAwarenessKind}
                  onChange={(e) => {
                    const value = e.target.value;
                    setDraftAwarenessKind(
                      value === "none" ? "none" : value === "projects" ? "projects" : "all_local",
                    );
                  }}
                  className="rounded-md border border-input bg-background px-2.5 py-1 text-xs text-foreground"
                >
                  <option value="all_local">全部本机任务</option>
                  <option value="projects">指定文件夹</option>
                  <option value="none">仅此 Leader 远程任务</option>
                </select>
              </div>
              {draftAwarenessKind === "projects" ? (
                <div data-testid="leader-project-scope-picker" className="space-y-1.5 border-t border-border/60 pt-2">
                  <div className="text-[11px] text-muted-foreground">选择允许此 Leader 感知状态的文件夹：</div>
                  {selectableProjects.length === 0 && draftProjectIds.length === 0 ? (
                    <p className="text-[11px] text-muted-foreground">暂无可选本机文件夹。</p>
                  ) : (
                    <div className="flex flex-wrap gap-2">
                      {[
                        ...selectableProjects,
                        ...draftProjectIds
                          .filter((id) => !selectableProjects.some((p) => p.id === id))
                          .map((id) => ({ id, title: id })),
                      ].map((project) => {
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

            <div className="flex flex-wrap items-center justify-between gap-2 pt-1">
              <div className="flex flex-wrap gap-2">
                <Button
                  type="button"
                  size="sm"
                  variant="outline"
                  onClick={() => void navigate({ to: "/settings/remote-connections" })}
                >
                  <Link2Icon className="mr-1 size-3.5" aria-hidden="true" />
                  管理 / 添加聊天软件
                </Button>
                <Button
                  type="button"
                  size="sm"
                  variant="outline"
                  disabled={busy}
                  onClick={() => void handleResetSession()}
                >
                  <RotateCcwIcon className="mr-1 size-3.5" aria-hidden="true" />
                  重置对话
                </Button>
                <Button
                  type="button"
                  size="sm"
                  variant="outline"
                  disabled={busy}
                  onClick={() => void handleCopyDiagnostics()}
                >
                  <ClipboardCopyIcon className="mr-1 size-3.5" aria-hidden="true" />
                  复制脱敏诊断
                </Button>
              </div>
              <Button type="submit" size="sm" disabled={busy}>
                {busy ? <Loader2Icon className="mr-1 size-3.5 animate-spin" aria-hidden="true" /> : null}
                保存设置
              </Button>
            </div>
          </form>
        </div>
      ) : null}
    </section>
  );
}
