// @effect-diagnostics nodeBuiltinImport:off -- Pure capability matrix for Xtwork bundled Pi 1.5.2 model channels.
/**
 * Versioned 19-supplier Pi 1.5.2 capability matrix & gateway compiler (ADR-012 §3.3).
 *
 * Baseline contracts verified against Electron `xiaotong_work` (Pi 0.87.1) and statically
 * aligned with bundled Pi `1.5.2` (`@earendil-works/pi-ai` / `@earendil-works/pi-coding-agent`).
 * Each supplier carries an explicit verification tier so live-verified vs static entries stay auditable.
 */

import {
  CODING_PLAN_USER_AGENT,
  COMPANY_CHANNEL_ID,
  COMPANY_DEFAULT_MODEL_ID,
  extractZhipuCodingTeamApiToken,
  formatModelSlug,
  parseZhipuTeamCredentials,
  stripLegacyContextSuffix,
  type GatewayApiKind,
  type GatewayChannelConfig,
  type GatewayModelConfig,
  type GatewayProviderType,
  type ZhipuTeamCredentials,
} from "./gateway.ts";
import {
  CODEX_DEFAULT_UPSTREAM_BASE_URL,
  XAI_DEFAULT_UPSTREAM_BASE_URL,
  isCopilotModelPermitted,
  type OAuthSubscriptionCredentials,
  type OAuthSubscriptionProvider,
} from "./oauthProxy.ts";

export {
  CODING_PLAN_USER_AGENT,
  COMPANY_CHANNEL_ID,
  COMPANY_DEFAULT_MODEL_ID,
  extractZhipuCodingTeamApiToken,
  formatModelSlug,
  parseZhipuTeamCredentials,
  stripLegacyContextSuffix,
  type ZhipuTeamCredentials,
};

export const PROVIDER_CATALOG_VERSION = "pi-1.5.2-v1" as const;
export const PI_TARGET_VERSION = "1.5.2" as const;
export const COMPANY_TEAM_CHANNEL_NAME = "小瞳 Work 团队模型";
export const COMPANY_TEAM_BASE_URL = "https://llm-api.sci-it.com/v1";

export type VerificationTier =
  | "v2-verified"
  | "pi-1.5.2-static"
  | "electron-verified"
  | "pending-live-e2e";

export type MemberProviderType = Exclude<GatewayProviderType, "company-team" | "dev-fallback">;
export type ProviderType = Exclude<GatewayProviderType, "dev-fallback">;

export type AuthHeaderMode =
  | "x-api-key"
  | "bearer-only"
  | "api-key-header"
  | "google-api-key"
  | "zhipu-composite"
  | "oauth-codex"
  | "oauth-copilot"
  | "oauth-xai";

export type ProviderUrlMode = "base" | "full-endpoint" | "oauth-managed";
export type ProviderTestStrategy =
  | "models-get"
  | "messages-probe"
  | "zhipu-team-quota"
  | "google-models-get"
  | "oauth-session";

export interface PresetModelSpec {
  readonly id: string;
  readonly name: string;
  readonly enabled: boolean;
  readonly api?: GatewayApiKind;
  readonly reasoning?: boolean;
  readonly contextWindow?: number;
  readonly maxTokens?: number;
  readonly input?: readonly ("text" | "image")[];
}

export interface ProviderCapabilitySpec {
  readonly type: ProviderType;
  readonly labelZh: string;
  readonly labelEn: string;
  readonly category: "company" | "api" | "oauth" | "custom";
  readonly selectable: boolean;
  readonly api: GatewayApiKind;
  readonly defaultBaseUrl: string;
  readonly urlMode: ProviderUrlMode;
  readonly authMode: AuthHeaderMode;
  readonly requiresCodingPlanUserAgent: boolean;
  readonly supportsDeveloperRole: boolean;
  readonly supportsFetchModels: boolean;
  readonly supportsPlanQuota: boolean;
  readonly testStrategy: ProviderTestStrategy;
  readonly oauthProvider?: OAuthSubscriptionProvider;
  readonly verificationTier: VerificationTier;
  readonly verificationNote: string;
  readonly presetModels: readonly PresetModelSpec[];
}

export interface StoredChannelModel {
  readonly id: string;
  readonly name: string;
  readonly enabled: boolean;
  readonly source?: "manual" | "fetched" | "preset";
}

export interface CompilableChannelInput {
  readonly id: string;
  readonly name: string;
  readonly provider: ProviderType;
  readonly baseUrl: string;
  readonly enabled: boolean;
  readonly models: readonly StoredChannelModel[];
  readonly availableModelIds?: readonly string[];
  readonly userAgent?: string;
  readonly upstreamHeaders?: Readonly<Record<string, string>>;
}

export interface CompilableChannelCredentials {
  readonly apiKey?: string;
  readonly secretRef?: string;
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

export type GeminiThinkingLevel = "minimal" | "low" | "medium" | "high";

export interface GeminiModelCapability {
  readonly contextWindow: number;
  readonly maxOutputTokens: number;
  readonly thinkingLevels: readonly GeminiThinkingLevel[];
  readonly defaultThinkingLevel: GeminiThinkingLevel;
}

const ONE_MILLION = 1_000_000;
const DEFAULT_CONTEXT_WINDOW = 200_000;
const DEFAULT_MAX_TOKENS = 64_000;
const SIXTY_FOUR_K = 65_536;
const GLM_53_MAX_TOKENS = 131_072;
const VOLCENGINE_GLM_MAX_TOKENS = 128_000;
const MIMO_V26_MAX_TOKENS = 128_000;
const CODEX_MAX_TOKENS = 128_000;

const GEMINI_ALL_LEVELS = ["minimal", "low", "medium", "high"] as const;
const GEMINI_NO_MINIMAL_LEVELS = ["low", "medium", "high"] as const;

export const GEMINI_TEXT_MODEL_CAPABILITIES: Readonly<Record<string, GeminiModelCapability>> =
  Object.freeze({
    "gemini-3-flash-preview": {
      contextWindow: ONE_MILLION,
      maxOutputTokens: SIXTY_FOUR_K,
      thinkingLevels: GEMINI_ALL_LEVELS,
      defaultThinkingLevel: "high",
    },
    "gemini-3.1-pro": {
      contextWindow: ONE_MILLION,
      maxOutputTokens: SIXTY_FOUR_K,
      thinkingLevels: GEMINI_NO_MINIMAL_LEVELS,
      defaultThinkingLevel: "high",
    },
    "gemini-3.1-pro-preview": {
      contextWindow: ONE_MILLION,
      maxOutputTokens: SIXTY_FOUR_K,
      thinkingLevels: GEMINI_NO_MINIMAL_LEVELS,
      defaultThinkingLevel: "high",
    },
    "gemini-3.1-pro-preview-customtools": {
      contextWindow: ONE_MILLION,
      maxOutputTokens: SIXTY_FOUR_K,
      thinkingLevels: GEMINI_NO_MINIMAL_LEVELS,
      defaultThinkingLevel: "high",
    },
    "gemini-3.1-flash-lite": {
      contextWindow: ONE_MILLION,
      maxOutputTokens: SIXTY_FOUR_K,
      thinkingLevels: GEMINI_ALL_LEVELS,
      defaultThinkingLevel: "minimal",
    },
    "gemini-3.1-flash-lite-preview": {
      contextWindow: ONE_MILLION,
      maxOutputTokens: SIXTY_FOUR_K,
      thinkingLevels: GEMINI_ALL_LEVELS,
      defaultThinkingLevel: "minimal",
    },
    "gemini-3.5-flash": {
      contextWindow: ONE_MILLION,
      maxOutputTokens: SIXTY_FOUR_K,
      thinkingLevels: GEMINI_ALL_LEVELS,
      defaultThinkingLevel: "medium",
    },
    "gemini-3.5-flash-lite": {
      contextWindow: ONE_MILLION,
      maxOutputTokens: SIXTY_FOUR_K,
      thinkingLevels: GEMINI_ALL_LEVELS,
      defaultThinkingLevel: "minimal",
    },
    "gemini-3.6-flash": {
      contextWindow: ONE_MILLION,
      maxOutputTokens: SIXTY_FOUR_K,
      thinkingLevels: GEMINI_ALL_LEVELS,
      defaultThinkingLevel: "medium",
    },
    "gemini-3.7-flash": {
      contextWindow: ONE_MILLION,
      maxOutputTokens: SIXTY_FOUR_K,
      thinkingLevels: GEMINI_NO_MINIMAL_LEVELS,
      defaultThinkingLevel: "medium",
    },
    "gemini-3.8-flash": {
      contextWindow: ONE_MILLION,
      maxOutputTokens: SIXTY_FOUR_K,
      thinkingLevels: GEMINI_NO_MINIMAL_LEVELS,
      defaultThinkingLevel: "medium",
    },
  });

export function getGeminiModelCapability(modelId: string | undefined): GeminiModelCapability | undefined {
  const normalized = modelId?.trim().toLowerCase().replace(/^models\//, "");
  return normalized ? GEMINI_TEXT_MODEL_CAPABILITIES[normalized] : undefined;
}

export function normalizeGeminiThinkingLevel(
  modelId: string | undefined,
  level: GeminiThinkingLevel | undefined,
): GeminiThinkingLevel | undefined {
  const cap = getGeminiModelCapability(modelId);
  if (!cap) return level;
  return level && cap.thinkingLevels.includes(level) ? level : cap.defaultThinkingLevel;
}

/** Static Pi 1.5.2 Codex curated model catalog (verified against `@earendil-works/pi-ai` 1.5.2). */
export const CODEX_STATIC_MODELS: readonly PresetModelSpec[] = Object.freeze([
  {
    id: "gpt-6.1-sol",
    name: "GPT-6.1 Sol",
    enabled: true,
    api: "openai-codex-responses",
    reasoning: true,
    contextWindow: 500_000,
    maxTokens: CODEX_MAX_TOKENS,
    input: ["text", "image"],
  },
  {
    id: "gpt-6.1-terra",
    name: "GPT-6.1 Terra",
    enabled: true,
    api: "openai-codex-responses",
    reasoning: true,
    contextWindow: 500_000,
    maxTokens: CODEX_MAX_TOKENS,
    input: ["text", "image"],
  },
  {
    id: "gpt-6-astra",
    name: "GPT-6 Astra",
    enabled: true,
    api: "openai-codex-responses",
    reasoning: true,
    contextWindow: 372_000,
    maxTokens: CODEX_MAX_TOKENS,
    input: ["text", "image"],
  },
  {
    id: "gpt-6-sol",
    name: "GPT-6 Sol",
    enabled: true,
    api: "openai-codex-responses",
    reasoning: true,
    contextWindow: 372_000,
    maxTokens: CODEX_MAX_TOKENS,
    input: ["text", "image"],
  },
  {
    id: "gpt-6-luna",
    name: "GPT-6 Luna",
    enabled: true,
    api: "openai-codex-responses",
    reasoning: true,
    contextWindow: 372_000,
    maxTokens: CODEX_MAX_TOKENS,
    input: ["text", "image"],
  },
  {
    id: "gpt-5.6-sol",
    name: "GPT-5.6 Sol",
    enabled: true,
    api: "openai-codex-responses",
    reasoning: true,
    contextWindow: 372_000,
    maxTokens: CODEX_MAX_TOKENS,
    input: ["text", "image"],
  },
  {
    id: "gpt-5.6-terra",
    name: "GPT-5.6 Terra",
    enabled: true,
    api: "openai-codex-responses",
    reasoning: true,
    contextWindow: 372_000,
    maxTokens: CODEX_MAX_TOKENS,
    input: ["text", "image"],
  },
  {
    id: "gpt-5.6-luna",
    name: "GPT-5.6 Luna",
    enabled: true,
    api: "openai-codex-responses",
    reasoning: true,
    contextWindow: 372_000,
    maxTokens: CODEX_MAX_TOKENS,
    input: ["text", "image"],
  },
]);

/** Static Pi 1.5.2 GitHub Copilot model catalog (per-model native wire API preserved). */
export const GITHUB_COPILOT_STATIC_MODELS: readonly PresetModelSpec[] = Object.freeze([
  { id: "claude-sonnet-5", name: "Claude Sonnet 5", enabled: true, api: "anthropic-messages", reasoning: true, contextWindow: 1_000_000, maxTokens: 128_000, input: ["text", "image"] },
  { id: "claude-sonnet-5.5", name: "Claude Sonnet 5.5", enabled: true, api: "anthropic-messages", reasoning: true, contextWindow: 1_000_000, maxTokens: 128_000, input: ["text", "image"] },
  { id: "claude-sonnet-4.6", name: "Claude Sonnet 4.6", enabled: true, api: "anthropic-messages", reasoning: true, contextWindow: 1_000_000, maxTokens: 32_000, input: ["text", "image"] },
  { id: "claude-opus-5", name: "Claude Opus 5", enabled: true, api: "anthropic-messages", reasoning: true, contextWindow: 1_000_000, maxTokens: 128_000, input: ["text", "image"] },
  { id: "claude-opus-5.5", name: "Claude Opus 5.5", enabled: true, api: "anthropic-messages", reasoning: true, contextWindow: 1_000_000, maxTokens: 128_000, input: ["text", "image"] },
  { id: "claude-opus-4.8", name: "Claude Opus 4.8", enabled: true, api: "anthropic-messages", reasoning: true, contextWindow: 1_000_000, maxTokens: 128_000, input: ["text", "image"] },
  { id: "claude-fable-5", name: "Claude Fable 5", enabled: true, api: "anthropic-messages", reasoning: true, contextWindow: 1_000_000, maxTokens: 128_000, input: ["text", "image"] },
  { id: "claude-fable-5.1", name: "Claude Fable 5.1", enabled: true, api: "anthropic-messages", reasoning: true, contextWindow: 1_000_000, maxTokens: 128_000, input: ["text", "image"] },
  { id: "claude-haiku-4.5", name: "Claude Haiku 4.5", enabled: true, api: "anthropic-messages", reasoning: true, contextWindow: 200_000, maxTokens: 64_000, input: ["text", "image"] },
  { id: "claude-haiku-5.5", name: "Claude Haiku 5.5", enabled: true, api: "anthropic-messages", reasoning: true, contextWindow: 1_000_000, maxTokens: 128_000, input: ["text", "image"] },
  { id: "gpt-6.1-sol", name: "GPT-6.1 Sol", enabled: true, api: "openai-responses", reasoning: true, contextWindow: 1_050_000, maxTokens: 128_000, input: ["text", "image"] },
  { id: "gpt-6.1-terra", name: "GPT-6.1 Terra", enabled: true, api: "openai-responses", reasoning: true, contextWindow: 1_050_000, maxTokens: 128_000, input: ["text", "image"] },
  { id: "gpt-6-astra", name: "GPT-6 Astra", enabled: true, api: "openai-responses", reasoning: true, contextWindow: 1_000_000, maxTokens: 128_000, input: ["text", "image"] },
  { id: "gpt-6-sol", name: "GPT-6 Sol", enabled: true, api: "openai-responses", reasoning: true, contextWindow: 1_000_000, maxTokens: 128_000, input: ["text", "image"] },
  { id: "gpt-6-luna", name: "GPT-6 Luna", enabled: true, api: "openai-responses", reasoning: true, contextWindow: 1_000_000, maxTokens: 128_000, input: ["text", "image"] },
  { id: "gpt-5.6-sol", name: "GPT-5.6 Sol", enabled: true, api: "openai-responses", reasoning: true, contextWindow: 1_050_000, maxTokens: 128_000, input: ["text", "image"] },
  { id: "gpt-5.6-terra", name: "GPT-5.6 Terra", enabled: true, api: "openai-responses", reasoning: true, contextWindow: 1_050_000, maxTokens: 128_000, input: ["text", "image"] },
  { id: "gpt-5.6-luna", name: "GPT-5.6 Luna", enabled: true, api: "openai-responses", reasoning: true, contextWindow: 1_050_000, maxTokens: 128_000, input: ["text", "image"] },
  { id: "gpt-5.4-nano", name: "GPT-5.4 nano", enabled: true, api: "openai-responses", reasoning: true, contextWindow: 400_000, maxTokens: 128_000, input: ["text", "image"] },
  { id: "gpt-5.3-codex", name: "GPT-5.3 Codex", enabled: true, api: "openai-responses", reasoning: true, contextWindow: 1_000_000, maxTokens: 128_000, input: ["text", "image"] },
  { id: "gpt-4.1", name: "GPT-4.1", enabled: true, api: "openai-completions", reasoning: false, contextWindow: 128_000, maxTokens: 16_384, input: ["text", "image"] },
  { id: "gemini-3.8-flash", name: "Gemini 3.8 Flash", enabled: true, api: "openai-completions", reasoning: true, contextWindow: 1_000_000, maxTokens: 64_000, input: ["text", "image"] },
  { id: "gemini-4-argon", name: "Gemini 4 Argon", enabled: true, api: "openai-completions", reasoning: true, contextWindow: 1_048_576, maxTokens: 65_536, input: ["text", "image"] },
  { id: "kimi-k3", name: "Kimi K3", enabled: true, api: "openai-completions", reasoning: true, contextWindow: 1_048_576, maxTokens: 131_072, input: ["text", "image"] },
  { id: "grok-4.7", name: "Grok 4.7", enabled: true, api: "openai-responses", reasoning: true, contextWindow: 500_000, maxTokens: 128_000, input: ["text", "image"] },
  { id: "grok-4.6", name: "Grok 4.6", enabled: true, api: "openai-responses", reasoning: true, contextWindow: 500_000, maxTokens: 128_000, input: ["text", "image"] },
  { id: "grok-4.5", name: "Grok 4.5", enabled: true, api: "openai-responses", reasoning: true, contextWindow: 500_000, maxTokens: 128_000, input: ["text", "image"] },
  { id: "mai-code-1.1-flash", name: "MAI-Code-1.1-Flash", enabled: true, api: "openai-responses", reasoning: true, contextWindow: 256_000, maxTokens: 128_000, input: ["text", "image"] },
]);

/** Static Pi 1.5.2 xAI Grok OAuth model catalog. */
export const XAI_STATIC_MODELS: readonly PresetModelSpec[] = Object.freeze([
  { id: "grok-4.7", name: "Grok 4.7", enabled: true, api: "openai-responses", reasoning: true, contextWindow: 500_000, maxTokens: 128_000, input: ["text", "image"] },
  { id: "grok-4.6", name: "Grok 4.6", enabled: true, api: "openai-responses", reasoning: true, contextWindow: 500_000, maxTokens: 128_000, input: ["text", "image"] },
  { id: "grok-4.5", name: "Grok 4.5", enabled: true, api: "openai-responses", reasoning: true, contextWindow: 500_000, maxTokens: 128_000, input: ["text", "image"] },
  { id: "grok-4.3", name: "Grok 4.3", enabled: true, api: "openai-responses", reasoning: true, contextWindow: 1_000_000, maxTokens: 30_000, input: ["text", "image"] },
]);

export const COMPANY_TEAM_PRESET_MODELS: readonly PresetModelSpec[] = Object.freeze([
  { id: COMPANY_DEFAULT_MODEL_ID, name: "DeepSeek Flash", enabled: true },
  { id: "Kimi-k2.7-Code", name: "Kimi K2.7 Code", enabled: true },
  { id: "qwen3-32b", name: "Qwen3 32B", enabled: true },
  { id: "qwen3.5", name: "Qwen3.5", enabled: true },
  { id: "qwen3.5-instruct", name: "Qwen3.5 Instruct", enabled: true },
]);

const DEEPSEEK_PRESETS: readonly PresetModelSpec[] = Object.freeze([
  { id: "deepseek-v4-pro", name: "DeepSeek V4 Pro", enabled: true },
  { id: "deepseek-v4-flash", name: "DeepSeek V4 Flash", enabled: true },
  { id: "deepseek-flash", name: "DeepSeek Flash", enabled: true },
  { id: "deepseek-v4-flash-vision-exp", name: "DeepSeek V4 Flash Vision Exp", enabled: true },
]);

const KIMI_API_PRESETS: readonly PresetModelSpec[] = Object.freeze([
  { id: "kimi-k3", name: "Kimi K3", enabled: true },
  { id: "kimi-k2.6", name: "Kimi K2.6", enabled: true },
]);

const KIMI_CODING_PRESETS: readonly PresetModelSpec[] = Object.freeze([
  { id: "k3", name: "Kimi K3", enabled: true },
  { id: "kimi-for-coding", name: "Kimi for Coding", enabled: true },
]);

const ZHIPU_PRESETS: readonly PresetModelSpec[] = Object.freeze([
  { id: "glm-5.3", name: "GLM-5.3", enabled: true },
  { id: "glm-5.3-flash", name: "GLM-5.3-Flash", enabled: true },
  { id: "glm-5.3-flashx", name: "GLM-5.3-FlashX", enabled: true },
  { id: "glm-5.1", name: "GLM-5.1", enabled: false },
]);

const MINIMAX_PRESETS: readonly PresetModelSpec[] = Object.freeze([
  { id: "MiniMax-M3", name: "MiniMax-M3", enabled: true },
  { id: "MiniMax-M2.7", name: "MiniMax-M2.7", enabled: true },
]);

const XIAOMI_PRESETS: readonly PresetModelSpec[] = Object.freeze([
  { id: "mimo-v2.6-pro", name: "MiMo V2.6 Pro", enabled: true },
  { id: "mimo-v2.6-flash", name: "MiMo V2.6 Flash", enabled: true },
  { id: "mimo-v2.6-pro-ultraspeed", name: "MiMo V2.6 Pro UltraSpeed", enabled: false },
]);

const QWEN_TOKEN_PLAN_PRESETS: readonly PresetModelSpec[] = Object.freeze([
  { id: "qwen3.8-max-preview", name: "Qwen3.8 Max Preview", enabled: true },
  { id: "qwen3.7-max", name: "Qwen3.7 Max", enabled: true },
  { id: "qwen3.7-flash", name: "Qwen3.7 Flash", enabled: true },
  { id: "qwen3.6-flash", name: "Qwen3.6 Flash", enabled: true },
]);

const QWEN_ANTHROPIC_LEGACY_PRESETS: readonly PresetModelSpec[] = Object.freeze([
  { id: "qwen3.7-max", name: "Qwen3.7 Max", enabled: true },
  { id: "qwen3.7-plus", name: "Qwen3.7 Plus", enabled: true },
]);

/**
 * Complete versioned provider capability catalog for Pi 1.5.2 (ADR-012 §3.3).
 * Covers the Company Team Channel + all 19 named member suppliers + custom endpoints + legacy `qwen-anthropic`.
 */
export const PROVIDER_CATALOG: Readonly<Record<ProviderType, ProviderCapabilitySpec>> = Object.freeze({
  "company-team": {
    type: "company-team",
    labelZh: COMPANY_TEAM_CHANNEL_NAME,
    labelEn: "XiaoTong Work Team",
    category: "company",
    selectable: false,
    api: "openai-completions",
    defaultBaseUrl: COMPANY_TEAM_BASE_URL,
    urlMode: "base",
    authMode: "bearer-only",
    requiresCodingPlanUserAgent: false,
    supportsDeveloperRole: false,
    supportsFetchModels: true,
    supportsPlanQuota: false,
    testStrategy: "models-get",
    verificationTier: "electron-verified",
    verificationNote: "Keycloak OIDC + PKCE S256 -> /api/oauth/exchange/keycloak -> /v1/models (default deepseek-flash)",
    presetModels: COMPANY_TEAM_PRESET_MODELS,
  },
  anthropic: {
    type: "anthropic",
    labelZh: "Anthropic",
    labelEn: "Anthropic",
    category: "api",
    selectable: true,
    api: "anthropic-messages",
    defaultBaseUrl: "https://api.anthropic.com",
    urlMode: "base",
    authMode: "x-api-key",
    requiresCodingPlanUserAgent: false,
    supportsDeveloperRole: true,
    supportsFetchModels: true,
    supportsPlanQuota: false,
    testStrategy: "models-get",
    verificationTier: "v2-verified",
    verificationNote: "Native anthropic-messages via local gateway with x-api-key & Claude forceAdaptiveThinking",
    presetModels: [],
  },
  "anthropic-compatible": {
    type: "anthropic-compatible",
    labelZh: "Anthropic 兼容格式",
    labelEn: "Anthropic Compatible",
    category: "custom",
    selectable: true,
    api: "anthropic-messages",
    defaultBaseUrl: "",
    urlMode: "full-endpoint",
    authMode: "x-api-key",
    requiresCodingPlanUserAgent: false,
    supportsDeveloperRole: true,
    supportsFetchModels: true,
    supportsPlanQuota: false,
    testStrategy: "models-get",
    verificationTier: "electron-verified",
    verificationNote: "Custom full Anthropic messages endpoint with x-api-key header",
    presetModels: [],
  },
  openai: {
    type: "openai",
    labelZh: "OpenAI",
    labelEn: "OpenAI",
    category: "api",
    selectable: true,
    api: "openai-completions",
    defaultBaseUrl: "https://api.openai.com/v1",
    urlMode: "base",
    authMode: "bearer-only",
    requiresCodingPlanUserAgent: false,
    supportsDeveloperRole: true,
    supportsFetchModels: true,
    supportsPlanQuota: false,
    testStrategy: "models-get",
    verificationTier: "v2-verified",
    verificationNote: "Native openai-completions via local gateway with Bearer auth & reasoning_effort compat",
    presetModels: [],
  },
  "openai-responses": {
    type: "openai-responses",
    labelZh: "OpenAI Responses 格式",
    labelEn: "OpenAI Responses",
    category: "api",
    selectable: true,
    api: "openai-responses",
    defaultBaseUrl: "https://api.openai.com/v1",
    urlMode: "base",
    authMode: "bearer-only",
    requiresCodingPlanUserAgent: false,
    supportsDeveloperRole: true,
    supportsFetchModels: true,
    supportsPlanQuota: false,
    testStrategy: "models-get",
    verificationTier: "v2-verified",
    verificationNote: "Native /responses SSE passthrough & reasoning items via local gateway",
    presetModels: [],
  },
  "openai-codex": {
    type: "openai-codex",
    labelZh: "ChatGPT 订阅 (Codex)",
    labelEn: "ChatGPT Subscription (Codex)",
    category: "oauth",
    selectable: true,
    api: "openai-codex-responses",
    defaultBaseUrl: CODEX_DEFAULT_UPSTREAM_BASE_URL,
    urlMode: "oauth-managed",
    authMode: "oauth-codex",
    requiresCodingPlanUserAgent: false,
    supportsDeveloperRole: true,
    supportsFetchModels: true,
    supportsPlanQuota: true,
    testStrategy: "oauth-session",
    oauthProvider: "openai-codex",
    verificationTier: "v2-verified",
    verificationNote: "Proxy-Only OAuth PKCE/device-code + placeholder JWT + zstd SSE verified on Pi 1.5.2",
    presetModels: CODEX_STATIC_MODELS,
  },
  "github-copilot": {
    type: "github-copilot",
    labelZh: "GitHub Copilot 订阅",
    labelEn: "GitHub Copilot Subscription",
    category: "oauth",
    selectable: true,
    api: "openai-completions",
    defaultBaseUrl: "",
    urlMode: "oauth-managed",
    authMode: "oauth-copilot",
    requiresCodingPlanUserAgent: false,
    supportsDeveloperRole: true,
    supportsFetchModels: true,
    supportsPlanQuota: true,
    testStrategy: "oauth-session",
    oauthProvider: "github-copilot",
    verificationTier: "v2-verified",
    verificationNote: "Proxy-Only RFC 8628 device-code + server-side proxy-ep & availableModelIds allowlist verified on Pi 1.5.2",
    presetModels: GITHUB_COPILOT_STATIC_MODELS,
  },
  xai: {
    type: "xai",
    labelZh: "xAI 订阅 (Grok)",
    labelEn: "xAI Subscription (Grok)",
    category: "oauth",
    selectable: true,
    api: "openai-responses",
    defaultBaseUrl: XAI_DEFAULT_UPSTREAM_BASE_URL,
    urlMode: "oauth-managed",
    authMode: "oauth-xai",
    requiresCodingPlanUserAgent: false,
    supportsDeveloperRole: true,
    supportsFetchModels: true,
    supportsPlanQuota: false,
    testStrategy: "oauth-session",
    oauthProvider: "xai",
    verificationTier: "v2-verified",
    verificationNote: "Proxy-Only RFC 8628 device-code + single-flight fenced rotating refresh verified on Pi 1.5.2",
    presetModels: XAI_STATIC_MODELS,
  },
  deepseek: {
    type: "deepseek",
    labelZh: "DeepSeek",
    labelEn: "DeepSeek",
    category: "api",
    selectable: true,
    api: "anthropic-messages",
    defaultBaseUrl: "https://api.deepseek.com/anthropic",
    urlMode: "base",
    authMode: "x-api-key",
    requiresCodingPlanUserAgent: false,
    supportsDeveloperRole: true,
    supportsFetchModels: true,
    supportsPlanQuota: true,
    testStrategy: "messages-probe",
    verificationTier: "v2-verified",
    verificationNote: "Anthropic endpoint + gateway DeepSeek V4 thinking/output_config.effort rewrite + Flash vision",
    presetModels: DEEPSEEK_PRESETS,
  },
  google: {
    type: "google",
    labelZh: "Google",
    labelEn: "Google Gemini",
    category: "api",
    selectable: true,
    api: "google-generative-ai",
    defaultBaseUrl: "https://generativelanguage.googleapis.com",
    urlMode: "base",
    authMode: "google-api-key",
    requiresCodingPlanUserAgent: false,
    supportsDeveloperRole: true,
    supportsFetchModels: true,
    supportsPlanQuota: false,
    testStrategy: "google-models-get",
    verificationTier: "v2-verified",
    verificationNote: "Native google-generative-ai via gateway with /v1beta normalization & Gemini thinkingLevels",
    presetModels: [],
  },
  "kimi-api": {
    type: "kimi-api",
    labelZh: "Kimi API",
    labelEn: "Kimi API",
    category: "api",
    selectable: true,
    api: "anthropic-messages",
    defaultBaseUrl: "https://api.moonshot.cn/anthropic",
    urlMode: "base",
    authMode: "x-api-key",
    requiresCodingPlanUserAgent: false,
    supportsDeveloperRole: true,
    supportsFetchModels: true,
    supportsPlanQuota: false,
    testStrategy: "messages-probe",
    verificationTier: "electron-verified",
    verificationNote: "Anthropic messages on /anthropic, model discovery via /v1/models",
    presetModels: KIMI_API_PRESETS,
  },
  "kimi-coding": {
    type: "kimi-coding",
    labelZh: "Kimi Coding Plan",
    labelEn: "Kimi Coding Plan",
    category: "api",
    selectable: true,
    api: "anthropic-messages",
    defaultBaseUrl: "https://api.kimi.com/coding/v1",
    urlMode: "base",
    authMode: "bearer-only",
    requiresCodingPlanUserAgent: true,
    supportsDeveloperRole: true,
    supportsFetchModels: true,
    supportsPlanQuota: true,
    testStrategy: "models-get",
    verificationTier: "v2-verified",
    verificationNote: "Bearer-only Anthropic auth + Coding Plan User-Agent verified in gateway",
    presetModels: KIMI_CODING_PRESETS,
  },
  zhipu: {
    type: "zhipu",
    labelZh: "智谱 AI",
    labelEn: "Zhipu AI (GLM)",
    category: "api",
    selectable: true,
    api: "openai-completions",
    defaultBaseUrl: "https://open.bigmodel.cn/api/paas/v4",
    urlMode: "base",
    authMode: "bearer-only",
    requiresCodingPlanUserAgent: false,
    supportsDeveloperRole: false,
    supportsFetchModels: true,
    supportsPlanQuota: true,
    testStrategy: "models-get",
    verificationTier: "electron-verified",
    verificationNote: "OpenAI-compatible PAAS v4 with GLM-5.3 128K output & zai thinking/tool-stream compat",
    presetModels: ZHIPU_PRESETS,
  },
  "zhipu-coding": {
    type: "zhipu-coding",
    labelZh: "智谱 Coding Plan",
    labelEn: "Zhipu Coding Plan",
    category: "api",
    selectable: true,
    api: "anthropic-messages",
    defaultBaseUrl: "https://open.bigmodel.cn/api/anthropic",
    urlMode: "base",
    authMode: "bearer-only",
    requiresCodingPlanUserAgent: true,
    supportsDeveloperRole: true,
    supportsFetchModels: true,
    supportsPlanQuota: true,
    testStrategy: "models-get",
    verificationTier: "electron-verified",
    verificationNote: "Bearer-only Anthropic endpoint + Coding Plan User-Agent + [1m] suffix stripping",
    presetModels: ZHIPU_PRESETS,
  },
  "zhipu-coding-team": {
    type: "zhipu-coding-team",
    labelZh: "智谱 Coding Plan 团队版",
    labelEn: "Zhipu Coding Plan Team",
    category: "api",
    selectable: true,
    api: "anthropic-messages",
    defaultBaseUrl: "https://open.bigmodel.cn/api/anthropic",
    urlMode: "base",
    authMode: "zhipu-composite",
    requiresCodingPlanUserAgent: true,
    supportsDeveloperRole: true,
    supportsFetchModels: true,
    supportsPlanQuota: true,
    testStrategy: "zhipu-team-quota",
    verificationTier: "v2-verified",
    verificationNote: "Composite credential (apiKey; organization; project) extraction & Bearer-only Anthropic auth",
    presetModels: ZHIPU_PRESETS,
  },
  "doubao-api": {
    type: "doubao-api",
    labelZh: "火山引擎 API",
    labelEn: "Volcengine Ark API",
    category: "api",
    selectable: true,
    api: "openai-completions",
    defaultBaseUrl: "https://ark.cn-beijing.volces.com/api/v3",
    urlMode: "base",
    authMode: "bearer-only",
    requiresCodingPlanUserAgent: false,
    supportsDeveloperRole: false,
    supportsFetchModels: true,
    supportsPlanQuota: false,
    testStrategy: "models-get",
    verificationTier: "electron-verified",
    verificationNote: "OpenAI-compatible v3 with supportsDeveloperRole: false & GLM-5.x 128K output cap",
    presetModels: [],
  },
  minimax: {
    type: "minimax",
    labelZh: "MiniMax (API&编程包)",
    labelEn: "MiniMax (API & Coding Plan)",
    category: "api",
    selectable: true,
    api: "anthropic-messages",
    defaultBaseUrl: "https://api.minimaxi.com/anthropic",
    urlMode: "base",
    authMode: "bearer-only",
    requiresCodingPlanUserAgent: false,
    supportsDeveloperRole: true,
    supportsFetchModels: true,
    supportsPlanQuota: true,
    testStrategy: "models-get",
    verificationTier: "electron-verified",
    verificationNote: "Bearer-only Anthropic endpoint + Token Plan quota support",
    presetModels: MINIMAX_PRESETS,
  },
  qwen: {
    type: "qwen",
    labelZh: "通义千问",
    labelEn: "Qwen (DashScope)",
    category: "api",
    selectable: true,
    api: "openai-completions",
    defaultBaseUrl: "https://dashscope.aliyuncs.com/compatible-mode/v1",
    urlMode: "base",
    authMode: "bearer-only",
    requiresCodingPlanUserAgent: false,
    supportsDeveloperRole: false,
    supportsFetchModels: true,
    supportsPlanQuota: false,
    testStrategy: "models-get",
    verificationTier: "electron-verified",
    verificationNote: "DashScope OpenAI-compatible mode with supportsDeveloperRole: false",
    presetModels: [],
  },
  "qwen-anthropic": {
    type: "qwen-anthropic",
    labelZh: "通义千问 (Anthropic 协议·旧版)",
    labelEn: "Qwen Anthropic (Legacy)",
    category: "api",
    selectable: false,
    api: "anthropic-messages",
    defaultBaseUrl: "https://dashscope.aliyuncs.com/apps/anthropic",
    urlMode: "base",
    authMode: "bearer-only",
    requiresCodingPlanUserAgent: false,
    supportsDeveloperRole: true,
    supportsFetchModels: true,
    supportsPlanQuota: false,
    testStrategy: "models-get",
    verificationTier: "electron-verified",
    verificationNote: "Legacy DashScope Anthropic compatibility entry (hidden from new-channel dropdown)",
    presetModels: QWEN_ANTHROPIC_LEGACY_PRESETS,
  },
  "qwen-token-plan": {
    type: "qwen-token-plan",
    labelZh: "通义千问 Token Plan",
    labelEn: "Qwen Token Plan",
    category: "api",
    selectable: true,
    api: "anthropic-messages",
    defaultBaseUrl: "https://token-plan.cn-beijing.maas.aliyuncs.com/apps/anthropic/v1/messages",
    urlMode: "base",
    authMode: "bearer-only",
    requiresCodingPlanUserAgent: true,
    supportsDeveloperRole: true,
    supportsFetchModels: false,
    supportsPlanQuota: false,
    testStrategy: "messages-probe",
    verificationTier: "pi-1.5.2-static",
    verificationNote: "Complete Anthropic messages URL + Bearer-only + Coding Plan User-Agent + preset models",
    presetModels: QWEN_TOKEN_PLAN_PRESETS,
  },
  xiaomi: {
    type: "xiaomi",
    labelZh: "小米 MiMo (API)",
    labelEn: "Xiaomi MiMo (API)",
    category: "api",
    selectable: true,
    api: "anthropic-messages",
    defaultBaseUrl: "https://api.xiaomimimo.com/anthropic",
    urlMode: "base",
    authMode: "api-key-header",
    requiresCodingPlanUserAgent: false,
    supportsDeveloperRole: true,
    supportsFetchModels: false,
    supportsPlanQuota: false,
    testStrategy: "messages-probe",
    verificationTier: "electron-verified",
    verificationNote: "Uses `api-key` header on /anthropic/v1/messages + MiMo V2.6 1M/128K defaults",
    presetModels: XIAOMI_PRESETS,
  },
  "xiaomi-token-plan": {
    type: "xiaomi-token-plan",
    labelZh: "小米 MiMo Token Plan",
    labelEn: "Xiaomi MiMo Token Plan",
    category: "api",
    selectable: true,
    api: "anthropic-messages",
    defaultBaseUrl: "https://token-plan-cn.xiaomimimo.com/anthropic",
    urlMode: "base",
    authMode: "bearer-only",
    requiresCodingPlanUserAgent: true,
    supportsDeveloperRole: true,
    supportsFetchModels: false,
    supportsPlanQuota: false,
    testStrategy: "messages-probe",
    verificationTier: "pi-1.5.2-static",
    verificationNote: "Bearer-only Anthropic auth + Coding Plan User-Agent + MiMo V2.6 1M/128K defaults",
    presetModels: XIAOMI_PRESETS,
  },
  custom: {
    type: "custom",
    labelZh: "OpenAI Chat Completions（自定义地址）",
    labelEn: "Custom OpenAI-Compatible",
    category: "custom",
    selectable: true,
    api: "openai-completions",
    defaultBaseUrl: "",
    urlMode: "full-endpoint",
    authMode: "bearer-only",
    requiresCodingPlanUserAgent: false,
    supportsDeveloperRole: false,
    supportsFetchModels: true,
    supportsPlanQuota: false,
    testStrategy: "models-get",
    verificationTier: "electron-verified",
    verificationNote: "Generic OpenAI Chat Completions endpoint with supportsDeveloperRole: false",
    presetModels: [],
  },
});

export const SELECTABLE_MEMBER_PROVIDER_TYPES: readonly MemberProviderType[] = Object.freeze([
  "anthropic",
  "anthropic-compatible",
  "openai",
  "openai-responses",
  "openai-codex",
  "github-copilot",
  "xai",
  "deepseek",
  "google",
  "kimi-api",
  "kimi-coding",
  "zhipu",
  "zhipu-coding",
  "zhipu-coding-team",
  "doubao-api",
  "minimax",
  "qwen",
  "qwen-token-plan",
  "xiaomi",
  "xiaomi-token-plan",
  "custom",
]);

export const OAUTH_PROVIDER_TYPES: readonly OAuthSubscriptionProvider[] = Object.freeze([
  "openai-codex",
  "github-copilot",
  "xai",
]);

export function isProviderType(value: unknown): value is ProviderType {
  return typeof value === "string" && Object.hasOwn(PROVIDER_CATALOG, value);
}

export function isOAuthProviderType(provider: ProviderType): provider is OAuthSubscriptionProvider {
  return provider === "openai-codex" || provider === "github-copilot" || provider === "xai";
}

export function getProviderSpec(provider: ProviderType): ProviderCapabilitySpec {
  return PROVIDER_CATALOG[provider];
}

export function listProviderCatalogSpecs(): readonly ProviderCapabilitySpec[] {
  return Object.values(PROVIDER_CATALOG);
}

// ============================================================================
// Model filtering, canonicalization, context windows, and reasoning compat
// ============================================================================

const NON_AGENT_MODEL_TOKENS = new Set([
  "bge",
  "m3e",
  "embedding",
  "embeddings",
  "rerank",
  "reranker",
  "asr",
  "tts",
  "whisper",
  "paraformer",
]);
const NON_AGENT_MODEL_PHRASES = ["text-embedding", "text_embedding", "sensevoice", "cosyvoice"];

export function isAgentCapableModelId(modelId: string): boolean {
  const lowered = modelId.trim().toLowerCase();
  if (!lowered) return false;
  if (NON_AGENT_MODEL_PHRASES.some((phrase) => lowered.includes(phrase))) return false;
  return !lowered.split(/[-_.:/]+/).some((token) => NON_AGENT_MODEL_TOKENS.has(token));
}

export function filterAgentCapableModels<T extends { readonly id: string }>(models: readonly T[]): T[] {
  return models.filter((model) => isAgentCapableModelId(model.id));
}

/** Canonicalize model IDs: strip legacy `[1m]` suffix and map legacy company DeepSeek IDs to `deepseek-flash`. */
export function canonicalizeModelId(channelId: string, modelId: string): string {
  const clean = stripLegacyContextSuffix(modelId.trim());
  if (channelId === COMPANY_CHANNEL_ID && /^deepseek-v4-flash(?:-0731)?$/i.test(clean)) {
    return COMPANY_DEFAULT_MODEL_ID;
  }
  return clean;
}

const GPT_6_ASTRA_FAMILY_PATTERN = /^gpt-6-astra(?:-[a-z0-9]+(?:-[a-z0-9]+)*)?$/;

export function isGpt6AstraFamily(modelId: string | undefined): boolean {
  const normalized = modelId ? stripLegacyContextSuffix(modelId.trim().toLowerCase()) : undefined;
  return normalized !== undefined && GPT_6_ASTRA_FAMILY_PATTERN.test(normalized);
}

export function isGpt6SolFamily(modelId: string | undefined): boolean {
  return modelId ? stripLegacyContextSuffix(modelId.trim().toLowerCase()) === "gpt-6-sol" : false;
}

export function isGpt6LunaFamily(modelId: string | undefined): boolean {
  return modelId ? stripLegacyContextSuffix(modelId.trim().toLowerCase()) === "gpt-6-luna" : false;
}

export const MIMO_V26_MODEL_IDS = [
  "mimo-v2.6-pro",
  "mimo-v2.6-flash",
  "mimo-v2.6-pro-ultraspeed",
] as const;

export function isMimoV26Model(modelId: string | undefined): boolean {
  if (!modelId) return false;
  const clean = stripLegacyContextSuffix(modelId.trim().toLowerCase());
  return (MIMO_V26_MODEL_IDS as readonly string[]).includes(clean);
}

export function isGlm53Model(modelId: string | undefined): boolean {
  if (!modelId) return false;
  const clean = stripLegacyContextSuffix(modelId.trim().toLowerCase());
  return clean === "glm-5.3" || clean === "glm-5.3-flash" || clean === "glm-5.3-flashx";
}

const DEEPSEEK_FLASH_VISION_IDS = new Set(["deepseek-flash", "deepseek-v4-flash"]);

export function supportsNativeImageInput(modelId: string | undefined): boolean {
  if (!modelId) return false;
  const clean = stripLegacyContextSuffix(modelId.trim().toLowerCase());
  if (DEEPSEEK_FLASH_VISION_IDS.has(clean)) return true;
  if (clean.includes("vision") || clean.includes("vl")) return true;
  if (
    clean.startsWith("claude-") ||
    clean.startsWith("gpt-4") ||
    clean.startsWith("gpt-5") ||
    clean.startsWith("gpt-6") ||
    clean.startsWith("gemini-") ||
    clean.startsWith("grok-4") ||
    clean === "kimi-k2.7-code" ||
    clean === "kimi-k3" ||
    clean === "k3"
  ) {
    return true;
  }
  return false;
}

const ONE_MILLION_EXACT_RULES = new Set([
  "k3",
  "kimi-k3",
  "mimo-v2.5",
  "mimo-v2.5-pro",
  "mimo-v2.6-pro",
  "mimo-v2.6-flash",
  "mimo-v2.6-pro-ultraspeed",
]);

const ONE_MILLION_SUBSTRING_RULES = [
  "claude-sonnet-4-6",
  "claude-sonnet-4.6",
  "claude-sonnet-5",
  "claude-opus-5",
  "claude-opus-4-6",
  "claude-opus-4-7",
  "claude-opus-4-8",
  "claude-opus-4.8",
  "claude-fable-5",
  "deepseek-v4",
  "deepseek-flash",
  "glm-5.3",
  "glm-5.2",
  "minimax-m3",
  "qwen3.8",
  "qwen3.7",
  "qwen3.6-plus",
  "qwen3.6-flash",
  "qwen3.5-plus",
  "qwen3.5-flash",
  "qwen3-coder-plus",
];

export function inferContextWindow(modelId: string): number {
  const clean = stripLegacyContextSuffix(modelId.trim().toLowerCase());
  if (clean === "gpt-6.1-sol" || clean === "gpt-6.1-terra") return 500_000;
  if (isGpt6AstraFamily(clean) || isGpt6SolFamily(clean) || isGpt6LunaFamily(clean)) {
    return 372_000;
  }
  if (clean === "gpt-5.4-mini") return 400_000;
  if (clean === "gpt-5.4" || clean === "gpt-5.5") return 272_000;
  if (
    clean === "gpt-5.6" ||
    clean === "gpt-5.6-sol" ||
    clean === "gpt-5.6-terra" ||
    clean === "gpt-5.6-luna"
  ) {
    return 372_000;
  }
  const gemini = getGeminiModelCapability(clean);
  if (gemini) return gemini.contextWindow;
  if (clean.includes("haiku") && !clean.includes("5.5")) return DEFAULT_CONTEXT_WINDOW;
  if (ONE_MILLION_EXACT_RULES.has(clean)) return ONE_MILLION;
  if (ONE_MILLION_SUBSTRING_RULES.some((pattern) => clean.includes(pattern))) {
    return ONE_MILLION;
  }
  return DEFAULT_CONTEXT_WINDOW;
}

export function inferMaxTokens(provider: ProviderType, modelId: string): number {
  const clean = stripLegacyContextSuffix(modelId.trim().toLowerCase());
  if (provider === "doubao-api" && (clean === "glm-5.2" || clean === "glm-5.3")) {
    return VOLCENGINE_GLM_MAX_TOKENS;
  }
  if (isGlm53Model(clean)) return GLM_53_MAX_TOKENS;
  if (isMimoV26Model(clean)) return MIMO_V26_MAX_TOKENS;
  const gemini = getGeminiModelCapability(clean);
  if (gemini) return gemini.maxOutputTokens;
  if (provider === "openai-codex") return CODEX_MAX_TOKENS;
  return DEFAULT_MAX_TOKENS;
}

function getClaudeFamilyKey(modelRef: string): string | undefined {
  const normalized = modelRef.toLowerCase();
  const familyFirst = normalized.match(
    /claude[\s._:/-]+(opus|sonnet|haiku|fable|mythos)[\s._:/-]+(\d+)(?:[\s._:/-]+(\d+))?/,
  );
  const versionFirst = normalized.match(
    /claude[\s._:/-]+(\d+)(?:[\s._:/-]+(\d+))?[\s._:/-]+(opus|sonnet|haiku)/,
  );
  const family = familyFirst?.[1] ?? versionFirst?.[3];
  const major = familyFirst?.[2] ?? versionFirst?.[1];
  const minor = familyFirst?.[3] ?? versionFirst?.[2];
  if (!family) return undefined;
  if (!major) return family === "mythos" ? "mythos" : undefined;
  return `${family}-${major}${minor ? `-${minor}` : ""}`;
}

export function shouldForceAdaptiveThinking(api: GatewayApiKind, modelId: string): boolean {
  if (api !== "anthropic-messages") return false;
  const clean = stripLegacyContextSuffix(modelId.trim().toLowerCase());
  if (clean.startsWith("claude-mythos-preview")) return true;
  if (clean === "k3" || clean === "k3-256k" || clean === "kimi-k3") return true;
  if (clean === "glm-5.2" || isGlm53Model(clean)) return true;
  const familyKey = getClaudeFamilyKey(clean);
  if (!familyKey) return false;
  if (familyKey === "fable-5" || familyKey.startsWith("fable-5-")) return true;
  if (familyKey === "sonnet-5" || familyKey.startsWith("sonnet-5-")) return true;
  if (familyKey === "opus-5" || familyKey.startsWith("opus-5-")) return true;
  if (familyKey === "opus-4-6" || familyKey === "opus-4-7" || familyKey === "opus-4-8") return true;
  return false;
}

const DEEPSEEK_V4_FLASH_EFFORT_MAP: Record<string, string | null> = {
  minimal: null,
  low: "low",
  medium: null,
  high: "high",
  xhigh: "high",
  max: "max",
};

const DEEPSEEK_V4_PRO_EFFORT_MAP: Record<string, string | null> = {
  minimal: null,
  low: "high",
  medium: null,
  high: "high",
  xhigh: "max",
  max: "max",
};

const K3_EFFORT_MAP: Record<string, string | null> = {
  minimal: "low",
  low: "low",
  medium: "high",
  high: "high",
  xhigh: "max",
  max: "max",
};

const GLM_53_EFFORT_MAP: Record<string, string | null> = {
  low: "low",
  high: "high",
  max: "max",
};

const GLM_52_OPENAI_EFFORT_MAP: Record<string, string | null> = {
  minimal: null,
  low: "high",
  medium: "high",
  high: "high",
  xhigh: "max",
  max: "max",
};

const GLM_52_ANTHROPIC_EFFORT_MAP: Record<string, string | null> = {
  minimal: "high",
  low: "high",
  medium: "high",
  high: "high",
  xhigh: "max",
  max: "max",
};

const OPENAI_STANDARD_EFFORT_MAP: Record<string, string | null> = {
  off: "none",
  minimal: "low",
  xhigh: "xhigh",
};

const OPENAI_MAX_EFFORT_MAP: Record<string, string | null> = {
  ...OPENAI_STANDARD_EFFORT_MAP,
  max: "max",
};

const OPENAI_ASTRA_EFFORT_MAP: Record<string, string | null> = {
  off: "low",
  minimal: "low",
  xhigh: "xhigh",
  max: "max",
};

const OPENAI_SOL_LUNA_EFFORT_MAP: Record<string, string | null> = {
  off: "none",
  minimal: "low",
  xhigh: "xhigh",
  max: "max",
};

const CODEX_CATALOG_BY_ID = new Map(CODEX_STATIC_MODELS.map((m) => [m.id.toLowerCase(), m]));
const COPILOT_CATALOG_BY_ID = new Map(GITHUB_COPILOT_STATIC_MODELS.map((m) => [m.id.toLowerCase(), m]));
const XAI_CATALOG_BY_ID = new Map(XAI_STATIC_MODELS.map((m) => [m.id.toLowerCase(), m]));

export function compileModelCapabilities(
  provider: ProviderType,
  modelId: string,
  options: { readonly channelId?: string; readonly name?: string; readonly enabled?: boolean } = {},
): GatewayModelConfig {
  const spec = getProviderSpec(provider);
  const channelId = options.channelId ?? (provider === "company-team" ? COMPANY_CHANNEL_ID : provider);
  const cleanId = canonicalizeModelId(channelId, modelId);
  const lower = cleanId.toLowerCase();

  const staticEntry =
    provider === "openai-codex"
      ? CODEX_CATALOG_BY_ID.get(lower)
      : provider === "github-copilot"
        ? COPILOT_CATALOG_BY_ID.get(lower)
        : provider === "xai"
          ? XAI_CATALOG_BY_ID.get(lower)
          : undefined;

  const api: GatewayApiKind = staticEntry?.api ?? spec.api;
  const compat: Record<string, unknown> = {};
  let thinkingLevelMap: Record<string, string | null> | undefined;

  if (api === "openai-completions" && !spec.supportsDeveloperRole) {
    compat.supportsDeveloperRole = false;
  }

  if (shouldForceAdaptiveThinking(api, cleanId)) {
    compat.forceAdaptiveThinking = true;
  }

  if (/^deepseek-flash(?:-|$)/.test(lower)) {
    if (api === "anthropic-messages") {
      thinkingLevelMap = { ...DEEPSEEK_V4_FLASH_EFFORT_MAP };
    } else if (api === "openai-completions") {
      compat.supportsReasoningEffort = true;
      compat.thinkingFormat = "deepseek";
      thinkingLevelMap = { ...DEEPSEEK_V4_FLASH_EFFORT_MAP, off: "none" };
    }
  } else if (/^deepseek-v4-flash(?:-|$)/.test(lower)) {
    if (api === "anthropic-messages") {
      thinkingLevelMap = { ...DEEPSEEK_V4_FLASH_EFFORT_MAP };
    }
  } else if (/^deepseek-v4-pro(?:-|$)/.test(lower)) {
    if (api === "anthropic-messages") {
      thinkingLevelMap = { ...DEEPSEEK_V4_PRO_EFFORT_MAP };
    }
  } else if (/^(?:k3(?:-256k)?|kimi-k3)$/.test(lower)) {
    if (api === "anthropic-messages") {
      compat.forceAdaptiveThinking = true;
      thinkingLevelMap = { ...K3_EFFORT_MAP };
    } else if (api === "openai-completions") {
      compat.supportsReasoningEffort = true;
      thinkingLevelMap = { ...K3_EFFORT_MAP };
    }
  } else if (isGlm53Model(lower)) {
    if (api === "anthropic-messages") {
      compat.forceAdaptiveThinking = true;
      thinkingLevelMap = { ...GLM_53_EFFORT_MAP };
    } else if (api === "openai-completions") {
      compat.supportsDeveloperRole = false;
      compat.supportsReasoningEffort = true;
      compat.thinkingFormat = "zai";
      compat.zaiToolStream = true;
      thinkingLevelMap = { ...GLM_53_EFFORT_MAP };
    }
  } else if (lower === "glm-5.2") {
    if (api === "anthropic-messages") {
      compat.forceAdaptiveThinking = true;
      thinkingLevelMap = { ...GLM_52_ANTHROPIC_EFFORT_MAP };
    } else if (api === "openai-completions") {
      compat.supportsDeveloperRole = false;
      compat.supportsReasoningEffort = true;
      compat.thinkingFormat = "zai";
      compat.zaiToolStream = true;
      thinkingLevelMap = { ...GLM_52_OPENAI_EFFORT_MAP };
    }
  } else if (
    api === "openai-completions" ||
    api === "openai-responses" ||
    api === "openai-codex-responses"
  ) {
    if (isGpt6AstraFamily(lower)) {
      compat.supportsReasoningEffort = true;
      thinkingLevelMap = { ...OPENAI_ASTRA_EFFORT_MAP };
    } else if (isGpt6SolFamily(lower) || isGpt6LunaFamily(lower)) {
      compat.supportsReasoningEffort = true;
      thinkingLevelMap = { ...OPENAI_SOL_LUNA_EFFORT_MAP };
    } else if (
      !lower.endsWith("-chat-latest") &&
      (lower.startsWith("gpt-5") || /^(?:o1|o3|o4)(?:-|$)/.test(lower))
    ) {
      compat.supportsReasoningEffort = true;
      thinkingLevelMap = /^gpt-5\.6(?:-|$)/.test(lower)
        ? { ...OPENAI_MAX_EFFORT_MAP }
        : { ...OPENAI_STANDARD_EFFORT_MAP };
    }
  } else if (api === "google-generative-ai") {
    const gemini = getGeminiModelCapability(lower);
    if (gemini && !gemini.thinkingLevels.includes("minimal")) {
      thinkingLevelMap = { minimal: null };
    }
  }

  const input: readonly ("text" | "image")[] =
    staticEntry?.input ?? (supportsNativeImageInput(cleanId) ? ["text", "image"] : ["text"]);
  const contextWindow = staticEntry?.contextWindow ?? inferContextWindow(cleanId);
  const maxTokens = staticEntry?.maxTokens ?? inferMaxTokens(provider, cleanId);
  const reasoning =
    staticEntry?.reasoning ??
    (thinkingLevelMap !== undefined ||
      compat.forceAdaptiveThinking === true ||
      lower.includes("reasoner") ||
      lower.includes("r1") ||
      lower.includes("thinking") ||
      lower.startsWith("claude-") ||
      lower.startsWith("gemini-3") ||
      lower.startsWith("gemini-4") ||
      lower.startsWith("deepseek-v4") ||
      lower === "deepseek-flash");

  return {
    id: cleanId,
    name: options.name ?? staticEntry?.name ?? cleanId,
    enabled: options.enabled ?? true,
    ...(api !== spec.api ? { api } : {}),
    reasoning,
    contextWindow,
    maxTokens,
    input,
    ...(Object.keys(compat).length > 0 ? { compat } : {}),
    ...(thinkingLevelMap ? { thinkingLevelMap } : {}),
  };
}

// ============================================================================
// URL normalization helpers (aligned with Electron baseline + Google /v1beta)
// ============================================================================

function trimTrailingSlashKeepQuery(rawUrl: string): string {
  const trimmed = rawUrl.trim();
  const sep = trimmed.search(/[?#]/);
  if (sep === -1) return trimmed.replace(/\/+$/, "");
  return `${trimmed.slice(0, sep).replace(/\/+$/, "")}${trimmed.slice(sep)}`;
}

function hasPathSuffix(rawUrl: string, suffix: string): boolean {
  try {
    const parsed = new URL(rawUrl.trim());
    return parsed.pathname.replace(/\/+$/, "").endsWith(suffix);
  } catch {
    const withoutQuery = rawUrl.trim().split(/[?#]/, 1)[0] ?? "";
    return withoutQuery.replace(/\/+$/, "").endsWith(suffix);
  }
}

function replacePathSuffix(rawUrl: string, suffix: string, replacement: string): string {
  const trimmed = rawUrl.trim();
  const parsed = new URL(trimmed);
  const pathname = parsed.pathname.replace(/\/+$/, "");
  if (!pathname.endsWith(suffix)) return trimTrailingSlashKeepQuery(trimmed);
  parsed.pathname = `${pathname.slice(0, -suffix.length)}${replacement}`;
  return parsed.toString();
}

export function normalizeBaseUrl(baseUrl: string): string {
  return trimTrailingSlashKeepQuery(baseUrl);
}

const CREDENTIAL_QUERY_PARAM_KEYS = new Set([
  "key",
  "apikey",
  "token",
  "accesstoken",
  "refreshtoken",
  "idtoken",
  "secret",
  "clientsecret",
  "auth",
  "authorization",
  "password",
  "passwd",
  "pwd",
  "sig",
  "signature",
  "xapikey",
  "xgoogapikey",
]);

function normalizeQueryKey(key: string): string {
  return key.trim().toLowerCase().replace(/[^a-z0-9]/g, "");
}

/**
 * Reject URLs containing embedded userinfo (`user:pass@`) or credential-like query parameters
 * (e.g., `?key=sk-...`, `?api_key=...`, `?token=...`, `?secret=...`, `?sig=...`) while
 * preserving benign proxy query parameters like `?api-version=...`.
 */
export function assertNoUrlCredentials(url: URL): void {
  if (url.username || url.password) {
    throw new Error("渠道接口地址不允许包含用户名或密码凭据。");
  }
  for (const paramKey of url.searchParams.keys()) {
    if (CREDENTIAL_QUERY_PARAM_KEYS.has(normalizeQueryKey(paramKey))) {
      throw new Error(`渠道接口地址不允许在查询参数中携带凭据字段（${paramKey}），请通过 API Key 输入框配置。`);
    }
  }
}

/**
 * Strip embedded userinfo and credential-like query parameters when loading legacy persisted URLs.
 */
export function stripUrlCredentialsForLoad(rawUrl: string): string {
  const trimmed = rawUrl.trim();
  if (!trimmed) return "";
  try {
    const parsed = new URL(trimmed);
    parsed.username = "";
    parsed.password = "";
    parsed.hash = "";
    const keysToDelete: string[] = [];
    for (const key of parsed.searchParams.keys()) {
      if (CREDENTIAL_QUERY_PARAM_KEYS.has(normalizeQueryKey(key))) {
        keysToDelete.push(key);
      }
    }
    for (const key of keysToDelete) {
      parsed.searchParams.delete(key);
    }
    return trimTrailingSlashKeepQuery(parsed.toString());
  } catch {
    return trimmed;
  }
}

function parseIpv4Octets(host: string): readonly [number, number, number, number] | null {
  const parts = host.split(".");
  if (parts.length !== 4) return null;
  const nums: number[] = [];
  for (const part of parts) {
    if (!/^\d{1,3}$/.test(part)) return null;
    const n = Number(part);
    if (!Number.isInteger(n) || n < 0 || n > 255) return null;
    nums.push(n);
  }
  return [nums[0]!, nums[1]!, nums[2]!, nums[3]!];
}

function isNonPublicIpv4(octets: readonly [number, number, number, number]): boolean {
  const [a, b, c] = octets;
  if (a === 0) return true; // 0.0.0.0/8 (this network / unspecified)
  if (a === 10) return true; // 10.0.0.0/8 (RFC 1918)
  if (a === 100 && b >= 64 && b <= 127) return true; // 100.64.0.0/10 (CGNAT)
  if (a === 127) return true; // 127.0.0.0/8 (loopback)
  if (a === 169 && b === 254) return true; // 169.254.0.0/16 (link-local / cloud metadata)
  if (a === 172 && b >= 16 && b <= 31) return true; // 172.16.0.0/12 (RFC 1918)
  if (a === 192 && b === 0 && c === 0) return true; // 192.0.0.0/24 (IETF protocol)
  if (a === 192 && b === 0 && c === 2) return true; // 192.0.2.0/24 (TEST-NET-1)
  if (a === 192 && b === 168) return true; // 192.168.0.0/16 (RFC 1918)
  if (a === 198 && (b === 18 || b === 19)) return true; // 198.18.0.0/15 (benchmarking)
  if (a === 198 && b === 51 && c === 100) return true; // 198.51.100.0/24 (TEST-NET-2)
  if (a === 203 && b === 0 && c === 113) return true; // 203.0.113.0/24 (TEST-NET-3)
  if (a >= 224) return true; // 224.0.0.0/4 multicast + 240.0.0.0/4 reserved + 255.255.255.255
  return false;
}

function parseIpv6Words(rawHost: string): readonly number[] | null {
  let host = rawHost;
  if (host.startsWith("[") && host.endsWith("]")) {
    host = host.slice(1, -1);
  }
  if (!host.includes(":")) return null;
  if (host.includes("%")) return null; // Reject zone IDs

  // Handle optional dotted-quad IPv4 tail (e.g., ::ffff:10.0.0.1)
  let tailWords: number[] = [];
  const lastColon = host.lastIndexOf(":");
  const maybeIpv4 = host.slice(lastColon + 1);
  if (maybeIpv4.includes(".")) {
    const octets = parseIpv4Octets(maybeIpv4);
    if (!octets) return null;
    tailWords = [(octets[0] << 8) | octets[1], (octets[2] << 8) | octets[3]];
    host = host.slice(0, lastColon);
    if (host.endsWith(":")) {
      host = `${host}0`;
    }
  }

  const doubleColonParts = host.split("::");
  if (doubleColonParts.length > 2) return null;

  const parseSegment = (seg: string): number[] | null => {
    if (!seg) return [];
    const groups = seg.split(":");
    const out: number[] = [];
    for (const g of groups) {
      if (!/^[0-9a-f]{1,4}$/i.test(g)) return null;
      out.push(Number.parseInt(g, 16));
    }
    return out;
  };

  if (doubleColonParts.length === 2) {
    const left = parseSegment(doubleColonParts[0]!);
    const right = parseSegment(doubleColonParts[1]!);
    if (!left || !right) return null;
    const missing = 8 - (left.length + right.length + tailWords.length);
    if (missing < 1) return null;
    return [...left, ...Array<number>(missing).fill(0), ...right, ...tailWords];
  }

  const all = parseSegment(host);
  if (!all || all.length + tailWords.length !== 8) return null;
  return [...all, ...tailWords];
}

function isNonPublicIpv6(words: readonly number[]): boolean {
  const [w0 = 0, w1 = 0, w2 = 0, w3 = 0, w4 = 0, w5 = 0, w6 = 0, w7 = 0] = words;
  // Unspecified ::
  if (words.every((w) => w === 0)) return true;
  // Loopback ::1
  if (w0 === 0 && w1 === 0 && w2 === 0 && w3 === 0 && w4 === 0 && w5 === 0 && w6 === 0 && w7 === 1) {
    return true;
  }
  // Unique local fc00::/7
  if ((w0 & 0xfe00) === 0xfc00) return true;
  // Link-local fe80::/10
  if ((w0 & 0xffc0) === 0xfe80) return true;
  // Site-local fec0::/10
  if ((w0 & 0xffc0) === 0xfec0) return true;
  // Multicast ff00::/8
  if ((w0 & 0xff00) === 0xff00) return true;
  // Documentation 2001:db8::/32
  if (w0 === 0x2001 && w1 === 0x0db8) return true;

  // IPv4-mapped ::ffff:0:0/96 or IPv4-compatible ::0:0/96
  if (w0 === 0 && w1 === 0 && w2 === 0 && w3 === 0 && w4 === 0 && (w5 === 0xffff || w5 === 0)) {
    return isNonPublicIpv4([w6 >> 8, w6 & 0xff, w7 >> 8, w7 & 0xff]);
  }
  // Well-known NAT64 prefix 64:ff9b::/96 or 64:ff9b:1::/48
  if (w0 === 0x0064 && w1 === 0xff9b && ((w2 === 0 && w3 === 0 && w4 === 0 && w5 === 0) || w2 === 0x0001)) {
    return isNonPublicIpv4([w6 >> 8, w6 & 0xff, w7 >> 8, w7 & 0xff]);
  }
  // 6to4 2002::/16 (embeds IPv4 in w1, w2)
  if (w0 === 0x2002) {
    return isNonPublicIpv4([w1 >> 8, w1 & 0xff, w2 >> 8, w2 & 0xff]);
  }
  return false;
}

/**
 * Strict SSRF-safe outbound HTTPS validator for model channels, test/fetch endpoints, and quota APIs.
 * Blocks non-HTTPS protocols, embedded credentials, credential-like query parameters, fragments,
 * loopback/private/link-local/CGNAT/metadata IPv4 & IPv6 literals (including IPv4-mapped IPv6),
 * and internal hostnames (`.local`, `.internal`, `.localhost`, `metadata.google.internal`).
 */
export function assertSafeOutboundUrl(url: URL): void {
  if (url.protocol !== "https:" || url.hash) {
    throw new Error("渠道接口地址必须是合法的 HTTPS URL。");
  }
  assertNoUrlCredentials(url);

  const rawHost = url.hostname.trim().toLowerCase();
  const host = rawHost.replace(/\.+$/, "");
  if (!host) {
    throw new Error("渠道接口地址缺少有效主机名。");
  }
  if (
    host === "localhost" ||
    host.endsWith(".localhost") ||
    host.endsWith(".local") ||
    host.endsWith(".internal") ||
    host === "metadata.google.internal" ||
    host === "metadata" ||
    host === "instance-data"
  ) {
    throw new Error("渠道接口地址不允许指向本机或内网域名。");
  }

  // IPv6 literal (URL.hostname wraps IPv6 in `[...]`)
  if (host.includes(":")) {
    const words = parseIpv6Words(host);
    if (!words || isNonPublicIpv6(words)) {
      throw new Error("渠道接口地址不允许指向本机、内网或保留 IPv6 地址。");
    }
    return;
  }

  // IPv4 literal (Node's URL parser canonicalizes hex/octal/integer IPv4 into dotted quad)
  const ipv4 = parseIpv4Octets(host);
  if (ipv4) {
    if (isNonPublicIpv4(ipv4)) {
      throw new Error("渠道接口地址不允许指向本机、内网、链路本地或元数据 IP 地址。");
    }
    return;
  }
}

/**
 * Normalize Google Generative AI base URL: ensures `/v1beta` (or existing `/v1`) while
 * preserving custom proxy path prefixes AND query parameters (ADR-012 §3.3).
 */
export function normalizeGoogleApiBaseUrl(rawUrl: string): string {
  const url = new URL(rawUrl.trim());
  const cleanPath = url.pathname.replace(/\/+$/, "");
  if (!/\/v1(?:beta)?$/i.test(cleanPath)) {
    url.pathname = `${cleanPath}/v1beta`;
  } else {
    url.pathname = cleanPath;
  }
  return url.toString().replace(/\/(?=\?|$)/, "");
}

export function normalizeAnthropicBaseUrlForGateway(rawUrl: string, provider: ProviderType): string {
  const trimmed = trimTrailingSlashKeepQuery(rawUrl);
  if (provider === "anthropic-compatible" || provider === "qwen-token-plan") {
    return trimmed;
  }
  const url = new URL(trimmed);
  let path = url.pathname.replace(/\/+$/, "");
  if (provider === "xiaomi" || provider === "xiaomi-token-plan") {
    path = "/anthropic/v1";
  } else {
    path = path.replace(/\/messages$/, "");
    if (
      provider === "minimax" ||
      provider === "qwen-anthropic" ||
      provider === "zhipu-coding" ||
      provider === "zhipu-coding-team" ||
      provider === "deepseek" ||
      provider === "kimi-api" ||
      provider === "kimi-coding"
    ) {
      if (!/\/v\d+$/i.test(path)) {
        path = `${path}/v1`;
      }
    } else if ((path === "" || path === "/") && !/\/v\d+$/i.test(path)) {
      path = "/v1";
    }
  }
  url.pathname = path;
  return url.toString().replace(/\/(?=\?|$)/, "");
}

export function normalizeOpenAIBaseUrlForGateway(rawUrl: string): string {
  const trimmed = trimTrailingSlashKeepQuery(rawUrl);
  if (hasPathSuffix(trimmed, "/chat/completions")) {
    return replacePathSuffix(trimmed, "/chat/completions", "").replace(/\/(?=\?|$)/, "");
  }
  if (hasPathSuffix(trimmed, "/responses")) {
    return replacePathSuffix(trimmed, "/responses", "").replace(/\/(?=\?|$)/, "");
  }
  return trimmed;
}

export function normalizeChannelBaseUrlForGateway(
  provider: ProviderType,
  rawUrl: string | undefined,
): string | undefined {
  const spec = getProviderSpec(provider);
  const candidate = rawUrl?.trim() || spec.defaultBaseUrl;
  if (!candidate) return undefined;
  if (spec.api === "google-generative-ai") return normalizeGoogleApiBaseUrl(candidate);
  if (spec.api === "anthropic-messages") return normalizeAnthropicBaseUrlForGateway(candidate, provider);
  if (spec.api === "openai-completions" || spec.api === "openai-responses") {
    return normalizeOpenAIBaseUrlForGateway(candidate);
  }
  return normalizeBaseUrl(candidate);
}

export function resolveAnthropicMessagesUrl(baseUrl: string, provider: ProviderType): string {
  const trimmed = trimTrailingSlashKeepQuery(baseUrl);
  if (provider === "anthropic-compatible") return trimmed;
  if (hasPathSuffix(trimmed, "/messages")) return trimmed;
  const normalized = normalizeAnthropicBaseUrlForGateway(trimmed, provider);
  const url = new URL(normalized);
  url.pathname = `${url.pathname.replace(/\/+$/, "")}/messages`;
  return url.toString();
}

export function resolveAnthropicModelsUrl(baseUrl: string, provider: ProviderType): string {
  const trimmed = trimTrailingSlashKeepQuery(baseUrl);
  if (provider === "deepseek") {
    return `${new URL(trimmed).origin}/models`;
  }
  if (provider === "kimi-api") {
    return `${new URL(trimmed).origin}/v1/models`;
  }
  if (hasPathSuffix(trimmed, "/messages")) {
    return replacePathSuffix(trimmed, "/messages", "/models");
  }
  const normalized = normalizeAnthropicBaseUrlForGateway(trimmed, provider);
  const url = new URL(normalized);
  url.pathname = `${url.pathname.replace(/\/+$/, "")}/models`;
  return url.toString();
}

export function resolveOpenAIModelsUrl(baseUrl: string): string {
  const trimmed = trimTrailingSlashKeepQuery(baseUrl);
  if (hasPathSuffix(trimmed, "/chat/completions")) {
    return replacePathSuffix(trimmed, "/chat/completions", "/models");
  }
  if (hasPathSuffix(trimmed, "/responses")) {
    return replacePathSuffix(trimmed, "/responses", "/models");
  }
  const url = new URL(trimmed);
  url.pathname = `${url.pathname.replace(/\/+$/, "")}/models`;
  return url.toString();
}

export function resolveGoogleModelsUrl(baseUrl: string): string {
  const normalized = normalizeGoogleApiBaseUrl(baseUrl);
  const url = new URL(normalized);
  url.pathname = `${url.pathname.replace(/\/+$/, "")}/models`;
  return url.toString();
}

/**
 * Compile a stored channel + runtime credentials into a `GatewayChannelConfig`
 * ready for `ModelGateway.updateChannels` and `buildPiModelsJson`.
 */
export function compileChannelToGatewayConfig(
  channel: CompilableChannelInput,
  credentials: CompilableChannelCredentials = {},
): GatewayChannelConfig {
  const spec = getProviderSpec(channel.provider);
  const resolvedBaseUrl =
    channel.provider === "github-copilot"
      ? channel.baseUrl.trim() || undefined
      : normalizeChannelBaseUrlForGateway(channel.provider, channel.baseUrl);

  const seenModelIds = new Set<string>();
  const compiledModels: GatewayModelConfig[] = [];
  for (const model of channel.models) {
    const cleanId = canonicalizeModelId(channel.id, model.id);
    if (!cleanId || !isAgentCapableModelId(cleanId)) continue;
    const dedupeKey = cleanId.toLowerCase();
    if (seenModelIds.has(dedupeKey)) continue;
    seenModelIds.add(dedupeKey);
    if (
      channel.provider === "github-copilot" &&
      !isCopilotModelPermitted(cleanId, channel.availableModelIds)
    ) {
      continue;
    }
    compiledModels.push(
      compileModelCapabilities(channel.provider, cleanId, {
        channelId: channel.id,
        name: model.name || cleanId,
        enabled: model.enabled,
      }),
    );
  }

  return {
    id: channel.id,
    name: channel.name,
    providerType: channel.provider,
    enabled: channel.enabled,
    api: spec.api,
    ...(resolvedBaseUrl ? { baseUrl: resolvedBaseUrl } : {}),
    models: compiledModels,
    ...(credentials.apiKey !== undefined ? { apiKey: credentials.apiKey } : {}),
    ...(credentials.secretRef !== undefined ? { secretRef: credentials.secretRef } : {}),
    ...(channel.userAgent
      ? { userAgent: channel.userAgent }
      : spec.requiresCodingPlanUserAgent
        ? { userAgent: CODING_PLAN_USER_AGENT }
        : {}),
    ...(channel.upstreamHeaders ? { upstreamHeaders: channel.upstreamHeaders } : {}),
    ...(channel.availableModelIds !== undefined
      ? { availableModelIds: [...channel.availableModelIds] }
      : {}),
    ...(credentials.oauth ? { oauth: credentials.oauth } : {}),
  };
}
