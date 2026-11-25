import { useEffect, useRef, useState } from "react";
import { useNavigate, useRouterState } from "@tanstack/react-router";
import { PauseCircleIcon, SparklesIcon } from "lucide-react";
import type { EnvironmentId } from "@t3tools/contracts";
import { usePrimaryEnvironmentId } from "../../state/environments";
import { REMOTE_IM_CHANNELS } from "../settings/remoteImThemes";
import { leaderRequest, type LeaderListItem } from "./leaderTypes";

export interface LeaderSidebarSlotProps {
  readonly onOpenThread?: (environmentId: EnvironmentId, threadId: string) => void;
  readonly onPinnedThreadIdsChange?: (ids: ReadonlySet<string>) => void;
}

/**
 * Dedicated top-of-sidebar fixed Leader control-plane entry (ADR-013 §1).
 * Intentionally mounted outside `pinnedThreads` so project folder filters never hide it
 * and ordinary pin/archive actions never remove it.
 */
export function LeaderSidebarSlot({ onOpenThread, onPinnedThreadIdsChange }: LeaderSidebarSlotProps) {
  const desktop = typeof window !== "undefined" && Boolean(window.desktopBridge);
  const primaryEnvironmentId = usePrimaryEnvironmentId();
  const navigate = useNavigate();
  const pathname = useRouterState({ select: (state) => state.location.pathname });
  const [leaders, setLeaders] = useState<readonly LeaderListItem[]>([]);
  const [openingId, setOpeningId] = useState<string | null>(null);
  const lastPinnedKeyRef = useRef("");

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
    const poll = async () => {
      try {
        const res = await leaderRequest<{ leaders?: LeaderListItem[] }>("leaders", undefined, controller.signal);
        if (!controller.signal.aborted && Array.isArray(res.leaders)) {
          setLeaders(res.leaders);
          notifyPinnedIds(res.leaders);
        }
      } catch {
        // Keep last known Leader snapshot silently during transient startup.
      } finally {
        if (!controller.signal.aborted) {
          timer = setTimeout(() => void poll(), 3000);
        }
      }
    };
    void poll();
    return () => {
      controller.abort();
      clearTimeout(timer);
    };
  }, [desktop]);

  if (!desktop || leaders.length === 0) return null;

  async function handleOpenLeader(item: LeaderListItem) {
    if (openingId) return;
    setOpeningId(item.leader.id);
    try {
      const res = await leaderRequest<{ threadId: string }>(`leaders/${item.leader.id}/open-thread`, {});
      if (res.threadId && primaryEnvironmentId) {
        const nextLeaders = leaders.map((entry) =>
          entry.leader.id === item.leader.id
            ? { ...entry, leader: { ...entry.leader, pinnedThreadId: res.threadId } }
            : entry,
        );
        setLeaders(nextLeaders);
        notifyPinnedIds(nextLeaders);
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
      // Ignore transient navigation failures; user can retry click.
    } finally {
      setOpeningId(null);
    }
  }

  return (
    <div
      data-testid="leader-sidebar-slot"
      className="mb-1.5 flex flex-col gap-1 px-1.5 pt-1"
      aria-label="Leader 主管入口"
    >
      {leaders.map((item) => {
        const isActiveRoute =
          Boolean(item.leader.pinnedThreadId) && pathname.includes(item.leader.pinnedThreadId!);
        const isPaused = item.leader.status === "paused";
        const boundLabels = item.connections
          .map((conn) => REMOTE_IM_CHANNELS[conn.platform]?.name)
          .filter((name): name is NonNullable<typeof name> => Boolean(name));
        const uniqueLabels = [...new Set(boundLabels)];
        const subtitle = isPaused
          ? item.pausedPendingCount > 0
            ? `已暂停 · ${item.pausedPendingCount} 条待审`
            : "已暂停"
          : item.needsYouCount > 0
            ? `${item.needsYouCount} 项需要你决定`
            : item.runningCount > 0
              ? `${item.runningCount} 项任务进行中`
              : uniqueLabels.length > 0
                ? uniqueLabels.join(" · ")
                : "主管控制面";

        return (
          <button
            key={item.leader.id}
            type="button"
            data-testid={`leader-slot-${item.leader.id}`}
            disabled={openingId === item.leader.id}
            onClick={() => void handleOpenLeader(item)}
            className={`group flex w-full items-center gap-2.5 rounded-xl border px-2.5 py-2 text-left transition-colors outline-none focus-visible:ring-2 focus-visible:ring-ring ${
              isActiveRoute
                ? "border-sidebar-border bg-sidebar-accent text-sidebar-accent-foreground shadow-xs"
                : "border-sidebar-border/70 bg-sidebar/70 text-sidebar-foreground hover:bg-sidebar-accent/70"
            }`}
          >
            <span
              className="relative flex size-7 shrink-0 items-center justify-center rounded-lg border border-sidebar-border/80 bg-background/90 text-xs font-semibold text-foreground shadow-2xs"
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
                <span className="truncate text-[13px] font-semibold leading-tight">
                  {item.leader.name}
                </span>
                {isPaused ? (
                  <PauseCircleIcon className="size-3.5 shrink-0 text-amber-500" aria-hidden="true" />
                ) : (
                  <SparklesIcon className="size-3 shrink-0 text-muted-foreground/70" aria-hidden="true" />
                )}
              </span>
              <span className="block truncate text-[11px] leading-tight text-sidebar-muted-foreground">
                {subtitle}
              </span>
            </span>

            {item.needsYouCount > 0 ? (
              <span
                data-testid={`leader-needs-you-badge-${item.leader.id}`}
                className="inline-flex h-5 min-w-5 shrink-0 items-center justify-center rounded-full bg-rose-500/15 px-1.5 text-[11px] font-semibold text-rose-600 dark:text-rose-400"
              >
                {item.needsYouCount}
              </span>
            ) : null}
          </button>
        );
      })}
    </div>
  );
}
