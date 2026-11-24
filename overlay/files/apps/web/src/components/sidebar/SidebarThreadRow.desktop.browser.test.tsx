import "~/index.css";
import {
  DEFAULT_CLIENT_SETTINGS,
  EnvironmentId,
  IssueTrackerKind,
  ProjectId,
  ProviderDriverKind,
  ProviderInstanceId,
  ThreadId,
} from "@t3tools/contracts";
import * as Atom from "effect/reactivity/Atom";
import { useSyncExternalStore } from "react";
import { afterEach, expect, it, vi } from "vite-plus/test";
import { render } from "../../../test/render";
import { makeThreadFixture } from "../../test-fixtures";
import { SortableThreadRow, type SidebarProviderEntry } from "./SidebarThreadRow";
import { SidebarProvider } from "../ui/sidebar";

const state = vi.hoisted(() => ({
  enabled: false,
  listeners: new Set<() => void>(),
}));

const setDeveloperFeatures = (enabled: boolean) => {
  state.enabled = enabled;
  state.listeners.forEach((listener) => listener());
};

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
    useDeveloperFeaturesEnvironmentId: () => EnvironmentId.make("local"),
  };
});

vi.mock("../../hooks/useSupportsMultiplePullRequests", () => ({
  useSupportsMultiplePullRequests: () => true,
}));

vi.mock("../../state/session", async (original) => ({
  ...(await original<typeof import("../../state/session")>()),
  useEnvironmentScope: () => true,
}));

vi.mock("../../state/terminalSessions", async (original) => ({
  ...(await original<typeof import("../../state/terminalSessions")>()),
  useThreadRunningTerminalIds: () => ["term-1"],
}));

vi.mock("../../state/issues", async (original) => ({
  ...(await original<typeof import("../../state/issues")>()),
  useLinkedIssueDetail: () => null,
}));

vi.mock("../../state/pullRequests", async (original) => ({
  ...(await original<typeof import("../../state/pullRequests")>()),
  useSharedPullRequestSummary: () => null,
}));

vi.mock("../../state/query", async (original) => ({
  ...(await original<typeof import("../../state/query")>()),
  useEnvironmentQuery: () => ({ data: undefined }),
}));

vi.mock("../../state/vcs", async (original) => ({
  ...(await original<typeof import("../../state/vcs")>()),
  vcsBranchRevalidation: () => Atom.make(null),
}));

afterEach(() => {
  state.enabled = false;
  state.listeners.clear();
  vi.unstubAllGlobals();
});

it("hides developer badges, branch, terminal, and provider icons in ordinary desktop mode", async () => {
  vi.stubGlobal("desktopBridge", {
    xtwork: true,
    getLocalEnvironmentEnabled: () => true,
    getLocalEnvironmentBootstraps: () => [],
  });
  setDeveloperFeatures(false);

  const environmentId = EnvironmentId.make("local");
  const projectId = ProjectId.make("proj-1");
  const providerInstanceId = ProviderInstanceId.make("codex");
  const thread = makeThreadFixture({
    environmentId,
    projectId,
    id: ThreadId.make("thread-dev-badges"),
    title: "整理会议纪要",
    branch: "feat/demo-branch",
    worktreePath: "/tmp/worktree-demo",
    providerInstanceId,
    modelSelection: { instanceId: providerInstanceId, model: "gpt-5.4" },
    pullRequests: [
      {
        host: "github.com",
        repository: "org/repo",
        number: 42,
        url: "https://github.com/org/repo/pull/42",
        source: "manual",
        linkedAt: "2026-01-01T00:00:00.000Z",
        stack: null,
        snapshot: {
          state: "open",
          title: "PR 42",
          headBranch: "feat/demo-branch",
          baseBranch: "main",
          isDraft: false,
          updatedAt: "2026-01-01T00:00:00.000Z",
          syncedAt: "2026-01-01T00:00:00.000Z",
        },
      },
    ],
    issues: [
      {
        tracker: IssueTrackerKind.make("github"),
        host: "github.com",
        scope: "org/repo",
        key: "88",
        projectId,
        url: "https://github.com/org/repo/issues/88",
        source: "manual",
        linkedAt: "2026-01-01T00:00:00.000Z",
        displayKey: "#88",
        title: "Fix issue",
      },
    ],
  });

  const providerEntryByInstanceId = new Map<string, SidebarProviderEntry>([
    [
      "codex",
      {
        instanceId: providerInstanceId,
        driverKind: ProviderDriverKind.make("codex"),
        enabled: true,
        displayName: "Codex",
        accentColor: "#6366f1",
        models: [],
      },
    ],
  ]);

  const noop = vi.fn();
  await using screen = await render(
    <SidebarProvider defaultOpen>
      <ul>
        <SortableThreadRow
          thread={thread}
          variant="folder-multiline"
          variantAction="settle"
          settlementSupported={false}
          snoozeSupported={false}
          pinningSupported={false}
          isPinned={false}
          sortableId="row-1"
          sortableDisabled
          contextDrag={false}
          dropVerb={null}
          dragOverPinned={false}
          sweepAction={null}
          snoozeWakeLabelText={null}
          wokeAt={null}
          isActive={false}
          isRouteThread={false}
          readOpensPullRequestsInRightPanel={() => false}
          jumpLabel={null}
          currentEnvironmentId={environmentId}
          environmentLabel={null}
          environmentMachine="laptop"
          scratchMachineLabel={null}
          project={null}
          projectDisplayName="工作文档"
          providerEntryByInstanceId={providerEntryByInstanceId}
          timestampFormat={DEFAULT_CLIENT_SETTINGS.timestampFormat}
          onThreadClick={noop}
          onThreadActivate={noop}
          onStartRename={noop}
          onRenameTitleChange={noop}
          onCommitRename={noop}
          onCancelRename={noop}
          isRenaming={false}
          renamingTitle=""
          onContextMenu={noop}
          onSettle={noop}
          onActionSweepStart={noop}
          onUnsettle={noop}
          onSnooze={noop}
          onUnsnooze={noop}
          onUnpin={noop}
          onAcknowledgeWoke={noop}
        />
      </ul>
    </SidebarProvider>,
    { router: "/" },
  );

  await expect.element(screen.getByText("整理会议纪要")).toBeVisible();
  await expect.element(screen.getByText("feat/demo-branch")).not.toBeInTheDocument();
  await expect.element(screen.getByText("#88")).not.toBeInTheDocument();
  expect(screen.container.querySelector('a[href="https://github.com/org/repo/pull/42"]')).toBeNull();
  expect(screen.container.querySelector('[data-provider-accent-color="#6366f1"]')).toBeNull();
  expect(screen.container.querySelector('button[aria-label*="terminal" i]')).toBeNull();

  await vi.waitFor(() => {
    setDeveloperFeatures(true);
  });

  await expect.element(screen.getByText("整理会议纪要")).toBeVisible();
  await expect.element(screen.getByText("feat/demo-branch")).toBeVisible();
  await expect.element(screen.getByText("#88")).toBeVisible();
  expect(screen.container.querySelector('a[href="https://github.com/org/repo/pull/42"]')).not.toBeNull();
  expect(screen.container.querySelector('[data-provider-accent-color="#6366f1"]')).not.toBeNull();
  expect(screen.container.querySelector('button[aria-label*="terminal" i]')).not.toBeNull();
});
