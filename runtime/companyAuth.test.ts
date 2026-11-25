import assert from "node:assert/strict";
import { generateKeyPairSync, sign as cryptoSign } from "node:crypto";
import { once } from "node:events";
import { createServer } from "node:http";
import { describe, it } from "node:test";
import {
  assertStrictCompanyHttpsUrl,
  COMPANY_CLIENT_ID,
  COMPANY_SECRET_REF,
  CompanyAuthService,
  formatCompanyMemberName,
  verifyOidcIdToken,
} from "./companyAuth.ts";
import {
  ChannelCredentialFence,
  memorySecrets,
  SecretStoreUnavailableError,
  type SecretStore,
} from "./secretStore.ts";

function makeRsaTestKey(kid = "test-kid-1") {
  const { publicKey, privateKey } = generateKeyPairSync("rsa", { modulusLength: 2048 });
  const jwk = publicKey.export({ format: "jwk" }) as Record<string, unknown>;
  return {
    privateKey,
    jwk: { ...jwk, kid, use: "sig", alg: "RS256" },
  };
}

function signTestJwt(
  header: Record<string, unknown>,
  payload: Record<string, unknown>,
  privateKey: ReturnType<typeof generateKeyPairSync>["privateKey"],
): string {
  const h = Buffer.from(JSON.stringify(header), "utf8").toString("base64url");
  const p = Buffer.from(JSON.stringify(payload), "utf8").toString("base64url");
  const sig = cryptoSign("RSA-SHA256", Buffer.from(`${h}.${p}`, "utf8"), privateKey).toString(
    "base64url",
  );
  return `${h}.${p}.${sig}`;
}

async function getFreeLoopbackPort(): Promise<number> {
  const srv = createServer();
  srv.listen(0, "127.0.0.1");
  await once(srv, "listening");
  const addr = srv.address();
  assert.ok(addr && typeof addr !== "string");
  const port = addr.port;
  await new Promise<void>((r) => srv.close(() => r()));
  return port;
}

describe("Company WeCom OIDC + PKCE Auth Service (ADR-012 §3.2)", () => {
  it("formats Han Chinese member names and enforces strict HTTPS destination rules", () => {
    assert.equal(formatCompanyMemberName("San Zhang", "三", "张"), "张三");
    assert.equal(formatCompanyMemberName("小明 王"), "王小明");
    assert.equal(formatCompanyMemberName("Alice Smith"), "Alice Smith");

    assert.doesNotThrow(() =>
      assertStrictCompanyHttpsUrl(
        new URL("https://llm-api.sci-it.com/v1/models"),
        "https://llm-api.sci-it.com",
      ),
    );
    assert.throws(() =>
      assertStrictCompanyHttpsUrl(
        new URL("http://llm-api.sci-it.com/v1/models"),
        "https://llm-api.sci-it.com",
      ),
    );
    assert.throws(() =>
      assertStrictCompanyHttpsUrl(
        new URL("https://evil.example.com/v1/models"),
        "https://llm-api.sci-it.com",
      ),
    );
  });

  it("verifies RS256 JWKS signatures and strictly checks iss, aud, azp, nonce, exp, and nbf", () => {
    const key = makeRsaTestKey("k1");
    const otherKey = makeRsaTestKey("k1");
    const issuer = "https://llm-api.sci-it.com/keycloak/realms/sci-it";
    const nowSec = Math.floor(Date.now() / 1000);
    const validPayload = {
      iss: issuer,
      aud: COMPANY_CLIENT_ID,
      azp: COMPANY_CLIENT_ID,
      sub: "user-sub-1",
      nonce: "nonce-xyz",
      exp: nowSec + 300,
      iat: nowSec,
      nbf: nowSec - 1,
      given_name: "明",
      family_name: "李",
    };
    const jwt = signTestJwt({ alg: "RS256", typ: "JWT", kid: "k1" }, validPayload, key.privateKey);

    const claims = verifyOidcIdToken(jwt, { keys: [key.jwk] }, {
      issuer,
      audience: COMPANY_CLIENT_ID,
      nonce: "nonce-xyz",
      nowMs: nowSec * 1000,
    });
    assert.equal(claims.sub, "user-sub-1");
    assert.equal(claims.name, "李明");

    // Wrong signature key
    assert.throws(() =>
      verifyOidcIdToken(jwt, { keys: [otherKey.jwk] }, {
        issuer,
        audience: COMPANY_CLIENT_ID,
        nonce: "nonce-xyz",
        nowMs: nowSec * 1000,
      }),
    );
    // Wrong nonce
    assert.throws(() =>
      verifyOidcIdToken(jwt, { keys: [key.jwk] }, {
        issuer,
        audience: COMPANY_CLIENT_ID,
        nonce: "wrong-nonce",
        nowMs: nowSec * 1000,
      }),
    );
    // Expired
    assert.throws(() =>
      verifyOidcIdToken(jwt, { keys: [key.jwk] }, {
        issuer,
        audience: COMPANY_CLIENT_ID,
        nonce: "nonce-xyz",
        nowMs: (nowSec + 600) * 1000,
      }),
    );
    // Future nbf
    const futureNbf = signTestJwt(
      { alg: "RS256", kid: "k1" },
      { ...validPayload, nbf: nowSec + 60 },
      key.privateKey,
    );
    assert.throws(() =>
      verifyOidcIdToken(futureNbf, { keys: [key.jwk] }, {
        issuer,
        audience: COMPANY_CLIENT_ID,
        nonce: "nonce-xyz",
        nowMs: nowSec * 1000,
      }),
    );
    // Multi-aud without matching azp rejected
    const multiAudBadAzp = signTestJwt(
      { alg: "RS256", kid: "k1" },
      { ...validPayload, aud: [COMPANY_CLIENT_ID, "other-client"], azp: "other-client" },
      key.privateKey,
    );
    assert.throws(() =>
      verifyOidcIdToken(multiAudBadAzp, { keys: [key.jwk] }, {
        issuer,
        audience: COMPANY_CLIENT_ID,
        nonce: "nonce-xyz",
        nowMs: nowSec * 1000,
      }),
    );
    // alg: none rejected
    const algNone = signTestJwt({ alg: "none", kid: "k1" }, validPayload, key.privateKey);
    assert.throws(() =>
      verifyOidcIdToken(algNone, { keys: [key.jwk] }, {
        issuer,
        audience: COMPANY_CLIENT_ID,
        nonce: "nonce-xyz",
        nowMs: nowSec * 1000,
      }),
    );
  });

  it("completes full WeCom PKCE login, validates callback security headers, syncs models, and revokes on logout", async () => {
    const rsa = makeRsaTestKey("company-key-1");
    const callbackPort = await getFreeLoopbackPort();
    const redirectUri = `http://localhost:${callbackPort}/callback`;
    let revokedToken = "";
    let issuedNonce = "";

    const stubServer = createServer(async (req, res) => {
      const chunks: Buffer[] = [];
      for await (const c of req) chunks.push(Buffer.isBuffer(c) ? c : Buffer.from(c));
      const bodyStr = Buffer.concat(chunks).toString("utf8");

      if (req.url === "/keycloak/realms/sci-it/protocol/openid-connect/token") {
        const params = new URLSearchParams(bodyStr);
        assert.equal(params.get("grant_type"), "authorization_code");
        assert.equal(params.get("client_id"), COMPANY_CLIENT_ID);
        assert.equal(params.get("code"), "wecom-auth-code-123");
        assert.ok((params.get("code_verifier") ?? "").length >= 32);

        const nowSec = Math.floor(Date.now() / 1000);
        const idToken = signTestJwt(
          { alg: "RS256", kid: "company-key-1" },
          {
            iss: `${stubBase}/keycloak/realms/sci-it`,
            aud: COMPANY_CLIENT_ID,
            azp: COMPANY_CLIENT_ID,
            sub: "wecom-sub-42",
            nonce: issuedNonce,
            exp: nowSec + 300,
            iat: nowSec,
            given_name: "瞳",
            family_name: "小",
          },
          rsa.privateKey,
        );
        res.writeHead(200, { "Content-Type": "application/json" });
        res.end(
          JSON.stringify({
            access_token: "kc-access-token-abc",
            id_token: idToken,
            refresh_token: "kc-refresh-token-xyz",
          }),
        );
        return;
      }

      if (req.url === "/keycloak/realms/sci-it/protocol/openid-connect/certs") {
        res.writeHead(200, { "Content-Type": "application/json" });
        res.end(JSON.stringify({ keys: [rsa.jwk] }));
        return;
      }

      if (req.url === "/api/oauth/exchange/keycloak") {
        assert.equal(req.headers.authorization, "Bearer kc-access-token-abc");
        res.writeHead(200, { "Content-Type": "application/json" });
        res.end(
          JSON.stringify({
            success: true,
            data: {
              api_key: "sk-company-personal-secret-999",
              user_id: 108,
              username: "xiaotong",
            },
          }),
        );
        return;
      }

      if (req.url === "/v1/models") {
        assert.equal(req.headers.authorization, "Bearer sk-company-personal-secret-999");
        res.writeHead(200, { "Content-Type": "application/json" });
        res.end(
          JSON.stringify({
            data: [
              { id: "qwen3.5" },
              { id: "bge-m3" },
              { id: "deepseek-v4-flash-0731" },
            ],
          }),
        );
        return;
      }

      if (req.url === "/keycloak/realms/sci-it/protocol/openid-connect/revoke") {
        const params = new URLSearchParams(bodyStr);
        revokedToken = params.get("token") ?? "";
        res.writeHead(200);
        res.end();
        return;
      }

      res.writeHead(404);
      res.end();
    });
    stubServer.listen(0, "127.0.0.1");
    await once(stubServer, "listening");
    const addr = stubServer.address();
    assert.ok(addr && typeof addr !== "string");
    const stubBase = `http://127.0.0.1:${addr.port}`;

    try {
      const secretStore = memorySecrets();
      let syncedModels: readonly { id: string; enabled: boolean }[] = [];
      let loggedOutCalled = false;

      const auth = new CompanyAuthService({
        secretStore,
        fence: new ChannelCredentialFence(),
        issuer: `${stubBase}/keycloak/realms/sci-it`,
        apiBase: stubBase,
        redirectUri,
        validateUrl: (url, expectedOrigin) => {
          assert.equal(url.origin, new URL(expectedOrigin).origin);
        },
        onModelsSynced: (models) => {
          syncedModels = models;
        },
        onLoggedOut: () => {
          loggedOutCalled = true;
        },
      });

      const { authUrl } = await auth.startLogin();
      const parsedAuth = new URL(authUrl);
      assert.equal(parsedAuth.searchParams.get("kc_idp_hint"), "wecom-web");
      assert.equal(parsedAuth.searchParams.get("prompt"), "login");
      assert.equal(parsedAuth.searchParams.get("code_challenge_method"), "S256");
      const state = parsedAuth.searchParams.get("state")!;
      issuedNonce = parsedAuth.searchParams.get("nonce")!;

      // Invalid state callback must be rejected with 400 and NOT consume the login!
      const badCb = await fetch(`http://localhost:${callbackPort}/callback?state=wrong&code=abc`);
      assert.equal(badCb.status, 400);
      assert.equal(badCb.headers.get("cache-control"), "no-store");
      assert.equal(badCb.headers.get("referrer-policy"), "no-referrer");

      // Valid callback returns security headers + history.replaceState scrubber
      const goodCb = await fetch(
        `http://localhost:${callbackPort}/callback?state=${encodeURIComponent(state)}&code=wecom-auth-code-123`,
      );
      assert.equal(goodCb.status, 200);
      assert.equal(goodCb.headers.get("cache-control"), "no-store");
      assert.equal(goodCb.headers.get("referrer-policy"), "no-referrer");
      assert.match(goodCb.headers.get("content-security-policy") ?? "", /script-src 'nonce-/);
      const html = await goodCb.text();
      assert.match(html, /history\.replaceState\(null,'','\/complete'\)/);

      const finalState = await auth.waitForActiveOperation();
      assert.equal(finalState.phase, "signed-in");
      assert.equal(finalState.member?.name, "小瞳");
      assert.equal(finalState.member?.username, "xiaotong");
      // Secret MUST NOT appear in redacted state!
      assert.ok(!JSON.stringify(finalState).includes("sk-company-personal-secret-999"));
      assert.ok(!JSON.stringify(finalState).includes("kc-refresh-token-xyz"));

      // Stored in SecretStore & models synced with deepseek-flash prioritized and bge-m3 filtered!
      const storedRaw = await secretStore.get(COMPANY_SECRET_REF);
      assert.ok(storedRaw && storedRaw.includes("sk-company-personal-secret-999"));
      assert.deepEqual(
        syncedModels.map((m) => m.id),
        ["deepseek-flash", "qwen3.5"],
      );

      // Logout deletes from SecretStore FIRST, clears in-memory key, and calls OIDC revoke!
      const afterLogout = await auth.logout();
      assert.equal(afterLogout.phase, "signed-out");
      assert.equal(afterLogout.member, undefined);
      assert.equal(auth.getApiKeyInternal(), undefined);
      assert.equal(await secretStore.get(COMPANY_SECRET_REF), undefined);
      assert.equal(loggedOutCalled, true);
      assert.equal(revokedToken, "kc-refresh-token-xyz");
    } finally {
      stubServer.close();
      stubServer.closeAllConnections();
    }
  });

  it("reports actionable Chinese error on callback port conflict (EADDRINUSE) and preserves state when SecretStore.delete fails on logout", async () => {
    const busyPort = await getFreeLoopbackPort();
    const blocker = createServer((_req, res) => res.end("busy"));
    blocker.listen(busyPort, "127.0.0.1");
    await once(blocker, "listening");

    try {
      const baseStore = memorySecrets();
      let failDelete = false;
      const guardedStore: SecretStore = {
        get: (ref) => baseStore.get(ref),
        read: (ref) => baseStore.read!(ref),
        set: (ref, val) => baseStore.set(ref, val),
        delete: async (ref) => {
          if (failDelete) {
            throw new SecretStoreUnavailableError("SECRET_ACCESS_DENIED", "Keychain denied delete");
          }
          await baseStore.delete(ref);
        },
      };

      const auth = new CompanyAuthService({
        secretStore: guardedStore,
        redirectUri: `http://localhost:${busyPort}/callback`,
      });

      await assert.rejects(
        () => auth.startLogin(),
        new RegExp(`登录回调端口 ${busyPort} 已被占用`),
      );
      assert.equal(auth.getState().phase, "signed-out");

      // Seed valid credentials -> initialize -> fail delete on logout -> MUST KEEP logged-in state!
      await baseStore.set(
        COMPANY_SECRET_REF,
        JSON.stringify({
          apiKey: "sk-keep-me-on-delete-failure",
          refreshToken: "rt-1",
          member: { subject: "s1", name: "测试员", userId: 7, username: "tester" },
        }),
      );
      const restored = await auth.initialize();
      assert.equal(restored.phase, "signed-in");
      assert.equal(restored.member?.name, "测试员");

      failDelete = true;
      await assert.rejects(() => auth.logout(), /已保留当前登录状态/);
      assert.equal(auth.getState().phase, "signed-in");
      assert.equal(auth.getState().member?.name, "测试员");
      assert.equal(auth.getApiKeyInternal(), "sk-keep-me-on-delete-failure");
    } finally {
      blocker.close();
      blocker.closeAllConnections();
    }
  });

  it("discards late syncModels() completion when logout() races while /v1/models is in flight (#4)", async () => {
    const store = memorySecrets();
    await store.set(
      COMPANY_SECRET_REF,
      JSON.stringify({
        apiKey: "sk-race-company-key-1234",
        refreshToken: "rt-race-1",
        member: { subject: "s-race", name: "竞态测试", userId: 9, username: "racer" },
      }),
    );

    let fetchEntered!: () => void;
    const fetchEnteredPromise = new Promise<void>((resolve) => {
      fetchEntered = resolve;
    });
    let releaseFetch!: () => void;
    const fetchGate = new Promise<void>((resolve) => {
      releaseFetch = resolve;
    });

    let onModelsSyncedCalls = 0;
    const auth = new CompanyAuthService({
      secretStore: store,
      issuer: "https://llm-api.sci-it.com/keycloak/realms/sci-it",
      apiBase: "https://llm-api.sci-it.com",
      fetchImpl: async (input) => {
        const url = String(input);
        if (url.endsWith("/v1/models")) {
          fetchEntered();
          await fetchGate;
          // Intentionally ignore signal to simulate a late response arriving right after logout!
          return new Response(JSON.stringify({ data: [{ id: "deepseek-flash" }] }), {
            status: 200,
            headers: { "Content-Type": "application/json" },
          });
        }
        return new Response(null, { status: 200 });
      },
      onModelsSynced: () => {
        onModelsSyncedCalls += 1;
      },
    });

    await auth.initialize();
    assert.equal(auth.getState().phase, "signed-in");

    // Kick off syncModels() and wait until /v1/models is in flight
    const syncPromise = auth.syncModels(true);
    await fetchEnteredPromise;

    // Logout races while syncModels() is still awaiting /v1/models
    const loggedOut = await auth.logout();
    assert.equal(loggedOut.phase, "signed-out");

    // Release the late /v1/models response -> MUST be discarded; MUST NOT revive signed-in or invoke onModelsSynced!
    releaseFetch();
    const syncResult = await syncPromise;
    assert.equal(syncResult.state.phase, "signed-out");
    assert.equal(syncResult.models.length, 0);
    assert.equal(auth.getState().phase, "signed-out");
    assert.equal(onModelsSyncedCalls, 0);
  });
});
