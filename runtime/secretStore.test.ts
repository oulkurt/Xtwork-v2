import assert from "node:assert/strict";
import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, it } from "node:test";
import * as secretStoreMod from "./secretStore.ts";
import {
  ChannelCredentialFence,
  type CommandRunner,
  createSecretStore,
  defaultSecrets,
  IM_BRIDGE_SECRET_NAMESPACE,
  keychainSecrets,
  linuxSecrets,
  memorySecrets,
  MODEL_CHANNELS_SECRET_NAMESPACE,
  SecretStoreError,
  SecretStoreUnavailableError,
  windowsSecrets,
} from "./secretStore.ts";

describe("runtime/secretStore hardened shared OS SecretStore (ADR-012 §3.1)", () => {
  it("exposes zero plaintext fallback and defaults to app.xtwork.model-channels namespace", async () => {
    assert.equal("fileSecrets" in secretStoreMod, false);
    assert.strictEqual(SecretStoreError, SecretStoreUnavailableError);

    let capturedService = "";
    const runner: CommandRunner = async (_file, args) => {
      capturedService = args[args.indexOf("-s") + 1] ?? "";
      return { code: 44, stdout: "" };
    };
    const defaultStore = keychainSecrets(runner);
    assert.equal(await defaultStore.get("channel-key"), undefined);
    assert.equal(capturedService, MODEL_CHANNELS_SECRET_NAMESPACE);

    const imStore = createSecretStore({
      namespace: IM_BRIDGE_SECRET_NAMESPACE,
      platform: "darwin",
      run: runner,
    });
    assert.equal(await imStore.get("bot-key"), undefined);
    assert.equal(capturedService, IM_BRIDGE_SECRET_NAMESPACE);
  });

  it("macOS Keychain distinguishes missing vs unavailable vs denied and rejects failed/unverified deletes", async () => {
    const db = new Map<string, string>();
    let failDeleteCode = 0;
    let silentDropDelete = false;
    const runner: CommandRunner = async (_file, args, stdin) => {
      if (args[0] === "find-generic-password") {
        const account = args[args.indexOf("-a") + 1]!;
        if (account === "denied-entry") {
          return { code: 128, stdout: "", stderr: "User canceled the operation." };
        }
        if (account === "broken-entry") {
          return { code: 50, stdout: "", stderr: "errSecParam" };
        }
        const val = db.get(account);
        return val === undefined ? { code: 44, stdout: "" } : { code: 0, stdout: `${val}\n` };
      }
      if (args[0] === "-i") {
        if (stdin.includes("delete-generic-password")) {
          if (failDeleteCode !== 0) {
            return { code: failDeleteCode, stdout: "", stderr: "delete failed" };
          }
          if (silentDropDelete) {
            return { code: 0, stdout: "" };
          }
        }
        for (const line of stdin.split("\n").filter(Boolean)) {
          const add = /^add-generic-password -s "[^"]+" -a "([^"]+)" -U -w "([^"]+)"$/.exec(line);
          if (add) {
            db.set(add[1]!, add[2]!);
            continue;
          }
          const del = /^delete-generic-password -s "[^"]+" -a "([^"]+)"$/.exec(line);
          if (del) db.delete(del[1]!);
        }
        return { code: 0, stdout: "" };
      }
      return { code: 1, stdout: "" };
    };

    const store = keychainSecrets(runner);
    assert.deepEqual(await store.read?.("no-such-key"), { status: "missing" });
    assert.equal(await store.get("no-such-key"), undefined);

    assert.equal((await store.read?.("denied-entry"))?.status, "denied");
    await assert.rejects(
      () => store.get("denied-entry"),
      (err: unknown) => err instanceof SecretStoreUnavailableError && err.code === "SECRET_ACCESS_DENIED",
    );

    assert.equal((await store.read?.("broken-entry"))?.status, "unavailable");
    await assert.rejects(
      () => store.get("broken-entry"),
      (err: unknown) => err instanceof SecretStoreUnavailableError && err.code === "SECRET_STORE_UNAVAILABLE",
    );

    await store.set("team-key", "sk-company-secret-value");
    assert.equal(await store.get("team-key"), "sk-company-secret-value");

    // Non-zero delete exit code MUST reject (never declare logout succeeded!)
    failDeleteCode = 1;
    await assert.rejects(
      () => store.delete("team-key"),
      (err: unknown) => err instanceof SecretStoreUnavailableError && err.code === "SECRET_DELETE_VERIFY_FAILED",
    );
    failDeleteCode = 0;

    // Silent delete returning 0 without removing item MUST reject on read-back!
    silentDropDelete = true;
    await assert.rejects(
      () => store.delete("team-key"),
      (err: unknown) => err instanceof SecretStoreUnavailableError && err.code === "SECRET_DELETE_VERIFY_FAILED",
    );
    silentDropDelete = false;

    // Verified delete succeeds and confirms missing
    await store.delete("team-key");
    assert.deepEqual(await store.read?.("team-key"), { status: "missing" });
  });

  it("Linux secret-tool distinguishes missing vs unavailable vs denied and verifies delete", async () => {
    const items = new Map<string, string>();
    let lookupMode: "normal" | "dbus-error" | "denied" = "normal";
    let clearMode: "normal" | "fail-exit" | "silent-noop" = "normal";

    const runner: CommandRunner = async (_file, args, stdin) => {
      const op = args[0];
      const account = args[args.indexOf("account") + 1]!;
      if (op === "store") {
        items.set(account, stdin);
        return { code: 0, stdout: "" };
      }
      if (op === "lookup") {
        if (account !== "__xtwork_probe__") {
          if (lookupMode === "dbus-error") {
            return { code: 1, stdout: "", stderr: "Cannot autolaunch D-Bus without X11 $DISPLAY" };
          }
          if (lookupMode === "denied") {
            return { code: 1, stdout: "", stderr: "Keyring is locked and unlock was cancelled" };
          }
        }
        const val = items.get(account);
        return val === undefined ? { code: 1, stdout: "", stderr: "" } : { code: 0, stdout: val };
      }
      if (op === "clear") {
        if (account !== "__xtwork_probe__") {
          if (clearMode === "fail-exit") return { code: 1, stdout: "", stderr: "clear failed" };
          if (clearMode === "silent-noop") return { code: 0, stdout: "" };
        }
        items.delete(account);
        return { code: 0, stdout: "" };
      }
      return { code: 1, stdout: "" };
    };

    const store = linuxSecrets(runner);
    await store.set("anthropic-1", "sk-ant-real");
    assert.equal(await store.get("anthropic-1"), "sk-ant-real");
    assert.deepEqual(await store.read?.("absent"), { status: "missing" });

    lookupMode = "dbus-error";
    assert.equal((await store.read?.("anthropic-1"))?.status, "unavailable");
    lookupMode = "denied";
    assert.equal((await store.read?.("anthropic-1"))?.status, "denied");
    lookupMode = "normal";

    clearMode = "fail-exit";
    await assert.rejects(
      () => store.delete("anthropic-1"),
      (err: unknown) => err instanceof SecretStoreUnavailableError && err.code === "SECRET_DELETE_VERIFY_FAILED",
    );
    clearMode = "silent-noop";
    await assert.rejects(
      () => store.delete("anthropic-1"),
      (err: unknown) => err instanceof SecretStoreUnavailableError && err.code === "SECRET_DELETE_VERIFY_FAILED",
    );
    clearMode = "normal";

    await store.delete("anthropic-1");
    assert.equal(await store.get("anthropic-1"), undefined);
  });

  it("Windows DPAPI enforces sealed blobs, read-back verification, and delete confirmation", async () => {
    const dir = mkdtempSync(join(tmpdir(), "xtwork-dpapi-"));
    const blobPath = join(dir, "channels-dpapi.json");
    try {
      const mockDpapi: CommandRunner = async (_file, args, stdin) => {
        const cmd = args.join(" ");
        if (cmd.includes("::Protect(")) {
          return { code: 0, stdout: Buffer.from(`SEALED:${stdin}`, "utf8").toString("base64") };
        }
        if (cmd.includes("::Unprotect(")) {
          const decoded = Buffer.from(stdin, "base64").toString("utf8");
          if (!decoded.startsWith("SEALED:")) return { code: 1, stdout: "" };
          return { code: 0, stdout: decoded.slice("SEALED:".length) };
        }
        return { code: 1, stdout: "" };
      };
      const store = windowsSecrets(blobPath, mockDpapi);
      await store.set("openai-1", "sk-openai-real");
      assert.equal(existsSync(blobPath), true);
      assert.equal(readFileSync(blobPath, "utf8").includes("sk-openai-real"), false);
      assert.equal(await windowsSecrets(blobPath, mockDpapi).get("openai-1"), "sk-openai-real");
      await store.delete("openai-1");
      assert.equal(await windowsSecrets(blobPath, mockDpapi).get("openai-1"), undefined);

      writeFileSync(blobPath, JSON.stringify({ "openai-1": "sk-plaintext" }));
      await assert.rejects(
        () => windowsSecrets(blobPath, mockDpapi).get("openai-1"),
        (err: unknown) => err instanceof SecretStoreUnavailableError && err.code === "SECRET_DECRYPT_FAILED",
      );
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it("ChannelCredentialFence blocks concurrent refresh-vs-logout credential resurrection", async () => {
    const store = memorySecrets();
    const fence = new ChannelCredentialFence();
    const key = "xai-sub";
    const ref = "oauth:xai-sub";
    await store.set(ref, JSON.stringify({ access: "a1", refresh: "r1", expires: 100 }));

    const lease = fence.acquire(key);
    assert.equal(lease.generation, 0);

    // Logout bumps generation, aborts refresh lease signal, and deletes secret
    const genAfterLogout = await fence.deleteAndInvalidate(store, key, ref, "logout");
    assert.equal(genAfterLogout, 1);
    assert.equal(lease.signal.aborted, true);
    assert.equal(await store.get(ref), undefined);

    // Late OAuth refresh attempts to persist refreshed tokens using old generation -> rejected!
    await assert.rejects(
      () => fence.writeIfCurrent(store, key, ref, JSON.stringify({ access: "a2", refresh: "r2", expires: 9999 }), lease.generation),
      (err: unknown) => err instanceof SecretStoreUnavailableError && err.code === "SECRET_FENCE_STALE",
    );
    assert.equal(await store.get(ref), undefined);

    // Re-login at generation 1 succeeds cleanly
    const freshLease = fence.acquire(key);
    assert.equal(freshLease.generation, 1);
    await fence.writeIfCurrent(store, key, ref, JSON.stringify({ access: "a3", refresh: "r3", expires: 9999 }), freshLease.generation);
    assert.equal(await store.get(ref), JSON.stringify({ access: "a3", refresh: "r3", expires: 9999 }));
    lease.release();
    freshLease.release();

    // Unsupported platform fails closed
    assert.throws(
      () => defaultSecrets(undefined, "sunos"),
      (err: unknown) => err instanceof SecretStoreUnavailableError && err.code === "SECRET_STORE_UNAVAILABLE",
    );
  });
});
