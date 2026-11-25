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
      if (args[0] === "delete-generic-password") {
        const svc = args[args.indexOf("-s") + 1]!;
        const account = args[args.indexOf("-a") + 1]!;
        const existed = db.delete(`${svc}::${account}`);
        return existed ? { code: 0, stdout: "" } : { code: 44, stdout: "" };
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

  it("macOS Keychain stores short/chunked secrets via stdin and deletes & verifies EACH chunk individually BEFORE the root manifest", async () => {
    const db = new Map<string, string>();
    const deleteOrder: string[] = [];
    let failAccountOnce: string | null = null;

    const runner: CommandRunner = async (_file, args, stdin) => {
      if (args[0] === "find-generic-password") {
        const account = args[args.indexOf("-a") + 1]!;
        const val = db.get(account);
        return val === undefined ? { code: 44, stdout: "" } : { code: 0, stdout: `${val}\n` };
      }
      if (args[0] === "delete-generic-password") {
        const account = args[args.indexOf("-a") + 1]!;
        deleteOrder.push(account);
        if (failAccountOnce === account) {
          failAccountOnce = null;
          return { code: 1, stdout: "", stderr: "security: SecKeychainItemDelete failed" };
        }
        const existed = db.delete(account);
        return existed ? { code: 0, stdout: "" } : { code: 44, stdout: "" };
      }
      if (args[0] === "-i") {
        // Must NEVER pass delete commands in a batched `security -i` call where a later exit status masks an earlier failure!
        assert.equal(stdin.includes("delete-generic-password"), false);
        for (const line of stdin.split("\n").filter(Boolean)) {
          const add = /^add-generic-password -s "[^"]+" -a "([^"]+)" -U -w "([^"]+)"$/.exec(line);
          if (add) {
            db.set(add[1]!, add[2]!);
          }
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
    assert.match(db.get("bot-large") ?? "", /^parts:g1:3$/);

    // If chunk #2 fails to delete, root manifest MUST remain intact so retry can still clean up remaining chunks!
    failAccountOnce = "bot-large#g1#2";
    await assert.rejects(
      () => store.delete("bot-large"),
      (err: unknown) => err instanceof SecretStoreUnavailableError && err.code === "SECRET_DELETE_VERIFY_FAILED",
    );
    assert.equal(db.has("bot-large"), true, "Root manifest must NOT be deleted when a chunk delete fails");
    assert.equal(db.has("bot-large#g1#2"), true);
    assert.equal(db.has("bot-large#g1#3"), true);
    assert.deepEqual(deleteOrder, ["bot-large#g1#1", "bot-large#g1#2"]);

    // Retry succeeds: already-deleted #1 (44) verifies missing, #2 and #3 delete & verify, THEN root manifest deletes last!
    deleteOrder.length = 0;
    await store.delete("bot-large");
    assert.deepEqual(deleteOrder, ["bot-large#g1#1", "bot-large#g1#2", "bot-large#g1#3", "bot-large"]);
    assert.equal(await store.get("bot-large"), undefined);
    assert.equal(db.size, 1);

    // Shrinking write with failing old-chunk cleanup MUST retain `;prev:` in manifest so retry OR delete still removes orphaned chunks (#9)!
    await store.set("bot-shrink", JSON.stringify({ token: "A".repeat(5000) }));
    assert.match(db.get("bot-shrink") ?? "", /^parts:g1:3$/);
    failAccountOnce = "bot-shrink#g1#3";
    await assert.rejects(
      () => store.set("bot-shrink", '{"token":"tiny"}'),
      (err: unknown) => err instanceof SecretStoreUnavailableError && err.code === "SECRET_DELETE_VERIFY_FAILED",
    );
    // New value is already readable, AND manifest still points to `prev:g1:3` so orphaned #g1#3 is NOT lost!
    assert.equal(await store.get("bot-shrink"), '{"token":"tiny"}');
    assert.match(db.get("bot-shrink") ?? "", /^b64:[^;]+;prev:g1:3$/);
    assert.equal(db.has("bot-shrink#g1#3"), true);

    // Calling delete() cleans up the orphaned `prev:g1:3` chunk BEFORE deleting the root manifest!
    deleteOrder.length = 0;
    await store.delete("bot-shrink");
    assert.deepEqual(deleteOrder, ["bot-shrink#g1#1", "bot-shrink#g1#2", "bot-shrink#g1#3", "bot-shrink"]);
    assert.equal(db.has("bot-shrink#g1#3"), false);
    assert.equal(db.has("bot-shrink"), false);

    // Also verify retry of set() after failed chunked->smaller-chunked shrink cleans up old generation and strips `;prev:`!
    await store.set("bot-shrink-2", "B".repeat(5000));
    assert.match(db.get("bot-shrink-2") ?? "", /^parts:g1:3$/);
    failAccountOnce = "bot-shrink-2#g1#2";
    const medium = "C".repeat(3000); // 2 chunks
    await assert.rejects(
      () => store.set("bot-shrink-2", medium),
      (err: unknown) => err instanceof SecretStoreUnavailableError && err.code === "SECRET_DELETE_VERIFY_FAILED",
    );
    assert.match(db.get("bot-shrink-2") ?? "", /^parts:g2:2;prev:g1:3$/);
    assert.equal(await store.get("bot-shrink-2"), medium);
    // Retrying set() cleans up BOTH g1 and g2, writes g3, and strips `;prev:`!
    await store.set("bot-shrink-2", "short-final");
    assert.match(db.get("bot-shrink-2") ?? "", /^b64:[^;]+$/);
    assert.equal(db.has("bot-shrink-2#g1#2"), false);
    assert.equal(db.has("bot-shrink-2#g2#1"), false);
    assert.equal(await store.get("bot-shrink-2"), "short-final");

    // Failing chunk #2 write/verify MUST already have `pending:` recorded in manifest BEFORE any
    // chunk was written, so even if rollback delete fails, a subsequent delete() finds and removes chunk #1 (#9)!
    let corruptAccountOnce: string | null = null;
    const partialWriteDb = new Map<string, string>();
    const partialDeleteOrder: string[] = [];
    let blockDelete = false;
    const partialRunner: CommandRunner = async (_file, args, stdin) => {
      if (args[0] === "find-generic-password") {
        const account = args[args.indexOf("-a") + 1]!;
        const val = partialWriteDb.get(account);
        return val === undefined ? { code: 44, stdout: "" } : { code: 0, stdout: `${val}\n` };
      }
      if (args[0] === "delete-generic-password") {
        const account = args[args.indexOf("-a") + 1]!;
        partialDeleteOrder.push(account);
        if (blockDelete) {
          return { code: 1, stdout: "", stderr: "keychain busy" };
        }
        const existed = partialWriteDb.delete(account);
        return existed ? { code: 0, stdout: "" } : { code: 44, stdout: "" };
      }
      if (args[0] === "-i") {
        for (const line of stdin.split("\n").filter(Boolean)) {
          const add = /^add-generic-password -s "[^"]+" -a "([^"]+)" -U -w "([^"]+)"$/.exec(line);
          if (add) {
            if (corruptAccountOnce === add[1]) {
              corruptAccountOnce = null;
              // Simulate chunk #2 failing to persist while chunk #1 WAS written!
              continue;
            }
            partialWriteDb.set(add[1]!, add[2]!);
          }
        }
        return { code: 0, stdout: "" };
      }
      return { code: 1, stdout: "" };
    };

    const partialStore = keychainSecrets(partialRunner);
    corruptAccountOnce = "bot-partial#g1#2";
    blockDelete = true;
    await assert.rejects(
      () => partialStore.set("bot-partial", "P".repeat(5000)),
      (err: unknown) => err instanceof SecretStoreUnavailableError && err.code === "SECRET_WRITE_VERIFY_FAILED",
    );
    // Chunk #1 sits in Keychain AND root manifest recorded `pending:g1:3` BEFORE writing chunks!
    assert.equal(partialWriteDb.has("bot-partial#g1#1"), true);
    assert.equal(partialWriteDb.get("bot-partial"), "pending:g1:3");
    assert.equal(await partialStore.get("bot-partial"), undefined);

    // Subsequent delete() finds & removes pending chunk #1 before deleting root manifest!
    blockDelete = false;
    partialDeleteOrder.length = 0;
    await partialStore.delete("bot-partial");
    assert.deepEqual(partialDeleteOrder, [
      "bot-partial#g1#1",
      "bot-partial#g1#2",
      "bot-partial#g1#3",
      "bot-partial",
    ]);
    assert.equal(partialWriteDb.size, 0);

    // Overwriting a legacy unprefixed raw Keychain value with a chunked write that fails on chunk #2
    // MUST wrap the legacy value as structured `b64:...;pending:...` so `read()` preserves the
    // exact original legacy string AND `delete()` cleans up chunk #1 + manifest (#9)!
    partialWriteDb.set("bot-legacy", "sk-raw-legacy-token-without-prefix");
    corruptAccountOnce = "bot-legacy#g1#2";
    blockDelete = true;
    await assert.rejects(
      () => partialStore.set("bot-legacy", "L".repeat(5000)),
      (err: unknown) => err instanceof SecretStoreUnavailableError && err.code === "SECRET_WRITE_VERIFY_FAILED",
    );
    assert.equal(await partialStore.get("bot-legacy"), "sk-raw-legacy-token-without-prefix");
    assert.match(partialWriteDb.get("bot-legacy") ?? "", /^b64:[^;]+;pending:g1:3$/);
    assert.equal(partialWriteDb.has("bot-legacy#g1#1"), true);

    blockDelete = false;
    partialDeleteOrder.length = 0;
    await partialStore.delete("bot-legacy");
    assert.deepEqual(partialDeleteOrder, [
      "bot-legacy#g1#1",
      "bot-legacy#g1#2",
      "bot-legacy#g1#3",
      "bot-legacy",
    ]);
    assert.equal(partialWriteDb.size, 0);
  });

  it("macOS Keychain distinguishes missing (44) vs unavailable (127 / non-zero / timedOut) vs denied (128/36/51)", async () => {
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

    const timedOutStore = keychainSecrets(async () => ({ code: 44, stdout: "", stderr: "", killed: true, signal: "SIGTERM", timedOut: true }));
    assert.equal((await timedOutStore.read?.("k"))?.status, "unavailable");

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

    // Case 1: delete-generic-password returns non-zero exit code
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

    // Case 2: delete-generic-password returns exit code 0 silently WITHOUT actually deleting item -> read-back catches it!
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

  it("Linux secret-tool never classifies timed-out/signaled lookup as missing and verifies clear exit-1 via completed lookup", async () => {
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

    // Healthy keyring that later hits D-Bus error, timeout/signal, or exit-1 clear on already-missing item
    const items = new Map<string, string>();
    let lookupMode: "normal" | "dbus-error" | "timeout" | "sigkill" = "normal";
    let clearMode: "normal" | "fail-exit" | "silent-noop" | "missing-exit-1" = "normal";
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
            return { code: 1, stdout: "", stderr: "org.freedesktop.DBus.Error.NoReply: daemon down" };
          }
          if (lookupMode === "timeout") {
            return { code: 1, stdout: "", stderr: "", killed: true, signal: "SIGTERM", timedOut: true };
          }
          if (lookupMode === "sigkill") {
            return { code: 1, stdout: "", stderr: "", killed: true, signal: "SIGKILL", timedOut: false };
          }
        }
        const val = items.get(account);
        return val === undefined ? { code: 1, stdout: "", stderr: "" } : { code: 0, stdout: val };
      }
      if (op === "clear") {
        if (account !== "__xtwork_probe__") {
          if (clearMode === "fail-exit") return { code: 1, stdout: "", stderr: "secret-tool: clear failed" };
          if (clearMode === "silent-noop") return { code: 0, stdout: "" };
          if (clearMode === "missing-exit-1") {
            const existed = items.delete(account);
            return existed ? { code: 0, stdout: "" } : { code: 1, stdout: "", stderr: "" };
          }
        }
        items.delete(account);
        return { code: 0, stdout: "" };
      }
      return { code: 1, stdout: "" };
    };

    const store = linuxSecrets(runner);
    await store.set("wecom-1", '{"secret":"abc"}');
    assert.equal(await store.get("wecom-1"), '{"secret":"abc"}');
    assert.deepEqual(await store.read?.("never-set"), { status: "missing" });

    // Non-empty stderr on exit code 1 MUST be classified as unavailable, NOT missing!
    lookupMode = "dbus-error";
    assert.equal((await store.read?.("wecom-1"))?.status, "unavailable");
    await assert.rejects(
      () => store.get("wecom-1"),
      (err: unknown) => err instanceof SecretStoreUnavailableError && err.code === "SECRET_STORE_UNAVAILABLE",
    );

    // Timed-out or signaled lookup with exit code 1 and empty stderr MUST NEVER be classified as missing!
    lookupMode = "timeout";
    assert.equal((await store.read?.("wecom-1"))?.status, "unavailable");
    await assert.rejects(
      () => store.get("wecom-1"),
      (err: unknown) => err instanceof SecretStoreUnavailableError && err.code === "SECRET_STORE_UNAVAILABLE",
    );
    // Delete verification during a timed-out lookup MUST fail instead of falsely claiming item is missing!
    await assert.rejects(
      () => store.delete("wecom-1"),
      (err: unknown) => err instanceof SecretStoreUnavailableError && err.code === "SECRET_STORE_UNAVAILABLE",
    );

    lookupMode = "sigkill";
    assert.equal((await store.read?.("wecom-1"))?.status, "unavailable");
    lookupMode = "normal";
    // Restore wecom-1 (was deleted in map during timed-out delete test)
    await store.set("wecom-1", '{"secret":"abc"}');

    // Delete exit code failure with stderr throws SECRET_DELETE_VERIFY_FAILED
    clearMode = "fail-exit";
    await assert.rejects(
      () => store.delete("wecom-1"),
      (err: unknown) => err instanceof SecretStoreUnavailableError && err.code === "SECRET_DELETE_VERIFY_FAILED",
    );

    // Silent no-op delete (exit 0 but item remains) caught by read-back check!
    clearMode = "silent-noop";
    await assert.rejects(
      () => store.delete("wecom-1"),
      (err: unknown) => err instanceof SecretStoreUnavailableError && err.code === "SECRET_DELETE_VERIFY_FAILED",
    );

    // `secret-tool clear` returning exit 1 with empty stderr on an ALREADY-MISSING entry succeeds
    // once a completed lookup confirms absence!
    clearMode = "missing-exit-1";
    await store.delete("wecom-1");
    assert.equal(await store.get("wecom-1"), undefined);
    await store.delete("wecom-1"); // already missing -> clear returns exit 1 + empty stderr -> lookup confirms missing!
  });

  it("Windows DPAPI has no plaintext cache and fences in-flight Unprotect reads against concurrent verified delete", async () => {
    const dir = mkdtempSync(join(tmpdir(), "im-bridge-dpapi-"));
    const blobPath = join(dir, "dpapi.json");
    try {
      let denyNext = false;
      let unprotectCalls = 0;
      let pauseNextUnprotect = false;
      let enteredPausedUnprotect!: () => void;
      const enteredPausedPromise = new Promise<void>((r) => {
        enteredPausedUnprotect = r;
      });
      let releasePausedUnprotect!: () => void;
      const pausedGate = new Promise<void>((r) => {
        releasePausedUnprotect = r;
      });

      const mockDpapi: CommandRunner = async (_file, args, stdin) => {
        if (denyNext) {
          return { code: 1, stdout: "", stderr: "Access to the path is denied." };
        }
        const cmd = args.join(" ");
        if (cmd.includes("::Protect(")) {
          return { code: 0, stdout: Buffer.from(`SEALED:${stdin}`, "utf8").toString("base64") };
        }
        if (cmd.includes("::Unprotect(")) {
          unprotectCalls++;
          if (pauseNextUnprotect) {
            pauseNextUnprotect = false;
            enteredPausedUnprotect();
            await pausedGate;
          }
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

      // Every read calls DPAPI fresh (no store-level plaintext cache!).
      const callsBefore = unprotectCalls;
      assert.equal(await store.get("wechat-1"), '{"token":"super-secret-token"}');
      assert.equal(await store.get("wechat-1"), '{"token":"super-secret-token"}');
      assert.equal(unprotectCalls - callsBefore, 2);

      // In-flight Unprotect read racing verified delete MUST NOT return deleted plaintext OR repopulate a cache!
      pauseNextUnprotect = true;
      const racingRead = store.get("wechat-1");
      await enteredPausedPromise;
      await store.delete("wechat-1");
      releasePausedUnprotect();
      assert.equal(await racingRead, undefined);
      assert.equal(await store.get("wechat-1"), undefined);

      // Denied DPAPI error is classified as denied
      await store.set("wechat-2", '{"token":"second-secret"}');
      denyNext = true;
      assert.equal((await store.read?.("wechat-2"))?.status, "denied");
      await assert.rejects(
        () => store.get("wechat-2"),
        (err: unknown) => err instanceof SecretStoreUnavailableError && err.code === "SECRET_ACCESS_DENIED",
      );
      denyNext = false;

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
