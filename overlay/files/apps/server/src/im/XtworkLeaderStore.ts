// @effect-diagnostics nodeBuiltinImport:off globalTimers:off globalDate:off globalDateInEffect:off globalJsonInEffect:off effectTryWithoutCatch:off globalErrorInEffectCatch:off globalErrorInEffectFailure:off effectFnOpportunity:off deterministicKeys:off matchBooleanToIsSuccess:off
import * as Effect from "effect/Effect";
import * as SqlClient from "effect/sql/SqlClient";
import { randomUUID } from "node:crypto";
import {
  DEFAULT_LEADER_ID,
  imError,
  isImThread,
  normalizeExecutionContext,
  type AwarenessScope,
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
  readonly pinnedThreadId: string | null;
  readonly awarenessScope: AwarenessScope;
  readonly ownerDmDesktopGrants: readonly string[];
  readonly createdAt: number;
  readonly updatedAt: number;
}

export interface LeaderBindingRecord {
  readonly bindingId: string;
  readonly leaderId: string;
  readonly connectionId: string;
  readonly epoch: number;
  readonly active: boolean;
  readonly createdAt: number;
  readonly unboundAt: number | null;
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
  readonly pinnedThreadId: string | null;
  readonly awarenessScopeJson: string;
  readonly ownerDmGrantsJson: string;
  readonly createdAt: number;
  readonly updatedAt: number;
};

type BindingRow = {
  readonly bindingId: string;
  readonly leaderId: string;
  readonly connectionId: string;
  readonly epoch: number;
  readonly active: number;
  readonly createdAt: number;
  readonly unboundAt: number | null;
};

type PolicyRow = {
  readonly policyId: string;
  readonly runId: string | null;
  readonly commandId: string;
  readonly threadId: string;
  readonly policyDigest: string;
  readonly policyJson: string;
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

function rowToLeader(row: LeaderRow): LeaderRecord {
  const status: LeaderStatus =
    row.status === "paused" || row.status === "archived" ? row.status : "active";
  return {
    id: row.id,
    name: row.name,
    avatar: row.avatar,
    role: row.role,
    status,
    pinnedThreadId: row.pinnedThreadId,
    awarenessScope: parseAwarenessScope(row.awarenessScopeJson),
    ownerDmDesktopGrants: parseGrants(row.ownerDmGrantsJson),
    createdAt: Number(row.createdAt),
    updatedAt: Number(row.updatedAt),
  };
}

function rowToBinding(row: BindingRow): LeaderBindingRecord {
  return {
    bindingId: row.bindingId,
    leaderId: row.leaderId,
    connectionId: row.connectionId,
    epoch: Number(row.epoch),
    active: Number(row.active) === 1,
    createdAt: Number(row.createdAt),
    unboundAt: row.unboundAt === null ? null : Number(row.unboundAt),
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

  yield* sql`CREATE TABLE IF NOT EXISTS xtwork_leaders (
    id TEXT PRIMARY KEY,
    name TEXT NOT NULL,
    avatar TEXT NOT NULL DEFAULT '瞳',
    role TEXT NOT NULL DEFAULT '',
    status TEXT NOT NULL DEFAULT 'active',
    pinned_thread_id TEXT,
    awareness_scope_json TEXT NOT NULL DEFAULT '{"kind":"all_local","projectIds":[]}',
    owner_dm_grants_json TEXT NOT NULL DEFAULT '[]',
    created_at INTEGER NOT NULL,
    updated_at INTEGER NOT NULL
  )`;

  yield* sql`CREATE TABLE IF NOT EXISTS xtwork_leader_bindings (
    binding_id TEXT PRIMARY KEY,
    leader_id TEXT NOT NULL,
    connection_id TEXT NOT NULL,
    epoch INTEGER NOT NULL,
    active INTEGER NOT NULL DEFAULT 1,
    created_at INTEGER NOT NULL,
    unbound_at INTEGER
  )`;
  yield* sql`CREATE INDEX IF NOT EXISTS idx_xtwork_leader_bindings_conn
    ON xtwork_leader_bindings(connection_id, active)`;

  yield* sql`CREATE TABLE IF NOT EXISTS xtwork_run_policies (
    policy_id TEXT PRIMARY KEY,
    run_id TEXT UNIQUE,
    command_id TEXT UNIQUE NOT NULL,
    thread_id TEXT NOT NULL,
    policy_digest TEXT NOT NULL,
    policy_json TEXT NOT NULL,
    created_at INTEGER NOT NULL
  )`;
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
      policy_json AS "policyJson", created_at AS "createdAt"
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
      SELECT id, name, avatar, role, status, pinned_thread_id AS "pinnedThreadId",
        awareness_scope_json AS "awarenessScopeJson", owner_dm_grants_json AS "ownerDmGrantsJson",
        created_at AS "createdAt", updated_at AS "updatedAt"
      FROM xtwork_leaders WHERE id = ${id}
    `.pipe(Effect.map(([row]) => (row ? rowToLeader(row) : undefined)));

  const ensureDefaultLeader = Effect.fnUntraced(function* () {
    const existing = yield* getLeader(DEFAULT_LEADER_ID);
    if (existing) return existing;
    const now = Date.now();
    yield* sql`INSERT OR IGNORE INTO xtwork_leaders (
      id, name, avatar, role, status, pinned_thread_id, awareness_scope_json, owner_dm_grants_json, created_at, updated_at
    ) VALUES (
      ${DEFAULT_LEADER_ID}, ${"小瞳"}, ${"瞳"}, ${""}, ${"active"}, ${null},
      ${JSON.stringify(DEFAULT_AWARENESS_SCOPE)}, ${"[]"}, ${now}, ${now}
    )`;
    return (yield* getLeader(DEFAULT_LEADER_ID))!;
  });

  yield* ensureDefaultLeader();

  const listLeaders = () =>
    sql<LeaderRow>`
      SELECT id, name, avatar, role, status, pinned_thread_id AS "pinnedThreadId",
        awareness_scope_json AS "awarenessScopeJson", owner_dm_grants_json AS "ownerDmGrantsJson",
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
  }) {
    const id = validateLeaderId(input.id ?? `leader-${randomUUID().slice(0, 8)}`);
    const name = input.name.trim() || "新 Leader";
    const avatar = (input.avatar?.trim() || Array.from(name)[0] || "L").slice(0, 8);
    const role = input.role ?? "";
    const scope = input.awarenessScope ?? DEFAULT_AWARENESS_SCOPE;
    const now = Date.now();
    yield* sql`INSERT INTO xtwork_leaders (
      id, name, avatar, role, status, pinned_thread_id, awareness_scope_json, owner_dm_grants_json, created_at, updated_at
    ) VALUES (
      ${id}, ${name}, ${avatar}, ${role}, ${"active"}, ${null},
      ${JSON.stringify(scope)}, ${"[]"}, ${now}, ${now}
    )`;
    return (yield* getLeader(id))!;
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
    }>,
  ) {
    const current = yield* getLeader(id);
    if (!current) return undefined;
    const nextName = patch.name !== undefined ? patch.name.trim() || current.name : current.name;
    const nextAvatar =
      patch.avatar !== undefined ? (patch.avatar.trim() || Array.from(nextName)[0] || current.avatar).slice(0, 8) : current.avatar;
    const nextRole = patch.role !== undefined ? patch.role : current.role;
    const nextStatus = patch.status !== undefined ? patch.status : current.status;
    const nextPinned = patch.pinnedThreadId !== undefined ? patch.pinnedThreadId : current.pinnedThreadId;
    const nextScope = patch.awarenessScope !== undefined ? patch.awarenessScope : current.awarenessScope;
    const nextGrants =
      patch.ownerDmDesktopGrants !== undefined ? patch.ownerDmDesktopGrants : current.ownerDmDesktopGrants;
    const now = Date.now();
    yield* sql`UPDATE xtwork_leaders SET
      name = ${nextName},
      avatar = ${nextAvatar},
      role = ${nextRole},
      status = ${nextStatus},
      pinned_thread_id = ${nextPinned},
      awareness_scope_json = ${JSON.stringify(nextScope)},
      owner_dm_grants_json = ${JSON.stringify(nextGrants)},
      updated_at = ${now}
      WHERE id = ${id}`;
    return yield* getLeader(id);
  });

  const activeBindingForConnection = (connectionId: string) =>
    sql<BindingRow>`
      SELECT binding_id AS "bindingId", leader_id AS "leaderId", connection_id AS "connectionId",
        epoch, active, created_at AS "createdAt", unbound_at AS "unboundAt"
      FROM xtwork_leader_bindings
      WHERE connection_id = ${connectionId} AND active = 1
      ORDER BY epoch DESC LIMIT 1
    `.pipe(Effect.map(([row]) => (row ? rowToBinding(row) : undefined)));

  const ensureBinding = Effect.fnUntraced(function* (connectionId: string, preferredLeaderId = DEFAULT_LEADER_ID) {
    const existing = yield* activeBindingForConnection(connectionId);
    if (existing) return existing;
    const leader = (yield* getLeader(preferredLeaderId)) ?? (yield* ensureDefaultLeader());
    const [maxRow] = yield* sql<{ readonly maxEpoch: number | null }>`
      SELECT MAX(epoch) AS "maxEpoch" FROM xtwork_leader_bindings WHERE connection_id = ${connectionId}
    `;
    const epoch = Number(maxRow?.maxEpoch ?? 0) + 1;
    const bindingId = `bind-${randomUUID().slice(0, 12)}`;
    const now = Date.now();
    yield* sql`INSERT INTO xtwork_leader_bindings (
      binding_id, leader_id, connection_id, epoch, active, created_at, unbound_at
    ) VALUES (${bindingId}, ${leader.id}, ${connectionId}, ${epoch}, 1, ${now}, ${null})`;
    return {
      bindingId,
      leaderId: leader.id,
      connectionId,
      epoch,
      active: true,
      createdAt: now,
      unboundAt: null,
    } satisfies LeaderBindingRecord;
  });

  /**
   * Rebind a connection to a different Leader without modifying historical deliveries or threads.
   * Bumps `epoch` and mints a fresh `bindingId` so old provider sessions / `chats.thread_id` are never reused.
   */
  const rebindConnection = Effect.fnUntraced(function* (connectionId: string, nextLeaderId: string) {
    const leader = yield* getLeader(nextLeaderId);
    if (!leader || leader.status === "archived") {
      return undefined;
    }
    const existing = yield* activeBindingForConnection(connectionId);
    if (existing && existing.leaderId === leader.id) return existing;
    const now = Date.now();
    yield* sql`UPDATE xtwork_leader_bindings SET active = 0, unbound_at = ${now}
      WHERE connection_id = ${connectionId} AND active = 1`;
    const [maxRow] = yield* sql<{ readonly maxEpoch: number | null }>`
      SELECT MAX(epoch) AS "maxEpoch" FROM xtwork_leader_bindings WHERE connection_id = ${connectionId}
    `;
    const epoch = Number(maxRow?.maxEpoch ?? 0) + 1;
    const bindingId = `bind-${randomUUID().slice(0, 12)}`;
    yield* sql`INSERT INTO xtwork_leader_bindings (
      binding_id, leader_id, connection_id, epoch, active, created_at, unbound_at
    ) VALUES (${bindingId}, ${leader.id}, ${connectionId}, ${epoch}, 1, ${now}, ${null})`;
    return {
      bindingId,
      leaderId: leader.id,
      connectionId,
      epoch,
      active: true,
      createdAt: now,
      unboundAt: null,
    } satisfies LeaderBindingRecord;
  });

  const getBindingById = (bindingId: string) =>
    sql<BindingRow>`
      SELECT binding_id AS "bindingId", leader_id AS "leaderId", connection_id AS "connectionId",
        epoch, active, created_at AS "createdAt", unbound_at AS "unboundAt"
      FROM xtwork_leader_bindings WHERE binding_id = ${bindingId} LIMIT 1
    `.pipe(Effect.map(([row]) => (row ? rowToBinding(row) : undefined)));

  const findBindingByTuple = (connectionId: string, leaderId: string, epoch: number) =>
    sql<BindingRow>`
      SELECT binding_id AS "bindingId", leader_id AS "leaderId", connection_id AS "connectionId",
        epoch, active, created_at AS "createdAt", unbound_at AS "unboundAt"
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
            epoch, active, created_at AS "createdAt", unbound_at AS "unboundAt"
          FROM xtwork_leader_bindings WHERE leader_id = ${leaderId} AND active = 1 ORDER BY created_at ASC
        `
      : sql<BindingRow>`
          SELECT binding_id AS "bindingId", leader_id AS "leaderId", connection_id AS "connectionId",
            epoch, active, created_at AS "createdAt", unbound_at AS "unboundAt"
          FROM xtwork_leader_bindings WHERE active = 1 ORDER BY created_at ASC
        `
    ).pipe(Effect.map((rows) => rows.map(rowToBinding)));

  /**
   * Persist execution policy BEFORE Orchestrator dispatches / Pi launches (ADR-013 §2).
   * Works for both `xtwork-im-*` and prefixless protected/derived threads.
   */
  const persistPolicyBeforeLaunch = Effect.fnUntraced(function* (input: {
    readonly commandId: string;
    readonly threadId: string;
    readonly context: TurnExecutionContext;
    readonly runId?: string;
  }) {
    const normalized = normalizeExecutionContext(input.context);
    const digest = normalized.policyDigest!;
    const policyJson = JSON.stringify(normalized);
    const now = Date.now();
    const policyId = `pol-${randomUUID().slice(0, 12)}`;

    yield* sql`INSERT INTO xtwork_run_policies (
      policy_id, run_id, command_id, thread_id, policy_digest, policy_json, created_at
    ) VALUES (
      ${policyId}, ${input.runId ?? null}, ${input.commandId}, ${input.threadId}, ${digest}, ${policyJson}, ${now}
    ) ON CONFLICT(command_id) DO UPDATE SET
      run_id = COALESCE(excluded.run_id, xtwork_run_policies.run_id),
      policy_digest = excluded.policy_digest,
      policy_json = excluded.policy_json`;

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
        policy_json AS "policyJson", created_at AS "createdAt"
      FROM xtwork_run_policies WHERE command_id = ${commandId} AND thread_id = ${threadId} LIMIT 1
    `;
    if (!existing) {
      return yield* imError("Protected run refused: no persisted execution policy for this dispatch command.");
    }
    if (existing.runId && existing.runId !== runId) {
      return yield* imError("Protected run refused: dispatch command policy is already bound to another run.");
    }
    yield* sql`UPDATE xtwork_run_policies SET run_id = ${runId} WHERE command_id = ${commandId} AND thread_id = ${threadId}`;
    return { ...rowToPolicy(existing), runId } satisfies PersistedRunPolicy;
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
    listLeaders,
    createLeader,
    updateLeader,
    activeBindingForConnection,
    getBindingById,
    findBindingByTuple,
    hasAnyBindingForConnection,
    ensureBinding,
    rebindConnection,
    listBindings,
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
