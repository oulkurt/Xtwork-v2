// @effect-diagnostics nodeBuiltinImport:off globalFetch:off -- The standalone gateway uses Node HTTP streams.
import { randomBytes, randomUUID, timingSafeEqual } from "node:crypto";
import { once } from "node:events";
import { constants } from "node:fs";
import { access, mkdir, readFile, rename, rm, writeFile } from "node:fs/promises";
import { createServer, type IncomingMessage, type ServerResponse } from "node:http";
import { dirname, join, resolve } from "node:path";
import { createZstdDecompress } from "node:zlib";
import {
  assertStrictOAuthDestination,
  buildCopilotUpstreamHeaders,
  CODEX_DEFAULT_UPSTREAM_BASE_URL,
  type CodexOAuthCredentials,
  createCodexPlaceholderJwt,
  deriveGitHubCopilotBaseUrl,
  extractCodexAccountId,
  type GithubCopilotOAuthCredentials,
  isCopilotModelPermitted,
  type OAuthDestinationValidator,
  OAuthTokenManager,
  type OAuthSubscriptionCredentials,
  type OAuthSubscriptionProvider,
  type RegisteredOAuthChannel,
  XAI_DEFAULT_UPSTREAM_BASE_URL,
  type XaiOAuthCredentials,
} from "./oauthProxy.ts";
import {
  ChannelCredentialFence,
  createSecretStore,
  MODEL_CHANNELS_SECRET_NAMESPACE,
  type SecretStore,
} from "./secretStore.ts";

export const GATEWAY_TOKEN_ENV = "XTWORK_MODEL_GATEWAY_TOKEN";
export const GATEWAY_TOKEN_HEADER = "x-xtwork-gateway-token";
export const MODEL_PROVIDER = "xtwork";
export const STANDARD_MODEL = "standard";
export const COMPANY_CHANNEL_ID = "xiaotong-work-team";
export const COMPANY_DEFAULT_MODEL_ID = "deepseek-flash";
export const CODING_PLAN_USER_AGENT = "Proma/1.0.0 (+https://github.com/ErlichLiu/Proma)";

const MAGPIE_URL = "http://127.0.0.1:3425/v1";
const MAGPIE_MODEL = "our-free-model/hy4-flash-free";
const REQUEST_LIMIT = 16 * 1024 * 1024;
const REDACTED_MARKER = "[REDACTED]";

export type GatewayApiKind =
  | "openai-completions"
  | "openai-responses"
  | "openai-codex-responses"
  | "anthropic-messages"
  | "google-generative-ai";

export type GatewayProviderType =
  | "company-team"
  | "anthropic"
  | "anthropic-compatible"
  | "deepseek"
  | "kimi-api"
  | "kimi-coding"
  | "zhipu"
  | "zhipu-coding"
  | "zhipu-coding-team"
  | "doubao-api"
  | "minimax"
  | "qwen"
  | "qwen-anthropic"
  | "qwen-token-plan"
  | "xiaomi"
  | "xiaomi-token-plan"
  | "openai"
  | "openai-responses"
  | "google"
  | "custom"
  | "openai-codex"
  | "github-copilot"
  | "xai"
  | "dev-fallback";

export interface GatewayModelConfig {
  readonly id: string;
  readonly name?: string;
  readonly enabled: boolean;
  readonly api?: GatewayApiKind;
  readonly reasoning?: boolean;
  readonly contextWindow?: number;
  readonly maxTokens?: number;
  readonly input?: readonly ("text" | "image")[];
  readonly compat?: Record<string, unknown>;
  readonly thinkingLevelMap?: Record<string, string | null>;
  /** Optional upstream model ID rewrite (e.g., dev fallback mapping `standard` -> upstream model). */
  readonly upstreamModelId?: string;
}

export interface GatewayChannelConfig {
  readonly id: string;
  readonly name?: string;
  readonly providerType: GatewayProviderType;
  readonly enabled: boolean;
  readonly api: GatewayApiKind;
  /** Upstream API base URL. For GitHub Copilot OAuth, optional override (otherwise derived from token `proxy-ep`). */
  readonly baseUrl?: string;
  readonly models: readonly GatewayModelConfig[];
  /** Direct API key in memory (never written to models.json or Pi env). */
  readonly apiKey?: string;
  /** Optional SecretStore ref for API key lookup on demand. */
  readonly secretRef?: string;
  /** Optional custom User-Agent override for Coding / Token Plan channels. */
  readonly userAgent?: string;
  /** Optional static upstream headers injected by the gateway (never exposed to Pi). */
  readonly upstreamHeaders?: Readonly<Record<string, string>>;
  /** For GitHub Copilot OAuth channels: subscription/organization allowed model IDs. */
  readonly availableModelIds?: readonly string[];
  /** For OAuth subscription channels: OAuth credentials & optional refresher. */
  readonly oauth?: {
    readonly provider: OAuthSubscriptionProvider;
    readonly secretRef: string;
    readonly initialCredentials?: OAuthSubscriptionCredentials;
    readonly refresh: (
      current: OAuthSubscriptionCredentials,
      signal: AbortSignal,
    ) => Promise<OAuthSubscriptionCredentials>;
  };
}

export interface ZhipuTeamCredentials {
  readonly apiKey: string;
  readonly organization?: string;
  readonly project?: string;
}

function normalizeCredentialKey(key: string): string {
  return key.trim().toLowerCase().replace(/[_-]/g, "");
}

/**
 * Parse Zhipu Coding Plan Team composite credentials (`apiKey=...; bigmodel_organization=...;
 * bigmodel_project=...` or JSON object).
 */
export function parseZhipuTeamCredentials(secret: string): ZhipuTeamCredentials | null {
  const trimmed = secret.trim();
  if (!trimmed) return null;

  const pick = (record: Record<string, unknown>): ZhipuTeamCredentials | null => {
    const normalized = new Map<string, string>();
    for (const [key, value] of Object.entries(record)) {
      if (typeof value === "string" && value.trim()) {
        normalized.set(normalizeCredentialKey(key), value.trim());
      }
    }
    const apiKey =
      normalized.get("apikey") ??
      normalized.get("apitoken") ??
      normalized.get("token") ??
      normalized.get("authorization") ??
      normalized.get("auth") ??
      normalized.get("bearer");
    const organization =
      normalized.get("bigmodelorganization") ??
      normalized.get("organization") ??
      normalized.get("org");
    const project = normalized.get("bigmodelproject") ?? normalized.get("project");
    if (!apiKey) return null;
    return {
      apiKey,
      ...(organization ? { organization } : {}),
      ...(project ? { project } : {}),
    };
  };

  if (trimmed.startsWith("{")) {
    try {
      const parsed = JSON.parse(trimmed) as unknown;
      if (parsed && typeof parsed === "object" && !Array.isArray(parsed)) {
        return pick(parsed as Record<string, unknown>);
      }
    } catch {
      return null;
    }
  }

  const entries: Record<string, string> = {};
  for (const part of trimmed.split(/[;\n]+/)) {
    const index = part.indexOf("=");
    if (index <= 0) continue;
    entries[part.slice(0, index).trim()] = part.slice(index + 1).trim();
  }
  return pick(entries);
}

export function extractZhipuCodingTeamApiToken(secret: string): string {
  const parsed = parseZhipuTeamCredentials(secret);
  if (parsed) return parsed.apiKey;
  const trimmed = secret.trim();
  return trimmed || secret;
}

export function stripLegacyContextSuffix(modelId: string): string {
  return modelId.replace(/\[1m\]$/i, "");
}

export function formatModelSlug(channelId: string, modelId: string): string {
  return `${channelId}/${modelId}`;
}

export function parseModelSlug(slug: string): { channelId: string; modelId: string } | null {
  const index = slug.indexOf("/");
  if (index <= 0 || index === slug.length - 1) return null;
  return { channelId: slug.slice(0, index), modelId: slug.slice(index + 1) };
}

function requiresCodingPlanUserAgent(providerType: GatewayProviderType): boolean {
  return (
    providerType === "kimi-coding" ||
    providerType === "xiaomi-token-plan" ||
    providerType === "qwen-token-plan" ||
    providerType === "zhipu-coding" ||
    providerType === "zhipu-coding-team"
  );
}

function usesBearerOnlyAnthropicAuth(providerType: GatewayProviderType): boolean {
  return (
    requiresCodingPlanUserAgent(providerType) ||
    providerType === "minimax" ||
    providerType === "qwen-anthropic" ||
    providerType === "github-copilot"
  );
}

function isDeepSeekV4AnthropicModel(
  providerType: GatewayProviderType,
  modelId: string,
): boolean {
  if (providerType !== "deepseek") return false;
  const lower = stripLegacyContextSuffix(modelId).trim().toLowerCase();
  return (
    lower.startsWith("deepseek-v4") ||
    lower === "deepseek-flash" ||
    lower === "deepseek-pro" ||
    lower === "deepseek-reasoner"
  );
}

function effortFromBudgetTokens(budget: unknown): "low" | "medium" | "high" | "max" {
  if (typeof budget !== "number" || !Number.isFinite(budget)) return "max";
  if (budget <= 2048) return "low";
  if (budget <= 8192) return "medium";
  if (budget <= 16384) return "high";
  return "max";
}

/**
 * Rewrite DeepSeek V4 Anthropic-compatible requests to `{ thinking: { type: "enabled" },
 * output_config: { effort } }` (ADR-012 §3.3).
 */
export function rewriteDeepSeekV4AnthropicBody(
  body: Record<string, unknown>,
  providerType: GatewayProviderType,
  modelId: string,
): Record<string, unknown> {
  if (!isDeepSeekV4AnthropicModel(providerType, modelId)) return body;
  const thinking = body.thinking;
  if (!thinking || typeof thinking !== "object" || Array.isArray(thinking)) return body;
  const thinkingRecord = thinking as Record<string, unknown>;
  if (thinkingRecord.type === "disabled") {
    const next: Record<string, unknown> = { ...body, thinking: { type: "disabled" } };
    delete next.output_config;
    return next;
  }
  if (thinkingRecord.type === "enabled" || thinkingRecord.type === "adaptive") {
    const existingOutputConfig =
      body.output_config &&
      typeof body.output_config === "object" &&
      !Array.isArray(body.output_config)
        ? (body.output_config as Record<string, unknown>)
        : {};
    const existingEffort = existingOutputConfig.effort;
    const effort =
      typeof existingEffort === "string" && existingEffort.length > 0
        ? existingEffort
        : effortFromBudgetTokens(thinkingRecord.budget_tokens);
    return {
      ...body,
      thinking: { type: "enabled" },
      output_config: { ...existingOutputConfig, effort },
    };
  }
  return body;
}

function validateUpstreamBaseUrl(rawUrl: string): URL {
  const url = new URL(rawUrl.trim());
  if (
    !["http:", "https:"].includes(url.protocol) ||
    url.username ||
    url.password ||
    url.hash
  ) {
    throw new Error(
      `Upstream base URL "${rawUrl}" must be an HTTP(S) URL without credentials or fragment.`,
    );
  }
  return url;
}

function normalizeGoogleBaseUrl(rawUrl: string): URL {
  const url = validateUpstreamBaseUrl(rawUrl);
  const cleanPath = url.pathname.replace(/\/+$/, "");
  if (!/\/v1(?:beta)?$/i.test(cleanPath)) {
    url.pathname = `${cleanPath}/v1beta`;
  } else {
    url.pathname = cleanPath;
  }
  return url;
}

const GOOGLE_ENDPOINT_PATTERN =
  /^(?:\/v1(?:beta)?)?\/models\/([^/:]+):(streamGenerateContent|generateContent)$/;

const ALLOWED_QUERY_PARAMS_BY_PROTOCOL: Readonly<Record<GatewayApiKind, ReadonlySet<string>>> = {
  "openai-completions": new Set(),
  "openai-responses": new Set(),
  "openai-codex-responses": new Set(),
  "anthropic-messages": new Set(),
  "google-generative-ai": new Set(["alt"]),
};

const ALLOWED_PASSTHROUGH_HEADERS: Readonly<Record<GatewayApiKind, ReadonlySet<string>>> = {
  "openai-completions": new Set([
    "accept",
    "content-type",
    "openai-beta",
    "openai-organization",
    "openai-project",
    "x-client-request-id",
  ]),
  "openai-responses": new Set([
    "accept",
    "content-type",
    "openai-beta",
    "openai-organization",
    "openai-project",
    "session-id",
    "session_id",
    "x-client-request-id",
    "x-session-id",
    "x-session-affinity",
  ]),
  "openai-codex-responses": new Set([
    "accept",
    "content-type",
    "openai-beta",
    "originator",
    "session-id",
    "session_id",
    "x-client-request-id",
    "x-session-id",
    "x-session-affinity",
  ]),
  "anthropic-messages": new Set([
    "accept",
    "content-type",
    "anthropic-version",
    "anthropic-beta",
    "x-client-request-id",
  ]),
  "google-generative-ai": new Set([
    "accept",
    "content-type",
    "x-goog-api-client",
    "x-client-request-id",
  ]),
};

function hasRawDotSegment(rawPath: string): boolean {
  for (const segment of rawPath.split("/")) {
    if (segment === "." || segment === "..") return true;
  }
  return false;
}

function hasInvalidPercentEncoding(pathname: string): boolean {
  for (const segment of pathname.split("/")) {
    if (!segment.includes("%")) continue;
    try {
      const decoded = decodeURIComponent(segment);
      if (decoded.includes("\0")) return true;
    } catch {
      return true;
    }
  }
  return false;
}

function safeDecodePathSegment(segment: string): string | null {
  try {
    const decoded = decodeURIComponent(segment);
    if (!decoded || decoded.includes("/") || decoded.includes("\\") || decoded.includes("\0")) {
      return null;
    }
    if (decoded === "." || decoded === "..") return null;
    return decoded;
  } catch {
    return null;
  }
}

function hasPathTraversal(rawPath: string): boolean {
  if (rawPath.includes("\\") || rawPath.includes("\0")) return true;
  if (/%2f|%5c|%00/i.test(rawPath)) return true;
  const segments = rawPath.split("/");
  for (const seg of segments) {
    if (seg === ".." || seg === ".") return true;
    try {
      const dec = decodeURIComponent(seg);
      if (dec === ".." || dec === "." || dec.includes("/") || dec.includes("\\")) return true;
    } catch {
      return true;
    }
  }
  return false;
}

interface ParsedProtocolEndpoint {
  readonly canonicalSubpath: string;
  readonly googleModelId?: string;
  readonly googleAction?: "streamGenerateContent" | "generateContent";
}

/**
 * Strictly allowlist exact endpoint paths per protocol so authenticated local clients cannot
 * invoke arbitrary upstream endpoints (`/files`, `/models`, `/batches`, etc.) with real keys.
 */
function parseAllowedProtocolSubpath(
  apiKind: GatewayApiKind,
  subpath: string,
): ParsedProtocolEndpoint | null {
  if (hasPathTraversal(subpath)) return null;

  if (apiKind === "openai-completions") {
    if (subpath === "/chat/completions" || subpath === "/v1/chat/completions") {
      return { canonicalSubpath: subpath };
    }
    return null;
  }
  if (apiKind === "openai-responses") {
    if (subpath === "/responses" || subpath === "/v1/responses") {
      return { canonicalSubpath: subpath };
    }
    return null;
  }
  if (apiKind === "openai-codex-responses") {
    if (subpath === "/codex/responses") {
      return { canonicalSubpath: subpath };
    }
    return null;
  }
  if (apiKind === "anthropic-messages") {
    if (subpath === "/messages" || subpath === "/v1/messages") {
      return { canonicalSubpath: subpath };
    }
    return null;
  }
  if (apiKind === "google-generative-ai") {
    const match = GOOGLE_ENDPOINT_PATTERN.exec(subpath);
    if (!match) return null;
    const decodedModel = safeDecodePathSegment(match[1]!);
    if (!decodedModel || !/^[A-Za-z0-9._:@[\]-]+$/.test(decodedModel)) return null;
    const action = match[2]! as "streamGenerateContent" | "generateContent";
    return {
      canonicalSubpath: `/models/${encodeURIComponent(decodedModel)}:${action}`,
      googleModelId: decodedModel,
      googleAction: action,
    };
  }
  return null;
}

function resolveChannelUpstreamUrl(
  baseUrlStr: string,
  apiKind: GatewayApiKind,
  subpath: string,
  requestQuery: string,
): URL {
  const base =
    apiKind === "google-generative-ai"
      ? normalizeGoogleBaseUrl(baseUrlStr)
      : validateUpstreamBaseUrl(baseUrlStr);
  const basePath = base.pathname.replace(/\/+$/, "");
  const cleanSub = subpath.startsWith("/") ? subpath : `/${subpath}`;

  let finalPath: string;
  if (apiKind === "anthropic-messages") {
    if (basePath.endsWith("/messages")) {
      finalPath = basePath;
    } else if (basePath.endsWith("/v1") && cleanSub.startsWith("/v1/")) {
      finalPath = `${basePath}${cleanSub.slice(3)}`;
    } else {
      finalPath = `${basePath}${cleanSub}`;
    }
  } else if (apiKind === "openai-codex-responses") {
    if (basePath.endsWith("/codex/responses")) {
      finalPath = basePath;
    } else if (basePath.endsWith("/codex") && cleanSub.startsWith("/codex/")) {
      finalPath = `${basePath}${cleanSub.slice(6)}`;
    } else {
      finalPath = `${basePath}${cleanSub}`;
    }
  } else if (apiKind === "google-generative-ai") {
    const strippedSub = cleanSub.replace(/^\/v1(?:beta)?(?=\/)/i, "");
    finalPath = `${basePath}${strippedSub}`;
  } else {
    if (basePath.endsWith("/v1") && cleanSub.startsWith("/v1/")) {
      finalPath = `${basePath}${cleanSub.slice(3)}`;
    } else {
      finalPath = `${basePath}${cleanSub}`;
    }
  }

  const target = new URL(base.toString());
  target.pathname = finalPath;

  // Strictly allowlist client-supplied query parameters per protocol while preserving the
  // channel's own configured baseUrl query parameters. Never leak `?key=<gatewayToken>` or
  // arbitrary client-injected query parameters upstream.
  const merged = new URLSearchParams(base.search);
  const allowedClientParams = ALLOWED_QUERY_PARAMS_BY_PROTOCOL[apiKind];
  if (allowedClientParams.size > 0 && requestQuery) {
    const incoming = new URLSearchParams(requestQuery);
    for (const [k, v] of incoming.entries()) {
      if (allowedClientParams.has(k)) {
        merged.set(k, v);
      }
    }
  }
  const mergedStr = merged.toString();
  target.search = mergedStr ? `?${mergedStr}` : "";
  return target;
}

function timingSafeEquals(actual: string | undefined, expected: string): boolean {
  if (!actual) return false;
  const a = Buffer.from(actual, "utf8");
  const b = Buffer.from(expected, "utf8");
  if (a.length !== b.length) return false;
  return timingSafeEqual(a, b);
}

function extractGatewayTokenFromRequest(request: IncomingMessage, parsedUrl: URL): string | undefined {
  const explicit = request.headers[GATEWAY_TOKEN_HEADER];
  if (typeof explicit === "string" && explicit.length > 0) return explicit;
  const auth = request.headers.authorization;
  if (typeof auth === "string" && auth.startsWith("Bearer ")) {
    return auth.slice("Bearer ".length);
  }
  const xApiKey = request.headers["x-api-key"];
  if (typeof xApiKey === "string" && xApiKey.length > 0) return xApiKey;
  const googKey = request.headers["x-goog-api-key"];
  if (typeof googKey === "string" && googKey.length > 0) return googKey;
  const queryKey = parsedUrl.searchParams.get("key");
  if (queryKey && queryKey.length > 0) return queryKey;
  return undefined;
}

function collectConnectionNominatedHeaders(request: IncomingMessage): Set<string> {
  const nominated = new Set<string>();
  const raw = request.headers.connection;
  const values = Array.isArray(raw) ? raw : typeof raw === "string" ? [raw] : [];
  for (const entry of values) {
    for (const token of entry.split(",")) {
      const normalized = token.trim().toLowerCase();
      if (normalized) nominated.add(normalized);
    }
  }
  return nominated;
}

function buildSafePassthroughHeaders(
  request: IncomingMessage,
  apiKind: GatewayApiKind,
): Record<string, string> {
  const allowed = ALLOWED_PASSTHROUGH_HEADERS[apiKind];
  const connectionNominated = collectConnectionNominatedHeaders(request);
  const out: Record<string, string> = {};
  for (const [name, value] of Object.entries(request.headers)) {
    const lower = name.toLowerCase();
    if (!allowed.has(lower) || connectionNominated.has(lower)) continue;
    if (typeof value === "string") {
      out[lower] = value;
    } else if (Array.isArray(value)) {
      out[lower] = value.join(", ");
    }
  }
  return out;
}

function effectiveUpstreamModelId(model: GatewayModelConfig): string {
  return stripLegacyContextSuffix(model.upstreamModelId ?? model.id);
}

interface CompiledChannelOAuthBinding {
  readonly provider: OAuthSubscriptionProvider;
  readonly secretRef: string;
  readonly bindingId: string;
}

interface CompiledChannel {
  readonly config: GatewayChannelConfig;
  readonly enabledModels: ReadonlyMap<string, GatewayModelConfig>;
  readonly allModels: ReadonlyMap<string, GatewayModelConfig>;
  readonly oauthBinding?: CompiledChannelOAuthBinding;
}

interface DevFallbackRoute {
  readonly url: URL;
  readonly model: string;
  readonly upstreamKey: string | undefined;
}

interface GatewayRouteSnapshot {
  readonly revision: number;
  readonly channels: ReadonlyMap<string, CompiledChannel>;
  readonly devFallback: DevFallbackRoute | null;
}

function compileRouteSnapshot(
  revision: number,
  channels: readonly GatewayChannelConfig[],
  devFallback: DevFallbackRoute | null,
  bindingIdsByChannel: ReadonlyMap<string, string>,
): GatewayRouteSnapshot {
  const map = new Map<string, CompiledChannel>();
  for (const ch of channels) {
    const allModels = new Map<string, GatewayModelConfig>();
    const enabledModels = new Map<string, GatewayModelConfig>();
    for (const model of ch.models) {
      const cleanId = stripLegacyContextSuffix(model.id);
      const normalizedModel: GatewayModelConfig = { ...model, id: cleanId };
      const targetUpstreamId = effectiveUpstreamModelId(normalizedModel);
      allModels.set(cleanId, normalizedModel);
      if (
        ch.enabled &&
        normalizedModel.enabled &&
        isCopilotModelPermitted(targetUpstreamId, ch.availableModelIds)
      ) {
        enabledModels.set(cleanId, normalizedModel);
      }
    }
    const bindingId = ch.oauth ? bindingIdsByChannel.get(ch.id) : undefined;
    const oauthBinding: CompiledChannelOAuthBinding | undefined =
      ch.oauth && bindingId !== undefined
        ? {
            provider: ch.oauth.provider,
            secretRef: ch.oauth.secretRef,
            bindingId,
          }
        : undefined;
    map.set(ch.id, {
      config: ch,
      enabledModels,
      allModels,
      ...(oauthBinding !== undefined ? { oauthBinding } : {}),
    });
  }
  return Object.freeze({ revision, channels: map, devFallback });
}

/**
 * Determine the next available fallback model slug `<channelId>/<modelId>`:
 * 1. `xiaotong-work-team/deepseek-flash` if enabled;
 * 2. First enabled model on `xiaotong-work-team`;
 * 3. First enabled model on any enabled channel (respecting Copilot `availableModelIds` against
 *    the resolved effective upstream model ID);
 * 4. `xtwork/standard` if dev fallback is active;
 * 5. `null` (zero-channel onboarding state).
 */
export function resolveFallbackModel(
  channels: readonly GatewayChannelConfig[],
  devFallbackActive: boolean,
): string | null {
  const enabledChannels = channels.filter((c) => c.enabled);
  const company = enabledChannels.find((c) => c.id === COMPANY_CHANNEL_ID);
  if (company) {
    const preferred = company.models.find(
      (m) => m.enabled && stripLegacyContextSuffix(m.id) === COMPANY_DEFAULT_MODEL_ID,
    );
    if (preferred) {
      return formatModelSlug(company.id, stripLegacyContextSuffix(preferred.id));
    }
    const firstCompany = company.models.find((m) => m.enabled);
    if (firstCompany) {
      return formatModelSlug(company.id, stripLegacyContextSuffix(firstCompany.id));
    }
  }
  for (const ch of enabledChannels) {
    for (const model of ch.models) {
      const cleanId = stripLegacyContextSuffix(model.id);
      const targetUpstreamId = effectiveUpstreamModelId({ ...model, id: cleanId });
      if (
        model.enabled &&
        isCopilotModelPermitted(targetUpstreamId, ch.availableModelIds)
      ) {
        return formatModelSlug(ch.id, cleanId);
      }
    }
  }
  if (devFallbackActive) {
    return formatModelSlug(MODEL_PROVIDER, STANDARD_MODEL);
  }
  return null;
}

/**
 * Build Pi 1.5.2 `models.json` content strictly with Proxy-Only gateway URLs and non-secret
 * auth tokens (`$XTWORK_MODEL_GATEWAY_TOKEN` + non-secret Codex placeholder JWT).
 * Real API keys and real OAuth tokens NEVER appear in the output.
 */
export function buildPiModelsJson(
  port: number,
  channels: readonly GatewayChannelConfig[],
  devFallbackActive: boolean,
): { readonly providers: Record<string, unknown> } {
  const providers: Record<string, unknown> = {};
  const enabledChannels = channels.filter((c) => c.enabled);

  for (const ch of enabledChannels) {
    const activeModels = ch.models
      .map((m) => ({ ...m, id: stripLegacyContextSuffix(m.id) }))
      .filter((m) => {
        const targetUpstreamId = effectiveUpstreamModelId(m);
        return m.enabled && isCopilotModelPermitted(targetUpstreamId, ch.availableModelIds);
      });
    if (activeModels.length === 0) continue;

    const isCodex = ch.api === "openai-codex-responses" || ch.providerType === "openai-codex";
    const providerBaseUrl = `http://127.0.0.1:${port}/c/${encodeURIComponent(ch.id)}/${ch.api}`;

    const entry: Record<string, unknown> = {
      name: ch.name ?? ch.id,
      api: ch.api,
      baseUrl: providerBaseUrl,
      apiKey: isCodex ? createCodexPlaceholderJwt() : `$${GATEWAY_TOKEN_ENV}`,
      ...(isCodex
        ? { headers: { [GATEWAY_TOKEN_HEADER]: `$${GATEWAY_TOKEN_ENV}` } }
        : {}),
      models: activeModels.map((m) => {
        const modelApi = m.api ?? ch.api;
        const modelBaseUrl =
          modelApi !== ch.api
            ? `http://127.0.0.1:${port}/c/${encodeURIComponent(ch.id)}/${modelApi}`
            : undefined;
        return {
          id: m.id,
          name: m.name ?? m.id,
          ...(modelApi !== ch.api ? { api: modelApi } : {}),
          ...(modelBaseUrl ? { baseUrl: modelBaseUrl } : {}),
          reasoning: m.reasoning ?? false,
          contextWindow: m.contextWindow ?? 131072,
          maxTokens: m.maxTokens ?? 16384,
          input: m.input ? [...m.input] : ["text"],
          ...(m.compat ? { compat: m.compat } : {}),
          ...(m.thinkingLevelMap ? { thinkingLevelMap: m.thinkingLevelMap } : {}),
        };
      }),
    };
    providers[ch.id] = entry;
  }

  if (Object.keys(providers).length === 0 && devFallbackActive) {
    providers[MODEL_PROVIDER] = {
      api: "openai-completions",
      apiKey: `$${GATEWAY_TOKEN_ENV}`,
      baseUrl: `http://127.0.0.1:${port}/v1`,
      models: [
        {
          id: STANDARD_MODEL,
          name: "标准",
          contextWindow: 131072,
          maxTokens: 8192,
          input: ["text"],
        },
      ],
    };
  }

  return { providers };
}

function rejectRequest(
  response: ServerResponse,
  status: number,
  message: string,
  code = "gateway_error",
) {
  if (response.destroyed || response.writableEnded) return;
  response.writeHead(status, { "content-type": "application/json" });
  response.end(JSON.stringify({ error: { message, type: "xtwork_gateway_error", code } }));
}

async function readRequestBody(
  request: IncomingMessage,
  response: ServerResponse,
): Promise<Buffer | null> {
  const chunks: Buffer[] = [];
  let size = 0;
  try {
    for await (const chunk of request.iterator({ destroyOnReturn: false })) {
      const buf = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk);
      size += buf.byteLength;
      if (size > REQUEST_LIMIT) {
        response.setHeader("connection", "close");
        rejectRequest(response, 413, "Model request is too large.", "payload_too_large");
        return null;
      }
      chunks.push(buf);
    }
    return Buffer.concat(chunks, size);
  } catch {
    if (!response.destroyed) {
      rejectRequest(response, 400, "Could not read the model request.", "invalid_request");
    }
    return null;
  }
}

type ZstdDecodeResult =
  | { readonly ok: true; readonly data: Buffer }
  | { readonly ok: false; readonly reason: "too_large" | "invalid" };

/**
 * Stream-decompress zstd payloads with a strict decoded-byte cap (`maxBytes`) so a tiny
 * compressed zstd bomb cannot exhaust memory or block the event loop.
 */
function decompressZstdWithLimit(compressed: Buffer, maxBytes: number): Promise<ZstdDecodeResult> {
  return new Promise((resolveDecode) => {
    const decompressor = createZstdDecompress({ chunkSize: 16 * 1024 });
    const chunks: Buffer[] = [];
    let decodedSize = 0;
    let settled = false;

    const finish = (result: ZstdDecodeResult) => {
      if (settled) return;
      settled = true;
      resolveDecode(result);
    };

    decompressor.on("data", (chunk: Buffer) => {
      if (settled) return;
      decodedSize += chunk.byteLength;
      if (decodedSize > maxBytes) {
        finish({ ok: false, reason: "too_large" });
        decompressor.destroy();
        return;
      }
      chunks.push(chunk);
    });

    decompressor.on("error", () => {
      finish({ ok: false, reason: "invalid" });
    });

    decompressor.on("end", () => {
      finish({ ok: true, data: Buffer.concat(chunks, decodedSize) });
    });

    // Feed compressed input in small slices via setImmediate so decompression yields and
    // stops promptly once the decoded cap is crossed.
    const SLICE = 16 * 1024;
    let offset = 0;
    const pump = () => {
      if (settled || decompressor.destroyed) return;
      if (offset >= compressed.byteLength) {
        decompressor.end();
        return;
      }
      const nextEnd = Math.min(offset + SLICE, compressed.byteLength);
      const slice = compressed.subarray(offset, nextEnd);
      offset = nextEnd;
      const canContinue = decompressor.write(slice);
      if (settled || decompressor.destroyed) return;
      if (canContinue) {
        setImmediate(pump);
      } else {
        decompressor.once("drain", () => setImmediate(pump));
      }
    };
    setImmediate(pump);
  });
}

function normalizeRedactionList(candidates: readonly (string | undefined)[]): readonly string[] {
  const unique = new Set<string>();
  const add = (value: string | undefined) => {
    if (!value) return;
    const trimmed = value.trim();
    if (trimmed.length >= 4) {
      unique.add(trimmed);
    }
    if (/^bearer\s+/i.test(trimmed)) {
      const inner = trimmed.replace(/^bearer\s+/i, "").trim();
      if (inner.length >= 4) unique.add(inner);
    }
  };
  for (const c of candidates) add(c);
  // Longest secrets first so prefixes never leave partial secret tails behind.
  return [...unique].sort((a, b) => b.length - a.length);
}

function redactString(text: string, secrets: readonly string[]): string {
  let out = text;
  for (const secret of secrets) {
    if (out.includes(secret)) {
      out = out.replaceAll(secret, REDACTED_MARKER);
    }
  }
  return out;
}

const REDACTED_BUFFER = Buffer.from(REDACTED_MARKER, "utf8");

function redactBuffer(input: Buffer, secretBuffers: readonly Buffer[]): Buffer {
  let buf = input;
  for (const secret of secretBuffers) {
    let idx = buf.indexOf(secret);
    if (idx === -1) continue;
    const parts: Buffer[] = [];
    let cursor = 0;
    while (idx !== -1) {
      if (idx > cursor) parts.push(buf.subarray(cursor, idx));
      parts.push(REDACTED_BUFFER);
      cursor = idx + secret.byteLength;
      idx = buf.indexOf(secret, cursor);
    }
    if (cursor < buf.byteLength) parts.push(buf.subarray(cursor));
    buf = Buffer.concat(parts);
  }
  return buf;
}

/**
 * Compute the longest trailing byte suffix of `buf` that is a proper prefix of any UTF-8 secret
 * byte sequence in `secretBuffers`. Binary-safe so ALL forwarded responses (SSE, JSON, or
 * `application/octet-stream`) redact secrets across arbitrary chunk boundaries with ZERO latency
 * on normal SSE frames.
 */
function longestSecretPrefixSuffixBytes(buf: Buffer, secretBuffers: readonly Buffer[]): number {
  let maxHold = 0;
  for (const secret of secretBuffers) {
    const limit = Math.min(buf.byteLength, secret.byteLength - 1);
    if (limit <= maxHold) continue;
    const firstByte = secret[0]!;
    let idx = buf.indexOf(firstByte, buf.byteLength - limit);
    while (idx !== -1) {
      const suffixLen = buf.byteLength - idx;
      if (suffixLen <= maxHold) break;
      let match = true;
      for (let i = 1; i < suffixLen; i++) {
        if (buf[idx + i] !== secret[i]) {
          match = false;
          break;
        }
      }
      if (match) {
        maxHold = suffixLen;
        break;
      }
      idx = buf.indexOf(firstByte, idx + 1);
    }
  }
  return maxHold;
}

const ALLOWED_RESPONSE_HEADERS = [
  "content-type",
  "cache-control",
  "retry-after",
  "retry-after-ms",
  "x-request-id",
  "anthropic-request-id",
] as const;

async function streamUpstreamResponse(
  upstream: Response,
  response: ServerResponse,
  abort: AbortController,
  redactionSecrets: readonly string[],
): Promise<void> {
  const headers: Record<string, string> = {};
  for (const name of ALLOWED_RESPONSE_HEADERS) {
    const value = upstream.headers.get(name);
    if (value !== null) {
      headers[name] = redactionSecrets.length > 0 ? redactString(value, redactionSecrets) : value;
    }
  }
  response.writeHead(upstream.status, headers);
  response.flushHeaders();

  if (upstream.body === null) {
    response.end();
    return;
  }

  // Redact ALL forwarded response bodies regardless of content-type (binary-safe Buffer scanning).
  const secretBuffers = redactionSecrets.map((s) => Buffer.from(s, "utf8"));
  let carry = Buffer.alloc(0);

  const writeChunk = async (chunk: Uint8Array) => {
    if (response.destroyed) return;
    const ok = response.write(chunk);
    if (!ok && !response.destroyed) {
      await once(response, "drain");
    }
  };

  const reader = upstream.body.getReader();
  const onAbort = () => {
    void reader.cancel().catch(() => undefined);
  };
  abort.signal.addEventListener("abort", onAbort, { once: true });
  try {
    while (true) {
      if (abort.signal.aborted || response.destroyed) break;
      const { done, value } = await reader.read();
      if (done) break;
      if (!value || value.byteLength === 0) continue;

      if (secretBuffers.length === 0) {
        await writeChunk(value);
        continue;
      }

      const chunkBuf = Buffer.from(value.buffer, value.byteOffset, value.byteLength);
      const merged = carry.byteLength > 0 ? Buffer.concat([carry, chunkBuf]) : chunkBuf;
      const redacted = redactBuffer(merged, secretBuffers);
      const holdLen = longestSecretPrefixSuffixBytes(redacted, secretBuffers);
      const emitEnd = redacted.byteLength - holdLen;
      carry = holdLen > 0 ? Buffer.from(redacted.subarray(emitEnd)) : Buffer.alloc(0);
      if (emitEnd > 0) {
        await writeChunk(redacted.subarray(0, emitEnd));
      }
    }

    if (secretBuffers.length > 0 && carry.byteLength > 0 && !abort.signal.aborted && !response.destroyed) {
      const tail = redactBuffer(carry, secretBuffers);
      carry = Buffer.alloc(0);
      if (tail.byteLength > 0) {
        await writeChunk(tail);
      }
    }

    if (!response.destroyed && !response.writableEnded) {
      response.end();
    }
  } finally {
    abort.signal.removeEventListener("abort", onAbort);
    reader.releaseLock();
  }
}

const VALID_API_KINDS = new Set<GatewayApiKind>([
  "openai-completions",
  "openai-responses",
  "openai-codex-responses",
  "anthropic-messages",
  "google-generative-ai",
]);

interface GatewayRuntimeContext {
  readonly token: string;
  readonly getSnapshot: () => GatewayRouteSnapshot;
  readonly secretStore: SecretStore;
  readonly oauthManager: OAuthTokenManager;
  readonly fetchImpl: typeof fetch;
  readonly validateOAuthDestination: OAuthDestinationValidator;
}

async function resolveChannelApiKey(
  channel: GatewayChannelConfig,
  secretStore: SecretStore,
): Promise<string | undefined> {
  if (channel.apiKey !== undefined) return channel.apiKey;
  if (channel.secretRef) {
    return await secretStore.get(channel.secretRef);
  }
  return undefined;
}

async function handleLegacyDevFallback(
  request: IncomingMessage,
  response: ServerResponse,
  fallback: DevFallbackRoute,
  abort: AbortController,
  fetchImpl: typeof fetch,
  gatewayToken: string,
): Promise<void> {
  const raw = await readRequestBody(request, response);
  if (raw === null) return;
  let body: unknown;
  try {
    body = JSON.parse(raw.toString("utf8"));
  } catch {
    rejectRequest(response, 400, "Expected a JSON model request.", "invalid_json");
    return;
  }
  if (
    body === null ||
    typeof body !== "object" ||
    !("model" in body) ||
    (body as { model?: unknown }).model !== STANDARD_MODEL
  ) {
    rejectRequest(
      response,
      403,
      "The Xtwork dev fallback route only accepts the standard model.",
      "model_disabled",
    );
    return;
  }

  const redactionSecrets = normalizeRedactionList([gatewayToken, fallback.upstreamKey]);
  try {
    const upstream = await fetchImpl(fallback.url, {
      method: "POST",
      headers: {
        "content-type": "application/json",
        ...(fallback.upstreamKey ? { authorization: `Bearer ${fallback.upstreamKey}` } : {}),
      },
      body: JSON.stringify({ ...body, model: fallback.model }),
      redirect: "error",
      signal: abort.signal,
    });
    await streamUpstreamResponse(upstream, response, abort, redactionSecrets);
  } catch {
    if (abort.signal.aborted) return;
    if (response.headersSent) response.destroy();
    else {
      rejectRequest(
        response,
        502,
        "Could not reach the model service. Start Magpie or check XTWORK_MODEL_UPSTREAM_URL.",
        "upstream_unreachable",
      );
    }
  }
}

async function handleGatewayRequest(
  request: IncomingMessage,
  response: ServerResponse,
  ctx: GatewayRuntimeContext,
): Promise<void> {
  // Capture immutable route snapshot at request start so mid-stream channel mutations cannot affect this request.
  const snapshot = ctx.getSnapshot();
  // Validate raw request target BEFORE `new URL(...)` normalizes away dot segments or malformed `%` escapes.
  const rawTarget = request.url ?? "/";
  if (
    !rawTarget.startsWith("/") ||
    rawTarget.startsWith("//") ||
    rawTarget.includes("\\") ||
    rawTarget.includes("\0")
  ) {
    rejectRequest(response, 400, "Malformed model request URL.", "invalid_request");
    return;
  }
  const queryOrHashIdx = rawTarget.search(/[?#]/);
  const rawPath = queryOrHashIdx >= 0 ? rawTarget.slice(0, queryOrHashIdx) : rawTarget;
  if (hasInvalidPercentEncoding(rawPath) || hasRawDotSegment(rawPath)) {
    rejectRequest(response, 400, "Malformed path encoding or dot segment in request URL.", "invalid_request");
    return;
  }

  let parsedUrl: URL;
  try {
    parsedUrl = new URL(rawTarget, "http://127.0.0.1");
  } catch {
    rejectRequest(response, 400, "Malformed model request URL.", "invalid_request");
    return;
  }

  const providedToken = extractGatewayTokenFromRequest(request, parsedUrl);
  if (!timingSafeEquals(providedToken, ctx.token)) {
    rejectRequest(response, 401, "Invalid Xtwork model gateway token.", "unauthorized");
    return;
  }

  if (request.method !== "POST") {
    rejectRequest(response, 405, "Method not allowed.", "method_not_allowed");
    return;
  }

  if (hasInvalidPercentEncoding(parsedUrl.pathname)) {
    rejectRequest(response, 400, "Malformed percent-encoding in request path.", "invalid_request");
    return;
  }

  const abort = new AbortController();
  const cancelUpstream = () => {
    if (!abort.signal.aborted) abort.abort();
  };
  request.once("aborted", cancelUpstream);
  response.once("close", () => {
    if (!response.writableEnded) cancelUpstream();
  });

  // Legacy dev/E2E fallback route (/v1/chat/completions)
  if (parsedUrl.pathname === "/v1/chat/completions") {
    if (!snapshot.devFallback) {
      rejectRequest(
        response,
        403,
        "The Xtwork dev fallback route is disabled.",
        "channel_disabled",
      );
      return;
    }
    await handleLegacyDevFallback(
      request,
      response,
      snapshot.devFallback,
      abort,
      ctx.fetchImpl,
      ctx.token,
    );
    return;
  }

  // Multi-protocol route: /c/<channelId>/<apiKind>/<subpath...>
  const routeMatch = /^\/c\/([^/]+)\/([^/]+)(\/.*)?$/.exec(parsedUrl.pathname);
  if (!routeMatch) {
    rejectRequest(response, 404, "Unknown model endpoint.", "not_found");
    return;
  }
  const channelId = safeDecodePathSegment(routeMatch[1]!);
  if (channelId === null) {
    rejectRequest(response, 400, "Invalid channel identifier in request path.", "invalid_request");
    return;
  }
  const rawApiKind = routeMatch[2]!;
  const rawSubpath = routeMatch[3] ?? "/";

  if (!VALID_API_KINDS.has(rawApiKind as GatewayApiKind)) {
    rejectRequest(response, 404, `Unsupported protocol route "${rawApiKind}".`, "not_found");
    return;
  }
  const apiKind = rawApiKind as GatewayApiKind;

  const allowedEndpoint = parseAllowedProtocolSubpath(apiKind, rawSubpath);
  if (allowedEndpoint === null) {
    rejectRequest(
      response,
      404,
      `Endpoint path is not allowed for protocol "${apiKind}".`,
      "endpoint_not_allowed",
    );
    return;
  }

  const compiled = snapshot.channels.get(channelId);
  if (!compiled) {
    rejectRequest(response, 404, `Unknown model channel "${channelId}".`, "channel_not_found");
    return;
  }
  if (!compiled.config.enabled) {
    rejectRequest(response, 403, `Model channel "${channelId}" is disabled.`, "channel_disabled");
    return;
  }

  const rawBody = await readRequestBody(request, response);
  if (rawBody === null) return;

  // Stream-decompress zstd request bodies with a strict 16 MiB decoded-byte cap (prevents zstd bombs).
  const encoding = String(request.headers["content-encoding"] ?? "").trim().toLowerCase();
  let decodedBodyBuf = rawBody;
  if (encoding === "zstd" && rawBody.byteLength > 0) {
    const decoded = await decompressZstdWithLimit(rawBody, REQUEST_LIMIT);
    if (!decoded.ok) {
      if (decoded.reason === "too_large") {
        response.setHeader("connection", "close");
        rejectRequest(
          response,
          413,
          "Decompressed model request exceeds maximum allowed size.",
          "payload_too_large",
        );
      } else {
        rejectRequest(response, 400, "Could not decompress zstd request body.", "invalid_request");
      }
      return;
    }
    decodedBodyBuf = decoded.data;
  } else if (encoding.length > 0 && encoding !== "identity") {
    rejectRequest(response, 415, "Unsupported request Content-Encoding.", "unsupported_encoding");
    return;
  }

  let parsedBody: Record<string, unknown> | undefined;
  if (decodedBodyBuf.byteLength > 0) {
    try {
      const json = JSON.parse(decodedBodyBuf.toString("utf8")) as unknown;
      if (json && typeof json === "object" && !Array.isArray(json)) {
        parsedBody = json as Record<string, unknown>;
      } else {
        rejectRequest(response, 400, "Expected a JSON object model request.", "invalid_json");
        return;
      }
    } catch {
      rejectRequest(response, 400, "Expected a JSON model request.", "invalid_json");
      return;
    }
  }

  // Extract requested model ID and enforce enabled-model + Copilot policy against ACTUAL upstream model ID.
  const rawRequestedModel =
    apiKind === "google-generative-ai"
      ? allowedEndpoint.googleModelId
      : typeof parsedBody?.model === "string"
        ? parsedBody.model
        : undefined;
  if (!rawRequestedModel) {
    rejectRequest(response, 400, "Model request is missing a model identifier.", "invalid_model");
    return;
  }
  const requestedModelId = stripLegacyContextSuffix(rawRequestedModel);

  const modelEntry = compiled.enabledModels.get(requestedModelId);
  if (!modelEntry) {
    const known = compiled.allModels.get(requestedModelId);
    if (known) {
      const knownUpstreamId = effectiveUpstreamModelId(known);
      if (!isCopilotModelPermitted(knownUpstreamId, compiled.config.availableModelIds)) {
        rejectRequest(
          response,
          403,
          `Model "${requestedModelId}" is not permitted by GitHub Copilot subscription policy.`,
          "model_not_permitted",
        );
        return;
      }
    }
    rejectRequest(
      response,
      403,
      `Model "${channelId}/${requestedModelId}" is disabled or not enabled on this channel.`,
      "model_disabled",
    );
    return;
  }

  const upstreamModelId = effectiveUpstreamModelId(modelEntry);
  if (!isCopilotModelPermitted(upstreamModelId, compiled.config.availableModelIds)) {
    rejectRequest(
      response,
      403,
      `Model "${requestedModelId}" is not permitted by GitHub Copilot subscription policy.`,
      "model_not_permitted",
    );
    return;
  }

  const expectedApi = modelEntry.api ?? compiled.config.api;
  if (expectedApi !== apiKind) {
    rejectRequest(
      response,
      400,
      `Model "${channelId}/${requestedModelId}" uses protocol "${expectedApi}", not "${apiKind}".`,
      "protocol_mismatch",
    );
    return;
  }

  // Strictly allowlist protocol-safe pass-through headers (dropping cookies, proxy auth,
  // connection-nominated headers, dummy local auth headers, and gateway tokens).
  const upstreamHeaders = buildSafePassthroughHeaders(request, apiKind);
  const injectedSecretCandidates: Array<string | undefined> = [ctx.token];

  if (compiled.config.upstreamHeaders) {
    for (const [k, v] of Object.entries(compiled.config.upstreamHeaders)) {
      const lower = k.toLowerCase();
      upstreamHeaders[lower] = v;
      if (
        lower === "authorization" ||
        lower === "x-api-key" ||
        lower === "api-key" ||
        lower === "x-goog-api-key" ||
        lower === "cookie" ||
        lower.includes("token") ||
        lower.includes("secret") ||
        lower.includes("key")
      ) {
        injectedSecretCandidates.push(v);
      }
    }
  }

  // Resolve real upstream credentials and target base URL strictly on the server side.
  let effectiveBaseUrl = compiled.config.baseUrl;
  let oauthEnterpriseUrl: string | undefined;
  try {
    if (compiled.config.oauth) {
      const oauthProvider = compiled.config.oauth.provider;
      const binding = compiled.oauthBinding;
      const creds = await ctx.oauthManager.getValidCredentials(channelId, {
        signal: abort.signal,
        expectedProvider: binding?.provider ?? oauthProvider,
        expectedSecretRef: binding?.secretRef ?? compiled.config.oauth.secretRef,
        ...(binding !== undefined ? { expectedBindingId: binding.bindingId } : {}),
      });
      injectedSecretCandidates.push(creds.access, creds.refresh);

      if (oauthProvider === "openai-codex") {
        const codexCreds = creds as CodexOAuthCredentials;
        const accountId = codexCreds.accountId ?? extractCodexAccountId(codexCreds.access);
        if (!accountId) {
          throw new Error("Missing Codex account identifier.");
        }
        injectedSecretCandidates.push(accountId);
        upstreamHeaders["authorization"] = `Bearer ${codexCreds.access}`;
        upstreamHeaders["chatgpt-account-id"] = accountId;
        effectiveBaseUrl ??= CODEX_DEFAULT_UPSTREAM_BASE_URL;
      } else if (oauthProvider === "github-copilot") {
        const copilotCreds = creds as GithubCopilotOAuthCredentials;
        oauthEnterpriseUrl = copilotCreds.enterpriseUrl;
        if (!isCopilotModelPermitted(upstreamModelId, copilotCreds.availableModelIds)) {
          rejectRequest(
            response,
            403,
            `Model "${requestedModelId}" is not permitted by GitHub Copilot subscription policy.`,
            "model_not_permitted",
          );
          return;
        }
        upstreamHeaders["authorization"] = `Bearer ${copilotCreds.access}`;
        const copilotHeaders = buildCopilotUpstreamHeaders(parsedBody);
        for (const [k, v] of Object.entries(copilotHeaders)) {
          upstreamHeaders[k.toLowerCase()] = v;
        }
        effectiveBaseUrl ??= deriveGitHubCopilotBaseUrl(
          copilotCreds.access,
          copilotCreds.enterpriseUrl,
          ctx.validateOAuthDestination,
        );
      } else if (oauthProvider === "xai") {
        const xaiCreds = creds as XaiOAuthCredentials;
        upstreamHeaders["authorization"] = `Bearer ${xaiCreds.access}`;
        effectiveBaseUrl ??= XAI_DEFAULT_UPSTREAM_BASE_URL;
      }
    } else {
      const rawKey = await resolveChannelApiKey(compiled.config, ctx.secretStore);
      const token =
        rawKey !== undefined && compiled.config.providerType === "zhipu-coding-team"
          ? extractZhipuCodingTeamApiToken(rawKey)
          : rawKey;
      injectedSecretCandidates.push(rawKey, token);

      if (apiKind === "anthropic-messages") {
        if (requiresCodingPlanUserAgent(compiled.config.providerType)) {
          upstreamHeaders["user-agent"] = compiled.config.userAgent ?? CODING_PLAN_USER_AGENT;
        }
        if (token) {
          if (compiled.config.providerType === "xiaomi") {
            upstreamHeaders["api-key"] = token;
          } else if (usesBearerOnlyAnthropicAuth(compiled.config.providerType)) {
            upstreamHeaders["authorization"] = `Bearer ${token}`;
          } else {
            upstreamHeaders["x-api-key"] = token;
          }
        }
      } else if (apiKind === "google-generative-ai") {
        if (token) {
          upstreamHeaders["x-goog-api-key"] = token;
        }
      } else {
        if (token) {
          upstreamHeaders["authorization"] = `Bearer ${token}`;
        }
      }
    }
  } catch {
    if (abort.signal.aborted) return;
    // NEVER leak raw OAuth refresh responses or OS SecretStore internal errors to Pi.
    rejectRequest(
      response,
      502,
      `Authentication failed for model channel "${channelId}". Please check or re-authenticate credentials in Settings.`,
      "credential_error",
    );
    return;
  }

  if (!effectiveBaseUrl) {
    rejectRequest(
      response,
      500,
      `Channel "${channelId}" has no configured upstream base URL.`,
      "misconfigured_channel",
    );
    return;
  }

  // Apply protocol-specific request body & path rewrites (upstream model ID, [1m] stripping, DeepSeek V4 Anthropic).
  const targetSubpath =
    apiKind === "google-generative-ai" && allowedEndpoint.googleAction
      ? `/models/${encodeURIComponent(upstreamModelId)}:${allowedEndpoint.googleAction}`
      : allowedEndpoint.canonicalSubpath;

  let forwardBody: string | undefined;
  if (parsedBody !== undefined) {
    let nextBody: Record<string, unknown> = { ...parsedBody };
    if (apiKind !== "google-generative-ai") {
      nextBody.model = upstreamModelId;
    }
    if (apiKind === "anthropic-messages") {
      nextBody = rewriteDeepSeekV4AnthropicBody(
        nextBody,
        compiled.config.providerType,
        upstreamModelId,
      );
    }
    forwardBody = JSON.stringify(nextBody);
    upstreamHeaders["content-type"] = "application/json";
  }

  let upstreamUrl: URL;
  try {
    upstreamUrl = resolveChannelUpstreamUrl(
      effectiveBaseUrl,
      apiKind,
      targetSubpath,
      parsedUrl.search,
    );
    if (compiled.config.oauth) {
      ctx.validateOAuthDestination(
        compiled.config.oauth.provider,
        upstreamUrl,
        "inference",
        oauthEnterpriseUrl ? { enterpriseUrl: oauthEnterpriseUrl } : undefined,
      );
    }
  } catch {
    rejectRequest(
      response,
      compiled.config.oauth ? 403 : 500,
      compiled.config.oauth
        ? `Upstream destination for OAuth channel "${channelId}" is not permitted.`
        : `Channel "${channelId}" has an invalid upstream URL configuration.`,
      compiled.config.oauth ? "invalid_oauth_destination" : "misconfigured_channel",
    );
    return;
  }

  const redactionSecrets = normalizeRedactionList(injectedSecretCandidates);

  try {
    const upstream = await ctx.fetchImpl(upstreamUrl, {
      method: "POST",
      headers: upstreamHeaders,
      ...(forwardBody !== undefined ? { body: forwardBody } : {}),
      redirect: "error",
      signal: abort.signal,
    });
    await streamUpstreamResponse(upstream, response, abort, redactionSecrets);
  } catch {
    if (abort.signal.aborted) return;
    if (response.headersSent) response.destroy();
    else {
      rejectRequest(
        response,
        502,
        `Could not reach upstream model service for channel "${channelId}".`,
        "upstream_unreachable",
      );
    }
  }
}

export interface StartBundledPiOptions {
  readonly channels?: readonly GatewayChannelConfig[];
  /** Defaults to the real OS SecretStore (`app.xtwork.model-channels`). Inject `memorySecrets()` in tests. */
  readonly secretStore?: SecretStore;
  readonly fence?: ChannelCredentialFence;
  readonly fetchImpl?: typeof fetch;
  /**
   * Override OAuth destination validation (strict HTTPS provider allowlist by default).
   * Intended strictly for automated tests routing to loopback stubs.
   */
  readonly validateOAuthDestination?: OAuthDestinationValidator;
  /** Explicitly force dev fallback on or off (defaults to env-based detection). */
  readonly devFallback?: boolean;
  /** Skip executable permission checks on `binaryPath` / `pi-shell` (for unit tests). */
  readonly skipBinaryAccessCheck?: boolean;
  /** Optional lifecycle hook invoked right before atomically committing a Pi config file (for tests). */
  readonly onBeforeCommitFile?: (file: "settings.json" | "models.json") => void | Promise<void>;
}

function shouldEnableDevFallback(
  env: NodeJS.ProcessEnv,
  explicit: boolean | undefined,
): boolean {
  if (explicit !== undefined) return explicit;
  return Boolean(
    env.XTWORK_MODEL_UPSTREAM_URL ||
      env.XTWORK_MODEL_UPSTREAM_MODEL ||
      env.XTWORK_MODEL_UPSTREAM_KEY_FILE ||
      env.XTWORK_DEV_FALLBACK === "1",
  );
}

export async function startBundledPi(
  binaryPath: string,
  dataDir: string,
  env: NodeJS.ProcessEnv = process.env,
  options: StartBundledPiOptions = {},
) {
  const launcher = resolve(binaryPath);
  const shellPath = join(dirname(launcher), "pi-shell");
  if (!options.skipBinaryAccessCheck) {
    await Promise.all([access(launcher, constants.X_OK), access(shellPath, constants.X_OK)]);
  }

  const agentDir = join(dataDir, "runtime", "pi");
  const devFallbackActive = shouldEnableDevFallback(env, options.devFallback);

  let devFallbackRoute: DevFallbackRoute | null = null;
  if (devFallbackActive) {
    const upstreamBase = validateUpstreamBaseUrl(env.XTWORK_MODEL_UPSTREAM_URL || MAGPIE_URL);
    if (upstreamBase.search) {
      throw new Error(
        "XTWORK_MODEL_UPSTREAM_URL must be an HTTP(S) base URL without credentials, query or fragment.",
      );
    }
    upstreamBase.pathname = `${upstreamBase.pathname.replace(/\/$/, "")}/chat/completions`;
    devFallbackRoute = {
      url: upstreamBase,
      model: env.XTWORK_MODEL_UPSTREAM_MODEL || MAGPIE_MODEL,
      upstreamKey: env.XTWORK_MODEL_UPSTREAM_KEY_FILE
        ? (await readFile(env.XTWORK_MODEL_UPSTREAM_KEY_FILE, "utf8")).trim()
        : undefined,
    };
  }

  const gatewayToken = randomBytes(32).toString("hex");
  const secretStore =
    options.secretStore ??
    createSecretStore({
      namespace: MODEL_CHANNELS_SECRET_NAMESPACE,
      windowsDpapiPath: join(dataDir, "channels", "dpapi-secrets.json"),
    });
  const fence = options.fence ?? new ChannelCredentialFence();
  const oauthManager = new OAuthTokenManager({ secretStore, fence });
  const fetchImpl = options.fetchImpl ?? globalThis.fetch;
  const validateOAuthDestination = options.validateOAuthDestination ?? assertStrictOAuthDestination;

  const extractOAuthConfigs = (
    channels: readonly GatewayChannelConfig[],
  ): RegisteredOAuthChannel[] => {
    const out: RegisteredOAuthChannel[] = [];
    for (const ch of channels) {
      if (ch.oauth) {
        out.push({
          channelId: ch.id,
          provider: ch.oauth.provider,
          secretRef: ch.oauth.secretRef,
          ...(ch.oauth.initialCredentials !== undefined
            ? { initialCredentials: ch.oauth.initialCredentials }
            : {}),
          refresh: ch.oauth.refresh,
        });
      }
    }
    return out;
  };

  let currentChannels: readonly GatewayChannelConfig[] = options.channels ? [...options.channels] : [];
  const initialTx = oauthManager.stageUpdate(extractOAuthConfigs(currentChannels));
  oauthManager.commitUpdate(initialTx);
  let snapshot = compileRouteSnapshot(
    1,
    currentChannels,
    devFallbackRoute,
    initialTx.bindingIdsByChannel,
  );

  const server = createServer((request, response) => {
    void handleGatewayRequest(request, response, {
      token: gatewayToken,
      getSnapshot: () => snapshot,
      secretStore,
      oauthManager,
      fetchImpl,
      validateOAuthDestination,
    }).catch(() => {
      if (response.destroyed || response.writableEnded) return;
      if (response.headersSent) {
        response.destroy();
        return;
      }
      rejectRequest(response, 500, "Internal model gateway error.", "internal_error");
    });
  });

  const closeGateway = () =>
    new Promise<void>((resolveClose) => {
      server.close(() => resolveClose());
      server.closeAllConnections();
    });

  let port = 0;

  const buildPiSettingsJson = (defaultSlug: string | null) => {
    const parsedDefault = defaultSlug ? parseModelSlug(defaultSlug) : null;
    return {
      shellPath,
      // Deterministic HTTP/SSE transport ensures Codex & all channels route reliably via the local loopback proxy.
      transport: "sse",
      ...(parsedDefault
        ? {
            defaultProvider: parsedDefault.channelId,
            defaultModel: parsedDefault.modelId,
          }
        : {}),
    };
  };

  let defaultModelSlug: string | null = null;
  let zeroChannelState = true;

  try {
    server.listen(0, "127.0.0.1");
    await once(server, "listening");
    const address = server.address();
    if (!address || typeof address === "string") {
      throw new Error("Cannot bind the Xtwork model gateway.");
    }
    port = address.port;
    await mkdir(agentDir, { recursive: true, mode: 0o700 });
    const initialDefault = resolveFallbackModel(currentChannels, devFallbackActive);
    // Write settings.json FIRST and commit models.json LAST so any reader observing models.json
    // is guaranteed to see matching settings.json and active gateway routes.
    await options.onBeforeCommitFile?.("settings.json");
    await writeRuntimeConfig(join(agentDir, "settings.json"), buildPiSettingsJson(initialDefault));
    await options.onBeforeCommitFile?.("models.json");
    await writeRuntimeConfig(
      join(agentDir, "models.json"),
      buildPiModelsJson(port, currentChannels, devFallbackActive),
    );
    defaultModelSlug = initialDefault;
    zeroChannelState = initialDefault === null;
  } catch (cause) {
    await closeGateway();
    throw cause;
  }

  // Async mutex serializing all channel catalog updates so `models.json`, `settings.json`,
  // OAuth registrations, and gateway routes never diverge across concurrent updates or write errors.
  let updateMutex: Promise<void> = Promise.resolve();
  const runSerializedUpdate = async <T>(operation: () => Promise<T>): Promise<T> => {
    const previous = updateMutex;
    let release!: () => void;
    const gate = new Promise<void>((resolveGate) => {
      release = resolveGate;
    });
    updateMutex = previous.catch(() => undefined).then(() => gate);
    await previous.catch(() => undefined);
    try {
      return await operation();
    } finally {
      release();
    }
  };

  /**
   * Serialized atomic channel catalog update with `models.json` atomic rename as the FINAL commit
   * point:
   * 1. Atomically persist `settings.json` first;
   * 2. Activate OAuth registrations and publish the new gateway route snapshot (already-started
   *    in-flight requests stay pinned to their request-start snapshot);
   * 3. Atomically rename `models.json` LAST, rolling back routes, OAuth registrations, defaults,
   *    and `settings.json` if committing `models.json` fails.
   */
  const updateChannels = async (nextChannels: readonly GatewayChannelConfig[]) =>
    runSerializedUpdate(async () => {
      const candidateChannels = [...nextChannels];
      const nextDefaultSlug = resolveFallbackModel(candidateChannels, devFallbackActive);
      const nextModelsJson = buildPiModelsJson(port, candidateChannels, devFallbackActive);
      const nextSettingsJson = buildPiSettingsJson(nextDefaultSlug);
      const settingsPath = join(agentDir, "settings.json");
      const modelsPath = join(agentDir, "models.json");

      // Phase 1: persist settings.json atomically FIRST. If this fails, routes & models.json are untouched.
      await options.onBeforeCommitFile?.("settings.json");
      await writeRuntimeConfig(settingsPath, nextSettingsJson);

      // Phase 2: non-destructively stage candidate OAuth bindings (NEVER evicting or clearing prior
      // live rotated caches before models.json commits!) and publish the candidate route snapshot.
      const prevChannels = currentChannels;
      const prevSnapshot = snapshot;
      const prevDefaultModelSlug = defaultModelSlug;
      const prevZeroChannelState = zeroChannelState;

      const stagedOAuthTx = oauthManager.stageUpdate(extractOAuthConfigs(candidateChannels));
      const candidateSnapshot = compileRouteSnapshot(
        prevSnapshot.revision + 1,
        candidateChannels,
        devFallbackRoute,
        stagedOAuthTx.bindingIdsByChannel,
      );
      currentChannels = candidateChannels;
      snapshot = candidateSnapshot;
      defaultModelSlug = nextDefaultSlug;
      zeroChannelState = nextDefaultSlug === null;

      // Phase 3 (FINAL commit point): atomically rename models.json LAST so any Pi reader observing
      // the new models.json is guaranteed to see matching settings.json and live gateway routes.
      // Only AFTER models.json commits do we finalize OAuth promotion & retire old accounts; on
      // failure, discard ONLY the staged candidates so prior live rotated caches stay 100% intact!
      try {
        await options.onBeforeCommitFile?.("models.json");
        await writeRuntimeConfig(modelsPath, nextModelsJson);
      } catch (error) {
        oauthManager.discardUpdate(stagedOAuthTx);
        currentChannels = prevChannels;
        snapshot = prevSnapshot;
        defaultModelSlug = prevDefaultModelSlug;
        zeroChannelState = prevZeroChannelState;
        await writeRuntimeConfig(settingsPath, buildPiSettingsJson(prevDefaultModelSlug)).catch(
          () => undefined,
        );
        throw error;
      }

      oauthManager.commitUpdate(stagedOAuthTx);

      return {
        revision: snapshot.revision,
        defaultModelSlug,
        zeroChannelState,
      };
    });

  return {
    config: {
      binaryPath: launcher,
      launchArgs: [
        "--offline --no-approve --no-extensions --no-skills --no-prompt-templates",
        '--append-system-prompt "You are 小瞳 (XiaoTong), the built-in assistant in 小瞳 Work. Help the user with everyday tasks."',
      ].join(" "),
    },
    environment: [
      { name: GATEWAY_TOKEN_ENV, value: gatewayToken, sensitive: true },
      { name: "PI_CODING_AGENT_DIR", value: agentDir, sensitive: false },
      { name: "PI_CODING_AGENT_SESSION_DIR", value: join(agentDir, "sessions"), sensitive: false },
      { name: "PI_SKIP_VERSION_CHECK", value: "1", sensitive: false },
      { name: "PI_TELEMETRY", value: "0", sensitive: false },
    ],
    port,
    gatewayToken,
    agentDir,
    secretStore,
    fence,
    oauthManager,
    getCatalogRevision: () => snapshot.revision,
    getDefaultModelSlug: () => defaultModelSlug,
    isZeroChannelState: () => zeroChannelState,
    resolveFallbackModel: () => resolveFallbackModel(currentChannels, devFallbackActive),
    updateChannels,
    close: closeGateway,
  };
}

async function writeRuntimeConfig(path: string, config: object) {
  const temporary = `${path}.${randomUUID()}.tmp`;
  try {
    await writeFile(temporary, JSON.stringify(config, null, 2) + "\n", { mode: 0o600 });
    await rename(temporary, path);
  } finally {
    await rm(temporary, { force: true });
  }
}
