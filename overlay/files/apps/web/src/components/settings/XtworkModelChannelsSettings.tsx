// @effect-diagnostics extendsNativeError:off
import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import {
  AlertTriangleIcon,
  Building2Icon,
  CheckCircle2Icon,
  CopyIcon,
  CpuIcon,
  ExternalLinkIcon,
  GaugeIcon,
  KeyRoundIcon,
  Loader2Icon,
  LockIcon,
  LogOutIcon,
  PencilIcon,
  PlusIcon,
  RefreshCwIcon,
  SearchIcon,
  ShieldCheckIcon,
  SparklesIcon,
  Trash2Icon,
  ZapIcon,
} from "lucide-react";
import { readDesktopPrimaryBearerToken } from "../../environments/primary/desktopAuth";
import {
  AlertDialog,
  AlertDialogClose,
  AlertDialogDescription,
  AlertDialogFooter,
  AlertDialogHeader,
  AlertDialogPopup,
  AlertDialogTitle,
} from "../ui/alert-dialog";
import { Badge } from "../ui/badge";
import { Button } from "../ui/button";
import {
  Dialog,
  DialogClose,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogPanel,
  DialogPopup,
  DialogTitle,
} from "../ui/dialog";
import { Input } from "../ui/input";
import { QRCodeSvg } from "../ui/qr-code";
import { Switch } from "../ui/switch";
import { SettingsPageContainer, SettingsRow, SettingsSection } from "./settingsLayout";

// ============================================================================
// Redacted API payload contracts (ZERO plaintext credentials ever returned)
// ============================================================================

export type ProviderCategory = "company" | "api" | "oauth" | "custom";
export type OAuthProviderId = "openai-codex" | "github-copilot" | "xai";

export interface ProviderCapabilitySpecView {
  readonly type: string;
  readonly labelZh: string;
  readonly labelEn: string;
  readonly category: ProviderCategory;
  readonly selectable: boolean;
  readonly api: string;
  readonly defaultBaseUrl: string;
  readonly urlMode: "base" | "full-endpoint" | "oauth-managed";
  readonly authMode: string;
  readonly requiresCodingPlanUserAgent: boolean;
  readonly supportsFetchModels: boolean;
  readonly supportsPlanQuota: boolean;
  readonly oauthProvider?: OAuthProviderId;
  readonly verificationTier: string;
  readonly verificationNote: string;
  readonly presetModels: ReadonlyArray<{
    readonly id: string;
    readonly name: string;
    readonly enabled: boolean;
  }>;
}

export interface ChannelModelView {
  readonly id: string;
  readonly name: string;
  readonly enabled: boolean;
  readonly source?: "manual" | "fetched" | "preset";
}

export interface RedactedChannelView {
  readonly id: string;
  readonly name: string;
  readonly provider: string;
  readonly baseUrl: string;
  readonly enabled: boolean;
  readonly models: ReadonlyArray<ChannelModelView>;
  readonly hasCredentials: boolean;
  readonly isTeamChannel: boolean;
  readonly immutableFields: ReadonlyArray<string>;
  readonly enterpriseUrl?: string;
  readonly availableModelIds?: ReadonlyArray<string>;
  readonly accountLabel?: string;
  readonly createdAt: number;
  readonly updatedAt: number;
}

export interface CompanyAuthStateView {
  readonly revision: number;
  readonly phase: "signed-out" | "waiting" | "connecting" | "signed-in";
  readonly member?: {
    readonly subject: string;
    readonly name: string;
    readonly userId: number;
    readonly username: string;
  };
  readonly authUrl?: string;
  readonly error?: string;
}

export interface OAuthLoginSessionView {
  readonly sessionId: string;
  readonly provider: OAuthProviderId;
  readonly channelId?: string;
  readonly channelName?: string;
  readonly method: "browser" | "device_code";
  readonly phase: "starting" | "awaiting_user" | "exchanging" | "succeeded" | "failed" | "cancelled";
  readonly authUrl?: string;
  readonly userCode?: string;
  readonly verificationUri?: string;
  readonly manualCallbackSupported?: boolean;
  readonly accountLabel?: string;
  readonly availableModelCount?: number;
  readonly error?: string;
  readonly updatedAt: number;
}

export interface ModelChannelsStateView {
  readonly catalogVersion: string;
  readonly catalog: ReadonlyArray<ProviderCapabilitySpecView>;
  readonly channels: ReadonlyArray<RedactedChannelView>;
  readonly companyAuth: CompanyAuthStateView;
  readonly oauthSessions: ReadonlyArray<OAuthLoginSessionView>;
  readonly defaultModelSlug: string | null;
  readonly zeroChannelState: boolean;
  readonly enabledModelCount: number;
}

export interface ChannelTestResultView {
  readonly success: boolean;
  readonly message: string;
  readonly errorType?: string;
  readonly statusCode?: number;
}

export interface ChannelPlanQuotaWindowView {
  readonly type: string;
  readonly label: string;
  readonly remainingPercent: number;
  readonly usedPercent: number;
  readonly resetAt?: number;
  readonly remainingLabel?: string;
  readonly showProgress?: boolean;
}

export interface ChannelPlanQuotaView {
  readonly supported: boolean;
  readonly provider: string;
  readonly planName?: string;
  readonly windows: ReadonlyArray<ChannelPlanQuotaWindowView>;
  readonly updatedAt: number;
  readonly message?: string;
  readonly error?: string;
}

class ChannelsApiError extends Error {
  readonly status: number;
  readonly code: string | undefined;
  constructor(message: string, status: number, code?: string) {
    super(message);
    this.status = status;
    this.code = code;
  }
}

async function channelsApi<T>(
  path: string,
  options: {
    readonly method?: "GET" | "POST";
    readonly body?: unknown;
    readonly signal?: AbortSignal;
  } = {},
): Promise<T> {
  const token = await readDesktopPrimaryBearerToken();
  const headers: Record<string, string> = {};
  if (token) headers.Authorization = `Bearer ${token}`;
  if (options.body !== undefined) headers["Content-Type"] = "application/json";
  const resp = await fetch(`/api/xtwork/channels/${path}`, {
    method: options.method ?? "GET",
    headers,
    ...(options.body !== undefined ? { body: JSON.stringify(options.body) } : {}),
    ...(options.signal ? { signal: options.signal } : {}),
  });
  const payload = (await resp.json().catch(() => ({}))) as Record<string, unknown>;
  if (!resp.ok) {
    throw new ChannelsApiError(
      typeof payload.error === "string" ? payload.error : `请求失败 (HTTP ${resp.status})`,
      resp.status,
      typeof payload.code === "string" ? payload.code : undefined,
    );
  }
  return payload as T;
}

function openExternalUrl(url: string): void {
  const bridge = window.desktopBridge;
  if (bridge && typeof bridge.openExternal === "function") {
    void bridge.openExternal(url);
    return;
  }
  window.open(url, "_blank", "noopener,noreferrer");
}

function revealDesktopWindow(): void {
  const bridge = window.desktopBridge;
  if (bridge && typeof bridge.revealWindow === "function") {
    void bridge.revealWindow();
  }
}

function formatProtocolBadge(api: string): string {
  switch (api) {
    case "anthropic-messages":
      return "Anthropic";
    case "openai-completions":
      return "OpenAI Chat";
    case "openai-responses":
      return "OpenAI Responses";
    case "openai-codex-responses":
      return "Codex OAuth";
    case "google-generative-ai":
      return "Gemini";
    default:
      return api;
  }
}

function formatResetTime(ts?: number): string | undefined {
  if (!ts) return undefined;
  try {
    return new Date(ts).toLocaleString("zh-CN", {
      month: "numeric",
      day: "numeric",
      hour: "2-digit",
      minute: "2-digit",
    });
  } catch {
    return undefined;
  }
}

interface ChannelFormDraft {
  readonly mode: "create" | "edit";
  readonly channelId?: string;
  readonly hasCredentials: boolean;
  readonly name: string;
  readonly provider: string;
  readonly baseUrl: string;
  readonly apiKey: string;
  readonly zhipuOrg: string;
  readonly zhipuProject: string;
  readonly enterpriseUrl: string;
  readonly enabled: boolean;
  readonly models: ReadonlyArray<ChannelModelView>;
}

export function XtworkModelChannelsSettings() {
  const [state, setState] = useState<ModelChannelsStateView | null>(null);
  const [loading, setLoading] = useState(true);
  const [loadError, setLoadError] = useState<string | null>(null);

  // Company login state
  const [companyBusy, setCompanyBusy] = useState(false);
  const [companyNotice, setCompanyNotice] = useState<string | null>(null);
  const [companyError, setCompanyError] = useState<string | null>(null);
  const [companyPortConflict, setCompanyPortConflict] = useState(false);
  const [companyLogoutOpen, setCompanyLogoutOpen] = useState(false);
  const prevCompanyPhaseRef = useRef<string | undefined>(undefined);

  // Per-channel transient UI states (test results, quota, busy indicators)
  const [testResults, setTestResults] = useState<Record<string, ChannelTestResultView>>({});
  const [testingId, setTestingId] = useState<string | null>(null);
  const [quotas, setQuotas] = useState<Record<string, ChannelPlanQuotaView>>({});
  const [quotaLoadingId, setQuotaLoadingId] = useState<string | null>(null);
  const [channelActionError, setChannelActionError] = useState<string | null>(null);
  const [deleteTarget, setDeleteTarget] = useState<RedactedChannelView | null>(null);
  const [deleteBusy, setDeleteBusy] = useState(false);

  // Add/Edit channel dialog state
  const [formOpen, setFormOpen] = useState(false);
  const [draft, setDraft] = useState<ChannelFormDraft | null>(null);
  const [formSaving, setFormSaving] = useState(false);
  const [formTesting, setFormTesting] = useState(false);
  const [formFetching, setFormFetching] = useState(false);
  const [formTestResult, setFormTestResult] = useState<ChannelTestResultView | null>(null);
  const [formError, setFormError] = useState<string | null>(null);
  const [modelSearch, setModelSearch] = useState("");
  const [customModelId, setCustomModelId] = useState("");

  // OAuth subscription dialog state
  const [oauthDialogOpen, setOauthDialogOpen] = useState(false);
  const [oauthProvider, setOauthProvider] = useState<OAuthProviderId>("openai-codex");
  const [oauthTargetChannelId, setOauthTargetChannelId] = useState<string | undefined>(undefined);
  const [oauthCodexMethod, setOauthCodexMethod] = useState<"browser" | "device_code">("browser");
  const [oauthEnterpriseUrl, setOauthEnterpriseUrl] = useState("");
  const [oauthSession, setOauthSession] = useState<OAuthLoginSessionView | null>(null);
  const [oauthManualInput, setOauthManualInput] = useState("");
  const [oauthStarting, setOauthStarting] = useState(false);
  const [oauthError, setOauthError] = useState<string | null>(null);
  const [copiedCode, setCopiedCode] = useState(false);

  const loadSeqRef = useRef(0);
  const loadAbortRef = useRef<AbortController | null>(null);

  const applyAuthoritativeState = useCallback((next: ModelChannelsStateView) => {
    loadSeqRef.current += 1;
    loadAbortRef.current?.abort();
    loadAbortRef.current = null;
    prevCompanyPhaseRef.current = next.companyAuth.phase;
    setState(next);
    setLoadError(null);
  }, []);

  const applyAuthoritativeCompanyAuth = useCallback((nextCompanyAuth: CompanyAuthStateView) => {
    loadSeqRef.current += 1;
    loadAbortRef.current?.abort();
    loadAbortRef.current = null;
    prevCompanyPhaseRef.current = nextCompanyAuth.phase;
    setState((prev) => (prev ? { ...prev, companyAuth: nextCompanyAuth } : prev));
  }, []);

  const loadState = useCallback(async (silent = false) => {
    const seq = ++loadSeqRef.current;
    loadAbortRef.current?.abort();
    const controller = new AbortController();
    loadAbortRef.current = controller;

    if (!silent) setLoading(true);
    try {
      const next = await channelsApi<ModelChannelsStateView>("state", {
        signal: controller.signal,
      });
      // Ignore superseded / out-of-order responses so slow polls never overwrite newer state.
      if (seq !== loadSeqRef.current) return;
      setState(next);
      setLoadError(null);
      const prevPhase = prevCompanyPhaseRef.current;
      prevCompanyPhaseRef.current = next.companyAuth.phase;
      if (
        (prevPhase === "waiting" || prevPhase === "connecting") &&
        next.companyAuth.phase === "signed-in"
      ) {
        revealDesktopWindow();
        setCompanyNotice("企业微信登录成功，已自动同步公司团队模型。");
        setCompanyError(null);
        setCompanyPortConflict(false);
      }
      if (next.companyAuth.error && next.companyAuth.phase !== "waiting") {
        setCompanyError(next.companyAuth.error);
      }
    } catch (error) {
      if (seq !== loadSeqRef.current || controller.signal.aborted) return;
      if (!silent) {
        setLoadError(error instanceof Error ? error.message : "加载模型渠道配置失败");
      }
    } finally {
      if (seq === loadSeqRef.current) {
        if (loadAbortRef.current === controller) {
          loadAbortRef.current = null;
        }
        if (!silent) setLoading(false);
      }
    }
  }, []);

  useEffect(() => {
    void loadState(false);
    return () => {
      loadSeqRef.current += 1;
      loadAbortRef.current?.abort();
      loadAbortRef.current = null;
    };
  }, [loadState]);

  // Poll while company login is in progress
  const companyPhase = state?.companyAuth.phase;
  useEffect(() => {
    if (companyPhase !== "waiting" && companyPhase !== "connecting") return;
    const timer = window.setInterval(() => {
      void loadState(true);
    }, 1200);
    return () => window.clearInterval(timer);
  }, [companyPhase, loadState]);

  // Poll while an OAuth subscription login session is in progress
  useEffect(() => {
    if (
      !oauthSession ||
      (oauthSession.phase !== "starting" &&
        oauthSession.phase !== "awaiting_user" &&
        oauthSession.phase !== "exchanging")
    ) {
      return;
    }
    const timer = window.setInterval(() => {
      void (async () => {
        try {
          const res = await channelsApi<{ readonly session: OAuthLoginSessionView }>(
            `oauth/status?sessionId=${encodeURIComponent(oauthSession.sessionId)}`,
          );
          setOauthSession(res.session);
          if (res.session.phase === "succeeded") {
            revealDesktopWindow();
            await loadState(true);
          } else if (res.session.phase === "failed") {
            setOauthError(res.session.error ?? "OAuth 订阅登录失败，请重试。");
          }
        } catch {
          // ignore transient poll hiccup
        }
      })();
    }, 1000);
    return () => window.clearInterval(timer);
  }, [oauthSession, loadState]);

  const catalogByType = useMemo(() => {
    const map = new Map<string, ProviderCapabilitySpecView>();
    for (const item of state?.catalog ?? []) {
      map.set(item.type, item);
    }
    return map;
  }, [state?.catalog]);

  const selectableProviders = useMemo(
    () => (state?.catalog ?? []).filter((spec) => spec.selectable && spec.category !== "company"),
    [state?.catalog],
  );

  const teamChannel = useMemo(
    () => state?.channels.find((ch) => ch.isTeamChannel) ?? null,
    [state?.channels],
  );
  const memberChannels = useMemo(
    () => (state?.channels ?? []).filter((ch) => !ch.isTeamChannel),
    [state?.channels],
  );

  // ============================================================================
  // Company WeCom Actions
  // ============================================================================

  const handleStartCompanyLogin = async () => {
    setCompanyBusy(true);
    setCompanyError(null);
    setCompanyNotice(null);
    setCompanyPortConflict(false);
    try {
      const res = await channelsApi<{
        readonly state: CompanyAuthStateView;
        readonly authUrl: string;
      }>("company/login", { method: "POST", body: {} });
      applyAuthoritativeCompanyAuth(res.state);
      openExternalUrl(res.authUrl);
    } catch (error) {
      const isConflict =
        error instanceof ChannelsApiError &&
        (error.code === "CALLBACK_PORT_IN_USE" || error.status === 409);
      setCompanyPortConflict(isConflict);
      setCompanyError(error instanceof Error ? error.message : "启动企业微信登录失败");
    } finally {
      setCompanyBusy(false);
    }
  };

  const handleCancelCompanyLogin = async () => {
    setCompanyBusy(true);
    try {
      const res = await channelsApi<{ readonly companyAuth: CompanyAuthStateView }>(
        "company/cancel",
        { method: "POST", body: {} },
      );
      applyAuthoritativeCompanyAuth(res.companyAuth);
      setCompanyError(null);
    } finally {
      setCompanyBusy(false);
    }
  };

  const handleSyncCompanyModels = async () => {
    setCompanyBusy(true);
    setCompanyError(null);
    setCompanyNotice(null);
    try {
      const res = await channelsApi<{
        readonly state: ModelChannelsStateView;
        readonly models: ReadonlyArray<ChannelModelView>;
      }>("company/sync", { method: "POST", body: { selectDefault: false } });
      applyAuthoritativeState(res.state);
      if (res.state.companyAuth.error) {
        setCompanyError(res.state.companyAuth.error);
      } else {
        setCompanyNotice(`已同步 ${res.models.length} 个公司团队模型。`);
      }
    } catch (error) {
      setCompanyError(error instanceof Error ? error.message : "同步公司模型失败");
    } finally {
      setCompanyBusy(false);
    }
  };

  const handleConfirmCompanyLogout = async () => {
    setCompanyBusy(true);
    setCompanyError(null);
    setCompanyNotice(null);
    try {
      const res = await channelsApi<{ readonly state: ModelChannelsStateView }>("company/logout", {
        method: "POST",
        body: {},
      });
      applyAuthoritativeState(res.state);
      setCompanyLogoutOpen(false);
      setCompanyNotice("已清除本机公司登录凭据并断开公司团队渠道。");
    } catch (error) {
      setCompanyError(error instanceof Error ? error.message : "退出公司登录失败");
      setCompanyLogoutOpen(false);
    } finally {
      setCompanyBusy(false);
    }
  };

  // ============================================================================
  // Channel Quick Actions (Toggle, Test, Quota, Delete, OAuth Logout)
  // ============================================================================

  const handleToggleChannelEnabled = async (channel: RedactedChannelView, enabled: boolean) => {
    setChannelActionError(null);
    try {
      const res = await channelsApi<{ readonly state: ModelChannelsStateView }>("update", {
        method: "POST",
        body: { id: channel.id, enabled },
      });
      applyAuthoritativeState(res.state);
    } catch (error) {
      setChannelActionError(error instanceof Error ? error.message : "更新渠道状态失败");
    }
  };

  const handleToggleChannelModel = async (
    channel: RedactedChannelView,
    modelId: string,
    enabled: boolean,
  ) => {
    setChannelActionError(null);
    const nextModels = channel.models.map((m) => (m.id === modelId ? { ...m, enabled } : m));
    try {
      const res = await channelsApi<{ readonly state: ModelChannelsStateView }>("update", {
        method: "POST",
        body: { id: channel.id, models: nextModels },
      });
      applyAuthoritativeState(res.state);
    } catch (error) {
      setChannelActionError(error instanceof Error ? error.message : "更新模型启用状态失败");
    }
  };

  const handleTestChannel = async (channel: RedactedChannelView) => {
    setTestingId(channel.id);
    setChannelActionError(null);
    try {
      const res = await channelsApi<ChannelTestResultView>("test", {
        method: "POST",
        body: { id: channel.id },
      });
      setTestResults((prev) => ({ ...prev, [channel.id]: res }));
    } catch (error) {
      setTestResults((prev) => ({
        ...prev,
        [channel.id]: {
          success: false,
          message: error instanceof Error ? error.message : "连接测试失败",
        },
      }));
    } finally {
      setTestingId(null);
    }
  };

  const handleQueryQuota = async (channel: RedactedChannelView) => {
    setQuotaLoadingId(channel.id);
    try {
      const res = await channelsApi<{ readonly quota: ChannelPlanQuotaView }>("quota", {
        method: "POST",
        body: { id: channel.id },
      });
      setQuotas((prev) => ({ ...prev, [channel.id]: res.quota }));
    } catch (error) {
      setQuotas((prev) => ({
        ...prev,
        [channel.id]: {
          supported: false,
          provider: channel.provider,
          windows: [],
          updatedAt: Date.now(),
          error: error instanceof Error ? error.message : "查询额度失败",
        },
      }));
    } finally {
      setQuotaLoadingId(null);
    }
  };

  const handleConfirmDeleteChannel = async () => {
    if (!deleteTarget) return;
    setDeleteBusy(true);
    setChannelActionError(null);
    try {
      const res = await channelsApi<{ readonly state: ModelChannelsStateView }>("delete", {
        method: "POST",
        body: { id: deleteTarget.id },
      });
      applyAuthoritativeState(res.state);
      setDeleteTarget(null);
    } catch (error) {
      setChannelActionError(error instanceof Error ? error.message : "删除渠道失败");
      setDeleteTarget(null);
    } finally {
      setDeleteBusy(false);
    }
  };

  const handleLogoutOAuthChannel = async (channel: RedactedChannelView) => {
    setChannelActionError(null);
    try {
      const res = await channelsApi<{ readonly state: ModelChannelsStateView }>("oauth/logout", {
        method: "POST",
        body: { id: channel.id },
      });
      applyAuthoritativeState(res.state);
    } catch (error) {
      setChannelActionError(error instanceof Error ? error.message : "退出订阅登录失败");
    }
  };

  // ============================================================================
  // Add / Edit Member Channel Form Dialog
  // ============================================================================

  const openCreateDialog = (initialProvider = "anthropic") => {
    const spec = catalogByType.get(initialProvider) ?? selectableProviders[0];
    const providerType = spec?.type ?? initialProvider;
    setDraft({
      mode: "create",
      hasCredentials: false,
      name: spec?.labelZh ?? "",
      provider: providerType,
      baseUrl: spec?.defaultBaseUrl ?? "",
      apiKey: "",
      zhipuOrg: "",
      zhipuProject: "",
      enterpriseUrl: "",
      enabled: true,
      models: (spec?.presetModels ?? []).map((m) => ({
        id: m.id,
        name: m.name,
        enabled: m.enabled,
        source: "preset",
      })),
    });
    setFormTestResult(null);
    setFormError(null);
    setModelSearch("");
    setCustomModelId("");
    setFormOpen(true);
  };

  const openEditDialog = (channel: RedactedChannelView) => {
    setDraft({
      mode: "edit",
      channelId: channel.id,
      hasCredentials: channel.hasCredentials,
      name: channel.name,
      provider: channel.provider,
      baseUrl: channel.baseUrl,
      apiKey: "", // Write-only: NEVER pre-filled from backend!
      zhipuOrg: "",
      zhipuProject: "",
      enterpriseUrl: channel.enterpriseUrl ?? "",
      enabled: channel.enabled,
      models: channel.models.map((m) => ({ ...m })),
    });
    setFormTestResult(null);
    setFormError(null);
    setModelSearch("");
    setCustomModelId("");
    setFormOpen(true);
  };

  const handleDraftProviderChange = (nextProvider: string) => {
    if (!draft) return;
    const spec = catalogByType.get(nextProvider);
    const prevSpec = catalogByType.get(draft.provider);
    const shouldReplaceName = !draft.name.trim() || draft.name === prevSpec?.labelZh;
    setDraft({
      ...draft,
      provider: nextProvider,
      name: shouldReplaceName ? (spec?.labelZh ?? nextProvider) : draft.name,
      baseUrl: spec?.defaultBaseUrl ?? "",
      models: (spec?.presetModels ?? []).map((m) => ({
        id: m.id,
        name: m.name,
        enabled: m.enabled,
        source: "preset",
      })),
    });
    setFormTestResult(null);
    setFormError(null);
  };

  const buildCredentialPayload = (d: ChannelFormDraft) => {
    if (d.provider === "zhipu-coding-team") {
      if (!d.apiKey.trim()) return {};
      return {
        zhipuTeam: {
          apiKey: d.apiKey.trim(),
          ...(d.zhipuOrg.trim() ? { organization: d.zhipuOrg.trim() } : {}),
          ...(d.zhipuProject.trim() ? { project: d.zhipuProject.trim() } : {}),
        },
      };
    }
    return d.apiKey.trim() ? { apiKey: d.apiKey.trim() } : {};
  };

  const handleFormTestConnection = async () => {
    if (!draft) return;
    setFormTesting(true);
    setFormTestResult(null);
    setFormError(null);
    try {
      const res = await channelsApi<ChannelTestResultView>("test", {
        method: "POST",
        body: {
          ...(draft.channelId ? { channelId: draft.channelId } : {}),
          provider: draft.provider,
          baseUrl: draft.baseUrl,
          models: draft.models,
          ...buildCredentialPayload(draft),
        },
      });
      setFormTestResult(res);
    } catch (error) {
      setFormTestResult({
        success: false,
        message: error instanceof Error ? error.message : "连接测试失败",
      });
    } finally {
      setFormTesting(false);
    }
  };

  const handleFormFetchModels = async () => {
    if (!draft) return;
    setFormFetching(true);
    setFormError(null);
    try {
      const res = await channelsApi<{
        readonly success: boolean;
        readonly message: string;
        readonly models: ReadonlyArray<ChannelModelView>;
      }>("fetch-models", {
        method: "POST",
        body: {
          ...(draft.channelId ? { channelId: draft.channelId } : {}),
          provider: draft.provider,
          baseUrl: draft.baseUrl,
          ...buildCredentialPayload(draft),
        },
      });
      if (!res.success) {
        setFormError(res.message);
        return;
      }
      const existingEnabled = new Map(draft.models.map((m) => [m.id, m.enabled]));
      const merged: ChannelModelView[] = res.models.map((m, idx) => ({
        ...m,
        enabled: existingEnabled.has(m.id)
          ? Boolean(existingEnabled.get(m.id))
          : m.enabled || (existingEnabled.size === 0 && idx === 0),
      }));
      // Preserve any manual custom models
      for (const m of draft.models) {
        if (m.source === "manual" && !merged.some((item) => item.id === m.id)) {
          merged.push(m);
        }
      }
      setDraft({ ...draft, models: merged });
      setFormTestResult({ success: true, message: res.message });
    } catch (error) {
      setFormError(error instanceof Error ? error.message : "拉取模型列表失败");
    } finally {
      setFormFetching(false);
    }
  };

  const handleAddCustomModel = () => {
    if (!draft) return;
    const id = customModelId.trim();
    if (!id) return;
    if (draft.models.some((m) => m.id.toLowerCase() === id.toLowerCase())) {
      setCustomModelId("");
      return;
    }
    setDraft({
      ...draft,
      models: [{ id, name: id, enabled: true, source: "manual" }, ...draft.models],
    });
    setCustomModelId("");
  };

  const handleSaveForm = async () => {
    if (!draft) return;
    setFormSaving(true);
    setFormError(null);
    try {
      const payload = {
        ...(draft.channelId ? { id: draft.channelId } : {}),
        name: draft.name.trim(),
        provider: draft.provider,
        baseUrl: draft.baseUrl.trim(),
        enabled: draft.enabled,
        models: draft.models,
        ...(draft.enterpriseUrl.trim() ? { enterpriseUrl: draft.enterpriseUrl.trim() } : {}),
        ...buildCredentialPayload(draft),
      };
      const res = await channelsApi<{ readonly state: ModelChannelsStateView }>(
        draft.mode === "create" ? "create" : "update",
        { method: "POST", body: payload },
      );
      applyAuthoritativeState(res.state);
      setFormOpen(false);
      setDraft(null);
    } catch (error) {
      setFormError(error instanceof Error ? error.message : "保存渠道失败");
    } finally {
      setFormSaving(false);
    }
  };

  // ============================================================================
  // OAuth Subscription Login Dialog Actions
  // ============================================================================

  const openOAuthDialog = (provider: OAuthProviderId, channel?: RedactedChannelView) => {
    setOauthProvider(provider);
    setOauthTargetChannelId(channel?.id);
    setOauthEnterpriseUrl(channel?.enterpriseUrl ?? "");
    setOauthCodexMethod("browser");
    setOauthSession(null);
    setOauthManualInput("");
    setOauthError(null);
    setCopiedCode(false);
    setOauthDialogOpen(true);
  };

  const handleStartOAuthSession = async () => {
    setOauthStarting(true);
    setOauthError(null);
    try {
      const res = await channelsApi<{ readonly session: OAuthLoginSessionView }>("oauth/start", {
        method: "POST",
        body: {
          provider: oauthProvider,
          ...(oauthTargetChannelId ? { channelId: oauthTargetChannelId } : {}),
          ...(oauthProvider === "openai-codex" ? { method: oauthCodexMethod } : {}),
          ...(oauthProvider === "github-copilot" && oauthEnterpriseUrl.trim()
            ? { enterpriseUrl: oauthEnterpriseUrl.trim() }
            : {}),
        },
      });
      setOauthSession(res.session);
      if (res.session.authUrl) {
        openExternalUrl(res.session.authUrl);
      }
    } catch (error) {
      setOauthError(error instanceof Error ? error.message : "启动 OAuth 订阅登录失败");
    } finally {
      setOauthStarting(false);
    }
  };

  const handleSubmitOAuthManualCallback = async () => {
    if (!oauthSession || !oauthManualInput.trim()) return;
    setOauthError(null);
    try {
      await channelsApi("oauth/submit-callback", {
        method: "POST",
        body: { sessionId: oauthSession.sessionId, input: oauthManualInput.trim() },
      });
      setOauthManualInput("");
    } catch (error) {
      setOauthError(error instanceof Error ? error.message : "提交手动回调失败");
    }
  };

  const handleCancelOAuthSession = async () => {
    if (oauthSession) {
      await channelsApi("oauth/cancel", {
        method: "POST",
        body: { sessionId: oauthSession.sessionId },
      }).catch(() => undefined);
    }
    setOauthSession(null);
    setOauthDialogOpen(false);
  };

  const handleCopyUserCode = (code: string) => {
    void navigator.clipboard?.writeText(code).catch(() => undefined);
    setCopiedCode(true);
    window.setTimeout(() => setCopiedCode(false), 1800);
  };

  const draftSpec = draft ? catalogByType.get(draft.provider) : undefined;
  const draftIsOAuth = draftSpec?.category === "oauth";
  const filteredDraftModels = useMemo(() => {
    if (!draft) return [];
    const q = modelSearch.trim().toLowerCase();
    if (!q) return draft.models;
    return draft.models.filter(
      (m) => m.id.toLowerCase().includes(q) || m.name.toLowerCase().includes(q),
    );
  }, [draft, modelSearch]);

  return (
    <SettingsPageContainer>
      {loading && !state ? (
        <div className="flex items-center gap-2 py-8 text-sm text-muted-foreground">
          <Loader2Icon className="size-4 animate-spin" />
          <span>正在加载模型渠道配置...</span>
        </div>
      ) : null}

      {loadError ? (
        <div
          role="alert"
          className="mb-4 rounded-xl border border-destructive/40 bg-destructive/10 px-4 py-3 text-sm text-destructive-foreground"
        >
          {loadError}
        </div>
      ) : null}

      {state?.zeroChannelState ? (
        <div
          data-testid="zero-channel-onboarding-card"
          className="mb-5 rounded-xl border border-warning/40 bg-warning/10 p-4"
        >
          <div className="flex flex-wrap items-start justify-between gap-3">
            <div className="space-y-1">
              <div className="flex items-center gap-2 text-sm font-semibold text-foreground">
                <SparklesIcon className="size-4 text-warning-foreground" />
                <span>开始使用小瞳：请先配置至少一个模型渠道</span>
              </div>
              <p className="text-xs leading-relaxed text-muted-foreground">
                当前未启用任何模型。你可以立即使用企业微信登录公司团队模型，或添加个人 API 密钥 /
                订阅账号（支持 19 类供应商，所有凭据仅保存在本机系统钥匙串）。
              </p>
            </div>
            <div className="flex flex-wrap items-center gap-2">
              <Button
                size="sm"
                variant="default"
                disabled={companyBusy}
                onClick={() => void handleStartCompanyLogin()}
              >
                企业微信扫码登录
              </Button>
              <Button size="sm" variant="outline" onClick={() => openCreateDialog("anthropic")}>
                <PlusIcon className="size-3.5" />
                添加个人渠道
              </Button>
            </div>
          </div>
        </div>
      ) : null}

      {/* ================================================================== */}
      {/* Section 1: Company Team Channel (WeCom OIDC + PKCE)                */}
      {/* ================================================================== */}
      <SettingsSection id="company-team-channel" title="公司团队渠道">
        <p className="px-4 pt-3 text-xs leading-relaxed text-muted-foreground">
          通过企业微信扫码登录，自动同步公司统一提供的团队模型。凭据仅保存在本机系统钥匙串中，绝不写入明文配置文件。
        </p>
        <SettingsRow
          title={
            state?.companyAuth.phase === "signed-in" && state.companyAuth.member
              ? `${state.companyAuth.member.name}（${state.companyAuth.member.username}）`
              : "小瞳 Work 团队账号"
          }
          description={
            state?.companyAuth.phase === "signed-in"
              ? "已连接公司团队模型网关 · 凭据受本机系统钥匙串保护"
              : state?.companyAuth.phase === "waiting"
                ? "正在等待浏览器中的企业微信扫码登录完成..."
                : state?.companyAuth.phase === "connecting"
                  ? "正在验证企业身份并同步公司模型..."
                  : "使用企业微信扫码登录，自动解锁公司团队模型渠道"
          }
        >
          <div className="flex flex-wrap items-center gap-2">
            {state?.companyAuth.phase === "signed-in" ? (
              <>
                <Badge variant="success">
                  <ShieldCheckIcon className="size-3" />
                  已登录
                </Badge>
                <Button
                  size="sm"
                  variant="outline"
                  disabled={companyBusy}
                  onClick={() => void handleSyncCompanyModels()}
                >
                  <RefreshCwIcon className={companyBusy ? "size-3.5 animate-spin" : "size-3.5"} />
                  同步模型
                </Button>
                <Button
                  size="sm"
                  variant="outline"
                  disabled={companyBusy}
                  onClick={() => setCompanyLogoutOpen(true)}
                >
                  <LogOutIcon className="size-3.5" />
                  退出登录
                </Button>
              </>
            ) : state?.companyAuth.phase === "waiting" || state?.companyAuth.phase === "connecting" ? (
              <>
                {state.companyAuth.authUrl ? (
                  <Button
                    size="sm"
                    variant="outline"
                    onClick={() => openExternalUrl(state.companyAuth.authUrl!)}
                  >
                    <ExternalLinkIcon className="size-3.5" />
                    重新打开浏览器
                  </Button>
                ) : null}
                <Button
                  size="sm"
                  variant="outline"
                  disabled={companyBusy}
                  onClick={() => void handleCancelCompanyLogin()}
                >
                  取消登录
                </Button>
              </>
            ) : (
              <Button
                size="sm"
                variant="default"
                disabled={companyBusy}
                onClick={() => void handleStartCompanyLogin()}
              >
                <Building2Icon className="size-3.5" />
                企业微信扫码登录
              </Button>
            )}
          </div>
        </SettingsRow>

        {companyNotice ? (
          <div className="px-4 pb-3 text-xs text-success-foreground">{companyNotice}</div>
        ) : null}

        {companyError ? (
          <div
            role="alert"
            data-testid="company-auth-error"
            className="mx-4 mb-3 rounded-lg border border-destructive/40 bg-destructive/10 px-3 py-2 text-xs text-destructive-foreground"
          >
            <div className="flex items-start gap-2">
              <AlertTriangleIcon className="mt-0.5 size-3.5 shrink-0" />
              <div className="space-y-1">
                <p>{companyError}</p>
                {companyPortConflict ? (
                  <p className="text-muted-foreground">
                    提示：请先关闭旧版 Electron 小瞳 Work 或其他占用本机 49160 端口的程序后再点击重试。
                  </p>
                ) : null}
              </div>
            </div>
          </div>
        ) : null}

        {teamChannel ? (
          <div
            data-testid="company-team-channel-card"
            className="mx-4 mb-4 rounded-xl border border-border/70 bg-card/50 p-4"
          >
            <div className="flex flex-wrap items-center justify-between gap-3">
              <div className="space-y-1">
                <div className="flex flex-wrap items-center gap-2">
                  <span className="text-sm font-semibold">{teamChannel.name}</span>
                  <Badge variant="info">
                    <LockIcon className="size-3" />
                    企业统一管理
                  </Badge>
                  <Badge variant="secondary">
                    已启用 {teamChannel.models.filter((m) => m.enabled).length} /{" "}
                    {teamChannel.models.length} 个模型
                  </Badge>
                </div>
                <p className="text-xs text-muted-foreground">
                  服务地址：{teamChannel.baseUrl}（地址、密钥与删除由企业账号锁定，仅支持开关模型）
                </p>
              </div>
              <div className="flex items-center gap-2">
                <Switch
                  aria-label="启用公司团队渠道"
                  checked={teamChannel.enabled}
                  onCheckedChange={(checked) => void handleToggleChannelEnabled(teamChannel, checked)}
                />
              </div>
            </div>

            {teamChannel.models.length > 0 ? (
              <div className="mt-3 grid grid-cols-1 gap-2 border-t border-border/50 pt-3 sm:grid-cols-2">
                {teamChannel.models.map((model) => (
                  <div
                    key={model.id}
                    className="flex items-center justify-between rounded-lg border border-border/50 bg-background/60 px-3 py-2 text-xs"
                  >
                    <div className="min-w-0 truncate">
                      <span className="font-medium text-foreground">{model.name}</span>
                      {model.name !== model.id ? (
                        <span className="ml-1.5 text-muted-foreground">{model.id}</span>
                      ) : null}
                    </div>
                    <Switch
                      size="sm"
                      aria-label={`启用公司模型 ${model.id}`}
                      checked={model.enabled}
                      onCheckedChange={(checked) =>
                        void handleToggleChannelModel(teamChannel, model.id, checked)
                      }
                    />
                  </div>
                ))}
              </div>
            ) : null}
          </div>
        ) : null}
      </SettingsSection>

      {/* ================================================================== */}
      {/* Section 2: Member Channels (19-Supplier Matrix + OAuth Subscriptions) */}
      {/* ================================================================== */}
      <SettingsSection
        id="member-model-channels"
        title="个人模型渠道（19 类供应商与订阅登录）"
      >
        <p className="px-4 pt-3 text-xs leading-relaxed text-muted-foreground">
          支持 Anthropic、OpenAI、DeepSeek、Google Gemini、Kimi、智谱、豆包、MiniMax、通义千问、小米
          MiMo、自定义端点，以及 ChatGPT Codex / GitHub Copilot / xAI 订阅 OAuth 登录。
        </p>
        <div className="flex flex-wrap items-center justify-between gap-2 px-4 py-3">
          <div className="flex flex-wrap items-center gap-2">
            <Button size="sm" variant="default" onClick={() => openCreateDialog("anthropic")}>
              <PlusIcon className="size-3.5" />
              添加 API 渠道
            </Button>
            <Button
              size="sm"
              variant="outline"
              onClick={() => openOAuthDialog("openai-codex")}
            >
              <ZapIcon className="size-3.5" />
              ChatGPT Codex 订阅
            </Button>
            <Button
              size="sm"
              variant="outline"
              onClick={() => openOAuthDialog("github-copilot")}
            >
              <ZapIcon className="size-3.5" />
              GitHub Copilot 订阅
            </Button>
            <Button size="sm" variant="outline" onClick={() => openOAuthDialog("xai")}>
              <ZapIcon className="size-3.5" />
              xAI Grok 订阅
            </Button>
          </div>
          {state ? (
            <Badge variant="outline">
              目录版本 {state.catalogVersion} · 可用模型 {state.enabledModelCount} 个
            </Badge>
          ) : null}
        </div>

        {channelActionError ? (
          <div
            role="alert"
            data-testid="channel-action-error"
            className="mx-4 mb-3 rounded-lg border border-destructive/40 bg-destructive/10 px-3 py-2 text-xs text-destructive-foreground"
          >
            {channelActionError}
          </div>
        ) : null}

        {memberChannels.length === 0 ? (
          <div className="mx-4 mb-4 rounded-xl border border-dashed border-border/70 px-4 py-6 text-center text-xs text-muted-foreground">
            暂未添加个人模型渠道。点击上方「添加 API 渠道」或任一 OAuth 订阅按钮开始配置。
          </div>
        ) : (
          <div className="space-y-3 px-4 pb-4">
            {memberChannels.map((channel) => {
              const spec = catalogByType.get(channel.provider);
              const isOAuth = spec?.category === "oauth";
              const testResult = testResults[channel.id];
              const quota = quotas[channel.id];
              const enabledCount = channel.models.filter((m) => m.enabled).length;

              return (
                <div
                  key={channel.id}
                  data-testid={`channel-card-${channel.id}`}
                  className="rounded-xl border border-border/70 bg-card/50 p-4"
                >
                  <div className="flex flex-wrap items-start justify-between gap-3">
                    <div className="min-w-0 space-y-1">
                      <div className="flex flex-wrap items-center gap-2">
                        <span className="text-sm font-semibold text-foreground">{channel.name}</span>
                        <Badge variant="secondary">{spec?.labelZh ?? channel.provider}</Badge>
                        {spec ? (
                          <Badge variant="outline">{formatProtocolBadge(spec.api)}</Badge>
                        ) : null}
                        <Badge variant={channel.hasCredentials ? "success" : "warning"}>
                          <KeyRoundIcon className="size-3" />
                          {channel.hasCredentials
                            ? isOAuth
                              ? `已订阅${channel.accountLabel ? ` · ${channel.accountLabel}` : ""}`
                              : "密钥已加密保存"
                            : "未配置凭据"}
                        </Badge>
                      </div>
                      <p className="truncate text-xs text-muted-foreground">
                        {channel.baseUrl || (isOAuth ? "通过本机安全代理网关路由" : "使用默认地址")} · 已启用{" "}
                        {enabledCount} / {channel.models.length} 个模型
                      </p>
                    </div>

                    <div className="flex flex-wrap items-center gap-1.5">
                      <Switch
                        aria-label={`启用渠道 ${channel.name}`}
                        checked={channel.enabled}
                        onCheckedChange={(checked) =>
                          void handleToggleChannelEnabled(channel, checked)
                        }
                      />
                      <Button
                        size="xs"
                        variant="outline"
                        disabled={testingId === channel.id}
                        onClick={() => void handleTestChannel(channel)}
                      >
                        {testingId === channel.id ? (
                          <Loader2Icon className="size-3 animate-spin" />
                        ) : (
                          <CheckCircle2Icon className="size-3" />
                        )}
                        测试
                      </Button>
                      {spec?.supportsPlanQuota ? (
                        <Button
                          size="xs"
                          variant="outline"
                          disabled={quotaLoadingId === channel.id}
                          onClick={() => void handleQueryQuota(channel)}
                        >
                          {quotaLoadingId === channel.id ? (
                            <Loader2Icon className="size-3 animate-spin" />
                          ) : (
                            <GaugeIcon className="size-3" />
                          )}
                          额度
                        </Button>
                      ) : null}
                      {isOAuth && spec?.oauthProvider ? (
                        <>
                          <Button
                            size="xs"
                            variant="outline"
                            onClick={() => openOAuthDialog(spec.oauthProvider!, channel)}
                          >
                            {channel.hasCredentials ? "重新登录" : "订阅登录"}
                          </Button>
                          {channel.hasCredentials ? (
                            <Button
                              size="xs"
                              variant="outline"
                              onClick={() => void handleLogoutOAuthChannel(channel)}
                            >
                              退出订阅
                            </Button>
                          ) : null}
                        </>
                      ) : null}
                      <Button
                        size="xs"
                        variant="outline"
                        aria-label={`编辑渠道 ${channel.name}`}
                        onClick={() => openEditDialog(channel)}
                      >
                        <PencilIcon className="size-3" />
                        编辑
                      </Button>
                      <Button
                        size="xs"
                        variant="outline"
                        aria-label={`删除渠道 ${channel.name}`}
                        onClick={() => setDeleteTarget(channel)}
                      >
                        <Trash2Icon className="size-3" />
                        删除
                      </Button>
                    </div>
                  </div>

                  {channel.provider === "github-copilot" &&
                  channel.hasCredentials &&
                  Array.isArray(channel.availableModelIds) &&
                  channel.availableModelIds.length === 0 ? (
                    <div
                      data-testid={`copilot-empty-allowlist-${channel.id}`}
                      className="mt-2.5 rounded-lg border border-warning/40 bg-warning/10 px-3 py-2 text-xs text-warning-foreground"
                    >
                      当前 GitHub Copilot 组织或订阅策略未授权任何可用模型（availableModelIds 为空），请联系管理员在 Copilot 策略中启用模型后重试。
                    </div>
                  ) : null}

                  {testResult ? (
                    <div
                      className={`mt-2.5 rounded-lg px-3 py-1.5 text-xs ${
                        testResult.success
                          ? "bg-success/10 text-success-foreground"
                          : "bg-destructive/10 text-destructive-foreground"
                      }`}
                    >
                      {testResult.message}
                    </div>
                  ) : null}

                  {quota ? (
                    <div
                      data-testid={`channel-quota-${channel.id}`}
                      className="mt-2.5 rounded-lg border border-border/50 bg-background/60 p-3 text-xs"
                    >
                      {quota.supported && quota.windows.length > 0 ? (
                        <div className="space-y-2">
                          <div className="flex items-center justify-between font-medium">
                            <span>{quota.planName ?? "订阅额度"}</span>
                            <span className="text-muted-foreground">
                              更新于 {formatResetTime(quota.updatedAt)}
                            </span>
                          </div>
                          {quota.windows.map((w, idx) => (
                            <div key={`${w.type}-${idx}`} className="space-y-1">
                              <div className="flex items-center justify-between">
                                <span>{w.label}</span>
                                <span className="font-medium">
                                  {w.remainingLabel ?? `剩余 ${w.remainingPercent}%`}
                                  {w.resetAt ? ` · 重置 ${formatResetTime(w.resetAt)}` : ""}
                                </span>
                              </div>
                              {w.showProgress !== false ? (
                                <div className="h-1.5 w-full overflow-hidden rounded-full bg-muted">
                                  <div
                                    className="h-full rounded-full bg-primary transition-all"
                                    style={{ width: `${Math.max(0, Math.min(100, w.remainingPercent))}%` }}
                                  />
                                </div>
                              ) : null}
                            </div>
                          ))}
                        </div>
                      ) : (
                        <p className="text-muted-foreground">
                          {quota.message ?? quota.error ?? "暂不支持额度查询"}
                        </p>
                      )}
                    </div>
                  ) : null}
                </div>
              );
            })}
          </div>
        )}
      </SettingsSection>

      {/* ================================================================== */}
      {/* Honest Company Logout Confirmation Dialog                          */}
      {/* ================================================================== */}
      <AlertDialog open={companyLogoutOpen} onOpenChange={setCompanyLogoutOpen}>
        <AlertDialogPopup>
          <AlertDialogHeader>
            <AlertDialogTitle>确认退出公司团队账号？</AlertDialogTitle>
            <AlertDialogDescription>
              退出登录将按以下顺序执行：
              {"\n"}1. 优先从本机系统钥匙串校验删除已保存的公司凭据（若钥匙串删除失败，将保留当前登录状态并报错）；
              {"\n"}2. 立即从模型列表移除「小瞳 Work 团队模型」并尝试吊销本次 OIDC refresh_token；
              {"\n"}3. 说明：公司网关签发的长期 sk- API Key 仍受服务端生命周期管理，如需在服务端彻底作废，请联系管理员。
            </AlertDialogDescription>
          </AlertDialogHeader>
          <AlertDialogFooter>
            <AlertDialogClose render={<Button variant="outline">取消</Button>} />
            <Button
              variant="destructive"
              disabled={companyBusy}
              onClick={() => void handleConfirmCompanyLogout()}
            >
              {companyBusy ? "正在退出..." : "确认退出登录"}
            </Button>
          </AlertDialogFooter>
        </AlertDialogPopup>
      </AlertDialog>

      {/* ================================================================== */}
      {/* Delete Member Channel Confirmation Dialog                          */}
      {/* ================================================================== */}
      <AlertDialog
        open={deleteTarget !== null}
        onOpenChange={(open) => {
          if (!open) setDeleteTarget(null);
        }}
      >
        <AlertDialogPopup>
          <AlertDialogHeader>
            <AlertDialogTitle>删除渠道「{deleteTarget?.name}」？</AlertDialogTitle>
            <AlertDialogDescription>
              删除前将先从本机系统钥匙串校验清除该渠道的所有 API Key 或 OAuth 令牌。若钥匙串删除失败，将中止删除并保留原渠道。
            </AlertDialogDescription>
          </AlertDialogHeader>
          <AlertDialogFooter>
            <AlertDialogClose render={<Button variant="outline">取消</Button>} />
            <Button
              variant="destructive"
              disabled={deleteBusy}
              onClick={() => void handleConfirmDeleteChannel()}
            >
              {deleteBusy ? "正在删除..." : "确认删除"}
            </Button>
          </AlertDialogFooter>
        </AlertDialogPopup>
      </AlertDialog>

      {/* ================================================================== */}
      {/* Add / Edit Channel Dialog                                          */}
      {/* ================================================================== */}
      <Dialog
        open={formOpen}
        onOpenChange={(open) => {
          setFormOpen(open);
          if (!open) setDraft(null);
        }}
      >
        <DialogPopup className="max-w-2xl">
          <DialogHeader>
            <DialogTitle>{draft?.mode === "edit" ? "编辑模型渠道" : "添加模型渠道"}</DialogTitle>
            <DialogDescription>
              所有 API Key 均为只写模式，直接加密存入本机系统钥匙串，不会回显也不会写入配置文件。
            </DialogDescription>
          </DialogHeader>
          {draft ? (
            <DialogPanel>
              <div className="space-y-4">
                <div className="grid grid-cols-1 gap-3 sm:grid-cols-2">
                  <label className="space-y-1.5 text-xs">
                    <span className="font-medium text-foreground">供应商类型</span>
                    <select
                      aria-label="供应商类型"
                      disabled={draft.mode === "edit"}
                      value={draft.provider}
                      onChange={(e) => handleDraftProviderChange(e.target.value)}
                      className="flex h-9 w-full rounded-md border border-input bg-background px-3 py-1 text-sm shadow-xs outline-none focus-visible:ring-2 focus-visible:ring-ring disabled:opacity-60"
                    >
                      {selectableProviders.map((spec) => (
                        <option key={spec.type} value={spec.type}>
                          {spec.labelZh}
                        </option>
                      ))}
                    </select>
                  </label>
                  <label className="space-y-1.5 text-xs">
                    <span className="font-medium text-foreground">渠道名称</span>
                    <Input
                      aria-label="渠道名称"
                      value={draft.name}
                      onChange={(e) => setDraft({ ...draft, name: e.target.value })}
                      placeholder="例如：我的 Claude API"
                    />
                  </label>
                </div>

                {draftSpec ? (
                  <p className="text-xs text-muted-foreground">
                    协议：{formatProtocolBadge(draftSpec.api)} · {draftSpec.verificationNote}
                  </p>
                ) : null}

                {!draftIsOAuth ? (
                  <>
                    <label className="block space-y-1.5 text-xs">
                      <span className="font-medium text-foreground">
                        {draftSpec?.urlMode === "full-endpoint"
                          ? "完整请求地址（Full Endpoint URL）"
                          : "接口地址（Base URL）"}
                      </span>
                      <Input
                        aria-label="接口地址"
                        value={draft.baseUrl}
                        onChange={(e) => setDraft({ ...draft, baseUrl: e.target.value })}
                        placeholder={draftSpec?.defaultBaseUrl || "https://api.example.com/v1"}
                      />
                    </label>

                    <label className="block space-y-1.5 text-xs">
                      <span className="font-medium text-foreground">API Key（只写，不回显）</span>
                      <Input
                        aria-label="API Key"
                        type="password"
                        autoComplete="new-password"
                        value={draft.apiKey}
                        onChange={(e) => setDraft({ ...draft, apiKey: e.target.value })}
                        placeholder={
                          draft.hasCredentials
                            ? "已安全保存在系统钥匙串；留空则保持不变"
                            : "输入你的 API Key（如 sk-...）"
                        }
                      />
                    </label>

                    {draft.provider === "zhipu-coding-team" ? (
                      <div className="grid grid-cols-1 gap-3 sm:grid-cols-2">
                        <label className="space-y-1.5 text-xs">
                          <span className="font-medium text-foreground">
                            组织 ID（bigmodel-organization）
                          </span>
                          <Input
                            aria-label="智谱组织 ID"
                            value={draft.zhipuOrg}
                            onChange={(e) => setDraft({ ...draft, zhipuOrg: e.target.value })}
                            placeholder="选填，留空则沿用已保存值"
                          />
                        </label>
                        <label className="space-y-1.5 text-xs">
                          <span className="font-medium text-foreground">
                            项目 ID（bigmodel-project）
                          </span>
                          <Input
                            aria-label="智谱项目 ID"
                            value={draft.zhipuProject}
                            onChange={(e) => setDraft({ ...draft, zhipuProject: e.target.value })}
                            placeholder="选填，留空则沿用已保存值"
                          />
                        </label>
                      </div>
                    ) : null}

                    <div className="flex flex-wrap items-center gap-2">
                      <Button
                        type="button"
                        size="sm"
                        variant="outline"
                        disabled={formTesting}
                        onClick={() => void handleFormTestConnection()}
                      >
                        {formTesting ? (
                          <Loader2Icon className="size-3.5 animate-spin" />
                        ) : (
                          <CheckCircle2Icon className="size-3.5" />
                        )}
                        测试连接
                      </Button>
                      <Button
                        type="button"
                        size="sm"
                        variant="outline"
                        disabled={formFetching}
                        onClick={() => void handleFormFetchModels()}
                      >
                        {formFetching ? (
                          <Loader2Icon className="size-3.5 animate-spin" />
                        ) : (
                          <RefreshCwIcon className="size-3.5" />
                        )}
                        {draftSpec?.supportsFetchModels ? "拉取模型列表" : "加载预设模型"}
                      </Button>
                    </div>
                  </>
                ) : (
                  <div className="rounded-lg border border-border/60 bg-muted/40 p-3 text-xs text-muted-foreground">
                    该供应商使用 OAuth 订阅登录，请在外部渠道卡片或上方订阅登录按钮完成授权。
                  </div>
                )}

                {formTestResult ? (
                  <div
                    className={`rounded-lg px-3 py-2 text-xs ${
                      formTestResult.success
                        ? "bg-success/10 text-success-foreground"
                        : "bg-destructive/10 text-destructive-foreground"
                    }`}
                  >
                    {formTestResult.message}
                  </div>
                ) : null}

                {formError ? (
                  <div
                    role="alert"
                    className="rounded-lg bg-destructive/10 px-3 py-2 text-xs text-destructive-foreground"
                  >
                    {formError}
                  </div>
                ) : null}

                {/* Model list & custom model ID editor */}
                <div className="space-y-2 border-t border-border/60 pt-3">
                  <div className="flex flex-wrap items-center justify-between gap-2">
                    <span className="text-xs font-medium text-foreground">
                      模型列表（已启用 {draft.models.filter((m) => m.enabled).length} /{" "}
                      {draft.models.length}）
                    </span>
                    <div className="flex items-center gap-1.5">
                      <Input
                        aria-label="添加自定义模型 ID"
                        className="h-7 w-44 text-xs"
                        value={customModelId}
                        onChange={(e) => setCustomModelId(e.target.value)}
                        placeholder="自定义模型 ID"
                      />
                      <Button
                        type="button"
                        size="xs"
                        variant="outline"
                        onClick={handleAddCustomModel}
                      >
                        添加
                      </Button>
                    </div>
                  </div>

                  {draft.models.length > 4 ? (
                    <div className="relative">
                      <SearchIcon className="pointer-events-none absolute top-2 left-2.5 size-3.5 text-muted-foreground" />
                      <Input
                        aria-label="筛选模型"
                        className="h-8 pl-8 text-xs"
                        value={modelSearch}
                        onChange={(e) => setModelSearch(e.target.value)}
                        placeholder="搜索模型 ID 或名称..."
                      />
                    </div>
                  ) : null}

                  <div className="max-h-52 space-y-1.5 overflow-y-auto pr-1">
                    {filteredDraftModels.map((model) => (
                      <div
                        key={model.id}
                        className="flex items-center justify-between rounded-lg border border-border/50 px-3 py-1.5 text-xs"
                      >
                        <div className="min-w-0 truncate">
                          <span className="font-medium">{model.name}</span>
                          {model.name !== model.id ? (
                            <span className="ml-1.5 text-muted-foreground">{model.id}</span>
                          ) : null}
                        </div>
                        <Switch
                          size="sm"
                          aria-label={`选择模型 ${model.id}`}
                          checked={model.enabled}
                          onCheckedChange={(checked) =>
                            setDraft({
                              ...draft,
                              models: draft.models.map((item) =>
                                item.id === model.id ? { ...item, enabled: checked } : item,
                              ),
                            })
                          }
                        />
                      </div>
                    ))}
                  </div>
                </div>
              </div>
            </DialogPanel>
          ) : null}
          <DialogFooter>
            <DialogClose render={<Button variant="outline">取消</Button>} />
            <Button disabled={formSaving || !draft} onClick={() => void handleSaveForm()}>
              {formSaving ? "保存中..." : "保存渠道"}
            </Button>
          </DialogFooter>
        </DialogPopup>
      </Dialog>

      {/* ================================================================== */}
      {/* OAuth Subscription Login Dialog (Codex / GitHub Copilot / xAI)     */}
      {/* ================================================================== */}
      <Dialog
        open={oauthDialogOpen}
        onOpenChange={(open) => {
          if (!open) {
            void handleCancelOAuthSession();
          }
        }}
      >
        <DialogPopup className="max-w-lg">
          <DialogHeader>
            <DialogTitle className="flex items-center gap-2">
              <CpuIcon className="size-4" />
              {oauthProvider === "openai-codex"
                ? "ChatGPT Subscription (Codex) OAuth 登录"
                : oauthProvider === "github-copilot"
                  ? "GitHub Copilot 订阅登录"
                  : "xAI Subscription (Grok) 订阅登录"}
            </DialogTitle>
            <DialogDescription>
              所有 OAuth 令牌均由本机安全代理托管并加密存储在系统钥匙串中，绝不暴露给底层子进程或前端页面。
            </DialogDescription>
          </DialogHeader>
          <DialogPanel>
            <div className="space-y-4">
              {!oauthSession ? (
                <>
                  {oauthProvider === "openai-codex" ? (
                    <div className="flex gap-2">
                      <Button
                        type="button"
                        size="sm"
                        variant={oauthCodexMethod === "browser" ? "default" : "outline"}
                        onClick={() => setOauthCodexMethod("browser")}
                      >
                        浏览器登录（推荐）
                      </Button>
                      <Button
                        type="button"
                        size="sm"
                        variant={oauthCodexMethod === "device_code" ? "default" : "outline"}
                        onClick={() => setOauthCodexMethod("device_code")}
                      >
                        设备码登录
                      </Button>
                    </div>
                  ) : null}

                  {oauthProvider === "github-copilot" ? (
                    <label className="block space-y-1.5 text-xs">
                      <span className="font-medium text-foreground">
                        GitHub Enterprise 域名（个人账号请留空）
                      </span>
                      <Input
                        aria-label="GitHub Enterprise 域名"
                        value={oauthEnterpriseUrl}
                        onChange={(e) => setOauthEnterpriseUrl(e.target.value)}
                        placeholder="例如：github.mycompany.com"
                      />
                    </label>
                  ) : null}

                  <Button
                    disabled={oauthStarting}
                    onClick={() => void handleStartOAuthSession()}
                  >
                    {oauthStarting ? (
                      <Loader2Icon className="size-4 animate-spin" />
                    ) : (
                      <ZapIcon className="size-4" />
                    )}
                    开始授权登录
                  </Button>
                </>
              ) : oauthSession.phase === "succeeded" ? (
                <div
                  data-testid="oauth-login-succeeded"
                  className="rounded-xl border border-success/40 bg-success/10 p-4 text-xs text-success-foreground"
                >
                  <p className="font-semibold">订阅登录成功！</p>
                  <p className="mt-1">
                    账号：{oauthSession.accountLabel ?? "已认证"}
                    {oauthSession.availableModelCount !== undefined
                      ? ` · 已同步 ${oauthSession.availableModelCount} 个可用模型`
                      : ""}
                  </p>
                </div>
              ) : (
                <div className="space-y-3">
                  {oauthSession.userCode && oauthSession.verificationUri ? (
                    <div
                      data-testid="oauth-device-code-panel"
                      className="rounded-xl border border-border/70 bg-muted/40 p-4 text-center"
                    >
                      <p className="text-xs text-muted-foreground">
                        请打开下方验证页面，并输入一次性设备验证码：
                      </p>
                      <div className="my-3 flex items-center justify-center gap-2">
                        <code
                          data-testid="oauth-user-code"
                          className="rounded-lg bg-background px-4 py-2 font-mono text-xl font-bold tracking-widest"
                        >
                          {oauthSession.userCode}
                        </code>
                        <Button
                          type="button"
                          size="sm"
                          variant="outline"
                          onClick={() => handleCopyUserCode(oauthSession.userCode!)}
                        >
                          <CopyIcon className="size-3.5" />
                          {copiedCode ? "已复制" : "复制"}
                        </Button>
                      </div>
                      <div className="my-3 flex justify-center">
                        <QRCodeSvg
                          value={oauthSession.verificationUri}
                          size={140}
                          className="rounded-lg bg-white p-2"
                        />
                      </div>
                      <Button
                        type="button"
                        size="sm"
                        variant="default"
                        onClick={() => openExternalUrl(oauthSession.verificationUri!)}
                      >
                        <ExternalLinkIcon className="size-3.5" />
                        打开验证页面
                      </Button>
                    </div>
                  ) : null}

                  {oauthSession.authUrl && oauthSession.manualCallbackSupported ? (
                    <div className="space-y-2 rounded-xl border border-border/70 bg-muted/40 p-4 text-xs">
                      <p className="font-medium text-foreground">
                        已打开浏览器授权页，完成后会自动回跳。
                      </p>
                      <Button
                        type="button"
                        size="xs"
                        variant="outline"
                        onClick={() => openExternalUrl(oauthSession.authUrl!)}
                      >
                        <ExternalLinkIcon className="size-3" />
                        重新打开授权页
                      </Button>
                      <div className="pt-2">
                        <p className="mb-1.5 text-muted-foreground">
                          若本地 1455 回调端口被占用，请粘贴浏览器重定向后的完整回调 URL 或授权码：
                        </p>
                        <div className="flex gap-2">
                          <Input
                            aria-label="手动回调 URL 或授权码"
                            value={oauthManualInput}
                            onChange={(e) => setOauthManualInput(e.target.value)}
                            placeholder="http://localhost:1455/auth/callback?code=..."
                          />
                          <Button
                            type="button"
                            size="sm"
                            variant="outline"
                            onClick={() => void handleSubmitOAuthManualCallback()}
                          >
                            提交
                          </Button>
                        </div>
                      </div>
                    </div>
                  ) : null}

                  <div className="flex items-center gap-2 text-xs text-muted-foreground">
                    <Loader2Icon className="size-3.5 animate-spin" />
                    <span>
                      {oauthSession.phase === "exchanging"
                        ? "正在交换并加密保存订阅凭据..."
                        : "等待授权确认中..."}
                    </span>
                  </div>
                </div>
              )}

              {oauthError ? (
                <div
                  role="alert"
                  className="rounded-lg bg-destructive/10 px-3 py-2 text-xs text-destructive-foreground"
                >
                  {oauthError}
                </div>
              ) : null}
            </div>
          </DialogPanel>
          <DialogFooter>
            {oauthSession?.phase === "succeeded" ? (
              <Button onClick={() => setOauthDialogOpen(false)}>完成</Button>
            ) : (
              <Button variant="outline" onClick={() => void handleCancelOAuthSession()}>
                取消
              </Button>
            )}
          </DialogFooter>
        </DialogPopup>
      </Dialog>
    </SettingsPageContainer>
  );
}
