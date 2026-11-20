import {
  DEFAULT_SERVER_SETTINGS,
  ProjectId,
  ProviderDriverKind,
  ProviderInstanceId,
} from "@t3tools/contracts";
import { assert, it } from "@effect/vitest";
import { seedBundledPi } from "./bundledPiSettings.ts";

it("migrates Alpha's explicit model choices and preserves inherited and custom choices", () => {
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
