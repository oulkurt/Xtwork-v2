// @effect-diagnostics nodeBuiltinImport:off globalDate:off globalTimers:off
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
  makeProviderProvisioner,
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
    getSettings: () => Effect.succeed(settings),
    updateProviderInstance: ({ instanceId, instance }) =>
      Effect.sync(() => {
        upsertedInstances.push({ instanceId, instance });
        settings = {
          ...settings,
          providerInstances: {
            ...settings.providerInstances,
            [instanceId]: instance,
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
      [KIMI_CODE_INSTANCE_ID, "https://code.kimi.com/install.sh"],
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
});
