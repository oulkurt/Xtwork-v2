import { type EnvironmentId, type ServerProvider } from "@t3tools/contracts";
import { useAtomValue } from "@effect/atom-react";
import { useNavigate } from "@tanstack/react-router";
import { CpuIcon, XIcon } from "lucide-react";
import { memo, useRef, useState } from "react";
import { BUILT_IN_ASSISTANT_ID } from "../../desktopFeatureVisibility";
import { serverEnvironment } from "../../state/server";
import { useAtomCommand } from "../../state/use-atom-command";
import { Alert, AlertAction, AlertDescription, AlertTitle } from "../ui/alert";
import { Button } from "../ui/button";
import { RefreshIcon } from "../ui/refresh-icon";

/**
 * True when the built-in `xtworkPi` assistant has zero configured/enabled models and needs
 * first-run channel setup (WeCom company login or personal API/OAuth channel).
 */
export function isXtworkZeroChannelStatus(status: ServerProvider | null): boolean {
  if (!status || status.instanceId !== BUILT_IN_ASSISTANT_ID || status.status === "disabled") {
    return false;
  }
  if (status.status === "ready") {
    return false;
  }
  const hasRealModel = status.models.some((model) => model.slug !== "default");
  return status.auth.status === "unauthenticated" || !hasRealModel;
}

export const XtworkZeroChannelBanner = memo(function XtworkZeroChannelBanner({
  environmentId,
  onDismiss,
  status,
}: {
  readonly environmentId: EnvironmentId;
  readonly onDismiss: () => void;
  readonly status: ServerProvider;
}) {
  const navigate = useNavigate();
  const canRefresh = useAtomValue(serverEnvironment.refreshProviders.permissionAtom(environmentId));
  const refreshProviders = useAtomCommand(serverEnvironment.refreshProviders, {
    label: "Refresh provider status",
  });
  const refreshingRef = useRef(false);
  const [isRefreshing, setIsRefreshing] = useState(false);

  const handleRefresh = async () => {
    if (!canRefresh || refreshingRef.current) return;
    refreshingRef.current = true;
    setIsRefreshing(true);
    try {
      await refreshProviders({
        environmentId,
        input: { instanceId: status.instanceId, refreshModels: true },
      });
    } finally {
      refreshingRef.current = false;
      setIsRefreshing(false);
    }
  };

  return (
    <div
      className="pointer-events-auto mx-auto w-fit max-w-[calc(100%-2rem)] pt-3"
      data-testid="xtwork-zero-channel-banner"
    >
      <Alert variant="warning" role="status" surface="glass" controlAlignment="first-line">
        <CpuIcon />
        <AlertTitle>欢迎使用小瞳 — 请先配置模型渠道</AlertTitle>
        <AlertDescription>
          <div className="flex flex-col gap-2">
            <p className="text-xs leading-relaxed">
              小瞳当前尚未配置可用模型渠道。你可以前往「模型渠道」使用企业微信扫码登录公司团队账号，或添加你的个人
              API 密钥与订阅账号。
            </p>
            <div className="flex flex-wrap items-center justify-end gap-2">
              <Button
                size="xs"
                variant="default"
                onClick={() => void navigate({ to: "/settings/channels" })}
              >
                前往配置模型渠道
              </Button>
              <Button
                aria-label="刷新模型状态"
                disabled={!canRefresh || isRefreshing}
                onClick={() => void handleRefresh()}
                size="xs"
                variant="outline"
              >
                <RefreshIcon />
                {isRefreshing ? "刷新中..." : "刷新"}
              </Button>
            </div>
          </div>
        </AlertDescription>
        <AlertAction>
          <Button
            aria-label="暂时收起模型渠道提示"
            onClick={onDismiss}
            size="icon-xs"
            variant="ghost-muted"
          >
            <XIcon />
          </Button>
        </AlertAction>
      </Alert>
    </div>
  );
});
