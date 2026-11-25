import { readDesktopPrimaryBearerToken } from "../../environments/primary/desktopAuth";
import type { RemoteImChannel } from "../settings/remoteImThemes";

export interface LeaderAwarenessScope {
  readonly kind: "none" | "all_local" | "projects";
  readonly projectIds: readonly string[];
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
}

export interface LeaderListItem {
  readonly leader: LeaderProfile;
  readonly bindings: readonly {
    readonly bindingId: string;
    readonly connectionId: string;
    readonly epoch: number;
  }[];
  readonly connections: readonly LeaderConnectionSummary[];
  readonly needsYouCount: number;
  readonly runningCount: number;
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
  readonly body: string;
  readonly createdAt: number;
}

export interface LeaderOverview {
  readonly leader: LeaderProfile;
  readonly connections: readonly LeaderConnectionSummary[];
  readonly pausedPending: readonly LeaderPausedItem[];
  readonly needsYou: {
    readonly snapshotSequence: number;
    readonly needsYouCount: number;
    readonly runningCount: number;
    readonly completedCount: number;
    readonly failedCount: number;
    readonly pendingApprovalCount: number;
    readonly threads: readonly LeaderScopedThread[];
  };
  readonly approvals: readonly LeaderApprovalItem[];
}

export const LEADER_ROLE_TEMPLATES: readonly {
  readonly id: string;
  readonly label: string;
  readonly prompt: string;
}[] = [
  {
    id: "assistant",
    label: "私人助理",
    prompt: "你是我的日常工作主管。帮我跟进各项任务进展、整理待办与笔记，并在需要我决策时简明直接地提醒我。",
  },
  {
    id: "group",
    label: "群聊帮手",
    prompt: "你在群里负责接单、同步进展和总结讨论。只公开当前群的协作结论，回答简洁清晰。",
  },
  {
    id: "coding",
    label: "编程搭档",
    prompt: "你是我的技术搭档，协助拆解开发任务、跟踪各分支与测试状态，并重点提示风险和阻塞项。",
  },
  {
    id: "translator",
    label: "翻译",
    prompt: "你是双语沟通助手，帮我准确翻译文档、邮件与消息，保持语气自然、术语一致。",
  },
  {
    id: "study",
    label: "学习搭档",
    prompt: "你是我的学习搭档，帮我拆解复杂概念、整理知识卡片并制定循序渐进的练习计划。",
  },
  {
    id: "habit",
    label: "习惯教练",
    prompt: "你是我的习惯教练，帮我跟踪日常目标、复盘卡点并给出可执行的小步调整建议。",
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
    throw new Error(typeof value?.error === "string" ? value.error : "Leader 服务暂不可用。");
  }
  return value as T;
}
