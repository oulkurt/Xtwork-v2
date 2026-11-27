import { useEffect, useMemo, useRef, useState, type FormEvent } from "react";
import { useNavigate, useRouterState } from "@tanstack/react-router";
import { DicesIcon, EllipsisIcon, Link2Icon, PauseCircleIcon, PlusIcon, RotateCwIcon, XIcon } from "lucide-react";
import type { EnvironmentId } from "@t3tools/contracts";
import { useQuietThreadShells } from "../../state/entities";
import { usePrimaryEnvironmentId } from "../../state/environments";
import {
  LEADER_ROLE_TEMPLATES,
  emitNavigatorsChanged,
  leaderRequest,
  useNavigatorLang,
  type LeaderListItem,
  type NavigatorLang,
} from "./leaderTypes";
import {
  extractPinnedThreadSignal,
  isLightAvatarBodyColor,
  parseNavigatorAvatar,
  pickRandomNavigatorAvatar,
  resolveNavigatorBoundChannels,
  type NavigatorThreadSignal,
  type NavigatorWorkSignals,
} from "./navigatorAvatarModel";
import { NavigatorBotAvatar, useNavigatorAvatarPresentation } from "./NavigatorBotAvatar";

export interface LeaderSidebarSlotProps {
  readonly onOpenThread?: (environmentId: EnvironmentId, threadId: string) => void;
  readonly onPinnedThreadIdsChange?: (ids: ReadonlySet<string>) => void;
}

interface LeaderSidebarRowProps {
  readonly item: LeaderListItem;
  readonly pinnedThread: NavigatorThreadSignal | null;
  readonly isActiveRoute: boolean;
  readonly disabled: boolean;
  readonly lang: NavigatorLang;
  readonly onOpen: (leaderId: string) => void;
}

function LeaderSidebarRow({
  item,
  pinnedThread,
  isActiveRoute,
  disabled,
  lang,
  onOpen,
}: LeaderSidebarRowProps) {
  const isPaused = item.leader.status === "paused";
  const isEn = lang === "en";
  const resolvedAvatar = useMemo(
    () => parseNavigatorAvatar(item.leader.avatar, item.leader.id),
    [item.leader.avatar, item.leader.id],
  );
  const lightBody = isLightAvatarBodyColor(resolvedAvatar.color);
  const boundChannels = useMemo(
    () =>
      resolveNavigatorBoundChannels({
        connections: item.connections,
        boundPlatforms: item.boundPlatforms,
        bindings: item.bindings,
        lang,
      }),
    [item.connections, item.boundPlatforms, item.bindings, lang],
  );
  const awarenessScopeKey = useMemo(
    () => JSON.stringify(item.leader.awarenessScope),
    [item.leader.awarenessScope],
  );
  const signals = useMemo<NavigatorWorkSignals>(
    () => ({
      leaderStatus: item.leader.status,
      pinnedThread,
      runningCount: item.runningCount,
      startingCount: item.startingCount,
      waitingCount: item.waitingCount,
      failedCount: item.failedCount,
      pendingApprovalCount: item.pendingApprovalCount,
      pausedPendingCount: item.pausedPendingCount,
      needsYouCount: item.needsYouCount,
      latestCompletedKey: item.latestCompletedKey,
      latestCompletedAtMs: item.latestCompletedAtMs,
      awarenessScopeKey,
    }),
    [item, pinnedThread, awarenessScopeKey],
  );
  const presentation = useNavigatorAvatarPresentation(signals);

  return (
    <button
      type="button"
      data-testid={`leader-slot-${item.leader.id}`}
      disabled={disabled}
      onClick={() => onOpen(item.leader.id)}
      className={`group flex w-full items-center gap-2.5 rounded-xl px-2 py-2 text-left transition-colors outline-none focus-visible:ring-2 focus-visible:ring-ring disabled:opacity-60 ${
        isActiveRoute
          ? "bg-sidebar-accent text-sidebar-accent-foreground"
          : "text-sidebar-foreground hover:bg-sidebar-row-hover"
      }`}
    >
      <span
        className={`relative flex size-8 shrink-0 items-center justify-center rounded-lg border border-sidebar-border/50 shadow-2xs ${
          lightBody ? "bg-foreground/[0.08] dark:bg-white/10" : "bg-background/85"
        }`}
      >
        <NavigatorBotAvatar
          avatar={item.leader.avatar}
          leaderId={item.leader.id}
          state={presentation.state}
          mood={presentation.mood}
          size={28}
          testId={`leader-avatar-${item.leader.id}`}
        />
      </span>

      <span className="min-w-0 flex-1">
        <span className="flex items-center gap-1.5">
          <span className="truncate text-[13px] font-medium leading-tight">
            {item.leader.name}
          </span>
          {isPaused ? (
            <PauseCircleIcon className="size-3.5 shrink-0 text-amber-500" aria-hidden="true" />
          ) : null}
        </span>
        {boundChannels.length > 0 ? (
          <span
            data-testid={`leader-channels-${item.leader.id}`}
            className="mt-0.5 flex flex-wrap items-center gap-x-2 gap-y-0.5 text-[11px] leading-tight text-sidebar-muted-foreground"
          >
            {boundChannels.map((ch) => (
              <span
                key={ch.platform}
                data-testid={`leader-channel-${item.leader.id}-${ch.platform}`}
                data-online={ch.online ? "true" : "false"}
                title={`${ch.label} · ${ch.online ? (isEn ? "Online" : "在线") : isEn ? "Offline" : "离线"}`}
                className="inline-flex items-center gap-1 truncate"
              >
                <span
                  data-testid={`leader-channel-dot-${item.leader.id}-${ch.platform}`}
                  className={
                    ch.online
                      ? "size-1.5 shrink-0 rounded-full bg-emerald-500"
                      : "size-1.5 shrink-0 rounded-[1.5px] bg-rose-500 ring-1 ring-rose-500/40"
                  }
                  aria-hidden="true"
                />
                <span className="truncate">{ch.label}</span>
                <span className="sr-only">
                  {ch.online ? (isEn ? " online" : " 在线") : isEn ? " offline" : " 离线"}
                </span>
              </span>
            ))}
          </span>
        ) : null}
      </span>

      {item.needsYouCount > 0 ? (
        <>
          <span
            data-testid={`leader-needs-you-badge-${item.leader.id}`}
            title={isEn ? `${item.needsYouCount} items need you` : `${item.needsYouCount} 项待处理`}
            aria-hidden="true"
            className="inline-flex h-5 min-w-5 shrink-0 items-center justify-center rounded-md bg-sidebar-border/65 px-1.5 text-[11px] font-semibold tabular-nums text-sidebar-foreground"
          >
            {item.needsYouCount}
          </span>
          <span className="sr-only">
            {isEn ? `${item.needsYouCount} items need you` : `${item.needsYouCount} 项待处理`}
          </span>
        </>
      ) : null}
    </button>
  );
}

export function LeaderSidebarSlot({ onOpenThread, onPinnedThreadIdsChange }: LeaderSidebarSlotProps) {
  const desktop = typeof window !== "undefined" && Boolean(window.desktopBridge);
  const lang = useNavigatorLang();
  const isEn = lang === "en";
  const primaryEnvironmentId = usePrimaryEnvironmentId();
  const threadShells = useQuietThreadShells();
  const navigate = useNavigate();
  const pathname = useRouterState({ select: (state) => state.location.pathname });
  const [leaders, setLeaders] = useState<readonly LeaderListItem[]>([]);
  const [loadError, setLoadError] = useState("");
  const [openError, setOpenError] = useState("");
  const [openingId, setOpeningId] = useState<string | null>(null);
  const [creating, setCreating] = useState(false);
  const [menuOpen, setMenuOpen] = useState(false);
  const [newName, setNewName] = useState("");
  const [newAvatar, setNewAvatar] = useState(() => pickRandomNavigatorAvatar().encoded);
  const [newRole, setNewRole] = useState("");
  const [selectedTemplateId, setSelectedTemplateId] = useState<string | null>(null);
  const [submitting, setSubmitting] = useState(false);
  const [createError, setCreateError] = useState("");
  const lastPinnedKeyRef = useRef("");
  const menuContainerRef = useRef<HTMLDivElement>(null);
  const moreTriggerRef = useRef<HTMLButtonElement>(null);
  const menuItemRefs = useRef<Array<HTMLButtonElement | null>>([]);
  const createSubmitEpochRef = useRef(0);
  const fetchNowRef = useRef<(() => void) | null>(null);

  const threadShellById = useMemo(() => {
    const map = new Map<string, NavigatorThreadSignal>();
    for (const shell of threadShells) {
      map.set(shell.id, extractPinnedThreadSignal(shell));
    }
    return map;
  }, [threadShells]);

  const usedShapeIds = useMemo(
    () => leaders.map((item) => parseNavigatorAvatar(item.leader.avatar, item.leader.id).shapeId),
    [leaders],
  );

  const createAvatarLight = isLightAvatarBodyColor(parseNavigatorAvatar(newAvatar).color);

  const notifyPinnedIds = (items: readonly LeaderListItem[]) => {
    if (!onPinnedThreadIdsChange) return;
    const ids = items
      .map((item) => item.leader.pinnedThreadId)
      .filter((id): id is string => typeof id === "string" && id.length > 0)
      .sort();
    const key = ids.join("\0");
    if (key === lastPinnedKeyRef.current) return;
    lastPinnedKeyRef.current = key;
    onPinnedThreadIdsChange(new Set(ids));
  };

  useEffect(() => {
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
        void runFetch();
      }, 3000);
    };

    const runFetch = async () => {
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
        const res = await leaderRequest<{ leaders?: LeaderListItem[] }>("leaders", undefined, controller.signal);
        if (!controller.signal.aborted && Array.isArray(res.leaders)) {
          setLeaders(res.leaders);
          notifyPinnedIds(res.leaders);
          setLoadError("");
        }
      } catch (cause) {
        if (!controller.signal.aborted) {
          setLoadError(
            cause instanceof Error
              ? cause.message
              : isEn
                ? "Failed to load Navigators."
                : "加载领航员列表失败。",
          );
        }
      } finally {
        inFlight = false;
        if (!controller.signal.aborted) {
          if (rerunRequested) {
            rerunRequested = false;
            void runFetch();
          } else {
            scheduleNext();
          }
        }
      }
    };

    const onChanged = () => {
      void runFetch();
    };
    const onVisibility = () => {
      if (isHidden()) {
        if (timer !== undefined) {
          clearTimeout(timer);
          timer = undefined;
        }
      } else {
        void runFetch();
      }
    };
    fetchNowRef.current = () => {
      void runFetch();
    };
    window.addEventListener("xtwork:leaders-changed", onChanged);
    document.addEventListener("visibilitychange", onVisibility);
    void runFetch();
    return () => {
      fetchNowRef.current = null;
      window.removeEventListener("xtwork:leaders-changed", onChanged);
      document.removeEventListener("visibilitychange", onVisibility);
      controller.abort();
      if (timer !== undefined) clearTimeout(timer);
    };
  }, [desktop, isEn]);

  useEffect(() => {
    if (!menuOpen) return;
    menuItemRefs.current[0]?.focus();
    const handlePointerDown = (event: PointerEvent) => {
      if (menuContainerRef.current && !menuContainerRef.current.contains(event.target as Node)) {
        setMenuOpen(false);
      }
    };
    const handleKeyDown = (event: KeyboardEvent) => {
      if (event.key === "Escape") {
        event.preventDefault();
        setMenuOpen(false);
        moreTriggerRef.current?.focus();
      } else if (event.key === "ArrowDown" || event.key === "ArrowUp") {
        const items = menuItemRefs.current.filter((el): el is HTMLButtonElement => el !== null);
        if (items.length === 0) return;
        event.preventDefault();
        const currentIndex = items.findIndex((el) => el === document.activeElement);
        const delta = event.key === "ArrowDown" ? 1 : -1;
        const nextIndex = currentIndex < 0 ? 0 : (currentIndex + delta + items.length) % items.length;
        items[nextIndex]?.focus();
      }
    };
    document.addEventListener("pointerdown", handlePointerDown);
    document.addEventListener("keydown", handleKeyDown);
    return () => {
      document.removeEventListener("pointerdown", handlePointerDown);
      document.removeEventListener("keydown", handleKeyDown);
    };
  }, [menuOpen]);

  if (!desktop || (leaders.length === 0 && !loadError && !creating)) return null;

  function openCreateForm() {
    createSubmitEpochRef.current += 1;
    const picked = pickRandomNavigatorAvatar({ usedShapeIds });
    setNewName("");
    setNewRole("");
    setSelectedTemplateId(null);
    setNewAvatar(picked.encoded);
    setCreateError("");
    setSubmitting(false);
    setCreating(true);
  }

  function closeCreateForm() {
    createSubmitEpochRef.current += 1;
    setCreating(false);
    setSubmitting(false);
    setNewName("");
    setNewRole("");
    setSelectedTemplateId(null);
    setCreateError("");
  }

  function randomizeCreateAvatar() {
    const current = parseNavigatorAvatar(newAvatar);
    const picked = pickRandomNavigatorAvatar({
      currentShapeId: current.shapeId,
      currentColor: current.color,
      usedShapeIds,
    });
    setNewAvatar(picked.encoded);
  }

  async function openLeaderById(leaderId: string) {
    if (openingId) return;
    setOpeningId(leaderId);
    setOpenError("");
    try {
      const res = await leaderRequest<{ threadId: string }>(`leaders/${leaderId}/open-thread`, {});
      if (res.threadId && primaryEnvironmentId) {
        setLeaders((prev) => {
          const next = prev.map((entry) =>
            entry.leader.id === leaderId
              ? { ...entry, leader: { ...entry.leader, pinnedThreadId: res.threadId } }
              : entry,
          );
          notifyPinnedIds(next);
          return next;
        });
        if (onOpenThread) {
          onOpenThread(primaryEnvironmentId, res.threadId);
        } else {
          void navigate({
            to: "/$environmentId/$threadId",
            params: { environmentId: primaryEnvironmentId, threadId: res.threadId },
          });
        }
      }
    } catch (cause) {
      setOpenError(
        cause instanceof Error
          ? cause.message
          : isEn
            ? "Failed to open Navigator thread."
            : "打开领航员对话失败。",
      );
    } finally {
      setOpeningId(null);
    }
  }

  async function handleCreateSubmit(event: FormEvent) {
    event.preventDefault();
    const trimmed = newName.trim();
    if (!trimmed || submitting) return;
    const submitEpoch = createSubmitEpochRef.current;
    setSubmitting(true);
    setCreateError("");
    setOpenError("");
    let createdId: string | undefined;
    try {
      const created = await leaderRequest<{ leader: { id: string } }>("leaders", {
        name: trimmed,
        ...(newAvatar.trim() ? { avatar: newAvatar.trim() } : {}),
        ...(newRole.trim() ? { role: newRole.trim() } : {}),
      });
      createdId = created.leader?.id;
    } catch (cause) {
      if (createSubmitEpochRef.current === submitEpoch) {
        setCreateError(
          cause instanceof Error
            ? cause.message
            : isEn
              ? "Failed to create Navigator."
              : "创建领航员失败。",
        );
        setSubmitting(false);
      }
      return;
    }

    const ownsDraft = createSubmitEpochRef.current === submitEpoch;
    if (ownsDraft) {
      setNewName("");
      setNewAvatar(pickRandomNavigatorAvatar({ usedShapeIds }).encoded);
      setNewRole("");
      setSelectedTemplateId(null);
      setCreateError("");
      setCreating(false);
    }
    emitNavigatorsChanged();

    try {
      const listRes = await leaderRequest<{ leaders?: LeaderListItem[] }>("leaders");
      if (Array.isArray(listRes.leaders)) {
        setLeaders(listRes.leaders);
        notifyPinnedIds(listRes.leaders);
        setLoadError("");
      }
    } catch (refreshCause) {
      setLoadError(
        isEn
          ? `Navigator created, but refreshing the list failed: ${refreshCause instanceof Error ? refreshCause.message : "unknown error"}`
          : `领航员已创建，但刷新列表失败：${refreshCause instanceof Error ? refreshCause.message : "未知错误"}`,
      );
    } finally {
      if (createSubmitEpochRef.current === submitEpoch) {
        setSubmitting(false);
      }
    }

    if (createdId && createSubmitEpochRef.current === submitEpoch) {
      await openLeaderById(createdId);
    }
  }

  return (
    <div
      data-testid="leader-sidebar-slot"
      className="mb-2.5 flex flex-col gap-1.5 border-b border-sidebar-border/45 pb-3"
      aria-label={isEn ? "Navigators" : "领航员"}
    >
      <div className="relative flex items-center justify-between gap-1 px-1" ref={menuContainerRef}>
        <span
          data-testid="sidebar-navigators-heading"
          className="text-[13px] font-semibold tracking-tight text-sidebar-foreground/90"
        >
          {isEn ? "Navigators" : "领航员"}
        </span>
        <div className="flex shrink-0 items-center gap-0.5">
          <button
            type="button"
            data-testid="leader-create-trigger"
            aria-label={
              creating
                ? isEn
                  ? "Close new Navigator form"
                  : "关闭新建领航员"
                : isEn
                  ? "New Navigator"
                  : "新建领航员"
            }
            aria-expanded={creating}
            aria-controls="leader-create-form"
            title={
              creating
                ? isEn
                  ? "Close new Navigator form"
                  : "关闭新建领航员"
                : isEn
                  ? "New Navigator"
                  : "新建领航员"
            }
            onClick={() => {
              setMenuOpen(false);
              if (creating) {
                closeCreateForm();
              } else {
                openCreateForm();
              }
            }}
            className="inline-flex size-7 items-center justify-center rounded-md text-sidebar-muted-foreground transition-colors hover:bg-sidebar-row-hover hover:text-sidebar-foreground focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring"
          >
            {creating ? <XIcon className="size-3.5" aria-hidden="true" /> : <PlusIcon className="size-4" aria-hidden="true" />}
          </button>
          <button
            ref={moreTriggerRef}
            type="button"
            data-testid="leader-more-trigger"
            aria-label={isEn ? "Navigator options" : "领航员选项"}
            aria-expanded={menuOpen}
            aria-controls="leader-more-menu"
            title={isEn ? "Navigator options" : "领航员选项"}
            onClick={() => setMenuOpen((prev) => !prev)}
            className="inline-flex size-7 items-center justify-center rounded-md text-sidebar-muted-foreground transition-colors hover:bg-sidebar-row-hover hover:text-sidebar-foreground focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring"
          >
            <EllipsisIcon className="size-4" aria-hidden="true" />
          </button>
        </div>

        {menuOpen ? (
          <div
            id="leader-more-menu"
            role="menu"
            data-testid="leader-more-menu"
            className="absolute top-8 right-0 z-30 w-44 rounded-xl border border-border bg-popover p-1 text-popover-foreground shadow-md"
          >
            <button
              ref={(el) => {
                menuItemRefs.current[0] = el;
              }}
              type="button"
              role="menuitem"
              onClick={() => {
                setMenuOpen(false);
                openCreateForm();
              }}
              className="flex w-full items-center gap-2 rounded-lg px-2.5 py-1.5 text-left text-xs transition-colors hover:bg-accent focus-visible:bg-accent focus-visible:outline-none"
            >
              <PlusIcon className="size-3.5 text-muted-foreground" aria-hidden="true" />
              {isEn ? "New Navigator" : "新建领航员"}
            </button>
            <button
              ref={(el) => {
                menuItemRefs.current[1] = el;
              }}
              type="button"
              role="menuitem"
              onClick={() => {
                setMenuOpen(false);
                void navigate({ to: "/settings/remote-connections" });
              }}
              className="flex w-full items-center gap-2 rounded-lg px-2.5 py-1.5 text-left text-xs transition-colors hover:bg-accent focus-visible:bg-accent focus-visible:outline-none"
            >
              <Link2Icon className="size-3.5 text-muted-foreground" aria-hidden="true" />
              {isEn ? "Remote connections" : "管理远程连接"}
            </button>
          </div>
        ) : null}
      </div>

      {loadError ? (
        <div
          data-testid="leader-sidebar-error"
          role="alert"
          className="flex items-center justify-between gap-2 rounded-lg border border-destructive/30 bg-destructive/5 px-2 py-1.5 text-[11px] text-destructive"
        >
          <span className="min-w-0 flex-1 break-words">{loadError}</span>
          <button
            type="button"
            data-testid="leader-sidebar-retry"
            onClick={() => fetchNowRef.current?.()}
            className="inline-flex shrink-0 items-center gap-1 rounded px-1.5 py-0.5 font-medium hover:bg-destructive/10"
          >
            <RotateCwIcon className="size-3" aria-hidden="true" />
            {isEn ? "Retry" : "重试"}
          </button>
        </div>
      ) : null}

      {openError ? (
        <p data-testid="leader-sidebar-open-error" role="alert" className="px-1 text-[11px] text-destructive">
          {openError}
        </p>
      ) : null}

      {creating ? (
        <form
          id="leader-create-form"
          data-testid="leader-create-form"
          onKeyDown={(event) => {
            if (event.key === "Escape") {
              event.preventDefault();
              closeCreateForm();
            }
          }}
          onSubmit={(event) => void handleCreateSubmit(event)}
          className="space-y-2 rounded-xl border border-sidebar-border/80 bg-background/85 p-2.5 shadow-xs"
        >
          <div className="flex items-center gap-1.5">
            <span
              className={`flex size-8 shrink-0 items-center justify-center rounded-lg border border-border/70 shadow-2xs ${
                createAvatarLight ? "bg-foreground/[0.08] dark:bg-white/10" : "bg-background"
              }`}
            >
              <NavigatorBotAvatar
                avatar={newAvatar}
                size={26}
                testId="leader-create-avatar-preview"
              />
            </span>
            <input
              type="text"
              data-testid="leader-create-name"
              value={newName}
              onChange={(event) => setNewName(event.target.value)}
              placeholder={isEn ? "Navigator name" : "领航员名字"}
              aria-label={isEn ? "Navigator name" : "领航员名字"}
              autoFocus
              required
              className="h-8 min-w-0 flex-1 rounded-md border border-input bg-background px-2 text-xs text-foreground outline-none focus-visible:ring-2 focus-visible:ring-ring"
            />
            <button
              type="button"
              data-testid="leader-create-avatar-randomize"
              aria-label={isEn ? "Randomize avatar" : "随机生成头像"}
              title={isEn ? "Randomize avatar" : "随机生成头像"}
              onClick={randomizeCreateAvatar}
              className="inline-flex size-8 shrink-0 items-center justify-center rounded-md border border-input bg-background text-muted-foreground transition-colors hover:bg-accent hover:text-foreground focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring"
            >
              <DicesIcon className="size-3.5" aria-hidden="true" />
            </button>
          </div>
          <div className="flex flex-wrap gap-1">
            {LEADER_ROLE_TEMPLATES.slice(0, 3).map((tpl) => {
              const selected = selectedTemplateId === tpl.id;
              return (
                <button
                  key={tpl.id}
                  type="button"
                  data-testid={`leader-create-template-${tpl.id}`}
                  aria-pressed={selected}
                  onClick={() => {
                    if (selected) {
                      setSelectedTemplateId(null);
                      setNewRole("");
                    } else {
                      setSelectedTemplateId(tpl.id);
                      setNewRole(isEn ? tpl.promptEn : tpl.prompt);
                    }
                  }}
                  className={`rounded-full border px-2 py-0.5 text-[10px] transition-colors ${
                    selected
                      ? "border-primary bg-primary/10 font-medium text-foreground"
                      : "border-border/80 bg-muted/40 text-muted-foreground hover:bg-accent hover:text-foreground"
                  }`}
                >
                  {isEn ? tpl.labelEn : tpl.label}
                </button>
              );
            })}
          </div>
          {newRole ? (
            <div className="flex items-center justify-between gap-1 rounded-md bg-muted/40 px-2 py-1 text-[10px] text-muted-foreground">
              <span className="min-w-0 flex-1 truncate">{newRole}</span>
              <button
                type="button"
                data-testid="leader-create-role-clear"
                onClick={() => {
                  setSelectedTemplateId(null);
                  setNewRole("");
                }}
                className="shrink-0 text-foreground/70 hover:text-foreground"
              >
                {isEn ? "Clear" : "清除"}
              </button>
            </div>
          ) : null}
          {createError ? (
            <p className="text-[11px] text-destructive" role="alert">
              {createError}
            </p>
          ) : null}
          <div className="flex items-center justify-end gap-1.5">
            <button
              type="button"
              onClick={closeCreateForm}
              className="h-6 rounded-md px-2 text-[11px] text-muted-foreground hover:bg-accent hover:text-foreground"
            >
              {isEn ? "Cancel" : "取消"}
            </button>
            <button
              type="submit"
              disabled={submitting || !newName.trim()}
              className="h-6 rounded-md bg-primary px-2.5 text-[11px] font-medium text-primary-foreground transition-opacity disabled:opacity-50"
            >
              {isEn ? "Create" : "创建"}
            </button>
          </div>
        </form>
      ) : null}

      <div className="flex max-h-[36vh] flex-col gap-1 overflow-y-auto">
        {leaders.map((item) => {
          const isActiveRoute =
            Boolean(item.leader.pinnedThreadId) && pathname.includes(item.leader.pinnedThreadId!);
          const pinnedThread = item.leader.pinnedThreadId
            ? (threadShellById.get(item.leader.pinnedThreadId) ?? null)
            : null;
          return (
            <LeaderSidebarRow
              key={item.leader.id}
              item={item}
              pinnedThread={pinnedThread}
              isActiveRoute={isActiveRoute}
              disabled={openingId !== null}
              lang={lang}
              onOpen={(id) => void openLeaderById(id)}
            />
          );
        })}
      </div>
    </div>
  );
}
