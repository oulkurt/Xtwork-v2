/**
 * Tiered companion memory directory layout and cross-scope write protection (ADR-011 §4 & §5.3 L3).
 *
 * Directory layout under `<companionDir>`:
 *   - `ROLE.md`                         (public role definition shared across private & group chats)
 *   - `private/MEMORY.md`, `private/notes/`  (Owner private memory shared across all IM DMs)
 *   - `groups/<chatKey>/MEMORY.md`, `groups/<chatKey>/notes/` (per-group isolated memory)
 *
 * Security invariants:
 * - Group turns NEVER auto-load `private/` unless `allowPrivateInGroup` is explicitly enabled.
 * - Cross-scope writes (including via file tools, memory MCP tools, or background `tidy`)
 *   require explicit Owner single-use approval.
 * - `MEMORY.md` carries a 64 KB soft limit check to trigger tidy hints.
 */

import { existsSync, lstatSync, mkdirSync, readdirSync, readFileSync, readlinkSync, realpathSync, statSync } from "node:fs";
import { dirname, isAbsolute, join, relative, resolve, sep } from "node:path";

/** Soft limit for `MEMORY.md` size before suggesting a tidy pass (64 KB). */
export const MEMORY_SOFT_LIMIT_BYTES = 64 * 1024;

export interface CompanionPaths {
  readonly root: string;
  readonly roleFile: string;
  readonly privateDir: string;
  readonly privateMemoryFile: string;
  readonly privateNotesDir: string;
  readonly groupsRoot: string;
  readonly groupDir?: string;
  readonly groupMemoryFile?: string;
  readonly groupNotesDir?: string;
}

/**
 * Validate and normalize a group `chatKey` into a safe single directory component.
 * Rejects empty strings, `.` / `..`, path separators, null bytes, or unsafe characters.
 */
export function sanitizeChatKey(chatKey: string): string {
  const trimmed = chatKey.trim();
  if (!trimmed || trimmed === "." || trimmed === "..") {
    throw new Error("Invalid companion chatKey: must be non-empty");
  }
  if (trimmed.includes("\0") || trimmed.includes("/") || trimmed.includes("\\") || trimmed.includes("..")) {
    throw new Error(`Invalid companion chatKey: unsafe path segment "${chatKey}"`);
  }
  const safe = trimmed.replace(/[^A-Za-z0-9._:-]/g, "_");
  if (!safe || safe === "." || safe === "..") {
    throw new Error(`Invalid companion chatKey: "${chatKey}"`);
  }
  return safe;
}

/** Resolve canonical paths for the tiered companion directory. */
export function companionPaths(companionDir: string, chatKey?: string): CompanionPaths {
  const root = resolve(companionDir);
  const privateDir = join(root, "private");
  const groupsRoot = join(root, "groups");
  const base: CompanionPaths = {
    root,
    roleFile: join(root, "ROLE.md"),
    privateDir,
    privateMemoryFile: join(privateDir, "MEMORY.md"),
    privateNotesDir: join(privateDir, "notes"),
    groupsRoot,
  };
  if (chatKey === undefined) return base;
  const safeKey = sanitizeChatKey(chatKey);
  const groupDir = join(groupsRoot, safeKey);
  return {
    ...base,
    groupDir,
    groupMemoryFile: join(groupDir, "MEMORY.md"),
    groupNotesDir: join(groupDir, "notes"),
  };
}

/** Ensure directory structure exists on disk for root/private and optional group scope. */
export function ensureCompanionLayout(companionDir: string, chatKey?: string): CompanionPaths {
  const paths = companionPaths(companionDir, chatKey);
  mkdirSync(paths.root, { recursive: true });
  mkdirSync(paths.privateNotesDir, { recursive: true });
  mkdirSync(paths.groupsRoot, { recursive: true });
  if (paths.groupNotesDir) {
    mkdirSync(paths.groupNotesDir, { recursive: true });
  }
  return paths;
}

export interface MemoryLimitStatus {
  readonly path: string;
  readonly exists: boolean;
  readonly bytes: number;
  readonly softLimitBytes: number;
  readonly exceeded: boolean;
}

/** Check whether a `MEMORY.md` file exceeds the 64 KB soft limit. */
export function checkMemoryLimit(filePath: string, softLimitBytes = MEMORY_SOFT_LIMIT_BYTES): MemoryLimitStatus {
  if (!existsSync(filePath)) {
    return { path: filePath, exists: false, bytes: 0, softLimitBytes, exceeded: false };
  }
  const bytes = statSync(filePath).size;
  return {
    path: filePath,
    exists: true,
    bytes,
    softLimitBytes,
    exceeded: bytes > softLimitBytes,
  };
}

export interface CompanionContext {
  readonly role: string | null;
  readonly privateMemory: string | null;
  readonly privateNotes: readonly string[];
  readonly groupMemory: string | null;
  readonly groupNotes: readonly string[];
  readonly limits: {
    readonly private?: MemoryLimitStatus;
    readonly group?: MemoryLimitStatus;
  };
}

function readOptionalFile(filePath: string): string | null {
  return existsSync(filePath) ? readFileSync(filePath, "utf8") : null;
}

function listNotes(dirPath: string): string[] {
  if (!existsSync(dirPath)) return [];
  return readdirSync(dirPath)
    .filter((f) => !f.startsWith("."))
    .sort();
}

/**
 * Load companion context respecting ADR-011 scope isolation:
 * - Private scope loads `ROLE.md` + `private/`.
 * - Group scope loads `ROLE.md` + `groups/<chatKey>/` ONLY; `private/` is NEVER loaded
 *   unless `allowPrivateInGroup` is explicitly `true`.
 */
export function loadCompanionContext(
  companionDir: string,
  opts: {
    readonly scope: "private" | "group";
    readonly chatKey?: string;
    readonly allowPrivateInGroup?: boolean;
  },
): CompanionContext {
  const paths = companionPaths(companionDir, opts.scope === "group" ? opts.chatKey : undefined);
  const role = readOptionalFile(paths.roleFile);
  if (opts.scope === "private") {
    return {
      role,
      privateMemory: readOptionalFile(paths.privateMemoryFile),
      privateNotes: listNotes(paths.privateNotesDir),
      groupMemory: null,
      groupNotes: [],
      limits: {
        private: checkMemoryLimit(paths.privateMemoryFile),
      },
    };
  }
  if (!paths.groupMemoryFile || !paths.groupNotesDir) {
    throw new Error("chatKey is required when loading group companion context");
  }
  const includePrivate = opts.allowPrivateInGroup === true;
  return {
    role,
    privateMemory: includePrivate ? readOptionalFile(paths.privateMemoryFile) : null,
    privateNotes: includePrivate ? listNotes(paths.privateNotesDir) : [],
    groupMemory: readOptionalFile(paths.groupMemoryFile),
    groupNotes: listNotes(paths.groupNotesDir),
    limits: {
      ...(includePrivate ? { private: checkMemoryLimit(paths.privateMemoryFile) } : {}),
      group: checkMemoryLimit(paths.groupMemoryFile),
    },
  };
}

// -------------------------------------------------- Cross-scope write policy (ADR-011 L3)

export type CompanionTargetScope =
  | { readonly kind: "shared_role" }
  | { readonly kind: "private" }
  | { readonly kind: "group"; readonly chatKey: string }
  | { readonly kind: "root_other" }
  | { readonly kind: "outside" };

export type WriteSourceScope =
  | { readonly kind: "desktop" }
  | { readonly kind: "owner_dm" }
  | { readonly kind: "group"; readonly chatKey: string };

export interface CompanionWriteDecision {
  readonly decision: "allow" | "require_owner_approval" | "deny";
  readonly reason: string;
  readonly targetScope: CompanionTargetScope;
  readonly resolvedTarget: string;
}

/**
 * Resolve canonical real path including dangling symlinks (prevents dangling-symlink escapes
 * where `existsSync` would return false even though the symlink inode itself points elsewhere).
 */
function resolveRealPath(targetPath: string, depth = 0): string {
  if (depth > 40) throw new Error("Too many symbolic links while resolving companion path");
  const abs = resolve(targetPath);
  const pending: string[] = [];
  let cursor = abs;
  for (;;) {
    try {
      const st = lstatSync(cursor);
      if (st.isSymbolicLink()) {
        const linkTarget = readlinkSync(cursor);
        const resolvedLink = isAbsolute(linkTarget) ? linkTarget : resolve(dirname(cursor), linkTarget);
        const fullTarget = pending.length ? join(resolvedLink, ...pending) : resolvedLink;
        return resolveRealPath(fullTarget, depth + 1);
      }
      const realBase = realpathSync(cursor);
      return pending.length ? join(realBase, ...pending) : realBase;
    } catch {
      const parent = dirname(cursor);
      if (parent === cursor) return abs;
      pending.unshift(cursor.slice(parent.length + (parent.endsWith(sep) ? 0 : 1)));
      cursor = parent;
    }
  }
}

function isInside(root: string, candidate: string): boolean {
  const rel = relative(root, candidate);
  return rel === "" || (!rel.startsWith("..") && !isAbsolute(rel));
}

/** Classify where `targetPath` falls within `<companionDir>` (symlink-safe). */
export function classifyCompanionPath(companionDir: string, targetPath: string): {
  readonly scope: CompanionTargetScope;
  readonly resolvedTarget: string;
} {
  const realRoot = resolveRealPath(companionDir);
  const resolvedTarget = resolveRealPath(targetPath);
  if (!isInside(realRoot, resolvedTarget)) {
    return { scope: { kind: "outside" }, resolvedTarget };
  }
  const rel = relative(realRoot, resolvedTarget);
  const segments = rel ? rel.split(sep) : [];
  if (segments.length === 1 && segments[0] === "ROLE.md") {
    return { scope: { kind: "shared_role" }, resolvedTarget };
  }
  if (segments[0] === "private") {
    return { scope: { kind: "private" }, resolvedTarget };
  }
  if (segments[0] === "groups" && segments.length >= 2 && segments[1]) {
    return { scope: { kind: "group", chatKey: segments[1] }, resolvedTarget };
  }
  return { scope: { kind: "root_other" }, resolvedTarget };
}

/**
 * Evaluate whether a turn from `sourceScope` may write to `targetPath` under `<companionDir>`.
 *
 * ADR-011 L3 policy:
 * - Writes outside `<companionDir>` are denied.
 * - A `group(X)` turn (including Owner speaking in group and `tidy` jobs running for group X)
 *   may only write directly inside `groups/X/`; ANY write to `ROLE.md`, `private/`, another
 *   group `groups/Y/`, or companion root requires Owner single-use approval.
 * - An `owner_dm` turn may write to `private/` and `ROLE.md`; writing into a shared group's
 *   memory requires Owner single-use approval to prevent accidental private-to-group leakage.
 * - Local `desktop` actions may write anywhere inside `<companionDir>`.
 */
export function evaluateCompanionWrite(input: {
  readonly companionDir: string;
  readonly sourceScope: WriteSourceScope;
  readonly targetPath: string;
  readonly viaTidy?: boolean;
}): CompanionWriteDecision {
  const { scope: targetScope, resolvedTarget } = classifyCompanionPath(input.companionDir, input.targetPath);
  if (targetScope.kind === "outside") {
    return {
      decision: "deny",
      reason: "target path is outside the companion directory",
      targetScope,
      resolvedTarget,
    };
  }
  if (input.sourceScope.kind === "desktop") {
    return { decision: "allow", reason: "desktop owner scope", targetScope, resolvedTarget };
  }
  if (input.sourceScope.kind === "owner_dm") {
    if (targetScope.kind === "private" || targetScope.kind === "shared_role") {
      return { decision: "allow", reason: "owner_dm writing private or role companion memory", targetScope, resolvedTarget };
    }
    return {
      decision: "require_owner_approval",
      reason: input.viaTidy
        ? "tidy cross-scope write from owner_dm to group scope requires owner approval"
        : "cross-scope write from owner_dm to group or root companion scope requires owner approval",
      targetScope,
      resolvedTarget,
    };
  }
  // Group source scope
  const sourceKey = sanitizeChatKey(input.sourceScope.chatKey);
  if (targetScope.kind === "group" && targetScope.chatKey === sourceKey) {
    return { decision: "allow", reason: "same-group companion memory write", targetScope, resolvedTarget };
  }
  return {
    decision: "require_owner_approval",
    reason: input.viaTidy
      ? `tidy cross-scope write from group:${sourceKey} to ${targetScope.kind} requires owner approval`
      : `cross-scope write from group:${sourceKey} to ${targetScope.kind} requires owner approval`,
    targetScope,
    resolvedTarget,
  };
}
