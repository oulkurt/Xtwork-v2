import { EnvironmentId } from "@t3tools/contracts";
import { DEFAULT_CLIENT_SETTINGS } from "@t3tools/contracts/settings";
import { afterEach, expect, it, vi } from "vite-plus/test";
import {
  DEFAULT_LOCALE,
  DEFAULT_UI_LOCALE,
  resolveUiLocale,
  SUPPORTED_LOCALES,
} from "./i18n/locales";

afterEach(() => {
  vi.unstubAllGlobals();
  vi.resetModules();
});

it("defaults the UI language to Simplified Chinese and limits options to zh and en", () => {
  expect(DEFAULT_LOCALE).toBe("en");
  expect(DEFAULT_UI_LOCALE).toBe("zh");
  expect(DEFAULT_CLIENT_SETTINGS.language).toBe("zh");
  expect(SUPPORTED_LOCALES).toEqual(["zh", "en"]);
  expect(resolveUiLocale("zh")).toBe("zh");
  expect(resolveUiLocale("en")).toBe("en");
  expect(resolveUiLocale("system")).toBe("zh");
  expect(resolveUiLocale("ja")).toBe("zh");
  expect(resolveUiLocale("")).toBe("zh");
});

it("routes server browser tabs through ServerBrowserSurface instead of Electron webviews on Xtwork desktop", async () => {
  const envId = EnvironmentId.make("local");
  const baseBridge = {
    getAppBranding: () => null,
    getClientPlatform: () => "darwin",
    getSystemLocale: () => "en",
    getPreferredSystemLanguages: () => ["en"],
    getRelayTelemetryEnabled: () => false,
    getLocalEnvironmentEnabled: () => true,
    getLocalEnvironmentBootstraps: () => [],
  };

  vi.resetModules();
  vi.stubGlobal("window", { desktopBridge: { ...baseBridge, preview: {} } });
  const electronRuntime = await import("./browser/previewRuntime");
  const electronPreviewStore = await import("./previewStateStore");
  expect(electronPreviewStore.isPreviewSupportedInRuntime()).toBe(true);
  expect(electronRuntime.rendersServerTabNatively(envId, envId, { runtime: "server" })).toBe(true);

  vi.resetModules();
  vi.stubGlobal("window", { desktopBridge: { ...baseBridge, xtwork: true } });
  const xtworkRuntime = await import("./browser/previewRuntime");
  const xtworkPreviewStore = await import("./previewStateStore");
  expect(xtworkPreviewStore.isPreviewSupportedInRuntime()).toBe(false);
  expect(xtworkRuntime.rendersServerTabNatively(envId, envId, { runtime: "server" })).toBe(false);
  expect(
    xtworkRuntime.rendersServerTabNatively(envId, envId, { runtime: "server", headless: false }),
  ).toBe(false);
});
