import { useEffect, useMemo, useRef, useState } from "react";
import {
  mountAvatar,
  type AvatarMood,
  type AvatarState,
  type MountedAvatar,
} from "./openBotAvatar";
import {
  createNavigatorAvatarControllerState,
  isLightAvatarBodyColor,
  parseNavigatorAvatar,
  resolveAvatarPresentation,
  stepNavigatorAvatarController,
  type NavigatorAvatarControllerState,
  type NavigatorWorkSignals,
} from "./navigatorAvatarModel";

export interface NavigatorBotAvatarProps {
  readonly avatar: string | null | undefined;
  readonly leaderId?: string | undefined;
  readonly state?: AvatarState | undefined;
  readonly mood?: AvatarMood | undefined;
  readonly size?: number | undefined;
  readonly followPointer?: boolean | undefined;
  readonly still?: boolean | undefined;
  readonly depth?: number | undefined;
  readonly replayNonce?: number | undefined;
  readonly className?: string | undefined;
  readonly testId?: string | undefined;
}

export function useNavigatorAvatarPresentation(signals: NavigatorWorkSignals): {
  readonly state: AvatarState;
  readonly mood: AvatarMood;
} {
  const [controller, setController] = useState<NavigatorAvatarControllerState>(() =>
    stepNavigatorAvatarController(createNavigatorAvatarControllerState(), signals, Date.now()),
  );
  const [nowMs, setNowMs] = useState(() => Date.now());
  const latestSignalsRef = useRef(signals);
  latestSignalsRef.current = signals;

  const signalSignature = [
    signals.leaderStatus,
    signals.runningCount,
    signals.startingCount ?? 0,
    signals.waitingCount ?? 0,
    signals.failedCount ?? 0,
    signals.pendingApprovalCount,
    signals.pausedPendingCount,
    signals.needsYouCount,
    signals.latestCompletedKey ?? "",
    signals.latestCompletedAtMs ?? "",
    signals.awarenessScopeKey ?? "",
    signals.pinnedThread?.status ?? "",
    signals.pinnedThread?.runtimeStatus ?? "",
    signals.pinnedThread?.activityRunStatus ?? "",
    signals.pinnedThread?.blockedOnThreadWait ? "1" : "0",
    signals.pinnedThread?.pendingRuntimeRequest ? "1" : "0",
    signals.pinnedThread?.latestRunId ?? "",
    signals.pinnedThread?.latestRunStopRequested ? "1" : "0",
    signals.pinnedThread?.hasAwaitedBackgroundWork ? "1" : "0",
  ].join("\0");

  useEffect(() => {
    const now = Date.now();
    setNowMs(now);
    setController((prev) => stepNavigatorAvatarController(prev, latestSignalsRef.current, now));
  }, [signalSignature]);

  const presentation = resolveAvatarPresentation(controller, nowMs);

  useEffect(() => {
    if (presentation.nextWakeMs === null) return;
    const delay = Math.max(16, presentation.nextWakeMs + 20);
    const timer = setTimeout(() => {
      const now = Date.now();
      setNowMs(now);
      setController((prev) => stepNavigatorAvatarController(prev, latestSignalsRef.current, now));
    }, delay);
    return () => clearTimeout(timer);
  }, [presentation.nextWakeMs, controller]);

  return {
    state: presentation.state,
    mood: presentation.mood,
  };
}

export function NavigatorBotAvatar({
  avatar,
  leaderId,
  state = "idle",
  mood = "neutral",
  size = 32,
  followPointer = false,
  still = false,
  depth = 6,
  replayNonce,
  className,
  testId,
}: NavigatorBotAvatarProps) {
  const hostRef = useRef<HTMLSpanElement>(null);
  const mountedRef = useRef<MountedAvatar | null>(null);
  const [pageHidden, setPageHidden] = useState(
    () => typeof document !== "undefined" && document.visibilityState === "hidden",
  );

  const resolved = useMemo(() => parseNavigatorAvatar(avatar, leaderId), [avatar, leaderId]);
  const lightBody = isLightAvatarBodyColor(resolved.color);
  const reducedMotion: boolean | "system" = pageHidden ? true : "system";

  useEffect(() => {
    if (typeof document === "undefined") return;
    const onVisibility = () => {
      setPageHidden(document.visibilityState === "hidden");
    };
    document.addEventListener("visibilitychange", onVisibility);
    return () => document.removeEventListener("visibilitychange", onVisibility);
  }, []);

  useEffect(() => {
    const host = hostRef.current;
    if (!host) return;
    const instance = mountAvatar(host, {
      definition: resolved.entry.definition,
      color: resolved.color,
      eyeColor: resolved.eyeColor,
      state,
      mood,
      followPointer: still ? false : followPointer,
      still,
      depth,
      reducedMotion,
      label: "",
      replayNonce,
    });
    mountedRef.current = instance;
    return () => {
      instance.destroy();
      mountedRef.current = null;
    };
  }, [still]);

  useEffect(() => {
    const instance = mountedRef.current;
    if (!instance) return;
    instance.update({
      definition: resolved.entry.definition,
      color: resolved.color,
      eyeColor: resolved.eyeColor,
      state,
      mood,
      followPointer: still ? false : followPointer,
      depth,
      reducedMotion,
      label: "",
      replayNonce,
    });
  }, [resolved, state, mood, followPointer, still, depth, reducedMotion, size, replayNonce]);

  return (
    <span
      ref={hostRef}
      data-testid={testId}
      data-avatar-shape={resolved.shapeId}
      data-avatar-color={resolved.color}
      data-avatar-eye-color={resolved.eyeColor}
      data-avatar-light-body={lightBody ? "true" : "false"}
      data-avatar-state={state}
      data-avatar-mood={mood}
      aria-hidden="true"
      style={{ width: size, height: size }}
      className={`relative inline-flex shrink-0 items-center justify-center select-none ${
        still ? "overflow-hidden pointer-events-none [&>svg]:block [&>svg]:size-full" : ""
      } ${lightBody ? "drop-shadow-[0_0_1px_rgba(15,23,42,0.45)]" : ""} ${className ?? ""}`}
    />
  );
}
