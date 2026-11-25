import assert from "node:assert/strict";
import { once } from "node:events";
import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { createServer, type IncomingMessage, type ServerResponse } from "node:http";
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
  CODEX_PLACEHOLDER_ACCOUNT_ID,
  createCodexPlaceholderJwt,
  deriveGitHubCopilotBaseUrl,
  extractCodexAccountId,
  OAuthTokenManager,
  refreshXaiOAuthToken,
  type XaiOAuthCredentials,
} from "./oauthProxy.ts";
import {
  ChannelCredentialFence,
  memorySecrets,
  SecretStoreUnavailableError,
} from "./secretStore.ts";

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
          refreshXaiOAuthToken(cur, signal, { tokenUrl: `${tokenStub.baseUrl}/oauth2/token` }),
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
});
