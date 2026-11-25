// @effect-diagnostics nodeBuiltinImport:off globalTimers:off globalDate:off globalDateInEffect:off globalJsonInEffect:off effectTryWithoutCatch:off globalErrorInEffectCatch:off globalErrorInEffectFailure:off effectFnOpportunity:off deterministicKeys:off matchBooleanToIsSuccess:off
import { access, lstat, mkdir, readdir, readFile, rename, rm, writeFile } from "node:fs/promises";
import { randomUUID } from "node:crypto";
import { dirname, join } from "node:path";
import { DEFAULT_LEADER_ID, scopedPath, type CompanionScope, type MemoryScope } from "./XtworkImSecurity.ts";

export const MAX_COMPANION_FILE_BYTES = 65_536;

export function memoryScope(value: unknown): MemoryScope {
  if (value === "role" || value === "private") return value;
  if (typeof value === "string" && /^group:[a-zA-Z0-9_-]{1,160}$/u.test(value)) {
    return value as MemoryScope;
  }
  throw new Error("Unknown companion memory scope.");
}

export function validateLeaderId(leaderId: string): string {
  if (!/^[a-zA-Z0-9_-]{1,64}$/u.test(leaderId)) {
    throw new Error("Invalid leader ID.");
  }
  return leaderId;
}

async function exists(path: string): Promise<boolean> {
  try {
    await access(path);
    return true;
  } catch {
    return false;
  }
}

/**
 * Recursively copy individual missing files from `src` into `dst` without ever overwriting
 * existing files in `dst`. Safe to resume after partial/interrupted migrations (S10).
 */
async function copyMissingEntries(src: string, dst: string): Promise<void> {
  let stat;
  try {
    stat = await lstat(src);
  } catch (error) {
    if (error instanceof Error && "code" in error && error.code === "ENOENT") return;
    throw error;
  }
  if (stat.isSymbolicLink()) return;
  if (stat.isFile()) {
    if (await exists(dst)) return;
    await mkdir(dirname(dst), { recursive: true, mode: 0o700 });
    const data = await readFile(src);
    const temp = join(dirname(dst), `.${randomUUID()}.migrate.tmp`);
    try {
      await writeFile(temp, data, { flag: "wx", mode: 0o600 });
      if (await exists(dst)) return;
      await rename(temp, dst);
    } finally {
      await rm(temp, { force: true });
    }
    return;
  }
  if (stat.isDirectory()) {
    await mkdir(dst, { recursive: true, mode: 0o700 });
    const entries = await readdir(src, { withFileTypes: true });
    for (const entry of entries) {
      if (entry.isSymbolicLink()) continue;
      await copyMissingEntries(join(src, entry.name), join(dst, entry.name));
    }
  }
}

export class XtworkImMemory {
  private readonly root: string;
  private migrated = false;

  constructor(root: string) {
    this.root = root;
  }

  /**
   * Idempotently migrate legacy ADR-011 root companion files (`ROLE.md`, `private/`, `groups/`)
   * into `leaders/<defaultLeaderId>/` per ADR-013 §5. Copies missing files individually so an
   * interrupted migration finishes cleanly on restart without ever clobbering existing Leader files.
   */
  async ensureMigrated(defaultLeaderId = DEFAULT_LEADER_ID): Promise<void> {
    if (this.migrated) return;
    const leaderId = validateLeaderId(defaultLeaderId);
    await mkdir(this.root, { recursive: true, mode: 0o700 });
    const leaderDir = await scopedPath(this.root, join("leaders", leaderId));
    await mkdir(leaderDir, { recursive: true, mode: 0o700 });

    const legacyItems = ["ROLE.md", "private", "groups"] as const;
    for (const item of legacyItems) {
      const src = join(this.root, item);
      const dst = join(leaderDir, item);
      if (await exists(src)) {
        await copyMissingEntries(src, dst);
      }
    }
    this.migrated = true;
  }

  private async path(scope: MemoryScope, note?: string, leaderId = DEFAULT_LEADER_ID) {
    await this.ensureMigrated();
    const safeLeader = validateLeaderId(leaderId);
    if (note !== undefined && (scope === "role" || !/^[\p{L}\p{N}_-]{1,100}\.md$/u.test(note))) {
      throw new Error("Expected a Markdown note name.");
    }
    const leaderRoot = join("leaders", safeLeader);
    const folder =
      scope === "role"
        ? leaderRoot
        : scope === "private"
          ? join(leaderRoot, "private")
          : join(leaderRoot, "groups", scope.slice(6));
    await mkdir(this.root, { recursive: true, mode: 0o700 });
    return scopedPath(
      this.root,
      join(folder, note === undefined ? (scope === "role" ? "ROLE.md" : "MEMORY.md") : join("notes", note)),
    );
  }

  async read(scope: MemoryScope, note?: string, leaderId = DEFAULT_LEADER_ID) {
    const path = await this.path(scope, note, leaderId);
    try {
      return (await readFile(path, "utf8")).slice(0, 65_536);
    } catch (error) {
      if (error instanceof Error && "code" in error && error.code === "ENOENT") return "";
      throw error;
    }
  }

  async write(scope: MemoryScope, text: string, note?: string, leaderId = DEFAULT_LEADER_ID) {
    if (Buffer.byteLength(text) > MAX_COMPANION_FILE_BYTES) throw new Error("Companion files must fit within 64 KiB.");
    const path = await this.path(scope, note, leaderId);
    await mkdir(dirname(path), { recursive: true, mode: 0o700 });
    const temp = join(dirname(path), `.${randomUUID()}.tmp`);
    try {
      await writeFile(temp, text, { flag: "wx", mode: 0o600 });
      await rename(temp, path);
    } finally {
      await rm(temp, { force: true });
    }
  }

  /**
   * Copy an Owner-approved private content snapshot into a specific group's notes directory
   * (ADR-013 §4: snapshot-bound share, never grants live read access to `private/`).
   */
  async writeSharedSnapshot(
    targetScope: CompanionScope,
    snapshotHash: string,
    content: string,
    leaderId = DEFAULT_LEADER_ID,
  ): Promise<string> {
    if (!targetScope.startsWith("group:")) {
      throw new Error("Shared snapshots must target a group scope.");
    }
    const shortHash = snapshotHash.replace(/[^a-f0-9]/giu, "").slice(0, 12) || "snapshot";
    const note = `shared-${shortHash}.md`;
    await this.write(targetScope, content, note, leaderId);
    return note;
  }
}
