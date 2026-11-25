// @effect-diagnostics nodeBuiltinImport:off
import {
  DEFAULT_CODING_AGENT_SETTING,
  PROVIDER_DISPLAY_NAMES,
  type CodingAgentBlockedReason,
  type CodingAgentSetting,
  type OrchestratorMcpTarget,
  type ProviderInstanceConfig,
  type ProviderInstanceId,
  type ServerProvider,
  type ServerSettings,
  resolveProviderInstanceEnabled,
} from "@t3tools/contracts";
import * as NodePath from "node:path";
import { isImThread, type TurnExecutionContext } from "../im/XtworkImSecurity.ts";
import { PI_INSTANCE_ID } from "./bundledPiSettings.ts";
import {
  CODEBUDDY_CODE_INSTANCE_ID,
  DEEPSEEK_HARNESS_INSTANCE_ID,
  KIMI_CODE_INSTANCE_ID,
  QODER_INSTANCE_ID,
} from "./codingAgentSeed.ts";

export const CODING_AGENT_UNAVAILABLE_CODE = "coding_agent_unavailable" as const;
export const IM_DELEGATION_DENIED_CODE = "delegation_denied_in_im" as const;

export const ONE_TURN_BUILTIN_XIAOTONG_INSTRUCTION_ZH =
  "仅本次请直接由内置「小瞳」在当前对话模型上继续完成这项任务，不要调用 delegate_task，也不要修改我的全局 Coding Agent 设置。";

export const ONE_TURN_BUILTIN_XIAOTONG_INSTRUCTION_EN =
  "For this turn only, continue and complete this task directly with built-in Xiaotong on the current conversation model. Do not call delegate_task and do not change my global Coding Agent setting.";

const KNOWN_CODING_AGENT_LABELS: Readonly<Record<string, string>> = {
  claudeAgent: "Claude Code",
  codex: "Codex",
  [KIMI_CODE_INSTANCE_ID]: "Kimi Code",
  [QODER_INSTANCE_ID]: "Qoder",
  [CODEBUDDY_CODE_INSTANCE_ID]: "Codebuddy Code",
  [DEEPSEEK_HARNESS_INSTANCE_ID]: "DeepSeek Harness",
};

const KNOWN_PROVISIONABLE_INSTANCE_IDS: ReadonlySet<string> = new Set([
  "claudeAgent",
  "codex",
  KIMI_CODE_INSTANCE_ID,
  QODER_INSTANCE_ID,
  CODEBUDDY_CODE_INSTANCE_ID,
  DEEPSEEK_HARNESS_INSTANCE_ID,
]);

export interface CodingAgentUnavailableResult {
  readonly blocked: true;
  readonly code: typeof CODING_AGENT_UNAVAILABLE_CODE;
  readonly reason: CodingAgentBlockedReason;
  readonly instanceId: ProviderInstanceId;
  readonly displayName: string;
  readonly canInstall: boolean;
  readonly canLogin: boolean;
  readonly message: string;
}

export interface ImDelegationBlockedResult {
  readonly blocked: true;
  readonly code: typeof IM_DELEGATION_DENIED_CODE;
  readonly reason: string;
  readonly message: string;
}

export type ExternalDelegationThreadCheck =
  | { readonly blocked: false }
  | ImDelegationBlockedResult;

export type CodingAgentReadiness =
  | {
      readonly ready: true;
      readonly instanceId: ProviderInstanceId;
      readonly displayName: string;
      readonly provider: ServerProvider;
    }
  | {
      readonly ready: false;
      readonly blocked: CodingAgentUnavailableResult;
    };

export type ResolveCodingAgentTargetResult =
  | { readonly kind: "passthrough" }
  | { readonly kind: "blocked"; readonly result: CodingAgentUnavailableResult }
  | {
      readonly kind: "routed";
      readonly target: OrchestratorMcpTarget;
      readonly lockedInstanceId: ProviderInstanceId;
      readonly displayName: string;
      readonly overriddenExternalTarget: boolean;
    };

export type DelegationWorkspaceKind = "git" | "non_git" | "scratch";

export type DelegationWorkspaceValidation =
  | {
      readonly allowed: true;
      readonly effectiveIsolation: "shared" | "worktree";
      readonly workspaceKind: DelegationWorkspaceKind;
      readonly isScratch: boolean;
    }
  | {
      readonly allowed: false;
      readonly reason:
        | "scratch_worktree_unsupported"
        | "non_git_worktree_unsupported"
        | "commit_outside_project";
      readonly workspaceKind: DelegationWorkspaceKind;
      readonly isScratch: boolean;
      readonly message: string;
    };

/**
 * Normalizes the persisted `codingAgent` setting so built-in `xtworkPi` or malformed
 * values always collapse cleanly to `{ mode: "auto" }`.
 */
export function normalizeCodingAgentSetting(
  setting: CodingAgentSetting | null | undefined,
): CodingAgentSetting {
  if (!setting || setting.mode !== "provider") {
    return DEFAULT_CODING_AGENT_SETTING;
  }
  const rawInstanceId = typeof setting.instanceId === "string" ? setting.instanceId.trim() : "";
  if (rawInstanceId.length === 0 || rawInstanceId === PI_INSTANCE_ID) {
    return DEFAULT_CODING_AGENT_SETTING;
  }
  const trimmedModel = typeof setting.model === "string" ? setting.model.trim() : "";
  return {
    mode: "provider",
    instanceId: rawInstanceId as ProviderInstanceId,
    ...(trimmedModel.length > 0 ? { model: trimmedModel } : {}),
  };
}

export function resolveCodingAgentDisplayName(input: {
  readonly instanceId: string;
  readonly provider?: ServerProvider | undefined;
  readonly instanceConfig?: ProviderInstanceConfig | undefined;
}): string {
  const fromProvider = input.provider?.displayName?.trim();
  if (fromProvider) return fromProvider;
  const fromConfig = input.instanceConfig?.displayName?.trim();
  if (fromConfig) return fromConfig;
  const known = KNOWN_CODING_AGENT_LABELS[input.instanceId];
  if (known) return known;
  const driver = input.provider?.driver ?? input.instanceConfig?.driver;
  if (driver && Object.hasOwn(PROVIDER_DISPLAY_NAMES, driver)) {
    return PROVIDER_DISPLAY_NAMES[driver as keyof typeof PROVIDER_DISPLAY_NAMES] ?? input.instanceId;
  }
  return input.instanceId;
}

function isProvisionableInstance(
  instanceId: string,
  provider?: ServerProvider,
  instanceConfig?: ProviderInstanceConfig,
): boolean {
  if (KNOWN_PROVISIONABLE_INSTANCE_IDS.has(instanceId)) return true;
  if (provider?.setup?.canInstall === true) return true;
  const driver = provider?.driver ?? instanceConfig?.driver;
  if (driver === "claudeAgent" || driver === "codex") return true;
  if (driver === "acpRegistry" && instanceConfig?.config && typeof instanceConfig.config === "object") {
    const config = instanceConfig.config as Record<string, unknown>;
    if (
      config.source !== "local" &&
      typeof config.agentId === "string" &&
      config.agentId.trim().length > 0
    ) {
      return true;
    }
    if (config.source === "local" && typeof config.commandPath === "string") {
      const base = config.commandPath.trim().split(/[\\/]/u).pop() ?? "";
      return base === "dsh" || base === "dsh.exe" || base === "dsh.cmd";
    }
  }
  return false;
}

function supportsAuthentication(
  provider?: ServerProvider,
  instanceConfig?: ProviderInstanceConfig,
): boolean {
  if (provider?.setup?.canAuthenticate === true) return true;
  const driver = provider?.driver ?? instanceConfig?.driver;
  return driver === "claudeAgent" || driver === "codex" || driver === "acpRegistry";
}

function detectsUpdateRequired(
  provider: ServerProvider,
  requestedModel?: string | undefined,
): boolean {
  if (
    requestedModel !== undefined &&
    provider.updateRequiredModels?.some((candidate) => candidate.slug === requestedModel)
  ) {
    return true;
  }
  if (
    provider.compatibilityAdvisory?.status === "unsupported" ||
    provider.compatibilityAdvisory?.status === "broken"
  ) {
    return true;
  }
  const message = provider.message?.toLowerCase() ?? "";
  if (
    provider.status === "warning" &&
    provider.installed &&
    (message.includes("update_required") ||
      (message.includes("update") && message.includes("confirm")) ||
      message.includes("confirm in provider settings to update"))
  ) {
    return true;
  }
  return false;
}

export function assessCodingAgentReadiness(input: {
  readonly instanceId: ProviderInstanceId;
  readonly providers: ReadonlyArray<ServerProvider>;
  readonly providerInstances?: ServerSettings["providerInstances"] | undefined;
  readonly orchestrationCapableInstanceIds?: ReadonlySet<ProviderInstanceId> | undefined;
  readonly isEnabledForProject?: ((instanceId: ProviderInstanceId) => boolean) | undefined;
  readonly requestedModel?: string | undefined;
}): CodingAgentReadiness {
  const instanceId = input.instanceId;
  const provider = input.providers.find((candidate) => candidate.instanceId === instanceId);
  const instanceConfig =
    input.providerInstances && Object.hasOwn(input.providerInstances, instanceId)
      ? input.providerInstances[instanceId]
      : undefined;
  const displayName = resolveCodingAgentDisplayName({
    instanceId,
    provider,
    instanceConfig,
  });
  const canInstall = isProvisionableInstance(instanceId, provider, instanceConfig);
  const canLogin = supportsAuthentication(provider, instanceConfig);

  const makeBlocked = (
    reason: CodingAgentBlockedReason,
    message: string,
    overrides?: { readonly canInstall?: boolean; readonly canLogin?: boolean },
  ): CodingAgentReadiness => ({
    ready: false,
    blocked: {
      blocked: true,
      code: CODING_AGENT_UNAVAILABLE_CODE,
      reason,
      instanceId,
      displayName,
      canInstall: overrides?.canInstall ?? false,
      canLogin: overrides?.canLogin ?? false,
      message,
    },
  });

  if (provider === undefined) {
    if (instanceConfig !== undefined && !resolveProviderInstanceEnabled(instanceConfig)) {
      return makeBlocked(
        "disabled",
        `Configured Coding Agent "${displayName}" (${instanceId}) is disabled. Enable it in Settings → Providers or use built-in 小瞳 for this turn.`,
      );
    }
    return makeBlocked(
      "not_found",
      `Configured Coding Agent "${displayName}" (${instanceId}) is not available on this environment. Check Settings → Providers or use built-in 小瞳 for this turn.`,
      { canInstall },
    );
  }

  const projectEnabled = input.isEnabledForProject ? input.isEnabledForProject(instanceId) : true;
  if (!provider.enabled || provider.status === "disabled" || !projectEnabled) {
    return makeBlocked(
      "disabled",
      `Configured Coding Agent "${displayName}" (${instanceId}) is disabled. Enable it in Settings → Providers or use built-in 小瞳 for this turn.`,
    );
  }

  if (!provider.installed) {
    return makeBlocked(
      "not_installed",
      `Configured Coding Agent "${displayName}" (${instanceId}) is not installed or has not received install consent. Install it from Settings → Providers or use built-in 小瞳 for this turn.`,
      { canInstall: true },
    );
  }

  if (detectsUpdateRequired(provider, input.requestedModel)) {
    return makeBlocked(
      "update_required",
      provider.message ??
        `Configured Coding Agent "${displayName}" (${instanceId}) requires a confirmed update in Settings → Providers before running.`,
      {
        canInstall:
          canInstall ||
          provider.setup?.canInstall === true ||
          provider.versionAdvisory?.canInstallVersion === true,
      },
    );
  }

  if (provider.auth.status === "unauthenticated") {
    return makeBlocked(
      "not_authenticated",
      `Configured Coding Agent "${displayName}" (${instanceId}) is not signed in. Sign in from Settings → Providers or use built-in 小瞳 for this turn.`,
      { canLogin: true },
    );
  }

  if (
    provider.availability === "unavailable" ||
    (input.orchestrationCapableInstanceIds !== undefined &&
      !input.orchestrationCapableInstanceIds.has(instanceId))
  ) {
    return makeBlocked(
      "not_found",
      provider.unavailableReason ??
        `Configured Coding Agent "${displayName}" (${instanceId}) cannot run delegated tasks on this server.`,
      { canInstall },
    );
  }

  if (provider.status === "error") {
    return makeBlocked(
      "unavailable",
      provider.message ??
        `Configured Coding Agent "${displayName}" (${instanceId}) is currently unavailable.`,
      { canInstall, canLogin },
    );
  }

  return {
    ready: true,
    instanceId,
    displayName,
    provider,
  };
}

/**
 * Deterministic target resolution for `delegate_task` when built-in「小瞳」(`xtworkPi`)
 * runs with `codingAgent.mode === "provider"` (ADR-012 §5.1).
 *
 * Never silently switches to another external Coding Agent and never triggers installs.
 */
export function resolveCodingAgentTarget(input: {
  readonly codingAgent: CodingAgentSetting | undefined;
  readonly callerInstanceId: ProviderInstanceId;
  readonly requestedTarget?: OrchestratorMcpTarget | undefined;
  readonly requestedRole?: string | undefined;
  readonly providers: ReadonlyArray<ServerProvider>;
  readonly providerInstances?: ServerSettings["providerInstances"] | undefined;
  readonly orchestrationCapableInstanceIds?: ReadonlySet<ProviderInstanceId> | undefined;
  readonly isEnabledForProject?: ((instanceId: ProviderInstanceId) => boolean) | undefined;
}): ResolveCodingAgentTargetResult {
  if (input.callerInstanceId !== PI_INSTANCE_ID) {
    return { kind: "passthrough" };
  }
  const normalized = normalizeCodingAgentSetting(input.codingAgent);
  if (normalized.mode !== "provider") {
    return { kind: "passthrough" };
  }

  // Allow an explicit non-coding general/research subagent on built-in `xtworkPi`,
  // while keeping all omitted or external-provider delegations strictly locked to `codingAgent.instanceId`.
  if (
    input.requestedTarget?.providerInstanceId === PI_INSTANCE_ID &&
    input.requestedTarget.driverKind === undefined &&
    (input.requestedRole === "general" || input.requestedRole === "research")
  ) {
    return { kind: "passthrough" };
  }

  const lockedInstanceId = normalized.instanceId;
  const lockedProvider = input.providers.find(
    (candidate) => candidate.instanceId === lockedInstanceId,
  );
  const requestedExternalMismatch =
    (input.requestedTarget?.providerInstanceId !== undefined &&
      input.requestedTarget.providerInstanceId !== lockedInstanceId) ||
    (input.requestedTarget?.driverKind !== undefined &&
      lockedProvider !== undefined &&
      input.requestedTarget.driverKind !== lockedProvider.driver);

  const requestedModel = requestedExternalMismatch
    ? normalized.model
    : (input.requestedTarget?.model ?? normalized.model);

  const readiness = assessCodingAgentReadiness({
    instanceId: lockedInstanceId,
    providers: input.providers,
    providerInstances: input.providerInstances,
    orchestrationCapableInstanceIds: input.orchestrationCapableInstanceIds,
    isEnabledForProject: input.isEnabledForProject,
    requestedModel,
  });

  if (!readiness.ready) {
    return { kind: "blocked", result: readiness.blocked };
  }

  const sanitizedOptions = requestedExternalMismatch ? undefined : input.requestedTarget?.options;
  const target: OrchestratorMcpTarget = {
    ...(input.requestedTarget?.projectId === undefined
      ? {}
      : { projectId: input.requestedTarget.projectId }),
    ...(input.requestedTarget?.environmentId === undefined
      ? {}
      : { environmentId: input.requestedTarget.environmentId }),
    providerInstanceId: lockedInstanceId,
    ...(requestedModel === undefined ? {} : { model: requestedModel }),
    ...(sanitizedOptions === undefined ? {} : { options: sanitizedOptions }),
  };

  return {
    kind: "routed",
    target,
    lockedInstanceId,
    displayName: readiness.displayName,
    overriddenExternalTarget: requestedExternalMismatch,
  };
}

/**
 * ADR-012 §5.4 hard-deny guard: ANY IM-originated thread, protected Xtwork thread,
 * or `group` / `owner_dm` IM execution context is strictly forbidden from delegating
 * to external Coding CLIs even when desktop `codingAgent.mode === "provider"` is set.
 */
export function isExternalDelegationBlockedForThread(input: {
  readonly threadId?: string | null | undefined;
  readonly isProtectedThread?: boolean | undefined;
  readonly executionContext?:
    | Pick<TurnExecutionContext, "source" | "replyAudience">
    | null
    | undefined;
}): ExternalDelegationThreadCheck {
  const threadId = input.threadId?.trim();
  const isImById = Boolean(threadId && isImThread(threadId));
  const isImSource = input.executionContext?.source === "im";
  const isGroupAudience = input.executionContext?.replyAudience === "group";
  const isImAudience =
    input.executionContext?.replyAudience === "group" ||
    input.executionContext?.replyAudience === "owner_dm";

  if (!isImById && input.isProtectedThread !== true && !isImSource && !isImAudience) {
    return { blocked: false };
  }

  const reason = isGroupAudience
    ? "group_audience_forbidden"
    : isImById || isImSource || isImAudience
      ? "im_thread_forbidden"
      : "protected_thread_forbidden";

  return {
    blocked: true,
    code: IM_DELEGATION_DENIED_CODE,
    reason,
    message:
      "External Coding Agent delegation is blocked for IM and group turns (ADR-012 §5.4). Complete the task directly with built-in 小瞳 or start external Coding Agent delegation from the desktop app.",
  };
}

function isPathInsideOrEqual(candidate: string | null | undefined, root: string | null | undefined): boolean {
  if (!candidate || !root) return false;
  const resolvedCandidate = NodePath.resolve(candidate);
  const resolvedRoot = NodePath.resolve(root);
  const rel = NodePath.relative(resolvedRoot, resolvedCandidate);
  return (
    rel === "" ||
    (!NodePath.isAbsolute(rel) && rel !== ".." && !rel.startsWith(`..${NodePath.sep}`))
  );
}

function looksLikeScratchWorkspacePath(workspacePath: string | null | undefined): boolean {
  if (!workspacePath) return false;
  const normalized = NodePath.resolve(workspacePath).replaceAll("\\", "/");
  return normalized.endsWith("/scratch") || normalized.includes("/scratch/");
}

/**
 * ADR-012 §5.2 workspace contract:
 * - `isolation: "shared"` (or omitted) works on Git repos, non-Git folders, and project-less `scratch/`.
 * - `isolation: "worktree"` requires a valid non-scratch Git repository with a valid HEAD commit;
 *   refuses non-Git folders and `scratch/` with clear actionable guidance to retry with `isolation: "shared"`.
 */
export function validateDelegationWorkspace(input: {
  readonly isolation: "shared" | "worktree" | undefined;
  readonly projectWorkspaceRoot?: string | null | undefined;
  readonly parentWorktreePath?: string | null | undefined;
  readonly isScratchProject?: boolean | undefined;
  readonly scratchRoot?: string | null | undefined;
  readonly projectTitle?: string | undefined;
  readonly hasValidGitHead: boolean;
  readonly projectContainsHeadCommit?: boolean | undefined;
}): DelegationWorkspaceValidation {
  const effectiveCwd = input.parentWorktreePath ?? input.projectWorkspaceRoot ?? null;
  const isScratch =
    input.isScratchProject === true ||
    isPathInsideOrEqual(effectiveCwd, input.scratchRoot) ||
    isPathInsideOrEqual(input.projectWorkspaceRoot, input.scratchRoot) ||
    (input.projectTitle === "No project" &&
      (looksLikeScratchWorkspacePath(input.projectWorkspaceRoot) ||
        looksLikeScratchWorkspacePath(effectiveCwd)));

  const workspaceKind: DelegationWorkspaceKind = isScratch
    ? "scratch"
    : input.hasValidGitHead
      ? "git"
      : "non_git";

  if (input.isolation !== "worktree") {
    return {
      allowed: true,
      effectiveIsolation: "shared",
      workspaceKind,
      isScratch,
    };
  }

  if (isScratch) {
    return {
      allowed: false,
      reason: "scratch_worktree_unsupported",
      workspaceKind,
      isScratch: true,
      message:
        'Isolation "worktree" is not available in a project-less scratch/ workspace. Retry delegate_task with isolation: "shared" to work directly in this scratch folder.',
    };
  }

  if (!input.hasValidGitHead) {
    return {
      allowed: false,
      reason: "non_git_worktree_unsupported",
      workspaceKind,
      isScratch: false,
      message:
        'Isolation "worktree" requires a Git repository with a valid HEAD commit, but the current workspace is a non-Git folder or has no commits yet. Retry delegate_task with isolation: "shared".',
    };
  }

  if (input.parentWorktreePath != null && input.projectContainsHeadCommit === false) {
    const projectLabel = input.projectTitle
      ? `project "${input.projectTitle}" (${input.projectWorkspaceRoot ?? "unknown"})`
      : `the project root (${input.projectWorkspaceRoot ?? "unknown"})`;
    return {
      allowed: false,
      reason: "commit_outside_project",
      workspaceKind,
      isScratch: false,
      message: `Isolation "worktree" creates the child checkout in ${projectLabel}, which does not contain the parent checkout's commit. Retry delegate_task with isolation: "shared" to work in the parent's checkout.`,
    };
  }

  return {
    allowed: true,
    effectiveIsolation: "worktree",
    workspaceKind: "git",
    isScratch: false,
  };
}

/**
 * Generates concise runtime delegation instructions for built-in「小瞳」(`xtworkPi`)
 * ONLY on non-IM desktop turns when `codingAgent.mode === "provider"` (ADR-012 §5.1–§5.4).
 */
export function buildCodingAgentDelegationInstructions(input: {
  readonly codingAgent: CodingAgentSetting | undefined;
  readonly callerInstanceId: ProviderInstanceId;
  readonly threadId?: string | null | undefined;
  readonly isProtectedThread?: boolean | undefined;
  readonly executionContext?:
    | Pick<TurnExecutionContext, "source" | "replyAudience">
    | null
    | undefined;
  readonly displayName?: string | undefined;
  readonly workspaceKind?: DelegationWorkspaceKind | undefined;
}): string {
  if (input.callerInstanceId !== PI_INSTANCE_ID) {
    return "";
  }
  const threadGuard = isExternalDelegationBlockedForThread({
    threadId: input.threadId,
    isProtectedThread: input.isProtectedThread,
    executionContext: input.executionContext,
  });
  if (threadGuard.blocked) {
    return "";
  }
  const normalized = normalizeCodingAgentSetting(input.codingAgent);
  if (normalized.mode !== "provider") {
    return "";
  }
  const displayName =
    input.displayName?.trim() ||
    resolveCodingAgentDisplayName({ instanceId: normalized.instanceId });
  const targetSpec = normalized.model
    ? `target: { providerInstanceId: "${normalized.instanceId}", model: "${normalized.model}" }`
    : `target: { providerInstanceId: "${normalized.instanceId}" }`;
  const workspaceHint =
    input.workspaceKind === "scratch"
      ? 'This thread runs in a project-less scratch/ workspace: you MUST pass isolation: "shared" (never "worktree").'
      : input.workspaceKind === "non_git"
        ? 'This thread runs in a non-Git workspace: you MUST pass isolation: "shared" (never "worktree").'
        : 'Use isolation: "shared" for non-Git or project-less scratch/ workspaces; use isolation: "worktree" only when the workspace is a Git repository with a valid HEAD and isolated checkout is needed.';

  return [
    "<coding_agent_delegation>",
    `The user selected external Coding Agent "${displayName}" (${normalized.instanceId}) for coding tasks.`,
    "- Keep general Q&A, todos, schedules, notes, plugins, and browser research inside built-in 小瞳 (do not delegate those).",
    `- For coding, debugging, refactoring, test fixes, or repository modifications, delegate via \`delegate_task\` with ${targetSpec}. Never silently substitute a different external Coding Agent.`,
    "- Exception: if the user explicitly asks in this turn to use built-in 小瞳 directly for this turn only, handle the task directly without calling `delegate_task`.",
    "- If `delegate_task` returns `coding_agent_unavailable`, stop and report the reason concisely without trying another external agent (the user can click the inline Install/Sign-in or one-turn built-in 小瞳 buttons).",
    `- Workspace rule: ${workspaceHint}`,
    "- Because `delegate_task` starts a child without parent chat history or attachments, structure every `task` brief with these 5 sections:",
    "  1. Goal & Acceptance Criteria: exact objective and how to verify success.",
    "  2. Constraints & Scope: boundaries, untouched files, and uncommitted-change rules.",
    "  3. File/Attachment Paths: exact workspace-relative or absolute paths for relevant files and attachments.",
    "  4. Privacy/Secret Redaction: exclude unrelated personal chat history, secrets, API keys, and full todo lists.",
    "  5. Verification Summary: require the child to report edited files, verification commands run, and remaining risks.",
    "</coding_agent_delegation>",
  ].join("\n");
}
