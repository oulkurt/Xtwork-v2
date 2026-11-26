import type { ThemeAppearance, ThemeColors, ThemeDefinition } from "@t3tools/shared/themePalettes";

// Window washes and pane colors from Kero v2.1.35 theme.go (MIT).
type ThemeSeed = Readonly<{
  stops: readonly [string, ...string[]];
  glow?: string;
  surface: string;
  text: string;
  accent: string;
  selection: string;
}>;

const THEME_SEEDS = {
  default: {
    light: {
      stops: ["#f6f6f7", "#f7f7f8", "#f8f8f8"],
      surface: "#ffffff",
      text: "#292929",
      accent: "#466fbd",
      selection: "#cedffd",
    },
    dark: {
      stops: ["#141416", "#151517", "#161618"],
      glow: "rgb(90 120 200 / 0.10)",
      surface: "#232323",
      text: "#e4e4e4",
      accent: "#7daafd",
      selection: "#314262",
    },
  },
  "t3-chat": {
    light: {
      stops: ["#ebe0f3", "#f3e7f1", "#f7eee4", "#f6efcf"],
      glow: "rgb(247 220 241 / 0.75)",
      surface: "#fff5f9",
      text: "#34232b",
      accent: "#a84e7c",
      selection: "#f7d2e2",
    },
    dark: {
      stops: ["#240f1d", "#26111a", "#271610"],
      glow: "rgb(142 58 110 / 0.30)",
      surface: "#2b1f24",
      text: "#ede1e6",
      accent: "#e887b6",
      selection: "#5a3547",
    },
  },
  grove: {
    light: {
      stops: ["#e2eee5", "#ebf2e7", "#f3f2e2", "#f5f0d6"],
      glow: "rgb(214 240 222 / 0.75)",
      surface: "#f4faf2",
      text: "#212d1e",
      accent: "#448335",
      selection: "#cfe6ca",
    },
    dark: {
      stops: ["#081c0d", "#101d0c", "#1b1c0b"],
      glow: "rgb(6 113 50 / 0.30)",
      surface: "#1e251c",
      text: "#dfe7de",
      accent: "#7dbf6e",
      selection: "#314a2b",
    },
  },
  ocean: {
    light: {
      stops: ["#dbebef", "#e3eff1", "#ecf3f0", "#f2f2e8"],
      glow: "rgb(194 232 238 / 0.75)",
      surface: "#effafc",
      text: "#162d30",
      accent: "#008492",
      selection: "#bce7ec",
    },
    dark: {
      stops: ["#001b22", "#001e1f", "#0b1e1b"],
      glow: "rgb(0 112 128 / 0.30)",
      surface: "#172627",
      text: "#dae8e9",
      accent: "#00c2d2",
      selection: "#0d4b51",
    },
  },
  ember: {
    light: {
      stops: ["#f5e1d6", "#f8e7dc", "#f8eedf", "#f6f0da"],
      glow: "rgb(252 212 194 / 0.78)",
      surface: "#fff6f1",
      text: "#35251b",
      accent: "#ac571d",
      selection: "#f8d6c4",
    },
    dark: {
      stops: ["#2a1207", "#291507", "#25190a"],
      glow: "rgb(151 62 22 / 0.30)",
      surface: "#2b201a",
      text: "#ede2dc",
      accent: "#ec915c",
      selection: "#5c3824",
    },
  },
  iris: {
    light: {
      stops: ["#e4dbf3", "#efdeee", "#f6e3dc", "#f7e6cf"],
      glow: "rgb(246 206 222 / 0.80)",
      surface: "#fbf5fe",
      text: "#2f2433",
      accent: "#8e57a5",
      selection: "#ead6f3",
    },
    dark: {
      stops: ["#190f2e", "#260f24", "#2d140b"],
      glow: "rgb(125 65 138 / 0.30)",
      surface: "#27202a",
      text: "#e8e2ec",
      accent: "#ca91e3",
      selection: "#4e3858",
    },
  },
} satisfies Record<string, Record<ThemeAppearance, ThemeSeed>>;

type BuiltInThemeId = keyof typeof THEME_SEEDS;

export type BuiltInThemeWashSpec = Readonly<{
  stops: readonly [string, ...string[]];
  glow?: string;
  surface: string;
  text: string;
}>;

export function getBuiltInThemeWashSpec(
  id: string,
  appearance: ThemeAppearance,
): BuiltInThemeWashSpec | undefined {
  if (!Object.hasOwn(THEME_SEEDS, id)) return undefined;
  const seed: ThemeSeed = THEME_SEEDS[id as BuiltInThemeId][appearance];
  return {
    stops: seed.stops,
    ...(seed.glow === undefined ? {} : { glow: seed.glow }),
    surface: seed.surface,
    text: seed.text,
  };
}

export function getBuiltInThemeWash(id: string, appearance: ThemeAppearance): string | undefined {
  if (!Object.hasOwn(THEME_SEEDS, id)) return undefined;
  const seed: ThemeSeed = THEME_SEEDS[id as BuiltInThemeId][appearance];
  const base = `linear-gradient(180deg in oklab, ${seed.stops.join(", ")})`;
  return seed.glow
    ? `linear-gradient(225deg in oklab, ${seed.glow}, transparent 50%), ${base}`
    : base;
}

type Rgb = { r: number; g: number; b: number };

function parseHex(value: string): Rgb {
  const hex = value.slice(1);
  return {
    r: Number.parseInt(hex.slice(0, 2), 16),
    g: Number.parseInt(hex.slice(2, 4), 16),
    b: Number.parseInt(hex.slice(4, 6), 16),
  };
}

function toHex(value: number): string {
  return Math.round(value).toString(16).padStart(2, "0");
}

function mixHex(base: string, overlay: string, amount: number): string {
  const first = parseHex(base);
  const second = parseHex(overlay);
  const red = toHex(first.r + (second.r - first.r) * amount);
  const green = toHex(first.g + (second.g - first.g) * amount);
  const blue = toHex(first.b + (second.b - first.b) * amount);
  return `#${red}${green}${blue}`;
}

function makeThemeColors(seed: ThemeSeed, appearance: ThemeAppearance): ThemeColors {
  const dark = appearance === "dark";
  const canvas = seed.stops[0];
  const sidebar = seed.stops[1] ?? canvas;
  const { accent, selection, surface, text: foreground } = seed;
  const surfaceRaised = mixHex(surface, "#ffffff", dark ? 0.025 : 0.6);
  const surfaceOverlay = mixHex(surface, "#ffffff", dark ? 0.04 : 0.6);
  const textMuted = mixHex(foreground, surface, dark ? 0.38 : 0.32);
  const border = mixHex(surface, dark ? "#ffffff" : "#000000", dark ? 0.07 : 0.06);
  const input = mixHex(surface, foreground, dark ? 0.28 : 0.19);
  const secondary = mixHex(surface, foreground, dark ? 0.07 : 0.045);
  const muted = mixHex(surface, foreground, dark ? 0.07 : 0.045);
  const control = dark ? "#404047" : "#ffffff";
  // UI action text also has to stay legible on bright dark-mode accents.
  const action = dark ? accent : mixHex(accent, "#000000", 0.06);
  const accentForeground = dark ? canvas : "#ffffff";
  const error = dark ? "#ff6961" : "#d93a35";
  const errorForeground = dark ? "#ffb8b0" : "#8f241f";
  const warning = dark ? "#f0b94e" : "#c27b0f";
  const warningForeground = dark ? "#ffdf8f" : "#714500";
  const searchMatchBackground = dark ? "#705525" : "#f8e38a";
  const searchMatchActiveBackground = dark ? "#a87a29" : "#d39a2d";

  return {
    canvas,
    chrome: canvas,
    toolbar: surfaceRaised,
    toolbarForeground: foreground,
    toolbarBorder: border,
    toolbarControl: control,
    toolbarControlForeground: foreground,
    toolbarControlHover: dark ? "#4a4a52" : "#f7f7f9",
    surface,
    surfaceRaised,
    surfaceOverlay,
    text: foreground,
    textMuted,
    border,
    input,
    focus: accent,
    accent,
    accentForeground,
    secondary,
    secondaryForeground: foreground,
    muted,
    mutedForeground: textMuted,
    placeholder: textMuted,
    secondaryLabel: textMuted,
    iconMuted: textMuted,
    error,
    errorForeground,
    errorSurface: mixHex(canvas, error, dark ? 0.22 : 0.1),
    warning,
    warningForeground,
    warningSurface: mixHex(canvas, warning, dark ? 0.22 : 0.1),
    update: accent,
    updateForeground: mixHex(accent, foreground, 0.22),
    updateSurface: mixHex(canvas, accent, dark ? 0.2 : 0.12),
    accentSurface: selection,
    accentSurfaceForeground: foreground,
    messageSurface: selection,
    messageForeground: foreground,
    messageAction: action,
    messageActionForeground: accentForeground,
    messageActionHover: mixHex(action, "#000000", 0.08),
    codeBackground: secondary,
    codeForeground: foreground,
    searchMatchBackground,
    searchMatchForeground: dark ? "#ffffff" : "#21180a",
    searchMatchActiveBackground,
    searchMatchActiveForeground: "#21180a",
    sidebar,
    sidebarForeground: foreground,
    sidebarMutedForeground: textMuted,
    sidebarControlSurface: control,
    sidebarRowHover: dark ? "#ffffff0d" : "#0000000a",
    sidebarRowActive: dark ? "#ffffff1a" : mixHex(surface, "#ffffff", 0.5),
    sidebarRowSelected: dark ? "#ffffff1a" : mixHex(surface, "#ffffff", 0.5),
    sidebarBorder: border,
    terminalBackground: surface,
    terminalForeground: foreground,
    terminalCursor: accent,
    terminalSelection: selection,
    terminalScrollbar: mixHex(canvas, foreground, dark ? 0.3 : 0.18),
    terminalScrollbarHover: mixHex(canvas, foreground, dark ? 0.42 : 0.28),
  };
}

function makeTheme(id: BuiltInThemeId, label: string): ThemeDefinition {
  return {
    id,
    label,
    appearance: "light",
    colors: makeThemeColors(THEME_SEEDS[id].light, "light"),
    variants: { dark: makeThemeColors(THEME_SEEDS[id].dark, "dark") },
    sidebarArtwork: true,
  };
}

export const PAPER_THEME_LABEL = "纸白";
export const PAPER_THEME_COLORS = {
  light: makeThemeColors(THEME_SEEDS.default.light, "light"),
  dark: makeThemeColors(THEME_SEEDS.default.dark, "dark"),
};

// Retain the existing IDs so saved themes and mixed appearances still resolve.
export const BUILT_IN_PALETTES = {
  petal: makeTheme("t3-chat", "花瓣"),
  meadow: makeTheme("grove", "草甸"),
  tide: makeTheme("ocean", "潮汐"),
  apricot: makeTheme("ember", "暖杏"),
  dusk: makeTheme("iris", "暮色"),
};
