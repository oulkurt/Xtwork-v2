import { useEffect, useMemo, useRef, useState, type FormEvent, type ReactNode } from "react";
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
  RotateCwIcon,
  Settings2Icon,
  ShieldAlertIcon,
  ShieldCheckIcon,
  XIcon,
} from "lucide-react";
import type { EnvironmentId } from "@t3tools/contracts";
import { useProjects, useQuietThreadShells } from "../../state/entities";
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
import {
  extractPinnedThreadSignal,
  isConnectionStrictlyOnline,
  isLightAvatarBodyColor,
  parseNavigatorAvatar,
  resolveNavigatorBoundChannels,
  type NavigatorThreadSignal,
  type NavigatorWorkSignals,
} from "./navigatorAvatarModel";
import { NavigatorBotAvatar, useNavigatorAvatarPresentation } from "./NavigatorBotAvatar";
import { NavigatorAvatarEditor } from "./NavigatorAvatarEditor";

export interface LeaderSupervisoryBarProps {
  readonly threadId: string;
  readonly environmentId: EnvironmentId;
  readonly rightPanelOpen?: boolean;
  readonly renderHeader?: (headerContent: ReactNode) => ReactNode;
  readonly fallbackHeader?: ReactNode;
  readonly onOpenThread?: (threadId: string) => void;
  readonly availableProjects?: readonly { readonly id: string; readonly title: string }[];
}

interface ConfigSnapshot {
  readonly name: string;
  readonly avatar: string;
  readonly role: string;
  readonly awarenessKind: "all_local" | "projects" | "none";
  readonly projectIds: readonly string[];
  readonly imPolicy: ImDelegationPolicy;
}

function PausedMessageBody({
  id,
  body,
  expanded,
  isEn,
  onToggle,
}: {
  readonly id: string;
  readonly body: string;
  readonly expanded: boolean;
  readonly isEn: boolean;
  readonly onToggle: () => void;
}) {
  const textRef = useRef<HTMLParagraphElement>(null);
  const [truncated, setTruncated] = useState(false);

  useEffect(() => {
    const el = textRef.current;
    if (!el || expanded) return;
    const check = () => {
      setTruncated(body.includes("\n") || el.scrollWidth > el.clientWidth + 1);
    };
    check();
    const observer = typeof ResizeObserver !== "undefined" ? new ResizeObserver(check) : null;
    observer?.observe(el);
    window.addEventListener("resize", check);
    return () => {
      observer?.disconnect();
      window.removeEventListener("resize", check);
    };
  }, [body, expanded]);

  return (
    <>
      <p
        ref={textRef}
        data-testid={`paused-message-body-${id}`}
        title={expanded ? undefined : body}
        className={
          expanded
            ? "whitespace-pre-wrap break-words text-muted-foreground"
            : "truncate text-muted-foreground"
        }
      >
        {body}
      </p>
      {truncated || expanded ? (
        <button
          type="button"
          data-testid={`paused-message-toggle-${id}`}
          onClick={onToggle}
          className="mt-0.5 text-[11px] text-primary hover:underline"
        >
          {expanded ? (isEn ? "Collapse" : "收起") : isEn ? "Show full message" : "展开全文"}
        </button>
      ) : null}
    </>
  );
}

const pendingNavigatorNoticeByLeaderId = new Map<string, string>();

function NavigatorHeaderAvatar({
  overview,
  totalAttention,
  pinnedThread,
}: {
  readonly overview: LeaderOverview;
  readonly totalAttention: number;
  readonly pinnedThread: NavigatorThreadSignal | null;
}) {
  const resolvedAvatar = useMemo(
    () => parseNavigatorAvatar(overview.leader.avatar, overview.leader.id),
    [overview.leader.avatar, overview.leader.id],
  );
  const lightBody = isLightAvatarBodyColor(resolvedAvatar.color);
  const awarenessScopeKey = useMemo(
    () => JSON.stringify(overview.leader.awarenessScope),
    [overview.leader.awarenessScope],
  );
  const signals = useMemo<NavigatorWorkSignals>(
    () => ({
      leaderStatus: overview.leader.status,
      pinnedThread,
      runningCount: overview.needsYou.runningCount,
      startingCount: overview.needsYou.startingCount,
      waitingCount: overview.needsYou.waitingCount,
      failedCount: overview.needsYou.failedCount,
      pendingApprovalCount: overview.approvals.length,
      pausedPendingCount: overview.pausedPending.length,
      needsYouCount: totalAttention,
      latestCompletedKey: overview.needsYou.latestCompletedKey,
      latestCompletedAtMs: overview.needsYou.latestCompletedAtMs,
      awarenessScopeKey,
    }),
    [overview, totalAttention, pinnedThread, awarenessScopeKey],
  );
  const presentation = useNavigatorAvatarPresentation(signals);
  return (
    <span
      className={`flex size-7 shrink-0 items-center justify-center rounded-lg border border-foreground/12 shadow-2xs ${
        lightBody ? "bg-foreground/[0.08] dark:bg-white/10" : "bg-background/60"
      }`}
    >
      <NavigatorBotAvatar
        avatar={overview.leader.avatar}
        leaderId={overview.leader.id}
        state={presentation.state}
        mood={presentation.mood}
        size={24}
        testId="leader-header-avatar"
      />
    </span>
  );
}

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
  const threadShells = useQuietThreadShells();
  const selectableProjects =
    availableProjects ??
    storeProjects
      .filter((project) => project.environmentId === environmentId && project.archivedAt === null && !project.isScratch)
      .map((project) => ({ id: project.id, title: project.title }));

  const [allLeaders, setAllLeaders] = useState<readonly LeaderListItem[]>([]);
  const [matchedLeaderId, setMatchedLeaderId] = useState<string | null>(null);
  const [overview, setOverview] = useState<LeaderOverview | null>(null);
  const [loadedThreadId, setLoadedThreadId] = useState<string | null>(null);
  const [loadError, setLoadError] = useState("");
  const [expanded, setExpanded] = useState(false);
  const [configOpen, setConfigOpen] = useState(false);
  const [busy, setBusy] = useState(false);
  const [notice, setNotice] = useState("");
  const [error, setError] = useState("");
  const [confirmingArchive, setConfirmingArchive] = useState(false);
  const [showAllThreads, setShowAllThreads] = useState(false);
  const [expandedPausedIds, setExpandedPausedIds] = useState<ReadonlySet<string>>(() => new Set());
  const [diagnosticsFallback, setDiagnosticsFallback] = useState("");
  const [drawerMaxHeight, setDrawerMaxHeight] = useState<number | null>(null);

  const [draftName, setDraftName] = useState("");
  const [draftAvatar, setDraftAvatar] = useState("");
  const [draftRole, setDraftRole] = useState("");
  const [draftAwarenessKind, setDraftAwarenessKind] = useState<"all_local" | "projects" | "none">("all_local");
  const [draftProjectIds, setDraftProjectIds] = useState<readonly string[]>([]);
  const [draftImPolicy, setDraftImPolicy] = useState<ImDelegationPolicy>(DEFAULT_IM_DELEGATION_POLICY);

  const openedSnapshotRef = useRef<ConfigSnapshot | null>(null);
  const panelRef = useRef<HTMLDivElement>(null);
  const needsYouTriggerRef = useRef<HTMLButtonElement>(null);
  const manageTriggerRef = useRef<HTMLButtonElement>(null);
  const syncNowRef = useRef<(() => void) | null>(null);

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
    setLoadError("");
    setExpanded(false);
    setConfigOpen(false);
    setConfirmingArchive(false);
    setShowAllThreads(false);
    setExpandedPausedIds(new Set());
    setDiagnosticsFallback("");
    setError("");
    setNotice("");
    openedSnapshotRef.current = null;
    if (!desktop) return;
    const controller = new AbortController();
    let timer: ReturnType<typeof setTimeout> | undefined;
    let inFlight = false;
    let rerunRequested = false;

    const isHidden = () => typeof document !== "undefined" && document.visibilityState === "hidden";

    const scheduleNext = () => {
      if (controller.signal.aborted || isHidden()) return;
      if (timer !== undefined) clearTimeout(timer);
      timer = setTimeout(() => {
        timer = undefined;
        void runSync();
      }, 2500);
    };

    const runSync = async () => {
      if (controller.signal.aborted) return;
      if (inFlight) {
        rerunRequested = true;
        return;
      }
      if (timer !== undefined) {
        clearTimeout(timer);
        timer = undefined;
      }
      inFlight = true;
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
          setLoadError("");
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
          setLoadError("");
          const pendingNotice = pendingNavigatorNoticeByLeaderId.get(detail.leader.id);
          if (pendingNotice) {
            pendingNavigatorNoticeByLeaderId.delete(detail.leader.id);
            setNotice(pendingNotice);
          }
        }
      } catch (cause) {
        if (!controller.signal.aborted) {
          setLoadError(
            cause instanceof Error
              ? cause.message
              : isEn
                ? "Failed to load Navigator controls."
                : "加载领航员控制栏失败。",
          );
        }
      } finally {
        inFlight = false;
        if (!controller.signal.aborted) {
          if (rerunRequested) {
            rerunRequested = false;
            void runSync();
          } else {
            scheduleNext();
          }
        }
      }
    };

    const onChanged = () => {
      void runSync();
    };
    const onVisibility = () => {
      if (isHidden()) {
        if (timer !== undefined) {
          clearTimeout(timer);
          timer = undefined;
        }
      } else {
        void runSync();
      }
    };
    syncNowRef.current = () => {
      void runSync();
    };
    window.addEventListener("xtwork:leaders-changed", onChanged);
    document.addEventListener("visibilitychange", onVisibility);
    void runSync();
    return () => {
      syncNowRef.current = null;
      window.removeEventListener("xtwork:leaders-changed", onChanged);
      document.removeEventListener("visibilitychange", onVisibility);
      controller.abort();
      if (timer !== undefined) clearTimeout(timer);
    };
  }, [desktop, threadId, isEn]);

  useEffect(() => {
    if (!overview || configOpen) return;
    setDraftName(overview.leader.name);
    setDraftAvatar(overview.leader.avatar);
    setDraftRole(overview.leader.role);
    setDraftAwarenessKind(overview.leader.awarenessScope.kind);
    setDraftProjectIds(overview.leader.awarenessScope.projectIds);
    setDraftImPolicy(normalizeImPolicy(overview.leader.imPolicy));
  }, [overview, configOpen]);

  useEffect(() => {
    if (!expanded && !configOpen) return;
    const onKeyDown = (event: KeyboardEvent) => {
      if (event.key !== "Escape") return;
      event.preventDefault();
      if (configOpen) {
        setConfigOpen(false);
        setConfirmingArchive(false);
        setDiagnosticsFallback("");
        manageTriggerRef.current?.focus();
      } else if (expanded) {
        setExpanded(false);
        setShowAllThreads(false);
        needsYouTriggerRef.current?.focus();
      }
    };
    document.addEventListener("keydown", onKeyDown);
    return () => document.removeEventListener("keydown", onKeyDown);
  }, [expanded, configOpen]);

  useEffect(() => {
    if (!expanded && !configOpen) {
      setDrawerMaxHeight(null);
      return;
    }
    const measure = () => {
      const panel = panelRef.current;
      if (!panel) return;
      const panelTop = panel.getBoundingClientRect().top;
      const column = panel.closest("[data-chat-column]") as HTMLElement | null;
      const composerTarget =
        (column?.querySelector("[data-chat-composer-stack='true']") as HTMLElement | null) ??
        (column?.querySelector("[data-chat-composer-overlay='true']") as HTMLElement | null) ??
        (document.querySelector("[data-chat-composer-stack='true']") as HTMLElement | null) ??
        (document.querySelector("[data-chat-composer-overlay='true']") as HTMLElement | null);
      const columnRect = column?.getBoundingClientRect();
      const viewportBottom = columnRect ? columnRect.bottom : window.innerHeight;
      const viewportHeight = columnRect ? columnRect.height : window.innerHeight;
      const ceiling = Math.floor(viewportHeight * 0.72);
      const composerTop = composerTarget ? composerTarget.getBoundingClientRect().top : viewportBottom - 16;
      const available = Math.floor(composerTop - panelTop - 12);
      if (available > 0) {
        setDrawerMaxHeight(Math.max(120, Math.min(ceiling, available)));
      }
    };
    measure();
    const rafId = typeof requestAnimationFrame !== "undefined" ? requestAnimationFrame(measure) : 0;
    const panel = panelRef.current;
    const column = panel?.closest("[data-chat-column]") as HTMLElement | null;
    const composerTarget =
      (column?.querySelector("[data-chat-composer-stack='true']") as HTMLElement | null) ??
      (column?.querySelector("[data-chat-composer-overlay='true']") as HTMLElement | null) ??
      (document.querySelector("[data-chat-composer-stack='true']") as HTMLElement | null) ??
      (document.querySelector("[data-chat-composer-overlay='true']") as HTMLElement | null);
    const observer = typeof ResizeObserver !== "undefined" ? new ResizeObserver(measure) : null;
    if (observer) {
      if (column) observer.observe(column);
      if (composerTarget) observer.observe(composerTarget);
    }
    window.addEventListener("resize", measure);
    return () => {
      if (rafId) cancelAnimationFrame(rafId);
      observer?.disconnect();
      window.removeEventListener("resize", measure);
    };
  }, [expanded, configOpen, notice, error, confirmingArchive, diagnosticsFallback]);

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
    const loadErrorBanner =
      desktop && matchedLeaderId && loadError ? (
        <div
          data-testid="leader-overview-error"
          role="alert"
          className="flex shrink-0 items-center justify-between gap-2 px-3 pb-1.5 text-xs text-destructive sm:px-5"
        >
          <span className="min-w-0 flex-1 truncate">{loadError}</span>
          <button
            type="button"
            data-testid="leader-overview-retry"
            onClick={() => syncNowRef.current?.()}
            className="inline-flex shrink-0 items-center gap-1 rounded px-2 py-0.5 font-medium hover:bg-destructive/10"
          >
            <RotateCwIcon className="size-3" aria-hidden="true" />
            {isEn ? "Retry" : "重试"}
          </button>
        </div>
      ) : null;
    return renderHeader ? (
      <>
        {renderHeader(fallbackHeader ?? null)}
        {loadErrorBanner}
      </>
    ) : (
      loadErrorBanner
    );
  }

  const leader = overview.leader;
  const isPaused = leader.status === "paused";
  const isDefaultNavigator = leader.id === "leader-default";
  const defaultLeaderName =
    allLeaders.find((item) => item.leader.id === "leader-default")?.leader.name ?? (isEn ? "Default Navigator" : "小瞳");
  const matchedShell = threadShells.find((shell) => shell.id === threadId);
  const pinnedThreadSignal: NavigatorThreadSignal | null = matchedShell
    ? extractPinnedThreadSignal(matchedShell)
    : null;
  const headerBoundChannels = resolveNavigatorBoundChannels({
    connections: overview.connections,
    boundPlatforms: overview.boundPlatforms,
    bindings: overview.bindings,
    lang,
  });
  const missingBoundPlatforms = headerBoundChannels.filter(
    (ch) =>
      !overview.connections.some(
        (conn) =>
          conn.platform === ch.platform &&
          conn.lifecycleState !== "pairing" &&
          conn.lifecycleState !== "idle",
      ),
  );
  const archiveAffectedChannels = Array.from(
    new Set([
      ...overview.connections
        .filter((conn) => conn.lifecycleState !== "pairing" && conn.lifecycleState !== "idle")
        .map((conn) => navigatorChannelLabel(conn.platform, lang)),
      ...headerBoundChannels.map((ch) => ch.label),
    ]),
  );
  const otherUsedShapeIds = allLeaders
    .filter((item) => item.leader.id !== leader.id)
    .map((item) => parseNavigatorAvatar(item.leader.avatar, item.leader.id).shapeId);

  function openConfigPanel() {
    const normalizedPolicy = normalizeImPolicy(leader.imPolicy);
    const projectIds = [...leader.awarenessScope.projectIds];
    openedSnapshotRef.current = {
      name: leader.name,
      avatar: leader.avatar,
      role: leader.role,
      awarenessKind: leader.awarenessScope.kind,
      projectIds,
      imPolicy: normalizedPolicy,
    };
    setDraftName(leader.name);
    setDraftAvatar(leader.avatar);
    setDraftRole(leader.role);
    setDraftAwarenessKind(leader.awarenessScope.kind);
    setDraftProjectIds(projectIds);
    setDraftImPolicy(normalizedPolicy);
    setConfirmingArchive(false);
    setDiagnosticsFallback("");
    setExpanded(false);
    setConfigOpen(true);
  }

  function closeConfigPanel() {
    setConfigOpen(false);
    setConfirmingArchive(false);
    setDiagnosticsFallback("");
  }

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

  async function runAction(
    work: () => Promise<string | void>,
    successMessage?: string,
    options?: { readonly skipRefresh?: boolean },
  ) {
    setBusy(true);
    setError("");
    setNotice("");
    let customNotice: string | void;
    try {
      customNotice = await work();
    } catch (cause) {
      setError(
        cause instanceof Error
          ? cause.message
          : isEn
            ? "Action failed. Please try again."
            : "操作失败，请重试。",
      );
      setBusy(false);
      return;
    }

    const message = typeof customNotice === "string" ? customNotice : successMessage;
    if (message) setNotice(message);

    if (options?.skipRefresh) {
      setBusy(false);
      return;
    }

    try {
      await refreshOverview();
    } catch (refreshCause) {
      setError(
        isEn
          ? `Action succeeded, but refreshing status failed: ${refreshCause instanceof Error ? refreshCause.message : "please retry."}`
          : `操作已生效，但刷新状态失败：${refreshCause instanceof Error ? refreshCause.message : "请稍后重试。"}`,
      );
    } finally {
      setBusy(false);
    }
  }

  async function handleSaveConfig(event: FormEvent) {
    event.preventDefault();
    const trimmedName = draftName.trim();
    if (!trimmedName) {
      setError(isEn ? "Navigator name cannot be empty." : "领航员名字不能为空。");
      return;
    }
    const base: ConfigSnapshot = openedSnapshotRef.current ?? {
      name: leader.name,
      avatar: leader.avatar,
      role: leader.role,
      awarenessKind: leader.awarenessScope.kind,
      projectIds: leader.awarenessScope.projectIds,
      imPolicy: normalizeImPolicy(leader.imPolicy),
    };
    const normalizedProjects = draftAwarenessKind === "projects" ? [...new Set(draftProjectIds)] : [];
    const nameChanged = trimmedName !== base.name.trim();
    const avatarChanged = draftAvatar !== base.avatar;
    const roleChanged = draftRole !== base.role;
    const scopeChanged =
      draftAwarenessKind !== base.awarenessKind ||
      normalizedProjects.length !== base.projectIds.length ||
      normalizedProjects.some((id, idx) => base.projectIds[idx] !== id);
    const nextPolicy = normalizeImPolicy(draftImPolicy);
    const ownerDmDelegationChanged = nextPolicy.ownerDm.delegationMode !== base.imPolicy.ownerDm.delegationMode;
    const ownerDmProjectsChanged =
      nextPolicy.ownerDm.allowedProjectIds.length !== base.imPolicy.ownerDm.allowedProjectIds.length ||
      nextPolicy.ownerDm.allowedProjectIds.some((id, idx) => base.imPolicy.ownerDm.allowedProjectIds[idx] !== id);
    const ownerDmReportChanged = nextPolicy.ownerDm.progressReportMode !== base.imPolicy.ownerDm.progressReportMode;
    const ownerDmPatch: Record<string, unknown> = {
      ...(ownerDmDelegationChanged ? { delegationMode: nextPolicy.ownerDm.delegationMode } : {}),
      ...(ownerDmDelegationChanged || ownerDmProjectsChanged
        ? { allowedProjectIds: nextPolicy.ownerDm.allowedProjectIds }
        : {}),
      ...(ownerDmReportChanged ? { progressReportMode: nextPolicy.ownerDm.progressReportMode } : {}),
    };
    const groupDelegationChanged = nextPolicy.group.delegationMode !== base.imPolicy.group.delegationMode;
    const groupReportChanged = nextPolicy.group.progressReportMode !== base.imPolicy.group.progressReportMode;
    const groupPatch: Record<string, unknown> = {
      ...(groupDelegationChanged ? { delegationMode: nextPolicy.group.delegationMode } : {}),
      ...(groupReportChanged ? { progressReportMode: nextPolicy.group.progressReportMode } : {}),
    };
    const imPolicyPatch: Record<string, unknown> = {
      ...(Object.keys(ownerDmPatch).length > 0 ? { ownerDm: ownerDmPatch } : {}),
      ...(Object.keys(groupPatch).length > 0 ? { group: groupPatch } : {}),
    };
    const policyChanged = Object.keys(imPolicyPatch).length > 0;

    const patch: Record<string, unknown> = {
      ...(nameChanged ? { name: trimmedName } : {}),
      ...(avatarChanged ? { avatar: draftAvatar } : {}),
      ...(roleChanged ? { role: draftRole } : {}),
      ...(scopeChanged ? { awarenessScope: { kind: draftAwarenessKind, projectIds: normalizedProjects } } : {}),
      ...(policyChanged ? { imPolicy: imPolicyPatch } : {}),
    };

    if (Object.keys(patch).length === 0) {
      closeConfigPanel();
      setNotice(isEn ? "No changes to save." : "未检测到设置变更。");
      return;
    }

    await runAction(async () => {
      await leaderRequest(`leaders/${leader.id}/update`, patch);
      closeConfigPanel();
    }, isEn ? "Navigator settings saved." : "领航员设置已保存。");
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
        : `连接已换绑至「${target}」，新消息将由该领航员承接，历史归属保持不变。`;
    });
  }

  async function handleArchiveNavigator() {
    if (isDefaultNavigator || !overview) return;
    setBusy(true);
    setError("");
    setNotice("");
    try {
      const hasBoundChannels =
        overview.connections.length > 0 ||
        (overview.bindings?.length ?? 0) > 0 ||
        headerBoundChannels.length > 0;
      const payload = hasBoundChannels ? { rebindToLeaderId: "leader-default" } : {};
      const archiveRes = await leaderRequest<{ syncPending?: boolean }>(`leaders/${leader.id}/archive`, payload);
      if (archiveRes.syncPending) {
        pendingNavigatorNoticeByLeaderId.set(
          "leader-default",
          isEn
            ? "Navigator archived and rebind saved to default Navigator; waiting for IM bridge sync retry."
            : "已归档领航员并保存换绑至默认领航员，远程桥接同步待重试确认。",
        );
      }
      emitNavigatorsChanged();
      closeConfigPanel();
      const fallback = await leaderRequest<{ threadId: string }>("leaders/leader-default/open-thread", {});
      if (fallback.threadId) {
        jumpToThread(fallback.threadId);
      }
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : isEn ? "Failed to archive Navigator." : "归档领航员失败。");
    } finally {
      setBusy(false);
    }
  }

  async function handleCopyDiagnostics() {
    await runAction(
      async () => {
        const res = await leaderRequest<{ text: string }>(`leaders/${leader.id}/diagnostics`);
        if (typeof navigator !== "undefined" && typeof navigator.clipboard?.writeText === "function") {
          try {
            await navigator.clipboard.writeText(res.text);
            setDiagnosticsFallback("");
            return isEn ? "Redacted diagnostics copied." : "已复制脱敏诊断信息。";
          } catch {
          }
        }
        setDiagnosticsFallback(res.text);
        return isEn
          ? "Clipboard unavailable; copy the redacted diagnostics below."
          : "当前环境不支持自动复制，请手动选择下方脱敏诊断信息复制。";
      },
      undefined,
      { skipRefresh: true },
    );
  }

  async function handleResetSession() {
    const resetNotice = isEn
      ? "Started a fresh model context. History, memory, todos, and IM bindings remain intact."
      : "已开启全新模型上下文，历史消息、记忆、待办与聊天软件连接均已保留。";
    await runAction(async () => {
      const res = await leaderRequest<{ threadId: string }>(`leaders/${leader.id}/reset-session`, {});
      if (res.threadId) {
        pendingNavigatorNoticeByLeaderId.set(leader.id, resetNotice);
        closeConfigPanel();
        jumpToThread(res.threadId);
      }
      return resetNotice;
    });
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

  const visibleNeedsYouThreads = showAllThreads
    ? overview.needsYou.threads
    : overview.needsYou.threads.slice(0, 8);

  const headerRow = (
    <div
      data-testid="leader-supervisory-bar"
      aria-label={isEn ? "Navigator supervisory header" : "领航员控制栏"}
      className={`@container flex h-full min-w-0 flex-1 items-center justify-between gap-2 ${
        rightPanelOpen ? "pr-10" : "pr-24"
      }`}
    >
      <div
        data-testid="leader-header-identity"
        className="flex min-w-0 flex-1 items-center gap-2 overflow-hidden"
      >
        <NavigatorHeaderAvatar
          key={leader.id}
          overview={overview}
          totalAttention={totalAttention}
          pinnedThread={pinnedThreadSignal}
        />
        <div className="flex min-w-0 flex-1 items-center gap-2 overflow-hidden">
          <span
            data-testid="leader-header-name"
            className="min-w-[36px] truncate text-sm font-semibold leading-none text-foreground"
          >
            {leader.name}
          </span>
          <span
            className={`hidden h-5 shrink-0 items-center gap-1 rounded-full px-2 text-[11px] font-medium leading-none ${
              isPaused
                ? "@[340px]:inline-flex bg-amber-500/15 text-amber-700 dark:text-amber-300"
                : "@[380px]:inline-flex bg-emerald-500/15 text-emerald-700 dark:text-emerald-300"
            }`}
          >
            <span
              className={`size-1.5 rounded-full ${isPaused ? "bg-amber-500" : "bg-emerald-500"}`}
              aria-hidden="true"
            />
            {isPaused ? (isEn ? "Paused" : "已暂停") : isEn ? "Active" : "活跃"}
          </span>
          {headerBoundChannels.map((ch) => (
            <span
              key={ch.platform}
              data-testid={`leader-header-channel-${ch.platform}`}
              data-online={ch.online ? "true" : "false"}
              title={`${ch.label} · ${ch.online ? (isEn ? "Online" : "在线") : isEn ? "Offline" : "离线"}`}
              className="hidden h-5 shrink-0 items-center gap-1.5 rounded-full border border-foreground/10 bg-background/50 px-2 text-[11px] leading-none text-muted-foreground @[520px]:inline-flex"
            >
              <span
                className={
                  ch.online
                    ? "size-1.5 shrink-0 rounded-full bg-emerald-500"
                    : "size-1.5 shrink-0 rounded-[1.5px] bg-rose-500 ring-1 ring-rose-500/40"
                }
                aria-hidden="true"
              />
              {ch.label}
              <span className="sr-only">
                {ch.online ? (isEn ? " online" : " 在线") : isEn ? " offline" : " 离线"}
              </span>
            </span>
          ))}
          {overview.needsYou.runningCount > 0 ? (
            <span className="hidden shrink-0 text-xs leading-none text-muted-foreground @[640px]:inline">
              {isEn ? `${overview.needsYou.runningCount} running` : `${overview.needsYou.runningCount} 项进行中`}
            </span>
          ) : null}
        </div>
      </div>

      <div className="flex shrink-0 items-center gap-1 [-webkit-app-region:no-drag]">
        <Button
          ref={needsYouTriggerRef}
          size="sm"
          variant={totalAttention > 0 ? "default" : "outline"}
          aria-label={`Needs You (${totalAttention})`}
          aria-expanded={expanded}
          aria-controls="leader-needs-you-panel"
          title={`Needs You (${totalAttention})`}
          className={`h-7 min-h-7 px-2 text-xs @[470px]:px-2.5 ${
            expanded && totalAttention === 0 ? "border-primary/60 bg-accent ring-1 ring-primary" : ""
          }`}
          onClick={() => {
            closeConfigPanel();
            setExpanded((value) => {
              if (value) setShowAllThreads(false);
              return !value;
            });
          }}
        >
          {totalAttention > 0 ? (
            <ShieldAlertIcon className="mr-1 size-3.5" aria-hidden="true" />
          ) : (
            <CheckCircle2Icon className="mr-1 size-3.5" aria-hidden="true" />
          )}
          <span className="hidden @[470px]:inline">Needs You ({totalAttention})</span>
          <span className="tabular-nums @[470px]:hidden">{totalAttention}</span>
          {expanded ? (
            <ChevronUpIcon className="ml-1 size-3.5" aria-hidden="true" />
          ) : (
            <ChevronDownIcon className="ml-1 size-3.5" aria-hidden="true" />
          )}
        </Button>
        <Button
          size="sm"
          variant="outline"
          aria-label={isPaused ? (isEn ? "Resume" : "恢复") : isEn ? "Pause" : "暂停"}
          title={isPaused ? (isEn ? "Resume" : "恢复") : isEn ? "Pause" : "暂停"}
          className="h-7 min-h-7 px-2 text-xs @[410px]:px-2.5"
          disabled={busy}
          onClick={() =>
            void runAction(
              async () => {
                await leaderRequest(`leaders/${leader.id}/${isPaused ? "resume" : "pause"}`, {});
              },
              isPaused
                ? isEn
                  ? "Navigator resumed. Review queued messages below to replay or dismiss."
                  : "领航员已恢复接单，可在下方选择重投暂停期间的消息。"
                : isEn
                  ? "Navigator paused. In-flight tasks will finish and /stop remains available."
                  : "领航员已暂停接单，在途任务将继续完成且 /stop 保持可用。",
            )
          }
        >
          {isPaused ? (
            <>
              <PlayIcon className="size-3.5 @[410px]:mr-1" aria-hidden="true" />
              <span className="hidden @[410px]:inline">{isEn ? "Resume" : "恢复"}</span>
            </>
          ) : (
            <>
              <PauseIcon className="size-3.5 @[410px]:mr-1" aria-hidden="true" />
              <span className="hidden @[410px]:inline">{isEn ? "Pause" : "暂停"}</span>
            </>
          )}
        </Button>
        <Button
          ref={manageTriggerRef}
          size="sm"
          variant="outline"
          aria-label={isEn ? "Manage" : "管理"}
          title={isEn ? "Manage" : "管理"}
          aria-expanded={configOpen}
          aria-controls="leader-config-panel"
          className={`h-7 min-h-7 px-2 text-xs @[350px]:px-2.5 ${
            configOpen ? "border-primary/60 bg-accent ring-1 ring-primary" : ""
          }`}
          onClick={() => {
            if (configOpen) {
              closeConfigPanel();
            } else {
              openConfigPanel();
            }
          }}
        >
          <Settings2Icon className="size-3.5 @[350px]:mr-1" aria-hidden="true" />
          <span className="hidden @[350px]:inline">{isEn ? "Manage" : "管理"}</span>
        </Button>
      </div>
    </div>
  );

  const statusBanners =
    notice || error ? (
      <>
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
      </>
    ) : null;

  const activePanel = expanded ? (
    <div
      id="leader-needs-you-panel"
      ref={panelRef}
      data-testid="leader-needs-you-panel"
      style={drawerMaxHeight !== null ? { maxHeight: drawerMaxHeight } : undefined}
      className="max-h-[min(70vh,calc(100vh-220px))] overflow-y-auto space-y-3 rounded-2xl border border-border/80 bg-popover/95 p-4 shadow-lg backdrop-blur-md"
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
          {overview.pausedPending.map((item) => {
            const isBodyExpanded = expandedPausedIds.has(item.id);
            return (
              <div
                key={item.id}
                className="flex flex-wrap items-center justify-between gap-2 rounded-xl border border-border bg-card/70 px-3 py-2 text-xs"
              >
                <div className="min-w-0 flex-1">
                  <div className="font-medium text-foreground">
                    {navigatorChannelLabel(item.platform, lang)} ·{" "}
                    {item.chatName || item.senderName || (isEn ? "Remote message" : "远程消息")}
                  </div>
                  <PausedMessageBody
                    id={item.id}
                    body={item.body}
                    expanded={isBodyExpanded}
                    isEn={isEn}
                    onToggle={() =>
                      setExpandedPausedIds((prev) => {
                        const next = new Set(prev);
                        if (next.has(item.id)) next.delete(item.id);
                        else next.add(item.id);
                        return next;
                      })
                    }
                  />
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
                            : "当前连接或领航员处于暂停/未激活状态，消息仍保留在暂停积压队列中。";
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
            );
          })}
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
            {visibleNeedsYouThreads.map((item) => (
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
            {overview.needsYou.threads.length > 8 ? (
              <button
                type="button"
                data-testid="leader-needs-you-toggle-all"
                onClick={() => setShowAllThreads((prev) => !prev)}
                className="self-start rounded-md px-2 py-1 text-xs font-medium text-primary hover:bg-accent"
              >
                {showAllThreads
                  ? isEn
                    ? "Show fewer"
                    : "收起（仅显示前 8 项）"
                  : isEn
                    ? `Show all ${overview.needsYou.threads.length} tasks`
                    : `显示全部 ${overview.needsYou.threads.length} 项任务`}
              </button>
            ) : null}
          </div>
        )}
      </div>
    </div>
  ) : configOpen ? (
    <div
      id="leader-config-panel"
      ref={panelRef}
      data-testid="leader-config-panel"
      style={drawerMaxHeight !== null ? { maxHeight: drawerMaxHeight } : undefined}
      className="max-h-[min(72vh,calc(100vh-220px))] overflow-y-auto space-y-4 rounded-2xl border border-border/80 bg-popover/95 p-4 shadow-lg backdrop-blur-md"
    >
      <div className="flex items-center justify-between gap-2">
        <h3 className="min-w-0 truncate text-sm font-semibold text-foreground">
          {isEn ? `Navigator settings · ${leader.name}` : `领航员设置 · ${leader.name}`}
        </h3>
        <button
          type="button"
          aria-label={isEn ? "Close Navigator settings" : "关闭领航员设置"}
          onClick={closeConfigPanel}
          className="shrink-0 rounded-md p-1 text-muted-foreground hover:bg-accent hover:text-foreground"
        >
          <XIcon className="size-4" aria-hidden="true" />
        </button>
      </div>

      <form className="min-w-0 space-y-4" onSubmit={(event) => void handleSaveConfig(event)}>
        <label className="grid min-w-0 gap-1 text-xs font-medium text-foreground">
          {isEn ? "Name" : "名字"}
          <Input
            value={draftName}
            onChange={(e) => setDraftName(e.target.value)}
            placeholder={isEn ? "Name this Navigator" : "给领航员起个名字"}
            required
          />
        </label>

        <NavigatorAvatarEditor
          value={draftAvatar}
          leaderId={leader.id}
          usedShapeIds={otherUsedShapeIds}
          lang={lang}
          onChange={setDraftAvatar}
        />

        <div className="min-w-0 space-y-1.5">
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

        <div className="min-w-0 space-y-2 rounded-xl border border-border/70 bg-muted/25 px-3.5 py-3 text-xs">
          <div className="flex min-w-0 flex-wrap items-center justify-between gap-2">
            <div className="min-w-0 flex-1">
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
              className="w-full min-w-0 max-w-full rounded-lg border border-input bg-background px-2.5 py-1.5 text-xs text-foreground sm:w-auto"
            >
              <option value="all_local">{isEn ? "All local tasks" : "全部本机任务"}</option>
              <option value="projects">{isEn ? "Selected folders" : "指定文件夹"}</option>
              <option value="none">{isEn ? "Remote tasks only" : "仅此领航员远程任务"}</option>
            </select>
          </div>
          {draftAwarenessKind === "projects" ? (
            <div data-testid="leader-project-scope-picker" className="space-y-1.5 border-t border-border/60 pt-2">
              <div className="text-[11px] text-muted-foreground">
                {isEn ? "Select folders visible to this Navigator:" : "选择允许此领航员感知状态的文件夹："}
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
          className="min-w-0 space-y-2 rounded-xl border border-border/70 bg-muted/25 px-3.5 py-3 text-xs"
        >
          <div className="flex min-w-0 flex-wrap items-center justify-between gap-2">
            <div className="min-w-0 flex-1">
              <div className="font-medium text-foreground">
                {isEn ? "Bound IM channels" : "已绑定的远程渠道"}
              </div>
              <p className="text-[11px] text-muted-foreground">
                {isEn
                  ? "Rebinding starts a fresh binding epoch for new messages while preserving historical ownership"
                  : "换绑后仅新消息路由至目标领航员，历史任务与暂停积压保留原领航员归属"}
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
          {overview.connections.length === 0 && missingBoundPlatforms.length === 0 ? (
            <p className="text-[11px] text-muted-foreground">
              {isEn ? "No IM channels bound to this Navigator yet." : "当前领航员暂未绑定任何聊天软件连接。"}
            </p>
          ) : (
            <div className="space-y-1.5 pt-1">
              {overview.connections.map((conn, idx) => {
                const connId = conn.id ?? `${conn.platform}-${idx}`;
                const isPairing = conn.lifecycleState === "pairing";
                const online = isConnectionStrictlyOnline(conn);
                const bridgeOwnerMismatch = Boolean(conn.syncPending && conn.leaderId && conn.leaderId !== leader.id);
                return (
                  <div
                    key={connId}
                    className="flex min-w-0 flex-wrap items-center justify-between gap-2 rounded-lg border border-border/70 bg-background/80 px-2.5 py-1.5"
                  >
                    <div className="flex min-w-0 flex-wrap items-center gap-2">
                      <span
                        className={
                          isPairing
                            ? "size-1.5 shrink-0 rounded-full bg-amber-500"
                            : online
                              ? "size-1.5 shrink-0 rounded-full bg-emerald-500"
                              : "size-1.5 shrink-0 rounded-[1.5px] bg-rose-500 ring-1 ring-rose-500/40"
                        }
                        aria-hidden="true"
                      />
                      <span className="font-medium text-foreground">
                        {navigatorChannelLabel(conn.platform, lang)}
                      </span>
                      {conn.botName ? (
                        <span className="truncate text-[11px] text-muted-foreground">{conn.botName}</span>
                      ) : null}
                      {isPairing ? (
                        <span
                          data-testid={`leader-conn-pairing-${connId}`}
                          className="rounded-full bg-amber-500/15 px-1.5 py-0.5 text-[10px] font-medium text-amber-700 dark:text-amber-300"
                        >
                          {isEn ? "Awaiting claim" : "待认领"}
                        </span>
                      ) : !online ? (
                        <span className="rounded-full bg-rose-500/15 px-1.5 py-0.5 text-[10px] font-medium text-rose-700 dark:text-rose-300">
                          {isEn ? "Offline" : "离线"}
                        </span>
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
                            : "桥接同步完成前仍向原领航员投递"}
                        </span>
                      ) : null}
                    </div>
                    {conn.id && !isPairing && allLeaders.length > 1 ? (
                      <label className="flex min-w-0 items-center gap-1.5 text-[11px] text-muted-foreground">
                        <span className="shrink-0">{isEn ? "Assign to" : "换绑至"}</span>
                        <select
                          data-testid={`leader-rebind-select-${conn.id}`}
                          aria-label={isEn ? `Rebind ${conn.platform} connection` : `换绑 ${navigatorChannelLabel(conn.platform, lang)} 连接`}
                          value={conn.desiredLeaderId ?? leader.id}
                          disabled={busy}
                          onChange={(event) => void handleRebindConnection(conn.id!, event.target.value)}
                          className="min-w-0 max-w-full rounded-md border border-input bg-background px-2 py-1 text-[11px] text-foreground"
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
              {missingBoundPlatforms.map((ch) => (
                <div
                  key={`offline-${ch.platform}`}
                  data-testid={`leader-bound-offline-${ch.platform}`}
                  className="flex min-w-0 flex-wrap items-center justify-between gap-2 rounded-lg border border-border/70 bg-background/60 px-2.5 py-1.5"
                >
                  <div className="flex min-w-0 items-center gap-2">
                    <span
                      className="size-1.5 shrink-0 rounded-[1.5px] bg-rose-500 ring-1 ring-rose-500/40"
                      aria-hidden="true"
                    />
                    <span className="font-medium text-foreground">{ch.label}</span>
                    <span className="rounded-full bg-rose-500/15 px-1.5 py-0.5 text-[10px] font-medium text-rose-700 dark:text-rose-300">
                      {isEn ? "Offline / live status unavailable" : "离线 / 实时状态不可用"}
                    </span>
                  </div>
                </div>
              ))}
            </div>
          )}
        </div>

        <div
          data-testid="leader-im-policy-section"
          className="min-w-0 space-y-3 rounded-xl border border-border/70 bg-muted/25 px-3.5 py-3 text-xs"
        >
          <div className="flex min-w-0 items-start gap-2">
            <ShieldCheckIcon className="mt-0.5 size-4 shrink-0 text-primary" aria-hidden="true" />
            <div className="min-w-0 flex-1">
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

          <div className="grid min-w-0 grid-cols-[repeat(auto-fit,minmax(min(100%,240px),1fr))] gap-3">
            <div className="min-w-0 space-y-2 rounded-lg border border-border/70 bg-background/80 p-3">
              <div className="font-medium text-foreground">
                {isEn ? "Owner DM (owner_dm)" : "我的私聊（Owner 私聊）"}
              </div>
              <label className="grid min-w-0 gap-1 text-[11px] text-muted-foreground">
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
                  className="w-full min-w-0 max-w-full rounded-md border border-input bg-background px-2 py-1 text-xs text-foreground"
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
              <label className="grid min-w-0 gap-1 text-[11px] text-muted-foreground">
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
                  className="w-full min-w-0 max-w-full rounded-md border border-input bg-background px-2 py-1 text-xs text-foreground"
                >
                  <option value="completion_and_blocked">{isEn ? "Completion & blocked only (Default)" : "仅回报完成与阻塞（默认）"}</option>
                  <option value="phase_summary">{isEn ? "Live phase summaries" : "实时回报阶段进展"}</option>
                  <option value="silent">{isEn ? "Final reply only (Silent)" : "静默（仅发送最终结果）"}</option>
                </select>
              </label>
            </div>

            <div className="min-w-0 space-y-2 rounded-lg border border-border/70 bg-background/80 p-3">
              <div className="font-medium text-foreground">
                {isEn ? "Group chats (group)" : "群聊（受限受众）"}
              </div>
              <label className="grid min-w-0 gap-1 text-[11px] text-muted-foreground">
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
                  className="w-full min-w-0 max-w-full rounded-md border border-input bg-background px-2 py-1 text-xs text-foreground"
                >
                  <option value="always_ask">{isEn ? "Always ask on desktop (Default)" : "每次询问桌面确认（默认）"}</option>
                  <option value="deny">{isEn ? "Deny cross-thread delegation" : "禁止跨对话委派"}</option>
                </select>
              </label>
              <label className="grid min-w-0 gap-1 text-[11px] text-muted-foreground">
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
                  className="w-full min-w-0 max-w-full rounded-md border border-input bg-background px-2 py-1 text-xs text-foreground"
                >
                  <option value="completion_and_blocked">{isEn ? "Completion & blocked only (Default)" : "仅回报完成与阻塞（默认）"}</option>
                  <option value="phase_summary">{isEn ? "Live phase summaries" : "实时回报阶段进展"}</option>
                  <option value="silent">{isEn ? "Final reply only (Silent)" : "静默（仅发送最终结果）"}</option>
                </select>
              </label>
            </div>
          </div>
        </div>

        {diagnosticsFallback ? (
          <div
            data-testid="leader-diagnostics-fallback-box"
            className="space-y-1.5 rounded-xl border border-border bg-muted/30 p-3 text-xs"
          >
            <div className="flex items-center justify-between gap-2">
              <span className="font-medium text-foreground">
                {isEn ? "Redacted diagnostics (select and copy)" : "脱敏诊断信息（请全选手动复制）"}
              </span>
              <button
                type="button"
                onClick={() => setDiagnosticsFallback("")}
                className="text-[11px] text-muted-foreground hover:text-foreground"
              >
                {isEn ? "Dismiss" : "关闭"}
              </button>
            </div>
            <textarea
              data-testid="leader-diagnostics-fallback"
              readOnly
              rows={4}
              value={diagnosticsFallback}
              onFocus={(event) => event.currentTarget.select()}
              className="w-full rounded-lg border border-input bg-background p-2 font-mono text-[11px] text-foreground"
            />
          </div>
        ) : null}

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
          </div>
          <Button type="submit" size="sm" disabled={busy || !draftName.trim()}>
            {busy ? <Loader2Icon className="mr-1 size-3.5 animate-spin" aria-hidden="true" /> : null}
            {isEn ? "Save settings" : "保存设置"}
          </Button>
        </div>

        {!isDefaultNavigator ? (
          <div
            data-testid="leader-danger-zone"
            className="space-y-2 border-t border-destructive/25 pt-3 text-xs"
          >
            <div className="flex flex-wrap items-center justify-between gap-2">
              <div className="min-w-0 flex-1">
                <div className="font-medium text-destructive">
                  {isEn ? "Danger zone" : "危险操作"}
                </div>
                <p className="text-[11px] text-muted-foreground">
                  {overview.pausedPending.length > 0
                    ? isEn
                      ? "Resolve queued paused messages in Needs You before archiving."
                      : "请先在 Needs You 中处理暂停积压消息后再归档。"
                    : isEn
                      ? "Archiving stops this Navigator from accepting new work; historical threads stay readable."
                      : "归档后该领航员不再接单，历史消息仍保留可查。"}
                </p>
              </div>
              {!confirmingArchive ? (
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
                  onClick={() => setConfirmingArchive(true)}
                  className="border-destructive/40 text-destructive hover:bg-destructive/10"
                >
                  <ArchiveIcon className="mr-1 size-3.5" aria-hidden="true" />
                  {isEn ? "Archive Navigator" : "归档领航员"}
                </Button>
              ) : null}
            </div>

            {confirmingArchive ? (
              <div
                data-testid="leader-archive-confirm-box"
                className="space-y-2 rounded-xl border border-destructive/35 bg-destructive/5 p-3"
              >
                <p className="text-xs text-foreground">
                  {archiveAffectedChannels.length > 0
                    ? isEn
                      ? `Confirm archiving "${leader.name}"? Bound channels (${archiveAffectedChannels.join(", ")}) will be handed over to "${defaultLeaderName}" for new messages.`
                      : `确认归档「${leader.name}」？已绑定的渠道（${archiveAffectedChannels.join("、")}）将立即换绑并移交给默认领航员「${defaultLeaderName}」承接新消息。`
                    : isEn
                      ? `Confirm archiving "${leader.name}"? It will no longer appear in the active Navigator list.`
                      : `确认归档「${leader.name}」？归档后将从活跃领航员列表中移除。`}
                </p>
                <div className="flex flex-wrap items-center justify-end gap-2">
                  <Button
                    type="button"
                    size="sm"
                    variant="outline"
                    data-testid="leader-archive-cancel"
                    disabled={busy}
                    onClick={() => setConfirmingArchive(false)}
                  >
                    {isEn ? "Cancel" : "取消"}
                  </Button>
                  <Button
                    type="button"
                    size="sm"
                    variant="destructive"
                    data-testid="leader-archive-confirm"
                    disabled={busy || overview.pausedPending.length > 0}
                    onClick={() => void handleArchiveNavigator()}
                  >
                    {isEn ? "Confirm archive" : "确认归档"}
                  </Button>
                </div>
              </div>
            ) : null}
          </div>
        ) : null}
      </form>
    </div>
  ) : null;

  const hasDrawer = expanded || configOpen;

  const drawersContent =
    renderHeader ? (
      hasDrawer ? (
        <div className="relative z-30 h-0 shrink-0">
          <div className="absolute inset-x-3 top-0 z-30 sm:inset-x-5">
            {statusBanners}
            {activePanel}
          </div>
        </div>
      ) : statusBanners ? (
        <div className="shrink-0 px-3 pb-1.5 sm:px-5">{statusBanners}</div>
      ) : null
    ) : statusBanners || activePanel ? (
      <div className="mt-2">
        {statusBanners}
        {activePanel}
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
