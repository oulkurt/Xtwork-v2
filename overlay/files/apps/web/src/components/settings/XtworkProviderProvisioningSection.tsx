import {
  CheckCircle2Icon,
  DownloadIcon,
  ExternalLinkIcon,
  RefreshCwIcon,
  ShieldCheckIcon,
  TerminalIcon,
  Trash2Icon,
  XCircleIcon,
} from "lucide-react";
import { useEffect, useRef, useState } from "react";
import { useLocale } from "gt-react";
import type { ProviderDriverKind, ProviderInstanceConfig, ServerProvider } from "@t3tools/contracts";

import { readDesktopPrimaryBearerToken } from "../../environments/primary/desktopAuth";
import { ensureLocalApi } from "../../localApi";
import { Badge } from "../ui/badge";
import { Button } from "../ui/button";
import {
  Dialog,
  DialogAction,
  DialogClose,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogPanel,
  DialogPopup,
  DialogTitle,
} from "../ui/dialog";
import { Spinner } from "../ui/spinner";
import { SettingsRow } from "./settingsLayout";

type ProvisionInstallMode = "app-managed" | "vendor-script";

type ProvisionerPhase =
  | "idle"
  | "awaiting_consent"
  | "installing"
  | "verifying"
  | "succeeded"
  | "failed"
  | "cancelled";

interface InstallConsentKey {
  readonly instanceId: string;
  readonly source: string;
  readonly version: string;
  readonly distribution: string;
  readonly installDir: string;
}

interface ProvisionPlanOption {
  readonly mode: ProvisionInstallMode;
  readonly label: string;
  readonly labelZh: string;
  readonly summary: string;
  readonly summaryZh: string;
  readonly commandPreview: string;
  readonly officialSource: string;
  readonly targetInstallDir: string;
  readonly uninstallSemantics: "app-managed" | "vendor-managed";
  readonly uninstallGuidance: string;
  readonly uninstallGuidanceZh: string;
  readonly consentKey: InstallConsentKey;
  readonly availableVersion: string | null;
  readonly distribution: string;
}

interface ProviderProvisionState {
  readonly instanceId: string;
  readonly phase: ProvisionerPhase;
  readonly operationId: string | null;
  readonly mode: ProvisionInstallMode | null;
  readonly message: string | null;
  readonly error: string | null;
  readonly logs: ReadonlyArray<string>;
  readonly installedVersion: string | null;
  readonly executablePath: string | null;
  readonly startedAt: string | null;
  readonly finishedAt: string | null;
}

interface ProviderInstallPlan {
  readonly instanceId: string;
  readonly agentKind: string;
  readonly displayName: string;
  readonly defaultMode: ProvisionInstallMode;
  readonly selectedMode: ProvisionInstallMode;
  readonly selectedOption: ProvisionPlanOption;
  readonly availableModes: ReadonlyArray<ProvisionPlanOption>;
  readonly existingDetection: {
    readonly detected: boolean;
    readonly source: "user-path" | "app-managed" | "none";
    readonly executablePath: string | null;
    readonly version: string | null;
  };
  readonly installedVersion: string | null;
  readonly availableVersion: string | null;
  readonly updateAvailable: boolean;
  readonly consentRequired: boolean;
  readonly consentReason: "install_required" | "update_required" | null;
  readonly canUninstall: boolean;
  readonly uninstallSemantics: "app-managed" | "vendor-managed";
  readonly uninstallGuidance: string;
  readonly uninstallGuidanceZh: string;
  readonly state: ProviderProvisionState;
}

const PROVISIONABLE_INSTANCE_IDS = new Set([
  "claudeAgent",
  "codex",
  "xtworkKimiCode",
  "xtworkQoder",
  "xtworkCodebuddyCode",
  "xtworkDeepseekHarness",
]);

const PROVISIONABLE_ACP_AGENT_IDS = new Set(["kimi-code", "qoder", "codebuddy-code"]);

export function isProvisionableCodingAgent(
  instanceId: string,
  driver: ProviderDriverKind,
  instance: ProviderInstanceConfig | undefined,
): boolean {
  if (PROVISIONABLE_INSTANCE_IDS.has(instanceId)) return true;
  if (driver === "claudeAgent" || driver === "codex") return true;
  if (driver === "acpRegistry" && instance?.config && typeof instance.config === "object") {
    const config = instance.config as Record<string, unknown>;
    if (config.source !== "local" && typeof config.agentId === "string") {
      return PROVISIONABLE_ACP_AGENT_IDS.has(config.agentId.trim());
    }
    if (config.source === "local" && typeof config.commandPath === "string") {
      const base = config.commandPath.trim().split(/[\\/]/u).pop() ?? "";
      return base === "dsh" || base === "dsh.exe" || base === "dsh.cmd";
    }
  }
  return false;
}

async function provisionerRequest<T>(
  path: string,
  payload?: Record<string, unknown>,
  signal?: AbortSignal,
): Promise<T> {
  const token = await readDesktopPrimaryBearerToken();
  if (!token) {
    throw new Error("Local desktop connection required.");
  }
  const res = await fetch(`/api/xtwork/providers/${path}`, {
    headers: {
      Authorization: `Bearer ${token}`,
      ...(payload ? { "Content-Type": "application/json" } : {}),
    },
    ...(signal ? { signal } : {}),
    ...(payload ? { method: "POST", body: JSON.stringify(payload) } : {}),
  });
  const data = (await res.json().catch(() => ({}))) as { error?: string } & T;
  if (!res.ok) {
    throw new Error(typeof data.error === "string" ? data.error : `Request failed (${res.status})`);
  }
  return data;
}

export function XtworkProviderProvisioningSection({
  instanceId,
  liveProvider,
  readOnly,
  onProvisioned,
}: {
  readonly instanceId: string;
  readonly liveProvider: ServerProvider | undefined;
  readonly readOnly: boolean;
  readonly onProvisioned?: () => void;
}) {
  const locale = useLocale();
  const isZh = locale.toLowerCase().startsWith("zh");
  const t = (zh: string, en: string) => (isZh ? zh : en);

  const [selectedMode, setSelectedMode] = useState<ProvisionInstallMode | undefined>(undefined);
  const [plan, setPlan] = useState<ProviderInstallPlan | null>(null);
  const [status, setStatus] = useState<ProviderProvisionState | null>(null);
  const [loading, setLoading] = useState(true);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [confirmOpen, setConfirmOpen] = useState(false);
  const logsEndRef = useRef<HTMLDivElement>(null);
  const lastTerminalPhaseRef = useRef<ProvisionerPhase | null>(null);

  const activeState = status ?? plan?.state ?? null;
  const isInstalling =
    activeState?.phase === "installing" || activeState?.phase === "verifying";

  const loadPlan = async (modeOverride?: ProvisionInstallMode, signal?: AbortSignal) => {
    const query = new URLSearchParams({ instanceId });
    const modeToRequest = modeOverride ?? selectedMode;
    if (modeToRequest) query.set("mode", modeToRequest);
    const nextPlan = await provisionerRequest<ProviderInstallPlan>(
      `plan?${query.toString()}`,
      undefined,
      signal,
    );
    if (signal?.aborted) return;
    setPlan(nextPlan);
    setStatus(nextPlan.state);
    setError(null);
  };

  // Load initial plan on mount / instance change / mode change.
  // oxlint-disable-next-line t3code/no-unreasoned-state-sync -- loads install plan from server for selected instance and mode
  useEffect(() => {
    if (typeof window === "undefined" || !window.desktopBridge) {
      setLoading(false);
      return;
    }
    const controller = new AbortController();
    setLoading(true);
    void loadPlan(selectedMode, controller.signal)
      .catch((cause) => {
        if (!controller.signal.aborted) {
          setError(cause instanceof Error ? cause.message : t("无法获取安装计划。", "Could not load install plan."));
        }
      })
      .finally(() => {
        if (!controller.signal.aborted) setLoading(false);
      });
    return () => controller.abort();
  }, [instanceId, selectedMode]);

  // Poll live status & logs while installing or verifying.
  // oxlint-disable-next-line t3code/no-unreasoned-state-sync -- polls server provisioning progress and sanitized log stream while active
  useEffect(() => {
    if (!isInstalling) return;
    const controller = new AbortController();
    const poll = async () => {
      try {
        const nextStatus = await provisionerRequest<ProviderProvisionState>(
          `status?instanceId=${encodeURIComponent(instanceId)}`,
          undefined,
          controller.signal,
        );
        if (controller.signal.aborted) return;
        setStatus(nextStatus);
        if (
          nextStatus.phase === "succeeded" ||
          nextStatus.phase === "failed" ||
          nextStatus.phase === "cancelled"
        ) {
          if (lastTerminalPhaseRef.current !== nextStatus.phase) {
            lastTerminalPhaseRef.current = nextStatus.phase;
            await loadPlan(selectedMode, controller.signal).catch(() => undefined);
            if (nextStatus.phase === "succeeded") {
              onProvisioned?.();
            }
          }
          return;
        }
      } catch {
        // retry on next tick
      }
      if (!controller.signal.aborted) {
        timer = setTimeout(() => void poll(), 700);
      }
    };
    let timer: ReturnType<typeof setTimeout> = setTimeout(() => void poll(), 500);
    return () => {
      controller.abort();
      clearTimeout(timer);
    };
  }, [isInstalling, instanceId, selectedMode]);

  // Auto-scroll live log box.
  // oxlint-disable-next-line t3code/no-unreasoned-state-sync -- keeps streaming install log scrolled to the newest line
  useEffect(() => {
    logsEndRef.current?.scrollIntoView({ block: "nearest" });
  }, [activeState?.logs.length]);

  if (typeof window === "undefined" || !window.desktopBridge) {
    return null;
  }

  const handleConfirmInstall = async () => {
    if (!plan || busy) return;
    setBusy(true);
    setError(null);
    lastTerminalPhaseRef.current = null;
    try {
      const nextState = await provisionerRequest<ProviderProvisionState>("install", {
        instanceId,
        mode: plan.selectedMode,
        consent: {
          confirmed: true,
          source: plan.selectedOption.consentKey.source,
          version: plan.selectedOption.consentKey.version,
          distribution: plan.selectedOption.consentKey.distribution,
          installDir: plan.selectedOption.consentKey.installDir,
        },
      });
      setConfirmOpen(false);
      setStatus(nextState);
    } catch (cause) {
      setError(
        cause instanceof Error
          ? cause.message
          : t("启动安装失败，请稍后重试。", "Could not start installation."),
      );
    } finally {
      setBusy(false);
    }
  };

  const handleCancel = async () => {
    if (!activeState || busy) return;
    setBusy(true);
    try {
      const nextState = await provisionerRequest<ProviderProvisionState>("cancel", {
        instanceId,
        ...(activeState.operationId ? { operationId: activeState.operationId } : {}),
      });
      setStatus(nextState);
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : t("取消安装失败。", "Could not cancel."));
    } finally {
      setBusy(false);
    }
  };

  const handleUninstall = async () => {
    if (!plan || !plan.canUninstall || busy) return;
    const confirmed = await ensureLocalApi().dialogs.confirm(
      t(
        `确定要卸载由小瞳 Work 托管安装的 ${plan.displayName} 吗？仅移除应用内受管目录，不会影响系统全局安装。`,
        `Uninstall the app-managed ${plan.displayName} runtime? Only Xiaotong Work's isolated directory is removed; global installations are untouched.`,
      ),
      { variant: "destructive" },
    );
    if (!confirmed) return;
    setBusy(true);
    setError(null);
    try {
      const nextState = await provisionerRequest<ProviderProvisionState>("uninstall", {
        instanceId,
      });
      setStatus(nextState);
      await loadPlan(selectedMode);
      onProvisioned?.();
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : t("卸载失败。", "Could not uninstall."));
    } finally {
      setBusy(false);
    }
  };

  const option = plan?.selectedOption;
  const installed = Boolean(plan?.existingDetection.detected || liveProvider?.installed);
  const actionButtonLabel = plan?.updateAvailable
    ? t("确认并更新", "Update")
    : installed
      ? plan?.existingDetection.source === "user-path" && option?.mode === "app-managed"
        ? t("安装独立受管版", "Install managed copy")
        : t("重新安装", "Reinstall")
      : t("一键安装", "One-Click Install");

  return (
    <>
      <SettingsRow
        title={t("一键安装与管理", "Installation")}
        description={
          loading
            ? t("正在检测本机安装状态与官方安装源…", "Checking installation status and official source…")
            : plan?.existingDetection.source === "user-path"
              ? t(
                  `已检测到本机已有安装${plan.existingDetection.version ? `（v${plan.existingDetection.version}）` : ""}，默认直接复用，不会覆盖您的环境。`,
                  `Detected existing local install${plan.existingDetection.version ? ` (v${plan.existingDetection.version})` : ""}. Your existing binary will not be overwritten.`,
                )
              : plan?.existingDetection.source === "app-managed"
                ? t(
                    `已通过受管隔离目录安装${plan.installedVersion ? `（v${plan.installedVersion}）` : ""}。`,
                    `Installed in Xiaotong Work's isolated directory${plan.installedVersion ? ` (v${plan.installedVersion})` : ""}.`,
                  )
                : t(
                    "尚未安装。点击按钮前会完整预览官方命令与安装位置，确认后才开始下载。",
                    "Not installed yet. You will review the exact official command and target directory before anything downloads.",
                  )
        }
        control={
          <div className="flex flex-wrap items-center justify-end gap-1.5">
            {isInstalling ? (
              <Button
                type="button"
                size="sm"
                variant="outline"
                disabled={readOnly || busy}
                onClick={() => void handleCancel()}
              >
                <XCircleIcon className="size-3.5" />
                {t("取消安装", "Cancel")}
              </Button>
            ) : (
              <>
                {plan?.canUninstall && !readOnly ? (
                  <Button
                    type="button"
                    size="sm"
                    variant="ghost-destructive"
                    disabled={busy}
                    onClick={() => void handleUninstall()}
                  >
                    <Trash2Icon className="size-3.5" />
                    {t("卸载", "Uninstall")}
                  </Button>
                ) : null}
                <Button
                  type="button"
                  size="sm"
                  variant={installed && !plan?.updateAvailable ? "outline" : "default"}
                  disabled={readOnly || loading || busy || !plan}
                  onClick={() => setConfirmOpen(true)}
                >
                  {plan?.updateAvailable ? (
                    <RefreshCwIcon className="size-3.5" />
                  ) : (
                    <DownloadIcon className="size-3.5" />
                  )}
                  {actionButtonLabel}
                </Button>
              </>
            )}
          </div>
        }
      >
        <div className="mt-2 space-y-2.5 text-xs">
          {plan && plan.availableModes.length > 1 && !isInstalling ? (
            <div className="flex flex-wrap items-center gap-1.5">
              <span className="text-muted-foreground">{t("安装方式：", "Install mode:")}</span>
              {plan.availableModes.map((candidate) => {
                const active = candidate.mode === plan.selectedMode;
                return (
                  <Button
                    key={candidate.mode}
                    type="button"
                    size="xs"
                    variant={active ? "secondary" : "outline"}
                    disabled={readOnly || busy}
                    onClick={() => setSelectedMode(candidate.mode)}
                  >
                    {isZh ? candidate.labelZh : candidate.label}
                  </Button>
                );
              })}
            </div>
          ) : null}

          {plan?.existingDetection.detected && plan.existingDetection.executablePath ? (
            <div className="flex flex-wrap items-center gap-2 text-muted-foreground">
              <Badge variant={plan.existingDetection.source === "app-managed" ? "secondary" : "outline"} size="sm">
                {plan.existingDetection.source === "app-managed"
                  ? t("受管隔离", "App-Managed")
                  : t("本机已有", "System / User PATH")}
              </Badge>
              <code className="truncate font-mono text-2xs">
                {plan.existingDetection.executablePath}
              </code>
            </div>
          ) : null}

          {plan && !plan.canUninstall && plan.existingDetection.source !== "none" ? (
            <p className="text-muted-foreground leading-relaxed">
              {isZh ? plan.uninstallGuidanceZh : plan.uninstallGuidance}
            </p>
          ) : null}

          {isInstalling ? (
            <div className="rounded-lg border border-border/70 bg-muted/30 p-3 space-y-2">
              <div className="flex items-center gap-2 font-medium text-foreground">
                <Spinner size="sm" />
                <span>
                  {activeState.phase === "verifying"
                    ? t("正在校验安装结果…", "Verifying installation…")
                    : activeState.message ?? t("正在安装…", "Installing…")}
                </span>
              </div>
              {activeState.logs.length > 0 ? (
                <pre className="max-h-40 overflow-auto rounded-md border border-border/50 bg-background/80 p-2 font-mono text-2xs leading-relaxed text-muted-foreground whitespace-pre-wrap break-all">
                  {activeState.logs.join("\n")}
                  <div ref={logsEndRef} />
                </pre>
              ) : null}
            </div>
          ) : null}

          {!isInstalling && activeState?.phase === "succeeded" ? (
            <div className="flex items-start gap-2 rounded-lg border border-emerald-500/30 bg-emerald-500/10 p-2.5 text-emerald-700 dark:text-emerald-300">
              <CheckCircle2Icon className="mt-0.5 size-4 shrink-0" />
              <div className="min-w-0 space-y-0.5">
                <p className="font-medium">
                  {t(
                    "安装并验证完成！请继续在下方完成账号登录。",
                    "Installation verified! Continue signing in below.",
                  )}
                </p>
                {activeState.executablePath ? (
                  <code className="block truncate font-mono text-2xs opacity-80">
                    {activeState.executablePath}
                  </code>
                ) : null}
              </div>
            </div>
          ) : null}

          {!isInstalling && (activeState?.phase === "failed" || activeState?.phase === "cancelled") ? (
            <div className="space-y-1.5 rounded-lg border border-destructive/30 bg-destructive/10 p-2.5">
              <p role="alert" className="font-medium text-destructive">
                {activeState.phase === "cancelled"
                  ? t("安装已取消。", "Installation cancelled.")
                  : (activeState.error ?? activeState.message ?? t("安装失败。", "Installation failed."))}
              </p>
              {activeState.logs.length > 0 ? (
                <pre className="max-h-32 overflow-auto rounded-md border border-border/50 bg-background/80 p-2 font-mono text-2xs leading-relaxed text-muted-foreground whitespace-pre-wrap break-all">
                  {activeState.logs.slice(-30).join("\n")}
                </pre>
              ) : null}
            </div>
          ) : null}

          {error ? (
            <p role="alert" className="text-destructive">
              {error}
            </p>
          ) : null}
        </div>
      </SettingsRow>

      <Dialog open={confirmOpen} onOpenChange={setConfirmOpen}>
        <DialogPopup className="max-w-xl">
          <DialogHeader>
            <DialogTitle>
              {plan?.updateAvailable
                ? t(`确认更新 ${plan.displayName}`, `Confirm update for ${plan.displayName}`)
                : t(`确认安装 ${plan?.displayName ?? ""}`, `Confirm installation of ${plan?.displayName ?? ""}`)}
            </DialogTitle>
            <DialogDescription>
              {option ? (isZh ? option.summaryZh : option.summary) : ""}
            </DialogDescription>
          </DialogHeader>
          {plan && option ? (
            <DialogPanel>
              <div className="space-y-3 text-xs">
                <div className="flex flex-wrap items-center gap-2">
                  <Badge
                    variant={option.mode === "app-managed" ? "secondary" : "warning"}
                    size="sm"
                  >
                    <ShieldCheckIcon className="mr-1 size-3" />
                    {option.mode === "app-managed"
                      ? t("受管隔离安装（App-Managed）", "App-Managed Isolated")
                      : t("官方脚本安装（Vendor-Managed）", "Vendor-Managed Script")}
                  </Badge>
                  {option.availableVersion ? (
                    <code className="rounded bg-muted px-1.5 py-0.5 font-mono text-2xs">
                      {option.availableVersion}
                    </code>
                  ) : null}
                </div>

                <div className="space-y-1">
                  <p className="font-medium text-foreground flex items-center gap-1.5">
                    <TerminalIcon className="size-3.5 text-muted-foreground" />
                    {t("将执行的官方命令", "Command to execute")}
                  </p>
                  <pre className="overflow-x-auto rounded-md border border-border bg-muted/50 p-2.5 font-mono text-2xs leading-relaxed text-foreground whitespace-pre-wrap break-all select-all">
                    {option.commandPreview}
                  </pre>
                </div>

                <dl className="grid gap-2 rounded-md border border-border/70 bg-muted/20 p-3">
                  <div className="grid gap-0.5">
                    <dt className="text-muted-foreground">{t("官方来源", "Official source")}</dt>
                    <dd className="flex items-center gap-1 font-mono text-2xs break-all text-foreground">
                      <span>{option.officialSource}</span>
                      {option.officialSource.startsWith("https://") ? (
                        <a
                          href={option.officialSource}
                          target="_blank"
                          rel="noreferrer"
                          className="inline-flex shrink-0 text-primary hover:underline"
                          aria-label={t("打开官方来源", "Open official source")}
                        >
                          <ExternalLinkIcon className="size-3" />
                        </a>
                      ) : null}
                    </dd>
                  </div>
                  <div className="grid gap-0.5">
                    <dt className="text-muted-foreground">{t("安装目录", "Target install directory")}</dt>
                    <dd className="font-mono text-2xs break-all text-foreground">
                      {option.targetInstallDir === "vendor-global"
                        ? t(
                            "本机用户全局目录（由厂商官方脚本决定，如 ~/.local/bin）",
                            "User global path managed by the vendor script (e.g. ~/.local/bin)",
                          )
                        : option.targetInstallDir}
                    </dd>
                  </div>
                  <div className="grid gap-0.5">
                    <dt className="text-muted-foreground">{t("卸载与回滚说明", "Uninstall semantics")}</dt>
                    <dd className="leading-relaxed text-muted-foreground">
                      {isZh ? option.uninstallGuidanceZh : option.uninstallGuidance}
                    </dd>
                  </div>
                </dl>
              </div>
            </DialogPanel>
          ) : null}
          <DialogFooter>
            <DialogClose render={<Button variant="outline" size="sm" disabled={busy} />}>
              {t("取消", "Cancel")}
            </DialogClose>
            <DialogAction
              size="sm"
              disabled={busy || !plan}
              onClick={() => void handleConfirmInstall()}
            >
              {busy ? <Spinner size="sm" /> : <DownloadIcon className="size-3.5" />}
              {plan?.updateAvailable
                ? t("确认并更新", "Confirm & Update")
                : t("确认并安装", "Confirm & Install")}
            </DialogAction>
          </DialogFooter>
        </DialogPopup>
      </Dialog>
    </>
  );
}
