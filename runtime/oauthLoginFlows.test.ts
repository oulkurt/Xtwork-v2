import assert from "node:assert/strict";
import { once } from "node:events";
import { createServer } from "node:http";
import { describe, it } from "node:test";
import {
  OAuthLoginSessionManager,
  parseCodexPlanQuotaResponse,
  parseGithubCopilotPlanQuotaResponse,
  queryCodexPlanQuota,
  queryGithubCopilotPlanQuota,
  redactSecretsFromText,
  refreshGithubCopilotOAuthToken,
} from "./oauthLoginFlows.ts";
import {
  assertStrictOAuthDestination,
  createCodexPlaceholderJwt,
  type CodexOAuthCredentials,
  type GithubCopilotOAuthCredentials,
  type OAuthDestinationValidator,
  type OAuthSubscriptionCredentials,
  type XaiOAuthCredentials,
} from "./oauthProxy.ts";

const allowLoopbackTestOAuth: OAuthDestinationValidator = (provider, url, purpose, context) => {
  if (url.protocol === "http:" && (url.hostname === "127.0.0.1" || url.hostname === "localhost")) {
    return;
  }
  assertStrictOAuthDestination(provider, url, purpose, context);
};

async function freePort(): Promise<number> {
  const srv = createServer();
  srv.listen(0, "127.0.0.1");
  await once(srv, "listening");
  const addr = srv.address();
  assert.ok(addr && typeof addr !== "string");
  const port = addr.port;
  await new Promise<void>((r) => srv.close(() => r()));
  return port;
}

describe("OAuth Subscription Login, Refresh & Quota Flows (ADR-012 §3.3 & §3.4)", () => {
  it("redacts secrets from all error messages and never leaks tokens in session views", () => {
    const raw =
      'Failed with Authorization: Bearer supersecret_jwt_token and "refresh_token":"gho_secret123456" and sk-live-secret-999999';
    const redacted = redactSecretsFromText(raw, ["extra-custom-secret-val"]);
    assert.ok(!redacted.includes("supersecret_jwt_token"));
    assert.ok(!redacted.includes("gho_secret123456"));
    assert.ok(!redacted.includes("sk-live-secret-999999"));
    assert.ok(redacted.includes("[REDACTED]"));
  });

  it("completes ChatGPT Codex browser PKCE login & parses/queries Codex rolling quota", async () => {
    const cbPort = await freePort();
    const realCodexAccess = createCodexPlaceholderJwt("acct-codex-real-123");
    let capturedCreds: OAuthSubscriptionCredentials | undefined;

    const stub = createServer(async (req, res) => {
      const chunks: Buffer[] = [];
      for await (const c of req) chunks.push(Buffer.isBuffer(c) ? c : Buffer.from(c));
      const body = Buffer.concat(chunks).toString("utf8");

      if (req.url === "/oauth/token") {
        const params = new URLSearchParams(body);
        assert.equal(params.get("grant_type"), "authorization_code");
        assert.equal(params.get("code"), "codex-code-77");
        res.writeHead(200, { "Content-Type": "application/json" });
        res.end(
          JSON.stringify({
            access_token: realCodexAccess,
            refresh_token: "codex-refresh-secret-77",
            expires_in: 3600,
          }),
        );
        return;
      }

      if (req.url === "/backend-api/wham/usage") {
        assert.equal(req.headers.authorization, `Bearer ${realCodexAccess}`);
        assert.equal(req.headers["chatgpt-account-id"], "acct-codex-real-123");
        res.writeHead(200, { "Content-Type": "application/json" });
        res.end(
          JSON.stringify({
            plan_type: "plus",
            rate_limit: {
              primary_window: { used_percent: 30, limit_window_seconds: 18000, reset_after_seconds: 3600 },
              secondary_window: { used_percent: 15, limit_window_seconds: 604800, reset_after_seconds: 86400 },
            },
          }),
        );
        return;
      }

      res.writeHead(404).end();
    });
    stub.listen(0, "127.0.0.1");
    await once(stub, "listening");
    const addr = stub.address();
    assert.ok(addr && typeof addr !== "string");
    const base = `http://127.0.0.1:${addr.port}`;

    try {
      const manager = new OAuthLoginSessionManager({
        codexAuthBaseUrl: base,
        codexRedirectUri: `http://localhost:${cbPort}/auth/callback`,
        validateDestination: allowLoopbackTestOAuth,
        onCompleted: async (creds) => {
          capturedCreds = creds;
          return { channelId: "codex-ch-1", availableModelCount: 8 };
        },
      });

      const started = await manager.start({ provider: "openai-codex", method: "browser" });
      assert.equal(started.phase, "awaiting_user");
      assert.ok(started.authUrl);
      const authUrl = new URL(started.authUrl);
      const state = authUrl.searchParams.get("state")!;
      assert.equal(authUrl.searchParams.get("code_challenge_method"), "S256");

      const cbRes = await fetch(
        `http://localhost:${cbPort}/auth/callback?state=${encodeURIComponent(state)}&code=codex-code-77`,
      );
      assert.equal(cbRes.status, 200);
      assert.equal(cbRes.headers.get("cache-control"), "no-store");

      const done = await manager.waitForSession(started.sessionId);
      assert.equal(done?.phase, "succeeded");
      assert.equal(done?.channelId, "codex-ch-1");
      assert.equal(done?.accountLabel, "acct-codex-real-123");
      // Raw tokens MUST NEVER appear in session view!
      assert.ok(!JSON.stringify(done).includes("codex-refresh-secret-77"));
      assert.ok(!JSON.stringify(done).includes(realCodexAccess));

      const codexCreds = capturedCreds as CodexOAuthCredentials;
      assert.equal(codexCreds.accountId, "acct-codex-real-123");
      assert.equal(codexCreds.refresh, "codex-refresh-secret-77");

      const quota = await queryCodexPlanQuota(codexCreds, {
        codexUsageUrl: `${base}/backend-api/wham/usage`,
        validateDestination: allowLoopbackTestOAuth,
      });
      assert.equal(quota.supported, true);
      assert.equal(quota.planName, "ChatGPT Plus (Codex)");
      assert.equal(quota.windows.length, 2);
      assert.equal(quota.windows[0]!.type, "5h");
      assert.equal(quota.windows[0]!.remainingPercent, 70);
      assert.equal(quota.windows[1]!.type, "weekly");
      assert.equal(quota.windows[1]!.remainingPercent, 85);
    } finally {
      stub.close();
      stub.closeAllConnections();
    }
  });

  it("completes GitHub Copilot RFC 8628 device-code login, syncs availableModelIds, refreshes, and queries quota", async () => {
    let pollCalls = 0;
    let capturedCreds: GithubCopilotOAuthCredentials | undefined;

    const stub = createServer(async (req, res) => {
      const chunks: Buffer[] = [];
      for await (const c of req) chunks.push(Buffer.isBuffer(c) ? c : Buffer.from(c));

      if (req.url === "/login/device/code") {
        res.writeHead(200, { "Content-Type": "application/json" });
        res.end(
          JSON.stringify({
            device_code: "gh-dev-1",
            user_code: "ABCD-1234",
            verification_uri: `${base}/login/device`,
            interval: 0,
            expires_in: 600,
          }),
        );
        return;
      }
      if (req.url === "/login/oauth/access_token") {
        pollCalls += 1;
        res.writeHead(200, { "Content-Type": "application/json" });
        if (pollCalls === 1) {
          res.end(JSON.stringify({ error: "authorization_pending" }));
          return;
        }
        res.end(JSON.stringify({ access_token: "gho_copilot_refresh_secret_55" }));
        return;
      }
      if (req.url === "/copilot_internal/v2/token") {
        assert.equal(req.headers.authorization, "Bearer gho_copilot_refresh_secret_55");
        res.writeHead(200, { "Content-Type": "application/json" });
        res.end(
          JSON.stringify({
            token: `tid=copilot-short-token;exp=9999999999;proxy-ep=proxy.stub.local`,
            expires_at: Math.floor(Date.now() / 1000) + 1800,
          }),
        );
        return;
      }
      if (req.url === "/models") {
        res.writeHead(200, { "Content-Type": "application/json" });
        res.end(
          JSON.stringify({
            data: [
              { id: "claude-sonnet-5", model_picker_enabled: true, policy: { state: "enabled" } },
              { id: "gpt-6-sol", model_picker_enabled: true, policy: { state: "enabled" } },
              { id: "disabled-model", model_picker_enabled: true, policy: { state: "disabled" } },
            ],
          }),
        );
        return;
      }
      if (req.url === "/copilot_internal/user") {
        assert.equal(req.headers.authorization, "token gho_copilot_refresh_secret_55");
        res.writeHead(200, { "Content-Type": "application/json" });
        res.end(
          JSON.stringify({
            copilot_plan: "pro",
            quota_reset_date: "2026-12-01",
            quota_snapshots: {
              premium_interactions: { entitlement: 300, remaining: 240, percent_remaining: 80 },
              chat: { unlimited: true },
            },
          }),
        );
        return;
      }
      res.writeHead(404).end();
    });
    stub.listen(0, "127.0.0.1");
    await once(stub, "listening");
    const addr = stub.address();
    assert.ok(addr && typeof addr !== "string");
    const base = `http://127.0.0.1:${addr.port}`;

    // Route derived `https://api.stub.local/models` to our loopback stub during unit test
    const routedFetch: typeof fetch = (input, init) => {
      const urlStr = typeof input === "string" ? input : input instanceof URL ? input.toString() : input.url;
      if (urlStr.startsWith("https://api.stub.local/")) {
        return fetch(urlStr.replace("https://api.stub.local", base), init);
      }
      return fetch(input, init);
    };
    const allowStub: OAuthDestinationValidator = (provider, url, purpose, ctx) => {
      if (url.hostname === "api.stub.local") return;
      allowLoopbackTestOAuth(provider, url, purpose, ctx);
    };

    try {
      const manager = new OAuthLoginSessionManager({
        githubBaseUrl: base,
        githubApiBaseUrl: base,
        fetchImpl: routedFetch,
        validateDestination: allowStub,
        pollIntervalFloorMs: 10,
        onCompleted: async (creds) => {
          capturedCreds = creds as GithubCopilotOAuthCredentials;
          return { channelId: "copilot-ch-1", availableModelCount: capturedCreds.availableModelIds?.length };
        },
      });

      const started = await manager.start({ provider: "github-copilot" });
      assert.equal(started.phase, "awaiting_user");
      assert.equal(started.userCode, "ABCD-1234");
      assert.equal(started.verificationUri, `${base}/login/device`);

      const done = await manager.waitForSession(started.sessionId);
      assert.equal(done?.phase, "succeeded");
      assert.equal(done?.availableModelCount, 2);
      assert.ok(!JSON.stringify(done).includes("gho_copilot_refresh_secret_55"));
      assert.ok(!JSON.stringify(done).includes("copilot-short-token"));
      assert.deepEqual(capturedCreds?.availableModelIds, ["claude-sonnet-5", "gpt-6-sol"]);

      const refreshed = await refreshGithubCopilotOAuthToken(
        capturedCreds!,
        new AbortController().signal,
        { githubApiBaseUrl: base, fetchImpl: routedFetch, validateDestination: allowStub },
      );
      assert.deepEqual(refreshed.availableModelIds, ["claude-sonnet-5", "gpt-6-sol"]);

      const quota = await queryGithubCopilotPlanQuota(capturedCreds!, {
        githubApiBaseUrl: base,
        validateDestination: allowStub,
      });
      assert.equal(quota.supported, true);
      assert.equal(quota.planName, "GitHub Copilot Pro");
      assert.equal(quota.windows[0]!.label, "Premium");
      assert.equal(quota.windows[0]!.remainingPercent, 80);
      assert.equal(quota.windows[0]!.remainingLabel, "240 / 300");
    } finally {
      stub.close();
      stub.closeAllConnections();
    }
  });

  it("completes xAI RFC 8628 device-code login and supports mid-poll cancellation", async () => {
    let pollMode: "complete" | "hang" = "complete";
    let captured: XaiOAuthCredentials | undefined;

    const stub = createServer(async (req, res) => {
      if (req.url === "/oauth2/device/code") {
        res.writeHead(200, { "Content-Type": "application/json" });
        res.end(
          JSON.stringify({
            device_code: "xai-dev-1",
            user_code: "XAI-9999",
            verification_uri: `${base}/device`,
            verification_uri_complete: `${base}/device?code=XAI-9999`,
            interval: 1,
            expires_in: 600,
          }),
        );
        return;
      }
      if (req.url === "/oauth2/token") {
        res.writeHead(200, { "Content-Type": "application/json" });
        if (pollMode === "hang") {
          res.end(JSON.stringify({ error: "authorization_pending" }));
          return;
        }
        res.end(
          JSON.stringify({
            access_token: "xai-access-secret-11",
            refresh_token: "xai-refresh-secret-22",
            expires_in: 3600,
          }),
        );
        return;
      }
      res.writeHead(404).end();
    });
    stub.listen(0, "127.0.0.1");
    await once(stub, "listening");
    const addr = stub.address();
    assert.ok(addr && typeof addr !== "string");
    const base = `http://127.0.0.1:${addr.port}`;

    try {
      const manager = new OAuthLoginSessionManager({
        xaiAuthBaseUrl: base,
        validateDestination: allowLoopbackTestOAuth,
        pollIntervalFloorMs: 10,
        onCompleted: async (creds) => {
          captured = creds as XaiOAuthCredentials;
          return { channelId: "xai-ch-1", availableModelCount: 4 };
        },
      });

      const started = await manager.start({ provider: "xai" });
      assert.equal(started.phase, "awaiting_user");
      assert.equal(started.userCode, "XAI-9999");
      assert.equal(started.verificationUri, `${base}/device?code=XAI-9999`);

      const done = await manager.waitForSession(started.sessionId);
      assert.equal(done?.phase, "succeeded");
      assert.equal(captured?.access, "xai-access-secret-11");
      assert.equal(captured?.refresh, "xai-refresh-secret-22");
      assert.ok(!JSON.stringify(done).includes("xai-access-secret-11"));

      // Cancel flow while polling
      pollMode = "hang";
      const started2 = await manager.start({ provider: "xai" });
      manager.cancel(started2.sessionId);
      const cancelled = await manager.waitForSession(started2.sessionId);
      assert.equal(cancelled?.phase, "cancelled");
    } finally {
      stub.close();
      stub.closeAllConnections();
    }
  });

  it("parses Codex and Copilot quota edge cases cleanly", () => {
    assert.equal(parseCodexPlanQuotaResponse({}).supported, false);
    const copilot = parseGithubCopilotPlanQuotaResponse({
      copilot_plan: "enterprise",
      token_based_billing: true,
      quota_snapshots: { chat: { unlimited: true } },
    });
    assert.equal(copilot.supported, true);
    assert.equal(copilot.planName, "GitHub Copilot Enterprise");
    assert.equal(copilot.windows[0]!.remainingLabel, "按量计费");
  });

  it("serializes cancel() against onCompleted() commit lock so cancelled sessions never persist or flip to succeeded (#8)", async () => {
    let tokenEntered!: () => void;
    let releaseToken!: () => void;
    let commitEntered!: () => void;
    let releaseCommit!: () => void;
    let mode: "cancel-before-commit" | "cancel-during-commit" = "cancel-before-commit";
    let completedCalls = 0;

    const resetGates = () => {
      tokenEntered = () => undefined;
      releaseToken = () => undefined;
      commitEntered = () => undefined;
      releaseCommit = () => undefined;
    };
    resetGates();

    const fetchImpl: typeof fetch = async (input) => {
      const url = String(input);
      if (url.endsWith("/oauth2/device/code")) {
        return new Response(
          JSON.stringify({
            device_code: "dc-race",
            user_code: "RACE-1234",
            verification_uri: "https://auth.x.ai/device",
            expires_in: 300,
            interval: 1,
          }),
          { status: 200, headers: { "Content-Type": "application/json" } },
        );
      }
      if (url.endsWith("/oauth2/token")) {
        if (mode === "cancel-before-commit") {
          tokenEntered();
          await new Promise<void>((r) => {
            releaseToken = r;
          });
        }
        return new Response(
          JSON.stringify({
            access_token: "xai-race-at",
            refresh_token: "xai-race-rt",
            expires_in: 3600,
          }),
          { status: 200, headers: { "Content-Type": "application/json" } },
        );
      }
      return new Response(null, { status: 404 });
    };

    const manager = new OAuthLoginSessionManager({
      fetchImpl,
      validateDestination: () => undefined,
      pollIntervalFloorMs: 5,
      xaiAuthBaseUrl: "https://auth.x.ai",
      onCompleted: async () => {
        completedCalls += 1;
        if (mode === "cancel-during-commit") {
          commitEntered();
          await new Promise<void>((r) => {
            releaseCommit = r;
          });
        }
        return { channelId: "xai-committed-1" };
      },
    });

    // Case A: cancel() arrives right before onCompleted() starts -> MUST NOT persist or report succeeded!
    const tokenInFlight = new Promise<void>((r) => {
      tokenEntered = r;
    });
    const s1 = await manager.start({ provider: "xai" });
    await tokenInFlight;
    const cancelledImmediate = manager.cancel(s1.sessionId);
    assert.equal(cancelledImmediate[0]?.phase, "cancelled");
    releaseToken();
    const s1Final = await manager.waitForSession(s1.sessionId);
    assert.equal(s1Final?.phase, "cancelled");
    assert.equal(completedCalls, 0);

    // Case B: cancel() arrives WHILE onCompleted() is actively committing -> MUST NOT lie and report cancelled!
    mode = "cancel-during-commit";
    const commitStarted = new Promise<void>((r) => {
      commitEntered = r;
    });
    const s2 = await manager.start({ provider: "xai" });
    await commitStarted;

    // Synchronous cancel during active commit MUST NOT flip phase to cancelled
    const midCancel = manager.cancel(s2.sessionId);
    assert.notEqual(midCancel[0]?.phase, "cancelled");
    // cancelAndWait waits on commit lock and observes final consistent "succeeded" state
    const cancelWaitPromise = manager.cancelAndWait(s2.sessionId);
    releaseCommit();
    const settled = await cancelWaitPromise;
    assert.equal(settled[0]?.phase, "succeeded");
    assert.equal(manager.getSession(s2.sessionId)?.phase, "succeeded");
    assert.equal(completedCalls, 1);
  });

  it("sanitizes Codex and xAI token refresh failures without leaking raw upstream response body (#9)", async () => {
    const { refreshCodexOAuthToken, refreshXaiOAuthToken } = await import("./oauthProxy.ts");
    const leakyBody = JSON.stringify({
      error: "invalid_grant",
      error_description: "Token revoked: access_token=eyJ-leaked-at refresh_token=rt-leaked-secret-999",
    });

    const leakyFetch: typeof fetch = async () =>
      new Response(leakyBody, { status: 400, headers: { "Content-Type": "application/json" } });

    await assert.rejects(
      () =>
        refreshCodexOAuthToken(
          { access: "old-at", refresh: "old-rt", expires: 0 },
          undefined,
          { fetchImpl: leakyFetch },
        ),
      (err: unknown) => {
        const msg = err instanceof Error ? err.message : String(err);
        assert.ok(msg.includes("HTTP 400: invalid_grant"), `expected sanitized code, got: ${msg}`);
        assert.equal(msg.includes("eyJ-leaked-at"), false);
        assert.equal(msg.includes("rt-leaked-secret-999"), false);
        return true;
      },
    );

    await assert.rejects(
      () =>
        refreshXaiOAuthToken(
          { access: "old-at", refresh: "old-rt", expires: 0 },
          undefined,
          { fetchImpl: leakyFetch },
        ),
      (err: unknown) => {
        const msg = err instanceof Error ? err.message : String(err);
        assert.ok(msg.includes("HTTP 400: invalid_grant"), `expected sanitized code, got: ${msg}`);
        assert.equal(msg.includes("eyJ-leaked-at"), false);
        assert.equal(msg.includes("rt-leaked-secret-999"), false);
        return true;
      },
    );
  });
});
