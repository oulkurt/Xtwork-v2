import {
  EnvironmentId,
  ProviderDriverKind,
  ProviderInstanceId,
  type ProviderAuthState,
  type ProviderInstallState,
  type ServerProvider,
} from "@t3tools/contracts";
import { describe, expect, it, vi } from "vite-plus/test";
import { page } from "vite-plus/test/browser";

import { render } from "../../../test/render";

const state = vi.hoisted(() => ({
  auth: null as ProviderAuthState | null,
  installation: null as ProviderInstallState | null,
  startInstall: vi.fn(),
  cancelInstall: vi.fn(),
  startAuth: vi.fn(),
  refreshProviders: vi.fn(),
}));

vi.mock(import("../../state/server"), async (original) => {
  const actual = await original();
  const commandLabels = {
    startProviderInstall: "startInstall",
    cancelProviderInstall: "cancelInstall",
    startProviderAuth: "startAuth",
    refreshProviders: "refreshProviders",
  } as const;
  const labelled = Object.fromEntries(
    Object.entries(commandLabels).map(([key, label]) => [
      key,
      { ...actual.serverEnvironment[key as keyof typeof commandLabels], label },
    ]),
  );
  return {
    ...actual,
    serverEnvironment: {
      ...actual.serverEnvironment,
      ...labelled,
      providerAuthState: (() => "auth") as never,
      providerInstallState: (() => "installation") as never,
    } as never,
  };
});

vi.mock(import("../../state/use-atom-command"), async (original) => ({
  ...(await original()),
  useAtomCommand: ((command: { label?: string }) =>
    ({
      startInstall: state.startInstall,
      cancelInstall: state.cancelInstall,
      startAuth: state.startAuth,
      refreshProviders: state.refreshProviders,
    })[command.label ?? ""] ?? vi.fn()) as never,
}));

vi.mock(import("../../state/query"), async (original) => ({
  ...(await original()),
  useEnvironmentQuery: ((atom: unknown) => ({
    data: atom === "auth" ? state.auth : atom === "installation" ? state.installation : null,
    error: null,
    isPending: false,
    refresh: vi.fn(),
  })) as never,
}));

vi.mock(import("../../state/session"), async (original) => ({
  ...(await original()),
  useEnvironmentScope: () => true,
  readEnvironmentScope: () => true,
  readPreparedConnection: (() => ({ httpBaseUrl: "http://127.0.0.1:3773" })) as never,
}));

vi.mock(import("../../state/waitForQuerySettled"), async (original) => ({
  ...(await original()),
  waitForQuerySettled: vi.fn(() => new Promise(() => {})) as never,
}));

vi.mock(import("../../state/environments"), async (original) => ({
  ...(await original()),
  useEnvironmentHttpBaseUrl: () => "http://127.0.0.1:3773",
}));

import { CodexSetupSection } from "./CodexSetupSection";

const environmentId = EnvironmentId.make("local");
const instanceId = ProviderInstanceId.make("codex");
const RELEASE_URL =
  "https://github.com/openai/codex/releases/download/rust-v0.166.0/codex-package-aarch64-apple-darwin.tar.gz";
const RELEASE_SHA256 = "c".repeat(64);

function makeProvider(authenticated: boolean): ServerProvider {
  return {
    instanceId,
    driver: ProviderDriverKind.make("codex"),
    enabled: true,
    installed: authenticated,
    version: authenticated ? "0.156.1" : null,
    status: authenticated ? "ready" : "warning",
    auth: { status: authenticated ? "authenticated" : "unauthenticated" },
    checkedAt: "2026-11-25T00:00:00.000Z",
    models: [],
    slashCommands: [],
    skills: [],
    setup: { canAuthenticate: true, canInstall: true },
  };
}

describe("CodexSetupSection explicit install/update consent (M2)", () => {
  it("requires explicit confirmation of pinned release version/URL/SHA-256 before starting install", async () => {
    state.auth = {
      instanceId,
      phase: "idle",
      flowId: null,
      authorizationUrl: null,
      expiresAt: null,
      message: null,
      methods: [],
    };
    state.installation = {
      driver: ProviderDriverKind.make("codex"),
      operationId: null,
      phase: "idle",
      downloadedBytes: 0,
      totalBytes: 50_000_000,
      version: "0.166.0",
      installedVersion: null,
      executablePath: null,
      source: null,
      releaseUrl: RELEASE_URL,
      releaseSha256: RELEASE_SHA256,
      canRemove: false,
      message: null,
    };
    state.startInstall.mockReset().mockResolvedValue({
      _tag: "Success",
      value: { ...state.installation, operationId: "op-1", phase: "downloading" },
    });

    await using _screen = await render(
      <CodexSetupSection
        environmentId={environmentId}
        instanceId={instanceId}
        provider={makeProvider(false)}
        mode="managed"
        enabled
        onModeChange={vi.fn()}
      />,
    );

    await page.getByRole("button", { name: "Continue with ChatGPT" }).click();
    expect(state.startInstall).not.toHaveBeenCalled();

    const confirmRegion = page.getByRole("region", { name: "Confirm Codex installation" });
    await expect.element(confirmRegion).toBeVisible();
    await expect.element(page.getByText(RELEASE_URL)).toBeVisible();
    await expect.element(page.getByText(`SHA-256: ${RELEASE_SHA256}`)).toBeVisible();

    await page.getByRole("button", { name: "Confirm & Install" }).click();
    await vi.waitFor(() => {
      expect(state.startInstall).toHaveBeenCalledWith({
        environmentId,
        input: {
          instanceId,
          explicitConsent: true,
          expectedVersion: "0.166.0",
          expectedSha256: RELEASE_SHA256,
        },
      });
    });
  });

  it("requires explicit confirmation before starting a managed Codex update", async () => {
    state.auth = {
      instanceId,
      phase: "idle",
      flowId: null,
      authorizationUrl: null,
      expiresAt: null,
      message: null,
      methods: [],
    };
    state.installation = {
      driver: ProviderDriverKind.make("codex"),
      operationId: null,
      phase: "succeeded",
      downloadedBytes: 0,
      totalBytes: 50_000_000,
      version: "0.166.0",
      installedVersion: "0.156.1",
      executablePath: "/tmp/codex",
      source: "managed",
      releaseUrl: RELEASE_URL,
      releaseSha256: RELEASE_SHA256,
      canRemove: true,
      message: null,
    };
    state.startInstall.mockReset().mockResolvedValue({
      _tag: "Success",
      value: { ...state.installation, operationId: "op-2", phase: "downloading" },
    });

    await using _screen = await render(
      <CodexSetupSection
        environmentId={environmentId}
        instanceId={instanceId}
        provider={makeProvider(true)}
        mode="managed"
        enabled
        onModeChange={vi.fn()}
      />,
    );

    await page.getByRole("button", { name: "Update Codex" }).click();
    expect(state.startInstall).not.toHaveBeenCalled();
    await expect
      .element(page.getByRole("region", { name: "Confirm Codex update" }))
      .toBeVisible();

    await page.getByRole("button", { name: "Confirm & Update" }).click();
    await vi.waitFor(() => {
      expect(state.startInstall).toHaveBeenCalledWith({
        environmentId,
        input: {
          instanceId,
          explicitConsent: true,
          expectedVersion: "0.166.0",
          expectedSha256: RELEASE_SHA256,
        },
      });
    });
  });
});
