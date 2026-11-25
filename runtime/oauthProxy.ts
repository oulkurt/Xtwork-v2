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
  return availableModelIds.includes(modelId);
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

  const payload = (await response.json().catch(() => ({}))) as Record<string, unknown>;
  if (!response.ok) {
    const err = typeof payload.error === "string" ? payload.error : "";
    const desc = typeof payload.error_description === "string" ? payload.error_description : "";
    const detail = [err, desc].filter(Boolean).join(": ");
    throw new Error(
      `xAI OAuth token refresh failed (HTTP ${response.status})${detail ? `: ${detail}` : ""}`,
    );
  }
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
    const text = await response.text().catch(() => "");
    throw new Error(
      `OpenAI Codex token refresh failed (${response.status}): ${text || response.statusText}`,
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
 *   or unregistering fences/aborts in-flight refreshes and drops cached credentials immediately.
 */
export class OAuthTokenManager {
  private readonly secretStore: SecretStore;
  private readonly fence: ChannelCredentialFence;
  private readonly skewMs: number;
  private readonly now: () => number;
  private readonly configs = new Map<string, RegisteredOAuthChannel>();
  private readonly cache = new Map<string, OAuthSubscriptionCredentials>();
  private readonly pendingDeletes = new Map<string, number>();
  private readonly inflight = new Map<
    string,
    { readonly generation: number; readonly promise: Promise<OAuthSubscriptionCredentials> }
  >();

  constructor(options: OAuthTokenManagerOptions) {
    this.secretStore = options.secretStore;
    this.fence = options.fence;
    this.skewMs = options.skewMs ?? OAUTH_REFRESH_SKEW_MS;
    this.now = options.now ?? Date.now;
  }

  private assertNotDeleting(channelId: string): void {
    if ((this.pendingDeletes.get(channelId) ?? 0) > 0) {
      throw new SecretStoreUnavailableError(
        "SECRET_FENCE_STALE",
        `OAuth credentials for channel "${channelId}" are currently being revoked`,
      );
    }
  }

  register<T extends OAuthSubscriptionCredentials>(config: RegisteredOAuthChannel<T>): void {
    const nextConfig = config as unknown as RegisteredOAuthChannel;
    const previous = this.configs.get(config.channelId);
    if (previous) {
      const accountChanged =
        previous.secretRef !== nextConfig.secretRef || previous.provider !== nextConfig.provider;
      if (accountChanged) {
        this.fence.invalidate(
          config.channelId,
          `OAuth channel secretRef/provider changed (${previous.provider}:${previous.secretRef} -> ${nextConfig.provider}:${nextConfig.secretRef})`,
        );
        this.cache.delete(config.channelId);
        this.inflight.delete(config.channelId);
        this.configs.set(config.channelId, nextConfig);
        if (nextConfig.initialCredentials) {
          this.cache.set(config.channelId, nextConfig.initialCredentials);
        }
        return;
      }
      // Same channelId, provider, and secretRef: preserve rotated cached credentials & inflight refresh!
      this.configs.set(config.channelId, nextConfig);
      return;
    }
    this.configs.set(config.channelId, nextConfig);
    if (nextConfig.initialCredentials) {
      this.cache.set(config.channelId, nextConfig.initialCredentials);
    }
  }

  unregister(channelId: string, reason = "OAuth channel removed"): void {
    this.fence.invalidate(channelId, reason);
    this.configs.delete(channelId);
    this.cache.delete(channelId);
    this.inflight.delete(channelId);
  }

  getCached<T extends OAuthSubscriptionCredentials>(channelId: string): T | undefined {
    return this.cache.get(channelId) as T | undefined;
  }

  getAccountGeneration(channelId: string): number {
    return this.fence.generation(channelId);
  }

  private async loadCredentials(
    config: RegisteredOAuthChannel,
    lease: CredentialFenceLease,
  ): Promise<OAuthSubscriptionCredentials> {
    this.assertNotDeleting(config.channelId);
    lease.assertCurrent();
    const cached = this.cache.get(config.channelId);
    if (cached) {
      this.assertNotDeleting(config.channelId);
      lease.assertCurrent();
      return cached;
    }
    const raw = await this.secretStore.get(config.secretRef);
    // CRITICAL: Re-check fence & pending-delete state IMMEDIATELY after SecretStore read resolves,
    // BEFORE parsing, caching, returning, or starting a refresh!
    this.assertNotDeleting(config.channelId);
    lease.assertCurrent();
    if (!raw) {
      throw new SecretStoreUnavailableError(
        "SECRET_STORE_UNAVAILABLE",
        `OAuth credentials missing for channel "${config.channelId}"`,
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
        `Malformed OAuth credentials stored for channel "${config.channelId}"`,
      );
    }
    this.assertNotDeleting(config.channelId);
    lease.assertCurrent();
    this.cache.set(config.channelId, parsed);
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
    this.assertNotDeleting(channelId);
    const config = this.configs.get(channelId);
    if (!config) {
      throw new SecretStoreUnavailableError(
        "SECRET_FENCE_STALE",
        `No OAuth configuration registered for channel "${channelId}"`,
      );
    }
    if (
      (opts.expectedSecretRef !== undefined && config.secretRef !== opts.expectedSecretRef) ||
      (opts.expectedProvider !== undefined && config.provider !== opts.expectedProvider)
    ) {
      throw new SecretStoreUnavailableError(
        "SECRET_FENCE_STALE",
        `OAuth channel "${channelId}" account binding changed after request started`,
      );
    }
    // Acquire generation lease BEFORE touching SecretStore so any concurrent logout/delete
    // or account replacement invalidates this read before it can cache, return, or refresh.
    const readLease = this.fence.acquire(channelId, opts.signal);
    try {
      if (
        opts.expectedGeneration !== undefined &&
        readLease.generation !== opts.expectedGeneration
      ) {
        throw new SecretStoreUnavailableError(
          "SECRET_FENCE_STALE",
          `OAuth channel "${channelId}" account generation changed (${opts.expectedGeneration} !== ${readLease.generation})`,
        );
      }
      const current = await this.loadCredentials(config, readLease);
      this.assertNotDeleting(channelId);
      readLease.assertCurrent();
      if (current.expires - this.now() > this.skewMs) {
        return current as T;
      }
      return await this.refreshSerial<T>(config, current, readLease);
    } finally {
      readLease.release();
    }
  }

  private async refreshSerial<T extends OAuthSubscriptionCredentials>(
    config: RegisteredOAuthChannel,
    fallback: OAuthSubscriptionCredentials,
    readLease: CredentialFenceLease,
  ): Promise<T> {
    this.assertNotDeleting(config.channelId);
    readLease.assertCurrent();
    const expectedGen = readLease.generation;

    const existing = this.inflight.get(config.channelId);
    if (existing && existing.generation === expectedGen) {
      const sharedResult = await existing.promise;
      this.assertNotDeleting(config.channelId);
      readLease.assertCurrent();
      return sharedResult as T;
    }

    // Acquire a refresh-scoped fence lease pinned strictly to `expectedGen` (NEVER jumping to
    // a post-logout generation). Not tied to a single caller's HTTP disconnect signal so
    // concurrent waiters on the same single-flight refresh are not spuriously aborted.
    const refreshLease = this.fence.acquire(config.channelId);
    if (refreshLease.generation !== expectedGen) {
      refreshLease.release();
      readLease.assertCurrent();
      throw new SecretStoreUnavailableError(
        "SECRET_FENCE_STALE",
        `Channel "${config.channelId}" fence generation advanced before refresh started`,
      );
    }

    let inflightEntry:
      | { readonly generation: number; readonly promise: Promise<OAuthSubscriptionCredentials> }
      | undefined;
    const refreshPromise = (async (): Promise<OAuthSubscriptionCredentials> => {
      try {
        this.assertNotDeleting(config.channelId);
        refreshLease.assertCurrent();
        const latest = this.cache.get(config.channelId) ?? fallback;
        if (latest.expires - this.now() > this.skewMs) {
          return latest;
        }
        const refreshed = await config.refresh(latest, refreshLease.signal);
        this.assertNotDeleting(config.channelId);
        refreshLease.assertCurrent();
        await this.fence.writeIfCurrent(
          this.secretStore,
          config.channelId,
          config.secretRef,
          JSON.stringify(refreshed),
          refreshLease.generation,
        );
        if (!refreshLease.isCurrent() || (this.pendingDeletes.get(config.channelId) ?? 0) > 0) {
          throw new SecretStoreUnavailableError(
            "SECRET_FENCE_STALE",
            `Channel "${config.channelId}" was invalidated during OAuth refresh`,
          );
        }
        this.cache.set(config.channelId, refreshed);
        return refreshed;
      } finally {
        refreshLease.release();
        if (inflightEntry !== undefined && this.inflight.get(config.channelId) === inflightEntry) {
          this.inflight.delete(config.channelId);
        }
      }
    })();

    inflightEntry = { generation: expectedGen, promise: refreshPromise };
    this.inflight.set(config.channelId, inflightEntry);
    const result = await refreshPromise;
    this.assertNotDeleting(config.channelId);
    readLease.assertCurrent();
    return result as T;
  }

  /**
   * Logout / delete a channel's OAuth credentials safely under the fencing token:
   * blocks new reads while deletion is pending, aborts any in-flight refresh, clears in-memory
   * caches, and performs verified deletion from the OS SecretStore.
   */
  async revokeAndDelete(
    channelId: string,
    secretRefOverride?: string,
    reason = "OAuth channel logout/deleted",
  ): Promise<number> {
    const config = this.configs.get(channelId);
    const secretRef = secretRefOverride ?? config?.secretRef;
    this.pendingDeletes.set(channelId, (this.pendingDeletes.get(channelId) ?? 0) + 1);
    this.cache.delete(channelId);
    this.inflight.delete(channelId);
    try {
      if (!secretRef) {
        return this.fence.invalidate(channelId, reason);
      }
      return await this.fence.deleteAndInvalidate(this.secretStore, channelId, secretRef, reason);
    } finally {
      const remaining = (this.pendingDeletes.get(channelId) ?? 1) - 1;
      if (remaining <= 0) {
        this.pendingDeletes.delete(channelId);
      } else {
        this.pendingDeletes.set(channelId, remaining);
      }
    }
  }
}
