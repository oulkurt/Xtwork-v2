// @effect-diagnostics nodeBuiltinImport:off globalDate:off globalDateInEffect:off globalJsonInEffect:off effectFnOpportunity:off
import * as AcpRegistrySupport from "@t3tools/provider-acp-registry/server/AcpRegistrySupport";
import * as Context from "effect/Context";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as NodeFs from "node:fs";
import * as NodePath from "node:path";
import * as ServerConfig from "../config.ts";

export interface InstallConsentKey {
  readonly instanceId: string;
  readonly source: string;
  readonly version: string;
  readonly distribution: string;
  readonly installDir: string;
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

function normalizeInstallDir(installDir: string): string {
  const trimmed = installDir.trim();
  if (trimmed.length === 0) return "";
  if (NodePath.isAbsolute(trimmed)) return NodePath.resolve(trimmed);
  return trimmed;
}

export function normalizeInstallConsentKey(key: InstallConsentKey): InstallConsentKey {
  const normalized: InstallConsentKey = {
    instanceId: key.instanceId.trim(),
    source: key.source.trim(),
    version: key.version.trim(),
    distribution: key.distribution.trim(),
    installDir: normalizeInstallDir(key.installDir),
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
    left.installDir === right.installDir
  );
}

export function installConsentsFilePath(dataDir: string): string {
  return NodePath.join(dataDir, "tools", "install-consents.json");
}

function isValidConsentRecord(value: unknown): value is InstallConsentRecord {
  if (value === null || typeof value !== "object") return false;
  const candidate = value as Record<string, unknown>;
  if (typeof candidate.grantedAt !== "string") return false;
  if (candidate.key === null || typeof candidate.key !== "object") return false;
  const key = candidate.key as Record<string, unknown>;
  return (
    typeof key.instanceId === "string" &&
    key.instanceId.trim().length > 0 &&
    typeof key.source === "string" &&
    key.source.trim().length > 0 &&
    typeof key.version === "string" &&
    key.version.trim().length > 0 &&
    typeof key.distribution === "string" &&
    key.distribution.trim().length > 0 &&
    typeof key.installDir === "string" &&
    key.installDir.trim().length > 0
  );
}

export class InstallConsentStore {
  readonly filePath: string;

  constructor(dataDir: string) {
    this.filePath = installConsentsFilePath(dataDir);
  }

  private readAll(): Array<InstallConsentRecord> {
    if (!NodeFs.existsSync(this.filePath)) return [];
    try {
      const raw = NodeFs.readFileSync(this.filePath, "utf8");
      const parsed = JSON.parse(raw) as Partial<PersistedConsentFile> | null;
      if (!parsed || !Array.isArray(parsed.consents)) return [];
      return parsed.consents.filter(isValidConsentRecord).map((record) => ({
        ...record,
        key: normalizeInstallConsentKey(record.key),
      }));
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

  revokeConsent(rawKey: InstallConsentKey): boolean {
    let key: InstallConsentKey;
    try {
      key = normalizeInstallConsentKey(rawKey);
    } catch {
      return false;
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
    }),
  ),
);
