import assert from "node:assert/strict";
import { createServer, type IncomingMessage, type Server, type ServerResponse } from "node:http";
import { generateKeyPairSync, sign as cryptoSign } from "node:crypto";
import { mkdir, mkdtemp, readFile, rm, stat, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, it } from "node:test";
import { ChannelManager, type GatewayCoordinator } from "./channelManager.ts";
import {
  COMPANY_CHANNEL_ID,
  COMPANY_DEFAULT_MODEL_ID,
  startBundledPi,
  type GatewayChannelConfig,
} from "./gateway.ts";
import { queryApiKeyPlanQuota } from "./oauthLoginFlows.ts";
import { createCodexPlaceholderJwt, isCopilotModelPermitted } from "./oauthProxy.ts";
import { compileChannelToGatewayConfig } from "./providerCatalog.ts";
import {
  memorySecrets,
  SecretStoreUnavailableError,
  type SecretStore,
} from "./secretStore.ts";

async function startStubServer(
  handler: (req: IncomingMessage, res: ServerResponse) => void,
): Promise<{ readonly url: string; readonly close: () => Promise<void> }> {
  const server: Server = createServer(handler);
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  const addr = server.address();
  if (!addr || typeof addr === "string") throw new Error("failed to bind stub server");
  return {
    url: `http://127.0.0.1:${addr.port}`,
    close: () =>
      new Promise<void>((resolve) => {
        server.close(() => resolve());
        server.closeAllConnections();
      }),
  };
}

function createFakeGateway(): {
  readonly coordinator: GatewayCoordinator;
  readonly updates: GatewayChannelConfig[][];
} {
  let revision = 0;
  let defaultModelSlug: string | null = null;
  let zeroChannelState = true;
  const updates: GatewayChannelConfig[][] = [];

  return {
    updates,
    coordinator: {
      updateChannels: async (nextChannels) => {
        revision += 1;
        updates.push([...nextChannels]);
        const enabledModels: string[] = [];
        for (const ch of nextChannels) {
          if (!ch.enabled) continue;
          for (const m of ch.models) {
            if (m.enabled) enabledModels.push(`${ch.id}/${m.id}`);
          }
        }
        const preferredCompany = `${COMPANY_CHANNEL_ID}/${COMPANY_DEFAULT_MODEL_ID}`;
        defaultModelSlug = enabledModels.includes(preferredCompany)
          ? preferredCompany
          : (enabledModels[0] ?? null);
        zeroChannelState = defaultModelSlug === null;
        return { revision, defaultModelSlug, zeroChannelState };
      },
      getCatalogRevision: () => revision,
      getDefaultModelSlug: () => defaultModelSlug,
      isZeroChannelState: () => zeroChannelState,
    },
  };
}

function createDeleteFailingSecretStore(inner: SecretStore, failRef: string): SecretStore {
  return {
    get: (ref) => inner.get(ref),
    read: inner.read ? (ref) => inner.read!(ref) : undefined,
    set: (ref, value) => inner.set(ref, value),
    delete: async (ref) => {
      if (ref === failRef) {
        throw new SecretStoreUnavailableError("SECRET_ACCESS_DENIED", "keychain delete denied");
      }
      await inner.delete(ref);
    },
  };
}

function signTestJwt(
  payload: Record<string, unknown>,
  privateKey: ReturnType<typeof generateKeyPairSync>["privateKey"],
  kid: string,
): string {
  const header = Buffer.from(JSON.stringify({ alg: "RS256", typ: "JWT", kid })).toString("base64url");
  const body = Buffer.from(JSON.stringify(payload)).toString("base64url");
  const sig = cryptoSign("RSA-SHA256", Buffer.from(`${header}.${body}`), privateKey).toString(
    "base64url",
  );
  return `${header}.${body}.${sig}`;
}

describe("ChannelManager & Gateway/Live-Pi Coordinator (ADR-012 §2, §3.1–§3.4)", () => {
  it("persists redacted channels.json (0600) with ZERO secrets, supports CRUD, and enforces verified-delete-first on failure", async () => {
    const dir = await mkdtemp(join(tmpdir(), "xtwork-chmgr-crud-"));
    try {
      const innerSecrets = memorySecrets();
      let failDeleteRef = "";
      const secretStore: SecretStore = {
        get: (ref) => innerSecrets.get(ref),
        read: innerSecrets.read ? (ref) => innerSecrets.read!(ref) : undefined,
        set: (ref, val) => innerSecrets.set(ref, val),
        delete: async (ref) => {
          if (failDeleteRef && ref === failDeleteRef) {
            throw new SecretStoreUnavailableError("SECRET_ACCESS_DENIED", "simulated keychain denial");
          }
          await innerSecrets.delete(ref);
        },
      };
      const fakeGateway = createFakeGateway();
      const catalogEvents: Array<{ revision: number; defaultModelSlug: string | null }> = [];

      const manager = new ChannelManager({
        dataDir: dir,
        secretStore,
        gateway: fakeGateway.coordinator,
        onCatalogChanged: (evt) => {
          catalogEvents.push({ revision: evt.revision, defaultModelSlug: evt.defaultModelSlug });
        },
      });

      const initial = await manager.initialize();
      assert.equal(initial.zeroChannelState, true);
      assert.equal(initial.channels.length, 0);

      // Create Anthropic channel with secret
      const created = await manager.createChannel({
        name: "My Claude",
        provider: "anthropic",
        baseUrl: "https://api.anthropic.com",
        apiKey: "sk-ant-super-secret-value-999999",
        models: [
          { id: "claude-sonnet-4-6", name: "Claude Sonnet 4.6", enabled: true },
          { id: "claude-opus-4-6", name: "Claude Opus 4.6", enabled: false },
        ],
      });
      assert.equal(created.hasCredentials, true);
      assert.equal(created.isTeamChannel, false);
      assert.equal("apiKey" in (created as unknown as Record<string, unknown>), false);
      assert.equal(manager.getState().zeroChannelState, false);
      assert.equal(manager.getState().defaultModelSlug, `${created.id}/claude-sonnet-4-6`);

      // Verify channels.json permissions (0600) and ZERO secret leakage on disk!
      const rawFile = await readFile(manager.channelsFilePath, "utf8");
      const fileStat = await stat(manager.channelsFilePath);
      assert.equal(fileStat.mode & 0o777, 0o600);
      assert.equal(rawFile.includes("sk-ant-super-secret-value-999999"), false);
      assert.equal(rawFile.includes("apiKey"), false);

      // Update channel without re-sending apiKey -> keeps existing secret in SecretStore
      const updated = await manager.updateChannel(created.id, {
        name: "My Claude Renamed",
        models: [{ id: "claude-opus-4-6", name: "Claude Opus 4.6", enabled: true }],
      });
      assert.equal(updated.name, "My Claude Renamed");
      assert.equal(updated.hasCredentials, true);
      assert.equal(manager.getState().defaultModelSlug, `${created.id}/claude-opus-4-6`);

      // Simulate SecretStore.delete failure -> channel MUST be preserved!
      failDeleteRef = `channel:${created.id}`;
      await assert.rejects(
        () => manager.deleteChannel(created.id),
        /保留当前渠道状态/,
      );
      assert.equal(manager.listRedacted().length, 1);

      // Allow SecretStore.delete -> channel removed & zero-channel state restored
      failDeleteRef = "";
      const afterDelete = await manager.deleteChannel(created.id);
      assert.equal(afterDelete.channels.length, 0);
      assert.equal(afterDelete.zeroChannelState, true);
      assert.equal(afterDelete.defaultModelSlug, null);
      const secretCheck = await innerSecrets.get(`channel:${created.id}`);
      assert.equal(secretCheck, undefined);
      assert.ok(catalogEvents.length >= 3);
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });

  it("enforces Company Team Channel visibility, immutability, and logout verified-delete-first", async () => {
    const dir = await mkdtemp(join(tmpdir(), "xtwork-chmgr-company-"));
    const { publicKey, privateKey } = generateKeyPairSync("rsa", { modulusLength: 2048 });
    const jwk = publicKey.export({ format: "jwk" });
    const kid = "team-key-1";
    let pendingNonce = "";
    let stubBaseUrl = "";

    const stub = await startStubServer(async (req, res) => {
      const url = new URL(req.url ?? "/", stubBaseUrl);
      if (url.pathname === "/keycloak/realms/sci-it/protocol/openid-connect/token") {
        const idToken = signTestJwt(
          {
            iss: `${stubBaseUrl}/keycloak/realms/sci-it`,
            aud: "xiaotong-work",
            azp: "xiaotong-work",
            sub: "sub-001",
            nonce: pendingNonce,
            name: "小明 张",
            given_name: "小明",
            family_name: "张",
            iat: Math.floor(Date.now() / 1000) - 5,
            exp: Math.floor(Date.now() / 1000) + 600,
          },
          privateKey,
          kid,
        );
        res.writeHead(200, { "Content-Type": "application/json" });
        res.end(JSON.stringify({ access_token: "kc-at", refresh_token: "kc-rt", id_token: idToken }));
        return;
      }
      if (url.pathname === "/keycloak/realms/sci-it/protocol/openid-connect/certs") {
        res.writeHead(200, { "Content-Type": "application/json" });
        res.end(JSON.stringify({ keys: [{ ...jwk, kid, use: "sig", alg: "RS256" }] }));
        return;
      }
      if (url.pathname === "/api/oauth/exchange/keycloak") {
        res.writeHead(200, { "Content-Type": "application/json" });
        res.end(
          JSON.stringify({
            success: true,
            data: { api_key: "sk-company-secret-888888", user_id: 42, username: "zhangxm" },
          }),
        );
        return;
      }
      if (url.pathname === "/v1/models") {
        res.writeHead(200, { "Content-Type": "application/json" });
        res.end(
          JSON.stringify({
            data: [{ id: "deepseek-v4-flash-0731" }, { id: "claude-sonnet-4-6" }],
          }),
        );
        return;
      }
      if (url.pathname === "/keycloak/realms/sci-it/protocol/openid-connect/revoke") {
        res.writeHead(200).end();
        return;
      }
      res.writeHead(404).end();
    });
    stubBaseUrl = stub.url;

    const cbPort = 49172;
    const innerSecrets = memorySecrets();
    let failCompanyDelete = false;
    const secretStore = createDeleteFailingSecretStore(innerSecrets, "");
    const controllableSecrets: SecretStore = {
      get: (ref) => secretStore.get(ref),
      read: secretStore.read ? (ref) => secretStore.read!(ref) : undefined,
      set: (ref, val) => secretStore.set(ref, val),
      delete: async (ref) => {
        if (failCompanyDelete) {
          throw new SecretStoreUnavailableError("SECRET_ACCESS_DENIED", "company delete denied");
        }
        await secretStore.delete(ref);
      },
    };
    const fakeGateway = createFakeGateway();

    const manager = new ChannelManager({
      dataDir: dir,
      secretStore: controllableSecrets,
      gateway: fakeGateway.coordinator,
      companyAuthOptions: {
        issuer: `${stubBaseUrl}/keycloak/realms/sci-it`,
        apiBase: stubBaseUrl,
        redirectUri: `http://127.0.0.1:${cbPort}/callback`,
        validateUrl: () => undefined,
      },
    });

    try {
      await manager.initialize();
      assert.equal(manager.listRedacted().some((c) => c.id === COMPANY_CHANNEL_ID), false);

      const { authUrl } = await manager.startCompanyLogin();
      const authParsed = new URL(authUrl);
      pendingNonce = authParsed.searchParams.get("nonce")!;
      const state = authParsed.searchParams.get("state")!;

      const cbResp = await fetch(
        `http://127.0.0.1:${cbPort}/callback?state=${encodeURIComponent(state)}&code=auth-code-1`,
      );
      assert.equal(cbResp.status, 200);
      await manager.companyAuth.waitForActiveOperation();

      const afterLogin = manager.getState();
      assert.equal(afterLogin.companyAuth.phase, "signed-in");
      assert.equal(afterLogin.companyAuth.member?.name, "张小明");
      const teamCh = afterLogin.channels.find((c) => c.id === COMPANY_CHANNEL_ID);
      assert.ok(teamCh);
      assert.equal(teamCh.isTeamChannel, true);
      assert.equal(afterLogin.defaultModelSlug, "xiaotong-work-team/deepseek-flash");

      // Zero company sk- key in channels.json!
      const diskJson = await readFile(manager.channelsFilePath, "utf8");
      assert.equal(diskJson.includes("sk-company-secret-888888"), false);
      assert.equal(diskJson.includes("kc-rt"), false);

      // Immutability: cannot edit baseUrl, name, apiKey, or delete team channel
      await assert.rejects(
        () => manager.updateChannel(COMPANY_CHANNEL_ID, { baseUrl: "https://evil.example/v1" }),
        /不支持修改/,
      );
      await assert.rejects(
        () => manager.updateChannel(COMPANY_CHANNEL_ID, { apiKey: "sk-hijack" }),
        /不支持修改/,
      );
      await assert.rejects(
        () => manager.deleteChannel(COMPANY_CHANNEL_ID),
        /不支持直接删除/,
      );

      // Can toggle model/channel enabled state on team channel
      const toggled = await manager.updateChannel(COMPANY_CHANNEL_ID, {
        models: [
          { id: "deepseek-flash", name: "deepseek-flash", enabled: true },
          { id: "claude-sonnet-4-6", name: "claude-sonnet-4-6", enabled: true },
        ],
      });
      assert.equal(toggled.models.filter((m) => m.enabled).length, 2);

      // Logout fails if SecretStore.delete fails -> team channel stays visible & signed in!
      failCompanyDelete = true;
      await assert.rejects(() => manager.logoutCompany(), /保留当前登录状态/);
      assert.equal(manager.getState().companyAuth.phase, "signed-in");
      assert.equal(manager.listRedacted().some((c) => c.id === COMPANY_CHANNEL_ID), true);

      // Logout succeeds -> team channel disappears from UI & gateway
      failCompanyDelete = false;
      const afterLogout = await manager.logoutCompany();
      assert.equal(afterLogout.companyAuth.phase, "signed-out");
      assert.equal(afterLogout.channels.some((c) => c.id === COMPANY_CHANNEL_ID), false);
      assert.equal(afterLogout.zeroChannelState, true);
    } finally {
      await manager.close();
      await stub.close();
      await rm(dir, { recursive: true, force: true });
    }
  });

  it("tests channels, fetches models, redacts leaked keys in errors, and supports OAuth login + logout", async () => {
    const dir = await mkdtemp(join(tmpdir(), "xtwork-chmgr-test-"));
    let stubUrl = "";
    const stub = await startStubServer((req, res) => {
      const url = new URL(req.url ?? "/", stubUrl);
      if (url.pathname === "/v1/models" && req.headers.authorization === "Bearer sk-valid-key-12345") {
        res.writeHead(200, { "Content-Type": "application/json" });
        res.end(
          JSON.stringify({
            data: [
              { id: "gpt-5.4" },
              { id: "text-embedding-3-large" }, // non-agent filtered out!
            ],
          }),
        );
        return;
      }
      if (url.pathname === "/v1/models") {
        res.writeHead(401, { "Content-Type": "application/json" });
        res.end(
          JSON.stringify({
            error: { message: "Invalid key sk-bad-leaked-secret-999999 in Bearer sk-bad-leaked-secret-999999" },
          }),
        );
        return;
      }
      if (url.pathname === "/v1beta/models") {
        assert.equal(req.headers["x-goog-api-key"], "google-secret-key-123");
        res.writeHead(200, { "Content-Type": "application/json" });
        res.end(
          JSON.stringify({
            models: [
              {
                name: "models/gemini-3.1-pro-preview",
                displayName: "Gemini 3.1 Pro",
                supportedGenerationMethods: ["generateContent"],
              },
              {
                name: "models/text-embedding-004",
                supportedGenerationMethods: ["embedContent"],
              },
            ],
          }),
        );
        return;
      }
      if (url.pathname === "/oauth2/device/code") {
        res.writeHead(200, { "Content-Type": "application/json" });
        res.end(
          JSON.stringify({
            device_code: "xai-dc-1",
            user_code: "XAI-9999",
            verification_uri: `${stubUrl}/verify`,
            expires_in: 300,
            interval: 1,
          }),
        );
        return;
      }
      if (url.pathname === "/oauth2/token") {
        res.writeHead(200, { "Content-Type": "application/json" });
        res.end(
          JSON.stringify({
            access_token: "xai-access-secret-777",
            refresh_token: "xai-refresh-secret-777",
            expires_in: 3600,
          }),
        );
        return;
      }
      res.writeHead(404).end();
    });
    stubUrl = stub.url;

    const secretStore = memorySecrets();
    const fakeGateway = createFakeGateway();
    const manager = new ChannelManager({
      dataDir: dir,
      secretStore,
      gateway: fakeGateway.coordinator,
      validateOutboundUrl: () => undefined,
      oauthEndpoints: {
        validateDestination: () => undefined,
        pollIntervalFloorMs: 10,
        xaiAuthBaseUrl: stubUrl,
      },
    });

    try {
      await manager.initialize();

      // Test failure redacts API key and classifies 401 -> auth
      const badTest = await manager.testChannelDirect({
        provider: "openai",
        baseUrl: `${stubUrl}/v1`,
        apiKey: "sk-bad-leaked-secret-999999",
      });
      assert.equal(badTest.success, false);
      assert.equal(badTest.errorType, "auth");
      assert.equal(badTest.statusCode, 401);
      assert.equal(badTest.message.includes("sk-bad-leaked-secret-999999"), false);

      // Fetch OpenAI models filters out non-agent embeddings
      const fetchedOpenAi = await manager.fetchChannelModels({
        provider: "openai",
        baseUrl: `${stubUrl}/v1`,
        apiKey: "sk-valid-key-12345",
      });
      assert.equal(fetchedOpenAi.success, true);
      assert.deepEqual(
        fetchedOpenAi.models.map((m) => m.id),
        ["gpt-5.4"],
      );

      // Fetch Google models sends x-goog-api-key header (not URL query) and filters generateContent
      const fetchedGoogle = await manager.fetchChannelModels({
        provider: "google",
        baseUrl: stubUrl,
        apiKey: "google-secret-key-123",
      });
      assert.equal(fetchedGoogle.success, true);
      assert.deepEqual(
        fetchedGoogle.models.map((m) => m.id),
        ["gemini-3.1-pro-preview"],
      );

      // Xiaomi Token Plan preset fallback (no /models endpoint)
      const fetchedXiaomi = await manager.fetchChannelModels({
        provider: "xiaomi-token-plan",
        apiKey: "sk-xiaomi",
      });
      assert.equal(fetchedXiaomi.success, true);
      assert.ok(fetchedXiaomi.models.some((m) => m.id === "mimo-v2.6-pro"));

      // End-to-end xAI OAuth device-code login -> SecretStore persistence -> redacted channels.json -> logout
      const session = await manager.startOAuthLogin({ provider: "xai", channelName: "My Grok" });
      assert.equal(session.userCode, "XAI-9999");
      const done = await manager.waitForOAuthSession(session.sessionId);
      assert.equal(done?.phase, "succeeded");
      assert.ok(done?.channelId);

      const diskAfterOAuth = await readFile(manager.channelsFilePath, "utf8");
      assert.equal(diskAfterOAuth.includes("xai-access-secret-777"), false);
      assert.equal(diskAfterOAuth.includes("xai-refresh-secret-777"), false);

      const oauthChannel = manager.listRedacted().find((c) => c.id === done!.channelId);
      assert.ok(oauthChannel);
      assert.equal(oauthChannel.hasCredentials, true);
      assert.equal(oauthChannel.enabled, true);

      const loggedOutChannel = await manager.logoutOAuthChannel(oauthChannel.id);
      assert.equal(loggedOutChannel.hasCredentials, false);
      assert.equal(loggedOutChannel.enabled, false);
      assert.equal(manager.getState().zeroChannelState, true);

      // Sanity: placeholder JWT helper still produces non-secret value
      assert.ok(createCodexPlaceholderJwt().includes("xtwork-proxy"));
    } finally {
      await manager.close();
      await stub.close();
      await rm(dir, { recursive: true, force: true });
    }
  });

  it("blocks SSRF private/link-local/metadata IPs & URL query credentials, and enforces quota URL validation (#1)", async () => {
    const dir = await mkdtemp(join(tmpdir(), "xtwork-chmgr-ssrf-"));
    try {
      let outboundFetchCalls = 0;
      const manager = new ChannelManager({
        dataDir: dir,
        secretStore: memorySecrets(),
        fetchImpl: async () => {
          outboundFetchCalls += 1;
          return new Response(JSON.stringify({ data: [] }), { status: 200 });
        },
      });
      await manager.initialize();

      const blockedUrls = [
        "https://192.168.1.10/v1",
        "https://169.254.169.254/latest/meta-data",
        "https://10.0.0.5/v1",
        "https://172.16.0.1/v1",
        "https://100.64.0.1/v1",
        "https://127.0.0.1/v1",
        "https://0.0.0.0/v1",
        "https://[::1]/v1",
        "https://[::]/v1",
        "https://[fc00::1]/v1",
        "https://[fe80::1]/v1",
        "https://[::ffff:10.0.0.1]/v1",
        "https://[::ffff:169.254.169.254]/v1",
        "https://metadata.google.internal/computeMetadata/v1",
        "https://my-service.local/v1",
        "https://user:pass@api.openai.com/v1",
        "https://api.openai.com/v1?key=sk-secret-in-query",
        "https://api.openai.com/v1?api_key=sk-secret-in-query",
        "https://api.openai.com/v1?token=secret-tok",
      ];

      for (const badUrl of blockedUrls) {
        await assert.rejects(
          () =>
            manager.createChannel({
              name: "Bad SSRF",
              provider: "openai",
              baseUrl: badUrl,
              apiKey: "sk-test-1234",
            }),
          /不允许|HTTPS/,
          `Expected createChannel to reject ${badUrl}`,
        );
      }

      // Benign query params like api-version MUST still be accepted
      const benign = await manager.createChannel({
        name: "Azure-style Proxy",
        provider: "openai",
        baseUrl: "https://proxy.example.com/v1?api-version=2024-06-01",
        apiKey: "sk-benign-1234",
      });
      assert.equal(benign.baseUrl, "https://proxy.example.com/v1?api-version=2024-06-01");

      // queryApiKeyPlanQuota MUST enforce SSRF validator and NEVER fetch metadata IP!
      const quotaRes = await queryApiKeyPlanQuota(
        "deepseek",
        "sk-ds-123",
        "https://169.254.169.254/v1",
        {
          fetchImpl: async () => {
            outboundFetchCalls += 1;
            return new Response("{}", { status: 200 });
          },
        },
      );
      assert.equal(quotaRes.supported, false);
      assert.equal(outboundFetchCalls, 0);
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });

  it("refuses forwarding old stored API key on baseUrl/provider change (#2) and rejects cross-channel test/fetch mismatch (#3)", async () => {
    const dir = await mkdtemp(join(tmpdir(), "xtwork-chmgr-cred-"));
    try {
      let outboundFetchCalls = 0;
      const manager = new ChannelManager({
        dataDir: dir,
        secretStore: memorySecrets(),
        fetchImpl: async () => {
          outboundFetchCalls += 1;
          return new Response(JSON.stringify({ data: [] }), { status: 200 });
        },
      });
      await manager.initialize();

      const ch = await manager.createChannel({
        name: "Claude Primary",
        provider: "anthropic",
        baseUrl: "https://api.anthropic.com",
        apiKey: "sk-ant-original-key-1234",
      });

      // #2: Changing baseUrl without providing a new apiKey MUST be rejected!
      await assert.rejects(
        () => manager.updateChannel(ch.id, { baseUrl: "https://attacker.example.com" }),
        /必须重新输入新的 API Key/,
      );
      // #2: Changing provider without providing a new apiKey MUST be rejected!
      await assert.rejects(
        () => manager.updateChannel(ch.id, { provider: "openai" }),
        /必须重新输入新的 API Key/,
      );
      // Providing a new apiKey when changing baseUrl succeeds!
      const updated = await manager.updateChannel(ch.id, {
        baseUrl: "https://proxy.example.com",
        apiKey: "sk-ant-rotated-key-5678",
      });
      assert.equal(updated.baseUrl, "https://proxy.example.com");

      // #3: Calling testChannelDirect or fetchChannelModels with channelId + mismatched provider/baseUrl MUST be rejected without fetching!
      await assert.rejects(
        () =>
          manager.testChannelDirect({
            channelId: ch.id,
            provider: "openai",
            baseUrl: "https://proxy.example.com",
          }),
        /不能使用已保存的渠道凭据/,
      );
      await assert.rejects(
        () =>
          manager.testChannelDirect({
            channelId: ch.id,
            provider: "anthropic",
            baseUrl: "https://evil-exfil.example.com",
          }),
        /不能使用已保存的渠道凭据/,
      );
      await assert.rejects(
        () =>
          manager.fetchChannelModels({
            channelId: ch.id,
            provider: "anthropic",
            baseUrl: "https://evil-exfil.example.com",
          }),
        /不能使用已保存的渠道凭据/,
      );
      assert.equal(outboundFetchCalls, 0);
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });

  it("purges revoked company apiKey from live gateway even if channels.json write fails after verified SecretStore.delete (#5)", async () => {
    const dir = await mkdtemp(join(tmpdir(), "xtwork-chmgr-gw-purge-"));
    let stubUrl = "";
    const stub = await startStubServer((req, res) => {
      const url = new URL(req.url ?? "/", stubUrl);
      if (url.pathname === "/v1/chat/completions") {
        res.writeHead(200, { "Content-Type": "application/json" });
        res.end(JSON.stringify({ ok: true, auth: req.headers.authorization }));
        return;
      }
      res.writeHead(200, { "Content-Type": "application/json" });
      res.end("{}");
    });
    stubUrl = stub.url;

    const secretStore = memorySecrets();
    const gw = await startBundledPi("/bin/true", dir, {}, {
      secretStore,
      skipBinaryAccessCheck: true,
    });

    await secretStore.set(
      "company:xiaotong-work-team",
      JSON.stringify({
        apiKey: "sk-company-must-purge-999",
        refreshToken: "rt-purge",
        member: { subject: "s-purge", name: "测试员", userId: 1, username: "purger" },
      }),
    );

    let failPersist = false;
    const manager = new ChannelManager({
      dataDir: dir,
      secretStore: gw.secretStore,
      fence: gw.fence,
      oauthManager: gw.oauthManager,
      gateway: gw,
      validateOutboundUrl: () => undefined,
      companyAuthOptions: {
        issuer: `${stubUrl}/keycloak/realms/sci-it`,
        apiBase: stubUrl,
        validateUrl: () => undefined,
      },
      onBeforePersistChannels: () => {
        if (failPersist) throw new Error("ENOSPC: simulated disk full");
      },
    });

    try {
      await manager.initialize();
      // Live gateway serves company team channel before logout
      const beforeResp = await fetch(
        `http://127.0.0.1:${gw.port}/c/${COMPANY_CHANNEL_ID}/openai-completions/v1/chat/completions`,
        {
          method: "POST",
          headers: {
            authorization: `Bearer ${gw.gatewayToken}`,
            "content-type": "application/json",
          },
          body: JSON.stringify({ model: COMPANY_DEFAULT_MODEL_ID, messages: [] }),
        },
      );
      assert.equal(beforeResp.status, 200);

      // Now simulate channels.json write failure during company logout AFTER SecretStore.delete succeeds!
      failPersist = true;
      await assert.rejects(() => manager.logoutCompany(), /ENOSPC/);

      // SecretStore is deleted, companyAuth is signed-out, AND live gateway MUST IMMEDIATELY reject!
      assert.equal(await secretStore.get("company:xiaotong-work-team"), undefined);
      assert.equal(manager.companyAuth.getState().phase, "signed-out");
      const afterResp = await fetch(
        `http://127.0.0.1:${gw.port}/c/${COMPANY_CHANNEL_ID}/openai-completions/v1/chat/completions`,
        {
          method: "POST",
          headers: {
            authorization: `Bearer ${gw.gatewayToken}`,
            "content-type": "application/json",
          },
          body: JSON.stringify({ model: COMPANY_DEFAULT_MODEL_ID, messages: [] }),
        },
      );
      assert.equal(afterResp.status, 404);
    } finally {
      await manager.close();
      await gw.close();
      await stub.close();
      await rm(dir, { recursive: true, force: true });
    }
  });

  it("blocks OAuth overwrite of xiaotong-work-team (#6), evicts cached OAuth account on re-login (#7), and keeps empty Copilot allowlist consistent (#11)", async () => {
    const dir = await mkdtemp(join(tmpdir(), "xtwork-chmgr-oauth-fixes-"));
    let xaiTokenIssued = "xai-account-A-token";
    let stubUrl = "";

    const stub = await startStubServer((req, res) => {
      const url = new URL(req.url ?? "/", stubUrl);
      if (url.pathname === "/oauth2/device/code") {
        res.writeHead(200, { "Content-Type": "application/json" });
        res.end(
          JSON.stringify({
            device_code: "dc-relogin",
            user_code: "REL-1234",
            verification_uri: `${stubUrl}/verify`,
            expires_in: 300,
            interval: 1,
          }),
        );
        return;
      }
      if (url.pathname === "/oauth2/token") {
        res.writeHead(200, { "Content-Type": "application/json" });
        res.end(
          JSON.stringify({
            access_token: xaiTokenIssued,
            refresh_token: `${xaiTokenIssued}-rt`,
            expires_in: 3600,
          }),
        );
        return;
      }
      if (url.pathname === "/login/device/code") {
        res.writeHead(200, { "Content-Type": "application/json" });
        res.end(
          JSON.stringify({
            device_code: "gh-dc-empty",
            user_code: "GH-0000",
            verification_uri: `${stubUrl}/gh-verify`,
            expires_in: 300,
            interval: 1,
          }),
        );
        return;
      }
      if (url.pathname === "/login/oauth/access_token") {
        res.writeHead(200, { "Content-Type": "application/json" });
        res.end(JSON.stringify({ access_token: "gho_empty_policy_user" }));
        return;
      }
      if (url.pathname === "/copilot_internal/v2/token") {
        res.writeHead(200, { "Content-Type": "application/json" });
        res.end(
          JSON.stringify({
            token: "tid=copilot-empty;proxy-ep=proxy.individual.githubcopilot.com",
            expires_at: Math.floor(Date.now() / 1000) + 3600,
          }),
        );
        return;
      }
      if (url.pathname === "/models") {
        // Org policy disables ALL models!
        res.writeHead(200, { "Content-Type": "application/json" });
        res.end(
          JSON.stringify({
            data: [
              { id: "gpt-5.4", policy: { state: "disabled" }, model_picker_enabled: false },
            ],
          }),
        );
        return;
      }
      res.writeHead(404).end();
    });
    stubUrl = stub.url;

    const secretStore = memorySecrets();
    const gw = await startBundledPi("/bin/true", dir, {}, {
      secretStore,
      skipBinaryAccessCheck: true,
    });

    const manager = new ChannelManager({
      dataDir: dir,
      secretStore: gw.secretStore,
      fence: gw.fence,
      oauthManager: gw.oauthManager,
      gateway: gw,
      validateOutboundUrl: () => undefined,
      oauthEndpoints: {
        validateDestination: () => undefined,
        pollIntervalFloorMs: 5,
        xaiAuthBaseUrl: stubUrl,
        githubBaseUrl: stubUrl,
        githubApiBaseUrl: stubUrl,
        fetchImpl: async (input, init) => {
          const rawUrl = typeof input === "string" ? input : input instanceof URL ? input.href : input.url;
          // Route derived Copilot `https://api.individual.githubcopilot.com/models` to our local stub
          if (rawUrl.includes("githubcopilot.com/models")) {
            return await fetch(`${stubUrl}/models`, init);
          }
          return await fetch(input, init);
        },
      },
    });

    try {
      await manager.initialize();

      // #6: OAuth login targeting xiaotong-work-team MUST be rejected!
      await assert.rejects(
        () => manager.startOAuthLogin({ provider: "xai", channelId: COMPANY_CHANNEL_ID }),
        /不支持修改/,
      );

      // #7: First xAI login -> warm active OAuthTokenManager cache -> re-login on SAME channelId ->
      // MUST immediately evict cached account A and serve account B!
      const sA = await manager.startOAuthLogin({ provider: "xai", channelId: "xai-shared" });
      const doneA = await manager.waitForOAuthSession(sA.sessionId);
      assert.equal(doneA?.phase, "succeeded");
      const credsA = await gw.oauthManager.getValidCredentials("xai-shared");
      assert.equal(credsA.access, "xai-account-A-token");

      xaiTokenIssued = "xai-account-B-token";
      const sB = await manager.startOAuthLogin({ provider: "xai", channelId: "xai-shared" });
      const doneB = await manager.waitForOAuthSession(sB.sessionId);
      assert.equal(doneB?.phase, "succeeded");
      const credsB = await gw.oauthManager.getValidCredentials("xai-shared");
      assert.equal(credsB.access, "xai-account-B-token");

      // #11: GitHub Copilot with empty org allowlist (`availableModelIds: []`) MUST yield 0 models in BOTH UI & gateway!
      const sCopilot = await manager.startOAuthLogin({ provider: "github-copilot" });
      const doneCopilot = await manager.waitForOAuthSession(sCopilot.sessionId);
      assert.equal(doneCopilot?.phase, "succeeded");
      assert.equal(doneCopilot?.availableModelCount, 0);

      const copilotCh = manager.listRedacted().find((c) => c.id === doneCopilot!.channelId);
      assert.ok(copilotCh);
      assert.deepEqual(copilotCh.availableModelIds, []);
      assert.deepEqual(copilotCh.models, []);

      const fetchedCopilot = await manager.fetchChannelModels({
        channelId: copilotCh.id,
        provider: "github-copilot",
      });
      assert.equal(fetchedCopilot.success, true);
      assert.deepEqual(fetchedCopilot.models, []);

      const compiledCopilot = compileChannelToGatewayConfig(copilotCh);
      assert.deepEqual(compiledCopilot.models, []);
    } finally {
      await manager.close();
      await gw.close();
      await stub.close();
      await rm(dir, { recursive: true, force: true });
    }
  });

  it("blocks legacy SSRF/auth_token URLs on load, blocks endpoint change when SecretStore is unavailable, suppresses dev fallback when an enabled member channel has all models disabled, and matches Copilot availableModelIds case-insensitively (Sol R2)", async () => {
    const dir = await mkdtemp(join(tmpdir(), "xtwork-cm-r2-"));
    try {
      // 1. Legacy channels.json with loopback SSRF URL and ?auth_token=... MUST be stripped on load and NOT compiled into gateway!
      const channelsFile = join(dir, "channels", "channels.json");
      await mkdir(join(dir, "channels"), { recursive: true });
      await writeFile(
        channelsFile,
        JSON.stringify(
          {
            version: 1,
            channels: [
              {
                id: "legacy-ssrf",
                name: "Legacy SSRF",
                provider: "openai",
                baseUrl: "https://127.0.0.1:9443/v1?auth_token=leaked-secret&api-version=2025-01",
                enabled: true,
                secretRef: "channel:legacy-ssrf",
                models: [{ id: "gpt-4o", name: "GPT-4o", enabled: true }],
                createdAt: 1,
                updatedAt: 1,
              },
              {
                id: "disabled-models-ch",
                name: "Enabled Channel Zero Models",
                provider: "openai",
                baseUrl: "https://api.openai.com/v1",
                enabled: true,
                secretRef: "channel:disabled-models-ch",
                models: [{ id: "gpt-4o", name: "GPT-4o", enabled: false }],
                createdAt: 1,
                updatedAt: 1,
              },
            ],
          },
          null,
          2,
        ),
        "utf8",
      );

      const backing = memorySecrets();
      await backing.set("channel:legacy-ssrf", "sk-legacy-secret");
      await backing.set("channel:disabled-models-ch", "sk-disabled-models");
      let failReads = false;
      const flakySecrets: SecretStore = {
        backend: backing.backend,
        get: async (k) => {
          if (failReads) throw new SecretStoreUnavailableError("SECRET_STORE_UNAVAILABLE", "keychain locked");
          return backing.get(k);
        },
        set: (k, v) => backing.set(k, v),
        delete: (k) => backing.delete(k),
      };

      const gw = await startBundledPi(
        "/bin/true",
        dir,
        { XTWORK_MODEL_UPSTREAM_URL: "https://dev-fallback.example.com/v1" },
        {
          secretStore: flakySecrets,
          skipBinaryAccessCheck: true,
        },
      );
      const manager = new ChannelManager({
        dataDir: dir,
        secretStore: flakySecrets,
        gateway: gw,
        devFallbackActive: true,
      });

      try {
        await manager.initialize();

        // #1: auth_token stripped on load AND loopback legacy channel refused from gateway compilation
        const loadedLegacy = manager.listRedacted().find((c) => c.id === "legacy-ssrf");
        assert.ok(loadedLegacy);
        assert.equal(loadedLegacy.baseUrl.includes("auth_token"), false);
        assert.equal(loadedLegacy.baseUrl.includes("leaked-secret"), false);
        assert.equal(loadedLegacy.baseUrl.includes("api-version=2025-01"), true);

        const legacyResp = await fetch(
          `http://127.0.0.1:${gw.port}/c/legacy-ssrf/openai-completions/chat/completions`,
          {
            method: "POST",
            headers: {
              authorization: `Bearer ${gw.gatewayToken}`,
              "content-type": "application/json",
            },
            body: JSON.stringify({ model: "gpt-4o", messages: [{ role: "user", content: "hi" }] }),
          },
        );
        assert.equal(legacyResp.status, 404, "Legacy loopback SSRF channel must not be mounted in gateway");

        // #10: Enabled member channel with all models disabled MUST STILL suppress xtwork/standard dev fallback!
        assert.equal(gw.getDefaultModelSlug(), null);
        assert.equal(manager.getState().defaultModelSlug, null);
        const devResp = await fetch(`http://127.0.0.1:${gw.port}/v1/chat/completions`, {
          method: "POST",
          headers: {
            authorization: `Bearer ${gw.gatewayToken}`,
            "content-type": "application/json",
          },
          body: JSON.stringify({ model: "standard", messages: [{ role: "user", content: "hi" }] }),
        });
        assert.equal(devResp.status, 404, "Dev fallback must stay disabled when a member channel is enabled even with 0 enabled models");

        // #2: Even when SecretStore is temporarily unavailable during init (credentialsPresence=false),
        // changing baseUrl or provider on a channel with an existing secretRef MUST still require a new API key!
        failReads = true;
        const managerLocked = new ChannelManager({
          dataDir: dir,
          secretStore: flakySecrets,
        });
        await managerLocked.initialize();
        await assert.rejects(
          () =>
            managerLocked.updateChannel("disabled-models-ch", {
              baseUrl: "https://attacker.example.com/v1",
            }),
          /必须重新输入新的 API Key/,
        );
        await assert.rejects(
          () =>
            managerLocked.updateChannel("disabled-models-ch", {
              provider: "anthropic",
              baseUrl: "https://api.anthropic.com",
            }),
          /必须重新输入新的 API Key/,
        );
        await managerLocked.close();

        // #11: Mixed-case Copilot availableModelIds must match identically in BOTH UI and gateway allowlist!
        assert.equal(isCopilotModelPermitted("claude-sonnet-4.5", ["CLAUDE-SONNET-4.5"]), true);
        assert.equal(isCopilotModelPermitted("GPT-4o", ["gpt-4o"]), true);
        assert.equal(isCopilotModelPermitted("gpt-4o", ["claude-sonnet-4.5"]), false);
      } finally {
        await manager.close();
        await gw.close();
      }
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });
});
