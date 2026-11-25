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
import * as Semaphore from "effect/Semaphore";
import * as Stream from "effect/Stream";
import * as ChildProcessSpawner from "effect/process/ChildProcessSpawner";
import { Headers, HttpRouter, HttpServerRequest, HttpServerResponse } from "effect/http";
import * as NodeChildProcess from "node:child_process";
import * as NodeCrypto from "node:crypto";
import * as NodeFs from "node:fs";
import * as NodeHttps from "node:https";
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
export type ProvisionAcpDistributionPreference = "auto" | "binary" | "npx" | "uvx";

export type KnownProvisionAgentKind =
  | "codex"
  | "claude"
  | "kimi-code"
  | "qoder"
  | "codebuddy-code"
  | "deepseek-harness";

export type ProvisionAgentKind = KnownProvisionAgentKind | (string & {});

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
  /** True when exact version/artifact resolution succeeded and the option can be installed. */
  readonly installable: boolean;
  readonly unavailableReason?: string | undefined;
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
  readonly vendorInstallBlockedByExistingPath: boolean;
  readonly distributionPreference?: ProvisionAcpDistributionPreference | undefined;
  readonly state: ProviderProvisionState;
}

export interface ProvisionInstallConsentPayload {
  readonly confirmed: boolean;
  readonly source: string;
  readonly version: string;
  readonly distribution: string;
  readonly installDir: string;
  readonly artifactSpec?: string | undefined;
  readonly artifactDigest?: string | undefined;
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
  readonly onStdout?: (chunk: string) => void;
  readonly onStderr?: (chunk: string) => void;
}) => SpawnedCommandHandle;

export type ProvisionVersionProber = (
  executablePath: string,
  env: NodeJS.ProcessEnv,
  signal?: AbortSignal,
) => Promise<string | null>;

export type ProvisionNpmVersionResolver = (
  packageName: string,
  env: NodeJS.ProcessEnv,
) => Promise<string | null>;

export type ProvisionAcpVerifier = (input: {
  readonly executablePath: string;
  readonly args: ReadonlyArray<string>;
  readonly env: NodeJS.ProcessEnv;
  readonly signal?: AbortSignal;
}) => Promise<{ readonly ok: boolean; readonly version?: string | null; readonly error?: string }>;

const MAX_LOG_LINES = 300;
const MAX_LOG_LINE_CHARS = 400;
const MAX_LINE_BUFFER_CHARS = 16 * 1024;
const NPM_VERSION_CACHE_TTL_MS = 60_000;
const VENDOR_GLOBAL_INSTALL_DIR = "vendor-global";
const SEMVER_PATTERN = /^\d+\.\d+\.\d+(?:-[0-9A-Za-z.-]+)?$/u;

const ANSI_ESCAPE_PATTERN =
  // eslint-disable-next-line no-control-regex
  /\u001B(?:\][^\u0007\u001B]*(?:\u0007|\u001B\\)|\[[0-9;?]*[ -/]*[@-~])/g;
const SECRET_PATTERNS: ReadonlyArray<readonly [RegExp, string]> = [
  // S5: JSON-quoted key/value secret fields ("api_key": "...", "token": 123456, "password": "...", etc.)
  [
    /("(?:[^"\\]|\\.)*(?:api[_-]?key|password|passwd|secret|token|authorization|credential)(?:[^"\\]|\\.)*"\s*:\s*")((?:[^"\\]|\\.)*)(")/gi,
    "$1[REDACTED]$3",
  ],
  [
    /("(?:[^"\\]|\\.)*(?:api[_-]?key|password|passwd|secret|token|authorization|credential)(?:[^"\\]|\\.)*"\s*:\s*)(-?\d+(?:\.\d+)?(?:[eE][+-]?\d+)?)(?=\s*[,}\]]|$)/gi,
    '$1"[REDACTED]"',
  ],
  // Single-quoted key/value secret fields ('api_key': '...', 'token': 123456)
  [
    /('(?:[^'\\]|\\.)*(?:api[_-]?key|password|passwd|secret|token|authorization|credential)(?:[^'\\]|\\.)*'\s*:\s*')((?:[^'\\]|\\.)*)(')/gi,
    "$1[REDACTED]$3",
  ],
  [
    /('(?:[^'\\]|\\.)*(?:api[_-]?key|password|passwd|secret|token|authorization|credential)(?:[^'\\]|\\.)*'\s*:\s*)(-?\d+(?:\.\d+)?(?:[eE][+-]?\d+)?)(?=\s*[,}\]]|$)/gi,
    "$1'[REDACTED]'",
  ],
  [/\b(sk-[A-Za-z0-9_-]{12,})\b/g, "[REDACTED_KEY]"],
  [/\b((?:ghp|gho|ghu|ghs|ghr)_[A-Za-z0-9_]{12,}|github_pat_[A-Za-z0-9_]{12,})\b/g, "[REDACTED_KEY]"],
  [/\b(Bearer\s+)[A-Za-z0-9._~+/-]+=*/gi, "$1[REDACTED]"],
  [
    /\b(Authorization\s*[=:]\s*(?:(?:Bearer|Basic|Token)\s+)?)(?:"(?:[^"\\]|\\.)*"|'(?:[^'\\]|\\.)*'|\S+)/gi,
    "$1[REDACTED]",
  ],
  [
    /\b((?:ANTHROPIC|OPENAI|DEEPSEEK|KIMI|API)[A-Z0-9_]*(?:KEY|TOKEN|SECRET)\s*[=:]\s*)\S+/gi,
    "$1[REDACTED]",
  ],
  [
    /\b((?:api[_-]?key|apiKey|access[_-]?token|accessToken|refresh[_-]?token|refreshToken|client[_-]?secret|clientSecret|passwd|password|secret|token|credential)\s*[=:]\s*)(?:"(?:[^"\\]|\\.)*"|'(?:[^'\\]|\\.)*'|\S+)/gi,
    "$1[REDACTED]",
  ],
];

export function redactSecrets(raw: string): string {
  let clean = raw.replace(ANSI_ESCAPE_PATTERN, "").replace(/\r/g, "");
  for (const [pattern, replacement] of SECRET_PATTERNS) {
    clean = clean.replace(pattern, replacement);
  }
  return clean;
}

export function sanitizeProvisionLogLine(raw: string): string {
  let clean = redactSecrets(raw).trimEnd();
  if (clean.length > MAX_LOG_LINE_CHARS) {
    clean = `${clean.slice(0, MAX_LOG_LINE_CHARS - 1)}…`;
  }
  return clean;
}

/**
 * Bounded per-stream line buffer that defers secret redaction until complete lines
 * arrive (or the stream flushes), preventing credentials split across chunk
 * boundaries from leaking into status logs (S5).
 */
export interface RedactingLineBuffer {
  readonly push: (chunk: string) => void;
  readonly flush: () => void;
}

export function createRedactingLineBuffer(
  onCleanLine: (line: string) => void,
  maxBufferChars = MAX_LINE_BUFFER_CHARS,
): RedactingLineBuffer {
  let pending = "";

  const emitLine = (rawLine: string) => {
    const clean = sanitizeProvisionLogLine(rawLine);
    if (clean.length > 0) {
      onCleanLine(clean);
    }
  };

  return {
    push: (chunk: string) => {
      if (!chunk) return;
      pending += chunk;
      let newlineIdx = pending.indexOf("\n");
      while (newlineIdx !== -1) {
        const line = pending.slice(0, newlineIdx);
        pending = pending.slice(newlineIdx + 1);
        emitLine(line);
        newlineIdx = pending.indexOf("\n");
      }
      if (pending.length > maxBufferChars) {
        emitLine(pending);
        pending = "";
      }
    },
    flush: () => {
      if (pending.length > 0) {
        emitLine(pending);
        pending = "";
      }
    },
  };
}

export function extractVersionString(output: string): string | null {
  const match = /\bv?(\d+\.\d+\.\d+(?:-[0-9A-Za-z.-]+)?)\b/.exec(output);
  return match?.[1] ?? null;
}

/**
 * Builds a hardened POSIX installer command using HTTPS-only curl (`--proto '=https'`
 * and `--proto-redir '=https'`) downloading to a temp file before executing with bash,
 * so partial downloads or HTTP downgrades are never executed (M1).
 */
export function buildHardenedPosixInstallerCommand(httpsUrl: string): string {
  const trimmed = httpsUrl.trim();
  if (!trimmed.startsWith("https://")) {
    throw new Error(`Vendor installer URL must use https:// (got '${trimmed}')`);
  }
  if (/[\s'"`$;|&<>\\\n\r]/u.test(trimmed)) {
    throw new Error(`Vendor installer URL contains unsafe characters: '${trimmed}'`);
  }
  return [
    "set -euo pipefail",
    'tmp="$(mktemp -t xtwork-install.XXXXXX.sh)"',
    `trap 'rm -f "$tmp"' EXIT`,
    `curl --proto '=https' --proto-redir '=https' -fsSL '${trimmed}' -o "$tmp"`,
    'bash "$tmp"',
  ].join("\n");
}

function isExecutableFile(filePath: string, platform: NodeJS.Platform = process.platform): boolean {
  try {
    const stat = NodeFs.statSync(filePath);
    if (!stat.isFile()) return false;
    if (platform === "win32") return true;
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
    if (isExecutableFile(candidate, platform)) return candidate;
  }
  const execDir = NodePath.dirname(process.execPath);
  const siblingNpm = NodePath.join(execDir, npmName);
  if (isExecutableFile(siblingNpm, platform)) return siblingNpm;
  return findExecutableInPath(npmName, env, platform, []);
}

export function findExecutableInPath(
  binaryName: string,
  env: NodeJS.ProcessEnv,
  platform: NodeJS.Platform,
  excludedDirs: ReadonlyArray<string>,
): string | null {
  const rawPath =
    platform === "win32" ? (env.PATH ?? env.Path ?? env.path ?? "") : (env.PATH ?? "");
  const home =
    platform === "win32"
      ? env.USERPROFILE?.trim() || env.HOME?.trim() || NodeOs.homedir()
      : env.HOME?.trim() || NodeOs.homedir();
  const extraDirs =
    platform === "win32"
      ? [
          NodePath.join(home, ".kimi-code", "bin"),
          NodePath.join(home, ".local", "bin"),
          NodePath.join(home, ".cargo", "bin"),
        ]
      : [
          NodePath.join(home, ".local", "bin"),
          NodePath.join(home, ".kimi-code", "bin"),
          NodePath.join(home, ".claude", "local", "bin"),
          ...(env.XTWORK_DISABLE_SYSTEM_PATH_PROBE === "1"
            ? []
            : ["/opt/homebrew/bin", "/usr/local/bin"]),
        ];
  const pathDelimiter = platform === "win32" ? ";" : ":";
  const dirs = [...rawPath.split(pathDelimiter).filter(Boolean), ...extraDirs];
  const seen = new Set<string>();
  const extensions = platform === "win32" ? ["", ".exe", ".cmd", ".bat"] : [""];

  for (const rawDir of dirs) {
    const dir = NodePath.resolve(rawDir);
    if (seen.has(dir)) continue;
    seen.add(dir);
    if (excludedDirs.some((excluded) => isInsideDirectory(dir, excluded))) continue;
    for (const ext of extensions) {
      const candidate = NodePath.join(dir, `${binaryName}${ext}`);
      if (isExecutableFile(candidate, platform)) {
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

const defaultVersionProber: ProvisionVersionProber = (executablePath, env, signal) =>
  new Promise((resolve) => {
    if (signal?.aborted) {
      resolve(null);
      return;
    }
    const child = NodeChildProcess.execFile(
      executablePath,
      ["--version"],
      { env, timeout: 5_000, maxBuffer: 64 * 1024, ...(signal ? { signal } : {}) },
      (error, stdout, stderr) => {
        if (error) {
          resolve(null);
          return;
        }
        resolve(extractVersionString(`${stdout}\n${stderr}`));
      },
    );
    if (signal) {
      const onAbort = () => {
        try {
          child.kill("SIGKILL");
        } catch {
          // ignore
        }
      };
      signal.addEventListener("abort", onAbort, { once: true });
      child.once("close", () => signal.removeEventListener("abort", onAbort));
    }
  });

const defaultNpmVersionResolver: ProvisionNpmVersionResolver = async (packageName, env) => {
  const npmPath = resolveBundledNpm(env, process.platform);
  if (npmPath) {
    const fromCli = await new Promise<string | null>((resolve) => {
      NodeChildProcess.execFile(
        npmPath,
        ["view", packageName, "version", "--json"],
        { env, timeout: 8_000, maxBuffer: 64 * 1024 },
        (error, stdout) => {
          if (error) {
            resolve(null);
            return;
          }
          const raw = stdout.trim();
          try {
            const parsed = JSON.parse(raw) as unknown;
            if (typeof parsed === "string" && SEMVER_PATTERN.test(parsed.trim())) {
              resolve(parsed.trim());
              return;
            }
          } catch {
            if (SEMVER_PATTERN.test(raw)) {
              resolve(raw);
              return;
            }
          }
          resolve(null);
        },
      );
    });
    if (fromCli) return fromCli;
  }
  const fromRegistry = await new Promise<string | null>((resolve) => {
    const encoded = packageName.startsWith("@")
      ? `@${encodeURIComponent(packageName.slice(1))}`
      : encodeURIComponent(packageName);
    let settled = false;
    const finish = (value: string | null) => {
      if (settled) return;
      settled = true;
      resolve(value);
    };
    const req = NodeHttps.get(
      `https://registry.npmjs.org/${encoded}/latest`,
      {
        headers: { accept: "application/json" },
        timeout: 8_000,
      },
      (res) => {
        if ((res.statusCode ?? 0) < 200 || (res.statusCode ?? 0) >= 300) {
          res.resume();
          finish(null);
          return;
        }
        const chunks: Array<Buffer> = [];
        let totalBytes = 0;
        res.on("data", (chunk: Buffer) => {
          totalBytes += chunk.length;
          if (totalBytes <= 256 * 1024) {
            chunks.push(chunk);
          }
        });
        res.on("end", () => {
          try {
            const data = JSON.parse(Buffer.concat(chunks).toString("utf8")) as {
              version?: unknown;
            };
            if (typeof data.version === "string" && SEMVER_PATTERN.test(data.version.trim())) {
              finish(data.version.trim());
              return;
            }
          } catch {
            // malformed JSON
          }
          finish(null);
        });
        res.on("error", () => finish(null));
      },
    );
    req.on("timeout", () => {
      req.destroy();
      finish(null);
    });
    req.on("error", () => finish(null));
  });
  return fromRegistry;
};

function createOperationAbortController(): AbortController {
  return new AbortController();
}

const defaultAcpVerifier: ProvisionAcpVerifier = ({ executablePath, args, env, signal }) =>
  new Promise((resolve) => {
    if (signal?.aborted) {
      resolve({ ok: false, error: "Verification cancelled." });
      return;
    }
    const detached = process.platform !== "win32";
    let settled = false;
    const child = NodeChildProcess.spawn(executablePath, [...args], {
      env,
      stdio: ["pipe", "pipe", "pipe"],
      detached,
    });

    const killChild = () => {
      try {
        if (detached && child.pid) {
          process.kill(-child.pid, "SIGKILL");
        } else {
          child.kill("SIGKILL");
        }
      } catch {
        // already exited
      }
    };

    const finish = (outcome: { readonly ok: boolean; readonly version?: string | null; readonly error?: string }) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      signal?.removeEventListener("abort", onAbort);
      killChild();
      resolve(outcome);
    };

    const onAbort = () => finish({ ok: false, error: "Verification cancelled." });
    signal?.addEventListener("abort", onAbort, { once: true });

    const timer = setTimeout(() => {
      finish({ ok: false, error: `ACP initialize verification timed out for '${executablePath}'.` });
    }, 8_000);
    timer.unref?.();

    let stdoutBuf = "";
    child.stdout?.on("data", (chunk: Buffer) => {
      stdoutBuf += chunk.toString("utf8");
      if (stdoutBuf.length > 128 * 1024) {
        stdoutBuf = stdoutBuf.slice(-64 * 1024);
      }
      let nl = stdoutBuf.indexOf("\n");
      while (nl !== -1) {
        const line = stdoutBuf.slice(0, nl).trim();
        stdoutBuf = stdoutBuf.slice(nl + 1);
        if (line.startsWith("{")) {
          try {
            const msg = JSON.parse(line) as {
              id?: unknown;
              result?: { agentInfo?: { version?: unknown } };
              error?: { message?: unknown };
            };
            if (msg.id === 1) {
              if (msg.result && typeof msg.result === "object") {
                const agentVersion =
                  typeof msg.result.agentInfo?.version === "string"
                    ? msg.result.agentInfo.version
                    : null;
                finish({ ok: true, version: agentVersion });
                return;
              }
              if (msg.error) {
                finish({
                  ok: false,
                  error:
                    typeof msg.error.message === "string"
                      ? msg.error.message
                      : "ACP initialize returned an error.",
                });
                return;
              }
            }
          } catch {
            // ignore non-JSON banner lines
          }
        }
        nl = stdoutBuf.indexOf("\n");
      }
    });

    let stderrBuf = "";
    child.stderr?.on("data", (chunk: Buffer) => {
      if (stderrBuf.length < 4096) {
        stderrBuf += chunk.toString("utf8");
      }
    });

    child.on("error", (error) => {
      finish({
        ok: false,
        error: redactSecrets(
          error instanceof Error ? error.message : "Failed to spawn ACP executable.",
        ),
      });
    });
    child.on("close", (code) => {
      const stderrSummary = sanitizeProvisionLogLine(stderrBuf.trim());
      finish({
        ok: false,
        error: stderrSummary
          ? `ACP executable exited with code ${code ?? 1} before completing initialize: ${stderrSummary}`
          : `ACP executable exited with code ${code ?? 1} before completing initialize.`,
      });
    });

    try {
      child.stdin?.write(
        `${JSON.stringify({
          jsonrpc: "2.0",
          id: 1,
          method: "initialize",
          params: {
            protocolVersion: 1,
            clientCapabilities: {},
            clientInfo: { name: "xtwork-provisioner", version: "1.0.0" },
          },
        })}\n`,
      );
    } catch {
      finish({ ok: false, error: "Could not write ACP initialize request." });
    }
  });

const defaultCommandRunner: ProvisionCommandRunner = ({
  command,
  args,
  env,
  cwd,
  onOutput,
  onStdout,
  onStderr,
}) => {
  const detached = process.platform !== "win32";
  const child = NodeChildProcess.spawn(command, [...args], {
    env,
    ...(cwd ? { cwd } : {}),
    stdio: ["ignore", "pipe", "pipe"],
    detached,
  });

  child.stdout?.on("data", (chunk: Buffer) => {
    const text = chunk.toString("utf8");
    if (onStdout) onStdout(text);
    else onOutput(text);
  });
  child.stderr?.on("data", (chunk: Buffer) => {
    const text = chunk.toString("utf8");
    if (onStderr) onStderr(text);
    else onOutput(text);
  });

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

  const promise = new Promise<{
    readonly exitCode: number;
    readonly signal: NodeJS.Signals | null;
  }>((resolve, reject) => {
    child.on("error", (error) => {
      if (forceKillTimer) clearTimeout(forceKillTimer);
      reject(error);
    });
    child.on("close", (code, signal) => {
      if (forceKillTimer) clearTimeout(forceKillTimer);
      resolve({ exitCode: code ?? (signal ? 1 : 0), signal });
    });
  });

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
    if (!parsed || parsed.version !== 1 || !Array.isArray(parsed.receipts)) return [];
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

function isInstanceEnabled(instance: ProviderInstanceConfig): boolean {
  if (instance.enabled === false) return false;
  if (isObjectRecord(instance.config) && instance.config.enabled === false) return false;
  return true;
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
    if (source !== "local" && agentId.length > 0) {
      // M3: Support provisioning / re-confirmation / upgrades for ALL ACP Registry agents.
      return agentId;
    }
    if (source === "local") {
      const cmd = NodePath.basename(configString(instance.config, "commandPath"));
      if (cmd === "dsh" || cmd === "dsh.exe" || cmd === "dsh.cmd") {
        return "deepseek-harness";
      }
    }
  }
  return null;
}

interface VendorScriptMeta {
  readonly displayName: string;
  readonly cliBinary: string;
  readonly acpArgs: ReadonlyArray<string>;
  readonly posixScriptUrl: string;
  readonly windowsScriptUrl: string;
  readonly vendorUninstallGuidance: string;
  readonly vendorUninstallGuidanceZh: string;
}

type BuiltInVendorAcpAgentId = "kimi-code" | "qoder" | "codebuddy-code";

const ACP_REGISTRY_AGENT_META: Readonly<Record<BuiltInVendorAcpAgentId, VendorScriptMeta>> = {
  "kimi-code": {
    displayName: "Kimi Code",
    cliBinary: "kimi",
    acpArgs: ["acp"],
    // M1: Use the modern Kimi Code CLI HTTPS installer (legacy code.kimi.com/install.sh installs deprecated Python kimi-cli without a TTY).
    posixScriptUrl: "https://code.kimi.com/kimi-code/install.sh",
    windowsScriptUrl: "https://code.kimi.com/kimi-code/install.ps1",
    vendorUninstallGuidance:
      "Installed via Kimi Code's official HTTPS script into user global paths (~/.kimi-code). Uninstall using Kimi Code's official instructions or remove the binary from your PATH.",
    vendorUninstallGuidanceZh:
      "通过 Kimi Code 官方 HTTPS 脚本安装到用户全局目录（~/.kimi-code），小瞳 Work 不提供应用内自动回滚或卸载；如需卸载请按 Kimi Code 官方说明清理。",
  },
  qoder: {
    displayName: "Qoder",
    cliBinary: "qoder",
    acpArgs: ["--acp"],
    posixScriptUrl: "https://qoder.com/install",
    windowsScriptUrl: "https://qoder.com/install.ps1",
    vendorUninstallGuidance:
      "Installed via Qoder's official HTTPS script into user global paths. Uninstall using Qoder's official instructions.",
    vendorUninstallGuidanceZh:
      "通过 Qoder 官方 HTTPS 脚本安装到用户全局目录，小瞳 Work 不提供应用内自动回滚或卸载；如需卸载请按 Qoder 官方说明清理。",
  },
  "codebuddy-code": {
    displayName: "Codebuddy Code",
    cliBinary: "codebuddy",
    acpArgs: ["--acp"],
    posixScriptUrl: "https://copilot.tencent.com/cli/install.sh",
    windowsScriptUrl: "https://copilot.tencent.com/cli/install.ps1",
    vendorUninstallGuidance:
      "Installed via CodeBuddy's official HTTPS native installer script into user global paths. Xiaotong Work does not modify your global installation; follow CodeBuddy's official uninstall instructions.",
    vendorUninstallGuidanceZh:
      "通过 CodeBuddy 官方 HTTPS 安装脚本写入用户全局目录；小瞳 Work 不会擅自修改或卸载全局环境，如需卸载请按 CodeBuddy 官方说明清理。",
  },
};

function isBuiltInVendorAcpAgentId(agentKind: string): agentKind is BuiltInVendorAcpAgentId {
  return Object.prototype.hasOwnProperty.call(ACP_REGISTRY_AGENT_META, agentKind);
}

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
  readonly resolveNpmVersion?: ProvisionNpmVersionResolver | undefined;
  readonly verifyAcpInitialize?: ProvisionAcpVerifier | undefined;
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
  readonly resourceKey: string;
  readonly abortController: AbortController;
  readonly commitSemaphore: Semaphore.Semaphore;
  cancel: () => void;
  cancelled: boolean;
  committing: boolean;
  committed: boolean;
}

interface ResourceLock {
  readonly operationId: string;
  readonly instanceId: string;
  readonly kind: "install" | "uninstall";
}

export function makeProviderProvisioner(
  deps: ProviderProvisionerDeps,
): XtworkProviderProvisionerService {
  const runCommand = deps.runCommand ?? defaultCommandRunner;
  const probeVersion = deps.probeVersion ?? defaultVersionProber;
  const resolveNpmVersionRaw = deps.resolveNpmVersion ?? defaultNpmVersionResolver;
  const verifyAcpInitialize = deps.verifyAcpInitialize ?? defaultAcpVerifier;
  const toolsDir = NodePath.join(deps.baseDir, "tools");
  const states = new Map<string, ProviderProvisionState>();
  const activeOps = new Map<string, ActiveOperation>();
  // M6: synchronous instance reservation + shared managed-runtime / target-dir locks.
  const pendingInstances = new Set<string>();
  const resourceLocks = new Map<string, ResourceLock>();
  const npmVersionCache = new Map<string, { readonly version: string; readonly resolvedAt: number }>();

  const resolvePinnedNpmVersion = (
    packageName: string,
    env: NodeJS.ProcessEnv,
  ): Effect.Effect<string | null> =>
    Effect.gen(function* () {
      const cached = npmVersionCache.get(packageName);
      if (cached && Date.now() - cached.resolvedAt < NPM_VERSION_CACHE_TTL_MS) {
        return cached.version;
      }
      const version = yield* Effect.promise(() => resolveNpmVersionRaw(packageName, env));
      if (version && SEMVER_PATTERN.test(version.trim())) {
        const clean = version.trim();
        npmVersionCache.set(packageName, { version: clean, resolvedAt: Date.now() });
        return clean;
      }
      return null;
    });

  const resourceLockKeyFor = (
    agentKind: ProvisionAgentKind,
    mode: ProvisionInstallMode,
    targetInstallDir: string,
  ): string => {
    if (mode === "vendor-script") return `vendor:${agentKind}`;
    if (agentKind === "codex") return `codex:${NodePath.resolve(deps.codexInstallation.managedDirectory)}`;
    if (agentKind === "claude") return `dir:${NodePath.resolve(toolsDir, "claude-code")}`;
    if (agentKind === "deepseek-harness") return `dir:${NodePath.resolve(toolsDir, "deepseek-harness")}`;
    if (agentKind.trim().length > 0) {
      return `acp:${agentKind}`;
    }
    return `dir:${NodePath.resolve(targetInstallDir)}`;
  };

  const getOrInitState = (instanceId: string): ProviderProvisionState =>
    states.get(instanceId) ?? idleState(instanceId);

  const setState = (
    instanceId: string,
    updater: (prev: ProviderProvisionState) => ProviderProvisionState,
  ): ProviderProvisionState => {
    const rawNext = updater(getOrInitState(instanceId));
    // S5: Defense-in-depth — always redact secrets from user-facing error and status messages.
    const next: ProviderProvisionState = {
      ...rawNext,
      error: rawNext.error !== null ? redactSecrets(rawNext.error) : null,
      message: rawNext.message !== null ? redactSecrets(rawNext.message) : null,
    };
    states.set(instanceId, next);
    return next;
  };

  const appendCleanLogLine = (instanceId: string, cleanLine: string): void => {
    if (!cleanLine) return;
    setState(instanceId, (prev) => ({
      ...prev,
      logs: [...prev.logs, cleanLine].slice(-MAX_LOG_LINES),
    }));
  };

  const appendLog = (instanceId: string, rawText: string): void => {
    const lines = rawText
      .split(/\n/u)
      .map(sanitizeProvisionLogLine)
      .filter((line) => line.length > 0);
    if (lines.length === 0) return;
    setState(instanceId, (prev) => ({
      ...prev,
      logs: [...prev.logs, ...lines].slice(-MAX_LOG_LINES),
    }));
  };

  const isOpCancelled = (instanceId: string, operationId: string): boolean => {
    const op = activeOps.get(instanceId);
    return (
      op !== undefined &&
      op.operationId === operationId &&
      (op.cancelled || op.abortController.signal.aborted)
    );
  };

  const getInstanceConfig = (
    instanceId: string,
  ): Effect.Effect<ProviderInstanceConfig | undefined> =>
    deps.getSettings().pipe(
      Effect.map((settings) => settings.providerInstances[instanceId as ProviderInstanceId]),
      Effect.orElseSucceed(() => undefined),
    );

  const findOtherReferencingInstances = (
    instanceId: string,
    agentKind: ProvisionAgentKind,
    managedDir: string,
  ): Effect.Effect<ReadonlyArray<string>> =>
    deps.getSettings().pipe(
      Effect.map((settings) => {
        const blocking: Array<string> = [];
        for (const [candidateId, instance] of Object.entries(settings.providerInstances)) {
          if (candidateId === instanceId || !isInstanceEnabled(instance)) continue;
          const config = isObjectRecord(instance.config) ? instance.config : {};
          if (agentKind === "codex" && instance.driver === ProviderDriverKind.make("codex")) {
            const binaryPath = configString(config, "binaryPath");
            if (config.setupMode === "managed" || (binaryPath && isInsideDirectory(binaryPath, managedDir))) {
              blocking.push(candidateId);
            }
          } else if (
            agentKind === "claude" &&
            instance.driver === ProviderDriverKind.make("claudeAgent")
          ) {
            const binaryPath = configString(config, "binaryPath");
            if (binaryPath && isInsideDirectory(binaryPath, managedDir)) {
              blocking.push(candidateId);
            }
          } else if (
            agentKind === "deepseek-harness" &&
            instance.driver === ProviderDriverKind.make("acpRegistry")
          ) {
            const cmd = configString(config, "commandPath");
            if (cmd && isInsideDirectory(cmd, managedDir)) {
              blocking.push(candidateId);
            }
          } else if (instance.driver === ProviderDriverKind.make("acpRegistry")) {
            const cmd = configString(config, "commandPath");
            if (
              config.source !== "local" &&
              configString(config, "agentId") === agentKind &&
              !cmd
            ) {
              blocking.push(candidateId);
            }
          }
        }
        return blocking;
      }),
      Effect.orElseSucceed((): ReadonlyArray<string> => []),
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
        const pendingRelease = deps.codexInstallation.describePendingRelease
          ? yield* deps.codexInstallation.describePendingRelease()
          : null;
        const userCodexPath = findExecutableInPath("codex", env, platform, [toolsDir]);
        const userCodexVersion = userCodexPath
          ? yield* Effect.promise(() => probeVersion(userCodexPath, env))
          : null;
        const managedInstallDir = deps.codexInstallation.managedDirectory;
        const managedInstalled =
          codexState.source === "managed" && codexState.installedVersion !== null;
        const targetVersion =
          pendingRelease?.version ?? codexState.version ?? codexState.installedVersion ?? null;
        const pinnedUrl =
          pendingRelease?.url ?? "https://github.com/openai/codex/releases";
        const pinnedSha256 = pendingRelease?.sha256?.toLowerCase();
        const installable = targetVersion !== null;
        const consentKey = normalizeInstallConsentKey({
          instanceId,
          source: "codex-managed",
          version: targetVersion ?? "unavailable",
          distribution: "codex-release",
          installDir: managedInstallDir,
          ...(pendingRelease ? { artifactSpec: pendingRelease.url } : {}),
          ...(pinnedSha256 ? { artifactDigest: pinnedSha256 } : {}),
        });
        const option: ProvisionPlanOption = {
          mode: "app-managed",
          label: "App-Managed Isolated Install",
          labelZh: "受管隔离安装（推荐）",
          summary:
            "Downloads OpenAI's official Codex release into Xiaotong Work's private tools directory with SHA-256 verification.",
          summaryZh:
            "从官方发布源下载并经 SHA-256 校验安装到应用独立目录，支持取消与一键卸载，不修改系统全局环境。",
          commandPreview: pendingRelease
            ? `Download verified Codex v${pendingRelease.version} (${pendingRelease.url}, sha256=${pendingRelease.sha256.slice(0, 16)}…) -> ${managedInstallDir}`
            : `Download official Codex ${targetVersion ?? "(unavailable)"} release -> ${managedInstallDir}`,
          officialSource: pinnedUrl,
          targetInstallDir: managedInstallDir,
          uninstallSemantics: "app-managed",
          uninstallGuidance: `Removes the managed Codex directory (${managedInstallDir}) without affecting system-installed Codex or sign-in history.`,
          uninstallGuidanceZh: `可直接在应用内移除受管目录（${managedInstallDir}），不影响您本机全局安装的 Codex。`,
          consentKey,
          availableVersion: targetVersion,
          distribution: "codex-release",
          installable,
          ...(installable
            ? {}
            : { unavailableReason: "No supported Codex release is published for this platform." }),
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
          targetVersion !== null &&
          targetVersion !== codexState.installedVersion;
        const hasConsent = installable ? yield* deps.consent.hasConsent(consentKey) : false;
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
          availableVersion: targetVersion,
          updateAvailable,
          consentRequired: consentReason !== null,
          consentReason,
          canUninstall: Boolean(codexState.canRemove || managedInstalled),
          uninstallSemantics: "app-managed",
          uninstallGuidance: option.uninstallGuidance,
          uninstallGuidanceZh: option.uninstallGuidanceZh,
          vendorInstallBlockedByExistingPath: false,
          state: currentState,
        };
      }

      // ---- 2. CLAUDE CODE (Default: Vendor Script; Optional: App-Managed pinned npm) ----
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
        const vendorScriptUrl =
          platform === "win32" ? "https://claude.ai/install.ps1" : "https://claude.ai/install.sh";
        const vendorScriptCmd =
          platform === "win32"
            ? `irm ${vendorScriptUrl} | iex`
            : buildHardenedPosixInstallerCommand(vendorScriptUrl);

        const vendorBlocked = userClaudePath !== null;
        const vendorOption: ProvisionPlanOption = {
          mode: "vendor-script",
          label: "Official Install Script (Recommended)",
          labelZh: "官方脚本安装（默认）",
          summary:
            "Runs Anthropic's official HTTPS installer script into your user directory (~/.local/bin/claude).",
          summaryZh:
            "通过仅限 HTTPS 的 curl 下载并执行 Anthropic 官方安装脚本到本机用户目录（~/.local/bin/claude），安装后自动探测并刷新状态。",
          commandPreview: vendorScriptCmd,
          officialSource: vendorScriptUrl,
          targetInstallDir: VENDOR_GLOBAL_INSTALL_DIR,
          uninstallSemantics: "vendor-managed",
          uninstallGuidance:
            "Installed by Anthropic's official script into user global paths. Xiaotong Work cannot atomically roll back or uninstall it; remove ~/.local/bin/claude or follow Anthropic's uninstall docs.",
          uninstallGuidanceZh:
            "由官方脚本写入本机用户目录，小瞳 Work 不承诺原子回滚或应用内卸载；如需卸载请手动删除 ~/.local/bin/claude 或参考 Anthropic 官方文档。",
          consentKey: normalizeInstallConsentKey({
            instanceId,
            source: "vendor-script",
            version: "official-script",
            distribution: "vendor-script",
            installDir: VENDOR_GLOBAL_INSTALL_DIR,
            artifactSpec: vendorScriptUrl,
          }),
          availableVersion: null,
          distribution: "vendor-script",
          installable: !vendorBlocked,
          ...(vendorBlocked
            ? {
                unavailableReason: `Claude Code is already installed on PATH at ${userClaudePath}. Xiaotong Work will not overwrite your existing installation.`,
              }
            : {}),
        };

        // M4: Resolve exact pinned npm version before confirmation when app-managed mode is selected or inspected.
        const selectedMode: ProvisionInstallMode =
          requestedMode ?? (managedExists && !userClaudePath ? "app-managed" : "vendor-script");
        const resolvedClaudeNpmVersion =
          selectedMode === "app-managed" || requestedMode === "app-managed"
            ? yield* resolvePinnedNpmVersion("@anthropic-ai/claude-code", env)
            : (npmVersionCache.get("@anthropic-ai/claude-code")?.version ?? null);
        const pinnedClaudeSpec = resolvedClaudeNpmVersion
          ? `@anthropic-ai/claude-code@${resolvedClaudeNpmVersion}`
          : null;

        const managedOption: ProvisionPlanOption = {
          mode: "app-managed",
          label: "App-Managed Isolated npm",
          labelZh: "受管隔离安装（随包 npm）",
          summary:
            "Installs a pinned version of @anthropic-ai/claude-code into Xiaotong Work's isolated tools directory using bundled npm.",
          summaryZh:
            "使用随包 npm 将锁定版本的 @anthropic-ai/claude-code 安装至应用独立目录，支持取消清理与一键卸载，不污染系统全局。",
          commandPreview: pinnedClaudeSpec
            ? `${npmPath} install --prefix ${managedDir} ${pinnedClaudeSpec}`
            : `${npmPath} install --prefix ${managedDir} @anthropic-ai/claude-code@<version-unresolved>`,
          officialSource: "https://www.npmjs.com/package/@anthropic-ai/claude-code",
          targetInstallDir: managedDir,
          uninstallSemantics: "app-managed",
          uninstallGuidance: `Removes ${managedDir} and clears any auto-wired managed binary path without touching global installations.`,
          uninstallGuidanceZh: `应用内一键移除受管目录（${managedDir}）并清理自动绑定路径，不影响系统全局工具。`,
          consentKey: normalizeInstallConsentKey({
            instanceId,
            source: "npm-managed",
            version: resolvedClaudeNpmVersion ?? "unresolved",
            distribution: "npm",
            installDir: managedDir,
            ...(pinnedClaudeSpec ? { artifactSpec: pinnedClaudeSpec } : {}),
          }),
          availableVersion: resolvedClaudeNpmVersion,
          distribution: "npm",
          installable: pinnedClaudeSpec !== null,
          ...(pinnedClaudeSpec === null
            ? {
                unavailableReason:
                  "Could not resolve an exact version of @anthropic-ai/claude-code from npm. Check network connectivity and retry.",
              }
            : {}),
        };

        const availableModes: ReadonlyArray<ProvisionPlanOption> = [vendorOption, managedOption];
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

        const updateAvailable =
          selectedOption.mode === "app-managed" &&
          managedExists &&
          managedVersion !== null &&
          resolvedClaudeNpmVersion !== null &&
          managedVersion !== resolvedClaudeNpmVersion;
        const hasConsent = selectedOption.installable
          ? yield* deps.consent.hasConsent(selectedOption.consentKey)
          : false;
        const consentReason =
          updateAvailable && !hasConsent
            ? "update_required"
            : !existingDetection.detected && !hasConsent
              ? "install_required"
              : null;

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
          updateAvailable,
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
          vendorInstallBlockedByExistingPath: selectedOption.mode === "vendor-script" && vendorBlocked,
          state: currentState,
        };
      }

      // ---- 3. DEEPSEEK HARNESS (App-Managed Isolated pinned npm) ----
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
        // M4: Resolve and pin exact npm version BEFORE confirmation.
        const resolvedDshVersion = yield* resolvePinnedNpmVersion("@deepseek-ai/dsh", env);
        const pinnedDshSpec = resolvedDshVersion ? `@deepseek-ai/dsh@${resolvedDshVersion}` : null;

        const option: ProvisionPlanOption = {
          mode: "app-managed",
          label: "App-Managed Isolated npm",
          labelZh: "受管隔离安装（随包 npm）",
          summary:
            "Installs a pinned version of @deepseek-ai/dsh into Xiaotong Work's isolated tools directory using bundled Node & npm.",
          summaryZh:
            "使用随包 Node 与 npm 将锁定版本的 @deepseek-ai/dsh 安装至应用独立目录，支持取消清理与一键卸载，不覆盖您已安装的 dsh。",
          commandPreview: pinnedDshSpec
            ? `${npmPath} install --prefix ${managedDir} ${pinnedDshSpec}`
            : `${npmPath} install --prefix ${managedDir} @deepseek-ai/dsh@<version-unresolved>`,
          officialSource: "https://www.npmjs.com/package/@deepseek-ai/dsh",
          targetInstallDir: managedDir,
          uninstallSemantics: "app-managed",
          uninstallGuidance: `Removes ${managedDir} and restores default command 'dsh' if no custom path was configured.`,
          uninstallGuidanceZh: `应用内一键移除受管目录（${managedDir}），并在未配置自定义路径时恢复默认命令 dsh。`,
          consentKey: normalizeInstallConsentKey({
            instanceId,
            source: "npm-managed",
            version: resolvedDshVersion ?? "unresolved",
            distribution: "npm",
            installDir: managedDir,
            ...(pinnedDshSpec ? { artifactSpec: pinnedDshSpec } : {}),
          }),
          availableVersion: resolvedDshVersion,
          distribution: "npm",
          installable: pinnedDshSpec !== null,
          ...(pinnedDshSpec === null
            ? {
                unavailableReason:
                  "Could not resolve an exact version of @deepseek-ai/dsh from npm. Check network connectivity and retry.",
              }
            : {}),
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

        const updateAvailable =
          managedExists &&
          managedVersion !== null &&
          resolvedDshVersion !== null &&
          managedVersion !== resolvedDshVersion;
        const hasConsent = option.installable
          ? yield* deps.consent.hasConsent(option.consentKey)
          : false;
        const consentReason =
          updateAvailable && !hasConsent
            ? "update_required"
            : !existingDetection.detected && !hasConsent
              ? "install_required"
              : null;

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
          availableVersion: resolvedDshVersion,
          updateAvailable,
          consentRequired: consentReason !== null,
          consentReason,
          canUninstall: managedExists,
          uninstallSemantics: "app-managed",
          uninstallGuidance: option.uninstallGuidance,
          uninstallGuidanceZh: option.uninstallGuidanceZh,
          vendorInstallBlockedByExistingPath: false,
          state: currentState,
        };
      }

      // ---- 4. ACP REGISTRY AGENTS (Built-in Kimi/Qoder/Codebuddy + all user-added ACP Registry agents) ----
      const builtInMeta = isBuiltInVendorAcpAgentId(agentKind)
        ? ACP_REGISTRY_AGENT_META[agentKind]
        : undefined;
      const acpAgentId = agentKind;
      const resolvedDisplayName =
        instance?.displayName?.trim() || builtInMeta?.displayName || acpAgentId;
      // M3: Honor the instance's configured ACP distribution preference (e.g. "npx") rather than forcing "auto".
      const rawDistributionPref = configString(instance?.config, "distribution");
      const configuredDistribution: ProvisionAcpDistributionPreference =
        rawDistributionPref === "binary" ||
        rawDistributionPref === "npx" ||
        rawDistributionPref === "uvx"
          ? rawDistributionPref
          : "auto";
      const described = deps.acpCatalog.describeAgent
        ? yield* deps.acpCatalog.describeAgent(acpAgentId, configuredDistribution).pipe(Effect.option)
        : Option.none();
      const describedValue = Option.getOrUndefined(described);

      const userCliPath = builtInMeta
        ? findExecutableInPath(builtInMeta.cliBinary, env, platform, [toolsDir])
        : null;
      const userCliVersion = userCliPath
        ? yield* Effect.promise(() => probeVersion(userCliPath, env))
        : null;

      const resolvedVersion = describedValue?.version ?? null;
      const resolvedDistribution = describedValue?.distribution ?? receipt?.distribution ?? "npx";
      const resolvedInstallDir =
        describedValue?.installDir ??
        receipt?.installDir ??
        NodePath.join(toolsDir, acpAgentId, encodeURIComponent(resolvedVersion ?? "unresolved"), "npm");
      const resolvedArtifactSpec = describedValue
        ? describedValue.distribution === "binary"
          ? describedValue.archiveUrl
          : describedValue.packageName
        : undefined;
      const resolvedDigest = describedValue?.sha256?.toLowerCase();
      const npmPath = resolveBundledNpm(env, platform) ?? "npm";
      const managedCommandPreview = describedValue
        ? describedValue.distribution === "binary"
          ? `Download verified ACP Registry binary ${acpAgentId}@${describedValue.version} (${describedValue.archiveUrl ?? "official ACP Registry"}${resolvedDigest ? `, sha256=${resolvedDigest.slice(0, 16)}…` : ""}) -> ${describedValue.installDir}`
          : describedValue.distribution === "npx"
            ? `${npmPath} install --global ${describedValue.packageName ?? acpAgentId} (npm_config_prefix=${describedValue.installDir})`
            : `uv tool install --force ${describedValue.packageName ?? acpAgentId} (UV_TOOL_DIR=${describedValue.installDir})`
        : `Prepare official ACP Registry agent '${acpAgentId}' (metadata unavailable)`;

      const appManagedInstallable =
        describedValue !== undefined && resolvedVersion !== null && resolvedArtifactSpec !== undefined;

      const appManagedOption: ProvisionPlanOption = {
        mode: "app-managed",
        label: "App-Managed ACP Install (Recommended)",
        labelZh: "受管隔离安装（ACP Registry，推荐）",
        summary: `Installs ${resolvedDisplayName} from the official ACP Registry into Xiaotong Work's isolated tools cache using bundled Node & npm.`,
        summaryZh: `通过官方 ACP Registry 与随包 Node/npm 将 ${resolvedDisplayName} 安装到应用独立目录，支持取消清理与一键卸载。`,
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
          version: resolvedVersion ?? "unresolved",
          distribution: resolvedDistribution,
          installDir: resolvedInstallDir,
          ...(resolvedArtifactSpec ? { artifactSpec: resolvedArtifactSpec } : {}),
          ...(resolvedDigest ? { artifactDigest: resolvedDigest } : {}),
        }),
        availableVersion: resolvedVersion,
        distribution: resolvedDistribution,
        installable: appManagedInstallable,
        ...(appManagedInstallable
          ? {}
          : {
              unavailableReason: `Could not resolve pinned ACP Registry metadata for '${acpAgentId}'. Check network access and retry.`,
            }),
      };

      const vendorBlocked = userCliPath !== null;
      const vendorScriptOption: ProvisionPlanOption | null = builtInMeta
        ? (() => {
            const vendorScriptUrl =
              platform === "win32" ? builtInMeta.windowsScriptUrl : builtInMeta.posixScriptUrl;
            const vendorScriptCommand =
              platform === "win32"
                ? `irm ${vendorScriptUrl} | iex`
                : buildHardenedPosixInstallerCommand(vendorScriptUrl);
            return {
              mode: "vendor-script",
              label: "Official Native Global Install",
              labelZh: "官方脚本全局安装（可选）",
              summary: `Runs ${builtInMeta.displayName}'s official HTTPS global installer script into your system/user PATH.`,
              summaryZh: `通过仅限 HTTPS 的 curl 下载并执行 ${builtInMeta.displayName} 官方全局安装脚本；安装后核验 ACP initialize 并绑定可执行文件路径，不承诺应用内卸载。`,
              commandPreview: vendorScriptCommand,
              officialSource: vendorScriptUrl,
              targetInstallDir: VENDOR_GLOBAL_INSTALL_DIR,
              uninstallSemantics: "vendor-managed",
              uninstallGuidance: builtInMeta.vendorUninstallGuidance,
              uninstallGuidanceZh: builtInMeta.vendorUninstallGuidanceZh,
              consentKey: normalizeInstallConsentKey({
                instanceId,
                source: "vendor-script",
                version: "official-script",
                distribution: "vendor-script",
                installDir: VENDOR_GLOBAL_INSTALL_DIR,
                artifactSpec: vendorScriptUrl,
              }),
              availableVersion: null,
              distribution: "vendor-script",
              installable: !vendorBlocked,
              ...(vendorBlocked
                ? {
                    unavailableReason: `${builtInMeta.displayName} is already installed on PATH at ${userCliPath}. Xiaotong Work will not overwrite your existing installation.`,
                  }
                : {}),
            } satisfies ProvisionPlanOption;
          })()
        : null;

      const availableModes: ReadonlyArray<ProvisionPlanOption> = vendorScriptOption
        ? [appManagedOption, vendorScriptOption]
        : [appManagedOption];
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
      const existingDetection: ExistingInstallDetection = managedInstalled
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

      const hasConsent = selectedOption.installable
        ? yield* deps.consent.hasConsent(selectedOption.consentKey)
        : false;
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
        displayName: resolvedDisplayName,
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
        vendorInstallBlockedByExistingPath:
          selectedOption.mode === "vendor-script" && vendorBlocked,
        distributionPreference: configuredDistribution,
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
    // M7: Never run global vendor script over an existing user PATH installation.
    if (plan.selectedMode === "vendor-script" && plan.vendorInstallBlockedByExistingPath) {
      return Effect.fail(
        new ProvisionerError(
          "existing_install_detected",
          plan.selectedOption.unavailableReason ??
            `${plan.displayName} is already installed on your PATH and will not be overwritten.`,
          409,
        ),
      );
    }
    // M4: Refuse unpinned / unresolved install options.
    if (!plan.selectedOption.installable) {
      return Effect.fail(
        new ProvisionerError(
          "version_resolution_failed",
          plan.selectedOption.unavailableReason ??
            `Could not resolve a pinned version/artifact for ${plan.displayName}.`,
          503,
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
        ...(consent.artifactSpec ? { artifactSpec: consent.artifactSpec } : {}),
        ...(consent.artifactDigest ? { artifactDigest: consent.artifactDigest } : {}),
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
    readonly pinnedPackageSpec: string;
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
        input.pinnedPackageSpec,
      ];
      appendLog(input.instanceId, `$ ${npmPath} ${args.join(" ")}`);

      // S5: separate bounded line buffers per stream so split secrets are redacted across chunk boundaries.
      const stdoutBuf = createRedactingLineBuffer((line) =>
        appendCleanLogLine(input.instanceId, line),
      );
      const stderrBuf = createRedactingLineBuffer((line) =>
        appendCleanLogLine(input.instanceId, line),
      );
      const handle = runCommand({
        command: npmPath,
        args,
        env,
        onOutput: (chunk) => stdoutBuf.push(chunk),
        onStdout: (chunk) => stdoutBuf.push(chunk),
        onStderr: (chunk) => stderrBuf.push(chunk),
      });
      const op = activeOps.get(input.instanceId);
      if (op && op.operationId === input.operationId) {
        op.cancel = () => {
          op.abortController.abort();
          handle.cancel();
        };
        if (op.cancelled) {
          op.abortController.abort();
          handle.cancel();
        }
      }

      const result = yield* Effect.tryPromise(() => handle.promise).pipe(
        Effect.match({
          onSuccess: (value) => ({ ok: true as const, value }),
          onFailure: (error) => ({ ok: false as const, error }),
        }),
      );
      stdoutBuf.flush();
      stderrBuf.flush();

      if (isOpCancelled(input.instanceId, input.operationId)) {
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

      const binName = deps.platform === "win32" ? `${input.binaryName}.cmd` : input.binaryName;
      const managedBin = NodePath.join(input.installDir, "node_modules", ".bin", binName);
      if (!isExecutableFile(managedBin, deps.platform)) {
        if (!existedBefore) {
          NodeFs.rmSync(input.installDir, { recursive: true, force: true });
        }
        setState(input.instanceId, (prev) => ({
          ...prev,
          phase: "failed",
          error: `Installed ${input.pinnedPackageSpec}, but '${binName}' was not found at ${managedBin}.`,
          message: "Verification failed.",
          finishedAt: new Date().toISOString(),
        }));
        return;
      }

      // S4: Pass AbortSignal into verification so cancellation interrupts probing immediately.
      const signal = activeOps.get(input.instanceId)?.abortController.signal;
      const probedVersion = yield* Effect.promise(() => probeVersion(managedBin, env, signal));

      // S4: Check cancellation BEFORE committing receipts, wiring settings, or reporting succeeded.
      if (isOpCancelled(input.instanceId, input.operationId)) {
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

      const installedVersion =
        probedVersion ?? readInstalledNpmPackageVersion(input.installDir, input.packageName);
      if (probedVersion === null && installedVersion === null) {
        if (!existedBefore) {
          NodeFs.rmSync(input.installDir, { recursive: true, force: true });
        }
        setState(input.instanceId, (prev) => ({
          ...prev,
          phase: "failed",
          error: `${input.binaryName} --version did not succeed after installation.`,
          message: "Verification failed.",
          finishedAt: new Date().toISOString(),
        }));
        return;
      }

      const commitOp = activeOps.get(input.instanceId);
      const runCommit = Effect.gen(function* () {
        if (isOpCancelled(input.instanceId, input.operationId)) {
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
        // S4: Past point-of-no-return under commitSemaphore; cancelInstall waits for this critical section
        // and observes committed=true rather than deleting the binary that settings now references.
        if (commitOp && commitOp.operationId === input.operationId) {
          commitOp.committing = true;
        }

        const wireResult = yield* input.wireInstance(managedBin).pipe(
          Effect.match({
            onSuccess: () => ({ ok: true as const }),
            onFailure: (error) => ({ ok: false as const, error }),
          }),
        );
        if (!wireResult.ok) {
          if (commitOp && commitOp.operationId === input.operationId) {
            commitOp.committing = false;
          }
          const detail = redactSecrets(
            wireResult.error instanceof Error
              ? wireResult.error.message
              : `Failed to save provider settings for '${input.instanceId}'.`,
          );
          appendLog(input.instanceId, detail);
          setState(input.instanceId, (prev) => ({
            ...prev,
            phase: "failed",
            installedVersion,
            executablePath: managedBin,
            error: detail,
            message: detail,
            finishedAt: new Date().toISOString(),
          }));
          return;
        }

        upsertReceipt(deps.baseDir, {
          instanceId: input.instanceId,
          agentKind: input.agentKind,
          mode: "app-managed",
          source: input.option.consentKey.source,
          version: installedVersion ?? input.option.consentKey.version,
          distribution: input.option.consentKey.distribution,
          installDir: input.installDir,
          executablePath: managedBin,
          installedAt: new Date().toISOString(),
        });

        if (commitOp && commitOp.operationId === input.operationId) {
          commitOp.committed = true;
          commitOp.committing = false;
        }

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

      if (commitOp && commitOp.operationId === input.operationId) {
        yield* commitOp.commitSemaphore.withPermits(1)(runCommit);
      } else {
        yield* runCommit;
      }

      if (getOrInitState(input.instanceId).phase === "succeeded") {
        yield* deps
          .refreshProviderInstance(ProviderInstanceId.make(input.instanceId))
          .pipe(Effect.ignore);
      }
    });

  const runVendorScriptInstall = (input: {
    readonly instanceId: string;
    readonly operationId: string;
    readonly agentKind: ProvisionAgentKind;
    readonly commandPreview: string;
    readonly binaryName: string;
    readonly acpArgs?: ReadonlyArray<string> | undefined;
  }): Effect.Effect<void> =>
    Effect.gen(function* () {
      const env = deps.getHostEnvironment();
      appendLog(input.instanceId, `$ ${input.commandPreview}`);
      const shellCmd =
        deps.platform === "win32"
          ? { command: "powershell.exe", args: ["-NoProfile", "-Command", input.commandPreview] }
          : { command: "/bin/bash", args: ["-c", input.commandPreview] };

      const stdoutBuf = createRedactingLineBuffer((line) =>
        appendCleanLogLine(input.instanceId, line),
      );
      const stderrBuf = createRedactingLineBuffer((line) =>
        appendCleanLogLine(input.instanceId, line),
      );
      const handle = runCommand({
        command: shellCmd.command,
        args: shellCmd.args,
        env,
        onOutput: (chunk) => stdoutBuf.push(chunk),
        onStdout: (chunk) => stdoutBuf.push(chunk),
        onStderr: (chunk) => stderrBuf.push(chunk),
      });
      const op = activeOps.get(input.instanceId);
      if (op && op.operationId === input.operationId) {
        op.cancel = () => {
          op.abortController.abort();
          handle.cancel();
        };
        if (op.cancelled) {
          op.abortController.abort();
          handle.cancel();
        }
      }

      const result = yield* Effect.tryPromise(() => handle.promise).pipe(
        Effect.match({
          onSuccess: (value) => ({ ok: true as const, value }),
          onFailure: (error) => ({ ok: false as const, error }),
        }),
      );
      stdoutBuf.flush();
      stderrBuf.flush();

      if (isOpCancelled(input.instanceId, input.operationId)) {
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

      if (isOpCancelled(input.instanceId, input.operationId)) {
        setState(input.instanceId, (prev) => ({
          ...prev,
          phase: "cancelled",
          message: "Installation cancelled.",
          finishedAt: new Date().toISOString(),
        }));
        return;
      }

      const refreshedEnv = deps.getHostEnvironment();
      const detectedPath = findExecutableInPath(input.binaryName, refreshedEnv, deps.platform, [
        toolsDir,
      ]);

      // M8: Fail cleanly when the vendor installer finishes but no executable is detected!
      if (!detectedPath) {
        const detail = `Installer finished, but '${input.binaryName}' was not detected on PATH. Verify installation in a terminal and refresh providers.`;
        appendLog(input.instanceId, detail);
        setState(input.instanceId, (prev) => ({
          ...prev,
          phase: "failed",
          installedVersion: null,
          executablePath: null,
          error: detail,
          message: detail,
          finishedAt: new Date().toISOString(),
        }));
        return;
      }

      const signal = activeOps.get(input.instanceId)?.abortController.signal;
      let detectedVersion = yield* Effect.promise(() =>
        probeVersion(detectedPath, refreshedEnv, signal),
      );

      if (isOpCancelled(input.instanceId, input.operationId)) {
        setState(input.instanceId, (prev) => ({
          ...prev,
          phase: "cancelled",
          message: "Installation cancelled.",
          finishedAt: new Date().toISOString(),
        }));
        return;
      }

      const isAcpVendorAgent =
        input.agentKind === "kimi-code" ||
        input.agentKind === "qoder" ||
        input.agentKind === "codebuddy-code";

      if (isAcpVendorAgent) {
        // M8: Verify ACP `initialize` handshake before wiring `commandPath` or reporting success!
        const acpCheck = yield* Effect.promise(() =>
          verifyAcpInitialize({
            executablePath: detectedPath,
            args: input.acpArgs ?? ["--acp"],
            env: refreshedEnv,
            ...(signal ? { signal } : {}),
          }),
        );
        if (isOpCancelled(input.instanceId, input.operationId)) {
          setState(input.instanceId, (prev) => ({
            ...prev,
            phase: "cancelled",
            message: "Installation cancelled.",
            finishedAt: new Date().toISOString(),
          }));
          return;
        }
        if (!acpCheck.ok) {
          const detail = redactSecrets(
            acpCheck.error ??
              `Detected '${detectedPath}', but ACP initialize verification failed.`,
          );
          appendLog(input.instanceId, detail);
          setState(input.instanceId, (prev) => ({
            ...prev,
            phase: "failed",
            installedVersion: detectedVersion,
            executablePath: detectedPath,
            error: detail,
            message: detail,
            finishedAt: new Date().toISOString(),
          }));
          return;
        }
        detectedVersion = detectedVersion ?? acpCheck.version ?? null;

        // M8/S4: Read existing config outside commit lock, then serialize commit against cancel
        // and re-check cancellation atomically BEFORE mutating settings. Propagate write errors!
        const current = yield* getInstanceConfig(input.instanceId);
        const commitOp = activeOps.get(input.instanceId);
        const commitVendorWiring = Effect.gen(function* () {
          if (isOpCancelled(input.instanceId, input.operationId)) {
            setState(input.instanceId, (prev) => ({
              ...prev,
              phase: "cancelled",
              message: "Installation cancelled.",
              finishedAt: new Date().toISOString(),
            }));
            return "cancelled" as const;
          }
          if (commitOp && commitOp.operationId === input.operationId) {
            commitOp.committing = true;
          }
          const currentConfig = isObjectRecord(current?.config) ? current.config : {};
          const existingCommandPath = configString(currentConfig, "commandPath");
          if (!existingCommandPath) {
            const displayName = isBuiltInVendorAcpAgentId(input.agentKind)
              ? ACP_REGISTRY_AGENT_META[input.agentKind].displayName
              : input.agentKind;
            const writeResult = yield* deps
              .updateProviderInstance({
                operation: "upsert",
                instanceId: ProviderInstanceId.make(input.instanceId),
                instance: {
                  ...(current ?? {
                    driver: ProviderDriverKind.make("acpRegistry"),
                    displayName,
                  }),
                  driver: ProviderDriverKind.make("acpRegistry"),
                  enabled: current?.enabled ?? true,
                  config: {
                    ...currentConfig,
                    source: "registry",
                    agentId: input.agentKind,
                    commandPath: detectedPath,
                    enabled: current?.enabled ?? true,
                  },
                },
              })
              .pipe(
                Effect.match({
                  onSuccess: () => ({ ok: true as const }),
                  onFailure: (error) => ({ ok: false as const, error }),
                }),
              );
            if (!writeResult.ok) {
              if (commitOp && commitOp.operationId === input.operationId) {
                commitOp.committing = false;
              }
              const detail = redactSecrets(
                writeResult.error instanceof Error
                  ? writeResult.error.message
                  : `Failed to save commandPath for '${input.instanceId}'.`,
              );
              appendLog(input.instanceId, detail);
              setState(input.instanceId, (prev) => ({
                ...prev,
                phase: "failed",
                installedVersion: detectedVersion,
                executablePath: detectedPath,
                error: detail,
                message: detail,
                finishedAt: new Date().toISOString(),
              }));
              return "failed" as const;
            }
          }
          if (commitOp && commitOp.operationId === input.operationId) {
            commitOp.committed = true;
            commitOp.committing = false;
          }
          appendLog(
            input.instanceId,
            `Verified ${input.binaryName}${detectedVersion ? ` v${detectedVersion}` : ""} at ${detectedPath}`,
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
          return "committed" as const;
        });

        const commitOutcome =
          commitOp && commitOp.operationId === input.operationId
            ? yield* commitOp.commitSemaphore.withPermits(1)(commitVendorWiring)
            : yield* commitVendorWiring;
        if (commitOutcome !== "committed") {
          return;
        }
      } else if (detectedVersion === null) {
        const detail = `Detected '${detectedPath}', but '${input.binaryName} --version' verification failed.`;
        appendLog(input.instanceId, detail);
        setState(input.instanceId, (prev) => ({
          ...prev,
          phase: "failed",
          installedVersion: null,
          executablePath: detectedPath,
          error: detail,
          message: detail,
          finishedAt: new Date().toISOString(),
        }));
        return;
      } else {
        const commitOp = activeOps.get(input.instanceId);
        const markCommitted = Effect.sync(() => {
          if (isOpCancelled(input.instanceId, input.operationId)) {
            setState(input.instanceId, (prev) => ({
              ...prev,
              phase: "cancelled",
              message: "Installation cancelled.",
              finishedAt: new Date().toISOString(),
            }));
            return false;
          }
          if (commitOp && commitOp.operationId === input.operationId) {
            commitOp.committed = true;
            commitOp.committing = false;
          }
          appendLog(
            input.instanceId,
            `Verified ${input.binaryName}${detectedVersion ? ` v${detectedVersion}` : ""} at ${detectedPath}`,
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
          return true;
        });
        const ok =
          commitOp && commitOp.operationId === input.operationId
            ? yield* commitOp.commitSemaphore.withPermits(1)(markCommitted)
            : yield* markCommitted;
        if (!ok) {
          return;
        }
      }

      yield* deps
        .refreshProviderInstance(ProviderInstanceId.make(input.instanceId))
        .pipe(Effect.ignore);
    });

  const runCodexManagedInstall = (input: {
    readonly instanceId: string;
    readonly operationId: string;
    readonly option: ProvisionPlanOption;
    readonly approvalToken: string;
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
        .start({
          instanceId: instanceIdTyped,
          approvalToken: input.approvalToken,
          ...(input.option.availableVersion ? { expectedVersion: input.option.availableVersion } : {}),
          ...(input.option.consentKey.artifactDigest
            ? { expectedSha256: input.option.consentKey.artifactDigest }
            : {}),
        })
        .pipe(
          Effect.match({
            onSuccess: (value) => ({ ok: true as const, value }),
            onFailure: (error) => ({ ok: false as const, error }),
          }),
        );

      if (!startedResult.ok) {
        yield* deps.consent.revokeApproval(input.approvalToken).pipe(Effect.ignore);
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
          op.abortController.abort();
          void Effect.runPromise(
            deps.providerInstallation
              .cancel({ instanceId: instanceIdTyped, operationId: codexOpId })
              .pipe(Effect.ignore),
          );
        };
        if (op.cancelled) {
          op.cancel();
        }
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

      yield* deps.consent.revokeApproval(input.approvalToken).pipe(Effect.ignore);
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
    readonly agentId: string;
    readonly option: ProvisionPlanOption;
    readonly approvalToken: string;
    readonly distributionPreference?: ProvisionAcpDistributionPreference | undefined;
  }): Effect.Effect<void> =>
    Effect.gen(function* () {
      const targetDir = input.option.targetInstallDir;
      const existedBefore = NodeFs.existsSync(targetDir);
      appendLog(input.instanceId, `$ ${input.option.commandPreview}`);

      const expectedDistribution =
        input.option.distribution === "binary" ||
        input.option.distribution === "npx" ||
        input.option.distribution === "uvx"
          ? input.option.distribution
          : undefined;
      const prepareEffect = deps.acpCatalog.prepare({
        agentId: input.agentId,
        instanceId: ProviderInstanceId.make(input.instanceId),
        approvalToken: input.approvalToken,
        ...(input.distributionPreference && input.distributionPreference !== "auto"
          ? { distributionPreference: input.distributionPreference }
          : {}),
        ...(input.option.availableVersion ? { expectedVersion: input.option.availableVersion } : {}),
        ...(expectedDistribution ? { expectedDistribution } : {}),
        ...(input.option.consentKey.artifactSpec
          ? { expectedArtifactSpec: input.option.consentKey.artifactSpec }
          : {}),
        ...(input.option.consentKey.artifactDigest
          ? { expectedArchiveSha256: input.option.consentKey.artifactDigest }
          : {}),
      });

      const fiber = yield* Effect.forkDetach(prepareEffect);
      const op = activeOps.get(input.instanceId);
      if (op && op.operationId === input.operationId) {
        op.cancel = () => {
          op.abortController.abort();
          void Effect.runPromise(Fiber.interrupt(fiber));
        };
        if (op.cancelled) {
          op.abortController.abort();
          yield* Fiber.interrupt(fiber);
        }
      }

      const exit = yield* Fiber.await(fiber);
      yield* deps.consent.revokeApproval(input.approvalToken).pipe(Effect.ignore);

      if (isOpCancelled(input.instanceId, input.operationId)) {
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

      const commitOp = activeOps.get(input.instanceId);
      const commitAcp = Effect.sync(() => {
        if (isOpCancelled(input.instanceId, input.operationId)) {
          if (!existedBefore) {
            NodeFs.rmSync(targetDir, { recursive: true, force: true });
          }
          setState(input.instanceId, (prev) => ({
            ...prev,
            phase: "cancelled",
            message: "Installation cancelled.",
            finishedAt: new Date().toISOString(),
          }));
          return false;
        }
        if (commitOp && commitOp.operationId === input.operationId) {
          commitOp.committing = true;
        }
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
        if (commitOp && commitOp.operationId === input.operationId) {
          commitOp.committed = true;
          commitOp.committing = false;
        }
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
        return true;
      });
      const committed =
        commitOp && commitOp.operationId === input.operationId
          ? yield* commitOp.commitSemaphore.withPermits(1)(commitAcp)
          : yield* commitAcp;
      if (!committed) {
        return;
      }

      yield* deps
        .refreshProviderInstance(ProviderInstanceId.make(input.instanceId))
        .pipe(Effect.ignore);
    });

  const startInstall = (
    request: ProvisionInstallRequest,
  ): Effect.Effect<ProviderProvisionState, ProvisionerError> =>
    Effect.suspend(() => {
      // M6: Acquire synchronous per-instance reservation BEFORE any async plan construction!
      if (pendingInstances.has(request.instanceId) || activeOps.has(request.instanceId)) {
        return Effect.fail(
          new ProvisionerError(
            "already_installing",
            `An operation is already in progress for '${request.instanceId}'.`,
            409,
          ),
        );
      }
      pendingInstances.add(request.instanceId);

      return Effect.gen(function* () {
        const plan = yield* buildPlan(request.instanceId, request.mode);
        const verifiedKey = yield* validateConsentMatches(plan, request.consent);

        const resourceKey = resourceLockKeyFor(
          plan.agentKind,
          plan.selectedMode,
          plan.selectedOption.targetInstallDir,
        );
        const existingLock = resourceLocks.get(resourceKey);
        if (existingLock !== undefined) {
          return yield* Effect.fail(
            new ProvisionerError(
              "resource_busy",
              `Another ${existingLock.kind} is already running for this managed runtime (${existingLock.instanceId}). Wait for it to finish first.`,
              409,
            ),
          );
        }

        // Persist explicit user consent audit log AND issue fresh single-use approval token (M2/M3).
        yield* deps.consent.grantConsent(verifiedKey, {
          commandPreview: plan.selectedOption.commandPreview,
          officialSource: plan.selectedOption.officialSource,
        });
        const approvalToken = yield* deps.consent.issueApproval(verifiedKey);

        const operationId = NodeCrypto.randomUUID();
        const startedAt = new Date().toISOString();
        const op: ActiveOperation = {
          operationId,
          mode: plan.selectedMode,
          resourceKey,
          abortController: createOperationAbortController(),
          commitSemaphore: Semaphore.makeUnsafe(1),
          cancel: () => {},
          cancelled: false,
          committing: false,
          committed: false,
        };
        activeOps.set(request.instanceId, op);
        resourceLocks.set(resourceKey, {
          operationId,
          instanceId: request.instanceId,
          kind: "install",
        });

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
            return runCodexManagedInstall({
              instanceId: request.instanceId,
              operationId,
              option: plan.selectedOption,
              approvalToken,
            });
          }
          if (plan.selectedMode === "vendor-script") {
            const binaryName =
              plan.agentKind === "claude"
                ? "claude"
                : plan.agentKind === "deepseek-harness"
                  ? "dsh"
                  : isBuiltInVendorAcpAgentId(plan.agentKind)
                    ? ACP_REGISTRY_AGENT_META[plan.agentKind].cliBinary
                    : plan.agentKind;
            const acpArgs = isBuiltInVendorAcpAgentId(plan.agentKind)
              ? ACP_REGISTRY_AGENT_META[plan.agentKind].acpArgs
              : undefined;
            return runVendorScriptInstall({
              instanceId: request.instanceId,
              operationId,
              agentKind: plan.agentKind,
              commandPreview: plan.selectedOption.commandPreview,
              binaryName,
              acpArgs,
            }).pipe(
              Effect.ensuring(deps.consent.revokeApproval(approvalToken).pipe(Effect.ignore)),
            );
          }
          if (plan.agentKind === "deepseek-harness") {
            const managedDir = NodePath.join(toolsDir, "deepseek-harness");
            const pinnedSpec = plan.selectedOption.consentKey.artifactSpec!;
            return runManagedNpmInstall({
              instanceId: request.instanceId,
              operationId,
              agentKind: "deepseek-harness",
              packageName: "@deepseek-ai/dsh",
              pinnedPackageSpec: pinnedSpec,
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
            }).pipe(
              Effect.ensuring(deps.consent.revokeApproval(approvalToken).pipe(Effect.ignore)),
            );
          }
          if (plan.agentKind === "claude") {
            const managedDir = NodePath.join(toolsDir, "claude-code");
            const pinnedSpec = plan.selectedOption.consentKey.artifactSpec!;
            return runManagedNpmInstall({
              instanceId: request.instanceId,
              operationId,
              agentKind: "claude",
              packageName: "@anthropic-ai/claude-code",
              pinnedPackageSpec: pinnedSpec,
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
            }).pipe(
              Effect.ensuring(deps.consent.revokeApproval(approvalToken).pipe(Effect.ignore)),
            );
          }
          return runAcpRegistryManagedInstall({
            instanceId: request.instanceId,
            operationId,
            agentId: plan.agentKind,
            option: plan.selectedOption,
            approvalToken,
            distributionPreference: plan.distributionPreference,
          });
        })();

        yield* Effect.forkDetach(
          workflow.pipe(
            Effect.ensuring(
              Effect.sync(() => {
                if (activeOps.get(request.instanceId)?.operationId === operationId) {
                  activeOps.delete(request.instanceId);
                }
                if (resourceLocks.get(resourceKey)?.operationId === operationId) {
                  resourceLocks.delete(resourceKey);
                }
              }),
            ),
          ),
        );

        return initialState;
      }).pipe(
        Effect.ensuring(
          Effect.sync(() => {
            pendingInstances.delete(request.instanceId);
          }),
        ),
      );
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
          new ProvisionerError(
            "operation_mismatch",
            "Active installation operation ID does not match.",
            409,
          ),
        );
      }
      // S4: Serialize with the per-operation commitSemaphore BEFORE mutating op.cancelled or aborting.
      // When a commit critical section (settings/receipt write) is already in progress, cancel waits for
      // commitSemaphore, observes committed=true / phase="succeeded", and returns that state untouched
      // instead of setting op.cancelled=true mid-write and triggering destructive cleanup.
      // When no commit is in progress, commitSemaphore is uncontended so abort runs immediately.
      return yield* op.commitSemaphore.withPermits(1)(
        Effect.sync(() => {
          const current = getOrInitState(instanceId);
          if (
            op.committed ||
            current.phase === "cancelled" ||
            current.phase === "failed" ||
            current.phase === "succeeded"
          ) {
            return current;
          }
          op.cancelled = true;
          op.abortController.abort();
          op.cancel();
          return setState(instanceId, (prev) => ({
            ...prev,
            message: "Cancelling installation…",
          }));
        }),
      );
    });

  const uninstall = (
    instanceId: string,
  ): Effect.Effect<ProviderProvisionState, ProvisionerError> =>
    Effect.suspend(() => {
      // M6: Synchronously guard against concurrent install/uninstall before async plan lookup.
      if (pendingInstances.has(instanceId) || activeOps.has(instanceId)) {
        return Effect.fail(
          new ProvisionerError(
            "already_installing",
            "Cancel the active installation before uninstalling.",
            409,
          ),
        );
      }
      pendingInstances.add(instanceId);

      const operationId = NodeCrypto.randomUUID();
      let acquiredResourceKey: string | null = null;

      return Effect.gen(function* () {
        const plan = yield* buildPlan(instanceId, "app-managed");
        if (!plan.canUninstall) {
          return yield* Effect.fail(
            new ProvisionerError("uninstall_unsupported", plan.uninstallGuidance, 400),
          );
        }

        const resourceKey = resourceLockKeyFor(
          plan.agentKind,
          "app-managed",
          plan.selectedOption.targetInstallDir,
        );
        const existingLock = resourceLocks.get(resourceKey);
        if (existingLock !== undefined) {
          return yield* Effect.fail(
            new ProvisionerError(
              "resource_busy",
              `Cannot uninstall while another ${existingLock.kind} is active for this managed runtime (${existingLock.instanceId}).`,
              409,
            ),
          );
        }
        resourceLocks.set(resourceKey, {
          operationId,
          instanceId,
          kind: "uninstall",
        });
        acquiredResourceKey = resourceKey;

        const instanceIdTyped = ProviderInstanceId.make(instanceId);

        if (plan.agentKind === "codex") {
          const blockers = yield* findOtherReferencingInstances(
            instanceId,
            "codex",
            deps.codexInstallation.managedDirectory,
          );
          if (blockers.length > 0) {
            return yield* Effect.fail(
              new ProvisionerError(
                "shared_runtime_in_use",
                `Cannot uninstall managed Codex because another enabled provider instance still uses it (${blockers.join(", ")}).`,
                409,
              ),
            );
          }
          yield* deps.providerInstallation.remove({ instanceId: instanceIdTyped }).pipe(
            Effect.mapError(
              (error) => new ProvisionerError("uninstall_failed", error.message, 500),
            ),
          );
        } else if (plan.agentKind === "deepseek-harness") {
          const managedDir = NodePath.join(toolsDir, "deepseek-harness");
          const blockers = yield* findOtherReferencingInstances(
            instanceId,
            "deepseek-harness",
            managedDir,
          );
          if (blockers.length > 0) {
            return yield* Effect.fail(
              new ProvisionerError(
                "shared_runtime_in_use",
                `Cannot uninstall managed DeepSeek Harness because another enabled provider instance still uses it (${blockers.join(", ")}).`,
                409,
              ),
            );
          }
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
          const blockers = yield* findOtherReferencingInstances(instanceId, "claude", managedDir);
          if (blockers.length > 0) {
            return yield* Effect.fail(
              new ProvisionerError(
                "shared_runtime_in_use",
                `Cannot uninstall managed Claude Code because another enabled provider instance still uses it (${blockers.join(", ")}).`,
                409,
              ),
            );
          }
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
          // M6: Acquire AcpRegistrySupport install permit & check shared references before removing ACP cache!
          const blockers = yield* findOtherReferencingInstances(
            instanceId,
            plan.agentKind,
            NodePath.join(toolsDir, plan.agentKind),
          );
          if (blockers.length > 0) {
            return yield* Effect.fail(
              new ProvisionerError(
                "shared_runtime_in_use",
                `Cannot uninstall managed ${plan.displayName} because another enabled provider instance still references '${plan.agentKind}' (${blockers.join(", ")}).`,
                409,
              ),
            );
          }
          if (deps.acpCatalog.uninstallManagedAgent) {
            const acpRemoval = yield* deps.acpCatalog
              .uninstallManagedAgent({
                agentId: plan.agentKind,
                ignoreInstanceId: instanceId,
              })
              .pipe(
                Effect.mapError(
                  (error) => new ProvisionerError("uninstall_failed", error.detail, 500),
                ),
              );
            if (acpRemoval.blockedByInstanceIds.length > 0) {
              return yield* Effect.fail(
                new ProvisionerError(
                  "shared_runtime_in_use",
                  `Cannot uninstall managed ${plan.displayName} because another enabled provider instance still references '${plan.agentKind}' (${acpRemoval.blockedByInstanceIds.join(", ")}).`,
                  409,
                ),
              );
            }
          } else {
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
        }

        removeReceipt(deps.baseDir, instanceId);
        yield* deps.consent.revokeConsentForInstance(instanceId);
        yield* deps.refreshProviderInstance(instanceIdTyped).pipe(Effect.ignore);

        return setState(instanceId, () => ({
          ...idleState(instanceId),
          message: `Uninstalled managed ${plan.displayName}.`,
          finishedAt: new Date().toISOString(),
        }));
      }).pipe(
        Effect.ensuring(
          Effect.sync(() => {
            pendingInstances.delete(instanceId);
            if (
              acquiredResourceKey !== null &&
              resourceLocks.get(acquiredResourceKey)?.operationId === operationId
            ) {
              resourceLocks.delete(acquiredResourceKey);
            }
          }),
        ),
      );
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
    const artifactSpec =
      typeof rawConsent.artifactSpec === "string" ? rawConsent.artifactSpec : undefined;
    const artifactDigest =
      typeof rawConsent.artifactDigest === "string" ? rawConsent.artifactDigest : undefined;
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
          ...(artifactSpec ? { artifactSpec } : {}),
          ...(artifactDigest ? { artifactDigest } : {}),
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
