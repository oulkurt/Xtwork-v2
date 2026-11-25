// @effect-diagnostics nodeBuiltinImport:off globalFetch:off globalDate:off -- Channel manager persists redacted metadata, manages hardened SecretStore credentials, and coordinates gateway/Pi live updates.
/**
 * Xtwork Model Channel Manager & Gateway/Live-Pi Coordinator (ADR-012 §2, §3.1–§3.4).
 *
 * Security & Persistence Invariants:
 * - `<dataDir>/channels/channels.json` (0600, atomic temp + rename) stores ONLY redacted channel metadata.
 * - ZERO plaintext API keys, company `sk-` keys, or OAuth `access`/`refresh` tokens ever appear in
 *   `channels.json`, `models.json`, logs, HTTP responses, error messages, or renderer payloads.
 * - ALL secrets live exclusively in the hardened OS SecretStore (`app.xtwork.model-channels`) protected
 *   by `ChannelCredentialFence` / `OAuthTokenManager`.
 * - Channel deletion, OAuth logout, and Company logout execute read-back verified `SecretStore.delete`
 *   FIRST. If deletion fails, existing state is preserved and an explicit error is thrown.
 * - All outbound HTTP requests enforce strict HTTPS URL validation, `redirect: "error"`, timeouts,
 *   and bounded response reads.
 */

import { randomUUID } from "node:crypto";
import { mkdir, readFile, rename, rm, writeFile } from "node:fs/promises";
import { dirname, join } from "node:path";
import {
  CompanyAuthService,
  COMPANY_SECRET_REF,
  type CompanyAuthServiceOptions,
  type CompanyAuthState,
  type CompanyUrlValidator,
} from "./companyAuth.ts";
import {
  CODING_PLAN_USER_AGENT,
  COMPANY_CHANNEL_ID,
  COMPANY_DEFAULT_MODEL_ID,
  formatModelSlug,
  parseZhipuTeamCredentials,
  resolveFallbackModel,
  type GatewayChannelConfig,
} from "./gateway.ts";
import {
  fetchGitHubCopilotAvailableModels,
  OAuthLoginSessionManager,
  queryApiKeyPlanQuota,
  queryCodexPlanQuota,
  queryGithubCopilotPlanQuota,
  redactSecretsFromText,
  refreshCodexOAuthToken,
  refreshGithubCopilotOAuthToken,
  refreshXaiOAuthToken,
  type ChannelPlanQuotaResult,
  type OAuthEndpointOverrides,
  type OAuthLoginSessionView,
  type StartOAuthLoginInput,
} from "./oauthLoginFlows.ts";
import {
  isCopilotModelPermitted,
  normalizeEnterpriseDomain,
  OAuthTokenManager,
  type CodexOAuthCredentials,
  type GithubCopilotOAuthCredentials,
  type OAuthSubscriptionCredentials,
  type OAuthSubscriptionProvider,
  type XaiOAuthCredentials,
} from "./oauthProxy.ts";
import {
  assertNoUrlCredentials,
  assertSafeOutboundUrl,
  canonicalizeModelId,
  CODEX_STATIC_MODELS,
  COMPANY_TEAM_BASE_URL,
  COMPANY_TEAM_CHANNEL_NAME,
  compileChannelToGatewayConfig,
  getProviderSpec,
  GITHUB_COPILOT_STATIC_MODELS,
  isAgentCapableModelId,
  isOAuthProviderType,
  isProviderType,
  listProviderCatalogSpecs,
  normalizeBaseUrl,
  PROVIDER_CATALOG_VERSION,
  resolveAnthropicMessagesUrl,
  resolveAnthropicModelsUrl,
  resolveGoogleModelsUrl,
  resolveOpenAIModelsUrl,
  stripUrlCredentialsForLoad,
  XAI_STATIC_MODELS,
  type ProviderCapabilitySpec,
  type ProviderType,
  type StoredChannelModel,
} from "./providerCatalog.ts";
import {
  ChannelCredentialFence,
  createSecretStore,
  MODEL_CHANNELS_SECRET_NAMESPACE,
  SecretStoreUnavailableError,
  type SecretStore,
} from "./secretStore.ts";

const CHANNELS_SCHEMA_VERSION = 1;
const DEFAULT_REQUEST_TIMEOUT_MS = 15_000;
const MAX_ERROR_BODY_BYTES = 16 * 1024;
const MAX_MODELS_BODY_BYTES = 2 * 1024 * 1024;
const MAX_ERROR_DETAIL_LENGTH = 500;

export const TEAM_CHANNEL_IMMUTABLE_FIELDS = Object.freeze([
  "name",
  "provider",
  "baseUrl",
  "apiKey",
  "delete",
] as const);

export type ImmutableChannelField = (typeof TEAM_CHANNEL_IMMUTABLE_FIELDS)[number];

export type ChannelTestErrorType =
  | "auth"
  | "permission"
  | "not_found"
  | "rate_limit"
  | "quota"
  | "bad_request"
  | "server"
  | "network"
  | "timeout"
  | "unknown";

export interface ChannelTestResult {
  readonly success: boolean;
  readonly message: string;
  readonly errorType?: ChannelTestErrorType;
  readonly statusCode?: number;
  readonly detail?: string;
}

export interface FetchChannelModelsResult {
  readonly success: boolean;
  readonly message: string;
  readonly models: readonly StoredChannelModel[];
  readonly errorType?: ChannelTestErrorType;
  readonly statusCode?: number;
}

export interface StoredChannelRecord {
  readonly id: string;
  readonly name: string;
  readonly provider: ProviderType;
  readonly baseUrl: string;
  readonly enabled: boolean;
  readonly models: readonly StoredChannelModel[];
  readonly secretRef?: string;
  readonly enterpriseUrl?: string;
  readonly availableModelIds?: readonly string[];
  readonly accountLabel?: string;
  readonly createdAt: number;
  readonly updatedAt: number;
}

interface ChannelsDiskFile {
  readonly version: number;
  readonly channels: readonly StoredChannelRecord[];
}

/** Redacted channel representation returned to HTTP routes and renderer. ZERO credentials! */
export interface RedactedChannel {
  readonly id: string;
  readonly name: string;
  readonly provider: ProviderType;
  readonly baseUrl: string;
  readonly enabled: boolean;
  readonly models: readonly StoredChannelModel[];
  readonly hasCredentials: boolean;
  readonly isTeamChannel: boolean;
  readonly immutableFields: readonly ImmutableChannelField[];
  readonly enterpriseUrl?: string;
  readonly availableModelIds?: readonly string[];
  readonly accountLabel?: string;
  readonly createdAt: number;
  readonly updatedAt: number;
}

export interface ModelChannelsStateSnapshot {
  readonly catalogVersion: typeof PROVIDER_CATALOG_VERSION;
  readonly catalog: readonly ProviderCapabilitySpec[];
  readonly channels: readonly RedactedChannel[];
  readonly companyAuth: CompanyAuthState;
  readonly oauthSessions: readonly OAuthLoginSessionView[];
  readonly defaultModelSlug: string | null;
  readonly zeroChannelState: boolean;
  readonly enabledModelCount: number;
}

export interface ZhipuTeamCredentialInput {
  readonly apiKey: string;
  readonly organization?: string;
  readonly project?: string;
}

export interface CreateChannelInput {
  readonly id?: string;
  readonly name: string;
  readonly provider: ProviderType;
  readonly baseUrl?: string;
  readonly apiKey?: string;
  readonly zhipuTeam?: ZhipuTeamCredentialInput;
  readonly enabled?: boolean;
  readonly models?: readonly StoredChannelModel[];
  readonly enterpriseUrl?: string;
}

export interface UpdateChannelInput {
  readonly name?: string;
  readonly provider?: ProviderType;
  readonly baseUrl?: string;
  readonly apiKey?: string;
  readonly zhipuTeam?: ZhipuTeamCredentialInput;
  readonly enabled?: boolean;
  readonly models?: readonly StoredChannelModel[];
  readonly enterpriseUrl?: string;
}

export interface TestChannelDirectInput {
  readonly channelId?: string;
  readonly provider: ProviderType;
  readonly baseUrl?: string;
  readonly apiKey?: string;
  readonly zhipuTeam?: ZhipuTeamCredentialInput;
  readonly modelId?: string;
  readonly models?: readonly StoredChannelModel[];
}

export interface FetchChannelModelsInput {
  readonly channelId?: string;
  readonly provider: ProviderType;
  readonly baseUrl?: string;
  readonly apiKey?: string;
  readonly zhipuTeam?: ZhipuTeamCredentialInput;
}

export interface CatalogChangeEvent {
  readonly revision: number;
  readonly defaultModelSlug: string | null;
  readonly zeroChannelState: boolean;
  readonly enabledModelSlugs: readonly string[];
}

export interface GatewayCoordinator {
  readonly updateChannels: (nextChannels: readonly GatewayChannelConfig[]) => Promise<{
    readonly revision: number;
    readonly defaultModelSlug: string | null;
    readonly zeroChannelState: boolean;
  }>;
  readonly getCatalogRevision: () => number;
  readonly getDefaultModelSlug: () => string | null;
  readonly isZeroChannelState: () => boolean;
}

export type OutboundUrlValidator = (url: URL) => void;

export interface ChannelManagerOptions {
  readonly dataDir: string;
  readonly secretStore?: SecretStore;
  readonly fence?: ChannelCredentialFence;
  readonly oauthManager?: OAuthTokenManager;
  readonly gateway?: GatewayCoordinator;
  readonly devFallbackActive?: boolean;
  readonly fetchImpl?: typeof fetch;
  readonly validateOutboundUrl?: OutboundUrlValidator;
  readonly requestTimeoutMs?: number;
  readonly now?: () => number;
  readonly companyAuthOptions?: Partial<
    Omit<
      CompanyAuthServiceOptions,
      "secretStore" | "fence" | "onModelsSynced" | "onLoggedOut"
    >
  >;
  readonly oauthEndpoints?: OAuthEndpointOverrides;
  readonly onCatalogChanged?: (event: CatalogChangeEvent) => void | Promise<void>;
  /** Optional test hook invoked right before writing channels.json to disk. */
  readonly onBeforePersistChannels?: () => void | Promise<void>;
}

const ERROR_LABELS: Record<ChannelTestErrorType, string> = {
  auth: "认证失败，请检查 API Key",
  permission: "权限不足，当前 Key 无访问权限",
  not_found: "资源不存在，请检查 Base URL 或模型",
  rate_limit: "请求频率受限，请稍后重试",
  quota: "额度不足，请检查账户余额",
  bad_request: "请求无效，请检查渠道配置",
  server: "供应商服务异常，请稍后重试",
  network: "网络连接失败，请检查网络或代理",
  timeout: "连接超时，请检查网络或代理",
  unknown: "连接测试失败",
};

const AUTH_TEXT =
  /invalid[_\s-]?(?:api[_\s-]?)?key|api[_\s-]?key[_\s-]?(?:not[_\s-]?valid|invalid)|incorrect api key|unauthorized|authentication|invalid token|密钥无效|凭证无效|未认证/i;
const QUOTA_TEXT =
  /insufficient[_\s-]?quota|exceeded your current quota|out of credit|billing|payment[_\s-]?required|余额不足|额度不足|欠费|充值/i;
const TIMEOUT_TEXT = /timeout|timed out|etimedout|超时/i;
const INVALID_URL_TEXT =
  /invalid url|failed to parse url|unsupported protocol|only absolute urls|invalid protocol|无效的 url|必须是合法的 https/i;

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

/**
 * Strict SSRF-safe outbound HTTPS validator for channel test / fetch / quota URLs.
 * Rejects plaintext HTTP, embedded credentials, credential query params, fragments,
 * private/loopback/link-local/metadata IPv4 & IPv6 literals, and internal domains.
 */
export function assertStrictChannelHttpsUrl(url: URL): void {
  assertSafeOutboundUrl(url);
}

export function classifyHttpStatus(status: number, bodyText = ""): ChannelTestErrorType {
  if (status >= 500) return "server";
  switch (status) {
    case 401:
      return "auth";
    case 402:
      return "quota";
    case 403:
      return AUTH_TEXT.test(bodyText) ? "auth" : "permission";
    case 404:
      return "not_found";
    case 408:
      return "timeout";
    case 429:
      return QUOTA_TEXT.test(bodyText) ? "quota" : "rate_limit";
    case 400:
      return AUTH_TEXT.test(bodyText) ? "auth" : "bad_request";
    case 405:
    case 409:
    case 413:
    case 415:
    case 422:
      return "bad_request";
    default:
      return "unknown";
  }
}

function extractHttpErrorMessage(bodyText: string): string {
  const trimmed = bodyText.trim();
  if (!trimmed) return "";
  try {
    const parsed = JSON.parse(trimmed) as unknown;
    if (!isRecord(parsed)) return trimmed;
    const target = isRecord(parsed.error) ? parsed.error : parsed;
    if (typeof target.message === "string" && target.message.trim()) return target.message.trim();
    if (typeof target.msg === "string" && target.msg.trim()) return target.msg.trim();
    const code =
      (typeof target.code === "string" || typeof target.code === "number" ? String(target.code) : "") ||
      (typeof target.type === "string" ? target.type : "") ||
      (typeof target.status === "string" ? target.status : "");
    return code || trimmed;
  } catch {
    return trimmed;
  }
}

function summarizeErrorDetail(
  text: string,
  extraSecrets: readonly (string | undefined)[] = [],
): string | undefined {
  const redacted = redactSecretsFromText(text, extraSecrets).replace(/\s+/g, " ").trim();
  if (!redacted) return undefined;
  return redacted.length > MAX_ERROR_DETAIL_LENGTH
    ? `${redacted.slice(0, MAX_ERROR_DETAIL_LENGTH)}…`
    : redacted;
}

function buildTestFailure(
  errorType: ChannelTestErrorType,
  detail: string,
  statusCode?: number,
  extraSecrets: readonly (string | undefined)[] = [],
): ChannelTestResult {
  const summary = summarizeErrorDetail(detail, extraSecrets);
  const statusPart = statusCode === undefined ? "" : ` (${statusCode})`;
  const detailPart = summary ? `：${summary}` : "";
  return {
    success: false,
    message: `${ERROR_LABELS[errorType]}${statusPart}${detailPart}`,
    errorType,
    ...(statusCode === undefined ? {} : { statusCode }),
    ...(summary ? { detail: summary } : {}),
  };
}

function buildExceptionFailure(
  error: unknown,
  extraSecrets: readonly (string | undefined)[] = [],
): ChannelTestResult {
  const rawMessage = error instanceof Error ? error.message : String(error ?? "");
  const name = error instanceof Error ? error.name : "";
  if (name === "TimeoutError" || name === "AbortError" || TIMEOUT_TEXT.test(rawMessage)) {
    return buildTestFailure("timeout", rawMessage, undefined, extraSecrets);
  }
  if (INVALID_URL_TEXT.test(rawMessage)) {
    return buildTestFailure("bad_request", rawMessage, undefined, extraSecrets);
  }
  return buildTestFailure("network", rawMessage, undefined, extraSecrets);
}

async function readBoundedText(response: Response, maxBytes: number): Promise<string> {
  if (!response.body) {
    const text = await response.text();
    if (Buffer.byteLength(text, "utf8") > maxBytes) {
      return text.slice(0, maxBytes);
    }
    return text;
  }
  const reader = response.body.getReader();
  const chunks: Buffer[] = [];
  let total = 0;
  try {
    while (total < maxBytes) {
      const { done, value } = await reader.read();
      if (done) break;
      if (!value) continue;
      const remaining = maxBytes - total;
      const slice = value.byteLength > remaining ? value.subarray(0, remaining) : value;
      chunks.push(Buffer.from(slice.buffer, slice.byteOffset, slice.byteLength));
      total += slice.byteLength;
      if (slice.byteLength < value.byteLength) {
        await reader.cancel().catch(() => undefined);
        break;
      }
    }
  } finally {
    reader.releaseLock();
  }
  return Buffer.concat(chunks, total).toString("utf8");
}

function serializeZhipuTeamCredential(
  rawApiKey?: string,
  structured?: ZhipuTeamCredentialInput,
): string | undefined {
  if (structured) {
    const apiKey = structured.apiKey.trim();
    if (!apiKey) return undefined;
    const parts = [`apiKey=${apiKey}`];
    if (structured.organization?.trim()) {
      parts.push(`bigmodel_organization=${structured.organization.trim()}`);
    }
    if (structured.project?.trim()) {
      parts.push(`bigmodel_project=${structured.project.trim()}`);
    }
    return parts.join("; ");
  }
  const trimmed = rawApiKey?.trim();
  return trimmed ? trimmed : undefined;
}

function sanitizeChannelId(raw: string): string {
  const cleaned = raw
    .trim()
    .toLowerCase()
    .replace(/[^a-z0-9-_]+/g, "-")
    .replace(/^-+|-+$/g, "");
  return cleaned || `ch-${randomUUID().slice(0, 8)}`;
}

function sanitizeModels(
  channelId: string,
  models: readonly StoredChannelModel[] | undefined,
): StoredChannelModel[] {
  if (!models || models.length === 0) return [];
  const seen = new Set<string>();
  const result: StoredChannelModel[] = [];
  for (const item of models) {
    if (!item || typeof item.id !== "string") continue;
    const cleanId = canonicalizeModelId(channelId, item.id);
    if (!cleanId || !isAgentCapableModelId(cleanId)) continue;
    const key = cleanId.toLowerCase();
    if (seen.has(key)) continue;
    seen.add(key);
    result.push({
      id: cleanId,
      name: typeof item.name === "string" && item.name.trim() ? item.name.trim() : cleanId,
      enabled: Boolean(item.enabled),
      ...(item.source ? { source: item.source } : {}),
    });
  }
  return result;
}

function defaultModelsForProvider(provider: ProviderType): StoredChannelModel[] {
  const spec = getProviderSpec(provider);
  return spec.presetModels.map((preset) => ({
    id: preset.id,
    name: preset.name,
    enabled: preset.enabled,
    source: "preset",
  }));
}

function parsePersistedRecord(raw: unknown): StoredChannelRecord | null {
  if (!isRecord(raw)) return null;
  if (typeof raw.id !== "string" || !raw.id.trim()) return null;
  if (typeof raw.name !== "string" || !raw.name.trim()) return null;
  if (!isProviderType(raw.provider)) return null;
  const id = raw.id.trim();
  const modelsRaw = Array.isArray(raw.models) ? (raw.models as StoredChannelModel[]) : [];
  const availableModelIds = Array.isArray(raw.availableModelIds)
    ? raw.availableModelIds.filter((v): v is string => typeof v === "string" && v.trim().length > 0)
    : undefined;
  return {
    id,
    name: raw.name.trim(),
    provider: raw.provider,
    baseUrl: typeof raw.baseUrl === "string" ? stripUrlCredentialsForLoad(raw.baseUrl) : "",
    enabled: Boolean(raw.enabled),
    models: sanitizeModels(id, modelsRaw),
    ...(typeof raw.secretRef === "string" && raw.secretRef.trim()
      ? { secretRef: raw.secretRef.trim() }
      : {}),
    ...(typeof raw.enterpriseUrl === "string" && raw.enterpriseUrl.trim()
      ? { enterpriseUrl: raw.enterpriseUrl.trim() }
      : {}),
    ...(availableModelIds ? { availableModelIds } : {}),
    ...(typeof raw.accountLabel === "string" && raw.accountLabel.trim()
      ? { accountLabel: raw.accountLabel.trim() }
      : {}),
    createdAt: typeof raw.createdAt === "number" && Number.isFinite(raw.createdAt) ? raw.createdAt : Date.now(),
    updatedAt: typeof raw.updatedAt === "number" && Number.isFinite(raw.updatedAt) ? raw.updatedAt : Date.now(),
  };
}

async function atomicWriteJson0600(filePath: string, data: unknown): Promise<void> {
  await mkdir(dirname(filePath), { recursive: true, mode: 0o700 });
  const tmpPath = `${filePath}.${randomUUID()}.tmp`;
  try {
    await writeFile(tmpPath, `${JSON.stringify(data, null, 2)}\n`, { mode: 0o600 });
    await rename(tmpPath, filePath);
  } finally {
    await rm(tmpPath, { force: true }).catch(() => undefined);
  }
}

export class ChannelManager {
  readonly dataDir: string;
  readonly channelsFilePath: string;
  readonly secretStore: SecretStore;
  readonly fence: ChannelCredentialFence;
  readonly oauthManager: OAuthTokenManager;
  readonly companyAuth: CompanyAuthService;
  readonly oauthLogin: OAuthLoginSessionManager;

  private readonly gateway: GatewayCoordinator | undefined;
  private readonly devFallbackActive: boolean;
  private readonly fetchImpl: typeof fetch;
  private readonly validateOutboundUrl: OutboundUrlValidator;
  private readonly requestTimeoutMs: number;
  private readonly now: () => number;
  private readonly oauthEndpoints: OAuthEndpointOverrides | undefined;
  private readonly onCatalogChanged: ((event: CatalogChangeEvent) => void | Promise<void>) | undefined;
  private readonly onBeforePersistChannels: (() => void | Promise<void>) | undefined;

  private channels: StoredChannelRecord[] = [];
  private credentialsPresence = new Map<string, boolean>();
  private initialized = false;
  private localRevision = 0;
  private defaultModelSlug: string | null = null;
  private zeroChannelState = true;
  private mutex: Promise<void> = Promise.resolve();

  constructor(options: ChannelManagerOptions) {
    this.dataDir = options.dataDir;
    this.channelsFilePath = join(options.dataDir, "channels", "channels.json");
    this.secretStore =
      options.secretStore ??
      createSecretStore({
        namespace: MODEL_CHANNELS_SECRET_NAMESPACE,
        windowsDpapiPath: join(options.dataDir, "channels", "secrets.dpapi.json"),
      });
    this.fence = options.fence ?? new ChannelCredentialFence();
    this.oauthManager =
      options.oauthManager ??
      new OAuthTokenManager({
        secretStore: this.secretStore,
        fence: this.fence,
        ...(options.now ? { now: options.now } : {}),
      });
    this.gateway = options.gateway;
    this.devFallbackActive = options.devFallbackActive ?? false;
    this.fetchImpl = options.fetchImpl ?? globalThis.fetch;
    this.validateOutboundUrl = options.validateOutboundUrl ?? assertStrictChannelHttpsUrl;
    this.requestTimeoutMs = options.requestTimeoutMs ?? DEFAULT_REQUEST_TIMEOUT_MS;
    this.now = options.now ?? Date.now;
    this.oauthEndpoints = options.oauthEndpoints;
    this.onCatalogChanged = options.onCatalogChanged;
    this.onBeforePersistChannels = options.onBeforePersistChannels;

    const companyValidateUrl: CompanyUrlValidator | undefined = options.companyAuthOptions?.validateUrl;
    this.companyAuth = new CompanyAuthService({
      ...options.companyAuthOptions,
      secretStore: this.secretStore,
      fence: this.fence,
      fetchImpl: options.companyAuthOptions?.fetchImpl ?? this.fetchImpl,
      ...(companyValidateUrl ? { validateUrl: companyValidateUrl } : {}),
      now: this.now,
      onModelsSynced: async (models) => {
        await this.applyCompanyModelsSynced(models);
      },
      onLoggedOut: async () => {
        await this.applyCompanyLoggedOut();
      },
    });

    this.oauthLogin = new OAuthLoginSessionManager({
      ...this.oauthEndpoints,
      fetchImpl: this.oauthEndpoints?.fetchImpl ?? this.fetchImpl,
      now: this.now,
      onCompleted: async (credentials, meta) => {
        return await this.applyOAuthLoginCompleted(credentials, meta);
      },
    });
  }

  private runSerialized<T>(fn: () => Promise<T>): Promise<T> {
    const prev = this.mutex;
    let release!: () => void;
    const gate = new Promise<void>((resolve) => {
      release = resolve;
    });
    this.mutex = prev.catch(() => undefined).then(() => gate);
    return prev
      .catch(() => undefined)
      .then(async () => {
        try {
          return await fn();
        } finally {
          release();
        }
      });
  }

  private assertOutbound(rawUrl: string): URL {
    let parsed: URL;
    try {
      parsed = new URL(rawUrl.trim());
    } catch {
      throw new Error("无效的 URL 地址，请输入完整的 https:// 地址。");
    }
    // Always block userinfo & credential-like query parameters even under test URL validator overrides.
    assertNoUrlCredentials(parsed);
    this.validateOutboundUrl(parsed);
    return parsed;
  }

  async initialize(): Promise<ModelChannelsStateSnapshot> {
    return await this.runSerialized(async () => {
      await this.loadFromDisk();
      await this.companyAuth.initialize();

      // Reconcile company team channel visibility with live verified company credentials.
      const companyMember = this.companyAuth.getState().member;
      if (companyMember) {
        this.ensureCompanyTeamChannelRecord();
      } else {
        this.channels = this.channels.filter((ch) => ch.id !== COMPANY_CHANNEL_ID);
      }

      // Audit presence of SecretStore refs for member channels.
      await this.refreshCredentialsPresence();
      await this.syncGatewayAndNotify();
      this.initialized = true;
      return this.getState();
    });
  }

  async close(): Promise<void> {
    this.companyAuth.cancelLogin();
    this.oauthLogin.cancel();
  }

  private async loadFromDisk(): Promise<void> {
    try {
      const raw = await readFile(this.channelsFilePath, "utf8");
      const parsed = JSON.parse(raw) as unknown;
      if (!isRecord(parsed) || !Array.isArray(parsed.channels)) {
        this.channels = [];
        return;
      }
      const loaded: StoredChannelRecord[] = [];
      const seenIds = new Set<string>();
      for (const item of parsed.channels) {
        const record = parsePersistedRecord(item);
        if (!record || seenIds.has(record.id)) continue;
        seenIds.add(record.id);
        loaded.push(record);
      }
      this.channels = loaded;
    } catch (error) {
      const code = (error as NodeJS.ErrnoException)?.code;
      if (code === "ENOENT") {
        this.channels = [];
        return;
      }
      this.channels = [];
    }
  }

  private async persistToDisk(): Promise<void> {
    await this.onBeforePersistChannels?.();
    // Strip any accidental non-whitelisted fields so ZERO credentials can ever reach disk.
    const cleanChannels: StoredChannelRecord[] = this.channels.map((ch) => ({
      id: ch.id,
      name: ch.name,
      provider: ch.provider,
      baseUrl: ch.baseUrl,
      enabled: ch.enabled,
      models: ch.models.map((m) => ({
        id: m.id,
        name: m.name,
        enabled: m.enabled,
        ...(m.source ? { source: m.source } : {}),
      })),
      ...(ch.secretRef ? { secretRef: ch.secretRef } : {}),
      ...(ch.enterpriseUrl ? { enterpriseUrl: ch.enterpriseUrl } : {}),
      ...(ch.availableModelIds ? { availableModelIds: [...ch.availableModelIds] } : {}),
      ...(ch.accountLabel ? { accountLabel: ch.accountLabel } : {}),
      createdAt: ch.createdAt,
      updatedAt: ch.updatedAt,
    }));
    const payload: ChannelsDiskFile = {
      version: CHANNELS_SCHEMA_VERSION,
      channels: cleanChannels,
    };
    await atomicWriteJson0600(this.channelsFilePath, payload);
  }

  private ensureCompanyTeamChannelRecord(models?: readonly StoredChannelModel[]): StoredChannelRecord {
    const now = this.now();
    const existingIdx = this.channels.findIndex((c) => c.id === COMPANY_CHANNEL_ID);
    const existing = existingIdx >= 0 ? this.channels[existingIdx] : undefined;

    let mergedModels: StoredChannelModel[];
    if (models && models.length > 0) {
      const prevEnabled = new Map(existing?.models.map((m) => [m.id, m.enabled]) ?? []);
      mergedModels = sanitizeModels(
        COMPANY_CHANNEL_ID,
        models.map((m) => ({
          ...m,
          enabled: prevEnabled.has(m.id) ? Boolean(prevEnabled.get(m.id)) : m.enabled,
        })),
      );
      if (mergedModels.length > 0 && !mergedModels.some((m) => m.enabled)) {
        const preferred =
          mergedModels.find((m) => m.id === COMPANY_DEFAULT_MODEL_ID) ?? mergedModels[0]!;
        mergedModels = mergedModels.map((m) =>
          m.id === preferred.id ? { ...m, enabled: true } : m,
        );
      }
    } else if (existing && existing.models.length > 0) {
      mergedModels = [...existing.models];
    } else {
      mergedModels = defaultModelsForProvider("company-team");
    }

    const memberName = this.companyAuth.getState().member?.name;
    const record: StoredChannelRecord = {
      id: COMPANY_CHANNEL_ID,
      name: COMPANY_TEAM_CHANNEL_NAME,
      provider: "company-team",
      baseUrl: this.companyAuth.getApiBase() ? `${this.companyAuth.getApiBase()}/v1` : COMPANY_TEAM_BASE_URL,
      enabled: existing ? existing.enabled : true,
      models: mergedModels,
      secretRef: COMPANY_SECRET_REF,
      ...(memberName ? { accountLabel: memberName } : {}),
      createdAt: existing?.createdAt ?? now,
      updatedAt: now,
    };

    if (existingIdx >= 0) {
      this.channels[existingIdx] = record;
    } else {
      this.channels.unshift(record);
    }
    this.credentialsPresence.set(COMPANY_CHANNEL_ID, true);
    return record;
  }

  private async readSecretValue(ref: string): Promise<string | undefined> {
    if (this.secretStore.read) {
      const res = await this.secretStore.read(ref);
      return res.status === "found" ? res.value : undefined;
    }
    return await this.secretStore.get(ref);
  }

  private async refreshCredentialsPresence(): Promise<void> {
    this.credentialsPresence.clear();
    if (this.companyAuth.getApiKeyInternal()) {
      this.credentialsPresence.set(COMPANY_CHANNEL_ID, true);
    }
    for (const ch of this.channels) {
      if (ch.id === COMPANY_CHANNEL_ID) continue;
      if (!ch.secretRef) {
        this.credentialsPresence.set(ch.id, false);
        continue;
      }
      try {
        const val = await this.readSecretValue(ch.secretRef);
        this.credentialsPresence.set(ch.id, typeof val === "string" && val.trim().length > 0);
      } catch {
        this.credentialsPresence.set(ch.id, false);
      }
    }
  }

  private buildOAuthRefresher(
    provider: OAuthSubscriptionProvider,
  ): (current: OAuthSubscriptionCredentials, signal: AbortSignal) => Promise<OAuthSubscriptionCredentials> {
    const fetchImpl = this.oauthEndpoints?.fetchImpl ?? this.fetchImpl;
    const validateDestination = this.oauthEndpoints?.validateDestination;
    const now = this.now;

    if (provider === "openai-codex") {
      return async (current, signal) =>
        await refreshCodexOAuthToken(current as CodexOAuthCredentials, signal, {
          fetchImpl,
          ...(validateDestination ? { validateDestination } : {}),
          ...(this.oauthEndpoints?.codexAuthBaseUrl
            ? { tokenEndpoint: `${this.oauthEndpoints.codexAuthBaseUrl.replace(/\/+$/, "")}/oauth/token` }
            : {}),
          now,
        });
    }
    if (provider === "github-copilot") {
      return async (current, signal) =>
        await refreshGithubCopilotOAuthToken(current as GithubCopilotOAuthCredentials, signal, {
          ...this.oauthEndpoints,
          fetchImpl,
          now,
        });
    }
    return async (current, signal) =>
      await refreshXaiOAuthToken(current as XaiOAuthCredentials, signal, {
        fetchImpl,
        ...(validateDestination ? { validateDestination } : {}),
        ...(this.oauthEndpoints?.xaiAuthBaseUrl
          ? { tokenEndpoint: `${this.oauthEndpoints.xaiAuthBaseUrl.replace(/\/+$/, "")}/oauth2/token` }
          : {}),
        now,
      });
  }

  private async compileGatewayChannels(): Promise<GatewayChannelConfig[]> {
    const compiled: GatewayChannelConfig[] = [];
    const companyApiKey = this.companyAuth.getApiKeyInternal();
    const companySignedIn = this.companyAuth.isSignedIn();

    for (const ch of this.channels) {
      if (ch.id === COMPANY_CHANNEL_ID) {
        if (!companySignedIn || !companyApiKey) continue;
        const authoritativeBaseUrl = this.companyAuth.getApiBase()
          ? `${this.companyAuth.getApiBase()}/v1`
          : COMPANY_TEAM_BASE_URL;
        const pinnedCompanyRecord: StoredChannelRecord = {
          ...ch,
          baseUrl: authoritativeBaseUrl,
        };
        try {
          this.companyAuth.validateEndpointUrl(authoritativeBaseUrl);
          assertNoUrlCredentials(new URL(authoritativeBaseUrl));
          const companyCompiled = compileChannelToGatewayConfig(pinnedCompanyRecord, {
            apiKey: companyApiKey,
            secretRef: COMPANY_SECRET_REF,
          });
          compiled.push(companyCompiled);
        } catch {
          continue;
        }
        continue;
      }

      if (isOAuthProviderType(ch.provider)) {
        if (!ch.secretRef) continue;
        try {
          if (ch.baseUrl) this.assertOutbound(ch.baseUrl);
        } catch {
          continue;
        }
        let parsedCreds: OAuthSubscriptionCredentials | undefined;
        try {
          const raw = await this.readSecretValue(ch.secretRef);
          if (raw) {
            const parsed = JSON.parse(raw) as OAuthSubscriptionCredentials;
            if (parsed && typeof parsed.access === "string" && typeof parsed.refresh === "string") {
              parsedCreds = parsed;
            }
          }
        } catch {
          parsedCreds = undefined;
        }
        if (!parsedCreds) continue;
        try {
          const oauthCompiled = compileChannelToGatewayConfig(ch, {
            oauth: {
              provider: ch.provider,
              secretRef: ch.secretRef,
              initialCredentials: parsedCreds,
              refresh: this.buildOAuthRefresher(ch.provider),
            },
          });
          this.assertOutbound(oauthCompiled.baseUrl);
          compiled.push(oauthCompiled);
        } catch {
          continue;
        }
        continue;
      }

      if (!ch.secretRef) continue;
      // Enforce SSRF & URL credential validation even on legacy persisted `channels.json` records
      // before compiling them into the live gateway so tampered/legacy loopback/private URLs are never proxied.
      try {
        this.assertOutbound(ch.baseUrl);
      } catch {
        continue;
      }
      let apiKey: string | undefined;
      try {
        const raw = await this.readSecretValue(ch.secretRef);
        if (typeof raw === "string" && raw.trim().length > 0) {
          apiKey = raw;
        }
      } catch {
        apiKey = undefined;
      }
      if (!apiKey) continue;
      try {
        const apiCompiled = compileChannelToGatewayConfig(ch, {
          apiKey,
          secretRef: ch.secretRef,
        });
        this.assertOutbound(apiCompiled.baseUrl);
        compiled.push(apiCompiled);
      } catch {
        continue;
      }
    }

    return compiled;
  }

  private async syncGatewayAndNotify(): Promise<void> {
    const compiled = await this.compileGatewayChannels();
    let revision: number;
    let defaultSlug: string | null;
    let zeroState: boolean;

    if (this.gateway) {
      const updated = await this.gateway.updateChannels(compiled);
      revision = updated.revision;
      defaultSlug = updated.defaultModelSlug;
      zeroState = updated.zeroChannelState;
    } else {
      this.localRevision += 1;
      revision = this.localRevision;
      defaultSlug = resolveFallbackModel(compiled, this.devFallbackActive);
      zeroState = defaultSlug === null;
    }

    this.defaultModelSlug = defaultSlug;
    this.zeroChannelState = zeroState;

    const enabledModelSlugs: string[] = [];
    for (const ch of compiled) {
      if (!ch.enabled) continue;
      for (const m of ch.models) {
        if (m.enabled) {
          enabledModelSlugs.push(formatModelSlug(ch.id, m.id));
        }
      }
    }

    await this.onCatalogChanged?.({
      revision,
      defaultModelSlug: defaultSlug,
      zeroChannelState: zeroState,
      enabledModelSlugs,
    });
  }

  listRedacted(): RedactedChannel[] {
    const companySignedIn = this.companyAuth.isSignedIn();
    const out: RedactedChannel[] = [];
    for (const ch of this.channels) {
      const isTeam = ch.id === COMPANY_CHANNEL_ID;
      if (isTeam && !companySignedIn) continue;
      out.push({
        id: ch.id,
        name: ch.name,
        provider: ch.provider,
        baseUrl: ch.baseUrl,
        enabled: ch.enabled,
        models: ch.models.map((m) => ({ ...m })),
        hasCredentials: Boolean(this.credentialsPresence.get(ch.id)),
        isTeamChannel: isTeam,
        immutableFields: isTeam ? TEAM_CHANNEL_IMMUTABLE_FIELDS : [],
        ...(ch.enterpriseUrl ? { enterpriseUrl: ch.enterpriseUrl } : {}),
        ...(ch.availableModelIds ? { availableModelIds: [...ch.availableModelIds] } : {}),
        ...(ch.accountLabel ? { accountLabel: ch.accountLabel } : {}),
        createdAt: ch.createdAt,
        updatedAt: ch.updatedAt,
      });
    }
    return out;
  }

  getState(): ModelChannelsStateSnapshot {
    const channels = this.listRedacted();
    let enabledModelCount = 0;
    for (const ch of channels) {
      if (!ch.enabled || !ch.hasCredentials) continue;
      for (const m of ch.models) {
        if (m.enabled) enabledModelCount += 1;
      }
    }
    return {
      catalogVersion: PROVIDER_CATALOG_VERSION,
      catalog: listProviderCatalogSpecs(),
      channels,
      companyAuth: this.companyAuth.getState(),
      oauthSessions: this.oauthLogin.listSessions(),
      defaultModelSlug: this.gateway ? this.gateway.getDefaultModelSlug() : this.defaultModelSlug,
      zeroChannelState: this.gateway ? this.gateway.isZeroChannelState() : this.zeroChannelState,
      enabledModelCount,
    };
  }

  // ============================================================================
  // Company Team Channel operations (WeCom OIDC + PKCE)
  // ============================================================================

  async startCompanyLogin(): Promise<{ readonly state: CompanyAuthState; readonly authUrl: string }> {
    return await this.companyAuth.startLogin();
  }

  cancelCompanyLogin(): CompanyAuthState {
    return this.companyAuth.cancelLogin();
  }

  async syncCompanyModels(selectDefault = false): Promise<{
    readonly state: CompanyAuthState;
    readonly models: readonly StoredChannelModel[];
  }> {
    return await this.companyAuth.syncModels(selectDefault);
  }

  async logoutCompany(): Promise<ModelChannelsStateSnapshot> {
    // CompanyAuthService.logout runs read-back verified SecretStore.delete FIRST and throws if it fails!
    await this.companyAuth.logout();
    return this.getState();
  }

  private async applyCompanyModelsSynced(models: readonly StoredChannelModel[]): Promise<void> {
    await this.runSerialized(async () => {
      // Guard against syncModels() vs logout() race: if company account is no longer signed in,
      // discard late model sync results without recreating the team channel or writing metadata.
      if (!this.companyAuth.isSignedIn()) {
        return;
      }
      this.ensureCompanyTeamChannelRecord(models);
      await this.persistToDisk();
      await this.syncGatewayAndNotify();
    });
  }

  private async applyCompanyLoggedOut(): Promise<void> {
    await this.runSerialized(async () => {
      this.channels = this.channels.filter((ch) => ch.id !== COMPANY_CHANNEL_ID);
      this.credentialsPresence.delete(COMPANY_CHANNEL_ID);
      let persistError: unknown;
      try {
        await this.persistToDisk();
      } catch (err) {
        persistError = err;
      }
      // ALWAYS update live gateway & Pi so the revoked company apiKey is immediately purged from memory
      // even if persisting channels.json fails!
      await this.syncGatewayAndNotify();
      if (persistError !== undefined) {
        throw persistError;
      }
    });
  }

  // ============================================================================
  // Member Channel CRUD (19-supplier catalog)
  // ============================================================================

  async createChannel(input: CreateChannelInput): Promise<RedactedChannel> {
    return await this.runSerialized(async () => {
      if (!isProviderType(input.provider) || input.provider === "company-team") {
        throw new Error("不支持的模型渠道类型。");
      }
      const spec = getProviderSpec(input.provider);
      const name = input.name.trim() || spec.labelZh;
      const isOAuth = isOAuthProviderType(input.provider);

      let baseUrl = (input.baseUrl ?? "").trim();
      if (!isOAuth) {
        if (!baseUrl) {
          baseUrl = spec.defaultBaseUrl;
        }
        if (!baseUrl) {
          throw new Error("请填写渠道的 HTTPS 接口地址（Base URL）。");
        }
        this.assertOutbound(baseUrl);
        baseUrl = normalizeBaseUrl(baseUrl);
      } else if (baseUrl) {
        this.assertOutbound(baseUrl);
        baseUrl = normalizeBaseUrl(baseUrl);
      }

      const enterpriseUrl =
        input.provider === "github-copilot" && input.enterpriseUrl?.trim()
          ? normalizeEnterpriseDomain(input.enterpriseUrl)
          : undefined;

      const rawId = input.id ? sanitizeChannelId(input.id) : `${input.provider}-${randomUUID().slice(0, 8)}`;
      if (rawId === COMPANY_CHANNEL_ID) {
        throw new Error("渠道标识与公司团队渠道冲突。");
      }
      const id = this.channels.some((c) => c.id === rawId)
        ? `${rawId}-${randomUUID().slice(0, 4)}`
        : rawId;

      const models =
        input.models && input.models.length > 0
          ? sanitizeModels(id, input.models)
          : defaultModelsForProvider(input.provider);

      let secretRef: string | undefined;
      if (!isOAuth) {
        const secretValue =
          input.provider === "zhipu-coding-team"
            ? serializeZhipuTeamCredential(input.apiKey, input.zhipuTeam)
            : input.apiKey?.trim();
        if (!secretValue) {
          throw new Error("请填写有效的 API Key。");
        }
        if (input.provider === "zhipu-coding-team" && !parseZhipuTeamCredentials(secretValue)) {
          throw new Error("智谱 Coding Plan 团队版凭据格式无效，请填写 API Key。");
        }
        secretRef = `channel:${id}`;
        const lease = this.fence.acquire(id);
        try {
          await this.fence.writeIfCurrent(
            this.secretStore,
            id,
            secretRef,
            secretValue,
            lease.generation,
          );
        } catch (error) {
          throw this.formatSecretStoreWriteError(error);
        } finally {
          lease.release();
        }
      }

      const now = this.now();
      const record: StoredChannelRecord = {
        id,
        name,
        provider: input.provider,
        baseUrl,
        enabled: input.enabled ?? !isOAuth,
        models,
        ...(secretRef ? { secretRef } : {}),
        ...(enterpriseUrl ? { enterpriseUrl } : {}),
        createdAt: now,
        updatedAt: now,
      };

      const previousChannels = [...this.channels];
      this.channels.push(record);
      this.credentialsPresence.set(id, Boolean(secretRef));

      try {
        await this.persistToDisk();
        await this.syncGatewayAndNotify();
      } catch (error) {
        this.channels = previousChannels;
        this.credentialsPresence.delete(id);
        if (secretRef) {
          await this.secretStore.delete(secretRef).catch(() => undefined);
        }
        throw error;
      }

      const redacted = this.listRedacted().find((c) => c.id === id);
      if (!redacted) throw new Error("创建渠道后无法读取渠道状态。");
      return redacted;
    });
  }

  async updateChannel(channelId: string, patch: UpdateChannelInput): Promise<RedactedChannel> {
    return await this.runSerialized(async () => {
      const idx = this.channels.findIndex((c) => c.id === channelId);
      if (idx === -1) {
        throw new Error(`找不到模型渠道：${channelId}`);
      }
      const current = this.channels[idx]!;
      const isTeam = current.id === COMPANY_CHANNEL_ID;

      if (isTeam) {
        const forbiddenNameChange = patch.name !== undefined && patch.name.trim() !== current.name;
        const forbiddenProviderChange =
          patch.provider !== undefined && patch.provider !== current.provider;
        const forbiddenBaseUrlChange =
          patch.baseUrl !== undefined && normalizeBaseUrl(patch.baseUrl) !== current.baseUrl;
        const forbiddenKeyChange = patch.apiKey !== undefined || patch.zhipuTeam !== undefined;
        if (
          forbiddenNameChange ||
          forbiddenProviderChange ||
          forbiddenBaseUrlChange ||
          forbiddenKeyChange
        ) {
          throw new Error(
            "公司团队渠道的名称、协议、服务地址与凭据由企业账号统一管理，不支持修改。",
          );
        }
      }

      const nextProvider = patch.provider ?? current.provider;
      if (!isTeam && (!isProviderType(nextProvider) || nextProvider === "company-team")) {
        throw new Error("不支持的模型渠道类型。");
      }
      const nextIsOAuth = isOAuthProviderType(nextProvider);

      let nextBaseUrl = current.baseUrl;
      if (!isTeam && patch.baseUrl !== undefined) {
        const trimmed = patch.baseUrl.trim();
        if (!nextIsOAuth) {
          const candidate = trimmed || getProviderSpec(nextProvider).defaultBaseUrl;
          if (!candidate) {
            throw new Error("请填写渠道的 HTTPS 接口地址（Base URL）。");
          }
          this.assertOutbound(candidate);
          nextBaseUrl = normalizeBaseUrl(candidate);
        } else if (trimmed) {
          this.assertOutbound(trimmed);
          nextBaseUrl = normalizeBaseUrl(trimmed);
        } else {
          nextBaseUrl = "";
        }
      }

      let nextEnterpriseUrl = current.enterpriseUrl;
      if (!isTeam && patch.enterpriseUrl !== undefined && nextProvider === "github-copilot") {
        nextEnterpriseUrl = patch.enterpriseUrl.trim()
          ? normalizeEnterpriseDomain(patch.enterpriseUrl)
          : undefined;
      }

      let nextSecretRef = current.secretRef;
      const providerChanged = !isTeam && nextProvider !== current.provider;
      const baseUrlChanged =
        !isTeam && normalizeBaseUrl(nextBaseUrl) !== normalizeBaseUrl(current.baseUrl);
      const hasStoredSecret = Boolean(current.secretRef || this.credentialsPresence.get(current.id));

      if (!isTeam && !nextIsOAuth) {
        const newSecret =
          nextProvider === "zhipu-coding-team"
            ? serializeZhipuTeamCredential(patch.apiKey, patch.zhipuTeam)
            : patch.apiKey?.trim();
        if ((providerChanged || baseUrlChanged) && hasStoredSecret && !newSecret) {
          throw new Error(
            "修改渠道供应商或接口地址后，必须重新输入新的 API Key，不可将旧凭据发送到新地址。",
          );
        }
        if (newSecret) {
          if (nextProvider === "zhipu-coding-team" && !parseZhipuTeamCredentials(newSecret)) {
            throw new Error("智谱 Coding Plan 团队版凭据格式无效，请填写 API Key。");
          }
          const ref = current.secretRef ?? `channel:${current.id}`;
          const lease = this.fence.acquire(current.id);
          try {
            await this.fence.writeIfCurrent(
              this.secretStore,
              current.id,
              ref,
              newSecret,
              lease.generation,
            );
          } catch (error) {
            throw this.formatSecretStoreWriteError(error);
          } finally {
            lease.release();
          }
          nextSecretRef = ref;
          this.credentialsPresence.set(current.id, true);
        }
      } else if (!isTeam && nextIsOAuth && providerChanged && hasStoredSecret) {
        throw new Error(
          "切换渠道供应商后必须重新认证，不可将旧凭据复用到新供应商。",
        );
      }

      const nextModels =
        patch.models !== undefined ? sanitizeModels(current.id, patch.models) : current.models;

      const updated: StoredChannelRecord = {
        ...current,
        name: isTeam ? current.name : patch.name?.trim() || current.name,
        provider: isTeam ? current.provider : nextProvider,
        baseUrl: isTeam ? current.baseUrl : nextBaseUrl,
        enabled: patch.enabled !== undefined ? Boolean(patch.enabled) : current.enabled,
        models: nextModels,
        ...(nextSecretRef ? { secretRef: nextSecretRef } : {}),
        ...(nextEnterpriseUrl ? { enterpriseUrl: nextEnterpriseUrl } : {}),
        updatedAt: this.now(),
      };

      const prevRecord = this.channels[idx]!;
      this.channels[idx] = updated;
      try {
        await this.persistToDisk();
        await this.syncGatewayAndNotify();
      } catch (error) {
        this.channels[idx] = prevRecord;
        throw error;
      }

      const redacted = this.listRedacted().find((c) => c.id === channelId);
      if (!redacted) throw new Error(`找不到模型渠道：${channelId}`);
      return redacted;
    });
  }

  /**
   * Delete a member channel with read-back verified SecretStore deletion FIRST (ADR-012 §3.1).
   * If SecretStore deletion fails, the channel record is PRESERVED and an explicit error is thrown.
   */
  async deleteChannel(channelId: string): Promise<ModelChannelsStateSnapshot> {
    return await this.runSerialized(async () => {
      if (channelId === COMPANY_CHANNEL_ID) {
        throw new Error("公司团队渠道不支持直接删除，请通过「退出登录」断开公司账号。");
      }
      const idx = this.channels.findIndex((c) => c.id === channelId);
      if (idx === -1) {
        throw new Error(`找不到模型渠道：${channelId}`);
      }
      const target = this.channels[idx]!;

      // Verified SecretStore delete FIRST!
      if (target.secretRef) {
        try {
          if (isOAuthProviderType(target.provider)) {
            await this.oauthManager.revokeAndDelete(target.id, target.secretRef);
          } else {
            await this.fence.deleteAndInvalidate(
              this.secretStore,
              target.id,
              target.secretRef,
              "channel delete",
            );
          }
        } catch (error) {
          throw this.formatSecretStoreDeleteError(error, "删除渠道凭据");
        }
      }

      this.channels.splice(idx, 1);
      this.credentialsPresence.delete(target.id);
      let persistError: unknown;
      try {
        await this.persistToDisk();
      } catch (err) {
        persistError = err;
      }
      // ALWAYS update live gateway even if writing channels.json fails after verified SecretStore delete.
      await this.syncGatewayAndNotify();
      if (persistError !== undefined) {
        throw persistError;
      }
      return this.getState();
    });
  }

  // ============================================================================
  // OAuth Subscription Login & Logout (Codex, GitHub Copilot, xAI)
  // ============================================================================

  async startOAuthLogin(input: StartOAuthLoginInput): Promise<OAuthLoginSessionView> {
    if (!isOAuthProviderType(input.provider)) {
      throw new Error(`渠道类型 ${input.provider} 不支持 OAuth 订阅登录。`);
    }
    if (input.channelId && sanitizeChannelId(input.channelId) === COMPANY_CHANNEL_ID) {
      throw new Error("公司团队渠道不支持修改，不能使用 OAuth 订阅登录覆盖。");
    }
    return await this.oauthLogin.start(input);
  }

  getOAuthLoginSession(sessionId: string): OAuthLoginSessionView | undefined {
    return this.oauthLogin.getSession(sessionId);
  }

  listOAuthLoginSessions(): OAuthLoginSessionView[] {
    return this.oauthLogin.listSessions();
  }

  submitOAuthManualCallback(sessionId: string, callbackInput: string): boolean {
    return this.oauthLogin.submitManualCallback(sessionId, callbackInput);
  }

  cancelOAuthLogin(sessionId?: string, provider?: OAuthSubscriptionProvider): OAuthLoginSessionView[] {
    return this.oauthLogin.cancel(sessionId, provider);
  }

  async cancelOAuthLoginAndWait(
    sessionId?: string,
    provider?: OAuthSubscriptionProvider,
  ): Promise<OAuthLoginSessionView[]> {
    return await this.oauthLogin.cancelAndWait(sessionId, provider);
  }

  async waitForOAuthSession(sessionId: string): Promise<OAuthLoginSessionView | undefined> {
    return await this.oauthLogin.waitForSession(sessionId);
  }

  private async applyOAuthLoginCompleted(
    credentials: OAuthSubscriptionCredentials,
    meta: {
      readonly provider: OAuthSubscriptionProvider;
      readonly channelId?: string;
      readonly channelName?: string;
      readonly enterpriseUrl?: string;
    },
  ): Promise<{ readonly channelId: string; readonly availableModelCount?: number }> {
    return await this.runSerialized(async () => {
      if (meta.channelId && sanitizeChannelId(meta.channelId) === COMPANY_CHANNEL_ID) {
        throw new Error("公司团队渠道不支持修改，不能使用 OAuth 订阅登录覆盖。");
      }
      const spec = getProviderSpec(meta.provider);
      const existingIdx = meta.channelId
        ? this.channels.findIndex((c) => c.id === meta.channelId)
        : this.channels.findIndex((c) => c.provider === meta.provider);
      const existing = existingIdx >= 0 ? this.channels[existingIdx] : undefined;
      if (existing?.id === COMPANY_CHANNEL_ID) {
        throw new Error("公司团队渠道不支持修改，不能使用 OAuth 订阅登录覆盖。");
      }

      const channelId =
        existing?.id ??
        (meta.channelId ? sanitizeChannelId(meta.channelId) : `${meta.provider}-${randomUUID().slice(0, 6)}`);
      if (channelId === COMPANY_CHANNEL_ID) {
        throw new Error("公司团队渠道不支持修改，不能使用 OAuth 订阅登录覆盖。");
      }
      const secretRef = existing?.secretRef ?? `oauth:${meta.provider}:${channelId}`;

      // Evict any cached old account credentials & abort in-flight refreshes BEFORE writing new token.
      this.oauthManager.evictSecretRef(secretRef, "OAuth interactive re-login replacing credentials");

      const lease = this.fence.acquire(channelId);
      try {
        await this.fence.writeIfCurrent(
          this.secretStore,
          channelId,
          secretRef,
          JSON.stringify(credentials),
          lease.generation,
        );
      } catch (error) {
        throw this.formatSecretStoreWriteError(error);
      } finally {
        lease.release();
      }

      // Evict again right after SecretStore write so active OAuthTokenManager immediately loads
      // and serves the NEW account token instead of a stale cached token.
      this.oauthManager.evictSecretRef(secretRef, "OAuth interactive re-login committed new credentials");

      const copilotCreds =
        meta.provider === "github-copilot" ? (credentials as GithubCopilotOAuthCredentials) : undefined;
      const availableModelIds = copilotCreds?.availableModelIds;

      let models: StoredChannelModel[];
      if (meta.provider === "github-copilot") {
        // Strictly distinguish `availableModelIds === undefined` (unfetched -> static catalog)
        // from `availableModelIds: []` (fetched org policy grants 0 models -> return [] to match gateway!).
        const permitted =
          availableModelIds !== undefined
            ? GITHUB_COPILOT_STATIC_MODELS.filter((m) =>
                isCopilotModelPermitted(m.id, availableModelIds),
              )
            : GITHUB_COPILOT_STATIC_MODELS;
        const prevById = new Map(existing?.models.map((m) => [m.id, m.enabled]) ?? []);
        models = permitted.map((m) => ({
          id: m.id,
          name: m.name,
          enabled: prevById.has(m.id) ? Boolean(prevById.get(m.id)) : m.enabled,
          source: "preset" as const,
        }));
      } else if (existing && existing.models.length > 0) {
        models = [...existing.models];
      } else {
        models = defaultModelsForProvider(meta.provider);
      }

      const accountLabel =
        meta.provider === "openai-codex"
          ? (credentials as CodexOAuthCredentials).accountId
          : meta.provider === "github-copilot"
            ? copilotCreds?.enterpriseUrl ?? "github.com"
            : "xAI Subscription";

      const now = this.now();
      const record: StoredChannelRecord = {
        id: channelId,
        name: existing?.name ?? (meta.channelName?.trim() || spec.labelZh),
        provider: meta.provider,
        baseUrl: existing?.baseUrl ?? spec.defaultBaseUrl,
        enabled: true,
        models,
        secretRef,
        ...(copilotCreds?.enterpriseUrl || meta.enterpriseUrl
          ? { enterpriseUrl: copilotCreds?.enterpriseUrl ?? meta.enterpriseUrl }
          : {}),
        ...(availableModelIds ? { availableModelIds } : {}),
        ...(accountLabel ? { accountLabel } : {}),
        createdAt: existing?.createdAt ?? now,
        updatedAt: now,
      };

      if (existingIdx >= 0) {
        this.channels[existingIdx] = record;
      } else {
        this.channels.push(record);
      }
      this.credentialsPresence.set(channelId, true);

      await this.persistToDisk();
      await this.syncGatewayAndNotify();

      return {
        channelId,
        ...(availableModelIds ? { availableModelCount: availableModelIds.length } : {}),
      };
    });
  }

  /**
   * Logout an OAuth subscription channel with read-back verified SecretStore deletion FIRST (ADR-012 §3.1 & §3.4).
   * If deletion fails, credentials & channel state are preserved and an explicit error is thrown.
   */
  async logoutOAuthChannel(channelId: string): Promise<RedactedChannel> {
    return await this.runSerialized(async () => {
      const idx = this.channels.findIndex((c) => c.id === channelId);
      if (idx === -1) throw new Error(`找不到模型渠道：${channelId}`);
      const target = this.channels[idx]!;
      if (!isOAuthProviderType(target.provider)) {
        throw new Error("该渠道不是 OAuth 订阅渠道。");
      }
      if (target.secretRef) {
        try {
          await this.oauthManager.revokeAndDelete(target.id, target.secretRef);
        } catch (error) {
          throw this.formatSecretStoreDeleteError(error, "退出订阅登录");
        }
      }

      const updated: StoredChannelRecord = {
        id: target.id,
        name: target.name,
        provider: target.provider,
        baseUrl: target.baseUrl,
        enabled: false,
        models: target.models,
        ...(target.enterpriseUrl ? { enterpriseUrl: target.enterpriseUrl } : {}),
        createdAt: target.createdAt,
        updatedAt: this.now(),
      };
      this.channels[idx] = updated;
      this.credentialsPresence.set(target.id, false);
      let persistError: unknown;
      try {
        await this.persistToDisk();
      } catch (err) {
        persistError = err;
      }
      // ALWAYS update live gateway even if writing channels.json fails after verified OAuth revocation.
      await this.syncGatewayAndNotify();
      if (persistError !== undefined) {
        throw persistError;
      }

      const redacted = this.listRedacted().find((c) => c.id === channelId);
      if (!redacted) throw new Error(`找不到模型渠道：${channelId}`);
      return redacted;
    });
  }

  // ============================================================================
  // Test Connection, Fetch Models & Plan Quota
  // ============================================================================

  private async resolveChannelApiKey(channelId: string): Promise<string | undefined> {
    if (channelId === COMPANY_CHANNEL_ID) {
      return this.companyAuth.getApiKeyInternal();
    }
    const ch = this.channels.find((c) => c.id === channelId);
    if (!ch?.secretRef) return undefined;
    return await this.readSecretValue(ch.secretRef);
  }

  private async resolveOAuthCredentials(channel: StoredChannelRecord): Promise<OAuthSubscriptionCredentials> {
    if (!isOAuthProviderType(channel.provider)) {
      throw new Error("该渠道不是 OAuth 订阅渠道。");
    }
    // Prefer OAuthTokenManager (handles single-flight refresh & fence verification).
    if (this.oauthManager.getBindingId(channel.id) !== undefined) {
      return await this.oauthManager.getValidCredentials(
        channel.id,
        AbortSignal.timeout(this.requestTimeoutMs),
      );
    }
    if (!channel.secretRef) {
      throw new Error("请先完成 OAuth 订阅登录。");
    }
    const raw = await this.readSecretValue(channel.secretRef);
    if (!raw) {
      throw new Error("未在钥匙串中找到该 OAuth 订阅凭据，请重新登录。");
    }
    const parsed = JSON.parse(raw) as OAuthSubscriptionCredentials;
    if (parsed.expires - this.now() <= 60_000) {
      const refresher = this.buildOAuthRefresher(channel.provider);
      const refreshed = await refresher(parsed, AbortSignal.timeout(this.requestTimeoutMs));
      const lease = this.fence.acquire(channel.id);
      try {
        await this.fence.writeIfCurrent(
          this.secretStore,
          channel.id,
          channel.secretRef,
          JSON.stringify(refreshed),
          lease.generation,
        );
      } finally {
        lease.release();
      }
      return refreshed;
    }
    return parsed;
  }

  async testChannel(channelId: string): Promise<ChannelTestResult> {
    const channel = this.channels.find((c) => c.id === channelId);
    if (!channel) {
      return { success: false, message: `找不到模型渠道：${channelId}`, errorType: "not_found" };
    }
    if (isOAuthProviderType(channel.provider)) {
      try {
        const creds = await this.resolveOAuthCredentials(channel);
        if (channel.provider === "github-copilot") {
          const copilot = creds as GithubCopilotOAuthCredentials;
          const modelIds = await fetchGitHubCopilotAvailableModels(
            copilot.access,
            copilot.enterpriseUrl ?? channel.enterpriseUrl,
            AbortSignal.timeout(this.requestTimeoutMs),
            { ...this.oauthEndpoints, fetchImpl: this.oauthEndpoints?.fetchImpl ?? this.fetchImpl },
            false,
          );
          return {
            success: true,
            message:
              modelIds.length > 0
                ? `GitHub Copilot 订阅连接正常，可用 ${modelIds.length} 个模型`
                : "GitHub Copilot 订阅连接正常",
          };
        }
        return {
          success: true,
          message: `${getProviderSpec(channel.provider).labelZh} 订阅凭据有效`,
        };
      } catch (error) {
        return buildExceptionFailure(error);
      }
    }

    const apiKey = await this.resolveChannelApiKey(channelId);
    if (!apiKey) {
      return {
        success: false,
        message: "未找到渠道 API Key，请先配置凭据。",
        errorType: "auth",
      };
    }

    return await this.testChannelDirect({
      channelId: channel.id,
      provider: channel.provider,
      baseUrl: channel.baseUrl,
      apiKey,
      models: channel.models,
    });
  }

  private assertStoredChannelTargetMatch(
    channelId: string,
    provider: ProviderType,
    requestedBaseUrl?: string,
  ): StoredChannelRecord {
    const stored = this.channels.find((c) => c.id === channelId);
    if (!stored) {
      throw new Error(`找不到模型渠道：${channelId}`);
    }
    if (stored.provider !== provider) {
      throw new Error(
        "不能使用已保存的渠道凭据请求其他供应商或自定义地址，请提供新的 API Key。",
      );
    }
    const trimmedReq = requestedBaseUrl?.trim();
    if (trimmedReq) {
      const effectiveStored = stored.baseUrl.trim() || getProviderSpec(stored.provider).defaultBaseUrl;
      if (normalizeBaseUrl(trimmedReq) !== normalizeBaseUrl(effectiveStored)) {
        throw new Error(
          "不能使用已保存的渠道凭据请求其他供应商或自定义地址，请提供新的 API Key。",
        );
      }
    }
    return stored;
  }

  async testChannelDirect(input: TestChannelDirectInput): Promise<ChannelTestResult> {
    if (!isProviderType(input.provider)) {
      return { success: false, message: "不支持的渠道类型。", errorType: "bad_request" };
    }
    if (isOAuthProviderType(input.provider)) {
      if (input.channelId) {
        this.assertStoredChannelTargetMatch(input.channelId, input.provider, input.baseUrl);
        return await this.testChannel(input.channelId);
      }
      return {
        success: false,
        message: "请先完成 OAuth 订阅登录后再测试连接。",
        errorType: "auth",
      };
    }

    const spec = getProviderSpec(input.provider);
    let apiKey =
      input.provider === "zhipu-coding-team"
        ? serializeZhipuTeamCredential(input.apiKey, input.zhipuTeam)
        : input.apiKey?.trim();
    if (!apiKey && input.channelId) {
      this.assertStoredChannelTargetMatch(input.channelId, input.provider, input.baseUrl);
      apiKey = await this.resolveChannelApiKey(input.channelId);
    }
    if (!apiKey) {
      return { success: false, message: "请填写 API Key 后再测试连接。", errorType: "auth" };
    }

    const baseUrl = input.baseUrl?.trim() || spec.defaultBaseUrl;
    if (!baseUrl) {
      return { success: false, message: "请填写接口地址（Base URL）。", errorType: "bad_request" };
    }

    const extraSecrets = [apiKey];

    try {
      // Zhipu Coding Team: validate via quota/limit endpoint with org/project headers.
      if (input.provider === "zhipu-coding-team") {
        const team = parseZhipuTeamCredentials(apiKey);
        if (!team) {
          return { success: false, message: "智谱团队版凭据格式无效。", errorType: "auth" };
        }
        extraSecrets.push(team.apiKey);
        const base = this.assertOutbound(baseUrl);
        const probeUrl = this.assertOutbound(`${base.origin}/api/monitor/usage/quota/limit?type=2`);
        const headers: Record<string, string> = {
          Authorization: team.apiKey,
          "Content-Type": "application/json",
          "User-Agent": CODING_PLAN_USER_AGENT,
        };
        if (team.organization) headers["bigmodel-organization"] = team.organization;
        if (team.project) headers["bigmodel-project"] = team.project;
        const resp = await this.fetchImpl(probeUrl, {
          method: "GET",
          headers,
          redirect: "error",
          signal: AbortSignal.timeout(this.requestTimeoutMs),
        });
        if (resp.ok) {
          await resp.body?.cancel().catch(() => undefined);
          return { success: true, message: "智谱 Coding Plan 团队版连接测试成功" };
        }
        const errText = await readBoundedText(resp, MAX_ERROR_BODY_BYTES);
        return buildTestFailure(
          classifyHttpStatus(resp.status, errText),
          extractHttpErrorMessage(errText),
          resp.status,
          extraSecrets,
        );
      }

      // Google Generative AI: GET /models with x-goog-api-key header (never key in URL query).
      if (spec.api === "google-generative-ai") {
        const modelsUrl = this.assertOutbound(resolveGoogleModelsUrl(baseUrl));
        const resp = await this.fetchImpl(modelsUrl, {
          method: "GET",
          headers: { "x-goog-api-key": apiKey, Accept: "application/json" },
          redirect: "error",
          signal: AbortSignal.timeout(this.requestTimeoutMs),
        });
        if (resp.ok) {
          await resp.body?.cancel().catch(() => undefined);
          return { success: true, message: "Google AI 连接测试成功" };
        }
        const errText = await readBoundedText(resp, MAX_ERROR_BODY_BYTES);
        return buildTestFailure(
          classifyHttpStatus(resp.status, errText),
          extractHttpErrorMessage(errText),
          resp.status,
          extraSecrets,
        );
      }

      // Anthropic-messages probe (Xiaomi, Xiaomi Token Plan, Qwen Token Plan, Anthropic-Compatible)
      if (spec.testStrategy === "messages-probe") {
        const probeUrl = this.assertOutbound(resolveAnthropicMessagesUrl(baseUrl, input.provider));
        const probeModel =
          input.modelId?.trim() ||
          input.models?.find((m) => m.enabled)?.id ||
          input.models?.[0]?.id ||
          spec.presetModels[0]?.id ||
          "claude-sonnet-4-6";
        const headers: Record<string, string> = {
          "Content-Type": "application/json",
          "anthropic-version": "2023-06-01",
          ...this.buildAuthHeaders(spec, apiKey),
        };
        if (spec.requiresCodingPlanUserAgent) {
          headers["User-Agent"] = CODING_PLAN_USER_AGENT;
        }
        const resp = await this.fetchImpl(probeUrl, {
          method: "POST",
          headers,
          body: JSON.stringify({
            model: probeModel,
            max_tokens: 1,
            messages: [{ role: "user", content: "hi" }],
          }),
          redirect: "error",
          signal: AbortSignal.timeout(this.requestTimeoutMs),
        });
        if (resp.ok) {
          await resp.body?.cancel().catch(() => undefined);
          return { success: true, message: `${spec.labelZh} 连接测试成功` };
        }
        const errText = await readBoundedText(resp, MAX_ERROR_BODY_BYTES);
        return buildTestFailure(
          classifyHttpStatus(resp.status, errText),
          extractHttpErrorMessage(errText),
          resp.status,
          extraSecrets,
        );
      }

      // Standard GET /models test (Anthropic / OpenAI / DeepSeek / Kimi / Zhipu / MiniMax / Qwen / Doubao / Custom / Company)
      const modelsUrlRaw =
        spec.api === "anthropic-messages"
          ? resolveAnthropicModelsUrl(baseUrl, input.provider)
          : resolveOpenAIModelsUrl(baseUrl);
      const modelsUrl = this.assertOutbound(modelsUrlRaw);
      const headers: Record<string, string> = {
        Accept: "application/json",
        ...this.buildAuthHeaders(spec, apiKey),
      };
      if (spec.api === "anthropic-messages") {
        headers["anthropic-version"] = "2023-06-01";
      }
      if (spec.requiresCodingPlanUserAgent) {
        headers["User-Agent"] = CODING_PLAN_USER_AGENT;
      }

      const resp = await this.fetchImpl(modelsUrl, {
        method: "GET",
        headers,
        redirect: "error",
        signal: AbortSignal.timeout(this.requestTimeoutMs),
      });
      if (resp.ok) {
        await resp.body?.cancel().catch(() => undefined);
        return { success: true, message: `${spec.labelZh} 连接测试成功` };
      }
      const errText = await readBoundedText(resp, MAX_ERROR_BODY_BYTES);
      return buildTestFailure(
        classifyHttpStatus(resp.status, errText),
        extractHttpErrorMessage(errText),
        resp.status,
        extraSecrets,
      );
    } catch (error) {
      return buildExceptionFailure(error, extraSecrets);
    }
  }

  async fetchChannelModels(input: FetchChannelModelsInput): Promise<FetchChannelModelsResult> {
    if (!isProviderType(input.provider)) {
      return { success: false, message: "不支持的渠道类型。", models: [], errorType: "bad_request" };
    }
    const spec = getProviderSpec(input.provider);

    // OAuth subscription channels
    if (isOAuthProviderType(input.provider)) {
      if (input.provider === "openai-codex") {
        const models: StoredChannelModel[] = CODEX_STATIC_MODELS.map((m) => ({
          id: m.id,
          name: m.name,
          enabled: m.enabled,
          source: "preset",
        }));
        return {
          success: true,
          message: `已加载 ${models.length} 个 ChatGPT Codex 订阅模型`,
          models,
        };
      }
      if (input.provider === "xai") {
        const models: StoredChannelModel[] = XAI_STATIC_MODELS.map((m) => ({
          id: m.id,
          name: m.name,
          enabled: m.enabled,
          source: "preset",
        }));
        return {
          success: true,
          message: `已加载 ${models.length} 个 xAI Grok 订阅模型`,
          models,
        };
      }
      // GitHub Copilot: try live subscription policy sync if channel logged in, else static catalog.
      const channel = input.channelId
        ? this.assertStoredChannelTargetMatch(input.channelId, input.provider, input.baseUrl)
        : undefined;
      if (channel && channel.secretRef) {
        try {
          const creds = (await this.resolveOAuthCredentials(channel)) as GithubCopilotOAuthCredentials;
          const available = await fetchGitHubCopilotAvailableModels(
            creds.access,
            creds.enterpriseUrl ?? channel.enterpriseUrl,
            AbortSignal.timeout(this.requestTimeoutMs),
            { ...this.oauthEndpoints, fetchImpl: this.oauthEndpoints?.fetchImpl ?? this.fetchImpl },
            false,
          );
          if (available.length === 0) {
            return {
              success: true,
              message:
                "GitHub Copilot 组织或订阅策略当前未授权任何可用模型，请联系管理员在 Copilot 策略中启用模型。",
              models: [],
            };
          }
          const filtered = GITHUB_COPILOT_STATIC_MODELS.filter((m) =>
            isCopilotModelPermitted(m.id, available),
          );
          return {
            success: true,
            message: `已同步 ${filtered.length} 个 GitHub Copilot 可用模型`,
            models: filtered.map((m) => ({
              id: m.id,
              name: m.name,
              enabled: m.enabled,
              source: "fetched",
            })),
          };
        } catch (error) {
          const failure = buildExceptionFailure(error);
          return {
            success: false,
            message: failure.message,
            models: [],
            ...(failure.errorType ? { errorType: failure.errorType } : {}),
          };
        }
      }
      const models: StoredChannelModel[] = GITHUB_COPILOT_STATIC_MODELS.map((m) => ({
        id: m.id,
        name: m.name,
        enabled: m.enabled,
        source: "preset",
      }));
      return {
        success: true,
        message: `已加载 ${models.length} 个 GitHub Copilot 预设模型`,
        models,
      };
    }

    // Suppliers without a public /models endpoint -> return versioned presets immediately.
    if (!spec.supportsFetchModels) {
      const presets = defaultModelsForProvider(input.provider);
      return {
        success: true,
        message: `${spec.labelZh} 未开放模型列表端点，已加载 ${presets.length} 个预设模型`,
        models: presets,
      };
    }

    let apiKey =
      input.provider === "zhipu-coding-team"
        ? serializeZhipuTeamCredential(input.apiKey, input.zhipuTeam)
        : input.apiKey?.trim();
    if (!apiKey && input.channelId) {
      this.assertStoredChannelTargetMatch(input.channelId, input.provider, input.baseUrl);
      apiKey = await this.resolveChannelApiKey(input.channelId);
    }
    if (!apiKey) {
      return {
        success: false,
        message: "请先填写 API Key 后再拉取模型列表。",
        models: [],
        errorType: "auth",
      };
    }

    const baseUrl = input.baseUrl?.trim() || spec.defaultBaseUrl;
    if (!baseUrl) {
      return {
        success: false,
        message: "请填写接口地址（Base URL）。",
        models: [],
        errorType: "bad_request",
      };
    }

    const extraSecrets = [apiKey];
    try {
      if (spec.api === "google-generative-ai") {
        const modelsUrl = this.assertOutbound(resolveGoogleModelsUrl(baseUrl));
        const resp = await this.fetchImpl(modelsUrl, {
          method: "GET",
          headers: { "x-goog-api-key": apiKey, Accept: "application/json" },
          redirect: "error",
          signal: AbortSignal.timeout(this.requestTimeoutMs),
        });
        if (!resp.ok) {
          const errText = await readBoundedText(resp, MAX_ERROR_BODY_BYTES);
          const failure = buildTestFailure(
            classifyHttpStatus(resp.status, errText),
            extractHttpErrorMessage(errText),
            resp.status,
            extraSecrets,
          );
          return {
            success: false,
            message: failure.message,
            models: [],
            ...(failure.errorType ? { errorType: failure.errorType } : {}),
            ...(failure.statusCode !== undefined ? { statusCode: failure.statusCode } : {}),
          };
        }
        const json = JSON.parse(await readBoundedText(resp, MAX_MODELS_BODY_BYTES)) as Record<
          string,
          unknown
        >;
        const rawList = Array.isArray(json.models) ? json.models : [];
        const models: StoredChannelModel[] = [];
        for (const item of rawList) {
          if (!isRecord(item) || typeof item.name !== "string") continue;
          const methods = Array.isArray(item.supportedGenerationMethods)
            ? item.supportedGenerationMethods
            : [];
          if (methods.length > 0 && !methods.includes("generateContent")) continue;
          const id = item.name.replace(/^models\//, "").trim();
          if (!id || !isAgentCapableModelId(id)) continue;
          const displayName =
            typeof item.displayName === "string" && item.displayName.trim()
              ? item.displayName.trim()
              : id;
          models.push({ id, name: displayName, enabled: false, source: "fetched" });
        }
        return {
          success: true,
          message: `已获取 ${models.length} 个 Google AI 模型`,
          models: sanitizeModels(input.channelId ?? input.provider, models),
        };
      }

      const modelsUrlRaw =
        spec.api === "anthropic-messages"
          ? resolveAnthropicModelsUrl(baseUrl, input.provider)
          : resolveOpenAIModelsUrl(baseUrl);
      const modelsUrl = this.assertOutbound(modelsUrlRaw);
      const headers: Record<string, string> = {
        Accept: "application/json",
        ...this.buildAuthHeaders(spec, apiKey),
      };
      if (spec.api === "anthropic-messages") {
        headers["anthropic-version"] = "2023-06-01";
      }
      if (spec.requiresCodingPlanUserAgent) {
        headers["User-Agent"] = CODING_PLAN_USER_AGENT;
      }

      const resp = await this.fetchImpl(modelsUrl, {
        method: "GET",
        headers,
        redirect: "error",
        signal: AbortSignal.timeout(this.requestTimeoutMs),
      });
      if (!resp.ok) {
        const errText = await readBoundedText(resp, MAX_ERROR_BODY_BYTES);
        const failure = buildTestFailure(
          classifyHttpStatus(resp.status, errText),
          extractHttpErrorMessage(errText),
          resp.status,
          extraSecrets,
        );
        return {
          success: false,
          message: failure.message,
          models: [],
          ...(failure.errorType ? { errorType: failure.errorType } : {}),
          ...(failure.statusCode !== undefined ? { statusCode: failure.statusCode } : {}),
        };
      }

      const json = JSON.parse(await readBoundedText(resp, MAX_MODELS_BODY_BYTES)) as Record<
        string,
        unknown
      >;
      const list = Array.isArray(json.data)
        ? json.data
        : Array.isArray(json.models)
          ? json.models
          : [];
      const fetched: StoredChannelModel[] = [];
      for (const item of list) {
        if (!isRecord(item) || typeof item.id !== "string") continue;
        const id = item.id.trim();
        if (!id || !isAgentCapableModelId(id)) continue;
        const displayName =
          typeof item.display_name === "string" && item.display_name.trim()
            ? item.display_name.trim()
            : typeof item.name === "string" && item.name.trim()
              ? item.name.trim()
              : id;
        fetched.push({ id, name: displayName, enabled: false, source: "fetched" });
      }
      const cleaned = sanitizeModels(input.channelId ?? input.provider, fetched);
      return {
        success: true,
        message: `已获取 ${cleaned.length} 个可用模型`,
        models: cleaned,
      };
    } catch (error) {
      const failure = buildExceptionFailure(error, extraSecrets);
      return {
        success: false,
        message: failure.message,
        models: [],
        ...(failure.errorType ? { errorType: failure.errorType } : {}),
      };
    }
  }

  async getChannelPlanQuota(channelId: string): Promise<ChannelPlanQuotaResult> {
    const channel = this.channels.find((c) => c.id === channelId);
    if (!channel) {
      return {
        supported: false,
        provider: "custom",
        windows: [],
        updatedAt: this.now(),
        message: `找不到模型渠道：${channelId}`,
      };
    }

    if (channel.provider === "openai-codex") {
      try {
        const creds = (await this.resolveOAuthCredentials(channel)) as CodexOAuthCredentials;
        return await queryCodexPlanQuota(creds, {
          ...this.oauthEndpoints,
          fetchImpl: this.oauthEndpoints?.fetchImpl ?? this.fetchImpl,
          now: this.now,
        });
      } catch (error) {
        return {
          supported: false,
          provider: channel.provider,
          windows: [],
          updatedAt: this.now(),
          message: redactSecretsFromText(
            error instanceof Error ? error.message : "ChatGPT 订阅额度查询失败",
          ),
        };
      }
    }

    if (channel.provider === "github-copilot") {
      try {
        const creds = (await this.resolveOAuthCredentials(channel)) as GithubCopilotOAuthCredentials;
        return await queryGithubCopilotPlanQuota(creds, {
          ...this.oauthEndpoints,
          fetchImpl: this.oauthEndpoints?.fetchImpl ?? this.fetchImpl,
          now: this.now,
        });
      } catch (error) {
        return {
          supported: false,
          provider: channel.provider,
          windows: [],
          updatedAt: this.now(),
          message: redactSecretsFromText(
            error instanceof Error ? error.message : "GitHub Copilot 额度查询失败",
          ),
        };
      }
    }

    const apiKey = await this.resolveChannelApiKey(channelId);
    if (!apiKey) {
      return {
        supported: false,
        provider: channel.provider,
        windows: [],
        updatedAt: this.now(),
        message: "该渠道尚未配置凭据",
      };
    }

    return await queryApiKeyPlanQuota(channel.provider, apiKey, channel.baseUrl, {
      fetchImpl: this.fetchImpl,
      now: this.now,
      validateOutboundUrl: this.validateOutboundUrl,
    });
  }

  private buildAuthHeaders(spec: ProviderCapabilitySpec, apiKey: string): Record<string, string> {
    if (spec.authMode === "x-api-key") {
      return { "x-api-key": apiKey };
    }
    if (spec.authMode === "api-key-header") {
      return { "api-key": apiKey };
    }
    if (spec.authMode === "google-api-key") {
      return { "x-goog-api-key": apiKey };
    }
    return { Authorization: `Bearer ${apiKey}` };
  }

  private formatSecretStoreWriteError(error: unknown): Error {
    if (error instanceof SecretStoreUnavailableError) {
      const msg =
        error.kind === "denied"
          ? "系统钥匙串拒绝写入模型渠道凭据，请授权后重试。"
          : "系统钥匙串暂不可用，无法安全保存模型渠道凭据。";
      return new Error(msg, { cause: error });
    }
    return error instanceof Error ? error : new Error("无法保存模型渠道凭据。");
  }

  private formatSecretStoreDeleteError(error: unknown, action: string): Error {
    if (error instanceof SecretStoreUnavailableError) {
      const msg =
        error.kind === "denied"
          ? `系统钥匙串拒绝${action}，已保留当前渠道状态，请授权后重试。`
          : `无法清除本机钥匙串中的凭据，${action}已中止并保留原状态，请检查钥匙串后重试。`;
      return new Error(msg, { cause: error });
    }
    return new Error(`清除本机钥匙串凭据失败，${action}已中止并保留原状态。`, { cause: error });
  }
}
