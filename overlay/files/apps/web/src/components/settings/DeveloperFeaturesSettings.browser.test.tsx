import "~/index.css";
import { useSyncExternalStore } from "react";
import { afterEach, expect, it, vi } from "vite-plus/test";
import { page } from "vite-plus/test/browser";
import { render } from "../../../test/render";
import { SidebarProvider } from "../ui/sidebar";
import { DeveloperFeaturesSettings } from "./DeveloperFeaturesSettings";
import { SettingsSidebarNav } from "./SettingsSidebarNav";

const state = vi.hoisted(() => ({
  enabled: false,
  listeners: new Set<() => void>(),
}));

vi.mock("../../hooks/useDeveloperFeatures", () => {
  const useDeveloperFeatures = () =>
    useSyncExternalStore(
      (listener) => {
        state.listeners.add(listener);
        return () => state.listeners.delete(listener);
      },
      () => state.enabled,
    );
  return {
    useDeveloperFeatures,
    useDesktopDeveloperFeatures: useDeveloperFeatures,
    useDeveloperFeaturesEnvironmentId: () => "local",
  };
});

vi.mock("../../hooks/useSettings", async (original) => ({
  ...(await original<typeof import("../../hooks/useSettings")>()),
  useUpdateEnvironmentSettings: () => (patch: { developerFeaturesEnabled: boolean }) => {
    state.enabled = patch.developerFeaturesEnabled;
    state.listeners.forEach((listener) => listener());
  },
}));

vi.mock("../../state/environments", async (original) => ({
  ...(await original<typeof import("../../state/environments")>()),
  usePullRequestsSupported: () => true,
  useIssuesSupported: () => true,
}));

vi.mock("../../state/session", async (original) => ({
  ...(await original<typeof import("../../state/session")>()),
  useEnvironmentScope: () => true,
}));

afterEach(() => vi.unstubAllGlobals());

it("restores developer settings and navigation without restoring unsupported desktop settings", async () => {
  vi.stubGlobal("desktopBridge", {
    xtwork: true,
    getLocalEnvironmentEnabled: () => true,
    getLocalEnvironmentBootstraps: () => [],
  });
  await page.viewport(1280, 900);
  await using _screen = await render(
    <SidebarProvider defaultOpen>
      <SettingsSidebarNav pathname="/settings/general" />
      <DeveloperFeaturesSettings />
    </SidebarProvider>,
    { router: "/settings/general" },
  );
  const toggle = page.getByRole("switch", { name: "Show developer features" });
  const nav = (name: string) => page.getByRole("button", { name, exact: true });
  const developer = [
    "Open pull requests",
    "Open issues",
    "Worktrees",
    "Providers",
    "Source control & issues",
  ];
  const unsupported = ["SnapShots", "Environments", "Sharing & access", "Mobile app"];
  await expect.element(toggle).not.toBeChecked();
  for (const name of [...developer, ...unsupported])
    await expect.element(nav(name)).not.toBeInTheDocument();
  await expect.element(nav("Diffs")).toBeVisible();
  await expect.element(nav("Browser")).toBeVisible();
  await toggle.click();
  for (const name of developer) await expect.element(nav(name)).toBeVisible();
  await expect.element(nav("Browser")).toBeVisible();
  for (const name of unsupported) await expect.element(nav(name)).not.toBeInTheDocument();
  await toggle.click();
  for (const name of developer) await expect.element(nav(name)).not.toBeInTheDocument();
  await expect.element(nav("Browser")).toBeVisible();
});
