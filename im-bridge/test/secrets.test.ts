import assert from "node:assert/strict";
import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, it } from "node:test";
import * as secretsMod from "../src/platform/secrets.ts";
import {
  type CommandRunner,
  defaultSecrets,
  keychainSecrets,
  linuxSecrets,
  memorySecrets,
  SecretStoreUnavailableError,
  windowsSecrets,
} from "../src/platform/secrets.ts";

describe("fail-closed OS secret store (ADR-011 L4)", () => {
  it("does NOT export any plaintext fileSecrets fallback", () => {
    assert.equal("fileSecrets" in secretsMod, false);
  });

  it("macOS Keychain stores short and chunked (>3000 b64) secrets via stdin and verifies read-back", async () => {
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

  it("Linux secret-tool fails closed with zero plaintext fallback when unavailable", async () => {
    const unavailable: CommandRunner = async () => ({ code: 127, stdout: "" });
    const store = linuxSecrets(unavailable);

    await assert.rejects(
      () => store.set("feishu-1", '{"appSecret":"top-secret"}'),
      (err: unknown) => err instanceof SecretStoreUnavailableError && err.code === "SECRET_STORE_UNAVAILABLE",
    );
    await assert.rejects(
      () => store.get("feishu-1"),
      (err: unknown) => err instanceof SecretStoreUnavailableError && err.code === "SECRET_STORE_UNAVAILABLE",
    );
  });

  it("Linux secret-tool succeeds when keyring is healthy and verifies read-back", async () => {
    const items = new Map<string, string>();
    const healthy: CommandRunner = async (_file, args, stdin) => {
      const op = args[0];
      const account = args[args.indexOf("account") + 1]!;
      if (op === "store") {
        items.set(account, stdin);
        return { code: 0, stdout: "" };
      }
      if (op === "lookup") {
        const val = items.get(account);
        return val === undefined ? { code: 1, stdout: "" } : { code: 0, stdout: val };
      }
      if (op === "clear") {
        items.delete(account);
        return { code: 0, stdout: "" };
      }
      return { code: 1, stdout: "" };
    };

    const store = linuxSecrets(healthy);
    await store.set("wecom-1", '{"secret":"abc"}');
    assert.equal(await store.get("wecom-1"), '{"secret":"abc"}');
    await store.delete("wecom-1");
    assert.equal(await store.get("wecom-1"), undefined);
  });

  it("Windows DPAPI stores only sealed dpapi: blobs, verifies round-trip, and rejects plaintext", async () => {
    const dir = mkdtempSync(join(tmpdir(), "im-bridge-dpapi-"));
    const blobPath = join(dir, "dpapi.json");
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
      await store.set("wechat-1", '{"token":"super-secret-token"}');
      assert.equal(existsSync(blobPath), true);
      const rawOnDisk = readFileSync(blobPath, "utf8");
      assert.equal(rawOnDisk.includes("super-secret-token"), false);
      assert.ok(rawOnDisk.includes("dpapi:"));

      // Fresh instance decrypts cleanly
      const store2 = windowsSecrets(blobPath, mockDpapi);
      assert.equal(await store2.get("wechat-1"), '{"token":"super-secret-token"}');

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
