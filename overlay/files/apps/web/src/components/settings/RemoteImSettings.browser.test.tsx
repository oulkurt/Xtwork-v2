import "~/index.css";
import { afterEach, expect, it, vi } from "vite-plus/test";
import { page, userEvent } from "vite-plus/test/browser";
import { render } from "../../../test/render";
import { SidebarProvider } from "../ui/sidebar";
import { RemoteImSettings } from "./RemoteImSettings";
import { SettingsSidebarNav } from "./SettingsSidebarNav";

vi.mock("../../environments/primary/desktopAuth", () => ({
  readDesktopPrimaryBearerToken: async () => "test-bearer",
}));

vi.mock("../../hooks/useDeveloperFeatures", () => ({
  useDeveloperFeatures: () => false,
  useDesktopDeveloperFeatures: () => false,
  useDeveloperFeaturesEnvironmentId: () => "local",
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

it("shows Remote connections in its own settings sidebar section without developer mode", async () => {
  stubDesktopBridge();
  await page.viewport(1280, 900);
  await using screen = await render(
    <SidebarProvider defaultOpen>
      <SettingsSidebarNav pathname="/settings/general" />
    </SidebarProvider>,
    { router: "/settings/general" },
  );

  const remoteButton = page.getByRole("button", { name: "Remote connections", exact: true });
  await expect.element(remoteButton).toBeVisible();
  await remoteButton.click();
  await vi.waitFor(() => {
    expect(screen.router?.state.location.pathname).toBe("/settings/remote-connections");
  });
});

it("flips cards to QR on general click and to manual credentials on top-right three-dots click", async () => {
  stubDesktopBridge();
  const requests: Array<{ path: string; body?: Record<string, unknown> }> = [];
  let pendingEvents: Array<{ sequence: number; event: string; payload: Record<string, unknown> }> = [];
  let seq = 0;

  vi.stubGlobal(
    "fetch",
    vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
      const url = typeof input === "string" ? input : input instanceof URL ? input.toString() : input.url;
      const path = url.replace(/^.*\/api\/xtwork\/im\//, "").split("?")[0] ?? "";
      const body = typeof init?.body === "string" ? (JSON.parse(init.body) as Record<string, unknown>) : undefined;
      requests.push(body ? { path, body } : { path });

      const json = (data: unknown) =>
        new Response(JSON.stringify(data), {
          status: 200,
          headers: { "Content-Type": "application/json" },
        });

      if (path === "status") return json({ state: "idle", lifecycle: "idle" });
      if (path === "connections") return json({ connections: [] });
      if (path === "access") return json({ held: [] });
      if (path === "approvals") return json({ approvals: [] });
      if (path === "onboarding/events") {
        const events = pendingEvents;
        pendingEvents = [];
        return json({ events });
      }
      if (path === "onboarding/start") {
        const platform = String(body?.platform ?? "feishu");
        const mode = String(body?.mode ?? "qr");
        const sessionId = `onb-${platform}-${mode}`;
        if (mode === "qr") {
          pendingEvents.push({
            sequence: ++seq,
            event: "onboarding.event",
            payload: {
              sessionId,
              platform,
              event: { kind: "qr_ready", qrContent: `https://example.com/qr/${platform}` },
            },
          });
        } else {
          pendingEvents.push({
            sequence: ++seq,
            event: "onboarding.event",
            payload: {
              sessionId,
              platform,
              event: { kind: "succeeded", lifecycleState: "pairing", claimCode: "654321" },
            },
          });
        }
        return json({ sessionId, platform });
      }
      if (path === "onboarding/cancel") return json({ cancelled: true });
      return json({});
    }),
  );

  await page.viewport(1280, 960);
  await using _screen = await render(<RemoteImSettings />, {
    router: "/settings/remote-connections",
  });

  // All 3 cards render with the exact single description sentence.
  const descriptions = page.getByText("点击翻转扫描二维码即刻连接你的聊天软件", { exact: true });
  await expect.element(descriptions.nth(0)).toBeVisible();
  await expect.element(descriptions.nth(1)).toBeVisible();
  await expect.element(descriptions.nth(2)).toBeVisible();

  const feishuCard = page.getByTestId("holo-card-feishu");
  const wecomCard = page.getByTestId("holo-card-wecom");
  const wechatCard = page.getByTestId("holo-card-wechat");

  // Top-right three-dots exist on Feishu and WeCom, not on WeChat (iLink is QR-only).
  await expect.element(page.getByRole("button", { name: "手动填入飞书凭据" })).toBeVisible();
  await expect.element(page.getByRole("button", { name: "手动填入企业微信凭据" })).toBeVisible();
  await expect.element(page.getByRole("button", { name: "手动填入微信凭据" })).not.toBeInTheDocument();

  // Wait for status polling to mark bridge available.
  await expect.element(page.getByText("选择下方卡片接入你的聊天软件")).toBeVisible();

  // 1. Clicking anywhere on the Feishu card body flips to QR and starts QR onboarding.
  // Use { force: true } because the holo card continuously sways in 3D via RAF.
  await feishuCard.getByRole("heading", { name: "飞书" }).click({ force: true });
  await expect.element(feishuCard).toHaveAttribute("data-flipped", "true");
  await expect.element(page.getByRole("img", { name: "飞书连接二维码" })).toBeVisible();
  expect(requests.some((r) => r.path === "onboarding/start" && r.body?.platform === "feishu" && r.body?.mode === "qr")).toBe(true);

  // Clicking 返回 waits for the 3D flip to settle on the stationary back face, then flips back.
  await feishuCard.getByRole("button", { name: "返回" }).click();
  await expect.element(feishuCard).toHaveAttribute("data-flipped", "false");
  await vi.waitFor(() => {
    expect(requests.some((r) => r.path === "onboarding/cancel" && r.body?.sessionId === "onb-feishu-qr")).toBe(true);
  });

  // 2. Clicking top-right three-dots on WeCom flips directly to manual credentials WITHOUT QR start.
  await page.getByRole("button", { name: "手动填入企业微信凭据" }).click({ force: true });
  await expect.element(wecomCard).toHaveAttribute("data-flipped", "true");
  expect(requests.some((r) => r.path === "onboarding/start" && r.body?.platform === "wecom")).toBe(false);

  await wecomCard.getByPlaceholder("输入机器人 Bot ID").fill("bot-123");
  await wecomCard.getByPlaceholder("输入机器人 Secret").fill("sec-xyz");
  await wecomCard.getByRole("button", { name: "验证并连接" }).click();

  await expect.element(wecomCard.getByText("654321")).toBeVisible();
  expect(
    requests.some(
      (r) =>
        r.path === "onboarding/start" &&
        r.body?.platform === "wecom" &&
        r.body?.mode === "credentials" &&
        (r.body?.credentials as Record<string, string>)?.botId === "bot-123",
    ),
  ).toBe(true);

  // 3. Keyboard Enter flips WeChat to QR and Escape flips back.
  const wechatFront = wechatCard.element().querySelector<HTMLElement>(".xtwork-holo-face-front");
  expect(wechatFront).not.toBeNull();
  wechatFront!.focus();
  await userEvent.keyboard("{Enter}");
  await expect.element(wechatCard).toHaveAttribute("data-flipped", "true");
  await expect.element(page.getByRole("img", { name: "微信连接二维码" })).toBeVisible();
  await userEvent.keyboard("{Escape}");
  await expect.element(wechatCard).toHaveAttribute("data-flipped", "false");
});

it("starts QR once readiness arrives and lets manual credentials retry after a start error", async () => {
  stubDesktopBridge();
  let resolveStatus!: () => void;
  const statusGate = new Promise<void>((resolve) => {
    resolveStatus = resolve;
  });
  let seq = 0;
  let pendingEvents: Array<{ sequence: number; event: string; payload: Record<string, unknown> }> = [];
  let manualAttempts = 0;

  vi.stubGlobal(
    "fetch",
    vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
      const url = typeof input === "string" ? input : input instanceof URL ? input.toString() : input.url;
      const path = url.replace(/^.*\/api\/xtwork\/im\//, "").split("?")[0] ?? "";
      const body = typeof init?.body === "string" ? (JSON.parse(init.body) as Record<string, unknown>) : undefined;
      const json = (data: unknown, status = 200) =>
        new Response(JSON.stringify(data), {
          status,
          headers: { "Content-Type": "application/json" },
        });

      if (path === "status") {
        await statusGate;
        return json({ state: "idle", lifecycle: "idle" });
      }
      if (path === "connections") return json({ connections: [] });
      if (path === "access") return json({ held: [] });
      if (path === "approvals") return json({ approvals: [] });
      if (path === "onboarding/events") {
        const events = pendingEvents;
        pendingEvents = [];
        return json({ events });
      }
      if (path === "onboarding/start") {
        const platform = String(body?.platform ?? "feishu");
        const mode = String(body?.mode ?? "qr");
        if (mode === "credentials") {
          manualAttempts += 1;
          if (manualAttempts === 1) return json({ error: "凭据格式有误" }, 400);
          return json({ sessionId: "onb-manual-ok", platform });
        }
        const sessionId = `onb-early-${platform}`;
        pendingEvents.push({
          sequence: ++seq,
          event: "onboarding.event",
          payload: {
            sessionId,
            platform,
            event: { kind: "qr_ready", qrContent: "https://example.com/early-qr" },
          },
        });
        return json({ sessionId, platform });
      }
      return json({});
    }),
  );

  await page.viewport(1280, 960);
  await using _screen = await render(<RemoteImSettings />, {
    router: "/settings/remote-connections",
  });

  // Flip Feishu BEFORE the first status request resolves; once ready, QR must start automatically.
  const feishuCard = page.getByTestId("holo-card-feishu");
  await feishuCard.getByRole("heading", { name: "飞书" }).click({ force: true });
  await expect.element(feishuCard).toHaveAttribute("data-flipped", "true");
  resolveStatus();
  await expect.element(page.getByRole("img", { name: "飞书连接二维码" })).toBeVisible();

  // Manual start error must show the error AND leave the submit button enabled for retry.
  const wecomCard = page.getByTestId("holo-card-wecom");
  await page.getByRole("button", { name: "手动填入企业微信凭据" }).click({ force: true });
  await wecomCard.getByPlaceholder("输入机器人 Bot ID").fill("bad-id");
  await wecomCard.getByPlaceholder("输入机器人 Secret").fill("bad-secret");
  await wecomCard.getByRole("button", { name: "验证并连接" }).click();
  await expect.element(wecomCard.getByText("凭据格式有误")).toBeVisible();
  await expect.element(wecomCard.getByRole("button", { name: "验证并连接" })).toBeEnabled();
});

it("handles unbound event polls, stale manual failures, and live claim refresh/completion", async () => {
  stubDesktopBridge();
  const eventsLog: Array<{ sequence: number; event: string; payload: Record<string, unknown> }> = [];
  let seq = 0;
  let connections: Array<Record<string, unknown>> = [];

  // S7 gates: hold the 2nd events poll in flight while Feishu start is also pending.
  let eventsPollCount = 0;
  let releaseInFlightPoll!: () => void;
  const inFlightPollGate = new Promise<void>((resolve) => {
    releaseInFlightPoll = resolve;
  });
  let inFlightPollStarted!: () => void;
  const inFlightPollReady = new Promise<void>((resolve) => {
    inFlightPollStarted = resolve;
  });
  let releaseFeishuStart!: () => void;
  const feishuStartGate = new Promise<void>((resolve) => {
    releaseFeishuStart = resolve;
  });
  let feishuStartCalled!: () => void;
  const feishuStartReady = new Promise<void>((resolve) => {
    feishuStartCalled = resolve;
  });

  // S8 gate: hold WeCom's first manual attempt pending until QR replacement is shown.
  let releaseStaleManual!: () => void;
  const staleManualGate = new Promise<void>((resolve) => {
    releaseStaleManual = resolve;
  });
  let wecomManualAttempts = 0;

  // S9 stale-snapshot gate: hold one pre-refresh connections response until after claimRefresh applies.
  let delayNextConnectionsPoll = false;
  let delayedConnectionsStarted!: () => void;
  const delayedConnectionsReady = new Promise<void>((resolve) => {
    delayedConnectionsStarted = resolve;
  });
  let releaseDelayedConnections!: () => void;
  const delayedConnectionsGate = new Promise<void>((resolve) => {
    releaseDelayedConnections = resolve;
  });
  let claimRefreshCount = 0;

  vi.stubGlobal(
    "fetch",
    vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
      const url = typeof input === "string" ? input : input instanceof URL ? input.toString() : input.url;
      const parsed = new URL(url, "http://localhost");
      const path = parsed.pathname.replace(/^.*\/api\/xtwork\/im\//, "");
      const body = typeof init?.body === "string" ? (JSON.parse(init.body) as Record<string, unknown>) : undefined;
      const json = (data: unknown, status = 200) =>
        new Response(JSON.stringify(data), {
          status,
          headers: { "Content-Type": "application/json" },
        });

      if (path === "status") return json({ state: "idle", lifecycle: "idle" });
      if (path === "connections") {
        const snapshot = connections.map((item) => ({ ...item }));
        if (delayNextConnectionsPoll) {
          delayNextConnectionsPoll = false;
          delayedConnectionsStarted();
          await delayedConnectionsGate;
        }
        return json({ connections: snapshot });
      }
      if (path === "access") return json({ held: [] });
      if (path === "approvals") return json({ approvals: [] });
      if (path === "onboarding/events") {
        eventsPollCount += 1;
        const after = Number(parsed.searchParams.get("after") ?? 0);
        if (eventsPollCount === 2) {
          inFlightPollStarted();
          await inFlightPollGate;
        }
        return json({ events: eventsLog.filter((item) => item.sequence > after) });
      }
      if (path === "onboarding/start") {
        const platform = String(body?.platform ?? "feishu");
        const mode = String(body?.mode ?? "qr");
        if (platform === "feishu" && mode === "qr") {
          const sessionId = "onb-feishu-race";
          eventsLog.push({
            sequence: ++seq,
            event: "onboarding.event",
            payload: {
              sessionId,
              platform: "feishu",
              event: { kind: "qr_ready", qrContent: "https://example.com/feishu-race-qr" },
            },
          });
          feishuStartCalled();
          await feishuStartGate;
          return json({ sessionId, platform: "feishu" });
        }
        if (platform === "wecom" && mode === "credentials") {
          wecomManualAttempts += 1;
          if (wecomManualAttempts === 1) {
            await staleManualGate;
            return json({ error: "过期凭据错误" }, 400);
          }
          const sessionId = "onb-wecom-claim";
          connections = [
            {
              id: "conn-wc-1",
              platform: "wecom",
              lifecycleState: "pairing",
              state: "connected",
              claimCode: "111222",
            },
          ];
          eventsLog.push({
            sequence: ++seq,
            event: "onboarding.event",
            payload: {
              sessionId,
              platform: "wecom",
              event: {
                kind: "succeeded",
                connectionId: "conn-wc-1",
                lifecycleState: "pairing",
                claimCode: "111222",
              },
            },
          });
          return json({ sessionId, platform: "wecom" });
        }
        if (platform === "wecom" && mode === "qr") {
          const sessionId = "onb-wecom-qr";
          eventsLog.push({
            sequence: ++seq,
            event: "onboarding.event",
            payload: {
              sessionId,
              platform: "wecom",
              event: { kind: "qr_ready", qrContent: "https://example.com/wecom-qr" },
            },
          });
          return json({ sessionId, platform: "wecom" });
        }
      }
      if (path === "connections/claimRefresh") {
        claimRefreshCount += 1;
        const nextCode = claimRefreshCount === 1 ? "999888" : "777666";
        connections = connections.map((item) =>
          item.id === body?.connectionId ? { ...item, claimCode: nextCode } : item,
        );
        return json({ connectionId: body?.connectionId, claimCode: nextCode });
      }
      if (path === "onboarding/cancel") return json({ cancelled: true });
      return json({});
    }),
  );

  await page.viewport(1280, 960);
  await using _screen = await render(<RemoteImSettings />, {
    router: "/settings/remote-connections",
  });

  // S7: Wait until poll #2 is in flight, start Feishu QR, let poll #2 receive qr_ready while start is unbound,
  // then resolve start. Cursor must not have advanced early, so Feishu QR renders on the next refresh.
  await inFlightPollReady;
  const feishuCard = page.getByTestId("holo-card-feishu");
  await feishuCard.getByRole("heading", { name: "飞书" }).click({ force: true });
  await feishuStartReady;
  releaseInFlightPoll();
  await new Promise((resolve) => setTimeout(resolve, 40));
  releaseFeishuStart();
  await expect.element(page.getByRole("img", { name: "飞书连接二维码" })).toBeVisible();

  // S8: Submit manual WeCom credentials, switch to QR before manual rejects, verify QR stays visible after stale failure.
  const wecomCard = page.getByTestId("holo-card-wecom");
  await page.getByRole("button", { name: "手动填入企业微信凭据" }).click({ force: true });
  await wecomCard.getByPlaceholder("输入机器人 Bot ID").fill("stale-id");
  await wecomCard.getByPlaceholder("输入机器人 Secret").fill("stale-sec");
  await wecomCard.getByRole("button", { name: "验证并连接" }).click();
  await wecomCard.getByRole("button", { name: "扫码" }).click();
  await expect.element(page.getByRole("img", { name: "企业微信连接二维码" })).toBeVisible();
  releaseStaleManual();
  await new Promise((resolve) => setTimeout(resolve, 60));
  await expect.element(page.getByRole("img", { name: "企业微信连接二维码" })).toBeVisible();
  await expect.element(wecomCard.getByText("过期凭据错误")).not.toBeInTheDocument();

  // S9: Complete pairing via manual credentials, verify a delayed older connections snapshot
  // cannot roll back the refreshed claim code, then verify S10 null-code exhaustion + recovery + completion.
  await wecomCard.getByRole("button", { name: "凭据" }).click();
  await wecomCard.getByPlaceholder("输入机器人 Bot ID").fill("real-id");
  await wecomCard.getByPlaceholder("输入机器人 Secret").fill("real-sec");
  await wecomCard.getByRole("button", { name: "验证并连接" }).click();
  await expect.element(wecomCard.getByText("111222")).toBeVisible();

  delayNextConnectionsPoll = true;
  await delayedConnectionsReady;
  await page.getByRole("button", { name: "刷新认领码" }).click();
  await expect.element(wecomCard.getByText("999888")).toBeVisible();
  await expect.element(wecomCard.getByText("111222")).not.toBeInTheDocument();

  // Release the delayed older poll carrying "111222"; the card must stay on "999888".
  releaseDelayedConnections();
  await new Promise((resolve) => setTimeout(resolve, 60));
  await expect.element(wecomCard.getByText("999888")).toBeVisible();
  await expect.element(wecomCard.getByText("111222")).not.toBeInTheDocument();

  // S10: Exhausting attempts clears claimCode to null; card must NOT fall back to old session claim.
  connections = [
    { id: "conn-wc-1", platform: "wecom", lifecycleState: "pairing", state: "connected", claimCode: null },
  ];
  await expect.element(wecomCard.getByText("认领码已失效")).toBeVisible();
  await expect.element(wecomCard.getByText("111222")).not.toBeInTheDocument();
  await expect.element(wecomCard.getByText("999888")).not.toBeInTheDocument();
  await wecomCard.getByRole("button", { name: "刷新认领码" }).click();
  await expect.element(wecomCard.getByText("777666")).toBeVisible();

  connections = [{ id: "conn-wc-1", platform: "wecom", lifecycleState: "active", state: "connected", claimCode: null }];
  await expect.element(wecomCard.getByText("企业微信已连接")).toBeVisible();
});

it("lets users rebind an active IM connection between Navigators from RemoteImSettings", async () => {
  stubDesktopBridge();
  const rebindCalls: Array<Record<string, unknown>> = [];
  let assignedLeaderId = "leader-default";

  vi.stubGlobal(
    "fetch",
    vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
      const url = typeof input === "string" ? input : input instanceof URL ? input.toString() : input.url;
      const path = new URL(url, "http://localhost").pathname.replace(/^.*\/api\/xtwork\/im\//, "");
      const body = typeof init?.body === "string" ? (JSON.parse(init.body) as Record<string, unknown>) : undefined;
      const json = (data: unknown) =>
        new Response(JSON.stringify(data), { status: 200, headers: { "Content-Type": "application/json" } });

      if (path === "status") return json({ state: "idle", lifecycle: "idle" });
      if (path === "connections") {
        return json({
          connections: [
            { id: "conn-feishu-1", platform: "feishu", lifecycleState: "active", state: "connected", leaderId: assignedLeaderId },
          ],
        });
      }
      if (path === "leaders") {
        return json({
          leaders: [
            { leader: { id: "leader-default", name: "小瞳" } },
            { leader: { id: "leader-eng", name: "研发领航员" } },
          ],
        });
      }
      if (path === "connections/rebind") {
        rebindCalls.push(body ?? {});
        assignedLeaderId = String(body?.leaderId ?? assignedLeaderId);
        return json({ binding: { bindingId: "bind-2", leaderId: assignedLeaderId, epoch: 2 } });
      }
      if (path === "access") return json({ held: [] });
      if (path === "approvals") return json({ approvals: [] });
      if (path === "onboarding/events") return json({ events: [] });
      return json({});
    }),
  );

  await page.viewport(1280, 960);
  await using _screen = await render(<RemoteImSettings />, {
    router: "/settings/remote-connections",
  });

  await expect.element(page.getByText("可自由分配至 2 位领航员")).toBeVisible();
  const rebindSelect = page.getByTestId("connection-rebind-conn-feishu-1");
  await expect.element(rebindSelect).toBeVisible();
  await rebindSelect.selectOptions("leader-eng");

  await vi.waitFor(() => {
    expect(rebindCalls).toEqual([{ connectionId: "conn-feishu-1", leaderId: "leader-eng" }]);
  });
});

it("downgrades connected cards and rows to unconfirmed when GET status subsequently returns HTTP 503", async () => {
  stubDesktopBridge();
  let failStatus = false;

  vi.stubGlobal(
    "fetch",
    vi.fn(async (input: RequestInfo | URL) => {
      const url = typeof input === "string" ? input : input instanceof URL ? input.toString() : input.url;
      const path = new URL(url, "http://localhost").pathname.replace(/^.*\/api\/xtwork\/im\//, "");
      const json = (data: unknown, status = 200) =>
        new Response(JSON.stringify(data), { status, headers: { "Content-Type": "application/json" } });

      if (path === "status") {
        if (failStatus) return json({ error: "bridge down" }, 503);
        return json({ state: "idle", lifecycle: "idle" });
      }
      if (path === "connections") {
        return json({
          connections: [
            { id: "conn-feishu-1", platform: "feishu", lifecycleState: "active", state: "connected", botName: "飞书小瞳" },
            { id: "conn-wecom-1", platform: "wecom", lifecycleState: "active", state: "connected", botName: "企微小瞳" },
          ],
        });
      }
      if (path === "leaders") return json({ leaders: [{ leader: { id: "leader-default", name: "小瞳" } }] });
      if (path === "access") return json({ held: [] });
      if (path === "approvals") return json({ approvals: [] });
      if (path === "onboarding/events") return json({ events: [] });
      return json({});
    }),
  );

  await page.viewport(1280, 960);
  await using _screen = await render(<RemoteImSettings />, {
    router: "/settings/remote-connections",
  });

  const feishuCard = page.getByTestId("holo-card-feishu");
  const wecomCard = page.getByTestId("holo-card-wecom");
  await expect.element(feishuCard.getByText("已连接", { exact: true })).toBeVisible();
  await expect.element(wecomCard.getByText("已连接", { exact: true })).toBeVisible();

  failStatus = true;
  await vi.waitFor(
    async () => {
      expect(feishuCard.element().textContent).toContain("无法确认在线");
      expect(wecomCard.element().textContent).toContain("无法确认在线");
      expect(document.body.textContent).toContain("飞书小瞳");
      expect(document.body.textContent).toContain("桥接不可用 · 无法确认在线");
    },
    { timeout: 5000 },
  );
});

it("does not flash green connected during retry when /status returns 200 while /connections is still failing", async () => {
  stubDesktopBridge();
  let connectionsMode: "ok" | "fail" | "slow_fail" = "ok";
  let slowConnectionsStarted = false;
  let releaseSlowConnections: (() => void) | undefined;

  vi.stubGlobal(
    "fetch",
    vi.fn(async (input: RequestInfo | URL) => {
      const url = typeof input === "string" ? input : input instanceof URL ? input.toString() : input.url;
      const path = new URL(url, "http://localhost").pathname.replace(/^.*\/api\/xtwork\/im\//, "");
      const json = (data: unknown, status = 200) =>
        new Response(JSON.stringify(data), { status, headers: { "Content-Type": "application/json" } });

      if (path === "status") return json({ state: "idle", lifecycle: "idle" });
      if (path === "connections") {
        if (connectionsMode === "fail") {
          return json({ error: "connections unavailable" }, 503);
        }
        if (connectionsMode === "slow_fail") {
          slowConnectionsStarted = true;
          await new Promise<void>((resolve) => {
            releaseSlowConnections = resolve;
          });
          return json({ error: "connections still unavailable" }, 503);
        }
        return json({
          connections: [
            { id: "conn-feishu-1", platform: "feishu", lifecycleState: "active", state: "connected", botName: "飞书小瞳" },
            { id: "conn-wecom-1", platform: "wecom", lifecycleState: "active", state: "connected", botName: "企微小瞳" },
          ],
        });
      }
      if (path === "leaders") return json({ leaders: [{ leader: { id: "leader-default", name: "小瞳" } }] });
      if (path === "access") return json({ held: [] });
      if (path === "approvals") return json({ approvals: [] });
      if (path === "onboarding/events") return json({ events: [] });
      return json({});
    }),
  );

  await page.viewport(1280, 960);
  await using _screen = await render(<RemoteImSettings />, {
    router: "/settings/remote-connections",
  });

  const feishuCard = page.getByTestId("holo-card-feishu");
  const wecomCard = page.getByTestId("holo-card-wecom");
  await expect.element(feishuCard.getByText("已连接", { exact: true })).toBeVisible();
  await expect.element(wecomCard.getByText("已连接", { exact: true })).toBeVisible();

  connectionsMode = "fail";
  await vi.waitFor(
    () => {
      expect(feishuCard.element().textContent).toContain("无法确认在线");
      expect(wecomCard.element().textContent).toContain("无法确认在线");
    },
    { timeout: 5000 },
  );

  connectionsMode = "slow_fail";
  await vi.waitFor(
    () => {
      expect(slowConnectionsStarted).toBe(true);
    },
    { timeout: 5000 },
  );
  expect(feishuCard.element().textContent).toContain("无法确认在线");
  expect(wecomCard.element().textContent).toContain("无法确认在线");
  expect(feishuCard.element().textContent).not.toContain("已连接");
  expect(wecomCard.element().textContent).not.toContain("已连接");

  connectionsMode = "ok";
  releaseSlowConnections?.();
  await vi.waitFor(
    () => {
      expect(feishuCard.element().textContent).toContain("已连接");
      expect(wecomCard.element().textContent).toContain("已连接");
    },
    { timeout: 5000 },
  );
});
