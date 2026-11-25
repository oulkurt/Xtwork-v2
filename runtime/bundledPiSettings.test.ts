import {
  DEFAULT_SERVER_SETTINGS,
  ProjectId,
  ProviderDriverKind,
  ProviderInstanceId,
} from "@t3tools/contracts";
import { assert, it } from "@effect/vitest";
import {
  BUILT_IN_ASSISTANT_NAME,
  LEGACY_BUILT_IN_ASSISTANT_NAME,
  PI_DRIVER,
  PI_INSTANCE_ID,
  seedBundledPi,
} from "./bundledPiSettings.ts";

it("migrates Alpha's explicit model choices, renames default assistant to 小瞳, and preserves custom choices", () => {
  const dim = { instanceId: ProviderInstanceId.make("xtworkDim"), model: "default" };
  const pi = { instanceId: ProviderInstanceId.make("xtworkPi"), model: "xtwork/standard" };
  const custom = { instanceId: ProviderInstanceId.make("codex"), model: "gpt-6.2-sol" };
  const migratedProject = ProjectId.make("project-with-dim");
  const customProject = ProjectId.make("project-with-custom-model");
  const customOverrides = { sourceControlWriterModelSelection: custom, reviewGuideModelSelection: null };

  const migrated = seedBundledPi({
    ...DEFAULT_SERVER_SETTINGS,
    providerInstances: {
      [dim.instanceId]: { driver: ProviderDriverKind.make("acpRegistry"), enabled: true, config: {} },
    },
    sourceControlWriterModelSelection: dim,
    reviewGuideModelSelection: dim,
    speechPostProcessingModelSelection: dim,
    projectSettingsOverrides: {
      [migratedProject]: { sourceControlWriterModelSelection: dim, reviewGuideModelSelection: dim },
      [customProject]: customOverrides,
    },
  }, false);

  assert.equal(migrated.providerInstances[PI_INSTANCE_ID]?.displayName, BUILT_IN_ASSISTANT_NAME);
  assert.deepEqual(migrated.sourceControlWriterModelSelection, pi);
  assert.deepEqual(migrated.reviewGuideModelSelection, pi);
  assert.deepEqual(migrated.speechPostProcessingModelSelection, pi);
  assert.deepEqual(migrated.projectSettingsOverrides[migratedProject], {
    sourceControlWriterModelSelection: pi,
    reviewGuideModelSelection: pi,
  });
  assert.deepEqual(migrated.projectSettingsOverrides[customProject], customOverrides);
  assert.strictEqual(seedBundledPi(migrated, false), migrated);
});

it("smoothly upgrades legacy displayName '内置助手' to '小瞳' while preserving user-customized names", () => {
  const legacySettings = {
    ...DEFAULT_SERVER_SETTINGS,
    providerInstances: {
      [PI_INSTANCE_ID]: {
        driver: PI_DRIVER,
        displayName: LEGACY_BUILT_IN_ASSISTANT_NAME,
        enabled: true,
      },
    },
  };
  const upgraded = seedBundledPi(legacySettings, false);
  assert.equal(upgraded.providerInstances[PI_INSTANCE_ID]?.displayName, BUILT_IN_ASSISTANT_NAME);
  assert.strictEqual(seedBundledPi(upgraded, false), upgraded);

  const customNamedSettings = {
    ...DEFAULT_SERVER_SETTINGS,
    providerInstances: {
      [PI_INSTANCE_ID]: {
        driver: PI_DRIVER,
        displayName: "我的专属助手",
        enabled: true,
      },
    },
  };
  const untouched = seedBundledPi(customNamedSettings, false);
  assert.strictEqual(untouched, customNamedSettings);
  assert.equal(untouched.providerInstances[PI_INSTANCE_ID]?.displayName, "我的专属助手");
});

it("handles zero-channel onboarding and channel-scoped model identity cleanly on first run", () => {
  const zeroChannel = seedBundledPi(DEFAULT_SERVER_SETTINGS, true, { defaultModelSlug: null });
  assert.equal(zeroChannel.providerInstances[PI_INSTANCE_ID]?.displayName, BUILT_IN_ASSISTANT_NAME);
  assert.equal(zeroChannel.defaultModelSelection, null);

  const companySeeded = seedBundledPi(DEFAULT_SERVER_SETTINGS, true, {
    defaultModelSlug: "xiaotong-work-team/deepseek-flash",
  });
  assert.equal(companySeeded.providerInstances[PI_INSTANCE_ID]?.displayName, BUILT_IN_ASSISTANT_NAME);
  assert.deepEqual(companySeeded.defaultModelSelection, {
    instanceId: PI_INSTANCE_ID,
    model: "xiaotong-work-team/deepseek-flash",
  });
});
