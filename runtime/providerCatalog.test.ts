import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { buildPiModelsJson, CODING_PLAN_USER_AGENT, COMPANY_CHANNEL_ID } from "./gateway.ts";
import {
  canonicalizeModelId,
  compileChannelToGatewayConfig,
  compileModelCapabilities,
  filterAgentCapableModels,
  getGeminiModelCapability,
  getProviderSpec,
  isAgentCapableModelId,
  normalizeChannelBaseUrlForGateway,
  normalizeGeminiThinkingLevel,
  normalizeGoogleApiBaseUrl,
  OAUTH_PROVIDER_TYPES,
  PROVIDER_CATALOG,
  PROVIDER_CATALOG_VERSION,
  resolveAnthropicMessagesUrl,
  resolveAnthropicModelsUrl,
  resolveGoogleModelsUrl,
  resolveOpenAIModelsUrl,
  SELECTABLE_MEMBER_PROVIDER_TYPES,
  shouldForceAdaptiveThinking,
} from "./providerCatalog.ts";

describe("Versioned 19-supplier Pi 1.5.2 provider catalog (ADR-012 §3.3)", () => {
  it("defines Company Team Channel + all 19+ member suppliers with verification tiers and 4 native protocols", () => {
    assert.equal(PROVIDER_CATALOG_VERSION, "pi-1.5.2-v1");
    assert.ok(SELECTABLE_MEMBER_PROVIDER_TYPES.length >= 19);
    assert.equal(OAUTH_PROVIDER_TYPES.length, 3);
    assert.equal(PROVIDER_CATALOG["company-team"].selectable, false);
    assert.equal(PROVIDER_CATALOG["company-team"].defaultBaseUrl, "https://llm-api.sci-it.com/v1");
    assert.equal(PROVIDER_CATALOG["company-team"].api, "openai-completions");

    const apis = new Set(Object.values(PROVIDER_CATALOG).map((spec) => spec.api));
    assert.ok(apis.has("anthropic-messages"));
    assert.ok(apis.has("openai-completions"));
    assert.ok(apis.has("openai-responses"));
    assert.ok(apis.has("openai-codex-responses"));
    assert.ok(apis.has("google-generative-ai"));

    for (const spec of Object.values(PROVIDER_CATALOG)) {
      assert.ok(spec.labelZh.length > 0, `Missing labelZh for ${spec.type}`);
      assert.ok(spec.labelEn.length > 0, `Missing labelEn for ${spec.type}`);
      assert.ok(
        ["v2-verified", "pi-1.5.2-static", "electron-verified", "pending-live-e2e"].includes(
          spec.verificationTier,
        ),
      );
      assert.ok(spec.verificationNote.length > 0);
    }

    // Coding/Token Plan User-Agent & auth header modes
    assert.equal(getProviderSpec("anthropic").authMode, "x-api-key");
    assert.equal(getProviderSpec("kimi-coding").authMode, "bearer-only");
    assert.equal(getProviderSpec("kimi-coding").requiresCodingPlanUserAgent, true);
    assert.equal(getProviderSpec("zhipu-coding-team").authMode, "zhipu-composite");
    assert.equal(getProviderSpec("xiaomi").authMode, "api-key-header");
    assert.equal(getProviderSpec("xiaomi-token-plan").authMode, "bearer-only");
    assert.equal(getProviderSpec("xiaomi-token-plan").requiresCodingPlanUserAgent, true);
    assert.equal(getProviderSpec("qwen-token-plan").requiresCodingPlanUserAgent, true);
  });

  it("compiles Claude forceAdaptiveThinking, DeepSeek V4 thinking, [1m] stripping, GLM-5.3/MiMo V2.6 128K, and DeepSeek Flash vision", () => {
    // Claude adaptive thinking
    assert.equal(shouldForceAdaptiveThinking("anthropic-messages", "claude-opus-4-7"), true);
    assert.equal(shouldForceAdaptiveThinking("anthropic-messages", "claude-sonnet-5"), true);
    assert.equal(shouldForceAdaptiveThinking("anthropic-messages", "claude-fable-5.1"), true);
    assert.equal(shouldForceAdaptiveThinking("anthropic-messages", "claude-sonnet-4-5"), false);
    assert.equal(shouldForceAdaptiveThinking("openai-completions", "claude-opus-4-7"), false);

    const claude5 = compileModelCapabilities("anthropic", "claude-sonnet-5[1m]");
    assert.equal(claude5.id, "claude-sonnet-5");
    assert.equal(claude5.contextWindow, 1_000_000);
    assert.equal(claude5.compat?.forceAdaptiveThinking, true);

    // DeepSeek V4 Anthropic + DeepSeek Flash vision
    const dsFlash = compileModelCapabilities("deepseek", "deepseek-flash");
    assert.deepEqual(dsFlash.input, ["text", "image"]);
    assert.equal(dsFlash.contextWindow, 1_000_000);
    assert.equal(dsFlash.thinkingLevelMap?.max, "max");
    assert.equal(dsFlash.thinkingLevelMap?.minimal, null);

    // Company channel legacy canonicalization + DeepSeek Flash openai-completions compat
    assert.equal(canonicalizeModelId(COMPANY_CHANNEL_ID, "deepseek-v4-flash-0731"), "deepseek-flash");
    const companyDs = compileModelCapabilities("company-team", "deepseek-v4-flash", {
      channelId: COMPANY_CHANNEL_ID,
    });
    assert.equal(companyDs.id, "deepseek-flash");
    assert.deepEqual(companyDs.input, ["text", "image"]);
    assert.equal(companyDs.compat?.supportsDeveloperRole, false);
    assert.equal(companyDs.compat?.supportsReasoningEffort, true);
    assert.equal(companyDs.compat?.thinkingFormat, "deepseek");

    // GLM-5.3 128K + Zhipu zai compat
    const glm53 = compileModelCapabilities("zhipu", "glm-5.3[1m]");
    assert.equal(glm53.id, "glm-5.3");
    assert.equal(glm53.contextWindow, 1_000_000);
    assert.equal(glm53.maxTokens, 131_072);
    assert.equal(glm53.compat?.supportsDeveloperRole, false);
    assert.equal(glm53.compat?.supportsReasoningEffort, true);
    assert.equal(glm53.compat?.thinkingFormat, "zai");
    assert.equal(glm53.compat?.zaiToolStream, true);

    // Volcengine GLM-5.3 cap
    const arkGlm = compileModelCapabilities("doubao-api", "glm-5.3");
    assert.equal(arkGlm.maxTokens, 128_000);
    assert.equal(arkGlm.compat?.supportsDeveloperRole, false);

    // MiMo V2.6 128K
    const mimo = compileModelCapabilities("xiaomi-token-plan", "mimo-v2.6-pro");
    assert.equal(mimo.contextWindow, 1_000_000);
    assert.equal(mimo.maxTokens, 128_000);
  });

  it("normalizes Google /v1beta URLs preserving proxy paths & query and enforces Gemini thinkingLevels", () => {
    assert.equal(
      normalizeGoogleApiBaseUrl("https://generativelanguage.googleapis.com"),
      "https://generativelanguage.googleapis.com/v1beta",
    );
    assert.equal(
      normalizeGoogleApiBaseUrl("https://proxy.example.com/gemini?tenant=acme"),
      "https://proxy.example.com/gemini/v1beta?tenant=acme",
    );
    assert.equal(
      normalizeGoogleApiBaseUrl("https://proxy.example.com/gemini/v1?tenant=acme"),
      "https://proxy.example.com/gemini/v1?tenant=acme",
    );
    assert.equal(
      resolveGoogleModelsUrl("https://generativelanguage.googleapis.com"),
      "https://generativelanguage.googleapis.com/v1beta/models",
    );

    const proCap = getGeminiModelCapability("gemini-3.1-pro-preview");
    assert.ok(proCap);
    assert.equal(proCap.contextWindow, 1_000_000);
    assert.equal(proCap.maxOutputTokens, 65_536);
    assert.equal(normalizeGeminiThinkingLevel("gemini-3.1-pro-preview", "minimal"), "high");
    assert.equal(normalizeGeminiThinkingLevel("gemini-3.5-flash", "minimal"), "minimal");

    const compiledPro = compileModelCapabilities("google", "gemini-3.1-pro-preview");
    assert.equal(compiledPro.thinkingLevelMap?.minimal, null);
    const compiledFlash = compileModelCapabilities("google", "gemini-3.5-flash");
    assert.equal(compiledFlash.thinkingLevelMap, undefined);
  });

  it("filters non-agent models and normalizes Anthropic/OpenAI endpoint URLs cleanly", () => {
    assert.equal(isAgentCapableModelId("deepseek-flash"), true);
    assert.equal(isAgentCapableModelId("gpt-4o-audio-preview"), true);
    assert.equal(isAgentCapableModelId("text-embedding-3-small"), false);
    assert.equal(isAgentCapableModelId("bge-m3"), false);
    assert.equal(isAgentCapableModelId("CosyVoice2-0.5B"), false);
    assert.equal(isAgentCapableModelId("whisper-large-v3"), false);
    assert.deepEqual(
      filterAgentCapableModels([{ id: "gpt-5.4" }, { id: "bge-reranker" }]).map((m) => m.id),
      ["gpt-5.4"],
    );

    assert.equal(
      resolveAnthropicMessagesUrl("https://api.deepseek.com/anthropic", "deepseek"),
      "https://api.deepseek.com/anthropic/v1/messages",
    );
    assert.equal(
      resolveAnthropicModelsUrl("https://api.deepseek.com/anthropic", "deepseek"),
      "https://api.deepseek.com/models",
    );
    assert.equal(
      resolveAnthropicModelsUrl("https://api.moonshot.cn/anthropic", "kimi-api"),
      "https://api.moonshot.cn/v1/models",
    );
    assert.equal(
      resolveOpenAIModelsUrl("https://proxy.example.com/v1/chat/completions"),
      "https://proxy.example.com/v1/models",
    );
    assert.equal(
      normalizeChannelBaseUrlForGateway("custom", "https://proxy.example.com/v1/chat/completions"),
      "https://proxy.example.com/v1",
    );
  });

  it("compiles channels to GatewayChannelConfig & models.json with stable <channelId>/<modelId> IDs and zero secrets", () => {
    const kimiGateway = compileChannelToGatewayConfig(
      {
        id: "kimi-work",
        name: "Kimi Coding",
        provider: "kimi-coding",
        baseUrl: "https://api.kimi.com/coding/v1",
        enabled: true,
        models: [
          { id: "k3", name: "Kimi K3", enabled: true },
          { id: "text-embedding-3-large", name: "Embed", enabled: true },
        ],
      },
      { secretRef: "channel:kimi-work" },
    );
    assert.equal(kimiGateway.userAgent, CODING_PLAN_USER_AGENT);
    assert.equal(kimiGateway.models.length, 1);
    assert.equal(kimiGateway.models[0]!.id, "k3");

    const copilotGateway = compileChannelToGatewayConfig(
      {
        id: "copilot-main",
        name: "GitHub Copilot",
        provider: "github-copilot",
        baseUrl: "",
        enabled: true,
        availableModelIds: ["claude-sonnet-5", "gpt-6-sol"],
        models: [
          { id: "claude-sonnet-5", name: "Claude Sonnet 5", enabled: true },
          { id: "gpt-6-sol", name: "GPT-6 Sol", enabled: true },
          { id: "grok-4.7", name: "Grok 4.7", enabled: true },
        ],
      },
      {
        oauth: {
          provider: "github-copilot",
          secretRef: "oauth:copilot-main",
          refresh: async (c) => c,
        },
      },
    );
    // grok-4.7 filtered by availableModelIds; claude-sonnet-5 keeps anthropic-messages & gpt-6-sol keeps openai-responses!
    assert.deepEqual(
      copilotGateway.models.map((m) => [m.id, m.api]),
      [
        ["claude-sonnet-5", "anthropic-messages"],
        ["gpt-6-sol", "openai-responses"],
      ],
    );

    const piModels = buildPiModelsJson(43210, [kimiGateway, copilotGateway], false);
    const providers = piModels.providers as Record<string, { apiKey: string; models: Array<{ id: string; baseUrl?: string }> }>;
    assert.equal(providers["kimi-work"]!.apiKey, "$XTWORK_MODEL_GATEWAY_TOKEN");
    assert.equal(
      providers["copilot-main"]!.models[0]!.baseUrl,
      "http://127.0.0.1:43210/c/copilot-main/anthropic-messages",
    );
    assert.equal(
      providers["copilot-main"]!.models[1]!.baseUrl,
      "http://127.0.0.1:43210/c/copilot-main/openai-responses",
    );
  });
});
