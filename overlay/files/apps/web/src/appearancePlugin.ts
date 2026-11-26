import {
  THEME_COLOR_ROLES,
  type ThemeColorRole,
} from "@t3tools/shared/themePalettes";

import { isThemeColor, registerAppearancePluginLayer } from "./themePalette";

export type AppearancePluginTheme = Readonly<{
  pluginId: string;
  kind: "appearance";
  theme: Readonly<{
    id: string;
    tokens: Readonly<Record<string, string>>;
  }>;
}>;

export type AppearanceApplication = Readonly<{
  appliedRoles: ReadonlyArray<ThemeColorRole>;
  rejectedRoles: ReadonlyArray<string>;
  dispose: () => void;
}>;

const themeRoles = new Set<string>(THEME_COLOR_ROLES);

export function applyAppearancePluginTheme(
  root: HTMLElement,
  plugin: AppearancePluginTheme,
): AppearanceApplication {
  const appliedRoles: ThemeColorRole[] = [];
  const rejectedRoles: string[] = [];
  const validTokens: Partial<Record<ThemeColorRole, string>> = {};

  for (const [role, value] of Object.entries(plugin.theme.tokens)) {
    if (!themeRoles.has(role) || !isThemeColor(value)) {
      rejectedRoles.push(role);
      continue;
    }
    const themeRole = role as ThemeColorRole;
    validTokens[themeRole] = value;
    appliedRoles.push(themeRole);
  }

  if (appliedRoles.length === 0) {
    return {
      appliedRoles,
      rejectedRoles,
      dispose: () => {},
    };
  }

  const releaseLayer = registerAppearancePluginLayer(root, validTokens);

  let disposed = false;
  return {
    appliedRoles,
    rejectedRoles,
    dispose: () => {
      if (disposed) return;
      disposed = true;
      releaseLayer();
    },
  };
}
