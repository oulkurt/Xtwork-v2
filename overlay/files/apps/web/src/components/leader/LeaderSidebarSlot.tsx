import { useEffect, useRef, useState, type FormEvent } from "react";
import { useNavigate, useRouterState } from "@tanstack/react-router";
import { EllipsisIcon, Link2Icon, PauseCircleIcon, PlusIcon, XIcon } from "lucide-react";
import type { EnvironmentId } from "@t3tools/contracts";
import { usePrimaryEnvironmentId } from "../../state/environments";
import {
  LEADER_ROLE_TEMPLATES,
  emitNavigatorsChanged,
  leaderRequest,
  navigatorChannelLabel,
  useNavigatorLang,
  type LeaderListItem,
} from "./leaderTypes";

export interface LeaderSidebarSlotProps {
  readonly onOpenThread?: (environmentId: EnvironmentId, threadId: string) => void;
  readonly onPinnedThreadIdsChange?: (ids: ReadonlySet<string>) => void;
}

export function LeaderSidebarSlot({ onOpenThread, onPinnedThreadIdsChange }: LeaderSidebarSlotProps) {
  const desktop = typeof window !== "undefined" && Boolean(window.desktopBridge);
  const lang = useNavigatorLang();
  const isEn = lang === "en";
  const primaryEnvironmentId = usePrimaryEnvironmentId();
  const navigate = useNavigate();
  const pathname = useRouterState({ select: (state) => state.location.pathname });
  const [leaders, setLeaders] = useState<readonly LeaderListItem[]>([]);
  const [openingId, setOpeningId] = useState<string | null>(null);
  const [creating, setCreating] = useState(false);
  const [menuOpen, setMenuOpen] = useState(false);
  const [newName, setNewName] = useState("");
  const [newAvatar, setNewAvatar] = useState("");
  const [newRole, setNewRole] = useState("");
  const [submitting, setSubmitting] = useState(false);
  const [createError, setCreateError] = useState("");
  const lastPinnedKeyRef = useRef("");
  const menuContainerRef = useRef<HTMLDivElement>(null);

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
    let timer: ReturnType<typeof setTimeout>;
    const fetchLeaders = async () => {
      try {
        const res = await leaderRequest<{ leaders?: LeaderListItem[] }>("leaders", undefined, controller.signal);
        if (!controller.signal.aborted && Array.isArray(res.leaders)) {
          setLeaders(res.leaders);
          notifyPinnedIds(res.leaders);
        }
      } catch {
      }
    };
    const poll = async () => {
      await fetchLeaders();
      if (!controller.signal.aborted) {
        timer = setTimeout(() => void poll(), 3000);
      }
    };
    const onChanged = () => {
      void fetchLeaders();
    };
    window.addEventListener("xtwork:leaders-changed", onChanged);
    void poll();
    return () => {
      window.removeEventListener("xtwork:leaders-changed", onChanged);
      controller.abort();
      clearTimeout(timer);
    };
  }, [desktop]);

  useEffect(() => {
    if (!menuOpen) return;
    const handlePointerDown = (event: PointerEvent) => {
      if (menuContainerRef.current && !menuContainerRef.current.contains(event.target as Node)) {
        setMenuOpen(false);
      }
    };
    document.addEventListener("pointerdown", handlePointerDown);
    return () => document.removeEventListener("pointerdown", handlePointerDown);
  }, [menuOpen]);

  if (!desktop || leaders.length === 0) return null;

  async function openLeaderById(leaderId: string) {
    if (openingId) return;
    setOpeningId(leaderId);
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
    } catch {
    } finally {
      setOpeningId(null);
    }
  }

  async function handleCreateSubmit(event: FormEvent) {
    event.preventDefault();
    const trimmed = newName.trim();
    if (!trimmed || submitting) return;
    setSubmitting(true);
    setCreateError("");
    try {
      const created = await leaderRequest<{ leader: { id: string } }>("leaders", {
        name: trimmed,
        ...(newAvatar.trim() ? { avatar: newAvatar.trim() } : {}),
        ...(newRole.trim() ? { role: newRole.trim() } : {}),
      });
      const listRes = await leaderRequest<{ leaders?: LeaderListItem[] }>("leaders");
      if (Array.isArray(listRes.leaders)) {
        setLeaders(listRes.leaders);
        notifyPinnedIds(listRes.leaders);
      }
      setNewName("");
      setNewAvatar("");
      setNewRole("");
      setCreating(false);
      emitNavigatorsChanged();
      if (created.leader?.id) {
        await openLeaderById(created.leader.id);
      }
    } catch (cause) {
      setCreateError(cause instanceof Error ? cause.message : isEn ? "Failed to create Navigator." : "创建领航者失败。");
    } finally {
      setSubmitting(false);
    }
  }

  return (
    <div
      data-testid="leader-sidebar-slot"
      className="mb-2.5 flex flex-col gap-1.5 border-b border-sidebar-border/45 pb-3"
      aria-label={isEn ? "Navigators" : "领航者"}
    >
      <div className="relative flex items-center justify-between gap-1 px-1" ref={menuContainerRef}>
        <span
          data-testid="sidebar-navigators-heading"
          className="text-[13px] font-semibold tracking-tight text-sidebar-foreground/90"
        >
          {isEn ? "Navigators" : "领航者"}
        </span>
        <div className="flex shrink-0 items-center gap-0.5">
          <button
            type="button"
            data-testid="leader-create-trigger"
            aria-label={isEn ? "New Navigator" : "新建领航者"}
            title={isEn ? "New Navigator" : "新建领航者"}
            onClick={() => {
              setMenuOpen(false);
              setCreateError("");
              setCreating((prev) => !prev);
            }}
            className="inline-flex size-7 items-center justify-center rounded-md text-sidebar-muted-foreground transition-colors hover:bg-sidebar-row-hover hover:text-sidebar-foreground focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring"
          >
            {creating ? <XIcon className="size-3.5" aria-hidden="true" /> : <PlusIcon className="size-4" aria-hidden="true" />}
          </button>
          <button
            type="button"
            data-testid="leader-more-trigger"
            aria-label={isEn ? "Navigator options" : "领航者选项"}
            aria-expanded={menuOpen}
            title={isEn ? "Navigator options" : "领航者选项"}
            onClick={() => setMenuOpen((prev) => !prev)}
            className="inline-flex size-7 items-center justify-center rounded-md text-sidebar-muted-foreground transition-colors hover:bg-sidebar-row-hover hover:text-sidebar-foreground focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring"
          >
            <EllipsisIcon className="size-4" aria-hidden="true" />
          </button>
        </div>

        {menuOpen ? (
          <div
            role="menu"
            data-testid="leader-more-menu"
            className="absolute top-8 right-0 z-30 w-44 rounded-xl border border-border bg-popover p-1 text-popover-foreground shadow-md"
          >
            <button
              type="button"
              role="menuitem"
              onClick={() => {
                setMenuOpen(false);
                setCreating(true);
              }}
              className="flex w-full items-center gap-2 rounded-lg px-2.5 py-1.5 text-left text-xs transition-colors hover:bg-accent"
            >
              <PlusIcon className="size-3.5 text-muted-foreground" aria-hidden="true" />
              {isEn ? "New Navigator" : "新建领航者"}
            </button>
            <button
              type="button"
              role="menuitem"
              onClick={() => {
                setMenuOpen(false);
                void navigate({ to: "/settings/remote-connections" });
              }}
              className="flex w-full items-center gap-2 rounded-lg px-2.5 py-1.5 text-left text-xs transition-colors hover:bg-accent"
            >
              <Link2Icon className="size-3.5 text-muted-foreground" aria-hidden="true" />
              {isEn ? "Remote connections" : "管理远程连接"}
            </button>
          </div>
        ) : null}
      </div>

      {creating ? (
        <form
          data-testid="leader-create-form"
          onSubmit={(event) => void handleCreateSubmit(event)}
          className="space-y-2 rounded-xl border border-sidebar-border/80 bg-background/85 p-2.5 shadow-xs"
        >
          <div className="flex gap-1.5">
            <input
              type="text"
              data-testid="leader-create-name"
              value={newName}
              onChange={(event) => setNewName(event.target.value)}
              placeholder={isEn ? "Navigator name" : "领航者名字"}
              aria-label={isEn ? "Navigator name" : "领航者名字"}
              autoFocus
              required
              className="h-7 min-w-0 flex-1 rounded-md border border-input bg-background px-2 text-xs text-foreground outline-none focus-visible:ring-2 focus-visible:ring-ring"
            />
            <input
              type="text"
              data-testid="leader-create-avatar"
              value={newAvatar}
              onChange={(event) => setNewAvatar(event.target.value)}
              placeholder={isEn ? "Icon" : "徽章"}
              aria-label={isEn ? "Avatar badge" : "头像徽章"}
              maxLength={4}
              className="h-7 w-12 shrink-0 rounded-md border border-input bg-background px-1.5 text-center text-xs text-foreground outline-none focus-visible:ring-2 focus-visible:ring-ring"
            />
          </div>
          <div className="flex flex-wrap gap-1">
            {LEADER_ROLE_TEMPLATES.slice(0, 3).map((tpl) => (
              <button
                key={tpl.id}
                type="button"
                onClick={() => setNewRole(isEn ? tpl.promptEn : tpl.prompt)}
                className="rounded-full border border-border/80 bg-muted/40 px-2 py-0.5 text-[10px] text-muted-foreground transition-colors hover:bg-accent hover:text-foreground"
              >
                {isEn ? tpl.labelEn : tpl.label}
              </button>
            ))}
          </div>
          {createError ? (
            <p className="text-[11px] text-destructive" role="alert">
              {createError}
            </p>
          ) : null}
          <div className="flex items-center justify-end gap-1.5">
            <button
              type="button"
              onClick={() => setCreating(false)}
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
          const isPaused = item.leader.status === "paused";
          const uniqueLabels = [
            ...new Set(item.connections.map((conn) => navigatorChannelLabel(conn.platform, lang))),
          ];
          const subtitle = isPaused
            ? item.pausedPendingCount > 0
              ? isEn
                ? `Paused · ${item.pausedPendingCount} queued`
                : `已暂停 · ${item.pausedPendingCount} 条待审`
              : isEn
                ? "Paused"
                : "已暂停"
            : item.needsYouCount > 0
              ? isEn
                ? `${item.needsYouCount} needs your decision`
                : `${item.needsYouCount} 项需要你决定`
              : item.runningCount > 0
                ? isEn
                  ? `${item.runningCount} active tasks`
                  : `${item.runningCount} 项任务进行中`
                : uniqueLabels.length > 0
                  ? uniqueLabels.join(" · ")
                  : isEn
                    ? "Supervisory workspace"
                    : "领航控制面";
          const subtitleTone = isPaused
            ? "text-amber-600 dark:text-amber-400"
            : item.needsYouCount > 0
              ? "text-primary"
              : "text-sidebar-muted-foreground";

          return (
            <button
              key={item.leader.id}
              type="button"
              data-testid={`leader-slot-${item.leader.id}`}
              disabled={openingId === item.leader.id}
              onClick={() => void openLeaderById(item.leader.id)}
              className={`group flex w-full items-center gap-2.5 rounded-xl px-2 py-2 text-left transition-colors outline-none focus-visible:ring-2 focus-visible:ring-ring ${
                isActiveRoute
                  ? "bg-sidebar-accent text-sidebar-accent-foreground"
                  : "text-sidebar-foreground hover:bg-sidebar-row-hover"
              }`}
            >
              <span
                className="relative flex size-8 shrink-0 items-center justify-center rounded-lg border border-sidebar-border/60 bg-background/90 text-[13px] font-semibold text-foreground shadow-2xs"
                aria-hidden="true"
              >
                {item.leader.avatar || Array.from(item.leader.name)[0] || "瞳"}
                <span
                  className={`absolute -right-0.5 -bottom-0.5 size-2 rounded-full ring-2 ring-sidebar ${
                    isPaused
                      ? "bg-amber-500"
                      : item.needsYouCount > 0
                        ? "bg-rose-500"
                        : "bg-emerald-500"
                  }`}
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
                <span className={`mt-0.5 block truncate text-[11px] leading-tight ${subtitleTone}`}>
                  {subtitle}
                </span>
              </span>

              {item.needsYouCount > 0 ? (
                <span
                  data-testid={`leader-needs-you-badge-${item.leader.id}`}
                  className="inline-flex h-5 min-w-5 shrink-0 items-center justify-center rounded-md bg-sidebar-border/65 px-1.5 text-[11px] font-semibold tabular-nums text-sidebar-foreground"
                >
                  {item.needsYouCount}
                </span>
              ) : null}
            </button>
          );
        })}
      </div>
    </div>
  );
}
