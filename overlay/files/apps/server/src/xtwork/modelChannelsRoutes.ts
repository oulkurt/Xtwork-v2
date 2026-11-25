// @effect-diagnostics nodeBuiltinImport:off globalDate:off globalDateInEffect:off globalJsonInEffect:off effectTryWithoutCatch:off globalErrorInEffectCatch:off globalErrorInEffectFailure:off effectFnOpportunity:off deterministicKeys:off matchBooleanToIsSuccess:off
/**
 * Xtwork Model Channels HTTP API Routes & Live-Pi Refresh Service (ADR-012 §2, §3.1–§3.4).
 *
 * Security Invariants:
 * - Every `/api/xtwork/channels/*` endpoint requires a valid Bearer token (cookies stripped).
 * - Read endpoints require `AuthOrchestrationReadScope`.
 * - Write & sensitive credential/auth endpoints require `AuthOrchestrationOperateScope` AND
 *   `session.subject === "desktop-bootstrap"`.
 * - Responses always set `Cache-Control: no-store` and NEVER include plaintext API keys,
 *   company `sk-` keys, or OAuth `access_token` / `refresh_token` values.
 */

import {
  AuthOrchestrationOperateScope,
  AuthOrchestrationReadScope,
  type ModelSelection,
} from "@t3tools/contracts";
import * as ByteSize from "effect/ByteSize";
import * as Context from "effect/Context";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Option from "effect/Option";
import * as Queue from "effect/Queue";
import { Headers, HttpRouter, HttpServerRequest, HttpServerResponse } from "effect/http";
import { EnvironmentAuth, parseBearerToken } from "../auth/EnvironmentAuth.ts";
import * as ServerConfig from "../config.ts";
import * as ProviderRegistry from "../provider/ProviderRegistry.ts";
import { forkParked } from "../serverActivation.ts";
import * as ServerSettings from "../serverSettings.ts";
import { PI_INHERIT_MODEL, PI_INSTANCE_ID } from "./bundledPiSettings.ts";
import {
  ChannelManager,
  type CatalogChangeEvent,
  type CreateChannelInput,
  type FetchChannelModelsInput,
  type TestChannelDirectInput,
  type UpdateChannelInput,
  type ZhipuTeamCredentialInput,
} from "./channelManager.ts";
import { COMPANY_CHANNEL_ID, MODEL_PROVIDER, STANDARD_MODEL } from "./gateway.ts";
import { redactSecretsFromText, type StartOAuthLoginInput } from "./oauthLoginFlows.ts";
import type { OAuthSubscriptionProvider } from "./oauthProxy.ts";
import {
  isOAuthProviderType,
  isProviderType,
  listProviderCatalogSpecs,
  PROVIDER_CATALOG_VERSION,
  type StoredChannelModel,
} from "./providerCatalog.ts";

export interface ModelChannelsService {
  readonly manager: ChannelManager;
  readonly reconcileNow: (event?: CatalogChangeEvent) => Effect.Effect<void>;
}

export class XtworkModelChannels extends Context.Service<
  XtworkModelChannels,
  ModelChannelsService
>()("t3/xtwork/modelChannelsRoutes/XtworkModelChannels") {}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function asNonEmptyString(value: unknown): string | undefined {
  return typeof value === "string" && value.trim().length > 0 ? value.trim() : undefined;
}

function parseZhipuTeam(value: unknown): ZhipuTeamCredentialInput | undefined {
  if (!isRecord(value)) return undefined;
  const apiKey = asNonEmptyString(value.apiKey);
  if (!apiKey) return undefined;
  const organization = asNonEmptyString(value.organization);
  const project = asNonEmptyString(value.project);
  return {
    apiKey,
    ...(organization ? { organization } : {}),
    ...(project ? { project } : {}),
  };
}

function parseStoredModels(value: unknown): StoredChannelModel[] | undefined {
  if (!Array.isArray(value)) return undefined;
  const models: StoredChannelModel[] = [];
  for (const item of value) {
    if (!isRecord(item) || typeof item.id !== "string" || !item.id.trim()) continue;
    const id = item.id.trim();
    const name = typeof item.name === "string" && item.name.trim() ? item.name.trim() : id;
    const source =
      item.source === "manual" || item.source === "fetched" || item.source === "preset"
        ? item.source
        : undefined;
    models.push({
      id,
      name,
      enabled: Boolean(item.enabled),
      ...(source ? { source } : {}),
    });
  }
  return models;
}

const jsonResponse = (value: unknown, status = 200) =>
  HttpServerResponse.jsonUnsafe(value ?? {}, {
    status,
    headers: { "cache-control": "no-store" },
  });

const errorResponse = (error: string, status: number, extra?: Record<string, unknown>) =>
  jsonResponse({ error: redactSecretsFromText(error), ...(extra ?? {}) }, status);

function mapActionError(error: unknown): {
  readonly status: number;
  readonly message: string;
  readonly code?: string;
} {
  const message = redactSecretsFromText(
    error instanceof Error ? error.message : String(error ?? "操作失败"),
  );
  const code = (error as { code?: string })?.code;
  if (code === "EADDRINUSE" || message.includes("49160")) {
    return { status: 409, message, code: "CALLBACK_PORT_IN_USE" };
  }
  if (message.includes("不支持修改") || message.includes("不支持直接删除")) {
    return { status: 403, message, code: "TEAM_CHANNEL_IMMUTABLE" };
  }
  if (message.includes("必须重新输入新的 API Key") || message.includes("必须重新认证")) {
    return { status: 400, message, code: "API_KEY_REQUIRED_ON_ENDPOINT_CHANGE" };
  }
  if (message.includes("不能使用已保存的渠道凭据")) {
    return { status: 400, message, code: "CREDENTIAL_TARGET_MISMATCH" };
  }
  if (message.includes("找不到模型渠道")) {
    return { status: 404, message, code: "CHANNEL_NOT_FOUND" };
  }
  if (message.includes("已保留当前") || message.includes("已中止并保留原状态")) {
    return { status: 500, message, code: "SECRET_DELETE_FAILED" };
  }
  if (message.includes("系统钥匙串")) {
    return { status: 503, message, code: "SECRET_STORE_UNAVAILABLE" };
  }
  return { status: 400, message };
}

/**
 * Compute smooth `defaultModelSelection` update for `xtworkPi` after a channel catalog change.
 * Never overwrites a valid selection on an external provider or another still-enabled `xtworkPi` model.
 */
export function computeReconciledDefaultSelection(
  current: ModelSelection | null | undefined,
  event: CatalogChangeEvent,
): ModelSelection | undefined {
  const fallbackSlug = event.defaultModelSlug;
  const legacyDevSlug = `${MODEL_PROVIDER}/${STANDARD_MODEL}`;

  if (!current) {
    return fallbackSlug ? { instanceId: PI_INSTANCE_ID, model: fallbackSlug } : undefined;
  }

  // Never touch external providers (Claude Code, Codex CLI, etc.).
  if (current.instanceId !== PI_INSTANCE_ID) {
    return undefined;
  }

  if (fallbackSlug === null) {
    // Zero-channel state: clear stale channel model selection back to inherit sentinel.
    if (current.model !== PI_INHERIT_MODEL && current.model !== legacyDevSlug) {
      return { instanceId: PI_INSTANCE_ID, model: PI_INHERIT_MODEL };
    }
    return undefined;
  }

  if (current.model === PI_INHERIT_MODEL) {
    return { instanceId: PI_INSTANCE_ID, model: fallbackSlug };
  }

  if (!event.enabledModelSlugs.includes(current.model)) {
    return { instanceId: PI_INSTANCE_ID, model: fallbackSlug };
  }

  return undefined;
}

const makeReconciler = (
  serverSettings: Option.Option<Context.Service.Shape<typeof ServerSettings.ServerSettingsService>>,
  providerRegistry: Option.Option<Context.Service.Shape<typeof ProviderRegistry.ProviderRegistry>>,
) =>
  Effect.fnUntraced(function* (event: CatalogChangeEvent) {
    if (Option.isSome(serverSettings)) {
      const settings = yield* serverSettings.value.getSettings.pipe(
        Effect.orElseSucceed(() => undefined),
      );
      if (settings) {
        const nextSelection = computeReconciledDefaultSelection(
          settings.defaultModelSelection,
          event,
        );
        if (nextSelection) {
          yield* serverSettings.value
            .updateSettings({ defaultModelSelection: nextSelection })
            .pipe(Effect.ignore);
        }
      }
    }
    if (Option.isSome(providerRegistry)) {
      yield* providerRegistry.value.refreshInstance(PI_INSTANCE_ID).pipe(Effect.ignore);
    }
  });

export const makeService = (options?: {
  readonly manager?: ChannelManager;
}) =>
  Effect.gen(function* () {
    const configOpt = yield* Effect.serviceOption(ServerConfig.ServerConfig);
    const settingsOpt = yield* Effect.serviceOption(ServerSettings.ServerSettingsService);
    const registryOpt = yield* Effect.serviceOption(ProviderRegistry.ProviderRegistry);

    const queue = yield* Queue.unbounded<CatalogChangeEvent>();
    let latestEvent: CatalogChangeEvent | undefined;
    const reconcile = makeReconciler(settingsOpt, registryOpt);

    const bundledPi = Option.isSome(settingsOpt) ? settingsOpt.value.bundledPi : undefined;

    const manager =
      options?.manager ??
      new ChannelManager({
        dataDir: Option.isSome(configOpt) ? configOpt.value.baseDir : process.cwd(),
        ...(bundledPi
          ? {
              secretStore: bundledPi.secretStore,
              fence: bundledPi.fence,
              oauthManager: bundledPi.oauthManager,
              gateway: bundledPi,
            }
          : {}),
        onCatalogChanged: (event) => {
          latestEvent = event;
          Queue.offerUnsafe(queue, event);
        },
      });

    yield* Effect.acquireRelease(
      Effect.promise(() => manager.initialize()).pipe(
        Effect.catchCause((cause) =>
          Effect.logWarning("Failed to initialize Xtwork model channels on startup", { cause }),
        ),
      ),
      () => Effect.promise(() => manager.close()).pipe(Effect.ignore),
    );

    // Drain asynchronous catalog updates (e.g. WeCom browser callback or OAuth device-code completion).
    yield* forkParked(
      Queue.take(queue).pipe(
        Effect.flatMap(reconcile),
        Effect.forever,
      ),
    );

    const reconcileNow = (event?: CatalogChangeEvent) =>
      Effect.gen(function* () {
        const target = event ?? latestEvent;
        if (!target) {
          const state = manager.getState();
          const enabledModelSlugs: string[] = [];
          for (const ch of state.channels) {
            if (!ch.enabled || !ch.hasCredentials) continue;
            for (const m of ch.models) {
              if (m.enabled) enabledModelSlugs.push(`${ch.id}/${m.id}`);
            }
          }
          yield* reconcile({
            revision: 0,
            defaultModelSlug: state.defaultModelSlug,
            zeroChannelState: state.zeroChannelState,
            enabledModelSlugs,
          });
          return;
        }
        yield* reconcile(target);
      });

    return { manager, reconcileNow } satisfies ModelChannelsService;
  });

export const layer = Layer.effect(XtworkModelChannels, makeService());

interface MappedActionFailure {
  readonly status: number;
  readonly message: string;
  readonly code?: string;
}

const tryPromiseAction = <A>(work: () => Promise<A>): Effect.Effect<A, MappedActionFailure> =>
  Effect.tryPromise({
    try: work,
    catch: mapActionError,
  });

export const serveModelChannels = Effect.fnUntraced(function* (service: ModelChannelsService) {
  const request = yield* HttpServerRequest.HttpServerRequest;
  if (parseBearerToken(request) === null) {
    return errorResponse("请先连接本机服务。", 401);
  }
  const auth = yield* EnvironmentAuth;
  const bearerOnly = request.modify({ headers: Headers.remove(request.headers, "cookie") });
  const session = yield* auth.authenticateHttpRequest(bearerOnly).pipe(Effect.option);
  if (Option.isNone(session)) {
    return errorResponse("请先连接本机服务。", 401);
  }

  const writing = request.method !== "GET";
  if (
    !session.value.scopes.includes(
      writing ? AuthOrchestrationOperateScope : AuthOrchestrationReadScope,
    ) ||
    (writing && session.value.subject !== "desktop-bootstrap")
  ) {
    return errorResponse("当前会话没有模型渠道管理权限。", 403);
  }

  const url = new URL(request.url, "http://localhost");
  const prefix = "/api/xtwork/channels/";
  const action = url.pathname.startsWith(prefix) ? url.pathname.slice(prefix.length) : "";

  if (!writing) {
    if (action === "state") {
      return jsonResponse(service.manager.getState());
    }
    if (action === "catalog") {
      return jsonResponse({
        catalogVersion: PROVIDER_CATALOG_VERSION,
        catalog: listProviderCatalogSpecs(),
      });
    }
    if (action === "company/status") {
      return jsonResponse({ companyAuth: service.manager.companyAuth.getState() });
    }
    if (action === "oauth/status") {
      const sessionId = url.searchParams.get("sessionId");
      if (sessionId) {
        const found = service.manager.getOAuthLoginSession(sessionId);
        if (!found) return errorResponse("找不到指定的 OAuth 登录会话。", 404);
        return jsonResponse({ session: found });
      }
      return jsonResponse({ sessions: service.manager.listOAuthLoginSessions() });
    }
    return errorResponse("找不到模型渠道接口。", 404);
  }

  // POST endpoints
  const rawBody = yield* request.json.pipe(
    Effect.provideService(HttpServerRequest.MaxBodySize, ByteSize.kibibytes(256)),
    Effect.option,
  );
  const body = Option.isSome(rawBody) && isRecord(rawBody.value) ? rawBody.value : {};

  if (action === "create") {
    const provider = body.provider;
    if (!isProviderType(provider) || provider === "company-team") {
      return errorResponse("不支持的模型渠道类型。", 400);
    }
    const id = asNonEmptyString(body.id);
    const zhipuTeam = parseZhipuTeam(body.zhipuTeam);
    const models = parseStoredModels(body.models);
    const input: CreateChannelInput = {
      ...(id ? { id } : {}),
      name: asNonEmptyString(body.name) ?? "",
      provider,
      ...(typeof body.baseUrl === "string" ? { baseUrl: body.baseUrl } : {}),
      ...(typeof body.apiKey === "string" ? { apiKey: body.apiKey } : {}),
      ...(zhipuTeam ? { zhipuTeam } : {}),
      ...(typeof body.enabled === "boolean" ? { enabled: body.enabled } : {}),
      ...(models ? { models } : {}),
      ...(typeof body.enterpriseUrl === "string" ? { enterpriseUrl: body.enterpriseUrl } : {}),
    };
    return yield* tryPromiseAction(() => service.manager.createChannel(input)).pipe(
      Effect.tap(() => service.reconcileNow()),
      Effect.match({
        onSuccess: (channel) => jsonResponse({ channel, state: service.manager.getState() }),
        onFailure: (mapped) =>
          errorResponse(mapped.message, mapped.status, mapped.code ? { code: mapped.code } : undefined),
      }),
    );
  }

  if (action === "update") {
    const channelId = asNonEmptyString(body.id ?? body.channelId);
    if (!channelId) return errorResponse("缺少渠道 ID。", 400);
    const zhipuTeam = parseZhipuTeam(body.zhipuTeam);
    const models = parseStoredModels(body.models);
    const patch: UpdateChannelInput = {
      ...(typeof body.name === "string" ? { name: body.name } : {}),
      ...(isProviderType(body.provider) ? { provider: body.provider } : {}),
      ...(typeof body.baseUrl === "string" ? { baseUrl: body.baseUrl } : {}),
      ...(typeof body.apiKey === "string" ? { apiKey: body.apiKey } : {}),
      ...(zhipuTeam ? { zhipuTeam } : {}),
      ...(typeof body.enabled === "boolean" ? { enabled: body.enabled } : {}),
      ...(models ? { models } : {}),
      ...(typeof body.enterpriseUrl === "string" ? { enterpriseUrl: body.enterpriseUrl } : {}),
    };
    return yield* tryPromiseAction(() => service.manager.updateChannel(channelId, patch)).pipe(
      Effect.tap(() => service.reconcileNow()),
      Effect.match({
        onSuccess: (channel) => jsonResponse({ channel, state: service.manager.getState() }),
        onFailure: (mapped) =>
          errorResponse(mapped.message, mapped.status, mapped.code ? { code: mapped.code } : undefined),
      }),
    );
  }

  if (action === "delete") {
    const channelId = asNonEmptyString(body.id ?? body.channelId);
    if (!channelId) return errorResponse("缺少渠道 ID。", 400);
    if (channelId === COMPANY_CHANNEL_ID) {
      return errorResponse("公司团队渠道不支持直接删除，请通过「退出登录」断开公司账号。", 403, {
        code: "TEAM_CHANNEL_IMMUTABLE",
      });
    }
    return yield* tryPromiseAction(() => service.manager.deleteChannel(channelId)).pipe(
      Effect.tap(() => service.reconcileNow()),
      Effect.match({
        onSuccess: (state) => jsonResponse({ deleted: true, state }),
        onFailure: (mapped) =>
          errorResponse(mapped.message, mapped.status, mapped.code ? { code: mapped.code } : undefined),
      }),
    );
  }

  if (action === "test") {
    const channelId = asNonEmptyString(body.id ?? body.channelId);
    const provider = body.provider;
    if (channelId && !isProviderType(provider)) {
      return yield* tryPromiseAction(() => service.manager.testChannel(channelId)).pipe(
        Effect.match({
          onSuccess: (result) => jsonResponse(result),
          onFailure: (mapped) => errorResponse(mapped.message, mapped.status),
        }),
      );
    }
    if (!isProviderType(provider)) {
      return errorResponse("不支持的模型渠道类型。", 400);
    }
    const zhipuTeam = parseZhipuTeam(body.zhipuTeam);
    const modelId = asNonEmptyString(body.modelId);
    const models = parseStoredModels(body.models);
    const input: TestChannelDirectInput = {
      ...(channelId ? { channelId } : {}),
      provider,
      ...(typeof body.baseUrl === "string" ? { baseUrl: body.baseUrl } : {}),
      ...(typeof body.apiKey === "string" ? { apiKey: body.apiKey } : {}),
      ...(zhipuTeam ? { zhipuTeam } : {}),
      ...(modelId ? { modelId } : {}),
      ...(models ? { models } : {}),
    };
    return yield* tryPromiseAction(() => service.manager.testChannelDirect(input)).pipe(
      Effect.match({
        onSuccess: (result) => jsonResponse(result),
        onFailure: (mapped) => errorResponse(mapped.message, mapped.status),
      }),
    );
  }

  if (action === "fetch-models") {
    const provider = body.provider;
    if (!isProviderType(provider)) {
      return errorResponse("不支持的模型渠道类型。", 400);
    }
    const channelId = asNonEmptyString(body.id ?? body.channelId);
    const zhipuTeam = parseZhipuTeam(body.zhipuTeam);
    const input: FetchChannelModelsInput = {
      ...(channelId ? { channelId } : {}),
      provider,
      ...(typeof body.baseUrl === "string" ? { baseUrl: body.baseUrl } : {}),
      ...(typeof body.apiKey === "string" ? { apiKey: body.apiKey } : {}),
      ...(zhipuTeam ? { zhipuTeam } : {}),
    };
    return yield* tryPromiseAction(() => service.manager.fetchChannelModels(input)).pipe(
      Effect.match({
        onSuccess: (result) => jsonResponse(result),
        onFailure: (mapped) => errorResponse(mapped.message, mapped.status),
      }),
    );
  }

  if (action === "quota") {
    const channelId = asNonEmptyString(body.id ?? body.channelId);
    if (!channelId) return errorResponse("缺少渠道 ID。", 400);
    return yield* tryPromiseAction(() => service.manager.getChannelPlanQuota(channelId)).pipe(
      Effect.match({
        onSuccess: (quota) => jsonResponse({ quota }),
        onFailure: (mapped) => errorResponse(mapped.message, mapped.status),
      }),
    );
  }

  if (action === "company/login") {
    return yield* tryPromiseAction(() => service.manager.startCompanyLogin()).pipe(
      Effect.match({
        onSuccess: (result) => jsonResponse(result),
        onFailure: (mapped) =>
          errorResponse(mapped.message, mapped.status, mapped.code ? { code: mapped.code } : undefined),
      }),
    );
  }

  if (action === "company/cancel") {
    const companyAuth = service.manager.cancelCompanyLogin();
    return jsonResponse({ companyAuth });
  }

  if (action === "company/sync") {
    const selectDefault = body.selectDefault === true;
    return yield* tryPromiseAction(() => service.manager.syncCompanyModels(selectDefault)).pipe(
      Effect.tap(() => service.reconcileNow()),
      Effect.match({
        onSuccess: (result) => jsonResponse({ ...result, state: service.manager.getState() }),
        onFailure: (mapped) => errorResponse(mapped.message, mapped.status),
      }),
    );
  }

  if (action === "company/logout") {
    return yield* tryPromiseAction(() => service.manager.logoutCompany()).pipe(
      Effect.tap(() => service.reconcileNow()),
      Effect.match({
        onSuccess: (state) => jsonResponse({ loggedOut: true, state }),
        onFailure: (mapped) =>
          errorResponse(mapped.message, mapped.status, mapped.code ? { code: mapped.code } : undefined),
      }),
    );
  }

  if (action === "oauth/start") {
    const provider = body.provider;
    if (!isProviderType(provider) || !isOAuthProviderType(provider)) {
      return errorResponse("该渠道类型不支持 OAuth 订阅登录。", 400);
    }
    const method =
      body.method === "browser" || body.method === "device_code" ? body.method : undefined;
    const channelId = asNonEmptyString(body.channelId);
    if (channelId === COMPANY_CHANNEL_ID) {
      return errorResponse("公司团队渠道不支持修改，不能使用 OAuth 订阅登录覆盖。", 403, {
        code: "TEAM_CHANNEL_IMMUTABLE",
      });
    }
    const channelName = asNonEmptyString(body.channelName);
    const enterpriseUrl = asNonEmptyString(body.enterpriseUrl);
    const input: StartOAuthLoginInput = {
      provider,
      ...(channelId ? { channelId } : {}),
      ...(channelName ? { channelName } : {}),
      ...(method ? { method } : {}),
      ...(enterpriseUrl ? { enterpriseUrl } : {}),
    };
    return yield* tryPromiseAction(() => service.manager.startOAuthLogin(input)).pipe(
      Effect.match({
        onSuccess: (sessionView) => jsonResponse({ session: sessionView }),
        onFailure: (mapped) => errorResponse(mapped.message, mapped.status),
      }),
    );
  }

  if (action === "oauth/submit-callback") {
    const sessionId = asNonEmptyString(body.sessionId);
    const input = asNonEmptyString(body.input ?? body.callbackUrl ?? body.code);
    if (!sessionId || !input) {
      return errorResponse("缺少会话 ID 或回调内容。", 400);
    }
    const accepted = service.manager.submitOAuthManualCallback(sessionId, input);
    if (!accepted) {
      return errorResponse("该 OAuth 登录会话不支持手动回调或已结束。", 409);
    }
    return jsonResponse({ accepted: true });
  }

  if (action === "oauth/cancel") {
    const sessionId = asNonEmptyString(body.sessionId);
    const provider =
      isProviderType(body.provider) && isOAuthProviderType(body.provider)
        ? (body.provider as OAuthSubscriptionProvider)
        : undefined;
    return yield* tryPromiseAction(() =>
      service.manager.cancelOAuthLoginAndWait(sessionId, provider),
    ).pipe(
      Effect.match({
        onSuccess: (sessions) => jsonResponse({ sessions }),
        onFailure: (mapped) => errorResponse(mapped.message, mapped.status),
      }),
    );
  }

  if (action === "oauth/logout") {
    const channelId = asNonEmptyString(body.id ?? body.channelId);
    if (!channelId) return errorResponse("缺少渠道 ID。", 400);
    return yield* tryPromiseAction(() => service.manager.logoutOAuthChannel(channelId)).pipe(
      Effect.tap(() => service.reconcileNow()),
      Effect.match({
        onSuccess: (channel) => jsonResponse({ channel, state: service.manager.getState() }),
        onFailure: (mapped) =>
          errorResponse(mapped.message, mapped.status, mapped.code ? { code: mapped.code } : undefined),
      }),
    );
  }

  return errorResponse("找不到模型渠道操作。", 404);
});

export const route = Layer.unwrap(
  Effect.map(XtworkModelChannels, (service) =>
    Layer.mergeAll(
      HttpRouter.add("GET", "/api/xtwork/channels/*", serveModelChannels(service)),
      HttpRouter.add("POST", "/api/xtwork/channels/*", serveModelChannels(service)),
    ),
  ),
);
