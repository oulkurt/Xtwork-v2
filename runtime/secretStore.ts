// @effect-diagnostics nodeBuiltinImport:off extendsNativeError:off -- OS SecretStore uses Node child_process, crypto, and fs and shares the standalone SecretStoreUnavailableError class.
/**
 * Shared server-side hardened OS SecretStore for Xtwork model channels (`app.xtwork.model-channels`).
 *
 * Implements the exact same ADR-011 L4 / ADR-012 §3.1 hardened OS SecretStore contract as
 * `im-bridge/src/platform/secrets.ts`, kept self-contained so `apps/server` and standalone
 * `im-bridge` packaging never break cross-package imports.
 */

import { execFile } from "node:child_process";
import { randomUUID } from "node:crypto";
import {
  chmodSync,
  existsSync,
  mkdirSync,
  readFileSync,
  renameSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { dirname } from "node:path";

export const IM_BRIDGE_SECRET_NAMESPACE = "app.xtwork.im-bridge";
export const MODEL_CHANNELS_SECRET_NAMESPACE = "app.xtwork.model-channels";

export type SecretStoreErrorCode =
  | "SECRET_STORE_UNAVAILABLE"
  | "SECRET_ACCESS_DENIED"
  | "SECRET_WRITE_VERIFY_FAILED"
  | "SECRET_DELETE_VERIFY_FAILED"
  | "SECRET_DECRYPT_FAILED"
  | "INVALID_SECRET_REF"
  | "SECRET_FENCE_STALE";

export type SecretStoreFailureKind =
  | "unavailable"
  | "denied"
  | "verification_failed"
  | "invalid_ref"
  | "stale_fence";

function failureKindForCode(code: SecretStoreErrorCode): SecretStoreFailureKind {
  switch (code) {
    case "SECRET_STORE_UNAVAILABLE":
      return "unavailable";
    case "SECRET_ACCESS_DENIED":
      return "denied";
    case "SECRET_WRITE_VERIFY_FAILED":
    case "SECRET_DELETE_VERIFY_FAILED":
    case "SECRET_DECRYPT_FAILED":
      return "verification_failed";
    case "INVALID_SECRET_REF":
      return "invalid_ref";
    case "SECRET_FENCE_STALE":
      return "stale_fence";
  }
}

export class SecretStoreUnavailableError extends Error {
  readonly code: SecretStoreErrorCode;
  readonly kind: SecretStoreFailureKind;

  constructor(code: SecretStoreErrorCode, message: string, options?: ErrorOptions) {
    super(message, options);
    this.name = "SecretStoreUnavailableError";
    this.code = code;
    this.kind = failureKindForCode(code);
  }
}

export { SecretStoreUnavailableError as SecretStoreError };

export type SecretReadResult =
  | { readonly status: "found"; readonly value: string }
  | { readonly status: "missing" }
  | { readonly status: "unavailable"; readonly error: SecretStoreUnavailableError }
  | { readonly status: "denied"; readonly error: SecretStoreUnavailableError };

/** Where credentials live. Never SQLite, never logs, never plaintext files. */
export interface SecretStore {
  get(ref: string): Promise<string | undefined>;
  read?(ref: string): Promise<SecretReadResult>;
  set(ref: string, value: string): Promise<void>;
  delete(ref: string): Promise<void>;
}

export interface CommandResult {
  readonly code: number;
  readonly stdout: string;
  readonly stderr?: string;
}

export type CommandRunner = (
  file: string,
  args: string[],
  stdin: string,
  timeoutMs?: number,
) => Promise<CommandResult>;

const DEFAULT_SERVICE = MODEL_CHANNELS_SECRET_NAMESPACE;
const SECURITY = "/usr/bin/security";

/** Base64 characters per Keychain item: `security -i` reads at most 4095 characters per command line. */
const CHUNK = 3000;

/** Runs a program with `stdin` and collects stdout/stderr. Never rejects. */
function runWith(
  file: string,
  args: string[],
  stdin: string,
  timeoutMs = 15_000,
): Promise<CommandResult> {
  return new Promise((resolve) => {
    let settled = false;
    const finish = (result: CommandResult) => {
      if (settled) return;
      settled = true;
      resolve(result);
    };
    const child = execFile(
      file,
      args,
      { timeout: timeoutMs, windowsHide: true },
      (error, stdout, stderr) => {
        if (!error) {
          finish({ code: 0, stdout, stderr });
          return;
        }
        const errCode = (error as NodeJS.ErrnoException & { code?: unknown }).code;
        if (errCode === "ENOENT") {
          finish({ code: 127, stdout: stdout ?? "", stderr: stderr ?? error.message });
          return;
        }
        const numeric = typeof errCode === "number" && Number.isFinite(errCode) ? errCode : 1;
        finish({ code: numeric, stdout: stdout ?? "", stderr: stderr ?? error.message });
      },
    );
    child.on("error", (err) => {
      const errCode = (err as NodeJS.ErrnoException).code;
      finish({ code: errCode === "ENOENT" ? 127 : 1, stdout: "", stderr: err.message });
    });
    child.stdin?.end(stdin);
  });
}

function validateRef(ref: string): void {
  if (!ref || /["\\\n\r\0]/.test(ref)) {
    throw new SecretStoreUnavailableError("INVALID_SECRET_REF", "Invalid secret reference");
  }
}

function validateService(service: string): void {
  if (!service || /["\\\n\r\0]/.test(service)) {
    throw new SecretStoreUnavailableError("INVALID_SECRET_REF", "Invalid secret namespace");
  }
}

function sanitizeErrorDetail(stderr: string | undefined): string {
  if (!stderr) return "";
  const compact = stderr.replace(/\s+/g, " ").trim();
  return compact.length > 200 ? `${compact.slice(0, 200)}...` : compact;
}

const MACOS_DENIED_EXIT_CODES = new Set([36, 51, 128]);
const MACOS_DENIED_PATTERN =
  /user canceled|denied|interaction is not allowed|not allowed|authorization failed|errSecAuthFailed|errSecUserCanceled|errSecInteractionNotAllowed|keychain is locked/i;

function isMacOsDenied(code: number, stderr?: string): boolean {
  return MACOS_DENIED_EXIT_CODES.has(code) || Boolean(stderr && MACOS_DENIED_PATTERN.test(stderr));
}

const LINUX_DENIED_PATTERN =
  /denied|locked|cancel|dismiss|permission|unauthorized|not authorized|authentication failed/i;

function isLinuxDenied(stderr?: string): boolean {
  return Boolean(stderr && LINUX_DENIED_PATTERN.test(stderr));
}

const WINDOWS_DENIED_PATTERN =
  /access(?:\s+to\s+the\s+path)?\s+.*denied|unauthorized|permission|privilege/i;

function isWindowsDenied(stderr?: string): boolean {
  return Boolean(stderr && WINDOWS_DENIED_PATTERN.test(stderr));
}

function isFsPermissionError(error: unknown): boolean {
  const code = (error as NodeJS.ErrnoException | null)?.code;
  return code === "EACCES" || code === "EPERM";
}

export function keychainSecrets(
  run: CommandRunner = runWith,
  service = DEFAULT_SERVICE,
): SecretStore {
  validateService(service);
  const quote = (value: string) => {
    validateRef(value);
    return `"${value}"`;
  };

  type RawRead =
    | { readonly status: "found"; readonly value: string }
    | { readonly status: "missing" }
    | { readonly status: "unavailable"; readonly error: SecretStoreUnavailableError }
    | { readonly status: "denied"; readonly error: SecretStoreUnavailableError };

  const readRaw = async (account: string): Promise<RawRead> => {
    validateRef(account);
    const { code, stdout, stderr } = await run(
      SECURITY,
      ["find-generic-password", "-s", service, "-a", account, "-w"],
      "",
    );
    if (code === 0) {
      return { status: "found", value: stdout.replace(/\n$/, "") };
    }
    if (code === 44) {
      return { status: "missing" };
    }
    const detail = sanitizeErrorDetail(stderr);
    const suffix = detail ? ` (${detail})` : ` (exit code ${code})`;
    if (code === 127) {
      return {
        status: "unavailable",
        error: new SecretStoreUnavailableError(
          "SECRET_STORE_UNAVAILABLE",
          "macOS Keychain tool (/usr/bin/security) is unavailable",
        ),
      };
    }
    if (isMacOsDenied(code, stderr)) {
      return {
        status: "denied",
        error: new SecretStoreUnavailableError(
          "SECRET_ACCESS_DENIED",
          `macOS Keychain denied access to credentials${suffix}`,
        ),
      };
    }
    return {
      status: "unavailable",
      error: new SecretStoreUnavailableError(
        "SECRET_STORE_UNAVAILABLE",
        `macOS Keychain read failed${suffix}`,
      ),
    };
  };

  const parts = (stored: string | undefined) => {
    const match = stored?.match(/^parts:(\d+)$/);
    return match ? Number(match[1]) : 0;
  };

  const deleteCommands = (ref: string, count: number) =>
    [...Array.from({ length: count }, (_, i) => `${ref}#${i + 1}`), ref].map(
      (account) => `delete-generic-password -s ${quote(service)} -a ${quote(account)}`,
    );

  const read = async (ref: string): Promise<SecretReadResult> => {
    const raw = await readRaw(ref);
    if (raw.status !== "found") return raw;

    const stored = raw.value;
    const count = parts(stored);
    if (count > 0) {
      let joined = "";
      for (let i = 1; i <= count; i++) {
        const part = await readRaw(`${ref}#${i}`);
        if (part.status === "unavailable" || part.status === "denied") {
          return part;
        }
        if (part.status === "missing") {
          return {
            status: "unavailable",
            error: new SecretStoreUnavailableError(
              "SECRET_DECRYPT_FAILED",
              `macOS Keychain chunk ${i}/${count} is missing for credential entry`,
            ),
          };
        }
        joined += part.value;
      }
      return { status: "found", value: Buffer.from(joined, "base64").toString("utf8") };
    }
    if (stored.startsWith("b64:")) {
      return { status: "found", value: Buffer.from(stored.slice(4), "base64").toString("utf8") };
    }
    if (/^(?:[0-9a-f]{2})+$/i.test(stored)) {
      return { status: "found", value: Buffer.from(stored, "hex").toString("utf8") };
    }
    return { status: "found", value: stored };
  };

  const store: SecretStore = {
    read,
    async get(ref) {
      const result = await read(ref);
      if (result.status === "found") return result.value;
      if (result.status === "missing") return undefined;
      throw result.error;
    },
    async set(ref, value) {
      validateRef(ref);
      const existing = await readRaw(ref);
      if (existing.status === "unavailable" || existing.status === "denied") {
        throw existing.error;
      }
      const previous = existing.status === "found" ? parts(existing.value) : 0;
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
      if (writeResult.code !== 0) {
        const detail = sanitizeErrorDetail(writeResult.stderr);
        const suffix = detail ? ` (${detail})` : ` (exit code ${writeResult.code})`;
        if (isMacOsDenied(writeResult.code, writeResult.stderr)) {
          throw new SecretStoreUnavailableError(
            "SECRET_ACCESS_DENIED",
            `macOS Keychain denied saving credentials${suffix}`,
          );
        }
        throw new SecretStoreUnavailableError(
          "SECRET_WRITE_VERIFY_FAILED",
          `Could not write credentials to macOS Keychain${suffix}`,
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
      const existing = await readRaw(ref);
      if (existing.status === "unavailable" || existing.status === "denied") {
        throw existing.error;
      }
      if (existing.status === "missing") {
        return;
      }
      const count = parts(existing.value);
      const delResult = await run(SECURITY, ["-i"], `${deleteCommands(ref, count).join("\n")}\n`);
      if (delResult.code === 127) {
        throw new SecretStoreUnavailableError(
          "SECRET_STORE_UNAVAILABLE",
          "macOS Keychain tool (/usr/bin/security) is unavailable",
        );
      }
      if (delResult.code !== 0) {
        const detail = sanitizeErrorDetail(delResult.stderr);
        const suffix = detail ? ` (${detail})` : ` (exit code ${delResult.code})`;
        if (isMacOsDenied(delResult.code, delResult.stderr)) {
          throw new SecretStoreUnavailableError(
            "SECRET_ACCESS_DENIED",
            `macOS Keychain denied deleting credentials${suffix}`,
          );
        }
        throw new SecretStoreUnavailableError(
          "SECRET_DELETE_VERIFY_FAILED",
          `Could not delete credentials from macOS Keychain${suffix}`,
        );
      }
      const accountsToVerify = [ref, ...Array.from({ length: count }, (_, i) => `${ref}#${i + 1}`)];
      for (const account of accountsToVerify) {
        const check = await readRaw(account);
        if (check.status === "unavailable" || check.status === "denied") {
          throw check.error;
        }
        if (check.status === "found") {
          throw new SecretStoreUnavailableError(
            "SECRET_DELETE_VERIFY_FAILED",
            "macOS Keychain credential still present after delete verification",
          );
        }
      }
    },
  };
  return store;
}

const DPAPI_PREFIX = "dpapi:";

export function windowsSecrets(sealedBlobPath: string, run: CommandRunner = runWith): SecretStore {
  const cache = new Map<string, string>();

  const readSealedMap = (): Record<string, string> => {
    if (!existsSync(sealedBlobPath)) return {};
    let raw: string;
    try {
      raw = readFileSync(sealedBlobPath, "utf8");
    } catch (error) {
      if ((error as NodeJS.ErrnoException | null)?.code === "ENOENT") return {};
      if (isFsPermissionError(error)) {
        throw new SecretStoreUnavailableError(
          "SECRET_ACCESS_DENIED",
          "Access denied while reading Windows DPAPI credential store file",
          { cause: error },
        );
      }
      throw new SecretStoreUnavailableError(
        "SECRET_STORE_UNAVAILABLE",
        "Could not read Windows DPAPI credential store file",
        { cause: error },
      );
    }
    let parsed: unknown;
    try {
      parsed = JSON.parse(raw);
    } catch (error) {
      throw new SecretStoreUnavailableError(
        "SECRET_DECRYPT_FAILED",
        "Corrupted DPAPI credential store file",
        { cause: error },
      );
    }
    if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) {
      throw new SecretStoreUnavailableError(
        "SECRET_DECRYPT_FAILED",
        "Corrupted DPAPI credential store file",
      );
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
    const tempPath = `${sealedBlobPath}.${randomUUID()}.tmp`;
    try {
      mkdirSync(dirname(sealedBlobPath), { recursive: true });
      writeFileSync(tempPath, JSON.stringify(data), { mode: 0o600 });
      try {
        chmodSync(tempPath, 0o600);
      } catch {
        // chmod is best-effort on Windows NTFS.
      }
      renameSync(tempPath, sealedBlobPath);
    } catch (error) {
      try {
        rmSync(tempPath, { force: true });
      } catch {
        // Ignore cleanup errors.
      }
      if (isFsPermissionError(error)) {
        throw new SecretStoreUnavailableError(
          "SECRET_ACCESS_DENIED",
          "Access denied while writing Windows DPAPI credential store file",
          { cause: error },
        );
      }
      throw new SecretStoreUnavailableError(
        "SECRET_WRITE_VERIFY_FAILED",
        "Could not persist Windows DPAPI credential store file",
        { cause: error },
      );
    }
  };

  const dpapi = async (op: "Protect" | "Unprotect", base64: string): Promise<string> => {
    const script =
      "Add-Type -AssemblyName System.Security;" +
      "$b=[Convert]::FromBase64String([Console]::In.ReadToEnd().Trim());" +
      `$o=[Security.Cryptography.ProtectedData]::${op}($b,$null,'CurrentUser');` +
      "[Console]::Out.Write([Convert]::ToBase64String($o))";
    const { code, stdout, stderr } = await run(
      "powershell.exe",
      ["-NoProfile", "-NonInteractive", "-Command", script],
      base64,
    );
    const out = stdout.trim();
    if (code === 127) {
      throw new SecretStoreUnavailableError(
        "SECRET_STORE_UNAVAILABLE",
        "Windows PowerShell DPAPI runtime is unavailable",
      );
    }
    if (code !== 0 && isWindowsDenied(stderr)) {
      const detail = sanitizeErrorDetail(stderr);
      throw new SecretStoreUnavailableError(
        "SECRET_ACCESS_DENIED",
        `Windows DPAPI denied access${detail ? ` (${detail})` : ""}`,
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

  const read = async (ref: string): Promise<SecretReadResult> => {
    validateRef(ref);
    const cached = cache.get(ref);
    if (cached !== undefined) return { status: "found", value: cached };
    let map: Record<string, string>;
    try {
      map = readSealedMap();
    } catch (error) {
      if (error instanceof SecretStoreUnavailableError) {
        if (error.kind === "denied") return { status: "denied", error };
        return { status: "unavailable", error };
      }
      throw error;
    }
    const sealed = map[ref];
    if (sealed === undefined) return { status: "missing" };
    if (!sealed.startsWith(DPAPI_PREFIX)) {
      return {
        status: "unavailable",
        error: new SecretStoreUnavailableError(
          "SECRET_DECRYPT_FAILED",
          "Refusing to read unencrypted credential entry; plaintext fallback is disabled",
        ),
      };
    }
    try {
      const unsealed = await dpapi("Unprotect", sealed.slice(DPAPI_PREFIX.length));
      const value = Buffer.from(unsealed, "base64").toString("utf8");
      cache.set(ref, value);
      return { status: "found", value };
    } catch (error) {
      if (error instanceof SecretStoreUnavailableError) {
        if (error.kind === "denied") return { status: "denied", error };
        return { status: "unavailable", error };
      }
      throw error;
    }
  };

  return {
    read,
    async get(ref) {
      const result = await read(ref);
      if (result.status === "found") return result.value;
      if (result.status === "missing") return undefined;
      throw result.error;
    },
    async set(ref, value) {
      validateRef(ref);
      const protectedB64 = await dpapi("Protect", Buffer.from(value, "utf8").toString("base64"));
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
      const persisted = readSealedMap()[ref];
      if (persisted !== `${DPAPI_PREFIX}${protectedB64}`) {
        throw new SecretStoreUnavailableError(
          "SECRET_WRITE_VERIFY_FAILED",
          "Windows DPAPI persisted blob verification failed",
        );
      }
      cache.set(ref, value);
    },
    async delete(ref) {
      validateRef(ref);
      cache.delete(ref);
      const current = readSealedMap();
      if (!(ref in current)) return;
      delete current[ref];
      try {
        writeSealedMap(current);
      } catch (error) {
        if (error instanceof SecretStoreUnavailableError && error.code === "SECRET_ACCESS_DENIED") {
          throw error;
        }
        throw new SecretStoreUnavailableError(
          "SECRET_DELETE_VERIFY_FAILED",
          "Could not delete credential from Windows DPAPI store file",
          { cause: error },
        );
      }
      const after = readSealedMap();
      if (ref in after) {
        throw new SecretStoreUnavailableError(
          "SECRET_DELETE_VERIFY_FAILED",
          "Windows DPAPI credential still present after delete verification",
        );
      }
    },
  };
}

export function linuxSecrets(
  run: CommandRunner = runWith,
  service = DEFAULT_SERVICE,
): SecretStore {
  validateService(service);
  const attrs = (ref: string) => ["service", service, "account", ref];
  let probePromise: Promise<{ ok: true } | { ok: false; error: SecretStoreUnavailableError }> | undefined;

  const ensureKeyring = async (): Promise<void> => {
    probePromise ??= (async () => {
      const probe = "__xtwork_probe__";
      const stored = await run("secret-tool", ["store", "--label=Xtwork Probe", ...attrs(probe)], "ok", 5000);
      if (stored.code !== 0) {
        const detail = sanitizeErrorDetail(stored.stderr);
        if (stored.code !== 127 && isLinuxDenied(stored.stderr)) {
          return {
            ok: false as const,
            error: new SecretStoreUnavailableError(
              "SECRET_ACCESS_DENIED",
              `Linux Secret Service denied access${detail ? ` (${detail})` : ""}`,
            ),
          };
        }
        return {
          ok: false as const,
          error: new SecretStoreUnavailableError(
            "SECRET_STORE_UNAVAILABLE",
            `Linux Secret Service (secret-tool / GNOME Keyring / KWallet) is unavailable; plaintext credential fallback is disabled${detail ? ` (${detail})` : ""}`,
          ),
        };
      }
      const verify = await run("secret-tool", ["lookup", ...attrs(probe)], "", 5000);
      await run("secret-tool", ["clear", ...attrs(probe)], "", 5000);
      if (verify.code === 0 && verify.stdout === "ok") {
        return { ok: true as const };
      }
      return {
        ok: false as const,
        error: new SecretStoreUnavailableError(
          "SECRET_STORE_UNAVAILABLE",
          "Linux Secret Service probe failed read-back verification; plaintext credential fallback is disabled",
        ),
      };
    })();
    const result = await probePromise;
    if (!result.ok) {
      probePromise = undefined;
      throw result.error;
    }
  };

  const lookupRaw = async (ref: string): Promise<SecretReadResult> => {
    const { code, stdout, stderr } = await run("secret-tool", ["lookup", ...attrs(ref)], "");
    if (code === 0) {
      return { status: "found", value: stdout };
    }
    const detail = sanitizeErrorDetail(stderr);
    if (code === 1 && detail.length === 0) {
      return { status: "missing" };
    }
    if (code === 127) {
      return {
        status: "unavailable",
        error: new SecretStoreUnavailableError("SECRET_STORE_UNAVAILABLE", "secret-tool is unavailable"),
      };
    }
    if (isLinuxDenied(stderr)) {
      return {
        status: "denied",
        error: new SecretStoreUnavailableError(
          "SECRET_ACCESS_DENIED",
          `Linux Secret Service denied access to credentials${detail ? ` (${detail})` : ""}`,
        ),
      };
    }
    return {
      status: "unavailable",
      error: new SecretStoreUnavailableError(
        "SECRET_STORE_UNAVAILABLE",
        `Linux Secret Service lookup failed${detail ? ` (${detail})` : ` (exit code ${code})`}`,
      ),
    };
  };

  const read = async (ref: string): Promise<SecretReadResult> => {
    validateRef(ref);
    try {
      await ensureKeyring();
    } catch (error) {
      if (error instanceof SecretStoreUnavailableError) {
        return error.kind === "denied"
          ? { status: "denied", error }
          : { status: "unavailable", error };
      }
      throw error;
    }
    return lookupRaw(ref);
  };

  return {
    read,
    async get(ref) {
      const result = await read(ref);
      if (result.status === "found") return result.value;
      if (result.status === "missing") return undefined;
      throw result.error;
    },
    async set(ref, value) {
      validateRef(ref);
      await ensureKeyring();
      const stored = await run("secret-tool", ["store", `--label=Xtwork ${ref}`, ...attrs(ref)], value);
      if (stored.code === 127) {
        throw new SecretStoreUnavailableError("SECRET_STORE_UNAVAILABLE", "secret-tool is unavailable");
      }
      if (stored.code !== 0) {
        const detail = sanitizeErrorDetail(stored.stderr);
        if (isLinuxDenied(stored.stderr)) {
          throw new SecretStoreUnavailableError(
            "SECRET_ACCESS_DENIED",
            `Linux Secret Service denied saving credentials${detail ? ` (${detail})` : ""}`,
          );
        }
        throw new SecretStoreUnavailableError(
          "SECRET_WRITE_VERIFY_FAILED",
          `Could not write credentials to Linux Secret Service${detail ? ` (${detail})` : ""}`,
        );
      }
      const verify = await lookupRaw(ref);
      if (verify.status === "unavailable" || verify.status === "denied") {
        throw verify.error;
      }
      if (verify.status !== "found" || verify.value !== value) {
        throw new SecretStoreUnavailableError(
          "SECRET_WRITE_VERIFY_FAILED",
          "Could not verify credentials written to Linux Secret Service",
        );
      }
    },
    async delete(ref) {
      validateRef(ref);
      await ensureKeyring();
      const cleared = await run("secret-tool", ["clear", ...attrs(ref)], "");
      if (cleared.code === 127) {
        throw new SecretStoreUnavailableError("SECRET_STORE_UNAVAILABLE", "secret-tool is unavailable");
      }
      if (cleared.code !== 0) {
        const detail = sanitizeErrorDetail(cleared.stderr);
        if (isLinuxDenied(cleared.stderr)) {
          throw new SecretStoreUnavailableError(
            "SECRET_ACCESS_DENIED",
            `Linux Secret Service denied deleting credentials${detail ? ` (${detail})` : ""}`,
          );
        }
        throw new SecretStoreUnavailableError(
          "SECRET_DELETE_VERIFY_FAILED",
          `Could not delete credentials from Linux Secret Service${detail ? ` (${detail})` : ` (exit code ${cleared.code})`}`,
        );
      }
      const check = await lookupRaw(ref);
      if (check.status === "unavailable" || check.status === "denied") {
        throw check.error;
      }
      if (check.status === "found") {
        throw new SecretStoreUnavailableError(
          "SECRET_DELETE_VERIFY_FAILED",
          "Linux Secret Service credential still present after delete verification",
        );
      }
    },
  };
}

/** In-memory secret store for automated unit tests ONLY. Never used in production `defaultSecrets`. */
export function memorySecrets(): SecretStore {
  const data = new Map<string, string>();
  const read = async (ref: string): Promise<SecretReadResult> => {
    validateRef(ref);
    const val = data.get(ref);
    return val === undefined ? { status: "missing" } : { status: "found", value: val };
  };
  return {
    read,
    async get(ref) {
      const result = await read(ref);
      return result.status === "found" ? result.value : undefined;
    },
    async set(ref, value) {
      validateRef(ref);
      data.set(ref, value);
    },
    async delete(ref) {
      validateRef(ref);
      data.delete(ref);
    },
  };
}

export interface SecretStoreFactoryOptions {
  readonly namespace?: string;
  readonly windowsDpapiPath?: string;
  readonly platform?: NodeJS.Platform;
  readonly run?: CommandRunner;
}

export function createSecretStore(options: SecretStoreFactoryOptions = {}): SecretStore {
  const namespace = options.namespace ?? DEFAULT_SERVICE;
  const platform = options.platform ?? process.platform;
  const run = options.run ?? runWith;
  validateService(namespace);

  if (platform === "darwin") return keychainSecrets(run, namespace);
  if (platform === "win32") {
    if (!options.windowsDpapiPath) {
      throw new SecretStoreUnavailableError(
        "SECRET_STORE_UNAVAILABLE",
        "Windows DPAPI store path is required",
      );
    }
    return windowsSecrets(options.windowsDpapiPath, run);
  }
  if (platform === "linux") return linuxSecrets(run, namespace);
  throw new SecretStoreUnavailableError(
    "SECRET_STORE_UNAVAILABLE",
    `Unsupported platform "${platform}" has no configured OS secure credential store; plaintext fallback is disabled`,
  );
}

export function defaultSecrets(
  windowsDpapiPath?: string,
  platform: NodeJS.Platform = process.platform,
  namespace: string = DEFAULT_SERVICE,
): SecretStore {
  return createSecretStore({
    ...(windowsDpapiPath !== undefined ? { windowsDpapiPath } : {}),
    platform,
    namespace,
  });
}

export interface CredentialFenceLease {
  readonly key: string;
  readonly generation: number;
  readonly signal: AbortSignal;
  isCurrent(): boolean;
  assertCurrent(): void;
  release(): void;
}

export class ChannelCredentialFence {
  private readonly generations = new Map<string, number>();
  private readonly activeControllers = new Map<string, Set<AbortController>>();
  private readonly keyLocks = new Map<string, Promise<void>>();

  generation(key: string): number {
    return this.generations.get(key) ?? 0;
  }

  isCurrent(key: string, expectedGeneration: number): boolean {
    return this.generation(key) === expectedGeneration;
  }

  acquire(key: string, externalSignal?: AbortSignal): CredentialFenceLease {
    const capturedGeneration = this.generation(key);
    const controller = new AbortController();
    let set = this.activeControllers.get(key);
    if (!set) {
      set = new Set();
      this.activeControllers.set(key, set);
    }
    set.add(controller);

    const cleanup = () => {
      const currentSet = this.activeControllers.get(key);
      currentSet?.delete(controller);
      if (currentSet && currentSet.size === 0) {
        this.activeControllers.delete(key);
      }
      externalSignal?.removeEventListener("abort", onExternalAbort);
    };
    const onExternalAbort = () => {
      controller.abort(externalSignal?.reason);
      cleanup();
    };
    if (externalSignal) {
      if (externalSignal.aborted) {
        controller.abort(externalSignal.reason);
        cleanup();
      } else {
        externalSignal.addEventListener("abort", onExternalAbort, { once: true });
      }
    }

    return {
      key,
      generation: capturedGeneration,
      signal: controller.signal,
      isCurrent: () => this.generation(key) === capturedGeneration && !controller.signal.aborted,
      assertCurrent: () => {
        if (this.generation(key) !== capturedGeneration) {
          throw new SecretStoreUnavailableError(
            "SECRET_FENCE_STALE",
            `Credential fence generation for "${key}" is stale (${capturedGeneration} !== ${this.generation(key)})`,
          );
        }
      },
      release: cleanup,
    };
  }

  invalidate(key: string, reason = "credential invalidated"): number {
    const next = this.generation(key) + 1;
    this.generations.set(key, next);
    const controllers = this.activeControllers.get(key);
    if (controllers) {
      this.activeControllers.delete(key);
      const abortErr = new SecretStoreUnavailableError(
        "SECRET_FENCE_STALE",
        `Credential operation aborted for "${key}": ${reason}`,
      );
      for (const controller of controllers) {
        controller.abort(abortErr);
      }
    }
    return next;
  }

  private async runSerialized<T>(key: string, operation: () => Promise<T>): Promise<T> {
    const previous = this.keyLocks.get(key) ?? Promise.resolve();
    let releaseLock!: () => void;
    const gate = new Promise<void>((resolve) => {
      releaseLock = resolve;
    });
    const tail = previous.catch(() => undefined).then(() => gate);
    this.keyLocks.set(key, tail);
    await previous.catch(() => undefined);
    try {
      return await operation();
    } finally {
      releaseLock();
      if (this.keyLocks.get(key) === tail) {
        this.keyLocks.delete(key);
      }
    }
  }

  async writeIfCurrent(
    store: SecretStore,
    key: string,
    ref: string,
    value: string,
    expectedGeneration: number,
  ): Promise<void> {
    await this.runSerialized(key, async () => {
      if (!this.isCurrent(key, expectedGeneration)) {
        throw new SecretStoreUnavailableError(
          "SECRET_FENCE_STALE",
          `Refused stale credential write-back for "${key}" (expected generation ${expectedGeneration}, current ${this.generation(key)})`,
        );
      }
      await store.set(ref, value);
      if (!this.isCurrent(key, expectedGeneration)) {
        await store.delete(ref).catch(() => undefined);
        throw new SecretStoreUnavailableError(
          "SECRET_FENCE_STALE",
          `Credential for "${key}" was invalidated while write-back was in flight`,
        );
      }
    });
  }

  async deleteAndInvalidate(
    store: SecretStore,
    key: string,
    ref: string,
    reason = "logout or channel deleted",
  ): Promise<number> {
    const nextGeneration = this.invalidate(key, reason);
    await this.runSerialized(key, async () => {
      await store.delete(ref);
    });
    return nextGeneration;
  }
}
