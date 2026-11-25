import {
  EnvironmentId,
  ProviderDriverKind,
  ProviderInstanceId,
  type CodingAgentSetting,
  type OrchestrationV2TurnItem,
  type ProviderInstanceConfig,
  type ServerProvider,
  type ServerSettingsPatch,
} from "@t3tools/contracts";
import { describe, expect, it, vi } from "vite-plus/test";
import { page, userEvent } from "vite-plus/test/browser";

import "~/index.css";
import { render } from "../../../test/render";
import { isDesktopSettingVisible } from "../../desktopFeatureVisibility";
import {
  CODING_AGENT_AUTO_HELPER_ZH,
  CodingAgentBlockedActionCard,
  CodingAgentSettingsSection,
  ONE_TURN_BUILTIN_XIAOTONG_PROMPT_ZH,
  readCodingAgentBlockedResult,
} from "./CodingAgentSettingsSection";

const environmentId = EnvironmentId.make("local-desktop");
const claudeId = ProviderInstanceId.make("claudeAgent");
const codexId = ProviderInstanceId.make("codex");
const kimiId = ProviderInstanceId.make("xtworkKimiCode");
const qoderId = ProviderInstanceId.make("xtworkQoder");
const codebuddyId = ProviderInstanceId.make("xtworkCodebuddyCode");
const deepseekId = ProviderInstanceId.make("xtworkDeepseekHarness");
const xtworkPiId = ProviderInstanceId.make("xtworkPi");

function makeProvider(
  instanceId: ProviderInstanceId,
  driver: string,
  overrides: Partial<ServerProvider> = {},
): ServerProvider {
  return {
    instanceId,
    driver: ProviderDriverKind.make(driver),
    enabled: true,
    installed: true,
    version: "1.0.0",
    status: "ready",
    auth: { status: "authenticated" },
    checkedAt: "2026-11-25T00:00:00.000Z",
    models: [],
    slashCommands: [],
    skills: [],
    ...overrides,
  };
}

function makeFixtureProviders(): ReadonlyArray<ServerProvider> {
  return [
    makeProvider(xtworkPiId, "pi", { displayName: "小瞳" }),
    makeProvider(claudeId, "claudeAgent", {
      displayName: "Claude Code",
      models: [
        { slug: "claude-sonnet-4-6", name: "Claude Sonnet 4.6", isCustom: false, capabilities: null },
        { slug: "claude-opus-4-6", name: "Claude Opus 4.6", isCustom: false, capabilities: null },
      ],
    }),
    makeProvider(codexId, "codex", {
      displayName: "Codex",
      installed: true,
      status: "warning",
      auth: { status: "unauthenticated" },
      setup: { canAuthenticate: true, canInstall: true },
    }),
    makeProvider(kimiId, "acpRegistry", {
      displayName: "Kimi Code",
      installed: false,
      status: "warning",
    }),
    makeProvider(qoderId, "acpRegistry", {
      displayName: "Qoder",
      enabled: false,
      status: "disabled",
    }),
    makeProvider(codebuddyId, "acpRegistry", {
      displayName: "Codebuddy Code",
      installed: false,
      status: "warning",
    }),
    makeProvider(deepseekId, "acpRegistry", {
      displayName: "DeepSeek Harness",
      installed: false,
      status: "warning",
    }),
  ];
}

const fixtureInstances: Readonly<Record<string, ProviderInstanceConfig>> = {
  [xtworkPiId]: { driver: ProviderDriverKind.make("pi"), displayName: "小瞳", enabled: true },
  [claudeId]: { driver: ProviderDriverKind.make("claudeAgent"), displayName: "Claude Code", enabled: true },
  [codexId]: { driver: ProviderDriverKind.make("codex"), displayName: "Codex", enabled: true },
  [kimiId]: { driver: ProviderDriverKind.make("acpRegistry"), displayName: "Kimi Code", enabled: true },
  [qoderId]: { driver: ProviderDriverKind.make("acpRegistry"), displayName: "Qoder", enabled: false },
  [codebuddyId]: { driver: ProviderDriverKind.make("acpRegistry"), displayName: "Codebuddy Code", enabled: true },
  [deepseekId]: { driver: ProviderDriverKind.make("acpRegistry"), displayName: "DeepSeek Harness", enabled: true },
};

describe("CodingAgentSettingsSection", () => {
  it("stays visible in ordinary mode, renders exact Chinese auto copy, and lists external agents with live readiness badges", async () => {
    expect(
      isDesktopSettingVisible({ id: "coding-agent", to: "/settings/providers" }, false),
    ).toBe(true);

    const onUpdateSettings = vi.fn<(patch: ServerSettingsPatch) => void>();
    await using screen = await render(
      <CodingAgentSettingsSection
        codingAgent={{ mode: "auto" }}
        serverProviders={makeFixtureProviders()}
        providerInstances={fixtureInstances}
        developerFeatures={false}
        readOnly={false}
        canWriteSettings={true}
        onUpdateSettings={onUpdateSettings}
        locale="zh"
      />,
    );

    await expect.element(screen.getByTestId("coding-agent-settings-section")).toBeVisible();
    await expect.element(screen.getByText(CODING_AGENT_AUTO_HELPER_ZH)).toBeVisible();

    await userEvent.click(screen.getByTestId("coding-agent-select"));
    await expect.element(page.getByTestId("coding-agent-option-auto")).toBeVisible();
    await expect.element(page.getByTestId(`coding-agent-option-${claudeId}`)).toMatchTextContent(/已就绪/);
    await expect.element(page.getByTestId(`coding-agent-option-${codexId}`)).toMatchTextContent(/需登录/);
    await expect.element(page.getByTestId(`coding-agent-option-${kimiId}`)).toMatchTextContent(/未安装/);
    await expect.element(page.getByTestId(`coding-agent-option-${qoderId}`)).toMatchTextContent(/已禁用/);
    expect(page.getByTestId(`coding-agent-option-${xtworkPiId}`).query()).toBeNull();

    await userEvent.click(page.getByTestId(`coding-agent-option-${claudeId}`));
    expect(onUpdateSettings).toHaveBeenCalledWith({
      codingAgent: { mode: "provider", instanceId: claudeId },
    });
  });

  it("supports model selection, readiness warning jump-to-provider, IM policy note, and switching back to auto", async () => {
    const onUpdateSettings = vi.fn<(patch: ServerSettingsPatch) => void>();
    const onSelectProviderInstance = vi.fn<(instanceId: ProviderInstanceId) => void>();

    const renderSection = (codingAgent: CodingAgentSetting) => (
      <CodingAgentSettingsSection
        codingAgent={codingAgent}
        serverProviders={makeFixtureProviders()}
        providerInstances={fixtureInstances}
        developerFeatures={false}
        readOnly={false}
        canWriteSettings={true}
        onUpdateSettings={onUpdateSettings}
        onSelectProviderInstance={onSelectProviderInstance}
        locale="zh"
      />
    );

    await using screen = await render(renderSection({ mode: "provider", instanceId: claudeId }));

    await expect.element(screen.getByTestId("coding-agent-selected-readiness")).toHaveTextContent("已就绪");
    await expect.element(screen.getByTestId("coding-agent-im-security-note")).toBeVisible();
    expect(screen.getByTestId("coding-agent-readiness-warning").query()).toBeNull();

    await userEvent.click(screen.getByTestId("coding-agent-model-select"));
    await userEvent.click(page.getByRole("option", { name: "Claude Opus 4.6" }));
    expect(onUpdateSettings).toHaveBeenCalledWith({
      codingAgent: { mode: "provider", instanceId: claudeId, model: "claude-opus-4-6" },
    });

    onUpdateSettings.mockClear();
    await screen.rerender(renderSection({ mode: "provider", instanceId: kimiId }));
    await expect.element(screen.getByTestId("coding-agent-selected-readiness")).toHaveTextContent("未安装");
    await expect.element(screen.getByTestId("coding-agent-readiness-warning")).toBeVisible();
    await userEvent.click(screen.getByTestId("coding-agent-jump-to-provider"));
    expect(onSelectProviderInstance).toHaveBeenCalledWith(kimiId);

    await userEvent.click(screen.getByTestId("coding-agent-select"));
    await userEvent.click(page.getByTestId("coding-agent-option-auto"));
    expect(onUpdateSettings).toHaveBeenCalledWith({ codingAgent: { mode: "auto" } });
  });
});

describe("CodingAgentBlockedActionCard", () => {
  it("parses MCP coding_agent_unavailable payloads and triggers install/login navigation or one-turn built-in fallback without mutating settings", async () => {
    const toolItem = {
      type: "dynamic_tool",
      toolName: "mcp__t3-code__delegate_task",
      output: {
        content: [
          {
            type: "text",
            text: JSON.stringify({
              _tag: "OrchestratorMcpFailure",
              blocked: true,
              code: "coding_agent_unavailable",
              reason: "not_installed",
              instanceId: "xtworkKimiCode",
              displayName: "Kimi Code",
              canInstall: true,
              canLogin: false,
              message: "Kimi Code is not installed yet.",
            }),
          },
        ],
      },
    } as unknown as OrchestrationV2TurnItem;

    const blocked = readCodingAgentBlockedResult(toolItem);
    expect(blocked).not.toBeNull();
    expect(blocked?.instanceId).toBe(kimiId);
    expect(blocked?.reason).toBe("not_installed");

    const onOpenProviderSettings = vi.fn<(instanceId: ProviderInstanceId) => void>();
    const onFallbackToBuiltIn = vi.fn<(instruction: string) => Promise<void>>(async () => {});

    await using screen = await render(
      <CodingAgentBlockedActionCard
        blocked={blocked!}
        environmentId={environmentId}
        onOpenProviderSettings={onOpenProviderSettings}
        onFallbackToBuiltIn={onFallbackToBuiltIn}
        locale="zh"
      />,
    );

    await expect.element(screen.getByTestId("coding-agent-blocked-action-card")).toBeVisible();
    await expect
      .element(screen.getByTestId("coding-agent-action-install-login"))
      .toHaveTextContent("一键安装 / 去登录");
    await expect
      .element(screen.getByTestId("coding-agent-action-fallback-builtin"))
      .toHaveTextContent("仅本次改用内置小瞳");

    await userEvent.click(screen.getByTestId("coding-agent-action-install-login"));
    expect(onOpenProviderSettings).toHaveBeenCalledWith(kimiId);

    await userEvent.click(screen.getByTestId("coding-agent-action-fallback-builtin"));
    expect(onFallbackToBuiltIn).toHaveBeenCalledWith(ONE_TURN_BUILTIN_XIAOTONG_PROMPT_ZH);
    await expect
      .element(screen.getByTestId("coding-agent-action-fallback-builtin"))
      .toBeDisabled();
  });
});
