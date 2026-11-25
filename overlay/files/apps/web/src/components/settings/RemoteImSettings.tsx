import { useEffect, useRef, useState, type FormEvent } from "react";
import { readDesktopPrimaryBearerToken } from "../../environments/primary/desktopAuth";
import { Button } from "../ui/button";
import { Dialog, DialogClose, DialogDescription, DialogFooter, DialogHeader, DialogPopup, DialogTitle } from "../ui/dialog";
import { Input } from "../ui/input";
import { QRCodeSvg } from "../ui/qr-code";
import { SettingsRow, SettingsSection } from "./settingsLayout";

const channels = {
  feishu: { name: "飞书", identifier: "App ID", secret: "App Secret" },
  wecom: { name: "企业微信", identifier: "Bot ID", secret: "Secret" },
  wechat: { name: "个人微信" },
} as const;
type Channel = keyof typeof channels;

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
  claimCode?: string;
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
type Onboarding = {
  platform: Channel;
  id?: string | undefined;
  state: string;
  qr?: string | undefined;
  claim?: string | undefined;
  desktopLink?: string | undefined;
  message?: string | undefined;
};

const labels: Record<string, string> = {
  connecting: "连接中",
  awaiting_approval: "等待授权",
  awaiting_code: "等待验证码",
  needs_code: "等待验证码",
  connected: "已连接",
  reconnecting: "重连中",
  error: "连接失败",
  paused: "已暂停",
  pairing: "等待认领",
};

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

export function applyOnboardingEvent(current: Onboarding, payload: Record<string, unknown>): Onboarding {
  const onboardingId = tokenValue(payload, "onboardingId", "sessionId", "id");
  const platform = tokenValue(payload, "platform", "channel");
  if ((current.id && onboardingId && current.id !== onboardingId) || (platform && platform !== current.platform)) return current;
  const event = payload.event && typeof payload.event === "object" && !Array.isArray(payload.event)
    ? payload.event as Record<string, unknown>
    : payload;
  const state = tokenValue(event, "lifecycleState", "state", "status", "type", "kind") ?? current.state;
  const qr = tokenValue(event, "qrContent", "qr", "qrUrl", "url", "qrCode", "qrcode");
  const desktopLink = tokenValue(event, "desktopLink", "verificationUri");
  const claim = tokenValue(event, "claimCode", "pairingCode", ...(state === "pairing" ? ["code"] : []));
  const message = tokenValue(event, "message", "error");
  return {
    ...current,
    id: current.id ?? onboardingId,
    state,
    qr: qr ?? current.qr,
    claim: claim && /^\d{6}$/u.test(claim) ? claim : current.claim,
    desktopLink: desktopLink ?? current.desktopLink,
    message: message ?? current.message,
  };
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

export function RemoteImSettings() {
  const [connections, setConnections] = useState<Connection[]>([]);
  const [access, setAccess] = useState<Access[]>([]);
  const [approvals, setApprovals] = useState<Approval[]>([]);
  const [available, setAvailable] = useState<boolean>();
  const [error, setError] = useState("");
  const [busy, setBusy] = useState(false);
  const [onboarding, setOnboarding] = useState<Onboarding>();
  const [manual, setManual] = useState(false);
  const cursor = useRef(0);

  async function refresh(signal?: AbortSignal) {
    const status = await request("status", undefined, signal) as { state?: string; lifecycle?: string };
    const statusState = status.state ?? status.lifecycle;
    const online = statusState !== "starting" && statusState !== "unavailable";
    setAvailable(online);
    if (!online) return;
    const [items, requests, permissions, notifications] = await Promise.all([
      request("connections", undefined, signal),
      request("access", undefined, signal),
      request("approvals", undefined, signal),
      request(`onboarding/events?after=${cursor.current}`, undefined, signal),
    ]);
    setConnections(collection(items, "connections"));
    const held = collection<Access>(requests, "held");
    setAccess((held.length > 0 ? held : collection<Access>(requests, "requests"))
      .filter((item) => (item.status ?? item.state ?? "held") === "held"));
    setApprovals(collection(permissions, "approvals"));
    for (const { sequence, event, payload } of collection<Event>(notifications, "events")) {
      cursor.current = Math.max(sequence, cursor.current);
      if (event === "onboarding.event") setOnboarding((current) => current && applyOnboardingEvent(current, payload));
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
      } catch (cause) {
        if (!controller.signal.aborted) setError(cause instanceof Error ? cause.message : "远程连接暂不可用。");
      } finally {
        if (!controller.signal.aborted) timer = setTimeout(() => void poll(), 2000);
      }
    };
    void poll();
    return () => {
      controller.abort();
      clearTimeout(timer);
    };
  }, [desktop]);

  async function perform(action: () => Promise<unknown>) {
    setBusy(true);
    setError("");
    try {
      await action();
      await refresh();
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : "操作失败，请重试。");
    } finally {
      setBusy(false);
    }
  }

  function start(platform: Channel, credentials?: Record<string, string>) {
    setOnboarding({ platform, state: "connecting" });
    return perform(async () => {
      const value = await request("onboarding/start", {
        platform,
        mode: credentials ? "credentials" : "qr",
        ...(credentials ? { credentials } : {}),
      });
      if (value && typeof value === "object") {
        setOnboarding((current) => current && applyOnboardingEvent(current, value as Record<string, unknown>));
      }
    });
  }

  function submitCredentials(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    if (!onboarding || onboarding.platform === "wechat") return;
    const form = new FormData(event.currentTarget);
    const identifier = String(form.get("identifier") ?? "").trim();
    const secret = String(form.get("secret") ?? "");
    if (!identifier || !secret) return;
    const credentials = onboarding.platform === "feishu"
      ? { appId: identifier, appSecret: secret }
      : { botId: identifier, secret };
    event.currentTarget.reset();
    setManual(false);
    void start(onboarding.platform, credentials);
  }

  function submitCode(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    if (!onboarding?.id) return;
    const code = String(new FormData(event.currentTarget).get("code") ?? "").trim();
    event.currentTarget.reset();
    void perform(() => request("onboarding/submitCode", { sessionId: onboarding.id, code }));
  }

  function close() {
    if (onboarding?.id && !["connected", "complete", "success", "succeeded", "pairing"].includes(onboarding.state)) {
      void perform(() => request("onboarding/cancel", { sessionId: onboarding.id }));
    }
    setOnboarding(undefined);
    setManual(false);
  }

  const credentialChannel = onboarding && onboarding.platform !== "wechat" ? channels[onboarding.platform] : undefined;

  if (!desktop) return null;
  return (
    <SettingsSection id="remote-im" title="远程连接">
      <p className="px-3 py-2 text-sm text-muted-foreground" role="status">
        {available === undefined ? "正在读取连接状态…" : available
          ? connections.length > 0 ? `已配置 ${connections.length} 个连接` : "暂无连接。选择一个渠道接入助手。"
          : "远程连接服务暂不可用。"}
      </p>
      {error && !onboarding ? <p className="px-3 py-2 text-sm text-destructive" role="alert">{error}</p> : null}
      {(Object.keys(channels) as Channel[]).map((platform) => (
        <SettingsRow key={platform} title={channels[platform].name} control={
          <Button size="sm" variant="outline" disabled={busy || !available} onClick={() => {
            setManual(false);
            setOnboarding({ platform, state: "choose" });
          }}>连接</Button>
        } />
      ))}
      {connections.map((connection) => {
        const id = connection.id ?? connection.connectionId;
        const lifecycle = connection.lifecycleState ?? "";
        const isPaused = connection.paused === true || connection.state === "paused" || connection.status === "paused";
        const state = lifecycle === "pairing" ? "pairing" : connection.state ?? connection.status ?? lifecycle;
        const statusLabel = isPaused && state !== "paused"
          ? `${labels[state] ?? state} · ${labels.paused}`
          : labels[state] ?? state;
        const action = isPaused ? "resume" : "pause";
        return id ? <SettingsRow key={id} title={connection.name ?? channels[connection.platform]?.name ?? "远程连接"}
          description={[statusLabel, connection.botName, connection.stateDetail, connection.message,
            connection.claimCode ? `认领码 ${connection.claimCode}` : undefined].filter(Boolean).join(" · ")}
          control={<div className="flex flex-wrap gap-2">
            {lifecycle === "pairing" ? <Button size="sm" variant="outline" disabled={busy}
              onClick={() => void perform(() => request("connections/claimRefresh", { connectionId: id }))}>刷新认领码</Button> : null}
            <Button size="sm" variant="outline" disabled={busy}
              onClick={() => void perform(() => request(`connections/${action}`, { connectionId: id }))}>
              {action === "resume" ? "恢复" : "暂停"}
            </Button>
            <Button size="sm" variant="outline" disabled={busy}
              onClick={() => void perform(() => request("connections/disconnect", { connectionId: id }))}>断开</Button>
          </div>} /> : null;
      })}
      {access.map((item) => {
        const target = accessTarget(item);
        if (!target) return null;
        const { targetKind, targetId } = target;
        const id = item.requestId ?? item.id ?? `${targetKind}:${targetId}:${item.platformMsgId ?? ""}`;
        return <SettingsRow key={id} title={item.name ?? item.chatName ?? item.senderName ?? item.chat?.name ?? "新的访问请求"}
          description="等待批准"
          control={<div className="flex gap-2">
            <Button size="sm" variant="outline" disabled={busy}
              onClick={() => void perform(() => request("access/decide", { targetKind, targetId, decision: "allowed" }))}>允许</Button>
            <Button size="sm" variant="outline" disabled={busy}
              onClick={() => void perform(() => request("access/decide", { targetKind, targetId, decision: "blocked" }))}>拒绝</Button>
          </div>} />;
      })}
      {approvals.map((item) => <SettingsRow key={item.id} title={item.toolName}
        description={<><span>{item.replyAudience === "group" ? "群聊请求单次授权" : "远程任务请求单次授权"}</span>
          <pre className="mt-1 max-h-28 overflow-auto whitespace-pre-wrap break-all font-mono text-xs">{item.details}</pre></>}
        control={<div className="flex gap-2">
          <Button size="sm" variant="outline" disabled={busy}
            onClick={() => void perform(() => request("approvals/decide", { id: item.id, approved: true }))}>允许一次</Button>
          <Button size="sm" variant="outline" disabled={busy}
            onClick={() => void perform(() => request("approvals/decide", { id: item.id, approved: false }))}>拒绝</Button>
        </div>} />)}
      <Dialog open={onboarding !== undefined} onOpenChange={(open) => { if (!open) close(); }}>
        {onboarding ? <DialogPopup>
          <DialogHeader>
            <DialogTitle>连接{channels[onboarding.platform].name}</DialogTitle>
            <DialogDescription>{onboarding.state === "choose" ? "选择一种连接方式。" : labels[onboarding.state] ?? "请在手机上完成连接。"}</DialogDescription>
          </DialogHeader>
          {error ? <p className="text-sm text-destructive" role="alert">{error}</p> : null}
          {onboarding.message ? <p className="text-sm text-muted-foreground" role="status">{onboarding.message}</p> : null}
          {manual && credentialChannel ? (
            <form className="grid gap-3" onSubmit={submitCredentials}>
              <label className="grid gap-1 text-sm">{credentialChannel.identifier}<Input name="identifier" required /></label>
              <label className="grid gap-1 text-sm">{credentialChannel.secret}<Input name="secret" type="password" required /></label>
              <Button disabled={busy} type="submit">连接</Button>
            </form>
          ) : null}
          {!manual && onboarding.state === "choose" ? <div className="flex flex-wrap gap-2">
            <Button disabled={busy} onClick={() => void start(onboarding.platform)}>扫码连接</Button>
            {credentialChannel ? <Button variant="outline" onClick={() => setManual(true)}>填写凭据</Button> : null}
          </div> : null}
          {onboarding.claim ? <div className="grid gap-2 text-sm">
            <p>在{channels[onboarding.platform].name}里私聊机器人，发送下方认领码。</p>
            <output className="font-mono text-2xl font-semibold tracking-widest">{onboarding.claim}</output>
          </div> : onboarding.qr && !["connected", "complete", "success", "succeeded"].includes(onboarding.state) ?
            <div className="grid gap-2">
              <QRCodeSvg className="mx-auto" size={192} marginSize={4} title="连接二维码" value={onboarding.qr} />
              {(onboarding.desktopLink ?? onboarding.qr).startsWith("http") ?
                <a className="break-all text-center text-sm underline" href={onboarding.desktopLink ?? onboarding.qr} target="_blank" rel="noreferrer">
                  {onboarding.desktopLink ?? onboarding.qr}
                </a> : null}
            </div> : null}
          {["awaiting_code", "needs_code", "code", "pin", "verify"].includes(onboarding.state) ? (
            <form className="flex items-end gap-2" onSubmit={submitCode}>
              <label className="grid flex-1 gap-1 text-sm">手机验证码<Input name="code" inputMode="numeric" required /></label>
              <Button disabled={busy} type="submit">提交</Button>
            </form>
          ) : null}
          <DialogFooter><DialogClose render={<Button variant="outline">关闭</Button>} /></DialogFooter>
        </DialogPopup> : null}
      </Dialog>
    </SettingsSection>
  );
}
