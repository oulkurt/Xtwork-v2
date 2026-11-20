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
});
