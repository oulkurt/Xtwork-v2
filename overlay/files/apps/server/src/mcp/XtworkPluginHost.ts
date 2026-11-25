// @effect-diagnostics nodeBuiltinImport:off globalTimers:off - owns a Node child and its JSONL pipes.
import { spawn, type ChildProcessByStdio } from "node:child_process";
import { isAbsolute, join } from "node:path";
import { createInterface } from "node:readline";
import type { Readable, Writable } from "node:stream";
import type * as Schema from "effect/Schema";
import type { ToolJson } from "effect/ai/McpSchema";

export interface PluginTool {
  readonly name: string;
  readonly title: string;
  readonly description: string;
  readonly confirm?: boolean;
  readonly inputSchema: ToolJson;
}

type Request = {
  readonly resolve: (result: unknown) => void;
  readonly reject: (error: Error) => void;
};

type Connection = {
  readonly child: ChildProcessByStdio<Writable, Readable, null>;
  readonly pending: Map<number, Request>;
  readonly exited: Promise<void>;
};

type HostOptions = {
  readonly executable: string;
  readonly pluginsDir: string;
  readonly dataDir: string;
  readonly disabled: string;
};

const REQUEST_TIMEOUT_MS = 45_000;
const MAX_PENDING_REQUESTS = 64;

export const isPluginToolName = (name: string) => /^[a-z][a-z0-9_]*__[a-z][a-z0-9_]*$/u.test(name);

export const pluginHostOptions = (stateDir: string): HostOptions | undefined => {
  const executable = process.env.XTWORK_PLUGIN_HOST_BIN;
  if (!executable) return undefined;
  const pluginsDir = process.env.XTWORK_PLUGINS_DIR;
  const dataDir = process.env.XTWORK_PLUGIN_DATA_DIR || join(stateDir, "plugins");
  if (!pluginsDir || ![executable, pluginsDir, dataDir].every(isAbsolute)) {
    throw new Error(
      "Xtwork plugin host requires absolute XTWORK_PLUGIN_HOST_BIN and XTWORK_PLUGINS_DIR paths.",
    );
  }
  return { executable, pluginsDir, dataDir, disabled: process.env.XTWORK_PLUGINS_DISABLED ?? "" };
};

export const isRecord = (value: unknown): value is Record<string, unknown> =>
  typeof value === "object" && value !== null && !Array.isArray(value);

const isTool = (value: unknown): value is PluginTool =>
  isRecord(value) &&
  typeof value.name === "string" &&
  isPluginToolName(value.name) &&
  typeof value.title === "string" &&
  typeof value.description === "string" &&
  isRecord(value.inputSchema) &&
  value.inputSchema.type === "object";

export class XtworkPluginHost {
  private connection: Connection | undefined;
  private stopped = Promise.resolve();
  private nextId = 0;
  private closed = false;

  private readonly options: HostOptions;

  constructor(options: HostOptions) {
    this.options = options;
  }

  async list(signal: AbortSignal): Promise<ReadonlyArray<PluginTool>> {
    const tools = await this.request("tools.list", {}, signal);
    if (!Array.isArray(tools) || !tools.every(isTool)) {
      throw new Error("The plugin host returned an invalid tool catalog.");
    }
    return tools;
  }

  invoke(
    name: string,
    input: Schema.Json,
    context: { readonly threadId: string; readonly operationKey: string | undefined; readonly scope?: string },
    signal: AbortSignal,
    approved = false,
  ) {
    return this.request("tools.invoke", { name, input, context, approved }, signal);
  }

  callView(name: string, input: Schema.Json, signal: AbortSignal) {
    return this.request("views.call", { name, input }, signal);
  }

  async close() {
    this.closed = true;
    if (this.connection !== undefined) {
      this.disconnect(this.connection, new Error("The plugin host stopped."));
    }
    await this.stopped;
  }

  private start(): Connection {
    const { executable, pluginsDir, dataDir, disabled } = this.options;
    const child = spawn(
      executable,
      [
        "serve",
        "--plugins-dir",
        pluginsDir,
        "--data-dir",
        dataDir,
        "--disabled",
        disabled,
        "--time-zone",
        Intl.DateTimeFormat().resolvedOptions().timeZone,
      ],
      { env: {}, stdio: ["pipe", "pipe", "inherit"], windowsHide: true },
    );
    const exited = new Promise<void>((resolve) => child.once("close", () => resolve()));
    const connection = { child, pending: new Map<number, Request>(), exited };
    this.connection = connection;
    child.on("error", (error) => this.disconnect(connection, error));
    child.once("close", () => this.disconnect(connection, new Error("The plugin host exited.")));
    child.stdin.on("error", (error) => this.disconnect(connection, error));
    createInterface({ input: child.stdout, crlfDelay: Infinity }).on("line", (line) => {
      try {
        const response: unknown = JSON.parse(line);
        if (!isRecord(response) || typeof response.id !== "number") {
          throw new Error("The plugin host returned an invalid response.");
        }
        const pending = connection.pending.get(response.id);
        if (pending === undefined) return;
        if (isRecord(response.error) && typeof response.error.message === "string") {
          pending.reject(new Error(response.error.message));
        } else if ("result" in response) {
          pending.resolve(response.result);
        } else {
          throw new Error("The plugin host returned an empty response.");
        }
      } catch (error) {
        this.disconnect(connection, error instanceof Error ? error : new Error(String(error)));
      }
    });
    return connection;
  }

  private async request(method: string, params: unknown, signal: AbortSignal): Promise<unknown> {
    await this.stopped;
    if (this.closed) throw new Error("The plugin host stopped.");
    if (signal.aborted) throw new Error("The plugin call was canceled.");
    const connection = this.connection ?? this.start();
    if (connection.pending.size >= MAX_PENDING_REQUESTS) {
      throw new Error("The plugin host is busy.");
    }
    const id = ++this.nextId;
    const line = `${JSON.stringify({ id, method, params })}\n`;
    return new Promise((resolve, reject) => {
      const onAbort = () => {
        cleanup();
        reject(new Error("The plugin call was canceled."));
      };
      const cleanup = () => {
        clearTimeout(timer);
        connection.pending.delete(id);
        signal.removeEventListener("abort", onAbort);
      };
      const timer = setTimeout(
        () => this.disconnect(connection, new Error("The plugin host timed out.")),
        REQUEST_TIMEOUT_MS,
      );
      signal.addEventListener("abort", onAbort, { once: true });
      connection.pending.set(id, {
        resolve: (value) => {
          cleanup();
          resolve(value);
        },
        reject: (error) => {
          cleanup();
          reject(error);
        },
      });
      connection.child.stdin.write(line);
    });
  }

  private disconnect(connection: Connection, error: Error) {
    if (this.connection === connection) {
      this.connection = undefined;
      this.stopped = connection.exited;
    }
    connection.child.stdin.destroy();
    connection.child.kill();
    for (const pending of connection.pending.values()) pending.reject(error);
  }
}
