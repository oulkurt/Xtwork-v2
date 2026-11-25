// @effect-diagnostics nodeBuiltinImport:off globalDate:off
import {
  ProviderDriverKind,
  ProviderInstanceId,
  type ProviderInstanceConfig,
  type ServerSettings,
} from "@t3tools/contracts";
import * as NodeFs from "node:fs";
import * as NodePath from "node:path";

export const ACP_REGISTRY_DRIVER = ProviderDriverKind.make("acpRegistry");

export const KIMI_CODE_INSTANCE_ID = ProviderInstanceId.make("xtworkKimiCode");
export const QODER_INSTANCE_ID = ProviderInstanceId.make("xtworkQoder");
export const CODEBUDDY_CODE_INSTANCE_ID = ProviderInstanceId.make("xtworkCodebuddyCode");
export const DEEPSEEK_HARNESS_INSTANCE_ID = ProviderInstanceId.make("xtworkDeepseekHarness");

export interface CodingAgentSeedDefinition {
  readonly instanceId: ProviderInstanceId;
  readonly instance: ProviderInstanceConfig;
}

/**
 * Four stable ACP coding-agent cards seeded for ordinary mode (ADR-012 §4.2).
 * Seeding makes cards visible and configured, but NEVER grants install consent
 * or authorizes downloading any package/binary.
 */
export const CODING_AGENT_SEEDS: ReadonlyArray<CodingAgentSeedDefinition> = [
  {
    instanceId: KIMI_CODE_INSTANCE_ID,
    instance: {
      driver: ACP_REGISTRY_DRIVER,
      displayName: "Kimi Code",
      enabled: true,
      config: {
        source: "registry",
        agentId: "kimi-code",
        enabled: true,
      },
    },
  },
  {
    instanceId: QODER_INSTANCE_ID,
    instance: {
      driver: ACP_REGISTRY_DRIVER,
      displayName: "Qoder",
      enabled: true,
      config: {
        source: "registry",
        agentId: "qoder",
        enabled: true,
      },
    },
  },
  {
    instanceId: CODEBUDDY_CODE_INSTANCE_ID,
    instance: {
      driver: ACP_REGISTRY_DRIVER,
      displayName: "Codebuddy Code",
      enabled: true,
      config: {
        source: "registry",
        agentId: "codebuddy-code",
        enabled: true,
      },
    },
  },
  {
    instanceId: DEEPSEEK_HARNESS_INSTANCE_ID,
    instance: {
      driver: ACP_REGISTRY_DRIVER,
      displayName: "DeepSeek Harness",
      enabled: true,
      config: {
        source: "local",
        commandPath: "dsh",
        commandArgs: ["--profile", "acp"],
        enabled: true,
      },
    },
  },
];

export const SEEDED_CODING_AGENT_IDS: ReadonlySet<string> = new Set(
  CODING_AGENT_SEEDS.map((entry) => entry.instanceId),
);

interface SeedMarkerFile {
  readonly version: 1;
  readonly seededIds: ReadonlyArray<string>;
}

export function shouldSeedCodingAgents(environment: NodeJS.ProcessEnv): boolean {
  if (environment.XTWORK_SEED_CODING_AGENTS === "0") return false;
  if (environment.XTWORK_SEED_CODING_AGENTS === "1") return true;
  return Boolean(
    environment.XTWORK_PI_BINARY ||
      environment.XTWORK_DATA_DIR ||
      environment.XTWORK_BRAND_CONFIG,
  );
}

export function codingAgentSeedMarkerPath(baseDir: string): string {
  return NodePath.join(baseDir, "tools", "coding-agents-seeded.json");
}

export function readSeededCodingAgentIds(baseDir: string): ReadonlySet<string> {
  const markerPath = codingAgentSeedMarkerPath(baseDir);
  try {
    const raw = NodeFs.readFileSync(markerPath, "utf8");
    const parsed = JSON.parse(raw) as Partial<SeedMarkerFile> | null;
    if (parsed && Array.isArray(parsed.seededIds)) {
      return new Set(parsed.seededIds.filter((item): item is string => typeof item === "string"));
    }
  } catch {
    // Missing or unreadable marker means older config or fresh install.
  }
  return new Set();
}

export function writeSeededCodingAgentIds(baseDir: string, ids: ReadonlySet<string>): void {
  const markerPath = codingAgentSeedMarkerPath(baseDir);
  const dir = NodePath.dirname(markerPath);
  NodeFs.mkdirSync(dir, { recursive: true, mode: 0o700 });
  const payload: SeedMarkerFile = {
    version: 1,
    seededIds: Array.from(ids).toSorted(),
  };
  const tmpPath = `${markerPath}.${process.pid}.${Date.now()}.tmp`;
  NodeFs.writeFileSync(tmpPath, `${JSON.stringify(payload, null, 2)}\n`, { mode: 0o600 });
  try {
    NodeFs.chmodSync(tmpPath, 0o600);
  } catch {
    // Best-effort on non-POSIX filesystems.
  }
  NodeFs.renameSync(tmpPath, markerPath);
}

function cloneSeedInstance(instance: ProviderInstanceConfig): ProviderInstanceConfig {
  const config =
    instance.config !== null && typeof instance.config === "object"
      ? structuredClone(instance.config)
      : instance.config;
  return {
    ...instance,
    ...(config !== undefined ? { config } : {}),
  };
}

export interface SeedCodingAgentsResult {
  readonly settings: ServerSettings;
  readonly addedIds: ReadonlyArray<ProviderInstanceId>;
  readonly trackedIds: ReadonlySet<string>;
}

/**
 * Idempotently seeds the 4 recommended ACP coding agents into server settings.
 * - Never overwrites any existing user entry (preserves custom displayName,
 *   disablement, custom commandPath/commandArgs, environment, etc.).
 * - Never re-adds an instance whose ID is already recorded in `previouslySeededIds`
 *   (so explicit user deletions stay deleted across restarts).
 * - Returns the original `settings` object reference when nothing changes.
 */
export function seedCodingAgents(
  settings: ServerSettings,
  options?: { readonly previouslySeededIds?: ReadonlySet<string> },
): SeedCodingAgentsResult {
  const previouslySeeded = options?.previouslySeededIds ?? new Set<string>();
  const existing = settings.providerInstances;
  const trackedIds = new Set<string>(previouslySeeded);
  const addedIds: Array<ProviderInstanceId> = [];
  let nextProviders: Record<string, ProviderInstanceConfig> | undefined;

  for (const seed of CODING_AGENT_SEEDS) {
    trackedIds.add(seed.instanceId);
    if (Object.prototype.hasOwnProperty.call(existing, seed.instanceId)) {
      continue;
    }
    if (previouslySeeded.has(seed.instanceId)) {
      continue;
    }
    nextProviders ??= { ...existing };
    nextProviders[seed.instanceId] = cloneSeedInstance(seed.instance);
    addedIds.push(seed.instanceId);
  }

  if (nextProviders === undefined) {
    return { settings, addedIds, trackedIds };
  }

  return {
    settings: {
      ...settings,
      providerInstances: nextProviders as ServerSettings["providerInstances"],
    },
    addedIds,
    trackedIds,
  };
}

export function seedCodingAgentsWithMarker(
  settings: ServerSettings,
  baseDir: string,
): ServerSettings {
  const previouslySeededIds = readSeededCodingAgentIds(baseDir);
  const result = seedCodingAgents(settings, { previouslySeededIds });
  const markerMissingOrStale =
    result.addedIds.length > 0 ||
    result.trackedIds.size !== previouslySeededIds.size ||
    !NodeFs.existsSync(codingAgentSeedMarkerPath(baseDir));
  if (markerMissingOrStale) {
    try {
      writeSeededCodingAgentIds(baseDir, result.trackedIds);
    } catch {
      // Do not fail settings hydration if marker persistence fails; next run remains idempotent.
    }
  }
  return result.settings;
}
