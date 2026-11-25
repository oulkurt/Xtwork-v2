import { createMemoryHistory } from "@tanstack/react-router";
import { scopeProjectRef, scopeThreadRef } from "@t3tools/client-runtime/environment";
import {
  ComposerContextId,
  EnvironmentId,
  ORCHESTRATION_V2_WS_METHODS,
  ProviderInstanceId,
  ThreadId,
  type OrchestrationV2ThreadLaunchInput,
  type ServerConfig,
  type ServerConfigStreamEvent,
  type VcsStatusStreamEvent,
} from "@t3tools/contracts";
import { formatComposerContextReference } from "@t3tools/shared/composerContextReferences";
import { DEFAULT_CLIENT_SETTINGS } from "@t3tools/contracts/settings";
import type * as Context from "effect/Context";
import * as Effect from "effect/Effect";
import * as Queue from "effect/Queue";
import { AsyncResult } from "effect/reactivity";
import { useSyncExternalStore } from "react";
import { afterEach, beforeEach, expect, it, vi } from "vite-plus/test";
import { page, userEvent } from "vite-plus/test/browser";

import { AppRoot } from "~/AppRoot";
import "~/components/ChatView";
import { DraftId, useComposerDraftStore } from "~/composerDraftStore";
import { __resetDesktopPrimaryAuthForTests } from "~/environments/primary/desktopAuth";
import { __setClientSettingsForTests, getClientSettings } from "~/hooks/useSettings";
import { useRightPanelStore } from "~/rightPanelStore";
import { getRouter } from "~/router";
import { appAtomRegistry } from "~/rpc/atomRegistry";
import { vcsEnvironment } from "~/state/vcs";
import {
  CODEX_PROVIDER,
  ENVIRONMENT_ID,
  PROJECT_ID,
  answerRpc,
  dispatchedCommands,
  installFakeEnvironment,
  threadWithHistory,
  type FakeDriver,
  type FakeThread,
} from "../../test/fakeEnvironment";
import { act, render } from "../../test/render";

const devState = vi.hoisted(() => ({
  state: false as boolean | null,
  listeners: new Set<() => void>(),
}));

const vcsQueues = vi.hoisted(() => new Set<Queue.Queue<VcsStatusStreamEvent>>());

const emitAllVcsStatus = async (event: VcsStatusStreamEvent): Promise<void> => {
  if (vcsQueues.size === 0) throw new Error("No VCS status subscription");
  for (const queue of vcsQueues) {
    await Effect.runPromise(Queue.offer(queue, event));
  }
};

const setDeveloperFeaturesState = (state: boolean | null) => {
  devState.state = state;
  devState.listeners.forEach((listener) => listener());
};

const setDeveloperFeatures = (enabled: boolean) => setDeveloperFeaturesState(enabled);

vi.mock("~/hooks/useDeveloperFeatures", async (original) => {
  const actual = await original<typeof import("~/hooks/useDeveloperFeatures")>();
  const useDesktopDeveloperFeaturesState = () =>
    useSyncExternalStore(
      (listener) => {
        devState.listeners.add(listener);
        return () => devState.listeners.delete(listener);
      },
      () => devState.state,
    );
  const useDeveloperFeatures = () => useDesktopDeveloperFeaturesState() === true;
  return {
    ...actual,
    readDeveloperFeatures: () => devState.state === true,
    readDeveloperFeaturesState: () => devState.state,
    useDeveloperFeatures,
    useDesktopDeveloperFeatures: useDeveloperFeatures,
    useDesktopDeveloperFeaturesState,
    useDeveloperFeaturesEnvironmentId: () => EnvironmentId.make("local"),
  };
});

vi.mock("../../../../packages/client-runtime/src/connection/driver.ts", async (importOriginal) => {
  const [actual, { fakeDriver }, contracts, Eff, Q, Str, Layer] = await Promise.all([
    importOriginal<{ readonly ConnectionDriver: Context.Key<unknown, FakeDriver> }>(),
    import("../../test/fakeEnvironment"),
    import("@t3tools/contracts"),
    import("effect/Effect"),
    import("effect/Queue"),
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
      Eff.map(fakeDriver.connect(entry), (lease) => {
        const wrappedClient = new Proxy(lease.session.client, {
          get(target, prop, receiver) {
            if (prop === contracts.WS_METHODS.subscribeVcsStatus) {
              return () =>
                Str.unwrap(
                  Eff.gen(function* () {
                    const queue = yield* Q.unbounded<VcsStatusStreamEvent>();
                    vcsQueues.add(queue);
                    yield* Eff.addFinalizer(() =>
                      Eff.sync(() => {
                        vcsQueues.delete(queue);
                      }),
                    );
                    return Str.fromQueue(queue);
                  }),
                );
            }
            if (prop === contracts.WS_METHODS.subscribeServerConfig) {
              return (...args: unknown[]) =>
                (
                  Reflect.get(target, prop, receiver) as (
                    ...a: unknown[]
                  ) => ReturnType<typeof lease.session.subscribeServerConfig>
                )(...args).pipe(Str.map(wrapConfigEvent));
            }
            return Reflect.get(target, prop, receiver);
          },
        });
        return {
          ...lease,
          session: {
            ...lease.session,
            initialConfig: Eff.map(lease.session.initialConfig, withEnabledPiConfig),
            subscribeServerConfig: () =>
              lease.session.subscribeServerConfig().pipe(Str.map(wrapConfigEvent)),
            client: wrappedClient,
          },
        };
      }),
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

let previousSettings = getClientSettings();

beforeEach(() => {
  previousSettings = getClientSettings();
  let storedClientSettings = {
    ...DEFAULT_CLIENT_SETTINGS,
    onboardingCompletedAt: "2026-01-01T00:00:00.000Z",
  };
  const noopUnsub = () => () => {};
  setDeveloperFeatures(false);
  vi.stubGlobal("desktopBridge", {
    xtwork: true,
    getAppBranding: () => null,
    getRelayTelemetryEnabled: () => false,
    getClientPlatform: () => "darwin",
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
  setDeveloperFeatures(false);
  __setClientSettingsForTests(previousSettings);
  vi.unstubAllGlobals();
});

it("hides /model in single-model ordinary mode and restores it in developer mode", async () => {
  await page.viewport(1280, 900);
  const thread = threadWithHistory("desktop-single-model", 1, {
    instanceId: PI_PROVIDER.instanceId,
    model: "xtwork/standard",
  });
  using _environment = installFakeEnvironment([thread], {
    providers: [PI_PROVIDER, CODEX_PROVIDER],
  });
  const router = getRouter(
    createMemoryHistory({ initialEntries: [`/${ENVIRONMENT_ID}/${thread.id}`] }),
  );
  await router.load();
  await using _app = await render(<AppRoot router={router} />, { router: false });
  await expect.element(page.getByText(`Answer 0 for ${thread.id}.`)).toBeVisible();

  const editor = page.getByTestId("composer-editor");
  await userEvent.click(editor);
  await userEvent.keyboard("/");
  await expect.element(page.getByText("/side", { exact: true })).toBeVisible();
  await expect.element(page.getByText("/model", { exact: true })).not.toBeInTheDocument();

  await act(() => setDeveloperFeatures(true));
  await expect.element(page.getByText("/model", { exact: true })).toBeVisible();
});

it("keeps started external-runtime threads sendable after developer features are turned off", async () => {
  await page.viewport(1280, 900);
  const thread = threadWithHistory("desktop-codex-started", 1);
  using _environment = installFakeEnvironment([thread], {
    acceptCommands: true,
    providers: [PI_PROVIDER, CODEX_PROVIDER],
  });
  const router = getRouter(
    createMemoryHistory({ initialEntries: [`/${ENVIRONMENT_ID}/${thread.id}`] }),
  );
  await router.load();
  await using _app = await render(<AppRoot router={router} />, { router: false });
  await expect.element(page.getByText(`Answer 0 for ${thread.id}.`)).toBeVisible();

  const editor = page.getByTestId("composer-editor");
  await userEvent.click(editor);
  await userEvent.keyboard("Continue codex work{Enter}");

  await vi.waitFor(() => {
    const dispatched = dispatchedCommands().find((command) => command.type === "message.dispatch");
    expect(dispatched).toBeDefined();
    if (dispatched?.type === "message.dispatch") {
      expect(dispatched.modelSelection?.instanceId).toBe(CODEX_PROVIDER.instanceId);
    }
  });
});

it("preserves existing review comments on send when developer features are turned off", async () => {
  await page.viewport(1280, 900);
  const thread = threadWithHistory("desktop-review-comments", 1);
  using _environment = installFakeEnvironment([thread], {
    acceptCommands: true,
    providers: [PI_PROVIDER, CODEX_PROVIDER],
  });
  const threadRef = scopeThreadRef(ENVIRONMENT_ID, thread.id);
  useComposerDraftStore.getState().addReviewComment(threadRef, {
    id: "rc-preserved",
    sectionId: "changes",
    sectionTitle: "Changes",
    filePath: "src/example.ts",
    startIndex: 1,
    endIndex: 1,
    rangeLabel: "L1",
    text: "Keep this review note",
    diff: "+const value = 1;",
  });

  const router = getRouter(
    createMemoryHistory({ initialEntries: [`/${ENVIRONMENT_ID}/${thread.id}`] }),
  );
  await router.load();
  await using _app = await render(<AppRoot router={router} />, { router: false });
  await expect.element(page.getByText(`Answer 0 for ${thread.id}.`)).toBeVisible();

  const editor = page.getByTestId("composer-editor");
  await userEvent.click(editor);
  await userEvent.keyboard("Apply feedback{Enter}");

  await vi.waitFor(() => {
    const dispatched = dispatchedCommands().find((command) => command.type === "message.dispatch");
    expect(dispatched).toBeDefined();
    if (dispatched?.type === "message.dispatch") {
      expect(dispatched.text).toContain("Apply feedback");
      expect(dispatched.context?.records).toContainEqual(
        expect.objectContaining({
          kind: "review-comment",
          filePath: "src/example.ts",
          text: "Keep this review note",
        }),
      );
    }
  });
});

it("preserves existing draft worktree workspace selection when developer features are turned off", async () => {
  await page.viewport(1280, 900);
  const existing = threadWithHistory("desktop-worktree-anchor", 1);
  using _environment = installFakeEnvironment([existing], {
    acceptCommands: true,
    providers: [PI_PROVIDER, CODEX_PROVIDER],
  });
  const launched: OrchestrationV2ThreadLaunchInput[] = [];
  using _launch = answerRpc(
    ORCHESTRATION_V2_WS_METHODS.launchThread,
    (input: OrchestrationV2ThreadLaunchInput) => {
      launched.push(input);
      return Effect.never;
    },
  );
  const draftId = DraftId.make("draft-worktree-preserved");
  const drafts = useComposerDraftStore.getState();
  drafts.setProjectDraftThreadId(scopeProjectRef(ENVIRONMENT_ID, PROJECT_ID), draftId, {
    threadId: ThreadId.make("thread-worktree-preserved"),
    envMode: "worktree",
    branch: "main",
  });
  drafts.setPrompt(draftId, "Run inside selected worktree");

  const router = getRouter(createMemoryHistory({ initialEntries: [`/draft/${draftId}`] }));
  await router.load();
  await using _app = await render(<AppRoot router={router} />, { router: false });
  await expect.element(page.getByText("render", { exact: true }).first()).toBeVisible();

  await act(() =>
    emitAllVcsStatus({
      _tag: "snapshot",
      local: {
        isRepo: true,
        hasPrimaryRemote: false,
        isDefaultRef: true,
        refName: "main",
        hasWorkingTreeChanges: false,
        workingTree: { files: [], insertions: 0, deletions: 0 },
      },
      remote: null,
    }),
  );

  const editor = page.getByTestId("composer-editor");
  await vi.waitFor(() => expect(editor.element().textContent).toContain("Run inside selected worktree"));
  await userEvent.click(editor);
  await userEvent.keyboard("{Enter}");

  await vi.waitFor(() => {
    expect(launched).toHaveLength(1);
    expect(launched[0]?.modelSelection.instanceId).toBe(PI_PROVIDER.instanceId);
    expect(launched[0]?.workspaceStrategy).toMatchObject({
      type: "worktree",
      baseRef: "main",
    });
  });
});

it("hides the branch mismatch Restore branch banner in ordinary mode and restores it in developer mode", async () => {
  await page.viewport(1280, 900);
  const thread = threadWithHistory("desktop-branch-restore", 1);
  using _environment = installFakeEnvironment([thread], {
    providers: [PI_PROVIDER, CODEX_PROVIDER],
  });
  const router = getRouter(
    createMemoryHistory({ initialEntries: [`/${ENVIRONMENT_ID}/${thread.id}`] }),
  );
  await router.load();
  await using _app = await render(<AppRoot router={router} />, { router: false });
  await expect.element(page.getByText(`Answer 0 for ${thread.id}.`)).toBeVisible();

  const gitStatus = vcsEnvironment.status({
    environmentId: ENVIRONMENT_ID,
    input: { cwd: "/workspace/render" },
  });
  await act(() =>
    emitAllVcsStatus({
      _tag: "snapshot",
      local: {
        isRepo: true,
        hasPrimaryRemote: false,
        isDefaultRef: false,
        refName: "other-branch",
        hasWorkingTreeChanges: false,
        workingTree: { files: [], insertions: 0, deletions: 0 },
      },
      remote: null,
    }),
  );
  await vi.waitFor(() => {
    const status = AsyncResult.getOrElse(appAtomRegistry.get(gitStatus), () => null);
    expect(status?.refName).toBe("other-branch");
  });

  const editor = page.getByTestId("composer-editor");
  await userEvent.click(editor);
  await userEvent.keyboard("Draft text triggers branch check");
  await vi.waitFor(() => {
    const draft = useComposerDraftStore
      .getState()
      .getComposerDraft(scopeThreadRef(ENVIRONMENT_ID, thread.id));
    expect(draft?.prompt).toContain("Draft text triggers branch check");
  });

  await expect.element(page.getByRole("button", { name: "Restore branch" })).not.toBeInTheDocument();

  await act(() => setDeveloperFeatures(true));
  await expect.element(page.getByRole("button", { name: "Restore branch" })).toBeVisible();
});

it("opens the right panel surface picker when only a hidden terminal tab exists in ordinary mode", async () => {
  await page.viewport(1280, 900);
  const thread = threadWithHistory("desktop-hidden-terminal-panel", 1);
  const threadRef = scopeThreadRef(ENVIRONMENT_ID, thread.id);
  useRightPanelStore.getState().openTerminal(threadRef, "term-1");
  useRightPanelStore.getState().close(threadRef);
  using _environment = installFakeEnvironment([thread], {
    providers: [PI_PROVIDER, CODEX_PROVIDER],
  });
  try {
    const router = getRouter(
      createMemoryHistory({ initialEntries: [`/${ENVIRONMENT_ID}/${thread.id}`] }),
    );
    await router.load();
    await using _app = await render(<AppRoot router={router} />, { router: false });
    await expect.element(page.getByText(`Answer 0 for ${thread.id}.`)).toBeVisible();

    const toggle = page.getByRole("button", { name: "Toggle right panel", exact: true });
    await expect.element(toggle).toHaveAttribute("aria-pressed", "false");
    await toggle.click();

    await expect.element(toggle).toHaveAttribute("aria-pressed", "true");
    await expect.element(page.getByRole("button", { name: /^Files/ })).toBeVisible();
    await expect.element(page.getByRole("button", { name: /^Diff/ })).toBeVisible();
  } finally {
    useRightPanelStore.getState().removeThread(threadRef);
  }
});

it("waits on /issues during cold start until developer settings load", async () => {
  await page.viewport(1280, 900);
  setDeveloperFeaturesState(null);
  const thread = threadWithHistory("desktop-cold-issues", 1);
  using _environment = installFakeEnvironment([thread], {
    providers: [PI_PROVIDER, CODEX_PROVIDER],
  });
  const router = getRouter(createMemoryHistory({ initialEntries: ["/issues"] }));
  await router.load();
  await using _app = await render(<AppRoot router={router} />, { router: false });

  await vi.waitFor(() => {
    expect(router.state.location.pathname).toBe("/issues");
  });
  await expect.element(page.getByText("Issues unavailable")).not.toBeInTheDocument();

  await act(() => setDeveloperFeaturesState(true));
  expect(router.state.location.pathname).toBe("/issues");
  await expect.element(page.getByText(/Issues unavailable|No trackers to read/)).toBeVisible();

  await act(() => setDeveloperFeaturesState(false));
  await vi.waitFor(() => {
    expect(router.state.location.pathname).not.toBe("/issues");
  });
});

it("keeps historical sent review-comment chips readable in ordinary mode", async () => {
  await page.viewport(1280, 900);
  const contextId = ComposerContextId.make("rc-sent-1");
  const refMarkdown = formatComposerContextReference({
    kind: "review-comment",
    contextId,
    label: "src/example.ts L1",
  });
  const baseThread = threadWithHistory("desktop-historic-review-chip", 1);
  const firstUser = baseThread.items[0]!;
  if (firstUser.type !== "user_message") throw new Error("Expected user message");
  const thread: FakeThread = {
    ...baseThread,
    items: [
      {
        ...firstUser,
        text: `Please update per ${refMarkdown}`,
        context: {
          version: 1,
          records: [
            {
              version: 1,
              contextId,
              kind: "review-comment",
              label: "src/example.ts L1",
              sectionId: "changes",
              sectionTitle: "Changes",
              filePath: "src/example.ts",
              startIndex: 1,
              endIndex: 1,
              rangeLabel: "L1",
              text: "Historic review detail",
              diff: "@@ -1 +1 @@\n-const a = 0;\n+const a = 1;",
            },
          ],
        },
      },
      ...baseThread.items.slice(1),
    ],
  };

  using _environment = installFakeEnvironment([thread], {
    providers: [PI_PROVIDER, CODEX_PROVIDER],
  });
  const router = getRouter(
    createMemoryHistory({ initialEntries: [`/${ENVIRONMENT_ID}/${thread.id}`] }),
  );
  await router.load();
  await using _app = await render(<AppRoot router={router} />, { router: false });

  const chip = page.getByRole("button", { name: /Review comment, example\.ts L1/ });
  await expect.element(chip).toBeVisible();
  await chip.click();
  await expect.element(page.getByText("Historic review detail")).toBeVisible();
});
