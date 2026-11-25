import {
  CodingAgentSetting,
  DEFAULT_CODING_AGENT_SETTING,
  DEFAULT_SERVER_SETTINGS,
  ProviderDriverKind,
  ProviderInstanceId,
  ServerSettings,
  ServerSettingsPatch,
  type ServerProvider,
} from "@t3tools/contracts";
import { applyServerSettingsPatch } from "@t3tools/shared/serverSettings";
import * as Schema from "effect/Schema";
import { describe, expect, it } from "vite-plus/test";
import { desktopContext, type TurnExecutionContext } from "../im/XtworkImSecurity.ts";
import { PI_INSTANCE_ID } from "./bundledPiSettings.ts";
import {
  CODING_AGENT_UNAVAILABLE_CODE,
  IM_DELEGATION_DENIED_CODE,
  assessCodingAgentReadiness,
  buildCodingAgentDelegationInstructions,
  isExternalDelegationBlockedForThread,
  normalizeCodingAgentSetting,
  resolveCodingAgentTarget,
  validateDelegationWorkspace,
} from "./codingAgentDelegation.ts";
import { KIMI_CODE_INSTANCE_ID } from "./codingAgentSeed.ts";

const claudeId = ProviderInstanceId.make("claudeAgent");
const codexId = ProviderInstanceId.make("codex");
const kimiId = KIMI_CODE_INSTANCE_ID;
const decodeServerSettings = Schema.decodeSync(ServerSettings);
const decodeCodingAgentSetting = Schema.decodeUnknownSync(CodingAgentSetting);

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
  });
});
