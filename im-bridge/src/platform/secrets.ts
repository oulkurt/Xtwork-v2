// @effect-diagnostics nodeBuiltinImport:off extendsNativeError:off -- OS SecretStore uses Node child_process, crypto, and fs and shares the standalone SecretStoreUnavailableError class.
/**
 * OS-backed secure credential storage (single canonical hardened contract for IM bridge & model channels).
 *
 * Adapted from earayu/Mingle (MIT, commit 006220e880d2134665ce2745ab6233f52c8eabe9),
 * src/platform/secrets.ts, hardened per ADR-011 L4 & ADR-012 §3.1:
 *
 * - Plaintext file fallback (`fileSecrets`) is EXPLICITLY ABSENT (fail-closed).
 * - Distinct error taxonomy: `missing` vs `unavailable` vs `denied` (never collapses
 *   arbitrary non-zero OS errors into `undefined` / `missing`).
 * - Verified `set(ref, value)` with read-back comparison.
 * - Verified `delete(ref)`: checks command exit code AND reads back to confirm `missing`;
 *   throws typed error if deletion fails or the secret remains readable.
 * - Independent service namespaces (`app.xtwork.im-bridge`, `app.xtwork.model-channels`).
 * - Concurrency fencing token (`ChannelCredentialFence`) preventing in-flight OAuth refresh
 *   write-backs from resurrecting credentials deleted by a concurrent logout or channel removal.
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
  readonly killed?: boolean;
  readonly signal?: NodeJS.Signals | null;
  readonly timedOut?: boolean;
}

export type CommandRunner = (
  file: string,
  args: string[],
  stdin: string,
  timeoutMs?: number,
) => Promise<CommandResult>;

const DEFAULT_SERVICE = IM_BRIDGE_SECRET_NAMESPACE;
const SECURITY = "/usr/bin/security";

/** Base64 characters per Keychain item: `security -i` reads at most 4095 characters per command line. */
const CHUNK = 3000;

function isCommandInterrupted(result: CommandResult): boolean {
  return Boolean(
    result.killed ||
      result.timedOut ||
      (result.signal !== undefined && result.signal !== null),
  );
}

function interruptedReason(result: CommandResult): string {
  if (result.timedOut) return "timed out";
  if (result.signal) return `terminated by signal ${result.signal}`;
  return "was killed before completion";
}

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
          finish({ code: 0, stdout, stderr, killed: false, signal: null, timedOut: false });
          return;
        }
        const execErr = error as NodeJS.ErrnoException & {
          code?: unknown;
          killed?: boolean;
          signal?: NodeJS.Signals | null;
        };
        const killed = Boolean(execErr.killed);
        const signal = execErr.signal ?? null;
        const timedOut = execErr.code === "ETIMEDOUT" || (killed && signal === "SIGTERM");
        if (execErr.code === "ENOENT") {
          finish({
            code: 127,
            stdout: stdout ?? "",
            stderr: stderr ?? error.message,
            killed: false,
            signal: null,
            timedOut: false,
          });
          return;
        }
        const numeric =
          typeof execErr.code === "number" && Number.isFinite(execErr.code) ? execErr.code : 1;
        finish({
          code: numeric,
          stdout: stdout ?? "",
          stderr: stderr ?? (killed || signal !== null ? "" : error.message),
          killed,
          signal,
          timedOut,
        });
      },
    );
    child.on("error", (err) => {
      const errCode = (err as NodeJS.ErrnoException).code;
      finish({
        code: errCode === "ENOENT" ? 127 : 1,
        stdout: "",
        stderr: err.message,
        killed: false,
        signal: null,
        timedOut: false,
      });
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

/**
 * macOS Keychain through `/usr/bin/security`.
 * Secrets are passed via stdin (`-i`, never argv), base64-encoded (`b64:`) or chunked (`parts:<n>`),
 * writes are verified by read-back, deletes check exit code AND confirm `missing` via read-back,
 * and non-`errSecItemNotFound` (44) failures are NEVER collapsed into `missing`.
 */
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
    const res = await run(
      SECURITY,
      ["find-generic-password", "-s", service, "-a", account, "-w"],
      "",
    );
    if (isCommandInterrupted(res)) {
      return {
        status: "unavailable",
        error: new SecretStoreUnavailableError(
          "SECRET_STORE_UNAVAILABLE",
          `macOS Keychain read ${interruptedReason(res)}`,
        ),
      };
    }
    const { code, stdout, stderr } = res;
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

  interface KeychainChunkSet {
    readonly gen: number | null;
    readonly count: number;
  }

  type ParsedKeychainManifest =
    | {
        readonly kind: "b64";
        readonly b64: string;
        readonly prev: readonly KeychainChunkSet[];
        readonly pending: readonly KeychainChunkSet[];
      }
    | {
        readonly kind: "chunks";
        readonly active: KeychainChunkSet;
        readonly prev: readonly KeychainChunkSet[];
        readonly pending: readonly KeychainChunkSet[];
      }
    | {
        readonly kind: "pending_only";
        readonly prev: readonly KeychainChunkSet[];
        readonly pending: readonly KeychainChunkSet[];
      }
    | {
        readonly kind: "legacy";
        readonly raw: string;
        readonly prev: readonly KeychainChunkSet[];
        readonly pending: readonly KeychainChunkSet[];
      };

  const formatChunkSet = (spec: KeychainChunkSet): string =>
    spec.gen === null ? `legacy:${spec.count}` : `g${spec.gen}:${spec.count}`;

  const chunkAccountName = (ref: string, spec: KeychainChunkSet, index: number): string =>
    spec.gen === null ? `${ref}#${index}` : `${ref}#g${spec.gen}#${index}`;

  const dedupeChunkSets = (sets: readonly KeychainChunkSet[]): KeychainChunkSet[] => {
    const seen = new Set<string>();
    const out: KeychainChunkSet[] = [];
    for (const spec of sets) {
      if (spec.count <= 0) continue;
      const key = formatChunkSet(spec);
      if (seen.has(key)) continue;
      seen.add(key);
      out.push(spec);
    }
    return out;
  };

  const parseChunkSetList = (rawList: string): KeychainChunkSet[] => {
    const out: KeychainChunkSet[] = [];
    for (const token of rawList.split(",")) {
      const trimmed = token.trim();
      if (!trimmed) continue;
      const genMatch = /^g(\d+):(\d+)$/.exec(trimmed);
      if (genMatch) {
        const count = Number(genMatch[2]);
        if (count > 0) out.push({ gen: Number(genMatch[1]), count });
        continue;
      }
      const legacyMatch = /^legacy:(\d+)$/.exec(trimmed);
      if (legacyMatch) {
        const count = Number(legacyMatch[1]);
        if (count > 0) out.push({ gen: null, count });
      }
    }
    return out;
  };

  const parseManifest = (stored: string): ParsedKeychainManifest => {
    const segments = stored.split(";");
    const head = segments[0] ?? "";
    const prev: KeychainChunkSet[] = [];
    const pending: KeychainChunkSet[] = [];
    for (let i = 1; i < segments.length; i++) {
      const seg = segments[i]!;
      if (seg.startsWith("prev:")) {
        prev.push(...parseChunkSetList(seg.slice("prev:".length)));
      } else if (seg.startsWith("pending:")) {
        pending.push(...parseChunkSetList(seg.slice("pending:".length)));
      }
    }

    if (head.startsWith("pending:")) {
      pending.unshift(...parseChunkSetList(head.slice("pending:".length)));
      return { kind: "pending_only", prev: dedupeChunkSets(prev), pending: dedupeChunkSets(pending) };
    }
    const genParts = /^parts:g(\d+):(\d+)$/.exec(head);
    if (genParts) {
      return {
        kind: "chunks",
        active: { gen: Number(genParts[1]), count: Number(genParts[2]) },
        prev: dedupeChunkSets(prev),
        pending: dedupeChunkSets(pending),
      };
    }
    const legacyParts = /^parts:(\d+)$/.exec(head);
    if (legacyParts) {
      return {
        kind: "chunks",
        active: { gen: null, count: Number(legacyParts[1]) },
        prev: dedupeChunkSets(prev),
        pending: dedupeChunkSets(pending),
      };
    }
    if (head.startsWith("b64:")) {
      return {
        kind: "b64",
        b64: head.slice(4),
        prev: dedupeChunkSets(prev),
        pending: dedupeChunkSets(pending),
      };
    }
    return { kind: "legacy", raw: stored, prev: [], pending: [] };
  };

  const formatManifestString = (
    head: string | null,
    prev: readonly KeychainChunkSet[],
    pending: readonly KeychainChunkSet[],
  ): string => {
    const cleanPrev = dedupeChunkSets(prev);
    const cleanPending = dedupeChunkSets(pending);
    const partsOut: string[] = [];
    if (head !== null) {
      partsOut.push(head);
      if (cleanPrev.length > 0) partsOut.push(`prev:${cleanPrev.map(formatChunkSet).join(",")}`);
      if (cleanPending.length > 0) {
        partsOut.push(`pending:${cleanPending.map(formatChunkSet).join(",")}`);
      }
    } else {
      partsOut.push(`pending:${cleanPending.map(formatChunkSet).join(",")}`);
      if (cleanPrev.length > 0) partsOut.push(`prev:${cleanPrev.map(formatChunkSet).join(",")}`);
    }
    return partsOut.join(";");
  };

  const maxGeneration = (manifest: ParsedKeychainManifest | null): number => {
    if (!manifest) return 0;
    let max = 0;
    if (manifest.kind === "chunks" && manifest.active.gen !== null) {
      max = Math.max(max, manifest.active.gen);
    }
    for (const spec of manifest.prev) {
      if (spec.gen !== null) max = Math.max(max, spec.gen);
    }
    for (const spec of manifest.pending) {
      if (spec.gen !== null) max = Math.max(max, spec.gen);
    }
    return max;
  };

  const runBatchAdd = async (commands: readonly string[]): Promise<void> => {
    const writeResult = await run(SECURITY, ["-i"], `${commands.join("\n")}\n`);
    if (isCommandInterrupted(writeResult)) {
      throw new SecretStoreUnavailableError(
        "SECRET_STORE_UNAVAILABLE",
        `macOS Keychain write ${interruptedReason(writeResult)}`,
      );
    }
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
  };

  /**
   * Delete a single Keychain account directly (no secret value in argv) and confirm via read-back
   * that it is `missing`. Unlike `security -i`, executing one item at a time prevents a later
   * exit status from masking an earlier failure.
   */
  const deleteOneAccount = async (account: string): Promise<void> => {
    validateRef(account);
    const delResult = await run(
      SECURITY,
      ["delete-generic-password", "-s", service, "-a", account],
      "",
    );
    if (isCommandInterrupted(delResult)) {
      throw new SecretStoreUnavailableError(
        "SECRET_STORE_UNAVAILABLE",
        `macOS Keychain delete ${interruptedReason(delResult)}`,
      );
    }
    if (delResult.code === 127) {
      throw new SecretStoreUnavailableError(
        "SECRET_STORE_UNAVAILABLE",
        "macOS Keychain tool (/usr/bin/security) is unavailable",
      );
    }
    if (delResult.code !== 0 && delResult.code !== 44) {
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
  };

  const read = async (ref: string): Promise<SecretReadResult> => {
    const raw = await readRaw(ref);
    if (raw.status !== "found") return raw;

    const manifest = parseManifest(raw.value);
    if (manifest.kind === "pending_only") {
      return { status: "missing" };
    }
    if (manifest.kind === "chunks") {
      const { active } = manifest;
      let joined = "";
      for (let i = 1; i <= active.count; i++) {
        const part = await readRaw(chunkAccountName(ref, active, i));
        if (part.status === "unavailable" || part.status === "denied") {
          return part;
        }
        if (part.status === "missing") {
          return {
            status: "unavailable",
            error: new SecretStoreUnavailableError(
              "SECRET_DECRYPT_FAILED",
              `macOS Keychain chunk ${i}/${active.count} is missing for credential entry`,
            ),
          };
        }
        joined += part.value;
      }
      return { status: "found", value: Buffer.from(joined, "base64").toString("utf8") };
    }
    if (manifest.kind === "b64") {
      return { status: "found", value: Buffer.from(manifest.b64, "base64").toString("utf8") };
    }
    if (/^(?:[0-9a-f]{2})+$/i.test(manifest.raw)) {
      return { status: "found", value: Buffer.from(manifest.raw, "hex").toString("utf8") };
    }
    return { status: "found", value: manifest.raw };
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
      const prevManifest = existing.status === "found" ? parseManifest(existing.value) : null;
      const existingHead: string | null =
        prevManifest === null || prevManifest.kind === "pending_only"
          ? null
          : prevManifest.kind === "chunks"
            ? prevManifest.active.gen === null
              ? `parts:${prevManifest.active.count}`
              : `parts:g${prevManifest.active.gen}:${prevManifest.active.count}`
            : prevManifest.kind === "b64"
              ? `b64:${prevManifest.b64}`
              : prevManifest.raw;
      const priorPrev = prevManifest ? [...prevManifest.prev] : [];
      const priorPending = prevManifest ? [...prevManifest.pending] : [];
      const prevToCleanup = dedupeChunkSets([
        ...priorPrev,
        ...priorPending,
        ...(prevManifest && prevManifest.kind === "chunks" ? [prevManifest.active] : []),
      ]);
      const nextGen = maxGeneration(prevManifest) + 1;

      const encoded = Buffer.from(value, "utf8").toString("base64");
      const add = (account: string, data: string) =>
        `add-generic-password -s ${quote(service)} -a ${quote(account)} -U -w "${data}"`;

      let cleanHead: string;
      if (encoded.length <= CHUNK) {
        cleanHead = `b64:${encoded}`;
      } else {
        const expectedSlices: Array<{ readonly account: string; readonly slice: string }> = [];
        const chunkCommands: string[] = [];
        let count = 0;
        for (let at = 0; at < encoded.length; at += CHUNK) {
          count++;
          const account = chunkAccountName(ref, { gen: nextGen, count }, count);
          const slice = encoded.slice(at, at + CHUNK);
          chunkCommands.push(add(account, slice));
          expectedSlices.push({ account, slice });
        }
        const pendingSpec: KeychainChunkSet = { gen: nextGen, count };

        // Phase 0 (Write-Ahead Pending Manifest): record `;pending:g<nextGen>:<count>` in the
        // root manifest AND verify it is persisted BEFORE writing ANY new chunk. If writing or
        // verifying chunk #2 fails, chunk #1 is still tracked by the manifest for rollback/delete!
        const walManifest = formatManifestString(
          existingHead,
          priorPrev,
          [...priorPending, pendingSpec],
        );
        await runBatchAdd([add(ref, walManifest)]);
        const walVerify = await readRaw(ref);
        if (walVerify.status === "unavailable" || walVerify.status === "denied") {
          throw walVerify.error;
        }
        if (walVerify.status !== "found" || walVerify.value !== walManifest) {
          throw new SecretStoreUnavailableError(
            "SECRET_WRITE_VERIFY_FAILED",
            "Could not persist write-ahead pending manifest in macOS Keychain",
          );
        }

        // Phase 1: write and verify every new generation-tagged chunk.
        try {
          await runBatchAdd(chunkCommands);
          for (const { account, slice } of expectedSlices) {
            const check = await readRaw(account);
            if (check.status === "unavailable" || check.status === "denied") {
              throw check.error;
            }
            if (check.status !== "found" || check.value !== slice) {
              throw new SecretStoreUnavailableError(
                "SECRET_WRITE_VERIFY_FAILED",
                "Could not verify new chunk written to macOS Keychain",
              );
            }
          }
        } catch (writeErr) {
          // Best-effort cleanup of partially written pending chunks; strip `pendingSpec` from
          // the manifest ONLY if every chunk of `pendingSpec` is read-back confirmed `missing`.
          // If cleanup fails, `pendingSpec` remains tracked in the manifest for retry / delete().
          let allRolledBack = true;
          for (const { account } of expectedSlices) {
            try {
              await deleteOneAccount(account);
            } catch {
              allRolledBack = false;
            }
          }
          if (allRolledBack) {
            if (existingHead === null && priorPrev.length === 0 && priorPending.length === 0) {
              await deleteOneAccount(ref).catch(() => undefined);
            } else {
              const restored = formatManifestString(existingHead, priorPrev, priorPending);
              await runBatchAdd([add(ref, restored)]).catch(() => undefined);
            }
          }
          throw writeErr;
        }
        cleanHead = `parts:g${nextGen}:${count}`;
      }

      // Phase 2: commit active manifest recording all previous/pending cleanup sets UNTIL every
      // old chunk is individually deleted and read-back verified `missing`.
      const manifestWithPrev = formatManifestString(cleanHead, prevToCleanup, []);
      await runBatchAdd([add(ref, manifestWithPrev)]);
      if ((await store.get(ref)) !== value) {
        throw new SecretStoreUnavailableError(
          "SECRET_WRITE_VERIFY_FAILED",
          "Could not save and verify credentials in macOS Keychain",
        );
      }

      if (prevToCleanup.length > 0) {
        for (const spec of prevToCleanup) {
          for (let i = 1; i <= spec.count; i++) {
            await deleteOneAccount(chunkAccountName(ref, spec, i));
          }
        }
        // Phase 3: strip `;prev:` ONLY AFTER every previous/pending chunk is confirmed missing.
        await runBatchAdd([add(ref, cleanHead)]);
        if ((await store.get(ref)) !== value) {
          throw new SecretStoreUnavailableError(
            "SECRET_WRITE_VERIFY_FAILED",
            "Could not finalize cleaned manifest in macOS Keychain",
          );
        }
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
      const manifest = parseManifest(existing.value);
      const chunkSetsToDelete = dedupeChunkSets([
        ...(manifest.kind === "chunks" ? [manifest.active] : []),
        ...manifest.prev,
        ...manifest.pending,
      ]);
      // Delete and verify EACH active, prev, AND pending chunk individually BEFORE deleting
      // the root manifest, so no chunk secret can ever be orphaned.
      for (const spec of chunkSetsToDelete) {
        for (let i = 1; i <= spec.count; i++) {
          await deleteOneAccount(chunkAccountName(ref, spec, i));
        }
      }
      await deleteOneAccount(ref);
    },
  };
  return store;
}

const DPAPI_PREFIX = "dpapi:";

/**
 * Windows DPAPI (`CurrentUser`) credential store.
 * Ciphertext blobs are persisted in an encrypted-only blob file (strictly prefixed with `dpapi:`).
 * Never writes or reads plaintext; verifies decrypt round-trip on every write and confirms
 * removal from disk on every delete.
 */
export function windowsSecrets(sealedBlobPath: string, run: CommandRunner = runWith): SecretStore {
  // No store-level plaintext cache: reads always decrypt fresh from disk and are fenced
  // against concurrent deletes/writes via per-ref mutation generations + serialized disk writes.
  const mutationGen = new Map<string, number>();
  let writeLock: Promise<void> = Promise.resolve();

  const bumpMutationGen = (ref: string) => {
    mutationGen.set(ref, (mutationGen.get(ref) ?? 0) + 1);
  };

  const runWriteSerialized = async <T>(op: () => Promise<T>): Promise<T> => {
    const previous = writeLock;
    let release!: () => void;
    const gate = new Promise<void>((resolve) => {
      release = resolve;
    });
    writeLock = previous.catch(() => undefined).then(() => gate);
    await previous.catch(() => undefined);
    try {
      return await op();
    } finally {
      release();
    }
  };

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
    const res = await run(
      "powershell.exe",
      ["-NoProfile", "-NonInteractive", "-Command", script],
      base64,
    );
    if (isCommandInterrupted(res)) {
      throw new SecretStoreUnavailableError(
        "SECRET_STORE_UNAVAILABLE",
        `Windows DPAPI ${op} ${interruptedReason(res)}`,
      );
    }
    const { code, stdout, stderr } = res;
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
    for (let attempt = 0; attempt < 3; attempt++) {
      const genBefore = mutationGen.get(ref) ?? 0;
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
      let value: string;
      try {
        const unsealed = await dpapi("Unprotect", sealed.slice(DPAPI_PREFIX.length));
        value = Buffer.from(unsealed, "base64").toString("utf8");
      } catch (error) {
        if (error instanceof SecretStoreUnavailableError) {
          if (error.kind === "denied") return { status: "denied", error };
          return { status: "unavailable", error };
        }
        throw error;
      }
      // Re-verify fence after async DPAPI decrypt so a concurrent delete/overwrite cannot
      // surface stale deleted plaintext.
      if ((mutationGen.get(ref) ?? 0) !== genBefore) {
        let afterMap: Record<string, string>;
        try {
          afterMap = readSealedMap();
        } catch (error) {
          if (error instanceof SecretStoreUnavailableError) {
            if (error.kind === "denied") return { status: "denied", error };
            return { status: "unavailable", error };
          }
          throw error;
        }
        if (!(ref in afterMap)) {
          return { status: "missing" };
        }
        continue;
      }
      return { status: "found", value };
    }
    return {
      status: "unavailable",
      error: new SecretStoreUnavailableError(
        "SECRET_FENCE_STALE",
        "Windows DPAPI credential changed concurrently during read",
      ),
    };
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
      await runWriteSerialized(async () => {
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
        // Verify entry exists on disk after write.
        const persisted = readSealedMap()[ref];
        if (persisted !== `${DPAPI_PREFIX}${protectedB64}`) {
          throw new SecretStoreUnavailableError(
            "SECRET_WRITE_VERIFY_FAILED",
            "Windows DPAPI persisted blob verification failed",
          );
        }
        bumpMutationGen(ref);
      });
    },
    async delete(ref) {
      validateRef(ref);
      bumpMutationGen(ref);
      await runWriteSerialized(async () => {
        const current = readSealedMap();
        if (!(ref in current)) {
          bumpMutationGen(ref);
          return;
        }
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
        // Read-back confirmation from disk.
        const after = readSealedMap();
        if (ref in after) {
          throw new SecretStoreUnavailableError(
            "SECRET_DELETE_VERIFY_FAILED",
            "Windows DPAPI credential still present after delete verification",
          );
        }
        bumpMutationGen(ref);
      });
    },
  };
}

/**
 * Linux Secret Service (GNOME Keyring / KWallet) through `secret-tool`.
 *
 * Strictly fail-closed with ZERO plaintext file fallback. Distinguishes `missing`
 * (exit code 1 with empty stderr) from `denied` and `unavailable`, verifies writes
 * via read-back, and verifies deletes via both exit code and read-back confirmation.
 */
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
      if (isCommandInterrupted(stored)) {
        return {
          ok: false as const,
          error: new SecretStoreUnavailableError(
            "SECRET_STORE_UNAVAILABLE",
            `Linux Secret Service probe ${interruptedReason(stored)}`,
          ),
        };
      }
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
      if (!isCommandInterrupted(verify) && verify.code === 0 && verify.stdout === "ok") {
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
    const res = await run("secret-tool", ["lookup", ...attrs(ref)], "");
    if (isCommandInterrupted(res)) {
      return {
        status: "unavailable",
        error: new SecretStoreUnavailableError(
          "SECRET_STORE_UNAVAILABLE",
          `Linux Secret Service lookup ${interruptedReason(res)}`,
        ),
      };
    }
    const { code, stdout, stderr } = res;
    if (code === 0) {
      return { status: "found", value: stdout };
    }
    const detail = sanitizeErrorDetail(stderr);
    // A completed `secret-tool lookup` returns exit code 1 with empty stderr ONLY when absent.
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
      if (isCommandInterrupted(stored)) {
        throw new SecretStoreUnavailableError(
          "SECRET_STORE_UNAVAILABLE",
          `Linux Secret Service write ${interruptedReason(stored)}`,
        );
      }
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
      if (isCommandInterrupted(cleared)) {
        throw new SecretStoreUnavailableError(
          "SECRET_STORE_UNAVAILABLE",
          `Linux Secret Service delete ${interruptedReason(cleared)}`,
        );
      }
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
        // `secret-tool clear` may return exit code 1 with empty stderr when the entry is already
        // absent. Fall through ONLY in that exact case to a completed lookup verification; any
        // other exit code or non-empty stderr fails immediately.
        if (!(cleared.code === 1 && detail.length === 0)) {
          throw new SecretStoreUnavailableError(
            "SECRET_DELETE_VERIFY_FAILED",
            `Could not delete credentials from Linux Secret Service${detail ? ` (${detail})` : ` (exit code ${cleared.code})`}`,
          );
        }
      }
      // Read-back confirmation via a completed lookup: item MUST be confirmed missing.
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

/**
 * Factory creating an OS-backed SecretStore bound to a specific namespace
 * (e.g. `app.xtwork.im-bridge` or `app.xtwork.model-channels`).
 * Fails closed on unsupported platforms without any plaintext file fallback.
 */
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

/**
 * Select the OS secure credential store for the current platform.
 * Fails closed on unsupported platforms without any plaintext file fallback.
 */
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

/**
 * Concurrency fencing guard (generation token + abort + per-key write/delete serialization).
 *
 * Prevents an in-flight OAuth refresh from writing stale refreshed tokens back to the OS
 * SecretStore after a concurrent logout or channel deletion has invalidated that key.
 */
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

  /**
   * Persist `value` into `store` ONLY if `expectedGeneration` still matches the key's current
   * generation. Serialized against `deleteAndInvalidate` so late write-backs can never
   * resurrect deleted credentials.
   */
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
        // Invalidated concurrently while `store.set` was in flight: delete immediately so
        // the stale write cannot survive even if caller only called `invalidate()`.
        await store.delete(ref).catch(() => undefined);
        throw new SecretStoreUnavailableError(
          "SECRET_FENCE_STALE",
          `Credential for "${key}" was invalidated while write-back was in flight`,
        );
      }
    });
  }

  /**
   * Atomically bump the fencing generation (aborting all in-flight refreshes) and run a
   * verified `store.delete(ref)` serialized after any currently running write.
   */
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
