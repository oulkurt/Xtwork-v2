import "~/index.css";
import { EnvironmentId, ProviderDriverKind, ProviderInstanceId, type ServerProvider } from "@t3tools/contracts";
import { afterEach, expect, it, vi } from "vite-plus/test";
import { page } from "vite-plus/test/browser";
import { render } from "../../../test/render";
import { ProviderStatusBanner } from "../chat/ProviderStatusBanner";
import { isXtworkZeroChannelStatus } from "../chat/XtworkZeroChannelBanner";
import { SidebarProvider } from "../ui/sidebar";
import { SettingsSidebarNav } from "./SettingsSidebarNav";
import {
  XtworkModelChannelsSettings,
  type ModelChannelsStateView,
  type ProviderCapabilitySpecView,
  type RedactedChannelView,
} from "./XtworkModelChannelsSettings";

vi.mock("../../environments/primary/desktopAuth", () => ({
  readDesktopPrimaryBearerToken: async () => "test-desktop-bearer",
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

const SAMPLE_CATALOG: ProviderCapabilitySpecView[] = [
  {
    type: "company-team",
    labelZh: "小瞳 Work 团队模型",
    labelEn: "XiaoTong Team",
    category: "company",
    selectable: false,
    api: "openai-completions",
    defaultBaseUrl: "https://llm-api.sci-it.com/v1",
    urlMode: "base",
    authMode: "bearer-only",
    requiresCodingPlanUserAgent: false,
    supportsFetchModels: true,
    supportsPlanQuota: false,
    verificationTier: "v2-verified",
    verificationNote: "Company gateway",
    presetModels: [{ id: "deepseek-flash", name: "DeepSeek Flash", enabled: true }],
  },
  {
    type: "anthropic",
    labelZh: "Anthropic (Claude)",
    labelEn: "Anthropic",
    category: "api",
    selectable: true,
    api: "anthropic-messages",
    defaultBaseUrl: "https://api.anthropic.com",
    urlMode: "base",
    authMode: "x-api-key",
    requiresCodingPlanUserAgent: false,
    supportsFetchModels: true,
    supportsPlanQuota: false,
    verificationTier: "electron-verified",
    verificationNote: "Native Anthropic messages",
    presetModels: [{ id: "claude-sonnet-4-6", name: "Claude Sonnet 4.6", enabled: true }],
  },
  {
    type: "deepseek",
    labelZh: "DeepSeek",
    labelEn: "DeepSeek",
    category: "api",
    selectable: true,
    api: "anthropic-messages",
    defaultBaseUrl: "https://api.deepseek.com/anthropic",
    urlMode: "base",
    authMode: "bearer-only",
    requiresCodingPlanUserAgent: false,
    supportsFetchModels: true,
    supportsPlanQuota: true,
    verificationTier: "electron-verified",
    verificationNote: "DeepSeek Anthropic endpoint",
    presetModels: [{ id: "deepseek-chat", name: "DeepSeek Chat", enabled: true }],
  },
  {
    type: "github-copilot",
    labelZh: "GitHub Copilot 订阅",
    labelEn: "GitHub Copilot",
    category: "oauth",
    selectable: true,
    api: "openai-completions",
    defaultBaseUrl: "",
    urlMode: "oauth-managed",
    authMode: "oauth-copilot",
    requiresCodingPlanUserAgent: false,
    supportsFetchModels: true,
    supportsPlanQuota: true,
    oauthProvider: "github-copilot",
    verificationTier: "pi-1.5.2-static",
    verificationNote: "Copilot OAuth device code",
    presetModels: [{ id: "gpt-5.4", name: "GPT-5.4", enabled: true }],
  },
  {
    type: "openai-codex",
    labelZh: "ChatGPT Subscription (Codex)",
    labelEn: "OpenAI Codex",
    category: "oauth",
    selectable: true,
    api: "openai-codex-responses",
    defaultBaseUrl: "https://chatgpt.com/backend-api",
    urlMode: "oauth-managed",
    authMode: "oauth-codex",
    requiresCodingPlanUserAgent: false,
    supportsFetchModels: false,
    supportsPlanQuota: true,
    oauthProvider: "openai-codex",
    verificationTier: "pi-1.5.2-static",
    verificationNote: "Codex OAuth PKCE",
    presetModels: [{ id: "gpt-5.4", name: "GPT-5.4", enabled: true }],
  },
  {
    type: "xai",
    labelZh: "xAI Subscription (Grok)",
    labelEn: "xAI Grok",
    category: "oauth",
    selectable: true,
    api: "openai-completions",
    defaultBaseUrl: "https://api.x.ai/v1",
    urlMode: "oauth-managed",
    authMode: "oauth-xai",
    requiresCodingPlanUserAgent: false,
    supportsFetchModels: false,
    supportsPlanQuota: false,
    oauthProvider: "xai",
    verificationTier: "pi-1.5.2-static",
    verificationNote: "xAI OAuth device code",
    presetModels: [{ id: "grok-4", name: "Grok 4", enabled: true }],
  },
];

function stubDesktopBridge() {
  const openExternal = vi.fn(async () => undefined);
  const revealWindow = vi.fn(async () => undefined);
  vi.stubGlobal("desktopBridge", {
    xtwork: true,
    openExternal,
    revealWindow,
    getLocalEnvironmentEnabled: () => true,
    getLocalEnvironmentBootstraps: () => [],
  });
  return { openExternal, revealWindow };
}

function makeBaseState(overrides: Partial<ModelChannelsStateView> = {}): ModelChannelsStateView {
  return {
    catalogVersion: "pi-1.5.2-v1",
    catalog: SAMPLE_CATALOG,
    channels: [],
    companyAuth: { revision: 1, phase: "signed-out" },
    oauthSessions: [],
    defaultModelSlug: null,
    zeroChannelState: true,
    enabledModelCount: 0,
    ...overrides,
  };
}

it("shows Model channels in the settings sidebar in ordinary mode and navigates to /settings/channels", async () => {
  stubDesktopBridge();
  await page.viewport(1280, 900);
  await using screen = await render(
    <SidebarProvider defaultOpen>
      <SettingsSidebarNav pathname="/settings/general" />
    </SidebarProvider>,
    { router: "/settings/general" },
  );

  const channelsButton = page.getByRole("button", { name: "Model channels", exact: true });
  await expect.element(channelsButton).toBeVisible();
  await channelsButton.click();
  await vi.waitFor(() => {
    expect(screen.router?.state.location.pathname).toBe("/settings/channels");
  });
});

it("handles Company WeCom login, port-49160 conflict guidance, team channel lock, and honest logout dialog", async () => {
  const { openExternal, revealWindow } = stubDesktopBridge();
  let state = makeBaseState();
  let loginAttempts = 0;
  let statePollsAfterWaiting = 0;

  vi.stubGlobal(
    "fetch",
    vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
      const url = typeof input === "string" ? input : input instanceof URL ? input.toString() : input.url;
      const path = new URL(url, "http://localhost").pathname.replace(/^\/api\/xtwork\/channels\//, "");
      const json = (data: unknown, status = 200) =>
        new Response(JSON.stringify(data), {
          status,
          headers: { "Content-Type": "application/json" },
        });

      if (path === "state") {
        if (state.companyAuth.phase === "waiting") {
          statePollsAfterWaiting += 1;
          if (statePollsAfterWaiting >= 1) {
            state = makeBaseState({
              companyAuth: {
                revision: 3,
                phase: "signed-in",
                member: { subject: "s1", name: "张小明", userId: 12, username: "zhangxm" },
              },
              channels: [
                {
                  id: "xiaotong-work-team",
                  name: "小瞳 Work 团队模型",
                  provider: "company-team",
                  baseUrl: "https://llm-api.sci-it.com/v1",
                  enabled: true,
                  models: [
                    { id: "deepseek-flash", name: "DeepSeek Flash", enabled: true },
                    { id: "claude-sonnet-4-6", name: "claude-sonnet-4-6", enabled: false },
                  ],
                  hasCredentials: true,
                  isTeamChannel: true,
                  immutableFields: ["name", "provider", "baseUrl", "apiKey", "delete"],
                  createdAt: 1,
                  updatedAt: 1,
                },
              ],
              defaultModelSlug: "xiaotong-work-team/deepseek-flash",
              zeroChannelState: false,
              enabledModelCount: 1,
            });
          }
        }
        return json(state);
      }

      if (path === "company/login") {
        loginAttempts += 1;
        if (loginAttempts === 1) {
          return json(
            {
              error: "端口 49160 已被占用，请关闭占用程序后重试。",
              code: "CALLBACK_PORT_IN_USE",
            },
            409,
          );
        }
        state = {
          ...state,
          companyAuth: {
            revision: 2,
            phase: "waiting",
            authUrl: "https://llm-api.sci-it.com/keycloak/realms/sci-it/protocol/openid-connect/auth?state=s",
          },
        };
        return json({ state: state.companyAuth, authUrl: state.companyAuth.authUrl });
      }

      if (path === "company/logout" && init?.method === "POST") {
        state = makeBaseState();
        return json({ loggedOut: true, state });
      }

      return json(state);
    }),
  );

  await page.viewport(1280, 900);
  await using _screen = await render(<XtworkModelChannelsSettings />, {
    router: "/settings/channels",
  });

  // Zero-channel onboarding card is visible initially
  await expect.element(page.getByTestId("zero-channel-onboarding-card")).toBeVisible();

  // First click hits port 49160 conflict -> actionable guidance displayed
  await page.getByRole("button", { name: "企业微信扫码登录" }).first().click();
  await expect.element(page.getByTestId("company-auth-error")).toBeVisible();
  await expect.element(page.getByText("端口 49160 已被占用，请关闭占用程序后重试。")).toBeVisible();
  await expect.element(page.getByText(/关闭旧版 Electron 小瞳 Work/)).toBeVisible();

  // Retry succeeds -> opens external browser -> polls -> signs in -> reveals window
  await page.getByRole("button", { name: "企业微信扫码登录" }).first().click();
  await vi.waitFor(() => {
    expect(openExternal).toHaveBeenCalledTimes(1);
  });
  await expect.element(page.getByTestId("company-team-channel-card")).toBeVisible();
  await expect.element(page.getByText("张小明（zhangxm）")).toBeVisible();
  expect(revealWindow).toHaveBeenCalledTimes(1);

  // Team channel card has NO delete button
  await expect.element(page.getByRole("button", { name: "删除渠道 小瞳 Work 团队模型" })).not.toBeInTheDocument();

  // Logout opens honest confirmation dialog explaining keychain delete + refresh_token vs server sk- key
  await page.getByRole("button", { name: "退出登录" }).click();
  await expect.element(page.getByText("确认退出公司团队账号？")).toBeVisible();
  await expect.element(page.getByText(/sk- API Key/)).toBeVisible();
  await page.getByRole("button", { name: "确认退出登录" }).click();

  await expect.element(page.getByTestId("zero-channel-onboarding-card")).toBeVisible();
});

it("supports member channel CRUD (write-only key), OAuth device-code UX, and quota display", async () => {
  stubDesktopBridge();
  const createdRequests: Array<Record<string, unknown>> = [];
  let channels: RedactedChannelView[] = [];
  let state = makeBaseState();
  let oauthPollCount = 0;

  vi.stubGlobal(
    "fetch",
    vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
      const url = typeof input === "string" ? input : input instanceof URL ? input.toString() : input.url;
      const parsed = new URL(url, "http://localhost");
      const path = parsed.pathname.replace(/^\/api\/xtwork\/channels\//, "");
      const body = typeof init?.body === "string" ? (JSON.parse(init.body) as Record<string, unknown>) : {};
      const json = (data: unknown, status = 200) =>
        new Response(JSON.stringify(data), {
          status,
          headers: { "Content-Type": "application/json" },
        });

      if (path === "state") return json(state);
      if (path === "test") return json({ success: true, message: "Anthropic (Claude) 连接测试成功" });
      if (path === "create") {
        createdRequests.push(body);
        const created: RedactedChannelView = {
          id: "anthropic-1",
          name: String(body.name || "My Claude"),
          provider: String(body.provider || "anthropic"),
          baseUrl: String(body.baseUrl || "https://api.anthropic.com"),
          enabled: true,
          models: [{ id: "claude-sonnet-4-6", name: "Claude Sonnet 4.6", enabled: true }],
          hasCredentials: true,
          isTeamChannel: false,
          immutableFields: [],
          createdAt: 1,
          updatedAt: 1,
        };
        channels = [...channels, created];
        state = makeBaseState({
          channels,
          defaultModelSlug: "anthropic-1/claude-sonnet-4-6",
          zeroChannelState: false,
          enabledModelCount: 1,
        });
        return json({ channel: created, state });
      }
      if (path === "oauth/start") {
        return json({
          session: {
            sessionId: "oauth-sess-1",
            provider: "github-copilot",
            method: "device_code",
            phase: "awaiting_user",
            userCode: "COPILOT-8888",
            verificationUri: "https://github.com/login/device",
            updatedAt: Date.now(),
          },
        });
      }
      if (path === "oauth/status") {
        oauthPollCount += 1;
        if (oauthPollCount >= 1) {
          const copilotCh: RedactedChannelView = {
            id: "copilot-1",
            name: "GitHub Copilot 订阅",
            provider: "github-copilot",
            baseUrl: "",
            enabled: true,
            models: [{ id: "gpt-5.4", name: "GPT-5.4", enabled: true }],
            hasCredentials: true,
            isTeamChannel: false,
            immutableFields: [],
            accountLabel: "github.com",
            createdAt: 2,
            updatedAt: 2,
          };
          channels = [...channels.filter((c) => c.id !== "copilot-1"), copilotCh];
          state = makeBaseState({
            channels,
            defaultModelSlug: "anthropic-1/claude-sonnet-4-6",
            zeroChannelState: false,
            enabledModelCount: 2,
          });
          return json({
            session: {
              sessionId: "oauth-sess-1",
              provider: "github-copilot",
              channelId: "copilot-1",
              method: "device_code",
              phase: "succeeded",
              accountLabel: "github.com",
              availableModelCount: 5,
              updatedAt: Date.now(),
            },
          });
        }
        return json({
          session: {
            sessionId: "oauth-sess-1",
            provider: "github-copilot",
            method: "device_code",
            phase: "awaiting_user",
            userCode: "COPILOT-8888",
            verificationUri: "https://github.com/login/device",
            updatedAt: Date.now(),
          },
        });
      }
      if (path === "quota") {
        return json({
          quota: {
            supported: true,
            provider: "github-copilot",
            planName: "Copilot Pro",
            windows: [
              { type: "monthly", label: "Premium Requests", remainingPercent: 80, usedPercent: 20 },
            ],
            updatedAt: Date.now(),
          },
        });
      }
      return json(state);
    }),
  );

  await page.viewport(1280, 960);
  await using _screen = await render(<XtworkModelChannelsSettings />, {
    router: "/settings/channels",
  });

  // Create API channel
  await page.getByRole("button", { name: "添加 API 渠道" }).click();
  await page.getByLabelText("渠道名称").fill("My Claude");
  await page.getByLabelText("API Key").fill("sk-ant-write-only-test");
  await page.getByRole("button", { name: "测试连接" }).click();
  await expect.element(page.getByText("Anthropic (Claude) 连接测试成功")).toBeVisible();
  await page.getByRole("button", { name: "保存渠道" }).click();

  await expect.element(page.getByTestId("channel-card-anthropic-1")).toBeVisible();
  expect(createdRequests[0]?.apiKey).toBe("sk-ant-write-only-test");

  // Re-open Edit -> API Key input MUST be blank (write-only!)
  await page.getByRole("button", { name: "编辑渠道 My Claude" }).click();
  await expect.element(page.getByLabelText("API Key")).toHaveValue("");
  await page.getByRole("button", { name: "取消" }).click();

  // Start GitHub Copilot OAuth device-code flow
  await page.getByRole("button", { name: "GitHub Copilot 订阅" }).click();
  await page.getByRole("button", { name: "开始授权登录" }).click();
  await expect.element(page.getByTestId("oauth-user-code")).toHaveTextContent("COPILOT-8888");
  await expect.element(page.getByTestId("oauth-login-succeeded")).toBeVisible();
  await page.getByRole("button", { name: "完成" }).click();

  // Query quota on Copilot channel card -> shows progress bar and remaining %
  const copilotCard = page.getByTestId("channel-card-copilot-1");
  await expect.element(copilotCard).toBeVisible();
  await copilotCard.getByRole("button", { name: "额度" }).click();
  await expect.element(page.getByTestId("channel-quota-copilot-1")).toBeVisible();
  await expect.element(page.getByText("Copilot Pro")).toBeVisible();
  await expect.element(page.getByText(/剩余 80%/)).toBeVisible();
});

it("renders XtworkZeroChannelBanner inside ProviderStatusBanner for zero-channel xtworkPi and navigates to /settings/channels", async () => {
  stubDesktopBridge();
  const unconfiguredPi: ServerProvider = {
    instanceId: ProviderInstanceId.make("xtworkPi"),
    driver: ProviderDriverKind.make("pi"),
    displayName: "小瞳",
    enabled: true,
    installed: true,
    version: "1.5.2",
    status: "warning",
    auth: { status: "unauthenticated", type: "pi" },
    checkedAt: "2026-11-25T00:00:00.000Z",
    message: "No models configured",
    models: [
      {
        slug: "default",
        name: "Default",
        isCustom: false,
        capabilities: {},
      },
    ],
    slashCommands: [],
    skills: [],
  };

  expect(isXtworkZeroChannelStatus(unconfiguredPi)).toBe(true);

  await page.viewport(1280, 900);
  await using screen = await render(
    <ProviderStatusBanner
      environmentId={EnvironmentId.make("local")}
      status={unconfiguredPi}
      onDismiss={() => undefined}
    />,
    { router: "/" },
  );

  await expect.element(page.getByTestId("xtwork-zero-channel-banner")).toBeVisible();
  await expect.element(page.getByText("欢迎使用小瞳 — 请先配置模型渠道")).toBeVisible();
  await page.getByRole("button", { name: "前往配置模型渠道" }).click();
  await vi.waitFor(() => {
    expect(screen.router?.state.location.pathname).toBe("/settings/channels");
  });
});

it("prevents an older slow loadState response from overwriting newer settings state (#12)", async () => {
  stubDesktopBridge();
  let stateCallCount = 0;
  let releaseSlowInitialPoll!: () => void;
  const slowInitialPoll = new Promise<void>((resolve) => {
    releaseSlowInitialPoll = resolve;
  });

  const newerChannel: RedactedChannelView = {
    id: "newer-claude",
    name: "Newer Channel",
    provider: "anthropic",
    baseUrl: "https://api.anthropic.com",
    enabled: true,
    models: [{ id: "claude-sonnet-4-6", name: "Claude Sonnet 4.6", enabled: true }],
    hasCredentials: true,
    isTeamChannel: false,
    immutableFields: [],
    createdAt: 10,
    updatedAt: 10,
  };

  vi.stubGlobal(
    "fetch",
    vi.fn(async (input: RequestInfo | URL) => {
      const url = typeof input === "string" ? input : input instanceof URL ? input.toString() : input.url;
      const path = new URL(url, "http://localhost").pathname.replace(/^\/api\/xtwork\/channels\//, "");
      const json = (data: unknown) =>
        new Response(JSON.stringify(data), {
          status: 200,
          headers: { "Content-Type": "application/json" },
        });

      if (path === "state") {
        stateCallCount += 1;
        if (stateCallCount === 1) {
          // Initial load succeeds quickly in waiting phase so polling starts
          return json(
            makeBaseState({
              companyAuth: { revision: 1, phase: "waiting", authUrl: "https://llm-api.sci-it.com/auth" },
            }),
          );
        }
        if (stateCallCount === 2) {
          // Second poll (stale!) hangs until AFTER a newer mutation/state already updated the UI
          await slowInitialPoll;
          return json(
            makeBaseState({
              companyAuth: { revision: 1, phase: "waiting", authUrl: "https://llm-api.sci-it.com/auth" },
              channels: [],
              zeroChannelState: true,
              enabledModelCount: 0,
            }),
          );
        }
        return json(
          makeBaseState({
            channels: [newerChannel],
            defaultModelSlug: "newer-claude/claude-sonnet-4-6",
            zeroChannelState: false,
            enabledModelCount: 1,
          }),
        );
      }
      if (path === "create") {
        return json({
          channel: newerChannel,
          state: makeBaseState({
            channels: [newerChannel],
            defaultModelSlug: "newer-claude/claude-sonnet-4-6",
            zeroChannelState: false,
            enabledModelCount: 1,
          }),
        });
      }
      return json(makeBaseState());
    }),
  );

  await page.viewport(1280, 960);
  await using _screen = await render(<XtworkModelChannelsSettings />, {
    router: "/settings/channels",
  });

  // Wait until the slow background poll (stateCallCount === 2) is in flight
  await vi.waitFor(
    () => {
      expect(stateCallCount).toBeGreaterThanOrEqual(2);
    },
    { timeout: 3000 },
  );

  // Create a channel while slow poll #2 is in flight -> UI receives authoritative newer state
  await page.getByRole("button", { name: "添加 API 渠道" }).click();
  await page.getByLabelText("渠道名称").fill("Newer Channel");
  await page.getByLabelText("API Key").fill("sk-ant-newer-test");
  await page.getByRole("button", { name: "保存渠道" }).click();
  await expect.element(page.getByTestId("channel-card-newer-claude")).toBeVisible();

  // Now release stale poll #2 -> MUST NOT overwrite newer state or make Newer Channel disappear!
  releaseSlowInitialPoll();
  await new Promise((r) => setTimeout(r, 80));
  await expect.element(page.getByTestId("channel-card-newer-claude")).toBeVisible();
});
