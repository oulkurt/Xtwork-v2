export const REMOTE_IM_CHANNELS = {
  feishu: {
    name: "飞书",
    scanHint: "打开飞书扫一扫",
    identifier: "App ID",
    identifierPlaceholder: "cli_a1b2c3d4e5f6",
    secret: "App Secret",
    secretPlaceholder: "输入应用密钥",
    setupUrl: "https://open.feishu.cn/app",
    setupLabel: "前往飞书开放平台",
    supportsManual: true,
    swayPhase: 0,
  },
  wecom: {
    name: "企业微信",
    scanHint: "打开企业微信扫一扫",
    identifier: "Bot ID",
    identifierPlaceholder: "输入机器人 Bot ID",
    secret: "Secret",
    secretPlaceholder: "输入机器人 Secret",
    setupUrl: undefined,
    setupLabel: undefined,
    supportsManual: true,
    swayPhase: 2.1,
  },
  wechat: {
    name: "微信",
    scanHint: "打开微信扫一扫",
    identifier: undefined,
    identifierPlaceholder: undefined,
    secret: undefined,
    secretPlaceholder: undefined,
    setupUrl: undefined,
    setupLabel: undefined,
    supportsManual: false,
    swayPhase: 4.2,
  },
} as const;

export type RemoteImChannel = keyof typeof REMOTE_IM_CHANNELS;

export const REMOTE_IM_CHANNEL_ORDER: readonly RemoteImChannel[] = ["feishu", "wecom", "wechat"];

export const REMOTE_IM_CARD_DESCRIPTION = "点击翻转扫描二维码即刻连接你的聊天软件";

export const REMOTE_IM_STATE_LABELS: Readonly<Record<string, string>> = {
  connecting: "连接中",
  qr_ready: "等待扫码",
  scanned: "已扫码，请在手机确认",
  awaiting_approval: "等待管理员审批",
  awaiting_code: "等待验证码",
  needs_code: "等待验证码",
  connected: "已连接",
  complete: "已连接",
  success: "已连接",
  succeeded: "已连接",
  reconnecting: "重连中",
  error: "连接失败",
  failed: "连接失败",
  paused: "已暂停",
  pairing: "等待认领",
};

const FAILURE_MESSAGES: Readonly<Record<string, string>> = {
  expired: "二维码已过期，请重新获取。",
  denied: "已取消或拒绝授权。",
  cancelled: "已取消连接。",
  invalid_credentials: "凭据验证失败，请核对后重试。",
  insufficient_scope: "应用权限不足，请检查开放平台权限配置。",
  network: "网络连接失败，请稍后重试。",
  already_bound: "该账号已绑定其他客户端。",
  already_connected: "该账号已连接到本机。",
  permission_missing: "缺少必要权限。",
  not_signed_in: "请先在手机端登录账号。",
  secret_store_unavailable: "系统安全凭据库不可用，无法保存密钥。",
};

export function formatOnboardingFailure(code?: string, detail?: string): string {
  if (code && FAILURE_MESSAGES[code]) return FAILURE_MESSAGES[code];
  if (detail && detail.trim().length > 0) return detail;
  return "连接未完成，请重试。";
}
