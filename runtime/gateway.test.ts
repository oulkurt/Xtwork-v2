import assert from "node:assert/strict";
import { once } from "node:events";
import { chmodSync, mkdtempSync, readFileSync, rmSync } from "node:fs";
import { createServer, request as httpRequest, type IncomingMessage, type ServerResponse } from "node:http";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, it } from "node:test";
import { zstdCompressSync } from "node:zlib";
import {
  buildPiModelsJson,
  CODING_PLAN_USER_AGENT,
  COMPANY_CHANNEL_ID,
  COMPANY_DEFAULT_MODEL_ID,
  extractZhipuCodingTeamApiToken,
  GATEWAY_TOKEN_HEADER,
  type GatewayChannelConfig,
  resolveFallbackModel,
  rewriteDeepSeekV4AnthropicBody,
  startBundledPi,
} from "./gateway.ts";
import {
  assertStrictOAuthDestination,
  CODEX_PLACEHOLDER_ACCOUNT_ID,
  createCodexPlaceholderJwt,
  deriveGitHubCopilotBaseUrl,
  extractCodexAccountId,
  type OAuthDestinationValidator,
  OAuthTokenManager,
  refreshCodexOAuthToken,
  refreshXaiOAuthToken,
  type XaiOAuthCredentials,
} from "./oauthProxy.ts";
import {
  ChannelCredentialFence,
  memorySecrets,
  type SecretStore,
  SecretStoreUnavailableError,
} from "./secretStore.ts";

const allowLoopbackOAuthForTests: OAuthDestinationValidator = (provider, url, purpose, context) => {
  if (url.protocol === "http:" && url.hostname === "127.0.0.1") return;
  assertStrictOAuthDestination(provider, url, purpose, context);
};

interface RecordedUpstreamRequest {
  readonly method: string;
  readonly url: string;
  readonly headers: Record<string, string | string[] | undefined>;
  readonly body: string;
}

async function startStubServer(
  handler: (req: IncomingMessage, res: ServerResponse, body: string) => void | Promise<void>,
) {
  const recorded: RecordedUpstreamRequest[] = [];
  const server = createServer(async (req, res) => {
    const chunks: Buffer[] = [];
    for await (const chunk of req) chunks.push(Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk));
    const body = Buffer.concat(chunks).toString("utf8");
    recorded.push({
      method: req.method ?? "GET",
      url: req.url ?? "/",
      headers: { ...req.headers },
      body,
    });
    await handler(req, res, body);
  });
  server.listen(0, "127.0.0.1");
  await once(server, "listening");
  const address = server.address();
  assert.ok(address && typeof address !== "string");
  return {
    port: address.port,
    baseUrl: `http://127.0.0.1:${address.port}`,
    recorded,
    close: () =>
      new Promise<void>((resolve) => {
        server.close(() => resolve());
        server.closeAllConnections();
      }),
  };
}

describe("multi-protocol Proxy-Only model gateway & OAuth helpers (ADR-012 M1b-Gate 1)", () => {
  it("handles zero-channel onboarding without hardcoded --provider/--model startup lock", async () => {
    const dir = mkdtempSync(join(tmpdir(), "xtwork-gw-zero-"));
    try {
      const runtime = await startBundledPi("/bin/true", dir, {}, { skipBinaryAccessCheck: true });
      try {
        assert.equal(runtime.config.launchArgs.includes("--provider"), false);
        assert.equal(runtime.config.launchArgs.includes("--model"), false);
        assert.equal(runtime.isZeroChannelState(), true);
        assert.equal(runtime.getDefaultModelSlug(), null);

        const modelsJson = JSON.parse(readFileSync(join(runtime.agentDir, "models.json"), "utf8"));
        assert.deepEqual(modelsJson, { providers: {} });

        const settingsJson = JSON.parse(
          readFileSync(join(runtime.agentDir, "settings.json"), "utf8"),
        );
        assert.equal(settingsJson.transport, "sse");
        assert.equal(settingsJson.defaultProvider, undefined);
        assert.equal(settingsJson.defaultModel, undefined);

        // Legacy fallback endpoint MUST be rejected when dev fallback is not active
        const res = await fetch(`http://127.0.0.1:${runtime.port}/v1/chat/completions`, {
          method: "POST",
          headers: {
            authorization: `Bearer ${runtime.gatewayToken}`,
            "content-type": "application/json",
          },
          body: JSON.stringify({ model: "standard", messages: [] }),
        });
        assert.equal(res.status, 403);
      } finally {
        await runtime.close();
      }
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it("preserves xtwork/standard dev fallback when XTWORK_MODEL_UPSTREAM_URL is configured", async () => {
    const stub = await startStubServer((_req, res, body) => {
      const parsed = JSON.parse(body) as { model: string };
      res.writeHead(200, { "content-type": "application/json" });
      res.end(JSON.stringify({ upstreamModel: parsed.model }));
    });
    const dir = mkdtempSync(join(tmpdir(), "xtwork-gw-dev-"));
    try {
      const runtime = await startBundledPi(
        "/bin/true",
        dir,
        {
          XTWORK_MODEL_UPSTREAM_URL: `${stub.baseUrl}/v1`,
          XTWORK_MODEL_UPSTREAM_MODEL: "dev/test-model",
        },
        { skipBinaryAccessCheck: true },
      );
      try {
        assert.equal(runtime.config.launchArgs.includes("--provider"), false);
        assert.equal(runtime.isZeroChannelState(), false);
        assert.equal(runtime.getDefaultModelSlug(), "xtwork/standard");

        const res = await fetch(`http://127.0.0.1:${runtime.port}/v1/chat/completions`, {
          method: "POST",
          headers: {
            authorization: `Bearer ${runtime.gatewayToken}`,
            "content-type": "application/json",
          },
          body: JSON.stringify({ model: "standard", messages: [] }),
        });
        assert.equal(res.status, 200);
        assert.deepEqual(await res.json(), { upstreamModel: "dev/test-model" });
      } finally {
        await runtime.close();
      }
    } finally {
      await stub.close();
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it("proxies all 4 native protocols, enforces allowlists, injects vendor headers, and isolates multi-account channels", async () => {
    const stub = await startStubServer((_req, res) => {
      res.writeHead(200, { "content-type": "text/event-stream" });
      res.write('data: {"ok":true}\n\n');
      res.end();
    });
    const dir = mkdtempSync(join(tmpdir(), "xtwork-gw-proto-"));
    try {
      const secretStore = memorySecrets();
      await secretStore.set("chan:openai-personal", "sk-personal-secret");

      const channels: GatewayChannelConfig[] = [
        {
          id: "openai-work",
          providerType: "openai",
          enabled: true,
          api: "openai-completions",
          baseUrl: `${stub.baseUrl}/work/v1`,
          apiKey: "sk-work-secret",
          models: [
            { id: "gpt-4o", enabled: true },
            { id: "gpt-4o-disabled", enabled: false },
          ],
        },
        {
          id: "openai-personal",
          providerType: "openai-responses",
          enabled: true,
          api: "openai-responses",
          baseUrl: `${stub.baseUrl}/personal/v1`,
          secretRef: "chan:openai-personal",
          models: [{ id: "gpt-4o", enabled: true }],
        },
        {
          id: "zhipu-team",
          providerType: "zhipu-coding-team",
          enabled: true,
          api: "anthropic-messages",
          baseUrl: `${stub.baseUrl}/zhipu/api/anthropic`,
          apiKey: "apiKey=zhipu-real-token; bigmodel_organization=org-1; bigmodel_project=proj-1",
          models: [{ id: "glm-5.3", enabled: true }],
        },
        {
          id: "deepseek-anth",
          providerType: "deepseek",
          enabled: true,
          api: "anthropic-messages",
          baseUrl: `${stub.baseUrl}/deepseek/anthropic`,
          apiKey: "sk-deepseek-real",
          models: [{ id: "deepseek-v4-pro", enabled: true }],
        },
        {
          id: "google-main",
          providerType: "google",
          enabled: true,
          api: "google-generative-ai",
          baseUrl: `${stub.baseUrl}/gemini-proxy?custom=1`,
          apiKey: "AIza-real-google-secret",
          models: [{ id: "gemini-2.5-pro", enabled: true }],
        },
        {
          id: "disabled-chan",
          providerType: "openai",
          enabled: false,
          api: "openai-completions",
          baseUrl: `${stub.baseUrl}/disabled/v1`,
          apiKey: "sk-disabled-secret",
          models: [{ id: "gpt-4o", enabled: true }],
        },
      ];

      const runtime = await startBundledPi(
        "/bin/true",
        dir,
        {},
        { channels, secretStore, skipBinaryAccessCheck: true },
      );
      try {
        // Verify ZERO real secrets appear in models.json or Pi environment!
        const rawModelsJson = readFileSync(join(runtime.agentDir, "models.json"), "utf8");
        for (const realSecret of [
          "sk-work-secret",
          "sk-personal-secret",
          "zhipu-real-token",
          "sk-deepseek-real",
          "AIza-real-google-secret",
          "sk-disabled-secret",
        ]) {
          assert.equal(rawModelsJson.includes(realSecret), false, `models.json leaked ${realSecret}`);
          for (const envEntry of runtime.environment) {
            assert.equal(envEntry.value.includes(realSecret), false, `env leaked ${realSecret}`);
          }
        }

        // 1. Unauthorized token -> 401
        const unauth = await fetch(
          `http://127.0.0.1:${runtime.port}/c/openai-work/openai-completions/chat/completions`,
          {
            method: "POST",
            headers: { authorization: "Bearer wrong-token", "content-type": "application/json" },
            body: JSON.stringify({ model: "gpt-4o", messages: [] }),
          },
        );
        assert.equal(unauth.status, 401);

        // 2. Disabled channel -> 403
        const disChan = await fetch(
          `http://127.0.0.1:${runtime.port}/c/disabled-chan/openai-completions/chat/completions`,
          {
            method: "POST",
            headers: {
              authorization: `Bearer ${runtime.gatewayToken}`,
              "content-type": "application/json",
            },
            body: JSON.stringify({ model: "gpt-4o", messages: [] }),
          },
        );
        assert.equal(disChan.status, 403);

        // 3. Disabled model -> 403
        const disModel = await fetch(
          `http://127.0.0.1:${runtime.port}/c/openai-work/openai-completions/chat/completions`,
          {
            method: "POST",
            headers: {
              authorization: `Bearer ${runtime.gatewayToken}`,
              "content-type": "application/json",
            },
            body: JSON.stringify({ model: "gpt-4o-disabled", messages: [] }),
          },
        );
        assert.equal(disModel.status, 403);

        // 4. Multi-account OpenAI Completions (openai-work/gpt-4o) & Responses (openai-personal/gpt-4o)
        const r1 = await fetch(
          `http://127.0.0.1:${runtime.port}/c/openai-work/openai-completions/chat/completions`,
          {
            method: "POST",
            headers: {
              authorization: `Bearer ${runtime.gatewayToken}`,
              "content-type": "application/json",
            },
            body: JSON.stringify({ model: "gpt-4o", messages: [{ role: "user", content: "hi" }] }),
          },
        );
        assert.equal(r1.status, 200);
        await r1.text();

        const r2 = await fetch(
          `http://127.0.0.1:${runtime.port}/c/openai-personal/openai-responses/responses`,
          {
            method: "POST",
            headers: {
              authorization: `Bearer ${runtime.gatewayToken}`,
              "content-type": "application/json",
            },
            body: JSON.stringify({ model: "gpt-4o", input: "hi" }),
          },
        );
        assert.equal(r2.status, 200);
        await r2.text();

        // 5. Zhipu Coding Team composite credential extraction + Bearer-only + Coding Plan UA + [1m] strip
        const r3 = await fetch(
          `http://127.0.0.1:${runtime.port}/c/zhipu-team/anthropic-messages/v1/messages`,
          {
            method: "POST",
            headers: {
              "x-api-key": runtime.gatewayToken,
              "content-type": "application/json",
            },
            body: JSON.stringify({ model: "glm-5.3[1m]", messages: [] }),
          },
        );
        assert.equal(r3.status, 200);
        await r3.text();

        // 6. DeepSeek V4 Anthropic thinking rewrite + x-api-key auth
        const r4 = await fetch(
          `http://127.0.0.1:${runtime.port}/c/deepseek-anth/anthropic-messages/v1/messages`,
          {
            method: "POST",
            headers: {
              "x-api-key": runtime.gatewayToken,
              "content-type": "application/json",
            },
            body: JSON.stringify({
              model: "deepseek-v4-pro",
              thinking: { type: "enabled", budget_tokens: 16384, display: "summarized" },
              messages: [],
            }),
          },
        );
        assert.equal(r4.status, 200);
        await r4.text();

        // 7. Google Generative AI (/v1beta auto-complete + custom query preserved + gateway token stripped)
        const r5 = await fetch(
          `http://127.0.0.1:${runtime.port}/c/google-main/google-generative-ai/models/gemini-2.5-pro:streamGenerateContent?alt=sse&key=${runtime.gatewayToken}`,
          {
            method: "POST",
            headers: {
              "x-goog-api-key": runtime.gatewayToken,
              "content-type": "application/json",
            },
            body: JSON.stringify({ contents: [{ role: "user", parts: [{ text: "hi" }] }] }),
          },
        );
        assert.equal(r5.status, 200);
        await r5.text();

        assert.equal(stub.recorded.length, 5);
        // Verify openai-work
        assert.equal(stub.recorded[0]!.url, "/work/v1/chat/completions");
        assert.equal(stub.recorded[0]!.headers.authorization, "Bearer sk-work-secret");
        // Verify openai-personal (loaded via SecretStore!)
        assert.equal(stub.recorded[1]!.url, "/personal/v1/responses");
        assert.equal(stub.recorded[1]!.headers.authorization, "Bearer sk-personal-secret");
        // Verify Zhipu Team composite extraction & Bearer-only + UA
        assert.equal(stub.recorded[2]!.url, "/zhipu/api/anthropic/v1/messages");
        assert.equal(stub.recorded[2]!.headers.authorization, "Bearer zhipu-real-token");
        assert.equal(stub.recorded[2]!.headers["x-api-key"], undefined);
        assert.equal(stub.recorded[2]!.headers["user-agent"], CODING_PLAN_USER_AGENT);
        assert.equal(JSON.parse(stub.recorded[2]!.body).model, "glm-5.3");
        // Verify DeepSeek V4 Anthropic rewrite
        assert.equal(stub.recorded[3]!.headers["x-api-key"], "sk-deepseek-real");
        assert.equal(stub.recorded[3]!.headers.authorization, undefined);
        assert.deepEqual(JSON.parse(stub.recorded[3]!.body), {
          model: "deepseek-v4-pro",
          thinking: { type: "enabled" },
          output_config: { effort: "high" },
          messages: [],
        });
        // Verify Google GenAI
        assert.equal(
          stub.recorded[4]!.url,
          "/gemini-proxy/v1beta/models/gemini-2.5-pro:streamGenerateContent?custom=1&alt=sse",
        );
        assert.equal(stub.recorded[4]!.headers["x-goog-api-key"], "AIza-real-google-secret");
        assert.equal(stub.recorded[4]!.url.includes(runtime.gatewayToken), false);
      } finally {
        await runtime.close();
      }
    } finally {
      await stub.close();
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it("cancels upstream AbortController on downstream disconnect and isolates mid-stream route mutations", async () => {
    let upstreamAborted!: () => void;
    const upstreamAbortedPromise = new Promise<void>((resolve) => {
      upstreamAborted = resolve;
    });
    let releaseStream1!: () => void;
    const stream1Gate = new Promise<void>((resolve) => {
      releaseStream1 = resolve;
    });
    let stream1FirstChunkSent!: () => void;
    const stream1FirstChunkPromise = new Promise<void>((resolve) => {
      stream1FirstChunkSent = resolve;
    });

    const stub1 = await startStubServer(async (req, res) => {
      if (req.url === "/v1/abort-test/chat/completions") {
        res.writeHead(200, { "content-type": "text/event-stream" });
        res.write("data: chunk-1\n\n");
        res.once("close", () => {
          if (!res.writableEnded) upstreamAborted();
        });
        return;
      }
      res.writeHead(200, { "content-type": "text/event-stream" });
      res.write("data: from-stub-1-part-1\n\n");
      stream1FirstChunkSent();
      await stream1Gate;
      res.write("data: from-stub-1-part-2\n\n");
      res.end();
    });
    const stub2 = await startStubServer((_req, res) => {
      res.writeHead(200, { "content-type": "text/event-stream" });
      res.write("data: from-stub-2\n\n");
      res.end();
    });

    const dir = mkdtempSync(join(tmpdir(), "xtwork-gw-stream-"));
    try {
      const runtime = await startBundledPi(
        "/bin/true",
        dir,
        {},
        {
          skipBinaryAccessCheck: true,
          secretStore: memorySecrets(),
          channels: [
            {
              id: "chan-stream",
              providerType: "openai",
              enabled: true,
              api: "openai-completions",
              baseUrl: `${stub1.baseUrl}/v1`,
              apiKey: "sk-1",
              models: [{ id: "m1", enabled: true }],
            },
            {
              id: "chan-abort",
              providerType: "openai",
              enabled: true,
              api: "openai-completions",
              baseUrl: `${stub1.baseUrl}/v1/abort-test`,
              apiKey: "sk-abort",
              models: [{ id: "m1", enabled: true }],
            },
          ],
        },
      );

      try {
        // 1. Downstream disconnect cancels upstream fetch immediately
        const clientAbort = new AbortController();
        const abortResp = await fetch(
          `http://127.0.0.1:${runtime.port}/c/chan-abort/openai-completions/chat/completions`,
          {
            method: "POST",
            headers: {
              authorization: `Bearer ${runtime.gatewayToken}`,
              "content-type": "application/json",
            },
            body: JSON.stringify({ model: "m1" }),
            signal: clientAbort.signal,
          },
        );
        const reader = abortResp.body!.getReader();
        const first = await reader.read();
        assert.match(new TextDecoder().decode(first.value), /chunk-1/);
        clientAbort.abort();
        await reader.cancel().catch(() => undefined);
        await Promise.race([
          upstreamAbortedPromise,
          new Promise((_, rej) => setTimeout(() => rej(new Error("Upstream was not aborted")), 3000)),
        ]);

        // 2. Request-start route snapshot isolation across mid-stream channel update!
        const inflightPromise = fetch(
          `http://127.0.0.1:${runtime.port}/c/chan-stream/openai-completions/chat/completions`,
          {
            method: "POST",
            headers: {
              authorization: `Bearer ${runtime.gatewayToken}`,
              "content-type": "application/json",
            },
            body: JSON.stringify({ model: "m1" }),
          },
        ).then((r) => r.text());

        await stream1FirstChunkPromise;

        // Mutate chan-stream to point at stub2 while first stream is in flight!
        await runtime.updateChannels([
          {
            id: "chan-stream",
            providerType: "openai",
            enabled: true,
            api: "openai-completions",
            baseUrl: `${stub2.baseUrl}/v1`,
            apiKey: "sk-2",
            models: [{ id: "m1", enabled: true }],
          },
        ]);

        // New request hits stub2 immediately
        const secondText = await fetch(
          `http://127.0.0.1:${runtime.port}/c/chan-stream/openai-completions/chat/completions`,
          {
            method: "POST",
            headers: {
              authorization: `Bearer ${runtime.gatewayToken}`,
              "content-type": "application/json",
            },
            body: JSON.stringify({ model: "m1" }),
          },
        ).then((r) => r.text());
        assert.match(secondText, /from-stub-2/);

        // Release original stream -> completes cleanly on original stub1 snapshot!
        releaseStream1();
        const firstText = await inflightPromise;
        assert.match(firstText, /from-stub-1-part-1/);
        assert.match(firstText, /from-stub-1-part-2/);
      } finally {
        await runtime.close();
      }
    } finally {
      await Promise.all([stub1.close(), stub2.close()]);
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it("handles Codex zstd SSE + placeholder JWT, Copilot availableModelIds, and xAI single-flight fenced refresh", async () => {
    // Verify Codex placeholder JWT has no real secrets and satisfies Pi's extractAccountId format
    const placeholder = createCodexPlaceholderJwt();
    assert.equal(extractCodexAccountId(placeholder), CODEX_PLACEHOLDER_ACCOUNT_ID);
    assert.equal(
      deriveGitHubCopilotBaseUrl("tid=1;proxy-ep=proxy.business.githubcopilot.com;exp=9999"),
      "https://api.business.githubcopilot.com",
    );

    // Verify zstd decompression + Codex header replacement in gateway
    const realCodexJwt = createCodexPlaceholderJwt("real-user-acct-999");
    const stub = await startStubServer((_req, res) => {
      res.writeHead(200, { "content-type": "text/event-stream" });
      res.write('data: {"type":"response.completed"}\n\n');
      res.end();
    });
    const dir = mkdtempSync(join(tmpdir(), "xtwork-gw-oauth-"));
    try {
      const secretStore = memorySecrets();
      const fence = new ChannelCredentialFence();
      const runtime = await startBundledPi(
        "/bin/true",
        dir,
        {},
        {
          skipBinaryAccessCheck: true,
          secretStore,
          fence,
          validateOAuthDestination: allowLoopbackOAuthForTests,
          channels: [
            {
              id: "codex-sub",
              providerType: "openai-codex",
              enabled: true,
              api: "openai-codex-responses",
              baseUrl: stub.baseUrl,
              models: [{ id: "gpt-6-sol", enabled: true }],
              oauth: {
                provider: "openai-codex",
                secretRef: "oauth:codex-sub",
                initialCredentials: {
                  access: realCodexJwt,
                  refresh: "real-codex-refresh",
                  expires: Date.now() + 3_600_000,
                  accountId: "real-user-acct-999",
                },
                refresh: async (c) => c,
              },
            },
            {
              id: "copilot-sub",
              providerType: "github-copilot",
              enabled: true,
              api: "openai-completions",
              baseUrl: stub.baseUrl,
              availableModelIds: ["gpt-4.1"],
              models: [
                { id: "gpt-4.1", enabled: true },
                { id: "claude-blocked", enabled: true },
              ],
              oauth: {
                provider: "github-copilot",
                secretRef: "oauth:copilot-sub",
                initialCredentials: {
                  access: "tid=real-copilot-access;proxy-ep=proxy.individual.githubcopilot.com",
                  refresh: "gho_real_refresh",
                  expires: Date.now() + 3_600_000,
                  availableModelIds: ["gpt-4.1"],
                },
                refresh: async (c) => c,
              },
            },
          ],
        },
      );
      try {
        // Send zstd-compressed Codex request with placeholder JWT + gateway token header
        const compressed = zstdCompressSync(JSON.stringify({ model: "gpt-6-sol", input: [] }));
        const codexRes = await fetch(
          `http://127.0.0.1:${runtime.port}/c/codex-sub/openai-codex-responses/codex/responses`,
          {
            method: "POST",
            headers: {
              authorization: `Bearer ${placeholder}`,
              "chatgpt-account-id": CODEX_PLACEHOLDER_ACCOUNT_ID,
              [GATEWAY_TOKEN_HEADER]: runtime.gatewayToken,
              "content-encoding": "zstd",
              "content-type": "application/json",
            },
            body: compressed,
          },
        );
        assert.equal(codexRes.status, 200);
        await codexRes.text();
        assert.equal(stub.recorded[0]!.url, "/codex/responses");
        assert.equal(stub.recorded[0]!.headers.authorization, `Bearer ${realCodexJwt}`);
        assert.equal(stub.recorded[0]!.headers["chatgpt-account-id"], "real-user-acct-999");
        assert.equal(stub.recorded[0]!.headers[GATEWAY_TOKEN_HEADER], undefined);

        // Copilot disallowed model is rejected with 403 and excluded from models.json
        const modelsJson = buildPiModelsJson(runtime.port, [
          {
            id: "copilot-sub",
            providerType: "github-copilot",
            enabled: true,
            api: "openai-completions",
            availableModelIds: ["gpt-4.1"],
            models: [
              { id: "gpt-4.1", enabled: true },
              { id: "claude-blocked", enabled: true },
            ],
          },
        ], false);
        assert.equal(JSON.stringify(modelsJson).includes("claude-blocked"), false);

        const blockedRes = await fetch(
          `http://127.0.0.1:${runtime.port}/c/copilot-sub/openai-completions/chat/completions`,
          {
            method: "POST",
            headers: {
              authorization: `Bearer ${runtime.gatewayToken}`,
              "content-type": "application/json",
            },
            body: JSON.stringify({ model: "claude-blocked", messages: [] }),
          },
        );
        assert.equal(blockedRes.status, 403);
      } finally {
        await runtime.close();
      }
    } finally {
      await stub.close();
      rmSync(dir, { recursive: true, force: true });
    }

    // xAI single-flight serialized refresh + fence race protection
    const xaiSecretStore = memorySecrets();
    const xaiFence = new ChannelCredentialFence();
    let refreshCalls = 0;
    const tokenStub = await startStubServer(async (_req, res) => {
      refreshCalls++;
      await new Promise((r) => setTimeout(r, 40));
      res.writeHead(200, { "content-type": "application/json" });
      res.end(
        JSON.stringify({
          access_token: `xai-fresh-${refreshCalls}`,
          refresh_token: `xai-rot-${refreshCalls}`,
          expires_in: 3600,
        }),
      );
    });
    try {
      const expired: XaiOAuthCredentials = {
        access: "xai-expired",
        refresh: "xai-refresh-0",
        expires: Date.now() + 10_000, // inside 60s skew
      };
      await xaiSecretStore.set("oauth:xai-1", JSON.stringify(expired));

      const manager = new OAuthTokenManager({
        secretStore: xaiSecretStore,
        fence: xaiFence,
      });
      manager.register<XaiOAuthCredentials>({
        channelId: "xai-1",
        provider: "xai",
        secretRef: "oauth:xai-1",
        initialCredentials: expired,
        refresh: (cur, signal) =>
          refreshXaiOAuthToken(cur, signal, {
            tokenUrl: `${tokenStub.baseUrl}/oauth2/token`,
            validateDestination: allowLoopbackOAuthForTests,
          }),
      });

      // Fire 5 concurrent refreshes -> MUST share a single HTTP refresh call!
      const results = await Promise.all(
        Array.from({ length: 5 }, () => manager.getValidCredentials<XaiOAuthCredentials>("xai-1")),
      );
      assert.equal(refreshCalls, 1);
      for (const creds of results) {
        assert.equal(creds.access, "xai-fresh-1");
        assert.equal(creds.refresh, "xai-rot-1");
      }
      assert.equal(
        JSON.parse((await xaiSecretStore.get("oauth:xai-1"))!).access,
        "xai-fresh-1",
      );

      // Now simulate logout racing an in-flight xAI refresh!
      let releaseSlowRefresh!: () => void;
      const slowManager = new OAuthTokenManager({
        secretStore: xaiSecretStore,
        fence: xaiFence,
      });
      slowManager.register<XaiOAuthCredentials>({
        channelId: "xai-race",
        provider: "xai",
        secretRef: "oauth:xai-race",
        initialCredentials: { access: "old", refresh: "r0", expires: Date.now() - 1000 },
        refresh: async () => {
          await new Promise<void>((r) => {
            releaseSlowRefresh = r;
          });
          return { access: "resurrected", refresh: "r1", expires: Date.now() + 3_600_000 };
        },
      });
      await xaiSecretStore.set("oauth:xai-race", JSON.stringify({ access: "old", refresh: "r0", expires: 0 }));

      const inflight = slowManager.getValidCredentials<XaiOAuthCredentials>("xai-race");
      await new Promise((r) => setTimeout(r, 10));
      await slowManager.revokeAndDelete("xai-race", "oauth:xai-race", "logout");
      releaseSlowRefresh();
      await assert.rejects(
        () => inflight,
        (err: unknown) => err instanceof SecretStoreUnavailableError && err.code === "SECRET_FENCE_STALE",
      );
      assert.equal(await xaiSecretStore.get("oauth:xai-race"), undefined);
    } finally {
      await tokenStub.close();
    }
  });

  it("extracts Zhipu composite credentials, rewrites DeepSeek V4 thinking, and prioritizes fallback models", () => {
    assert.equal(
      extractZhipuCodingTeamApiToken("apiKey=abc123; bigmodel_organization=org; bigmodel_project=p"),
      "abc123",
    );
    assert.equal(
      extractZhipuCodingTeamApiToken('{"api_key":"json-key","org":"o"}'),
      "json-key",
    );
    assert.deepEqual(
      rewriteDeepSeekV4AnthropicBody(
        { model: "deepseek-v4-flash", thinking: { type: "disabled" } },
        "deepseek",
        "deepseek-v4-flash",
      ),
      { model: "deepseek-v4-flash", thinking: { type: "disabled" } },
    );
    assert.equal(
      resolveFallbackModel(
        [
          {
            id: "openai-1",
            providerType: "openai",
            enabled: true,
            api: "openai-completions",
            models: [{ id: "gpt-4o", enabled: true }],
          },
          {
            id: COMPANY_CHANNEL_ID,
            providerType: "company-team",
            enabled: true,
            api: "openai-completions",
            models: [
              { id: "other", enabled: true },
              { id: COMPANY_DEFAULT_MODEL_ID, enabled: true },
            ],
          },
        ],
        true,
      ),
      `${COMPANY_CHANNEL_ID}/${COMPANY_DEFAULT_MODEL_ID}`,
    );
    assert.equal(resolveFallbackModel([], false), null);
    assert.equal(resolveFallbackModel([], true), "xtwork/standard");
  });

  it("blocks pre-logout SecretStore read races and concurrent reads during pending deletion (#1)", async () => {
    const backing = memorySecrets();
    const expiredCreds = JSON.stringify({ access: "old-a", refresh: "old-r", expires: Date.now() - 10_000 });
    await backing.set("oauth:race-pre", expiredCreds);

    let enteredSlowGet!: () => void;
    const enteredGetPromise = new Promise<void>((r) => {
      enteredSlowGet = r;
    });
    let releaseSlowGet!: () => void;
    const slowGetGate = new Promise<void>((r) => {
      releaseSlowGet = r;
    });
    let slowGetOnce = true;

    let enteredSlowDelete!: () => void;
    const enteredDeletePromise = new Promise<void>((r) => {
      enteredSlowDelete = r;
    });
    let releaseSlowDelete!: () => void;
    const slowDeleteGate = new Promise<void>((r) => {
      releaseSlowDelete = r;
    });
    let slowDeleteOnce = false;

    const racyStore: SecretStore = {
      async get(ref) {
        if (slowGetOnce && ref === "oauth:race-pre") {
          slowGetOnce = false;
          const val = await backing.get(ref);
          enteredSlowGet();
          await slowGetGate;
          return val;
        }
        return backing.get(ref);
      },
      set: (ref, val) => backing.set(ref, val),
      async delete(ref) {
        if (slowDeleteOnce && ref === "oauth:race-del") {
          slowDeleteOnce = false;
          enteredSlowDelete();
          await slowDeleteGate;
        }
        await backing.delete(ref);
      },
    };

    const fence = new ChannelCredentialFence();
    const manager = new OAuthTokenManager({ secretStore: racyStore, fence });
    let refreshInvocations = 0;
    manager.register<XaiOAuthCredentials>({
      channelId: "race-pre",
      provider: "xai",
      secretRef: "oauth:race-pre",
      refresh: async () => {
        refreshInvocations++;
        return { access: "resurrected", refresh: "resurrected-r", expires: Date.now() + 3_600_000 };
      },
    });

    // 1. Read starts at gen 0 (before logout), pauses in SecretStore.get.
    const preLogoutRead = manager.getValidCredentials<XaiOAuthCredentials>("race-pre");
    await enteredGetPromise;

    // 2. Logout runs and completes at gen 1.
    await manager.revokeAndDelete("race-pre", "oauth:race-pre", "user logout");
    assert.equal(await backing.get("oauth:race-pre"), undefined);

    // 3. Slow read finishes -> MUST reject SECRET_FENCE_STALE, NEVER cache, NEVER refresh, NEVER write back!
    releaseSlowGet();
    await assert.rejects(
      () => preLogoutRead,
      (err: unknown) => err instanceof SecretStoreUnavailableError && err.code === "SECRET_FENCE_STALE",
    );
    assert.equal(refreshInvocations, 0);
    assert.equal(manager.getCached("race-pre"), undefined);
    assert.equal(await backing.get("oauth:race-pre"), undefined);

    // 4. New reads arriving WHILE deletion is pending MUST be rejected immediately!
    await backing.set("oauth:race-del", JSON.stringify({ access: "live", refresh: "r", expires: Date.now() + 3_600_000 }));
    manager.register<XaiOAuthCredentials>({
      channelId: "race-del",
      provider: "xai",
      secretRef: "oauth:race-del",
      refresh: async (c) => c,
    });
    slowDeleteOnce = true;
    const pendingDelete = manager.revokeAndDelete("race-del", "oauth:race-del", "deleting");
    await enteredDeletePromise;
    await assert.rejects(
      () => manager.getValidCredentials("race-del"),
      (err: unknown) => err instanceof SecretStoreUnavailableError && err.code === "SECRET_FENCE_STALE",
    );
    releaseSlowDelete();
    await pendingDelete;
  });

  it("enforces strict OAuth HTTPS destination allowlists and redirect:error on all credential-bearing requests (#2)", async () => {
    // Copilot proxy-ep allowlist & enterprise domain validation
    assert.equal(
      deriveGitHubCopilotBaseUrl("tid=1;proxy-ep=proxy.business.githubcopilot.com;exp=9999"),
      "https://api.business.githubcopilot.com",
    );
    assert.equal(
      deriveGitHubCopilotBaseUrl("tid=1;exp=9999", "https://ghe.example.com"),
      "https://copilot-api.ghe.example.com",
    );
    for (const maliciousToken of [
      "tid=1;proxy-ep=proxy.evil.com",
      "tid=1;proxy-ep=169.254.169.254",
      "tid=1;proxy-ep=user@api.individual.githubcopilot.com",
      "tid=1;proxy-ep=proxy.individual.githubcopilot.com/evil",
      "tid=1;proxy-ep=proxy.individual.githubcopilot.com:8443",
    ]) {
      assert.throws(() => deriveGitHubCopilotBaseUrl(maliciousToken));
    }

    // Refresh endpoints reject untrusted hosts by default AND refuse HTTP 302 redirects!
    await assert.rejects(() =>
      refreshXaiOAuthToken(
        { access: "a", refresh: "r", expires: 0 },
        undefined,
        { tokenUrl: "https://evil.example.com/oauth2/token" },
      ),
    );
    await assert.rejects(() =>
      refreshCodexOAuthToken(
        { access: "a", refresh: "r", expires: 0 },
        undefined,
        { tokenUrl: "https://evil.example.com/oauth/token" },
      ),
    );

    const redirectStub = await startStubServer((req, res) => {
      res.writeHead(302, { location: `${redirectStub.baseUrl}/exfiltrate` });
      res.end();
    });
    const dir = mkdtempSync(join(tmpdir(), "xtwork-gw-oauth-dest-"));
    try {
      await assert.rejects(() =>
        refreshXaiOAuthToken(
          { access: "a", refresh: "r-secret", expires: 0 },
          undefined,
          {
            tokenUrl: `${redirectStub.baseUrl}/oauth2/token`,
            validateDestination: allowLoopbackOAuthForTests,
          },
        ),
      );
      await assert.rejects(() =>
        refreshCodexOAuthToken(
          { access: "a", refresh: "r-secret", expires: 0 },
          undefined,
          {
            tokenUrl: `${redirectStub.baseUrl}/oauth/token`,
            validateDestination: allowLoopbackOAuthForTests,
          },
        ),
      );
      // Confirm redirect target was NEVER followed!
      assert.equal(redirectStub.recorded.some((r) => r.url === "/exfiltrate"), false);

      // Default gateway WITHOUT test override rejects untrusted OAuth baseUrl (never sends real Bearer token!)
      const runtime = await startBundledPi(
        "/bin/true",
        dir,
        {},
        {
          skipBinaryAccessCheck: true,
          secretStore: memorySecrets(),
          channels: [
            {
              id: "xai-evil-override",
              providerType: "xai",
              enabled: true,
              api: "openai-responses",
              baseUrl: `${redirectStub.baseUrl}/v1`,
              models: [{ id: "grok-4.6", enabled: true }],
              oauth: {
                provider: "xai",
                secretRef: "oauth:xai-evil",
                initialCredentials: {
                  access: "xai-never-send-me",
                  refresh: "r",
                  expires: Date.now() + 3_600_000,
                },
                refresh: async (c) => c,
              },
            },
          ],
        },
      );
      try {
        const countBefore = redirectStub.recorded.length;
        const res = await fetch(
          `http://127.0.0.1:${runtime.port}/c/xai-evil-override/openai-responses/responses`,
          {
            method: "POST",
            headers: {
              authorization: `Bearer ${runtime.gatewayToken}`,
              "content-type": "application/json",
            },
            body: JSON.stringify({ model: "grok-4.6", input: "hi" }),
          },
        );
        assert.equal(res.status, 403);
        const body = (await res.json()) as { error: { code: string } };
        assert.equal(body.error.code, "invalid_oauth_destination");
        assert.equal(redirectStub.recorded.length, countBefore);
      } finally {
        await runtime.close();
      }
    } finally {
      await redirectStub.close();
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it("sanitizes credential errors and redacts injected secrets in headers, SSE, and binary application/octet-stream responses (#3)", async () => {
    const secretKey = "sk-super-secret-reflection-98765";
    let binaryMode = false;
    const stub = await startStubServer(async (_req, res) => {
      if (binaryMode) {
        // Binary response (`application/octet-stream`) with raw non-UTF8 bytes AND secret split across chunks!
        res.writeHead(200, { "content-type": "application/octet-stream" });
        res.write(Buffer.concat([Buffer.from([0xff, 0xfe]), Buffer.from(secretKey.slice(0, 14), "utf8")]));
        await new Promise((r) => setTimeout(r, 10));
        res.write(Buffer.concat([Buffer.from(secretKey.slice(14), "utf8"), Buffer.from([0x00, 0x7f])]));
        res.end();
        return;
      }
      // Echo the secret both in an allowed response header AND split across two SSE TCP chunks!
      res.writeHead(200, {
        "content-type": "text/event-stream",
        "x-request-id": `req-${secretKey}-end`,
        "set-cookie": "session=should-be-stripped",
      });
      res.write(`data: {"chunk":1,"msg":"leaked ${secretKey.slice(0, 12)}`);
      await new Promise((r) => setTimeout(r, 15));
      res.write(`${secretKey.slice(12)} ok"}\n\n`);
      res.end();
    });
    const dir = mkdtempSync(join(tmpdir(), "xtwork-gw-redact-"));
    try {
      const runtime = await startBundledPi(
        "/bin/true",
        dir,
        {},
        {
          skipBinaryAccessCheck: true,
          secretStore: memorySecrets(),
          validateOAuthDestination: allowLoopbackOAuthForTests,
          channels: [
            {
              id: "reflect-chan",
              providerType: "openai",
              enabled: true,
              api: "openai-completions",
              baseUrl: `${stub.baseUrl}/v1`,
              apiKey: secretKey,
              models: [{ id: "gpt-4o", enabled: true }],
            },
            {
              id: "failing-oauth",
              providerType: "xai",
              enabled: true,
              api: "openai-responses",
              baseUrl: `${stub.baseUrl}/v1`,
              models: [{ id: "grok-4.6", enabled: true }],
              oauth: {
                provider: "xai",
                secretRef: "oauth:failing-oauth",
                initialCredentials: { access: "old", refresh: "sensitive-refresh-body", expires: 0 },
                refresh: async () => {
                  throw new Error("raw oauth upstream error containing TOP_SECRET_OAUTH_PAYLOAD");
                },
              },
            },
          ],
        },
      );
      try {
        // 1. OAuth refresh error message MUST be sanitized (zero leak of raw upstream text!)
        const errRes = await fetch(
          `http://127.0.0.1:${runtime.port}/c/failing-oauth/openai-responses/responses`,
          {
            method: "POST",
            headers: {
              authorization: `Bearer ${runtime.gatewayToken}`,
              "content-type": "application/json",
            },
            body: JSON.stringify({ model: "grok-4.6", input: "hi" }),
          },
        );
        assert.equal(errRes.status, 502);
        const errText = await errRes.text();
        assert.equal(errText.includes("TOP_SECRET_OAUTH_PAYLOAD"), false);
        assert.equal(errText.includes("sensitive-refresh-body"), false);
        assert.match(errText, /credential_error/);

        // 2. Forwarded SSE chunks & response headers MUST redact injected secret even across chunk boundaries!
        const okRes = await fetch(
          `http://127.0.0.1:${runtime.port}/c/reflect-chan/openai-completions/chat/completions`,
          {
            method: "POST",
            headers: {
              authorization: `Bearer ${runtime.gatewayToken}`,
              "content-type": "application/json",
            },
            body: JSON.stringify({ model: "gpt-4o", messages: [] }),
          },
        );
        assert.equal(okRes.status, 200);
        assert.equal(okRes.headers.get("set-cookie"), null);
        assert.equal(okRes.headers.get("x-request-id"), "req-[REDACTED]-end");
        const sseText = await okRes.text();
        assert.equal(sseText.includes(secretKey), false);
        assert.match(sseText, /leaked \[REDACTED\] ok/);

        // 3. Binary `application/octet-stream` responses MUST NOT bypass redaction either!
        binaryMode = true;
        const binRes = await fetch(
          `http://127.0.0.1:${runtime.port}/c/reflect-chan/openai-completions/chat/completions`,
          {
            method: "POST",
            headers: {
              authorization: `Bearer ${runtime.gatewayToken}`,
              "content-type": "application/json",
            },
            body: JSON.stringify({ model: "gpt-4o", messages: [] }),
          },
        );
        assert.equal(binRes.status, 200);
        const binBuf = Buffer.from(await binRes.arrayBuffer());
        assert.equal(binBuf.includes(Buffer.from(secretKey, "utf8")), false);
        assert.deepEqual(
          binBuf,
          Buffer.concat([Buffer.from([0xff, 0xfe]), Buffer.from("[REDACTED]", "utf8"), Buffer.from([0x00, 0x7f])]),
        );
      } finally {
        await runtime.close();
      }
    } finally {
      await stub.close();
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it("caps streaming zstd decompression at 16 MiB and handles malformed URLs safely (#4, #5)", async () => {
    const stub = await startStubServer((_req, res) => {
      res.writeHead(200, { "content-type": "application/json" });
      res.end('{"ok":true}');
    });
    const dir = mkdtempSync(join(tmpdir(), "xtwork-gw-zstd-"));
    try {
      const runtime = await startBundledPi(
        "/bin/true",
        dir,
        {},
        {
          skipBinaryAccessCheck: true,
          secretStore: memorySecrets(),
          channels: [
            {
              id: "chan-z",
              providerType: "openai",
              enabled: true,
              api: "openai-completions",
              baseUrl: `${stub.baseUrl}/v1`,
              apiKey: "sk-z",
              models: [{ id: "m1", enabled: true }],
            },
          ],
        },
      );
      try {
        // 1. 17 MiB zstd bomb (compresses to ~2 KB) MUST be aborted and rejected with HTTP 413!
        const bombCompressed = zstdCompressSync(Buffer.alloc(17 * 1024 * 1024, 0x41));
        assert.ok(bombCompressed.byteLength < 64 * 1024);
        const bombRes = await fetch(
          `http://127.0.0.1:${runtime.port}/c/chan-z/openai-completions/chat/completions`,
          {
            method: "POST",
            headers: {
              authorization: `Bearer ${runtime.gatewayToken}`,
              "content-encoding": "zstd",
              "content-type": "application/json",
            },
            body: bombCompressed,
          },
        );
        assert.equal(bombRes.status, 413);
        const bombJson = (await bombRes.json()) as { error: { code: string } };
        assert.equal(bombJson.error.code, "payload_too_large");

        // 2. Malformed percent-escapes AND literal or percent-encoded dot segments (`..`, `%2e%2e`,
        // `%2e.`, `.%2e`, `%2e`) MUST return 400 BEFORE `new URL` normalizes them away (#5)!
        for (const badPath of [
          "/c/%E0%A4%A/openai-completions/chat/completions",
          "/c/chan-z/openai-completions/%E0%A4%A",
          "/c/chan-z/openai-completions/chat/%ZZ",
          "/c/chan-z/openai-completions/%ZZ/../chat/completions",
          "/c/chan-z/openai-completions/foo/../chat/completions",
          "/c/chan-z/openai-completions/%2e%2e/chat/completions",
          "/c/chan-z/openai-completions/%2e./chat/completions",
          "/c/chan-z/openai-completions/.%2e/chat/completions",
          "/c/chan-z/openai-completions/%2e/chat/completions",
        ]) {
          // Use raw httpRequest so Node does NOT normalize `..` before it reaches the gateway!
          const status = await new Promise<number>((resolveStatus, rejectReq) => {
            const req = httpRequest(
              {
                host: "127.0.0.1",
                port: runtime.port,
                path: badPath,
                method: "POST",
                headers: {
                  authorization: `Bearer ${runtime.gatewayToken}`,
                  "content-type": "application/json",
                },
              },
              (res) => {
                res.resume();
                res.on("end", () => resolveStatus(res.statusCode ?? 0));
              },
            );
            req.on("error", rejectReq);
            req.end(JSON.stringify({ model: "m1" }));
          });
          assert.equal(status, 400, `Expected 400 for malformed raw path ${badPath}, got ${status}`);
        }

        // 3. Server remains completely healthy afterwards
        const healthy = await fetch(
          `http://127.0.0.1:${runtime.port}/c/chan-z/openai-completions/chat/completions`,
          {
            method: "POST",
            headers: {
              authorization: `Bearer ${runtime.gatewayToken}`,
              "content-type": "application/json",
            },
            body: JSON.stringify({ model: "m1" }),
          },
        );
        assert.equal(healthy.status, 200);
        await healthy.text();
      } finally {
        await runtime.close();
      }
    } finally {
      await stub.close();
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it("preserves rotated OAuth tokens across metadata edits and fences secretRef swaps or removals (#6)", async () => {
    const store = memorySecrets();
    const fence = new ChannelCredentialFence();
    const manager = new OAuthTokenManager({ secretStore: store, fence });

    const initial: XaiOAuthCredentials = { access: "tok-v0", refresh: "ref-v0", expires: Date.now() - 1000 };
    await store.set("oauth:acct-1", JSON.stringify(initial));

    manager.register<XaiOAuthCredentials>({
      channelId: "xai-meta",
      provider: "xai",
      secretRef: "oauth:acct-1",
      initialCredentials: initial,
      refresh: async () => ({
        access: "tok-rotated-v1",
        refresh: "ref-rotated-v1",
        expires: Date.now() + 3_600_000,
      }),
    });

    // Trigger rotation -> live token is now tok-rotated-v1
    const rotated = await manager.getValidCredentials<XaiOAuthCredentials>("xai-meta");
    assert.equal(rotated.access, "tok-rotated-v1");

    // Metadata-only re-register passing stale initialCredentials MUST preserve rotated token!
    manager.register<XaiOAuthCredentials>({
      channelId: "xai-meta",
      provider: "xai",
      secretRef: "oauth:acct-1",
      initialCredentials: initial,
      refresh: async () => {
        throw new Error("Should not refresh when rotated token is still fresh");
      },
    });
    const afterMetaEdit = await manager.getValidCredentials<XaiOAuthCredentials>("xai-meta");
    assert.equal(afterMetaEdit.access, "tok-rotated-v1");

    // Start a slow refresh on acct-1, then swap secretRef to acct-2 -> old refresh MUST be aborted/fenced and new account loaded!
    await store.set(
      "oauth:acct-2",
      JSON.stringify({ access: "tok-acct-2", refresh: "ref-acct-2", expires: Date.now() + 3_600_000 }),
    );
    let enteredSlow!: () => void;
    const enteredP = new Promise<void>((r) => {
      enteredSlow = r;
    });
    let releaseSlow!: () => void;
    const releaseP = new Promise<void>((r) => {
      releaseSlow = r;
    });
    let slowAborted = false;

    manager.register<XaiOAuthCredentials>({
      channelId: "xai-swap",
      provider: "xai",
      secretRef: "oauth:acct-1",
      initialCredentials: { access: "old-1", refresh: "r-1", expires: 0 },
      refresh: async (_cur, sig) => {
        sig.addEventListener("abort", () => {
          slowAborted = true;
        });
        enteredSlow();
        await releaseP;
        return { access: "stale-acct-1", refresh: "sr", expires: Date.now() + 3_600_000 };
      },
    });
    const inflightOld = manager.getValidCredentials<XaiOAuthCredentials>("xai-swap");
    await enteredP;

    // Swap secretRef to oauth:acct-2 -> MUST fence & abort old in-flight refresh and clear cache!
    manager.register<XaiOAuthCredentials>({
      channelId: "xai-swap",
      provider: "xai",
      secretRef: "oauth:acct-2",
      refresh: async (c) => c,
    });
    assert.equal(slowAborted, true);
    releaseSlow();
    await assert.rejects(
      () => inflightOld,
      (err: unknown) => err instanceof SecretStoreUnavailableError && err.code === "SECRET_FENCE_STALE",
    );
    const swapped = await manager.getValidCredentials<XaiOAuthCredentials>("xai-swap");
    assert.equal(swapped.access, "tok-acct-2");

    // Unregistering MUST also bump fence generation & clear cache!
    const genBeforeUnreg = fence.generation("xai-swap");
    manager.unregister("xai-swap");
    assert.equal(fence.generation("xai-swap"), genBeforeUnreg + 1);
    assert.equal(manager.getCached("xai-swap"), undefined);
  });

  it("enforces Copilot policy against actual upstreamModelId, allowlists exact methods/paths, and allowlists headers/query (#7, #13)", async () => {
    const stub = await startStubServer((_req, res) => {
      res.writeHead(200, { "content-type": "application/json" });
      res.end('{"ok":true}');
    });
    const dir = mkdtempSync(join(tmpdir(), "xtwork-gw-allowlist-"));
    try {
      const runtime = await startBundledPi(
        "/bin/true",
        dir,
        {},
        {
          skipBinaryAccessCheck: true,
          secretStore: memorySecrets(),
          validateOAuthDestination: allowLoopbackOAuthForTests,
          channels: [
            {
              id: "copilot-alias",
              providerType: "github-copilot",
              enabled: true,
              api: "openai-completions",
              baseUrl: stub.baseUrl,
              availableModelIds: ["gpt-4.1"],
              models: [
                // Local alias mapped to an ALLOWED upstreamModelId MUST be kept & routed (#7)!
                { id: "my-fast-gpt", upstreamModelId: "gpt-4.1", enabled: true },
                // Local id is permitted, but upstreamModelId rewrites to a DISALLOWED model -> MUST be blocked!
                { id: "gpt-4.1", upstreamModelId: "claude-opus-blocked", enabled: true },
              ],
              oauth: {
                provider: "github-copilot",
                secretRef: "oauth:copilot-alias",
                initialCredentials: {
                  access: "tid=tok;proxy-ep=proxy.individual.githubcopilot.com",
                  refresh: "gho_r",
                  expires: Date.now() + 3_600_000,
                  availableModelIds: ["gpt-4.1"],
                },
                refresh: async (c) => c,
              },
            },
            {
              id: "strict-openai",
              providerType: "openai",
              enabled: true,
              api: "openai-completions",
              baseUrl: `${stub.baseUrl}/v1?tenant=configured`,
              apiKey: "sk-strict",
              models: [{ id: "gpt-4o", enabled: true }],
            },
          ],
        },
      );
      try {
        // 1. Allowed local alias (`my-fast-gpt` -> `gpt-4.1`) MUST be kept in models.json and routed,
        // while disallowed upstreamModelId (`gpt-4.1` -> `claude-opus-blocked`) MUST be excluded & rejected with 403!
        const parsedModels = JSON.parse(readFileSync(join(runtime.agentDir, "models.json"), "utf8")) as {
          providers: Record<string, { models: Array<{ id: string }> }>;
        };
        assert.deepEqual(
          parsedModels.providers["copilot-alias"]?.models.map((m) => m.id),
          ["my-fast-gpt"],
        );
        const allowedAliasRes = await fetch(
          `http://127.0.0.1:${runtime.port}/c/copilot-alias/openai-completions/chat/completions`,
          {
            method: "POST",
            headers: {
              authorization: `Bearer ${runtime.gatewayToken}`,
              "content-type": "application/json",
            },
            body: JSON.stringify({ model: "my-fast-gpt", messages: [] }),
          },
        );
        assert.equal(allowedAliasRes.status, 200);
        await allowedAliasRes.text();
        assert.equal(JSON.parse(stub.recorded[0]!.body).model, "gpt-4.1");

        const copilotRes = await fetch(
          `http://127.0.0.1:${runtime.port}/c/copilot-alias/openai-completions/chat/completions`,
          {
            method: "POST",
            headers: {
              authorization: `Bearer ${runtime.gatewayToken}`,
              "content-type": "application/json",
            },
            body: JSON.stringify({ model: "gpt-4.1", messages: [] }),
          },
        );
        assert.equal(copilotRes.status, 403);
        assert.equal(((await copilotRes.json()) as { error: { code: string } }).error.code, "model_not_permitted");

        // 2. Non-POST methods (GET/DELETE) -> 405
        const getRes = await fetch(
          `http://127.0.0.1:${runtime.port}/c/strict-openai/openai-completions/chat/completions`,
          { method: "GET", headers: { authorization: `Bearer ${runtime.gatewayToken}` } },
        );
        assert.equal(getRes.status, 405);

        // 3. Disallowed subpaths (/files, /models, /v1/embeddings) -> 404 endpoint_not_allowed
        for (const badPath of ["/files", "/models", "/v1/embeddings"]) {
          const badRes = await fetch(
            `http://127.0.0.1:${runtime.port}/c/strict-openai/openai-completions${badPath}`,
            {
              method: "POST",
              headers: {
                authorization: `Bearer ${runtime.gatewayToken}`,
                "content-type": "application/json",
              },
              body: JSON.stringify({ model: "gpt-4o" }),
            },
          );
          assert.equal(badRes.status, 404, `Expected 404 for ${badPath}, got ${badRes.status}`);
        }

        // 4. Header & query allowlist: strips Cookie, Proxy-Authorization, X-Forwarded-For,
        // Connection-nominated headers, and arbitrary client query params while preserving
        // allowlisted headers & channel-configured query params!
        // Use node:http request directly because undici fetch strips client-specified `connection` headers.
        const rawHttpStatus = await new Promise<number>((resolveStatus, rejectReq) => {
          const req = httpRequest(
            {
              host: "127.0.0.1",
              port: runtime.port,
              path: "/c/strict-openai/openai-completions/chat/completions?injected=evil&key=leak",
              method: "POST",
              headers: {
                authorization: `Bearer ${runtime.gatewayToken}`,
                "content-type": "application/json",
                "openai-beta": "assistants=v2",
                "x-client-request-id": "drop-via-connection",
                connection: "x-client-request-id, close",
                cookie: "session=secret-cookie",
                "proxy-authorization": "Basic c2VjcmV0",
                "x-forwarded-for": "1.2.3.4",
                "x-random-untrusted": "nope",
              },
            },
            (res) => {
              res.resume();
              res.on("end", () => resolveStatus(res.statusCode ?? 0));
            },
          );
          req.on("error", rejectReq);
          req.end(JSON.stringify({ model: "gpt-4o", messages: [] }));
        });
        assert.equal(rawHttpStatus, 200);
        assert.equal(stub.recorded.length, 2);
        const rec = stub.recorded[1]!;
        assert.equal(rec.url, "/v1/chat/completions?tenant=configured");
        assert.equal(rec.headers["openai-beta"], "assistants=v2");
        assert.equal(rec.headers["x-client-request-id"], undefined);
        assert.equal(rec.headers["cookie"], undefined);
        assert.equal(rec.headers["proxy-authorization"], undefined);
        assert.equal(rec.headers["x-forwarded-for"], undefined);
        assert.equal(rec.headers["x-random-untrusted"], undefined);
      } finally {
        await runtime.close();
      }
    } finally {
      await stub.close();
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it("serializes concurrent updateChannels and keeps prior routes intact when disk persistence fails (#14, #15)", async () => {
    const stub1 = await startStubServer((_req, res) => {
      res.writeHead(200, { "content-type": "application/json" });
      res.end('{"stub":1}');
    });
    const stub2 = await startStubServer((_req, res) => {
      res.writeHead(200, { "content-type": "application/json" });
      res.end('{"stub":2}');
    });
    const dir = mkdtempSync(join(tmpdir(), "xtwork-gw-atomic-"));
    try {
      // Confirm omitting options.secretStore wires the real OS-backed SecretStore (NOT memorySecrets) (#15)
      const defaultRuntime = await startBundledPi("/bin/true", dir, {}, { skipBinaryAccessCheck: true });
      try {
        assert.equal(typeof defaultRuntime.secretStore.read, "function");
        // memorySecrets never rejects INVALID_SECRET_REF? Both do, so verify by checking
        // that a fresh read on an absent random key does NOT hit an in-memory map we never set,
        // and verify defaultRuntime.secretStore is constructed via createSecretStore (not memorySecrets).
        assert.notEqual(defaultRuntime.secretStore.set.toString(), memorySecrets().set.toString());
      } finally {
        await defaultRuntime.close();
      }

      const chan1: GatewayChannelConfig = {
        id: "chan-atomic",
        providerType: "openai",
        enabled: true,
        api: "openai-completions",
        baseUrl: `${stub1.baseUrl}/v1`,
        apiKey: "sk-1",
        models: [{ id: "m1", enabled: true }],
      };
      const chan2: GatewayChannelConfig = {
        id: "chan-atomic",
        providerType: "openai",
        enabled: true,
        api: "openai-completions",
        baseUrl: `${stub2.baseUrl}/v1`,
        apiKey: "sk-2",
        models: [{ id: "m2", enabled: true }],
      };

      const runtime = await startBundledPi(
        "/bin/true",
        dir,
        {},
        { channels: [chan1], secretStore: memorySecrets(), skipBinaryAccessCheck: true },
      );
      try {
        // Concurrent updateChannels calls execute serially in order and end on the exact final revision
        const [rA, rB] = await Promise.all([
          runtime.updateChannels([chan2]),
          runtime.updateChannels([chan1]),
        ]);
        assert.equal(rA.revision, 2);
        assert.equal(rB.revision, 3);
        assert.equal(runtime.getDefaultModelSlug(), "chan-atomic/m1");
        const diskAfterConcurrent = JSON.parse(readFileSync(join(runtime.agentDir, "models.json"), "utf8"));
        assert.equal(diskAfterConcurrent.providers["chan-atomic"].models[0].id, "m1");

        // Make agentDir read-only so models.json persistence fails -> routes & defaults MUST stay on rev 3!
        chmodSync(runtime.agentDir, 0o500);
        try {
          await assert.rejects(() => runtime.updateChannels([chan2]));
          assert.equal(runtime.getCatalogRevision(), 3);
          assert.equal(runtime.getDefaultModelSlug(), "chan-atomic/m1");
          // Gateway MUST still route m1 to stub1 and reject m2!
          const resM1 = await fetch(
            `http://127.0.0.1:${runtime.port}/c/chan-atomic/openai-completions/chat/completions`,
            {
              method: "POST",
              headers: {
                authorization: `Bearer ${runtime.gatewayToken}`,
                "content-type": "application/json",
              },
              body: JSON.stringify({ model: "m1", messages: [] }),
            },
          );
          assert.equal(resM1.status, 200);
          assert.deepEqual(await resM1.json(), { stub: 1 });
        } finally {
          chmodSync(runtime.agentDir, 0o700);
        }
      } finally {
        await runtime.close();
      }
    } finally {
      await Promise.all([stub1.close(), stub2.close()]);
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it("rejects body-waiting OAuth request if channel account was replaced mid-request (#6) and commits models.json LAST (#14)", async () => {
    const stub = await startStubServer((_req, res) => {
      res.writeHead(200, { "content-type": "application/json" });
      res.end('{"ok":true}');
    });
    const dir = mkdtempSync(join(tmpdir(), "xtwork-gw-round2-"));
    try {
      const secretStore = memorySecrets();
      await secretStore.set(
        "oauth:acct-1",
        JSON.stringify({ access: "tok-account-1", refresh: "r1", expires: Date.now() + 3_600_000 }),
      );
      await secretStore.set(
        "oauth:acct-2",
        JSON.stringify({ access: "tok-account-2", refresh: "r2", expires: Date.now() + 3_600_000 }),
      );

      let pauseBeforeModels = false;
      let failBeforeModels = false;
      let hitModelsCommit!: () => void;
      let hitModelsPromise = new Promise<void>((r) => {
        hitModelsCommit = r;
      });
      let releaseModelsCommit!: () => void;
      let modelsGate = new Promise<void>((r) => {
        releaseModelsCommit = r;
      });

      const acct1Chan: GatewayChannelConfig = {
        id: "xai-swap-req",
        providerType: "xai",
        enabled: true,
        api: "openai-responses",
        baseUrl: `${stub.baseUrl}/v1`,
        models: [{ id: "grok-1", enabled: true }],
        oauth: {
          provider: "xai",
          secretRef: "oauth:acct-1",
          refresh: async (c) => c,
        },
      };
      const acct2Chan: GatewayChannelConfig = {
        ...acct1Chan,
        models: [{ id: "grok-2", enabled: true }],
        oauth: {
          provider: "xai",
          secretRef: "oauth:acct-2",
          refresh: async (c) => c,
        },
      };

      const runtime = await startBundledPi(
        "/bin/true",
        dir,
        {},
        {
          channels: [acct1Chan],
          secretStore,
          validateOAuthDestination: allowLoopbackOAuthForTests,
          skipBinaryAccessCheck: true,
          onBeforeCommitFile: async (file) => {
            if (file === "models.json" && failBeforeModels) {
              failBeforeModels = false;
              throw new Error("simulated models.json commit failure");
            }
            if (file === "models.json" && pauseBeforeModels) {
              pauseBeforeModels = false;
              hitModelsCommit();
              await modelsGate;
            }
          },
        },
      );

      try {
        // --- Proof A (#6): Request captures rev 1 (acct-1), pauses mid-body while channel swaps to acct-2 ---
        const slowBodyResponse = new Promise<{ status: number; text: string }>((resolveResp, rejectResp) => {
          const req = httpRequest(
            {
              host: "127.0.0.1",
              port: runtime.port,
              path: "/c/xai-swap-req/openai-responses/responses",
              method: "POST",
              headers: {
                authorization: `Bearer ${runtime.gatewayToken}`,
                "content-type": "application/json",
                "transfer-encoding": "chunked",
              },
            },
            (res) => {
              const chunks: Buffer[] = [];
              res.on("data", (c) => chunks.push(Buffer.isBuffer(c) ? c : Buffer.from(c)));
              res.on("end", () =>
                resolveResp({ status: res.statusCode ?? 0, text: Buffer.concat(chunks).toString("utf8") }),
              );
            },
          );
          req.on("error", rejectResp);
          // Send first half of JSON body and hold stream open so gateway already captured rev 1 snapshot!
          req.write('{"model":"grok-1",');

          // Swap account to acct-2 while request body is in flight, then finish sending body.
          void (async () => {
            await new Promise((r) => setTimeout(r, 25));
            await runtime.updateChannels([acct2Chan]);
            req.end('"input":"hi"}');
          })();
        });

        const slowRes = await slowBodyResponse;
        assert.equal(slowRes.status, 502);
        assert.match(slowRes.text, /credential_error/);
        // Upstream MUST NEVER have received acct-2's token on behalf of the rev-1 request!
        assert.equal(stub.recorded.length, 0);

        // --- Proof B (#14): models.json is committed LAST after settings.json + route activation ---
        pauseBeforeModels = true;
        hitModelsPromise = new Promise<void>((r) => {
          hitModelsCommit = r;
        });
        modelsGate = new Promise<void>((r) => {
          releaseModelsCommit = r;
        });
        const updatePromise = runtime.updateChannels([acct1Chan]);
        await hitModelsPromise;

        // Right BEFORE models.json is renamed:
        // 1) models.json on disk MUST still be rev 2 (`grok-2`)
        const modelsBeforeCommit = JSON.parse(readFileSync(join(runtime.agentDir, "models.json"), "utf8"));
        assert.equal(modelsBeforeCommit.providers["xai-swap-req"].models[0].id, "grok-2");
        // 2) settings.json on disk MUST ALREADY be rev 3 (`grok-1`)
        const settingsBeforeCommit = JSON.parse(readFileSync(join(runtime.agentDir, "settings.json"), "utf8"));
        assert.equal(settingsBeforeCommit.defaultModel, "grok-1");
        // 3) Gateway routes MUST ALREADY accept rev 3 (`grok-1`) with acct-1!
        const liveRev3 = await fetch(
          `http://127.0.0.1:${runtime.port}/c/xai-swap-req/openai-responses/responses`,
          {
            method: "POST",
            headers: {
              authorization: `Bearer ${runtime.gatewayToken}`,
              "content-type": "application/json",
            },
            body: JSON.stringify({ model: "grok-1", input: "ready-before-models-rename" }),
          },
        );
        assert.equal(liveRev3.status, 200);
        await liveRev3.text();
        assert.equal(stub.recorded[0]!.headers.authorization, "Bearer tok-account-1");

        releaseModelsCommit();
        await updatePromise;
        const modelsAfterCommit = JSON.parse(readFileSync(join(runtime.agentDir, "models.json"), "utf8"));
        assert.equal(modelsAfterCommit.providers["xai-swap-req"].models[0].id, "grok-1");

        // --- Proof C (#14 rollback): If models.json commit fails during an account swap,
        // settings.json + routes roll back AND prior account's LIVE ROTATED token is NEVER evicted
        // or overwritten with stale initialCredentials! ---
        let acct1RefreshCalls = 0;
        const acct1StaleInitial = {
          access: "tok-stale-initial-1",
          refresh: "r-initial-1",
          expires: Date.now() - 10_000, // expired -> triggers live rotation
        };
        const acct1Rotatable: GatewayChannelConfig = {
          ...acct1Chan,
          id: "xai-rotated-rollback",
          models: [{ id: "grok-1", enabled: true }],
          oauth: {
            provider: "xai",
            secretRef: "oauth:acct-1-rot",
            initialCredentials: acct1StaleInitial,
            refresh: async () => {
              acct1RefreshCalls++;
              return {
                access: `tok-rotated-live-${acct1RefreshCalls}`,
                refresh: `r-rotated-${acct1RefreshCalls}`,
                expires: Date.now() + 3_600_000,
              };
            },
          },
        };
        const acct2SwapTarget: GatewayChannelConfig = {
          ...acct1Rotatable,
          models: [{ id: "grok-2", enabled: true }],
          oauth: {
            provider: "xai",
            secretRef: "oauth:acct-2",
            refresh: async (c) => c,
          },
        };
        await runtime.updateChannels([acct1Rotatable]);

        // Trigger rotation on acct-1 -> live rotated token is now `tok-rotated-live-1` (refreshCalls === 1).
        const preFailResp = await fetch(
          `http://127.0.0.1:${runtime.port}/c/xai-rotated-rollback/openai-responses/responses`,
          {
            method: "POST",
            headers: {
              authorization: `Bearer ${runtime.gatewayToken}`,
              "content-type": "application/json",
            },
            body: JSON.stringify({ model: "grok-1", input: "rotate-first" }),
          },
        );
        assert.equal(preFailResp.status, 200);
        await preFailResp.text();
        assert.equal(acct1RefreshCalls, 1);
        assert.equal(stub.recorded[stub.recorded.length - 1]!.headers.authorization, "Bearer tok-rotated-live-1");

        // Attempt swap to acct-2 with models.json commit failing -> MUST roll back cleanly WITHOUT
        // evicting `tok-rotated-live-1` or reloading stale `initialCredentials`!
        failBeforeModels = true;
        await assert.rejects(() => runtime.updateChannels([acct2SwapTarget]));
        assert.equal(runtime.getDefaultModelSlug(), "xai-rotated-rollback/grok-1");
        const rolledBackSettings = JSON.parse(readFileSync(join(runtime.agentDir, "settings.json"), "utf8"));
        assert.equal(rolledBackSettings.defaultModel, "grok-1");
        assert.equal(runtime.oauthManager.getCached("xai-rotated-rollback")?.access, "tok-rotated-live-1");

        const afterRollback = await fetch(
          `http://127.0.0.1:${runtime.port}/c/xai-rotated-rollback/openai-responses/responses`,
          {
            method: "POST",
            headers: {
              authorization: `Bearer ${runtime.gatewayToken}`,
              "content-type": "application/json",
            },
            body: JSON.stringify({ model: "grok-1", input: "still-uses-rotated-cache" }),
          },
        );
        assert.equal(afterRollback.status, 200);
        await afterRollback.text();
        assert.equal(acct1RefreshCalls, 1, "Must keep live rotated cache without refreshing or reloading stale initialCredentials");
        assert.equal(stub.recorded[stub.recorded.length - 1]!.headers.authorization, "Bearer tok-rotated-live-1");

        // --- Proof D (staged refresh + commitUpdate + immediate revokeAndDelete race) ---
        // A refresh started during the staged window BEFORE commitUpdate MUST be aborted and
        // blocked from writing back if revokeAndDelete runs right after commitUpdate!
        const raceStore = memorySecrets();
        const raceFence = new ChannelCredentialFence();
        const raceMgr = new OAuthTokenManager({ secretStore: raceStore, fence: raceFence });
        await raceStore.set(
          "oauth:staged-race",
          JSON.stringify({ access: "exp", refresh: "r0", expires: Date.now() - 10_000 }),
        );
        let enteredStagedRefresh!: () => void;
        const enteredStagedRefreshP = new Promise<void>((r) => {
          enteredStagedRefresh = r;
        });
        let releaseStagedRefresh!: () => void;
        const releaseStagedRefreshP = new Promise<void>((r) => {
          releaseStagedRefresh = r;
        });
        let stagedSignalAborted = false;

        const tx = raceMgr.stageUpdate([
          {
            channelId: "staged-logout-ch",
            provider: "xai",
            secretRef: "oauth:staged-race",
            refresh: async (_cur, sig) => {
              sig.addEventListener("abort", () => {
                stagedSignalAborted = true;
              });
              enteredStagedRefresh();
              await releaseStagedRefreshP;
              return { access: "resurrected-after-logout", refresh: "r1", expires: Date.now() + 3_600_000 };
            },
          },
        ]);
        const stagedBindingId = tx.bindingIdsByChannel.get("staged-logout-ch")!;
        const preCommitRefresh = raceMgr.getValidCredentials("staged-logout-ch", {
          expectedProvider: "xai",
          expectedSecretRef: "oauth:staged-race",
          expectedBindingId: stagedBindingId,
        });
        await enteredStagedRefreshP;

        // Commit the staged channel, then immediately log out (revokeAndDelete) while pre-commit refresh is still in flight!
        raceMgr.commitUpdate(tx);
        await raceMgr.revokeAndDelete("staged-logout-ch", undefined, "immediate post-commit logout");
        assert.equal(stagedSignalAborted, true);
        assert.equal(await raceStore.get("oauth:staged-race"), undefined);

        // Release the pre-commit staged refresh -> MUST reject SECRET_FENCE_STALE and NEVER resurrect credentials!
        releaseStagedRefresh();
        await assert.rejects(
          () => preCommitRefresh,
          (err: unknown) => err instanceof SecretStoreUnavailableError && err.code === "SECRET_FENCE_STALE",
        );
        assert.equal(await raceStore.get("oauth:staged-race"), undefined);
        assert.equal(raceMgr.getCached("staged-logout-ch"), undefined);

        // --- Proof E (sibling active channels sharing a secretRef) ---
        // Logging out channel A MUST clear/invalidate sibling active channel B's cached credentials
        // and block reads during deletion so B can never refresh from stale cache and recreate the secret!
        let siblingRefreshCalls = 0;
        let currentNow = 1_000_000;
        const sharedStore = memorySecrets();
        const sharedFence = new ChannelCredentialFence();
        const sharedMgr = new OAuthTokenManager({
          secretStore: sharedStore,
          fence: sharedFence,
          now: () => currentNow,
        });
        await sharedStore.set(
          "oauth:shared-acct",
          JSON.stringify({ access: "shared-tok-1", refresh: "shared-r1", expires: currentNow + 300_000 }),
        );
        const sharedRefresh = async () => {
          siblingRefreshCalls += 1;
          return { access: "resurrected-by-sibling", refresh: "shared-r2", expires: currentNow + 3_600_000 };
        };
        sharedMgr.register({
          channelId: "shared-ch-a",
          provider: "xai",
          secretRef: "oauth:shared-acct",
          refresh: sharedRefresh,
        });
        sharedMgr.register({
          channelId: "shared-ch-b",
          provider: "xai",
          secretRef: "oauth:shared-acct",
          refresh: sharedRefresh,
        });
        assert.equal((await sharedMgr.getValidCredentials("shared-ch-a")).access, "shared-tok-1");
        assert.equal((await sharedMgr.getValidCredentials("shared-ch-b")).access, "shared-tok-1");
        assert.equal(sharedMgr.getCached("shared-ch-b")?.access, "shared-tok-1");

        await sharedMgr.revokeAndDelete("shared-ch-a", undefined, "logout shared account via channel A");
        assert.equal(sharedMgr.getCached("shared-ch-a"), undefined);
        assert.equal(sharedMgr.getCached("shared-ch-b"), undefined, "Sibling active channel cache must be evicted on shared secretRef logout");
        assert.equal(await sharedStore.get("oauth:shared-acct"), undefined);

        // Advance time past expiry and verify sibling B cannot refresh from stale cache or recreate secret!
        currentNow += 400_000;
        await assert.rejects(
          () => sharedMgr.getValidCredentials("shared-ch-b"),
          (err: unknown) => err instanceof SecretStoreUnavailableError && err.code === "SECRET_STORE_UNAVAILABLE",
        );
        assert.equal(siblingRefreshCalls, 0);
        assert.equal(await sharedStore.get("oauth:shared-acct"), undefined);

        // --- Proof F (stageUpdate/register during paused revokeAndDelete must NOT resurrect initialCredentials) ---
        const basePausedStore = memorySecrets();
        await basePausedStore.set(
          "oauth:paused-del",
          JSON.stringify({ access: "old-tok", refresh: "old-r", expires: 100 }),
        );
        let enteredDelete!: () => void;
        const enteredDeleteP = new Promise<void>((r) => {
          enteredDelete = r;
        });
        let releaseDelete!: () => void;
        const releaseDeleteP = new Promise<void>((r) => {
          releaseDelete = r;
        });
        const pausedStore: SecretStore = {
          backend: basePausedStore.backend,
          get: (k) => basePausedStore.get(k),
          set: (k, v) => basePausedStore.set(k, v),
          delete: async (k) => {
            enteredDelete();
            await releaseDeleteP;
            await basePausedStore.delete(k);
          },
        };
        let pausedRefreshCalls = 0;
        const pausedMgr = new OAuthTokenManager({
          secretStore: pausedStore,
          fence: new ChannelCredentialFence(),
          now: () => 500_000,
        });
        const pausedRefresh = async () => {
          pausedRefreshCalls += 1;
          return { access: "resurrected-from-paused-stage", refresh: "r-new", expires: 9_999_999 };
        };
        pausedMgr.register({
          channelId: "paused-ch-a",
          provider: "xai",
          secretRef: "oauth:paused-del",
          refresh: pausedRefresh,
        });

        const deletePromise = pausedMgr.revokeAndDelete("paused-ch-a", undefined, "paused logout");
        await enteredDeleteP;

        // While delete is paused in SecretStore, stageUpdate introduces a channel with stale initialCredentials!
        const pausedTx = pausedMgr.stageUpdate([
          {
            channelId: "paused-ch-b",
            provider: "xai",
            secretRef: "oauth:paused-del",
            initialCredentials: { access: "stale-init", refresh: "stale-r", expires: 100 },
            refresh: pausedRefresh,
          },
        ]);

        releaseDelete();
        await deletePromise;

        // Committing the staged update after delete finishes MUST NOT carry over stale initialCredentials!
        pausedMgr.commitUpdate(pausedTx);
        assert.equal(pausedMgr.getCached("paused-ch-b"), undefined);
        await assert.rejects(
          () => pausedMgr.getValidCredentials("paused-ch-b"),
          (err: unknown) => err instanceof SecretStoreUnavailableError && err.code === "SECRET_STORE_UNAVAILABLE",
        );
        assert.equal(pausedRefreshCalls, 0);
        assert.equal(await basePausedStore.get("oauth:paused-del"), undefined);
      } finally {
        await runtime.close();
      }
    } finally {
      await stub.close();
      rmSync(dir, { recursive: true, force: true });
    }
  });
});
