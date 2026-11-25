import { expect, it } from "vite-plus/test";
import {
  isDesktopSettingsPathVisible,
  isDesktopSettingVisible,
  isDesktopShortcutVisible,
  isOrdinaryModeProviderVisible,
  resolveVisibleProviderStatuses,
  showAssistantModelPicker,
  sortOrdinaryModeProviderRows,
} from "./desktopFeatureVisibility";

it("exposes providers in ordinary mode while keeping git/worktree/terminal developer entries gated", () => {
  expect(isDesktopSettingsPathVisible("/settings/providers", false)).toBe(true);
  expect(isDesktopSettingsPathVisible("/settings/providers", true)).toBe(true);
  expect(isDesktopSettingVisible({ to: "/settings/providers", id: "providers" }, false)).toBe(true);
  expect(isDesktopSettingVisible({ to: "/settings/secrets", id: "secret-providers" }, false)).toBe(
    false,
  );
  for (const path of ["/settings/worktrees", "/settings/source-control"]) {
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
  expect(isDesktopShortcutVisible("preview.toggle", false)).toBe(true);
  expect(isDesktopShortcutVisible("preview.refresh", false)).toBe(true);
  expect(isDesktopShortcutVisible("usage.open", false)).toBe(true);
  expect(isDesktopSettingsPathVisible("/settings/diffs", false)).toBe(true);
  expect(isDesktopSettingsPathVisible("/settings/browser", false)).toBe(true);
  expect(isDesktopSettingsPathVisible("/settings/remote-connections", false)).toBe(true);
  expect(isDesktopSettingVisible({ to: "/settings/diffs", id: "proactive-panels" }, false)).toBe(
    false,
  );
});

it("does not publish unavailable shell functions in developer mode", () => {
  for (const to of [
    "/settings/snap-shot",
    "/settings/connections",
    "/settings/access",
    "/settings/devices",
  ]) {
    expect(isDesktopSettingsPathVisible(to, true)).toBe(false);
  }
  for (const id of [
    "browser-recording-key-presses",
    "browser-recording-mouse-presses",
    "cli-command",
    "mobile-app",
    "welcome-page",
  ]) {
    expect(isDesktopSettingVisible({ to: "/settings/about", id }, true)).toBe(false);
  }
  expect(isDesktopSettingVisible({ to: "/settings/browser", id: "browser-profiles" }, false)).toBe(
    true,
  );
  expect(
    isDesktopSettingVisible({ to: "/settings/browser", id: "browser-recording-key-presses" }, true),
  ).toBe(false);
  expect(isDesktopShortcutVisible("preview.find", true)).toBe(false);
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

it("curates ordinary-mode providers to the 1+6 set plus custom and bound providers", () => {
  const allProviders = [
    { instanceId: "xtworkPi" },
    { instanceId: "claudeAgent" },
    { instanceId: "codex" },
    { instanceId: "xtworkKimiCode" },
    { instanceId: "xtworkQoder" },
    { instanceId: "xtworkCodebuddyCode" },
    { instanceId: "xtworkDeepseekHarness" },
    { instanceId: "customAcpAgent" },
    { instanceId: "cursor" },
    { instanceId: "grok" },
    { instanceId: "fx" },
    { instanceId: "opencode" },
    { instanceId: "antigravity" },
    { instanceId: "kiro" },
    { instanceId: "muse" },
  ];

  expect(
    resolveVisibleProviderStatuses({
      allProviders,
      developerFeatures: false,
      boundInstanceId: null,
    }).map((item) => item.instanceId),
  ).toEqual([
    "xtworkPi",
    "claudeAgent",
    "codex",
    "xtworkKimiCode",
    "xtworkQoder",
    "xtworkCodebuddyCode",
    "xtworkDeepseekHarness",
    "customAcpAgent",
  ]);

  expect(
    resolveVisibleProviderStatuses({
      allProviders,
      developerFeatures: false,
      boundInstanceId: "cursor",
    }).map((item) => item.instanceId),
  ).toContain("cursor");

  expect(
    resolveVisibleProviderStatuses({
      allProviders,
      developerFeatures: true,
      boundInstanceId: null,
    }),
  ).toEqual(allProviders);

  expect(
    isOrdinaryModeProviderVisible({
      instanceId: "antigravity",
      developerFeatures: false,
      isExplicitCustom: true,
    }),
  ).toBe(true);

  expect(
    sortOrdinaryModeProviderRows([
      { instanceId: "customAcpAgent" },
      { instanceId: "xtworkDeepseekHarness" },
      { instanceId: "codex" },
      { instanceId: "xtworkPi" },
      { instanceId: "claudeAgent" },
    ]).map((item) => item.instanceId),
  ).toEqual([
    "xtworkPi",
    "claudeAgent",
    "codex",
    "xtworkDeepseekHarness",
    "customAcpAgent",
  ]);
});
