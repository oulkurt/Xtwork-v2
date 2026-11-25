// @effect-diagnostics nodeBuiltinImport:off globalDate:off globalDateInEffect:off globalJsonInEffect:off effectFnOpportunity:off
import * as AcpRegistrySupport from "@t3tools/provider-acp-registry/server/AcpRegistrySupport";
import * as Context from "effect/Context";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as NodeCrypto from "node:crypto";
import * as NodeFs from "node:fs";
import * as NodePath from "node:path";
import * as ServerConfig from "../config.ts";
import * as CodexInstallation from "../provider/CodexInstallation.ts";

export interface InstallConsentKey {
  readonly instanceId: string;
  readonly source: string;
  readonly version: string;
  readonly distribution: string;
  readonly installDir: string;
  /** Exact pinned artifact identifier (e.g. `@scope/pkg@1.2.3` or release/archive URL). */
  readonly artifactSpec?: string | undefined;
  /** Optional cryptographic digest (e.g. lowercase SHA-256 hex) pinned at confirmation time. */
  readonly artifactDigest?: string | undefined;
}

export interface InstallConsentRecord {
  readonly key: InstallConsentKey;
  readonly grantedAt: string;
  readonly commandPreview?: string;
  readonly officialSource?: string;
}

interface PersistedConsentFile {
  readonly version: 1;
  readonly consents: ReadonlyArray<InstallConsentRecord>;
}

interface SingleUseApproval {
  readonly token: string;
  readonly key: InstallConsentKey;
  readonly issuedAt: number;
}

function normalizeInstallDir(installDir: string): string {
  const trimmed = installDir.trim();
  if (trimmed.length === 0) return "";
  if (NodePath.isAbsolute(trimmed)) return NodePath.resolve(trimmed);
  return trimmed;
}

export function normalizeInstallConsentKey(key: InstallConsentKey): InstallConsentKey {
  const artifactSpec = key.artifactSpec?.trim();
  const artifactDigest = key.artifactDigest?.trim().toLowerCase();
  const normalized: InstallConsentKey = {
    instanceId: key.instanceId.trim(),
    source: key.source.trim(),
    version: key.version.trim(),
    distribution: key.distribution.trim(),
    installDir: normalizeInstallDir(key.installDir),
    ...(artifactSpec ? { artifactSpec } : {}),
    ...(artifactDigest ? { artifactDigest } : {}),
  };
  if (
    !normalized.instanceId ||
    !normalized.source ||
    !normalized.version ||
    !normalized.distribution ||
    !normalized.installDir
  ) {
    throw new Error(
      "Install consent key requires non-empty instanceId, source, version, distribution, and installDir.",
    );
  }
  return normalized;
}

export function installConsentKeysEqual(
  left: InstallConsentKey,
  right: InstallConsentKey,
): boolean {
  return (
    left.instanceId === right.instanceId &&
    left.source === right.source &&
    left.version === right.version &&
    left.distribution === right.distribution &&
    left.installDir === right.installDir &&
    (left.artifactSpec ?? "") === (right.artifactSpec ?? "") &&
    (left.artifactDigest ?? "") === (right.artifactDigest ?? "")
  );
}

export function installConsentsFilePath(dataDir: string): string {
  return NodePath.join(dataDir, "tools", "install-consents.json");
}

function isPlainObject(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}

function isValidConsentRecord(value: unknown): value is InstallConsentRecord {
  if (!isPlainObject(value)) return false;
  if (typeof value.grantedAt !== "string" || value.grantedAt.trim().length === 0) return false;
  if (value.commandPreview !== undefined && typeof value.commandPreview !== "string") return false;
  if (value.officialSource !== undefined && typeof value.officialSource !== "string") return false;
  if (!isPlainObject(value.key)) return false;
  const key = value.key;
  if (
    typeof key.instanceId !== "string" ||
    key.instanceId.trim().length === 0 ||
    typeof key.source !== "string" ||
    key.source.trim().length === 0 ||
    typeof key.version !== "string" ||
    key.version.trim().length === 0 ||
    typeof key.distribution !== "string" ||
    key.distribution.trim().length === 0 ||
    typeof key.installDir !== "string" ||
    key.installDir.trim().length === 0
  ) {
    return false;
  }
  if (
    key.artifactSpec !== undefined &&
    (typeof key.artifactSpec !== "string" || key.artifactSpec.trim().length === 0)
  ) {
    return false;
  }
  if (
    key.artifactDigest !== undefined &&
    (typeof key.artifactDigest !== "string" || key.artifactDigest.trim().length === 0)
  ) {
    return false;
  }
  return true;
}

export class InstallConsentStore {
  readonly filePath: string;
  private readonly singleUseApprovals = new Map<string, SingleUseApproval>();

  constructor(dataDir: string) {
    this.filePath = installConsentsFilePath(dataDir);
  }

  private readAll(): Array<InstallConsentRecord> {
    if (!NodeFs.existsSync(this.filePath)) return [];
    try {
      const raw = NodeFs.readFileSync(this.filePath, "utf8");
      const parsed: unknown = JSON.parse(raw);
      // Fail closed on any schema violation across the entire document (S2).
      if (!isPlainObject(parsed)) return [];
      if (parsed.version !== 1) return [];
      if (!Array.isArray(parsed.consents)) return [];
      const validated: Array<InstallConsentRecord> = [];
      for (const entry of parsed.consents) {
        if (!isValidConsentRecord(entry)) {
          return [];
        }
        validated.push({
          ...entry,
          key: normalizeInstallConsentKey(entry.key),
        });
      }
      return validated;
    } catch {
      // Fail closed: corrupted or unreadable consent file grants nothing.
      return [];
    }
  }

  private writeAll(records: ReadonlyArray<InstallConsentRecord>): void {
    const dir = NodePath.dirname(this.filePath);
    NodeFs.mkdirSync(dir, { recursive: true, mode: 0o700 });
    const payload: PersistedConsentFile = {
      version: 1,
      consents: records,
    };
    const tmpPath = `${this.filePath}.${process.pid}.${Date.now()}.tmp`;
    NodeFs.writeFileSync(tmpPath, `${JSON.stringify(payload, null, 2)}\n`, { mode: 0o600 });
    try {
      NodeFs.chmodSync(tmpPath, 0o600);
    } catch {
      // Best-effort on non-POSIX filesystems.
    }
    NodeFs.renameSync(tmpPath, this.filePath);
  }

  listConsents(): ReadonlyArray<InstallConsentRecord> {
    return this.readAll();
  }

  hasConsent(rawKey: InstallConsentKey): boolean {
    let key: InstallConsentKey;
    try {
      key = normalizeInstallConsentKey(rawKey);
    } catch {
      return false;
    }
    return this.readAll().some((record) => installConsentKeysEqual(record.key, key));
  }

  grantConsent(
    rawKey: InstallConsentKey,
    metadata?: { readonly commandPreview?: string; readonly officialSource?: string },
  ): InstallConsentRecord {
    const key = normalizeInstallConsentKey(rawKey);
    const record: InstallConsentRecord = {
      key,
      grantedAt: new Date().toISOString(),
      ...(metadata?.commandPreview ? { commandPreview: metadata.commandPreview } : {}),
      ...(metadata?.officialSource ? { officialSource: metadata.officialSource } : {}),
    };
    const existing = this.readAll().filter((item) => !installConsentKeysEqual(item.key, key));
    existing.push(record);
    this.writeAll(existing);
    return record;
  }

  /**
   * Issues an in-memory single-use approval token bound to the exact normalized
   * install key. Must be consumed once by the downloader/installer (`prepare` or
   * `CodexInstallation.start`) so prior consents can never authorize a silent
   * re-download after cancellation or cache loss (M2, M3).
   */
  issueApproval(rawKey: InstallConsentKey): string {
    const key = normalizeInstallConsentKey(rawKey);
    const token = NodeCrypto.randomUUID();
    this.singleUseApprovals.set(token, { token, key, issuedAt: Date.now() });
    return token;
  }

  /**
   * Atomically verifies and consumes a matching single-use approval token.
   * Requires a non-empty `approvalToken` bound to the exact normalized key;
   * omitting or supplying a blank/mismatched token always fails closed (M2).
   */
  consumeApproval(rawKey: InstallConsentKey, approvalToken?: string): boolean {
    if (typeof approvalToken !== "string") return false;
    const trimmed = approvalToken.trim();
    if (!trimmed) return false;
    let key: InstallConsentKey;
    try {
      key = normalizeInstallConsentKey(rawKey);
    } catch {
      return false;
    }
    const entry = this.singleUseApprovals.get(trimmed);
    if (!entry || !installConsentKeysEqual(entry.key, key)) {
      return false;
    }
    this.singleUseApprovals.delete(trimmed);
    return true;
  }

  revokeApproval(approvalToken: string): boolean {
    return this.singleUseApprovals.delete(approvalToken);
  }

  revokeConsent(rawKey: InstallConsentKey): boolean {
    let key: InstallConsentKey;
    try {
      key = normalizeInstallConsentKey(rawKey);
    } catch {
      return false;
    }
    for (const [token, entry] of this.singleUseApprovals) {
      if (installConsentKeysEqual(entry.key, key)) {
        this.singleUseApprovals.delete(token);
      }
    }
    const current = this.readAll();
    const next = current.filter((item) => !installConsentKeysEqual(item.key, key));
    if (next.length === current.length) return false;
    this.writeAll(next);
    return true;
  }

  revokeConsentForInstance(instanceId: string): number {
    const normalized = instanceId.trim();
    if (!normalized) return 0;
    for (const [token, entry] of this.singleUseApprovals) {
      if (entry.key.instanceId === normalized) {
        this.singleUseApprovals.delete(token);
      }
    }
    const current = this.readAll();
    const next = current.filter((item) => item.key.instanceId !== normalized);
    const removed = current.length - next.length;
    if (removed > 0) this.writeAll(next);
    return removed;
  }
}

export interface XtworkInstallConsentService {
  readonly filePath: string;
  readonly listConsents: () => Effect.Effect<ReadonlyArray<InstallConsentRecord>>;
  readonly hasConsent: (key: InstallConsentKey) => Effect.Effect<boolean>;
  readonly grantConsent: (
    key: InstallConsentKey,
    metadata?: { readonly commandPreview?: string; readonly officialSource?: string },
  ) => Effect.Effect<InstallConsentRecord>;
  readonly issueApproval: (key: InstallConsentKey) => Effect.Effect<string>;
  readonly consumeApproval: (
    key: InstallConsentKey,
    approvalToken?: string,
  ) => Effect.Effect<boolean>;
  readonly revokeApproval: (approvalToken: string) => Effect.Effect<boolean>;
  readonly revokeConsent: (key: InstallConsentKey) => Effect.Effect<boolean>;
  readonly revokeConsentForInstance: (instanceId: string) => Effect.Effect<number>;
}

export class XtworkInstallConsent extends Context.Service<
  XtworkInstallConsent,
  XtworkInstallConsentService
>()("t3/xtwork/installConsent/XtworkInstallConsent") {}

export function makeXtworkInstallConsentService(dataDir: string): XtworkInstallConsentService {
  const store = new InstallConsentStore(dataDir);
  return {
    filePath: store.filePath,
    listConsents: () => Effect.sync(() => store.listConsents()),
    hasConsent: (key) => Effect.sync(() => store.hasConsent(key)),
    grantConsent: (key, metadata) => Effect.sync(() => store.grantConsent(key, metadata)),
    issueApproval: (key) => Effect.sync(() => store.issueApproval(key)),
    consumeApproval: (key, approvalToken) =>
      Effect.sync(() => store.consumeApproval(key, approvalToken)),
    revokeApproval: (approvalToken) => Effect.sync(() => store.revokeApproval(approvalToken)),
    revokeConsent: (key) => Effect.sync(() => store.revokeConsent(key)),
    revokeConsentForInstance: (instanceId) =>
      Effect.sync(() => store.revokeConsentForInstance(instanceId)),
  };
}

export const layer = Layer.effect(
  XtworkInstallConsent,
  Effect.gen(function* () {
    const config = yield* ServerConfig.ServerConfig;
    return makeXtworkInstallConsentService(config.baseDir);
  }),
);

export const acpConsentGateLayer = Layer.effect(
  AcpRegistrySupport.AcpInstallConsentGate,
  Effect.map(XtworkInstallConsent, (consent) =>
    AcpRegistrySupport.AcpInstallConsentGate.of({
      hasConsent: (key) => consent.hasConsent(key),
      consumePrepareApproval: (key, approvalToken) =>
        consent.consumeApproval(key, approvalToken),
    }),
  ),
);

export const codexConsentGateLayer = Layer.effect(
  CodexInstallation.CodexInstallConsentGate,
  Effect.map(XtworkInstallConsent, (consent) =>
    CodexInstallation.CodexInstallConsentGate.of({
      consumeInstallApproval: (key, approvalToken) =>
        consent.consumeApproval(key, approvalToken),
    }),
  ),
);
