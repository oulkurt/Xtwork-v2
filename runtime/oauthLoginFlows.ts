// @effect-diagnostics nodeBuiltinImport:off globalFetch:off globalTimers:off globalDate:off -- Server-side OAuth login, refresh, and quota flows use Node crypto, http, timers, and fetch.
/**
 * Proxy-Only Server-Side OAuth Subscription Login, Refresh & Plan Quota Flows (ADR-012 §3.3 & §3.4).
 *
 * Covers all 3 subscription OAuth providers:
 * - ChatGPT Subscription (Codex): Browser PKCE (S256, loopback :1455 + manual callback fallback) & Device Code
 * - GitHub Copilot Subscription: RFC 8628 Device Code + Copilot token exchange + `availableModelIds` sync
 * - xAI Subscription (Grok): RFC 8628 Device Code + rotating refresh
 *
 * Security Invariant:
 * - Real OAuth `access` / `refresh` tokens NEVER appear in session views, HTTP responses, logs, or errors.
 * - All outbound requests enforce strict HTTPS destination validation, `redirect: "error"`, timeouts,
 *   and bounded response sizes.
 */

import { createHash, randomBytes, randomUUID } from "node:crypto";
import { createServer, type IncomingMessage, type RequestListener, type Server, type ServerResponse } from "node:http";
import { CODING_PLAN_USER_AGENT, parseZhipuTeamCredentials } from "./gateway.ts";
import {
  assertStrictOAuthDestination,
  deriveGitHubCopilotBaseUrl,
  extractCodexAccountId,
  GITHUB_COPILOT_STATIC_HEADERS,
  normalizeEnterpriseDomain,
  refreshCodexOAuthToken,
  refreshXaiOAuthToken,
  type CodexOAuthCredentials,
  type GithubCopilotOAuthCredentials,
  type OAuthDestinationValidator,
  type OAuthSubscriptionCredentials,
  type OAuthSubscriptionProvider,
  type XaiOAuthCredentials,
} from "./oauthProxy.ts";
import {
  assertSafeOutboundUrl,
  GITHUB_COPILOT_STATIC_MODELS,
  type ProviderType,
} from "./providerCatalog.ts";

export { refreshCodexOAuthToken, refreshXaiOAuthToken };

const MAX_OAUTH_BODY_BYTES = 512 * 1024;
const REQUEST_TIMEOUT_MS = 20_000;
const CODEX_QUOTA_TIMEOUT_MS = 30_000;

export const CODEX_CLIENT_ID = "app_EMoamEEZ73f0CkXaXp7hrann";
export const CODEX_AUTH_BASE_URL = "https://auth.openai.com";
export const CODEX_DEFAULT_CALLBACK_PORT = 1455;
export const CODEX_DEFAULT_REDIRECT_URI = `http://localhost:${CODEX_DEFAULT_CALLBACK_PORT}/auth/callback`;
export const CODEX_DEVICE_VERIFICATION_URI = `${CODEX_AUTH_BASE_URL}/codex/device`;
export const CODEX_DEVICE_REDIRECT_URI = `${CODEX_AUTH_BASE_URL}/deviceauth/callback`;
export const CODEX_SCOPE = "openid profile email offline_access";

export const GITHUB_COPILOT_CLIENT_ID = "Iv1.b507a08c87ecfe98";
export const GITHUB_COPILOT_API_VERSION = "2026-06-01";

export const XAI_CLIENT_ID = "b1a00492-073a-47ea-816f-4c329264a828";
export const XAI_SCOPE = "openid profile email offline_access grok-cli:access api:access";
export const XAI_AUTH_BASE_URL = "https://auth.x.ai";

const KNOWN_COPILOT_MODEL_IDS = new Set(GITHUB_COPILOT_STATIC_MODELS.map((m) => m.id));

const SECRET_PATTERNS: ReadonlyArray<{ readonly pattern: RegExp; readonly replacement: string }> = [
  { pattern: /\bBearer\s+[A-Za-z0-9._~+/=-]+/gi, replacement: "Bearer [REDACTED]" },
  { pattern: /\btoken\s+[A-Za-z0-9._~+/=-]+/gi, replacement: "token [REDACTED]" },
  { pattern: /\bsk-[A-Za-z0-9_-]{8,}\b/g, replacement: "[REDACTED]" },
  { pattern: /\bgh[oups]_[A-Za-z0-9_]{8,}\b/g, replacement: "[REDACTED]" },
  { pattern: /\btid=[^;\s"']+/gi, replacement: "tid=[REDACTED]" },
  {
    pattern:
      /(["']?(?:access[_-]?token|refresh[_-]?token|api[_-]?key|x-api-key|authorization|token|secret)["']?\s*[:=]\s*["']?)[^"',&\s}]+/gi,
    replacement: "$1[REDACTED]",
  },
];

export function redactSecretsFromText(
  text: string,
  extraSecrets: readonly (string | undefined)[] = [],
): string {
  let out = text;
  const literals = extraSecrets
    .filter((s): s is string => typeof s === "string" && s.trim().length >= 6)
    .sort((a, b) => b.length - a.length);
  for (const secret of literals) {
    if (out.includes(secret)) out = out.replaceAll(secret, "[REDACTED]");
  }
  for (const { pattern, replacement } of SECRET_PATTERNS) {
    out = out.replace(pattern, replacement);
  }
  return out;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

async function readBoundedResponseText(
  response: Response,
  maxBytes = MAX_OAUTH_BODY_BYTES,
): Promise<string> {
  if (!response.body) {
    const text = await response.text();
    if (Buffer.byteLength(text, "utf8") > maxBytes) {
      throw new Error("Response body exceeded maximum allowed size");
    }
    return text;
  }
  const reader = response.body.getReader();
  const chunks: Buffer[] = [];
  let total = 0;
  try {
    while (true) {
      const { done, value } = await reader.read();
      if (done) break;
      if (!value) continue;
      total += value.byteLength;
      if (total > maxBytes) {
        await reader.cancel().catch(() => undefined);
        throw new Error("Response body exceeded maximum allowed size");
      }
      chunks.push(Buffer.from(value.buffer, value.byteOffset, value.byteLength));
    }
  } finally {
    reader.releaseLock();
  }
  return Buffer.concat(chunks, total).toString("utf8");
}

async function sleepWithSignal(ms: number, signal: AbortSignal): Promise<void> {
  if (signal.aborted) throw new Error("登录已取消");
  await new Promise<void>((resolve, reject) => {
    const onAbort = () => {
      clearTimeout(timer);
      reject(new Error("登录已取消"));
    };
    const timer = setTimeout(() => {
      signal.removeEventListener("abort", onAbort);
      resolve();
    }, ms);
    signal.addEventListener("abort", onAbort, { once: true });
  });
}

function validateVerificationUri(raw: string, allowLoopbackHttp = false): string {
  const url = new URL(raw);
  if (url.protocol === "https:") return url.href;
  if (
    allowLoopbackHttp &&
    url.protocol === "http:" &&
    (url.hostname === "127.0.0.1" || url.hostname === "localhost")
  ) {
    return url.href;
  }
  throw new Error("OAuth 授权验证地址必须是 HTTPS 链接");
}

export interface OAuthEndpointOverrides {
  readonly fetchImpl?: typeof fetch;
  readonly validateDestination?: OAuthDestinationValidator;
  readonly now?: () => number;
  readonly pollIntervalFloorMs?: number;
  readonly codexAuthBaseUrl?: string;
  readonly codexRedirectUri?: string;
  readonly codexUsageUrl?: string;
  readonly githubBaseUrl?: string;
  readonly githubApiBaseUrl?: string;
  readonly xaiAuthBaseUrl?: string;
}

function createPkce(): { readonly verifier: string; readonly challenge: string } {
  const verifier = randomBytes(32).toString("base64url");
  const challenge = createHash("sha256").update(verifier).digest("base64url");
  return { verifier, challenge };
}

function parseAuthorizationCallbackInput(input: string): {
  code?: string | undefined;
  state?: string | undefined;
} {
  const trimmed = input.trim();
  if (!trimmed) return {};
  try {
    const parsed = new URL(trimmed);
    return {
      code: parsed.searchParams.get("code") ?? undefined,
      state: parsed.searchParams.get("state") ?? undefined,
    };
  } catch {
    // not a full URL
  }
  if (trimmed.includes("#")) {
    const [code, state] = trimmed.split("#", 2);
    return { code, state };
  }
  if (trimmed.includes("code=")) {
    const params = new URLSearchParams(trimmed);
    return {
      code: params.get("code") ?? undefined,
      state: params.get("state") ?? undefined,
    };
  }
  return { code: trimmed };
}

// ============================================================================
// GitHub Copilot refresh & model catalog sync
// ============================================================================

export function parseGitHubCopilotModelCatalog(
  raw: unknown,
  allowPolicyFallback: boolean,
): { readonly availableModelIds: string[]; readonly policyModelIds: string[] } {
  const data = isRecord(raw) ? raw.data : undefined;
  if (!Array.isArray(data)) {
    throw new Error("GitHub Copilot 模型列表格式异常");
  }
  const accountModels: Array<{ id: string; pickerEnabled: boolean; policyState?: unknown }> = [];
  for (const item of data) {
    if (!isRecord(item) || typeof item.id !== "string" || !item.id.trim()) continue;
    const capabilities = isRecord(item.capabilities) ? item.capabilities : undefined;
    const supports = capabilities && isRecord(capabilities.supports) ? capabilities.supports : undefined;
    if (supports?.tool_calls === false) continue;
    const policy = isRecord(item.policy) ? item.policy : undefined;
    accountModels.push({
      id: item.id.trim(),
      pickerEnabled: item.model_picker_enabled === true,
      policyState: policy?.state,
    });
  }
  const pickerModelIds = accountModels
    .filter((m) => m.pickerEnabled && m.policyState !== "disabled")
    .map((m) => m.id);
  const usePolicyFallback = allowPolicyFallback && pickerModelIds.length === 0;
  const availableModelIds =
    pickerModelIds.length > 0 || !allowPolicyFallback
      ? pickerModelIds
      : accountModels.filter((m) => m.policyState === "enabled").map((m) => m.id);
  const policyModelIds = accountModels
    .filter(
      (m) =>
        m.policyState === "unconfigured" &&
        KNOWN_COPILOT_MODEL_IDS.has(m.id) &&
        (m.pickerEnabled || usePolicyFallback),
    )
    .map((m) => m.id);
  return {
    availableModelIds: [...new Set(availableModelIds)],
    policyModelIds: [...new Set(policyModelIds)],
  };
}

async function exchangeGitHubForCopilotToken(
  githubAccessToken: string,
  enterpriseDomain: string | undefined,
  signal: AbortSignal,
  options: OAuthEndpointOverrides,
): Promise<{ readonly access: string; readonly expires: number }> {
  const fetchImpl = options.fetchImpl ?? globalThis.fetch;
  const validate = options.validateDestination ?? assertStrictOAuthDestination;
  const apiBase =
    options.githubApiBaseUrl ??
    (enterpriseDomain ? `https://api.${enterpriseDomain}` : "https://api.github.com");
  const tokenUrl = new URL(`${apiBase.replace(/\/+$/, "")}/copilot_internal/v2/token`);
  validate(
    "github-copilot",
    tokenUrl,
    "token_refresh",
    enterpriseDomain ? { enterpriseUrl: enterpriseDomain } : undefined,
  );
  const resp = await fetchImpl(tokenUrl, {
    method: "GET",
    headers: {
      Accept: "application/json",
      Authorization: `Bearer ${githubAccessToken}`,
      ...GITHUB_COPILOT_STATIC_HEADERS,
    },
    redirect: "error",
    signal,
  });
  const text = await readBoundedResponseText(resp);
  if (!resp.ok) {
    throw new Error(
      redactSecretsFromText(
        `GitHub Copilot token exchange failed (HTTP ${resp.status})`,
        [githubAccessToken],
      ),
    );
  }
  let parsed: unknown;
  try {
    parsed = JSON.parse(text);
  } catch {
    throw new Error("GitHub Copilot token response was not valid JSON");
  }
  if (!isRecord(parsed) || typeof parsed.token !== "string" || typeof parsed.expires_at !== "number") {
    throw new Error("GitHub Copilot token response missing fields");
  }
  return {
    access: parsed.token,
    expires: parsed.expires_at * 1000 - 5 * 60 * 1000,
  };
}

export async function fetchGitHubCopilotAvailableModels(
  copilotAccessToken: string,
  enterpriseDomain: string | undefined,
  signal: AbortSignal,
  options: OAuthEndpointOverrides,
  enableUnconfiguredPolicies: boolean,
): Promise<string[]> {
  const fetchImpl = options.fetchImpl ?? globalThis.fetch;
  const validate = options.validateDestination ?? assertStrictOAuthDestination;
  const baseUrl = deriveGitHubCopilotBaseUrl(copilotAccessToken, enterpriseDomain, validate);
  const modelsUrl = new URL(`${baseUrl}/models`);
  validate(
    "github-copilot",
    modelsUrl,
    "inference",
    enterpriseDomain ? { enterpriseUrl: enterpriseDomain } : undefined,
  );
  const resp = await fetchImpl(modelsUrl, {
    method: "GET",
    headers: {
      Accept: "application/json",
      Authorization: `Bearer ${copilotAccessToken}`,
      ...GITHUB_COPILOT_STATIC_HEADERS,
      "X-GitHub-Api-Version": GITHUB_COPILOT_API_VERSION,
    },
    redirect: "error",
    signal,
  });
  const text = await readBoundedResponseText(resp);
  if (!resp.ok) {
    throw new Error(`GitHub Copilot models fetch failed (HTTP ${resp.status})`);
  }
  const catalog = parseGitHubCopilotModelCatalog(
    JSON.parse(text),
    baseUrl === "https://api.individual.githubcopilot.com",
  );
  const enabled: string[] = [];
  if (enableUnconfiguredPolicies && catalog.policyModelIds.length > 0) {
    for (const modelId of catalog.policyModelIds) {
      if (signal.aborted) break;
      try {
        const policyUrl = new URL(`${baseUrl}/models/${encodeURIComponent(modelId)}/policy`);
        validate(
          "github-copilot",
          policyUrl,
          "inference",
          enterpriseDomain ? { enterpriseUrl: enterpriseDomain } : undefined,
        );
        const pResp = await fetchImpl(policyUrl, {
          method: "POST",
          headers: {
            "Content-Type": "application/json",
            Authorization: `Bearer ${copilotAccessToken}`,
            ...GITHUB_COPILOT_STATIC_HEADERS,
            "openai-intent": "chat-policy",
            "x-interaction-type": "chat-policy",
          },
          body: JSON.stringify({ state: "enabled" }),
          redirect: "error",
          signal,
        });
        await pResp.body?.cancel().catch(() => undefined);
        if (pResp.ok) enabled.push(modelId);
      } catch {
        // Best effort
      }
    }
  }
  return [...new Set([...catalog.availableModelIds, ...enabled])];
}

export async function refreshGithubCopilotOAuthToken(
  current: GithubCopilotOAuthCredentials,
  signal: AbortSignal,
  options: OAuthEndpointOverrides = {},
): Promise<GithubCopilotOAuthCredentials> {
  const enterpriseDomain = normalizeEnterpriseDomain(current.enterpriseUrl);
  const token = await exchangeGitHubForCopilotToken(
    current.refresh,
    enterpriseDomain,
    signal,
    options,
  );
  let availableModelIds = current.availableModelIds ? [...current.availableModelIds] : [];
  try {
    availableModelIds = await fetchGitHubCopilotAvailableModels(
      token.access,
      enterpriseDomain,
      signal,
      options,
      false,
    );
  } catch {
    // Keep prior allowlist if models refresh transiently fails while token exchange succeeded.
  }
  return {
    access: token.access,
    refresh: current.refresh,
    expires: token.expires,
    ...(enterpriseDomain ? { enterpriseUrl: enterpriseDomain } : {}),
    availableModelIds,
  };
}

// ============================================================================
// Plan Quota Queries (Codex, GitHub Copilot, DeepSeek, Kimi Coding, MiniMax, Zhipu)
// ============================================================================

export interface ChannelPlanQuotaWindow {
  readonly type: "5h" | "weekly" | "custom";
  readonly label: string;
  readonly remainingPercent: number;
  readonly usedPercent: number;
  readonly remainingLabel?: string;
  readonly showProgress?: boolean;
  readonly resetAt?: number;
}

export interface ChannelPlanQuotaResult {
  readonly supported: boolean;
  readonly provider: ProviderType;
  readonly planName?: string;
  readonly windows: readonly ChannelPlanQuotaWindow[];
  readonly updatedAt: number;
  readonly message?: string;
}

function clampPercent(value: number): number {
  if (!Number.isFinite(value)) return 0;
  return Math.max(0, Math.min(100, Math.round(value)));
}

function asFiniteNumber(value: unknown): number | undefined {
  if (value == null || value === "") return undefined;
  const n = typeof value === "number" ? value : Number(value);
  return Number.isFinite(n) ? n : undefined;
}

function toTimestampMs(value: unknown): number | undefined {
  if (typeof value === "string" && value.trim()) {
    const parsed = Date.parse(value.trim());
    if (Number.isFinite(parsed)) return parsed;
  }
  const n = asFiniteNumber(value);
  if (n === undefined || n <= 0) return undefined;
  return n < 10_000_000_000 ? n * 1000 : n;
}

function unsupportedQuota(provider: ProviderType, message: string, now: () => number): ChannelPlanQuotaResult {
  return { supported: false, provider, windows: [], updatedAt: now(), message };
}

export function parseCodexPlanQuotaResponse(
  data: unknown,
  now: () => number = Date.now,
): ChannelPlanQuotaResult {
  if (!isRecord(data)) {
    return unsupportedQuota("openai-codex", "ChatGPT Codex 额度响应格式错误", now);
  }
  const rateLimit = isRecord(data.rate_limit) ? data.rate_limit : undefined;
  const parseWindow = (raw: unknown): ChannelPlanQuotaWindow | null => {
    if (!isRecord(raw)) return null;
    const usedPercent = asFiniteNumber(raw.used_percent);
    const durationSeconds = asFiniteNumber(raw.limit_window_seconds);
    if (usedPercent === undefined || durationSeconds === undefined || durationSeconds <= 0) {
      return null;
    }
    let type: "5h" | "weekly" | "custom" = "custom";
    let label = "用量额度";
    if (durationSeconds === 5 * 3600) {
      type = "5h";
      label = "每 5 小时";
    } else if (durationSeconds === 7 * 86400) {
      type = "weekly";
      label = "每周额度";
    } else if (durationSeconds % 86400 === 0) {
      label = `每 ${durationSeconds / 86400} 天`;
    } else if (durationSeconds >= 3600 && durationSeconds % 3600 === 0) {
      label = `每 ${durationSeconds / 3600} 小时`;
    }
    const resetAfter = asFiniteNumber(raw.reset_after_seconds);
    const resetAt =
      toTimestampMs(raw.reset_at) ??
      (resetAfter !== undefined && resetAfter > 0 ? now() + resetAfter * 1000 : undefined);
    return {
      type,
      label,
      usedPercent: clampPercent(usedPercent),
      remainingPercent: clampPercent(100 - usedPercent),
      ...(resetAt !== undefined ? { resetAt } : {}),
    };
  };

  const windows = [parseWindow(rateLimit?.primary_window), parseWindow(rateLimit?.secondary_window)].filter(
    (w): w is ChannelPlanQuotaWindow => w !== null,
  );
  if (windows.length === 0) {
    return unsupportedQuota("openai-codex", "ChatGPT 未返回 Codex 订阅额度数据", now);
  }
  const planType = typeof data.plan_type === "string" && data.plan_type.trim() ? data.plan_type.trim() : "";
  const planName = planType
    ? `ChatGPT ${planType.replace(/[_-]+/g, " ").replace(/\b\w/g, (c) => c.toUpperCase())} (Codex)`
    : "ChatGPT 订阅 (Codex)";
  return { supported: true, provider: "openai-codex", planName, windows, updatedAt: now() };
}

export async function queryCodexPlanQuota(
  credentials: CodexOAuthCredentials,
  options: OAuthEndpointOverrides = {},
): Promise<ChannelPlanQuotaResult> {
  const now = options.now ?? Date.now;
  const fetchImpl = options.fetchImpl ?? globalThis.fetch;
  const validate = options.validateDestination ?? assertStrictOAuthDestination;
  const usageUrl = new URL(options.codexUsageUrl ?? "https://chatgpt.com/backend-api/wham/usage");
  validate("openai-codex", usageUrl, "inference");

  const headers: Record<string, string> = {
    Authorization: `Bearer ${credentials.access}`,
    Accept: "application/json",
    "User-Agent": CODING_PLAN_USER_AGENT,
  };
  const accountId = credentials.accountId ?? extractCodexAccountId(credentials.access);
  if (accountId) headers["ChatGPT-Account-Id"] = accountId;

  try {
    const resp = await fetchImpl(usageUrl, {
      method: "GET",
      headers,
      redirect: "error",
      signal: AbortSignal.timeout(CODEX_QUOTA_TIMEOUT_MS),
    });
    const text = await readBoundedResponseText(resp);
    if (!resp.ok) {
      return unsupportedQuota("openai-codex", `ChatGPT Codex 额度查询失败 (HTTP ${resp.status})`, now);
    }
    return parseCodexPlanQuotaResponse(JSON.parse(text), now);
  } catch (err) {
    if (err instanceof Error && (err.name === "TimeoutError" || err.name === "AbortError")) {
      return unsupportedQuota("openai-codex", "ChatGPT Codex 额度查询超时，请检查网络后重试", now);
    }
    return unsupportedQuota("openai-codex", "ChatGPT Codex 额度查询失败，请稍后重试", now);
  }
}

export function parseGithubCopilotPlanQuotaResponse(
  data: unknown,
  now: () => number = Date.now,
): ChannelPlanQuotaResult {
  if (!isRecord(data)) {
    return unsupportedQuota("github-copilot", "GitHub Copilot 额度响应格式错误", now);
  }
  const snapshots = isRecord(data.quota_snapshots) ? data.quota_snapshots : undefined;
  const resetAt = toTimestampMs(data.quota_reset_date);
  const buildWindow = (raw: unknown, label: string): ChannelPlanQuotaWindow | undefined => {
    if (!isRecord(raw)) return undefined;
    if (raw.unlimited === true) {
      return {
        type: "custom",
        label,
        remainingLabel: "不限额",
        remainingPercent: 0,
        usedPercent: 0,
        showProgress: false,
        ...(resetAt !== undefined ? { resetAt } : {}),
      };
    }
    const entitlement = asFiniteNumber(raw.entitlement);
    const remaining = asFiniteNumber(raw.remaining);
    if (entitlement === 0 && remaining === 0) return undefined;
    const pct =
      asFiniteNumber(raw.percent_remaining) ??
      (entitlement !== undefined && entitlement > 0 && remaining !== undefined
        ? (remaining / entitlement) * 100
        : undefined);
    if (pct === undefined) return undefined;
    const remainingPercent = Math.round(Math.max(0, Math.min(100, pct)) * 100) / 100;
    return {
      type: "custom",
      label,
      remainingPercent,
      usedPercent: Math.round((100 - remainingPercent) * 100) / 100,
      ...(entitlement !== undefined && entitlement > 0 && remaining !== undefined
        ? { remainingLabel: `${Math.max(0, remaining)} / ${entitlement}` }
        : {}),
      ...(resetAt !== undefined ? { resetAt } : {}),
    };
  };

  const windows: ChannelPlanQuotaWindow[] = [];
  const premium = buildWindow(snapshots?.premium_interactions, "Premium");
  if (premium) windows.push(premium);
  const monthly = isRecord(data.monthly_quotas) ? data.monthly_quotas : undefined;
  const limited = isRecord(data.limited_user_quotas) ? data.limited_user_quotas : undefined;
  for (const [key, label] of [
    ["chat", "Chat"],
    ["completions", "补全"],
  ] as const) {
    let win = buildWindow(snapshots?.[key], label);
    const ent = asFiniteNumber(monthly?.[key]);
    const rem = asFiniteNumber(limited?.[key]);
    if ((!win || win.showProgress === false) && ent !== undefined && ent > 0 && rem !== undefined) {
      win = buildWindow({ entitlement: ent, remaining: rem }, label);
    }
    if (win) windows.push(win);
  }
  if (data.token_based_billing === true) {
    windows.unshift({
      type: "custom",
      label: "计费方式",
      remainingLabel: "按量计费",
      remainingPercent: 0,
      usedPercent: 0,
      showProgress: false,
      ...(resetAt !== undefined ? { resetAt } : {}),
    });
  }
  if (windows.length === 0) {
    return unsupportedQuota("github-copilot", "GitHub Copilot 未返回可用额度数据", now);
  }
  const planMap: Record<string, string> = {
    free: "GitHub Copilot Free",
    individual: "GitHub Copilot 个人订阅",
    pro: "GitHub Copilot Pro",
    "pro+": "GitHub Copilot Pro+",
    pro_plus: "GitHub Copilot Pro+",
    business: "GitHub Copilot Business",
    enterprise: "GitHub Copilot Enterprise",
  };
  const planName =
    typeof data.copilot_plan === "string" && planMap[data.copilot_plan]
      ? planMap[data.copilot_plan]!
      : "GitHub Copilot";
  return { supported: true, provider: "github-copilot", planName, windows, updatedAt: now() };
}

export async function queryGithubCopilotPlanQuota(
  credentials: GithubCopilotOAuthCredentials,
  options: OAuthEndpointOverrides = {},
): Promise<ChannelPlanQuotaResult> {
  const now = options.now ?? Date.now;
  const fetchImpl = options.fetchImpl ?? globalThis.fetch;
  const validate = options.validateDestination ?? assertStrictOAuthDestination;

  if (!/^[A-Za-z0-9_.-]+$/.test(credentials.refresh)) {
    return unsupportedQuota("github-copilot", "GitHub Copilot 登录凭据无效，请重新登录", now);
  }
  let apiBase = options.githubApiBaseUrl;
  const enterpriseDomain = normalizeEnterpriseDomain(credentials.enterpriseUrl);
  if (!apiBase) {
    if (!enterpriseDomain || enterpriseDomain === "github.com") {
      apiBase = "https://api.github.com";
    } else if (enterpriseDomain.endsWith(".ghe.com")) {
      apiBase = enterpriseDomain.startsWith("api.")
        ? `https://${enterpriseDomain}`
        : `https://api.${enterpriseDomain}`;
    } else {
      return unsupportedQuota("github-copilot", "当前企业登录域暂不支持 Copilot 额度查询", now);
    }
  }
  const url = new URL(`${apiBase.replace(/\/+$/, "")}/copilot_internal/user`);
  validate(
    "github-copilot",
    url,
    "token_refresh",
    enterpriseDomain ? { enterpriseUrl: enterpriseDomain } : undefined,
  );
  try {
    const resp = await fetchImpl(url, {
      method: "GET",
      headers: {
        Authorization: `token ${credentials.refresh}`,
        Accept: "application/json",
        "Editor-Version": "vscode/1.96.2",
        "Editor-Plugin-Version": "copilot-chat/0.26.7",
        "User-Agent": "GitHubCopilotChat/0.26.7",
        "X-Github-Api-Version": "2025-04-01",
      },
      redirect: "error",
      signal: AbortSignal.timeout(15_000),
    });
    if (resp.status === 401) {
      await resp.body?.cancel().catch(() => undefined);
      return unsupportedQuota("github-copilot", "GitHub Copilot 登录已失效，请重新登录 (HTTP 401)", now);
    }
    if (resp.status === 403) {
      await resp.body?.cancel().catch(() => undefined);
      return unsupportedQuota("github-copilot", "GitHub Copilot 拒绝额度访问，请检查订阅权限 (HTTP 403)", now);
    }
    if (resp.status === 429) {
      await resp.body?.cancel().catch(() => undefined);
      return unsupportedQuota("github-copilot", "GitHub Copilot 额度查询过于频繁，请稍后重试 (HTTP 429)", now);
    }
    if (!resp.ok) {
      await resp.body?.cancel().catch(() => undefined);
      return unsupportedQuota("github-copilot", `GitHub Copilot 额度查询失败 (HTTP ${resp.status})`, now);
    }
    const text = await readBoundedResponseText(resp);
    return parseGithubCopilotPlanQuotaResponse(JSON.parse(text), now);
  } catch (err) {
    if (err instanceof Error && (err.name === "TimeoutError" || err.name === "AbortError")) {
      return unsupportedQuota("github-copilot", "GitHub Copilot 额度查询超时，请稍后重试", now);
    }
    return unsupportedQuota("github-copilot", "GitHub Copilot 额度查询失败，请检查网络后重试", now);
  }
}

export async function queryApiKeyPlanQuota(
  provider: ProviderType,
  apiKey: string,
  baseUrl: string,
  options: {
    readonly fetchImpl?: typeof fetch;
    readonly now?: () => number;
    readonly validateOutboundUrl?: (url: URL) => void;
  } = {},
): Promise<ChannelPlanQuotaResult> {
  const now = options.now ?? Date.now;
  const fetchImpl = options.fetchImpl ?? globalThis.fetch;
  const validateUrl = options.validateOutboundUrl ?? assertSafeOutboundUrl;

  try {
    if (provider === "deepseek") {
      const parsedBase = new URL(baseUrl || "https://api.deepseek.com");
      validateUrl(parsedBase);
      const balanceUrl = new URL(`${parsedBase.origin}/user/balance`);
      validateUrl(balanceUrl);
      const resp = await fetchImpl(balanceUrl, {
        method: "GET",
        headers: {
          Authorization: `Bearer ${apiKey}`,
          Accept: "application/json",
          "User-Agent": CODING_PLAN_USER_AGENT,
        },
        redirect: "error",
        signal: AbortSignal.timeout(15_000),
      });
      if (!resp.ok) {
        await resp.body?.cancel().catch(() => undefined);
        return unsupportedQuota(provider, `DeepSeek 余额查询失败 (HTTP ${resp.status})`, now);
      }
      const data = JSON.parse(await readBoundedResponseText(resp)) as Record<string, unknown>;
      const infos = Array.isArray(data.balance_infos) ? data.balance_infos : [];
      const first = (infos.find(
        (b) => isRecord(b) && String(b.currency ?? "").toUpperCase() === "CNY",
      ) ?? infos[0]) as Record<string, unknown> | undefined;
      if (!first) return unsupportedQuota(provider, "DeepSeek 未返回余额数据", now);
      const total = Number(first.total_balance ?? 0);
      const currency = String(first.currency ?? "").toUpperCase();
      const label =
        currency === "CNY" || currency === "RMB"
          ? `¥${total.toFixed(2)}`
          : currency === "USD"
            ? `$${total.toFixed(2)}`
            : `${currency} ${total.toFixed(2)}`.trim();
      return {
        supported: true,
        provider,
        planName: "DeepSeek 账户余额",
        windows: [
          {
            type: "custom",
            label: "账户余额",
            remainingPercent: data.is_available === false ? 0 : 100,
            usedPercent: data.is_available === false ? 100 : 0,
            remainingLabel: label,
            showProgress: false,
          },
        ],
        updatedAt: now(),
      };
    }

    if (provider === "kimi-coding") {
      const kimiUrl = new URL("https://api.kimi.com/coding/v1/usages");
      validateUrl(kimiUrl);
      const resp = await fetchImpl(kimiUrl, {
        method: "GET",
        headers: {
          Authorization: `Bearer ${apiKey}`,
          "Content-Type": "application/json",
          "User-Agent": CODING_PLAN_USER_AGENT,
        },
        redirect: "error",
        signal: AbortSignal.timeout(15_000),
      });
      if (!resp.ok) {
        await resp.body?.cancel().catch(() => undefined);
        return unsupportedQuota(provider, `Kimi 额度查询失败 (HTTP ${resp.status})`, now);
      }
      const data = JSON.parse(await readBoundedResponseText(resp)) as Record<string, unknown>;
      const usage = isRecord(data.usage) ? data.usage : undefined;
      if (!usage) return unsupportedQuota(provider, "Kimi 未返回订阅额度数据", now);
      const remaining = clampPercent(Number(usage.remaining ?? 0));
      const used = clampPercent(Number(usage.used ?? 100 - remaining));
      const kimiResetAt = toTimestampMs(usage.resetTime);
      const windows: ChannelPlanQuotaWindow[] = [
        {
          type: "weekly",
          label: "每周额度",
          remainingPercent: remaining,
          usedPercent: used,
          ...(kimiResetAt !== undefined ? { resetAt: kimiResetAt } : {}),
        },
      ];
      return { supported: true, provider, planName: "Kimi For Coding", windows, updatedAt: now() };
    }

    if (provider === "zhipu-coding" || provider === "zhipu-coding-team") {
      const team = provider === "zhipu-coding-team" ? parseZhipuTeamCredentials(apiKey) : null;
      const headers: Record<string, string> = {
        Authorization: team ? team.apiKey : apiKey,
        "Content-Type": "application/json",
        "User-Agent": CODING_PLAN_USER_AGENT,
      };
      if (team?.organization) headers["bigmodel-organization"] = team.organization;
      if (team?.project) headers["bigmodel-project"] = team.project;
      const url = new URL(
        provider === "zhipu-coding-team"
          ? "https://bigmodel.cn/api/monitor/usage/quota/limit?type=2"
          : "https://bigmodel.cn/api/monitor/usage/quota/limit",
      );
      validateUrl(url);
      const resp = await fetchImpl(url, {
        method: "GET",
        headers,
        redirect: "error",
        signal: AbortSignal.timeout(15_000),
      });
      if (!resp.ok) {
        await resp.body?.cancel().catch(() => undefined);
        return unsupportedQuota(provider, `智谱额度查询失败 (HTTP ${resp.status})`, now);
      }
      const body = JSON.parse(await readBoundedResponseText(resp)) as Record<string, unknown>;
      const limits = isRecord(body.data) && Array.isArray(body.data.limits) ? body.data.limits : [];
      const windows: ChannelPlanQuotaWindow[] = [];
      for (const item of limits) {
        if (!isRecord(item) || item.type !== "TOKENS_LIMIT") continue;
        const used = clampPercent(Number(item.percentage ?? 0));
        const type = item.unit === 3 ? "5h" : item.unit === 6 ? "weekly" : "custom";
        const zhipuResetAt = toTimestampMs(item.nextResetTime);
        windows.push({
          type,
          label: type === "5h" ? "每 5 小时" : type === "weekly" ? "每周额度" : "Token 额度",
          usedPercent: used,
          remainingPercent: clampPercent(100 - used),
          ...(zhipuResetAt !== undefined ? { resetAt: zhipuResetAt } : {}),
        });
      }
      if (windows.length === 0) {
        return unsupportedQuota(provider, "智谱未返回窗口额度数据", now);
      }
      return {
        supported: true,
        provider,
        planName: provider === "zhipu-coding-team" ? "GLM Coding Plan 团队版" : "GLM Coding Plan",
        windows,
        updatedAt: now(),
      };
    }

    return unsupportedQuota(provider, "当前渠道不支持订阅额度查询", now);
  } catch {
    return unsupportedQuota(provider, "额度查询失败，请检查网络后重试", now);
  }
}

// ============================================================================
// Interactive OAuth Login Flows (Codex, GitHub Copilot, xAI)
// ============================================================================

export type OAuthLoginPhase =
  | "starting"
  | "awaiting_user"
  | "exchanging"
  | "succeeded"
  | "failed"
  | "cancelled";

export type OAuthLoginMethod = "browser" | "device_code";

/** Redacted OAuth login session snapshot safe to send to renderer. ZERO raw tokens! */
export interface OAuthLoginSessionView {
  readonly sessionId: string;
  readonly provider: OAuthSubscriptionProvider;
  readonly channelId?: string;
  readonly channelName?: string;
  readonly method: OAuthLoginMethod;
  readonly phase: OAuthLoginPhase;
  readonly authUrl?: string;
  readonly userCode?: string;
  readonly verificationUri?: string;
  readonly manualCallbackSupported?: boolean;
  readonly accountLabel?: string;
  readonly availableModelCount?: number;
  readonly error?: string | undefined;
  readonly updatedAt: number;
}

export interface StartOAuthLoginInput {
  readonly provider: OAuthSubscriptionProvider;
  readonly channelId?: string;
  readonly channelName?: string;
  readonly method?: OAuthLoginMethod;
  readonly enterpriseUrl?: string;
}

export interface OAuthLoginCompletionMeta {
  readonly sessionId: string;
  readonly provider: OAuthSubscriptionProvider;
  readonly channelId?: string;
  readonly channelName?: string;
  readonly enterpriseUrl?: string;
}

export interface OAuthLoginSessionManagerOptions extends OAuthEndpointOverrides {
  readonly onCompleted: (
    credentials: OAuthSubscriptionCredentials,
    meta: OAuthLoginCompletionMeta,
  ) => Promise<{ readonly channelId: string; readonly availableModelCount?: number }>;
  readonly onSessionChanged?: (view: OAuthLoginSessionView) => void;
}

interface InternalOAuthSession {
  view: OAuthLoginSessionView;
  readonly controller: AbortController;
  promise: Promise<OAuthLoginSessionView>;
  submitManualInput?: (input: string) => void;
  closeServer?: () => Promise<void>;
  /**
   * Explicit commit state machine serializing `cancel()` against final credential persistence:
   * - `"idle"`: safe to cancel immediately; flow will abort and never call `onCompleted()`.
   * - `"committing"`: `onCompleted()` is actively persisting credentials; `cancel()` cannot lie
   *   and flip state to `"cancelled"`, and callers awaiting `cancelAndWait()` wait for commit settlement.
   * - `"committed"`: credentials persisted and session succeeded; `cancel()` is a no-op.
   * - `"cancelled"`: session cancelled before commit; flow MUST NEVER call `onCompleted()` or flip to `"succeeded"`.
   */
  commitState: "idle" | "committing" | "committed" | "cancelled";
  commitDone?: Promise<void>;
  resolveCommitDone?: () => void;
}

export class OAuthLoginSessionManager {
  private readonly options: OAuthLoginSessionManagerOptions;
  private readonly sessions = new Map<string, InternalOAuthSession>();
  private readonly activeByProvider = new Map<OAuthSubscriptionProvider, string>();

  constructor(options: OAuthLoginSessionManagerOptions) {
    this.options = options;
  }

  private now(): number {
    return (this.options.now ?? Date.now)();
  }

  getSession(sessionId: string): OAuthLoginSessionView | undefined {
    const s = this.sessions.get(sessionId);
    return s ? { ...s.view } : undefined;
  }

  listSessions(): OAuthLoginSessionView[] {
    return [...this.sessions.values()].map((s) => ({ ...s.view }));
  }

  private selectCancelTargets(
    sessionId?: string,
    provider?: OAuthSubscriptionProvider,
  ): InternalOAuthSession[] {
    const targets: InternalOAuthSession[] = [];
    if (sessionId) {
      const found = this.sessions.get(sessionId);
      if (found) targets.push(found);
    } else if (provider) {
      const activeId = this.activeByProvider.get(provider);
      if (activeId) {
        const found = this.sessions.get(activeId);
        if (found) targets.push(found);
      }
    } else {
      for (const s of this.sessions.values()) {
        if (s.view.phase === "starting" || s.view.phase === "awaiting_user" || s.view.phase === "exchanging") {
          targets.push(s);
        }
      }
    }
    return targets;
  }

  cancel(sessionId?: string, provider?: OAuthSubscriptionProvider): OAuthLoginSessionView[] {
    const targets = this.selectCancelTargets(sessionId, provider);
    for (const target of targets) {
      // Only cancel when commit has NOT started yet. If `onCompleted()` is actively committing
      // or already committed, do NOT overwrite state to `"cancelled"` (prevents persisted-yet-cancelled
      // inconsistency and prevents cancelled->succeeded state flips).
      if (
        target.commitState === "idle" &&
        (target.view.phase === "starting" ||
          target.view.phase === "awaiting_user" ||
          target.view.phase === "exchanging")
      ) {
        target.commitState = "cancelled";
        target.controller.abort();
        void target.closeServer?.().catch(() => undefined);
        target.view = {
          ...target.view,
          phase: "cancelled",
          updatedAt: this.now(),
        };
        this.options.onSessionChanged?.({ ...target.view });
      }
    }
    return targets.map((t) => ({ ...t.view }));
  }

  /**
   * Cancel active OAuth sessions and wait for any already-started commit lock to settle cleanly
   * so callers observe deterministic final state (`cancelled`, `succeeded`, or `failed`).
   */
  async cancelAndWait(
    sessionId?: string,
    provider?: OAuthSubscriptionProvider,
  ): Promise<OAuthLoginSessionView[]> {
    const targets = this.selectCancelTargets(sessionId, provider);
    this.cancel(sessionId, provider);
    for (const target of targets) {
      if (target.commitDone) {
        await target.commitDone;
      }
    }
    return targets.map((t) => ({ ...t.view }));
  }

  submitManualCallback(sessionId: string, callbackInput: string): boolean {
    const session = this.sessions.get(sessionId);
    if (!session || !session.submitManualInput || session.view.phase !== "awaiting_user") {
      return false;
    }
    session.submitManualInput(callbackInput);
    return true;
  }

  async waitForSession(sessionId: string): Promise<OAuthLoginSessionView | undefined> {
    const session = this.sessions.get(sessionId);
    if (!session) return undefined;
    return await session.promise;
  }

  async start(input: StartOAuthLoginInput): Promise<OAuthLoginSessionView> {
    // Cancel any existing active login for the same provider so callback ports don't collide.
    const existingId = this.activeByProvider.get(input.provider);
    if (existingId) {
      this.cancel(existingId);
    }

    const sessionId = randomUUID();
    const method: OAuthLoginMethod =
      input.provider === "openai-codex" ? (input.method ?? "browser") : "device_code";
    const controller = new AbortController();

    const update = (patch: Partial<OAuthLoginSessionView>) => {
      const current = this.sessions.get(sessionId);
      if (!current) return;
      current.view = {
        ...current.view,
        ...patch,
        updatedAt: this.now(),
      };
      this.options.onSessionChanged?.({ ...current.view });
    };

    const initialView: OAuthLoginSessionView = {
      sessionId,
      provider: input.provider,
      ...(input.channelId ? { channelId: input.channelId } : {}),
      ...(input.channelName ? { channelName: input.channelName } : {}),
      method,
      phase: "starting",
      updatedAt: this.now(),
    };

    let readyResolve!: (view: OAuthLoginSessionView) => void;
    let readyReject!: (err: Error) => void;
    const readyPromise = new Promise<OAuthLoginSessionView>((resolve, reject) => {
      readyResolve = resolve;
      readyReject = reject;
    });
    let readySettled = false;
    const markReady = () => {
      if (readySettled) return;
      readySettled = true;
      const cur = this.sessions.get(sessionId);
      readyResolve(cur ? { ...cur.view } : initialView);
    };
    const markFailedEarly = (err: Error) => {
      if (readySettled) return;
      readySettled = true;
      readyReject(err);
    };

    const sessionRecord: InternalOAuthSession = {
      view: initialView,
      controller,
      promise: Promise.resolve(initialView),
      commitState: "idle",
    };
    this.sessions.set(sessionId, sessionRecord);
    this.activeByProvider.set(input.provider, sessionId);

    const runPromise = (async (): Promise<OAuthLoginSessionView> => {
      try {
        let credentials: OAuthSubscriptionCredentials;
        if (input.provider === "openai-codex") {
          credentials =
            method === "device_code"
              ? await this.runCodexDeviceCodeFlow(sessionRecord, update, markReady)
              : await this.runCodexBrowserFlow(sessionRecord, update, markReady);
        } else if (input.provider === "github-copilot") {
          credentials = await this.runCopilotDeviceCodeFlow(
            input.enterpriseUrl,
            sessionRecord,
            update,
            markReady,
          );
        } else {
          credentials = await this.runXaiDeviceCodeFlow(sessionRecord, update, markReady);
        }

        // Atomic commit gate: if `cancel()` won before persistence starts, abort cleanly
        // WITHOUT calling `onCompleted()` and WITHOUT writing credentials.
        if (sessionRecord.commitState !== "idle" || controller.signal.aborted) {
          throw new Error("登录已取消");
        }
        sessionRecord.commitState = "committing";
        sessionRecord.commitDone = new Promise<void>((resolve) => {
          sessionRecord.resolveCommitDone = resolve;
        });

        update({ phase: "exchanging" });
        let saved: { readonly channelId: string; readonly availableModelCount?: number };
        try {
          saved = await this.options.onCompleted(credentials, {
            sessionId,
            provider: input.provider,
            ...(input.channelId ? { channelId: input.channelId } : {}),
            ...(input.channelName ? { channelName: input.channelName } : {}),
            ...(input.enterpriseUrl ? { enterpriseUrl: input.enterpriseUrl } : {}),
          });
        } catch (commitError) {
          sessionRecord.commitState = "cancelled";
          sessionRecord.resolveCommitDone?.();
          throw commitError;
        }

        const accountLabel =
          input.provider === "openai-codex"
            ? (credentials as CodexOAuthCredentials).accountId
            : input.provider === "github-copilot"
              ? (credentials as GithubCopilotOAuthCredentials).enterpriseUrl ?? "github.com"
              : "xAI Subscription";

        sessionRecord.commitState = "committed";
        update({
          phase: "succeeded",
          channelId: saved.channelId,
          ...(accountLabel ? { accountLabel } : {}),
          ...(saved.availableModelCount !== undefined
            ? { availableModelCount: saved.availableModelCount }
            : {}),
          error: undefined,
        });
        sessionRecord.resolveCommitDone?.();
        markReady();
        return { ...sessionRecord.view };
      } catch (error) {
        const cancelled = sessionRecord.commitState === "cancelled" || controller.signal.aborted;
        const safeMessage = cancelled
          ? undefined
          : redactSecretsFromText(
              error instanceof Error ? error.message : "OAuth 登录失败，请重试。",
            );
        if (sessionRecord.commitState !== "committed") {
          if (cancelled) sessionRecord.commitState = "cancelled";
          update({
            phase: cancelled ? "cancelled" : "failed",
            ...(safeMessage ? { error: safeMessage } : {}),
          });
        }
        sessionRecord.resolveCommitDone?.();
        if (!readySettled) {
          markFailedEarly(new Error(safeMessage ?? "登录已取消"));
        }
        return { ...sessionRecord.view };
      } finally {
        await sessionRecord.closeServer?.().catch(() => undefined);
        if (this.activeByProvider.get(input.provider) === sessionId) {
          this.activeByProvider.delete(input.provider);
        }
      }
    })();

    sessionRecord.promise = runPromise;
    return await readyPromise;
  }

  private async runCodexBrowserFlow(
    session: InternalOAuthSession,
    update: (patch: Partial<OAuthLoginSessionView>) => void,
    markReady: () => void,
  ): Promise<CodexOAuthCredentials> {
    const fetchImpl = this.options.fetchImpl ?? globalThis.fetch;
    const validate = this.options.validateDestination ?? assertStrictOAuthDestination;
    const authBase = (this.options.codexAuthBaseUrl ?? CODEX_AUTH_BASE_URL).replace(/\/+$/, "");
    const redirectUri = this.options.codexRedirectUri ?? CODEX_DEFAULT_REDIRECT_URI;
    const redirect = new URL(redirectUri);

    const { verifier, challenge } = createPkce();
    const state = randomBytes(16).toString("hex");
    const authorizeUrl = new URL(`${authBase}/oauth/authorize`);
    validate("openai-codex", authorizeUrl, "token_refresh");
    authorizeUrl.searchParams.set("response_type", "code");
    authorizeUrl.searchParams.set("client_id", CODEX_CLIENT_ID);
    authorizeUrl.searchParams.set("redirect_uri", redirectUri);
    authorizeUrl.searchParams.set("scope", CODEX_SCOPE);
    authorizeUrl.searchParams.set("code_challenge", challenge);
    authorizeUrl.searchParams.set("code_challenge_method", "S256");
    authorizeUrl.searchParams.set("state", state);
    authorizeUrl.searchParams.set("id_token_add_organizations", "true");
    authorizeUrl.searchParams.set("codex_cli_simplified_flow", "true");
    authorizeUrl.searchParams.set("originator", "pi");

    let settled = false;
    let resolveCode!: (code: string) => void;
    let rejectCode!: (err: Error) => void;
    const codePromise = new Promise<string>((resolve, reject) => {
      resolveCode = resolve;
      rejectCode = reject;
    });
    void codePromise.catch(() => undefined);

    session.submitManualInput = (rawInput: string) => {
      if (settled) return;
      const parsed = parseAuthorizationCallbackInput(rawInput);
      if (parsed.state && parsed.state !== state) {
        settled = true;
        rejectCode(new Error("回调 state 校验失败，请重新登录。"));
        return;
      }
      if (!parsed.code) {
        return;
      }
      settled = true;
      resolveCode(parsed.code);
    };

    const onAbort = () => {
      if (!settled) {
        settled = true;
        rejectCode(new Error("登录已取消"));
      }
    };
    session.controller.signal.addEventListener("abort", onAbort, { once: true });

    // Best-effort loopback callback server on :1455 (falls back to manual paste if taken by Codex CLI).
    const nonce = randomBytes(16).toString("base64url");
    const listener: RequestListener = (req: IncomingMessage, res: ServerResponse) => {
      res.setHeader("Cache-Control", "no-store");
      res.setHeader("Referrer-Policy", "no-referrer");
      res.setHeader(
        "Content-Security-Policy",
        `default-src 'none'; script-src 'nonce-${nonce}'; frame-ancestors 'none'`,
      );
      if (req.method !== "GET" || req.headers.host !== redirect.host) {
        res.writeHead(400).end("Invalid callback");
        return;
      }
      const reqUrl = new URL(req.url ?? "/", redirectUri);
      if (reqUrl.pathname === "/complete") {
        res.writeHead(200, { "Content-Type": "text/plain; charset=utf-8" });
        res.end("ChatGPT 登录已完成，请返回小瞳 Work。");
        return;
      }
      if (
        settled ||
        reqUrl.pathname !== redirect.pathname ||
        reqUrl.searchParams.get("state") !== state
      ) {
        res.writeHead(400).end("Invalid callback");
        return;
      }
      const error = reqUrl.searchParams.get("error");
      const code = reqUrl.searchParams.get("code");
      if (!error && !code) {
        res.writeHead(400).end("Missing code");
        return;
      }
      settled = true;
      res.writeHead(200, { "Content-Type": "text/html; charset=utf-8" });
      res.end(
        `<!doctype html><meta charset="utf-8"><title>小瞳 Work</title>` +
          `<script nonce="${nonce}">history.replaceState(null,'','/complete')</script>` +
          `<p>ChatGPT 授权已收到，请返回小瞳 Work。</p>`,
      );
      if (error) rejectCode(new Error("ChatGPT 授权被取消或失败，请重试。"));
      else resolveCode(code!);
    };

    const servers: Server[] = [createServer(listener)];
    if (redirect.hostname === "localhost") servers.push(createServer(listener));
    session.closeServer = async () => {
      await Promise.all(
        servers.map(
          (srv) =>
            new Promise<void>((r) => {
              if (!srv.listening) return r();
              srv.close(() => r());
              srv.closeAllConnections();
            }),
        ),
      );
    };

    const port = Number(redirect.port);
    await Promise.all(
      servers.map(
        (srv, idx) =>
          new Promise<void>((resolveBind) => {
            srv.once("error", () => resolveBind()); // Fallback to manual paste if :1455 busy
            srv.listen(port, idx === 0 ? "127.0.0.1" : "::1", () => resolveBind());
          }),
      ),
    );

    update({
      phase: "awaiting_user",
      authUrl: authorizeUrl.toString(),
      manualCallbackSupported: true,
    });
    markReady();

    try {
      const code = await codePromise;
      await session.closeServer();
      update({ phase: "exchanging" });

      const tokenUrl = new URL(`${authBase}/oauth/token`);
      validate("openai-codex", tokenUrl, "token_refresh");
      const tokenResp = await fetchImpl(tokenUrl, {
        method: "POST",
        headers: { "Content-Type": "application/x-www-form-urlencoded", Accept: "application/json" },
        body: new URLSearchParams({
          grant_type: "authorization_code",
          client_id: CODEX_CLIENT_ID,
          code,
          code_verifier: verifier,
          redirect_uri: redirectUri,
        }),
        redirect: "error",
        signal: AbortSignal.any([session.controller.signal, AbortSignal.timeout(REQUEST_TIMEOUT_MS)]),
      });
      const text = await readBoundedResponseText(tokenResp);
      if (!tokenResp.ok) {
        throw new Error(`ChatGPT Token 交换失败 (HTTP ${tokenResp.status})`);
      }
      const json = JSON.parse(text) as Record<string, unknown>;
      if (
        typeof json.access_token !== "string" ||
        typeof json.refresh_token !== "string" ||
        typeof json.expires_in !== "number"
      ) {
        throw new Error("ChatGPT OAuth 返回缺少必要字段");
      }
      const accountId = extractCodexAccountId(json.access_token);
      if (!accountId) {
        throw new Error("无法从 ChatGPT 凭据中解析账号标识");
      }
      return {
        access: json.access_token,
        refresh: json.refresh_token,
        expires: this.now() + json.expires_in * 1000,
        accountId,
      };
    } finally {
      session.controller.signal.removeEventListener("abort", onAbort);
      await session.closeServer();
    }
  }

  private async runCodexDeviceCodeFlow(
    session: InternalOAuthSession,
    update: (patch: Partial<OAuthLoginSessionView>) => void,
    markReady: () => void,
  ): Promise<CodexOAuthCredentials> {
    const fetchImpl = this.options.fetchImpl ?? globalThis.fetch;
    const validate = this.options.validateDestination ?? assertStrictOAuthDestination;
    const authBase = (this.options.codexAuthBaseUrl ?? CODEX_AUTH_BASE_URL).replace(/\/+$/, "");
    const userCodeUrl = new URL(`${authBase}/api/accounts/deviceauth/usercode`);
    validate("openai-codex", userCodeUrl, "token_refresh");

    const startResp = await fetchImpl(userCodeUrl, {
      method: "POST",
      headers: { "Content-Type": "application/json", Accept: "application/json" },
      body: JSON.stringify({ client_id: CODEX_CLIENT_ID }),
      redirect: "error",
      signal: AbortSignal.any([session.controller.signal, AbortSignal.timeout(REQUEST_TIMEOUT_MS)]),
    });
    const startText = await readBoundedResponseText(startResp);
    if (!startResp.ok) {
      throw new Error(`ChatGPT 设备码申请失败 (HTTP ${startResp.status})`);
    }
    const startJson = JSON.parse(startText) as Record<string, unknown>;
    const deviceAuthId = typeof startJson.device_auth_id === "string" ? startJson.device_auth_id : "";
    const userCode = typeof startJson.user_code === "string" ? startJson.user_code : "";
    const intervalSec = Number(startJson.interval ?? 5);
    if (!deviceAuthId || !userCode || !Number.isFinite(intervalSec) || intervalSec < 0) {
      throw new Error("ChatGPT 设备码响应格式异常");
    }

    const verificationUri = `${authBase}/codex/device`;
    update({
      phase: "awaiting_user",
      userCode,
      verificationUri,
    });
    markReady();

    const pollUrl = new URL(`${authBase}/api/accounts/deviceauth/token`);
    validate("openai-codex", pollUrl, "token_refresh");
    const deadline = this.now() + 15 * 60 * 1000;
    let pollMs = Math.max(this.options.pollIntervalFloorMs ?? 1000, intervalSec * 1000);

    let authCode = "";
    let codeVerifier = "";
    while (this.now() < deadline) {
      await sleepWithSignal(pollMs, session.controller.signal);
      const pollResp = await fetchImpl(pollUrl, {
        method: "POST",
        headers: { "Content-Type": "application/json", Accept: "application/json" },
        body: JSON.stringify({ device_auth_id: deviceAuthId, user_code: userCode }),
        redirect: "error",
        signal: AbortSignal.any([session.controller.signal, AbortSignal.timeout(REQUEST_TIMEOUT_MS)]),
      });
      if (pollResp.ok) {
        const data = JSON.parse(await readBoundedResponseText(pollResp)) as Record<string, unknown>;
        if (typeof data.authorization_code === "string" && typeof data.code_verifier === "string") {
          authCode = data.authorization_code;
          codeVerifier = data.code_verifier;
          break;
        }
        throw new Error("ChatGPT 设备码授权响应格式异常");
      }
      if (pollResp.status === 403 || pollResp.status === 404) {
        await pollResp.body?.cancel().catch(() => undefined);
        continue;
      }
      const errBody = await readBoundedResponseText(pollResp).catch(() => "");
      if (errBody.includes("slow_down")) {
        pollMs += 5000;
        continue;
      }
      if (errBody.includes("authorization_pending")) continue;
      throw new Error(`ChatGPT 设备码授权失败 (HTTP ${pollResp.status})`);
    }
    if (!authCode || !codeVerifier) {
      throw new Error("ChatGPT 设备码授权已过期，请重试。");
    }

    update({ phase: "exchanging" });
    const tokenUrl = new URL(`${authBase}/oauth/token`);
    validate("openai-codex", tokenUrl, "token_refresh");
    const tokenResp = await fetchImpl(tokenUrl, {
      method: "POST",
      headers: { "Content-Type": "application/x-www-form-urlencoded", Accept: "application/json" },
      body: new URLSearchParams({
        grant_type: "authorization_code",
        client_id: CODEX_CLIENT_ID,
        code: authCode,
        code_verifier: codeVerifier,
        redirect_uri: `${authBase}/deviceauth/callback`,
      }),
      redirect: "error",
      signal: AbortSignal.any([session.controller.signal, AbortSignal.timeout(REQUEST_TIMEOUT_MS)]),
    });
    const text = await readBoundedResponseText(tokenResp);
    if (!tokenResp.ok) {
      throw new Error(`ChatGPT Token 交换失败 (HTTP ${tokenResp.status})`);
    }
    const json = JSON.parse(text) as Record<string, unknown>;
    if (
      typeof json.access_token !== "string" ||
      typeof json.refresh_token !== "string" ||
      typeof json.expires_in !== "number"
    ) {
      throw new Error("ChatGPT OAuth 响应缺少必要字段");
    }
    const accountId = extractCodexAccountId(json.access_token);
    if (!accountId) throw new Error("无法解析 ChatGPT 账号标识");
    return {
      access: json.access_token,
      refresh: json.refresh_token,
      expires: this.now() + json.expires_in * 1000,
      accountId,
    };
  }

  private async runCopilotDeviceCodeFlow(
    rawEnterpriseUrl: string | undefined,
    session: InternalOAuthSession,
    update: (patch: Partial<OAuthLoginSessionView>) => void,
    markReady: () => void,
  ): Promise<GithubCopilotOAuthCredentials> {
    const fetchImpl = this.options.fetchImpl ?? globalThis.fetch;
    const validate = this.options.validateDestination ?? assertStrictOAuthDestination;
    const enterpriseDomain = normalizeEnterpriseDomain(rawEnterpriseUrl);
    const domain = enterpriseDomain ?? "github.com";
    const ghBase = (this.options.githubBaseUrl ?? `https://${domain}`).replace(/\/+$/, "");

    const deviceUrl = new URL(`${ghBase}/login/device/code`);
    validate(
      "github-copilot",
      deviceUrl,
      "token_refresh",
      enterpriseDomain ? { enterpriseUrl: enterpriseDomain } : undefined,
    );
    const deviceResp = await fetchImpl(deviceUrl, {
      method: "POST",
      headers: {
        Accept: "application/json",
        "Content-Type": "application/x-www-form-urlencoded",
        "User-Agent": GITHUB_COPILOT_STATIC_HEADERS["User-Agent"]!,
      },
      body: new URLSearchParams({ client_id: GITHUB_COPILOT_CLIENT_ID, scope: "read:user" }),
      redirect: "error",
      signal: AbortSignal.any([session.controller.signal, AbortSignal.timeout(REQUEST_TIMEOUT_MS)]),
    });
    const deviceText = await readBoundedResponseText(deviceResp);
    if (!deviceResp.ok) {
      throw new Error(`GitHub Copilot 设备码申请失败 (HTTP ${deviceResp.status})`);
    }
    const deviceJson = JSON.parse(deviceText) as Record<string, unknown>;
    const deviceCode = typeof deviceJson.device_code === "string" ? deviceJson.device_code : "";
    const userCode = typeof deviceJson.user_code === "string" ? deviceJson.user_code : "";
    const rawVerificationUri =
      typeof deviceJson.verification_uri === "string" ? deviceJson.verification_uri : "";
    const expiresIn = typeof deviceJson.expires_in === "number" ? deviceJson.expires_in : 900;
    const intervalSec = typeof deviceJson.interval === "number" ? deviceJson.interval : 5;
    if (!deviceCode || !userCode || !rawVerificationUri) {
      throw new Error("GitHub Copilot 设备码响应格式异常");
    }
    const verificationUri = validateVerificationUri(
      rawVerificationUri,
      this.options.validateDestination !== undefined,
    );

    update({
      phase: "awaiting_user",
      userCode,
      verificationUri,
    });
    markReady();

    const accessUrl = new URL(`${ghBase}/login/oauth/access_token`);
    validate(
      "github-copilot",
      accessUrl,
      "token_refresh",
      enterpriseDomain ? { enterpriseUrl: enterpriseDomain } : undefined,
    );
    const deadline = this.now() + expiresIn * 1000;
    let pollMs = Math.max(this.options.pollIntervalFloorMs ?? 1000, intervalSec * 1000);
    let githubToken = "";

    while (this.now() < deadline) {
      await sleepWithSignal(pollMs, session.controller.signal);
      const pollResp = await fetchImpl(accessUrl, {
        method: "POST",
        headers: {
          Accept: "application/json",
          "Content-Type": "application/x-www-form-urlencoded",
          "User-Agent": GITHUB_COPILOT_STATIC_HEADERS["User-Agent"]!,
        },
        body: new URLSearchParams({
          client_id: GITHUB_COPILOT_CLIENT_ID,
          device_code: deviceCode,
          grant_type: "urn:ietf:params:oauth:grant-type:device_code",
        }),
        redirect: "error",
        signal: AbortSignal.any([session.controller.signal, AbortSignal.timeout(REQUEST_TIMEOUT_MS)]),
      });
      const pollJson = JSON.parse(await readBoundedResponseText(pollResp)) as Record<string, unknown>;
      if (typeof pollJson.access_token === "string" && pollJson.access_token.length > 0) {
        githubToken = pollJson.access_token;
        break;
      }
      const errCode = typeof pollJson.error === "string" ? pollJson.error : "";
      if (errCode === "authorization_pending") continue;
      if (errCode === "slow_down") {
        pollMs =
          typeof pollJson.interval === "number"
            ? Math.max(pollMs, pollJson.interval * 1000)
            : pollMs + 5000;
        continue;
      }
      if (errCode === "expired_token") {
        throw new Error("GitHub Copilot 设备码已过期，请重新登录。");
      }
      if (errCode === "access_denied") {
        throw new Error("GitHub Copilot 授权已被拒绝。");
      }
      throw new Error(`GitHub Copilot 授权失败：${errCode || "未知错误"}`);
    }
    if (!githubToken) {
      throw new Error("GitHub Copilot 设备码授权超时，请重新登录。");
    }

    update({ phase: "exchanging" });
    const exchanged = await exchangeGitHubForCopilotToken(
      githubToken,
      enterpriseDomain,
      session.controller.signal,
      this.options,
    );
    const availableModelIds = await fetchGitHubCopilotAvailableModels(
      exchanged.access,
      enterpriseDomain,
      session.controller.signal,
      this.options,
      true,
    );

    return {
      access: exchanged.access,
      refresh: githubToken,
      expires: exchanged.expires,
      ...(enterpriseDomain ? { enterpriseUrl: enterpriseDomain } : {}),
      availableModelIds,
    };
  }

  private async runXaiDeviceCodeFlow(
    session: InternalOAuthSession,
    update: (patch: Partial<OAuthLoginSessionView>) => void,
    markReady: () => void,
  ): Promise<XaiOAuthCredentials> {
    const fetchImpl = this.options.fetchImpl ?? globalThis.fetch;
    const validate = this.options.validateDestination ?? assertStrictOAuthDestination;
    const xaiAuthBase = (this.options.xaiAuthBaseUrl ?? XAI_AUTH_BASE_URL).replace(/\/+$/, "");

    const deviceUrl = new URL(`${xaiAuthBase}/oauth2/device/code`);
    validate("xai", deviceUrl, "token_refresh");
    const deviceResp = await fetchImpl(deviceUrl, {
      method: "POST",
      headers: {
        Accept: "application/json",
        "Content-Type": "application/x-www-form-urlencoded",
      },
      body: new URLSearchParams({
        client_id: XAI_CLIENT_ID,
        scope: XAI_SCOPE,
        referrer: "pi",
      }),
      redirect: "error",
      signal: AbortSignal.any([session.controller.signal, AbortSignal.timeout(REQUEST_TIMEOUT_MS)]),
    });
    const deviceText = await readBoundedResponseText(deviceResp);
    if (!deviceResp.ok) {
      throw new Error(`xAI 设备码申请失败 (HTTP ${deviceResp.status})`);
    }
    const deviceJson = JSON.parse(deviceText) as Record<string, unknown>;
    const deviceCode = typeof deviceJson.device_code === "string" ? deviceJson.device_code : "";
    const userCode = typeof deviceJson.user_code === "string" ? deviceJson.user_code : "";
    const rawUri =
      (typeof deviceJson.verification_uri_complete === "string" &&
      deviceJson.verification_uri_complete.length > 0
        ? deviceJson.verification_uri_complete
        : typeof deviceJson.verification_uri === "string"
          ? deviceJson.verification_uri
          : "");
    const expiresIn = typeof deviceJson.expires_in === "number" ? deviceJson.expires_in : 600;
    const intervalSec =
      typeof deviceJson.interval === "number" && deviceJson.interval > 0 ? deviceJson.interval : 5;
    if (!deviceCode || !userCode || !rawUri) {
      throw new Error("xAI 设备码响应格式异常");
    }
    const verificationUri = validateVerificationUri(
      rawUri,
      this.options.validateDestination !== undefined,
    );

    update({
      phase: "awaiting_user",
      userCode,
      verificationUri,
    });
    markReady();

    const tokenUrl = new URL(`${xaiAuthBase}/oauth2/token`);
    validate("xai", tokenUrl, "token_refresh");
    const deadline = this.now() + expiresIn * 1000;
    let pollMs = Math.max(this.options.pollIntervalFloorMs ?? 1000, intervalSec * 1000);

    while (this.now() < deadline) {
      await sleepWithSignal(pollMs, session.controller.signal);
      const pollResp = await fetchImpl(tokenUrl, {
        method: "POST",
        headers: {
          Accept: "application/json",
          "Content-Type": "application/x-www-form-urlencoded",
        },
        body: new URLSearchParams({
          grant_type: "urn:ietf:params:oauth:grant-type:device_code",
          client_id: XAI_CLIENT_ID,
          device_code: deviceCode,
        }),
        redirect: "error",
        signal: AbortSignal.any([session.controller.signal, AbortSignal.timeout(REQUEST_TIMEOUT_MS)]),
      });
      const pollJson = JSON.parse(await readBoundedResponseText(pollResp)) as Record<string, unknown>;
      if (pollResp.ok) {
        if (
          typeof pollJson.access_token !== "string" ||
          typeof pollJson.refresh_token !== "string"
        ) {
          throw new Error("xAI OAuth 响应缺少必要字段");
        }
        const expiresInSec =
          typeof pollJson.expires_in === "number" && pollJson.expires_in > 0
            ? pollJson.expires_in
            : 3600;
        return {
          access: pollJson.access_token,
          refresh: pollJson.refresh_token,
          expires: this.now() + expiresInSec * 1000,
        };
      }
      const errCode = typeof pollJson.error === "string" ? pollJson.error : "";
      if (errCode === "authorization_pending") continue;
      if (errCode === "slow_down") {
        pollMs =
          typeof pollJson.interval === "number"
            ? Math.max(pollMs, pollJson.interval * 1000)
            : pollMs + 5000;
        continue;
      }
      if (errCode === "access_denied" || errCode === "authorization_denied") {
        throw new Error("xAI 授权已被拒绝。");
      }
      if (errCode === "expired_token") {
        throw new Error("xAI 设备码已过期，请重新登录。");
      }
      throw new Error(`xAI 授权失败：${errCode || `HTTP ${pollResp.status}`}`);
    }
    throw new Error("xAI 设备码授权超时，请重新登录。");
  }
}
