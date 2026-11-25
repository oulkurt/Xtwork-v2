import { useEffect, useRef, useState, type FormEvent } from "react";
import {
  ArrowLeftIcon,
  CheckCircle2Icon,
  ExternalLinkIcon,
  KeyRoundIcon,
  Loader2Icon,
  QrCodeIcon,
  RotateCcwIcon,
} from "lucide-react";
import { readDesktopPrimaryBearerToken } from "../../environments/primary/desktopAuth";
import { Button } from "../ui/button";
import { Input } from "../ui/input";
import { QRCodeSvg } from "../ui/qr-code";
import { RemoteImHoloCard } from "./RemoteImHoloCard";
import {
  formatOnboardingFailure,
  REMOTE_IM_CHANNEL_ORDER,
  REMOTE_IM_CHANNELS,
  REMOTE_IM_STATE_LABELS,
  type RemoteImChannel,
} from "./remoteImThemes";
import { SettingsPageContainer, SettingsRow, SettingsSection } from "./settingsLayout";

type Channel = RemoteImChannel;
type CardFaceMode = "qr" | "manual";

type Connection = {
  id?: string;
  connectionId?: string;
  platform: Channel;
  lifecycleState?: string;
  paused?: boolean;
  state?: string;
  stateDetail?: string;
  status?: string;
  botName?: string;
  name?: string;
  message?: string;
  claimCode?: string | null;
  claimExpiresAt?: number | null;
};

type Access = {
  id?: string;
  requestId?: string;
  state?: string;
  status?: string;
  name?: string;
  chatName?: string;
  senderName?: string;
  contactId?: string | null;
  chatId?: string | null;
  platformMsgId?: string | null;
  chat?: { kind?: string | null; name?: string | null; parentId?: string | null };
};

type Approval = { id: string; toolName: string; details: string; replyAudience: string };
type Event = { sequence: number; event: string; payload: Record<string, unknown> };

export type Onboarding = {
  platform: Channel;
  id?: string | undefined;
  connectionId?: string | undefined;
  state: string;
  qr?: string | undefined;
  claim?: string | undefined;
  desktopLink?: string | undefined;
  message?: string | undefined;
  errorCode?: string | undefined;
};

const TERMINAL_ONBOARDING_STATES = new Set(["connected", "complete", "success", "succeeded"]);
const NON_CANCELLABLE_STATES = new Set([...TERMINAL_ONBOARDING_STATES, "pairing", "failed"]);
const CODE_STATES = new Set(["awaiting_code", "needs_code", "code", "pin", "verify"]);

function collection<T>(value: unknown, key: string): T[] {
  if (Array.isArray(value)) return value;
  if (value && typeof value === "object") {
    const items = (value as Record<string, unknown>)[key];
    if (Array.isArray(items)) return items;
  }
  return [];
}

function tokenValue(source: Record<string, unknown>, ...keys: string[]) {
  for (const key of keys) {
    const value = source[key];
    if (typeof value === "string") return value;
  }
  return undefined;
}

export function accessTarget(item: Access): { targetKind: "contact" | "chat"; targetId: string } | undefined {
  const isDm = item.chat?.kind !== undefined ? item.chat.kind === "dm" : Boolean(item.contactId);
  const targetKind = isDm ? "contact" : "chat";
  const targetId = targetKind === "contact" ? item.contactId : (item.chat?.parentId ?? item.chatId);
  return targetId ? { targetKind, targetId } : undefined;
}

export function applyOnboardingEvent(
  current: Onboarding,
  payload: Record<string, unknown>,
  options: { readonly allowBind?: boolean } = {},
): Onboarding {
  const onboardingId = tokenValue(payload, "onboardingId", "sessionId", "id");
  const platform = tokenValue(payload, "platform", "channel");
  if (platform && platform !== current.platform) return current;
  if (onboardingId) {
    if (current.id && current.id !== onboardingId) return current;
    if (!current.id && !options.allowBind) return current;
  }
  const event =
    payload.event && typeof payload.event === "object" && !Array.isArray(payload.event)
      ? (payload.event as Record<string, unknown>)
      : payload;
  const kind = tokenValue(event, "kind", "type");
  const lifecycle = tokenValue(event, "lifecycleState");
  const state =
    lifecycle === "pairing"
      ? "pairing"
      : kind === "succeeded"
        ? "succeeded"
        : (tokenValue(event, "lifecycleState", "state", "status", "type", "kind") ?? current.state);
  const qr = tokenValue(event, "qrContent", "qr", "qrUrl", "url", "qrCode", "qrcode");
  const desktopLink = tokenValue(event, "desktopLink", "verificationUri");
  const connectionId = tokenValue(event, "connectionId") ?? tokenValue(payload, "connectionId");
  const claim = tokenValue(event, "claimCode", "pairingCode", ...(state === "pairing" ? ["code"] : []));
  const errorCode = state === "failed" ? tokenValue(event, "code") : undefined;
  const rawMessage = tokenValue(event, "message", "error", "detail");
  const message =
    rawMessage ?? (state === "failed" ? formatOnboardingFailure(errorCode, undefined) : undefined);

  return {
    ...current,
    id: current.id ?? (options.allowBind ? onboardingId : undefined),
    connectionId: connectionId ?? current.connectionId,
    state,
    qr: qr ?? current.qr,
    claim: claim && /^\d{6}$/u.test(claim) ? claim : current.claim,
    desktopLink: desktopLink ?? current.desktopLink,
    message:
      message ?? (state === "qr_ready" || TERMINAL_ONBOARDING_STATES.has(state) ? undefined : current.message),
    errorCode: errorCode ?? (state === "failed" ? current.errorCode : undefined),
  };
}

export function resolveChannelStatus(
  platform: Channel,
  connections: readonly Connection[],
): { label: string; tone: "connected" | "warning" | "error" | "idle" } {
  const matched = connections.filter((item) => item.platform === platform);
  if (matched.length === 0) return { label: "未连接", tone: "idle" };

  const transportOf = (item: Connection) => item.state ?? item.status;
  const isPausedOf = (item: Connection) => item.paused === true || transportOf(item) === "paused";
  const isConnectedOf = (item: Connection) => {
    if (isPausedOf(item) || item.lifecycleState === "pairing") return false;
    const transport = transportOf(item);
    return transport === "connected" || (transport === undefined && item.lifecycleState === "active");
  };

  const connectedCount = matched.filter(isConnectedOf).length;
  if (connectedCount > 0) {
    return {
      label: connectedCount > 1 ? `已连接 · ${connectedCount}` : "已连接",
      tone: "connected",
    };
  }
  if (matched.some((item) => item.lifecycleState === "pairing")) {
    return { label: "等待认领", tone: "warning" };
  }
  if (matched.some((item) => !isPausedOf(item) && transportOf(item) === "error")) {
    return { label: "连接异常", tone: "error" };
  }
  if (matched.some((item) => !isPausedOf(item) && transportOf(item) === "awaiting_approval")) {
    return { label: REMOTE_IM_STATE_LABELS.awaiting_approval ?? "等待审批", tone: "warning" };
  }
  if (matched.every(isPausedOf)) {
    return { label: "已暂停", tone: "idle" };
  }
  const first = matched.find((item) => !isPausedOf(item)) ?? matched[0];
  const stateKey = (first ? transportOf(first) : undefined) ?? first?.lifecycleState ?? "";
  return { label: REMOTE_IM_STATE_LABELS[stateKey] ?? "连接中", tone: "warning" };
}

async function request(path: string, payload?: Record<string, unknown>, signal?: AbortSignal): Promise<unknown> {
  const token = await readDesktopPrimaryBearerToken();
  if (!token) throw new Error("请先连接本机服务。");
  const res = await fetch(`/api/xtwork/im/${path}`, {
    headers: { Authorization: `Bearer ${token}`, ...(payload ? { "Content-Type": "application/json" } : {}) },
    ...(signal ? { signal } : {}),
    ...(payload ? { method: "POST", body: JSON.stringify(payload) } : {}),
  });
  const value = await res.json();
  if (!res.ok) throw new Error(typeof value?.error === "string" ? value.error : "远程连接暂不可用。");
  return value;
}

function StatusPill({ label, tone }: { readonly label: string; readonly tone: "connected" | "warning" | "error" | "idle" }) {
  const dotColor =
    tone === "connected"
      ? "bg-emerald-500"
      : tone === "warning"
        ? "bg-amber-500"
        : tone === "error"
          ? "bg-rose-500"
          : "bg-current opacity-40";
  return (
    <span
      className="inline-flex items-center gap-1.5 rounded-full border px-2.5 py-1 text-2xs font-medium"
      style={{
        backgroundColor: "var(--holo-chip-bg)",
        borderColor: "var(--holo-chip-border)",
        color: "var(--holo-ink)",
      }}
    >
      <span className={`size-1.5 rounded-full ${dotColor}`} aria-hidden="true" />
      {label}
    </span>
  );
}

export function RemoteImSettings() {
  const [connections, setConnections] = useState<Connection[]>([]);
  const [access, setAccess] = useState<Access[]>([]);
  const [approvals, setApprovals] = useState<Approval[]>([]);
  const [available, setAvailable] = useState<boolean>();
  const [error, setError] = useState("");
  const [busy, setBusy] = useState(false);
  const [flippedModes, setFlippedModes] = useState<Partial<Record<Channel, CardFaceMode>>>({});
  const [onboardings, setOnboardings] = useState<Partial<Record<Channel, Onboarding>>>({});
  const [cardErrors, setCardErrors] = useState<Partial<Record<Channel, string>>>({});
  const cursor = useRef(0);
  const statusSeqRef = useRef(0);
  const appliedStatusSeqRef = useRef(0);
  const snapshotSeqRef = useRef(0);
  const appliedSnapshotSeqRef = useRef(0);
  const unboundStartsRef = useRef<Partial<Record<Channel, number>>>({});
  const activeActionsRef = useRef(new Set<{ platform?: Channel }>());
  const startGenRef = useRef<Record<Channel, number>>({ feishu: 0, wecom: 0, wechat: 0 });
  const onboardingsRef = useRef(onboardings);
  useEffect(() => {
    onboardingsRef.current = onboardings;
  }, [onboardings]);

  const hasActiveOnboarding = Object.values(onboardings).some(
    (entry) => entry !== undefined && !NON_CANCELLABLE_STATES.has(entry.state),
  );
  const pollIntervalMs = hasActiveOnboarding ? 1000 : 2000;
  const pollIntervalRef = useRef(pollIntervalMs);
  useEffect(() => {
    pollIntervalRef.current = pollIntervalMs;
  }, [pollIntervalMs]);

  async function refresh(signal?: AbortSignal) {
    const statusSeq = ++statusSeqRef.current;
    const status = (await request("status", undefined, signal)) as { state?: string; lifecycle?: string };
    if (signal?.aborted) return;
    const statusState = status.state ?? status.lifecycle;
    const online = statusState !== "starting" && statusState !== "unavailable";
    if (statusSeq >= appliedStatusSeqRef.current) {
      appliedStatusSeqRef.current = statusSeq;
      setAvailable(online);
    }
    if (!online) return;
    const snapshotSeq = ++snapshotSeqRef.current;
    const hasUnboundStart = () => Object.keys(unboundStartsRef.current).length > 0;
    const shouldPollEvents = !hasUnboundStart();
    const [items, requests, permissions, notifications] = await Promise.all([
      request("connections", undefined, signal),
      request("access", undefined, signal),
      request("approvals", undefined, signal),
      shouldPollEvents ? request(`onboarding/events?after=${cursor.current}`, undefined, signal) : Promise.resolve(null),
    ]);
    if (signal?.aborted) return;
    if (snapshotSeq >= appliedSnapshotSeqRef.current) {
      appliedSnapshotSeqRef.current = snapshotSeq;
      setConnections(collection(items, "connections"));
      const held = collection<Access>(requests, "held");
      setAccess(
        (held.length > 0 ? held : collection<Access>(requests, "requests")).filter(
          (item) => (item.status ?? item.state ?? "held") === "held",
        ),
      );
      setApprovals(collection(permissions, "approvals"));
    }
    // Defer consuming onboarding events and advancing the cursor whenever any active start is still unbound.
    const incomingEvents =
      shouldPollEvents && !hasUnboundStart()
        ? collection<Event>(notifications, "events").filter(({ sequence }) => sequence > cursor.current)
        : [];
    if (incomingEvents.length > 0) {
      const onboardingUpdates: Record<string, unknown>[] = [];
      for (const { sequence, event, payload } of incomingEvents) {
        cursor.current = Math.max(sequence, cursor.current);
        if (event === "onboarding.event") onboardingUpdates.push(payload);
      }
      if (onboardingUpdates.length > 0) {
        setOnboardings((current) => {
          let next = current;
          for (const payload of onboardingUpdates) {
            for (const platform of REMOTE_IM_CHANNEL_ORDER) {
              const existing = next[platform];
              if (!existing?.id) continue;
              const updated = applyOnboardingEvent(existing, payload);
              if (updated !== existing) {
                next = { ...next, [platform]: updated };
              }
            }
          }
          return next;
        });
      }
    }
  }

  const desktop = typeof window !== "undefined" && Boolean(window.desktopBridge);
  useEffect(() => {
    if (!desktop) return;
    const controller = new AbortController();
    let timer: ReturnType<typeof setTimeout>;
    const poll = async () => {
      try {
        await refresh(controller.signal);
        if (!controller.signal.aborted) setError("");
      } catch (cause) {
        if (!controller.signal.aborted) {
          setError(cause instanceof Error ? cause.message : "远程连接暂不可用。");
        }
      } finally {
        if (!controller.signal.aborted) {
          timer = setTimeout(() => void poll(), pollIntervalRef.current);
        }
      }
    };
    void poll();
    return () => {
      controller.abort();
      clearTimeout(timer);
    };
  }, [desktop]);

  async function perform(action: () => Promise<unknown>, scopedPlatform?: Channel) {
    const startGen = scopedPlatform ? startGenRef.current[scopedPlatform] : undefined;
    const actionToken: { platform?: Channel } = scopedPlatform ? { platform: scopedPlatform } : {};
    activeActionsRef.current.add(actionToken);
    setBusy(true);
    if (scopedPlatform) {
      setCardErrors((current) => ({ ...current, [scopedPlatform]: "" }));
    } else {
      setError("");
    }
    try {
      await action();
      appliedSnapshotSeqRef.current = ++snapshotSeqRef.current;
      if (scopedPlatform && startGen !== startGenRef.current[scopedPlatform]) return;
      await refresh();
    } catch (cause) {
      if (scopedPlatform && startGen !== startGenRef.current[scopedPlatform]) return;
      const message = cause instanceof Error ? cause.message : "操作失败，请重试。";
      if (scopedPlatform) {
        setCardErrors((current) => ({ ...current, [scopedPlatform]: message }));
      } else {
        setError(message);
      }
    } finally {
      activeActionsRef.current.delete(actionToken);
      setBusy(activeActionsRef.current.size > 0);
    }
  }

  function cancelPendingSession(platform: Channel) {
    startGenRef.current[platform] += 1;
    delete unboundStartsRef.current[platform];
    for (const token of activeActionsRef.current) {
      if (token.platform === platform) activeActionsRef.current.delete(token);
    }
    setBusy(activeActionsRef.current.size > 0);
    const active = onboardingsRef.current[platform];
    if (active?.id && !NON_CANCELLABLE_STATES.has(active.state)) {
      void request("onboarding/cancel", { sessionId: active.id }).catch(() => undefined);
    }
    setOnboardings((current) => {
      if (!(platform in current)) return current;
      const next = { ...current };
      delete next[platform];
      return next;
    });
    setCardErrors((current) => ({ ...current, [platform]: "" }));
  }

  function startOnboarding(platform: Channel, credentials?: Record<string, string>) {
    const generation = ++startGenRef.current[platform];
    unboundStartsRef.current[platform] = generation;
    const previous = onboardingsRef.current[platform];
    if (previous?.id && !NON_CANCELLABLE_STATES.has(previous.state)) {
      void request("onboarding/cancel", { sessionId: previous.id }).catch(() => undefined);
    }
    setOnboardings((current) => ({ ...current, [platform]: { platform, state: "connecting" } }));
    return perform(async () => {
      let bound = false;
      try {
        const value = await request("onboarding/start", {
          platform,
          mode: credentials ? "credentials" : "qr",
          ...(credentials ? { credentials } : {}),
        });
        const record = value && typeof value === "object" ? (value as Record<string, unknown>) : undefined;
        const returnedId = record ? tokenValue(record, "onboardingId", "sessionId", "id") : undefined;
        if (startGenRef.current[platform] !== generation) {
          if (returnedId) void request("onboarding/cancel", { sessionId: returnedId }).catch(() => undefined);
          return;
        }
        if (record) {
          bound = true;
          setOnboardings((current) => {
            const entry = current[platform];
            if (!entry) return current;
            return {
              ...current,
              [platform]: applyOnboardingEvent(entry, record, { allowBind: true }),
            };
          });
        }
      } catch (cause) {
        if (startGenRef.current[platform] !== generation) return;
        if (!bound) {
          const message = cause instanceof Error ? cause.message : "操作失败，请重试。";
          setOnboardings((current) => {
            const entry = current[platform];
            if (!entry || entry.state !== "connecting") return current;
            return { ...current, [platform]: { ...entry, state: "failed", message } };
          });
        }
        throw cause;
      } finally {
        if (unboundStartsRef.current[platform] === generation) {
          delete unboundStartsRef.current[platform];
        }
      }
    }, platform);
  }

  // Start QR onboarding whenever a card is flipped to QR mode and the bridge is ready.
  useEffect(() => {
    if (!desktop || !available) return;
    for (const platform of REMOTE_IM_CHANNEL_ORDER) {
      if (flippedModes[platform] === "qr" && !onboardingsRef.current[platform] && !cardErrors[platform]) {
        void startOnboarding(platform);
      }
    }
  }, [desktop, available, flippedModes, cardErrors]);

  function openQrCard(platform: Channel) {
    cancelPendingSession(platform);
    setFlippedModes((current) => ({ ...current, [platform]: "qr" }));
  }

  function openManualCard(platform: Channel) {
    if (!REMOTE_IM_CHANNELS[platform].supportsManual) return;
    cancelPendingSession(platform);
    setFlippedModes((current) => ({ ...current, [platform]: "manual" }));
  }

  function flipCardToFront(platform: Channel) {
    cancelPendingSession(platform);
    setFlippedModes((current) => {
      if (!(platform in current)) return current;
      const next = { ...current };
      delete next[platform];
      return next;
    });
  }

  function submitCredentials(platform: Channel, event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    if (platform === "wechat") return;
    const form = new FormData(event.currentTarget);
    const identifier = String(form.get("identifier") ?? "").trim();
    const secret = String(form.get("secret") ?? "").trim();
    if (!identifier || !secret) return;
    const credentials =
      platform === "feishu" ? { appId: identifier, appSecret: secret } : { botId: identifier, secret };
    event.currentTarget.reset();
    void startOnboarding(platform, credentials);
  }

  function submitCode(platform: Channel, event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    const active = onboardings[platform];
    if (!active?.id) return;
    const code = String(new FormData(event.currentTarget).get("code") ?? "").trim();
    if (!code) return;
    event.currentTarget.reset();
    void perform(() => request("onboarding/submitCode", { sessionId: active.id, code }), platform);
  }

  const renderBackFace = (platform: Channel) => {
    const meta = REMOTE_IM_CHANNELS[platform];
    const mode = flippedModes[platform] ?? "qr";
    const session = onboardings[platform];
    const localError = cardErrors[platform];
    const matchedConnection = session?.connectionId
      ? connections.find((item) => (item.id ?? item.connectionId) === session.connectionId)
      : undefined;
    const matchedConnectionId = matchedConnection?.id ?? matchedConnection?.connectionId;
    const isClaimedActive =
      session !== undefined &&
      (session.state === "pairing" || Boolean(session.claim)) &&
      matchedConnection?.lifecycleState === "active";
    const isSucceeded =
      isClaimedActive || (session !== undefined && TERMINAL_ONBOARDING_STATES.has(session.state));
    const liveClaim = matchedConnection
      ? matchedConnection.lifecycleState === "pairing"
        ? (matchedConnection.claimCode ?? undefined)
        : undefined
      : session?.claim;
    const isPairing =
      !isClaimedActive &&
      (matchedConnection
        ? matchedConnection.lifecycleState === "pairing"
        : session?.state === "pairing" || Boolean(session?.claim));
    const isNeedsCode = session !== undefined && CODE_STATES.has(session.state);
    const isFailed = session?.state === "failed";

    return (
      <div className="flex min-h-0 flex-1 flex-col justify-between gap-3">
        {/* Back Header */}
        <div className="flex items-center justify-between gap-2">
          <button
            type="button"
            className="inline-flex h-7 items-center gap-1 rounded-full border px-2.5 text-xs font-medium transition-colors outline-none focus-visible:ring-2 focus-visible:ring-ring"
            style={{
              backgroundColor: "var(--holo-control-bg)",
              borderColor: "var(--holo-chip-border)",
              color: "var(--holo-ink)",
            }}
            onClick={() => flipCardToFront(platform)}
          >
            <ArrowLeftIcon className="size-3.5" aria-hidden="true" />
            返回
          </button>

          {meta.supportsManual ? (
            <button
              type="button"
              className="inline-flex h-7 items-center gap-1 rounded-full border px-2.5 text-xs font-medium transition-colors outline-none focus-visible:ring-2 focus-visible:ring-ring"
              style={{
                backgroundColor: "var(--holo-control-bg)",
                borderColor: "var(--holo-chip-border)",
                color: "var(--holo-ink)",
              }}
              onClick={() => (mode === "manual" ? openQrCard(platform) : openManualCard(platform))}
            >
              {mode === "manual" ? (
                <>
                  <QrCodeIcon className="size-3.5" aria-hidden="true" />
                  扫码
                </>
              ) : (
                <>
                  <KeyRoundIcon className="size-3.5" aria-hidden="true" />
                  凭据
                </>
              )}
            </button>
          ) : null}
        </div>

        {/* Back Main Body */}
        <div
          data-holo-interactive="true"
          className="flex min-h-0 flex-1 flex-col items-center justify-center rounded-2xl border p-3.5 text-center"
          style={{
            backgroundColor: "var(--holo-back-panel-bg)",
            borderColor: "var(--holo-back-panel-border)",
          }}
        >
          {!desktop ? (
            <p className="text-xs leading-relaxed" style={{ color: "var(--holo-ink-muted)" }}>
              请在桌面端使用远程连接功能。
            </p>
          ) : available === undefined ? (
            <div className="flex flex-col items-center gap-2">
              <Loader2Icon className="size-5 animate-spin opacity-75" aria-hidden="true" />
              <p className="text-xs" style={{ color: "var(--holo-ink-muted)" }}>
                正在读取连接状态…
              </p>
            </div>
          ) : !available ? (
            <div className="flex flex-col items-center gap-2.5">
              <p className="text-xs leading-relaxed" style={{ color: "var(--holo-ink-muted)" }}>
                远程连接服务暂不可用，请稍后重试。
              </p>
            </div>
          ) : isPairing ? (
            <div className="flex w-full flex-col items-center gap-2.5">
              {liveClaim ? (
                <>
                  <span className="text-xs font-medium" style={{ color: "var(--holo-ink)" }}>
                    发送认领码完成绑定
                  </span>
                  <output
                    className="rounded-xl border px-4 py-2 font-mono text-2xl font-bold tracking-[0.22em]"
                    style={{
                      backgroundColor: "var(--holo-chip-bg)",
                      borderColor: "var(--holo-chip-border)",
                      color: "var(--holo-ink)",
                    }}
                  >
                    {liveClaim}
                  </output>
                  <p className="text-2xs leading-relaxed" style={{ color: "var(--holo-ink-muted)" }}>
                    在{meta.name}里私聊机器人发送上方 6 位认领码
                  </p>
                </>
              ) : (
                <>
                  <span className="text-xs font-medium" style={{ color: "var(--holo-ink)" }}>
                    认领码已失效
                  </span>
                  <p className="text-2xs leading-relaxed" style={{ color: "var(--holo-ink-muted)" }}>
                    请刷新认领码后，在{meta.name}里私聊机器人重新发送
                  </p>
                  {matchedConnectionId ? (
                    <Button
                      size="sm"
                      variant="outline"
                      disabled={busy}
                      onClick={() =>
                        void perform(() => request("connections/claimRefresh", { connectionId: matchedConnectionId }))
                      }
                    >
                      <RotateCcwIcon className="mr-1 size-3.5" aria-hidden="true" />
                      刷新认领码
                    </Button>
                  ) : null}
                </>
              )}
            </div>
          ) : isSucceeded ? (
            <div className="flex flex-col items-center gap-2">
              <CheckCircle2Icon className="size-8 text-emerald-500" aria-hidden="true" />
              <p className="text-sm font-semibold" style={{ color: "var(--holo-ink)" }}>
                {meta.name}已连接
              </p>
              <Button size="sm" variant="outline" onClick={() => flipCardToFront(platform)}>
                完成
              </Button>
            </div>
          ) : mode === "manual" && meta.supportsManual ? (
            <form
              className="flex w-full flex-col gap-2.5 text-left"
              onSubmit={(event) => submitCredentials(platform, event)}
            >
              <div className="flex items-center justify-between gap-2">
                <span className="text-xs font-semibold" style={{ color: "var(--holo-ink)" }}>
                  {meta.name} · 手动凭据
                </span>
                {meta.setupUrl ? (
                  <a
                    href={meta.setupUrl}
                    target="_blank"
                    rel="noreferrer"
                    className="inline-flex items-center gap-0.5 text-2xs underline opacity-80 hover:opacity-100"
                    style={{ color: "var(--holo-ink)" }}
                  >
                    开放平台
                    <ExternalLinkIcon className="size-2.5" aria-hidden="true" />
                  </a>
                ) : null}
              </div>

              <label className="grid gap-1 text-2xs font-medium" style={{ color: "var(--holo-ink)" }}>
                {meta.identifier}
                <Input
                  name="identifier"
                  placeholder={meta.identifierPlaceholder}
                  autoComplete="off"
                  required
                  className="h-8 bg-background/90 text-xs text-foreground"
                />
              </label>

              <label className="grid gap-1 text-2xs font-medium" style={{ color: "var(--holo-ink)" }}>
                {meta.secret}
                <Input
                  name="secret"
                  type="password"
                  placeholder={meta.secretPlaceholder}
                  autoComplete="off"
                  required
                  className="h-8 bg-background/90 text-xs text-foreground"
                />
              </label>

              {localError || (isFailed && session?.message) ? (
                <p className="text-2xs leading-snug text-destructive" role="alert">
                  {localError || session?.message}
                </p>
              ) : null}

              <Button
                size="sm"
                type="submit"
                disabled={busy || session?.state === "connecting"}
                className="mt-0.5 w-full"
              >
                {session?.state === "connecting" ? (
                  <>
                    <Loader2Icon className="mr-1.5 size-3.5 animate-spin" aria-hidden="true" />
                    正在验证…
                  </>
                ) : (
                  "验证并连接"
                )}
              </Button>
            </form>
          ) : isNeedsCode ? (
            <form
              className="flex w-full flex-col gap-2.5 text-left"
              onSubmit={(event) => submitCode(platform, event)}
            >
              <span className="text-xs font-semibold" style={{ color: "var(--holo-ink)" }}>
                输入手机验证码
              </span>
              <p className="text-2xs leading-relaxed" style={{ color: "var(--holo-ink-muted)" }}>
                请在手机上查看{meta.name}发送的验证码并输入
              </p>
              <Input
                name="code"
                inputMode="numeric"
                placeholder="输入验证码"
                required
                className="h-8 bg-background/90 text-xs text-foreground"
              />
              {localError ? (
                <p className="text-2xs text-destructive" role="alert">
                  {localError}
                </p>
              ) : null}
              <Button size="sm" type="submit" disabled={busy} className="w-full">
                提交验证码
              </Button>
            </form>
          ) : isFailed || localError ? (
            <div className="flex flex-col items-center gap-2.5">
              <p className="text-xs leading-relaxed text-destructive" role="alert">
                {localError || session?.message || "连接失败，请重试。"}
              </p>
              <Button size="sm" variant="outline" disabled={busy} onClick={() => void startOnboarding(platform)}>
                <RotateCcwIcon className="mr-1 size-3.5" aria-hidden="true" />
                重新获取二维码
              </Button>
            </div>
          ) : session?.state === "scanned" ? (
            <div className="flex flex-col items-center gap-2">
              <Loader2Icon className="size-6 animate-spin opacity-80" aria-hidden="true" />
              <p className="text-xs font-medium" style={{ color: "var(--holo-ink)" }}>
                已扫码，请在手机上确认
              </p>
            </div>
          ) : session?.qr ? (
            <div className="flex flex-col items-center gap-2">
              <div className="rounded-xl bg-white p-2.5 shadow-sm">
                <QRCodeSvg size={152} marginSize={2} title={`${meta.name}连接二维码`} value={session.qr} />
              </div>
              <p className="text-2xs font-medium" style={{ color: "var(--holo-ink-muted)" }}>
                {meta.scanHint}
              </p>
              {(session.desktopLink ?? session.qr).startsWith("http") && platform === "feishu" ? (
                <a
                  href={session.desktopLink ?? session.qr}
                  target="_blank"
                  rel="noreferrer"
                  className="inline-flex items-center gap-1 text-2xs underline opacity-80 hover:opacity-100"
                  style={{ color: "var(--holo-ink)" }}
                >
                  在浏览器中打开授权
                  <ExternalLinkIcon className="size-2.5" aria-hidden="true" />
                </a>
              ) : null}
            </div>
          ) : (
            <div className="flex flex-col items-center gap-2">
              <Loader2Icon className="size-5 animate-spin opacity-75" aria-hidden="true" />
              <p className="text-xs" style={{ color: "var(--holo-ink-muted)" }}>
                正在获取{meta.name}二维码…
              </p>
            </div>
          )}
        </div>

        {/* Back Footer */}
        <div className="flex items-center justify-between text-2xs" style={{ color: "var(--holo-ink-muted)" }}>
          <span>{meta.name}</span>
          {mode === "qr" && session?.qr && !isSucceeded && !isPairing ? (
            <button
              type="button"
              disabled={busy}
              className="inline-flex items-center gap-1 hover:underline disabled:opacity-50"
              style={{ color: "var(--holo-ink)" }}
              onClick={() => void startOnboarding(platform)}
            >
              <RotateCcwIcon className="size-3" aria-hidden="true" />
              刷新
            </button>
          ) : (
            <span>{mode === "manual" ? "凭据接入" : "扫码接入"}</span>
          )}
        </div>
      </div>
    );
  };

  return (
    <SettingsPageContainer width="wide">
      <section id="remote-im" className="space-y-4">
        <div className="flex flex-wrap items-baseline justify-between gap-2 px-1">
          <h2 className="text-base font-semibold text-foreground">远程连接</h2>
          <p className="text-xs text-muted-foreground" role="status">
            {!desktop
              ? "请在桌面端使用远程连接"
              : available === undefined
                ? "正在读取连接状态…"
                : available
                  ? connections.length > 0
                    ? `已配置 ${connections.length} 个连接`
                    : "选择下方卡片接入你的聊天软件"
                  : "远程连接服务暂不可用"}
          </p>
        </div>

        {error ? (
          <p className="px-1 text-sm text-destructive" role="alert">
            {error}
          </p>
        ) : null}

        <div className="grid grid-cols-1 gap-7 pt-1 pb-4 sm:grid-cols-2 lg:grid-cols-3">
          {REMOTE_IM_CHANNEL_ORDER.map((platform) => {
            const status = resolveChannelStatus(platform, connections);
            const flipped = flippedModes[platform] !== undefined;
            const meta = REMOTE_IM_CHANNELS[platform];
            return (
              <RemoteImHoloCard
                key={platform}
                channel={platform}
                flipped={flipped}
                statusBadge={<StatusPill label={status.label} tone={status.tone} />}
                onFlipQr={() => openQrCard(platform)}
                {...(meta.supportsManual ? { onFlipManual: () => openManualCard(platform) } : {})}
                onFlipFront={() => flipCardToFront(platform)}
                backContent={renderBackFace(platform)}
              />
            );
          })}
        </div>
      </section>

      {connections.length > 0 ? (
        <SettingsSection id="remote-im-connections" title="已配置的连接">
          {connections.map((connection) => {
            const id = connection.id ?? connection.connectionId;
            const lifecycle = connection.lifecycleState ?? "";
            const isPaused =
              connection.paused === true || connection.state === "paused" || connection.status === "paused";
            const state =
              lifecycle === "pairing" ? "pairing" : (connection.state ?? connection.status ?? lifecycle);
            const statusLabel =
              isPaused && state !== "paused"
                ? `${REMOTE_IM_STATE_LABELS[state] ?? state} · ${REMOTE_IM_STATE_LABELS.paused}`
                : (REMOTE_IM_STATE_LABELS[state] ?? state);
            const action = isPaused ? "resume" : "pause";
            return id ? (
              <SettingsRow
                key={id}
                title={connection.name ?? REMOTE_IM_CHANNELS[connection.platform]?.name ?? "远程连接"}
                description={[
                  statusLabel,
                  connection.botName,
                  connection.stateDetail,
                  connection.message,
                  connection.claimCode ? `认领码 ${connection.claimCode}` : undefined,
                ]
                  .filter(Boolean)
                  .join(" · ")}
                control={
                  <div className="flex flex-wrap gap-2">
                    {lifecycle === "pairing" ? (
                      <Button
                        size="sm"
                        variant="outline"
                        disabled={busy}
                        onClick={() => void perform(() => request("connections/claimRefresh", { connectionId: id }))}
                      >
                        刷新认领码
                      </Button>
                    ) : null}
                    <Button
                      size="sm"
                      variant="outline"
                      disabled={busy}
                      onClick={() => void perform(() => request(`connections/${action}`, { connectionId: id }))}
                    >
                      {action === "resume" ? "恢复" : "暂停"}
                    </Button>
                    <Button
                      size="sm"
                      variant="outline"
                      disabled={busy}
                      onClick={() =>
                        void perform(async () => {
                          await request("connections/disconnect", { connectionId: id });
                          if (onboardingsRef.current[connection.platform]?.connectionId === id) {
                            flipCardToFront(connection.platform);
                          }
                        })
                      }
                    >
                      断开
                    </Button>
                  </div>
                }
              />
            ) : null;
          })}
        </SettingsSection>
      ) : null}

      {access.length > 0 ? (
        <SettingsSection id="remote-im-access" title="访问请求">
          {access.map((item) => {
            const target = accessTarget(item);
            if (!target) return null;
            const { targetKind, targetId } = target;
            const id = item.requestId ?? item.id ?? `${targetKind}:${targetId}:${item.platformMsgId ?? ""}`;
            return (
              <SettingsRow
                key={id}
                title={item.name ?? item.chatName ?? item.senderName ?? item.chat?.name ?? "新的访问请求"}
                description="等待批准"
                control={
                  <div className="flex gap-2">
                    <Button
                      size="sm"
                      variant="outline"
                      disabled={busy}
                      onClick={() =>
                        void perform(() => request("access/decide", { targetKind, targetId, decision: "allowed" }))
                      }
                    >
                      允许
                    </Button>
                    <Button
                      size="sm"
                      variant="outline"
                      disabled={busy}
                      onClick={() =>
                        void perform(() => request("access/decide", { targetKind, targetId, decision: "blocked" }))
                      }
                    >
                      拒绝
                    </Button>
                  </div>
                }
              />
            );
          })}
        </SettingsSection>
      ) : null}

      {approvals.length > 0 ? (
        <SettingsSection id="remote-im-approvals" title="操作授权">
          {approvals.map((item) => (
            <SettingsRow
              key={item.id}
              title={item.toolName}
              description={
                <>
                  <span>{item.replyAudience === "group" ? "群聊请求单次授权" : "远程任务请求单次授权"}</span>
                  <pre className="mt-1 max-h-28 overflow-auto whitespace-pre-wrap break-all font-mono text-xs">
                    {item.details}
                  </pre>
                </>
              }
              control={
                <div className="flex gap-2">
                  <Button
                    size="sm"
                    variant="outline"
                    disabled={busy}
                    onClick={() => void perform(() => request("approvals/decide", { id: item.id, approved: true }))}
                  >
                    允许一次
                  </Button>
                  <Button
                    size="sm"
                    variant="outline"
                    disabled={busy}
                    onClick={() => void perform(() => request("approvals/decide", { id: item.id, approved: false }))}
                  >
                    拒绝
                  </Button>
                </div>
              }
            />
          ))}
        </SettingsSection>
      ) : null}
    </SettingsPageContainer>
  );
}
