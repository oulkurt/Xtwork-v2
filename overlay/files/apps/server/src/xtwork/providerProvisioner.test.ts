// @effect-diagnostics nodeBuiltinImport:off globalDate:off globalTimers:off anyUnknownInErrorContext:off globalErrorInEffectFailure:off
import * as NodeFs from "node:fs";
import * as NodeOs from "node:os";
import * as NodePath from "node:path";
import * as Effect from "effect/Effect";
import * as Stream from "effect/Stream";
import { afterEach, describe, expect, it } from "vite-plus/test";
import {
  DEFAULT_SERVER_SETTINGS,
  ProviderDriverKind,
  ProviderInstanceId,
  type ProviderInstanceConfig,
  type ProviderInstallState,
  type ServerSettings,
} from "@t3tools/contracts";
import type * as AcpRegistrySupport from "@t3tools/provider-acp-registry/server/AcpRegistrySupport";
import type * as CodexInstallation from "../provider/CodexInstallation.ts";
import type * as ProviderInstallation from "../provider/providerInstallation.ts";
import {
  CODEBUDDY_CODE_INSTANCE_ID,
  DEEPSEEK_HARNESS_INSTANCE_ID,
  KIMI_CODE_INSTANCE_ID,
  QODER_INSTANCE_ID,
  seedCodingAgents,
} from "./codingAgentSeed.ts";
import { makeXtworkInstallConsentService } from "./installConsent.ts";
import {
  buildHardenedPosixInstallerCommand,
  createRedactingLineBuffer,
  findExecutableInPath,
  makeProviderProvisioner,
  redactSecrets,
  sanitizeProvisionLogLine,
  type ProvisionAcpVerifier,
  type ProvisionCommandRunner,
  type ProvisionNpmVersionResolver,
  type ProvisionVersionProber,
  type ProviderProvisionState,
} from "./providerProvisioner.ts";

const tempDirs: Array<string> = [];

function makeTempDir(prefix = "xtwork-provisioner-"): string {
  const dir = NodeFs.mkdtempSync(NodePath.join(NodeOs.tmpdir(), prefix));
  tempDirs.push(dir);
  return dir;
}

function writeExecutable(filePath: string, content = "#!/bin/sh\necho '1.0.0'\n"): void {
  NodeFs.mkdirSync(NodePath.dirname(filePath), { recursive: true });
  NodeFs.writeFileSync(filePath, content, { mode: 0o755 });
  NodeFs.chmodSync(filePath, 0o755);
}

async function waitForPhase(
  getStatus: () => Promise<ProviderProvisionState>,
  phases: ReadonlyArray<ProviderProvisionState["phase"]>,
  timeoutMs = 3_000,
): Promise<ProviderProvisionState> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    const state = await getStatus();
    if (phases.includes(state.phase)) return state;
    await new Promise((resolve) => setTimeout(resolve, 20));
  }
  return getStatus();
}

afterEach(() => {
  while (tempDirs.length > 0) {
    NodeFs.rmSync(tempDirs.pop()!, { recursive: true, force: true });
  }
});

function createHarness(options?: {
  readonly settings?: ServerSettings;
  readonly getSettingsOverride?: () => Effect.Effect<ServerSettings, unknown>;
  readonly updateProviderInstanceOverride?: (input: {
    readonly operation: "upsert";
    readonly instanceId: ProviderInstanceId;
    readonly instance: ProviderInstanceConfig;
  }) => Effect.Effect<unknown, unknown>;
  readonly env?: NodeJS.ProcessEnv;
  readonly runCommand?: ProvisionCommandRunner;
  readonly probeVersion?: ProvisionVersionProber;
  readonly resolveNpmVersion?: ProvisionNpmVersionResolver;
  readonly verifyAcpInitialize?: ProvisionAcpVerifier;
  readonly acpDescribe?: AcpRegistrySupport.AcpRegistryCatalog["Service"]["describeAgent"];
  readonly acpPrepare?: AcpRegistrySupport.AcpRegistryCatalog["Service"]["prepare"];
  readonly acpUninstallAgent?: AcpRegistrySupport.AcpRegistryCatalog["Service"]["uninstallManagedAgent"];
  readonly codexState?: ProviderInstallState;
  readonly codexStart?: (input: {
    readonly instanceId: ProviderInstanceId;
    readonly approvalToken?: string;
    readonly expectedVersion?: string;
    readonly expectedSha256?: string;
  }) => Effect.Effect<ProviderInstallState>;
  readonly codexRemove?: () => Effect.Effect<ProviderInstallState>;
}) {
  const baseDir = makeTempDir();
  const cacheDir = NodePath.join(baseDir, "cache");
  const fakeNodeBin = NodePath.join(baseDir, "bundled-node", "bin");
  writeExecutable(NodePath.join(fakeNodeBin, "npm"));

  let settings: ServerSettings =
    options?.settings ?? seedCodingAgents(DEFAULT_SERVER_SETTINGS).settings;
  const refreshedInstances: Array<string> = [];
  const upsertedInstances: Array<{ instanceId: string; instance: ProviderInstanceConfig }> = [];
  const consent = makeXtworkInstallConsentService(baseDir);

  const codexDefaultState: ProviderInstallState = options?.codexState ?? {
    driver: ProviderDriverKind.make("codex"),
    operationId: null,
    phase: "idle",
    downloadedBytes: 0,
    totalBytes: 100_000_000,
    version: "0.166.0",
    installedVersion: null,
    executablePath: null,
    canRemove: false,
    message: null,
  };

  const codexInstallation = {
    managedDirectory: NodePath.join(baseDir, "tools", "codex"),
    describePendingRelease: () =>
      Effect.succeed({
        version: "0.166.0",
        target: "aarch64-apple-darwin",
        url: "https://github.com/openai/codex/releases/download/rust-v0.166.0/codex.tar.gz",
        sha256: "a".repeat(64),
        archiveBytes: 100_000_000,
      }),
    state: Effect.succeed(codexDefaultState),
    changes: Stream.empty,
  } as unknown as CodexInstallation.CodexInstallation["Service"];

  const providerInstallation = {
    start: (input: {
      readonly instanceId: ProviderInstanceId;
      readonly approvalToken?: string;
      readonly expectedVersion?: string;
      readonly expectedSha256?: string;
    }) =>
      options?.codexStart
        ? options.codexStart(input)
        : Effect.succeed({
            ...codexDefaultState,
            operationId: "codex-op-1",
            phase: "succeeded",
            installedVersion: "0.166.0",
            executablePath: NodePath.join(baseDir, "tools", "codex", "bin", "codex"),
            canRemove: true,
          } satisfies ProviderInstallState),
    cancel: () => Effect.succeed({ ...codexDefaultState, phase: "cancelled" }),
    subscribe: () => Stream.empty,
    remove: () =>
      options?.codexRemove
        ? options.codexRemove()
        : Effect.succeed({ ...codexDefaultState, phase: "idle", installedVersion: null }),
  } as unknown as ProviderInstallation.ProviderInstallation["Service"];

  const acpCatalog = {
    describeAgent:
      options?.acpDescribe ??
      ((agentId: string) =>
        Effect.succeed({
          agentId,
          version: "2.1.0",
          distribution: "npx" as const,
          packageName: `@official/${agentId}@2.1.0`,
          installDir: NodePath.join(baseDir, "tools", agentId, "2.1.0", "npm"),
          installed: false,
          hasOtherInstalledVersion: false,
        })),
    prepare:
      options?.acpPrepare ??
      ((input: { readonly agentId: string; readonly instanceId?: string }) =>
        Effect.sync(() => {
          const dir = NodePath.join(baseDir, "tools", input.agentId, "2.1.0", "npm");
          NodeFs.mkdirSync(dir, { recursive: true });
          return {
            agentId: input.agentId,
            version: "2.1.0",
            distribution: "npx" as const,
            prepared: true as const,
          };
        })),
    uninstallManagedAgent:
      options?.acpUninstallAgent ??
      ((input: { readonly agentId: string; readonly ignoreInstanceId?: string }) =>
        Effect.sync(() => {
          const dir = NodePath.join(baseDir, "tools", input.agentId);
          const existed = NodeFs.existsSync(dir);
          NodeFs.rmSync(dir, { recursive: true, force: true });
          return { agentId: input.agentId, removed: existed, blockedByInstanceIds: [] };
        })),
  } as unknown as AcpRegistrySupport.AcpRegistryCatalog["Service"];

  const env: NodeJS.ProcessEnv = {
    PATH: "/nonexistent-empty-path",
    HOME: NodePath.join(baseDir, "empty-home"),
    XTWORK_BUNDLED_NODE_BIN: fakeNodeBin,
    XTWORK_DISABLE_SYSTEM_PATH_PROBE: "1",
    ...options?.env,
  };

  const provisioner = makeProviderProvisioner({
    baseDir,
    cacheDir,
    platform: "darwin",
    getHostEnvironment: () => env,
    consent,
    acpCatalog,
    codexInstallation,
    providerInstallation,
    getSettings: () =>
      options?.getSettingsOverride ? options.getSettingsOverride() : Effect.succeed(settings),
    updateProviderInstance: (input) =>
      options?.updateProviderInstanceOverride
        ? options.updateProviderInstanceOverride(input)
        : Effect.sync(() => {
            upsertedInstances.push({ instanceId: input.instanceId, instance: input.instance });
            settings = {
              ...settings,
              providerInstances: {
                ...settings.providerInstances,
                [input.instanceId]: input.instance,
              },
            };
          }),
    refreshProviderInstance: (instanceId) =>
      Effect.sync(() => {
        refreshedInstances.push(instanceId);
      }),
    runCommand: options?.runCommand,
    probeVersion: options?.probeVersion ?? (async () => "1.4.2"),
    resolveNpmVersion: options?.resolveNpmVersion ?? (async () => "1.4.2"),
    verifyAcpInitialize:
      options?.verifyAcpInitialize ?? (async () => ({ ok: true, version: "2.1.0" })),
  });

  return {
    baseDir,
    consent,
    provisioner,
    refreshedInstances,
    upsertedInstances,
    getSettings: () => settings,
  };
}

describe("providerProvisioner", () => {
  it("sanitizes ANSI sequences and secrets in logs including split-chunk lines (S5)", () => {
    const cleaned = sanitizeProvisionLogLine(
      "\u001B[32mInstalling\u001B[0m Bearer supersecret123 sk-1234567890abcdef token=abc123",
    );
    expect(cleaned).not.toContain("\u001B");
    expect(cleaned).not.toContain("supersecret123");
    expect(cleaned).not.toContain("sk-1234567890abcdef");
    expect(cleaned).not.toContain("abc123");
    expect(cleaned).toContain("[REDACTED]");
    expect(cleaned).toContain("[REDACTED_KEY]");

    // S5: Split secrets across chunk boundaries on independent stdout/stderr buffers MUST redact cleanly.
    const emitted: Array<string> = [];
    const stdoutBuf = createRedactingLineBuffer((line) => emitted.push(`out:${line}`));
    const stderrBuf = createRedactingLineBuffer((line) => emitted.push(`err:${line}`));
    stdoutBuf.push("Header: Bearer super");
    stderrBuf.push("Warning: sk-ant-api03-");
    stdoutBuf.push("secret_split_token\n");
    stderrBuf.push("ABCDEF1234567890");
    stderrBuf.flush();
    stdoutBuf.flush();

    expect(emitted).toEqual(["out:Header: Bearer [REDACTED]", "err:Warning: [REDACTED_KEY]"]);
    expect(emitted.join("\n")).not.toContain("supersecret_split_token");
    expect(emitted.join("\n")).not.toContain("ABCDEF1234567890");
  });

  it("uses HTTPS-only hardened curl with temp-file execution for all vendor scripts (M1 & M7)", async () => {
    expect(() => buildHardenedPosixInstallerCommand("http://example.com/install.sh")).toThrow();
    expect(() => buildHardenedPosixInstallerCommand("code.kimi.com/install.sh")).toThrow();

    const { provisioner } = createHarness();
    for (const [instanceId, expectedHost] of [
      ["claudeAgent", "https://claude.ai/install.sh"],
      [KIMI_CODE_INSTANCE_ID, "https://code.kimi.com/kimi-code/install.sh"],
      [QODER_INSTANCE_ID, "https://qoder.com/install"],
      [CODEBUDDY_CODE_INSTANCE_ID, "https://copilot.tencent.com/cli/install.sh"],
    ] as const) {
      const plan = await Effect.runPromise(provisioner.getPlan(instanceId, "vendor-script"));
      expect(plan.selectedOption.officialSource).toBe(expectedHost);
      expect(plan.selectedOption.commandPreview).toContain("--proto '=https' --proto-redir '=https'");
      expect(plan.selectedOption.commandPreview).toContain(expectedHost);
      expect(plan.selectedOption.commandPreview).toContain("set -euo pipefail");
      expect(plan.selectedOption.commandPreview).toContain('bash "$tmp"');
      expect(plan.selectedOption.commandPreview).not.toContain("| bash");
      expect(plan.selectedOption.commandPreview).not.toContain("npm install -g");
    }
  });

  it("rejects installation when consent is missing or does not match pinned plan (M4)", async () => {
    const { provisioner } = createHarness();
    const plan = await Effect.runPromise(provisioner.getPlan(KIMI_CODE_INSTANCE_ID));
    expect(plan.consentRequired).toBe(true);
    expect(plan.consentReason).toBe("install_required");
    expect(plan.selectedMode).toBe("app-managed");
    expect(plan.selectedOption.consentKey.artifactSpec).toBe("@official/kimi-code@2.1.0");

    await expect(
      Effect.runPromise(
        provisioner.startInstall({
          instanceId: KIMI_CODE_INSTANCE_ID,
          consent: { confirmed: false, ...plan.selectedOption.consentKey },
        }),
      ),
    ).rejects.toThrow(/confirmation is required/i);

    await expect(
      Effect.runPromise(
        provisioner.startInstall({
          instanceId: KIMI_CODE_INSTANCE_ID,
          consent: {
            confirmed: true,
            ...plan.selectedOption.consentKey,
            artifactSpec: "@official/kimi-code@0.0.1",
          },
        }),
      ),
    ).rejects.toThrow(/install plan changed/i);
  });

  it("installs pinned @deepseek-ai/dsh@x.y.z, rejects unresolved versions, auto-wires commandPath, and preserves custom paths (M4)", async () => {
    // Unresolved npm version MUST NOT fall back to "latest".
    const offline = createHarness({ resolveNpmVersion: async () => null });
    const offlinePlan = await Effect.runPromise(
      offline.provisioner.getPlan(DEEPSEEK_HARNESS_INSTANCE_ID),
    );
    expect(offlinePlan.selectedOption.installable).toBe(false);
    expect(offlinePlan.availableVersion).toBeNull();
    await expect(
      Effect.runPromise(
        offline.provisioner.startInstall({
          instanceId: DEEPSEEK_HARNESS_INSTANCE_ID,
          consent: { confirmed: true, ...offlinePlan.selectedOption.consentKey },
        }),
      ),
    ).rejects.toThrow(/resolve.*version/i);

    // Pinned version installs exact `@deepseek-ai/dsh@1.4.2`.
    const installedArgs: Array<ReadonlyArray<string>> = [];
    const { baseDir, provisioner, getSettings } = createHarness({
      resolveNpmVersion: async () => "1.4.2",
      runCommand: ({ args, onStdout }) => {
        installedArgs.push(args);
        const prefixIdx = args.indexOf("--prefix");
        const prefixDir = args[prefixIdx + 1]!;
        writeExecutable(NodePath.join(prefixDir, "node_modules", ".bin", "dsh"));
        onStdout?.("added 1 package @deepseek-ai/dsh@1.4.2\n");
        return { promise: Promise.resolve({ exitCode: 0, signal: null }), cancel: () => {} };
      },
    });

    const plan = await Effect.runPromise(provisioner.getPlan(DEEPSEEK_HARNESS_INSTANCE_ID));
    expect(plan.selectedOption.commandPreview).toContain("@deepseek-ai/dsh@1.4.2");
    expect(plan.selectedOption.consentKey.version).toBe("1.4.2");
    expect(plan.selectedOption.consentKey.artifactSpec).toBe("@deepseek-ai/dsh@1.4.2");

    await Effect.runPromise(
      provisioner.startInstall({
        instanceId: DEEPSEEK_HARNESS_INSTANCE_ID,
        consent: { confirmed: true, ...plan.selectedOption.consentKey },
      }),
    );
    const finalState = await waitForPhase(
      () => Effect.runPromise(provisioner.getStatus(DEEPSEEK_HARNESS_INSTANCE_ID)),
      ["succeeded", "failed"],
    );
    expect(finalState.phase).toBe("succeeded");
    expect(installedArgs[0]).toContain("@deepseek-ai/dsh@1.4.2");

    const expectedManagedBin = NodePath.join(
      baseDir,
      "tools",
      "deepseek-harness",
      "node_modules",
      ".bin",
      "dsh",
    );
    const updatedConfig = getSettings().providerInstances[DEEPSEEK_HARNESS_INSTANCE_ID]
      ?.config as Record<string, unknown>;
    expect(updatedConfig.commandPath).toBe(expectedManagedBin);

    await Effect.runPromise(provisioner.uninstall(DEEPSEEK_HARNESS_INSTANCE_ID));
    expect(NodeFs.existsSync(NodePath.join(baseDir, "tools", "deepseek-harness"))).toBe(false);
    expect(
      (
        getSettings().providerInstances[DEEPSEEK_HARNESS_INSTANCE_ID]?.config as Record<
          string,
          unknown
        >
      ).commandPath,
    ).toBe("dsh");
  });

  it("blocks vendor-script installs when a working CLI already exists on PATH (M7)", async () => {
    const userBinDir = makeTempDir("xtwork-existing-claude-");
    const existingClaude = NodePath.join(userBinDir, "claude");
    writeExecutable(existingClaude);

    let commandRan = false;
    const { provisioner } = createHarness({
      env: { PATH: userBinDir },
      runCommand: () => {
        commandRan = true;
        return { promise: Promise.resolve({ exitCode: 0, signal: null }), cancel: () => {} };
      },
    });

    const plan = await Effect.runPromise(provisioner.getPlan("claudeAgent", "vendor-script"));
    expect(plan.existingDetection).toEqual({
      detected: true,
      source: "user-path",
      executablePath: existingClaude,
      version: "1.4.2",
    });
    expect(plan.vendorInstallBlockedByExistingPath).toBe(true);
    expect(plan.selectedOption.installable).toBe(false);

    await expect(
      Effect.runPromise(
        provisioner.startInstall({
          instanceId: "claudeAgent",
          mode: "vendor-script",
          consent: { confirmed: true, ...plan.selectedOption.consentKey },
        }),
      ),
    ).rejects.toThrow(/already installed on PATH/i);
    expect(commandRan).toBe(false);
  });

  it("verifies ACP initialize after vendor-script ACP install, fails if missing/invalid, and wires commandPath while preserving custom paths (M8)", async () => {
    // 1. Missing executable after vendor script -> MUST FAIL (never report succeeded).
    const missing = createHarness({
      runCommand: () => ({
        promise: Promise.resolve({ exitCode: 0, signal: null }),
        cancel: () => {},
      }),
    });
    const missingPlan = await Effect.runPromise(
      missing.provisioner.getPlan(KIMI_CODE_INSTANCE_ID, "vendor-script"),
    );
    await Effect.runPromise(
      missing.provisioner.startInstall({
        instanceId: KIMI_CODE_INSTANCE_ID,
        mode: "vendor-script",
        consent: { confirmed: true, ...missingPlan.selectedOption.consentKey },
      }),
    );
    const missingFinal = await waitForPhase(
      () => Effect.runPromise(missing.provisioner.getStatus(KIMI_CODE_INSTANCE_ID)),
      ["succeeded", "failed"],
    );
    expect(missingFinal.phase).toBe("failed");
    expect(missingFinal.error).toMatch(/not detected on PATH/i);

    // 2. Detected CLI that fails ACP initialize -> MUST FAIL without wiring commandPath.
    const installBinDir = makeTempDir("xtwork-vendor-kimi-");
    const kimiBin = NodePath.join(installBinDir, "kimi");
    const badAcp = createHarness({
      env: { PATH: installBinDir },
      runCommand: () => {
        writeExecutable(kimiBin);
        return { promise: Promise.resolve({ exitCode: 0, signal: null }), cancel: () => {} };
      },
      verifyAcpInitialize: async () => ({ ok: false, error: "ACP initialize refused" }),
    });
    const badPlan = await Effect.runPromise(
      badAcp.provisioner.getPlan(KIMI_CODE_INSTANCE_ID, "vendor-script"),
    );
    await Effect.runPromise(
      badAcp.provisioner.startInstall({
        instanceId: KIMI_CODE_INSTANCE_ID,
        mode: "vendor-script",
        consent: { confirmed: true, ...badPlan.selectedOption.consentKey },
      }),
    );
    const badFinal = await waitForPhase(
      () => Effect.runPromise(badAcp.provisioner.getStatus(KIMI_CODE_INSTANCE_ID)),
      ["succeeded", "failed"],
    );
    expect(badFinal.phase).toBe("failed");
    expect(badFinal.error).toContain("ACP initialize refused");

    // 3. Verified ACP initialize -> wires detected commandPath when user had none.
    const goodDir = makeTempDir("xtwork-vendor-kimi-good-");
    const goodKimi = NodePath.join(goodDir, "kimi");
    const goodAcp = createHarness({
      env: { PATH: goodDir },
      runCommand: () => {
        writeExecutable(goodKimi);
        return { promise: Promise.resolve({ exitCode: 0, signal: null }), cancel: () => {} };
      },
      verifyAcpInitialize: async () => ({ ok: true, version: "2.3.0" }),
    });
    const goodPlan = await Effect.runPromise(
      goodAcp.provisioner.getPlan(KIMI_CODE_INSTANCE_ID, "vendor-script"),
    );
    await Effect.runPromise(
      goodAcp.provisioner.startInstall({
        instanceId: KIMI_CODE_INSTANCE_ID,
        mode: "vendor-script",
        consent: { confirmed: true, ...goodPlan.selectedOption.consentKey },
      }),
    );
    const goodFinal = await waitForPhase(
      () => Effect.runPromise(goodAcp.provisioner.getStatus(KIMI_CODE_INSTANCE_ID)),
      ["succeeded", "failed"],
    );
    expect(goodFinal.phase).toBe("succeeded");
    expect(
      (goodAcp.getSettings().providerInstances[KIMI_CODE_INSTANCE_ID]?.config as Record<string, unknown>)
        .commandPath,
    ).toBe(goodKimi);
  });

  it("serializes shared-runtime mutations and refuses uninstalling runtimes referenced by another enabled instance (M6)", async () => {
    const baseSettings = seedCodingAgents(DEFAULT_SERVER_SETTINGS).settings;
    const secondKimiId = ProviderInstanceId.make("kimiCustom");
    const sharedSettings: ServerSettings = {
      ...baseSettings,
      providerInstances: {
        ...baseSettings.providerInstances,
        [secondKimiId]: {
          driver: ProviderDriverKind.make("acpRegistry"),
          displayName: "Kimi Team",
          enabled: true,
          config: { source: "registry", agentId: "kimi-code", enabled: true },
        },
      },
    };

    let releasePrepare!: () => void;
    const prepareGate = new Promise<void>((resolve) => {
      releasePrepare = resolve;
    });
    let uninstallPermitCalled = false;

    const { baseDir, provisioner } = createHarness({
      settings: sharedSettings,
      acpPrepare: (input) =>
        Effect.promise(async () => {
          await prepareGate;
          const dir = NodePath.join(baseDir, "tools", input.agentId, "2.1.0", "npm");
          NodeFs.mkdirSync(dir, { recursive: true });
          return {
            agentId: input.agentId,
            version: "2.1.0",
            distribution: "npx" as const,
            prepared: true as const,
          };
        }),
      acpUninstallAgent: () =>
        Effect.sync(() => {
          uninstallPermitCalled = true;
          return { agentId: "kimi-code", removed: false, blockedByInstanceIds: [secondKimiId] };
        }),
    });

    const plan1 = await Effect.runPromise(provisioner.getPlan(KIMI_CODE_INSTANCE_ID));
    const plan2 = await Effect.runPromise(provisioner.getPlan(secondKimiId));

    await Effect.runPromise(
      provisioner.startInstall({
        instanceId: KIMI_CODE_INSTANCE_ID,
        consent: { confirmed: true, ...plan1.selectedOption.consentKey },
      }),
    );

    // Concurrent install on a SECOND instance sharing the same `kimi-code` runtime MUST be rejected!
    await expect(
      Effect.runPromise(
        provisioner.startInstall({
          instanceId: secondKimiId,
          consent: { confirmed: true, ...plan2.selectedOption.consentKey },
        }),
      ),
    ).rejects.toThrow(/already running for this managed runtime/i);

    releasePrepare();
    const done1 = await waitForPhase(
      () => Effect.runPromise(provisioner.getStatus(KIMI_CODE_INSTANCE_ID)),
      ["succeeded", "failed"],
    );
    expect(done1.phase).toBe("succeeded");

    // Uninstalling while `kimiCustom` is still enabled MUST be refused without deleting directory!
    await expect(Effect.runPromise(provisioner.uninstall(KIMI_CODE_INSTANCE_ID))).rejects.toThrow(
      /another enabled provider instance still references/i,
    );
    expect(NodeFs.existsSync(NodePath.join(baseDir, "tools", "kimi-code"))).toBe(true);
    expect(uninstallPermitCalled).toBe(false);
  });

  it("aborts verification and avoids writing receipts or wiring settings when cancelled during verifying (S4)", async () => {
    let verifySignalAborted = false;
    let resolveVerifyStarted!: () => void;
    const verifyStarted = new Promise<void>((resolve) => {
      resolveVerifyStarted = resolve;
    });

    const { baseDir, provisioner, upsertedInstances } = createHarness({
      runCommand: ({ args }) => {
        const prefixDir = args[args.indexOf("--prefix") + 1]!;
        writeExecutable(NodePath.join(prefixDir, "node_modules", ".bin", "dsh"));
        return { promise: Promise.resolve({ exitCode: 0, signal: null }), cancel: () => {} };
      },
      probeVersion: (_execPath, _env, signal) =>
        new Promise<string | null>((resolve) => {
          resolveVerifyStarted();
          signal?.addEventListener(
            "abort",
            () => {
              verifySignalAborted = true;
              resolve(null);
            },
            { once: true },
          );
        }),
    });

    const plan = await Effect.runPromise(provisioner.getPlan(DEEPSEEK_HARNESS_INSTANCE_ID));
    const started = await Effect.runPromise(
      provisioner.startInstall({
        instanceId: DEEPSEEK_HARNESS_INSTANCE_ID,
        consent: { confirmed: true, ...plan.selectedOption.consentKey },
      }),
    );

    await verifyStarted;
    await Effect.runPromise(
      provisioner.cancelInstall(DEEPSEEK_HARNESS_INSTANCE_ID, started.operationId ?? undefined),
    );
    const finalState = await waitForPhase(
      () => Effect.runPromise(provisioner.getStatus(DEEPSEEK_HARNESS_INSTANCE_ID)),
      ["cancelled", "succeeded", "failed"],
    );
    expect(verifySignalAborted).toBe(true);
    expect(finalState.phase).toBe("cancelled");
    expect(upsertedInstances).toHaveLength(0);
    expect(NodeFs.existsSync(NodePath.join(baseDir, "tools", "deepseek-harness"))).toBe(false);
    expect(NodeFs.existsSync(NodePath.join(baseDir, "tools", "provisioner-receipts.json"))).toBe(
      false,
    );
  });

  it("delegates Codex install with single-use approvalToken & pinned sha256 to ProviderInstallation (M2/M4)", async () => {
    let capturedInput:
      | {
          readonly instanceId: ProviderInstanceId;
          readonly approvalToken?: string;
          readonly expectedVersion?: string;
          readonly expectedSha256?: string;
        }
      | undefined;

    const { provisioner, refreshedInstances } = createHarness({
      codexStart: (input) =>
        Effect.sync(() => {
          capturedInput = input;
          return {
            driver: ProviderDriverKind.make("codex"),
            operationId: "codex-op-42",
            phase: "succeeded" as const,
            downloadedBytes: 100,
            totalBytes: 100,
            version: "0.166.0",
            installedVersion: "0.166.0",
            executablePath: "/tmp/codex",
            canRemove: true,
            message: null,
          };
        }),
    });

    const plan = await Effect.runPromise(provisioner.getPlan("codex"));
    expect(plan.selectedOption.consentKey.artifactDigest).toBe("a".repeat(64));
    await Effect.runPromise(
      provisioner.startInstall({
        instanceId: "codex",
        consent: { confirmed: true, ...plan.selectedOption.consentKey },
      }),
    );
    const settled = await waitForPhase(
      () => Effect.runPromise(provisioner.getStatus("codex")),
      ["succeeded", "failed"],
    );
    expect(settled.phase).toBe("succeeded");
    expect(capturedInput?.approvalToken).toBeTruthy();
    expect(capturedInput?.expectedVersion).toBe("0.166.0");
    expect(capturedInput?.expectedSha256).toBe("a".repeat(64));
    expect(refreshedInstances).toContain("codex");
  });

  it("supports provisioning plan, cache-loss re-confirm, and version-bump upgrade for user-added non-built-in ACP Registry instances (M3)", async () => {
    const customId = ProviderInstanceId.make("acpRegistry_gemini");
    let installed = false;
    let hasOtherInstalledVersion = false;
    let version = "1.2.3";
    const preparedCalls: Array<{
      readonly agentId: string;
      readonly instanceId?: string;
      readonly expectedArtifactSpec?: string;
    }> = [];

    const { provisioner } = createHarness({
      settings: {
        ...DEFAULT_SERVER_SETTINGS,
        providerInstances: {
          [customId]: {
            driver: ProviderDriverKind.make("acpRegistry"),
            displayName: "Gemini CLI",
            enabled: true,
            config: { source: "registry", agentId: "gemini", enabled: true },
          },
        },
      },
      acpDescribe: (agentId) =>
        Effect.succeed({
          agentId,
          version,
          distribution: "npx" as const,
          packageName: `@google/gemini-cli@${version}`,
          installDir: `/tmp/tools/${agentId}/${version}/npm`,
          installed,
          hasOtherInstalledVersion,
        }),
      acpPrepare: (input) =>
        Effect.sync(() => {
          preparedCalls.push({
            agentId: input.agentId,
            ...(input.instanceId ? { instanceId: String(input.instanceId) } : {}),
            ...(input.expectedArtifactSpec
              ? { expectedArtifactSpec: input.expectedArtifactSpec }
              : {}),
          });
          installed = true;
          hasOtherInstalledVersion = false;
          return {
            agentId: input.agentId,
            version,
            distribution: "npx" as const,
            prepared: true as const,
          };
        }),
    });

    const initialPlan = await Effect.runPromise(provisioner.getPlan(customId));
    expect(initialPlan.agentKind).toBe("gemini");
    expect(initialPlan.displayName).toBe("Gemini CLI");
    expect(initialPlan.availableModes).toHaveLength(1);
    expect(initialPlan.selectedMode).toBe("app-managed");
    expect(initialPlan.consentReason).toBe("install_required");
    expect(initialPlan.selectedOption.consentKey.artifactSpec).toBe("@google/gemini-cli@1.2.3");

    await Effect.runPromise(
      provisioner.startInstall({
        instanceId: customId,
        mode: "app-managed",
        consent: { confirmed: true, ...initialPlan.selectedOption.consentKey },
      }),
    );
    const settledInstall = await waitForPhase(
      () => Effect.runPromise(provisioner.getStatus(customId)),
      ["succeeded", "failed"],
    );
    expect(settledInstall.phase).toBe("succeeded");
    expect(preparedCalls).toEqual([
      {
        agentId: "gemini",
        instanceId: "acpRegistry_gemini",
        expectedArtifactSpec: "@google/gemini-cli@1.2.3",
      },
    ]);

    // Simulate registry version bump -> plan reports update_required and allows re-confirming upgrade!
    version = "1.3.0";
    installed = false;
    hasOtherInstalledVersion = true;
    const upgradePlan = await Effect.runPromise(provisioner.getPlan(customId));
    expect(upgradePlan.updateAvailable).toBe(true);
    expect(upgradePlan.consentRequired).toBe(true);
    expect(upgradePlan.consentReason).toBe("update_required");
    expect(upgradePlan.selectedOption.consentKey.artifactSpec).toBe("@google/gemini-cli@1.3.0");
  });

  it("propagates settings-write failures instead of succeeding when wiring commandPath after vendor ACP install (M8)", async () => {
    const installBinDir = makeTempDir("xtwork-vendor-write-fail-");
    const kimiBin = NodePath.join(installBinDir, "kimi");
    let capturedArgs: ReadonlyArray<string> = [];

    const { provisioner } = createHarness({
      env: { PATH: installBinDir },
      runCommand: ({ args }) => {
        capturedArgs = args;
        writeExecutable(kimiBin);
        return { promise: Promise.resolve({ exitCode: 0, signal: null }), cancel: () => {} };
      },
      verifyAcpInitialize: async () => ({ ok: true, version: "2.2.0" }),
      updateProviderInstanceOverride: () =>
        Effect.fail(new Error("EACCES writing settings.json with Bearer top-secret-token-999")),
    });

    const plan = await Effect.runPromise(provisioner.getPlan(KIMI_CODE_INSTANCE_ID, "vendor-script"));
    await Effect.runPromise(
      provisioner.startInstall({
        instanceId: KIMI_CODE_INSTANCE_ID,
        mode: "vendor-script",
        consent: { confirmed: true, ...plan.selectedOption.consentKey },
      }),
    );
    const failed = await waitForPhase(
      () => Effect.runPromise(provisioner.getStatus(KIMI_CODE_INSTANCE_ID)),
      ["failed", "succeeded"],
    );
    // M1: Also assert modern Kimi Code URL was executed!
    expect(capturedArgs.join(" ")).toContain("https://code.kimi.com/kimi-code/install.sh");
    // M8 + S5: Failure propagated and secrets redacted from error/message!
    expect(failed.phase).toBe("failed");
    expect(failed.error).toContain("EACCES writing settings.json");
    expect(failed.error).not.toContain("top-secret-token-999");
    expect(failed.message).not.toContain("top-secret-token-999");
  });

  it("serializes cancellation against settings commit so cancel arriving during config read blocks commandPath mutation (S4)", async () => {
    const installBinDir = makeTempDir("xtwork-vendor-cancel-read-");
    const kimiBin = NodePath.join(installBinDir, "kimi");
    const baseSettings = seedCodingAgents(DEFAULT_SERVER_SETTINGS).settings;

    let readCallCount = 0;
    let releaseSecondRead!: () => void;
    let notifySecondReadStarted!: () => void;
    const secondReadStarted = new Promise<void>((resolve) => {
      notifySecondReadStarted = resolve;
    });
    const secondReadGate = new Promise<void>((resolve) => {
      releaseSecondRead = resolve;
    });

    const { provisioner, upsertedInstances } = createHarness({
      settings: baseSettings,
      env: { PATH: installBinDir },
      runCommand: () => {
        writeExecutable(kimiBin);
        return { promise: Promise.resolve({ exitCode: 0, signal: null }), cancel: () => {} };
      },
      verifyAcpInitialize: async () => ({ ok: true, version: "2.2.0" }),
      getSettingsOverride: () =>
        Effect.promise(async () => {
          readCallCount += 1;
          // Calls 1 & 2 are getPlan + startInstall's internal buildPlan; call 3 is post-verify getInstanceConfig!
          if (readCallCount === 3) {
            notifySecondReadStarted();
            await secondReadGate;
          }
          return baseSettings;
        }),
    });

    const plan = await Effect.runPromise(provisioner.getPlan(KIMI_CODE_INSTANCE_ID, "vendor-script"));
    const started = await Effect.runPromise(
      provisioner.startInstall({
        instanceId: KIMI_CODE_INSTANCE_ID,
        mode: "vendor-script",
        consent: { confirmed: true, ...plan.selectedOption.consentKey },
      }),
    );

    await secondReadStarted;
    await Effect.runPromise(
      provisioner.cancelInstall(KIMI_CODE_INSTANCE_ID, started.operationId ?? undefined),
    );
    releaseSecondRead();

    const finalState = await waitForPhase(
      () => Effect.runPromise(provisioner.getStatus(KIMI_CODE_INSTANCE_ID)),
      ["cancelled", "succeeded", "failed"],
    );
    expect(finalState.phase).toBe("cancelled");
    expect(upsertedInstances).toHaveLength(0);
  });

  it("redacts secrets in state.error and state.message when ACP initialize handshake fails (S5)", async () => {
    const installBinDir = makeTempDir("xtwork-vendor-redact-err-");
    const kimiBin = NodePath.join(installBinDir, "kimi");

    const { provisioner } = createHarness({
      env: { PATH: installBinDir },
      runCommand: () => {
        writeExecutable(kimiBin);
        return { promise: Promise.resolve({ exitCode: 0, signal: null }), cancel: () => {} };
      },
      verifyAcpInitialize: async () => ({
        ok: false,
        error:
          "ACP initialize failed: Authorization: Basic dXNlcjpwYXNz Bearer my-live-bearer-12345 sk-secretkey9876543210abcd API_KEY=supersecretval",
      }),
    });

    const plan = await Effect.runPromise(provisioner.getPlan(KIMI_CODE_INSTANCE_ID, "vendor-script"));
    await Effect.runPromise(
      provisioner.startInstall({
        instanceId: KIMI_CODE_INSTANCE_ID,
        mode: "vendor-script",
        consent: { confirmed: true, ...plan.selectedOption.consentKey },
      }),
    );
    const failed = await waitForPhase(
      () => Effect.runPromise(provisioner.getStatus(KIMI_CODE_INSTANCE_ID)),
      ["failed", "succeeded"],
    );
    expect(failed.phase).toBe("failed");
    const combined = `${failed.error ?? ""}\n${failed.message ?? ""}\n${failed.logs.join("\n")}`;
    expect(combined).not.toContain("dXNlcjpwYXNz");
    expect(combined).not.toContain("my-live-bearer-12345");
    expect(combined).not.toContain("sk-secretkey9876543210abcd");
    expect(combined).not.toContain("supersecretval");
    expect(failed.error).toContain("[REDACTED");
    expect(failed.message).toContain("[REDACTED");
  });

  it("resolves Windows Kimi executable under USERPROFILE\\.kimi-code\\bin and semicolon PATH (M1)", () => {
    const winHome = makeTempDir("xtwork-win-home-");
    const kimiExe = NodePath.join(winHome, ".kimi-code", "bin", "kimi.exe");
    NodeFs.mkdirSync(NodePath.dirname(kimiExe), { recursive: true });
    NodeFs.writeFileSync(kimiExe, "MZ-fake-windows-binary", { mode: 0o644 });

    const detected = findExecutableInPath(
      "kimi",
      { USERPROFILE: winHome, PATH: "" },
      "win32",
      [],
    );
    expect(detected).toBe(kimiExe);

    const pathDirA = makeTempDir("xtwork-win-path-a-");
    const pathDirB = makeTempDir("xtwork-win-path-b-");
    const pathQoderExe = NodePath.join(pathDirB, "qoder.exe");
    NodeFs.writeFileSync(pathQoderExe, "MZ-fake-windows-binary", { mode: 0o644 });
    const detectedFromPath = findExecutableInPath(
      "qoder",
      { USERPROFILE: makeTempDir("xtwork-win-empty-"), PATH: `${pathDirA};${pathDirB}` },
      "win32",
      [],
    );
    expect(detectedFromPath).toBe(pathQoderExe);
  });

  it("honors configured ACP distribution preference (e.g. npx) in getPlan and startInstall (M3)", async () => {
    const describedPrefs: Array<{ agentId: string; preference: string | undefined }> = [];
    const prepareCalls: Array<Record<string, unknown>> = [];
    const baseSettings = seedCodingAgents(DEFAULT_SERVER_SETTINGS).settings;
    const kimiSeed = baseSettings.providerInstances[KIMI_CODE_INSTANCE_ID]!;
    const pinnedNpxSettings: ServerSettings = {
      ...baseSettings,
      providerInstances: {
        ...baseSettings.providerInstances,
        [KIMI_CODE_INSTANCE_ID]: {
          ...kimiSeed,
          config: {
            ...(kimiSeed.config as Record<string, unknown>),
            distribution: "npx",
          },
        },
      },
    };

    const { baseDir, provisioner } = createHarness({
      settings: pinnedNpxSettings,
      acpDescribe: (agentId, preference) => {
        describedPrefs.push({ agentId, preference });
        if (preference === "npx") {
          return Effect.succeed({
            agentId,
            version: "2.1.0",
            distribution: "npx" as const,
            packageName: `@official/${agentId}@2.1.0`,
            installDir: NodePath.join(baseDir, "tools", agentId, "2.1.0", "npm"),
            installed: false,
            hasOtherInstalledVersion: false,
          });
        }
        return Effect.succeed({
          agentId,
          version: "2.1.0",
          distribution: "binary" as const,
          archiveUrl: `https://example.test/${agentId}.tar.gz`,
          sha256: "b".repeat(64),
          installDir: NodePath.join(baseDir, "tools", agentId, "2.1.0", "darwin-aarch64"),
          installed: false,
          hasOtherInstalledVersion: false,
        });
      },
      acpPrepare: (input) => {
        prepareCalls.push(input as unknown as Record<string, unknown>);
        return Effect.sync(() => {
          const dir = NodePath.join(baseDir, "tools", input.agentId, "2.1.0", "npm");
          NodeFs.mkdirSync(dir, { recursive: true });
          return {
            agentId: input.agentId,
            version: "2.1.0",
            distribution: "npx" as const,
            prepared: true as const,
          };
        });
      },
    });

    const plan = await Effect.runPromise(provisioner.getPlan(KIMI_CODE_INSTANCE_ID));
    expect(describedPrefs[0]).toEqual({ agentId: "kimi-code", preference: "npx" });
    expect(plan.distributionPreference).toBe("npx");
    expect(plan.selectedOption.distribution).toBe("npx");
    expect(plan.selectedOption.consentKey.distribution).toBe("npx");

    await Effect.runPromise(
      provisioner.startInstall({
        instanceId: KIMI_CODE_INSTANCE_ID,
        mode: "app-managed",
        consent: { confirmed: true, ...plan.selectedOption.consentKey },
      }),
    );
    const done = await waitForPhase(
      () => Effect.runPromise(provisioner.getStatus(KIMI_CODE_INSTANCE_ID)),
      ["succeeded", "failed"],
    );
    expect(done.phase).toBe("succeeded");
    expect(prepareCalls).toHaveLength(1);
    expect(prepareCalls[0]?.distributionPreference).toBe("npx");
    expect(prepareCalls[0]?.expectedDistribution).toBe("npx");
  });

  it("preserves committed binary, receipt, and succeeded state when cancel arrives mid-DeepSeek settings write (S4)", async () => {
    let settings = seedCodingAgents(DEFAULT_SERVER_SETTINGS).settings;
    let markWriteStarted!: () => void;
    const writeStarted = new Promise<void>((resolve) => {
      markWriteStarted = resolve;
    });
    let releaseWrite!: () => void;
    const writeGate = new Promise<void>((resolve) => {
      releaseWrite = resolve;
    });

    const { baseDir, provisioner } = createHarness({
      getSettingsOverride: () => Effect.succeed(settings),
      updateProviderInstanceOverride: (input) =>
        Effect.promise(async () => {
          markWriteStarted();
          await writeGate;
          settings = {
            ...settings,
            providerInstances: {
              ...settings.providerInstances,
              [input.instanceId]: input.instance,
            },
          };
        }),
      runCommand: ({ args }) => {
        const prefixIdx = args.indexOf("--prefix");
        const prefixDir = prefixIdx >= 0 ? args[prefixIdx + 1]! : "";
        writeExecutable(
          NodePath.join(prefixDir, "node_modules", ".bin", "dsh"),
          "#!/bin/sh\necho '1.4.2'\n",
        );
        return { promise: Promise.resolve({ exitCode: 0, signal: null }), cancel: () => {} };
      },
    });

    const plan = await Effect.runPromise(provisioner.getPlan(DEEPSEEK_HARNESS_INSTANCE_ID));
    const started = await Effect.runPromise(
      provisioner.startInstall({
        instanceId: DEEPSEEK_HARNESS_INSTANCE_ID,
        mode: "app-managed",
        consent: { confirmed: true, ...plan.selectedOption.consentKey },
      }),
    );

    // Wait until DeepSeek settings write is actively in flight inside commitSemaphore.
    await writeStarted;

    // Issue cancel right in the middle of the settings write; it must wait for commitSemaphore
    // without setting op.cancelled=true or deleting the newly wired managed binary.
    const cancelPromise = Effect.runPromise(
      provisioner.cancelInstall(DEEPSEEK_HARNESS_INSTANCE_ID, started.operationId!),
    );
    await new Promise((resolve) => setTimeout(resolve, 40));
    releaseWrite();

    const cancelResult = await cancelPromise;
    expect(cancelResult.phase).toBe("succeeded");

    const finalState = await waitForPhase(
      () => Effect.runPromise(provisioner.getStatus(DEEPSEEK_HARNESS_INSTANCE_ID)),
      ["succeeded", "cancelled", "failed"],
    );
    expect(finalState.phase).toBe("succeeded");

    const managedBin = NodePath.join(
      baseDir,
      "tools",
      "deepseek-harness",
      "node_modules",
      ".bin",
      "dsh",
    );
    expect(NodeFs.existsSync(managedBin)).toBe(true);
    const savedConfig = settings.providerInstances[DEEPSEEK_HARNESS_INSTANCE_ID]?.config as Record<
      string,
      unknown
    >;
    expect(savedConfig.commandPath).toBe(managedBin);
    const receiptsRaw = NodeFs.readFileSync(
      NodePath.join(baseDir, "tools", "provisioner-receipts.json"),
      "utf8",
    );
    expect(receiptsRaw).toContain(DEEPSEEK_HARNESS_INSTANCE_ID);
  });

  it("redacts JSON-formatted credentials in redactSecrets and ACP verifier failures (S5)", async () => {
    const jsonPayload = JSON.stringify({
      api_key: "json-secret-1",
      apiKey: "json-secret-2",
      password: "pw-secret-3",
      access_token: "tok-secret-4",
      refresh_token: "ref-secret-5",
      secret: "sec-secret-6",
      token: "t-secret-7",
      numeric_token: 9876543210,
    });
    const cleanedJson = redactSecrets(
      `${jsonPayload} authorization: DEMO_AUTH_1 authorization="DEMO_AUTH_2" authorization='DEMO_AUTH_3'\nAuthorization:\nAuthorization: DEMO_MULTILINE_CRED`,
    );
    for (const leaked of [
      "json-secret-1",
      "json-secret-2",
      "pw-secret-3",
      "tok-secret-4",
      "ref-secret-5",
      "sec-secret-6",
      "t-secret-7",
      "9876543210",
      "DEMO_AUTH_1",
      "DEMO_AUTH_2",
      "DEMO_AUTH_3",
      "DEMO_MULTILINE_CRED",
    ]) {
      expect(cleanedJson).not.toContain(leaked);
    }
    expect(cleanedJson).toContain("[REDACTED]");

    const binDir = makeTempDir("xtwork-s5-json-");
    const kimiPath = NodePath.join(binDir, "kimi");
    const { provisioner } = createHarness({
      env: { PATH: binDir },
      runCommand: () => {
        writeExecutable(kimiPath, "#!/bin/sh\necho '2.1.0'\n");
        return { promise: Promise.resolve({ exitCode: 0, signal: null }), cancel: () => {} };
      },
      verifyAcpInitialize: async () => ({
        ok: false,
        error: `ACP stderr: {"api_key":"kimi-json-key-999","apiKey":"kimi-camel-888","password":"kimi-pw-777","access_token":"kimi-tok-666"}`,
      }),
    });

    const plan = await Effect.runPromise(provisioner.getPlan(KIMI_CODE_INSTANCE_ID, "vendor-script"));
    await Effect.runPromise(
      provisioner.startInstall({
        instanceId: KIMI_CODE_INSTANCE_ID,
        mode: "vendor-script",
        consent: { confirmed: true, ...plan.selectedOption.consentKey },
      }),
    );
    const failed = await waitForPhase(
      () => Effect.runPromise(provisioner.getStatus(KIMI_CODE_INSTANCE_ID)),
      ["failed", "succeeded"],
    );
    expect(failed.phase).toBe("failed");
    const combined = `${failed.error ?? ""}\n${failed.message ?? ""}\n${failed.logs.join("\n")}`;
    expect(combined).not.toContain("kimi-json-key-999");
    expect(combined).not.toContain("kimi-camel-888");
    expect(combined).not.toContain("kimi-pw-777");
    expect(combined).not.toContain("kimi-tok-666");
    expect(failed.error).toContain("[REDACTED]");
    expect(failed.message).toContain("[REDACTED]");
  });

  it("stages managed npm upgrades and preserves previous runtime when cancelled during verification", async () => {
    let resolveVerifyStarted!: () => void;
    const verifyStarted = new Promise<void>((resolve) => {
      resolveVerifyStarted = resolve;
    });

    const { baseDir, provisioner } = createHarness({
      runCommand: ({ args }) => {
        const prefixDir = args[args.indexOf("--prefix") + 1]!;
        writeExecutable(
          NodePath.join(prefixDir, "node_modules", ".bin", "dsh"),
          "#!/bin/sh\necho '2.0.0-new'\n",
        );
        return { promise: Promise.resolve({ exitCode: 0, signal: null }), cancel: () => {} };
      },
      probeVersion: (execPath, _env, signal) => {
        if (!execPath.includes(".staging-")) {
          return Promise.resolve("1.0.0");
        }
        return new Promise<string | null>((resolve) => {
          resolveVerifyStarted();
          signal?.addEventListener("abort", () => resolve(null), { once: true });
        });
      },
    });

    // Pre-populate an existing v1.0.0 managed installation at tools/deepseek-harness.
    const liveDir = NodePath.join(baseDir, "tools", "deepseek-harness");
    const liveBin = NodePath.join(liveDir, "node_modules", ".bin", "dsh");
    writeExecutable(liveBin, "#!/bin/sh\necho '1.0.0-old'\n");

    const plan = await Effect.runPromise(provisioner.getPlan(DEEPSEEK_HARNESS_INSTANCE_ID));
    const started = await Effect.runPromise(
      provisioner.startInstall({
        instanceId: DEEPSEEK_HARNESS_INSTANCE_ID,
        mode: "app-managed",
        consent: { confirmed: true, ...plan.selectedOption.consentKey },
      }),
    );

    await verifyStarted;
    await Effect.runPromise(
      provisioner.cancelInstall(DEEPSEEK_HARNESS_INSTANCE_ID, started.operationId!),
    );
    const done = await waitForPhase(
      () => Effect.runPromise(provisioner.getStatus(DEEPSEEK_HARNESS_INSTANCE_ID)),
      ["cancelled", "succeeded", "failed"],
    );
    expect(done.phase).toBe("cancelled");
    // Previous v1.0.0 binary MUST remain completely untouched and staging dir must be removed!
    expect(NodeFs.readFileSync(liveBin, "utf8")).toContain("1.0.0-old");
    const leftovers = NodeFs.readdirSync(NodePath.join(baseDir, "tools")).filter((f) =>
      f.includes(".staging-"),
    );
    expect(leftovers).toEqual([]);
  });

  it("fails managed npm verification when executable probe returns null even if package.json exists", async () => {
    const { baseDir, provisioner, upsertedInstances } = createHarness({
      runCommand: ({ args }) => {
        const prefixDir = args[args.indexOf("--prefix") + 1]!;
        writeExecutable(NodePath.join(prefixDir, "node_modules", ".bin", "dsh"), "#!/bin/sh\nexit 1\n");
        const pkgDir = NodePath.join(prefixDir, "node_modules", "@deepseek-ai", "dsh");
        NodeFs.mkdirSync(pkgDir, { recursive: true });
        NodeFs.writeFileSync(NodePath.join(pkgDir, "package.json"), JSON.stringify({ version: "1.4.2" }));
        return { promise: Promise.resolve({ exitCode: 0, signal: null }), cancel: () => {} };
      },
      probeVersion: async () => null,
    });

    const plan = await Effect.runPromise(provisioner.getPlan(DEEPSEEK_HARNESS_INSTANCE_ID));
    await Effect.runPromise(
      provisioner.startInstall({
        instanceId: DEEPSEEK_HARNESS_INSTANCE_ID,
        mode: "app-managed",
        consent: { confirmed: true, ...plan.selectedOption.consentKey },
      }),
    );
    const done = await waitForPhase(
      () => Effect.runPromise(provisioner.getStatus(DEEPSEEK_HARNESS_INSTANCE_ID)),
      ["failed", "succeeded"],
    );
    expect(done.phase).toBe("failed");
    expect(done.error).toContain("--version did not succeed");
    expect(upsertedInstances).toHaveLength(0);
    expect(NodeFs.existsSync(NodePath.join(baseDir, "tools", "deepseek-harness"))).toBe(false);
  });

  it("records terminal failed state instead of hanging when an unexpected filesystem defect occurs during receipt write", async () => {
    const { baseDir, provisioner } = createHarness({
      runCommand: ({ args }) => {
        const prefixDir = args[args.indexOf("--prefix") + 1]!;
        writeExecutable(NodePath.join(prefixDir, "node_modules", ".bin", "dsh"));
        return { promise: Promise.resolve({ exitCode: 0, signal: null }), cancel: () => {} };
      },
    });

    // Make provisioner-receipts.json a non-empty directory so atomic rename in upsertReceipt throws EISDIR/ENOTEMPTY!
    const receiptsDirObstacle = NodePath.join(baseDir, "tools", "provisioner-receipts.json");
    NodeFs.mkdirSync(receiptsDirObstacle, { recursive: true });
    NodeFs.writeFileSync(NodePath.join(receiptsDirObstacle, "blocker"), "x");

    const plan = await Effect.runPromise(provisioner.getPlan(DEEPSEEK_HARNESS_INSTANCE_ID));
    await Effect.runPromise(
      provisioner.startInstall({
        instanceId: DEEPSEEK_HARNESS_INSTANCE_ID,
        mode: "app-managed",
        consent: { confirmed: true, ...plan.selectedOption.consentKey },
      }),
    );
    const done = await waitForPhase(
      () => Effect.runPromise(provisioner.getStatus(DEEPSEEK_HARNESS_INSTANCE_ID)),
      ["failed", "succeeded", "cancelled"],
    );
    expect(done.phase).toBe("failed");
    expect(done.error).toBeTruthy();
    expect(done.finishedAt).toBeTruthy();
    // Staged directory must also have been rolled back cleanly!
    expect(NodeFs.existsSync(NodePath.join(baseDir, "tools", "deepseek-harness"))).toBe(false);
  });
});
