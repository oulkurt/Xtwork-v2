// @effect-diagnostics nodeBuiltinImport:off globalTimers:off globalDate:off globalDateInEffect:off globalJsonInEffect:off effectTryWithoutCatch:off globalErrorInEffectCatch:off globalErrorInEffectFailure:off effectFnOpportunity:off deterministicKeys:off matchBooleanToIsSuccess:off
import { spawn, type ChildProcessByStdio } from "node:child_process";
import { isAbsolute } from "node:path";
import { createInterface } from "node:readline";
import type { Readable, Writable } from "node:stream";

export interface BridgeOptions {
  readonly entry: string;
  readonly dataDir: string;
  readonly companionDir: string;
}

export function bridgeRpcError(message: string, code?: string): Error {
  const err = new Error(message);
  if (code !== undefined) {
    Object.defineProperty(err, "code", { value: code, enumerable: true, configurable: true });
  }
  return err;
}

export type BridgePayload = Record<string, unknown>;
export const isRecord = (value: unknown): value is BridgePayload =>
  typeof value === "object" && value !== null && !Array.isArray(value);

export function bridgeOptions(env = process.env): BridgeOptions | undefined {
  const { XTWORK_IM_BRIDGE_ENTRY: entry, XTWORK_IM_DATA_DIR: dataDir, XTWORK_COMPANION_DIR: companionDir } = env;
  if (!entry) return undefined;
  if (!dataDir || !companionDir || ![entry, dataDir, companionDir].every(isAbsolute)) {
    throw new Error("The IM bridge requires absolute entry, data and companion paths.");
  }
  return { entry, dataDir, companionDir };
}

interface BridgeConnection {
  readonly child: ChildProcessByStdio<Writable, Readable, null>;
  readonly pending: Map<number, { resolve(value: unknown): void; reject(error: Error): void }>;
  readonly closed: Promise<void>;
  readonly events: Array<[string, BridgePayload]>;
  ready: boolean;
  readonly failureReset: ReturnType<typeof setTimeout>;
}

export class XtworkImBridgeHost {
  private connection: BridgeConnection | undefined;
  private restart: ReturnType<typeof setTimeout> | undefined;
  private closing: Promise<void> | undefined;
  private nextId = 0;
  private failures = 0;
  private exitCode: number | null | undefined;

  private readonly options: BridgeOptions;
  private readonly onEvent: (event: string, payload: BridgePayload) => void;
  private readonly onReady: ((call: (method: string, params?: BridgePayload, signal?: AbortSignal) => Promise<unknown>) => Promise<void>) | undefined;

  constructor(
    options: BridgeOptions,
    onEvent: (event: string, payload: BridgePayload) => void,
    onReady?: (call: (method: string, params?: BridgePayload, signal?: AbortSignal) => Promise<unknown>) => Promise<void>,
  ) {
    this.options = options;
    this.onEvent = onEvent;
    this.onReady = onReady;
  }

  get available() {
    return this.connection?.ready === true;
  }

  get lastExitCode() {
    return this.exitCode;
  }

  start() {
    if (this.connection || this.closing || this.restart) return;
    const { entry, dataDir, companionDir } = this.options;
    const env = Object.fromEntries(Object.entries(process.env).filter(([name]) =>
      ["PATH", "HOME", "USER", "LOGNAME", "TMPDIR", "TEMP", "TMP", "LANG", "TZ", "SystemRoot",
        "APPDATA", "LOCALAPPDATA", "USERPROFILE", "ComSpec", "XDG_RUNTIME_DIR", "DBUS_SESSION_BUS_ADDRESS"].includes(name) ||
      name.startsWith("LC_"),
    ));
    const child = spawn(process.execPath, [entry], {
      env: {
        ...env,
        XTWORK_IM_DATA_DIR: dataDir,
        XTWORK_COMPANION_DIR: companionDir,
        XTWORK_IM_PROTOCOL_VERSION: "1",
      },
      stdio: ["pipe", "pipe", "inherit"],
    });
    const connection: BridgeConnection = {
      child,
      closed: new Promise((resolve) => child.once("close", (code) => {
        this.exitCode = code;
        resolve();
      })),
      events: [],
      pending: new Map(),
      ready: false,
      failureReset: setTimeout(() => { this.failures = 0; }, 30_000),
    };
    connection.failureReset.unref();
    this.connection = connection;
    const stop = () => child.kill();
    child.once("error", stop);
    child.stdin.on("error", stop);
    const lines = createInterface({ input: child.stdout, crlfDelay: Infinity });
    lines.on("line", (line) => {
      try {
        const frame: unknown = JSON.parse(line);
        if (!isRecord(frame)) throw new Error("Invalid IM bridge frame.");
        if (typeof frame.id === "number") {
          const pending = connection.pending.get(frame.id);
          if (isRecord(frame.error) && typeof frame.error.message === "string") {
            const code = typeof frame.error.code === "string" ? frame.error.code : undefined;
            pending?.reject(bridgeRpcError(frame.error.message, code));
          } else {
            pending?.resolve(frame.result);
          }
        } else {
          const event = typeof frame.method === "string" ? frame.method : frame.event;
          const payload = isRecord(frame.params) ? frame.params : frame.payload;
          if (typeof event !== "string" || !isRecord(payload)) throw new Error("Invalid IM bridge frame.");
          if (connection.ready) this.onEvent(event, payload);
          else connection.events.push([event, payload]);
        }
      } catch {
        stop();
      }
    });
    void connection.closed.then(() => {
      clearTimeout(connection.failureReset);
      lines.close();
      for (const pending of connection.pending.values()) pending.reject(new Error("The IM bridge disconnected."));
      if (this.connection !== connection) return;
      this.connection = undefined;
      if (this.closing) return;
      const delay = Math.min(30_000, 250 * 2 ** this.failures++);
      this.restart = setTimeout(() => {
        this.restart = undefined;
        this.start();
      }, delay);
      this.restart.unref();
    });
    void this.call(
      connection,
      "bridge.hello",
      { protocolVersion: 1, ...(this.onReady ? { deferReplay: true } : {}) },
      AbortSignal.timeout(5000),
    )
      .then(async (result) => {
        if (!isRecord(result) || Number(result.protocolVersion) !== 1) {
          throw new Error("Incompatible IM bridge protocol.");
        }
        if (this.connection !== connection || this.closing) return;
        if (this.onReady) {
          await this.onReady((method, params = {}, signal) => this.call(connection, method, params, signal));
          if (this.connection !== connection || this.closing) return;
        }
        connection.ready = true;
        for (const [event, payload] of connection.events.splice(0)) this.onEvent(event, payload);
      })
      .catch(stop);
  }

  async request(method: string, params: BridgePayload = {}, signal?: AbortSignal) {
    const connection = this.connection;
    if (!connection?.ready || this.closing) throw new Error("The IM bridge is unavailable.");
    return this.call(connection, method, params, signal);
  }

  close() {
    return this.closing ??= this.stop();
  }

  private async stop() {
    clearTimeout(this.restart);
    const connection = this.connection;
    if (!connection) return;
    if (connection.ready) {
      await this.call(connection, "bridge.shutdown", {}, AbortSignal.timeout(2500)).catch(() => undefined);
    }
    connection.child.stdin.end();
    const terminate = setTimeout(() => connection.child.kill(), 500);
    const kill = setTimeout(() => connection.child.kill("SIGKILL"), 1500);
    try {
      await connection.closed;
    } finally {
      clearTimeout(terminate);
      clearTimeout(kill);
    }
  }

  private call(connection: BridgeConnection, method: string, params: BridgePayload, signal?: AbortSignal) {
    const id = ++this.nextId;
    const deadline = AbortSignal.any([AbortSignal.timeout(30_000), ...(signal ? [signal] : [])]);
    return new Promise<unknown>((resolve, reject) => {
      deadline.throwIfAborted();
      const finish = (settle: () => void) => {
        connection.pending.delete(id);
        deadline.removeEventListener("abort", abort);
        settle();
      };
      const abort = () => finish(() => reject(deadline.reason));
      connection.pending.set(id, {
        resolve: (value) => finish(() => resolve(value)),
        reject: (error) => finish(() => reject(error)),
      });
      deadline.addEventListener("abort", abort, { once: true });
      connection.child.stdin.write(JSON.stringify({ id, method, params }) + "\n", (error) => {
        if (error) finish(() => reject(error));
      });
    });
  }
}
