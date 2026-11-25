export const BUILT_IN_ASSISTANT_ID = "xtworkPi";

export const ORDINARY_MODE_CODING_AGENT_IDS = [
  "claudeAgent",
  "codex",
  "xtworkKimiCode",
  "xtworkQoder",
  "xtworkCodebuddyCode",
  "xtworkDeepseekHarness",
] as const;

export const ORDINARY_MODE_PROVIDER_ORDER = [
  BUILT_IN_ASSISTANT_ID,
  ...ORDINARY_MODE_CODING_AGENT_IDS,
] as const;

export const ORDINARY_MODE_PROVIDER_IDS: ReadonlySet<string> = new Set(
  ORDINARY_MODE_PROVIDER_ORDER,
);

const DEVELOPER_ONLY_DEFAULT_PROVIDER_IDS: ReadonlySet<string> = new Set([
  "cursor",
  "grok",
  "fx",
  "opencode",
  "antigravity",
  "kiro",
  "muse",
  "pi",
  "devReplay",
]);

export function isOrdinaryModeProviderVisible(input: {
  readonly instanceId: string;
  readonly developerFeatures: boolean;
  readonly boundInstanceId?: string | null | undefined;
  readonly isExplicitCustom?: boolean | undefined;
}): boolean {
  if (input.developerFeatures) return true;
  if (ORDINARY_MODE_PROVIDER_IDS.has(input.instanceId)) return true;
  if (input.boundInstanceId != null && input.instanceId === input.boundInstanceId) return true;
  if (input.isExplicitCustom === true) return true;
  return !DEVELOPER_ONLY_DEFAULT_PROVIDER_IDS.has(input.instanceId);
}

export function sortOrdinaryModeProviderRows<T extends { readonly instanceId: string }>(
  rows: ReadonlyArray<T>,
): ReadonlyArray<T> {
  const rank = (instanceId: string): number => {
    const index = (ORDINARY_MODE_PROVIDER_ORDER as ReadonlyArray<string>).indexOf(instanceId);
    return index === -1 ? ORDINARY_MODE_PROVIDER_ORDER.length : index;
  };
  return rows
    .map((row, index) => ({ row, index, order: rank(row.instanceId) }))
    .toSorted((left, right) => left.order - right.order || left.index - right.index)
    .map(({ row }) => row);
}

export function resolveVisibleProviderStatuses<T extends { readonly instanceId: string }>(input: {
  readonly allProviders: ReadonlyArray<T>;
  readonly developerFeatures: boolean;
  readonly boundInstanceId: string | null;
}): ReadonlyArray<T> {
  if (input.developerFeatures) return input.allProviders;
  return input.allProviders.filter((provider) =>
    isOrdinaryModeProviderVisible({
      instanceId: provider.instanceId,
      developerFeatures: false,
      boundInstanceId: input.boundInstanceId,
    }),
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
  "secret-providers",
  "secret-providers-add",
]);

const ordinaryProviderSettingIds = new Set([
  "providers",
  "usage-providers",
  "provider-health-check-interval",
  "provider-update-checks",
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
      (!developerSettingIds.has(item.id) &&
        (ordinaryProviderSettingIds.has(item.id) ||
          !/(?:worktree|terminal|provider)/.test(item.id))))
  );
}
