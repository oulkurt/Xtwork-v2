import "~/index.css";
import { afterEach, expect, it, vi } from "vite-plus/test";
import { page } from "vite-plus/test/browser";
import type { EnvironmentId } from "@t3tools/contracts";
import { render } from "../../../test/render";
import { LeaderSidebarSlot } from "./LeaderSidebarSlot";
import { LeaderSupervisoryBar } from "./LeaderSupervisoryBar";
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

vi.mock("../../state/entities", () => ({
  useProjects: () => [],
}));

afterEach(() => {
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
    role: "你的个人与团队领航者",
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
    name: "研发领航者",
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
  await expect.element(page.getByTestId("sidebar-navigators-heading")).toHaveTextContent("领航者");
  await expect.element(page.getByTestId("leader-slot-leader-default")).toBeVisible();
  await expect.element(page.getByTestId("leader-needs-you-badge-leader-default")).toHaveTextContent("2");

  await page.getByTestId("leader-slot-leader-default").click();
  await vi.waitFor(() => {
    expect(opened).toEqual([{ envId: "local", threadId: "xtwork-leader-leader-default-abc123" }]);
  });

  await page.getByTestId("leader-create-trigger").click();
  await expect.element(page.getByTestId("leader-create-form")).toBeVisible();
  await page.getByTestId("leader-create-name").fill("研发领航者");
  await page.getByTestId("leader-create-avatar").fill("研");
  await page.getByRole("button", { name: "创建", exact: true }).click();

  await vi.waitFor(() => {
    expect(createdPayloads).toHaveLength(1);
    expect(createdPayloads[0]).toMatchObject({ name: "研发领航者", avatar: "研" });
    expect(opened).toContainEqual({ envId: "local", threadId: "xtwork-leader-leader-eng-xyz789" });
  });
  await expect.element(page.getByTestId("leader-slot-leader-eng")).toBeVisible();
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
        currentOverview = {
          ...currentOverview,
          leader: {
            ...currentOverview.leader,
            name: String(body?.name ?? currentOverview.leader.name),
            ...(body?.imPolicy ? { imPolicy: body.imPolicy as LeaderOverview["leader"]["imPolicy"] } : {}),
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
    .toHaveTextContent("当前连接或领航者处于暂停/未激活状态，消息仍保留在暂停积压队列中。");

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
        progressReportMode: "completion_and_blocked",
        allowedProjectIds: ["proj-alpha"],
      },
      group: {
        delegationMode: "always_ask",
        progressReportMode: "silent",
        allowedProjectIds: [],
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
  let resolveHeldLookup: ((value: Response) => void) | null = null;
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
  resolveHeldLookup?.(
    new Response(JSON.stringify({ leaders: [sampleLeaderItem] }), {
      status: 200,
      headers: { "Content-Type": "application/json" },
    }),
  );
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
    .toHaveTextContent("已归档领航者并保存换绑至默认领航者，远程桥接同步待重试确认。");
  await page.getByRole("button", { name: "管理", exact: true }).click();
  await expect.element(page.getByTestId("leader-conn-sync-pending-conn-wecom")).toHaveTextContent("同步中…");
});
