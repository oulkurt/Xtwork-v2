import type { DesktopBridge, DesktopUpdateState } from "@t3tools/contracts";
import { afterEach, describe, expect, it } from "vite-plus/test";

import { showBootError } from "./bootError";

describe("showBootError", () => {
  const originalBridge = window.desktopBridge;

  afterEach(() => {
    document.body.replaceChildren();
    if (originalBridge === undefined) {
      delete (window as { desktopBridge?: DesktopBridge }).desktopBridge;
    } else {
      window.desktopBridge = originalBridge;
    }
  });

  it("renders xtwork download, issue, and bundled log recovery links without upstream T3 branding", async () => {
    const bootShell = document.createElement("div");
    bootShell.id = "boot-shell";
    document.body.append(bootShell);

    window.desktopBridge = {
      xtwork: true,
      getClientPlatform: () => "darwin",
      onUpdateState: () => () => {},
      getUpdateState: async () => ({ status: "idle" }) as unknown as DesktopUpdateState,
      cliCommand: {
        getState: async () => ({
          supported: true,
          installedPath: "/tmp/t3",
          onPath: true,
          launcherPath: "/tmp/t3",
        }),
      },
    } as unknown as DesktopBridge;

    showBootError(new Error("boom"));

    const command = bootShell.querySelector("#boot-error-command code");
    if (!command) throw new Error("Expected boot error command element");
    await expect
      .poll(() => command.textContent)
      .toBe('tail -n 200 "$HOME/Library/Application Support/Xtwork-v2/backend.log"');

    const links = Array.from(bootShell.querySelectorAll("a"));
    const downloadLink = links.find(
      (link) => link.getAttribute("href") === "https://github.com/oulkurt/Xtwork-v2/releases",
    );
    expect(downloadLink?.textContent).toBe("Download and reinstall 小瞳 Work");

    const issueLink = bootShell.querySelector<HTMLAnchorElement>("#boot-error-report a");
    expect(issueLink).toBeTruthy();
    const issueUrl = new URL(issueLink!.href);
    expect(`${issueUrl.origin}${issueUrl.pathname}`).toBe(
      "https://github.com/oulkurt/Xtwork-v2/issues/new",
    );
    expect(issueUrl.searchParams.get("template")).toBeNull();
    expect(issueUrl.searchParams.get("area")).toBeNull();
    expect(issueUrl.searchParams.get("title")).toBe("小瞳 Work failed to start");

    const renderedText = bootShell.textContent ?? "";
    const hrefs = links.map((link) => link.getAttribute("href") ?? "").join(" ");
    expect(renderedText).not.toContain("T3 Code");
    expect(renderedText).not.toContain("npx t3 triage");
    expect(hrefs).not.toContain("t3.codes");
    expect(hrefs).not.toContain("pingdotgg/t3code");
  });

  it("uses desktopBridge.getBackendLogPath when provided by the desktop shell", async () => {
    const bootShell = document.createElement("div");
    bootShell.id = "boot-shell";
    document.body.append(bootShell);

    window.desktopBridge = {
      xtwork: true,
      getClientPlatform: () => "darwin",
      getBackendLogPath: () => "/tmp/xtwork-isolated-profile/backend.log",
      onUpdateState: () => () => {},
      getUpdateState: async () => ({ status: "idle" }) as unknown as DesktopUpdateState,
      cliCommand: {
        getState: async () => ({
          supported: false,
          installedPath: null,
          onPath: false,
          launcherPath: null,
        }),
      },
    } as unknown as DesktopBridge;

    showBootError(new Error("boom"));

    const command = bootShell.querySelector("#boot-error-command code");
    if (!command) throw new Error("Expected boot error command element");
    await expect
      .poll(() => command.textContent)
      .toBe("tail -n 200 /tmp/xtwork-isolated-profile/backend.log");
  });
});
