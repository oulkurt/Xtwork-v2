import {
  type ModelSelection,
  ProviderDriverKind,
  ProviderInstanceId,
  resolveProviderInstanceEnabled,
  type ServerSettings,
} from "@t3tools/contracts";
import { MODEL_PROVIDER, STANDARD_MODEL } from "./gateway.ts";

const DIM_INSTANCE_ID = ProviderInstanceId.make("xtworkDim");
export const PI_INSTANCE_ID = ProviderInstanceId.make("xtworkPi");
export const PI_DRIVER = ProviderDriverKind.make("pi");
export const BUILT_IN_ASSISTANT_NAME = "小瞳";
export const LEGACY_BUILT_IN_ASSISTANT_NAME = "内置助手";
export const PI_INHERIT_MODEL = "default";

const defaultLegacySelection: ModelSelection = {
  instanceId: PI_INSTANCE_ID,
  model: `${MODEL_PROVIDER}/${STANDARD_MODEL}`,
};

const modelSelectionKeys = [
  "defaultModelSelection",
  "fallbackModelSelection",
  "textGenerationModelSelection",
  "sourceControlWriterModelSelection",
  "reviewGuideModelSelection",
  "speechPostProcessingModelSelection",
] as const;
type ModelSelectionKey = (typeof modelSelectionKeys)[number];

export interface SeedBundledPiOptions {
  /**
   * Default `<channelId>/<modelId>` slug to seed on first run (e.g. `xiaotong-work-team/deepseek-flash`
   * or `xtwork/standard` in dev fallback). Pass `null` explicitly when zero channels are configured so
   * `xtworkPi` enters the clean unconfigured onboarding state without binding a nonexistent model.
   */
  readonly defaultModelSlug?: string | null;
}

function resolveSeedSelection(options?: SeedBundledPiOptions): ModelSelection | null {
  if (options === undefined || options.defaultModelSlug === undefined) {
    return defaultLegacySelection;
  }
  if (options.defaultModelSlug === null) {
    return null;
  }
  return {
    instanceId: PI_INSTANCE_ID,
    model: options.defaultModelSlug,
  };
}

function migrateModelSelections(
  settings: Partial<Pick<ServerSettings, ModelSelectionKey>>,
  targetSelection: ModelSelection,
) {
  const migrated: Partial<Record<ModelSelectionKey, ModelSelection>> = {};
  for (const key of modelSelectionKeys) {
    if (settings[key]?.instanceId === DIM_INSTANCE_ID) migrated[key] = targetSelection;
  }
  return migrated;
}

export function seedBundledPi(
  settings: ServerSettings,
  firstRun: boolean,
  options?: SeedBundledPiOptions,
): ServerSettings {
  const { [DIM_INSTANCE_ID]: dim, ...providers } = settings.providerInstances;
  const existingPi = providers[PI_INSTANCE_ID];
  const upgradingDim = dim?.driver === "acpRegistry" && dim.config !== undefined;
  const renamingLegacyPi =
    existingPi?.driver === PI_DRIVER &&
    existingPi.displayName === LEGACY_BUILT_IN_ASSISTANT_NAME;

  if (!firstRun && !upgradingDim && !renamingLegacyPi) return settings;

  const seededSelection = resolveSeedSelection(options);
  const dimMigrationTarget: ModelSelection = seededSelection ?? {
    instanceId: PI_INSTANCE_ID,
    model: PI_INHERIT_MODEL,
  };

  const projectSettingsOverrides = upgradingDim
    ? Object.fromEntries(
        Object.entries(settings.projectSettingsOverrides).map(([id, overrides]) => {
          const { [DIM_INSTANCE_ID]: dimOverride, ...overrideProviders } =
            overrides.providerInstances ?? {};
          return [
            id,
            {
              ...overrides,
              ...migrateModelSelections(overrides, dimMigrationTarget),
              ...(dimOverride === undefined
                ? {}
                : {
                    providerInstances: {
                      ...overrideProviders,
                      [PI_INSTANCE_ID]: overrideProviders[PI_INSTANCE_ID] ?? dimOverride,
                    },
                  }),
            },
          ];
        }),
      )
    : settings.projectSettingsOverrides;

  const nextPiInstance =
    existingPi === undefined
      ? {
          driver: PI_DRIVER,
          displayName: BUILT_IN_ASSISTANT_NAME,
          enabled: dim === undefined || resolveProviderInstanceEnabled(dim),
        }
      : renamingLegacyPi
        ? {
            ...existingPi,
            displayName: BUILT_IN_ASSISTANT_NAME,
          }
        : existingPi;

  return {
    ...settings,
    ...(upgradingDim ? migrateModelSelections(settings, dimMigrationTarget) : {}),
    ...(firstRun && settings.defaultModelSelection === null && seededSelection !== null
      ? { defaultModelSelection: seededSelection }
      : {}),
    projectSettingsOverrides,
    providerInstances: {
      ...providers,
      ...(upgradingDim
        ? {
            [DIM_INSTANCE_ID]: {
              driver: dim.driver,
              displayName: "旧版助手（Dim）",
              enabled: false,
            },
          }
        : {}),
      [PI_INSTANCE_ID]: nextPiInstance,
    },
  };
}
