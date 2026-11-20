import {
  THEME_COLOR_ROLES,
  type ThemeColorRole,
} from "@t3tools/shared/themePalettes";

import { getThemeColorVariable, isThemeColor } from "./themePalette";

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

  for (const [role, value] of Object.entries(plugin.theme.tokens)) {
    if (!themeRoles.has(role) || !isThemeColor(value)) {
      rejectedRoles.push(role);
      continue;
    }
    const themeRole = role as ThemeColorRole;
    root.style.setProperty(getThemeColorVariable(themeRole), value);
    appliedRoles.push(themeRole);
  }

  return {
    appliedRoles,
    rejectedRoles,
    dispose: () => {
      for (const role of appliedRoles) root.style.removeProperty(getThemeColorVariable(role));
    },
  };
}
