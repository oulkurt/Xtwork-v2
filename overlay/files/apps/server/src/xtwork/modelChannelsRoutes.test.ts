// @effect-diagnostics nodeBuiltinImport:off globalDate:off
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  AuthOrchestrationOperateScope,
  AuthOrchestrationReadScope,
  ProviderInstanceId,
  type ModelSelection,
} from "@t3tools/contracts";
import * as Context from "effect/Context";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import { HttpServerRequest } from "effect/http";
import { afterEach, describe, expect, it } from "vite-plus/test";
import { EnvironmentAuth } from "../auth/EnvironmentAuth.ts";
import { PI_INSTANCE_ID } from "./bundledPiSettings.ts";
import { ChannelManager } from "./channelManager.ts";
import { COMPANY_CHANNEL_ID } from "./gateway.ts";
import {
  computeReconciledDefaultSelection,
  serveModelChannels,
  type ModelChannelsService,
} from "./modelChannelsRoutes.ts";
import { memorySecrets } from "./secretStore.ts";

const tempDirs: string[] = [];

afterEach(() => {
  while (tempDirs.length > 0) {
    const dir = tempDirs.pop()!;
    rmSync(dir, { recursive: true, force: true });
  }
});

function createTempDir(): string {
  const dir = mkdtempSync(join(tmpdir(), "xtwork-routes-test-"));
  tempDirs.push(dir);
  return dir;
}

function makeFakeAuth(subject: string, scopes: readonly string[]) {
  return Layer.succeed(EnvironmentAuth, {
    authenticateHttpRequest: () =>
      Effect.succeed({
        sessionId: "sess-1",
        subject,
        scopes,
        method: "bearer-session-token",
        role: "owner",
        client: {},
        expiresAt: new Date(Date.now() + 3_600_000).toISOString(),
      }),
  } as unknown as Context.Service.Shape<typeof EnvironmentAuth>);
}

async function invokeRoute(
  service: ModelChannelsService,
  options: {
    readonly method: "GET" | "POST";
    readonly path: string;
    readonly token?: string;
    readonly body?: unknown;
    readonly subject?: string;
    readonly scopes?: readonly string[];
  },
) {
  const headers: Record<string, string> = {};
  if (options.token) headers.authorization = `Bearer ${options.token}`;
  if (options.body !== undefined) headers["content-type"] = "application/json";
  const webReq = new Request(`http://127.0.0.1:3773${options.path}`, {
    method: options.method,
    headers,
    ...(options.body !== undefined ? { body: JSON.stringify(options.body) } : {}),
  });
  const serverReq = HttpServerRequest.fromWeb(webReq);
  const authLayer = makeFakeAuth(
    options.subject ?? "desktop-bootstrap",
    options.scopes ?? [AuthOrchestrationReadScope, AuthOrchestrationOperateScope],
  );
  const res = await Effect.runPromise(
    serveModelChannels(service).pipe(
      Effect.provideService(HttpServerRequest.HttpServerRequest, serverReq),
      Effect.provide(authLayer),
    ),
  );
  const body = res.body._tag === "Uint8Array" ? JSON.parse(new TextDecoder().decode(res.body.body)) : {};
  return { status: res.status, headers: res.headers, body };
}

describe("Xtwork Model Channels HTTP routes (ADR-012 §2, §3.1–§3.4)", () => {
  it("enforces Bearer auth (401) and desktop-bootstrap write authorization (403)", async () => {
    const dir = createTempDir();
    const manager = new ChannelManager({ dataDir: dir, secretStore: memorySecrets() });
    await manager.initialize();
    const service: ModelChannelsService = { manager, reconcileNow: () => Effect.void };

    const unauth = await invokeRoute(service, {
      method: "GET",
      path: "/api/xtwork/channels/state",
    });
    expect(unauth.status).toBe(401);

    const nonBootstrapWrite = await invokeRoute(service, {
      method: "POST",
      path: "/api/xtwork/channels/create",
      token: "valid-token",
      subject: "remote-browser",
      body: { name: "Blocked", provider: "openai", apiKey: "sk-blocked" },
    });
    expect(nonBootstrapWrite.status).toBe(403);

    const readOk = await invokeRoute(service, {
      method: "GET",
      path: "/api/xtwork/channels/state",
      token: "valid-token",
      subject: "remote-browser",
      scopes: [AuthOrchestrationReadScope],
    });
    expect(readOk.status).toBe(200);
    expect(readOk.headers["cache-control"]).toBe("no-store");
    expect(readOk.body.zeroChannelState).toBe(true);
    expect(Array.isArray(readOk.body.catalog)).toBe(true);
  });

  it("handles CRUD without ever leaking secrets, rejects team delete (403), and triggers reconciliation", async () => {
    const dir = createTempDir();
    const manager = new ChannelManager({ dataDir: dir, secretStore: memorySecrets() });
    await manager.initialize();
    let reconcileCalls = 0;
    const service: ModelChannelsService = {
      manager,
      reconcileNow: () =>
        Effect.sync(() => {
          reconcileCalls += 1;
        }),
    };

    const created = await invokeRoute(service, {
      method: "POST",
      path: "/api/xtwork/channels/create",
      token: "desktop-tok",
      body: {
        name: "My DeepSeek",
        provider: "deepseek",
        baseUrl: "https://api.deepseek.com/anthropic",
        apiKey: "sk-ds-never-leak-123456",
        models: [{ id: "deepseek-chat", name: "DeepSeek Chat", enabled: true }],
      },
    });
    expect(created.status).toBe(200);
    expect(JSON.stringify(created.body)).not.toContain("sk-ds-never-leak-123456");
    expect(created.body.channel.hasCredentials).toBe(true);
    expect(created.body.state.zeroChannelState).toBe(false);
    expect(reconcileCalls).toBe(1);

    // Company team channel delete MUST be forbidden (403)
    const teamDelete = await invokeRoute(service, {
      method: "POST",
      path: "/api/xtwork/channels/delete",
      token: "desktop-tok",
      body: { id: COMPANY_CHANNEL_ID },
    });
    expect(teamDelete.status).toBe(403);
    expect(teamDelete.body.code).toBe("TEAM_CHANNEL_IMMUTABLE");

    // Delete member channel cleanly
    const deleted = await invokeRoute(service, {
      method: "POST",
      path: "/api/xtwork/channels/delete",
      token: "desktop-tok",
      body: { id: created.body.channel.id },
    });
    expect(deleted.status).toBe(200);
    expect(deleted.body.deleted).toBe(true);
    expect(deleted.body.state.zeroChannelState).toBe(true);
    expect(reconcileCalls).toBe(2);
  });

  it("smoothly reconciles defaultModelSelection without clobbering external providers or valid models", () => {
    const externalSelection: ModelSelection = {
      instanceId: ProviderInstanceId.make("claudeAgent"),
      model: "claude-sonnet-4-6",
    };
    expect(
      computeReconciledDefaultSelection(externalSelection, {
        revision: 1,
        defaultModelSlug: "xiaotong-work-team/deepseek-flash",
        zeroChannelState: false,
        enabledModelSlugs: ["xiaotong-work-team/deepseek-flash"],
      }),
    ).toBeUndefined();

    // Transitions out of zero-channel / inherit state when a channel becomes available
    expect(
      computeReconciledDefaultSelection(
        { instanceId: PI_INSTANCE_ID, model: "default" },
        {
          revision: 2,
          defaultModelSlug: "xiaotong-work-team/deepseek-flash",
          zeroChannelState: false,
          enabledModelSlugs: ["xiaotong-work-team/deepseek-flash"],
        },
      ),
    ).toEqual({ instanceId: PI_INSTANCE_ID, model: "xiaotong-work-team/deepseek-flash" });

    // Keeps user's still-valid xtworkPi model untouched
    expect(
      computeReconciledDefaultSelection(
        { instanceId: PI_INSTANCE_ID, model: "my-claude/claude-opus-4-6" },
        {
          revision: 3,
          defaultModelSlug: "xiaotong-work-team/deepseek-flash",
          zeroChannelState: false,
          enabledModelSlugs: [
            "xiaotong-work-team/deepseek-flash",
            "my-claude/claude-opus-4-6",
          ],
        },
      ),
    ).toBeUndefined();

    // Smoothly falls back when selected xtworkPi model is removed
    expect(
      computeReconciledDefaultSelection(
        { instanceId: PI_INSTANCE_ID, model: "deleted-ch/old-model" },
        {
          revision: 4,
          defaultModelSlug: "xiaotong-work-team/deepseek-flash",
          zeroChannelState: false,
          enabledModelSlugs: ["xiaotong-work-team/deepseek-flash"],
        },
      ),
    ).toEqual({ instanceId: PI_INSTANCE_ID, model: "xiaotong-work-team/deepseek-flash" });

    // Returns to inherit sentinel when returning to zero-channel state
    expect(
      computeReconciledDefaultSelection(
        { instanceId: PI_INSTANCE_ID, model: "deleted-ch/old-model" },
        {
          revision: 5,
          defaultModelSlug: null,
          zeroChannelState: true,
          enabledModelSlugs: [],
        },
      ),
    ).toEqual({ instanceId: PI_INSTANCE_ID, model: "default" });
  });

  it("enforces HTTP 400 on endpoint-change without new API key (#2), cross-channel test/fetch mismatch (#3), and HTTP 403 on OAuth team overwrite (#6)", async () => {
    const dir = createTempDir();
    const manager = new ChannelManager({ dataDir: dir, secretStore: memorySecrets() });
    await manager.initialize();
    const service: ModelChannelsService = { manager, reconcileNow: () => Effect.void };

    const created = await invokeRoute(service, {
      method: "POST",
      path: "/api/xtwork/channels/create",
      token: "desktop-tok",
      body: {
        name: "My Anthropic",
        provider: "anthropic",
        baseUrl: "https://api.anthropic.com",
        apiKey: "sk-ant-initial-1234",
      },
    });
    expect(created.status).toBe(200);
    const channelId = created.body.channel.id as string;

    // #2: Changing baseUrl without apiKey -> HTTP 400 API_KEY_REQUIRED_ON_ENDPOINT_CHANGE
    const badUpdate = await invokeRoute(service, {
      method: "POST",
      path: "/api/xtwork/channels/update",
      token: "desktop-tok",
      body: { id: channelId, baseUrl: "https://other.example.com" },
    });
    expect(badUpdate.status).toBe(400);
    expect(badUpdate.body.code).toBe("API_KEY_REQUIRED_ON_ENDPOINT_CHANGE");

    // #3: Testing with channelId + mismatched baseUrl without inline apiKey -> HTTP 400
    const badTest = await invokeRoute(service, {
      method: "POST",
      path: "/api/xtwork/channels/test",
      token: "desktop-tok",
      body: { channelId, provider: "anthropic", baseUrl: "https://attacker.example.com" },
    });
    expect(badTest.status).toBe(400);

    // #3: Fetching models with channelId + mismatched provider without inline apiKey -> HTTP 400
    const badFetch = await invokeRoute(service, {
      method: "POST",
      path: "/api/xtwork/channels/fetch-models",
      token: "desktop-tok",
      body: { channelId, provider: "openai", baseUrl: "https://api.openai.com/v1" },
    });
    expect(badFetch.status).toBe(400);

    // #6: OAuth start targeting xiaotong-work-team -> HTTP 403 TEAM_CHANNEL_IMMUTABLE
    const badOAuth = await invokeRoute(service, {
      method: "POST",
      path: "/api/xtwork/channels/oauth/start",
      token: "desktop-tok",
      body: { provider: "xai", channelId: COMPANY_CHANNEL_ID },
    });
    expect(badOAuth.status).toBe(403);
    expect(badOAuth.body.code).toBe("TEAM_CHANNEL_IMMUTABLE");
  });
});
