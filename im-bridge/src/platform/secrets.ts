/**
 * OS-backed secure credential storage for IM bot credentials.
 *
 * Adapted from earayu/Mingle (MIT, commit 006220e880d2134665ce2745ab6233f52c8eabe9),
 * src/platform/secrets.ts.
 *
 * ADR-011 L4 SECURITY INVARIANT:
 * Plaintext file fallback (`fileSecrets`) is EXPLICITLY REMOVED.
 * - macOS: Keychain via `/usr/bin/security -i` (stdin, chunked base64, read-back verified).
 * - Windows: DPAPI (`ProtectedData::Protect/Unprotect` CurrentUser) storing ONLY DPAPI-sealed
 *   ciphertext blobs on disk (refuses plaintext, verifies decrypt round-trip).
 * - Linux: Secret Service (`secret-tool`, probe + write + read-back verified).
 * If the OS secure store is unavailable or read-back verification fails, every operation fails
 * closed with `SecretStoreUnavailableError`. `memorySecrets()` is provided for tests only.
 */

import { execFile } from "node:child_process";
import { chmodSync, existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname } from "node:path";

/** Where IM credentials live. Never SQLite, never logs, never plaintext files. */
export interface SecretStore {
  get(ref: string): Promise<string | undefined>;
  set(ref: string, value: string): Promise<void>;
  delete(ref: string): Promise<void>;
}

export type SecretStoreErrorCode =
  | "SECRET_STORE_UNAVAILABLE"
  | "SECRET_WRITE_VERIFY_FAILED"
  | "SECRET_DECRYPT_FAILED"
  | "INVALID_SECRET_REF";

export class SecretStoreUnavailableError extends Error {
  readonly code: SecretStoreErrorCode;

  constructor(code: SecretStoreErrorCode, message: string) {
    super(message);
    this.name = "SecretStoreUnavailableError";
    this.code = code;
  }
}

export type CommandRunner = (
  file: string,
  args: string[],
  stdin: string,
  timeoutMs?: number,
) => Promise<{ code: number; stdout: string }>;

const SERVICE = "app.xtwork.im-bridge";
const SECURITY = "/usr/bin/security";

/** Base64 characters per Keychain item: `security -i` reads at most 4095 characters per command line. */
const CHUNK = 3000;

/** Runs a program with `stdin` and collects stdout. Never rejects. */
function runWith(
  file: string,
  args: string[],
  stdin: string,
  timeoutMs = 15_000,
): Promise<{ code: number; stdout: string }> {
  return new Promise((resolve) => {
    const child = execFile(file, args, { timeout: timeoutMs, windowsHide: true }, (error, stdout) => {
      resolve({ code: error ? Number((error as { code?: unknown }).code) || 1 : 0, stdout });
    });
    child.on("error", () => resolve({ code: 127, stdout: "" }));
    child.stdin?.end(stdin);
  });
}

function validateRef(ref: string): void {
  if (!ref || /["\\\n\r\0]/.test(ref)) {
    throw new SecretStoreUnavailableError("INVALID_SECRET_REF", "Invalid secret reference");
  }
}

/**
 * macOS Keychain through `/usr/bin/security -i`.
 * Secrets are passed via stdin (never argv), base64-encoded (`b64:`) or chunked (`parts:<n>`),
 * and every write is immediately read back and compared. Fails closed on any error.
 */
export function keychainSecrets(run: CommandRunner = runWith, service = SERVICE): SecretStore {
  const quote = (value: string) => {
    validateRef(value);
    return `"${value}"`;
  };
  const read = async (ref: string): Promise<string | undefined> => {
    validateRef(ref);
    const { code, stdout } = await run(SECURITY, ["find-generic-password", "-s", service, "-a", ref, "-w"], "");
    if (code === 127) {
      throw new SecretStoreUnavailableError(
        "SECRET_STORE_UNAVAILABLE",
        "macOS Keychain tool (/usr/bin/security) is unavailable",
      );
    }
    return code === 0 ? stdout.replace(/\n$/, "") : undefined;
  };
  const parts = (stored: string | undefined) => {
    const match = stored?.match(/^parts:(\d+)$/);
    return match ? Number(match[1]) : 0;
  };
  const deleteCommands = (ref: string, count: number) =>
    [...Array.from({ length: count }, (_, i) => `${ref}#${i + 1}`), ref].map(
      (account) => `delete-generic-password -s ${quote(service)} -a ${quote(account)}`,
    );

  const store: SecretStore = {
    async get(ref) {
      const stored = await read(ref);
      if (stored === undefined) return undefined;
      const count = parts(stored);
      if (count > 0) {
        let joined = "";
        for (let i = 1; i <= count; i++) {
          const part = await read(`${ref}#${i}`);
          if (part === undefined) return undefined;
          joined += part;
        }
        return Buffer.from(joined, "base64").toString("utf8");
      }
      if (stored.startsWith("b64:")) return Buffer.from(stored.slice(4), "base64").toString("utf8");
      if (/^(?:[0-9a-f]{2})+$/i.test(stored)) return Buffer.from(stored, "hex").toString("utf8");
      return stored;
    },
    async set(ref, value) {
      validateRef(ref);
      const previous = parts(await read(ref));
      const encoded = Buffer.from(value, "utf8").toString("base64");
      const add = (account: string, data: string) =>
        `add-generic-password -s ${quote(service)} -a ${quote(account)} -U -w "${data}"`;
      const commands: string[] = [];
      let count = 0;
      if (encoded.length <= CHUNK) {
        commands.push(add(ref, `b64:${encoded}`));
      } else {
        for (let at = 0; at < encoded.length; at += CHUNK) {
          count++;
          commands.push(add(`${ref}#${count}`, encoded.slice(at, at + CHUNK)));
        }
        commands.push(add(ref, `parts:${count}`));
      }
      for (let i = count + 1; i <= previous; i++) {
        commands.push(`delete-generic-password -s ${quote(service)} -a ${quote(`${ref}#${i}`)}`);
      }
      const writeResult = await run(SECURITY, ["-i"], `${commands.join("\n")}\n`);
      if (writeResult.code === 127) {
        throw new SecretStoreUnavailableError(
          "SECRET_STORE_UNAVAILABLE",
          "macOS Keychain tool (/usr/bin/security) is unavailable",
        );
      }
      if ((await store.get(ref)) !== value) {
        throw new SecretStoreUnavailableError(
          "SECRET_WRITE_VERIFY_FAILED",
          "Could not save and verify credentials in macOS Keychain",
        );
      }
    },
    async delete(ref) {
      validateRef(ref);
      const count = parts(await read(ref));
      await run(SECURITY, ["-i"], `${deleteCommands(ref, count).join("\n")}\n`);
    },
  };
  return store;
}

const DPAPI_PREFIX = "dpapi:";

/**
 * Windows DPAPI (`CurrentUser`) credential store.
 * Ciphertext blobs are persisted in an encrypted-only blob file (strictly prefixed with `dpapi:`).
 * Never writes or reads plaintext; verifies decrypt round-trip on every write.
 */
export function windowsSecrets(sealedBlobPath: string, run: CommandRunner = runWith): SecretStore {
  const cache = new Map<string, string>();

  const readSealedMap = (): Record<string, string> => {
    if (!existsSync(sealedBlobPath)) return {};
    const parsed: unknown = JSON.parse(readFileSync(sealedBlobPath, "utf8"));
    if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) {
      throw new SecretStoreUnavailableError("SECRET_DECRYPT_FAILED", "Corrupted DPAPI credential store file");
    }
    return parsed as Record<string, string>;
  };

  const writeSealedMap = (data: Record<string, string>): void => {
    for (const val of Object.values(data)) {
      if (typeof val !== "string" || !val.startsWith(DPAPI_PREFIX)) {
        throw new SecretStoreUnavailableError(
          "SECRET_WRITE_VERIFY_FAILED",
          "Refusing to persist non-DPAPI-encrypted credential data",
        );
      }
    }
    mkdirSync(dirname(sealedBlobPath), { recursive: true });
    writeFileSync(sealedBlobPath, JSON.stringify(data), { mode: 0o600 });
    try {
      chmodSync(sealedBlobPath, 0o600);
    } catch {
      // chmod is best-effort on Windows NTFS.
    }
  };

  const dpapi = async (op: "Protect" | "Unprotect", base64: string): Promise<string> => {
    const script =
      "Add-Type -AssemblyName System.Security;" +
      "$b=[Convert]::FromBase64String([Console]::In.ReadToEnd().Trim());" +
      `$o=[Security.Cryptography.ProtectedData]::${op}($b,$null,'CurrentUser');` +
      "[Console]::Out.Write([Convert]::ToBase64String($o))";
    const { code, stdout } = await run("powershell.exe", ["-NoProfile", "-NonInteractive", "-Command", script], base64);
    const out = stdout.trim();
    if (code === 127) {
      throw new SecretStoreUnavailableError(
        "SECRET_STORE_UNAVAILABLE",
        "Windows PowerShell DPAPI runtime is unavailable",
      );
    }
    if (code !== 0 || !out) {
      throw new SecretStoreUnavailableError(
        op === "Protect" ? "SECRET_WRITE_VERIFY_FAILED" : "SECRET_DECRYPT_FAILED",
        `Could not ${op === "Protect" ? "encrypt" : "decrypt"} credentials with Windows DPAPI`,
      );
    }
    return out;
  };

  return {
    async get(ref) {
      validateRef(ref);
      const cached = cache.get(ref);
      if (cached !== undefined) return cached;
      const sealed = readSealedMap()[ref];
      if (sealed === undefined) return undefined;
      if (!sealed.startsWith(DPAPI_PREFIX)) {
        throw new SecretStoreUnavailableError(
          "SECRET_DECRYPT_FAILED",
          "Refusing to read unencrypted credential entry; plaintext fallback is disabled",
        );
      }
      const unsealed = await dpapi("Unprotect", sealed.slice(DPAPI_PREFIX.length));
      const value = Buffer.from(unsealed, "base64").toString("utf8");
      cache.set(ref, value);
      return value;
    },
    async set(ref, value) {
      validateRef(ref);
      const protectedB64 = await dpapi("Protect", Buffer.from(value, "utf8").toString("base64"));
      // Verify decrypt round-trip before persisting.
      const checkB64 = await dpapi("Unprotect", protectedB64);
      const checkVal = Buffer.from(checkB64, "base64").toString("utf8");
      if (checkVal !== value) {
        throw new SecretStoreUnavailableError(
          "SECRET_WRITE_VERIFY_FAILED",
          "Windows DPAPI round-trip verification failed",
        );
      }
      const next = { ...readSealedMap(), [ref]: `${DPAPI_PREFIX}${protectedB64}` };
      writeSealedMap(next);
      cache.set(ref, value);
    },
    async delete(ref) {
      validateRef(ref);
      cache.delete(ref);
      const current = readSealedMap();
      if (!(ref in current)) return;
      delete current[ref];
      writeSealedMap(current);
    },
  };
}

/**
 * Linux Secret Service (GNOME Keyring / KWallet) through `secret-tool`.
 *
 * ADR-011 L4: Strictly fail-closed with ZERO plaintext file fallback. If `secret-tool` or the
 * desktop Secret Service daemon is unavailable, or if write read-back verification fails, throws
 * `SecretStoreUnavailableError` explaining why binding is blocked.
 */
export function linuxSecrets(run: CommandRunner = runWith, service = SERVICE): SecretStore {
  const attrs = (ref: string) => ["service", service, "account", ref];
  let probePromise: Promise<boolean> | undefined;

  const ensureKeyring = async (): Promise<void> => {
    probePromise ??= (async () => {
      const probe = "__xtwork_probe__";
      const stored = await run("secret-tool", ["store", "--label=Xtwork Probe", ...attrs(probe)], "ok", 5000);
      if (stored.code !== 0) return false;
      const read = await run("secret-tool", ["lookup", ...attrs(probe)], "", 5000);
      await run("secret-tool", ["clear", ...attrs(probe)], "", 5000);
      return read.code === 0 && read.stdout === "ok";
    })();
    const ok = await probePromise;
    if (!ok) {
      probePromise = undefined;
      throw new SecretStoreUnavailableError(
        "SECRET_STORE_UNAVAILABLE",
        "Linux Secret Service (secret-tool / GNOME Keyring / KWallet) is unavailable; plaintext credential fallback is disabled",
      );
    }
  };

  return {
    async get(ref) {
      validateRef(ref);
      await ensureKeyring();
      const { code, stdout } = await run("secret-tool", ["lookup", ...attrs(ref)], "");
      if (code === 127) {
        throw new SecretStoreUnavailableError("SECRET_STORE_UNAVAILABLE", "secret-tool is unavailable");
      }
      return code === 0 ? stdout : undefined;
    },
    async set(ref, value) {
      validateRef(ref);
      await ensureKeyring();
      const stored = await run("secret-tool", ["store", `--label=Xtwork ${ref}`, ...attrs(ref)], value);
      if (stored.code !== 0) {
        throw new SecretStoreUnavailableError(
          "SECRET_WRITE_VERIFY_FAILED",
          "Could not write credentials to Linux Secret Service",
        );
      }
      const verify = await run("secret-tool", ["lookup", ...attrs(ref)], "");
      if (verify.code !== 0 || verify.stdout !== value) {
        throw new SecretStoreUnavailableError(
          "SECRET_WRITE_VERIFY_FAILED",
          "Could not verify credentials written to Linux Secret Service",
        );
      }
    },
    async delete(ref) {
      validateRef(ref);
      await ensureKeyring();
      await run("secret-tool", ["clear", ...attrs(ref)], "");
    },
  };
}

/** In-memory secret store for automated unit tests ONLY. Never used in production `defaultSecrets`. */
export function memorySecrets(): SecretStore {
  const data = new Map<string, string>();
  return {
    async get(ref) {
      return data.get(ref);
    },
    async set(ref, value) {
      data.set(ref, value);
    },
    async delete(ref) {
      data.delete(ref);
    },
  };
}

/**
 * Select the OS secure credential store for the current platform.
 * Fails closed on unsupported platforms without any plaintext file fallback.
 */
export function defaultSecrets(windowsDpapiPath?: string, platform: NodeJS.Platform = process.platform): SecretStore {
  if (platform === "darwin") return keychainSecrets();
  if (platform === "win32") {
    if (!windowsDpapiPath) {
      throw new SecretStoreUnavailableError(
        "SECRET_STORE_UNAVAILABLE",
        "Windows DPAPI store path is required",
      );
    }
    return windowsSecrets(windowsDpapiPath);
  }
  if (platform === "linux") return linuxSecrets();
  throw new SecretStoreUnavailableError(
    "SECRET_STORE_UNAVAILABLE",
    `Unsupported platform "${platform}" has no configured OS secure credential store; plaintext fallback is disabled`,
  );
}
