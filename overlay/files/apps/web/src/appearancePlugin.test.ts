import { describe, expect, it } from "vite-plus/test";

import { applyAppearancePluginTheme } from "./appearancePlugin";

describe("applyAppearancePluginTheme", () => {
  it("applies only supported theme roles and can restore them", () => {
    const values = new Map<string, string>();
    const root = {
      style: {
        setProperty: (name: string, value: string) => values.set(name, value),
        removeProperty: (name: string) => values.delete(name),
        getPropertyValue: (name: string) => values.get(name) ?? "",
      },
    } as unknown as HTMLElement;
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

  it("clears built-in window wash when valid roles apply and restores prior role values and wash on dispose", () => {
    const wash = "linear-gradient(180deg in oklab, #ebe0f3, #f3e7f1, #f7eee4, #f6efcf)";
    const values = new Map<string, string>([
      ["--xtwork-window-wash", wash],
      ["--app-theme-canvas", "#ebe0f3"],
      ["--app-theme-surface", "#fff5f9"],
    ]);
    const dataset: Record<string, string | undefined> = { xtworkWash: "" };
    const root = {
      dataset,
      style: {
        setProperty: (name: string, value: string) => values.set(name, value),
        removeProperty: (name: string) => values.delete(name),
        getPropertyValue: (name: string) => values.get(name) ?? "",
      },
    } as unknown as HTMLElement;

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
    expect("xtworkWash" in dataset).toBe(false);
    expect(dataset.xtworkWash).toBeUndefined();
    expect(values.get("--xtwork-window-wash")).toBeUndefined();
    expect(values.get("--app-theme-canvas")).toBe("#121212");
    expect(values.get("--app-theme-surface")).toBe("#1c1c1c");
    expect(values.get("--app-theme-text")).toBe("#f5f5f5");

    application.dispose();
    expect(values.get("--app-theme-canvas")).toBe("#ebe0f3");
    expect(values.get("--app-theme-surface")).toBe("#fff5f9");
    expect(values.get("--app-theme-text")).toBeUndefined();
    expect("xtworkWash" in dataset).toBe(true);
    expect(dataset.xtworkWash).toBe("");
    expect(values.get("--xtwork-window-wash")).toBe(wash);
  });

  it("leaves built-in window wash untouched when zero valid roles apply", () => {
    const wash = "linear-gradient(180deg in oklab, #e2eee5, #ebf2e7, #f3f2e2, #f5f0d6)";
    const values = new Map<string, string>([["--xtwork-window-wash", wash]]);
    const dataset: Record<string, string | undefined> = { xtworkWash: "" };
    const root = {
      dataset,
      style: {
        setProperty: (name: string, value: string) => values.set(name, value),
        removeProperty: (name: string) => values.delete(name),
        getPropertyValue: (name: string) => values.get(name) ?? "",
      },
    } as unknown as HTMLElement;

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
    expect("xtworkWash" in dataset).toBe(true);
    expect(dataset.xtworkWash).toBe("");
    expect(values.get("--xtwork-window-wash")).toBe(wash);

    application.dispose();
    expect("xtworkWash" in dataset).toBe(true);
    expect(dataset.xtworkWash).toBe("");
    expect(values.get("--xtwork-window-wash")).toBe(wash);
  });

  it("does not add window wash on dispose when none was active", () => {
    const values = new Map<string, string>();
    const dataset: Record<string, string | undefined> = {};
    const root = {
      dataset,
      style: {
        setProperty: (name: string, value: string) => values.set(name, value),
        removeProperty: (name: string) => values.delete(name),
        getPropertyValue: (name: string) => values.get(name) ?? "",
      },
    } as unknown as HTMLElement;

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
    expect("xtworkWash" in dataset).toBe(false);
    expect(values.has("--xtwork-window-wash")).toBe(false);

    application.dispose();
    expect("xtworkWash" in dataset).toBe(false);
    expect(values.has("--xtwork-window-wash")).toBe(false);
  });
});
