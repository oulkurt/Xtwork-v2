import { describe, expect, it, vi } from "vite-plus/test";

import { getBuiltInThemeWash } from "./appearancePalettes";
import { applyAppearancePluginTheme } from "./appearancePlugin";
import { applyThemePalette, getThemeColorsForMode, getThemeDefinition } from "./themePalette";

function createMockRoot(options?: {
  values?: ReadonlyArray<readonly [string, string]>;
  dataset?: Record<string, string | undefined>;
}) {
  const values = new Map<string, string>(options?.values);
  const dataset = options?.dataset;
  const root = (
    dataset === undefined
      ? {
          style: {
            setProperty: (name: string, value: string) => values.set(name, value),
            removeProperty: (name: string) => values.delete(name),
            getPropertyValue: (name: string) => values.get(name) ?? "",
          },
        }
      : {
          dataset,
          style: {
            setProperty: (name: string, value: string) => values.set(name, value),
            removeProperty: (name: string) => values.delete(name),
            getPropertyValue: (name: string) => values.get(name) ?? "",
          },
        }
  ) as unknown as HTMLElement;
  return { root, values, dataset };
}

describe("applyAppearancePluginTheme", () => {
  it("applies only supported theme roles and can restore them", () => {
    const { root, values } = createMockRoot();
    const application = applyAppearancePluginTheme(root, {
      pluginId: "paper-dark",
      kind: "appearance",
      theme: {
        id: "paper-dark",
        tokens: {
          canvas: "#101010",
          text: "#f7f7f7",
          "app.unsafe": "#fff",
        },
      },
    });

    expect(application.appliedRoles).toEqual(["canvas", "text"]);
    expect(application.rejectedRoles).toEqual(["app.unsafe"]);
    expect(values.get("--app-theme-canvas")).toBe("#101010");

    application.dispose();
    expect(values.get("--app-theme-canvas")).toBeUndefined();
  });

  it("clears built-in window wash while keeping theme tokens active and restores prior values and wash on dispose", () => {
    const wash = "linear-gradient(180deg in oklab, #ebe0f3, #f3e7f1, #f7eee4, #f6efcf)";
    const { root, values, dataset } = createMockRoot({
      values: [
        ["--xtwork-window-wash", wash],
        ["--app-theme-canvas", "#ebe0f3"],
        ["--app-theme-surface", "#fff5f9"],
      ],
      dataset: { xtworkWash: "", xtworkThemeTokens: "" },
    });

    const application = applyAppearancePluginTheme(root, {
      pluginId: "custom-plugin",
      kind: "appearance",
      theme: {
        id: "custom-plugin",
        tokens: {
          canvas: "#121212",
          surface: "#1c1c1c",
          text: "#f5f5f5",
        },
      },
    });

    expect(application.appliedRoles).toEqual(["canvas", "surface", "text"]);
    expect("xtworkWash" in dataset!).toBe(false);
    expect(dataset!.xtworkWash).toBeUndefined();
    expect("xtworkThemeTokens" in dataset!).toBe(true);
    expect(dataset!.xtworkThemeTokens).toBe("");
    expect(values.get("--xtwork-window-wash")).toBeUndefined();
    expect(values.get("--app-theme-canvas")).toBe("#121212");
    expect(values.get("--app-theme-surface")).toBe("#1c1c1c");
    expect(values.get("--app-theme-text")).toBe("#f5f5f5");

    application.dispose();
    expect(values.get("--app-theme-canvas")).toBe("#ebe0f3");
    expect(values.get("--app-theme-surface")).toBe("#fff5f9");
    expect(values.get("--app-theme-text")).toBeUndefined();
    expect("xtworkWash" in dataset!).toBe(true);
    expect(dataset!.xtworkWash).toBe("");
    expect("xtworkThemeTokens" in dataset!).toBe(true);
    expect(dataset!.xtworkThemeTokens).toBe("");
    expect(values.get("--xtwork-window-wash")).toBe(wash);
  });

  it("leaves built-in window wash untouched when zero valid roles apply", () => {
    const wash = "linear-gradient(180deg in oklab, #e2eee5, #ebf2e7, #f3f2e2, #f5f0d6)";
    const { root, values, dataset } = createMockRoot({
      values: [["--xtwork-window-wash", wash]],
      dataset: { xtworkWash: "" },
    });

    const application = applyAppearancePluginTheme(root, {
      pluginId: "invalid-plugin",
      kind: "appearance",
      theme: {
        id: "invalid-plugin",
        tokens: {
          "app.unsafe": "#fff",
          canvas: "not-a-color",
        },
      },
    });

    expect(application.appliedRoles).toEqual([]);
    expect(application.rejectedRoles).toEqual(["app.unsafe", "canvas"]);
    expect("xtworkWash" in dataset!).toBe(true);
    expect(dataset!.xtworkWash).toBe("");
    expect("xtworkThemeTokens" in dataset!).toBe(false);
    expect(values.get("--xtwork-window-wash")).toBe(wash);

    application.dispose();
    expect("xtworkWash" in dataset!).toBe(true);
    expect(dataset!.xtworkWash).toBe("");
    expect("xtworkThemeTokens" in dataset!).toBe(false);
    expect(values.get("--xtwork-window-wash")).toBe(wash);
  });

  it("does not add window wash or leak theme token marker on dispose when neither was active", () => {
    const { root, values, dataset } = createMockRoot({ dataset: {} });

    const application = applyAppearancePluginTheme(root, {
      pluginId: "paper-dark",
      kind: "appearance",
      theme: {
        id: "paper-dark",
        tokens: {
          canvas: "#101010",
        },
      },
    });

    expect(application.appliedRoles).toEqual(["canvas"]);
    expect("xtworkWash" in dataset!).toBe(false);
    expect("xtworkThemeTokens" in dataset!).toBe(true);
    expect(values.has("--xtwork-window-wash")).toBe(false);

    application.dispose();
    expect("xtworkWash" in dataset!).toBe(false);
    expect("xtworkThemeTokens" in dataset!).toBe(false);
    expect(values.has("--xtwork-window-wash")).toBe(false);
  });

  it("preserves a theme chosen while a plugin is active when the older plugin disposes", () => {
    const { root, values, dataset } = createMockRoot({ dataset: {} });
    vi.stubGlobal("document", { documentElement: root });
    try {
      applyThemePalette("grove", "light");
      const oceanDark = getThemeColorsForMode(getThemeDefinition("ocean")!, "dark")!;
      const oceanDarkWash = getBuiltInThemeWash("ocean", "dark");

      const application = applyAppearancePluginTheme(root, {
        pluginId: "plugin-a",
        kind: "appearance",
        theme: {
          id: "plugin-a",
          tokens: {
            canvas: "#123456",
            text: "#abcdef",
          },
        },
      });
      expect(values.get("--app-theme-canvas")).toBe("#123456");
      expect("xtworkWash" in dataset!).toBe(false);
      expect("xtworkThemeTokens" in dataset!).toBe(true);

      applyThemePalette("ocean", "dark");
      expect(dataset!.themeId).toBe("ocean");
      expect("xtworkWash" in dataset!).toBe(false);
      expect("xtworkThemeTokens" in dataset!).toBe(true);
      expect(values.get("--app-theme-canvas")).toBe("#123456");
      expect(values.get("--app-theme-surface")).toBe(oceanDark.surface);

      application.dispose();
      expect(dataset!.themeId).toBe("ocean");
      expect("xtworkThemeTokens" in dataset!).toBe(true);
      expect("xtworkWash" in dataset!).toBe(true);
      expect(values.get("--xtwork-window-wash")).toBe(oceanDarkWash);
      expect(values.get("--app-theme-canvas")).toBe(oceanDark.canvas);
      expect(values.get("--app-theme-text")).toBe(oceanDark.text);
      expect(values.get("--app-theme-surface")).toBe(oceanDark.surface);

      application.dispose();
      expect(values.get("--app-theme-canvas")).toBe(oceanDark.canvas);
      expect(values.get("--xtwork-window-wash")).toBe(oceanDarkWash);
    } finally {
      vi.unstubAllGlobals();
    }
  });

  it("handles overlapping and disjoint plugins across both disposal orders and duplicate dispose calls", () => {
    const wash = "linear-gradient(180deg in oklab, #e2eee5, #ebf2e7, #f3f2e2, #f5f0d6)";

    const first = createMockRoot({
      values: [
        ["--xtwork-window-wash", wash],
        ["--app-theme-canvas", "#base01"],
        ["--app-theme-surface", "#base02"],
      ],
      dataset: { xtworkWash: "", xtworkThemeTokens: "" },
    });
    const firstA = applyAppearancePluginTheme(first.root, {
      pluginId: "plugin-a",
      kind: "appearance",
      theme: {
        id: "plugin-a",
        tokens: {
          canvas: "#111111",
          text: "#aaaaaa",
        },
      },
    });
    const firstB = applyAppearancePluginTheme(first.root, {
      pluginId: "plugin-b",
      kind: "appearance",
      theme: {
        id: "plugin-b",
        tokens: {
          canvas: "#222222",
          surface: "#333333",
        },
      },
    });

    firstA.dispose();
    expect(first.values.get("--app-theme-canvas")).toBe("#222222");
    expect(first.values.get("--app-theme-surface")).toBe("#333333");
    expect(first.values.get("--app-theme-text")).toBeUndefined();
    expect("xtworkWash" in first.dataset!).toBe(false);
    expect("xtworkThemeTokens" in first.dataset!).toBe(true);

    firstA.dispose();
    expect(first.values.get("--app-theme-canvas")).toBe("#222222");
    expect(first.values.get("--app-theme-surface")).toBe("#333333");

    firstB.dispose();
    expect(first.values.get("--app-theme-canvas")).toBe("#base01");
    expect(first.values.get("--app-theme-surface")).toBe("#base02");
    expect(first.values.get("--app-theme-text")).toBeUndefined();
    expect("xtworkWash" in first.dataset!).toBe(true);
    expect(first.values.get("--xtwork-window-wash")).toBe(wash);

    firstB.dispose();
    expect(first.values.get("--app-theme-canvas")).toBe("#base01");

    const second = createMockRoot({
      values: [
        ["--xtwork-window-wash", wash],
        ["--app-theme-canvas", "#base01"],
        ["--app-theme-surface", "#base02"],
      ],
      dataset: { xtworkWash: "", xtworkThemeTokens: "" },
    });
    const secondA = applyAppearancePluginTheme(second.root, {
      pluginId: "plugin-a",
      kind: "appearance",
      theme: {
        id: "plugin-a",
        tokens: {
          canvas: "#111111",
          text: "#aaaaaa",
        },
      },
    });
    const secondB = applyAppearancePluginTheme(second.root, {
      pluginId: "plugin-b",
      kind: "appearance",
      theme: {
        id: "plugin-b",
        tokens: {
          canvas: "#222222",
          surface: "#333333",
        },
      },
    });

    secondB.dispose();
    expect(second.values.get("--app-theme-canvas")).toBe("#111111");
    expect(second.values.get("--app-theme-surface")).toBe("#base02");
    expect(second.values.get("--app-theme-text")).toBe("#aaaaaa");
    expect("xtworkWash" in second.dataset!).toBe(false);
    expect("xtworkThemeTokens" in second.dataset!).toBe(true);

    secondA.dispose();
    expect(second.values.get("--app-theme-canvas")).toBe("#base01");
    expect(second.values.get("--app-theme-surface")).toBe("#base02");
    expect(second.values.get("--app-theme-text")).toBeUndefined();
    expect("xtworkWash" in second.dataset!).toBe(true);
    expect(second.values.get("--xtwork-window-wash")).toBe(wash);
  });
});
