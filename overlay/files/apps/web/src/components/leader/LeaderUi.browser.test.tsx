import "~/index.css";
import { afterEach, expect, it, vi } from "vite-plus/test";
import { page } from "vite-plus/test/browser";
import type { EnvironmentId } from "@t3tools/contracts";
import { render } from "../../../test/render";
import { LeaderSidebarSlot } from "./LeaderSidebarSlot";
import { LeaderSupervisoryBar } from "./LeaderSupervisoryBar";
import type { LeaderListItem, LeaderOverview } from "./leaderTypes";

vi.mock("../../environments/primary/desktopAuth", () => ({
  readDesktopPrimaryBearerToken: async () => "test-bearer",
}));

vi.mock("../../state/environments", () => ({
  usePrimaryEnvironmentId: () => "local" as EnvironmentId,
}));

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
    role: "你的个人与团队主管",
    status: "active",
    pinnedThreadId: "xtwork-leader-leader-default-abc123",
    awarenessScope: { kind: "all_local", projectIds: [] },
    ownerDmDesktopGrants: [],
    createdAt: 1,
    updatedAt: 1,
  },
  bindings: [],
  connections: [{ id: "conn-feishu", platform: "feishu", state: "connected" }],
  needsYouCount: 2,
  runningCount: 1,
  pendingApprovalCount: 1,
  pausedPendingCount: 1,
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

it("renders the fixed LeaderSidebarSlot with Needs You badge and opens the Leader thread on click", async () => {
  stubDesktopBridge();
  const opened: Array<{ envId: string; threadId: string }> = [];
  vi.stubGlobal(
    "fetch",
    vi.fn(async (input: RequestInfo | URL) => {
      const url = typeof input === "string" ? input : input instanceof URL ? input.toString() : input.url;
      const json = (data: unknown) =>
        new Response(JSON.stringify(data), { status: 200, headers: { "Content-Type": "application/json" } });
      if (url.endsWith("/api/xtwork/im/leaders")) {
        return json({ leaders: [sampleLeaderItem] });
      }
      if (url.endsWith("/api/xtwork/im/leaders/leader-default/open-thread")) {
        return json({ threadId: "xtwork-leader-leader-default-abc123" });
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
  await expect.element(page.getByTestId("leader-slot-leader-default")).toBeVisible();
  await expect.element(page.getByTestId("leader-needs-you-badge-leader-default")).toHaveTextContent("2");

  await page.getByTestId("leader-slot-leader-default").click();
  await vi.waitFor(() => {
    expect(opened).toEqual([{ envId: "local", threadId: "xtwork-leader-leader-default-abc123" }]);
  });
});

it("renders LeaderSupervisoryBar Needs You approvals with snapshot verification, paused backlog, and Leader config", async () => {
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

      if (path === "leaders") return json({ leaders: [sampleLeaderItem] });
      if (path === "leaders/leader-default/overview") return json(currentOverview);
      if (path === "approvals/decide") {
        currentOverview = { ...currentOverview, approvals: [] };
        return json({ decided: true });
      }
      if (path === "leaders/leader-default/paused-decide") {
        // First click tests S13 (skipped while connection paused -> accurate non-success notice);
        // second click succeeds and clears backlog.
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
          leader: { ...currentOverview.leader, name: String(body?.name ?? currentOverview.leader.name) },
        };
        return json({ leader: currentOverview.leader });
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
  // 1 approval + 1 pausedPending + 0 nonApprovalNeedsYou = 2 (no double counting!)
  await expect.element(page.getByRole("button", { name: /Needs You \(2\)/ })).toBeVisible();

  // S9: Open Needs You queue, verify exact destination chat + FULL non-truncated snapshot tail before approving
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

  // S13: First replay click returns skippedIds (connection paused) -> MUST report skipped status, NOT redelivered!
  await page.getByRole("button", { name: "重投", exact: true }).click();
  await expect
    .element(page.getByRole("status"))
    .toHaveTextContent("当前连接或 Leader 处于暂停/未激活状态，消息仍保留在暂停积压队列中。");

  // Second replay click succeeds -> reports redelivered and clears backlog!
  await page.getByRole("button", { name: "重投", exact: true }).click();
  await expect.element(page.getByRole("status")).toHaveTextContent("已按原幂等键重新投递。");
  await vi.waitFor(() => {
    expect(
      calls.some(
        (c) =>
          c.path === "leaders/leader-default/paused-decide" &&
          c.body?.decision === "replay" &&
          Array.isArray(c.body?.messageIds) &&
          (c.body.messageIds as string[]).includes("msg-paused-1"),
      ),
    ).toBe(true);
  });

  // Jump to scoped task thread
  await page.getByRole("button", { name: /研发群发布检查/ }).click();
  expect(jumped).toEqual(["xtwork-im-group-ops"]);

  // S11: Open Mingle-inspired Leader config panel on a project-scoped Leader -> unrelated role edit MUST NOT expand awarenessScope!
  await page.getByRole("button", { name: "管理", exact: true }).click();
  await expect.element(page.getByTestId("leader-config-panel")).toBeVisible();
  await expect.element(page.getByTestId("leader-project-scope-picker")).toBeVisible();
  await expect.element(page.getByText("所有已连接聊天都会使用这份角色介绍；私人背景请写入私有记忆")).toBeVisible();
  await page.getByRole("button", { name: "编程搭档", exact: true }).click();
  await page.getByRole("button", { name: "保存设置", exact: true }).click();
  await vi.waitFor(() => {
    const updateCall = calls.find((c) => c.path === "leaders/leader-default/update");
    expect(updateCall).toBeDefined();
    expect(updateCall?.body?.awarenessScope).toBeUndefined();
  });

  // S11: Explicitly adding Beta Service project updates awarenessScope with both projects
  await page.getByRole("button", { name: "管理", exact: true }).click();
  await page.getByLabelText("Beta Service").click();
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
  });
});
