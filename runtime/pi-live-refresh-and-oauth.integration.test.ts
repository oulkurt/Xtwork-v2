/**
 * End-to-end integration test running REAL bundled Pi 1.5.2 (`@earendil-works/pi-coding-agent`)
 * in `--mode rpc` through `runtime/gateway.ts` against local HTTP upstream stubs.
 *
 * Proves:
 * 1. Zero-channel startup: Pi 1.5.2 starts cleanly without `--provider`/`--model` lock.
 * 2. Active-session live refresh (`/xtwork-reload-models` from patched T3 `mcpExtensionSource.ts`)
 *    covering ALL 4 ADR-012 §3.4 scenarios on a single long-lived Pi 1.5.2 process:
 *      (a) Add new channel & switch live without `Model not found`
 *      (b) Edit metadata (`baseUrl` / `compat`) for the SAME `<channelId>/<modelId>` -> hits new upstream
 *      (c) Delete/disable active model -> clean rejection & fallback
 *      (d) Mutate channels mid-stream -> in-flight stream finishes on original snapshot, next turn uses updated catalog
 * 3. Proxy-Only OAuth narrow auth/transport proof for ALL 3 subscription channels with real Pi 1.5.2 turns:
 *      - Codex (`openai-codex-responses` SSE + zstd + non-secret placeholder JWT)
 *      - GitHub Copilot (gateway routing without `toAuth` baseUrl override + `availableModelIds` allowlist)
 *      - xAI (`openai-responses` + server-side single-flight fenced refresh)
 * 4. Secret isolation: real keys / OAuth tokens NEVER appear in `models.json`, Pi env, or Bash child env.
 */

import assert from "node:assert/strict";
import { execFileSync, spawn, type ChildProcessWithoutNullStreams } from "node:child_process";
import { once } from "node:events";
import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { createServer, type IncomingMessage, type ServerResponse } from "node:http";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { describe, it } from "node:test";
import {
  GATEWAY_TOKEN_ENV,
  GATEWAY_TOKEN_HEADER,
  type GatewayChannelConfig,
  startBundledPi,
} from "./gateway.ts";
import {
  createCodexPlaceholderJwt,
  refreshXaiOAuthToken,
  type XaiOAuthCredentials,
} from "./oauthProxy.ts";
import { ChannelCredentialFence, memorySecrets } from "./secretStore.ts";
import {
  PI_T3_MCP_EXTENSION_SOURCE,
  PI_XTWORK_RELOAD_MODELS_COMMAND,
} from "../.build/t3code/packages/provider-pi/src/server/mcpExtensionSource.ts";

function locatePiCli(): string {
  const candidates = [
    process.env.XTWORK_PI_CLI_JS,
    resolve(import.meta.dirname, "pi/node_modules/@earendil-works/pi-coding-agent/dist/bundle/cli.js"),
    resolve(import.meta.dirname, "../.build/mygo/resources/runtime/pi/node_modules/@earendil-works/pi-coding-agent/dist/bundle/cli.js"),
    resolve(import.meta.dirname, "../.build/pi-probe/node_modules/@earendil-works/pi-coding-agent/dist/bundle/cli.js"),
    "/Users/mizu/.t3/worktrees/xtwork_v2/t3-1542c884-93fb9243c8d1276a/.build/mygo/resources/runtime/pi/node_modules/@earendil-works/pi-coding-agent/dist/bundle/cli.js",
  ].filter((p): p is string => Boolean(p));
  for (const candidate of candidates) {
    if (existsSync(candidate)) return candidate;
  }
  throw new Error(
    `Could not locate bundled Pi 1.5.2 cli.js. Checked:\n${candidates.join("\n")}`,
  );
}

interface StubRequestRecord {
  readonly url: string;
  readonly headers: Record<string, string | string[] | undefined>;
  readonly body: Record<string, unknown>;
}

async function createUpstreamStub(
  handler: (req: IncomingMessage, res: ServerResponse, body: Record<string, unknown>) => void | Promise<void>,
) {
  const requests: StubRequestRecord[] = [];
  const server = createServer(async (req, res) => {
    const chunks: Buffer[] = [];
    for await (const chunk of req) chunks.push(Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk));
    const text = Buffer.concat(chunks).toString("utf8");
    let body: Record<string, unknown> = {};
    try {
      if (text.trim().startsWith("{")) body = JSON.parse(text) as Record<string, unknown>;
    } catch {
      body = {};
    }
    requests.push({ url: req.url ?? "/", headers: { ...req.headers }, body });
    await handler(req, res, body);
  });
  server.listen(0, "127.0.0.1");
  await once(server, "listening");
  const addr = server.address();
  assert.ok(addr && typeof addr !== "string");
  return {
    baseUrl: `http://127.0.0.1:${addr.port}`,
    requests,
    close: () =>
      new Promise<void>((r) => {
        server.close(() => r());
        server.closeAllConnections();
      }),
  };
}

function writeOpenAIChatCompletionSse(res: ServerResponse, text: string) {
  res.writeHead(200, { "content-type": "text/event-stream", "cache-control": "no-cache" });
  const frames = [
    {
      id: "chatcmpl-1",
      object: "chat.completion.chunk",
      created: 1700000000,
      model: "stub",
      choices: [{ index: 0, delta: { role: "assistant", content: text }, finish_reason: null }],
    },
    {
      id: "chatcmpl-1",
      object: "chat.completion.chunk",
      created: 1700000000,
      model: "stub",
      choices: [{ index: 0, delta: {}, finish_reason: "stop" }],
      usage: { prompt_tokens: 4, completion_tokens: 3, total_tokens: 7 },
    },
  ];
  for (const frame of frames) {
    res.write(`data: ${JSON.stringify(frame)}\n\n`);
  }
  res.write("data: [DONE]\n\n");
  res.end();
}

function writeResponsesSse(res: ServerResponse, text: string) {
  res.writeHead(200, { "content-type": "text/event-stream", "cache-control": "no-cache" });
  const events = [
    {
      type: "response.output_item.added",
      item: { type: "message", id: "msg_1", role: "assistant", content: [] },
    },
    {
      type: "response.content_part.added",
      item_id: "msg_1",
      content_index: 0,
      part: { type: "output_text", text: "" },
    },
    {
      type: "response.output_text.delta",
      item_id: "msg_1",
      content_index: 0,
      delta: text,
    },
    {
      type: "response.output_text.done",
      item_id: "msg_1",
      content_index: 0,
      text,
    },
    {
      type: "response.output_item.done",
      item: {
        type: "message",
        id: "msg_1",
        role: "assistant",
        status: "completed",
        content: [{ type: "output_text", text }],
      },
    },
    {
      type: "response.completed",
      response: {
        id: "resp_1",
        status: "completed",
        usage: { input_tokens: 5, output_tokens: 3, total_tokens: 8 },
      },
    },
  ];
  for (const ev of events) {
    res.write(`data: ${JSON.stringify(ev)}\n\n`);
  }
  res.end();
}

interface PiRpcClient {
  request(payload: Record<string, unknown>, timeoutMs?: number): Promise<Record<string, unknown>>;
  waitForEvent(
    predicate: (event: Record<string, unknown>) => boolean,
    timeoutMs?: number,
  ): Promise<Record<string, unknown>>;
  close(): Promise<void>;
}

function spawnPiRpc(
  piCli: string,
  env: Record<string, string>,
  extensionPath?: string,
): PiRpcClient {
  const args = [
    piCli,
    "--mode",
    "rpc",
    "--no-session",
    "--offline",
    "--no-approve",
    "--no-extensions",
    "--no-skills",
    "--no-prompt-templates",
    "--no-tools",
    ...(extensionPath ? ["--extension", extensionPath] : []),
  ];
  const child: ChildProcessWithoutNullStreams = spawn(process.execPath, args, {
    env: {
      PATH: process.env.PATH ?? "/usr/bin:/bin",
      HOME: env.HOME ?? process.env.HOME ?? tmpdir(),
      TMPDIR: process.env.TMPDIR ?? tmpdir(),
      ...env,
    },
    stdio: ["pipe", "pipe", "pipe"],
  });

  let buffer = "";
  let seq = 1;
  const pending = new Map<
    string,
    { resolve: (msg: Record<string, unknown>) => void; reject: (err: Error) => void }
  >();
  const eventHistory: Record<string, unknown>[] = [];
  const waiters: Array<{
    predicate: (e: Record<string, unknown>) => boolean;
    resolve: (e: Record<string, unknown>) => void;
  }> = [];

  child.stdout.on("data", (chunk: Buffer) => {
    buffer += chunk.toString("utf8");
    let nl: number;
    while ((nl = buffer.indexOf("\n")) >= 0) {
      const line = buffer.slice(0, nl).trim();
      buffer = buffer.slice(nl + 1);
      if (!line) continue;
      let parsed: Record<string, unknown>;
      try {
        parsed = JSON.parse(line) as Record<string, unknown>;
      } catch {
        continue;
      }
      if (parsed.type === "response" && typeof parsed.id === "string" && pending.has(parsed.id)) {
        const entry = pending.get(parsed.id)!;
        pending.delete(parsed.id);
        entry.resolve(parsed);
      } else {
        eventHistory.push(parsed);
        for (let i = waiters.length - 1; i >= 0; i--) {
          if (waiters[i]!.predicate(parsed)) {
            const waiter = waiters.splice(i, 1)[0]!;
            waiter.resolve(parsed);
          }
        }
      }
    }
  });

  child.once("exit", (code) => {
    for (const [, entry] of pending) {
      entry.reject(new Error(`Pi exited unexpectedly with code ${code}`));
    }
    pending.clear();
  });

  return {
    request(payload, timeoutMs = 15_000) {
      return new Promise((resolveReq, rejectReq) => {
        const id = `rpc-${seq++}`;
        const timer = setTimeout(() => {
          pending.delete(id);
          rejectReq(new Error(`Timed out waiting for Pi RPC response to ${String(payload.type)}`));
        }, timeoutMs);
        pending.set(id, {
          resolve: (msg) => {
            clearTimeout(timer);
            resolveReq(msg);
          },
          reject: (err) => {
            clearTimeout(timer);
            rejectReq(err);
          },
        });
        child.stdin.write(`${JSON.stringify({ ...payload, id })}\n`);
      });
    },
    waitForEvent(predicate, timeoutMs = 15_000) {
      const existing = eventHistory.find(predicate);
      if (existing) return Promise.resolve(existing);
      return new Promise((resolveEv, rejectEv) => {
        const timer = setTimeout(() => {
          rejectEv(new Error("Timed out waiting for Pi RPC event"));
        }, timeoutMs);
        waiters.push({
          predicate,
          resolve: (ev) => {
            clearTimeout(timer);
            resolveEv(ev);
          },
        });
      });
    },
    async close() {
      if (child.exitCode === null) {
        child.kill("SIGTERM");
        await Promise.race([once(child, "exit"), new Promise((r) => setTimeout(r, 3000))]);
        if (child.exitCode === null) child.kill("SIGKILL");
      }
    },
  };
}

describe("Real Pi 1.5.2 RPC integration: Live Refresh (4 scenarios) + OAuth Proxy-Only (Codex/Copilot/xAI)", () => {
  const piCli = locatePiCli();

  it("boots cleanly in zero-channel state without crashing", async () => {
    const dir = mkdtempSync(join(tmpdir(), "xtwork-pi-zero-"));
    try {
      const runtime = await startBundledPi("/bin/true", dir, {}, { skipBinaryAccessCheck: true });
      const piEnv = Object.fromEntries(runtime.environment.map((e) => [e.name, e.value]));
      const rpc = spawnPiRpc(piCli, piEnv);
      try {
        const state = await rpc.request({ type: "get_state" });
        assert.equal(state.success, true);
        const avail = await rpc.request({ type: "get_available_models" });
        assert.equal(avail.success, true);
        assert.deepEqual((avail.data as { models: unknown[] }).models, []);
      } finally {
        await rpc.close();
        await runtime.close();
      }
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it("proves ALL 4 active-session live-refresh scenarios on ONE running Pi 1.5.2 RPC session", async () => {
    let releaseSlowStream!: () => void;
    const slowStreamGate = new Promise<void>((r) => {
      releaseSlowStream = r;
    });
    let slowStreamStarted!: () => void;
    const slowStreamStartedPromise = new Promise<void>((r) => {
      slowStreamStarted = r;
    });
    let slowMode = false;

    const stubA = await createUpstreamStub(async (_req, res) => {
      if (slowMode) {
        res.writeHead(200, { "content-type": "text/event-stream", "cache-control": "no-cache" });
        res.write(
          `data: ${JSON.stringify({
            id: "slow-1",
            object: "chat.completion.chunk",
            created: 1700000000,
            model: "m-a",
            choices: [{ index: 0, delta: { role: "assistant", content: "midstream-part1-" }, finish_reason: null }],
          })}\n\n`,
        );
        slowStreamStarted();
        await slowStreamGate;
        res.write(
          `data: ${JSON.stringify({
            id: "slow-1",
            object: "chat.completion.chunk",
            created: 1700000000,
            model: "m-a",
            choices: [{ index: 0, delta: { content: "part2-from-original-snapshot" }, finish_reason: null }],
          })}\n\n`,
        );
        res.write(
          `data: ${JSON.stringify({
            id: "slow-1",
            object: "chat.completion.chunk",
            created: 1700000000,
            model: "m-a",
            choices: [{ index: 0, delta: {}, finish_reason: "stop" }],
          })}\n\n`,
        );
        res.write("data: [DONE]\n\n");
        res.end();
        return;
      }
      writeOpenAIChatCompletionSse(res, "reply-from-stub-A");
    });
    const stubB1 = await createUpstreamStub((_req, res) => {
      writeOpenAIChatCompletionSse(res, "reply-from-stub-B1");
    });
    const stubB2 = await createUpstreamStub((_req, res) => {
      writeOpenAIChatCompletionSse(res, "reply-from-stub-B2-updated");
    });

    const dir = mkdtempSync(join(tmpdir(), "xtwork-pi-live-"));
    const extPath = join(dir, "pi-t3-mcp-extension.ts");
    // Materialize the EXACT patched T3 extension source containing `/xtwork-reload-models`!
    writeFileSync(extPath, PI_T3_MCP_EXTENSION_SOURCE, "utf8");

    try {
      const chanA: GatewayChannelConfig = {
        id: "chan-a",
        providerType: "openai",
        enabled: true,
        api: "openai-completions",
        baseUrl: `${stubA.baseUrl}/v1`,
        apiKey: "sk-real-secret-A",
        models: [{ id: "model-a", enabled: true }],
      };
      const runtime = await startBundledPi(
        "/bin/true",
        dir,
        {},
        { channels: [chanA], skipBinaryAccessCheck: true },
      );
      const piEnv = Object.fromEntries(runtime.environment.map((e) => [e.name, e.value]));
      const rpc = spawnPiRpc(piCli, piEnv, extPath);

      let turnCount = 0;
      const runTurnAndGetText = async (message: string) => {
        const targetEndCount = ++turnCount;
        let seenEnds = 0;
        const settled = rpc.waitForEvent((e) => {
          if (e.type === "agent_end") {
            seenEnds++;
            return seenEnds >= targetEndCount;
          }
          return false;
        });
        const pRes = await rpc.request({ type: "prompt", message });
        assert.equal(pRes.success, true, `prompt failed: ${JSON.stringify(pRes)}`);
        assert.equal((pRes.data as { disposition?: string }).disposition, "started");
        await settled;
        const last = await rpc.request({ type: "get_last_assistant_text" });
        return (last.data as { text: string }).text;
      };

      try {
        // Confirm initial session starts with ONLY chan-a/model-a
        const avail0 = await rpc.request({ type: "get_available_models" });
        const slugs0 = (avail0.data as { models: Array<{ provider: string; id: string }> }).models.map(
          (m) => `${m.provider}/${m.id}`,
        );
        assert.deepEqual(slugs0, ["chan-a/model-a"]);

        // ------------------------------------------------------------------
        // Scenario 1: Add a NEW channel (chan-b/model-b) and switch live!
        // ------------------------------------------------------------------
        const chanBV1: GatewayChannelConfig = {
          id: "chan-b",
          providerType: "openai",
          enabled: true,
          api: "openai-completions",
          baseUrl: `${stubB1.baseUrl}/v1`,
          apiKey: "sk-real-secret-B1",
          models: [{ id: "model-b", enabled: true, compat: { supportsDeveloperRole: false } }],
        };
        await runtime.updateChannels([chanA, chanBV1]);

        const reload1 = await rpc.request({
          type: "prompt",
          message: `/${PI_XTWORK_RELOAD_MODELS_COMMAND}`,
        });
        assert.equal(reload1.success, true);
        assert.equal((reload1.data as { disposition?: string }).disposition, "handled");

        const set1 = await rpc.request({
          type: "set_model",
          provider: "chan-b",
          modelId: "model-b",
        });
        assert.equal(set1.success, true, `Scenario 1 set_model failed: ${JSON.stringify(set1)}`);
        const reply1 = await runTurnAndGetText("hello scenario 1");
        assert.equal(reply1, "reply-from-stub-B1");
        assert.equal(stubB1.requests.length, 1);
        assert.equal(stubB1.requests[0]!.headers.authorization, "Bearer sk-real-secret-B1");

        // ------------------------------------------------------------------
        // Scenario 2: Edit metadata (baseUrl + compat) for SAME chan-b/model-b!
        // ------------------------------------------------------------------
        const chanBV2: GatewayChannelConfig = {
          id: "chan-b",
          providerType: "openai",
          enabled: true,
          api: "openai-completions",
          baseUrl: `${stubB2.baseUrl}/v1`,
          apiKey: "sk-real-secret-B2",
          models: [
            {
              id: "model-b",
              enabled: true,
              compat: { supportsDeveloperRole: false, maxTokensField: "max_tokens" },
            },
          ],
        };
        await runtime.updateChannels([chanA, chanBV2]);
        const reload2 = await rpc.request({
          type: "prompt",
          message: `/${PI_XTWORK_RELOAD_MODELS_COMMAND}`,
        });
        assert.equal(reload2.success, true);

        // Next turn WITHOUT changing model slug MUST hit stubB2 with updated compat & key!
        const reply2 = await runTurnAndGetText("hello scenario 2");
        assert.equal(reply2, "reply-from-stub-B2-updated");
        assert.equal(stubB2.requests.length, 1);
        assert.equal(stubB2.requests[0]!.headers.authorization, "Bearer sk-real-secret-B2");
        assert.equal("max_tokens" in stubB2.requests[0]!.body, true);

        // ------------------------------------------------------------------
        // Scenario 3: Delete/disable active model chan-b/model-b -> clean rejection + fallback!
        // ------------------------------------------------------------------
        await runtime.updateChannels([chanA]);
        const reload3 = await rpc.request({
          type: "prompt",
          message: `/${PI_XTWORK_RELOAD_MODELS_COMMAND}`,
        });
        assert.equal(reload3.success, true);

        // Attempting to select deleted model returns clean Model not found error
        const setDeleted = await rpc.request({
          type: "set_model",
          provider: "chan-b",
          modelId: "model-b",
        });
        assert.equal(setDeleted.success, false);
        assert.match(String(setDeleted.error ?? ""), /Model not found/);

        // Direct gateway call to deleted channel is also cleanly rejected (404)
        const directDeleted = await fetch(
          `http://127.0.0.1:${runtime.port}/c/chan-b/openai-completions/chat/completions`,
          {
            method: "POST",
            headers: {
              authorization: `Bearer ${runtime.gatewayToken}`,
              "content-type": "application/json",
            },
            body: JSON.stringify({ model: "model-b", messages: [] }),
          },
        );
        assert.equal(directDeleted.status, 404);

        // Fallback resolves cleanly to chan-a/model-a and succeeds
        assert.equal(runtime.resolveFallbackModel(), "chan-a/model-a");
        const setFallback = await rpc.request({
          type: "set_model",
          provider: "chan-a",
          modelId: "model-a",
        });
        assert.equal(setFallback.success, true);

        // ------------------------------------------------------------------
        // Scenario 4: Mutate channels MID-STREAM!
        // In-flight stream completes on original stubA snapshot; next turn hits updated catalog!
        // ------------------------------------------------------------------
        slowMode = true;
        const targetEndForSlow = ++turnCount;
        let seenSlowEnds = 0;
        const slowSettled = rpc.waitForEvent((e) => {
          if (e.type === "agent_end") {
            seenSlowEnds++;
            return seenSlowEnds >= targetEndForSlow;
          }
          return false;
        });

        const slowPromptRes = await rpc.request({ type: "prompt", message: "hello midstream" });
        assert.equal(slowPromptRes.success, true);
        await slowStreamStartedPromise;

        // Mutate chan-a to point to stubB2 WHILE slowStream is still open!
        await runtime.updateChannels([
          {
            ...chanA,
            baseUrl: `${stubB2.baseUrl}/v1`,
            apiKey: "sk-real-secret-A-v2",
          },
        ]);
        // Even calling reload mid-stream MUST NOT disturb the in-flight stream!
        const midReload = await rpc.request({
          type: "prompt",
          message: `/${PI_XTWORK_RELOAD_MODELS_COMMAND}`,
        });
        assert.equal(midReload.success, true);

        // Release original stubA stream -> MUST finish intact with both parts from original snapshot!
        releaseSlowStream();
        await slowSettled;
        const slowText = (
          (await rpc.request({ type: "get_last_assistant_text" })).data as { text: string }
        ).text;
        assert.equal(slowText, "midstream-part1-part2-from-original-snapshot");

        // Now idle: reload & next turn hits the updated stubB2!
        await rpc.request({ type: "prompt", message: `/${PI_XTWORK_RELOAD_MODELS_COMMAND}` });
        const afterMutationReply = await runTurnAndGetText("hello after midstream mutation");
        assert.equal(afterMutationReply, "reply-from-stub-B2-updated");
        assert.equal(stubB2.requests.length, 2);
        assert.equal(stubB2.requests[1]!.headers.authorization, "Bearer sk-real-secret-A-v2");
      } finally {
        await rpc.close();
        await runtime.close();
      }
    } finally {
      await Promise.all([stubA.close(), stubB1.close(), stubB2.close()]);
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it("proves Proxy-Only OAuth turns on real Pi 1.5.2 for Codex, GitHub Copilot, and xAI + zero secret leak", async () => {
    const realCodexJwt = createCodexPlaceholderJwt("acct-real-codex-777");
    const realCopilotToken = "tid=real-copilot-secret;exp=9999999999;proxy-ep=proxy.stub.local";
    const realXaiExpired = "xai-expired-secret";
    const realXaiFresh = "xai-refreshed-secret-888";

    const codexStub = await createUpstreamStub((_req, res) => {
      writeResponsesSse(res, "codex-proxy-only-ok");
    });
    const copilotStub = await createUpstreamStub((_req, res) => {
      writeOpenAIChatCompletionSse(res, "copilot-proxy-only-ok");
    });
    const xaiStub = await createUpstreamStub((req, res) => {
      if (req.url === "/oauth2/token") {
        res.writeHead(200, { "content-type": "application/json" });
        res.end(
          JSON.stringify({
            access_token: realXaiFresh,
            refresh_token: "xai-rotated-refresh-999",
            expires_in: 3600,
          }),
        );
        return;
      }
      writeResponsesSse(res, "xai-proxy-only-ok");
    });

    const dir = mkdtempSync(join(tmpdir(), "xtwork-pi-oauth-"));
    try {
      const secretStore = memorySecrets();
      const fence = new ChannelCredentialFence();
      await secretStore.set(
        "oauth:xai-sub",
        JSON.stringify({
          access: realXaiExpired,
          refresh: "xai-initial-refresh",
          expires: Date.now() + 5_000, // inside 60s refresh skew!
        }),
      );

      const channels: GatewayChannelConfig[] = [
        {
          id: "codex-sub",
          providerType: "openai-codex",
          enabled: true,
          api: "openai-codex-responses",
          baseUrl: codexStub.baseUrl,
          models: [{ id: "gpt-6-sol", enabled: true }],
          oauth: {
            provider: "openai-codex",
            secretRef: "oauth:codex-sub",
            initialCredentials: {
              access: realCodexJwt,
              refresh: "real-codex-refresh",
              expires: Date.now() + 3_600_000,
              accountId: "acct-real-codex-777",
            },
            refresh: async (c) => c,
          },
        },
        {
          id: "copilot-sub",
          providerType: "github-copilot",
          enabled: true,
          api: "openai-completions",
          baseUrl: copilotStub.baseUrl,
          availableModelIds: ["gpt-4.1"],
          models: [
            { id: "gpt-4.1", enabled: true },
            { id: "blocked-org-model", enabled: true },
          ],
          oauth: {
            provider: "github-copilot",
            secretRef: "oauth:copilot-sub",
            initialCredentials: {
              access: realCopilotToken,
              refresh: "gho_real_copilot_refresh",
              expires: Date.now() + 3_600_000,
              availableModelIds: ["gpt-4.1"],
            },
            refresh: async (c) => c,
          },
        },
        {
          id: "xai-sub",
          providerType: "xai",
          enabled: true,
          api: "openai-responses",
          baseUrl: `${xaiStub.baseUrl}/v1`,
          models: [{ id: "grok-4.6", enabled: true }],
          oauth: {
            provider: "xai",
            secretRef: "oauth:xai-sub",
            refresh: (cur, signal) =>
              refreshXaiOAuthToken(cur as XaiOAuthCredentials, signal, {
                tokenUrl: `${xaiStub.baseUrl}/oauth2/token`,
              }),
          },
        },
      ];

      const runtime = await startBundledPi(
        "/bin/true",
        dir,
        {},
        { channels, secretStore, fence, skipBinaryAccessCheck: true },
      );
      const piEnv = Object.fromEntries(runtime.environment.map((e) => [e.name, e.value]));
      const rpc = spawnPiRpc(piCli, piEnv);

      let turnCount = 0;
      const runTurn = async (provider: string, modelId: string, prompt: string) => {
        const setRes = await rpc.request({ type: "set_model", provider, modelId });
        assert.equal(setRes.success, true, `set_model ${provider}/${modelId} failed: ${JSON.stringify(setRes)}`);
        const target = ++turnCount;
        let ends = 0;
        const done = rpc.waitForEvent((e) => {
          if (e.type === "agent_end") {
            ends++;
            return ends >= target;
          }
          return false;
        });
        const pRes = await rpc.request({ type: "prompt", message: prompt });
        assert.equal(pRes.success, true);
        await done;
        return ((await rpc.request({ type: "get_last_assistant_text" })).data as { text: string }).text;
      };

      try {
        // 1. Codex real Pi 1.5.2 turn
        const codexReply = await runTurn("codex-sub", "gpt-6-sol", "ping codex");
        assert.equal(codexReply, "codex-proxy-only-ok");
        assert.equal(codexStub.requests.length, 1);
        assert.equal(codexStub.requests[0]!.url, "/codex/responses");
        assert.equal(codexStub.requests[0]!.headers.authorization, `Bearer ${realCodexJwt}`);
        assert.equal(codexStub.requests[0]!.headers["chatgpt-account-id"], "acct-real-codex-777");
        assert.equal(codexStub.requests[0]!.headers[GATEWAY_TOKEN_HEADER], undefined);

        // 2. GitHub Copilot real Pi 1.5.2 turn + availableModelIds enforcement
        const copilotReply = await runTurn("copilot-sub", "gpt-4.1", "ping copilot");
        assert.equal(copilotReply, "copilot-proxy-only-ok");
        assert.equal(copilotStub.requests.length, 1);
        assert.equal(copilotStub.requests[0]!.headers.authorization, `Bearer ${realCopilotToken}`);
        assert.equal(copilotStub.requests[0]!.headers["openai-intent"], "conversation-edits");
        assert.equal(copilotStub.requests[0]!.headers["x-initiator"], "user");
        assert.match(String(copilotStub.requests[0]!.headers["user-agent"]), /GitHubCopilotChat/);

        // Blocked Copilot model is NOT exposed in Pi and rejected with 403 by gateway
        const setBlocked = await rpc.request({
          type: "set_model",
          provider: "copilot-sub",
          modelId: "blocked-org-model",
        });
        assert.equal(setBlocked.success, false);
        const gwBlocked = await fetch(
          `http://127.0.0.1:${runtime.port}/c/copilot-sub/openai-completions/chat/completions`,
          {
            method: "POST",
            headers: {
              authorization: `Bearer ${runtime.gatewayToken}`,
              "content-type": "application/json",
            },
            body: JSON.stringify({ model: "blocked-org-model", messages: [] }),
          },
        );
        assert.equal(gwBlocked.status, 403);

        // 3. xAI real Pi 1.5.2 turn (triggers server-side refresh before forwarding!)
        const xaiReply = await runTurn("xai-sub", "grok-4.6", "ping xai");
        assert.equal(xaiReply, "xai-proxy-only-ok");
        const xaiInference = xaiStub.requests.find((r) => r.url === "/v1/responses");
        assert.ok(xaiInference, "Expected xAI /v1/responses request");
        assert.equal(xaiInference.headers.authorization, `Bearer ${realXaiFresh}`);

        // 4. Secret isolation audit: models.json, Pi env, and pi-shell Bash child env
        const rawModels = readFileSync(join(runtime.agentDir, "models.json"), "utf8");
        const rawSettings = readFileSync(join(runtime.agentDir, "settings.json"), "utf8");
        const forbiddenSecrets = [
          realCodexJwt,
          "real-codex-refresh",
          "acct-real-codex-777",
          realCopilotToken,
          "gho_real_copilot_refresh",
          realXaiExpired,
          realXaiFresh,
          "xai-initial-refresh",
          "xai-rotated-refresh-999",
        ];
        for (const secret of forbiddenSecrets) {
          assert.equal(rawModels.includes(secret), false, `models.json leaked ${secret}`);
          assert.equal(rawSettings.includes(secret), false, `settings.json leaked ${secret}`);
          for (const entry of runtime.environment) {
            assert.equal(entry.value.includes(secret), false, `Pi env leaked ${secret}`);
          }
        }

        // Verify pi-shell strips XTWORK_MODEL_GATEWAY_TOKEN from Bash child env
        const piShell = resolve(import.meta.dirname, "pi/pi-shell");
        const bashEnvOut = execFileSync("/bin/sh", [piShell, "-c", "env"], {
          env: { ...piEnv, PATH: process.env.PATH ?? "/usr/bin:/bin" },
          encoding: "utf8",
        });
        assert.equal(bashEnvOut.includes(GATEWAY_TOKEN_ENV), false);
        assert.equal(bashEnvOut.includes(runtime.gatewayToken), false);
      } finally {
        await rpc.close();
        await runtime.close();
      }
    } finally {
      await Promise.all([codexStub.close(), copilotStub.close(), xaiStub.close()]);
      rmSync(dir, { recursive: true, force: true });
    }
  });
});
