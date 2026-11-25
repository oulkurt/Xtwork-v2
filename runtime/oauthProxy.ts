// @effect-diagnostics nodeBuiltinImport:off globalFetch:off -- Server-side OAuth proxy coordinator uses Node fetch & SecretStore.
/**
 * Proxy-Only server-side OAuth subscription credential & transport helpers (ADR-012 §3.4).
 *
 * Security Invariant:
 * Real OAuth `access_token`, `refresh_token`, and real account IDs NEVER leave the Xtwork server
 * process or OS SecretStore (`app.xtwork.model-channels`). Bundled Pi receives ONLY:
 * - `$XTWORK_MODEL_GATEWAY_TOKEN` (single-launch loopback token)
 * - For Codex (`openai-codex-responses`): a non-secret placeholder JWT carrying only the dummy
 *   `chatgpt_account_id` required by Pi 1.5.2's pre-network `extractAccountId()` check.
 */

import { randomUUID } from "node:crypto";
import {
  type ChannelCredentialFence,
  type CredentialFenceLease,
  type SecretStore,
  SecretStoreUnavailableError,
} from "./secretStore.ts";

export type OAuthSubscriptionProvider = "openai-codex" | "github-copilot" | "xai";

export type OAuthDestinationPurpose = "inference" | "token_refresh";

export type OAuthDestinationValidator = (
  provider: OAuthSubscriptionProvider,
  url: URL,
  purpose: OAuthDestinationPurpose,
  context?: { readonly enterpriseUrl?: string },
) => void;

export interface CodexOAuthCredentials {
  readonly access: string;
  readonly refresh: string;
  readonly expires: number;
  readonly accountId?: string;
}

export interface GithubCopilotOAuthCredentials {
  readonly access: string;
  readonly refresh: string;
  readonly expires: number;
  readonly enterpriseUrl?: string;
  readonly availableModelIds?: readonly string[];
}

export interface XaiOAuthCredentials {
  readonly access: string;
  readonly refresh: string;
  readonly expires: number;
}

export type OAuthSubscriptionCredentials =
  | CodexOAuthCredentials
  | GithubCopilotOAuthCredentials
  | XaiOAuthCredentials;

export const OAUTH_REFRESH_SKEW_MS = 60_000;
export const CODEX_JWT_CLAIM_PATH = "https://api.openai.com/auth";
export const CODEX_PLACEHOLDER_ACCOUNT_ID = "xtwork-proxy-placeholder";
export const CODEX_DEFAULT_UPSTREAM_BASE_URL = "https://chatgpt.com/backend-api";
export const XAI_DEFAULT_UPSTREAM_BASE_URL = "https://api.x.ai/v1";
export const GITHUB_COPILOT_DEFAULT_UPSTREAM_BASE_URL = "https://api.individual.githubcopilot.com";

export const GITHUB_COPILOT_STATIC_HEADERS: Readonly<Record<string, string>> = Object.freeze({
  "User-Agent": "GitHubCopilotChat/0.35.0",
  "Editor-Version": "vscode/1.107.0",
  "Editor-Plugin-Version": "copilot-chat/0.35.0",
  "Copilot-Integration-Id": "vscode-chat",
});

const FQDN_PATTERN =
  /^[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?(?:\.[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?)+$/i;
const IPV4_PATTERN = /^\d{1,3}(?:\.\d{1,3}){3}$/;
const COPILOT_PUBLIC_API_HOST_PATTERN =
  /^api(?:\.[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?)?\.githubcopilot\.com$/i;

function isSafePublicFqdn(hostname: string): boolean {
  const host = hostname.toLowerCase();
  if (!FQDN_PATTERN.test(host)) return false;
  if (IPV4_PATTERN.test(host)) return false;
  if (host === "localhost" || host.endsWith(".localhost") || host.endsWith(".local")) {
    return false;
  }
  return true;
}

/**
 * Create a non-secret placeholder JWT that satisfies Pi 1.5.2 `openai-codex-responses.js:1272`
 * (`extractAccountId` uses `atob(parts[1])` and reads `payload["https://api.openai.com/auth"].chatgpt_account_id`).
 *
 * Contains NO real OAuth credentials and NO real user account ID.
 */
export function createCodexPlaceholderJwt(
  placeholderAccountId: string = CODEX_PLACEHOLDER_ACCOUNT_ID,
): string {
  const header = Buffer.from(JSON.stringify({ alg: "none", typ: "JWT" }), "utf8").toString("base64");
  const payload = Buffer.from(
    JSON.stringify({ [CODEX_JWT_CLAIM_PATH]: { chatgpt_account_id: placeholderAccountId } }),
    "utf8",
  ).toString("base64");
  return `${header}.${payload}.xtwork-proxy`;
}

/**
 * Extract the real `chatgpt_account_id` claim from an OpenAI Codex OAuth JWT on the server side.
 */
export function extractCodexAccountId(accessToken: string): string | undefined {
  const parts = accessToken.split(".");
  if (parts.length !== 3 || !parts[1]) return undefined;
  try {
    const normalized = parts[1].replace(/-/g, "+").replace(/_/g, "/");
    const padded = normalized.padEnd(Math.ceil(normalized.length / 4) * 4, "=");
    const payload = JSON.parse(Buffer.from(padded, "base64").toString("utf8")) as Record<
      string,
      unknown
    >;
    const auth = payload[CODEX_JWT_CLAIM_PATH];
    if (!auth || typeof auth !== "object") return undefined;
    const accountId = (auth as Record<string, unknown>).chatgpt_account_id;
    return typeof accountId === "string" && accountId.length > 0 ? accountId : undefined;
  } catch {
    return undefined;
  }
}

export function normalizeEnterpriseDomain(input: string | undefined): string | undefined {
  if (input === undefined) return undefined;
  const trimmed = input.trim();
  if (!trimmed) return undefined;
  let url: URL;
  try {
    url = trimmed.includes("://") ? new URL(trimmed) : new URL(`https://${trimmed}`);
  } catch {
    throw new Error("Invalid GitHub Enterprise domain.");
  }
  if (
    url.protocol !== "https:" ||
    url.username ||
    url.password ||
    url.port ||
    url.search ||
    url.hash ||
    (url.pathname && url.pathname !== "/")
  ) {
    throw new Error("GitHub Enterprise domain must be a bare HTTPS hostname.");
  }
  const host = url.hostname.toLowerCase();
  if (!isSafePublicFqdn(host)) {
    throw new Error("GitHub Enterprise domain must be a valid public DNS hostname.");
  }
  return host;
}

/**
 * Strict production OAuth destination allowlist: prevents bearer/refresh tokens from ever being
 * sent over plaintext HTTP, to arbitrary `proxy-ep` hosts, or to untrusted `baseUrl` overrides.
 */
export function assertStrictOAuthDestination(
  provider: OAuthSubscriptionProvider,
  url: URL,
  purpose: OAuthDestinationPurpose,
  context?: { readonly enterpriseUrl?: string },
): void {
  if (url.protocol !== "https:" || url.username || url.password || url.port || url.hash) {
    throw new Error(
      `OAuth ${provider} ${purpose} destination must be a standard HTTPS origin without credentials, port, or fragment.`,
    );
  }
  const host = url.hostname.toLowerCase();
  if (!isSafePublicFqdn(host)) {
    throw new Error(`Untrusted OAuth ${provider} destination host "${host}".`);
  }

  if (provider === "openai-codex") {
    const allowed = purpose === "token_refresh" ? "auth.openai.com" : "chatgpt.com";
    if (host !== allowed) {
      throw new Error(`OAuth openai-codex ${purpose} host "${host}" is not allowed (expected ${allowed}).`);
    }
    return;
  }

  if (provider === "xai") {
    const allowed = purpose === "token_refresh" ? "auth.x.ai" : "api.x.ai";
    if (host !== allowed) {
      throw new Error(`OAuth xai ${purpose} host "${host}" is not allowed (expected ${allowed}).`);
    }
    return;
  }

  if (provider === "github-copilot") {
    const enterpriseDomain = normalizeEnterpriseDomain(context?.enterpriseUrl);
    if (purpose === "token_refresh") {
      const allowedHosts = new Set<string>(["api.github.com", "github.com"]);
      if (enterpriseDomain) {
        allowedHosts.add(enterpriseDomain);
        allowedHosts.add(`api.${enterpriseDomain}`);
      }
      if (!allowedHosts.has(host)) {
        throw new Error(`OAuth github-copilot token_refresh host "${host}" is not allowed.`);
      }
      return;
    }

    if (COPILOT_PUBLIC_API_HOST_PATTERN.test(host)) {
      return;
    }
    if (enterpriseDomain && host === `copilot-api.${enterpriseDomain}`) {
      return;
    }
    throw new Error(`OAuth github-copilot inference host "${host}" is not allowed.`);
  }
}

/**
 * Derive and strictly validate the real GitHub Copilot upstream API base URL from the Copilot
 * token's `proxy-ep=...` field or enterprise domain (matching Pi 1.5.2 `github-copilot.js:41-61`),
 * kept strictly on the server side so Pi's `toAuth` never overwrites the local gateway URL.
 *
 * Untrusted or malformed `proxy-ep` values are REJECTED (never allowed to redirect Bearer tokens
 * to an attacker-controlled host).
 */
export function deriveGitHubCopilotBaseUrl(
  copilotAccessToken: string | undefined,
  enterpriseUrl?: string,
  validateDestination: OAuthDestinationValidator = assertStrictOAuthDestination,
): string {
  const enterpriseDomain = normalizeEnterpriseDomain(enterpriseUrl);
  if (copilotAccessToken) {
    const match = copilotAccessToken.match(/(?:^|;)proxy-ep=([^;\s]+)/i);
    if (match?.[1]) {
      const rawHost = match[1].trim();
      if (!/^[a-z0-9.-]+$/i.test(rawHost)) {
        throw new Error("Malformed GitHub Copilot proxy-ep host.");
      }
      const apiHost = rawHost.toLowerCase().replace(/^proxy\./, "api.");
      const derived = new URL(`https://${apiHost}`);
      validateDestination("github-copilot", derived, "inference", {
        ...(enterpriseDomain ? { enterpriseUrl: enterpriseDomain } : {}),
      });
      return derived.origin;
    }
  }
  const fallback = enterpriseDomain
    ? new URL(`https://copilot-api.${enterpriseDomain}`)
    : new URL(GITHUB_COPILOT_DEFAULT_UPSTREAM_BASE_URL);
  validateDestination("github-copilot", fallback, "inference", {
    ...(enterpriseDomain ? { enterpriseUrl: enterpriseDomain } : {}),
  });
  return fallback.origin;
}

/**
 * Enforce GitHub Copilot subscription/organization model policy (`availableModelIds`).
 * When `availableModelIds` is specified, only explicitly permitted model IDs are allowed.
 */
export function isCopilotModelPermitted(
  modelId: string,
  availableModelIds: readonly string[] | undefined,
): boolean {
  if (availableModelIds === undefined) return true;
  const needle = modelId.trim().toLowerCase();
  return availableModelIds.some((id) => id.trim().toLowerCase() === needle);
}

function containsImageContent(value: unknown): boolean {
  if (!value || typeof value !== "object") return false;
  if (Array.isArray(value)) {
    return value.some((item) => containsImageContent(item));
  }
  const record = value as Record<string, unknown>;
  const type = record.type;
  if (type === "image" || type === "image_url" || type === "input_image") {
    return true;
  }
  if (record.content !== undefined && containsImageContent(record.content)) {
    return true;
  }
  return false;
}

/**
 * Build Copilot's dynamic per-request headers (`X-Initiator`, `Openai-Intent`,
 * `Copilot-Vision-Request`) on the server side when proxying Copilot traffic.
 */
export function buildCopilotUpstreamHeaders(requestBody: unknown): Record<string, string> {
  const headers: Record<string, string> = {
    ...GITHUB_COPILOT_STATIC_HEADERS,
    "Openai-Intent": "conversation-edits",
    "X-Initiator": "user",
  };
  if (requestBody && typeof requestBody === "object" && !Array.isArray(requestBody)) {
    const record = requestBody as Record<string, unknown>;
    const messages = Array.isArray(record.messages)
      ? record.messages
      : Array.isArray(record.input)
        ? record.input
        : [];
    const last = messages[messages.length - 1];
    if (
      last &&
      typeof last === "object" &&
      "role" in last &&
      typeof (last as { role?: unknown }).role === "string" &&
      (last as { role: string }).role !== "user"
    ) {
      headers["X-Initiator"] = "agent";
    }
    if (containsImageContent(messages)) {
      headers["Copilot-Vision-Request"] = "true";
    }
  }
  return headers;
}

export interface XaiRefreshEndpointOptions {
  readonly tokenUrl?: string;
  readonly clientId?: string;
  readonly fetchImpl?: typeof fetch;
  readonly now?: () => number;
  readonly validateDestination?: OAuthDestinationValidator;
}

const XAI_DEFAULT_CLIENT_ID = "b1a00492-073a-47ea-816f-4c329264a828";
const XAI_DEFAULT_TOKEN_URL = "https://auth.x.ai/oauth2/token";
const XAI_DEFAULT_LIFETIME_SECONDS = 3600;

const SAFE_OAUTH_ERROR_CODE_PATTERN = /^[a-z0-9_.-]{1,64}$/i;

async function extractSafeOAuthErrorCode(response: Response): Promise<string | undefined> {
  try {
    const raw = (await response.text()).slice(0, 4096);
    const parsed = JSON.parse(raw) as Record<string, unknown>;
    if (
      parsed &&
      typeof parsed === "object" &&
      typeof parsed.error === "string" &&
      SAFE_OAUTH_ERROR_CODE_PATTERN.test(parsed.error.trim())
    ) {
      return parsed.error.trim();
    }
    if (
      parsed &&
      typeof parsed === "object" &&
      typeof parsed.error === "object" &&
      parsed.error !== null &&
      typeof (parsed.error as Record<string, unknown>).code === "string"
    ) {
      const nested = String((parsed.error as Record<string, unknown>).code).trim();
      if (SAFE_OAUTH_ERROR_CODE_PATTERN.test(nested)) {
        return nested;
      }
    }
  } catch {
    // Non-JSON or unreadable error body: never expose raw text.
  }
  return undefined;
}

/**
 * Perform one xAI OAuth `refresh_token` grant (matching Pi 1.5.2 `auth/oauth/xai.js`).
 * Validates the token endpoint strictly, disables HTTP redirects (`redirect: "error"`), and
 * preserves the previous refresh token if xAI omits `refresh_token` when unrotated.
 */
export async function refreshXaiOAuthToken(
  current: XaiOAuthCredentials,
  signal?: AbortSignal,
  options: XaiRefreshEndpointOptions = {},
): Promise<XaiOAuthCredentials> {
  const fetchImpl = options.fetchImpl ?? globalThis.fetch;
  const tokenUrl = new URL(options.tokenUrl ?? XAI_DEFAULT_TOKEN_URL);
  const validate = options.validateDestination ?? assertStrictOAuthDestination;
  validate("xai", tokenUrl, "token_refresh");
  const clientId = options.clientId ?? XAI_DEFAULT_CLIENT_ID;
  const now = options.now ?? Date.now;

  const response = await fetchImpl(tokenUrl, {
    method: "POST",
    headers: {
      Accept: "application/json",
      "Content-Type": "application/x-www-form-urlencoded",
    },
    body: new URLSearchParams({
      grant_type: "refresh_token",
      client_id: clientId,
      refresh_token: current.refresh,
    }),
    redirect: "error",
    ...(signal ? { signal } : {}),
  });

  if (!response.ok) {
    const safeCode = await extractSafeOAuthErrorCode(response);
    throw new Error(
      `xAI OAuth token refresh failed (HTTP ${response.status}${safeCode ? `: ${safeCode}` : ""})`,
    );
  }
  const payload = (await response.json().catch(() => ({}))) as Record<string, unknown>;
  if (typeof payload.access_token !== "string" || payload.access_token.length === 0) {
    throw new Error("Invalid xAI OAuth refresh response: missing access_token");
  }
  const refresh =
    typeof payload.refresh_token === "string" && payload.refresh_token.length > 0
      ? payload.refresh_token
      : current.refresh;
  const expiresInSeconds =
    typeof payload.expires_in === "number" && Number.isFinite(payload.expires_in) && payload.expires_in > 0
      ? payload.expires_in
      : XAI_DEFAULT_LIFETIME_SECONDS;
  return {
    access: payload.access_token,
    refresh,
    expires: now() + expiresInSeconds * 1000,
  };
}

export interface CodexRefreshEndpointOptions {
  readonly tokenUrl?: string;
  readonly clientId?: string;
  readonly fetchImpl?: typeof fetch;
  readonly now?: () => number;
  readonly validateDestination?: OAuthDestinationValidator;
}

const CODEX_DEFAULT_CLIENT_ID = "app_EMoamEEZ73f0CkXaXp7hrann";
const CODEX_DEFAULT_TOKEN_URL = "https://auth.openai.com/oauth/token";

export async function refreshCodexOAuthToken(
  current: CodexOAuthCredentials,
  signal?: AbortSignal,
  options: CodexRefreshEndpointOptions = {},
): Promise<CodexOAuthCredentials> {
  const fetchImpl = options.fetchImpl ?? globalThis.fetch;
  const tokenUrl = new URL(options.tokenUrl ?? CODEX_DEFAULT_TOKEN_URL);
  const validate = options.validateDestination ?? assertStrictOAuthDestination;
  validate("openai-codex", tokenUrl, "token_refresh");
  const clientId = options.clientId ?? CODEX_DEFAULT_CLIENT_ID;
  const now = options.now ?? Date.now;

  const response = await fetchImpl(tokenUrl, {
    method: "POST",
    headers: { "Content-Type": "application/x-www-form-urlencoded" },
    body: new URLSearchParams({
      grant_type: "refresh_token",
      refresh_token: current.refresh,
      client_id: clientId,
    }),
    redirect: "error",
    ...(signal ? { signal } : {}),
  });
  if (!response.ok) {
    const safeCode = await extractSafeOAuthErrorCode(response);
    throw new Error(
      `OpenAI Codex token refresh failed (HTTP ${response.status}${safeCode ? `: ${safeCode}` : ""})`,
    );
  }
  const json = (await response.json()) as Record<string, unknown>;
  if (
    typeof json.access_token !== "string" ||
    typeof json.refresh_token !== "string" ||
    typeof json.expires_in !== "number"
  ) {
    throw new Error("OpenAI Codex token refresh response missing fields");
  }
  const accountId = extractCodexAccountId(json.access_token) ?? current.accountId;
  return {
    access: json.access_token,
    refresh: json.refresh_token,
    expires: now() + json.expires_in * 1000,
    ...(accountId ? { accountId } : {}),
  };
}

export interface RegisteredOAuthChannel<
  T extends OAuthSubscriptionCredentials = OAuthSubscriptionCredentials,
> {
  readonly channelId: string;
  readonly provider: OAuthSubscriptionProvider;
  readonly secretRef: string;
  readonly refresh: (current: T, signal: AbortSignal) => Promise<T>;
  readonly initialCredentials?: T;
}

export interface OAuthTokenManagerOptions {
  readonly secretStore: SecretStore;
  readonly fence: ChannelCredentialFence;
  readonly skewMs?: number;
  readonly now?: () => number;
}

export interface GetValidCredentialsOptions {
  readonly signal?: AbortSignal;
  /** Bind credential resolution strictly to the route snapshot's registered `secretRef`. */
  readonly expectedSecretRef?: string;
  /** Bind credential resolution strictly to the route snapshot's registered OAuth provider. */
  readonly expectedProvider?: OAuthSubscriptionProvider;
  /** Bind credential resolution strictly to the route snapshot's account fence generation. */
  readonly expectedGeneration?: number;
  /** Bind credential resolution strictly to the immutable OAuth binding ID (supports staged commits). */
  readonly expectedBindingId?: string;
}

interface OAuthBindingRecord {
  readonly bindingId: string;
  readonly fenceKey: string;
  readonly secretRefFenceKey: string;
  /** Fence keys from prior staged phases so logout/unregister invalidates pre-commit refreshes too. */
  readonly priorFenceKeys: Set<string>;
  config: RegisteredOAuthChannel;
}

interface SecretRefCredentialState {
  cache?: OAuthSubscriptionCredentials;
  inflight?: {
    readonly secretRefGeneration: number;
    readonly promise: Promise<OAuthSubscriptionCredentials>;
  };
}

function secretRefFenceKeyFor(secretRef: string): string {
  return `secretRef:${secretRef}`;
}

function stripInitialCredentials(config: RegisteredOAuthChannel): RegisteredOAuthChannel {
  if (config.initialCredentials === undefined) return config;
  const { initialCredentials: _dropped, ...rest } = config;
  return rest;
}

interface DualFenceLease {
  readonly bindingGeneration: number;
  readonly secretRefGeneration: number;
  readonly signal: AbortSignal;
  isCurrent(): boolean;
  assertCurrent(): void;
  release(): void;
}

export interface StagedOAuthUpdate {
  readonly nextConfigs: readonly RegisteredOAuthChannel[];
  readonly stagedBindingIds: ReadonlyMap<string, string>;
  readonly bindingIdsByChannel: ReadonlyMap<string, string>;
}

/**
 * Single-flight serialized OAuth credential manager backed by the hardened OS SecretStore
 * and protected by `ChannelCredentialFence`.
 *
 * Guarantees:
 * - Proactive 60s expiry skew refresh before upstream requests;
 * - Single-flight per-channel serialization (concurrent requests share one refresh, preventing
 *   rotating refresh token exhaustion on xAI / Codex / Copilot);
 * - Lease/generation is acquired BEFORE reading from SecretStore and checked BEFORE caching,
 *   returning, or persisting credentials; new reads are rejected while logout/delete is pending;
 * - Metadata-only re-registrations preserve live/rotated tokens; changing `secretRef`/`provider`
 *   or unregistering fences/aborts in-flight refreshes and drops cached credentials immediately;
 * - Non-destructive transactional staging (`stageUpdate` / `commitUpdate` / `discardUpdate`)
 *   keeps prior accounts' live rotated caches intact until `models.json` atomic rename commits.
 */
export class OAuthTokenManager {
  private readonly secretStore: SecretStore;
  private readonly fence: ChannelCredentialFence;
  private readonly skewMs: number;
  private readonly now: () => number;
  private readonly active = new Map<string, OAuthBindingRecord>();
  private readonly staged = new Map<string, OAuthBindingRecord>();
  private readonly secretRefStates = new Map<string, SecretRefCredentialState>();
  private readonly settledTransactions = new WeakSet<StagedOAuthUpdate>();
  private readonly pendingDeletes = new Map<string, number>();
  private readonly pendingDeletesBySecretRef = new Map<string, number>();

  constructor(options: OAuthTokenManagerOptions) {
    this.secretStore = options.secretStore;
    this.fence = options.fence;
    this.skewMs = options.skewMs ?? OAUTH_REFRESH_SKEW_MS;
    this.now = options.now ?? Date.now;
  }

  private getOrCreateSecretRefState(secretRef: string): SecretRefCredentialState {
    let state = this.secretRefStates.get(secretRef);
    if (!state) {
      state = {};
      this.secretRefStates.set(secretRef, state);
    }
    return state;
  }

  private seedInitialCache(
    channelId: string,
    secretRef: string,
    initialCredentials: OAuthSubscriptionCredentials | undefined,
  ): void {
    if (initialCredentials === undefined || this.isDeleting(channelId, secretRef)) {
      return;
    }
    const state = this.getOrCreateSecretRefState(secretRef);
    if (state.cache === undefined) {
      state.cache = initialCredentials;
    }
  }

  private isSecretRefReferenced(secretRef: string, excludeBindingId?: string): boolean {
    for (const rec of this.active.values()) {
      if (rec.bindingId !== excludeBindingId && rec.config.secretRef === secretRef) {
        return true;
      }
    }
    for (const rec of this.staged.values()) {
      if (rec.bindingId !== excludeBindingId && rec.config.secretRef === secretRef) {
        return true;
      }
    }
    return false;
  }

  private isDeleting(channelId: string, secretRef?: string): boolean {
    return (
      (this.pendingDeletes.get(channelId) ?? 0) > 0 ||
      (secretRef !== undefined && (this.pendingDeletesBySecretRef.get(secretRef) ?? 0) > 0)
    );
  }

  private assertNotDeleting(channelId: string, secretRef?: string): void {
    if (this.isDeleting(channelId, secretRef)) {
      throw new SecretStoreUnavailableError(
        "SECRET_FENCE_STALE",
        `OAuth credentials for channel "${channelId}" are currently being revoked`,
      );
    }
  }

  private acquireDualLease(
    record: OAuthBindingRecord,
    externalSignal?: AbortSignal,
  ): DualFenceLease {
    const bindingLease = this.fence.acquire(record.fenceKey, externalSignal);
    const secretRefLease = this.fence.acquire(record.secretRefFenceKey, externalSignal);
    const combinedController = new AbortController();
    const onAbort = (reason: unknown) => {
      if (!combinedController.signal.aborted) {
        combinedController.abort(reason);
      }
    };
    const onBindingAbort = () => onAbort(bindingLease.signal.reason);
    const onSecretRefAbort = () => onAbort(secretRefLease.signal.reason);

    if (bindingLease.signal.aborted) {
      onBindingAbort();
    } else {
      bindingLease.signal.addEventListener("abort", onBindingAbort, { once: true });
    }
    if (secretRefLease.signal.aborted) {
      onSecretRefAbort();
    } else {
      secretRefLease.signal.addEventListener("abort", onSecretRefAbort, { once: true });
    }

    return {
      bindingGeneration: bindingLease.generation,
      secretRefGeneration: secretRefLease.generation,
      signal: combinedController.signal,
      isCurrent: () => bindingLease.isCurrent() && secretRefLease.isCurrent(),
      assertCurrent: () => {
        bindingLease.assertCurrent();
        secretRefLease.assertCurrent();
      },
      release: () => {
        bindingLease.signal.removeEventListener("abort", onBindingAbort);
        secretRefLease.signal.removeEventListener("abort", onSecretRefAbort);
        bindingLease.release();
        secretRefLease.release();
      },
    };
  }

  private retireRecordFences(
    record: OAuthBindingRecord,
    reason: string,
    forceSecretRefInvalidation = false,
  ): void {
    this.fence.invalidate(record.fenceKey, reason);
    for (const priorKey of record.priorFenceKeys) {
      this.fence.invalidate(priorKey, reason);
    }
    if (
      forceSecretRefInvalidation ||
      !this.isSecretRefReferenced(record.config.secretRef, record.bindingId)
    ) {
      this.fence.invalidate(record.secretRefFenceKey, reason);
      this.secretRefStates.delete(record.config.secretRef);
    }
  }

  register<T extends OAuthSubscriptionCredentials>(config: RegisteredOAuthChannel<T>): string {
    const nextConfig = config as unknown as RegisteredOAuthChannel;
    const sanitizedConfig = stripInitialCredentials(nextConfig);
    const previous = this.active.get(config.channelId);
    if (previous) {
      const accountChanged =
        previous.config.secretRef !== sanitizedConfig.secretRef ||
        previous.config.provider !== sanitizedConfig.provider;
      if (accountChanged) {
        const providerChangedOnSameSecretRef =
          previous.config.secretRef === sanitizedConfig.secretRef &&
          previous.config.provider !== sanitizedConfig.provider;
        const replacement: OAuthBindingRecord = {
          bindingId: randomUUID(),
          fenceKey: config.channelId,
          secretRefFenceKey: secretRefFenceKeyFor(sanitizedConfig.secretRef),
          priorFenceKeys: new Set(),
          config: sanitizedConfig,
        };
        this.active.set(config.channelId, replacement);
        this.retireRecordFences(
          previous,
          `OAuth channel secretRef/provider changed (${previous.config.provider}:${previous.config.secretRef} -> ${sanitizedConfig.provider}:${sanitizedConfig.secretRef})`,
          providerChangedOnSameSecretRef,
        );
        this.seedInitialCache(
          sanitizedConfig.channelId,
          sanitizedConfig.secretRef,
          nextConfig.initialCredentials,
        );
        return replacement.bindingId;
      }
      // Same channelId, provider, and secretRef: preserve rotated cached credentials & inflight refresh!
      previous.config = sanitizedConfig;
      return previous.bindingId;
    }
    const created: OAuthBindingRecord = {
      bindingId: randomUUID(),
      fenceKey: config.channelId,
      secretRefFenceKey: secretRefFenceKeyFor(sanitizedConfig.secretRef),
      priorFenceKeys: new Set(),
      config: sanitizedConfig,
    };
    this.active.set(config.channelId, created);
    this.seedInitialCache(
      sanitizedConfig.channelId,
      sanitizedConfig.secretRef,
      nextConfig.initialCredentials,
    );
    return created.bindingId;
  }

  /**
   * Non-destructively stage a candidate OAuth catalog update without evicting, invalidating,
   * or overwriting existing live rotated caches. Call `commitUpdate(tx)` ONLY AFTER
   * `models.json` commits, or `discardUpdate(tx)` on persistence failure!
   */
  stageUpdate(nextConfigs: readonly RegisteredOAuthChannel[]): StagedOAuthUpdate {
    const stagedBindingIds = new Map<string, string>();
    const bindingIdsByChannel = new Map<string, string>();
    const sanitizedConfigs: RegisteredOAuthChannel[] = [];

    for (const nextConfig of nextConfigs) {
      const sanitizedConfig = stripInitialCredentials(nextConfig);
      sanitizedConfigs.push(sanitizedConfig);
      const existing = this.active.get(sanitizedConfig.channelId);
      if (
        existing &&
        existing.config.provider === sanitizedConfig.provider &&
        existing.config.secretRef === sanitizedConfig.secretRef
      ) {
        // Same account: reuse active binding & rotated cache without creating a duplicate.
        bindingIdsByChannel.set(sanitizedConfig.channelId, existing.bindingId);
        continue;
      }
      // New channel OR account swap: create an isolated staged record without touching `active`!
      const bindingId = randomUUID();
      const stagedRecord: OAuthBindingRecord = {
        bindingId,
        fenceKey: `${sanitizedConfig.channelId}#staged:${bindingId}`,
        secretRefFenceKey: secretRefFenceKeyFor(sanitizedConfig.secretRef),
        priorFenceKeys: new Set(),
        config: sanitizedConfig,
      };
      this.staged.set(bindingId, stagedRecord);
      this.seedInitialCache(
        sanitizedConfig.channelId,
        sanitizedConfig.secretRef,
        nextConfig.initialCredentials,
      );
      stagedBindingIds.set(sanitizedConfig.channelId, bindingId);
      bindingIdsByChannel.set(sanitizedConfig.channelId, bindingId);
    }

    return {
      nextConfigs: sanitizedConfigs,
      stagedBindingIds,
      bindingIdsByChannel,
    };
  }

  /**
   * Finalize a staged OAuth catalog update AFTER `models.json` atomic rename succeeds:
   * promotes staged records to `active` (preserving any token refreshed or currently in-flight
   * while staged via the shared `secretRef` state, AND tracking the staged fence key so any later
   * logout/unregister aborts pre-commit refreshes!), updates unchanged channels in place, and
   * retires/fences removed or replaced accounts.
   * Single-use: retrying an already committed or discarded transaction is a strict no-op.
   */
  commitUpdate(tx: StagedOAuthUpdate): void {
    if (this.settledTransactions.has(tx)) {
      return;
    }
    this.settledTransactions.add(tx);
    const nextChannelIds = new Set<string>();
    for (const nextConfig of tx.nextConfigs) {
      const sanitizedConfig = stripInitialCredentials(nextConfig);
      nextChannelIds.add(sanitizedConfig.channelId);
      const stagedId = tx.stagedBindingIds.get(sanitizedConfig.channelId);
      if (stagedId !== undefined) {
        const stagedRecord = this.staged.get(stagedId);
        this.staged.delete(stagedId);
        const previous = this.active.get(sanitizedConfig.channelId);
        const promotedPriorKeys = new Set<string>(stagedRecord?.priorFenceKeys ?? []);
        if (stagedRecord) {
          promotedPriorKeys.add(stagedRecord.fenceKey);
        }
        const promoted: OAuthBindingRecord = {
          bindingId: stagedRecord?.bindingId ?? stagedId,
          fenceKey: sanitizedConfig.channelId,
          secretRefFenceKey: secretRefFenceKeyFor(sanitizedConfig.secretRef),
          priorFenceKeys: promotedPriorKeys,
          config: sanitizedConfig,
        };
        this.active.set(sanitizedConfig.channelId, promoted);
        if (previous) {
          const providerChangedOnSameSecretRef =
            previous.config.secretRef === sanitizedConfig.secretRef &&
            previous.config.provider !== sanitizedConfig.provider;
          this.retireRecordFences(
            previous,
            `OAuth channel account replaced (${previous.config.provider}:${previous.config.secretRef} -> ${sanitizedConfig.provider}:${sanitizedConfig.secretRef})`,
            providerChangedOnSameSecretRef,
          );
        }
        if (this.isDeleting(sanitizedConfig.channelId, sanitizedConfig.secretRef)) {
          this.secretRefStates.delete(sanitizedConfig.secretRef);
        }
      } else {
        const existing = this.active.get(sanitizedConfig.channelId);
        if (existing) {
          existing.config = sanitizedConfig;
        }
      }
    }

    for (const channelId of [...this.active.keys()]) {
      if (!nextChannelIds.has(channelId)) {
        this.unregister(channelId);
      }
    }
  }

  /**
   * Roll back a staged OAuth catalog update after a failed `models.json` write:
   * discards staged candidates while leaving all prior active accounts and their live
   * rotated caches 100% untouched!
   */
  discardUpdate(tx: StagedOAuthUpdate): void {
    if (this.settledTransactions.has(tx)) {
      return;
    }
    this.settledTransactions.add(tx);
    for (const stagedId of tx.stagedBindingIds.values()) {
      const stagedRecord = this.staged.get(stagedId);
      if (stagedRecord) {
        this.staged.delete(stagedId);
        this.retireRecordFences(stagedRecord, "staged OAuth update discarded");
      }
    }
  }

  unregister(channelId: string, reason = "OAuth channel removed"): void {
    const existing = this.active.get(channelId);
    this.active.delete(channelId);
    if (existing) {
      this.retireRecordFences(existing, reason);
    } else {
      this.fence.invalidate(channelId, reason);
    }
  }

  getBindingId(channelId: string): string | undefined {
    return this.active.get(channelId)?.bindingId;
  }

  getCached<T extends OAuthSubscriptionCredentials>(channelId: string): T | undefined {
    const record = this.active.get(channelId);
    if (!record) return undefined;
    return this.secretRefStates.get(record.config.secretRef)?.cache as T | undefined;
  }

  getAccountGeneration(channelId: string): number {
    return this.fence.generation(channelId);
  }

  private resolveBinding(
    channelId: string,
    opts: GetValidCredentialsOptions,
  ): OAuthBindingRecord {
    if (opts.expectedBindingId !== undefined) {
      const stagedRecord = this.staged.get(opts.expectedBindingId);
      if (stagedRecord && stagedRecord.config.channelId === channelId) {
        if (
          (opts.expectedSecretRef !== undefined &&
            stagedRecord.config.secretRef !== opts.expectedSecretRef) ||
          (opts.expectedProvider !== undefined &&
            stagedRecord.config.provider !== opts.expectedProvider)
        ) {
          throw new SecretStoreUnavailableError(
            "SECRET_FENCE_STALE",
            `Staged OAuth channel "${channelId}" binding mismatch`,
          );
        }
        return stagedRecord;
      }
      const activeRecord = this.active.get(channelId);
      if (!activeRecord || activeRecord.bindingId !== opts.expectedBindingId) {
        throw new SecretStoreUnavailableError(
          "SECRET_FENCE_STALE",
          `OAuth channel "${channelId}" account binding is no longer active`,
        );
      }
      if (
        (opts.expectedSecretRef !== undefined &&
          activeRecord.config.secretRef !== opts.expectedSecretRef) ||
        (opts.expectedProvider !== undefined &&
          activeRecord.config.provider !== opts.expectedProvider)
      ) {
        throw new SecretStoreUnavailableError(
          "SECRET_FENCE_STALE",
          `OAuth channel "${channelId}" account binding changed after request started`,
        );
      }
      return activeRecord;
    }

    const activeRecord = this.active.get(channelId);
    if (!activeRecord) {
      throw new SecretStoreUnavailableError(
        "SECRET_FENCE_STALE",
        `No OAuth configuration registered for channel "${channelId}"`,
      );
    }
    if (
      (opts.expectedSecretRef !== undefined &&
        activeRecord.config.secretRef !== opts.expectedSecretRef) ||
      (opts.expectedProvider !== undefined &&
        activeRecord.config.provider !== opts.expectedProvider)
    ) {
      throw new SecretStoreUnavailableError(
        "SECRET_FENCE_STALE",
        `OAuth channel "${channelId}" account binding changed after request started`,
      );
    }
    return activeRecord;
  }

  private async loadCredentials(
    record: OAuthBindingRecord,
    lease: DualFenceLease,
  ): Promise<OAuthSubscriptionCredentials> {
    const { channelId, secretRef } = record.config;
    this.assertNotDeleting(channelId, secretRef);
    lease.assertCurrent();
    const cached = this.secretRefStates.get(secretRef)?.cache;
    if (cached) {
      this.assertNotDeleting(channelId, secretRef);
      lease.assertCurrent();
      return cached;
    }
    const raw = await this.secretStore.get(secretRef);
    // CRITICAL: Re-check fence & pending-delete state IMMEDIATELY after SecretStore read resolves,
    // BEFORE parsing, caching, returning, or starting a refresh!
    this.assertNotDeleting(channelId, secretRef);
    lease.assertCurrent();
    if (!raw) {
      throw new SecretStoreUnavailableError(
        "SECRET_STORE_UNAVAILABLE",
        `OAuth credentials missing for channel "${channelId}"`,
      );
    }
    const parsed = JSON.parse(raw) as OAuthSubscriptionCredentials;
    if (
      !parsed ||
      typeof parsed !== "object" ||
      typeof parsed.access !== "string" ||
      typeof parsed.refresh !== "string" ||
      typeof parsed.expires !== "number"
    ) {
      throw new SecretStoreUnavailableError(
        "SECRET_DECRYPT_FAILED",
        `Malformed OAuth credentials stored for channel "${channelId}"`,
      );
    }
    this.assertNotDeleting(channelId, secretRef);
    lease.assertCurrent();
    // Do NOT overwrite a credential already populated/rotated into the shared cache while
    // `secretStore.get()` was in flight (prevents a late keychain read from clobbering a newer
    // rotated refresh token).
    const state = this.getOrCreateSecretRefState(secretRef);
    if (state.cache !== undefined) {
      return state.cache;
    }
    state.cache = parsed;
    return parsed;
  }

  async getValidCredentials<T extends OAuthSubscriptionCredentials>(
    channelId: string,
    signalOrOptions?: AbortSignal | GetValidCredentialsOptions,
  ): Promise<T> {
    const opts: GetValidCredentialsOptions =
      signalOrOptions instanceof AbortSignal
        ? { signal: signalOrOptions }
        : (signalOrOptions ?? {});
    this.assertNotDeleting(channelId, opts.expectedSecretRef);
    const record = this.resolveBinding(channelId, opts);
    this.assertNotDeleting(channelId, record.config.secretRef);
    // Acquire dual generation lease (binding fence AND secretRef fence) BEFORE touching SecretStore
    // so any concurrent logout/delete, account swap, or post-commit revocation invalidates this read.
    const readLease = this.acquireDualLease(record, opts.signal);
    try {
      if (
        opts.expectedGeneration !== undefined &&
        readLease.bindingGeneration !== opts.expectedGeneration
      ) {
        throw new SecretStoreUnavailableError(
          "SECRET_FENCE_STALE",
          `OAuth channel "${channelId}" account generation changed (${opts.expectedGeneration} !== ${readLease.bindingGeneration})`,
        );
      }
      const current = await this.loadCredentials(record, readLease);
      this.assertNotDeleting(channelId, record.config.secretRef);
      readLease.assertCurrent();
      if (current.expires - this.now() > this.skewMs) {
        return current as T;
      }
      return await this.refreshSerial<T>(record, current, readLease);
    } finally {
      readLease.release();
    }
  }

  private async refreshSerial<T extends OAuthSubscriptionCredentials>(
    record: OAuthBindingRecord,
    fallback: OAuthSubscriptionCredentials,
    readLease: DualFenceLease,
  ): Promise<T> {
    const { channelId, secretRef } = record.config;
    const expectedBindingGen = readLease.bindingGeneration;
    const expectedSecretRefGen = readLease.secretRefGeneration;

    while (true) {
      this.assertNotDeleting(channelId, secretRef);
      readLease.assertCurrent();

      const state = this.getOrCreateSecretRefState(secretRef);
      const existing = state.inflight;
      if (existing && existing.secretRefGeneration === expectedSecretRefGen) {
        try {
          const sharedResult = await existing.promise;
          this.assertNotDeleting(channelId, secretRef);
          readLease.assertCurrent();
          return sharedResult as T;
        } catch (err) {
          // If the initiating sibling/staged binding was removed while THIS binding & shared
          // secretRef remain valid (not revoked), loop to join or start a fresh single-flight refresh.
          if (
            err instanceof SecretStoreUnavailableError &&
            err.code === "SECRET_FENCE_STALE" &&
            !this.isDeleting(channelId, secretRef) &&
            readLease.isCurrent() &&
            this.secretRefStates.get(secretRef)?.inflight !== existing
          ) {
            continue;
          }
          throw err;
        }
      }

      // Re-check shared cache after any awaited inflight completed.
      const cachedNow = state.cache;
      if (cachedNow && cachedNow.expires - this.now() > this.skewMs) {
        this.assertNotDeleting(channelId, secretRef);
        readLease.assertCurrent();
        return cachedNow as T;
      }

      // Acquire a refresh-scoped dual lease pinned strictly to `(expectedBindingGen, expectedSecretRefGen)`.
      const refreshLease = this.acquireDualLease(record);
      if (
        refreshLease.bindingGeneration !== expectedBindingGen ||
        refreshLease.secretRefGeneration !== expectedSecretRefGen
      ) {
        refreshLease.release();
        readLease.assertCurrent();
        throw new SecretStoreUnavailableError(
          "SECRET_FENCE_STALE",
          `Channel "${channelId}" fence generation advanced before refresh started`,
        );
      }

      let inflightEntry:
        | {
            readonly secretRefGeneration: number;
            readonly promise: Promise<OAuthSubscriptionCredentials>;
          }
        | undefined;
      const refreshPromise = (async (): Promise<OAuthSubscriptionCredentials> => {
        try {
          this.assertNotDeleting(channelId, secretRef);
          refreshLease.assertCurrent();
          const latest = this.secretRefStates.get(secretRef)?.cache ?? fallback;
          if (latest.expires - this.now() > this.skewMs) {
            return latest;
          }
          const refreshed = await record.config.refresh(latest, refreshLease.signal);
          this.assertNotDeleting(channelId, secretRef);
          refreshLease.assertCurrent();
          // Write under the `secretRef`-scoped fence so BOTH pre-commit staged refreshes AND active
          // refreshes serialize strictly against `revokeAndDelete` for the same `secretRef`!
          await this.fence.writeIfCurrent(
            this.secretStore,
            record.secretRefFenceKey,
            secretRef,
            JSON.stringify(refreshed),
            refreshLease.secretRefGeneration,
          );
          if (!refreshLease.isCurrent() || this.isDeleting(channelId, secretRef)) {
            await this.secretStore.delete(secretRef).catch(() => undefined);
            throw new SecretStoreUnavailableError(
              "SECRET_FENCE_STALE",
              `Channel "${channelId}" was invalidated during OAuth refresh`,
            );
          }
          this.getOrCreateSecretRefState(secretRef).cache = refreshed;
          return refreshed;
        } finally {
          refreshLease.release();
          const stateNow = this.secretRefStates.get(secretRef);
          if (stateNow && inflightEntry !== undefined && stateNow.inflight === inflightEntry) {
            delete stateNow.inflight;
          }
        }
      })();

      inflightEntry = {
        secretRefGeneration: expectedSecretRefGen,
        promise: refreshPromise,
      };
      state.inflight = inflightEntry;
      const result = await refreshPromise;
      this.assertNotDeleting(channelId, secretRef);
      readLease.assertCurrent();
      return result as T;
    }
  }

  private purgeMatchingRecords(
    channelId: string,
    secretRef: string | undefined,
    reason: string,
  ): void {
    if (secretRef !== undefined) {
      this.secretRefStates.delete(secretRef);
    }
    for (const rec of this.active.values()) {
      if (
        rec.config.channelId === channelId ||
        (secretRef !== undefined && rec.config.secretRef === secretRef)
      ) {
        this.secretRefStates.delete(rec.config.secretRef);
        if (rec.fenceKey !== channelId) {
          this.fence.invalidate(rec.fenceKey, reason);
        }
        for (const priorKey of rec.priorFenceKeys) {
          this.fence.invalidate(priorKey, reason);
        }
      }
    }
    for (const stagedRecord of this.staged.values()) {
      if (
        stagedRecord.config.channelId === channelId ||
        (secretRef !== undefined && stagedRecord.config.secretRef === secretRef)
      ) {
        this.secretRefStates.delete(stagedRecord.config.secretRef);
        this.fence.invalidate(stagedRecord.fenceKey, reason);
        for (const priorKey of stagedRecord.priorFenceKeys) {
          this.fence.invalidate(priorKey, reason);
        }
      }
    }
  }

  /**
   * Immediately evict cached credentials & invalidate in-flight refreshes for a `secretRef`
   * (e.g. after interactive OAuth re-login writes a new account's credentials under the same ref),
   * without deleting the SecretStore entry. Next `getValidCredentials()` immediately reloads the new token.
   */
  evictSecretRef(
    secretRef: string,
    reason = "OAuth credentials replaced via interactive re-login",
  ): void {
    this.secretRefStates.delete(secretRef);
    this.fence.invalidate(secretRefFenceKeyFor(secretRef), reason);
    for (const rec of this.active.values()) {
      if (rec.config.secretRef === secretRef) {
        this.fence.invalidate(rec.fenceKey, reason);
        for (const priorKey of rec.priorFenceKeys) {
          this.fence.invalidate(priorKey, reason);
        }
      }
    }
    for (const stagedRecord of this.staged.values()) {
      if (stagedRecord.config.secretRef === secretRef) {
        this.fence.invalidate(stagedRecord.fenceKey, reason);
        for (const priorKey of stagedRecord.priorFenceKeys) {
          this.fence.invalidate(priorKey, reason);
        }
      }
    }
  }

  /**
   * Logout / delete a channel's OAuth credentials safely under the fencing token:
   * blocks new reads while deletion is pending, aborts ANY in-flight active OR pre-commit staged
   * refresh for that channel or `secretRef`, clears in-memory caches across all channels sharing
   * the `secretRef`, and performs serialized verified deletion from the OS SecretStore.
   */
  async revokeAndDelete(
    channelId: string,
    secretRefOverride?: string,
    reason = "OAuth channel logout/deleted",
  ): Promise<number> {
    const activeRecord = this.active.get(channelId);
    let secretRef = secretRefOverride ?? activeRecord?.config.secretRef;
    if (!secretRef) {
      for (const stagedRecord of this.staged.values()) {
        if (stagedRecord.config.channelId === channelId) {
          secretRef = stagedRecord.config.secretRef;
          break;
        }
      }
    }
    this.pendingDeletes.set(channelId, (this.pendingDeletes.get(channelId) ?? 0) + 1);
    if (secretRef !== undefined) {
      this.pendingDeletesBySecretRef.set(
        secretRef,
        (this.pendingDeletesBySecretRef.get(secretRef) ?? 0) + 1,
      );
    }
    this.purgeMatchingRecords(channelId, secretRef, reason);
    try {
      const nextChannelGen = this.fence.invalidate(channelId, reason);
      if (secretRef) {
        await this.fence.deleteAndInvalidate(
          this.secretStore,
          secretRefFenceKeyFor(secretRef),
          secretRef,
          reason,
        );
      }
      // Post-delete sweep: clear any active/staged records introduced while delete was awaiting.
      this.purgeMatchingRecords(channelId, secretRef, reason);
      return nextChannelGen;
    } finally {
      const remaining = (this.pendingDeletes.get(channelId) ?? 1) - 1;
      if (remaining <= 0) {
        this.pendingDeletes.delete(channelId);
      } else {
        this.pendingDeletes.set(channelId, remaining);
      }
      if (secretRef !== undefined) {
        const remainingRef = (this.pendingDeletesBySecretRef.get(secretRef) ?? 1) - 1;
        if (remainingRef <= 0) {
          this.pendingDeletesBySecretRef.delete(secretRef);
        } else {
          this.pendingDeletesBySecretRef.set(secretRef, remainingRef);
        }
      }
    }
  }
}
