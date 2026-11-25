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

const sampleOverview: LeaderOverview = {
  leader: sampleLeaderItem.leader,
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
      contentPreview: "Q4 roadmap: launch Leader Slice 1",
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
        currentOverview = { ...currentOverview, pausedPending: [] };
        return json({ updated: 1 });
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
    />,
    { router: "/local/xtwork-leader-leader-default-abc123" },
  );

  await expect.element(page.getByTestId("leader-supervisory-bar")).toBeVisible();
  // 1 approval + 1 pausedPending + 0 nonApprovalNeedsYou = 2 (no double counting!)
  await expect.element(page.getByRole("button", { name: /Needs You \(2\)/ })).toBeVisible();

  // Open Needs You queue and approve snapshot-bound share
  await page.getByRole("button", { name: /Needs You \(2\)/ }).click();
  await expect.element(page.getByTestId("leader-needs-you-panel")).toBeVisible();
  await expect.element(page.getByText("Q4 roadmap: launch Leader Slice 1")).toBeVisible();
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

  // Replay paused backlog item
  await page.getByRole("button", { name: "重投", exact: true }).click();
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

  // Open Mingle-inspired Leader config panel, pick a role template, and save
  await page.getByRole("button", { name: "管理", exact: true }).click();
  await expect.element(page.getByTestId("leader-config-panel")).toBeVisible();
  await expect.element(page.getByText("所有已连接聊天都会使用这份角色介绍；私人背景请写入私有记忆")).toBeVisible();
  await page.getByRole("button", { name: "编程搭档", exact: true }).click();
  await page.getByRole("button", { name: "保存设置", exact: true }).click();
  await vi.waitFor(() => {
    expect(calls.some((c) => c.path === "leaders/leader-default/update")).toBe(true);
  });
});
