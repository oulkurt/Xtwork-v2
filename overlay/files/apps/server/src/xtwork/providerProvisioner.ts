// @effect-diagnostics nodeBuiltinImport:off globalTimers:off globalDate:off globalDateInEffect:off globalJsonInEffect:off effectTryWithoutCatch:off globalErrorInEffectCatch:off globalErrorInEffectFailure:off effectFnOpportunity:off extendsNativeError:off anyUnknownInErrorContext:off runEffectInsideEffect:off
import {
  AuthOrchestrationReadScope,
  AuthProvidersManageScope,
  ProviderDriverKind,
  ProviderInstanceId,
  type ProviderInstanceConfig,
  type ProviderInstallState,
  type ServerSettings,
} from "@t3tools/contracts";
import * as AcpRegistrySupport from "@t3tools/provider-acp-registry/server/AcpRegistrySupport";
import * as HostProcess from "@t3tools/shared/HostProcess";
import * as ByteSize from "effect/ByteSize";
import * as Context from "effect/Context";
import * as Effect from "effect/Effect";
import * as Fiber from "effect/Fiber";
import * as Layer from "effect/Layer";
import * as Option from "effect/Option";
import * as Stream from "effect/Stream";
import * as ChildProcessSpawner from "effect/process/ChildProcessSpawner";
import { Headers, HttpRouter, HttpServerRequest, HttpServerResponse } from "effect/http";
import * as NodeChildProcess from "node:child_process";
import * as NodeCrypto from "node:crypto";
import * as NodeFs from "node:fs";
import * as NodeOs from "node:os";
import * as NodePath from "node:path";
import { EnvironmentAuth, parseBearerToken } from "../auth/EnvironmentAuth.ts";
import * as ServerConfig from "../config.ts";
import { refreshPathFromLoginShell } from "../os-jank.ts";
import * as CodexInstallation from "../provider/CodexInstallation.ts";
import * as ProviderInstallation from "../provider/providerInstallation.ts";
import * as ProviderRegistry from "../provider/ProviderRegistry.ts";
import * as ServerSettingsService from "../serverSettings.ts";
import {
  CODEBUDDY_CODE_INSTANCE_ID,
  DEEPSEEK_HARNESS_INSTANCE_ID,
  KIMI_CODE_INSTANCE_ID,
  QODER_INSTANCE_ID,
} from "./codingAgentSeed.ts";
import {
  installConsentKeysEqual,
  normalizeInstallConsentKey,
  XtworkInstallConsent,
  type InstallConsentKey,
  type XtworkInstallConsentService,
} from "./installConsent.ts";

export type ProvisionerPhase =
  | "idle"
  | "awaiting_consent"
  | "installing"
  | "verifying"
  | "succeeded"
  | "failed"
  | "cancelled";

export type ProvisionInstallMode = "app-managed" | "vendor-script";

export type ProvisionAgentKind =
  | "codex"
  | "claude"
  | "kimi-code"
  | "qoder"
  | "codebuddy-code"
  | "deepseek-harness";

export interface ExistingInstallDetection {
  readonly detected: boolean;
  readonly source: "user-path" | "app-managed" | "none";
  readonly executablePath: string | null;
  readonly version: string | null;
}

export interface ProvisionPlanOption {
  readonly mode: ProvisionInstallMode;
  readonly label: string;
  readonly labelZh: string;
  readonly summary: string;
  readonly summaryZh: string;
  readonly commandPreview: string;
  readonly officialSource: string;
  readonly targetInstallDir: string;
  readonly uninstallSemantics: "app-managed" | "vendor-managed";
  readonly uninstallGuidance: string;
  readonly uninstallGuidanceZh: string;
  readonly consentKey: InstallConsentKey;
  readonly availableVersion: string | null;
  readonly distribution: string;
}

export interface ProviderProvisionState {
  readonly instanceId: string;
  readonly phase: ProvisionerPhase;
  readonly operationId: string | null;
  readonly mode: ProvisionInstallMode | null;
  readonly message: string | null;
  readonly error: string | null;
  readonly logs: ReadonlyArray<string>;
  readonly installedVersion: string | null;
  readonly executablePath: string | null;
  readonly startedAt: string | null;
  readonly finishedAt: string | null;
}

export interface ProviderInstallPlan {
  readonly instanceId: string;
  readonly agentKind: ProvisionAgentKind;
  readonly displayName: string;
  readonly defaultMode: ProvisionInstallMode;
  readonly selectedMode: ProvisionInstallMode;
  readonly selectedOption: ProvisionPlanOption;
  readonly availableModes: ReadonlyArray<ProvisionPlanOption>;
  readonly existingDetection: ExistingInstallDetection;
  readonly installedVersion: string | null;
  readonly availableVersion: string | null;
  readonly updateAvailable: boolean;
  readonly consentRequired: boolean;
  readonly consentReason: "install_required" | "update_required" | null;
  readonly canUninstall: boolean;
  readonly uninstallSemantics: "app-managed" | "vendor-managed";
  readonly uninstallGuidance: string;
  readonly uninstallGuidanceZh: string;
  readonly state: ProviderProvisionState;
}

export interface ProvisionInstallConsentPayload {
  readonly confirmed: boolean;
  readonly source: string;
  readonly version: string;
  readonly distribution: string;
  readonly installDir: string;
}

export interface ProvisionInstallRequest {
  readonly instanceId: string;
  readonly mode?: ProvisionInstallMode | undefined;
  readonly consent: ProvisionInstallConsentPayload;
}

export interface ProvisionerReceipt {
  readonly instanceId: string;
  readonly agentKind: ProvisionAgentKind;
  readonly mode: "app-managed";
  readonly source: string;
  readonly version: string;
  readonly distribution: string;
  readonly installDir: string;
  readonly executablePath: string | null;
  readonly installedAt: string;
}

interface PersistedReceiptsFile {
  readonly version: 1;
  readonly receipts: ReadonlyArray<ProvisionerReceipt>;
}

export interface SpawnedCommandHandle {
  readonly promise: Promise<{ readonly exitCode: number; readonly signal: NodeJS.Signals | null }>;
  readonly cancel: () => void;
}

export type ProvisionCommandRunner = (input: {
  readonly command: string;
  readonly args: ReadonlyArray<string>;
  readonly env: NodeJS.ProcessEnv;
  readonly cwd?: string;
  readonly onOutput: (chunk: string) => void;
}) => SpawnedCommandHandle;

export type ProvisionVersionProber = (
  executablePath: string,
  env: NodeJS.ProcessEnv,
) => Promise<string | null>;

const MAX_LOG_LINES = 300;
const MAX_LOG_LINE_CHARS = 400;
const VENDOR_GLOBAL_INSTALL_DIR = "vendor-global";

const ANSI_ESCAPE_PATTERN =
  // eslint-disable-next-line no-control-regex
  /\u001B(?:\][^\u0007\u001B]*(?:\u0007|\u001B\\)|\[[0-9;?]*[ -/]*[@-~])/g;
const SECRET_PATTERNS: ReadonlyArray<readonly [RegExp, string]> = [
  [/\b(sk-[A-Za-z0-9_-]{12,})\b/g, "[REDACTED_KEY]"],
  [/\b(Bearer\s+)[A-Za-z0-9._~+/-]+=*/gi, "$1[REDACTED]"],
  [/\b((?:ANTHROPIC|OPENAI|DEEPSEEK|KIMI|API)[A-Z0-9_]*(?:KEY|TOKEN|SECRET)\s*=\s*)\S+/gi, "$1[REDACTED]"],
  [/\b((?:api[_-]?key|access[_-]?token|refresh[_-]?token|token|secret|password)\s*[=:]\s*)\S+/gi, "$1[REDACTED]"],
];

export function sanitizeProvisionLogLine(raw: string): string {
  let clean = raw.replace(ANSI_ESCAPE_PATTERN, "").replace(/\r/g, "").trimEnd();
  for (const [pattern, replacement] of SECRET_PATTERNS) {
    clean = clean.replace(pattern, replacement);
  }
  if (clean.length > MAX_LOG_LINE_CHARS) {
    clean = `${clean.slice(0, MAX_LOG_LINE_CHARS - 1)}…`;
  }
  return clean;
}

export function extractVersionString(output: string): string | null {
  const match = /\bv?(\d+\.\d+\.\d+(?:-[0-9A-Za-z.-]+)?)\b/.exec(output);
  return match?.[1] ?? null;
}

function isExecutableFile(filePath: string): boolean {
  try {
    const stat = NodeFs.statSync(filePath);
    if (!stat.isFile()) return false;
    if (process.platform === "win32") return true;
    return (stat.mode & 0o111) !== 0;
  } catch {
    return false;
  }
}

function isInsideDirectory(candidate: string, parentDir: string): boolean {
  const rel = NodePath.relative(NodePath.resolve(parentDir), NodePath.resolve(candidate));
  return rel === "" || (!rel.startsWith("..") && !NodePath.isAbsolute(rel));
}

function resolveBundledNpm(env: NodeJS.ProcessEnv, platform: NodeJS.Platform): string | null {
  const npmName = platform === "win32" ? "npm.cmd" : "npm";
  const bundledBin = env.XTWORK_BUNDLED_NODE_BIN?.trim();
  if (bundledBin) {
    const candidate = NodePath.join(bundledBin, npmName);
    if (isExecutableFile(candidate)) return candidate;
  }
  const execDir = NodePath.dirname(process.execPath);
  const siblingNpm = NodePath.join(execDir, npmName);
  if (isExecutableFile(siblingNpm)) return siblingNpm;
  return findExecutableInPath(npmName, env, platform, []);
}

export function findExecutableInPath(
  binaryName: string,
  env: NodeJS.ProcessEnv,
  platform: NodeJS.Platform,
  excludedDirs: ReadonlyArray<string>,
): string | null {
  const rawPath =
    platform === "win32"
      ? (env.PATH ?? env.Path ?? env.path ?? "")
      : (env.PATH ?? "");
  const home = env.HOME?.trim() || NodeOs.homedir();
  const extraDirs =
    platform === "win32"
      ? []
      : [
          NodePath.join(home, ".local", "bin"),
          NodePath.join(home, ".claude", "local", "bin"),
          ...(env.XTWORK_DISABLE_SYSTEM_PATH_PROBE === "1"
            ? []
            : ["/opt/homebrew/bin", "/usr/local/bin"]),
        ];
  const dirs = [
    ...rawPath.split(NodePath.delimiter).filter(Boolean),
    ...extraDirs,
  ];
  const seen = new Set<string>();
  const extensions =
    platform === "win32" ? ["", ".exe", ".cmd", ".bat"] : [""];

  for (const rawDir of dirs) {
    const dir = NodePath.resolve(rawDir);
    if (seen.has(dir)) continue;
    seen.add(dir);
    if (excludedDirs.some((excluded) => isInsideDirectory(dir, excluded))) continue;
    for (const ext of extensions) {
      const candidate = NodePath.join(dir, `${binaryName}${ext}`);
      if (isExecutableFile(candidate)) {
        try {
          const real = NodeFs.realpathSync(candidate);
          if (excludedDirs.some((excluded) => isInsideDirectory(real, excluded))) continue;
        } catch {
          // keep candidate
        }
        return candidate;
      }
    }
  }
  return null;
}

const defaultVersionProber: ProvisionVersionProber = (executablePath, env) =>
  new Promise((resolve) => {
    NodeChildProcess.execFile(
      executablePath,
      ["--version"],
      { env, timeout: 5_000, maxBuffer: 64 * 1024 },
      (error, stdout, stderr) => {
        if (error) {
          resolve(null);
          return;
        }
        resolve(extractVersionString(`${stdout}\n${stderr}`));
      },
    );
  });

const defaultCommandRunner: ProvisionCommandRunner = ({ command, args, env, cwd, onOutput }) => {
  const detached = process.platform !== "win32";
  const child = NodeChildProcess.spawn(command, [...args], {
    env,
    ...(cwd ? { cwd } : {}),
    stdio: ["ignore", "pipe", "pipe"],
    detached,
  });

  const handleChunk = (chunk: Buffer) => {
    onOutput(chunk.toString("utf8"));
  };
  child.stdout?.on("data", handleChunk);
  child.stderr?.on("data", handleChunk);

  let cancelled = false;
  let forceKillTimer: ReturnType<typeof setTimeout> | undefined;

  const cancel = () => {
    if (cancelled) return;
    cancelled = true;
    try {
      if (detached && child.pid) {
        process.kill(-child.pid, "SIGTERM");
      } else {
        child.kill("SIGTERM");
      }
    } catch {
      // process may already have exited
    }
    forceKillTimer = setTimeout(() => {
      try {
        if (detached && child.pid) {
          process.kill(-child.pid, "SIGKILL");
        } else {
          child.kill("SIGKILL");
        }
      } catch {
        // already dead
      }
    }, 1_500);
    forceKillTimer.unref?.();
  };

  const promise = new Promise<{ readonly exitCode: number; readonly signal: NodeJS.Signals | null }>(
    (resolve, reject) => {
      child.on("error", (error) => {
        if (forceKillTimer) clearTimeout(forceKillTimer);
        reject(error);
      });
      child.on("close", (code, signal) => {
        if (forceKillTimer) clearTimeout(forceKillTimer);
        resolve({ exitCode: code ?? (signal ? 1 : 0), signal });
      });
    },
  );

  return { promise, cancel };
};

function receiptsFilePath(baseDir: string): string {
  return NodePath.join(baseDir, "tools", "provisioner-receipts.json");
}

function readReceipts(baseDir: string): Array<ProvisionerReceipt> {
  const file = receiptsFilePath(baseDir);
  if (!NodeFs.existsSync(file)) return [];
  try {
    const parsed = JSON.parse(NodeFs.readFileSync(file, "utf8")) as Partial<PersistedReceiptsFile>;
    if (!parsed || !Array.isArray(parsed.receipts)) return [];
    return parsed.receipts.filter(
      (item): item is ProvisionerReceipt =>
        item !== null &&
        typeof item === "object" &&
        typeof item.instanceId === "string" &&
        typeof item.installDir === "string",
    );
  } catch {
    return [];
  }
}

function writeReceipts(baseDir: string, receipts: ReadonlyArray<ProvisionerReceipt>): void {
  const file = receiptsFilePath(baseDir);
  NodeFs.mkdirSync(NodePath.dirname(file), { recursive: true, mode: 0o700 });
  const tmp = `${file}.${process.pid}.${Date.now()}.tmp`;
  const payload: PersistedReceiptsFile = { version: 1, receipts };
  NodeFs.writeFileSync(tmp, `${JSON.stringify(payload, null, 2)}\n`, { mode: 0o600 });
  try {
    NodeFs.chmodSync(tmp, 0o600);
  } catch {
    // best-effort
  }
  NodeFs.renameSync(tmp, file);
}

function upsertReceipt(baseDir: string, receipt: ProvisionerReceipt): void {
  const current = readReceipts(baseDir).filter((item) => item.instanceId !== receipt.instanceId);
  current.push(receipt);
  writeReceipts(baseDir, current);
}

function removeReceipt(baseDir: string, instanceId: string): ProvisionerReceipt | undefined {
  const current = readReceipts(baseDir);
  const existing = current.find((item) => item.instanceId === instanceId);
  if (existing !== undefined) {
    writeReceipts(
      baseDir,
      current.filter((item) => item.instanceId !== instanceId),
    );
  }
  return existing;
}

function readInstalledNpmPackageVersion(installDir: string, packageName: string): string | null {
  try {
    const manifestPath = NodePath.join(
      installDir,
      "node_modules",
      ...packageName.split("/"),
      "package.json",
    );
    const parsed = JSON.parse(NodeFs.readFileSync(manifestPath, "utf8")) as { version?: unknown };
    return typeof parsed.version === "string" ? parsed.version : null;
  } catch {
    return null;
  }
}

function isObjectRecord(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}

function configString(config: unknown, key: string): string {
  if (!isObjectRecord(config)) return "";
  const value = config[key];
  return typeof value === "string" ? value.trim() : "";
}

export function resolveProvisionAgentKind(
  instanceId: string,
  instance: ProviderInstanceConfig | undefined,
): ProvisionAgentKind | null {
  if (instanceId === "codex" || instance?.driver === ProviderDriverKind.make("codex")) {
    return "codex";
  }
  if (instanceId === "claudeAgent" || instance?.driver === ProviderDriverKind.make("claudeAgent")) {
    return "claude";
  }
  if (instanceId === KIMI_CODE_INSTANCE_ID) return "kimi-code";
  if (instanceId === QODER_INSTANCE_ID) return "qoder";
  if (instanceId === CODEBUDDY_CODE_INSTANCE_ID) return "codebuddy-code";
  if (instanceId === DEEPSEEK_HARNESS_INSTANCE_ID) return "deepseek-harness";
  if (instance?.driver === ProviderDriverKind.make("acpRegistry")) {
    const source = configString(instance.config, "source");
    const agentId = configString(instance.config, "agentId");
    if (source !== "local") {
      if (agentId === "kimi-code") return "kimi-code";
      if (agentId === "qoder") return "qoder";
      if (agentId === "codebuddy-code") return "codebuddy-code";
    } else {
      const cmd = NodePath.basename(configString(instance.config, "commandPath"));
      if (cmd === "dsh" || cmd === "dsh.exe" || cmd === "dsh.cmd") {
        return "deepseek-harness";
      }
    }
  }
  return null;
}

const ACP_REGISTRY_AGENT_META: Readonly<
  Record<
    "kimi-code" | "qoder" | "codebuddy-code",
    {
      readonly displayName: string;
      readonly cliBinary: string;
      readonly officialScriptCommand: string;
      readonly officialScriptUrl: string;
      readonly vendorUninstallGuidance: string;
      readonly vendorUninstallGuidanceZh: string;
    }
  >
> = {
  "kimi-code": {
    displayName: "Kimi Code",
    cliBinary: "kimi",
    officialScriptCommand: "curl -L code.kimi.com/install.sh | bash",
    officialScriptUrl: "https://code.kimi.com/install.sh",
    vendorUninstallGuidance:
      "Installed via Kimi Code's official script into user global paths. Uninstall using Kimi Code's official instructions or remove the binary from your PATH.",
    vendorUninstallGuidanceZh:
      "通过 Kimi Code 官方脚本安装到用户全局目录，小瞳 Work 不提供应用内自动回滚或卸载；如需卸载请按 Kimi Code 官方说明清理。",
  },
  qoder: {
    displayName: "Qoder",
    cliBinary: "qoder",
    officialScriptCommand: "curl -fsSL https://qoder.com/install | bash",
    officialScriptUrl: "https://qoder.com/install",
    vendorUninstallGuidance:
      "Installed via Qoder's official script into user global paths. Uninstall using Qoder's official instructions.",
    vendorUninstallGuidanceZh:
      "通过 Qoder 官方脚本安装到用户全局目录，小瞳 Work 不提供应用内自动回滚或卸载；如需卸载请按 Qoder 官方说明清理。",
  },
  "codebuddy-code": {
    displayName: "Codebuddy Code",
    cliBinary: "codebuddy",
    officialScriptCommand: "npm install -g @tencent-ai/codebuddy-code",
    officialScriptUrl: "https://www.npmjs.com/package/@tencent-ai/codebuddy-code",
    vendorUninstallGuidance:
      "Installed globally via npm. Run `npm uninstall -g @tencent-ai/codebuddy-code` in your terminal to remove it.",
    vendorUninstallGuidanceZh:
      "通过全局 npm 安装；小瞳 Work 不会擅自修改系统全局包，如需卸载请在终端运行 `npm uninstall -g @tencent-ai/codebuddy-code`。",
  },
};

export interface ProviderProvisionerDeps {
  readonly baseDir: string;
  readonly cacheDir: string;
  readonly platform: NodeJS.Platform;
  readonly getHostEnvironment: () => NodeJS.ProcessEnv;
  readonly consent: XtworkInstallConsentService;
  readonly acpCatalog: AcpRegistrySupport.AcpRegistryCatalog["Service"];
  readonly codexInstallation: CodexInstallation.CodexInstallation["Service"];
  readonly providerInstallation: ProviderInstallation.ProviderInstallation["Service"];
  readonly getSettings: () => Effect.Effect<ServerSettings, unknown>;
  readonly updateProviderInstance: (input: {
    readonly operation: "upsert";
    readonly instanceId: ProviderInstanceId;
    readonly instance: ProviderInstanceConfig;
  }) => Effect.Effect<unknown, unknown>;
  readonly refreshProviderInstance: (instanceId: ProviderInstanceId) => Effect.Effect<unknown, unknown>;
  readonly refreshLoginPath?: (() => Effect.Effect<void, unknown>) | undefined;
  readonly runCommand?: ProvisionCommandRunner | undefined;
  readonly probeVersion?: ProvisionVersionProber | undefined;
}

export class ProvisionerError extends Error {
  readonly statusCode: number;
  readonly code: string;

  constructor(code: string, message: string, statusCode = 400) {
    super(message);
    this.name = "ProvisionerError";
    this.code = code;
    this.statusCode = statusCode;
  }
}

export interface XtworkProviderProvisionerService {
  readonly getPlan: (
    instanceId: string,
    mode?: ProvisionInstallMode,
  ) => Effect.Effect<ProviderInstallPlan, ProvisionerError>;
  readonly getStatus: (instanceId: string) => Effect.Effect<ProviderProvisionState>;
  readonly listStatuses: () => Effect.Effect<Readonly<Record<string, ProviderProvisionState>>>;
  readonly startInstall: (
    request: ProvisionInstallRequest,
  ) => Effect.Effect<ProviderProvisionState, ProvisionerError>;
  readonly cancelInstall: (
    instanceId: string,
    operationId?: string,
  ) => Effect.Effect<ProviderProvisionState, ProvisionerError>;
  readonly uninstall: (
    instanceId: string,
  ) => Effect.Effect<ProviderProvisionState, ProvisionerError>;
}

export class XtworkProviderProvisioner extends Context.Service<
  XtworkProviderProvisioner,
  XtworkProviderProvisionerService
>()("t3/xtwork/providerProvisioner/XtworkProviderProvisioner") {}

function idleState(instanceId: string): ProviderProvisionState {
  return {
    instanceId,
    phase: "idle",
    operationId: null,
    mode: null,
    message: null,
    error: null,
    logs: [],
    installedVersion: null,
    executablePath: null,
    startedAt: null,
    finishedAt: null,
  };
}

interface ActiveOperation {
  readonly operationId: string;
  readonly mode: ProvisionInstallMode;
  cancel: () => void;
  cancelled: boolean;
}

export function makeProviderProvisioner(
  deps: ProviderProvisionerDeps,
): XtworkProviderProvisionerService {
  const runCommand = deps.runCommand ?? defaultCommandRunner;
  const probeVersion = deps.probeVersion ?? defaultVersionProber;
  const toolsDir = NodePath.join(deps.baseDir, "tools");
  const states = new Map<string, ProviderProvisionState>();
  const activeOps = new Map<string, ActiveOperation>();

  const getOrInitState = (instanceId: string): ProviderProvisionState =>
    states.get(instanceId) ?? idleState(instanceId);

  const setState = (
    instanceId: string,
    updater: (prev: ProviderProvisionState) => ProviderProvisionState,
  ): ProviderProvisionState => {
    const next = updater(getOrInitState(instanceId));
    states.set(instanceId, next);
    return next;
  };

  const appendLog = (instanceId: string, rawChunk: string): void => {
    const lines = rawChunk
      .split(/\n/u)
      .map(sanitizeProvisionLogLine)
      .filter((line) => line.length > 0);
    if (lines.length === 0) return;
    setState(instanceId, (prev) => ({
      ...prev,
      logs: [...prev.logs, ...lines].slice(-MAX_LOG_LINES),
    }));
  };

  const getInstanceConfig = (
    instanceId: string,
  ): Effect.Effect<ProviderInstanceConfig | undefined> =>
    deps.getSettings().pipe(
      Effect.map((settings) => settings.providerInstances[instanceId as ProviderInstanceId]),
      Effect.orElseSucceed(() => undefined),
    );

  const buildPlan = (
    instanceId: string,
    requestedMode?: ProvisionInstallMode,
  ): Effect.Effect<ProviderInstallPlan, ProvisionerError> =>
    Effect.gen(function* () {
      const instance = yield* getInstanceConfig(instanceId);
      const agentKind = resolveProvisionAgentKind(instanceId, instance);
      if (agentKind === null) {
        return yield* Effect.fail(
          new ProvisionerError(
            "unsupported_provider",
            `One-click provisioning is not available for provider instance '${instanceId}'.`,
            404,
          ),
        );
      }

      const env = deps.getHostEnvironment();
      const platform = deps.platform;
      const receipt = readReceipts(deps.baseDir).find((entry) => entry.instanceId === instanceId);
      const currentState = getOrInitState(instanceId);

      // ---- 1. CODEX (App-Managed via T3 CodexInstallation) ----
      if (agentKind === "codex") {
        const codexState = yield* deps.codexInstallation.state;
        const userCodexPath = findExecutableInPath("codex", env, platform, [toolsDir]);
        const userCodexVersion = userCodexPath
          ? yield* Effect.promise(() => probeVersion(userCodexPath, env))
          : null;
        const managedInstallDir = deps.codexInstallation.managedDirectory;
        const managedInstalled =
          codexState.source === "managed" && codexState.installedVersion !== null;
        const targetVersion = codexState.version ?? codexState.installedVersion ?? "latest";
        const consentKey = normalizeInstallConsentKey({
          instanceId,
          source: "codex-managed",
          version: targetVersion,
          distribution: "codex-release",
          installDir: managedInstallDir,
        });
        const option: ProvisionPlanOption = {
          mode: "app-managed",
          label: "App-Managed Isolated Install",
          labelZh: "受管隔离安装（推荐）",
          summary: "Downloads OpenAI's official Codex release into Xiaotong Work's private tools directory with SHA-256 verification.",
          summaryZh: "从官方发布源下载并经 SHA-256 校验安装到应用独立目录，支持取消与一键卸载，不修改系统全局环境。",
          commandPreview: `Download official Codex ${targetVersion} release -> ${managedInstallDir}`,
          officialSource: "https://github.com/openai/codex/releases",
          targetInstallDir: managedInstallDir,
          uninstallSemantics: "app-managed",
          uninstallGuidance: `Removes the managed Codex directory (${managedInstallDir}) without affecting system-installed Codex or sign-in history.`,
          uninstallGuidanceZh: `可直接在应用内移除受管目录（${managedInstallDir}），不影响您本机全局安装的 Codex。`,
          consentKey,
          availableVersion: codexState.version,
          distribution: "codex-release",
        };
        const existingDetection: ExistingInstallDetection = userCodexPath
          ? {
              detected: true,
              source: "user-path",
              executablePath: userCodexPath,
              version: userCodexVersion,
            }
          : managedInstalled
            ? {
                detected: true,
                source: "app-managed",
                executablePath: codexState.executablePath ?? null,
                version: codexState.installedVersion,
              }
            : { detected: false, source: "none", executablePath: null, version: null };
        const installedVersion = managedInstalled
          ? codexState.installedVersion
          : userCodexVersion;
        const updateAvailable =
          managedInstalled &&
          codexState.version !== null &&
          codexState.version !== codexState.installedVersion;
        const hasConsent = yield* deps.consent.hasConsent(consentKey);
        const consentReason =
          updateAvailable && !hasConsent
            ? "update_required"
            : !managedInstalled && !userCodexPath && !hasConsent
              ? "install_required"
              : null;

        return {
          instanceId,
          agentKind,
          displayName: instance?.displayName?.trim() || "Codex",
          defaultMode: "app-managed",
          selectedMode: "app-managed",
          selectedOption: option,
          availableModes: [option],
          existingDetection,
          installedVersion,
          availableVersion: codexState.version,
          updateAvailable,
          consentRequired: consentReason !== null,
          consentReason,
          canUninstall: Boolean(codexState.canRemove || managedInstalled),
          uninstallSemantics: "app-managed",
          uninstallGuidance: option.uninstallGuidance,
          uninstallGuidanceZh: option.uninstallGuidanceZh,
          state: currentState,
        };
      }

      // ---- 2. CLAUDE CODE (Default: Vendor Script; Optional: App-Managed npm) ----
      if (agentKind === "claude") {
        const managedDir = NodePath.join(toolsDir, "claude-code");
        const managedBin = NodePath.join(
          managedDir,
          "node_modules",
          ".bin",
          platform === "win32" ? "claude.cmd" : "claude",
        );
        const managedExists = isExecutableFile(managedBin);
        const managedVersion = managedExists
          ? (readInstalledNpmPackageVersion(managedDir, "@anthropic-ai/claude-code") ??
            (yield* Effect.promise(() => probeVersion(managedBin, env))))
          : null;
        const userClaudePath = findExecutableInPath("claude", env, platform, [toolsDir]);
        const userClaudeVersion = userClaudePath
          ? yield* Effect.promise(() => probeVersion(userClaudePath, env))
          : null;
        const npmPath = resolveBundledNpm(env, platform) ?? "npm";
        const vendorScriptCmd =
          platform === "win32"
            ? "irm https://claude.ai/install.ps1 | iex"
            : "curl -fsSL https://claude.ai/install.sh | bash";

        const vendorOption: ProvisionPlanOption = {
          mode: "vendor-script",
          label: "Official Install Script (Recommended)",
          labelZh: "官方脚本安装（默认）",
          summary: "Runs Anthropic's official installer script into your user directory (~/.local/bin/claude).",
          summaryZh: "执行 Anthropic 官方安装脚本安装到本机用户目录（~/.local/bin/claude），安装后自动探测并刷新状态。",
          commandPreview: vendorScriptCmd,
          officialSource:
            platform === "win32" ? "https://claude.ai/install.ps1" : "https://claude.ai/install.sh",
          targetInstallDir: VENDOR_GLOBAL_INSTALL_DIR,
          uninstallSemantics: "vendor-managed",
          uninstallGuidance:
            "Installed by Anthropic's official script into user global paths. Xiaotong Work cannot atomically roll back or uninstall it; remove ~/.local/bin/claude or follow Anthropic's uninstall docs.",
          uninstallGuidanceZh:
            "由官方脚本写入本机用户目录，小瞳 Work 不承诺原子回滚或应用内卸载；如需卸载请手动删除 ~/.local/bin/claude 或参考 Anthropic 官方文档。",
          consentKey: normalizeInstallConsentKey({
            instanceId,
            source: "vendor-script",
            version: "latest",
            distribution: "vendor-script",
            installDir: VENDOR_GLOBAL_INSTALL_DIR,
          }),
          availableVersion: "latest",
          distribution: "vendor-script",
        };
        const managedOption: ProvisionPlanOption = {
          mode: "app-managed",
          label: "App-Managed Isolated npm",
          labelZh: "受管隔离安装（随包 npm）",
          summary: "Installs @anthropic-ai/claude-code into Xiaotong Work's isolated tools directory using bundled npm.",
          summaryZh: "使用随包 npm 安装 @anthropic-ai/claude-code 至应用独立目录，支持取消清理与一键卸载，不污染系统全局。",
          commandPreview: `${npmPath} install --prefix ${managedDir} @anthropic-ai/claude-code`,
          officialSource: "https://www.npmjs.com/package/@anthropic-ai/claude-code",
          targetInstallDir: managedDir,
          uninstallSemantics: "app-managed",
          uninstallGuidance: `Removes ${managedDir} and clears any auto-wired managed binary path without touching global installations.`,
          uninstallGuidanceZh: `应用内一键移除受管目录（${managedDir}）并清理自动绑定路径，不影响系统全局工具。`,
          consentKey: normalizeInstallConsentKey({
            instanceId,
            source: "npm-managed",
            version: "latest",
            distribution: "npm",
            installDir: managedDir,
          }),
          availableVersion: "latest",
          distribution: "npm",
        };

        const availableModes: ReadonlyArray<ProvisionPlanOption> = [vendorOption, managedOption];
        const selectedMode: ProvisionInstallMode =
          requestedMode ?? (managedExists && !userClaudePath ? "app-managed" : "vendor-script");
        const selectedOption =
          availableModes.find((opt) => opt.mode === selectedMode) ?? vendorOption;

        const existingDetection: ExistingInstallDetection = userClaudePath
          ? {
              detected: true,
              source: "user-path",
              executablePath: userClaudePath,
              version: userClaudeVersion,
            }
          : managedExists
            ? {
                detected: true,
                source: "app-managed",
                executablePath: managedBin,
                version: managedVersion,
              }
            : { detected: false, source: "none", executablePath: null, version: null };

        const hasConsent = yield* deps.consent.hasConsent(selectedOption.consentKey);
        const installed = existingDetection.detected;
        const consentReason = !installed && !hasConsent ? "install_required" : null;

        return {
          instanceId,
          agentKind,
          displayName: instance?.displayName?.trim() || "Claude Code",
          defaultMode: "vendor-script",
          selectedMode: selectedOption.mode,
          selectedOption,
          availableModes,
          existingDetection,
          installedVersion: existingDetection.version,
          availableVersion: selectedOption.availableVersion,
          updateAvailable: false,
          consentRequired: consentReason !== null,
          consentReason,
          canUninstall: managedExists,
          uninstallSemantics: managedExists ? "app-managed" : selectedOption.uninstallSemantics,
          uninstallGuidance: managedExists
            ? managedOption.uninstallGuidance
            : selectedOption.uninstallGuidance,
          uninstallGuidanceZh: managedExists
            ? managedOption.uninstallGuidanceZh
            : selectedOption.uninstallGuidanceZh,
          state: currentState,
        };
      }

      // ---- 3. DEEPSEEK HARNESS (App-Managed Isolated npm) ----
      if (agentKind === "deepseek-harness") {
        const managedDir = NodePath.join(toolsDir, "deepseek-harness");
        const managedBin = NodePath.join(
          managedDir,
          "node_modules",
          ".bin",
          platform === "win32" ? "dsh.cmd" : "dsh",
        );
        const managedExists = isExecutableFile(managedBin);
        const managedVersion = managedExists
          ? (readInstalledNpmPackageVersion(managedDir, "@deepseek-ai/dsh") ??
            (yield* Effect.promise(() => probeVersion(managedBin, env))))
          : null;
        const userDshPath = findExecutableInPath("dsh", env, platform, [toolsDir]);
        const userDshVersion = userDshPath
          ? yield* Effect.promise(() => probeVersion(userDshPath, env))
          : null;
        const npmPath = resolveBundledNpm(env, platform) ?? "npm";

        const option: ProvisionPlanOption = {
          mode: "app-managed",
          label: "App-Managed Isolated npm",
          labelZh: "受管隔离安装（随包 npm）",
          summary: "Installs @deepseek-ai/dsh into Xiaotong Work's isolated tools directory using bundled Node & npm.",
          summaryZh: "使用随包 Node 与 npm 将 @deepseek-ai/dsh 安装至应用独立目录，支持取消清理与一键卸载，不覆盖您已安装的 dsh。",
          commandPreview: `${npmPath} install --prefix ${managedDir} @deepseek-ai/dsh`,
          officialSource: "https://www.npmjs.com/package/@deepseek-ai/dsh",
          targetInstallDir: managedDir,
          uninstallSemantics: "app-managed",
          uninstallGuidance: `Removes ${managedDir} and restores default command 'dsh' if no custom path was configured.`,
          uninstallGuidanceZh: `应用内一键移除受管目录（${managedDir}），并在未配置自定义路径时恢复默认命令 dsh。`,
          consentKey: normalizeInstallConsentKey({
            instanceId,
            source: "npm-managed",
            version: "latest",
            distribution: "npm",
            installDir: managedDir,
          }),
          availableVersion: "latest",
          distribution: "npm",
        };

        const existingDetection: ExistingInstallDetection = userDshPath
          ? {
              detected: true,
              source: "user-path",
              executablePath: userDshPath,
              version: userDshVersion,
            }
          : managedExists
            ? {
                detected: true,
                source: "app-managed",
                executablePath: managedBin,
                version: managedVersion,
              }
            : { detected: false, source: "none", executablePath: null, version: null };

        const hasConsent = yield* deps.consent.hasConsent(option.consentKey);
        const consentReason = !existingDetection.detected && !hasConsent ? "install_required" : null;

        return {
          instanceId,
          agentKind,
          displayName: instance?.displayName?.trim() || "DeepSeek Harness",
          defaultMode: "app-managed",
          selectedMode: "app-managed",
          selectedOption: option,
          availableModes: [option],
          existingDetection,
          installedVersion: existingDetection.version,
          availableVersion: "latest",
          updateAvailable: false,
          consentRequired: consentReason !== null,
          consentReason,
          canUninstall: managedExists,
          uninstallSemantics: "app-managed",
          uninstallGuidance: option.uninstallGuidance,
          uninstallGuidanceZh: option.uninstallGuidanceZh,
          state: currentState,
        };
      }

      // ---- 4. ACP REGISTRY AGENTS: Kimi Code / Qoder / Codebuddy Code ----
      const meta = ACP_REGISTRY_AGENT_META[agentKind];
      const acpAgentId = agentKind;
      const described = deps.acpCatalog.describeAgent
        ? yield* deps.acpCatalog.describeAgent(acpAgentId, "auto").pipe(Effect.option)
        : Option.none();
      const describedValue = Option.getOrUndefined(described);

      const userCliPath = findExecutableInPath(meta.cliBinary, env, platform, [toolsDir]);
      const userCliVersion = userCliPath
        ? yield* Effect.promise(() => probeVersion(userCliPath, env))
        : null;

      const resolvedVersion = describedValue?.version ?? receipt?.version ?? "latest";
      const resolvedDistribution = describedValue?.distribution ?? receipt?.distribution ?? "npx";
      const resolvedInstallDir =
        describedValue?.installDir ??
        receipt?.installDir ??
        NodePath.join(toolsDir, acpAgentId, encodeURIComponent(resolvedVersion), "npm");
      const npmPath = resolveBundledNpm(env, platform) ?? "npm";
      const managedCommandPreview = describedValue
        ? describedValue.distribution === "binary"
          ? `Download verified ACP Registry binary ${acpAgentId}@${describedValue.version} (${describedValue.archiveUrl ?? "official ACP Registry"}) -> ${describedValue.installDir}`
          : describedValue.distribution === "npx"
            ? `${npmPath} install --global ${describedValue.packageName ?? acpAgentId} (npm_config_prefix=${describedValue.installDir})`
            : `uv tool install --force ${describedValue.packageName ?? acpAgentId} (UV_TOOL_DIR=${describedValue.installDir})`
        : `Prepare official ACP Registry agent '${acpAgentId}' -> ${resolvedInstallDir}`;

      const appManagedOption: ProvisionPlanOption = {
        mode: "app-managed",
        label: "App-Managed ACP Install (Recommended)",
        labelZh: "受管隔离安装（ACP Registry，推荐）",
        summary: `Installs ${meta.displayName} from the official ACP Registry into Xiaotong Work's isolated tools cache using bundled Node & npm.`,
        summaryZh: `通过官方 ACP Registry 与随包 Node/npm 将 ${meta.displayName} 安装到应用独立目录，支持取消清理与一键卸载。`,
        commandPreview: managedCommandPreview,
        officialSource:
          describedValue?.archiveUrl ??
          (describedValue?.packageName
            ? `ACP Registry (${describedValue.packageName})`
            : "https://cdn.agentclientprotocol.com/registry/v1/latest/registry.json"),
        targetInstallDir: resolvedInstallDir,
        uninstallSemantics: "app-managed",
        uninstallGuidance: `Removes Xiaotong Work's managed cache under ${NodePath.join(toolsDir, acpAgentId)} and revokes its install consent.`,
        uninstallGuidanceZh: `应用内一键删除受管缓存目录（${NodePath.join(toolsDir, acpAgentId)}）并撤销安装授权，不影响系统全局工具。`,
        consentKey: normalizeInstallConsentKey({
          instanceId,
          source: "acp-registry",
          version: resolvedVersion,
          distribution: resolvedDistribution,
          installDir: resolvedInstallDir,
        }),
        availableVersion: describedValue?.version ?? null,
        distribution: resolvedDistribution,
      };

      const vendorScriptOption: ProvisionPlanOption = {
        mode: "vendor-script",
        label: "Official Native Global Install",
        labelZh: "官方脚本全局安装（可选）",
        summary: `Runs ${meta.displayName}'s official global installer command into your system/user PATH.`,
        summaryZh: `执行 ${meta.displayName} 官方全局安装命令到本机用户目录；安装后自动探测并刷新，不承诺应用内卸载。`,
        commandPreview: meta.officialScriptCommand,
        officialSource: meta.officialScriptUrl,
        targetInstallDir: VENDOR_GLOBAL_INSTALL_DIR,
        uninstallSemantics: "vendor-managed",
        uninstallGuidance: meta.vendorUninstallGuidance,
        uninstallGuidanceZh: meta.vendorUninstallGuidanceZh,
        consentKey: normalizeInstallConsentKey({
          instanceId,
          source: "vendor-script",
          version: "latest",
          distribution: "vendor-script",
          installDir: VENDOR_GLOBAL_INSTALL_DIR,
        }),
        availableVersion: "latest",
        distribution: "vendor-script",
      };

      const availableModes: ReadonlyArray<ProvisionPlanOption> = [
        appManagedOption,
        vendorScriptOption,
      ];
      const selectedMode: ProvisionInstallMode = requestedMode ?? "app-managed";
      const selectedOption =
        availableModes.find((opt) => opt.mode === selectedMode) ?? appManagedOption;

      const managedAgentRoot = NodePath.join(toolsDir, acpAgentId);
      const managedInstalled = Boolean(
        describedValue?.installed ||
          describedValue?.hasOtherInstalledVersion ||
          (receipt !== undefined && NodeFs.existsSync(managedAgentRoot)),
      );
      const updateAvailable = Boolean(
        describedValue && !describedValue.installed && describedValue.hasOtherInstalledVersion,
      );
      const existingDetection: ExistingInstallDetection =
        managedInstalled
          ? {
              detected: true,
              source: "app-managed",
              executablePath: receipt?.executablePath ?? resolvedInstallDir,
              version: describedValue?.installed ? describedValue.version : (receipt?.version ?? null),
            }
          : userCliPath
            ? {
                detected: true,
                source: "user-path",
                executablePath: userCliPath,
                version: userCliVersion,
              }
            : { detected: false, source: "none", executablePath: null, version: null };

      const hasConsent = yield* deps.consent.hasConsent(selectedOption.consentKey);
      const consentReason =
        selectedOption.mode === "app-managed"
          ? updateAvailable && !hasConsent
            ? "update_required"
            : !describedValue?.installed && !hasConsent
              ? "install_required"
              : null
          : !userCliPath && !hasConsent
            ? "install_required"
            : null;

      return {
        instanceId,
        agentKind,
        displayName: instance?.displayName?.trim() || meta.displayName,
        defaultMode: "app-managed",
        selectedMode: selectedOption.mode,
        selectedOption,
        availableModes,
        existingDetection,
        installedVersion: existingDetection.version,
        availableVersion: selectedOption.availableVersion,
        updateAvailable,
        consentRequired: consentReason !== null,
        consentReason,
        canUninstall: managedInstalled,
        uninstallSemantics: managedInstalled ? "app-managed" : selectedOption.uninstallSemantics,
        uninstallGuidance: managedInstalled
          ? appManagedOption.uninstallGuidance
          : selectedOption.uninstallGuidance,
        uninstallGuidanceZh: managedInstalled
          ? appManagedOption.uninstallGuidanceZh
          : selectedOption.uninstallGuidanceZh,
        state: currentState,
      };
    });

  const validateConsentMatches = (
    plan: ProviderInstallPlan,
    consent: ProvisionInstallConsentPayload,
  ): Effect.Effect<InstallConsentKey, ProvisionerError> => {
    if (!consent || consent.confirmed !== true) {
      return Effect.fail(
        new ProvisionerError(
          "consent_required",
          "Explicit user confirmation is required before downloading or installing a coding agent.",
          400,
        ),
      );
    }
    let submitted: InstallConsentKey;
    try {
      submitted = normalizeInstallConsentKey({
        instanceId: plan.instanceId,
        source: consent.source,
        version: consent.version,
        distribution: consent.distribution,
        installDir: consent.installDir,
      });
    } catch (error) {
      return Effect.fail(
        new ProvisionerError(
          "invalid_consent",
          error instanceof Error ? error.message : "Invalid install consent payload.",
          400,
        ),
      );
    }
    if (!installConsentKeysEqual(submitted, plan.selectedOption.consentKey)) {
      return Effect.fail(
        new ProvisionerError(
          "consent_mismatch",
          "The install plan changed since preview. Please review and confirm the latest install command.",
          409,
        ),
      );
    }
    return Effect.succeed(submitted);
  };

  const runManagedNpmInstall = (input: {
    readonly instanceId: string;
    readonly operationId: string;
    readonly agentKind: "deepseek-harness" | "claude";
    readonly packageName: string;
    readonly binaryName: string;
    readonly installDir: string;
    readonly option: ProvisionPlanOption;
    readonly wireInstance: (managedBinaryPath: string) => Effect.Effect<void, unknown>;
  }): Effect.Effect<void> =>
    Effect.gen(function* () {
      const env = deps.getHostEnvironment();
      const npmPath = resolveBundledNpm(env, deps.platform);
      if (npmPath === null) {
        setState(input.instanceId, (prev) => ({
          ...prev,
          phase: "failed",
          error: "Bundled npm executable is unavailable in this environment.",
          message: "Installation failed: npm not found.",
          finishedAt: new Date().toISOString(),
        }));
        return;
      }

      const existedBefore = NodeFs.existsSync(input.installDir);
      NodeFs.mkdirSync(input.installDir, { recursive: true, mode: 0o700 });
      const args = [
        "install",
        "--prefix",
        input.installDir,
        "--no-audit",
        "--no-fund",
        input.packageName,
      ];
      appendLog(input.instanceId, `$ ${npmPath} ${args.join(" ")}`);

      const handle = runCommand({
        command: npmPath,
        args,
        env,
        onOutput: (chunk) => appendLog(input.instanceId, chunk),
      });
      const op = activeOps.get(input.instanceId);
      if (op && op.operationId === input.operationId) {
        op.cancel = () => handle.cancel();
        if (op.cancelled) handle.cancel();
      }

      const result = yield* Effect.tryPromise(() => handle.promise).pipe(
        Effect.match({
          onSuccess: (value) => ({ ok: true as const, value }),
          onFailure: (error) => ({ ok: false as const, error }),
        }),
      );

      const currentOp = activeOps.get(input.instanceId);
      if (currentOp?.operationId === input.operationId && currentOp.cancelled) {
        if (!existedBefore) {
          NodeFs.rmSync(input.installDir, { recursive: true, force: true });
        }
        setState(input.instanceId, (prev) => ({
          ...prev,
          phase: "cancelled",
          message: "Installation cancelled.",
          finishedAt: new Date().toISOString(),
        }));
        return;
      }

      if (!result.ok || result.value.exitCode !== 0) {
        if (!existedBefore) {
          NodeFs.rmSync(input.installDir, { recursive: true, force: true });
        }
        const detail = !result.ok
          ? result.error instanceof Error
            ? result.error.message
            : "Failed to run npm install."
          : `npm install exited with code ${result.value.exitCode}.`;
        setState(input.instanceId, (prev) => ({
          ...prev,
          phase: "failed",
          error: detail,
          message: detail,
          finishedAt: new Date().toISOString(),
        }));
        return;
      }

      setState(input.instanceId, (prev) => ({
        ...prev,
        phase: "verifying",
        message: `Verifying ${input.binaryName} executable…`,
      }));

      const binName =
        deps.platform === "win32" ? `${input.binaryName}.cmd` : input.binaryName;
      const managedBin = NodePath.join(input.installDir, "node_modules", ".bin", binName);
      if (!isExecutableFile(managedBin)) {
        setState(input.instanceId, (prev) => ({
          ...prev,
          phase: "failed",
          error: `Installed ${input.packageName}, but '${binName}' was not found at ${managedBin}.`,
          message: "Verification failed.",
          finishedAt: new Date().toISOString(),
        }));
        return;
      }

      const probedVersion = yield* Effect.promise(() => probeVersion(managedBin, env));
      const installedVersion =
        probedVersion ?? readInstalledNpmPackageVersion(input.installDir, input.packageName);
      if (probedVersion === null && installedVersion === null) {
        setState(input.instanceId, (prev) => ({
          ...prev,
          phase: "failed",
          error: `${input.binaryName} --version did not succeed after installation.`,
          message: "Verification failed.",
          finishedAt: new Date().toISOString(),
        }));
        return;
      }

      upsertReceipt(deps.baseDir, {
        instanceId: input.instanceId,
        agentKind: input.agentKind,
        mode: "app-managed",
        source: input.option.consentKey.source,
        version: installedVersion ?? "installed",
        distribution: input.option.consentKey.distribution,
        installDir: input.installDir,
        executablePath: managedBin,
        installedAt: new Date().toISOString(),
      });

      yield* input.wireInstance(managedBin).pipe(Effect.ignore);
      yield* deps
        .refreshProviderInstance(ProviderInstanceId.make(input.instanceId))
        .pipe(Effect.ignore);

      appendLog(
        input.instanceId,
        `Verified ${input.binaryName}${installedVersion ? ` v${installedVersion}` : ""} at ${managedBin}`,
      );
      setState(input.instanceId, (prev) => ({
        ...prev,
        phase: "succeeded",
        installedVersion,
        executablePath: managedBin,
        error: null,
        message: `Installed ${input.binaryName}${installedVersion ? ` v${installedVersion}` : ""}.`,
        finishedAt: new Date().toISOString(),
      }));
    });

  const runVendorScriptInstall = (input: {
    readonly instanceId: string;
    readonly operationId: string;
    readonly commandPreview: string;
    readonly binaryName: string;
  }): Effect.Effect<void> =>
    Effect.gen(function* () {
      const env = deps.getHostEnvironment();
      appendLog(input.instanceId, `$ ${input.commandPreview}`);
      const shellCmd =
        deps.platform === "win32"
          ? { command: "powershell.exe", args: ["-NoProfile", "-Command", input.commandPreview] }
          : { command: "/bin/bash", args: ["-lc", input.commandPreview] };

      const handle = runCommand({
        command: shellCmd.command,
        args: shellCmd.args,
        env,
        onOutput: (chunk) => appendLog(input.instanceId, chunk),
      });
      const op = activeOps.get(input.instanceId);
      if (op && op.operationId === input.operationId) {
        op.cancel = () => handle.cancel();
        if (op.cancelled) handle.cancel();
      }

      const result = yield* Effect.tryPromise(() => handle.promise).pipe(
        Effect.match({
          onSuccess: (value) => ({ ok: true as const, value }),
          onFailure: (error) => ({ ok: false as const, error }),
        }),
      );

      const currentOp = activeOps.get(input.instanceId);
      if (currentOp?.operationId === input.operationId && currentOp.cancelled) {
        setState(input.instanceId, (prev) => ({
          ...prev,
          phase: "cancelled",
          message: "Vendor installer process interrupted.",
          finishedAt: new Date().toISOString(),
        }));
        return;
      }

      if (!result.ok || result.value.exitCode !== 0) {
        const detail = !result.ok
          ? result.error instanceof Error
            ? result.error.message
            : "Failed to run vendor installer script."
          : `Installer exited with code ${result.value.exitCode}.`;
        setState(input.instanceId, (prev) => ({
          ...prev,
          phase: "failed",
          error: detail,
          message: detail,
          finishedAt: new Date().toISOString(),
        }));
        return;
      }

      setState(input.instanceId, (prev) => ({
        ...prev,
        phase: "verifying",
        message: `Probing installed ${input.binaryName} executable…`,
      }));

      if (deps.refreshLoginPath) {
        yield* deps.refreshLoginPath().pipe(Effect.ignore);
      }

      const refreshedEnv = deps.getHostEnvironment();
      const detectedPath = findExecutableInPath(input.binaryName, refreshedEnv, deps.platform, [
        toolsDir,
      ]);
      const detectedVersion = detectedPath
        ? yield* Effect.promise(() => probeVersion(detectedPath, refreshedEnv))
        : null;

      yield* deps
        .refreshProviderInstance(ProviderInstanceId.make(input.instanceId))
        .pipe(Effect.ignore);

      if (!detectedPath) {
        setState(input.instanceId, (prev) => ({
          ...prev,
          phase: "succeeded",
          installedVersion: null,
          executablePath: null,
          error: null,
          message: `Installer finished. If '${input.binaryName}' is not detected yet, refresh providers or check your shell PATH.`,
          finishedAt: new Date().toISOString(),
        }));
        return;
      }

      appendLog(
        input.instanceId,
        `Detected ${input.binaryName}${detectedVersion ? ` v${detectedVersion}` : ""} at ${detectedPath}`,
      );
      setState(input.instanceId, (prev) => ({
        ...prev,
        phase: "succeeded",
        installedVersion: detectedVersion,
        executablePath: detectedPath,
        error: null,
        message: `Installed ${input.binaryName}${detectedVersion ? ` v${detectedVersion}` : ""}.`,
        finishedAt: new Date().toISOString(),
      }));
    });

  const runCodexManagedInstall = (input: {
    readonly instanceId: string;
    readonly operationId: string;
  }): Effect.Effect<void> =>
    Effect.gen(function* () {
      const instanceIdTyped = ProviderInstanceId.make(input.instanceId);
      const existing = yield* getInstanceConfig(input.instanceId);
      const existingConfig = isObjectRecord(existing?.config) ? existing.config : {};
      const customBinaryPath = configString(existingConfig, "binaryPath");
      if (!customBinaryPath || customBinaryPath === "codex") {
        if (existingConfig.setupMode !== "managed") {
          yield* deps
            .updateProviderInstance({
              operation: "upsert",
              instanceId: instanceIdTyped,
              instance: {
                ...(existing ?? { driver: ProviderDriverKind.make("codex") }),
                driver: ProviderDriverKind.make("codex"),
                enabled: true,
                config: {
                  ...existingConfig,
                  enabled: true,
                  setupMode: "managed",
                },
              },
            })
            .pipe(Effect.ignore);
        }
      }

      appendLog(input.instanceId, "Starting managed Codex installation…");
      const startedResult = yield* deps.providerInstallation
        .start({ instanceId: instanceIdTyped })
        .pipe(
          Effect.match({
            onSuccess: (value) => ({ ok: true as const, value }),
            onFailure: (error) => ({ ok: false as const, error }),
          }),
        );

      if (!startedResult.ok) {
        const msg = startedResult.error.message || "Could not start Codex installation.";
        setState(input.instanceId, (prev) => ({
          ...prev,
          phase: "failed",
          error: msg,
          message: msg,
          finishedAt: new Date().toISOString(),
        }));
        return;
      }

      const codexOpId = startedResult.value.operationId;
      const op = activeOps.get(input.instanceId);
      if (op && op.operationId === input.operationId && codexOpId) {
        op.cancel = () => {
          void Effect.runPromise(
            deps.providerInstallation
              .cancel({ instanceId: instanceIdTyped, operationId: codexOpId })
              .pipe(Effect.ignore),
          );
        };
      }

      const applyCodexState = (st: ProviderInstallState) => {
        if (st.phase === "downloading") {
          const mb = (st.downloadedBytes / 1_000_000).toFixed(1);
          const detail =
            st.totalBytes !== null
              ? `Downloading Codex (${mb} / ${(st.totalBytes / 1_000_000).toFixed(1)} MB)…`
              : `Downloading Codex (${mb} MB)…`;
          setState(input.instanceId, (prev) => ({ ...prev, phase: "installing", message: detail }));
        } else if (st.phase === "extracting") {
          setState(input.instanceId, (prev) => ({
            ...prev,
            phase: "installing",
            message: "Extracting Codex release…",
          }));
        } else if (st.phase === "verifying") {
          setState(input.instanceId, (prev) => ({
            ...prev,
            phase: "verifying",
            message: "Verifying Codex runtime…",
          }));
        }
      };

      applyCodexState(startedResult.value);

      const finalCodexState: ProviderInstallState =
        startedResult.value.phase === "succeeded" ||
        startedResult.value.phase === "failed" ||
        startedResult.value.phase === "cancelled"
          ? startedResult.value
          : yield* deps.codexInstallation.changes.pipe(
              Stream.tap((st) => Effect.sync(() => applyCodexState(st))),
              Stream.filter(
                (st) =>
                  st.phase === "succeeded" || st.phase === "failed" || st.phase === "cancelled",
              ),
              Stream.runHead,
              Effect.map((opt) => Option.getOrElse(opt, () => startedResult.value)),
            );

      yield* deps.refreshProviderInstance(instanceIdTyped).pipe(Effect.ignore);

      if (finalCodexState.phase === "succeeded") {
        appendLog(
          input.instanceId,
          `Codex ${finalCodexState.installedVersion ?? ""} ready at ${finalCodexState.executablePath ?? deps.codexInstallation.managedDirectory}`,
        );
        setState(input.instanceId, (prev) => ({
          ...prev,
          phase: "succeeded",
          installedVersion: finalCodexState.installedVersion,
          executablePath: finalCodexState.executablePath ?? null,
          error: null,
          message: `Installed Codex${finalCodexState.installedVersion ? ` v${finalCodexState.installedVersion}` : ""}.`,
          finishedAt: new Date().toISOString(),
        }));
      } else if (finalCodexState.phase === "cancelled") {
        setState(input.instanceId, (prev) => ({
          ...prev,
          phase: "cancelled",
          message: "Codex installation cancelled.",
          finishedAt: new Date().toISOString(),
        }));
      } else {
        const msg = finalCodexState.message ?? "Codex installation failed.";
        setState(input.instanceId, (prev) => ({
          ...prev,
          phase: "failed",
          error: msg,
          message: msg,
          finishedAt: new Date().toISOString(),
        }));
      }
    });

  const runAcpRegistryManagedInstall = (input: {
    readonly instanceId: string;
    readonly operationId: string;
    readonly agentId: "kimi-code" | "qoder" | "codebuddy-code";
    readonly option: ProvisionPlanOption;
  }): Effect.Effect<void> =>
    Effect.gen(function* () {
      const targetDir = input.option.targetInstallDir;
      const existedBefore = NodeFs.existsSync(targetDir);
      appendLog(input.instanceId, `$ ${input.option.commandPreview}`);

      const prepareEffect = deps.acpCatalog.prepare({
        agentId: input.agentId,
        instanceId: ProviderInstanceId.make(input.instanceId),
      });

      const fiber = yield* Effect.forkDetach(prepareEffect);
      const op = activeOps.get(input.instanceId);
      if (op && op.operationId === input.operationId) {
        op.cancel = () => {
          void Effect.runPromise(Fiber.interrupt(fiber));
        };
        if (op.cancelled) {
          yield* Fiber.interrupt(fiber);
        }
      }

      const exit = yield* Fiber.await(fiber);
      const currentOp = activeOps.get(input.instanceId);
      if (currentOp?.operationId === input.operationId && currentOp.cancelled) {
        if (!existedBefore) {
          NodeFs.rmSync(targetDir, { recursive: true, force: true });
        }
        setState(input.instanceId, (prev) => ({
          ...prev,
          phase: "cancelled",
          message: "Installation cancelled.",
          finishedAt: new Date().toISOString(),
        }));
        return;
      }

      if (exit._tag === "Failure") {
        if (!existedBefore) {
          NodeFs.rmSync(targetDir, { recursive: true, force: true });
        }
        const rawError = String(exit.cause);
        const detail =
          rawError.length > 0 ? sanitizeProvisionLogLine(rawError) : "ACP Registry prepare failed.";
        appendLog(input.instanceId, detail);
        setState(input.instanceId, (prev) => ({
          ...prev,
          phase: "failed",
          error: detail,
          message: detail,
          finishedAt: new Date().toISOString(),
        }));
        return;
      }

      const prepared = exit.value;
      setState(input.instanceId, (prev) => ({
        ...prev,
        phase: "verifying",
        message: `Verifying ${prepared.agentId} v${prepared.version}…`,
      }));

      upsertReceipt(deps.baseDir, {
        instanceId: input.instanceId,
        agentKind: input.agentId,
        mode: "app-managed",
        source: "acp-registry",
        version: prepared.version,
        distribution: prepared.distribution,
        installDir: targetDir,
        executablePath: targetDir,
        installedAt: new Date().toISOString(),
      });

      yield* deps
        .refreshProviderInstance(ProviderInstanceId.make(input.instanceId))
        .pipe(Effect.ignore);

      appendLog(
        input.instanceId,
        `Prepared ${prepared.agentId} v${prepared.version} (${prepared.distribution})`,
      );
      setState(input.instanceId, (prev) => ({
        ...prev,
        phase: "succeeded",
        installedVersion: prepared.version,
        executablePath: targetDir,
        error: null,
        message: `Installed ${prepared.agentId} v${prepared.version}.`,
        finishedAt: new Date().toISOString(),
      }));
    });

  const startInstall = (
    request: ProvisionInstallRequest,
  ): Effect.Effect<ProviderProvisionState, ProvisionerError> =>
    Effect.gen(function* () {
      const existingOp = activeOps.get(request.instanceId);
      if (existingOp !== undefined) {
        return yield* Effect.fail(
          new ProvisionerError(
            "already_installing",
            `An installation is already in progress for '${request.instanceId}'.`,
            409,
          ),
        );
      }

      const plan = yield* buildPlan(request.instanceId, request.mode);
      const verifiedKey = yield* validateConsentMatches(plan, request.consent);

      // Persist explicit user consent BEFORE any download or command runs.
      yield* deps.consent.grantConsent(verifiedKey, {
        commandPreview: plan.selectedOption.commandPreview,
        officialSource: plan.selectedOption.officialSource,
      });

      const operationId = NodeCrypto.randomUUID();
      const startedAt = new Date().toISOString();
      const op: ActiveOperation = {
        operationId,
        mode: plan.selectedMode,
        cancel: () => {},
        cancelled: false,
      };
      activeOps.set(request.instanceId, op);

      const initialState = setState(request.instanceId, () => ({
        instanceId: request.instanceId,
        phase: "installing",
        operationId,
        mode: plan.selectedMode,
        message: `Installing ${plan.displayName}…`,
        error: null,
        logs: [],
        installedVersion: null,
        executablePath: null,
        startedAt,
        finishedAt: null,
      }));

      const workflow: Effect.Effect<void> = (() => {
        if (plan.agentKind === "codex") {
          return runCodexManagedInstall({ instanceId: request.instanceId, operationId });
        }
        if (plan.selectedMode === "vendor-script") {
          const binaryName =
            plan.agentKind === "claude"
              ? "claude"
              : plan.agentKind === "deepseek-harness"
                ? "dsh"
                : ACP_REGISTRY_AGENT_META[plan.agentKind].cliBinary;
          return runVendorScriptInstall({
            instanceId: request.instanceId,
            operationId,
            commandPreview: plan.selectedOption.commandPreview,
            binaryName,
          });
        }
        if (plan.agentKind === "deepseek-harness") {
          const managedDir = NodePath.join(toolsDir, "deepseek-harness");
          return runManagedNpmInstall({
            instanceId: request.instanceId,
            operationId,
            agentKind: "deepseek-harness",
            packageName: "@deepseek-ai/dsh",
            binaryName: "dsh",
            installDir: managedDir,
            option: plan.selectedOption,
            wireInstance: (managedBin) =>
              Effect.gen(function* () {
                const current = yield* getInstanceConfig(request.instanceId);
                const currentConfig = isObjectRecord(current?.config) ? current.config : {};
                const currentCmd = configString(currentConfig, "commandPath");
                const isDefaultOrManaged =
                  !currentCmd ||
                  currentCmd === "dsh" ||
                  isInsideDirectory(currentCmd, managedDir);
                if (!isDefaultOrManaged) return;
                const currentArgs = Array.isArray(currentConfig.commandArgs)
                  ? currentConfig.commandArgs
                  : ["--profile", "acp"];
                yield* deps.updateProviderInstance({
                  operation: "upsert",
                  instanceId: ProviderInstanceId.make(request.instanceId),
                  instance: {
                    ...(current ?? {
                      driver: ProviderDriverKind.make("acpRegistry"),
                      displayName: "DeepSeek Harness",
                    }),
                    driver: ProviderDriverKind.make("acpRegistry"),
                    enabled: current?.enabled ?? true,
                    config: {
                      ...currentConfig,
                      source: "local",
                      commandPath: managedBin,
                      commandArgs: currentArgs,
                      enabled: current?.enabled ?? true,
                    },
                  },
                });
              }),
          });
        }
        if (plan.agentKind === "claude") {
          const managedDir = NodePath.join(toolsDir, "claude-code");
          return runManagedNpmInstall({
            instanceId: request.instanceId,
            operationId,
            agentKind: "claude",
            packageName: "@anthropic-ai/claude-code",
            binaryName: "claude",
            installDir: managedDir,
            option: plan.selectedOption,
            wireInstance: (managedBin) =>
              Effect.gen(function* () {
                const current = yield* getInstanceConfig(request.instanceId);
                const currentConfig = isObjectRecord(current?.config) ? current.config : {};
                const currentBinary = configString(currentConfig, "binaryPath");
                const isDefaultOrManaged =
                  !currentBinary ||
                  currentBinary === "claude" ||
                  isInsideDirectory(currentBinary, managedDir);
                if (!isDefaultOrManaged) return;
                yield* deps.updateProviderInstance({
                  operation: "upsert",
                  instanceId: ProviderInstanceId.make(request.instanceId),
                  instance: {
                    ...(current ?? { driver: ProviderDriverKind.make("claudeAgent") }),
                    driver: ProviderDriverKind.make("claudeAgent"),
                    enabled: current?.enabled ?? true,
                    config: {
                      ...currentConfig,
                      enabled: current?.enabled ?? true,
                      binaryPath: managedBin,
                    },
                  },
                });
              }),
          });
        }
        return runAcpRegistryManagedInstall({
          instanceId: request.instanceId,
          operationId,
          agentId: plan.agentKind,
          option: plan.selectedOption,
        });
      })();

      yield* Effect.forkDetach(
        workflow.pipe(
          Effect.ensuring(
            Effect.sync(() => {
              if (activeOps.get(request.instanceId)?.operationId === operationId) {
                activeOps.delete(request.instanceId);
              }
            }),
          ),
        ),
      );

      return initialState;
    });

  const cancelInstall = (
    instanceId: string,
    operationId?: string,
  ): Effect.Effect<ProviderProvisionState, ProvisionerError> =>
    Effect.gen(function* () {
      const op = activeOps.get(instanceId);
      if (op === undefined) {
        return getOrInitState(instanceId);
      }
      if (operationId !== undefined && op.operationId !== operationId) {
        return yield* Effect.fail(
          new ProvisionerError("operation_mismatch", "Active installation operation ID does not match.", 409),
        );
      }
      op.cancelled = true;
      op.cancel();
      return setState(instanceId, (prev) => ({
        ...prev,
        message: "Cancelling installation…",
      }));
    });

  const uninstall = (
    instanceId: string,
  ): Effect.Effect<ProviderProvisionState, ProvisionerError> =>
    Effect.gen(function* () {
      if (activeOps.has(instanceId)) {
        return yield* Effect.fail(
          new ProvisionerError(
            "already_installing",
            "Cancel the active installation before uninstalling.",
            409,
          ),
        );
      }

      const plan = yield* buildPlan(instanceId);
      if (!plan.canUninstall) {
        return yield* Effect.fail(
          new ProvisionerError("uninstall_unsupported", plan.uninstallGuidance, 400),
        );
      }

      const instanceIdTyped = ProviderInstanceId.make(instanceId);

      if (plan.agentKind === "codex") {
        yield* deps.providerInstallation.remove({ instanceId: instanceIdTyped }).pipe(
          Effect.mapError(
            (error) => new ProvisionerError("uninstall_failed", error.message, 500),
          ),
        );
      } else if (plan.agentKind === "deepseek-harness") {
        const managedDir = NodePath.join(toolsDir, "deepseek-harness");
        NodeFs.rmSync(managedDir, { recursive: true, force: true });
        const current = yield* getInstanceConfig(instanceId);
        const currentConfig = isObjectRecord(current?.config) ? current.config : {};
        const currentCmd = configString(currentConfig, "commandPath");
        if (current && currentCmd && isInsideDirectory(currentCmd, managedDir)) {
          yield* deps
            .updateProviderInstance({
              operation: "upsert",
              instanceId: instanceIdTyped,
              instance: {
                ...current,
                config: {
                  ...currentConfig,
                  commandPath: "dsh",
                },
              },
            })
            .pipe(Effect.ignore);
        }
      } else if (plan.agentKind === "claude") {
        const managedDir = NodePath.join(toolsDir, "claude-code");
        NodeFs.rmSync(managedDir, { recursive: true, force: true });
        const current = yield* getInstanceConfig(instanceId);
        const currentConfig = isObjectRecord(current?.config) ? current.config : {};
        const currentBinary = configString(currentConfig, "binaryPath");
        if (current && currentBinary && isInsideDirectory(currentBinary, managedDir)) {
          const { binaryPath: _omit, ...restConfig } = currentConfig;
          yield* deps
            .updateProviderInstance({
              operation: "upsert",
              instanceId: instanceIdTyped,
              instance: {
                ...current,
                config: restConfig,
              },
            })
            .pipe(Effect.ignore);
        }
      } else {
        // Kimi Code / Qoder / Codebuddy Code managed ACP tools dir + package receipts
        const agentRoot = NodePath.join(toolsDir, plan.agentKind);
        NodeFs.rmSync(agentRoot, { recursive: true, force: true });
        const receiptsDir = NodePath.join(deps.cacheDir, "acp-registry", "package-installs");
        if (NodeFs.existsSync(receiptsDir)) {
          for (const entry of NodeFs.readdirSync(receiptsDir)) {
            if (entry.startsWith(`${plan.agentKind}-`) && entry.endsWith(".json")) {
              NodeFs.rmSync(NodePath.join(receiptsDir, entry), { force: true });
            }
          }
        }
      }

      removeReceipt(deps.baseDir, instanceId);
      yield* deps.consent.revokeConsentForInstance(instanceId);
      yield* deps.refreshProviderInstance(instanceIdTyped).pipe(Effect.ignore);

      return setState(instanceId, () => ({
        ...idleState(instanceId),
        message: `Uninstalled managed ${plan.displayName}.`,
        finishedAt: new Date().toISOString(),
      }));
    });

  return {
    getPlan: buildPlan,
    getStatus: (instanceId) => Effect.sync(() => getOrInitState(instanceId)),
    listStatuses: () => Effect.sync(() => Object.fromEntries(states.entries())),
    startInstall,
    cancelInstall,
    uninstall,
  };
}

export const layer = Layer.effect(
  XtworkProviderProvisioner,
  Effect.gen(function* () {
    const config = yield* ServerConfig.ServerConfig;
    const platform = yield* HostProcess.Platform;
    const hostEnvironment = yield* HostProcess.Environment;
    const consent = yield* XtworkInstallConsent;
    const acpCatalog = yield* AcpRegistrySupport.AcpRegistryCatalog;
    const codexInstallation = yield* CodexInstallation.CodexInstallation;
    const providerInstallation = yield* ProviderInstallation.ProviderInstallation;
    const serverSettings = yield* ServerSettingsService.ServerSettingsService;
    const providerRegistry = yield* ProviderRegistry.ProviderRegistry;
    const spawner = yield* ChildProcessSpawner.ChildProcessSpawner;

    return makeProviderProvisioner({
      baseDir: config.baseDir,
      cacheDir: config.providerStatusCacheDir,
      platform,
      getHostEnvironment: () => hostEnvironment,
      consent,
      acpCatalog,
      codexInstallation,
      providerInstallation,
      getSettings: () => serverSettings.getSettings,
      updateProviderInstance: (input) => serverSettings.updateProviderInstance(input),
      refreshProviderInstance: (instanceId) => providerRegistry.refreshInstance(instanceId),
      refreshLoginPath: () =>
        refreshPathFromLoginShell().pipe(
          Effect.provideService(HostProcess.Platform, platform),
          Effect.provideService(HostProcess.Environment, hostEnvironment),
          Effect.provideService(ChildProcessSpawner.ChildProcessSpawner, spawner),
          Effect.ignore,
        ),
    });
  }),
);

const jsonResponse = (value: unknown, status = 200) =>
  HttpServerResponse.jsonUnsafe(value ?? {}, {
    status,
    headers: { "cache-control": "no-store" },
  });

const errorResponse = (error: string, status: number, code?: string) =>
  jsonResponse({ error, ...(code ? { code } : {}) }, status);

const serve = Effect.fnUntraced(function* (service: XtworkProviderProvisionerService) {
  const request = yield* HttpServerRequest.HttpServerRequest;
  if (parseBearerToken(request) === null) return errorResponse("Authentication required.", 401);
  const auth = yield* EnvironmentAuth;
  const bearer = request.modify({ headers: Headers.remove(request.headers, "cookie") });
  const session = yield* auth.authenticateHttpRequest(bearer).pipe(Effect.option);
  if (Option.isNone(session)) return errorResponse("Authentication required.", 401);

  const writing = request.method !== "GET";
  const requiredScope = writing ? AuthProvidersManageScope : AuthOrchestrationReadScope;
  if (!session.value.scopes.includes(requiredScope)) {
    return errorResponse("This session does not have permission to manage providers.", 403);
  }

  const url = new URL(request.url, "http://localhost");
  const action = url.pathname.slice("/api/xtwork/providers/".length).replace(/\/+$/u, "");

  if (!writing && action === "plan") {
    const instanceId = url.searchParams.get("instanceId")?.trim() ?? "";
    const modeParam = url.searchParams.get("mode")?.trim();
    const mode: ProvisionInstallMode | undefined =
      modeParam === "app-managed" || modeParam === "vendor-script" ? modeParam : undefined;
    if (!instanceId) return errorResponse("instanceId is required.", 400);
    return yield* service.getPlan(instanceId, mode).pipe(
      Effect.match({
        onSuccess: (plan) => jsonResponse(plan),
        onFailure: (error) => errorResponse(error.message, error.statusCode, error.code),
      }),
    );
  }

  if (!writing && action === "status") {
    const instanceId = url.searchParams.get("instanceId")?.trim();
    if (instanceId) {
      return jsonResponse(yield* service.getStatus(instanceId));
    }
    return jsonResponse({ statuses: yield* service.listStatuses() });
  }

  if (!writing) {
    return errorResponse("Unknown provider provisioning endpoint.", 404);
  }

  const rawBody = yield* request.json.pipe(
    Effect.provideService(HttpServerRequest.MaxBodySize, ByteSize.kibibytes(32)),
    Effect.option,
  );
  if (Option.isNone(rawBody) || !isObjectRecord(rawBody.value)) {
    return errorResponse("Invalid JSON request body.", 400);
  }
  const body = rawBody.value;
  const instanceId = typeof body.instanceId === "string" ? body.instanceId.trim() : "";
  if (!instanceId) return errorResponse("instanceId is required.", 400);

  if (action === "install") {
    const mode =
      body.mode === "app-managed" || body.mode === "vendor-script" ? body.mode : undefined;
    const rawConsent = isObjectRecord(body.consent) ? body.consent : null;
    if (
      rawConsent === null ||
      rawConsent.confirmed !== true ||
      typeof rawConsent.source !== "string" ||
      typeof rawConsent.version !== "string" ||
      typeof rawConsent.distribution !== "string" ||
      typeof rawConsent.installDir !== "string"
    ) {
      return errorResponse(
        "Explicit consent payload (confirmed, source, version, distribution, installDir) is required.",
        400,
        "consent_required",
      );
    }
    return yield* service
      .startInstall({
        instanceId,
        mode,
        consent: {
          confirmed: true,
          source: rawConsent.source,
          version: rawConsent.version,
          distribution: rawConsent.distribution,
          installDir: rawConsent.installDir,
        },
      })
      .pipe(
        Effect.match({
          onSuccess: (state) => jsonResponse(state, 202),
          onFailure: (error) => errorResponse(error.message, error.statusCode, error.code),
        }),
      );
  }

  if (action === "cancel") {
    const operationId = typeof body.operationId === "string" ? body.operationId : undefined;
    return yield* service.cancelInstall(instanceId, operationId).pipe(
      Effect.match({
        onSuccess: (state) => jsonResponse(state),
        onFailure: (error) => errorResponse(error.message, error.statusCode, error.code),
      }),
    );
  }

  if (action === "uninstall") {
    return yield* service.uninstall(instanceId).pipe(
      Effect.match({
        onSuccess: (state) => jsonResponse(state),
        onFailure: (error) => errorResponse(error.message, error.statusCode, error.code),
      }),
    );
  }

  return errorResponse("Unknown provider provisioning endpoint.", 404);
});

export const route = Layer.unwrap(
  Effect.map(XtworkProviderProvisioner, (service) =>
    Layer.mergeAll(
      HttpRouter.add("GET", "/api/xtwork/providers/*", serve(service)),
      HttpRouter.add("POST", "/api/xtwork/providers/*", serve(service)),
    ),
  ),
);
