// @effect-diagnostics nodeBuiltinImport:off globalTimers:off globalDate:off globalDateInEffect:off globalJsonInEffect:off effectTryWithoutCatch:off globalErrorInEffectCatch:off globalErrorInEffectFailure:off effectFnOpportunity:off deterministicKeys:off matchBooleanToIsSuccess:off
import * as Effect from "effect/Effect";
import * as SqlClient from "effect/sql/SqlClient";
import { randomUUID } from "node:crypto";
import {
  DEFAULT_IM_DELEGATION_POLICY,
  DEFAULT_LEADER_ID,
  LEADER_ARCHIVED_ERROR,
  LEADER_PAUSED_ERROR,
  imError,
  isImThread,
  normalizeExecutionContext,
  sanitizeImDelegationPolicy,
  type AwarenessScope,
  type ImDelegationPolicy,
  type TurnExecutionContext,
} from "./XtworkImSecurity.ts";
import { validateLeaderId } from "./XtworkImMemory.ts";

export type LeaderStatus = "active" | "paused" | "archived";

export interface LeaderRecord {
  readonly id: string;
  readonly name: string;
  readonly avatar: string;
  readonly role: string;
  readonly status: LeaderStatus;
  readonly pauseGeneration: number;
  readonly pauseVersion: number;
  readonly pinnedThreadId: string | null;
  readonly awarenessScope: AwarenessScope;
  readonly ownerDmDesktopGrants: readonly string[];
  readonly imPolicy: ImDelegationPolicy;
  readonly createdAt: number;
  readonly updatedAt: number;
}

export interface LeaderBindingRecord {
  readonly bindingId: string;
  readonly leaderId: string;
  readonly connectionId: string;
  readonly platform: string | null;
  readonly claimed: boolean;
  readonly epoch: number;
  readonly active: boolean;
  readonly createdAt: number;
  readonly unboundAt: number | null;
  readonly disconnectedAt: number | null;
}

export interface PersistedRunPolicy {
  readonly policyId: string;
  readonly runId: string | null;
  readonly commandId: string;
  readonly threadId: string;
  readonly policyDigest: string;
  readonly context: TurnExecutionContext;
  readonly createdAt: number;
}

export interface ProviderPolicyState {
  readonly protected: boolean;
  readonly policyDigest: string | null;
  readonly failClosed: boolean;
  /** True when this exact run's policy digest differs from the immediately prior bound run on the same thread (S2). */
  readonly policyChanged: boolean;
}

type LeaderRow = {
  readonly id: string;
  readonly name: string;
  readonly avatar: string;
  readonly role: string;
  readonly status: string;
  readonly pauseGeneration: number;
  readonly pauseVersion: number;
  readonly pinnedThreadId: string | null;
  readonly awarenessScopeJson: string;
  readonly ownerDmGrantsJson: string;
  readonly imPolicyJson?: string | null;
  readonly createdAt: number;
  readonly updatedAt: number;
};

type BindingRow = {
  readonly bindingId: string;
  readonly leaderId: string;
  readonly connectionId: string;
  readonly platform: string | null;
  readonly claimed?: number | null;
  readonly epoch: number;
  readonly active: number;
  readonly createdAt: number;
  readonly unboundAt: number | null;
  readonly disconnectedAt?: number | null;
};

type PolicyRow = {
  readonly policyId: string;
  readonly runId: string | null;
  readonly commandId: string;
  readonly threadId: string;
  readonly policyDigest: string;
  readonly policyJson: string;
  readonly pauseGeneration?: number | null;
  readonly createdAt: number;
};

type ProtectedThreadRow = {
  readonly threadId: string;
  readonly leaderId: string;
  readonly bindingId: string | null;
  readonly bindingEpoch: number | null;
  readonly policyDigest: string;
  readonly policyJson: string;
  readonly createdAt: number;
};

const BOT_AVATAR_PATTERN = /^bot:v1:[a-z0-9-]{1,32}:#(?:[0-9a-f]{3}|[0-9a-f]{6})(?::#(?:[0-9a-f]{3}|[0-9a-f]{6}))?$/i;

export function sanitizeLeaderAvatar(raw: string): string {
  const trimmed = raw.trim();
  if (BOT_AVATAR_PATTERN.test(trimmed)) {
    return trimmed.toLowerCase();
  }
  return Array.from(trimmed).slice(0, 8).join("");
}

export function sanitizeBindingPlatform(raw: unknown): string | null {
  if (raw === "wechat" || raw === "feishu" || raw === "wecom") {
    return raw;
  }
  return null;
}

const DEFAULT_AWARENESS_SCOPE: AwarenessScope = Object.freeze({
  kind: "all_local",
  projectIds: [],
});

function parseAwarenessScope(raw: string | undefined): AwarenessScope {
  if (!raw) return DEFAULT_AWARENESS_SCOPE;
  try {
    const parsed = JSON.parse(raw) as { kind?: unknown; projectIds?: unknown };
    const kind =
      parsed.kind === "none" || parsed.kind === "projects" || parsed.kind === "all_local"
        ? parsed.kind
        : "all_local";
    const projectIds = Array.isArray(parsed.projectIds)
      ? parsed.projectIds.filter((item): item is string => typeof item === "string" && item.length > 0)
      : [];
    return { kind, projectIds };
  } catch {
    return DEFAULT_AWARENESS_SCOPE;
  }
}

function parseGrants(raw: string | undefined): string[] {
  if (!raw) return [];
  try {
    const parsed = JSON.parse(raw);
    return Array.isArray(parsed) ? parsed.filter((item): item is string => typeof item === "string" && item.length > 0) : [];
  } catch {
    return [];
  }
}

function parseImPolicy(raw: string | null | undefined): ImDelegationPolicy {
  if (!raw) return DEFAULT_IM_DELEGATION_POLICY;
  try {
    return sanitizeImDelegationPolicy(JSON.parse(raw));
  } catch {
    return DEFAULT_IM_DELEGATION_POLICY;
  }
}

function rowToLeader(row: LeaderRow): LeaderRecord {
  const status: LeaderStatus =
    row.status === "paused" || row.status === "archived" ? row.status : "active";
  return {
    id: row.id,
    name: row.name,
    avatar: row.avatar,
    role: row.role,
    status,
    pauseGeneration: Number(row.pauseGeneration ?? 0),
    pauseVersion: Number(row.pauseVersion ?? 0),
    pinnedThreadId: row.pinnedThreadId,
    awarenessScope: parseAwarenessScope(row.awarenessScopeJson),
    ownerDmDesktopGrants: parseGrants(row.ownerDmGrantsJson),
    imPolicy: parseImPolicy(row.imPolicyJson),
    createdAt: Number(row.createdAt),
    updatedAt: Number(row.updatedAt),
  };
}

function rowToBinding(row: BindingRow): LeaderBindingRecord {
  return {
    bindingId: row.bindingId,
    leaderId: row.leaderId,
    connectionId: row.connectionId,
    platform: row.platform ?? null,
    claimed: Number(row.claimed ?? 0) === 1,
    epoch: Number(row.epoch),
    active: Number(row.active) === 1,
    createdAt: Number(row.createdAt),
    unboundAt: row.unboundAt === null ? null : Number(row.unboundAt),
    disconnectedAt: row.disconnectedAt === null || row.disconnectedAt === undefined ? null : Number(row.disconnectedAt),
  };
}

function rowToPolicy(row: PolicyRow): PersistedRunPolicy {
  return {
    policyId: row.policyId,
    runId: row.runId,
    commandId: row.commandId,
    threadId: row.threadId,
    policyDigest: row.policyDigest,
    context: normalizeExecutionContext(JSON.parse(row.policyJson) as TurnExecutionContext),
    createdAt: Number(row.createdAt),
  };
}

function parseProtectedContextSafe(json: string): TurnExecutionContext | undefined {
  try {
    return normalizeExecutionContext(JSON.parse(json) as TurnExecutionContext);
  } catch {
    return undefined;
  }
}

function parsePolicyRowSafe(row: PolicyRow): PersistedRunPolicy | undefined {
  try {
    return rowToPolicy(row);
  } catch {
    return undefined;
  }
}

export const makeLeaderStore = Effect.fnUntraced(function* () {
  const sql = yield* SqlClient.SqlClient;

  const defaultImPolicyJson = JSON.stringify(DEFAULT_IM_DELEGATION_POLICY);
  yield* sql`CREATE TABLE IF NOT EXISTS xtwork_leaders (
    id TEXT PRIMARY KEY,
    name TEXT NOT NULL,
    avatar TEXT NOT NULL DEFAULT '瞳',
    role TEXT NOT NULL DEFAULT '',
    status TEXT NOT NULL DEFAULT 'active',
    pause_generation INTEGER NOT NULL DEFAULT 0,
    pause_version INTEGER NOT NULL DEFAULT 0,
    pinned_thread_id TEXT,
    awareness_scope_json TEXT NOT NULL DEFAULT '{"kind":"all_local","projectIds":[]}',
    owner_dm_grants_json TEXT NOT NULL DEFAULT '[]',
    im_policy_json TEXT NOT NULL DEFAULT '{"ownerDm":{"delegationMode":"always_ask","progressReportMode":"completion_and_blocked","allowedProjectIds":[]},"group":{"delegationMode":"always_ask","progressReportMode":"completion_and_blocked","allowedProjectIds":[]}}',
    created_at INTEGER NOT NULL,
    updated_at INTEGER NOT NULL
  )`;
  const leaderCols = yield* sql<{ readonly name: string }>`PRAGMA table_info(xtwork_leaders)`;
  if (!leaderCols.some((c) => c.name === "pause_generation")) {
    yield* sql`ALTER TABLE xtwork_leaders ADD COLUMN pause_generation INTEGER NOT NULL DEFAULT 0`;
  }
  if (!leaderCols.some((c) => c.name === "pause_version")) {
    yield* sql`ALTER TABLE xtwork_leaders ADD COLUMN pause_version INTEGER NOT NULL DEFAULT 0`;
    yield* sql`UPDATE xtwork_leaders
      SET pause_version = CASE
        WHEN status = 'paused' THEN pause_generation * 2 + 1
        ELSE pause_generation * 2
      END
      WHERE pause_version = 0 AND (pause_generation > 0 OR status = 'paused')`;
  }
  if (!leaderCols.some((c) => c.name === "im_policy_json")) {
    yield* sql`ALTER TABLE xtwork_leaders ADD COLUMN im_policy_json TEXT NOT NULL DEFAULT '{"ownerDm":{"delegationMode":"always_ask","progressReportMode":"completion_and_blocked","allowedProjectIds":[]},"group":{"delegationMode":"always_ask","progressReportMode":"completion_and_blocked","allowedProjectIds":[]}}'`;
  }

  yield* sql`CREATE TABLE IF NOT EXISTS xtwork_leader_bindings (
    binding_id TEXT PRIMARY KEY,
    leader_id TEXT NOT NULL,
    connection_id TEXT NOT NULL,
    platform TEXT,
    claimed INTEGER NOT NULL DEFAULT 0,
    epoch INTEGER NOT NULL,
    active INTEGER NOT NULL DEFAULT 1,
    created_at INTEGER NOT NULL,
    unbound_at INTEGER,
    disconnected_at INTEGER
  )`;
  const bindingCols = yield* sql<{ readonly name: string }>`PRAGMA table_info(xtwork_leader_bindings)`;
  if (!bindingCols.some((c) => c.name === "platform")) {
    yield* sql`ALTER TABLE xtwork_leader_bindings ADD COLUMN platform TEXT`;
  }
  if (!bindingCols.some((c) => c.name === "claimed")) {
    yield* sql`ALTER TABLE xtwork_leader_bindings ADD COLUMN claimed INTEGER NOT NULL DEFAULT 0`;
  }
  if (!bindingCols.some((c) => c.name === "disconnected_at")) {
    yield* sql`ALTER TABLE xtwork_leader_bindings ADD COLUMN disconnected_at INTEGER`;
  }
  yield* sql`CREATE INDEX IF NOT EXISTS idx_xtwork_leader_bindings_conn
    ON xtwork_leader_bindings(connection_id, active)`;
  // Ensure at most one active binding and unique (connection_id, epoch) exist before creating unique indexes
  // (deduplicates any pre-fix race rows so store initialization never fails on upgrade).
  yield* sql`UPDATE xtwork_leader_bindings
    SET active = 0, unbound_at = COALESCE(unbound_at, ${Date.now()})
    WHERE active = 1
      AND binding_id NOT IN (
        SELECT b1.binding_id
        FROM xtwork_leader_bindings b1
        WHERE b1.active = 1
          AND NOT EXISTS (
            SELECT 1 FROM xtwork_leader_bindings b2
            WHERE b2.connection_id = b1.connection_id
              AND b2.active = 1
              AND (b2.epoch > b1.epoch OR (b2.epoch = b1.epoch AND b2.rowid > b1.rowid))
          )
      )`;
  yield* sql`DELETE FROM xtwork_leader_bindings
    WHERE rowid NOT IN (
      SELECT b1.rowid
      FROM xtwork_leader_bindings b1
      WHERE NOT EXISTS (
        SELECT 1 FROM xtwork_leader_bindings b2
        WHERE b2.connection_id = b1.connection_id
          AND b2.epoch = b1.epoch
          AND (b2.active > b1.active OR (b2.active = b1.active AND b2.rowid > b1.rowid))
      )
    )`;
  yield* sql`CREATE UNIQUE INDEX IF NOT EXISTS idx_xtwork_leader_bindings_one_active
    ON xtwork_leader_bindings(connection_id)
    WHERE active = 1`;
  yield* sql`CREATE UNIQUE INDEX IF NOT EXISTS idx_xtwork_leader_bindings_conn_epoch
    ON xtwork_leader_bindings(connection_id, epoch)`;

  yield* sql`CREATE TABLE IF NOT EXISTS xtwork_run_policies (
    policy_id TEXT PRIMARY KEY,
    run_id TEXT UNIQUE,
    command_id TEXT UNIQUE NOT NULL,
    thread_id TEXT NOT NULL,
    policy_digest TEXT NOT NULL,
    policy_json TEXT NOT NULL,
    pause_generation INTEGER,
    created_at INTEGER NOT NULL
  )`;
  const policyCols = yield* sql<{ readonly name: string }>`PRAGMA table_info(xtwork_run_policies)`;
  if (!policyCols.some((c) => c.name === "pause_generation")) {
    yield* sql`ALTER TABLE xtwork_run_policies ADD COLUMN pause_generation INTEGER`;
  }
  yield* sql`CREATE INDEX IF NOT EXISTS idx_xtwork_run_policies_thread
    ON xtwork_run_policies(thread_id, created_at DESC)`;

  yield* sql`CREATE TABLE IF NOT EXISTS xtwork_protected_threads (
    thread_id TEXT PRIMARY KEY,
    leader_id TEXT NOT NULL,
    binding_id TEXT,
    binding_epoch INTEGER,
    policy_digest TEXT NOT NULL,
    policy_json TEXT NOT NULL,
    created_at INTEGER NOT NULL
  )`;

  // S2: Track the exact policy digest recorded for each native provider conversation
  // so cancelled/queued intermediate runs can never mask a digest mismatch on resume!
  yield* sql`CREATE TABLE IF NOT EXISTS xtwork_native_session_policies (
    thread_id TEXT NOT NULL,
    native_thread_id TEXT NOT NULL,
    policy_digest TEXT NOT NULL,
    updated_at INTEGER NOT NULL,
    PRIMARY KEY (thread_id, native_thread_id)
  )`;

  // Synchronous mirrors kept in lockstep with SQLite for fail-closed policy hooks.
  const protectedThreads = new Map<string, TurnExecutionContext>();
  const latestPolicyByThread = new Map<string, PersistedRunPolicy>();
  const policyByRunId = new Map<string, PersistedRunPolicy>();
  const policyByCommandId = new Map<string, PersistedRunPolicy>();
  const nativePolicyDigestByKey = new Map<string, string>();
  const pauseGenerationByLeader = new Map<string, number>();
  const imPolicyByLeader = new Map<string, ImDelegationPolicy>();
  const leaderCacheById = new Map<string, LeaderRecord>();
  const nativePolicyKey = (threadId: string, nativeThreadId: string) => `${threadId}\0${nativeThreadId}`;

  const existingProtected = yield* sql<ProtectedThreadRow>`
    SELECT thread_id AS "threadId", leader_id AS "leaderId", binding_id AS "bindingId",
      binding_epoch AS "bindingEpoch", policy_digest AS "policyDigest",
      policy_json AS "policyJson", created_at AS "createdAt"
    FROM xtwork_protected_threads
  `;
  for (const row of existingProtected) {
    const parsed = parseProtectedContextSafe(row.policyJson);
    if (parsed !== undefined) {
      protectedThreads.set(row.threadId, parsed);
    }
  }

  const existingPolicies = yield* sql<PolicyRow>`
    SELECT policy_id AS "policyId", run_id AS "runId", command_id AS "commandId",
      thread_id AS "threadId", policy_digest AS "policyDigest",
      policy_json AS "policyJson", pause_generation AS "pauseGeneration", created_at AS "createdAt"
    FROM xtwork_run_policies
    ORDER BY created_at ASC
  `;
  for (const row of existingPolicies) {
    const policy = parsePolicyRowSafe(row);
    if (policy !== undefined) {
      latestPolicyByThread.set(policy.threadId, policy);
      policyByCommandId.set(policy.commandId, policy);
      if (policy.runId) {
        policyByRunId.set(policy.runId, policy);
      }
    }
  }

  const existingNativePolicies = yield* sql<{
    readonly threadId: string;
    readonly nativeThreadId: string;
    readonly policyDigest: string;
  }>`
    SELECT thread_id AS "threadId", native_thread_id AS "nativeThreadId", policy_digest AS "policyDigest"
    FROM xtwork_native_session_policies
  `;
  for (const row of existingNativePolicies) {
    nativePolicyDigestByKey.set(nativePolicyKey(row.threadId, row.nativeThreadId), row.policyDigest);
  }

  const getLeader = (id: string) =>
    sql<LeaderRow>`
      SELECT id, name, avatar, role, status, pause_generation AS "pauseGeneration",
        pause_version AS "pauseVersion",
        pinned_thread_id AS "pinnedThreadId",
        awareness_scope_json AS "awarenessScopeJson", owner_dm_grants_json AS "ownerDmGrantsJson",
        im_policy_json AS "imPolicyJson",
        created_at AS "createdAt", updated_at AS "updatedAt"
      FROM xtwork_leaders WHERE id = ${id}
    `.pipe(Effect.map(([row]) => (row ? rowToLeader(row) : undefined)));

  const ensureDefaultLeader = Effect.fnUntraced(function* () {
    const existing = yield* getLeader(DEFAULT_LEADER_ID);
    if (existing) return existing;
    const now = Date.now();
    yield* sql`INSERT OR IGNORE INTO xtwork_leaders (
      id, name, avatar, role, status, pinned_thread_id, awareness_scope_json, owner_dm_grants_json, im_policy_json, created_at, updated_at
    ) VALUES (
      ${DEFAULT_LEADER_ID}, ${"小瞳"}, ${"瞳"}, ${""}, ${"active"}, ${null},
      ${JSON.stringify(DEFAULT_AWARENESS_SCOPE)}, ${"[]"}, ${defaultImPolicyJson}, ${now}, ${now}
    )`;
    const created = (yield* getLeader(DEFAULT_LEADER_ID))!;
    imPolicyByLeader.set(created.id, created.imPolicy);
    return created;
  });

  yield* ensureDefaultLeader();
  const initialLeaders = yield* sql<LeaderRow>`
    SELECT id, name, avatar, role, status, pause_generation AS "pauseGeneration",
      pause_version AS "pauseVersion",
      pinned_thread_id AS "pinnedThreadId",
      awareness_scope_json AS "awarenessScopeJson", owner_dm_grants_json AS "ownerDmGrantsJson",
      im_policy_json AS "imPolicyJson",
      created_at AS "createdAt", updated_at AS "updatedAt"
    FROM xtwork_leaders
  `;
  for (const row of initialLeaders) {
    const parsed = rowToLeader(row);
    pauseGenerationByLeader.set(parsed.id, parsed.pauseGeneration);
    imPolicyByLeader.set(parsed.id, parsed.imPolicy);
    leaderCacheById.set(parsed.id, parsed);
  }
  const getPauseGenerationSync = (leaderId: string): number => pauseGenerationByLeader.get(leaderId) ?? 0;
  const getImPolicySync = (leaderId: string): ImDelegationPolicy =>
    imPolicyByLeader.get(leaderId) ?? DEFAULT_IM_DELEGATION_POLICY;
  const getLeaderSync = (leaderId: string): LeaderRecord | undefined => leaderCacheById.get(leaderId);

  const listLeaders = () =>
    sql<LeaderRow>`
      SELECT id, name, avatar, role, status, pause_generation AS "pauseGeneration",
        pause_version AS "pauseVersion",
        pinned_thread_id AS "pinnedThreadId",
        awareness_scope_json AS "awarenessScopeJson", owner_dm_grants_json AS "ownerDmGrantsJson",
        im_policy_json AS "imPolicyJson",
        created_at AS "createdAt", updated_at AS "updatedAt"
      FROM xtwork_leaders
      WHERE status != 'archived'
      ORDER BY CASE WHEN id = ${DEFAULT_LEADER_ID} THEN 0 ELSE 1 END, created_at ASC
    `.pipe(Effect.map((rows) => rows.map(rowToLeader)));

  const createLeader = Effect.fnUntraced(function* (input: {
    readonly id?: string;
    readonly name: string;
    readonly avatar?: string;
    readonly role?: string;
    readonly awarenessScope?: AwarenessScope;
    readonly imPolicy?: unknown;
  }) {
    const id = validateLeaderId(input.id ?? `leader-${randomUUID().slice(0, 8)}`);
    const name = input.name.trim() || "新领航者";
    const sanitizedAvatar = input.avatar !== undefined ? sanitizeLeaderAvatar(input.avatar) : "";
    const avatar = sanitizedAvatar || sanitizeLeaderAvatar(Array.from(name)[0] || "航");
    const role = input.role ?? "";
    const scope = input.awarenessScope ?? DEFAULT_AWARENESS_SCOPE;
    const imPolicy = sanitizeImDelegationPolicy(input.imPolicy);
    const now = Date.now();
    yield* sql`INSERT INTO xtwork_leaders (
      id, name, avatar, role, status, pinned_thread_id, awareness_scope_json, owner_dm_grants_json, im_policy_json, created_at, updated_at
    ) VALUES (
      ${id}, ${name}, ${avatar}, ${role}, ${"active"}, ${null},
      ${JSON.stringify(scope)}, ${"[]"}, ${JSON.stringify(imPolicy)}, ${now}, ${now}
    )`;
    pauseGenerationByLeader.set(id, 0);
    imPolicyByLeader.set(id, imPolicy);
    const created = (yield* getLeader(id))!;
    leaderCacheById.set(created.id, created);
    return created;
  });

  const updateLeader = Effect.fnUntraced(function* (
    id: string,
    patch: Partial<{
      readonly name: string;
      readonly avatar: string;
      readonly role: string;
      readonly status: LeaderStatus;
      readonly pinnedThreadId: string | null;
      readonly awarenessScope: AwarenessScope;
      readonly ownerDmDesktopGrants: readonly string[];
      readonly imPolicy: ImDelegationPolicy;
    }>,
  ) {
    const trimmedName = patch.name !== undefined ? patch.name.trim() : "";
    const updateName = trimmedName.length > 0 ? 1 : 0;
    const trimmedAvatar = patch.avatar !== undefined ? patch.avatar.trim() : "";
    const hasAvatarExplicit = patch.avatar !== undefined && trimmedAvatar.length > 0 ? 1 : 0;
    const explicitAvatar = hasAvatarExplicit === 1 ? sanitizeLeaderAvatar(trimmedAvatar) : "";
    const resetAvatarToNameInitial = patch.avatar !== undefined && trimmedAvatar.length === 0 ? 1 : 0;
    const updateRole = patch.role !== undefined ? 1 : 0;
    const updateStatus = patch.status !== undefined ? 1 : 0;
    const advancePauseGeneration = patch.status === "paused" ? 1 : 0;
    const advancePauseVersion = patch.status === "paused" || patch.status === "active" ? 1 : 0;
    const updatePinned = patch.pinnedThreadId !== undefined ? 1 : 0;
    const updateScope = patch.awarenessScope !== undefined ? 1 : 0;
    const updateGrants = patch.ownerDmDesktopGrants !== undefined ? 1 : 0;
    const updateImPolicy = patch.imPolicy !== undefined ? 1 : 0;
    const sanitizedImPolicyJson =
      updateImPolicy === 1 ? JSON.stringify(sanitizeImDelegationPolicy(patch.imPolicy)) : defaultImPolicyJson;
    const now = Date.now();
    const [row] = yield* sql<LeaderRow>`
      UPDATE xtwork_leaders SET
        name = CASE WHEN ${updateName} = 1 THEN ${trimmedName} ELSE name END,
        avatar = CASE
          WHEN ${hasAvatarExplicit} = 1 THEN ${explicitAvatar}
          WHEN ${resetAvatarToNameInitial} = 1 THEN COALESCE(
            NULLIF(substr(CASE WHEN ${updateName} = 1 THEN ${trimmedName} ELSE name END, 1, 1), ''),
            avatar
          )
          ELSE avatar
        END,
        role = CASE WHEN ${updateRole} = 1 THEN ${patch.role ?? ""} ELSE role END,
        status = CASE WHEN ${updateStatus} = 1 THEN ${patch.status ?? "active"} ELSE status END,
        pause_generation = pause_generation + ${advancePauseGeneration},
        pause_version = pause_version + ${advancePauseVersion},
        pinned_thread_id = CASE WHEN ${updatePinned} = 1 THEN ${patch.pinnedThreadId ?? null} ELSE pinned_thread_id END,
        awareness_scope_json = CASE WHEN ${updateScope} = 1 THEN ${JSON.stringify(patch.awarenessScope ?? DEFAULT_AWARENESS_SCOPE)} ELSE awareness_scope_json END,
        owner_dm_grants_json = CASE WHEN ${updateGrants} = 1 THEN ${JSON.stringify(patch.ownerDmDesktopGrants ?? [])} ELSE owner_dm_grants_json END,
        im_policy_json = CASE WHEN ${updateImPolicy} = 1 THEN ${sanitizedImPolicyJson} ELSE im_policy_json END,
        updated_at = ${now}
      WHERE id = ${id} AND status != 'archived'
      RETURNING id, name, avatar, role, status, pause_generation AS "pauseGeneration",
        pause_version AS "pauseVersion",
        pinned_thread_id AS "pinnedThreadId",
        awareness_scope_json AS "awarenessScopeJson", owner_dm_grants_json AS "ownerDmGrantsJson",
        im_policy_json AS "imPolicyJson",
        created_at AS "createdAt", updated_at AS "updatedAt"
    `;
    const updated = row ? rowToLeader(row) : undefined;
    if (updated) {
      pauseGenerationByLeader.set(
        updated.id,
        Math.max(pauseGenerationByLeader.get(updated.id) ?? 0, updated.pauseGeneration),
      );
      imPolicyByLeader.set(updated.id, updated.imPolicy);
      leaderCacheById.set(updated.id, updated);
    }
    return updated;
  });

  const activeBindingForConnection = (connectionId: string) =>
    sql<BindingRow>`
      SELECT binding_id AS "bindingId", leader_id AS "leaderId", connection_id AS "connectionId",
        platform, claimed, epoch, active, created_at AS "createdAt", unbound_at AS "unboundAt",
        disconnected_at AS "disconnectedAt"
      FROM xtwork_leader_bindings
      WHERE connection_id = ${connectionId} AND active = 1
      ORDER BY epoch DESC LIMIT 1
    `.pipe(Effect.map(([row]) => (row ? rowToBinding(row) : undefined)));

  const recordBindingPlatform = Effect.fnUntraced(function* (
    connectionId: string,
    platform: string,
    claimed = false,
  ) {
    const clean = sanitizeBindingPlatform(platform);
    const claimedInt = claimed ? 1 : 0;
    if (!clean && claimedInt === 0) return;
    if (clean) {
      yield* sql`UPDATE xtwork_leader_bindings
        SET platform = ${clean},
          claimed = CASE WHEN claimed = 1 OR ${claimedInt} = 1 THEN 1 ELSE 0 END
        WHERE connection_id = ${connectionId} AND active = 1
          AND (platform IS NULL OR platform != ${clean} OR (claimed = 0 AND ${claimedInt} = 1))`;
      return;
    }
    yield* sql`UPDATE xtwork_leader_bindings
      SET claimed = 1
      WHERE connection_id = ${connectionId} AND active = 1 AND claimed = 0`;
  });

  const deactivateBindingOnDisconnect = Effect.fnUntraced(function* (
    connectionId: string,
    platform?: string,
    claimed = false,
  ) {
    const cleanPlatform = sanitizeBindingPlatform(platform);
    const claimedInt = claimed ? 1 : 0;
    const now = Date.now();
    yield* sql.withTransaction(
      Effect.gen(function* () {
        yield* sql`UPDATE xtwork_leader_bindings
          SET active = 0,
            unbound_at = COALESCE(unbound_at, ${now}),
            disconnected_at = COALESCE(disconnected_at, ${now}),
            platform = COALESCE(platform, ${cleanPlatform}),
            claimed = CASE WHEN claimed = 1 OR ${claimedInt} = 1 THEN 1 ELSE 0 END
          WHERE connection_id = ${connectionId} AND active = 1`;
        const [latestRow] = yield* sql<{ readonly disconnectedAt: number | null; readonly epoch: number }>`
          SELECT disconnected_at AS "disconnectedAt", epoch
          FROM xtwork_leader_bindings
          WHERE connection_id = ${connectionId}
          ORDER BY epoch DESC LIMIT 1
        `;
        if (!latestRow || latestRow.disconnectedAt === null) {
          const nextEpoch = Number(latestRow?.epoch ?? 0) + 1;
          const tombstoneId = `bind-${randomUUID().slice(0, 12)}`;
          yield* sql`INSERT OR IGNORE INTO xtwork_leader_bindings (
            binding_id, leader_id, connection_id, platform, claimed, epoch, active, created_at, unbound_at, disconnected_at
          ) VALUES (${tombstoneId}, ${DEFAULT_LEADER_ID}, ${connectionId}, ${cleanPlatform}, 0, ${nextEpoch}, 0, ${now}, ${now}, ${now})`;
        }
      }),
    );
  });

  const ensureBinding = Effect.fnUntraced(function* (
    connectionId: string,
    preferredLeaderId = DEFAULT_LEADER_ID,
    platform?: string,
    claimed = false,
  ) {
    const cleanPlatform = sanitizeBindingPlatform(platform);
    const claimedInt = claimed ? 1 : 0;
    const existing = yield* activeBindingForConnection(connectionId);
    if (existing) {
      const nextPlatform = cleanPlatform ?? existing.platform;
      const nextClaimed = existing.claimed || claimed;
      if (nextPlatform !== existing.platform || nextClaimed !== existing.claimed) {
        if (cleanPlatform) {
          yield* recordBindingPlatform(connectionId, cleanPlatform, nextClaimed);
        } else if (nextClaimed) {
          yield* sql`UPDATE xtwork_leader_bindings SET claimed = 1 WHERE connection_id = ${connectionId} AND active = 1 AND claimed = 0`;
        }
        return { ...existing, platform: nextPlatform, claimed: nextClaimed };
      }
      return existing;
    }
    const leader = (yield* getLeader(preferredLeaderId)) ?? (yield* ensureDefaultLeader());
    const bindingId = `bind-${randomUUID().slice(0, 12)}`;
    const now = Date.now();
    yield* sql
      .withTransaction(
        Effect.gen(function* () {
          const insideExisting = yield* activeBindingForConnection(connectionId);
          if (insideExisting) {
            if ((cleanPlatform && insideExisting.platform !== cleanPlatform) || (claimedInt === 1 && !insideExisting.claimed)) {
              yield* sql`UPDATE xtwork_leader_bindings
                SET platform = COALESCE(${cleanPlatform}, platform),
                  claimed = CASE WHEN claimed = 1 OR ${claimedInt} = 1 THEN 1 ELSE 0 END
                WHERE connection_id = ${connectionId} AND active = 1`;
            }
            return;
          }
          const [maxRow] = yield* sql<{ readonly maxEpoch: number | null }>`
            SELECT MAX(epoch) AS "maxEpoch" FROM xtwork_leader_bindings WHERE connection_id = ${connectionId}
          `;
          const [prevRow] = yield* sql<{
            readonly platform: string | null;
            readonly claimed: number | null;
            readonly disconnectedAt: number | null;
          }>`
            SELECT platform, claimed, disconnected_at AS "disconnectedAt"
            FROM xtwork_leader_bindings
            WHERE connection_id = ${connectionId}
            ORDER BY epoch DESC LIMIT 1
          `;
          if (prevRow && prevRow.disconnectedAt !== null) {
            return;
          }
          const resolvedPlatform = cleanPlatform ?? sanitizeBindingPlatform(prevRow?.platform);
          const resolvedClaimed = claimedInt === 1 || Number(prevRow?.claimed ?? 0) === 1 ? 1 : 0;
          const epoch = Number(maxRow?.maxEpoch ?? 0) + 1;
          yield* sql`INSERT OR IGNORE INTO xtwork_leader_bindings (
            binding_id, leader_id, connection_id, platform, claimed, epoch, active, created_at, unbound_at, disconnected_at
          ) VALUES (${bindingId}, ${leader.id}, ${connectionId}, ${resolvedPlatform}, ${resolvedClaimed}, ${epoch}, 1, ${now}, ${null}, ${null})`;
        }),
      )
      .pipe(Effect.ignore);
    const resolved = yield* activeBindingForConnection(connectionId);
    if (resolved) {
      const nextPlatform = cleanPlatform ?? resolved.platform;
      const nextClaimed = resolved.claimed || claimed;
      if (nextPlatform !== resolved.platform || nextClaimed !== resolved.claimed) {
        if (cleanPlatform) {
          yield* recordBindingPlatform(connectionId, cleanPlatform, nextClaimed);
        } else if (nextClaimed) {
          yield* sql`UPDATE xtwork_leader_bindings SET claimed = 1 WHERE connection_id = ${connectionId} AND active = 1 AND claimed = 0`;
        }
        return { ...resolved, platform: nextPlatform, claimed: nextClaimed };
      }
      return resolved;
    }
    return yield* imError("Failed to create active Leader binding.");
  });

  const rebindConnection = Effect.fnUntraced(function* (
    connectionId: string,
    nextLeaderId: string,
    platform?: string,
    claimed?: boolean,
    requireActive = false,
  ) {
    const cleanPlatform = sanitizeBindingPlatform(platform);
    const now = Date.now();
    const bindingId = `bind-${randomUUID().slice(0, 12)}`;
    return yield* sql.withTransaction(
      Effect.gen(function* () {
        const leader = yield* getLeader(nextLeaderId);
        if (!leader || leader.status === "archived") {
          return undefined;
        }
        const existing = yield* activeBindingForConnection(connectionId);
        if (!existing && requireActive) {
          return undefined;
        }
        const resolvedPlatform = cleanPlatform ?? existing?.platform ?? null;
        const resolvedClaimed = Boolean(existing?.claimed) || claimed === true;
        const resolvedClaimedInt = resolvedClaimed ? 1 : 0;
        if (existing && existing.leaderId === leader.id) {
          if (resolvedPlatform !== existing.platform || resolvedClaimed !== existing.claimed) {
            yield* sql`UPDATE xtwork_leader_bindings
              SET platform = COALESCE(${resolvedPlatform}, platform),
                claimed = CASE WHEN claimed = 1 OR ${resolvedClaimedInt} = 1 THEN 1 ELSE 0 END
              WHERE connection_id = ${connectionId} AND active = 1`;
            return { ...existing, platform: resolvedPlatform, claimed: resolvedClaimed };
          }
          return existing;
        }
        let carryPlatform = resolvedPlatform;
        let carryClaimed = resolvedClaimed;
        if (!existing) {
          const [prevRow] = yield* sql<{
            readonly platform: string | null;
            readonly claimed: number | null;
            readonly disconnectedAt: number | null;
          }>`
            SELECT platform, claimed, disconnected_at AS "disconnectedAt"
            FROM xtwork_leader_bindings
            WHERE connection_id = ${connectionId}
            ORDER BY epoch DESC LIMIT 1
          `;
          if (prevRow && prevRow.disconnectedAt !== null) {
            return undefined;
          }
          carryPlatform = carryPlatform ?? sanitizeBindingPlatform(prevRow?.platform);
          carryClaimed = carryClaimed || Number(prevRow?.claimed ?? 0) === 1;
        } else if (!carryPlatform || !carryClaimed) {
          const [prevRow] = yield* sql<{ readonly platform: string | null; readonly claimed: number | null }>`
            SELECT platform, claimed FROM xtwork_leader_bindings
            WHERE connection_id = ${connectionId}
            ORDER BY epoch DESC LIMIT 1
          `;
          carryPlatform = carryPlatform ?? sanitizeBindingPlatform(prevRow?.platform);
          carryClaimed = carryClaimed || Number(prevRow?.claimed ?? 0) === 1;
        }
        const carryClaimedInt = carryClaimed ? 1 : 0;
        yield* sql`UPDATE xtwork_leader_bindings SET active = 0, unbound_at = ${now}, disconnected_at = NULL
          WHERE connection_id = ${connectionId} AND active = 1`;
        const [maxRow] = yield* sql<{ readonly maxEpoch: number | null }>`
          SELECT MAX(epoch) AS "maxEpoch" FROM xtwork_leader_bindings WHERE connection_id = ${connectionId}
        `;
        const epoch = Number(maxRow?.maxEpoch ?? 0) + 1;
        yield* sql`INSERT INTO xtwork_leader_bindings (
          binding_id, leader_id, connection_id, platform, claimed, epoch, active, created_at, unbound_at, disconnected_at
        ) VALUES (${bindingId}, ${leader.id}, ${connectionId}, ${carryPlatform}, ${carryClaimedInt}, ${epoch}, 1, ${now}, ${null}, ${null})`;
        return {
          bindingId,
          leaderId: leader.id,
          connectionId,
          platform: carryPlatform,
          claimed: carryClaimed,
          epoch,
          active: true,
          createdAt: now,
          unboundAt: null,
          disconnectedAt: null,
        } satisfies LeaderBindingRecord;
      }),
    );
  });

  const archiveLeader = Effect.fnUntraced(function* (id: string, rebindToLeaderId?: string) {
    if (id === DEFAULT_LEADER_ID) {
      return yield* imError("默认领航者不可归档。");
    }
    const now = Date.now();
    return yield* sql.withTransaction(
      Effect.gen(function* () {
        const current = yield* getLeader(id);
        if (!current) return undefined;
        if (current.status === "archived") {
          return { leader: current, reboundBindings: [] as LeaderBindingRecord[] };
        }
        const activeBindings = yield* sql<BindingRow>`
          SELECT binding_id AS "bindingId", leader_id AS "leaderId", connection_id AS "connectionId",
            platform, claimed, epoch, active, created_at AS "createdAt", unbound_at AS "unboundAt",
            disconnected_at AS "disconnectedAt"
          FROM xtwork_leader_bindings
          WHERE leader_id = ${id} AND active = 1
          ORDER BY created_at ASC
        `.pipe(Effect.map((rows) => rows.map(rowToBinding)));
        const reboundBindings: LeaderBindingRecord[] = [];
        if (activeBindings.length > 0) {
          if (!rebindToLeaderId) {
            const err = new Error("该领航者仍绑定着远程连接，请先换绑或指定接管领航者后再归档。");
            Reflect.set(err, "code", "LEADER_HAS_ACTIVE_BINDINGS");
            return yield* imError(err);
          }
          if (rebindToLeaderId === id) {
            return yield* imError("接管领航者不能与待归档领航者相同。");
          }
          const target = yield* getLeader(rebindToLeaderId);
          if (!target || target.status === "archived") {
            return yield* imError("目标接管领航者不存在或已归档。");
          }
          for (const binding of activeBindings) {
            yield* sql`UPDATE xtwork_leader_bindings SET active = 0, unbound_at = ${now}, disconnected_at = NULL
              WHERE connection_id = ${binding.connectionId} AND active = 1`;
            const [maxRow] = yield* sql<{ readonly maxEpoch: number | null }>`
              SELECT MAX(epoch) AS "maxEpoch" FROM xtwork_leader_bindings WHERE connection_id = ${binding.connectionId}
            `;
            const nextEpoch = Number(maxRow?.maxEpoch ?? 0) + 1;
            const nextBindingId = `bind-${randomUUID().slice(0, 12)}`;
            const claimedInt = binding.claimed ? 1 : 0;
            yield* sql`INSERT INTO xtwork_leader_bindings (
              binding_id, leader_id, connection_id, platform, claimed, epoch, active, created_at, unbound_at, disconnected_at
            ) VALUES (${nextBindingId}, ${target.id}, ${binding.connectionId}, ${binding.platform}, ${claimedInt}, ${nextEpoch}, 1, ${now}, ${null}, ${null})`;
            reboundBindings.push({
              bindingId: nextBindingId,
              leaderId: target.id,
              connectionId: binding.connectionId,
              platform: binding.platform,
              claimed: binding.claimed,
              epoch: nextEpoch,
              active: true,
              createdAt: now,
              unboundAt: null,
              disconnectedAt: null,
            });
          }
        }
        const [row] = yield* sql<LeaderRow>`
          UPDATE xtwork_leaders SET status = 'archived', updated_at = ${now}
          WHERE id = ${id}
          RETURNING id, name, avatar, role, status, pause_generation AS "pauseGeneration",
            pause_version AS "pauseVersion",
            pinned_thread_id AS "pinnedThreadId",
            awareness_scope_json AS "awarenessScopeJson", owner_dm_grants_json AS "ownerDmGrantsJson",
            im_policy_json AS "imPolicyJson",
            created_at AS "createdAt", updated_at AS "updatedAt"
        `;
        const archivedLeader = row ? rowToLeader(row) : undefined;
        if (archivedLeader) {
          leaderCacheById.set(archivedLeader.id, archivedLeader);
        }
        return archivedLeader ? { leader: archivedLeader, reboundBindings } : undefined;
      }),
    );
  });

  const getBindingById = (bindingId: string) =>
    sql<BindingRow>`
      SELECT binding_id AS "bindingId", leader_id AS "leaderId", connection_id AS "connectionId",
        platform, claimed, epoch, active, created_at AS "createdAt", unbound_at AS "unboundAt",
        disconnected_at AS "disconnectedAt"
      FROM xtwork_leader_bindings WHERE binding_id = ${bindingId} LIMIT 1
    `.pipe(Effect.map(([row]) => (row ? rowToBinding(row) : undefined)));

  const findBindingByTuple = (connectionId: string, leaderId: string, epoch: number) =>
    sql<BindingRow>`
      SELECT binding_id AS "bindingId", leader_id AS "leaderId", connection_id AS "connectionId",
        platform, claimed, epoch, active, created_at AS "createdAt", unbound_at AS "unboundAt",
        disconnected_at AS "disconnectedAt"
      FROM xtwork_leader_bindings
      WHERE connection_id = ${connectionId} AND leader_id = ${leaderId} AND epoch = ${epoch}
      LIMIT 1
    `.pipe(Effect.map(([row]) => (row ? rowToBinding(row) : undefined)));

  const hasAnyBindingForConnection = (connectionId: string) =>
    sql<{ readonly count: number }>`
      SELECT COUNT(*) AS count FROM xtwork_leader_bindings WHERE connection_id = ${connectionId}
    `.pipe(Effect.map(([row]) => Number(row?.count ?? 0) > 0));

  const listBindings = (leaderId?: string) =>
    (leaderId
      ? sql<BindingRow>`
          SELECT binding_id AS "bindingId", leader_id AS "leaderId", connection_id AS "connectionId",
            platform, claimed, epoch, active, created_at AS "createdAt", unbound_at AS "unboundAt",
            disconnected_at AS "disconnectedAt"
          FROM xtwork_leader_bindings WHERE leader_id = ${leaderId} AND active = 1 ORDER BY created_at ASC
        `
      : sql<BindingRow>`
          SELECT binding_id AS "bindingId", leader_id AS "leaderId", connection_id AS "connectionId",
            platform, claimed, epoch, active, created_at AS "createdAt", unbound_at AS "unboundAt",
            disconnected_at AS "disconnectedAt"
          FROM xtwork_leader_bindings WHERE active = 1 ORDER BY created_at ASC
        `
    ).pipe(Effect.map((rows) => rows.map(rowToBinding)));

  const listActiveBindingsWithLeaderState = (leaderId?: string) =>
    (leaderId
      ? sql<
          BindingRow & {
            readonly leaderStatus: string;
            readonly leaderPauseVersion: number;
          }
        >`
          SELECT b.binding_id AS "bindingId", b.leader_id AS "leaderId", b.connection_id AS "connectionId",
            b.platform, b.claimed, b.epoch, b.active, b.created_at AS "createdAt", b.unbound_at AS "unboundAt",
            b.disconnected_at AS "disconnectedAt",
            l.status AS "leaderStatus", l.pause_version AS "leaderPauseVersion"
          FROM xtwork_leader_bindings b
          INNER JOIN xtwork_leaders l ON l.id = b.leader_id
          WHERE b.leader_id = ${leaderId} AND b.active = 1 AND l.status != 'archived'
          ORDER BY b.created_at ASC
        `
      : sql<
          BindingRow & {
            readonly leaderStatus: string;
            readonly leaderPauseVersion: number;
          }
        >`
          SELECT b.binding_id AS "bindingId", b.leader_id AS "leaderId", b.connection_id AS "connectionId",
            b.platform, b.claimed, b.epoch, b.active, b.created_at AS "createdAt", b.unbound_at AS "unboundAt",
            b.disconnected_at AS "disconnectedAt",
            l.status AS "leaderStatus", l.pause_version AS "leaderPauseVersion"
          FROM xtwork_leader_bindings b
          INNER JOIN xtwork_leaders l ON l.id = b.leader_id
          WHERE b.active = 1 AND l.status != 'archived'
          ORDER BY b.created_at ASC
        `
    ).pipe(
      Effect.map((rows) =>
        rows.map((row) => ({
          ...rowToBinding(row),
          leaderStatus: (row.leaderStatus === "paused" || row.leaderStatus === "archived"
            ? row.leaderStatus
            : "active") as LeaderStatus,
          leaderPauseVersion: Number(row.leaderPauseVersion ?? 0),
        })),
      ),
    );

  const listBoundPlatforms = (leaderId: string) =>
    sql<{ readonly platform: string | null }>`
      SELECT DISTINCT platform
      FROM xtwork_leader_bindings
      WHERE leader_id = ${leaderId}
        AND platform IS NOT NULL
        AND claimed = 1
        AND (active = 1 OR disconnected_at IS NOT NULL)
    `.pipe(
      Effect.map((rows) =>
        rows
          .map((row) => sanitizeBindingPlatform(row.platform))
          .filter((platform): platform is string => platform !== null),
      ),
    );

  /**
   * Persist execution policy BEFORE Orchestrator dispatches / Pi launches (ADR-013 §2).
   * Works for both `xtwork-im-*` and prefixless protected/derived threads.
   */
  const persistPolicyBeforeLaunch = Effect.fnUntraced(function* (input: {
    readonly commandId: string;
    readonly threadId: string;
    readonly context: TurnExecutionContext;
    readonly runId?: string;
    readonly expectedPauseGeneration?: number;
  }) {
    const normalized = normalizeExecutionContext(input.context);
    const digest = normalized.policyDigest!;
    const policyJson = JSON.stringify(normalized);
    const now = Date.now();
    const policyId = `pol-${randomUUID().slice(0, 12)}`;
    const pauseGen = input.expectedPauseGeneration ?? null;

    yield* sql`INSERT INTO xtwork_run_policies (
      policy_id, run_id, command_id, thread_id, policy_digest, policy_json, pause_generation, created_at
    ) VALUES (
      ${policyId}, ${input.runId ?? null}, ${input.commandId}, ${input.threadId}, ${digest}, ${policyJson}, ${pauseGen}, ${now}
    ) ON CONFLICT(command_id) DO UPDATE SET
      run_id = COALESCE(excluded.run_id, xtwork_run_policies.run_id),
      policy_digest = excluded.policy_digest,
      policy_json = excluded.policy_json,
      pause_generation = excluded.pause_generation`;

    yield* sql`INSERT INTO xtwork_protected_threads (
      thread_id, leader_id, binding_id, binding_epoch, policy_digest, policy_json, created_at
    ) VALUES (
      ${input.threadId}, ${normalized.leaderId ?? DEFAULT_LEADER_ID},
      ${normalized.bindingId ?? null}, ${normalized.bindingEpoch ?? null},
      ${digest}, ${policyJson}, ${now}
    ) ON CONFLICT(thread_id) DO UPDATE SET
      leader_id = excluded.leader_id,
      binding_id = excluded.binding_id,
      binding_epoch = excluded.binding_epoch,
      policy_digest = excluded.policy_digest,
      policy_json = excluded.policy_json`;

    const [row] = yield* sql<PolicyRow>`
      SELECT policy_id AS "policyId", run_id AS "runId", command_id AS "commandId",
        thread_id AS "threadId", policy_digest AS "policyDigest",
        policy_json AS "policyJson", created_at AS "createdAt"
      FROM xtwork_run_policies WHERE command_id = ${input.commandId}
    `;
    const record = row
      ? rowToPolicy(row)
      : {
          policyId,
          runId: input.runId ?? null,
          commandId: input.commandId,
          threadId: input.threadId,
          policyDigest: digest,
          context: normalized,
          createdAt: now,
        };
    protectedThreads.set(input.threadId, normalized);
    latestPolicyByThread.set(input.threadId, record);
    policyByCommandId.set(record.commandId, record);
    if (record.runId) {
      policyByRunId.set(record.runId, record);
    }
    return record;
  });

  const registerLegacyProtectedThread = Effect.fnUntraced(function* (
    threadId: string,
    context: TurnExecutionContext,
  ) {
    const normalized = normalizeExecutionContext(context);
    const digest = normalized.policyDigest!;
    const now = Date.now();
    yield* sql`INSERT OR IGNORE INTO xtwork_protected_threads (
      thread_id, leader_id, binding_id, binding_epoch, policy_digest, policy_json, created_at
    ) VALUES (
      ${threadId}, ${normalized.leaderId ?? DEFAULT_LEADER_ID},
      ${normalized.bindingId ?? null}, ${normalized.bindingEpoch ?? null},
      ${digest}, ${JSON.stringify(normalized)}, ${now}
    )`;
    if (!protectedThreads.has(threadId)) {
      protectedThreads.set(threadId, normalized);
    }
  });

  /**
   * S12: SQLite-only binding step executed INSIDE `EventSink.commitCommand`'s atomic transaction.
   * Does NOT mutate in-memory caches until the transaction commits; rollback leaves zero stale state.
   */
  const bindRunPolicySql = Effect.fnUntraced(function* (commandId: string, threadId: string, runId: string) {
    const [existing] = yield* sql<PolicyRow>`
      SELECT policy_id AS "policyId", run_id AS "runId", command_id AS "commandId",
        thread_id AS "threadId", policy_digest AS "policyDigest",
        policy_json AS "policyJson", pause_generation AS "pauseGeneration", created_at AS "createdAt"
      FROM xtwork_run_policies WHERE command_id = ${commandId} AND thread_id = ${threadId} LIMIT 1
    `;
    if (!existing) {
      return yield* imError("Protected run refused: no persisted execution policy for this dispatch command.");
    }
    if (existing.runId && existing.runId !== runId) {
      return yield* imError("Protected run refused: dispatch command policy is already bound to another run.");
    }
    const record = rowToPolicy(existing);
    // S22/S23: Re-check persisted Leader status AND pause_generation INSIDE the atomic SQLite
    // transaction that commits `run.created`. Even if a Leader was paused and resumed while an
    // earlier dispatch was in flight, its advanced pause_generation rolls back `run.created`!
    if (record.context.source === "im") {
      const leaderId = record.context.leaderId ?? DEFAULT_LEADER_ID;
      const [leaderRow] = yield* sql<{ readonly status: string; readonly pauseGeneration: number }>`
        SELECT status, pause_generation AS "pauseGeneration" FROM xtwork_leaders WHERE id = ${leaderId} LIMIT 1
      `;
      if (!leaderRow || leaderRow.status === "archived") {
        return yield* imError(`${LEADER_ARCHIVED_ERROR}: Target Navigator is archived; IM task rejected.`);
      }
      if (
        leaderRow.status === "paused" ||
        (existing.pauseGeneration != null &&
          Number(leaderRow.pauseGeneration) !== Number(existing.pauseGeneration))
      ) {
        return yield* imError(
          `${LEADER_PAUSED_ERROR}: Leader pause state changed during dispatch; IM task deferred.`,
        );
      }
    }
    yield* sql`UPDATE xtwork_run_policies SET run_id = ${runId} WHERE command_id = ${commandId} AND thread_id = ${threadId}`;
    return { ...record, runId } satisfies PersistedRunPolicy;
  });

  /**
   * S12: Post-commit synchronous cache update called right AFTER SQLite commits and BEFORE
   * `EventSink` notifies `ProviderTurnStartService` or publishes events.
   */
  const publishBoundRunPolicySync = (record: PersistedRunPolicy): void => {
    latestPolicyByThread.set(record.threadId, record);
    policyByCommandId.set(record.commandId, record);
    if (record.runId) {
      policyByRunId.set(record.runId, record);
    }
  };

  /**
   * Convenience wrapper for tests / direct callers composing SQL bind + cache publish.
   */
  const bindRunPolicy = Effect.fnUntraced(function* (commandId: string, threadId: string, runId: string) {
    const record = yield* bindRunPolicySql(commandId, threadId, runId);
    publishBoundRunPolicySync(record);
    return record;
  });

  const attachRunId = Effect.fnUntraced(function* (commandId: string, runId: string) {
    yield* sql`UPDATE xtwork_run_policies SET run_id = ${runId} WHERE command_id = ${commandId}`;
    const [row] = yield* sql<PolicyRow>`
      SELECT policy_id AS "policyId", run_id AS "runId", command_id AS "commandId",
        thread_id AS "threadId", policy_digest AS "policyDigest",
        policy_json AS "policyJson", created_at AS "createdAt"
      FROM xtwork_run_policies WHERE command_id = ${commandId}
    `;
    if (!row) return undefined;
    const record = rowToPolicy(row);
    publishBoundRunPolicySync(record);
    return record;
  });

  /**
   * S2: Record the exact policy digest active for a concrete native provider conversation ID
   * so future turns compare against THAT conversation's recorded policy regardless of cancelled/queued runs.
   */
  const recordNativeThreadPolicy = Effect.fnUntraced(function* (
    threadId: string,
    nativeThreadId: string,
    policyDigest: string,
  ) {
    const now = Date.now();
    yield* sql`INSERT INTO xtwork_native_session_policies (
      thread_id, native_thread_id, policy_digest, updated_at
    ) VALUES (
      ${threadId}, ${nativeThreadId}, ${policyDigest}, ${now}
    ) ON CONFLICT(thread_id, native_thread_id) DO UPDATE SET
      policy_digest = excluded.policy_digest,
      updated_at = excluded.updated_at`;
    nativePolicyDigestByKey.set(nativePolicyKey(threadId, nativeThreadId), policyDigest);
  });

  const resolvePolicy = Effect.fnUntraced(function* (query: {
    readonly runId?: string | null;
    readonly commandId?: string | null;
    readonly threadId?: string | null;
  }) {
    if (query.runId) {
      const cached = policyByRunId.get(query.runId);
      if (cached) return cached;
      const [row] = yield* sql<PolicyRow>`
        SELECT policy_id AS "policyId", run_id AS "runId", command_id AS "commandId",
          thread_id AS "threadId", policy_digest AS "policyDigest",
          policy_json AS "policyJson", created_at AS "createdAt"
        FROM xtwork_run_policies WHERE run_id = ${query.runId} LIMIT 1
      `;
      if (row) {
        const record = rowToPolicy(row);
        policyByRunId.set(query.runId, record);
        return record;
      }
      // If an explicit runId was requested on a protected thread and has no persisted policy row,
      // return undefined so callers fail closed instead of falling back to another run's policy!
      return undefined;
    }
    if (query.commandId) {
      const [row] = yield* sql<PolicyRow>`
        SELECT policy_id AS "policyId", run_id AS "runId", command_id AS "commandId",
          thread_id AS "threadId", policy_digest AS "policyDigest",
          policy_json AS "policyJson", created_at AS "createdAt"
        FROM xtwork_run_policies WHERE command_id = ${query.commandId} LIMIT 1
      `;
      return row ? rowToPolicy(row) : undefined;
    }
    if (query.threadId) {
      const cached = latestPolicyByThread.get(query.threadId);
      if (cached) return cached;
      const [row] = yield* sql<PolicyRow>`
        SELECT policy_id AS "policyId", run_id AS "runId", command_id AS "commandId",
          thread_id AS "threadId", policy_digest AS "policyDigest",
          policy_json AS "policyJson", created_at AS "createdAt"
        FROM xtwork_run_policies WHERE thread_id = ${query.threadId}
        ORDER BY created_at DESC LIMIT 1
      `;
      if (row) {
        const record = rowToPolicy(row);
        latestPolicyByThread.set(query.threadId, record);
        return record;
      }
    }
    return undefined;
  });

  const isProtectedThreadSync = (threadId: string | undefined): boolean => {
    if (!threadId) return false;
    return protectedThreads.has(threadId) || isImThread(threadId);
  };

  const getProtectedContextSync = (threadId: string | undefined): TurnExecutionContext | undefined => {
    if (!threadId) return undefined;
    return protectedThreads.get(threadId);
  };

  /**
   * Synchronous policy check used by ProviderSessionManager & ProviderTurnStartService before
   * opening/reusing a Pi session or resuming a native conversation (S1/S2).
   * - Requires an exact bound `(threadId, runId)` policy row — NEVER borrows unattached policies.
   * - When `resumingNativeThreadId` is supplied, compares against the EXACT policy digest recorded
   *   for THAT native conversation (fail-closed if unknown or mismatched, immune to cancelled intermediate runs).
   */
  const resolveProviderPolicySync = (
    threadId: string,
    runId?: string | null,
    resumingNativeThreadId?: string | null,
  ): ProviderPolicyState => {
    const isProtected = isProtectedThreadSync(threadId);
    if (!isProtected) {
      return { protected: false, policyDigest: null, failClosed: false, policyChanged: false };
    }
    if (!runId) {
      return { protected: true, policyDigest: null, failClosed: true, policyChanged: false };
    }
    const exact = policyByRunId.get(runId);
    if (!exact || exact.threadId !== threadId || !exact.policyDigest) {
      return { protected: true, policyDigest: null, failClosed: true, policyChanged: false };
    }
    const policyChanged = resumingNativeThreadId
      ? nativePolicyDigestByKey.get(nativePolicyKey(threadId, resumingNativeThreadId)) !== exact.policyDigest
      : false;
    return {
      protected: true,
      policyDigest: exact.policyDigest,
      failClosed: false,
      policyChanged,
    };
  };

  const hasRunPolicySync = (query: { readonly runId?: string | null; readonly commandId?: string | null; readonly threadId?: string | null }): boolean => {
    if (query.runId) return policyByRunId.has(query.runId);
    if (query.commandId) return policyByCommandId.has(query.commandId);
    if (query.threadId) return latestPolicyByThread.has(query.threadId);
    return false;
  };

  return {
    ensureDefaultLeader,
    getLeader,
    getLeaderSync,
    getPauseGenerationSync,
    getImPolicySync,
    listLeaders,
    createLeader,
    updateLeader,
    archiveLeader,
    activeBindingForConnection,
    getBindingById,
    findBindingByTuple,
    hasAnyBindingForConnection,
    ensureBinding,
    recordBindingPlatform,
    deactivateBindingOnDisconnect,
    rebindConnection,
    listBindings,
    listActiveBindingsWithLeaderState,
    listBoundPlatforms,
    persistPolicyBeforeLaunch,
    registerLegacyProtectedThread,
    bindRunPolicySql,
    publishBoundRunPolicySync,
    bindRunPolicy,
    attachRunId,
    recordNativeThreadPolicy,
    resolvePolicy,
    isProtectedThreadSync,
    getProtectedContextSync,
    resolveProviderPolicySync,
    hasRunPolicySync,
  };
});

export type LeaderStore = Effect.Success<ReturnType<typeof makeLeaderStore>>;
