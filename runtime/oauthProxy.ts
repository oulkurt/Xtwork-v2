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
  type SecretStore,
  SecretStoreUnavailableError,
} from "./secretStore.ts";

export type OAuthSubscriptionProvider = "openai-codex" | "github-copilot" | "xai";

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

function normalizeEnterpriseDomain(input: string | undefined): string | undefined {
  if (!input) return undefined;
  const trimmed = input.trim();
  if (!trimmed) return undefined;
  try {
    const url = trimmed.includes("://") ? new URL(trimmed) : new URL(`https://${trimmed}`);
    return url.hostname;
  } catch {
    return undefined;
  }
}

/**
 * Derive the real GitHub Copilot upstream API base URL from the Copilot token's `proxy-ep=...`
 * field or enterprise domain (matching Pi 1.5.2 `github-copilot.js:41-61`), kept strictly on the
 * server side so Pi's `toAuth` never overwrites the local gateway URL.
 */
export function deriveGitHubCopilotBaseUrl(
  copilotAccessToken: string | undefined,
  enterpriseUrl?: string,
): string {
  if (copilotAccessToken) {
    const match = copilotAccessToken.match(/proxy-ep=([^;\s]+)/);
    if (match?.[1]) {
      const apiHost = match[1].replace(/^proxy\./, "api.");
      return `https://${apiHost}`;
    }
  }
  const enterpriseDomain = normalizeEnterpriseDomain(enterpriseUrl);
  if (enterpriseDomain) {
    return `https://copilot-api.${enterpriseDomain}`;
  }
  return GITHUB_COPILOT_DEFAULT_UPSTREAM_BASE_URL;
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
}

const XAI_DEFAULT_CLIENT_ID = "b1a00492-073a-47ea-816f-4c329264a828";
const XAI_DEFAULT_TOKEN_URL = "https://auth.x.ai/oauth2/token";
const XAI_DEFAULT_LIFETIME_SECONDS = 3600;

/**
 * Perform one xAI OAuth `refresh_token` grant (matching Pi 1.5.2 `auth/oauth/xai.js`).
 * Preserves the previous refresh token if xAI omits `refresh_token` when unrotated.
 */
export async function refreshXaiOAuthToken(
  current: XaiOAuthCredentials,
  signal?: AbortSignal,
  options: XaiRefreshEndpointOptions = {},
): Promise<XaiOAuthCredentials> {
  const fetchImpl = options.fetchImpl ?? globalThis.fetch;
  const tokenUrl = options.tokenUrl ?? XAI_DEFAULT_TOKEN_URL;
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
}

const CODEX_DEFAULT_CLIENT_ID = "app_EMoamEEZ73f0CkXaXp7hrann";
const CODEX_DEFAULT_TOKEN_URL = "https://auth.openai.com/oauth/token";

export async function refreshCodexOAuthToken(
  current: CodexOAuthCredentials,
  signal?: AbortSignal,
  options: CodexRefreshEndpointOptions = {},
): Promise<CodexOAuthCredentials> {
  const fetchImpl = options.fetchImpl ?? globalThis.fetch;
  const tokenUrl = options.tokenUrl ?? CODEX_DEFAULT_TOKEN_URL;
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

/**
 * Single-flight serialized OAuth credential manager backed by the hardened OS SecretStore
 * and protected by `ChannelCredentialFence`.
 *
 * Guarantees:
 * - Proactive 60s expiry skew refresh before upstream requests;
 * - Single-flight per-channel serialization (concurrent requests share one refresh, preventing
 *   rotating refresh token exhaustion on xAI / Codex / Copilot);
 * - Logout / channel delete bumps fence generation, aborts any in-flight refresh, clears cache,
 *   and prevents stale write-backs from resurrecting deleted credentials.
 */
export class OAuthTokenManager {
  private readonly secretStore: SecretStore;
  private readonly fence: ChannelCredentialFence;
  private readonly skewMs: number;
  private readonly now: () => number;
  private readonly configs = new Map<string, RegisteredOAuthChannel>();
  private readonly cache = new Map<string, OAuthSubscriptionCredentials>();
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

  register<T extends OAuthSubscriptionCredentials>(config: RegisteredOAuthChannel<T>): void {
    this.configs.set(config.channelId, config as unknown as RegisteredOAuthChannel);
    if (config.initialCredentials) {
      this.cache.set(config.channelId, config.initialCredentials);
    }
  }

  unregister(channelId: string): void {
    this.configs.delete(channelId);
    this.cache.delete(channelId);
    this.inflight.delete(channelId);
  }

  getCached<T extends OAuthSubscriptionCredentials>(channelId: string): T | undefined {
    return this.cache.get(channelId) as T | undefined;
  }

  private async loadCredentials(
    config: RegisteredOAuthChannel,
  ): Promise<OAuthSubscriptionCredentials> {
    const cached = this.cache.get(config.channelId);
    if (cached) return cached;
    const raw = await this.secretStore.get(config.secretRef);
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
    this.cache.set(config.channelId, parsed);
    return parsed;
  }

  async getValidCredentials<T extends OAuthSubscriptionCredentials>(
    channelId: string,
    signal?: AbortSignal,
  ): Promise<T> {
    const config = this.configs.get(channelId);
    if (!config) {
      throw new Error(`No OAuth configuration registered for channel "${channelId}"`);
    }
    const current = await this.loadCredentials(config);
    if (current.expires - this.now() > this.skewMs) {
      return current as T;
    }
    return this.refreshSerial<T>(config, current, signal);
  }

  private async refreshSerial<T extends OAuthSubscriptionCredentials>(
    config: RegisteredOAuthChannel,
    fallback: OAuthSubscriptionCredentials,
    signal?: AbortSignal,
  ): Promise<T> {
    const currentGen = this.fence.generation(config.channelId);
    const existing = this.inflight.get(config.channelId);
    if (existing && existing.generation === currentGen) {
      return (await existing.promise) as T;
    }

    const lease = this.fence.acquire(config.channelId, signal);
    let inflightEntry:
      | { readonly generation: number; readonly promise: Promise<OAuthSubscriptionCredentials> }
      | undefined;
    const refreshPromise = (async (): Promise<OAuthSubscriptionCredentials> => {
      try {
        const latest = this.cache.get(config.channelId) ?? fallback;
        if (latest.expires - this.now() > this.skewMs) {
          return latest;
        }
        lease.assertCurrent();
        const refreshed = await config.refresh(latest, lease.signal);
        lease.assertCurrent();
        await this.fence.writeIfCurrent(
          this.secretStore,
          config.channelId,
          config.secretRef,
          JSON.stringify(refreshed),
          lease.generation,
        );
        if (!lease.isCurrent()) {
          throw new SecretStoreUnavailableError(
            "SECRET_FENCE_STALE",
            `Channel "${config.channelId}" was invalidated during OAuth refresh`,
          );
        }
        this.cache.set(config.channelId, refreshed);
        return refreshed;
      } finally {
        lease.release();
        if (inflightEntry !== undefined && this.inflight.get(config.channelId) === inflightEntry) {
          this.inflight.delete(config.channelId);
        }
      }
    })();

    inflightEntry = { generation: lease.generation, promise: refreshPromise };
    this.inflight.set(config.channelId, inflightEntry);
    return (await refreshPromise) as T;
  }

  /**
   * Logout / delete a channel's OAuth credentials safely under the fencing token:
   * aborts any in-flight refresh, clears in-memory caches, and performs verified deletion
   * from the OS SecretStore.
   */
  async revokeAndDelete(
    channelId: string,
    secretRefOverride?: string,
    reason = "OAuth channel logout/deleted",
  ): Promise<number> {
    const config = this.configs.get(channelId);
    const secretRef = secretRefOverride ?? config?.secretRef;
    this.cache.delete(channelId);
    this.inflight.delete(channelId);
    if (!secretRef) {
      return this.fence.invalidate(channelId, reason);
    }
    return this.fence.deleteAndInvalidate(this.secretStore, channelId, secretRef, reason);
  }
}
