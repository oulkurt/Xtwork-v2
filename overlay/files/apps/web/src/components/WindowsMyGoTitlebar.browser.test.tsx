import "~/index.css";
import { createMemoryHistory } from "@tanstack/react-router";
import { scopeThreadRef } from "@t3tools/client-runtime/environment";
import {
  EnvironmentId,
  ProviderInstanceId,
  type ServerConfig,
  type ServerConfigStreamEvent,
} from "@t3tools/contracts";
import { DEFAULT_CLIENT_SETTINGS } from "@t3tools/contracts/settings";
import type * as Context from "effect/Context";
import { afterEach, beforeEach, expect, it, vi } from "vite-plus/test";
import { page } from "vite-plus/test/browser";

import { AppRoot } from "~/AppRoot";
import "~/components/ChatView";
import { __resetDesktopPrimaryAuthForTests } from "~/environments/primary/desktopAuth";
import { __setClientSettingsForTests, getClientSettings } from "~/hooks/useSettings";
import { useRightPanelStore } from "~/rightPanelStore";
import { getRouter } from "~/router";
import { applyThemePalette } from "~/themePalette";
import {
  DEFAULT_IM_DELEGATION_POLICY,
  type LeaderListItem,
  type LeaderOverview,
} from "./leader/leaderTypes";
import {
  CODEX_PROVIDER,
  ENVIRONMENT_ID,
  installFakeEnvironment,
  threadWithHistory,
  type FakeDriver,
} from "../../test/fakeEnvironment";
import { render } from "../../test/render";

vi.mock("~/env", () => ({
  isElectron: true,
  isSecretsFeatureEnabled: false,
}));

vi.mock("~/environments/primary/desktopAuth", async (importOriginal) => {
  const actual = await importOriginal<typeof import("~/environments/primary/desktopAuth")>();
  return {
    ...actual,
    readDesktopPrimaryBearerToken: async () => "test-bearer-token",
  };
});

vi.mock("~/hooks/useDeveloperFeatures", async (original) => {
  const actual = await original<typeof import("~/hooks/useDeveloperFeatures")>();
  return {
    ...actual,
    readDeveloperFeatures: () => false,
    readDeveloperFeaturesState: () => false,
    useDeveloperFeatures: () => false,
    useDesktopDeveloperFeatures: () => false,
    useDesktopDeveloperFeaturesState: () => false,
    useDeveloperFeaturesEnvironmentId: () => EnvironmentId.make("local"),
  };
});

vi.mock("../../../../packages/client-runtime/src/connection/driver.ts", async (importOriginal) => {
  const [actual, { fakeDriver }, contracts, Eff, Str, Layer] = await Promise.all([
    importOriginal<{ readonly ConnectionDriver: Context.Key<unknown, FakeDriver> }>(),
    import("../../test/fakeEnvironment"),
    import("@t3tools/contracts"),
    import("effect/Effect"),
    import("effect/Stream"),
    import("effect/Layer"),
  ]);
  const withEnabledPiConfig = (config: ServerConfig): ServerConfig => ({
    ...config,
    settings: {
      ...config.settings,
      providerInstances: {
        ...config.settings.providerInstances,
        [contracts.ProviderInstanceId.make("xtworkPi")]: {
          driver: contracts.ProviderDriverKind.make("pi"),
          enabled: true,
        },
      },
    },
  });
  const wrapConfigEvent = (event: ServerConfigStreamEvent): ServerConfigStreamEvent =>
    event.type === "snapshot" ? { ...event, config: withEnabledPiConfig(event.config) } : event;
  const wrappedDriver: FakeDriver = {
    ...fakeDriver,
    connect: (entry) =>
      Eff.map(fakeDriver.connect(entry), (lease) => ({
        ...lease,
        session: {
          ...lease.session,
          initialConfig: Eff.map(lease.session.initialConfig, withEnabledPiConfig),
          subscribeServerConfig: () =>
            lease.session.subscribeServerConfig().pipe(Str.map(wrapConfigEvent)),
        },
      })),
  };
  return { ...actual, layer: Layer.succeed(actual.ConnectionDriver, wrappedDriver) };
});

vi.mock(import("~/rpc/requestLatencyState"), async (original) => ({
  ...(await original()),
  trackRpcRequestSent: () => {},
}));

const PI_PROVIDER = {
  instanceId: ProviderInstanceId.make("xtworkPi"),
  driver: "pi",
  enabled: true,
  installed: true,
  version: "1.0.0",
  status: "ready",
  auth: { status: "authenticated" },
  checkedAt: "2026-03-17T19:12:28.000Z",
  models: [
    { slug: "default", name: "Default", isCustom: false, capabilities: null },
    { slug: "xtwork/standard", name: "Standard", isCustom: false, capabilities: null },
  ],
  slashCommands: [],
  skills: [],
};

const NAVIGATOR_THREAD_ID = "xtwork-leader-leader-default-mygo";

const sampleLeaderItem: LeaderListItem = {
  leader: {
    id: "leader-default",
    name: "小瞳",
    avatar: "瞳",
    role: "你的个人与团队领航员",
    status: "active",
    pinnedThreadId: NAVIGATOR_THREAD_ID,
    awarenessScope: { kind: "all_local", projectIds: [] },
    ownerDmDesktopGrants: [],
    imPolicy: DEFAULT_IM_DELEGATION_POLICY,
    createdAt: 1,
    updatedAt: 1,
  },
  bindings: [],
  connections: [],
  needsYouCount: 0,
  runningCount: 0,
  pendingApprovalCount: 0,
  pausedPendingCount: 0,
};

const sampleOverview: LeaderOverview = {
  leader: sampleLeaderItem.leader,
  connections: [],
  pausedPending: [],
  needsYou: {
    snapshotSequence: 1,
    needsYouCount: 0,
    runningCount: 0,
    completedCount: 0,
    failedCount: 0,
    pendingApprovalCount: 0,
    threads: [],
  },
  approvals: [],
};

let previousSettings = getClientSettings();

beforeEach(() => {
  previousSettings = getClientSettings();
  let storedClientSettings = {
    ...DEFAULT_CLIENT_SETTINGS,
    onboardingCompletedAt: "2026-01-01T00:00:00.000Z",
  };
  const noopUnsub = () => () => {};
  vi.stubGlobal("desktopBridge", {
    xtwork: true,
    getAppBranding: () => null,
    getRelayTelemetryEnabled: () => false,
    getClientPlatform: () => "win32",
    getSystemLocale: () => "en-US",
    getPreferredSystemLanguages: () => ["en-US"],
    getLocalEnvironmentEnabled: () => true,
    getLocalEnvironmentBootstraps: () => [],
    getLocalEnvironmentBearerToken: async () => "test-bearer-token",
    getClientSettings: async () => storedClientSettings,
    setClientSettings: async (next: typeof storedClientSettings) => {
      storedClientSettings = next;
    },
    onNotificationBadgeClear: noopUnsub,
    onTrackpadScrollBegin: noopUnsub,
    onTrackpadScrollEnd: noopUnsub,
    onMenuAction: noopUnsub,
    onSnapShotEvent: noopUnsub,
    onQuitShortcut: noopUnsub,
    getWindowFullscreenState: () => false,
    onWindowFullscreenStateChange: noopUnsub,
    getWindowZoomFactor: () => 1,
    onUpdateState: noopUnsub,
    getUpdateState: async () => ({ status: "idle", channel: "latest" }),
    setTheme: async () => {},
    revealWindow: async () => {},
    appActivation: {
      setReady: async () => {},
      complete: async () => {},
      onRequest: noopUnsub,
    },
    webLinks: {
      setReady: async () => {},
      onOpen: noopUnsub,
    },
  });
  __setClientSettingsForTests(storedClientSettings);
});

afterEach(() => {
  __resetDesktopPrimaryAuthForTests();
  __setClientSettingsForTests(previousSettings);
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
});

it("keeps real ChatView Navigator Manage button, inline RightPanelTabs, and narrow RightPanelSheet clear of Windows MyGo native controls without WCO", async () => {
  const root = document.documentElement;
  root.classList.remove("wco", "dark");
  applyThemePalette("grove", "light");
  root.style.setProperty("--mygo-titlebar-inset-right", "138px");
  root.style.setProperty("--mygo-titlebar-height", "52px");
  root.style.setProperty("--mygo-titlebar-controls-bottom", "20px");

  const thread = threadWithHistory(NAVIGATOR_THREAD_ID, 1);
  const threadRef = scopeThreadRef(ENVIRONMENT_ID, thread.id);
  using _environment = installFakeEnvironment([thread], {
    providers: [PI_PROVIDER, CODEX_PROVIDER],
  });
  const envFetch = globalThis.fetch.bind(globalThis);
  vi.stubGlobal(
    "fetch",
    vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
      const url =
        typeof input === "string" ? input : input instanceof URL ? input.toString() : input.url;
      if (!url.includes("/api/xtwork/im/")) {
        return envFetch(input, init);
      }
      const path = url.replace(/^.*\/api\/xtwork\/im\//, "").split("?")[0] ?? "";
      const json = (data: unknown) =>
        new Response(JSON.stringify(data), {
          status: 200,
          headers: { "Content-Type": "application/json" },
        });
      if (path === "leaders") return json({ leaders: [sampleLeaderItem] });
      if (path === "leaders/leader-default/overview") return json(sampleOverview);
      return json({});
    }),
  );

  try {
    await page.viewport(1280, 800);
    const router = getRouter(
      createMemoryHistory({ initialEntries: [`/${ENVIRONMENT_ID}/${thread.id}`] }),
    );
    await router.load();
    await using _app = await render(<AppRoot router={router} />, { router: false });

    await expect.element(page.getByTestId("leader-supervisory-bar"), { timeout: 2500 }).toBeVisible();
    const captionLeftWide = 1280 - 138;
    const manageButton = page.getByRole("button", { name: /^(Manage|管理)$/ }).element() as HTMLElement;
    const titlebarControls = document.querySelector("[data-workspace-titlebar-controls]") as HTMLElement;
    expect(titlebarControls).not.toBeNull();

    const manageRect = manageButton.getBoundingClientRect();
    const controlsRect = titlebarControls.getBoundingClientRect();
    expect(controlsRect.right).toBeLessThanOrEqual(captionLeftWide + 0.5);
    expect(manageRect.right).toBeLessThanOrEqual(captionLeftWide + 0.5);
    expect(manageRect.right).toBeLessThanOrEqual(controlsRect.left + 0.5);

    const manageHit = document.elementFromPoint(
      manageRect.left + manageRect.width / 2,
      manageRect.top + manageRect.height / 2,
    );
    expect(manageHit && manageButton.contains(manageHit)).toBe(true);
    await page.getByRole("button", { name: /^(Manage|管理)$/ }).click();
    await expect.element(page.getByTestId("leader-config-panel"), { timeout: 2500 }).toBeVisible();
    await page.getByRole("button", { name: /^(Manage|管理)$/ }).click();

    const togglePanel = page.getByRole("button", { name: "Toggle right panel", exact: true });
    await expect.element(togglePanel, { timeout: 2500 }).toBeVisible();
    await togglePanel.click();

    await vi.waitFor(
      () => {
        const tabbar = document.querySelector("[data-right-panel-tabbar]") as HTMLElement | null;
        expect(tabbar).not.toBeNull();
        expect(Number.parseFloat(getComputedStyle(tabbar!).paddingRight)).toBeGreaterThanOrEqual(240);
      },
      { timeout: 2500 },
    );
    const inlineControls = document.querySelector("[data-workspace-titlebar-controls]") as HTMLElement;
    const inlineControlsRect = inlineControls.getBoundingClientRect();
    expect(inlineControlsRect.right).toBeLessThanOrEqual(captionLeftWide + 0.5);
    const addSurfaceBtn = page.getByRole("button", { name: "Add panel surface" }).element() as HTMLElement;
    const addSurfaceRect = addSurfaceBtn.getBoundingClientRect();
    expect(addSurfaceRect.right).toBeLessThanOrEqual(inlineControlsRect.left + 0.5);
    expect(addSurfaceRect.right).toBeLessThanOrEqual(captionLeftWide + 0.5);

    await page.viewport(768, 500);
    for (const sheetCase of [
      { titlebarHeight: "52px", controlsBottom: "20px", expectedMinTop: 51.5 },
      { titlebarHeight: "20px", controlsBottom: "58px", expectedMinTop: 57.5 },
    ] as const) {
      root.style.setProperty("--mygo-titlebar-height", sheetCase.titlebarHeight);
      root.style.setProperty("--mygo-titlebar-controls-bottom", sheetCase.controlsBottom);
      await vi.waitFor(
        () => {
          const sheetPopup = document.querySelector('[data-slot="sheet-popup"]') as HTMLElement | null;
          expect(sheetPopup).not.toBeNull();
          expect(sheetPopup!.getBoundingClientRect().top).toBeGreaterThanOrEqual(
            sheetCase.expectedMinTop,
          );
        },
        { timeout: 2500 },
      );
      const sheetTabbar = document.querySelector(
        '[data-slot="sheet-popup"] [data-right-panel-tabbar]',
      ) as HTMLElement;
      expect(sheetTabbar).not.toBeNull();
      expect(sheetTabbar.getBoundingClientRect().top).toBeGreaterThanOrEqual(
        sheetCase.expectedMinTop,
      );
      const sheetButtons = Array.from(sheetTabbar.querySelectorAll("button"));
      expect(sheetButtons.length).toBeGreaterThan(0);
      for (const button of sheetButtons) {
        expect(button.getBoundingClientRect().top).toBeGreaterThanOrEqual(sheetCase.expectedMinTop);
      }
    }
  } finally {
    useRightPanelStore.getState().removeThread(threadRef);
    root.style.removeProperty("--mygo-titlebar-inset-right");
    root.style.removeProperty("--mygo-titlebar-height");
    root.style.removeProperty("--mygo-titlebar-controls-bottom");
    applyThemePalette("system", "light");
  }
});
