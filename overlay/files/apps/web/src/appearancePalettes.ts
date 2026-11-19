import type { ThemeAppearance, ThemeColors, ThemeDefinition } from "@t3tools/shared/themePalettes";

/**
 * Kero's built-in washes, adapted from egoist/kero theme.go (MIT).
 *
 * The web app uses flat semantic roles, so the wash stops become the canvas
 * and surface hierarchy while the hue-specific accents keep controls and
 * status colours coherent in both appearances.
 */
type ThemeSeed = Readonly<{
  lightCanvas: string;
  darkCanvas: string;
  lightAccent: string;
  darkAccent: string;
}>;

const THEME_SEEDS = {
  paper: {
    lightCanvas: "#f6f6f7",
    darkCanvas: "#141416",
    lightAccent: "#3b6cf6",
    darkAccent: "#6b93ff",
  },
  petal: {
    lightCanvas: "#ebe0f3",
    darkCanvas: "#240f1d",
    lightAccent: "#a83f82",
    darkAccent: "#e07ab4",
  },
  meadow: {
    lightCanvas: "#e2eee5",
    darkCanvas: "#081c0d",
    lightAccent: "#2f7d50",
    darkAccent: "#65c886",
  },
  tide: {
    lightCanvas: "#dbebef",
    darkCanvas: "#001b22",
    lightAccent: "#247c8a",
    darkAccent: "#57c7d4",
  },
  apricot: {
    lightCanvas: "#f5e1d6",
    darkCanvas: "#2a1207",
    lightAccent: "#b65e27",
    darkAccent: "#f0a16c",
  },
  dusk: {
    lightCanvas: "#e4dbf3",
    darkCanvas: "#190f2e",
    lightAccent: "#7f4aa5",
    darkAccent: "#c28ce6",
  },
};

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
  const canvas = dark ? seed.darkCanvas : seed.lightCanvas;
  const accent = dark ? seed.darkAccent : seed.lightAccent;
  const foreground = dark ? "#ececf0" : "#1d1d1f";
  const surface = mixHex(canvas, "#ffffff", dark ? 0.08 : 0.62);
  const surfaceRaised = mixHex(surface, "#ffffff", dark ? 0.08 : 0.16);
  const surfaceOverlay = mixHex(surfaceRaised, "#ffffff", dark ? 0.08 : 0.15);
  const sidebar = mixHex(canvas, dark ? "#000000" : "#ffffff", dark ? 0.08 : 0.12);
  const textMuted = mixHex(foreground, canvas, dark ? 0.48 : 0.35);
  const border = mixHex(canvas, foreground, dark ? 0.22 : 0.14);
  const input = mixHex(canvas, foreground, dark ? 0.32 : 0.22);
  const secondary = mixHex(surface, foreground, dark ? 0.08 : 0.04);
  const muted = mixHex(surface, foreground, dark ? 0.05 : 0.025);
  const accentSurface = mixHex(surface, accent, dark ? 0.22 : 0.12);
  const messageSurface = mixHex(surface, accent, dark ? 0.16 : 0.12);
  const codeBackground = mixHex(surface, canvas, dark ? 0.45 : 0.18);
  const accentForeground = dark ? canvas : "#ffffff";
  const error = dark ? "#ff6961" : "#d93a35";
  const errorForeground = dark ? "#ffb8b0" : "#8f241f";
  const warning = dark ? "#f0b94e" : "#c27b0f";
  const warningForeground = dark ? "#ffdf8f" : "#714500";
  const searchMatchBackground = dark ? "#705525" : "#f0d98a";
  const searchMatchActiveBackground = dark ? "#a87a29" : "#d39a2d";

  return {
    canvas,
    chrome: canvas,
    toolbar: canvas,
    toolbarForeground: foreground,
    toolbarBorder: border,
    toolbarControl: surfaceRaised,
    toolbarControlForeground: foreground,
    toolbarControlHover: mixHex(surfaceRaised, accent, dark ? 0.12 : 0.08),
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
    mutedForeground: dark ? "#b5b5ba" : textMuted,
    placeholder: dark ? "#b5b5ba" : textMuted,
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
    accentSurface,
    accentSurfaceForeground: foreground,
    messageSurface,
    messageForeground: foreground,
    messageAction: accent,
    messageActionForeground: accentForeground,
    messageActionHover: mixHex(accent, dark ? "#ffffff" : "#000000", dark ? 0.14 : 0.12),
    codeBackground,
    codeForeground: foreground,
    searchMatchBackground,
    searchMatchForeground: dark ? "#ffffff" : "#21180a",
    searchMatchActiveBackground,
    searchMatchActiveForeground: "#21180a",
    sidebar,
    sidebarForeground: foreground,
    sidebarMutedForeground: textMuted,
    sidebarControlSurface: mixHex(sidebar, foreground, dark ? 0.1 : 0.08),
    sidebarRowHover: mixHex(sidebar, accent, dark ? 0.12 : 0.06),
    sidebarRowActive: mixHex(sidebar, accent, dark ? 0.18 : 0.1),
    sidebarRowSelected: mixHex(sidebar, accent, dark ? 0.14 : 0.08),
    sidebarBorder: border,
    terminalBackground: canvas,
    terminalForeground: foreground,
    terminalCursor: accent,
    terminalSelection: mixHex(canvas, accent, dark ? 0.32 : 0.22),
    terminalScrollbar: mixHex(canvas, foreground, dark ? 0.3 : 0.18),
    terminalScrollbarHover: mixHex(canvas, foreground, dark ? 0.42 : 0.28),
  };
}

function makeTheme(id: string, label: string, seed: ThemeSeed): ThemeDefinition {
  return {
    id,
    label,
    appearance: "light",
    colors: makeThemeColors(seed, "light"),
    variants: { dark: makeThemeColors(seed, "dark") },
    sidebarArtwork: true,
  };
}

export const PAPER_THEME_LABEL = "纸白";
export const PAPER_THEME_COLORS = {
  light: makeThemeColors(THEME_SEEDS.paper, "light"),
  dark: makeThemeColors(THEME_SEEDS.paper, "dark"),
};

// Retain the existing IDs so saved themes and mixed appearances still resolve.
export const BUILT_IN_PALETTES = {
  petal: makeTheme("t3-chat", "花瓣", THEME_SEEDS.petal),
  meadow: makeTheme("grove", "草甸", THEME_SEEDS.meadow),
  tide: makeTheme("ocean", "潮汐", THEME_SEEDS.tide),
  apricot: makeTheme("ember", "暖杏", THEME_SEEDS.apricot),
  dusk: makeTheme("iris", "暮色", THEME_SEEDS.dusk),
};
