import assert from "node:assert/strict";
import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, it } from "node:test";
import * as secretsMod from "../src/platform/secrets.ts";
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
  SecretStoreUnavailableError,
  windowsSecrets,
} from "../src/platform/secrets.ts";

describe("hardened fail-closed OS secret store (ADR-011 L4 & ADR-012 §3.1)", () => {
  it("does NOT export any plaintext fileSecrets fallback", () => {
    assert.equal("fileSecrets" in secretsMod, false);
  });

  it("supports independent service namespaces for im-bridge and model-channels", async () => {
    const db = new Map<string, string>();
    const runner: CommandRunner = async (_file, args, stdin) => {
      if (args[0] === "find-generic-password") {
        const svc = args[args.indexOf("-s") + 1]!;
        const account = args[args.indexOf("-a") + 1]!;
        const val = db.get(`${svc}::${account}`);
        return val === undefined ? { code: 44, stdout: "" } : { code: 0, stdout: `${val}\n` };
      }
      if (args[0] === "-i") {
        for (const line of stdin.split("\n").filter(Boolean)) {
          const add = /^add-generic-password -s "([^"]+)" -a "([^"]+)" -U -w "([^"]+)"$/.exec(line);
          if (add) {
            db.set(`${add[1]!}::${add[2]!}`, add[3]!);
            continue;
          }
          const del = /^delete-generic-password -s "([^"]+)" -a "([^"]+)"$/.exec(line);
          if (del) db.delete(`${del[1]!}::${del[2]!}`);
        }
        return { code: 0, stdout: "" };
      }
      return { code: 1, stdout: "" };
    };

    const imStore = createSecretStore({
      namespace: IM_BRIDGE_SECRET_NAMESPACE,
      platform: "darwin",
      run: runner,
    });
    const modelStore = createSecretStore({
      namespace: MODEL_CHANNELS_SECRET_NAMESPACE,
      platform: "darwin",
      run: runner,
    });

    await imStore.set("shared-ref", "im-secret");
    await modelStore.set("shared-ref", "model-secret");
    assert.equal(await imStore.get("shared-ref"), "im-secret");
    assert.equal(await modelStore.get("shared-ref"), "model-secret");

    await imStore.delete("shared-ref");
    assert.equal(await imStore.get("shared-ref"), undefined);
    assert.equal(await modelStore.get("shared-ref"), "model-secret");
  });

  it("macOS Keychain stores short and chunked (>3000 b64) secrets via stdin and verifies read-back & delete", async () => {
    const db = new Map<string, string>();
    const runner: CommandRunner = async (_file, args, stdin) => {
      if (args[0] === "find-generic-password") {
        const account = args[args.indexOf("-a") + 1]!;
        const val = db.get(account);
        return val === undefined ? { code: 44, stdout: "" } : { code: 0, stdout: `${val}\n` };
      }
      if (args[0] === "-i") {
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
    await store.set("bot-short", '{"token":"secret-1"}');
    assert.equal(await store.get("bot-short"), '{"token":"secret-1"}');
    assert.ok(db.get("bot-short")?.startsWith("b64:"));

    const large = JSON.stringify({ token: "Z".repeat(5000) });
    await store.set("bot-large", large);
    assert.equal(await store.get("bot-large"), large);
    assert.match(db.get("bot-large") ?? "", /^parts:\d+$/);

    await store.delete("bot-large");
    assert.equal(await store.get("bot-large"), undefined);
    assert.equal(db.size, 1);
  });

  it("macOS Keychain distinguishes missing (44) vs unavailable (127 / non-zero) vs denied (128/36/51)", async () => {
    const missingStore = keychainSecrets(async () => ({ code: 44, stdout: "", stderr: "The specified item could not be found in the keychain." }));
    assert.deepEqual(await missingStore.read?.("absent"), { status: "missing" });
    assert.equal(await missingStore.get("absent"), undefined);

    const unavailableTool = keychainSecrets(async () => ({ code: 127, stdout: "", stderr: "ENOENT" }));
    const unavailRes = await unavailableTool.read?.("k");
    assert.equal(unavailRes?.status, "unavailable");
    await assert.rejects(
      () => unavailableTool.get("k"),
      (err: unknown) => err instanceof SecretStoreUnavailableError && err.code === "SECRET_STORE_UNAVAILABLE",
    );

    // Arbitrary non-zero exit code MUST NOT collapse into missing / undefined!
    const arbitraryErr = keychainSecrets(async () => ({ code: 50, stdout: "", stderr: "One or more parameters passed to a function were not valid." }));
    assert.equal((await arbitraryErr.read?.("k"))?.status, "unavailable");
    await assert.rejects(
      () => arbitraryErr.get("k"),
      (err: unknown) => err instanceof SecretStoreUnavailableError && err.code === "SECRET_STORE_UNAVAILABLE",
    );

    // Denied (user canceled = 128 or locked = 36)
    const deniedStore = keychainSecrets(async () => ({ code: 128, stdout: "", stderr: "User canceled the operation." }));
    const deniedRes = await deniedStore.read?.("k");
    assert.equal(deniedRes?.status, "denied");
    await assert.rejects(
      () => deniedStore.get("k"),
      (err: unknown) => err instanceof SecretStoreUnavailableError && err.code === "SECRET_ACCESS_DENIED",
    );

    const lockedStore = keychainSecrets(async () => ({ code: 36, stdout: "", stderr: "User interaction is not allowed." }));
    assert.equal((await lockedStore.read?.("k"))?.status, "denied");
    await assert.rejects(
      () => lockedStore.get("k"),
      (err: unknown) => err instanceof SecretStoreUnavailableError && err.code === "SECRET_ACCESS_DENIED",
    );
  });

  it("macOS Keychain rejects failed delete (non-zero exit OR item still readable on read-back)", async () => {
    const db = new Map<string, string>([["ref-1", `b64:${Buffer.from("top-secret").toString("base64")}`]]);

    // Case 1: security -i returns non-zero exit code on delete
    const failingDeleteRunner: CommandRunner = async (_f, args) => {
      if (args[0] === "find-generic-password") {
        const account = args[args.indexOf("-a") + 1]!;
        const val = db.get(account);
        return val === undefined ? { code: 44, stdout: "" } : { code: 0, stdout: `${val}\n` };
      }
      return { code: 1, stdout: "", stderr: "security: SecKeychainItemDelete: error" };
    };
    const s1 = keychainSecrets(failingDeleteRunner);
    await assert.rejects(
      () => s1.delete("ref-1"),
      (err: unknown) => err instanceof SecretStoreUnavailableError && err.code === "SECRET_DELETE_VERIFY_FAILED",
    );

    // Case 2: security -i returns exit code 0 silently WITHOUT actually deleting item -> read-back catches it!
    const silentNoOpDeleteRunner: CommandRunner = async (_f, args) => {
      if (args[0] === "find-generic-password") {
        const account = args[args.indexOf("-a") + 1]!;
        const val = db.get(account);
        return val === undefined ? { code: 44, stdout: "" } : { code: 0, stdout: `${val}\n` };
      }
      return { code: 0, stdout: "" };
    };
    const s2 = keychainSecrets(silentNoOpDeleteRunner);
    await assert.rejects(
      () => s2.delete("ref-1"),
      (err: unknown) => err instanceof SecretStoreUnavailableError && err.code === "SECRET_DELETE_VERIFY_FAILED",
    );

    // Case 3: denied during delete
    const deniedDeleteRunner: CommandRunner = async (_f, args) => {
      if (args[0] === "find-generic-password") {
        return { code: 0, stdout: `${db.get("ref-1")!}\n` };
      }
      return { code: 128, stdout: "", stderr: "User canceled" };
    };
    const s3 = keychainSecrets(deniedDeleteRunner);
    await assert.rejects(
      () => s3.delete("ref-1"),
      (err: unknown) => err instanceof SecretStoreUnavailableError && err.code === "SECRET_ACCESS_DENIED",
    );
  });

  it("macOS Keychain fails closed when /usr/bin/security is missing or read-back verification fails", async () => {
    const missing: CommandRunner = async () => ({ code: 127, stdout: "" });
    const s1 = keychainSecrets(missing);
    await assert.rejects(
      () => s1.set("ref1", "secret"),
      (err: unknown) => err instanceof SecretStoreUnavailableError && err.code === "SECRET_STORE_UNAVAILABLE",
    );

    const silentDrop: CommandRunner = async (_f, args) => {
      if (args[0] === "-i") return { code: 0, stdout: "" };
      return { code: 44, stdout: "" };
    };
    const s2 = keychainSecrets(silentDrop);
    await assert.rejects(
      () => s2.set("ref1", "secret"),
      (err: unknown) => err instanceof SecretStoreUnavailableError && err.code === "SECRET_WRITE_VERIFY_FAILED",
    );
  });

  it("Linux secret-tool distinguishes missing vs unavailable vs denied and verifies delete", async () => {
    const unavailable: CommandRunner = async () => ({ code: 127, stdout: "" });
    const storeUnavail = linuxSecrets(unavailable);
    await assert.rejects(
      () => storeUnavail.set("feishu-1", '{"appSecret":"top-secret"}'),
      (err: unknown) => err instanceof SecretStoreUnavailableError && err.code === "SECRET_STORE_UNAVAILABLE",
    );
    await assert.rejects(
      () => storeUnavail.get("feishu-1"),
      (err: unknown) => err instanceof SecretStoreUnavailableError && err.code === "SECRET_STORE_UNAVAILABLE",
    );

    // Denied when user dismisses keyring unlock prompt
    const deniedRunner: CommandRunner = async () => ({
      code: 1,
      stdout: "",
      stderr: "secret-tool: Cannot unlock keyring: permission denied by user",
    });
    const storeDenied = linuxSecrets(deniedRunner);
    assert.equal((await storeDenied.read?.("k"))?.status, "denied");
    await assert.rejects(
      () => storeDenied.get("k"),
      (err: unknown) => err instanceof SecretStoreUnavailableError && err.code === "SECRET_ACCESS_DENIED",
    );

    // Healthy keyring that later hits D-Bus error on lookup or fails delete
    const items = new Map<string, string>();
    let failLookupWithDbus = false;
    let failClearWithError = false;
    let silentClearNoOp = false;
    const runner: CommandRunner = async (_file, args, stdin) => {
      const op = args[0];
      const account = args[args.indexOf("account") + 1]!;
      if (op === "store") {
        items.set(account, stdin);
        return { code: 0, stdout: "" };
      }
      if (op === "lookup") {
        if (failLookupWithDbus && account !== "__xtwork_probe__") {
          return { code: 1, stdout: "", stderr: "org.freedesktop.DBus.Error.NoReply: daemon down" };
        }
        const val = items.get(account);
        return val === undefined ? { code: 1, stdout: "", stderr: "" } : { code: 0, stdout: val };
      }
      if (op === "clear") {
        if (failClearWithError && account !== "__xtwork_probe__") {
          return { code: 1, stdout: "", stderr: "secret-tool: clear failed" };
        }
        if (!silentClearNoOp || account === "__xtwork_probe__") {
          items.delete(account);
        }
        return { code: 0, stdout: "" };
      }
      return { code: 1, stdout: "" };
    };

    const store = linuxSecrets(runner);
    await store.set("wecom-1", '{"secret":"abc"}');
    assert.equal(await store.get("wecom-1"), '{"secret":"abc"}');
    assert.deepEqual(await store.read?.("never-set"), { status: "missing" });

    // Non-empty stderr on exit code 1 MUST be classified as unavailable, NOT missing!
    failLookupWithDbus = true;
    assert.equal((await store.read?.("wecom-1"))?.status, "unavailable");
    await assert.rejects(
      () => store.get("wecom-1"),
      (err: unknown) => err instanceof SecretStoreUnavailableError && err.code === "SECRET_STORE_UNAVAILABLE",
    );
    failLookupWithDbus = false;

    // Delete exit code failure throws SECRET_DELETE_VERIFY_FAILED
    failClearWithError = true;
    await assert.rejects(
      () => store.delete("wecom-1"),
      (err: unknown) => err instanceof SecretStoreUnavailableError && err.code === "SECRET_DELETE_VERIFY_FAILED",
    );
    failClearWithError = false;

    // Silent no-op delete (exit 0 but item remains) caught by read-back check!
    silentClearNoOp = true;
    await assert.rejects(
      () => store.delete("wecom-1"),
      (err: unknown) => err instanceof SecretStoreUnavailableError && err.code === "SECRET_DELETE_VERIFY_FAILED",
    );
    silentClearNoOp = false;

    // Clean verified delete succeeds
    await store.delete("wecom-1");
    assert.equal(await store.get("wecom-1"), undefined);
  });

  it("Windows DPAPI stores only sealed dpapi: blobs, verifies round-trip, refuses plaintext, and classifies denied", async () => {
    const dir = mkdtempSync(join(tmpdir(), "im-bridge-dpapi-"));
    const blobPath = join(dir, "dpapi.json");
    try {
      let denyNext = false;
      const mockDpapi: CommandRunner = async (_file, args, stdin) => {
        if (denyNext) {
          return { code: 1, stdout: "", stderr: "Access to the path is denied." };
        }
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
      await store.set("wechat-1", '{"token":"super-secret-token"}');
      assert.equal(existsSync(blobPath), true);
      const rawOnDisk = readFileSync(blobPath, "utf8");
      assert.equal(rawOnDisk.includes("super-secret-token"), false);
      assert.ok(rawOnDisk.includes("dpapi:"));

      // Fresh instance decrypts cleanly
      const store2 = windowsSecrets(blobPath, mockDpapi);
      assert.equal(await store2.get("wechat-1"), '{"token":"super-secret-token"}');

      // Denied DPAPI error is classified as denied
      denyNext = true;
      const storeDenied = windowsSecrets(blobPath, mockDpapi);
      assert.equal((await storeDenied.read?.("wechat-1"))?.status, "denied");
      await assert.rejects(
        () => storeDenied.get("wechat-1"),
        (err: unknown) => err instanceof SecretStoreUnavailableError && err.code === "SECRET_ACCESS_DENIED",
      );
      denyNext = false;

      // Verified delete removes from disk
      await store2.delete("wechat-1");
      assert.equal(await windowsSecrets(blobPath, mockDpapi).get("wechat-1"), undefined);

      // Plaintext tampered file MUST be refused
      writeFileSync(blobPath, JSON.stringify({ "wechat-1": '{"token":"plain"}' }));
      const store3 = windowsSecrets(blobPath, mockDpapi);
      await assert.rejects(
        () => store3.get("wechat-1"),
        (err: unknown) => err instanceof SecretStoreUnavailableError && err.code === "SECRET_DECRYPT_FAILED",
      );
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it("ChannelCredentialFence prevents stale in-flight OAuth refresh write-back from resurrecting deleted credentials", async () => {
    const store = memorySecrets();
    const fence = new ChannelCredentialFence();
    const channelId = "codex-sub";
    const secretRef = `oauth:${channelId}`;
    await store.set(secretRef, JSON.stringify({ access: "old-token", refresh: "old-refresh" }));

    // 1. In-flight refresh acquires lease at generation 0
    const lease = fence.acquire(channelId);
    assert.equal(lease.generation, 0);
    assert.equal(lease.signal.aborted, false);

    // 2. Concurrent logout invalidates & deletes while refresh is mid-flight
    const nextGen = await fence.deleteAndInvalidate(store, channelId, secretRef, "user logged out");
    assert.equal(nextGen, 1);
    assert.equal(lease.signal.aborted, true);
    assert.equal(lease.isCurrent(), false);
    assert.equal(await store.get(secretRef), undefined);

    // 3. Stale refresh tries to write back anyway -> MUST reject with SECRET_FENCE_STALE and NOT resurrect credential!
    await assert.rejects(
      () =>
        fence.writeIfCurrent(
          store,
          channelId,
          secretRef,
          JSON.stringify({ access: "stale-refreshed", refresh: "stale-r" }),
          lease.generation,
        ),
      (err: unknown) => err instanceof SecretStoreUnavailableError && err.code === "SECRET_FENCE_STALE",
    );
    assert.equal(await store.get(secretRef), undefined);
    lease.release();

    // 4. Race while store.set itself is in flight: deleteAndInvalidate serializes after set and removes it!
    await store.set(secretRef, "initial");
    const slowBase = memorySecrets();
    let releaseSlowSet!: () => void;
    let enteredSlowSet!: () => void;
    const enteredPromise = new Promise<void>((r) => {
      enteredSlowSet = r;
    });
    const slowStore: typeof store = {
      get: (ref) => slowBase.get(ref),
      async set(ref, value) {
        enteredSlowSet();
        await new Promise<void>((r) => {
          releaseSlowSet = r;
        });
        await slowBase.set(ref, value);
      },
      delete: (ref) => slowBase.delete(ref),
    };
    const genBefore = fence.generation(channelId);
    const writePromise = fence.writeIfCurrent(slowStore, channelId, secretRef, "late-write", genBefore);
    await enteredPromise;
    const deletePromise = fence.deleteAndInvalidate(slowStore, channelId, secretRef, "logout mid-set");
    releaseSlowSet();
    await assert.rejects(
      () => writePromise,
      (err: unknown) => err instanceof SecretStoreUnavailableError && err.code === "SECRET_FENCE_STALE",
    );
    await deletePromise;
    assert.equal(await slowStore.get(secretRef), undefined);
  });

  it("defaultSecrets fails closed on unsupported platforms and memorySecrets works for tests", async () => {
    assert.throws(
      () => defaultSecrets(undefined, "freebsd"),
      (err: unknown) => err instanceof SecretStoreUnavailableError && err.code === "SECRET_STORE_UNAVAILABLE",
    );
    const mem = memorySecrets();
    await mem.set("k", "v");
    assert.equal(await mem.get("k"), "v");
    await mem.delete("k");
    assert.equal(await mem.get("k"), undefined);
  });
});
