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

const piSelection: ModelSelection = {
  instanceId: PI_INSTANCE_ID,
  model: `${MODEL_PROVIDER}/${STANDARD_MODEL}`,
};

export function seedBundledPi(settings: ServerSettings, firstRun: boolean): ServerSettings {
  const { [DIM_INSTANCE_ID]: dim, ...providers } = settings.providerInstances;
  const upgradingDim = dim?.driver === "acpRegistry" && dim.config !== undefined;
  if (!firstRun && !upgradingDim) return settings;

  const defaultModelSelection = settings.defaultModelSelection;
  const fallbackModelSelection = settings.fallbackModelSelection;
  const projectSettingsOverrides = Object.fromEntries(
    Object.entries(settings.projectSettingsOverrides).map(([id, overrides]) => {
      const { [DIM_INSTANCE_ID]: dimOverride, ...providers } = overrides.providerInstances ?? {};
      return [id, {
        ...overrides,
        ...(overrides.defaultModelSelection?.instanceId === DIM_INSTANCE_ID
          ? { defaultModelSelection: piSelection }
          : {}),
        ...(overrides.textGenerationModelSelection?.instanceId === DIM_INSTANCE_ID
          ? { textGenerationModelSelection: piSelection }
          : {}),
        ...(dimOverride === undefined ? {} : {
          providerInstances: { ...providers, [PI_INSTANCE_ID]: providers[PI_INSTANCE_ID] ?? dimOverride },
        }),
      }];
    }),
  );

  return {
    ...settings,
    defaultModelSelection:
      (firstRun && defaultModelSelection === null) || defaultModelSelection?.instanceId === DIM_INSTANCE_ID
        ? piSelection
        : defaultModelSelection,
    fallbackModelSelection:
      fallbackModelSelection?.instanceId === DIM_INSTANCE_ID ? piSelection : fallbackModelSelection,
    textGenerationModelSelection:
      settings.textGenerationModelSelection.instanceId === DIM_INSTANCE_ID
        ? piSelection
        : settings.textGenerationModelSelection,
    projectSettingsOverrides,
    providerInstances: {
      ...providers,
      ...(upgradingDim ? {
        [DIM_INSTANCE_ID]: { driver: dim.driver, displayName: "旧版助手（Dim）", enabled: false },
      } : {}),
      [PI_INSTANCE_ID]: providers[PI_INSTANCE_ID] ?? {
        driver: PI_DRIVER,
        displayName: "内置助手",
        enabled: dim === undefined || resolveProviderInstanceEnabled(dim),
      },
    },
  };
}
