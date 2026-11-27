import "~/index.css";
import { afterEach, expect, it, vi } from "vite-plus/test";
import { page } from "vite-plus/test/browser";
import { presentThreadShell } from "@t3tools/client-runtime/state/shell";
import type { EnvironmentThreadShell } from "@t3tools/client-runtime/state/models";
import {
  EnvironmentId,
  ProjectId,
  ProviderInstanceId,
  RunId,
  ThreadId,
  type OrchestrationV2ThreadShell,
} from "@t3tools/contracts";
import * as DateTime from "effect/DateTime";
import { render } from "../../../test/render";
import { AppRouteModal, AppRouteModalClose } from "../AppRouteModal";
import { applyThemePalette } from "../../themePalette";
import { LeaderSidebarSlot } from "./LeaderSidebarSlot";
import { LeaderSupervisoryBar } from "./LeaderSupervisoryBar";
import { NavigatorBotAvatar } from "./NavigatorBotAvatar";
import {
  DEFAULT_IM_DELEGATION_POLICY,
  type LeaderListItem,
  type LeaderOverview,
} from "./leaderTypes";

vi.mock("../../environments/primary/desktopAuth", () => ({
  readDesktopPrimaryBearerToken: async () => "test-bearer",
}));

vi.mock("../../state/environments", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../../state/environments")>();
  return {
    ...actual,
    usePrimaryEnvironmentId: () => "local" as EnvironmentId,
  };
});

let mockThreadShells: ReadonlyArray<EnvironmentThreadShell> = [];

function makeRealThreadShell(
  id: string,
  overrides: Partial<OrchestrationV2ThreadShell> = {},
): EnvironmentThreadShell {
  const environmentId = EnvironmentId.make("local");
  const threadId = ThreadId.make(id);
  const providerInstanceId = ProviderInstanceId.make("codex");
  const now = DateTime.makeUnsafe("2026-11-26T00:00:00.000Z");
  return presentThreadShell(environmentId, {
    id: threadId,
    projectId: ProjectId.make("proj-scratch"),
    title: "小瞳",
    providerInstanceId,
    modelSelection: { instanceId: providerInstanceId, model: "gpt-5.4" },
    runtimeMode: "full-access",
    interactionMode: "default",
    branch: null,
    worktreePath: null,
    activeProviderThreadId: null,
    lineage: { rootThreadId: threadId, parentThreadId: null, relationshipToParent: null },
    forkedFrom: null,
    createdBy: "user",
    creationSource: "web",
    latestRunId: null,
    activeRunId: null,
    status: "idle",
    pendingRuntimeRequest: null,
    latestVisibleMessage: null,
    latestUserMessageAt: null,
    hasActionableProposedPlan: false,
    itemCount: 0,
    visibleItemCount: 0,
    createdAt: now,
    updatedAt: now,
    archivedAt: null,
    settledOverride: null,
    settledAt: null,
    deletedAt: null,
    ...overrides,
  });
}

vi.mock("../../state/entities", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../../state/entities")>();
  return {
    ...actual,
    useProjects: () => [],
    useQuietThreadShells: () => mockThreadShells,
  };
});

afterEach(() => {
  mockThreadShells = [];
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
});

function stubDesktopBridge() {
  vi.stubGlobal("desktopBridge", {
    xtwork: true,
    getLocalEnvironmentEnabled: () => true,
    getLocalEnvironmentBootstraps: () => [],
  });
}

const sampleLeaderItem: LeaderListItem = {
  leader: {
    id: "leader-default",
    name: "小瞳",
    avatar: "瞳",
    role: "你的个人与团队领航员",
    status: "active",
    pinnedThreadId: "xtwork-leader-leader-default-abc123",
    awarenessScope: { kind: "all_local", projectIds: [] },
    ownerDmDesktopGrants: [],
    imPolicy: DEFAULT_IM_DELEGATION_POLICY,
    createdAt: 1,
    updatedAt: 1,
  },
  bindings: [],
  connections: [{ id: "conn-feishu", platform: "feishu", state: "connected", botName: "小瞳飞书" }],
  needsYouCount: 2,
  runningCount: 1,
  pendingApprovalCount: 1,
  pausedPendingCount: 1,
};

const secondLeaderItem: LeaderListItem = {
  leader: {
    id: "leader-eng",
    name: "研发领航员",
    avatar: "研",
    role: "技术搭档",
    status: "active",
    pinnedThreadId: "xtwork-leader-leader-eng-xyz789",
    awarenessScope: { kind: "all_local", projectIds: [] },
    ownerDmDesktopGrants: [],
    imPolicy: DEFAULT_IM_DELEGATION_POLICY,
    createdAt: 2,
    updatedAt: 2,
  },
  bindings: [],
  connections: [],
  needsYouCount: 0,
  runningCount: 0,
  pendingApprovalCount: 0,
  pausedPendingCount: 0,
};

const FULL_SNAPSHOT = `Q4 roadmap: launch Leader Slice 1.\n${"milestone-detail ".repeat(110)}SNAPSHOT_TAIL_MARKER`;

const sampleOverview: LeaderOverview = {
  leader: {
    ...sampleLeaderItem.leader,
    awarenessScope: { kind: "projects", projectIds: ["proj-alpha"] },
  },
  connections: sampleLeaderItem.connections,
  pausedPending: [
    {
      id: "msg-paused-1",
      connectionId: "conn-feishu",
      platform: "feishu",
      chatId: "chat-ops",
      chatKind: "group",
      chatName: "研发群",
      senderName: "Alice",
      body: "请帮我查一下今天发布进度",
      createdAt: Date.now(),
    },
  ],
  needsYou: {
    snapshotSequence: 10,
    needsYouCount: 1,
    runningCount: 1,
    completedCount: 0,
    failedCount: 0,
    pendingApprovalCount: 1,
    threads: [
      {
        threadId: "xtwork-im-group-ops",
        projectId: "proj-scratch",
        projectTitle: "远程连接",
        title: "研发群发布检查",
        phase: "waiting_for_approval",
        headline: "等待批准 (1)",
        replyAudience: "group",
        isProtected: true,
        updatedAt: new Date().toISOString(),
        pendingApprovalCount: 1,
      },
    ],
  },
  approvals: [
    {
      id: "apr-1",
      turnId: "run-99",
      threadId: "xtwork-im-group-ops",
      leaderId: "leader-default",
      toolName: "im__memory_share",
      replyAudience: "group",
      details: JSON.stringify({ note: "roadmap.md" }),
      snapshotHash: "snap1234567890",
      targetScope: "group:ops",
      targetChatName: "核心研发群",
      contentSnapshot: FULL_SNAPSHOT,
      contentPreview: FULL_SNAPSHOT,
    },
  ],
};

it("renders the Navigator sidebar section with heading, quick-create form, and opens threads on click", async () => {
  stubDesktopBridge();
  const opened: Array<{ envId: string; threadId: string }> = [];
  let leadersList: LeaderListItem[] = [sampleLeaderItem];
  const createdPayloads: Record<string, unknown>[] = [];

  vi.stubGlobal(
    "fetch",
    vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
      const url = typeof input === "string" ? input : input instanceof URL ? input.toString() : input.url;
      const body = typeof init?.body === "string" ? (JSON.parse(init.body) as Record<string, unknown>) : undefined;
      const json = (data: unknown) =>
        new Response(JSON.stringify(data), { status: 200, headers: { "Content-Type": "application/json" } });
      if (url.endsWith("/api/xtwork/im/leaders") && init?.method === "POST") {
        createdPayloads.push(body ?? {});
        leadersList = [...leadersList, secondLeaderItem];
        return json({ leader: secondLeaderItem.leader });
      }
      if (url.endsWith("/api/xtwork/im/leaders")) {
        return json({ leaders: leadersList });
      }
      if (url.endsWith("/api/xtwork/im/leaders/leader-default/open-thread")) {
        return json({ threadId: "xtwork-leader-leader-default-abc123" });
      }
      if (url.endsWith("/api/xtwork/im/leaders/leader-eng/open-thread")) {
        return json({ threadId: "xtwork-leader-leader-eng-xyz789" });
      }
      return json({});
    }),
  );

  await page.viewport(1280, 900);
  await using _screen = await render(
    <LeaderSidebarSlot onOpenThread={(envId, threadId) => opened.push({ envId, threadId })} />,
    { router: "/" },
  );

  await expect.element(page.getByTestId("leader-sidebar-slot")).toBeVisible();
  await expect.element(page.getByTestId("sidebar-navigators-heading")).toHaveTextContent("领航员");
  await expect.element(page.getByTestId("leader-slot-leader-default")).toBeVisible();
  await expect.element(page.getByTestId("leader-needs-you-badge-leader-default")).toHaveTextContent("2");

  await page.getByTestId("leader-slot-leader-default").click();
  await vi.waitFor(() => {
    expect(opened).toEqual([{ envId: "local", threadId: "xtwork-leader-leader-default-abc123" }]);
  });

  await page.getByTestId("leader-create-trigger").click();
  await expect.element(page.getByTestId("leader-create-form")).toBeVisible();
  const initialShape = page.getByTestId("leader-create-avatar-preview").element().getAttribute("data-avatar-shape");
  await page.getByTestId("leader-create-avatar-randomize").click();
  const rolledShape = page.getByTestId("leader-create-avatar-preview").element().getAttribute("data-avatar-shape");
  expect(rolledShape).toBeTruthy();
  expect(rolledShape).not.toBe(initialShape);
  await page.getByTestId("leader-create-name").fill("研发领航员");
  await page.getByRole("button", { name: "创建", exact: true }).click();

  await vi.waitFor(() => {
    expect(createdPayloads).toHaveLength(1);
    expect(createdPayloads[0]).toMatchObject({ name: "研发领航员" });
    expect(String(createdPayloads[0]?.avatar ?? "")).toMatch(/^bot:v1:[a-z0-9-]+:#[0-9a-f]{6}$/);
    expect(opened).toContainEqual({ envId: "local", threadId: "xtwork-leader-leader-eng-xyz789" });
  });
  await expect.element(page.getByTestId("leader-slot-leader-eng")).toBeVisible();
  await expect.element(page.getByTestId("leader-channels-leader-eng")).not.toBeInTheDocument();
  expect(page.getByTestId("leader-slot-leader-eng").element().textContent).not.toContain("领航控制面");
});

it("renders unified Navigator supervisory bar with Needs You, IM policy controls, channel rebinding, and archive", async () => {
  stubDesktopBridge();
  const calls: Array<{ path: string; body?: Record<string, unknown> }> = [];
  let currentOverview: LeaderOverview = structuredClone(sampleOverview);

  vi.stubGlobal(
    "fetch",
    vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
      const url = typeof input === "string" ? input : input instanceof URL ? input.toString() : input.url;
      const path = url.replace(/^.*\/api\/xtwork\/im\//, "").split("?")[0] ?? "";
      const body = typeof init?.body === "string" ? (JSON.parse(init.body) as Record<string, unknown>) : undefined;
      calls.push(body ? { path, body } : { path });

      const json = (data: unknown) =>
        new Response(JSON.stringify(data), { status: 200, headers: { "Content-Type": "application/json" } });

      if (path === "leaders") return json({ leaders: [sampleLeaderItem, secondLeaderItem] });
      if (path === "leaders/leader-default/overview") return json(currentOverview);
      if (path === "approvals/decide") {
        currentOverview = { ...currentOverview, approvals: [] };
        return json({ decided: true });
      }
      if (path === "leaders/leader-default/paused-decide") {
        const replayClicks = calls.filter((c) => c.path === "leaders/leader-default/paused-decide").length;
        if (replayClicks === 1) {
          return json({ count: 0, messageIds: [], skippedIds: ["msg-paused-1"], blockedIds: [], heldIds: [] });
        }
        currentOverview = { ...currentOverview, pausedPending: [] };
        return json({ count: 1, messageIds: ["msg-paused-1"], skippedIds: [], blockedIds: [], heldIds: [] });
      }
      if (path === "leaders/leader-default/update") {
        const nextImPolicy = body?.imPolicy as LeaderOverview["leader"]["imPolicy"] | undefined;
        currentOverview = {
          ...currentOverview,
          leader: {
            ...currentOverview.leader,
            name: String(body?.name ?? currentOverview.leader.name),
            ...(nextImPolicy ? { imPolicy: nextImPolicy } : {}),
          },
        };
        return json({ leader: currentOverview.leader });
      }
      if (path === "connections/rebind") {
        currentOverview = { ...currentOverview, connections: [] };
        return json({
          binding: { bindingId: "bind-2", leaderId: body?.leaderId, connectionId: body?.connectionId, epoch: 2 },
        });
      }
      if (path === "leaders/leader-default/diagnostics") {
        return json({ text: '{"leader":{"id":"leader-default"}}' });
      }
      return json({});
    }),
  );

  const jumped: string[] = [];
  await page.viewport(1280, 900);
  await using _screen = await render(
    <LeaderSupervisoryBar
      threadId="xtwork-leader-leader-default-abc123"
      environmentId={"local" as EnvironmentId}
      onOpenThread={(id) => jumped.push(id)}
      availableProjects={[
        { id: "proj-alpha", title: "Alpha App" },
        { id: "proj-beta", title: "Beta Service" },
      ]}
    />,
    { router: "/local/xtwork-leader-leader-default-abc123" },
  );

  await expect.element(page.getByTestId("leader-supervisory-bar")).toBeVisible();
  await expect.element(page.getByRole("button", { name: /Needs You \(2\)/ })).toBeVisible();

  await page.getByRole("button", { name: /Needs You \(2\)/ }).click();
  await expect.element(page.getByTestId("leader-needs-you-panel")).toBeVisible();
  await expect.element(page.getByTestId("approval-destination-apr-1")).toHaveTextContent("目标：核心研发群");
  await expect.element(page.getByTestId("approval-snapshot-apr-1")).toBeVisible();
  expect(page.getByTestId("approval-snapshot-apr-1").element().textContent).toBe(FULL_SNAPSHOT);
  await page.getByRole("button", { name: "允许一次", exact: true }).click();
  await vi.waitFor(() => {
    expect(
      calls.some(
        (c) =>
          c.path === "approvals/decide" &&
          c.body?.approved === true &&
          c.body?.expectedRunId === "run-99" &&
          c.body?.expectedAudience === "group" &&
          c.body?.expectedSnapshotHash === "snap1234567890",
      ),
    ).toBe(true);
  });

  await page.getByRole("button", { name: "重投", exact: true }).click();
  await expect
    .element(page.getByRole("status"))
    .toHaveTextContent("当前连接或领航员处于暂停/未激活状态，消息仍保留在暂停积压队列中。");

  await page.getByRole("button", { name: "重投", exact: true }).click();
  await expect.element(page.getByRole("status")).toHaveTextContent("已按原幂等键重新投递。");

  await page.getByRole("button", { name: /研发群发布检查/ }).click();
  expect(jumped).toEqual(["xtwork-im-group-ops"]);

  await page.getByRole("button", { name: "管理", exact: true }).click();
  await expect.element(page.getByTestId("leader-config-panel")).toBeVisible();
  await expect.element(page.getByTestId("leader-project-scope-picker")).toBeVisible();
  await expect.element(page.getByTestId("leader-im-policy-section")).toBeVisible();
  await expect.element(page.getByTestId("leader-archive-button")).not.toBeInTheDocument();

  const groupDelegationSelect = page.getByTestId("im-policy-group-delegation").element() as HTMLSelectElement;
  expect(Array.from(groupDelegationSelect.options).map((o) => o.value)).toEqual(["always_ask", "deny"]);

  await page.getByTestId("leader-rebind-select-conn-feishu").selectOptions("leader-eng");
  await vi.waitFor(() => {
    expect(
      calls.some(
        (c) => c.path === "connections/rebind" && c.body?.connectionId === "conn-feishu" && c.body?.leaderId === "leader-eng",
      ),
    ).toBe(true);
  });

  await page.getByRole("button", { name: "编程搭档", exact: true }).click();
  await page.getByRole("button", { name: "保存设置", exact: true }).click();
  await vi.waitFor(() => {
    const updateCall = calls.find((c) => c.path === "leaders/leader-default/update");
    expect(updateCall).toBeDefined();
    expect(updateCall?.body?.awarenessScope).toBeUndefined();
  });

  await page.getByRole("button", { name: "管理", exact: true }).click();
  await page.getByTestId("im-policy-owner-dm-delegation").selectOptions("scoped_auto");
  await expect.element(page.getByTestId("im-policy-owner-dm-projects")).toBeVisible();
  await page.getByTestId("im-policy-owner-dm-projects").getByLabelText("Alpha App").click();
  await page.getByTestId("im-policy-group-report").selectOptions("silent");
  await page.getByTestId("leader-project-scope-picker").getByLabelText("Beta Service").click();
  await page.getByRole("button", { name: "保存设置", exact: true }).click();

  await vi.waitFor(() => {
    const scopeUpdates = calls.filter(
      (c) => c.path === "leaders/leader-default/update" && c.body?.awarenessScope !== undefined,
    );
    expect(scopeUpdates).toHaveLength(1);
    expect(scopeUpdates[0]?.body?.awarenessScope).toEqual({
      kind: "projects",
      projectIds: ["proj-alpha", "proj-beta"],
    });
    expect(scopeUpdates[0]?.body?.imPolicy).toEqual({
      ownerDm: {
        delegationMode: "scoped_auto",
        allowedProjectIds: ["proj-alpha"],
      },
      group: {
        progressReportMode: "silent",
      },
    });
  });
});

it("allows archiving a non-default Navigator and hands over bound connections cleanly", async () => {
  stubDesktopBridge();
  const calls: Array<{ path: string; body?: Record<string, unknown> }> = [];
  const engOverview: LeaderOverview = {
    ...sampleOverview,
    leader: secondLeaderItem.leader,
    connections: [{ id: "conn-wecom", platform: "wecom", state: "connected" }],
    approvals: [],
    pausedPending: [],
    needsYou: {
      ...sampleOverview.needsYou,
      needsYouCount: 0,
      runningCount: 0,
      pendingApprovalCount: 0,
      threads: [],
    },
  };

  vi.stubGlobal(
    "fetch",
    vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
      const url = typeof input === "string" ? input : input instanceof URL ? input.toString() : input.url;
      const path = url.replace(/^.*\/api\/xtwork\/im\//, "").split("?")[0] ?? "";
      const body = typeof init?.body === "string" ? (JSON.parse(init.body) as Record<string, unknown>) : undefined;
      calls.push(body ? { path, body } : { path });
      const json = (data: unknown) =>
        new Response(JSON.stringify(data), { status: 200, headers: { "Content-Type": "application/json" } });
      if (path === "leaders") return json({ leaders: [sampleLeaderItem, secondLeaderItem] });
      if (path === "leaders/leader-eng/overview") return json(engOverview);
      if (path === "leaders/leader-eng/archive") return json({ leader: { ...secondLeaderItem.leader, status: "archived" }, reboundBindings: [] });
      if (path === "leaders/leader-default/open-thread") return json({ threadId: "xtwork-leader-leader-default-abc123" });
      return json({});
    }),
  );

  const jumped: string[] = [];
  await page.viewport(1280, 900);
  await using _screen = await render(
    <LeaderSupervisoryBar
      threadId="xtwork-leader-leader-eng-xyz789"
      environmentId={"local" as EnvironmentId}
      onOpenThread={(id) => jumped.push(id)}
    />,
    { router: "/local/xtwork-leader-leader-eng-xyz789" },
  );

  await page.getByRole("button", { name: "管理", exact: true }).click();
  await expect.element(page.getByTestId("leader-archive-button")).toBeVisible();
  await page.getByTestId("leader-archive-button").click();
  await expect.element(page.getByTestId("leader-archive-confirm-box")).toBeVisible();
  expect(page.getByTestId("leader-archive-confirm-box").element().textContent).toContain("企业微信");
  expect(page.getByTestId("leader-archive-confirm-box").element().textContent).toContain("小瞳");
  expect(calls.some((c) => c.path === "leaders/leader-eng/archive")).toBe(false);
  await page.getByTestId("leader-archive-confirm").click();

  await vi.waitFor(() => {
    expect(
      calls.some(
        (c) => c.path === "leaders/leader-eng/archive" && c.body?.rebindToLeaderId === "leader-default",
      ),
    ).toBe(true);
    expect(jumped).toEqual(["xtwork-leader-leader-default-abc123"]);
  });
});

it("disables archive when a non-default Navigator still has paused queued messages", async () => {
  stubDesktopBridge();
  const engPausedOverview: LeaderOverview = {
    ...sampleOverview,
    leader: { ...secondLeaderItem.leader, status: "paused" },
    connections: [],
    approvals: [],
    pausedPending: sampleOverview.pausedPending,
  };

  vi.stubGlobal(
    "fetch",
    vi.fn(async (input: RequestInfo | URL) => {
      const url = typeof input === "string" ? input : input instanceof URL ? input.toString() : input.url;
      const path = url.replace(/^.*\/api\/xtwork\/im\//, "").split("?")[0] ?? "";
      const json = (data: unknown) =>
        new Response(JSON.stringify(data), { status: 200, headers: { "Content-Type": "application/json" } });
      if (path === "leaders") return json({ leaders: [sampleLeaderItem, secondLeaderItem] });
      if (path === "leaders/leader-eng/overview") return json(engPausedOverview);
      return json({});
    }),
  );

  await page.viewport(1280, 900);
  await using _screen = await render(
    <LeaderSupervisoryBar
      threadId="xtwork-leader-leader-eng-xyz789"
      environmentId={"local" as EnvironmentId}
      onOpenThread={() => undefined}
    />,
    { router: "/local/xtwork-leader-leader-eng-xyz789" },
  );

  await page.getByRole("button", { name: "管理", exact: true }).click();
  await expect.element(page.getByTestId("leader-archive-button")).toBeDisabled();
});

it("renders fallbackHeader inside renderHeader when viewing a historical unmatched leader thread", async () => {
  stubDesktopBridge();
  vi.stubGlobal(
    "fetch",
    vi.fn(async (input: RequestInfo | URL) => {
      const url = typeof input === "string" ? input : input instanceof URL ? input.toString() : input.url;
      const path = url.replace(/^.*\/api\/xtwork\/im\//, "").split("?")[0] ?? "";
      const json = (data: unknown) =>
        new Response(JSON.stringify(data), { status: 200, headers: { "Content-Type": "application/json" } });
      if (path === "leaders") return json({ leaders: [sampleLeaderItem] });
      return json({});
    }),
  );

  await page.viewport(1280, 900);
  await using _screen = await render(
    <LeaderSupervisoryBar
      threadId="xtwork-leader-leader-default-historical999"
      environmentId={"local" as EnvironmentId}
      onOpenThread={() => undefined}
      fallbackHeader={<div data-testid="fallback-chat-header">Historical Thread Header</div>}
      renderHeader={(content) => <header data-testid="outer-header">{content}</header>}
    />,
    { router: "/local/xtwork-leader-leader-default-historical999" },
  );

  await expect.element(page.getByTestId("fallback-chat-header")).toBeVisible();
});

it("immediately falls back when switching from a matched Navigator to a historical thread while lookup is pending", async () => {
  stubDesktopBridge();
  let holdSecondLookup = false;
  let resolveHeldLookup: ((value: Response) => void) | undefined;
  vi.stubGlobal(
    "fetch",
    vi.fn(async (input: RequestInfo | URL) => {
      const url = typeof input === "string" ? input : input instanceof URL ? input.toString() : input.url;
      const path = url.replace(/^.*\/api\/xtwork\/im\//, "").split("?")[0] ?? "";
      const json = (data: unknown) =>
        new Response(JSON.stringify(data), { status: 200, headers: { "Content-Type": "application/json" } });
      if (path === "leaders" && holdSecondLookup) {
        return await new Promise<Response>((resolve) => {
          resolveHeldLookup = resolve;
        });
      }
      if (path === "leaders") return json({ leaders: [sampleLeaderItem] });
      if (path === "leaders/leader-default/overview") return json(sampleOverview);
      return json({});
    }),
  );

  await page.viewport(1280, 900);
  await using screen = await render(
    <LeaderSupervisoryBar
      threadId="xtwork-leader-leader-default-abc123"
      environmentId={"local" as EnvironmentId}
      onOpenThread={() => undefined}
      fallbackHeader={<div data-testid="fallback-chat-header">Historical Thread Header</div>}
      renderHeader={(content) => <header data-testid="outer-header">{content}</header>}
    />,
    { router: "/local/xtwork-leader-leader-default-abc123" },
  );

  await expect.element(page.getByTestId("leader-supervisory-bar")).toBeVisible();

  holdSecondLookup = true;
  await screen.rerender(
    <LeaderSupervisoryBar
      threadId="xtwork-leader-leader-default-historical999"
      environmentId={"local" as EnvironmentId}
      onOpenThread={() => undefined}
      fallbackHeader={<div data-testid="fallback-chat-header">Historical Thread Header</div>}
      renderHeader={(content) => <header data-testid="outer-header">{content}</header>}
    />,
  );

  await expect.element(page.getByTestId("fallback-chat-header")).toBeVisible();
  await expect.element(page.getByTestId("leader-supervisory-bar")).not.toBeInTheDocument();
  if (resolveHeldLookup) {
    resolveHeldLookup(
      new Response(JSON.stringify({ leaders: [sampleLeaderItem] }), {
        status: 200,
        headers: { "Content-Type": "application/json" },
      }),
    );
  }
});

it("preserves archive syncPending notice and renders pending badge on target Navigator connection row", async () => {
  stubDesktopBridge();
  const engOverview: LeaderOverview = {
    ...sampleOverview,
    leader: secondLeaderItem.leader,
    connections: [{ id: "conn-wecom", platform: "wecom", state: "connected", leaderId: "leader-eng" }],
    approvals: [],
    pausedPending: [],
    needsYou: {
      ...sampleOverview.needsYou,
      needsYouCount: 0,
      runningCount: 0,
      pendingApprovalCount: 0,
      threads: [],
    },
  };
  const defaultPendingOverview: LeaderOverview = {
    ...sampleOverview,
    connections: [
      {
        id: "conn-wecom",
        platform: "wecom",
        state: "connected",
        leaderId: "leader-eng",
        desiredLeaderId: "leader-default",
        syncPending: true,
      },
    ],
    approvals: [],
    pausedPending: [],
  };

  vi.stubGlobal(
    "fetch",
    vi.fn(async (input: RequestInfo | URL) => {
      const url = typeof input === "string" ? input : input instanceof URL ? input.toString() : input.url;
      const path = url.replace(/^.*\/api\/xtwork\/im\//, "").split("?")[0] ?? "";
      const json = (data: unknown) =>
        new Response(JSON.stringify(data), { status: 200, headers: { "Content-Type": "application/json" } });
      if (path === "leaders") return json({ leaders: [sampleLeaderItem, secondLeaderItem] });
      if (path === "leaders/leader-eng/overview") return json(engOverview);
      if (path === "leaders/leader-default/overview") return json(defaultPendingOverview);
      if (path === "leaders/leader-eng/archive") {
        return json({ leader: { ...secondLeaderItem.leader, status: "archived" }, reboundBindings: [], syncPending: true });
      }
      if (path === "leaders/leader-default/open-thread") {
        return json({ threadId: "xtwork-leader-leader-default-abc123" });
      }
      return json({});
    }),
  );

  const jumped: string[] = [];
  await page.viewport(1280, 900);
  await using screen = await render(
    <LeaderSupervisoryBar
      threadId="xtwork-leader-leader-eng-xyz789"
      environmentId={"local" as EnvironmentId}
      onOpenThread={(id) => jumped.push(id)}
    />,
    { router: "/local/xtwork-leader-leader-eng-xyz789" },
  );

  await page.getByRole("button", { name: "管理", exact: true }).click();
  await page.getByTestId("leader-archive-button").click();
  await expect.element(page.getByTestId("leader-archive-confirm-box")).toBeVisible();
  await page.getByTestId("leader-archive-confirm").click();
  await vi.waitFor(() => {
    expect(jumped).toEqual(["xtwork-leader-leader-default-abc123"]);
  });

  await screen.rerender(
    <LeaderSupervisoryBar
      threadId="xtwork-leader-leader-default-abc123"
      environmentId={"local" as EnvironmentId}
      onOpenThread={(id) => jumped.push(id)}
    />,
  );
  await expect
    .element(page.getByRole("status"))
    .toHaveTextContent("已归档领航员并保存换绑至默认领航员，远程桥接同步待重试确认。");
  await page.getByRole("button", { name: "管理", exact: true }).click();
  await expect.element(page.getByTestId("leader-conn-sync-pending-conn-wecom")).toHaveTextContent("同步中…");
});

it("shows green dots for strictly online IM channels, red dots for bound offline/syncPending channels, and nothing when unbound or pairing", async () => {
  stubDesktopBridge();
  const mixedLeader: LeaderListItem = {
    ...sampleLeaderItem,
    leader: { ...sampleLeaderItem.leader, id: "leader-mixed", name: "小瞳" },
    bindings: [
      { bindingId: "bind-wechat", connectionId: "conn-wechat", epoch: 1, platform: "wechat", claimed: true },
      { bindingId: "bind-feishu", connectionId: "conn-feishu", epoch: 1, platform: "feishu", claimed: true },
      { bindingId: "bind-wecom", connectionId: "conn-wecom", epoch: 1, platform: "wecom", claimed: true },
    ],
    boundPlatforms: ["wechat", "feishu", "wecom"],
    connections: [
      { id: "conn-wechat", platform: "wechat", lifecycleState: "active", state: "connected" },
      { id: "conn-feishu", platform: "feishu", lifecycleState: "active", state: "reconnecting" },
      { id: "conn-wecom", platform: "wecom", lifecycleState: "active", state: "connected", syncPending: true },
    ],
    needsYouCount: 0,
    runningCount: 0,
    pendingApprovalCount: 0,
    pausedPendingCount: 0,
  };
  const unboundLeader: LeaderListItem = {
    ...secondLeaderItem,
    leader: { ...secondLeaderItem.leader, id: "leader-unbound", name: "啊啊" },
    bindings: [{ bindingId: "bind-pairing", connectionId: "conn-pairing", epoch: 1, platform: "wechat", claimed: false }],
    boundPlatforms: [],
    connections: [{ id: "conn-pairing", platform: "wechat", lifecycleState: "pairing", state: "connected" }],
  };

  vi.stubGlobal(
    "fetch",
    vi.fn(async () =>
      new Response(JSON.stringify({ leaders: [mixedLeader, unboundLeader] }), {
        status: 200,
        headers: { "Content-Type": "application/json" },
      }),
    ),
  );

  await page.viewport(1280, 900);
  await using _screen = await render(<LeaderSidebarSlot />, { router: "/" });

  await expect.element(page.getByTestId("leader-channel-leader-mixed-wechat")).toBeVisible();
  expect(page.getByTestId("leader-channel-leader-mixed-wechat").element().getAttribute("data-online")).toBe("true");
  expect(page.getByTestId("leader-channel-dot-leader-mixed-wechat").element().className).toContain("bg-emerald-500");
  expect(page.getByTestId("leader-channel-leader-mixed-wechat").element().textContent).toContain("在线");

  await expect.element(page.getByTestId("leader-channel-leader-mixed-feishu")).toBeVisible();
  expect(page.getByTestId("leader-channel-leader-mixed-feishu").element().getAttribute("data-online")).toBe("false");
  expect(page.getByTestId("leader-channel-dot-leader-mixed-feishu").element().className).toContain("bg-rose-500");
  expect(page.getByTestId("leader-channel-leader-mixed-feishu").element().textContent).toContain("离线");

  await expect.element(page.getByTestId("leader-channel-leader-mixed-wecom")).toBeVisible();
  expect(page.getByTestId("leader-channel-leader-mixed-wecom").element().getAttribute("data-online")).toBe("false");
  expect(page.getByTestId("leader-channel-dot-leader-mixed-wecom").element().className).toContain("bg-rose-500");

  await expect.element(page.getByTestId("leader-channels-leader-unbound")).not.toBeInTheDocument();
  expect(page.getByTestId("leader-slot-leader-unbound").element().textContent).not.toContain("领航控制面");
});

it("drives sidebar and header Navigator avatars through thinking, working, done celebration, and stopped non-celebration using real presentThreadShell()", async () => {
  stubDesktopBridge();
  const quietLeader: LeaderListItem = {
    ...secondLeaderItem,
    leader: {
      ...secondLeaderItem.leader,
      id: "leader-live",
      name: "小瞳",
      avatar: "bot:v1:cat:#f8a01c",
      pinnedThreadId: "xtwork-leader-live-thread",
    },
    needsYouCount: 0,
    runningCount: 0,
    pendingApprovalCount: 0,
    pausedPendingCount: 0,
  };
  const quietOverview: LeaderOverview = {
    ...sampleOverview,
    leader: quietLeader.leader,
    connections: [],
    bindings: [],
    boundPlatforms: [],
    pausedPending: [],
    approvals: [],
    needsYou: {
      snapshotSequence: 1,
      needsYouCount: 0,
      startingCount: 0,
      runningCount: 0,
      waitingCount: 0,
      completedCount: 0,
      failedCount: 0,
      pendingApprovalCount: 0,
      latestCompletedKey: null,
      latestCompletedAtMs: null,
      threads: [],
    },
  };

  let currentLatestCompletedKey: string | null = null;
  let currentLatestCompletedAtMs: number | null = null;

  vi.stubGlobal(
    "fetch",
    vi.fn(async (input: RequestInfo | URL) => {
      const url = typeof input === "string" ? input : input instanceof URL ? input.toString() : input.url;
      const path = url.replace(/^.*\/api\/xtwork\/im\//, "").split("?")[0] ?? "";
      const json = (data: unknown) =>
        new Response(JSON.stringify(data), { status: 200, headers: { "Content-Type": "application/json" } });
      if (path === "leaders") {
        return json({
          leaders: [
            {
              ...quietLeader,
              latestCompletedKey: currentLatestCompletedKey,
              latestCompletedAtMs: currentLatestCompletedAtMs,
            },
          ],
        });
      }
      if (path === "leaders/leader-live/overview") {
        return json({
          ...quietOverview,
          needsYou: {
            ...quietOverview.needsYou,
            latestCompletedKey: currentLatestCompletedKey,
            latestCompletedAtMs: currentLatestCompletedAtMs,
          },
        });
      }
      return json({});
    }),
  );

  const renderPair = () => (
    <div>
      <LeaderSidebarSlot />
      <LeaderSupervisoryBar
        threadId="xtwork-leader-live-thread"
        environmentId={EnvironmentId.make("local")}
      />
    </div>
  );

  mockThreadShells = [
    makeRealThreadShell("xtwork-leader-live-thread", {
      status: "idle",
      activityRunStatus: null,
      latestRunId: RunId.make("run-0"),
    }),
  ];
  await page.viewport(1280, 900);
  await using screen = await render(renderPair(), { router: "/local/xtwork-leader-live-thread" });

  await expect.element(page.getByTestId("leader-avatar-leader-live")).toBeVisible();
  await expect.element(page.getByTestId("leader-header-avatar")).toBeVisible();
  expect(page.getByTestId("leader-avatar-leader-live").element().getAttribute("data-avatar-shape")).toBe("cat");
  expect(page.getByTestId("leader-avatar-leader-live").element().getAttribute("data-avatar-state")).toBe("idle");
  expect(page.getByTestId("leader-header-avatar").element().getAttribute("data-avatar-state")).toBe("idle");

  mockThreadShells = [
    makeRealThreadShell("xtwork-leader-live-thread", {
      status: "starting",
      activityRunStatus: "starting",
      latestRunId: RunId.make("run-1"),
      activeRunId: RunId.make("run-1"),
    }),
  ];
  await screen.rerender(renderPair());
  await vi.waitFor(() => {
    expect(page.getByTestId("leader-avatar-leader-live").element().getAttribute("data-avatar-state")).toBe("thinking");
    expect(page.getByTestId("leader-header-avatar").element().getAttribute("data-avatar-state")).toBe("thinking");
  });

  mockThreadShells = [
    makeRealThreadShell("xtwork-leader-live-thread", {
      status: "running",
      activityRunStatus: "running",
      latestRunId: RunId.make("run-1"),
      activeRunId: RunId.make("run-1"),
    }),
  ];
  await screen.rerender(renderPair());
  await vi.waitFor(() => {
    expect(page.getByTestId("leader-avatar-leader-live").element().getAttribute("data-avatar-state")).toBe("working");
    expect(page.getByTestId("leader-header-avatar").element().getAttribute("data-avatar-state")).toBe("working");
  });

  mockThreadShells = [
    makeRealThreadShell("xtwork-leader-live-thread", {
      status: "completed",
      activityRunStatus: null,
      latestRunId: RunId.make("run-1"),
      activeRunId: null,
      latestRunStopRequested: false,
    }),
  ];
  await screen.rerender(renderPair());
  await vi.waitFor(() => {
    expect(page.getByTestId("leader-avatar-leader-live").element().getAttribute("data-avatar-state")).toBe("done");
    expect(page.getByTestId("leader-avatar-leader-live").element().getAttribute("data-avatar-mood")).toBe("happy");
    expect(page.getByTestId("leader-header-avatar").element().getAttribute("data-avatar-state")).toBe("done");
    expect(page.getByTestId("leader-header-avatar").element().getAttribute("data-avatar-mood")).toBe("happy");
  });

  mockThreadShells = [
    makeRealThreadShell("xtwork-leader-live-thread", {
      status: "running",
      activityRunStatus: "running",
      latestRunId: RunId.make("run-2"),
      activeRunId: RunId.make("run-2"),
    }),
  ];
  await screen.rerender(renderPair());
  await vi.waitFor(() => {
    expect(page.getByTestId("leader-avatar-leader-live").element().getAttribute("data-avatar-state")).toBe("working");
    expect(page.getByTestId("leader-header-avatar").element().getAttribute("data-avatar-state")).toBe("working");
  });

  mockThreadShells = [
    makeRealThreadShell("xtwork-leader-live-thread", {
      status: "completed",
      activityRunStatus: null,
      latestRunId: RunId.make("run-2"),
      activeRunId: null,
      latestRunStopRequested: true,
    }),
  ];
  await screen.rerender(renderPair());
  await vi.waitFor(() => {
    expect(page.getByTestId("leader-avatar-leader-live").element().getAttribute("data-avatar-state")).toBe("idle");
    expect(page.getByTestId("leader-avatar-leader-live").element().getAttribute("data-avatar-mood")).toBe("neutral");
    expect(page.getByTestId("leader-header-avatar").element().getAttribute("data-avatar-state")).toBe("idle");
    expect(page.getByTestId("leader-header-avatar").element().getAttribute("data-avatar-mood")).toBe("neutral");
  }, { timeout: 2500 });

  mockThreadShells = [
    makeRealThreadShell("xtwork-leader-live-thread", {
      status: "running",
      activityRunStatus: "running",
      latestRunId: RunId.make("run-3"),
      activeRunId: RunId.make("run-3"),
    }),
  ];
  await screen.rerender(renderPair());
  await vi.waitFor(() => {
    expect(page.getByTestId("leader-avatar-leader-live").element().getAttribute("data-avatar-state")).toBe("working");
    expect(page.getByTestId("leader-header-avatar").element().getAttribute("data-avatar-state")).toBe("working");
  });

  const heldShell = makeRealThreadShell("xtwork-leader-live-thread", {
    status: "completed",
    activityRunStatus: null,
    latestRunId: RunId.make("run-3"),
    activeRunId: null,
    latestRunStopRequested: false,
    pendingBackgroundTasks: [{ taskId: "bg-subagent-1", kind: "subagent" }],
  });
  expect(heldShell.runtime?.status).toBe("idle");
  mockThreadShells = [heldShell];
  await screen.rerender(renderPair());
  await vi.waitFor(() => {
    expect(page.getByTestId("leader-avatar-leader-live").element().getAttribute("data-avatar-state")).toBe("idle");
    expect(page.getByTestId("leader-avatar-leader-live").element().getAttribute("data-avatar-mood")).toBe("neutral");
    expect(page.getByTestId("leader-header-avatar").element().getAttribute("data-avatar-state")).toBe("idle");
    expect(page.getByTestId("leader-header-avatar").element().getAttribute("data-avatar-mood")).toBe("neutral");
  }, { timeout: 2500 });

  currentLatestCompletedKey = "other-thread:run-other:999999";
  currentLatestCompletedAtMs = 999999;
  window.dispatchEvent(new CustomEvent("xtwork:leaders-changed"));
  await new Promise((resolve) => setTimeout(resolve, 250));
  expect(page.getByTestId("leader-avatar-leader-live").element().getAttribute("data-avatar-state")).toBe("idle");
  expect(page.getByTestId("leader-avatar-leader-live").element().getAttribute("data-avatar-mood")).toBe("neutral");
  expect(page.getByTestId("leader-header-avatar").element().getAttribute("data-avatar-state")).toBe("idle");
  expect(page.getByTestId("leader-header-avatar").element().getAttribute("data-avatar-mood")).toBe("neutral");

  mockThreadShells = [
    makeRealThreadShell("xtwork-leader-live-thread", {
      status: "completed",
      activityRunStatus: null,
      latestRunId: RunId.make("run-3"),
      activeRunId: null,
      latestRunStopRequested: false,
      pendingBackgroundTasks: [],
    }),
  ];
  await screen.rerender(renderPair());
  await vi.waitFor(() => {
    expect(page.getByTestId("leader-avatar-leader-live").element().getAttribute("data-avatar-state")).toBe("done");
    expect(page.getByTestId("leader-avatar-leader-live").element().getAttribute("data-avatar-mood")).toBe("happy");
    expect(page.getByTestId("leader-header-avatar").element().getAttribute("data-avatar-state")).toBe("done");
    expect(page.getByTestId("leader-header-avatar").element().getAttribute("data-avatar-mood")).toBe("happy");
  });
});

it("keeps a single polling timer even after repeated xtwork:leaders-changed events", async () => {
  stubDesktopBridge();
  let leadersFetchCount = 0;
  vi.stubGlobal(
    "fetch",
    vi.fn(async (input: RequestInfo | URL) => {
      const url = typeof input === "string" ? input : input instanceof URL ? input.toString() : input.url;
      const path = url.replace(/^.*\/api\/xtwork\/im\//, "").split("?")[0] ?? "";
      const json = (data: unknown) =>
        new Response(JSON.stringify(data), { status: 200, headers: { "Content-Type": "application/json" } });
      if (path === "leaders") {
        leadersFetchCount += 1;
        return json({ leaders: [sampleLeaderItem] });
      }
      if (path === "leaders/leader-default/overview") return json(sampleOverview);
      return json({});
    }),
  );

  await page.viewport(1280, 900);
  await using _screen = await render(
    <LeaderSupervisoryBar
      threadId="xtwork-leader-leader-default-abc123"
      environmentId={EnvironmentId.make("local")}
    />,
    { router: "/local/xtwork-leader-leader-default-abc123" },
  );

  await expect.element(page.getByTestId("leader-supervisory-bar")).toBeVisible();
  for (let i = 0; i < 6; i += 1) {
    window.dispatchEvent(new CustomEvent("xtwork:leaders-changed"));
  }
  await new Promise((resolve) => setTimeout(resolve, 200));
  const countAfterBurst = leadersFetchCount;
  await new Promise((resolve) => setTimeout(resolve, 2800));
  expect(leadersFetchCount - countAfterBurst).toBeLessThanOrEqual(2);
});

it("lets users randomize, choose among 23 bot shapes, and customize color in the Manage edit area", async () => {
  stubDesktopBridge();
  const updatePayloads: Record<string, unknown>[] = [];
  let currentOverview: LeaderOverview = structuredClone(sampleOverview);

  vi.stubGlobal(
    "fetch",
    vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
      const url = typeof input === "string" ? input : input instanceof URL ? input.toString() : input.url;
      const path = url.replace(/^.*\/api\/xtwork\/im\//, "").split("?")[0] ?? "";
      const body = typeof init?.body === "string" ? (JSON.parse(init.body) as Record<string, unknown>) : undefined;
      const json = (data: unknown) =>
        new Response(JSON.stringify(data), { status: 200, headers: { "Content-Type": "application/json" } });
      if (path === "leaders") return json({ leaders: [sampleLeaderItem, secondLeaderItem] });
      if (path === "leaders/leader-default/overview") return json(currentOverview);
      if (path === "leaders/leader-default/update") {
        updatePayloads.push(body ?? {});
        currentOverview = {
          ...currentOverview,
          leader: {
            ...currentOverview.leader,
            avatar: String(body?.avatar ?? currentOverview.leader.avatar),
          },
        };
        return json({ leader: currentOverview.leader });
      }
      return json({});
    }),
  );

  await page.viewport(1280, 900);
  await using _screen = await render(
    <LeaderSupervisoryBar
      threadId="xtwork-leader-leader-default-abc123"
      environmentId={"local" as EnvironmentId}
    />,
    { router: "/local/xtwork-leader-leader-default-abc123" },
  );

  await page.getByRole("button", { name: "管理", exact: true }).click();
  await expect.element(page.getByTestId("leader-avatar-editor")).toBeVisible();
  expect(page.getByTestId("leader-avatar-shape-grid").element().querySelectorAll("button")).toHaveLength(23);

  const beforeShape = page.getByTestId("leader-avatar-editor-preview").element().getAttribute("data-avatar-shape");
  await page.getByTestId("leader-avatar-randomize").click();
  const afterRandomShape = page.getByTestId("leader-avatar-editor-preview").element().getAttribute("data-avatar-shape");
  expect(afterRandomShape).not.toBe(beforeShape);

  await page.getByTestId("leader-avatar-shape-rocket").click();
  await page.getByTestId("leader-avatar-swatch-7").click();
  expect(page.getByTestId("leader-avatar-editor-preview").element().getAttribute("data-avatar-shape")).toBe("rocket");
  expect(page.getByTestId("leader-avatar-editor-preview").element().getAttribute("data-avatar-color")).toBe("#1f7cf2");

  await page.getByRole("button", { name: "保存设置", exact: true }).click();
  await vi.waitFor(() => {
    expect(updatePayloads).toHaveLength(1);
    expect(updatePayloads[0]).toEqual({ avatar: "bot:v1:rocket:#1f7cf2" });
  });
});

it("renders 23 bounded static SVGs with unique DOM IDs, zero button overlap, accurate hit-testing, and no horizontal overflow in narrow split-pane", async () => {
  stubDesktopBridge();
  vi.stubGlobal(
    "fetch",
    vi.fn(async (input: RequestInfo | URL) => {
      const url = typeof input === "string" ? input : input instanceof URL ? input.toString() : input.url;
      const path = url.replace(/^.*\/api\/xtwork\/im\//, "").split("?")[0] ?? "";
      const json = (data: unknown) =>
        new Response(JSON.stringify(data), { status: 200, headers: { "Content-Type": "application/json" } });
      if (path === "leaders") return json({ leaders: [sampleLeaderItem, secondLeaderItem] });
      if (path === "leaders/leader-default/overview") return json(sampleOverview);
      return json({});
    }),
  );

  await page.viewport(1200, 800);
  await using _screen = await render(
    <div style={{ width: 320 }} className="flex h-[800px] flex-col" data-chat-column>
      <LeaderSupervisoryBar
        threadId="xtwork-leader-leader-default-abc123"
        environmentId={"local" as EnvironmentId}
        rightPanelOpen
        renderHeader={(header) => <header className="flex h-12 shrink-0 items-center px-3">{header}</header>}
      />
    </div>,
    { router: "/local/xtwork-leader-leader-default-abc123" },
  );

  await expect.element(page.getByTestId("leader-supervisory-bar")).toBeVisible();
  const nameRect = page.getByTestId("leader-header-name").element().getBoundingClientRect();
  expect(nameRect.width).toBeGreaterThan(20);

  await page.getByRole("button", { name: "管理", exact: true }).click();
  await expect.element(page.getByTestId("leader-config-panel")).toBeVisible();

  await vi.waitFor(() => {
    const svgs = page.getByTestId("leader-avatar-shape-grid").element().querySelectorAll("svg");
    expect(svgs).toHaveLength(23);
  });

  const panel = page.getByTestId("leader-config-panel").element() as HTMLElement;
  const panelRect = panel.getBoundingClientRect();
  expect(panel.scrollWidth - panel.clientWidth).toBeLessThanOrEqual(1);

  const selects = Array.from(panel.querySelectorAll("select"));
  expect(selects.length).toBeGreaterThanOrEqual(4);
  for (const select of selects) {
    expect(select.getBoundingClientRect().right).toBeLessThanOrEqual(panelRect.right + 1);
  }

  const buttons = Array.from(page.getByTestId("leader-avatar-shape-grid").element().querySelectorAll("button"));
  expect(buttons).toHaveLength(23);

  for (const button of buttons) {
    const svg = button.querySelector("svg");
    expect(svg).not.toBeNull();
    expect(svg?.getAttribute("width")).toBeTruthy();
    expect(svg?.getAttribute("height")).toBeTruthy();
    const svgRect = svg!.getBoundingClientRect();
    expect(svgRect.width).toBeGreaterThan(0);
    expect(svgRect.width).toBeLessThanOrEqual(26);
    expect(svgRect.height).toBeGreaterThan(0);
    expect(svgRect.height).toBeLessThanOrEqual(26);

    button.scrollIntoView({ block: "center" });
    const btnRect = button.getBoundingClientRect();
    const hitCenter = document.elementFromPoint(btnRect.left + btnRect.width / 2, btnRect.top + btnRect.height / 2);
    const hitRight = document.elementFromPoint(btnRect.right - 2, btnRect.top + btnRect.height / 2);
    expect(hitCenter && button.contains(hitCenter)).toBe(true);
    expect(hitRight && button.contains(hitRight)).toBe(true);
  }

  for (let i = 0; i < buttons.length; i += 1) {
    for (let j = i + 1; j < buttons.length; j += 1) {
      const a = buttons[i]!.getBoundingClientRect();
      const b = buttons[j]!.getBoundingClientRect();
      const overlapX = Math.min(a.right, b.right) - Math.max(a.left, b.left);
      const overlapY = Math.min(a.bottom, b.bottom) - Math.max(a.top, b.top);
      expect(overlapX > 0 && overlapY > 0).toBe(false);
    }
  }
});

it("keeps Manage and Needs You drawers strictly above the bottom chat composer at 760x500", async () => {
  stubDesktopBridge();
  vi.stubGlobal(
    "fetch",
    vi.fn(async (input: RequestInfo | URL) => {
      const url = typeof input === "string" ? input : input instanceof URL ? input.toString() : input.url;
      const path = url.replace(/^.*\/api\/xtwork\/im\//, "").split("?")[0] ?? "";
      const json = (data: unknown) =>
        new Response(JSON.stringify(data), { status: 200, headers: { "Content-Type": "application/json" } });
      if (path === "leaders") return json({ leaders: [sampleLeaderItem] });
      if (path === "leaders/leader-default/overview") return json(sampleOverview);
      return json({});
    }),
  );

  await page.viewport(760, 500);
  await using _screen = await render(
    <div className="flex h-[500px] w-[760px] flex-col overflow-x-hidden" data-chat-column>
      <LeaderSupervisoryBar
        threadId="xtwork-leader-leader-default-abc123"
        environmentId={"local" as EnvironmentId}
        renderHeader={(header) => <header className="flex h-12 shrink-0 items-center px-3">{header}</header>}
      />
      <div className="relative flex min-h-0 min-w-0 flex-1">
        <div
          data-chat-composer-overlay="true"
          className="pointer-events-none absolute inset-x-0 bottom-0 z-20"
        >
          <div data-chat-composer-stack="true" className="pointer-events-auto h-[112px] w-full border bg-card" />
        </div>
      </div>
    </div>,
    { router: "/local/xtwork-leader-leader-default-abc123" },
  );

  await expect.element(page.getByTestId("leader-supervisory-bar")).toBeVisible();
  const composerEl = document.querySelector("[data-chat-composer-stack='true']") as HTMLElement;
  expect(composerEl).not.toBeNull();

  await page.getByRole("button", { name: "管理", exact: true }).click();
  await expect.element(page.getByTestId("leader-config-panel")).toBeVisible();
  await vi.waitFor(() => {
    const configRect = page.getByTestId("leader-config-panel").element().getBoundingClientRect();
    const composerRect = composerEl.getBoundingClientRect();
    expect(configRect.bottom).toBeLessThanOrEqual(composerRect.top);
  });

  await page.getByRole("button", { name: /Needs You/ }).click();
  await expect.element(page.getByTestId("leader-needs-you-panel")).toBeVisible();
  await vi.waitFor(() => {
    const needsRect = page.getByTestId("leader-needs-you-panel").element().getBoundingClientRect();
    const composerRect = composerEl.getBoundingClientRect();
    expect(needsRect.bottom).toBeLessThanOrEqual(composerRect.top);
  });
});

it("patches only fields edited since opening Manage without overwriting concurrent role or awarenessScope changes", async () => {
  stubDesktopBridge();
  const updatePayloads: Record<string, unknown>[] = [];
  let currentOverview: LeaderOverview = {
    ...structuredClone(sampleOverview),
    leader: {
      ...structuredClone(sampleOverview.leader),
      role: "初始角色",
      awarenessScope: { kind: "all_local", projectIds: [] },
    },
  };

  vi.stubGlobal(
    "fetch",
    vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
      const url = typeof input === "string" ? input : input instanceof URL ? input.toString() : input.url;
      const path = url.replace(/^.*\/api\/xtwork\/im\//, "").split("?")[0] ?? "";
      const body = typeof init?.body === "string" ? (JSON.parse(init.body) as Record<string, unknown>) : undefined;
      const json = (data: unknown) =>
        new Response(JSON.stringify(data), { status: 200, headers: { "Content-Type": "application/json" } });
      if (path === "leaders") return json({ leaders: [sampleLeaderItem] });
      if (path === "leaders/leader-default/overview") return json(currentOverview);
      if (path === "leaders/leader-default/update") {
        updatePayloads.push(body ?? {});
        return json({ leader: { ...currentOverview.leader, ...body } });
      }
      return json({});
    }),
  );

  await page.viewport(1280, 900);
  await using _screen = await render(
    <LeaderSupervisoryBar
      threadId="xtwork-leader-leader-default-abc123"
      environmentId={"local" as EnvironmentId}
    />,
    { router: "/local/xtwork-leader-leader-default-abc123" },
  );

  await page.getByRole("button", { name: "管理", exact: true }).click();
  await expect.element(page.getByTestId("leader-avatar-editor")).toBeVisible();

  currentOverview = {
    ...currentOverview,
    leader: {
      ...currentOverview.leader,
      role: "另一端刚保存的角色",
      awarenessScope: { kind: "none", projectIds: [] },
    },
  };
  window.dispatchEvent(new CustomEvent("xtwork:leaders-changed"));
  await new Promise((resolve) => setTimeout(resolve, 120));

  await page.getByTestId("leader-avatar-shape-rocket").click();
  await page.getByTestId("leader-avatar-swatch-7").click();
  await page.getByRole("button", { name: "保存设置", exact: true }).click();

  await vi.waitFor(() => {
    expect(updatePayloads).toHaveLength(1);
    expect(updatePayloads[0]).toEqual({ avatar: "bot:v1:rocket:#1f7cf2" });
  });
});

it("closes quick-create after POST succeeds even when list refresh returns 503 and resets draft state on cancel", async () => {
  stubDesktopBridge();
  let createPosts = 0;
  let failListAfterCreate = false;

  vi.stubGlobal(
    "fetch",
    vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
      const url = typeof input === "string" ? input : input instanceof URL ? input.toString() : input.url;
      const json = (data: unknown, status = 200) =>
        new Response(JSON.stringify(data), { status, headers: { "Content-Type": "application/json" } });
      if (url.endsWith("/api/xtwork/im/leaders") && init?.method === "POST") {
        createPosts += 1;
        failListAfterCreate = true;
        return json({ leader: secondLeaderItem.leader });
      }
      if (url.endsWith("/api/xtwork/im/leaders")) {
        if (failListAfterCreate) {
          return json({ error: "temporary unavailable" }, 503);
        }
        return json({ leaders: [sampleLeaderItem] });
      }
      if (url.endsWith("/api/xtwork/im/leaders/leader-eng/open-thread")) {
        return json({ threadId: "xtwork-leader-leader-eng-xyz789" });
      }
      return json({});
    }),
  );

  await page.viewport(1280, 900);
  await using _screen = await render(<LeaderSidebarSlot onOpenThread={() => undefined} />, { router: "/" });
  await expect.element(page.getByTestId("leader-sidebar-slot")).toBeVisible();

  await page.getByTestId("leader-create-trigger").click();
  await page.getByTestId("leader-create-name").fill("临时草稿");
  await page.getByTestId("leader-create-template-group").click();
  expect(page.getByTestId("leader-create-template-group").element().getAttribute("aria-pressed")).toBe("true");
  await page.getByRole("button", { name: "取消", exact: true }).click();

  await page.getByTestId("leader-create-trigger").click();
  expect((page.getByTestId("leader-create-name").element() as HTMLInputElement).value).toBe("");
  expect(page.getByTestId("leader-create-template-group").element().getAttribute("aria-pressed")).toBe("false");

  await page.getByTestId("leader-create-name").fill("正式领航员");
  await page.getByRole("button", { name: "创建", exact: true }).click();

  await vi.waitFor(() => {
    expect(createPosts).toBe(1);
    expect(page.getByTestId("leader-create-form").query()).toBeNull();
  });
  await expect.element(page.getByTestId("leader-sidebar-error")).toBeVisible();
  await expect.element(page.getByTestId("leader-sidebar-retry")).toBeVisible();
});

it("expands Needs You beyond 8 tasks, surfaces offline bound platforms and pairing badge in Manage, falls back without clipboard, and keeps unique SVG IDs", async () => {
  stubDesktopBridge();
  const tenThreads = Array.from({ length: 10 }, (_, idx) => ({
    threadId: `thread-${idx + 1}`,
    projectId: "proj-scratch",
    projectTitle: "项目",
    title: `待处理任务 ${idx + 1}`,
    phase: "waiting_for_input" as const,
    headline: "等你决定",
    replyAudience: "local_only" as const,
    isProtected: false,
    updatedAt: new Date().toISOString(),
    pendingApprovalCount: 0,
  }));
  const richOverview: LeaderOverview = {
    ...sampleOverview,
    leader: { ...sampleOverview.leader, avatar: "bot:v1:cat:#ffffff" },
    boundPlatforms: ["feishu"],
    connections: [{ id: "conn-pairing", platform: "wechat", lifecycleState: "pairing", state: "connecting" }],
    approvals: [],
    pausedPending: [],
    needsYou: {
      ...sampleOverview.needsYou,
      needsYouCount: 10,
      threads: tenThreads,
    },
  };

  vi.stubGlobal(
    "fetch",
    vi.fn(async (input: RequestInfo | URL) => {
      const url = typeof input === "string" ? input : input instanceof URL ? input.toString() : input.url;
      const path = url.replace(/^.*\/api\/xtwork\/im\//, "").split("?")[0] ?? "";
      const json = (data: unknown) =>
        new Response(JSON.stringify(data), { status: 200, headers: { "Content-Type": "application/json" } });
      if (path === "leaders") return json({ leaders: [sampleLeaderItem] });
      if (path === "leaders/leader-default/overview") return json(richOverview);
      if (path === "leaders/leader-default/diagnostics") return json({ text: '{"diag":"redacted"}' });
      return json({});
    }),
  );

  const originalClipboard = navigator.clipboard;
  Object.defineProperty(navigator, "clipboard", { value: undefined, configurable: true });

  try {
    await page.viewport(1280, 900);
    await using _screen = await render(
      <div>
        <NavigatorBotAvatar avatar="bot:v1:cat:#ff6a1a" size={24} still testId="dup-cat-a" />
        <NavigatorBotAvatar avatar="bot:v1:cat:#1f7cf2" size={24} still testId="dup-cat-b" />
        <LeaderSupervisoryBar
          threadId="xtwork-leader-leader-default-abc123"
          environmentId={"local" as EnvironmentId}
        />
      </div>,
      { router: "/local/xtwork-leader-leader-default-abc123" },
    );

    await page.getByRole("button", { name: /Needs You \(10\)/ }).click();
    await expect.element(page.getByText("待处理任务 8", { exact: true })).toBeVisible();
    await expect.element(page.getByText("待处理任务 9", { exact: true })).not.toBeInTheDocument();
    await page.getByTestId("leader-needs-you-toggle-all").click();
    await expect.element(page.getByText("待处理任务 10", { exact: true })).toBeVisible();

    await page.getByRole("button", { name: "管理", exact: true }).click();
    await expect.element(page.getByTestId("leader-conn-pairing-conn-pairing")).toHaveTextContent("待认领");
    await expect.element(page.getByTestId("leader-bound-offline-feishu")).toBeVisible();
    expect(
      page.getByTestId("leader-avatar-editor-preview-plate").element().getAttribute("data-light-contrast"),
    ).toBe("true");
    expect(
      page.getByTestId("leader-avatar-editor-preview").element().getAttribute("data-avatar-light-body"),
    ).toBe("true");

    await page.getByRole("button", { name: "复制脱敏诊断", exact: true }).click();
    await expect.element(page.getByTestId("leader-diagnostics-fallback")).toHaveValue('{"diag":"redacted"}');

    await vi.waitFor(() => {
      expect(page.getByTestId("dup-cat-a").element().querySelector("svg")).not.toBeNull();
      expect(page.getByTestId("dup-cat-b").element().querySelector("svg")).not.toBeNull();
    });
    const ids = Array.from(document.querySelectorAll("svg [id]")).map((el) => el.id);
    expect(ids.length).toBeGreaterThan(0);
    expect(new Set(ids).size).toBe(ids.length);
  } finally {
    Object.defineProperty(navigator, "clipboard", { value: originalClipboard, configurable: true });
  }
});

it("patches only edited imPolicy sub-fields, expands truncated short paused messages in narrow panes, and preserves new quick-create drafts against late POST responses", async () => {
  stubDesktopBridge();
  const updatePayloads: Record<string, unknown>[] = [];
  let currentOverview: LeaderOverview = {
    ...structuredClone(sampleOverview),
    pausedPending: [
      {
        id: "msg-short-29",
        connectionId: "conn-feishu",
        platform: "feishu",
        chatId: "chat-ops",
        chatKind: "group",
        chatName: "研发群",
        senderName: "Bob",
        body: "请确认今天下午三点半版本发布前数据库迁移和回滚预案是否已经就绪",
        createdAt: Date.now(),
      },
    ],
  };

  let releaseFirstCreate!: () => void;
  const firstCreateGate = new Promise<void>((resolve) => {
    releaseFirstCreate = resolve;
  });
  let createCalls = 0;

  vi.stubGlobal(
    "fetch",
    vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
      const url = typeof input === "string" ? input : input instanceof URL ? input.toString() : input.url;
      const path = url.replace(/^.*\/api\/xtwork\/im\//, "").split("?")[0] ?? "";
      const body = typeof init?.body === "string" ? (JSON.parse(init.body) as Record<string, unknown>) : undefined;
      const json = (data: unknown) =>
        new Response(JSON.stringify(data), { status: 200, headers: { "Content-Type": "application/json" } });
      if (path === "leaders" && init?.method === "POST") {
        createCalls += 1;
        if (createCalls === 1) {
          await firstCreateGate;
        }
        return json({ leader: secondLeaderItem.leader });
      }
      if (path === "leaders") return json({ leaders: [sampleLeaderItem] });
      if (path === "leaders/leader-default/overview") return json(currentOverview);
      if (path === "leaders/leader-default/update") {
        updatePayloads.push(body ?? {});
        return json({ leader: currentOverview.leader });
      }
      if (path === "leaders/leader-eng/open-thread") {
        return json({ threadId: "xtwork-leader-leader-eng-xyz789" });
      }
      return json({});
    }),
  );

  await page.viewport(1200, 800);
  await using _screen = await render(
    <div className="flex gap-4">
      <div style={{ width: 256 }}>
        <LeaderSidebarSlot onOpenThread={() => undefined} />
      </div>
      <div style={{ width: 320 }} className="flex h-[700px] flex-col" data-chat-column>
        <LeaderSupervisoryBar
          threadId="xtwork-leader-leader-default-abc123"
          environmentId={"local" as EnvironmentId}
          rightPanelOpen
          renderHeader={(header) => <header className="flex h-12 shrink-0 items-center px-3">{header}</header>}
        />
      </div>
    </div>,
    { router: "/local/xtwork-leader-leader-default-abc123" },
  );

  await page.getByRole("button", { name: /Needs You/ }).click();
  await expect.element(page.getByTestId("paused-message-toggle-msg-short-29")).toBeVisible();
  await page.getByTestId("paused-message-toggle-msg-short-29").click();
  expect(page.getByTestId("paused-message-body-msg-short-29").element().className).toContain("whitespace-pre-wrap");

  await page.getByRole("button", { name: "管理", exact: true }).click();
  await page.getByTestId("im-policy-owner-dm-report").selectOptions("phase_summary");
  await page.getByRole("button", { name: "保存设置", exact: true }).click();

  await vi.waitFor(() => {
    expect(updatePayloads).toHaveLength(1);
    expect(updatePayloads[0]).toEqual({
      imPolicy: {
        ownerDm: {
          progressReportMode: "phase_summary",
        },
      },
    });
  });

  await page.getByTestId("leader-create-trigger").click();
  await page.getByTestId("leader-create-name").fill("第一份草稿");
  await page.getByRole("button", { name: "创建", exact: true }).click();
  await page.getByRole("button", { name: "取消", exact: true }).click();
  await page.getByTestId("leader-create-trigger").click();
  await page.getByTestId("leader-create-name").fill("第二份草稿");
  releaseFirstCreate();
  await new Promise((resolve) => setTimeout(resolve, 150));
  await expect.element(page.getByTestId("leader-create-form")).toBeVisible();
  expect((page.getByTestId("leader-create-name").element() as HTMLInputElement).value).toBe("第二份草稿");
});

it("keeps Navigator Manage button and right-panel tabs clear of Windows MyGo native controls and fixed titlebar controls without WCO", async () => {
  stubDesktopBridge();
  vi.stubGlobal(
    "fetch",
    vi.fn(async (input: RequestInfo | URL) => {
      const url = typeof input === "string" ? input : input instanceof URL ? input.toString() : input.url;
      const path = url.replace(/^.*\/api\/xtwork\/im\//, "").split("?")[0] ?? "";
      const json = (data: unknown) =>
        new Response(JSON.stringify(data), { status: 200, headers: { "Content-Type": "application/json" } });
      if (path === "leaders") return json({ leaders: [sampleLeaderItem] });
      if (path === "leaders/leader-default/overview") return json(sampleOverview);
      return json({});
    }),
  );

  const root = document.documentElement;
  root.classList.remove("wco", "dark");
  applyThemePalette("grove", "light");
  root.style.setProperty("--mygo-titlebar-inset-right", "138px");
  try {
    await page.viewport(1280, 800);
    await using _screen = await render(
      <div data-slot="sidebar-wrapper" data-sidebar-state="expanded" className="flex h-dvh w-full">
        <div data-app-sidebar="" data-slot="sidebar-container" className="w-[240px] shrink-0" />
        <main data-slot="sidebar-inset" className="relative flex min-w-0 flex-1 flex-col bg-background">
          <div
            data-testid="fixed-titlebar-controls"
            data-workspace-titlebar-controls=""
            className="fixed top-[var(--workspace-controls-top)] right-[var(--workspace-controls-right)] z-30 flex h-[var(--workspace-topbar-height)] w-24 items-center justify-end"
          />
          <div className="flex min-h-0 flex-1 flex-col" data-chat-column>
            <LeaderSupervisoryBar
              threadId="xtwork-leader-leader-default-abc123"
              environmentId={EnvironmentId.make("local")}
              rightPanelOpen={false}
              renderHeader={(header) => (
                <header
                  data-chat-header=""
                  className="drag-region relative flex h-[var(--workspace-topbar-height)] min-h-[var(--workspace-topbar-height)] shrink-0 items-center bg-transparent pl-3 sm:pl-5 pr-[calc(0.75rem+var(--mygo-titlebar-inset-right,0px))] sm:pr-[calc(1.25rem+var(--mygo-titlebar-inset-right,0px))] wco:pr-(--workspace-native-controls-inset)"
                >
                  {header}
                </header>
              )}
            />
            <div
              data-testid="mygo-right-panel-tabbar"
              className="drag-region flex h-[var(--workspace-topbar-height)] min-h-[var(--workspace-topbar-height)] shrink-0 items-center gap-1 pl-2 pr-[calc(7rem+var(--mygo-titlebar-inset-right,0px))] wco:pr-(--workspace-native-controls-inset)"
            >
              <div data-testid="mygo-right-panel-tab-end" className="ml-auto h-6 w-20" />
            </div>
          </div>
        </main>
      </div>,
      { router: "/local/xtwork-leader-leader-default-abc123" },
    );

    await expect.element(page.getByTestId("leader-supervisory-bar")).toBeVisible();
    const manageButton = page.getByRole("button", { name: "管理", exact: true }).element() as HTMLElement;
    const fixedControls = page.getByTestId("fixed-titlebar-controls").element() as HTMLElement;
    const manageRect = manageButton.getBoundingClientRect();
    const fixedRect = fixedControls.getBoundingClientRect();
    const captionLeftEdge = 1280 - 138;

    expect(fixedRect.right).toBeLessThanOrEqual(captionLeftEdge);
    expect(manageRect.right).toBeLessThanOrEqual(captionLeftEdge);
    expect(manageRect.right).toBeLessThanOrEqual(fixedRect.left);

    const hitTarget = document.elementFromPoint(
      manageRect.left + manageRect.width / 2,
      manageRect.top + manageRect.height / 2,
    );
    expect(hitTarget && manageButton.contains(hitTarget)).toBe(true);
    await page.getByRole("button", { name: "管理", exact: true }).click();
    await expect.element(page.getByTestId("leader-config-panel")).toBeVisible();

    const tabEndRect = page.getByTestId("mygo-right-panel-tab-end").element().getBoundingClientRect();
    expect(tabEndRect.right).toBeLessThanOrEqual(captionLeftEdge);
    expect(tabEndRect.right).toBeLessThanOrEqual(fixedRect.left + 1);
  } finally {
    root.style.removeProperty("--mygo-titlebar-inset-right");
    applyThemePalette("system", "light");
  }
});

it("keeps AppRouteModal and its Close button below the 52px Windows MyGo native titlebar at 768x500 and 1200x800", async () => {
  const root = document.documentElement;
  root.classList.remove("wco");
  root.style.setProperty("--mygo-titlebar-height", "52px");
  root.style.setProperty("--mygo-titlebar-controls-bottom", "52px");
  try {
    for (const [width, height] of [
      [768, 500],
      [1200, 800],
    ] as const) {
      await page.viewport(width, height);
      await using _screen = await render(
        <AppRouteModal label="Settings" onClose={() => {}}>
          <div className="flex h-12 items-center justify-end px-4">
            <AppRouteModalClose />
          </div>
        </AppRouteModal>,
        { router: "/" },
      );

      const modal = document.querySelector("[data-app-modal]") as HTMLElement;
      expect(modal).not.toBeNull();
      const closeButton = page.getByRole("button", { name: "Close" }).element() as HTMLElement;
      const modalRect = modal.getBoundingClientRect();
      const closeRect = closeButton.getBoundingClientRect();
      expect(modalRect.top, `${width}x${height} modal top`).toBeGreaterThanOrEqual(51.5);
      expect(closeRect.top, `${width}x${height} close button top`).toBeGreaterThanOrEqual(51.5);
      expect(closeRect.bottom).toBeGreaterThan(closeRect.top);
    }
  } finally {
    root.style.removeProperty("--mygo-titlebar-height");
    root.style.removeProperty("--mygo-titlebar-controls-bottom");
  }
});
