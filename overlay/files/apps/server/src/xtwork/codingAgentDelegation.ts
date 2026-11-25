// @effect-diagnostics nodeBuiltinImport:off
import {
  DEFAULT_CODING_AGENT_SETTING,
  PROVIDER_DISPLAY_NAMES,
  ThreadId,
  type CodingAgentBlockedReason,
  type CodingAgentSetting,
  type CodingAgentTurnOverride,
  type OrchestratorMcpTarget,
  type ProviderInstanceConfig,
  type ProviderInstanceId,
  type ServerProvider,
  type ServerSettings,
  resolveProviderInstanceEnabled,
} from "@t3tools/contracts";
import * as Effect from "effect/Effect";
import * as NodeFS from "node:fs";
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
export const CODING_AGENT_BUILTIN_ONCE_CODE = "coding_agent_builtin_once" as const;
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

const MAX_ANCESTRY_HOPS = 64;

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

export interface CodingAgentBuiltinOnceBlockedResult {
  readonly blocked: true;
  readonly code: typeof CODING_AGENT_BUILTIN_ONCE_CODE;
  readonly message: string;
}

export interface CodingAgentRemoteBlockedResult {
  readonly blocked: true;
  readonly code: "invalid_request";
  readonly instanceId: ProviderInstanceId;
  readonly displayName: string;
  readonly message: string;
}

export interface ImDelegationBlockedResult {
  readonly blocked: true;
  readonly code: typeof IM_DELEGATION_DENIED_CODE;
  readonly reason: string;
  readonly blockedAncestorThreadId?: string;
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
  | { readonly kind: "builtin_once"; readonly result: CodingAgentBuiltinOnceBlockedResult }
  | { readonly kind: "remote_blocked"; readonly result: CodingAgentRemoteBlockedResult }
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

export type HandoffBriefSectionKey = "goal" | "constraints" | "files";

export type HandoffBriefValidation =
  | { readonly valid: true }
  | {
      readonly valid: false;
      readonly missingSections: ReadonlyArray<HandoffBriefSectionKey>;
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
  if (
    driver === "acpRegistry" &&
    instanceConfig?.config &&
    typeof instanceConfig.config === "object"
  ) {
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
    const advisory = provider.versionAdvisory;
    const versionDetail =
      advisory?.status === "behind_latest" && advisory.latestVersion
        ? ` (latest v${advisory.latestVersion}${advisory.currentVersion ? `, installed v${advisory.currentVersion}` : ""})`
        : "";
    return makeBlocked(
      "update_required",
      advisory?.message ??
        provider.message ??
        `Configured Coding Agent "${displayName}" (${instanceId}) requires a confirmed update${versionDetail} in Settings → Providers before running.`,
      {
        canInstall:
          canInstall ||
          provider.setup?.canInstall === true ||
          advisory?.canUpdate === true ||
          advisory?.canInstallVersion === true,
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
 * runs with `codingAgent.mode === "provider"` or a server-side `builtin_once` turn override (ADR-012 §5.1).
 *
 * Never silently switches to another external Coding Agent, never lets remote environment
 * delegation bypass the configured local Coding Agent, and never triggers silent installs.
 */
export function resolveCodingAgentTarget(input: {
  readonly codingAgent: CodingAgentSetting | undefined;
  readonly callerInstanceId: ProviderInstanceId;
  readonly codingAgentOverride?: CodingAgentTurnOverride | undefined;
  readonly isRemoteEnvironmentTarget?: boolean | undefined;
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

  // Server-side one-turn override (`[仅本次改用内置小瞳]`): deterministically block delegation
  // on this single turn so built-in 小瞳 handles the task directly without mutating global settings.
  if (input.codingAgentOverride === "builtin_once") {
    return {
      kind: "builtin_once",
      result: {
        blocked: true,
        code: CODING_AGENT_BUILTIN_ONCE_CODE,
        message:
          "This turn is locked to built-in 小瞳 (`codingAgentOverride: 'builtin_once'`). Complete the task directly on the current built-in model without calling `delegate_task`; your global Coding Agent setting remains unchanged for subsequent turns.",
      },
    };
  }

  const normalized = normalizeCodingAgentSetting(input.codingAgent);
  if (normalized.mode !== "provider") {
    return { kind: "passthrough" };
  }

  // Allow an explicit non-coding local general/research subagent on built-in `xtworkPi`,
  // while keeping all remote, omitted, or external-provider delegations strictly locked to `codingAgent.instanceId`.
  if (
    input.isRemoteEnvironmentTarget !== true &&
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

  // Remote environment delegation must NEVER bypass the configured local Coding Agent or
  // silently route to another provider/machine.
  if (input.isRemoteEnvironmentTarget === true) {
    return {
      kind: "remote_blocked",
      result: {
        blocked: true,
        code: "invalid_request",
        instanceId: lockedInstanceId,
        displayName: readiness.displayName,
        message: `Remote environment delegation is blocked while local Coding Agent "${readiness.displayName}" (${lockedInstanceId}) is configured. Omit target.environmentId to delegate locally to "${readiness.displayName}", or switch Coding Agent to auto in Settings → Providers.`,
      },
    };
  }

  const sanitizedOptions = requestedExternalMismatch ? undefined : input.requestedTarget?.options;
  const target: OrchestratorMcpTarget = {
    ...(input.requestedTarget?.projectId === undefined
      ? {}
      : { projectId: input.requestedTarget.projectId }),
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
 * or `group` / `owner_dm` IM execution context — including any prefixless derived child thread
 * descending from an IM/protected ancestor — is strictly forbidden from delegating
 * to external Coding CLIs even when desktop `codingAgent.mode === "provider"` is set.
 */
export function isExternalDelegationBlockedForThread(input: {
  readonly threadId?: string | null | undefined;
  readonly isProtectedThread?: boolean | undefined;
  readonly executionContext?:
    | Pick<TurnExecutionContext, "source" | "replyAudience">
    | null
    | undefined;
  readonly ancestorThreadIds?: ReadonlyArray<string> | undefined;
  readonly isAncestorProtected?: ((ancestorThreadId: string) => boolean) | undefined;
  readonly getAncestorExecutionContext?:
    | ((ancestorThreadId: string) => Pick<TurnExecutionContext, "source" | "replyAudience"> | null | undefined)
    | undefined;
}): ExternalDelegationThreadCheck {
  const checkSingle = (
    candidateId: string | null | undefined,
    isProtected: boolean,
    executionContext: Pick<TurnExecutionContext, "source" | "replyAudience"> | null | undefined,
  ): ImDelegationBlockedResult | null => {
    const trimmed = candidateId?.trim();
    const isImById = Boolean(trimmed && isImThread(trimmed));
    const isImSource = executionContext?.source === "im";
    const isGroupAudience = executionContext?.replyAudience === "group";
    const isImAudience =
      executionContext?.replyAudience === "group" ||
      executionContext?.replyAudience === "owner_dm";

    if (!isImById && !isProtected && !isImSource && !isImAudience) {
      return null;
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
  };

  const direct = checkSingle(
    input.threadId,
    input.isProtectedThread === true,
    input.executionContext,
  );
  if (direct !== null) {
    return direct;
  }

  if (input.ancestorThreadIds) {
    const seen = new Set<string>();
    const selfId = input.threadId?.trim();
    if (selfId) seen.add(selfId);
    for (const rawAncestorId of input.ancestorThreadIds) {
      const ancestorId = rawAncestorId.trim();
      if (ancestorId.length === 0 || seen.has(ancestorId)) continue;
      seen.add(ancestorId);
      const ancestorResult = checkSingle(
        ancestorId,
        input.isAncestorProtected?.(ancestorId) === true,
        input.getAncestorExecutionContext?.(ancestorId),
      );
      if (ancestorResult !== null) {
        return {
          ...ancestorResult,
          blockedAncestorThreadId: ancestorId,
        };
      }
    }
  }

  return { blocked: false };
}

export interface ThreadLineageRef {
  readonly parentThreadId?: ThreadId | null | undefined;
  readonly rootThreadId?: ThreadId | null | undefined;
}

/**
 * Walks `parentThreadId`/`rootThreadId` ancestry with cycle detection (ADR-012 §5.4).
 * Fails closed on lineage lookup errors or when unvisited ancestors remain past the hop limit.
 */
export const checkExternalDelegationAncestry = Effect.fn(
  "codingAgentDelegation.checkExternalDelegationAncestry",
)(function* <E = never>(input: {
  readonly threadId?: string | null | undefined;
  readonly initialLineage?: ThreadLineageRef | null | undefined;
  readonly isProtectedThread: (threadId: string) => boolean;
  readonly getProtectedContext?:
    | ((threadId: string) => Pick<TurnExecutionContext, "source" | "replyAudience"> | undefined)
    | undefined;
  readonly executionContext?:
    | Pick<TurnExecutionContext, "source" | "replyAudience">
    | null
    | undefined;
  readonly loadThreadLineage: (
    threadId: ThreadId,
  ) => Effect.Effect<ThreadLineageRef | null, E>;
}): Effect.fn.Return<ExternalDelegationThreadCheck> {
  const failClosedAncestry = (
    reason: "ancestry_lookup_failed" | "ancestry_depth_exceeded",
    ancestorId: string | undefined,
  ): ImDelegationBlockedResult => ({
    blocked: true,
    code: IM_DELEGATION_DENIED_CODE,
    reason,
    ...(ancestorId ? { blockedAncestorThreadId: ancestorId } : {}),
    message:
      reason === "ancestry_depth_exceeded"
        ? "External Coding Agent delegation is blocked because thread ancestry depth exceeded the verification limit (ADR-012 §5.4 fail-closed)."
        : "External Coding Agent delegation is blocked because thread ancestry could not be verified (ADR-012 §5.4 fail-closed).",
  });

  const lookupLineageSafely = (tid: string) =>
    input.loadThreadLineage(ThreadId.make(tid)).pipe(
      Effect.matchCause({
        onSuccess: (lineage) => ({ ok: true as const, lineage }),
        onFailure: () => ({ ok: false as const }),
      }),
    );

  const currentId = input.threadId?.trim();
  const direct = isExternalDelegationBlockedForThread({
    threadId: currentId,
    isProtectedThread: currentId ? input.isProtectedThread(currentId) : false,
    executionContext:
      input.executionContext ?? (currentId ? input.getProtectedContext?.(currentId) : undefined),
  });
  if (direct.blocked) {
    return direct;
  }

  const visited = new Set<string>();
  if (currentId) {
    visited.add(currentId);
  }

  const queue: Array<string> = [];
  const enqueue = (candidate: string | null | undefined) => {
    const trimmed = candidate?.trim();
    if (trimmed && !visited.has(trimmed)) {
      queue.push(trimmed);
    }
  };

  if (input.initialLineage === null) {
    return failClosedAncestry("ancestry_lookup_failed", currentId);
  }
  if (input.initialLineage !== undefined) {
    enqueue(input.initialLineage.parentThreadId);
    enqueue(input.initialLineage.rootThreadId);
  } else if (currentId) {
    const selfLookup = yield* lookupLineageSafely(currentId);
    if (!selfLookup.ok || selfLookup.lineage === null) {
      return failClosedAncestry("ancestry_lookup_failed", currentId);
    }
    enqueue(selfLookup.lineage.parentThreadId);
    enqueue(selfLookup.lineage.rootThreadId);
  }

  let hops = 0;
  while (queue.length > 0 && hops < MAX_ANCESTRY_HOPS) {
    const ancestorId = queue.shift()!;
    if (visited.has(ancestorId)) continue;
    visited.add(ancestorId);
    hops += 1;

    const ancestorCheck = isExternalDelegationBlockedForThread({
      threadId: ancestorId,
      isProtectedThread: input.isProtectedThread(ancestorId),
      executionContext: input.getProtectedContext?.(ancestorId),
    });
    if (ancestorCheck.blocked) {
      return {
        ...ancestorCheck,
        blockedAncestorThreadId: ancestorId,
      };
    }

    const ancestorLookup = yield* lookupLineageSafely(ancestorId);
    if (!ancestorLookup.ok || ancestorLookup.lineage === null) {
      return failClosedAncestry("ancestry_lookup_failed", ancestorId);
    }
    enqueue(ancestorLookup.lineage.parentThreadId);
    enqueue(ancestorLookup.lineage.rootThreadId);
  }

  const remainingUnvisited = queue.find((candidate) => !visited.has(candidate));
  if (remainingUnvisited !== undefined) {
    return failClosedAncestry("ancestry_depth_exceeded", remainingUnvisited);
  }

  return { blocked: false };
});

/**
 * Canonicalizes a filesystem path via `fs.realpathSync`, falling back to canonicalizing
 * the nearest existing ancestor and re-joining remaining path segments when the leaf
 * does not exist yet. Closes symlink traversal bypasses for `scratch/` detection.
 */
export function canonicalizeFilesystemPath(targetPath: string): string {
  const resolved = NodePath.resolve(targetPath);
  const realpath = NodeFS.realpathSync.native ?? NodeFS.realpathSync;
  try {
    return realpath(resolved);
  } catch {
    const trailingSegments: Array<string> = [];
    let current = resolved;
    while (true) {
      const parent = NodePath.dirname(current);
      if (parent === current) {
        return resolved;
      }
      trailingSegments.unshift(NodePath.basename(current));
      current = parent;
      try {
        const canonicalAncestor = realpath(current);
        return NodePath.join(canonicalAncestor, ...trailingSegments);
      } catch {
        // Continue walking up to the nearest existing ancestor.
      }
    }
  }
}

function isRelativeInsideOrEqual(candidate: string, root: string): boolean {
  const rel = NodePath.relative(root, candidate);
  return (
    rel === "" ||
    (!NodePath.isAbsolute(rel) && rel !== ".." && !rel.startsWith(`..${NodePath.sep}`))
  );
}

function isPathInsideOrEqual(
  candidate: string | null | undefined,
  root: string | null | undefined,
): boolean {
  if (!candidate || !root) return false;
  const resolvedCandidate = NodePath.resolve(candidate);
  const resolvedRoot = NodePath.resolve(root);
  if (isRelativeInsideOrEqual(resolvedCandidate, resolvedRoot)) {
    return true;
  }
  const canonicalCandidate = canonicalizeFilesystemPath(candidate);
  const canonicalRoot = canonicalizeFilesystemPath(root);
  return isRelativeInsideOrEqual(canonicalCandidate, canonicalRoot);
}

function looksLikeScratchWorkspacePath(workspacePath: string | null | undefined): boolean {
  if (!workspacePath) return false;
  const check = (value: string) => {
    const normalized = value.replaceAll("\\", "/");
    return normalized.endsWith("/scratch") || normalized.includes("/scratch/");
  };
  return check(NodePath.resolve(workspacePath)) || check(canonicalizeFilesystemPath(workspacePath));
}

/**
 * ADR-012 §5.2 workspace contract: `shared` works everywhere; `worktree` requires
 * a non-scratch Git repo with a valid HEAD (canonicalizing symlinked `scratch/`).
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

interface BriefSectionRule {
  readonly key: HandoffBriefSectionKey;
  readonly label: string;
  readonly enTokens: ReadonlyArray<string>;
  readonly zhTokens: ReadonlyArray<string>;
  readonly headingPatterns: ReadonlyArray<RegExp>;
}

const BRIEF_SECTION_RULES: ReadonlyArray<BriefSectionRule> = (
  [
    {
      key: "goal",
      label: "Goal & Acceptance Criteria (目标与验收标准)",
      enTokens: [
        "goals?",
        "objectives?",
        "acceptance(?:\\s+criteria)?",
        "success\\s+criteria",
        "expected\\s+result",
      ],
      zhTokens: ["目标", "验收标准", "验收", "完成标准", "预期结果"],
    },
    {
      key: "constraints",
      label: "Constraints & Scope (约束与范围)",
      enTokens: [
        "constraints?",
        "scopes?",
        "boundar(?:y|ies)",
        "non-?goals?",
        "guardrails?",
        "rules?",
      ],
      zhTokens: ["约束", "范围", "边界", "限制", "禁止", "不要修改", "不改"],
    },
    {
      key: "files",
      label: "File/Attachment Paths (相关文件与路径)",
      enTokens: [
        "file\\/attachment\\s+paths?",
        "target\\s+files?",
        "relevant\\s+files?",
        "workspace\\s+paths?",
        "files?",
        "paths?",
        "attachments?",
      ],
      zhTokens: ["文件路径", "相关文件", "涉及文件", "文件", "路径", "附件", "目录"],
    },
  ] as const
).map((spec) => ({
  ...spec,
  headingPatterns: [
    new RegExp(`(?:^|\\b)(?:${spec.enTokens.join("|")})(?:\\b|$)`, "iu"),
    new RegExp(spec.zhTokens.join("|"), "u"),
  ],
}));

const ALL_EXPLICIT_SECTION_TOKENS = BRIEF_SECTION_RULES.flatMap((rule) => [
  ...rule.enTokens,
  ...rule.zhTokens,
]).join("|");

const EXPLICIT_SECTION_LABEL_PATTERN = new RegExp(
  `^(?:${ALL_EXPLICIT_SECTION_TOKENS})(?:\\s*(?:&|\\/|and|与|和)\\s*(?:${ALL_EXPLICIT_SECTION_TOKENS}))*$`,
  "iu",
);

function hasMeaningfulSectionBody(text: string): boolean {
  return /[\p{L}\p{N}]/u.test(text);
}

interface ParsedSectionHeader {
  readonly header: string;
  readonly inlineBody: string;
  readonly structuralHeading: boolean;
}

/**
 * Extracts structured section heading/label candidates and optional inline body text.
 */
function parseSectionHeaderLine(rawLine: string): ParsedSectionHeader | null {
  const line = rawLine.trim();
  if (line.length === 0) return null;

  // Markdown heading: ## Goal & Acceptance Criteria (or ## Goal: Fix auth)
  const mdHeading = /^#{1,6}\s+(.+)$/u.exec(line);
  if (mdHeading?.[1]) {
    const cleaned = mdHeading[1].replaceAll(/[*_`]/gu, "").trim();
    const colonInHeading = /^([^:\uFF1A]{2,60}?)\s*[:\uFF1A]\s*(.+)$/u.exec(cleaned);
    if (colonInHeading?.[1] && colonInHeading[2]) {
      return {
        header: colonInHeading[1].trim(),
        inlineBody: colonInHeading[2].trim(),
        structuralHeading: true,
      };
    }
    return { header: cleaned, inlineBody: "", structuralHeading: true };
  }

  // XML/bracket tag: <goal> or [Goal] (do NOT match Markdown links like `[spec](docs/a.md)`)
  const tagHeading =
    /^(?:<([a-zA-Z_\u4e00-\u9fff][a-zA-Z0-9_\-\s\u4e00-\u9fff]{1,40})>|\[([^\]]{2,48})\](?!\())(?:\s*[:\uFF1A]?\s*(.*))?$/u.exec(
      line,
    );
  if (tagHeading?.[1] || tagHeading?.[2]) {
    return {
      header: (tagHeading[1] ?? tagHeading[2] ?? "").trim(),
      inlineBody: (tagHeading[3] ?? "").trim(),
      structuralHeading: true,
    };
  }

  // Strip optional list marker (`1.`, `1)`, `-`, `*`, `•`).
  const withoutList = line.replace(/^(?:\d+[.)]\s+|[-*•]\s+)/u, "").trim();

  // Bold standalone heading line: **Constraints & Scope**
  const boldHeading = /^\*\*([^*]{2,60})\*\*$/u.exec(withoutList);
  if (boldHeading?.[1]) {
    return { header: boldHeading[1].trim(), inlineBody: "", structuralHeading: true };
  }

  // Explicit `Label: ...` or `Label：...` (label portion up to 60 chars before colon)
  const colonMatch = /^([^*`:\uFF1A]{2,60}?)(?:\*{1,2})?\s*[:\uFF1A]\s*(.*)$/u.exec(
    withoutList.replace(/^\*{1,2}/u, ""),
  );
  if (colonMatch?.[1]) {
    const candidateHeader = colonMatch[1].replaceAll(/[*_`]/gu, "").trim();
    // Skip file-path-like tokens (e.g. `src/files/auth.ts: line 12`) so they remain body text.
    if (/[\\/]\S+\.\w+$/u.test(candidateHeader)) {
      return null;
    }
    return {
      header: candidateHeader,
      inlineBody: (colonMatch[2] ?? "").trim(),
      structuralHeading: false,
    };
  }

  return null;
}

/**
 * Rejects degenerate inline bodies composed of explicit stacked section headings/tags
 * (e.g., `[Goal] [Scope]`, `<goal> <files>`, `Goal: Scope:`, `Goal: Scope: Files:`, `## Goal: ## Scope`)
 * while preserving normal prose containing colons, bold text, or Markdown links.
 */
function isInlineBodyAnotherHeadingOrTag(inlineBody: string): boolean {
  let remaining = inlineBody.trim();
  let sawNestedSectionHeader = false;
  for (let depth = 0; depth < 8 && remaining.length > 0; depth += 1) {
    const nested = parseSectionHeaderLine(remaining);
    if (nested === null) {
      return false;
    }
    if (!EXPLICIT_SECTION_LABEL_PATTERN.test(nested.header)) {
      return false;
    }
    sawNestedSectionHeader = true;
    remaining = nested.inlineBody.trim();
    if (nested.structuralHeading) {
      return true;
    }
    if (!hasMeaningfulSectionBody(remaining)) {
      return true;
    }
  }
  return sawNestedSectionHeader;
}

/**
 * Server-side ADR-012 §5.3 handoff brief validator: requires 3 distinct non-empty sections
 * (Goal, Constraints, Files) with at most one category matched per heading line.
 */
export function validateCodingAgentHandoffBrief(task: string): HandoffBriefValidation {
  const populated = new Set<HandoffBriefSectionKey>();
  let currentSection: HandoffBriefSectionKey | null = null;

  for (const rawLine of task.split(/\r?\n/u)) {
    const parsed = parseSectionHeaderLine(rawLine);
    if (parsed !== null) {
      const matchedRules = BRIEF_SECTION_RULES.filter((rule) =>
        rule.headingPatterns.some((pattern) => pattern.test(parsed.header)),
      );
      if (matchedRules.length === 1) {
        if (isInlineBodyAnotherHeadingOrTag(parsed.inlineBody)) {
          // Reject lines combining multiple section headers/tags such as `[Goal] [Scope]`.
          currentSection = null;
          continue;
        }
        const matchedKey = matchedRules[0]!.key;
        currentSection = matchedKey;
        if (hasMeaningfulSectionBody(parsed.inlineBody)) {
          populated.add(matchedKey);
        }
        continue;
      }
      if (matchedRules.length > 1 || parsed.structuralHeading) {
        // Reject combined multi-category headings and reset on unrelated structural headings.
        currentSection = null;
        continue;
      }
    }

    if (currentSection !== null && hasMeaningfulSectionBody(rawLine)) {
      populated.add(currentSection);
    }
  }

  const missing = BRIEF_SECTION_RULES.filter((rule) => !populated.has(rule.key));
  if (missing.length === 0) {
    return { valid: true };
  }

  const missingLabels = missing.map((rule) => rule.label).join(", ");
  return {
    valid: false,
    missingSections: missing.map((rule) => rule.key),
    message: `Delegated Coding Agent handoff brief is incomplete (ADR-012 §5.3). Because the child starts with no parent chat history, include 3 distinct non-empty sections for: ${missingLabels}. Retry delegate_task with explicit headings/labels and non-empty body content for each missing section.`,
  };
}

/**
 * Generates concise runtime delegation instructions for built-in「小瞳」(`xtworkPi`)
 * ONLY on non-IM desktop turns when `codingAgent.mode === "provider"` and no one-turn
 * `builtin_once` override is active (ADR-012 §5.1–§5.4).
 */
export function buildCodingAgentDelegationInstructions(input: {
  readonly codingAgent: CodingAgentSetting | undefined;
  readonly callerInstanceId: ProviderInstanceId;
  readonly codingAgentOverride?: CodingAgentTurnOverride | undefined;
  readonly threadId?: string | null | undefined;
  readonly isProtectedThread?: boolean | undefined;
  readonly executionContext?:
    | Pick<TurnExecutionContext, "source" | "replyAudience">
    | null
    | undefined;
  readonly ancestorThreadIds?: ReadonlyArray<string> | undefined;
  readonly isAncestorProtected?: ((ancestorThreadId: string) => boolean) | undefined;
  readonly displayName?: string | undefined;
  readonly workspaceKind?: DelegationWorkspaceKind | undefined;
}): string {
  if (input.callerInstanceId !== PI_INSTANCE_ID) {
    return "";
  }
  if (input.codingAgentOverride === "builtin_once") {
    return "";
  }
  const threadGuard = isExternalDelegationBlockedForThread({
    threadId: input.threadId,
    isProtectedThread: input.isProtectedThread,
    executionContext: input.executionContext,
    ancestorThreadIds: input.ancestorThreadIds,
    isAncestorProtected: input.isAncestorProtected,
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
    `- For coding, debugging, refactoring, test fixes, or repository modifications, delegate via \`delegate_task\` with ${targetSpec}. Never silently substitute a different external Coding Agent or remote environment.`,
    "- Exception: if the user explicitly triggers the one-turn built-in 小瞳 fallback, handle the task directly without calling `delegate_task`.",
    "- If `delegate_task` returns `coding_agent_unavailable`, stop and report the reason concisely without trying another external agent (the user can click the inline Install/Sign-in or one-turn built-in 小瞳 buttons).",
    `- Workspace rule: ${workspaceHint}`,
    "- Because `delegate_task` starts a child without parent chat history or attachments, structure every `task` brief with these 5 sections (Goal, Constraints, and File Paths are enforced server-side):",
    "  1. Goal & Acceptance Criteria: exact objective and how to verify success.",
    "  2. Constraints & Scope: boundaries, untouched files, and uncommitted-change rules.",
    "  3. File/Attachment Paths: exact workspace-relative or absolute paths for relevant files and attachments.",
    "  4. Privacy/Secret Redaction: exclude unrelated personal chat history, secrets, API keys, and full todo lists.",
    "  5. Verification Summary: require the child to report edited files, verification commands run, and remaining risks.",
    "</coding_agent_delegation>",
  ].join("\n");
}
