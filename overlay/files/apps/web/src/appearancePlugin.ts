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
const WINDOW_WASH_VARIABLE = "--xtwork-window-wash";

export function applyAppearancePluginTheme(
  root: HTMLElement,
  plugin: AppearancePluginTheme,
): AppearanceApplication {
  const appliedRoles: ThemeColorRole[] = [];
  const rejectedRoles: string[] = [];
  const previousRoleValues: Array<readonly [string, string]> = [];

  for (const [role, value] of Object.entries(plugin.theme.tokens)) {
    if (!themeRoles.has(role) || !isThemeColor(value)) {
      rejectedRoles.push(role);
      continue;
    }
    const themeRole = role as ThemeColorRole;
    const variable = getThemeColorVariable(themeRole);
    previousRoleValues.push([variable, root.style.getPropertyValue(variable)]);
    root.style.setProperty(variable, value);
    appliedRoles.push(themeRole);
  }

  const dataset = (root as { dataset?: DOMStringMap }).dataset;
  let hadWash = false;
  let previousWash = "";

  if (appliedRoles.length > 0) {
    if (dataset) {
      hadWash = "xtworkWash" in dataset;
    }
    previousWash = root.style.getPropertyValue(WINDOW_WASH_VARIABLE);
    if (dataset && hadWash) {
      delete dataset.xtworkWash;
    }
    if (hadWash || previousWash !== "") {
      root.style.removeProperty(WINDOW_WASH_VARIABLE);
    }
  }

  return {
    appliedRoles,
    rejectedRoles,
    dispose: () => {
      for (let index = previousRoleValues.length - 1; index >= 0; index -= 1) {
        const [variable, previousValue] = previousRoleValues[index]!;
        if (previousValue !== "") {
          root.style.setProperty(variable, previousValue);
        } else {
          root.style.removeProperty(variable);
        }
      }
      if (dataset && hadWash) {
        dataset.xtworkWash = "";
      }
      if (previousWash !== "") {
        root.style.setProperty(WINDOW_WASH_VARIABLE, previousWash);
      }
    },
  };
}
