import {
  DEFAULT_CODING_AGENT_SETTING,
  PROVIDER_DISPLAY_NAMES,
  ProviderInstanceId,
  type CodingAgentBlockedReason,
  type CodingAgentSetting,
  type CodingAgentTurnOverride,
  type EnvironmentId,
  type OrchestrationV2TurnItem,
  type ProviderInstanceConfig,
  type ServerProvider,
  type ServerSettingsPatch,
  resolveProviderInstanceEnabled,
} from "@t3tools/contracts";
import { useNavigate } from "@tanstack/react-router";
import { useLocale } from "gt-react";
import {
  AlertTriangleIcon,
  ArrowRightIcon,
  BotIcon,
  CheckCircle2Icon,
  ShieldCheckIcon,
  WrenchIcon,
} from "lucide-react";
import { useState } from "react";

import {
  BUILT_IN_ASSISTANT_ID,
  ORDINARY_MODE_CODING_AGENT_IDS,
  isOrdinaryModeProviderVisible,
} from "../../desktopFeatureVisibility";
import { cn } from "../../lib/utils";
import { Badge } from "../ui/badge";
import { Button } from "../ui/button";
import { Select, SelectItem, SelectPopup, SelectTrigger, SelectValue } from "../ui/select";
import { SettingsRow, SettingsSection } from "./settingsLayout";
import { useSearchableSetting } from "./settingsSearch";

export const CODING_AGENT_AUTO_HELPER_ZH =
  "使用内置 agent，跑在当前对话的模型上。要交给 Claude Code 或 ACP agent，请直接选择它。";
export const CODING_AGENT_AUTO_HELPER_EN =
  "Uses the built-in agent on the current conversation's model. To delegate to Claude Code or an ACP agent, select it directly.";

export const ONE_TURN_BUILTIN_XIAOTONG_PROMPT_ZH =
  "仅本次请直接由内置「小瞳」在当前对话模型上继续完成这项任务，不要调用 delegate_task，也不要修改我的全局 Coding Agent 设置。";
export const ONE_TURN_BUILTIN_XIAOTONG_PROMPT_EN =
  "For this turn only, continue and complete this task directly with built-in Xiaotong on the current conversation model. Do not call delegate_task and do not change my global Coding Agent setting.";

const KNOWN_AGENT_DISPLAY_NAMES: Readonly<Record<string, string>> = {
  claudeAgent: "Claude Code",
  codex: "Codex",
  xtworkKimiCode: "Kimi Code",
  xtworkQoder: "Qoder",
  xtworkCodebuddyCode: "Codebuddy Code",
  xtworkDeepseekHarness: "DeepSeek Harness",
};

const AUTO_VALUE = "__auto__";
const DEFAULT_MODEL_VALUE = "__agent_default__";
const CODING_AGENT_HEADING = "Coding Agent";

export type CodingAgentReadinessStatus =
  | "ready"
  | "not_installed"
  | "update_required"
  | "not_authenticated"
  | "disabled"
  | "not_found";

export interface CodingAgentOption {
  readonly instanceId: ProviderInstanceId;
  readonly displayName: string;
  readonly readiness: CodingAgentReadinessStatus;
  readonly provider: ServerProvider | undefined;
  readonly models: ReadonlyArray<{ readonly slug: string; readonly name: string }>;
}

export interface CodingAgentBlockedPayload {
  readonly blocked: true;
  readonly code: "coding_agent_unavailable";
  readonly reason: CodingAgentBlockedReason;
  readonly instanceId: ProviderInstanceId;
  readonly displayName: string;
  readonly canInstall: boolean;
  readonly canLogin: boolean;
  readonly message: string;
}

function useIsZh(localeOverride?: string): boolean {
  const gtLocale = useLocale();
  const normalized = (localeOverride ?? gtLocale ?? "").trim().toLowerCase();
  if (normalized.length === 0) return true;
  return normalized.startsWith("zh");
}

function isUpdateRequiredSnapshot(provider: ServerProvider): boolean {
  if (provider.versionAdvisory?.status === "behind_latest") {
    return true;
  }
  if (
    provider.compatibilityAdvisory?.status === "unsupported" ||
    provider.compatibilityAdvisory?.status === "broken"
  ) {
    return true;
  }
  const message = provider.message?.toLowerCase() ?? "";
  return (
    provider.status === "warning" &&
    provider.installed &&
    (message.includes("update_required") ||
      (message.includes("update") && message.includes("confirm")) ||
      message.includes("confirm in provider settings to update"))
  );
}

export function classifyCodingAgentReadiness(
  provider: ServerProvider | undefined,
  instanceConfig: ProviderInstanceConfig | undefined,
): CodingAgentReadinessStatus {
  if (provider === undefined) {
    if (instanceConfig !== undefined && !resolveProviderInstanceEnabled(instanceConfig)) {
      return "disabled";
    }
    return "not_installed";
  }
  if (!provider.enabled || provider.status === "disabled") {
    return "disabled";
  }
  if (!provider.installed) {
    return "not_installed";
  }
  if (isUpdateRequiredSnapshot(provider)) {
    return "update_required";
  }
  if (provider.auth.status === "unauthenticated") {
    return "not_authenticated";
  }
  if (provider.availability === "unavailable" || provider.status === "error") {
    return "not_found";
  }
  return "ready";
}

function resolveOptionDisplayName(
  instanceId: string,
  provider: ServerProvider | undefined,
  instanceConfig: ProviderInstanceConfig | undefined,
): string {
  const fromProvider = provider?.displayName?.trim();
  if (fromProvider) return fromProvider;
  const fromConfig = instanceConfig?.displayName?.trim();
  if (fromConfig) return fromConfig;
  const known = KNOWN_AGENT_DISPLAY_NAMES[instanceId];
  if (known) return known;
  const driver = provider?.driver ?? instanceConfig?.driver;
  if (driver && Object.hasOwn(PROVIDER_DISPLAY_NAMES, driver)) {
    return PROVIDER_DISPLAY_NAMES[driver as keyof typeof PROVIDER_DISPLAY_NAMES] ?? instanceId;
  }
  return instanceId;
}

export function buildCodingAgentOptions(input: {
  readonly serverProviders: ReadonlyArray<ServerProvider>;
  readonly providerInstances: Readonly<Record<string, ProviderInstanceConfig>> | undefined;
  readonly selectedInstanceId: ProviderInstanceId | null;
  readonly developerFeatures: boolean;
}): ReadonlyArray<CodingAgentOption> {
  const providersById = new Map<string, ServerProvider>(
    input.serverProviders.map((provider) => [String(provider.instanceId), provider]),
  );
  const instances = input.providerInstances ?? {};
  const orderedIds: Array<string> = [];
  const seen = new Set<string>();

  const addId = (rawId: string, isExplicitCustom = false) => {
    if (!rawId || rawId === BUILT_IN_ASSISTANT_ID || seen.has(rawId)) return;
    if (
      !isOrdinaryModeProviderVisible({
        instanceId: rawId,
        developerFeatures: input.developerFeatures,
        boundInstanceId: input.selectedInstanceId,
        isExplicitCustom,
      })
    ) {
      return;
    }
    seen.add(rawId);
    orderedIds.push(rawId);
  };

  for (const recommendedId of ORDINARY_MODE_CODING_AGENT_IDS) {
    addId(recommendedId);
  }
  for (const instanceId of Object.keys(instances)) {
    const isRecommended = (ORDINARY_MODE_CODING_AGENT_IDS as ReadonlyArray<string>).includes(
      instanceId,
    );
    addId(instanceId, !isRecommended);
  }
  for (const provider of input.serverProviders) {
    addId(String(provider.instanceId));
  }
  if (input.selectedInstanceId) {
    addId(String(input.selectedInstanceId), true);
  }

  return orderedIds.map((rawId) => {
    const instanceId = ProviderInstanceId.make(rawId);
    const provider = providersById.get(rawId);
    const instanceConfig = Object.hasOwn(instances, rawId) ? instances[rawId] : undefined;
    const displayName = resolveOptionDisplayName(rawId, provider, instanceConfig);
    const readiness =
      provider === undefined &&
      instanceConfig === undefined &&
      !(ORDINARY_MODE_CODING_AGENT_IDS as ReadonlyArray<string>).includes(rawId)
        ? "not_found"
        : classifyCodingAgentReadiness(provider, instanceConfig);
    const models = (provider?.models ?? []).map((model) => ({
      slug: model.slug,
      name: model.name,
    }));
    return {
      instanceId,
      displayName,
      readiness,
      provider,
      models,
    };
  });
}

function readinessBadgeMeta(
  status: CodingAgentReadinessStatus | CodingAgentBlockedReason,
  isZh: boolean,
): {
  readonly text: string;
  readonly variant: "success" | "warning" | "secondary" | "error";
} {
  const pick = (zh: string, en: string) => (isZh ? zh : en);
  switch (status) {
    case "ready":
      return { text: pick("已就绪", "Ready"), variant: "success" };
    case "not_installed":
      return { text: pick("未安装", "Not installed"), variant: "warning" };
    case "update_required":
      return { text: pick("需确认更新", "Update required"), variant: "warning" };
    case "not_authenticated":
      return { text: pick("需登录", "Login required"), variant: "warning" };
    case "disabled":
      return { text: pick("已禁用", "Disabled"), variant: "secondary" };
    case "not_found":
    case "unavailable":
      return { text: pick("不可用", "Unavailable"), variant: "error" };
  }
}

export interface CodingAgentSettingsSectionProps {
  readonly codingAgent: CodingAgentSetting | undefined;
  readonly serverProviders: ReadonlyArray<ServerProvider>;
  readonly providerInstances: Readonly<Record<string, ProviderInstanceConfig>> | undefined;
  readonly developerFeatures: boolean;
  readonly readOnly: boolean;
  readonly canWriteSettings: boolean;
  readonly onUpdateSettings: (patch: ServerSettingsPatch) => void;
  readonly onSelectProviderInstance?: ((instanceId: ProviderInstanceId) => void) | undefined;
  readonly locale?: string | undefined;
}

export function CodingAgentSettingsSection({
  codingAgent,
  serverProviders,
  providerInstances,
  developerFeatures,
  readOnly,
  canWriteSettings,
  onUpdateSettings,
  onSelectProviderInstance,
  locale,
}: CodingAgentSettingsSectionProps) {
  const searchableSetting = useSearchableSetting();
  const isZh = useIsZh(locale);
  const t = (zh: string, en: string) => (isZh ? zh : en);

  const effectiveSetting: CodingAgentSetting =
    codingAgent?.mode === "provider" && String(codingAgent.instanceId) !== BUILT_IN_ASSISTANT_ID
      ? codingAgent
      : DEFAULT_CODING_AGENT_SETTING;

  const selectedInstanceId =
    effectiveSetting.mode === "provider" ? effectiveSetting.instanceId : null;
  const selectedModel = effectiveSetting.mode === "provider" ? effectiveSetting.model : undefined;

  const options = buildCodingAgentOptions({
    serverProviders,
    providerInstances,
    selectedInstanceId,
    developerFeatures,
  });

  const selectedOption =
    selectedInstanceId !== null
      ? options.find((option) => option.instanceId === selectedInstanceId)
      : undefined;
  const selectValue = selectedInstanceId ? String(selectedInstanceId) : AUTO_VALUE;
  const editable = !readOnly && canWriteSettings;

  const handleAgentChange = (nextValue: string | null) => {
    if (!nextValue || !editable) return;
    if (nextValue === AUTO_VALUE) {
      onUpdateSettings({ codingAgent: { mode: "auto" } });
      return;
    }
    const nextInstanceId = ProviderInstanceId.make(nextValue);
    onUpdateSettings({
      codingAgent: {
        mode: "provider",
        instanceId: nextInstanceId,
      },
    });
  };

  const handleModelChange = (nextModel: string | null) => {
    if (!editable || selectedInstanceId === null || !nextModel) return;
    if (nextModel === DEFAULT_MODEL_VALUE) {
      onUpdateSettings({
        codingAgent: {
          mode: "provider",
          instanceId: selectedInstanceId,
        },
      });
      return;
    }
    onUpdateSettings({
      codingAgent: {
        mode: "provider",
        instanceId: selectedInstanceId,
        model: nextModel,
      },
    });
  };

  const selectedBadge = selectedOption
    ? readinessBadgeMeta(selectedOption.readiness, isZh)
    : null;
  const isSelectedBlocked = selectedOption !== undefined && selectedOption.readiness !== "ready";

  const warningCopy = (() => {
    if (!selectedOption || !isSelectedBlocked) return null;
    switch (selectedOption.readiness) {
      case "not_installed":
        return t(
          `${selectedOption.displayName} 尚未安装或未确认安装授权。编码任务委派将被阻断（不会静默切换其他外部 Agent），请先前往下方卡片一键安装。`,
          `${selectedOption.displayName} is not installed yet. Coding delegation will be blocked with no silent fallback until you install it below.`,
        );
      case "update_required":
        return t(
          `${selectedOption.displayName} 需要先确认版本更新后才能运行。请前往下方卡片确认更新。`,
          `${selectedOption.displayName} requires confirming an update before running. Review it in the provider card below.`,
        );
      case "not_authenticated":
        return t(
          `${selectedOption.displayName} 尚未登录。编码任务委派将被阻断，请先前往下方卡片完成登录。`,
          `${selectedOption.displayName} is not signed in yet. Coding delegation will be blocked until you sign in below.`,
        );
      case "disabled":
        return t(
          `${selectedOption.displayName} 当前已禁用。请在下方卡片启用后再进行委派。`,
          `${selectedOption.displayName} is currently disabled. Enable it in the provider card below before delegating.`,
        );
      case "not_found":
        return t(
          `${selectedOption.displayName} 当前在本地环境中不可用。请检查下方卡片配置或改选其他 Coding Agent。`,
          `${selectedOption.displayName} is currently unavailable on this environment. Check its configuration below or choose another Coding Agent.`,
        );
    }
  })();

  const jumpButtonLabel =
    selectedOption?.readiness === "not_authenticated"
      ? t("前往登录", "Go to Sign in")
      : selectedOption?.readiness === "not_installed" ||
          selectedOption?.readiness === "update_required"
        ? t("前往一键安装", "Go to Install")
        : t("查看该 Agent 配置", "Configure Agent");

  return (
    <SettingsSection
      {...searchableSetting("coding-agent")}
      title={CODING_AGENT_HEADING}
      icon={<BotIcon className="size-4 text-muted-foreground" aria-hidden />}
      data-testid="coding-agent-settings-section"
    >
      <SettingsRow
        title={CODING_AGENT_HEADING}
        description={
          effectiveSetting.mode === "auto"
            ? t(CODING_AGENT_AUTO_HELPER_ZH, CODING_AGENT_AUTO_HELPER_EN)
            : t(
                `日常对话、待办与浏览器整理留在内置「小瞳」；编码与改代码任务将确定性地委派给 ${selectedOption?.displayName ?? String(selectedInstanceId)}（不静默切换其他外部 Agent）。`,
                `General chat, todos, and browser work stay in built-in Xiaotong; coding and repository edits deterministically delegate to ${selectedOption?.displayName ?? String(selectedInstanceId)} with no silent fallback.`,
              )
        }
        status={
          selectedBadge ? (
            <Badge
              variant={selectedBadge.variant}
              size="sm"
              data-testid="coding-agent-selected-readiness"
            >
              {selectedOption?.readiness === "ready" ? (
                <CheckCircle2Icon className="size-3" aria-hidden />
              ) : (
                <AlertTriangleIcon className="size-3" aria-hidden />
              )}
              {selectedBadge.text}
            </Badge>
          ) : null
        }
        control={
          <Select value={selectValue} onValueChange={handleAgentChange} disabled={!editable}>
            <SelectTrigger
              aria-label={CODING_AGENT_HEADING}
              data-testid="coding-agent-select"
              className="w-64 sm:w-72"
            >
              <SelectValue>
                {effectiveSetting.mode === "auto"
                  ? t("自动（使用内置小瞳）", "Auto (use built-in Xiaotong)")
                  : (selectedOption?.displayName ?? String(selectedInstanceId))}
              </SelectValue>
            </SelectTrigger>
            <SelectPopup>
              <SelectItem value={AUTO_VALUE} data-testid="coding-agent-option-auto">
                <span className="flex items-center gap-2">
                  <span>{t("自动（使用内置小瞳）", "Auto (use built-in Xiaotong)")}</span>
                </span>
              </SelectItem>
              {options.map((option) => {
                const badge = readinessBadgeMeta(option.readiness, isZh);
                return (
                  <SelectItem
                    key={option.instanceId}
                    value={String(option.instanceId)}
                    data-testid={`coding-agent-option-${option.instanceId}`}
                  >
                    <span className="flex w-full items-center justify-between gap-2">
                      <span className="truncate">{option.displayName}</span>
                      <Badge variant={badge.variant} size="sm">
                        {badge.text}
                      </Badge>
                    </span>
                  </SelectItem>
                );
              })}
            </SelectPopup>
          </Select>
        }
      />

      {effectiveSetting.mode === "provider" && selectedOption && selectedOption.models.length > 0 ? (
        <SettingsRow
          title={t("默认委派模型（可选）", "Delegation model (optional)")}
          description={t(
            "留空时使用该 Coding Agent 的默认模型。",
            "Leave unset to use this Coding Agent's default model.",
          )}
          control={
            <Select
              value={selectedModel ?? DEFAULT_MODEL_VALUE}
              onValueChange={handleModelChange}
              disabled={!editable}
            >
              <SelectTrigger
                aria-label={t("默认委派模型", "Delegation model")}
                data-testid="coding-agent-model-select"
                className="w-64 sm:w-72"
              >
                <SelectValue>
                  {selectedModel
                    ? (selectedOption.models.find((m) => m.slug === selectedModel)?.name ??
                      selectedModel)
                    : t("跟随 Agent 默认模型", "Use agent default model")}
                </SelectValue>
              </SelectTrigger>
              <SelectPopup>
                <SelectItem value={DEFAULT_MODEL_VALUE}>
                  {t("跟随 Agent 默认模型", "Use agent default model")}
                </SelectItem>
                {selectedOption.models.map((model) => (
                  <SelectItem key={model.slug} value={model.slug}>
                    {model.name}
                  </SelectItem>
                ))}
              </SelectPopup>
            </Select>
          }
        />
      ) : null}

      {effectiveSetting.mode === "provider" && isSelectedBlocked && selectedOption && warningCopy ? (
        <div
          data-testid="coding-agent-readiness-warning"
          className="flex flex-wrap items-center justify-between gap-3 bg-warning/8 px-3 py-3 text-sm sm:px-4"
        >
          <div className="flex min-w-0 flex-1 items-start gap-2 text-foreground/90">
            <AlertTriangleIcon className="mt-0.5 size-4 shrink-0 text-warning" aria-hidden />
            <p className="min-w-0 leading-relaxed">{warningCopy}</p>
          </div>
          {onSelectProviderInstance ? (
            <Button
              type="button"
              size="xs"
              variant="outline"
              data-testid="coding-agent-jump-to-provider"
              onClick={() => onSelectProviderInstance(selectedOption.instanceId)}
            >
              {jumpButtonLabel}
              <ArrowRightIcon className="size-3.5" aria-hidden />
            </Button>
          ) : null}
        </div>
      ) : null}

      {effectiveSetting.mode === "provider" ? (
        <div
          data-testid="coding-agent-im-security-note"
          className="flex items-start gap-2 px-3 py-2.5 text-xs text-muted-foreground sm:px-4"
        >
          <ShieldCheckIcon className="mt-0.5 size-3.5 shrink-0 text-muted-foreground" aria-hidden />
          <span>
            {t(
              "安全策略：IM / 群聊消息始终保留在内置「小瞳」中执行，不会委派给外部 Coding Agent。",
              "Security policy: IM and group chats always stay on built-in Xiaotong and never delegate to external Coding Agents.",
            )}
          </span>
        </div>
      ) : null}
    </SettingsSection>
  );
}

function asRecord(value: unknown): Record<string, unknown> | undefined {
  return value !== null && typeof value === "object" && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : undefined;
}

const VALID_BLOCKED_REASONS: ReadonlySet<string> = new Set([
  "not_found",
  "disabled",
  "not_installed",
  "update_required",
  "not_authenticated",
  "unavailable",
]);

function extractBlockedRecord(value: unknown, depth = 0): CodingAgentBlockedPayload | null {
  if (depth > 5 || value == null) return null;
  if (typeof value === "string") {
    const trimmed = value.trim();
    if (!trimmed.startsWith("{") && !trimmed.startsWith("[")) return null;
    try {
      return extractBlockedRecord(JSON.parse(trimmed), depth + 1);
    } catch {
      return null;
    }
  }
  if (Array.isArray(value)) {
    for (const entry of value) {
      const rec = asRecord(entry);
      const found =
        extractBlockedRecord(rec?.text, depth + 1) ??
        extractBlockedRecord(asRecord(rec?.content)?.text, depth + 1) ??
        extractBlockedRecord(entry, depth + 1);
      if (found) return found;
    }
    return null;
  }
  const record = asRecord(value);
  if (!record) return null;
  if (
    record.code === "coding_agent_unavailable" &&
    typeof record.instanceId === "string" &&
    record.instanceId.trim().length > 0
  ) {
    const rawReason = typeof record.reason === "string" ? record.reason : "unavailable";
    const reason: CodingAgentBlockedReason = VALID_BLOCKED_REASONS.has(rawReason)
      ? (rawReason as CodingAgentBlockedReason)
      : "unavailable";
    const instanceId = ProviderInstanceId.make(record.instanceId.trim());
    const displayName =
      typeof record.displayName === "string" && record.displayName.trim().length > 0
        ? record.displayName.trim()
        : (KNOWN_AGENT_DISPLAY_NAMES[instanceId] ?? String(instanceId));
    const message =
      typeof record.message === "string" && record.message.trim().length > 0
        ? record.message.trim()
        : `Coding Agent ${displayName} is currently unavailable.`;
    return {
      blocked: true,
      code: "coding_agent_unavailable",
      reason,
      instanceId,
      displayName,
      canInstall: record.canInstall === true,
      canLogin: record.canLogin === true,
      message,
    };
  }
  return (
    extractBlockedRecord(record.structuredContent, depth + 1) ??
    extractBlockedRecord(record.content, depth + 1) ??
    extractBlockedRecord(record.error, depth + 1)
  );
}

function isDelegateTaskToolName(toolName: string | null | undefined): boolean {
  if (!toolName) return false;
  return (
    toolName === "delegate_task" ||
    toolName.endsWith("__delegate_task") ||
    toolName.endsWith(".delegate_task") ||
    toolName.endsWith("/delegate_task")
  );
}

/**
 * Parses a blocked `coding_agent_unavailable` payload from a `delegate_task` turn item.
 */
export function readCodingAgentBlockedResult(
  item:
    | (Pick<OrchestrationV2TurnItem, "type"> & {
        readonly toolName?: string | null | undefined;
        readonly output?: unknown;
      })
    | undefined,
): CodingAgentBlockedPayload | null {
  if (!item || item.type !== "dynamic_tool" || !isDelegateTaskToolName(item.toolName)) {
    return null;
  }
  return extractBlockedRecord(item.output);
}

export interface CodingAgentBlockedActionCardProps {
  readonly blocked: CodingAgentBlockedPayload;
  readonly environmentId: EnvironmentId;
  readonly onOpenProviderSettings?: ((instanceId: ProviderInstanceId) => void) | undefined;
  readonly onFallbackToBuiltIn?:
    | ((
        instruction: string,
        options?: { readonly codingAgentOverride?: CodingAgentTurnOverride },
      ) => Promise<void> | void)
    | undefined;
  readonly locale?: string | undefined;
  readonly className?: string | undefined;
}

export function CodingAgentBlockedActionCard({
  blocked,
  environmentId,
  onOpenProviderSettings,
  onFallbackToBuiltIn,
  locale,
  className,
}: CodingAgentBlockedActionCardProps) {
  const navigate = useNavigate();
  const isZh = useIsZh(locale);
  const t = (zh: string, en: string) => (isZh ? zh : en);
  const [fallbackState, setFallbackState] = useState<"idle" | "sending" | "sent" | "failed">(
    "idle",
  );

  const badge = readinessBadgeMeta(blocked.reason, isZh);

  const handleOpenSettings = () => {
    if (onOpenProviderSettings) {
      onOpenProviderSettings(blocked.instanceId);
      return;
    }
    void navigate({
      to: "/settings/providers",
      search: {
        environmentId,
        instanceId: blocked.instanceId,
      },
    });
  };

  const handleFallback = async () => {
    if (!onFallbackToBuiltIn || fallbackState === "sending" || fallbackState === "sent") return;
    setFallbackState("sending");
    try {
      await onFallbackToBuiltIn(
        isZh ? ONE_TURN_BUILTIN_XIAOTONG_PROMPT_ZH : ONE_TURN_BUILTIN_XIAOTONG_PROMPT_EN,
        { codingAgentOverride: "builtin_once" },
      );
      setFallbackState("sent");
    } catch {
      setFallbackState("failed");
    }
  };

  return (
    <div
      data-testid="coding-agent-blocked-action-card"
      data-blocked-instance-id={blocked.instanceId}
      data-blocked-reason={blocked.reason}
      className={cn(
        "ms-7 flex flex-col gap-2.5 rounded-lg border border-warning/35 bg-warning/6 px-3 py-2.5 text-sm",
        className,
      )}
    >
      <div className="flex flex-wrap items-center gap-2">
        <AlertTriangleIcon className="size-4 shrink-0 text-warning" aria-hidden />
        <span className="font-medium text-foreground">
          {t(`无法委派给 ${blocked.displayName}`, `Could not delegate to ${blocked.displayName}`)}
        </span>
        <Badge variant={badge.variant} size="sm">
          {badge.text}
        </Badge>
      </div>
      <p className="text-xs leading-relaxed text-muted-foreground">{blocked.message}</p>
      <div className="flex flex-wrap items-center gap-2">
        <Button
          type="button"
          size="xs"
          variant="default"
          data-testid="coding-agent-action-install-login"
          onClick={handleOpenSettings}
        >
          <WrenchIcon className="size-3.5" aria-hidden />
          {t("一键安装 / 去登录", "Install / Sign in")}
        </Button>
        {onFallbackToBuiltIn ? (
          <Button
            type="button"
            size="xs"
            variant="outline"
            data-testid="coding-agent-action-fallback-builtin"
            disabled={fallbackState === "sending" || fallbackState === "sent"}
            onClick={() => void handleFallback()}
          >
            <BotIcon className="size-3.5" aria-hidden />
            {fallbackState === "sent"
              ? t("已改用内置小瞳继续", "Continuing with built-in Xiaotong")
              : fallbackState === "sending"
                ? t("正在发送…", "Sending…")
                : t("仅本次改用内置小瞳", "Use built-in Xiaotong for this turn")}
          </Button>
        ) : null}
        {fallbackState === "failed" ? (
          <span className="text-xs text-destructive" role="alert">
            {t("发送失败，请重试。", "Failed to send fallback instruction.")}
          </span>
        ) : null}
      </div>
    </div>
  );
}
