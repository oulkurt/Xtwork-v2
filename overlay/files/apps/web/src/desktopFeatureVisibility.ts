export const BUILT_IN_ASSISTANT_ID = "xtworkPi";

export function resolveVisibleProviderStatuses<T extends { readonly instanceId: string }>(input: {
  readonly allProviders: ReadonlyArray<T>;
  readonly developerFeatures: boolean;
  readonly boundInstanceId: string | null;
}): ReadonlyArray<T> {
  if (input.developerFeatures) return input.allProviders;
  return input.allProviders.filter(
    (provider) =>
      provider.instanceId === BUILT_IN_ASSISTANT_ID ||
      (input.boundInstanceId !== null && provider.instanceId === input.boundInstanceId),
  );
}

export function isXtworkDesktop(): boolean {
  return (
    typeof window !== "undefined" &&
    window.desktopBridge !== undefined &&
    "xtwork" in window.desktopBridge
  );
}

export function isDesktopShortcutVisible(command: string, developerFeatures: boolean): boolean {
  if (command === "preview.find" || command.startsWith("snapShot.")) return false;
  if (developerFeatures) return true;
  return !(
    /^(?:terminal\.|script\.|projectScript\.|provider\.|pullRequest\.)/.test(command) ||
    [
      "editor.openFavorite",
      "composer.cycleHost",
      "composer.branch",
      "composer.host",
      "composer.workspace",
      "composer.previousWorktree",
    ].includes(command)
  );
}

export function showAssistantModelPicker(
  entries: ReadonlyArray<{
    readonly instanceId: string;
    readonly enabled: boolean;
    readonly isAvailable: boolean;
    readonly models: ReadonlyArray<{ readonly slug: string }>;
  }>,
  developerFeatures: boolean,
): boolean {
  if (developerFeatures) return true;
  const models = entries
    .filter((entry) => entry.enabled && entry.isAvailable)
    .flatMap((entry) =>
      entry.models.flatMap(({ slug }) =>
        entry.instanceId === BUILT_IN_ASSISTANT_ID && slug === "default"
          ? []
          : [[entry.instanceId, slug]],
      ),
    );
  return (
    models.length > 1 ||
    models.some(([id, slug]) => id !== BUILT_IN_ASSISTANT_ID || slug !== "xtwork/standard")
  );
}

const unsupportedSettingsPaths = new Set([
  "/settings/access",
  "/settings/connections",
  "/settings/devices",
  "/settings/snap-shot",
]);

const developerSettingsPaths = new Set([
  "/settings/providers",
  "/settings/source-control",
  "/settings/worktrees",
]);

const unsupportedSettingIds = new Set([
  "browser-recording-key-presses",
  "browser-recording-mouse-presses",
  "cli-command",
  "linked-environments",
  "mobile-app",
  "simlock-hosts",
  "welcome-page",
]);

const developerSettingIds = new Set([
  "composer-context",
  "proactive-panels",
  "pull-request-links-open-in-app",
  "text-generation-model",
  "git-fetch-interval",
  "default-model",
  "fallback-model",
]);

export function isDesktopSettingsPathVisible(path: string, developerFeatures: boolean): boolean {
  return (
    !unsupportedSettingsPaths.has(path) && (developerFeatures || !developerSettingsPaths.has(path))
  );
}

export function isDesktopSettingVisible(
  item: { readonly to: string; readonly id: string },
  developerFeatures: boolean,
): boolean {
  return (
    isDesktopSettingsPathVisible(item.to, developerFeatures) &&
    !unsupportedSettingIds.has(item.id) &&
    (!item.id.startsWith("keybinding-") ||
      isDesktopShortcutVisible(item.id.slice("keybinding-".length), developerFeatures)) &&
    (developerFeatures ||
      (!developerSettingIds.has(item.id) && !/(?:worktree|terminal|provider)/.test(item.id)))
  );
}
