import { readDesktopPrimaryBearerToken } from "../../environments/primary/desktopAuth";
import { useClientSettings } from "../../hooks/useSettings";
import type { RemoteImChannel } from "../settings/remoteImThemes";

export type NavigatorLang = "zh" | "en";

export function useNavigatorLang(): NavigatorLang {
  const language = useClientSettings((settings) => settings.language);
  return language === "en" ? "en" : "zh";
}

export function emitNavigatorsChanged(): void {
  if (typeof window !== "undefined") {
    window.dispatchEvent(new CustomEvent("xtwork:leaders-changed"));
  }
}

export interface LeaderAwarenessScope {
  readonly kind: "none" | "all_local" | "projects";
  readonly projectIds: readonly string[];
}

export type ImDelegationMode = "always_ask" | "scoped_auto" | "deny";
export type ImProgressReportMode = "silent" | "completion_and_blocked" | "phase_summary";

export interface ImAudiencePolicy {
  readonly delegationMode: ImDelegationMode;
  readonly progressReportMode: ImProgressReportMode;
  readonly allowedProjectIds: readonly string[];
}

export interface ImDelegationPolicy {
  readonly ownerDm: ImAudiencePolicy;
  readonly group: ImAudiencePolicy;
}

export const DEFAULT_IM_DELEGATION_POLICY: ImDelegationPolicy = {
  ownerDm: {
    delegationMode: "always_ask",
    progressReportMode: "completion_and_blocked",
    allowedProjectIds: [],
  },
  group: {
    delegationMode: "always_ask",
    progressReportMode: "completion_and_blocked",
    allowedProjectIds: [],
  },
};

export function normalizeImPolicy(policy?: ImDelegationPolicy | null): ImDelegationPolicy {
  if (!policy) return DEFAULT_IM_DELEGATION_POLICY;
  const ownerDmMode: ImDelegationMode =
    policy.ownerDm?.delegationMode === "scoped_auto" || policy.ownerDm?.delegationMode === "deny"
      ? policy.ownerDm.delegationMode
      : "always_ask";
  const groupMode: ImDelegationMode =
    policy.group?.delegationMode === "deny" ? "deny" : "always_ask";
  const normReport = (value?: string): ImProgressReportMode =>
    value === "silent" || value === "phase_summary" || value === "completion_and_blocked"
      ? value
      : "completion_and_blocked";
  return {
    ownerDm: {
      delegationMode: ownerDmMode,
      progressReportMode: normReport(policy.ownerDm?.progressReportMode),
      allowedProjectIds: Array.isArray(policy.ownerDm?.allowedProjectIds)
        ? [...new Set(policy.ownerDm.allowedProjectIds.filter((id) => typeof id === "string" && id.length > 0))]
        : [],
    },
    group: {
      delegationMode: groupMode,
      progressReportMode: normReport(policy.group?.progressReportMode),
      allowedProjectIds: [],
    },
  };
}

export interface LeaderProfile {
  readonly id: string;
  readonly name: string;
  readonly avatar: string;
  readonly role: string;
  readonly status: "active" | "paused" | "archived";
  readonly pinnedThreadId: string | null;
  readonly awarenessScope: LeaderAwarenessScope;
  readonly ownerDmDesktopGrants: readonly string[];
  readonly imPolicy?: ImDelegationPolicy;
  readonly createdAt: number;
  readonly updatedAt: number;
}

export interface LeaderConnectionSummary {
  readonly id?: string;
  readonly platform: RemoteImChannel;
  readonly lifecycleState?: string;
  readonly state?: string;
  readonly paused?: boolean;
  readonly leaderPaused?: boolean;
  readonly botName?: string;
  readonly leaderId?: string;
  readonly bindingId?: string;
  readonly bindingEpoch?: number;
  readonly desiredLeaderId?: string;
  readonly desiredBindingId?: string;
  readonly desiredBindingEpoch?: number;
  readonly syncPending?: boolean;
}

export interface LeaderBindingSummary {
  readonly bindingId: string;
  readonly connectionId: string;
  readonly epoch: number;
  readonly platform?: string | null;
  readonly claimed?: boolean;
}

export interface LeaderListItem {
  readonly leader: LeaderProfile;
  readonly bindings: readonly LeaderBindingSummary[];
  readonly boundPlatforms?: readonly string[];
  readonly connections: readonly LeaderConnectionSummary[];
  readonly needsYouCount: number;
  readonly runningCount: number;
  readonly startingCount?: number;
  readonly waitingCount?: number;
  readonly failedCount?: number;
  readonly completedCount?: number;
  readonly latestCompletedKey?: string | null;
  readonly latestCompletedAtMs?: number | null;
  readonly pendingApprovalCount: number;
  readonly pausedPendingCount: number;
}

export interface LeaderScopedThread {
  readonly threadId: string;
  readonly projectId: string;
  readonly projectTitle: string;
  readonly title: string;
  readonly phase: string;
  readonly headline: string;
  readonly detail?: string;
  readonly replyAudience: "local_only" | "owner_dm" | "group";
  readonly isProtected: boolean;
  readonly updatedAt: string;
  readonly pendingApprovalCount: number;
}

export interface LeaderApprovalItem {
  readonly id: string;
  readonly turnId: string;
  readonly threadId?: string;
  readonly leaderId: string;
  readonly toolName: string;
  readonly replyAudience: "local_only" | "owner_dm" | "group";
  readonly details: string;
  readonly snapshotHash?: string;
  readonly targetScope?: string;
  readonly targetChatId?: string;
  readonly targetChatName?: string;
  readonly contentSnapshot?: string;
  readonly contentPreview?: string;
}

export interface LeaderPausedItem {
  readonly id: string;
  readonly connectionId: string;
  readonly platform: RemoteImChannel;
  readonly chatId: string;
  readonly chatKind: string;
  readonly chatName?: string | null;
  readonly senderName?: string | null;
  readonly idempotencyKey?: string | null;
  readonly leaderId?: string | null;
  readonly bindingId?: string | null;
  readonly bindingEpoch?: number | null;
  readonly body: string;
  readonly createdAt: number;
}

export interface LeaderOverview {
  readonly leader: LeaderProfile;
  readonly bindings?: readonly LeaderBindingSummary[];
  readonly boundPlatforms?: readonly string[];
  readonly connections: readonly LeaderConnectionSummary[];
  readonly pausedPending: readonly LeaderPausedItem[];
  readonly needsYou: {
    readonly snapshotSequence: number;
    readonly needsYouCount: number;
    readonly runningCount: number;
    readonly startingCount?: number;
    readonly waitingCount?: number;
    readonly completedCount: number;
    readonly failedCount: number;
    readonly latestCompletedKey?: string | null;
    readonly latestCompletedAtMs?: number | null;
    readonly pendingApprovalCount: number;
    readonly threads: readonly LeaderScopedThread[];
  };
  readonly approvals: readonly LeaderApprovalItem[];
}

export function navigatorChannelLabel(platform: RemoteImChannel, lang: NavigatorLang): string {
  if (lang === "en") {
    if (platform === "feishu") return "Feishu";
    if (platform === "wecom") return "WeCom";
    if (platform === "wechat") return "WeChat";
    return platform;
  }
  if (platform === "feishu") return "飞书";
  if (platform === "wecom") return "企业微信";
  if (platform === "wechat") return "微信";
  return platform;
}

export const LEADER_ROLE_TEMPLATES: readonly {
  readonly id: string;
  readonly label: string;
  readonly labelEn: string;
  readonly prompt: string;
  readonly promptEn: string;
}[] = [
  {
    id: "assistant",
    label: "私人助理",
    labelEn: "Personal Assistant",
    prompt: "你是我的日常工作领航者。帮我跟进各项任务进展、整理待办与笔记，并在需要我决策时简明直接地提醒我。",
    promptEn: "You are my daily work Navigator. Track task progress, organize todos and notes, and flag decisions concisely when my input is needed.",
  },
  {
    id: "group",
    label: "群聊帮手",
    labelEn: "Group Helper",
    prompt: "你在群里负责接单、同步进展和总结讨论。只公开当前群的协作结论，回答简洁清晰。",
    promptEn: "You handle group requests, sync progress, and summarize discussions. Keep replies concise and limited strictly to the current group context.",
  },
  {
    id: "coding",
    label: "编程搭档",
    labelEn: "Coding Partner",
    prompt: "你是我的技术搭档，协助拆解开发任务、跟踪各分支与测试状态，并重点提示风险和阻塞项。",
    promptEn: "You are my engineering partner. Break down tasks, track branch and test status, and surface risks or blockers early.",
  },
  {
    id: "translator",
    label: "翻译",
    labelEn: "Translator",
    prompt: "你是双语沟通助手，帮我准确翻译文档、邮件与消息，保持语气自然、术语一致。",
    promptEn: "You are a bilingual translator. Translate documents, emails, and messages accurately with consistent terminology and natural tone.",
  },
  {
    id: "study",
    label: "学习搭档",
    labelEn: "Study Partner",
    prompt: "你是我的学习搭档，帮我拆解复杂概念、整理知识卡片并制定循序渐进的练习计划。",
    promptEn: "You are my study partner. Break down complex topics, build structured notes, and create step-by-step practice plans.",
  },
  {
    id: "habit",
    label: "习惯教练",
    labelEn: "Habit Coach",
    prompt: "你是我的习惯教练，帮我跟踪日常目标、复盘卡点并给出可执行的小步调整建议。",
    promptEn: "You are my habit coach. Track daily goals, review friction points, and suggest small actionable adjustments.",
  },
];

export async function leaderRequest<T>(
  path: string,
  payload?: Record<string, unknown>,
  signal?: AbortSignal,
): Promise<T> {
  const token = await readDesktopPrimaryBearerToken();
  if (!token) throw new Error("请先连接本机服务。");
  const res = await fetch(`/api/xtwork/im/${path}`, {
    headers: {
      Authorization: `Bearer ${token}`,
      ...(payload ? { "Content-Type": "application/json" } : {}),
    },
    ...(signal ? { signal } : {}),
    ...(payload ? { method: "POST", body: JSON.stringify(payload) } : {}),
  });
  const value = await res.json();
  if (!res.ok) {
    throw new Error(typeof value?.error === "string" ? value.error : "领航者服务暂不可用。");
  }
  return value as T;
}
