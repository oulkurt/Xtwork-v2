// @effect-diagnostics nodeBuiltinImport:off globalFetch:off globalDate:off -- Company WeCom OIDC + PKCE auth service uses Node crypto, http, and fetch.
/**
 * Company Team Channel — WeCom OIDC + PKCE Authentication Service (ADR-012 §3.2).
 *
 * Security Invariants:
 * - Long-lived `sk-` API keys & OIDC `refresh_token` are stored ONLY in the hardened OS SecretStore
 *   (`app.xtwork.model-channels`, ref `company:xiaotong-work-team`), protected by `ChannelCredentialFence`.
 * - ZERO plaintext secrets in channels.json, models.json, logs, errors, or renderer payloads.
 * - Pure Node `crypto` RS256 JWKS signature & claims verification (`iss`, `aud`, `azp`, `nonce`, `exp`, `nbf`).
 * - Loopback callback server binds ONLY `127.0.0.1:49160` and `[::1]:49160`, validates `Host`, `state`,
 *   single `code`, returns `no-store` / `no-referrer` / nonce CSP + `history.replaceState` URL scrubbing,
 *   and closes immediately upon completion, timeout, or cancel.
 * - Logout runs read-back verified `SecretStore.delete` FIRST; if delete fails, logged-in state is
 *   preserved and an explicit error is returned.
 */

import { createHash, createPublicKey, randomBytes, verify as cryptoVerify, type JsonWebKey } from "node:crypto";
import { createServer, type IncomingMessage, type RequestListener, type Server, type ServerResponse } from "node:http";
import { COMPANY_CHANNEL_ID, COMPANY_DEFAULT_MODEL_ID } from "./gateway.ts";
import {
  canonicalizeModelId,
  isAgentCapableModelId,
  type StoredChannelModel,
} from "./providerCatalog.ts";
import {
  ChannelCredentialFence,
  SecretStoreUnavailableError,
  type SecretStore,
} from "./secretStore.ts";

export const COMPANY_ISSUER = "https://llm-api.sci-it.com/keycloak/realms/sci-it";
export const COMPANY_API_BASE = "https://llm-api.sci-it.com";
export const COMPANY_CLIENT_ID = "xiaotong-work";
export const COMPANY_CALLBACK_PORT = 49160;
export const COMPANY_REDIRECT_URI = `http://localhost:${COMPANY_CALLBACK_PORT}/callback`;
export const COMPANY_SECRET_REF = "company:xiaotong-work-team";

const MAX_RESPONSE_BYTES = 256 * 1024;
const DEFAULT_LOGIN_TIMEOUT_MS = 300_000;
const DEFAULT_REQUEST_TIMEOUT_MS = 30_000;
const REVOKE_TIMEOUT_MS = 5_000;
const CLOCK_TOLERANCE_SECONDS = 5;

export interface CompanyMember {
  readonly subject: string;
  readonly name: string;
  readonly userId: number;
  readonly username: string;
}

export type CompanyAuthPhase = "signed-out" | "waiting" | "connecting" | "signed-in";

/** Redacted company auth snapshot safe to expose to renderer / HTTP API. Never contains apiKey or refreshToken. */
export interface CompanyAuthState {
  readonly revision: number;
  readonly phase: CompanyAuthPhase;
  readonly member?: CompanyMember;
  readonly authUrl?: string;
  readonly error?: string;
}

export interface CompanyStoredCredentials {
  readonly apiKey: string;
  readonly refreshToken?: string;
  readonly member: CompanyMember;
}

export type CompanyUrlValidator = (url: URL, expectedOrigin: string) => void;

export interface CompanyAuthServiceOptions {
  readonly secretStore: SecretStore;
  readonly fence?: ChannelCredentialFence;
  readonly issuer?: string;
  readonly apiBase?: string;
  readonly clientId?: string;
  readonly redirectUri?: string;
  readonly fetchImpl?: typeof fetch;
  readonly validateUrl?: CompanyUrlValidator;
  readonly loginTimeoutMs?: number;
  readonly requestTimeoutMs?: number;
  readonly now?: () => number;
  readonly openBrowser?: (url: string) => void | Promise<void>;
  readonly onCallbackReceived?: () => void;
  readonly onStateChange?: (state: CompanyAuthState) => void;
  readonly onModelsSynced?: (models: readonly StoredChannelModel[], selectDefault: boolean) => void | Promise<void>;
  readonly onLoggedOut?: () => void | Promise<void>;
}

/** Format Keycloak Han Chinese names as `familyName + givenName`, preserving non-Han names as-is. */
export function formatCompanyMemberName(
  name: string,
  givenName?: unknown,
  familyName?: unknown,
): string {
  const han = /^\p{Script=Han}+$/u;
  if (
    typeof givenName === "string" &&
    typeof familyName === "string" &&
    han.test(givenName.trim()) &&
    han.test(familyName.trim())
  ) {
    return familyName.trim() + givenName.trim();
  }
  const legacy = /^(\p{Script=Han}+)\s+(\p{Script=Han}+)$/u.exec(name.trim());
  return legacy ? `${legacy[2]!}${legacy[1]!}` : name.trim();
}

export function assertStrictCompanyHttpsUrl(url: URL, expectedOrigin: string): void {
  if (url.protocol !== "https:" || url.username || url.password || url.hash) {
    throw new Error("公司认证接口地址必须是合法的 HTTPS URL。");
  }
  const expected = new URL(expectedOrigin);
  if (url.origin !== expected.origin) {
    throw new Error("公司认证请求目标不在允许的域名范围内。");
  }
}

async function readBoundedText(response: Response, maxBytes = MAX_RESPONSE_BYTES): Promise<string> {
  if (!response.body) {
    const text = await response.text();
    if (Buffer.byteLength(text, "utf8") > maxBytes) {
      throw new Error("服务端响应体积超出安全限制。");
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
        throw new Error("服务端响应体积超出安全限制。");
      }
      chunks.push(Buffer.from(value.buffer, value.byteOffset, value.byteLength));
    }
  } finally {
    reader.releaseLock();
  }
  return Buffer.concat(chunks, total).toString("utf8");
}

/** Never echo raw HTTP error bodies (which could contain tokens or sensitive fields). */
async function readCompanyJson(response: Response, operation: string): Promise<unknown> {
  if (!response.ok) {
    await response.body?.cancel().catch(() => undefined);
    if (response.status === 401) throw new Error("公司登录已失效，请重新扫码登录。");
    if (response.status === 403) throw new Error("公司模型访问已被停用，请联系管理员。");
    if (response.status === 429) throw new Error("请求过于频繁，请稍后重试。");
    throw new Error(`${operation}失败（HTTP ${response.status}），请稍后重试。`);
  }
  const text = await readBoundedText(response);
  try {
    return JSON.parse(text) as unknown;
  } catch {
    throw new Error(`${operation}返回格式异常。`);
  }
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function decodeBase64UrlJson(segment: string): Record<string, unknown> {
  if (!/^[A-Za-z0-9_-]+$/.test(segment)) {
    throw new Error("Invalid base64url segment");
  }
  const decoded = Buffer.from(segment, "base64url").toString("utf8");
  const parsed = JSON.parse(decoded) as unknown;
  if (!isRecord(parsed)) {
    throw new Error("JWT segment must be a JSON object");
  }
  return parsed;
}

export interface VerifiedIdTokenClaims {
  readonly sub: string;
  readonly name: string;
  readonly nonce: string;
}

/**
 * Pure Node `crypto` JWKS RS256 JWT verification with strict `iss`, `aud`, `azp`, `nonce`, `exp`, `iat`, `nbf` checks.
 */
export function verifyOidcIdToken(
  idToken: string,
  jwks: { readonly keys: readonly Record<string, unknown>[] },
  options: {
    readonly issuer: string;
    readonly audience: string;
    readonly nonce: string;
    readonly nowMs?: number;
    readonly clockToleranceSec?: number;
  },
): VerifiedIdTokenClaims {
  const parts = idToken.split(".");
  if (parts.length !== 3 || !parts[0] || !parts[1] || !parts[2]) {
    throw new Error("公司身份校验失败，请重新扫码。");
  }
  const [rawHeader, rawPayload, rawSignature] = parts;
  let header: Record<string, unknown>;
  let payload: Record<string, unknown>;
  try {
    header = decodeBase64UrlJson(rawHeader);
    payload = decodeBase64UrlJson(rawPayload);
  } catch {
    throw new Error("公司身份校验失败，请重新扫码。");
  }

  if (header.alg !== "RS256") {
    throw new Error("公司身份校验失败，请重新扫码。");
  }
  const kid = typeof header.kid === "string" && header.kid.length > 0 ? header.kid : undefined;

  const candidateKeys = jwks.keys.filter((key) => {
    if (!isRecord(key) || key.kty !== "RSA") return false;
    if (key.use !== undefined && key.use !== "sig") return false;
    if (key.alg !== undefined && key.alg !== "RS256") return false;
    if (kid !== undefined && key.kid !== kid) return false;
    return typeof key.n === "string" && typeof key.e === "string";
  });
  if (candidateKeys.length === 0) {
    throw new Error("公司身份校验失败，请重新扫码。");
  }

  const signingInput = Buffer.from(`${rawHeader}.${rawPayload}`, "utf8");
  const signature = Buffer.from(rawSignature, "base64url");
  if (signature.byteLength === 0) {
    throw new Error("公司身份校验失败，请重新扫码。");
  }

  let verified = false;
  for (const jwk of candidateKeys) {
    try {
      const publicKey = createPublicKey({ key: jwk as unknown as JsonWebKey, format: "jwk" });
      if (cryptoVerify("RSA-SHA256", signingInput, publicKey, signature)) {
        verified = true;
        break;
      }
    } catch {
      continue;
    }
  }
  if (!verified) {
    throw new Error("公司身份校验失败，请重新扫码。");
  }

  const nowSec = Math.floor((options.nowMs ?? Date.now()) / 1000);
  const tolerance = options.clockToleranceSec ?? CLOCK_TOLERANCE_SECONDS;

  if (payload.iss !== options.issuer) {
    throw new Error("公司身份校验失败，请重新扫码。");
  }

  const aud = payload.aud;
  const audMatches =
    aud === options.audience ||
    (Array.isArray(aud) && aud.some((entry) => entry === options.audience));
  if (!audMatches) {
    throw new Error("公司身份校验失败，请重新扫码。");
  }

  const azp = payload.azp;
  if (azp !== undefined && azp !== options.audience) {
    throw new Error("公司身份校验失败，请重新扫码。");
  }
  if (Array.isArray(aud) && aud.length > 1 && azp !== options.audience) {
    throw new Error("公司身份校验失败，请重新扫码。");
  }

  if (typeof payload.sub !== "string" || payload.sub.length === 0) {
    throw new Error("公司身份校验失败，请重新扫码。");
  }
  if (payload.nonce !== options.nonce) {
    throw new Error("公司身份校验失败，请重新扫码。");
  }
  if (typeof payload.exp !== "number" || !Number.isFinite(payload.exp) || payload.exp <= nowSec - tolerance) {
    throw new Error("公司身份校验失败，请重新扫码。");
  }
  if (typeof payload.iat !== "number" || !Number.isFinite(payload.iat)) {
    throw new Error("公司身份校验失败，请重新扫码。");
  }
  if (payload.nbf !== undefined) {
    if (
      typeof payload.nbf !== "number" ||
      !Number.isFinite(payload.nbf) ||
      payload.nbf > nowSec + tolerance
    ) {
      throw new Error("公司身份校验失败，请重新扫码。");
    }
  }

  const formattedName = formatCompanyMemberName(
    typeof payload.name === "string" ? payload.name.trim() : "",
    payload.given_name,
    payload.family_name,
  );

  return {
    sub: payload.sub,
    name: formattedName,
    nonce: options.nonce,
  };
}

function parseStoredCredentials(raw: string): CompanyStoredCredentials {
  const parsed = JSON.parse(raw) as unknown;
  if (!isRecord(parsed)) throw new Error("Invalid company credentials payload");
  const apiKey = parsed.apiKey;
  const refreshToken = parsed.refreshToken;
  const member = parsed.member;
  if (typeof apiKey !== "string" || !apiKey.startsWith("sk-") || apiKey.length < 8) {
    throw new Error("Invalid company apiKey");
  }
  if (refreshToken !== undefined && (typeof refreshToken !== "string" || refreshToken.length === 0)) {
    throw new Error("Invalid company refreshToken");
  }
  if (
    !isRecord(member) ||
    typeof member.subject !== "string" ||
    member.subject.length === 0 ||
    typeof member.name !== "string" ||
    member.name.length === 0 ||
    typeof member.userId !== "number" ||
    !Number.isInteger(member.userId) ||
    member.userId <= 0 ||
    typeof member.username !== "string" ||
    member.username.length === 0
  ) {
    throw new Error("Invalid company member metadata");
  }
  return {
    apiKey,
    ...(refreshToken ? { refreshToken } : {}),
    member: {
      subject: member.subject,
      name: formatCompanyMemberName(member.name),
      userId: member.userId,
      username: member.username,
    },
  };
}

export function normalizeCompanyTeamModels(
  models: readonly StoredChannelModel[],
  options: { readonly selectDefault?: boolean; readonly previous?: readonly StoredChannelModel[] } = {},
): StoredChannelModel[] {
  const previousMap = new Map(
    (options.previous ?? []).map((m) => [canonicalizeModelId(COMPANY_CHANNEL_ID, m.id), m]),
  );
  const seen = new Set<string>();
  const normalized: StoredChannelModel[] = [];

  for (const model of models) {
    const id = canonicalizeModelId(COMPANY_CHANNEL_ID, model.id);
    if (!id || !isAgentCapableModelId(id) || seen.has(id)) continue;
    seen.add(id);
    const prev = previousMap.get(id);
    const enabled = options.selectDefault
      ? true
      : prev !== undefined
        ? prev.enabled
        : model.enabled;
    normalized.push({
      id,
      name: id === COMPANY_DEFAULT_MODEL_ID ? "DeepSeek Flash" : model.name || id,
      enabled,
      source: model.source ?? "fetched",
    });
  }

  // Prioritize default `deepseek-flash` first so default selection & UI display stay deterministic.
  const defaultIdx = normalized.findIndex((m) => m.id === COMPANY_DEFAULT_MODEL_ID);
  if (defaultIdx > 0) {
    const [defaultEntry] = normalized.splice(defaultIdx, 1);
    normalized.unshift(defaultEntry!);
  }
  return normalized;
}

interface LoopbackCallbackHandle {
  readonly codePromise: Promise<string>;
  readonly close: () => Promise<void>;
}

async function startCompanyCallbackServer(params: {
  readonly redirectUri: string;
  readonly state: string;
  readonly nonce: string;
  readonly signal: AbortSignal;
}): Promise<LoopbackCallbackHandle> {
  const redirect = new URL(params.redirectUri);
  const port = Number(redirect.port);
  if (!Number.isInteger(port) || port <= 0 || port > 65535) {
    throw new Error("公司登录回调端口配置无效。");
  }
  const expectedHost = redirect.host;
  const expectedPath = redirect.pathname;

  let settled = false;
  let resolveCode!: (code: string) => void;
  let rejectCode!: (error: Error) => void;
  const codePromise = new Promise<string>((resolve, reject) => {
    resolveCode = resolve;
    rejectCode = reject;
  });
  void codePromise.catch(() => undefined);

  const handleRequest: RequestListener = (req: IncomingMessage, res: ServerResponse) => {
    res.setHeader("Cache-Control", "no-store");
    res.setHeader("Referrer-Policy", "no-referrer");
    res.setHeader(
      "Content-Security-Policy",
      `default-src 'none'; script-src 'nonce-${params.nonce}'; frame-ancestors 'none'`,
    );

    if (req.method !== "GET" || req.headers.host !== expectedHost) {
      res.writeHead(400, { "Content-Type": "text/plain; charset=utf-8" });
      res.end("Invalid callback");
      return;
    }

    let url: URL;
    try {
      url = new URL(req.url ?? "/", params.redirectUri);
    } catch {
      res.writeHead(400, { "Content-Type": "text/plain; charset=utf-8" });
      res.end("Invalid callback");
      return;
    }

    if (url.pathname === "/complete") {
      res.writeHead(200, { "Content-Type": "text/plain; charset=utf-8" });
      res.end("已收到登录结果，请返回小瞳 Work。");
      return;
    }

    const search = url.searchParams;
    if (
      settled ||
      url.pathname !== expectedPath ||
      search.getAll("state").length !== 1 ||
      search.get("state") !== params.state
    ) {
      res.writeHead(400, { "Content-Type": "text/plain; charset=utf-8" });
      res.end("Invalid callback");
      return;
    }

    const hasError = search.has("error");
    const code = search.get("code");
    if (!hasError && (!code || search.getAll("code").length !== 1)) {
      res.writeHead(400, { "Content-Type": "text/plain; charset=utf-8" });
      res.end("Missing code");
      return;
    }

    settled = true;
    res.writeHead(200, { "Content-Type": "text/html; charset=utf-8" });
    res.end(
      `<!doctype html><meta charset="utf-8"><title>小瞳 Work</title>` +
        `<script nonce="${params.nonce}">history.replaceState(null,'','/complete')</script>` +
        `<p>已收到登录结果，请返回小瞳 Work。</p>`,
    );
    if (hasError) {
      rejectCode(new Error("企业微信授权未完成，请重新登录。"));
    } else {
      resolveCode(code!);
    }
  };

  const bindHosts =
    redirect.hostname === "localhost"
      ? (["127.0.0.1", "::1"] as const)
      : redirect.hostname === "::1" || redirect.hostname === "[::1]"
        ? (["::1"] as const)
        : (["127.0.0.1"] as const);

  const servers: Server[] = bindHosts.map(() => createServer(handleRequest));

  const closeAll = async (): Promise<void> => {
    await Promise.all(
      servers.map(
        (srv) =>
          new Promise<void>((resolveClose) => {
            if (!srv.listening) {
              resolveClose();
              return;
            }
            srv.close(() => resolveClose());
            srv.closeAllConnections();
          }),
      ),
    );
  };

  const onAbort = () => {
    if (!settled) {
      settled = true;
      rejectCode(new Error("登录已取消或超时，请重新扫码。"));
    }
    void closeAll();
  };
  params.signal.addEventListener("abort", onAbort, { once: true });

  try {
    params.signal.throwIfAborted();
    await Promise.all(
      servers.map(
        (srv, idx) =>
          new Promise<void>((resolveBind, rejectBind) => {
            const host = bindHosts[idx]!;
            const onError = (err: NodeJS.ErrnoException) => {
              if (idx === 1 && (err.code === "EAFNOSUPPORT" || err.code === "EADDRNOTAVAIL")) {
                resolveBind();
                return;
              }
              if (err.code === "EADDRINUSE") {
                rejectBind(
                  new Error(
                    `登录回调端口 ${port} 已被占用（可能正在运行旧版小瞳 Work 或其他登录窗口），请关闭后重试。`,
                  ),
                );
                return;
              }
              rejectBind(
                new Error(`登录回调端口 ${port} 不可用，请关闭其他登录窗口后重试。`),
              );
            };
            srv.once("error", onError);
            srv.listen(port, host, () => {
              srv.off("error", onError);
              resolveBind();
            });
          }),
      ),
    );
  } catch (err) {
    params.signal.removeEventListener("abort", onAbort);
    await closeAll();
    throw err;
  }

  return {
    codePromise,
    close: async () => {
      params.signal.removeEventListener("abort", onAbort);
      await closeAll();
    },
  };
}

export class CompanyAuthService {
  private readonly secretStore: SecretStore;
  private readonly fence: ChannelCredentialFence;
  private readonly issuer: string;
  private readonly apiBase: string;
  private readonly clientId: string;
  private readonly redirectUri: string;
  private readonly fetchImpl: typeof fetch;
  private readonly validateUrl: CompanyUrlValidator;
  private readonly loginTimeoutMs: number;
  private readonly requestTimeoutMs: number;
  private readonly now: () => number;
  private readonly openBrowser: ((url: string) => void | Promise<void>) | undefined;
  private readonly onCallbackReceived: (() => void) | undefined;
  private readonly onStateChange: ((state: CompanyAuthState) => void) | undefined;
  private readonly onModelsSynced:
    | ((models: readonly StoredChannelModel[], selectDefault: boolean) => void | Promise<void>)
    | undefined;
  private readonly onLoggedOut: (() => void | Promise<void>) | undefined;

  private credentials: CompanyStoredCredentials | undefined;
  private state: CompanyAuthState = { revision: 0, phase: "signed-out" };
  private activeController: AbortController | undefined;
  private activeOperation: Promise<CompanyAuthState> | undefined;
  private activeAuthUrl: string | undefined;

  constructor(options: CompanyAuthServiceOptions) {
    this.secretStore = options.secretStore;
    this.fence = options.fence ?? new ChannelCredentialFence();
    this.issuer = (options.issuer ?? COMPANY_ISSUER).replace(/\/+$/, "");
    this.apiBase = (options.apiBase ?? COMPANY_API_BASE).replace(/\/+$/, "");
    this.clientId = options.clientId ?? COMPANY_CLIENT_ID;
    this.redirectUri = options.redirectUri ?? COMPANY_REDIRECT_URI;
    this.fetchImpl = options.fetchImpl ?? globalThis.fetch;
    this.validateUrl = options.validateUrl ?? assertStrictCompanyHttpsUrl;
    this.loginTimeoutMs = options.loginTimeoutMs ?? DEFAULT_LOGIN_TIMEOUT_MS;
    this.requestTimeoutMs = options.requestTimeoutMs ?? DEFAULT_REQUEST_TIMEOUT_MS;
    this.now = options.now ?? Date.now;
    this.openBrowser = options.openBrowser;
    this.onCallbackReceived = options.onCallbackReceived;
    this.onStateChange = options.onStateChange;
    this.onModelsSynced = options.onModelsSynced;
    this.onLoggedOut = options.onLoggedOut;
  }

  getState(): CompanyAuthState {
    return {
      ...this.state,
      ...(this.state.member ? { member: { ...this.state.member } } : {}),
    };
  }

  /** Internal server-only accessor for compiling gateway routes. Never expose over HTTP/IPC. */
  getApiKeyInternal(): string | undefined {
    return this.credentials?.apiKey;
  }

  getApiBase(): string {
    return this.apiBase;
  }

  validateEndpointUrl(url: string): void {
    this.validateUrl(url, this.apiBase);
  }

  isSignedIn(): boolean {
    return Boolean(this.credentials?.member && this.credentials.apiKey);
  }

  private publish(phase: CompanyAuthPhase, opts: { error?: string; authUrl?: string } = {}): CompanyAuthState {
    this.state = {
      revision: this.state.revision + 1,
      phase,
      ...(this.credentials?.member ? { member: { ...this.credentials.member } } : {}),
      ...(opts.authUrl ? { authUrl: opts.authUrl } : {}),
      ...(opts.error ? { error: opts.error } : {}),
    };
    const snapshot = this.getState();
    this.onStateChange?.(snapshot);
    return snapshot;
  }

  private assertOutbound(rawUrl: string, expectedOrigin: string): URL {
    const url = new URL(rawUrl);
    this.validateUrl(url, expectedOrigin);
    return url;
  }

  /** Load persisted company credentials from hardened OS SecretStore on startup. */
  async initialize(): Promise<CompanyAuthState> {
    this.credentials = undefined;
    try {
      if (this.secretStore.read) {
        const readResult = await this.secretStore.read(COMPANY_SECRET_REF);
        if (readResult.status === "missing") {
          return this.publish("signed-out");
        }
        if (readResult.status === "denied") {
          return this.publish("signed-out", {
            error: "系统钥匙串拒绝访问公司登录凭据，请授权钥匙串访问或重新登录。",
          });
        }
        if (readResult.status === "unavailable") {
          return this.publish("signed-out", {
            error: "系统钥匙串暂不可用，无法读取公司登录凭据。",
          });
        }
        this.credentials = parseStoredCredentials(readResult.value);
        return this.publish("signed-in");
      }
      const raw = await this.secretStore.get(COMPANY_SECRET_REF);
      if (!raw) {
        return this.publish("signed-out");
      }
      this.credentials = parseStoredCredentials(raw);
      return this.publish("signed-in");
    } catch (error) {
      this.credentials = undefined;
      if (error instanceof SecretStoreUnavailableError) {
        return this.publish("signed-out", {
          error:
            error.kind === "denied"
              ? "系统钥匙串拒绝访问公司登录凭据，请授权后重试。"
              : "系统钥匙串暂不可用，请检查系统凭据服务后重新登录。",
        });
      }
      return this.publish("signed-out", { error: "无法恢复公司登录，请重新扫码。" });
    }
  }

  /**
   * Start WeCom OIDC + PKCE login:
   * 1. Binds loopback callback listener on `127.0.0.1:49160` + `[::1]:49160` immediately (so port
   *    conflicts return an immediate, actionable error before opening any browser).
   * 2. Returns `{ state, authUrl }` so desktop UI can call `window.desktopBridge.openExternal(authUrl)`.
   * 3. Continues awaiting callback -> token exchange -> JWKS RS256 verify -> keycloak exchange ->
   *    fenced verified `SecretStore.set` -> `/v1/models` sync in the background.
   */
  async startLogin(): Promise<{ readonly state: CompanyAuthState; readonly authUrl: string }> {
    if (this.activeOperation && this.activeAuthUrl && this.state.phase === "waiting") {
      return { state: this.getState(), authUrl: this.activeAuthUrl };
    }
    if (this.credentials) {
      await this.syncModels(false);
      return { state: this.getState(), authUrl: "" };
    }

    const controller = new AbortController();
    this.activeController = controller;
    const lease = this.fence.acquire(COMPANY_SECRET_REF, controller.signal);
    const signal = AbortSignal.any([lease.signal, AbortSignal.timeout(this.loginTimeoutMs)]);

    const stateParam = randomBytes(32).toString("base64url");
    const nonce = randomBytes(32).toString("base64url");
    const verifier = randomBytes(32).toString("base64url");
    const challenge = createHash("sha256").update(verifier).digest("base64url");

    const authEndpoint = this.assertOutbound(
      `${this.issuer}/protocol/openid-connect/auth`,
      this.issuer,
    );
    authEndpoint.search = new URLSearchParams({
      client_id: this.clientId,
      redirect_uri: this.redirectUri,
      response_type: "code",
      scope: "openid profile email",
      state: stateParam,
      nonce,
      code_challenge: challenge,
      code_challenge_method: "S256",
      kc_idp_hint: "wecom-web",
      prompt: "login",
    }).toString();
    const authUrl = authEndpoint.toString();

    let callbackHandle: LoopbackCallbackHandle;
    try {
      callbackHandle = await startCompanyCallbackServer({
        redirectUri: this.redirectUri,
        state: stateParam,
        nonce,
        signal,
      });
    } catch (error) {
      lease.release();
      if (this.activeController === controller) this.activeController = undefined;
      const msg = error instanceof Error ? error.message : "无法启动本机登录回调服务。";
      this.publish("signed-out", { error: msg });
      throw error;
    }

    this.activeAuthUrl = authUrl;
    const waitingState = this.publish("waiting", { authUrl });

    if (this.openBrowser) {
      try {
        await this.openBrowser(authUrl);
      } catch {
        await callbackHandle.close();
        lease.release();
        if (this.activeController === controller) this.activeController = undefined;
        this.activeAuthUrl = undefined;
        const err = new Error("无法打开系统浏览器，请重试。");
        this.publish("signed-out", { error: err.message });
        throw err;
      }
    }

    let operation: Promise<CompanyAuthState> | undefined;
    operation = (async (): Promise<CompanyAuthState> => {
      try {
        const code = await callbackHandle.codePromise;
        await callbackHandle.close();
        signal.throwIfAborted();
        lease.assertCurrent();

        this.publish("connecting");
        this.onCallbackReceived?.();

        const tokenUrl = this.assertOutbound(
          `${this.issuer}/protocol/openid-connect/token`,
          this.issuer,
        );
        const tokenResp = await this.fetchImpl(tokenUrl, {
          method: "POST",
          headers: { "Content-Type": "application/x-www-form-urlencoded", Accept: "application/json" },
          body: new URLSearchParams({
            grant_type: "authorization_code",
            client_id: this.clientId,
            redirect_uri: this.redirectUri,
            code,
            code_verifier: verifier,
          }),
          redirect: "error",
          signal,
        });
        const tokenPayload = await readCompanyJson(tokenResp, "登录");
        if (
          !isRecord(tokenPayload) ||
          typeof tokenPayload.access_token !== "string" ||
          tokenPayload.access_token.length === 0 ||
          typeof tokenPayload.id_token !== "string" ||
          tokenPayload.id_token.length === 0
        ) {
          throw new Error("登录凭据格式异常。");
        }
        const accessToken = tokenPayload.access_token;
        const idToken = tokenPayload.id_token;
        const refreshToken =
          typeof tokenPayload.refresh_token === "string" && tokenPayload.refresh_token.length > 0
            ? tokenPayload.refresh_token
            : undefined;

        const jwksUrl = this.assertOutbound(
          `${this.issuer}/protocol/openid-connect/certs`,
          this.issuer,
        );
        const jwksResp = await this.fetchImpl(jwksUrl, {
          method: "GET",
          headers: { Accept: "application/json" },
          redirect: "error",
          signal,
        });
        const jwksPayload = await readCompanyJson(jwksResp, "身份校验");
        if (
          !isRecord(jwksPayload) ||
          !Array.isArray(jwksPayload.keys) ||
          jwksPayload.keys.length === 0
        ) {
          throw new Error("身份校验密钥格式异常。");
        }

        const verifiedClaims = verifyOidcIdToken(
          idToken,
          { keys: jwksPayload.keys as Record<string, unknown>[] },
          {
            issuer: this.issuer,
            audience: this.clientId,
            nonce,
            nowMs: this.now(),
          },
        );

        const exchangeUrl = this.assertOutbound(
          `${this.apiBase}/api/oauth/exchange/keycloak`,
          this.apiBase,
        );
        const exchangeResp = await this.fetchImpl(exchangeUrl, {
          method: "POST",
          headers: { Authorization: `Bearer ${accessToken}`, Accept: "application/json" },
          redirect: "error",
          signal,
        });
        const exchangePayload = await readCompanyJson(exchangeResp, "获取个人模型权限");
        if (
          !isRecord(exchangePayload) ||
          exchangePayload.success !== true ||
          !isRecord(exchangePayload.data) ||
          typeof exchangePayload.data.api_key !== "string" ||
          !exchangePayload.data.api_key.startsWith("sk-") ||
          exchangePayload.data.api_key.length < 8 ||
          typeof exchangePayload.data.user_id !== "number" ||
          !Number.isInteger(exchangePayload.data.user_id) ||
          exchangePayload.data.user_id <= 0 ||
          typeof exchangePayload.data.username !== "string" ||
          exchangePayload.data.username.length === 0
        ) {
          throw new Error("获取个人模型权限失败，请联系管理员。");
        }

        signal.throwIfAborted();
        lease.assertCurrent();

        const nextCreds: CompanyStoredCredentials = {
          apiKey: exchangePayload.data.api_key,
          ...(refreshToken ? { refreshToken } : {}),
          member: {
            subject: verifiedClaims.sub,
            name: verifiedClaims.name || exchangePayload.data.username,
            userId: exchangePayload.data.user_id,
            username: exchangePayload.data.username,
          },
        };

        await this.fence.writeIfCurrent(
          this.secretStore,
          COMPANY_SECRET_REF,
          COMPANY_SECRET_REF,
          JSON.stringify(nextCreds),
          lease.generation,
        );
        this.credentials = nextCreds;
        this.publish("connecting");

        // Sync models right after persisting credentials; if model sync fails, keep signed-in state with warning.
        try {
          await this.fetchAndApplyModels(signal, true, lease, nextCreds.apiKey);
          if (!lease.isCurrent() || !this.isSignedIn()) {
            return this.getState();
          }
          return this.publish("signed-in");
        } catch (syncErr) {
          if (!lease.isCurrent() || !this.isSignedIn()) {
            return this.getState();
          }
          const msg =
            syncErr instanceof Error ? syncErr.message : "已登录，但同步公司模型列表失败，请稍后刷新。";
          return this.publish("signed-in", { error: msg });
        }
      } catch (error) {
        const message = signal.aborted
          ? controller.signal.aborted
            ? undefined
            : "登录超时，请重新扫码。"
          : error instanceof SecretStoreUnavailableError
            ? error.kind === "denied"
              ? "系统钥匙串拒绝保存公司凭据，请授权后重试。"
              : "系统钥匙串暂不可用，无法安全保存公司登录凭据。"
            : error instanceof Error && !["TypeError", "AbortError"].includes(error.name)
              ? error.message
              : "无法连接公司登录服务，请检查网络后重试。";
        return this.publish(this.credentials ? "signed-in" : "signed-out", {
          ...(message ? { error: message } : {}),
        });
      } finally {
        await callbackHandle.close().catch(() => undefined);
        lease.release();
        if (this.activeController === controller) this.activeController = undefined;
        if (this.activeOperation === operation) this.activeOperation = undefined;
        this.activeAuthUrl = undefined;
      }
    })();

    this.activeOperation = operation;
    return { state: waitingState, authUrl };
  }

  /** Wait for an active login/sync background operation to finish (useful in tests & CLI). */
  async waitForActiveOperation(): Promise<CompanyAuthState> {
    if (this.activeOperation) return await this.activeOperation;
    return this.getState();
  }

  cancelLogin(): CompanyAuthState {
    if (this.activeController) {
      this.activeController.abort();
      this.activeController = undefined;
      this.activeAuthUrl = undefined;
      return this.publish(this.credentials ? "signed-in" : "signed-out");
    }
    return this.getState();
  }

  private async fetchAndApplyModels(
    signal: AbortSignal,
    selectDefault: boolean,
    lease?: { readonly isCurrent: () => boolean },
    apiKeyOverride?: string,
  ): Promise<readonly StoredChannelModel[]> {
    const apiKey = apiKeyOverride ?? this.credentials?.apiKey;
    if (!apiKey) throw new Error("请先使用企业微信登录。");
    const modelsUrl = this.assertOutbound(`${this.apiBase}/v1/models`, this.apiBase);
    const resp = await this.fetchImpl(modelsUrl, {
      method: "GET",
      headers: { Authorization: `Bearer ${apiKey}`, Accept: "application/json" },
      redirect: "error",
      signal,
    });
    const payload = await readCompanyJson(resp, "获取公司模型");
    if (!isRecord(payload) || !Array.isArray(payload.data)) {
      throw new Error("公司模型列表格式异常，请稍后刷新。");
    }
    const rawModels: StoredChannelModel[] = [];
    for (const item of payload.data) {
      if (isRecord(item) && typeof item.id === "string" && item.id.trim().length > 0) {
        const id = item.id.trim();
        rawModels.push({ id, name: id, enabled: true, source: "fetched" });
      }
    }
    signal.throwIfAborted();
    if ((lease && !lease.isCurrent()) || !this.isSignedIn()) {
      return [];
    }
    const models = normalizeCompanyTeamModels(rawModels, { selectDefault });
    await this.onModelsSynced?.(models, selectDefault);
    return models;
  }

  async syncModels(selectDefault = false): Promise<{
    readonly state: CompanyAuthState;
    readonly models: readonly StoredChannelModel[];
  }> {
    const lease = this.fence.acquire(COMPANY_SECRET_REF);
    try {
      const apiKey = this.credentials?.apiKey;
      if (!apiKey || !this.isSignedIn()) {
        const s = this.publish("signed-out", { error: "请先使用企业微信登录。" });
        return { state: s, models: [] };
      }
      const signal = AbortSignal.any([lease.signal, AbortSignal.timeout(this.requestTimeoutMs)]);
      this.publish("connecting");
      try {
        const models = await this.fetchAndApplyModels(signal, selectDefault, lease, apiKey);
        // Re-verify fence & signed-in state after await: if logout() invalidated the fence
        // while /v1/models was in flight, discard late results without reviving "signed-in"!
        if (!lease.isCurrent() || !this.isSignedIn()) {
          return { state: this.getState(), models: [] };
        }
        return { state: this.publish("signed-in"), models };
      } catch (error) {
        if (!lease.isCurrent() || !this.isSignedIn()) {
          return { state: this.getState(), models: [] };
        }
        const msg =
          error instanceof Error && !["TypeError", "AbortError"].includes(error.name)
            ? error.message
            : "无法连接公司模型服务，请检查网络后重试。";
        return { state: this.publish("signed-in", { error: msg }), models: [] };
      }
    } finally {
      lease.release();
    }
  }

  /**
   * Logout with read-back verified SecretStore deletion FIRST (ADR-012 §3.1 & §3.2):
   * - If SecretStore deletion fails, KEEP logged-in state & credentials and throw an explicit error!
   * - If SecretStore deletion succeeds, clear in-memory credentials, notify gateway/Pi to stop exposing
   *   `xiaotong-work-team`, and best-effort revoke OIDC `refresh_token` at Keycloak.
   */
  async logout(): Promise<CompanyAuthState> {
    this.cancelLogin();
    const previousRefreshToken = this.credentials?.refreshToken;

    try {
      await this.fence.deleteAndInvalidate(
        this.secretStore,
        COMPANY_SECRET_REF,
        COMPANY_SECRET_REF,
        "company account logout",
      );
    } catch (error) {
      const msg =
        error instanceof SecretStoreUnavailableError && error.kind === "denied"
          ? "系统钥匙串拒绝删除公司登录凭据，已保留当前登录状态，请授权后重试。"
          : "无法清除本机钥匙串中的公司登录凭据，已保留当前登录状态，请检查钥匙串后重试。";
      this.publish(this.credentials ? "signed-in" : "signed-out", { error: msg });
      throw new Error(msg, { cause: error });
    }

    this.credentials = undefined;
    let logoutHookError: unknown;
    try {
      await this.onLoggedOut?.();
    } catch (err) {
      logoutHookError = err;
    }
    const signedOutState = this.publish("signed-out");

    if (previousRefreshToken) {
      try {
        const revokeUrl = this.assertOutbound(
          `${this.issuer}/protocol/openid-connect/revoke`,
          this.issuer,
        );
        await this.fetchImpl(revokeUrl, {
          method: "POST",
          headers: { "Content-Type": "application/x-www-form-urlencoded" },
          body: new URLSearchParams({
            client_id: this.clientId,
            token: previousRefreshToken,
            token_type_hint: "refresh_token",
          }),
          redirect: "error",
          signal: AbortSignal.timeout(REVOKE_TIMEOUT_MS),
        });
      } catch {
        // Offline / best-effort revoke failure must NOT restore local credentials.
      }
    }

    if (logoutHookError !== undefined) {
      throw logoutHookError;
    }

    return signedOutState;
  }
}
