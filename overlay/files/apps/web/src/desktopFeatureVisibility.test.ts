import { expect, it } from "vite-plus/test";
import {
  isDesktopSettingsPathVisible,
  isDesktopSettingVisible,
  isDesktopShortcutVisible,
  resolveVisibleProviderStatuses,
  showAssistantModelPicker,
} from "./desktopFeatureVisibility";

it("keeps developer settings and commands behind the switch while leaving changes available", () => {
  for (const path of ["/settings/providers", "/settings/worktrees", "/settings/source-control"]) {
    expect(isDesktopSettingsPathVisible(path, false)).toBe(false);
    expect(isDesktopSettingsPathVisible(path, true)).toBe(true);
  }
  for (const command of [
    "terminal.toggle",
    "editor.openFavorite",
    "composer.workspace",
    "composer.branch",
    "pullRequest.copyNumber",
  ]) {
    expect(isDesktopShortcutVisible(command, false)).toBe(false);
    expect(isDesktopShortcutVisible(command, true)).toBe(true);
  }
  expect(isDesktopShortcutVisible("diff.toggle", false)).toBe(true);
  expect(isDesktopShortcutVisible("usage.open", false)).toBe(true);
  expect(isDesktopSettingsPathVisible("/settings/diffs", false)).toBe(true);
  expect(isDesktopSettingVisible({ to: "/settings/diffs", id: "proactive-panels" }, false)).toBe(
    false,
  );
});

it("does not publish unavailable shell functions in developer mode", () => {
  for (const to of [
    "/settings/browser",
    "/settings/snap-shot",
    "/settings/connections",
    "/settings/access",
    "/settings/devices",
  ]) {
    expect(isDesktopSettingsPathVisible(to, true)).toBe(false);
  }
  for (const id of ["cli-command", "mobile-app", "welcome-page"]) {
    expect(isDesktopSettingVisible({ to: "/settings/about", id }, true)).toBe(false);
  }
  expect(isDesktopShortcutVisible("preview.toggle", true)).toBe(false);
});

it("omits the picker for the only built-in model and restores it when there is a choice", () => {
  const assistant = {
    instanceId: "xtworkPi",
    enabled: true,
    isAvailable: true,
    models: [{ slug: "default" }, { slug: "xtwork/standard" }],
  };
  const otherModel = {
    ...assistant,
    models: [...assistant.models, { ...assistant.models[0]!, slug: "xtwork/second" }],
  };
  expect(showAssistantModelPicker([assistant], false)).toBe(false);
  expect(showAssistantModelPicker([assistant], true)).toBe(true);
  expect(showAssistantModelPicker([otherModel], false)).toBe(true);
});

it("keeps an already-started external runtime available when developer features are turned off", () => {
  const allProviders = [
    { instanceId: "xtworkPi" },
    { instanceId: "codex" },
    { instanceId: "claudeAgent" },
  ];
  expect(
    resolveVisibleProviderStatuses({
      allProviders,
      developerFeatures: false,
      boundInstanceId: null,
    }),
  ).toEqual([{ instanceId: "xtworkPi" }]);
  expect(
    resolveVisibleProviderStatuses({
      allProviders,
      developerFeatures: false,
      boundInstanceId: "codex",
    }),
  ).toEqual([{ instanceId: "xtworkPi" }, { instanceId: "codex" }]);
  expect(
    resolveVisibleProviderStatuses({
      allProviders,
      developerFeatures: true,
      boundInstanceId: null,
    }),
  ).toEqual(allProviders);
});
