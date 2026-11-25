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
  makeProviderProvisioner,
  sanitizeProvisionLogLine,
  type ProvisionCommandRunner,
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
  readonly acpDescribe?: AcpRegistrySupport.AcpRegistryCatalog["Service"]["describeAgent"];
  readonly acpPrepare?: AcpRegistrySupport.AcpRegistryCatalog["Service"]["prepare"];
  readonly codexState?: ProviderInstallState;
  readonly codexStart?: () => Effect.Effect<ProviderInstallState>;
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
    state: Effect.succeed(codexDefaultState),
    changes: Stream.empty,
  } as unknown as CodexInstallation.CodexInstallation["Service"];

  const providerInstallation = {
    start: () =>
      options?.codexStart
        ? options.codexStart()
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
    probeVersion: async () => "1.4.2",
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
  it("sanitizes ANSI sequences and secrets in logs", () => {
    const cleaned = sanitizeProvisionLogLine(
      "\u001B[32mInstalling\u001B[0m Bearer supersecret123 sk-1234567890abcdef token=abc123",
    );
    expect(cleaned).not.toContain("\u001B");
    expect(cleaned).not.toContain("supersecret123");
    expect(cleaned).not.toContain("sk-1234567890abcdef");
    expect(cleaned).not.toContain("abc123");
    expect(cleaned).toContain("[REDACTED]");
    expect(cleaned).toContain("[REDACTED_KEY]");
  });

  it("rejects installation when consent is missing or does not match current plan", async () => {
    const { provisioner } = createHarness();
    const plan = await Effect.runPromise(provisioner.getPlan(KIMI_CODE_INSTANCE_ID));
    expect(plan.consentRequired).toBe(true);
    expect(plan.consentReason).toBe("install_required");
    expect(plan.selectedMode).toBe("app-managed");

    await expect(
      Effect.runPromise(
        provisioner.startInstall({
          instanceId: KIMI_CODE_INSTANCE_ID,
          consent: {
            confirmed: false,
            ...plan.selectedOption.consentKey,
          },
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
            version: "0.0.1-stale",
          },
        }),
      ),
    ).rejects.toThrow(/install plan changed/i);
  });

  it("installs Kimi/Qoder/Codebuddy via consent + ACP Registry prepare and supports clean uninstall", async () => {
    let preparedInput: { agentId: string; instanceId?: string } | undefined;
    const { baseDir, consent, provisioner, refreshedInstances } = createHarness({
      acpPrepare: (input) =>
        Effect.sync(() => {
          preparedInput = input;
          const dir = NodePath.join(baseDir, "tools", input.agentId, "2.1.0", "npm");
          NodeFs.mkdirSync(dir, { recursive: true });
          return {
            agentId: input.agentId,
            version: "2.1.0",
            distribution: "npx" as const,
            prepared: true as const,
          };
        }),
    });

    const plan = await Effect.runPromise(provisioner.getPlan(KIMI_CODE_INSTANCE_ID));
    await Effect.runPromise(
      provisioner.startInstall({
        instanceId: KIMI_CODE_INSTANCE_ID,
        mode: "app-managed",
        consent: { confirmed: true, ...plan.selectedOption.consentKey },
      }),
    );

    const finalState = await waitForPhase(
      () => Effect.runPromise(provisioner.getStatus(KIMI_CODE_INSTANCE_ID)),
      ["succeeded", "failed"],
    );
    expect(finalState.phase).toBe("succeeded");
    expect(finalState.installedVersion).toBe("2.1.0");
    expect(preparedInput).toEqual({ agentId: "kimi-code", instanceId: KIMI_CODE_INSTANCE_ID });
    expect(await Effect.runPromise(consent.hasConsent(plan.selectedOption.consentKey))).toBe(true);
    expect(refreshedInstances).toContain(KIMI_CODE_INSTANCE_ID);

    // Uninstall cleans managed directory and revokes consent.
    const afterPlan = await Effect.runPromise(provisioner.getPlan(KIMI_CODE_INSTANCE_ID));
    expect(afterPlan.canUninstall).toBe(true);
    const uninstalled = await Effect.runPromise(provisioner.uninstall(KIMI_CODE_INSTANCE_ID));
    expect(uninstalled.phase).toBe("idle");
    expect(NodeFs.existsSync(NodePath.join(baseDir, "tools", "kimi-code"))).toBe(false);
    expect(await Effect.runPromise(consent.hasConsent(plan.selectedOption.consentKey))).toBe(false);
  });

  it("installs DeepSeek Harness into isolated dir, auto-wires commandPath, and preserves custom paths", async () => {
    const installedArgs: Array<ReadonlyArray<string>> = [];
    const { baseDir, provisioner, getSettings } = createHarness({
      runCommand: ({ args, onOutput }) => {
        installedArgs.push(args);
        const prefixIdx = args.indexOf("--prefix");
        const prefixDir = args[prefixIdx + 1]!;
        writeExecutable(NodePath.join(prefixDir, "node_modules", ".bin", "dsh"));
        onOutput("added 1 package @deepseek-ai/dsh\n");
        return {
          promise: Promise.resolve({ exitCode: 0, signal: null }),
          cancel: () => {},
        };
      },
    });

    const plan = await Effect.runPromise(provisioner.getPlan(DEEPSEEK_HARNESS_INSTANCE_ID));
    expect(plan.selectedMode).toBe("app-managed");
    expect(plan.selectedOption.commandPreview).toContain("@deepseek-ai/dsh");

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
    expect(finalState.installedVersion).toBe("1.4.2");
    expect(installedArgs[0]).toContain("@deepseek-ai/dsh");

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
    expect(updatedConfig.commandArgs).toEqual(["--profile", "acp"]);

    // Uninstall removes managed directory and restores default "dsh".
    await Effect.runPromise(provisioner.uninstall(DEEPSEEK_HARNESS_INSTANCE_ID));
    expect(NodeFs.existsSync(NodePath.join(baseDir, "tools", "deepseek-harness"))).toBe(false);
    const restoredConfig = getSettings().providerInstances[DEEPSEEK_HARNESS_INSTANCE_ID]
      ?.config as Record<string, unknown>;
    expect(restoredConfig.commandPath).toBe("dsh");
  });

  it("detects existing user PATH binary without overwriting custom paths", async () => {
    const userBinDir = makeTempDir("xtwork-user-bin-");
    const userDsh = NodePath.join(userBinDir, "dsh");
    writeExecutable(userDsh);

    const customSettings = seedCodingAgents(DEFAULT_SERVER_SETTINGS).settings;
    const withCustomDsh: ServerSettings = {
      ...customSettings,
      providerInstances: {
        ...customSettings.providerInstances,
        [DEEPSEEK_HARNESS_INSTANCE_ID]: {
          driver: ProviderDriverKind.make("acpRegistry"),
          displayName: "DeepSeek Harness",
          enabled: true,
          config: {
            source: "local",
            commandPath: "/opt/custom/dsh",
            commandArgs: ["--profile", "acp"],
            enabled: true,
          },
        },
      },
    };

    const { provisioner, getSettings } = createHarness({
      settings: withCustomDsh,
      env: { PATH: userBinDir },
      runCommand: ({ args }) => {
        const prefixDir = args[args.indexOf("--prefix") + 1]!;
        writeExecutable(NodePath.join(prefixDir, "node_modules", ".bin", "dsh"));
        return { promise: Promise.resolve({ exitCode: 0, signal: null }), cancel: () => {} };
      },
    });

    const plan = await Effect.runPromise(provisioner.getPlan(DEEPSEEK_HARNESS_INSTANCE_ID));
    expect(plan.existingDetection).toEqual({
      detected: true,
      source: "user-path",
      executablePath: userDsh,
      version: "1.4.2",
    });
    expect(plan.canUninstall).toBe(false);

    // Even if user installs managed copy explicitly, their custom commandPath stays untouched.
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
    const afterConfig = getSettings().providerInstances[DEEPSEEK_HARNESS_INSTANCE_ID]
      ?.config as Record<string, unknown>;
    expect(afterConfig.commandPath).toBe("/opt/custom/dsh");
  });

  it("supports cancelling an active install and cleans up partial managed directory", async () => {
    let cancelCalled = false;
    let resolveStarted!: () => void;
    const commandStarted = new Promise<void>((resolve) => {
      resolveStarted = resolve;
    });
    let resolveExit!: (value: { exitCode: number; signal: NodeJS.Signals | null }) => void;

    const { baseDir, provisioner } = createHarness({
      runCommand: ({ args, onOutput }) => {
        onOutput("downloading...\n");
        const prefixDir = args[args.indexOf("--prefix") + 1]!;
        NodeFs.writeFileSync(NodePath.join(prefixDir, "partial.tmp"), "in-progress");
        resolveStarted();
        return {
          promise: new Promise((resolve) => {
            resolveExit = resolve;
          }),
          cancel: () => {
            cancelCalled = true;
            resolveExit({ exitCode: 1, signal: "SIGTERM" });
          },
        };
      },
    });

    const plan = await Effect.runPromise(provisioner.getPlan(DEEPSEEK_HARNESS_INSTANCE_ID));
    const started = await Effect.runPromise(
      provisioner.startInstall({
        instanceId: DEEPSEEK_HARNESS_INSTANCE_ID,
        consent: { confirmed: true, ...plan.selectedOption.consentKey },
      }),
    );
    expect(started.phase).toBe("installing");
    await commandStarted;

    await Effect.runPromise(
      provisioner.cancelInstall(DEEPSEEK_HARNESS_INSTANCE_ID, started.operationId ?? undefined),
    );
    const settled = await waitForPhase(
      () => Effect.runPromise(provisioner.getStatus(DEEPSEEK_HARNESS_INSTANCE_ID)),
      ["cancelled"],
    );
    expect(cancelCalled).toBe(true);
    expect(settled.phase).toBe("cancelled");
    expect(NodeFs.existsSync(NodePath.join(baseDir, "tools", "deepseek-harness"))).toBe(false);
  });

  it("exposes vendor-script default and optional app-managed npm mode for Claude Code with honest uninstall semantics", async () => {
    const { provisioner } = createHarness();
    const defaultPlan = await Effect.runPromise(provisioner.getPlan("claudeAgent"));
    expect(defaultPlan.defaultMode).toBe("vendor-script");
    expect(defaultPlan.selectedMode).toBe("vendor-script");
    expect(defaultPlan.selectedOption.commandPreview).toBe(
      "curl -fsSL https://claude.ai/install.sh | bash",
    );
    expect(defaultPlan.uninstallSemantics).toBe("vendor-managed");
    expect(defaultPlan.canUninstall).toBe(false);
    expect(defaultPlan.availableModes.map((m) => m.mode)).toEqual([
      "vendor-script",
      "app-managed",
    ]);

    const managedPlan = await Effect.runPromise(
      provisioner.getPlan("claudeAgent", "app-managed"),
    );
    expect(managedPlan.selectedMode).toBe("app-managed");
    expect(managedPlan.selectedOption.commandPreview).toContain("@anthropic-ai/claude-code");
    expect(managedPlan.selectedOption.uninstallSemantics).toBe("app-managed");

    // Refuses to uninstall when nothing app-managed is installed.
    await expect(Effect.runPromise(provisioner.uninstall("claudeAgent"))).rejects.toThrow(
      /official script|uninstall/i,
    );
  });

  it("delegates Codex managed install and uninstall to T3 ProviderInstallation", async () => {
    let startCalled = false;
    let removeCalled = false;
    const { provisioner, refreshedInstances } = createHarness({
      codexStart: () =>
        Effect.sync(() => {
          startCalled = true;
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
      codexRemove: () =>
        Effect.sync(() => {
          removeCalled = true;
          return {
            driver: ProviderDriverKind.make("codex"),
            operationId: null,
            phase: "idle" as const,
            downloadedBytes: 0,
            totalBytes: 100,
            version: "0.166.0",
            installedVersion: null,
            executablePath: null,
            canRemove: false,
            message: null,
          };
        }),
    });

    const plan = await Effect.runPromise(provisioner.getPlan("codex"));
    expect(plan.selectedMode).toBe("app-managed");
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
    expect(startCalled).toBe(true);
    expect(settled.phase).toBe("succeeded");
    expect(refreshedInstances).toContain("codex");

    // Verify uninstall delegates to providerInstallation.remove when managed Codex is installed.
    const installedHarness = createHarness({
      codexState: {
        driver: ProviderDriverKind.make("codex"),
        operationId: null,
        phase: "succeeded",
        downloadedBytes: 100,
        totalBytes: 100,
        version: "0.166.0",
        installedVersion: "0.166.0",
        executablePath: "/tmp/codex",
        canRemove: true,
        source: "managed",
        message: null,
      },
      codexRemove: () =>
        Effect.sync(() => {
          removeCalled = true;
          return {
            driver: ProviderDriverKind.make("codex"),
            operationId: null,
            phase: "idle" as const,
            downloadedBytes: 0,
            totalBytes: 100,
            version: "0.166.0",
            installedVersion: null,
            executablePath: null,
            canRemove: false,
            message: null,
          };
        }),
    });
    await Effect.runPromise(installedHarness.provisioner.uninstall("codex"));
    expect(removeCalled).toBe(true);
  });

  it("plans Qoder and Codebuddy Code with both app-managed and vendor-script options", async () => {
    const { provisioner } = createHarness();
    const qoderPlan = await Effect.runPromise(provisioner.getPlan(QODER_INSTANCE_ID));
    const codebuddyPlan = await Effect.runPromise(provisioner.getPlan(CODEBUDDY_CODE_INSTANCE_ID));
    expect(qoderPlan.availableModes.map((m) => m.mode)).toEqual(["app-managed", "vendor-script"]);
    expect(codebuddyPlan.availableModes.map((m) => m.mode)).toEqual([
      "app-managed",
      "vendor-script",
    ]);
    expect(qoderPlan.displayName).toBe("Qoder");
    expect(codebuddyPlan.displayName).toBe("Codebuddy Code");
  });
});
