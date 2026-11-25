// @effect-diagnostics nodeBuiltinImport:off
import {
  CodingAgentSetting,
  DEFAULT_CODING_AGENT_SETTING,
  DEFAULT_SERVER_SETTINGS,
  OrchestrationMessageContext,
  ProviderDriverKind,
  ProviderInstanceId,
  ServerSettings,
  ServerSettingsPatch,
  ThreadId,
  type ServerProvider,
} from "@t3tools/contracts";
import { applyServerSettingsPatch } from "@t3tools/shared/serverSettings";
import { describe, expect, it } from "@effect/vitest";
import * as Effect from "effect/Effect";
import * as Schema from "effect/Schema";
import * as NodeFS from "node:fs";
import * as NodeOS from "node:os";
import * as NodePath from "node:path";
import { desktopContext, type TurnExecutionContext } from "../im/XtworkImSecurity.ts";
import { PI_INSTANCE_ID } from "./bundledPiSettings.ts";
import {
  CODING_AGENT_BUILTIN_ONCE_CODE,
  CODING_AGENT_UNAVAILABLE_CODE,
  IM_DELEGATION_DENIED_CODE,
  assessCodingAgentReadiness,
  buildCodingAgentDelegationInstructions,
  checkExternalDelegationAncestry,
  isExternalDelegationBlockedForThread,
  normalizeCodingAgentSetting,
  resolveCodingAgentTarget,
  validateCodingAgentHandoffBrief,
  validateDelegationWorkspace,
} from "./codingAgentDelegation.ts";
import { KIMI_CODE_INSTANCE_ID } from "./codingAgentSeed.ts";

const claudeId = ProviderInstanceId.make("claudeAgent");
const codexId = ProviderInstanceId.make("codex");
const kimiId = KIMI_CODE_INSTANCE_ID;
const decodeServerSettings = Schema.decodeSync(ServerSettings);
const decodeCodingAgentSetting = Schema.decodeUnknownSync(CodingAgentSetting);
const decodeMessageContext = Schema.decodeUnknownSync(OrchestrationMessageContext);

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
    models: [{ slug: "default-model", name: "Default Model", isCustom: false, capabilities: null }],
    slashCommands: [],
    skills: [],
    ...overrides,
  };
}

describe("codingAgent settings schema & normalization", () => {
  it("defaults ServerSettings.codingAgent to { mode: 'auto' }", () => {
    const decoded = decodeServerSettings({});
    expect(decoded.codingAgent).toEqual({ mode: "auto" });
    expect(DEFAULT_SERVER_SETTINGS.codingAgent).toEqual(DEFAULT_CODING_AGENT_SETTING);
  });

  it("validates CodingAgentSetting union cleanly and rejects empty instanceId", () => {
    const decode = decodeCodingAgentSetting;
    expect(decode({ mode: "auto" })).toEqual({ mode: "auto" });
    expect(decode({ mode: "provider", instanceId: "claudeAgent" })).toEqual({
      mode: "provider",
      instanceId: "claudeAgent",
    });
    expect(
      decode({ mode: "provider", instanceId: "claudeAgent", model: " claude-sonnet-4-6 " }),
    ).toEqual({
      mode: "provider",
      instanceId: "claudeAgent",
      model: "claude-sonnet-4-6",
    });
    expect(() => decode({ mode: "provider", instanceId: "" })).toThrow();
    expect(() => decode({ mode: "invalid" })).toThrow();
  });

  it("replaces codingAgent whole in applyServerSettingsPatch without leaking stale keys", () => {
    const decodePatch = Schema.decodeUnknownSync(ServerSettingsPatch);
    const withProvider = applyServerSettingsPatch(
      DEFAULT_SERVER_SETTINGS,
      decodePatch({
        codingAgent: { mode: "provider", instanceId: "codex", model: "gpt-5.4" },
      }),
    );
    expect(withProvider.codingAgent).toEqual({
      mode: "provider",
      instanceId: "codex",
      model: "gpt-5.4",
    });

    const clearedModel = applyServerSettingsPatch(
      withProvider,
      decodePatch({
        codingAgent: { mode: "provider", instanceId: "codex" },
      }),
    );
    expect(clearedModel.codingAgent).toEqual({
      mode: "provider",
      instanceId: "codex",
    });
    expect("model" in clearedModel.codingAgent).toBe(false);

    const backToAuto = applyServerSettingsPatch(
      withProvider,
      decodePatch({ codingAgent: { mode: "auto" } }),
    );
    expect(backToAuto.codingAgent).toEqual({ mode: "auto" });
    expect("instanceId" in backToAuto.codingAgent).toBe(false);
    expect("model" in backToAuto.codingAgent).toBe(false);
  });

  it("normalizes xtworkPi provider target back to auto to prevent self-delegation loops", () => {
    expect(
      normalizeCodingAgentSetting({ mode: "provider", instanceId: PI_INSTANCE_ID }),
    ).toEqual({ mode: "auto" });
    expect(normalizeCodingAgentSetting(undefined)).toEqual({ mode: "auto" });
    expect(
      normalizeCodingAgentSetting({
        mode: "provider",
        instanceId: claudeId,
        model: "  claude-opus-4-6  ",
      }),
    ).toEqual({
      mode: "provider",
      instanceId: claudeId,
      model: "claude-opus-4-6",
    });
  });
});

describe("assessCodingAgentReadiness & resolveCodingAgentTarget", () => {
  const readyClaude = makeProvider(claudeId, "claudeAgent", { displayName: "Claude Code" });
  const readyCodex = makeProvider(codexId, "codex", { displayName: "Codex" });
  const capable = new Set<ProviderInstanceId>([PI_INSTANCE_ID, claudeId, codexId, kimiId]);

  it("passes through when codingAgent is auto or caller is not xtworkPi", () => {
    expect(
      resolveCodingAgentTarget({
        codingAgent: { mode: "auto" },
        callerInstanceId: PI_INSTANCE_ID,
        providers: [readyClaude, readyCodex],
        orchestrationCapableInstanceIds: capable,
      }),
    ).toEqual({ kind: "passthrough" });

    expect(
      resolveCodingAgentTarget({
        codingAgent: { mode: "provider", instanceId: claudeId },
        callerInstanceId: codexId,
        providers: [readyClaude, readyCodex],
        orchestrationCapableInstanceIds: capable,
      }),
    ).toEqual({ kind: "passthrough" });
  });

  it("routes deterministically to configured instanceId when omitted or another external agent is requested", () => {
    const omitted = resolveCodingAgentTarget({
      codingAgent: { mode: "provider", instanceId: claudeId, model: "claude-sonnet-4-6" },
      callerInstanceId: PI_INSTANCE_ID,
      providers: [readyClaude, readyCodex],
      orchestrationCapableInstanceIds: capable,
    });
    expect(omitted).toMatchObject({
      kind: "routed",
      lockedInstanceId: claudeId,
      overriddenExternalTarget: false,
      target: { providerInstanceId: claudeId, model: "claude-sonnet-4-6" },
    });

    const swapped = resolveCodingAgentTarget({
      codingAgent: { mode: "provider", instanceId: claudeId, model: "claude-sonnet-4-6" },
      callerInstanceId: PI_INSTANCE_ID,
      requestedTarget: { providerInstanceId: codexId, model: "gpt-5.4" },
      providers: [readyClaude, readyCodex],
      orchestrationCapableInstanceIds: capable,
    });
    expect(swapped).toMatchObject({
      kind: "routed",
      lockedInstanceId: claudeId,
      overriddenExternalTarget: true,
      target: { providerInstanceId: claudeId, model: "claude-sonnet-4-6" },
    });
  });

  it("never silently substitutes another ready external Coding Agent when configured target is blocked", () => {
    const cases = [
      {
        label: "not_installed",
        provider: makeProvider(claudeId, "claudeAgent", {
          displayName: "Claude Code",
          installed: false,
          status: "warning",
        }),
        expectedReason: "not_installed",
        canInstall: true,
        canLogin: false,
      },
      {
        label: "update_required",
        provider: makeProvider(kimiId, "acpRegistry", {
          displayName: "Kimi Code",
          installed: true,
          status: "warning",
          message:
            "ACP Registry agent 'kimi-code' has update v2.0.0 available. Confirm in provider settings to update.",
        }),
        expectedReason: "update_required",
        canInstall: true,
        canLogin: false,
      },
      {
        label: "not_authenticated",
        provider: makeProvider(claudeId, "claudeAgent", {
          displayName: "Claude Code",
          installed: true,
          status: "warning",
          auth: { status: "unauthenticated" },
          setup: { canAuthenticate: true, canInstall: true },
        }),
        expectedReason: "not_authenticated",
        canInstall: false,
        canLogin: true,
      },
      {
        label: "disabled",
        provider: makeProvider(claudeId, "claudeAgent", {
          displayName: "Claude Code",
          enabled: false,
          status: "disabled",
        }),
        expectedReason: "disabled",
        canInstall: false,
        canLogin: false,
      },
    ] as const;

    for (const testCase of cases) {
      const resolved = resolveCodingAgentTarget({
        codingAgent: { mode: "provider", instanceId: testCase.provider.instanceId },
        callerInstanceId: PI_INSTANCE_ID,
        requestedTarget: { providerInstanceId: codexId },
        providers: [testCase.provider, readyCodex],
        orchestrationCapableInstanceIds: capable,
      });
      expect(resolved.kind, testCase.label).toBe("blocked");
      if (resolved.kind !== "blocked") continue;
      expect(resolved.result).toMatchObject({
        blocked: true,
        code: CODING_AGENT_UNAVAILABLE_CODE,
        reason: testCase.expectedReason,
        instanceId: testCase.provider.instanceId,
        displayName: testCase.provider.displayName,
        canInstall: testCase.canInstall,
        canLogin: testCase.canLogin,
      });
    }

    const notFound = assessCodingAgentReadiness({
      instanceId: ProviderInstanceId.make("missingAgent"),
      providers: [readyCodex],
      orchestrationCapableInstanceIds: capable,
    });
    expect(notFound.ready).toBe(false);
    if (!notFound.ready) {
      expect(notFound.blocked.code).toBe(CODING_AGENT_UNAVAILABLE_CODE);
      expect(notFound.blocked.reason).toBe("not_found");
    }
  });
});

describe("isExternalDelegationBlockedForThread (ADR-012 §5.4)", () => {
  const groupContext: TurnExecutionContext = {
    ...desktopContext,
    source: "im",
    connectionId: "conn-1",
    chatId: "group-1",
    chatKind: "group",
    senderRole: "member",
    replyAudience: "group",
    companionScope: "group:chat-1",
  };
  const ownerDmContext: TurnExecutionContext = {
    ...desktopContext,
    source: "im",
    connectionId: "conn-1",
    chatId: "dm-1",
    chatKind: "dm",
    senderRole: "owner",
    replyAudience: "owner_dm",
    companionScope: "private",
  };

  it("hard-denies IM thread IDs, protected threads, and group/owner_dm execution contexts", () => {
    expect(isExternalDelegationBlockedForThread({ threadId: "xtwork-im-dm-abc" })).toMatchObject({
      blocked: true,
      code: IM_DELEGATION_DENIED_CODE,
    });
    expect(isExternalDelegationBlockedForThread({ threadId: "xtwork-im-group-xyz" })).toMatchObject(
      {
        blocked: true,
        code: IM_DELEGATION_DENIED_CODE,
      },
    );
    expect(
      isExternalDelegationBlockedForThread({ threadId: "desktop-1", isProtectedThread: true }),
    ).toMatchObject({
      blocked: true,
      code: IM_DELEGATION_DENIED_CODE,
    });
    expect(
      isExternalDelegationBlockedForThread({
        threadId: "desktop-1",
        executionContext: groupContext,
      }),
    ).toMatchObject({
      blocked: true,
      code: IM_DELEGATION_DENIED_CODE,
      reason: "group_audience_forbidden",
    });
    expect(
      isExternalDelegationBlockedForThread({
        threadId: "desktop-1",
        executionContext: ownerDmContext,
      }),
    ).toMatchObject({
      blocked: true,
      code: IM_DELEGATION_DENIED_CODE,
    });
  });

  it("allows normal desktop local_only threads", () => {
    expect(
      isExternalDelegationBlockedForThread({
        threadId: "thread:desktop-1",
        isProtectedThread: false,
        executionContext: desktopContext,
      }),
    ).toEqual({ blocked: false });
  });
});

describe("validateDelegationWorkspace (ADR-012 §5.2)", () => {
  it("allows isolation: 'shared' (or omitted) on scratch, non-Git, and Git workspaces", () => {
    expect(
      validateDelegationWorkspace({
        isolation: undefined,
        projectWorkspaceRoot: "/tmp/t3/scratch",
        parentWorktreePath: "/tmp/t3/scratch/2026-11-25-demo",
        isScratchProject: true,
        hasValidGitHead: false,
      }),
    ).toEqual({
      allowed: true,
      effectiveIsolation: "shared",
      workspaceKind: "scratch",
      isScratch: true,
    });

    expect(
      validateDelegationWorkspace({
        isolation: "shared",
        projectWorkspaceRoot: "/tmp/plain-folder",
        parentWorktreePath: null,
        hasValidGitHead: false,
      }),
    ).toEqual({
      allowed: true,
      effectiveIsolation: "shared",
      workspaceKind: "non_git",
      isScratch: false,
    });
  });

  it("refuses isolation: 'worktree' on scratch/ and non-Git folders with actionable shared guidance", () => {
    const scratchRefusal = validateDelegationWorkspace({
      isolation: "worktree",
      projectWorkspaceRoot: "/tmp/t3/scratch",
      parentWorktreePath: "/tmp/t3/scratch/2026-11-25-demo",
      isScratchProject: true,
      hasValidGitHead: true,
    });
    expect(scratchRefusal.allowed).toBe(false);
    if (!scratchRefusal.allowed) {
      expect(scratchRefusal.reason).toBe("scratch_worktree_unsupported");
      expect(scratchRefusal.message).toContain('isolation: "shared"');
    }

    const nonGitRefusal = validateDelegationWorkspace({
      isolation: "worktree",
      projectWorkspaceRoot: "/tmp/plain-folder",
      parentWorktreePath: null,
      hasValidGitHead: false,
    });
    expect(nonGitRefusal.allowed).toBe(false);
    if (!nonGitRefusal.allowed) {
      expect(nonGitRefusal.reason).toBe("non_git_worktree_unsupported");
      expect(nonGitRefusal.message).toContain('isolation: "shared"');
    }

    const validGit = validateDelegationWorkspace({
      isolation: "worktree",
      projectWorkspaceRoot: "/tmp/repo",
      parentWorktreePath: null,
      hasValidGitHead: true,
    });
    expect(validGit).toEqual({
      allowed: true,
      effectiveIsolation: "worktree",
      workspaceKind: "git",
      isScratch: false,
    });
  });
});

describe("buildCodingAgentDelegationInstructions (ADR-012 §5.3)", () => {
  it("emits 5-part handoff instructions only for non-IM xtworkPi turns when mode === 'provider'", () => {
    const prompt = buildCodingAgentDelegationInstructions({
      codingAgent: { mode: "provider", instanceId: claudeId, model: "claude-sonnet-4-6" },
      callerInstanceId: PI_INSTANCE_ID,
      threadId: "thread:desktop-1",
      isProtectedThread: false,
      displayName: "Claude Code",
      workspaceKind: "scratch",
    });
    expect(prompt).toContain("Claude Code");
    expect(prompt).toContain('providerInstanceId: "claudeAgent"');
    expect(prompt).toContain('model: "claude-sonnet-4-6"');
    expect(prompt).toContain("Goal & Acceptance Criteria");
    expect(prompt).toContain("Constraints & Scope");
    expect(prompt).toContain("File/Attachment Paths");
    expect(prompt).toContain("Privacy/Secret Redaction");
    expect(prompt).toContain("Verification Summary");
    expect(prompt).toContain('isolation: "shared"');
  });

  it("omits instructions on auto mode, non-xtworkPi callers, and IM/group threads", () => {
    expect(
      buildCodingAgentDelegationInstructions({
        codingAgent: { mode: "auto" },
        callerInstanceId: PI_INSTANCE_ID,
        threadId: "thread:desktop-1",
      }),
    ).toBe("");

    expect(
      buildCodingAgentDelegationInstructions({
        codingAgent: { mode: "provider", instanceId: claudeId },
        callerInstanceId: codexId,
        threadId: "thread:desktop-1",
      }),
    ).toBe("");

    expect(
      buildCodingAgentDelegationInstructions({
        codingAgent: { mode: "provider", instanceId: claudeId },
        callerInstanceId: PI_INSTANCE_ID,
        threadId: "xtwork-im-group-123",
      }),
    ).toBe("");

    expect(
      buildCodingAgentDelegationInstructions({
        codingAgent: { mode: "provider", instanceId: claudeId },
        callerInstanceId: PI_INSTANCE_ID,
        threadId: "thread:desktop-1",
        isProtectedThread: true,
      }),
    ).toBe("");

    expect(
      buildCodingAgentDelegationInstructions({
        codingAgent: { mode: "provider", instanceId: claudeId },
        callerInstanceId: PI_INSTANCE_ID,
        codingAgentOverride: "builtin_once",
        threadId: "thread:desktop-1",
      }),
    ).toBe("");
  });
});

describe("Sol Round 1 regression guards", () => {
  it("blocks remote environment targets when xtworkPi has a configured local Coding Agent", () => {
    const readyClaude = makeProvider(claudeId, "claudeAgent", { displayName: "Claude Code" });
    const readyCodex = makeProvider(codexId, "codex", { displayName: "Codex" });

    const remoteWhenReady = resolveCodingAgentTarget({
      codingAgent: { mode: "provider", instanceId: claudeId },
      callerInstanceId: PI_INSTANCE_ID,
      isRemoteEnvironmentTarget: true,
      requestedTarget: {
        environmentId: "env:remote-box" as never,
        providerInstanceId: codexId,
      },
      providers: [readyClaude, readyCodex],
    });
    expect(remoteWhenReady.kind).toBe("remote_blocked");
    if (remoteWhenReady.kind === "remote_blocked") {
      expect(remoteWhenReady.result.blocked).toBe(true);
      expect(remoteWhenReady.result.instanceId).toBe(claudeId);
      expect(remoteWhenReady.result.message).toContain("Remote environment delegation is blocked");
    }

    const uninstalledClaude = makeProvider(claudeId, "claudeAgent", {
      displayName: "Claude Code",
      installed: false,
      status: "warning",
    });
    const remoteWhenUninstalled = resolveCodingAgentTarget({
      codingAgent: { mode: "provider", instanceId: claudeId },
      callerInstanceId: PI_INSTANCE_ID,
      isRemoteEnvironmentTarget: true,
      requestedTarget: {
        environmentId: "env:remote-box" as never,
        providerInstanceId: codexId,
      },
      providers: [uninstalledClaude, readyCodex],
    });
    expect(remoteWhenUninstalled.kind).toBe("blocked");
    if (remoteWhenUninstalled.kind === "blocked") {
      expect(remoteWhenUninstalled.result.code).toBe(CODING_AGENT_UNAVAILABLE_CODE);
      expect(remoteWhenUninstalled.result.reason).toBe("not_installed");
    }
  });

  it("blocks delegation deterministically when codingAgentOverride === 'builtin_once' and round-trips context schema", () => {
    const ctx = decodeMessageContext({
      version: 1,
      codingAgentOverride: "builtin_once",
      records: [],
    });
    expect(ctx.codingAgentOverride).toBe("builtin_once");

    const resolved = resolveCodingAgentTarget({
      codingAgent: { mode: "provider", instanceId: claudeId },
      callerInstanceId: PI_INSTANCE_ID,
      codingAgentOverride: "builtin_once",
      requestedTarget: { providerInstanceId: claudeId },
      providers: [makeProvider(claudeId, "claudeAgent")],
    });
    expect(resolved.kind).toBe("builtin_once");
    if (resolved.kind === "builtin_once") {
      expect(resolved.result.code).toBe(CODING_AGENT_BUILTIN_ONCE_CODE);
      expect(resolved.result.blocked).toBe(true);
    }
  });

  it.effect(
    "walks parentThreadId ancestry with cycle protection for prefixless derived IM/group children",
    () =>
      Effect.gen(function* () {
        const derivedChild = ThreadId.make("derived-subagent-9821");
        const middleThread = ThreadId.make("derived-mid-5510");
        const imRoot = ThreadId.make("xtwork-im-group-team-1");
        const cycleA = ThreadId.make("desktop-cycle-a");
        const cycleB = ThreadId.make("desktop-cycle-b");

        const parents = new Map<ThreadId, ThreadId | null>([
          [derivedChild, middleThread],
          [middleThread, imRoot],
          [imRoot, null],
          [cycleA, cycleB],
          [cycleB, cycleA],
        ]);

        const derivedCheck = yield* checkExternalDelegationAncestry({
          threadId: derivedChild,
          isProtectedThread: () => false,
          loadThreadLineage: (tid) => Effect.succeed({ parentThreadId: parents.get(tid) ?? null }),
        });
        expect(derivedCheck).toMatchObject({
          blocked: true,
          code: IM_DELEGATION_DENIED_CODE,
          blockedAncestorThreadId: imRoot,
        });

        const cycleCheck = yield* checkExternalDelegationAncestry({
          threadId: cycleA,
          isProtectedThread: () => false,
          loadThreadLineage: (tid) => Effect.succeed({ parentThreadId: parents.get(tid) ?? null }),
        });
        expect(cycleCheck).toEqual({ blocked: false });

        // Fail closed when looking up a referenced parentThreadId fails!
        const failingParent = ThreadId.make("parent-lookup-fail");
        const lookupFailCheck = yield* checkExternalDelegationAncestry({
          threadId: ThreadId.make("child-of-failing-parent"),
          initialLineage: { parentThreadId: failingParent },
          isProtectedThread: () => false,
          loadThreadLineage: () => Effect.fail("sqlite busy"),
        });
        expect(lookupFailCheck).toMatchObject({
          blocked: true,
          code: IM_DELEGATION_DENIED_CODE,
          reason: "ancestry_lookup_failed",
          blockedAncestorThreadId: failingParent,
        });

        // Fail closed when initialLineage is explicitly `null` (missing lineage must not skip checks)!
        const nullInitialLineageCheck = yield* checkExternalDelegationAncestry({
          threadId: ThreadId.make("child-with-null-lineage"),
          initialLineage: null,
          isProtectedThread: () => false,
          loadThreadLineage: () => Effect.succeed({ parentThreadId: null }),
        });
        expect(nullInitialLineageCheck).toMatchObject({
          blocked: true,
          code: IM_DELEGATION_DENIED_CODE,
          reason: "ancestry_lookup_failed",
        });

        // Fail closed when a referenced parentThreadId is missing (lookup returns null)!
        const missingParent = ThreadId.make("parent-missing-null");
        const missingParentCheck = yield* checkExternalDelegationAncestry({
          threadId: ThreadId.make("child-of-missing-parent"),
          initialLineage: { parentThreadId: missingParent },
          isProtectedThread: () => false,
          loadThreadLineage: () => Effect.succeed(null),
        });
        expect(missingParentCheck).toMatchObject({
          blocked: true,
          code: IM_DELEGATION_DENIED_CODE,
          reason: "ancestry_lookup_failed",
          blockedAncestorThreadId: missingParent,
        });

        // Fail closed when ancestry depth exceeds the 64-hop verification cap with unvisited ancestors remaining!
        const deepChain = new Map<ThreadId, ThreadId | null>();
        for (let i = 0; i <= 70; i += 1) {
          deepChain.set(
            ThreadId.make(`desktop-chain-${i}`),
            i < 70 ? ThreadId.make(`desktop-chain-${i + 1}`) : null,
          );
        }
        const deepCheck = yield* checkExternalDelegationAncestry({
          threadId: ThreadId.make("desktop-chain-0"),
          isProtectedThread: () => false,
          loadThreadLineage: (tid) => Effect.succeed({ parentThreadId: deepChain.get(tid) ?? null }),
        });
        expect(deepCheck).toMatchObject({
          blocked: true,
          code: IM_DELEGATION_DENIED_CODE,
          reason: "ancestry_depth_exceeded",
        });
      }),
  );

  it("canonicalizes symlinked scratch/ paths via realpathSync and refuses isolation: 'worktree'", () => {
    const tmpRoot = NodeFS.mkdtempSync(NodePath.join(NodeOS.tmpdir(), "xtwork-symlink-scratch-"));
    try {
      const scratchRoot = NodePath.join(tmpRoot, "t3", "scratch");
      const scratchSession = NodePath.join(scratchRoot, "2026-11-25-session");
      NodeFS.mkdirSync(scratchSession, { recursive: true });
      const symlinkPath = NodePath.join(tmpRoot, "project-link");
      NodeFS.symlinkSync(scratchRoot, symlinkPath, "dir");

      const directSymlink = validateDelegationWorkspace({
        isolation: "worktree",
        projectWorkspaceRoot: symlinkPath,
        parentWorktreePath: null,
        isScratchProject: false,
        scratchRoot,
        hasValidGitHead: true,
      });
      expect(directSymlink.allowed).toBe(false);
      if (!directSymlink.allowed) {
        expect(directSymlink.reason).toBe("scratch_worktree_unsupported");
        expect(directSymlink.isScratch).toBe(true);
      }

      // Non-existent descendant through symlink still canonicalizes via nearest existing ancestor.
      const nonExistentThroughSymlink = validateDelegationWorkspace({
        isolation: "worktree",
        projectWorkspaceRoot: NodePath.join(symlinkPath, "future-sub-session"),
        parentWorktreePath: null,
        isScratchProject: false,
        scratchRoot,
        hasValidGitHead: true,
      });
      expect(nonExistentThroughSymlink.allowed).toBe(false);
      if (!nonExistentThroughSymlink.allowed) {
        expect(nonExistentThroughSymlink.reason).toBe("scratch_worktree_unsupported");
      }
    } finally {
      NodeFS.rmSync(tmpRoot, { recursive: true, force: true });
    }
  });

  it("blocks provider with versionAdvisory.status === 'behind_latest' as update_required before dispatch", () => {
    const behindProvider = makeProvider(claudeId, "claudeAgent", {
      displayName: "Claude Code",
      installed: true,
      status: "ready",
      version: "1.0.0",
      versionAdvisory: {
        status: "behind_latest",
        currentVersion: "1.0.0",
        latestVersion: "2.0.0",
        updateCommand: "npm install -g @anthropic-ai/claude-code@latest",
        canUpdate: true,
        canInstallVersion: true,
        checkedAt: "2026-11-25T00:00:00.000Z",
        message: "Claude Code 2.0.0 is available.",
      },
    });
    const readiness = assessCodingAgentReadiness({
      instanceId: claudeId,
      providers: [behindProvider],
    });
    expect(readiness.ready).toBe(false);
    if (!readiness.ready) {
      expect(readiness.blocked.code).toBe(CODING_AGENT_UNAVAILABLE_CODE);
      expect(readiness.blocked.reason).toBe("update_required");
      expect(readiness.blocked.canInstall).toBe(true);
      expect(readiness.blocked.message).toContain("2.0.0");
    }
  });

  it("enforces ADR-012 §5.3 structured handoff brief sections (EN & ZH) and rejects bare free-form tasks", () => {
    const bare = validateCodingAgentHandoffBrief("Fix auth test failure");
    expect(bare.valid).toBe(false);
    if (!bare.valid) {
      expect(bare.missingSections).toEqual(["goal", "constraints", "files"]);
    }

    // Prose casually mentioning keywords without section headers/labels must still fail.
    const proseOnly = validateCodingAgentHandoffBrief(
      "Please fix the file in scope so we reach our goal quickly.",
    );
    expect(proseOnly.valid).toBe(false);

    const partial = validateCodingAgentHandoffBrief(
      "1. Goal & Acceptance Criteria: Fix auth test.\n2. Constraints & Scope: Touch auth only.",
    );
    expect(partial.valid).toBe(false);
    if (!partial.valid) {
      expect(partial.missingSections).toEqual(["files"]);
    }

    const validEn = validateCodingAgentHandoffBrief(
      [
        "1. Goal & Acceptance Criteria: Fix auth test failure and pass pnpm test.",
        "2. Constraints & Scope: Only edit auth.ts; keep migrations untouched.",
        "3. File/Attachment Paths: apps/server/src/auth.ts, apps/server/src/auth.test.ts",
      ].join("\n"),
    );
    expect(validEn).toEqual({ valid: true });

    const validZh = validateCodingAgentHandoffBrief(
      [
        "## 目标与验收标准",
        "修复认证单测失败并确保测试通过。",
        "## 约束与范围",
        "仅修改认证相关代码，不改动数据库迁移。",
        "## 相关文件路径",
        "- apps/server/src/auth.ts: line 42",
      ].join("\n"),
    );
    expect(validZh).toEqual({ valid: true });

    // 3 bare empty headings MUST be rejected!
    const threeEmptyEn = validateCodingAgentHandoffBrief("## Goal\n## Scope\n## Files");
    expect(threeEmptyEn.valid).toBe(false);
    if (!threeEmptyEn.valid) {
      expect(threeEmptyEn.missingSections).toEqual(["goal", "constraints", "files"]);
    }

    const threeEmptyZh = validateCodingAgentHandoffBrief("## 目标\n## 范围\n## 文件路径");
    expect(threeEmptyZh.valid).toBe(false);
    if (!threeEmptyZh.valid) {
      expect(threeEmptyZh.missingSections).toEqual(["goal", "constraints", "files"]);
    }

    // One empty section sandwiched between populated sections MUST be rejected!
    const oneEmptyMiddle = validateCodingAgentHandoffBrief(
      "## Goal\nFix auth bug\n## Scope\n## Files\napps/server/src/auth.ts",
    );
    expect(oneEmptyMiddle.valid).toBe(false);
    if (!oneEmptyMiddle.valid) {
      expect(oneEmptyMiddle.missingSections).toEqual(["constraints"]);
    }

    // Single combined heading matching multiple categories MUST NOT satisfy multiple sections!
    const combinedHeading = validateCodingAgentHandoffBrief(
      "## Goal, Scope & Files\nFix apps/server/src/auth.ts without touching migrations.",
    );
    expect(combinedHeading.valid).toBe(false);
    if (!combinedHeading.valid) {
      expect(combinedHeading.missingSections).toEqual(["goal", "constraints", "files"]);
    }

    const combinedTwoCategories = validateCodingAgentHandoffBrief(
      "1. Goal & Scope: Fix auth only.\n2. Files: apps/server/src/auth.ts",
    );
    expect(combinedTwoCategories.valid).toBe(false);
    if (!combinedTwoCategories.valid) {
      expect(combinedTwoCategories.missingSections).toEqual(["goal", "constraints"]);
    }

    // Stacked bracket/XML/label headings on the same line MUST NOT treat the second tag as body!
    const stackedBracketTags = validateCodingAgentHandoffBrief(
      "[Goal] [Scope]\n## Scope\nOnly touch auth.\n## Files\napps/server/src/auth.ts",
    );
    expect(stackedBracketTags.valid).toBe(false);
    if (!stackedBracketTags.valid) {
      expect(stackedBracketTags.missingSections).toEqual(["goal"]);
    }

    const stackedXmlTags = validateCodingAgentHandoffBrief(
      "<goal> <scope>\n## Scope\nOnly touch auth.\n## Files\napps/server/src/auth.ts",
    );
    expect(stackedXmlTags.valid).toBe(false);
    if (!stackedXmlTags.valid) {
      expect(stackedXmlTags.missingSections).toEqual(["goal"]);
    }

    const stackedColonLabels = validateCodingAgentHandoffBrief(
      "Goal: Scope:\n## Scope\nOnly touch auth.\n## Files\napps/server/src/auth.ts",
    );
    expect(stackedColonLabels.valid).toBe(false);
    if (!stackedColonLabels.valid) {
      expect(stackedColonLabels.missingSections).toEqual(["goal"]);
    }

    const tripleStackedColonLabels = validateCodingAgentHandoffBrief(
      "Goal: Scope: Files:\n## Scope\nOnly touch auth.\n## Files\napps/server/src/auth.ts",
    );
    expect(tripleStackedColonLabels.valid).toBe(false);
    if (!tripleStackedColonLabels.valid) {
      expect(tripleStackedColonLabels.missingSections).toEqual(["goal"]);
    }

    const mixedStackedLabelAndTag = validateCodingAgentHandoffBrief(
      "Goal: Scope: [Files]\n## Scope\nOnly touch auth.\n## Files\napps/server/src/auth.ts",
    );
    expect(mixedStackedLabelAndTag.valid).toBe(false);
    if (!mixedStackedLabelAndTag.valid) {
      expect(mixedStackedLabelAndTag.missingSections).toEqual(["goal"]);
    }

    for (const emptyStackedGoal of [
      "Goal: Success Criteria:",
      "Goal: Guardrails:",
      "Goal: File Paths:",
      "Goal: Task:",
      "目标：完成标准：",
      "目标：任务：",
    ]) {
      const res = validateCodingAgentHandoffBrief(
        `${emptyStackedGoal}\n## Scope\nOnly touch auth.\n## Files\napps/server/src/auth.ts`,
      );
      expect(res.valid).toBe(false);
      if (!res.valid) {
        expect(res.missingSections).toEqual(["goal"]);
      }
    }

    // Valid `Non-goals:` constraints heading MUST NOT collide with `goals?`!
    const validNonGoals = validateCodingAgentHandoffBrief(
      [
        "Goal: Fix retry backoff on upload errors.",
        "Non-goals: Do not change database schema.",
        "Files: apps/server/src/uploads.ts",
      ].join("\n"),
    );
    expect(validNonGoals).toEqual({ valid: true });

    // Normal prose containing a colon, bold text, or Markdown link with keywords like "file" MUST still be accepted!
    const colonInNormalProse = validateCodingAgentHandoffBrief(
      [
        "Goal: Repair file uploads: preserve retry metadata.",
        "Scope: Keep API response shape backwards-compatible.",
        "Files: apps/server/src/uploads.ts",
      ].join("\n"),
    );
    expect(colonInNormalProse).toEqual({ valid: true });

    const colonWithBoldProse = validateCodingAgentHandoffBrief(
      [
        "Goal: Repair file uploads: **preserve retry metadata**",
        "Scope: Keep API response shape backwards-compatible.",
        "Files: apps/server/src/uploads.ts",
      ].join("\n"),
    );
    expect(colonWithBoldProse).toEqual({ valid: true });

    const colonWithMarkdownLink = validateCodingAgentHandoffBrief(
      [
        "Goal: Repair file uploads: [file upload spec](docs/uploads.md)",
        "Scope: Keep API response shape backwards-compatible.",
        "Files: apps/server/src/uploads.ts",
      ].join("\n"),
    );
    expect(colonWithMarkdownLink).toEqual({ valid: true });

    const directMarkdownLinkBody = validateCodingAgentHandoffBrief(
      [
        "Goal: [file upload spec](docs/uploads.md)",
        "Scope: Keep API response shape backwards-compatible.",
        "Files: apps/server/src/uploads.ts",
      ].join("\n"),
    );
    expect(directMarkdownLinkBody).toEqual({ valid: true });
  });
});
