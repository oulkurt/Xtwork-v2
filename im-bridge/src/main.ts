/**
 * Bidirectional JSONL IPC daemon entry point for `im-bridge`.
 *
 * Spawned by T3 server using the bundled Node executable (`process.execPath`):
 * - Reads newline-delimited JSON requests from `stdin`
 * - Writes newline-delimited JSON responses and notifications to `stdout`
 * - Diagnostic logs go exclusively to `stderr` (never secrets, never `stdout`)
 * - Shuts down cleanly on `bridge.shutdown`, `stdin` close/end, `SIGTERM`, or `SIGINT`
 */

import { mkdirSync, realpathSync } from "node:fs";
import { join, resolve } from "node:path";
import { createInterface } from "node:readline";
import type { Readable, Writable } from "node:stream";
import { pathToFileURL } from "node:url";
import { ImBridge, type RpcNotification, type RpcRequest, type RpcResponse } from "./bridge.ts";
import { type ChannelMap, loadChannels } from "./channels/registry.ts";
import { defaultSecrets, type SecretStore } from "./platform/secrets.ts";
import { Store } from "./store/store.ts";

export interface DaemonOptions {
  readonly dataDir: string;
  readonly stdin?: Readable;
  readonly stdout?: Writable;
  readonly stderr?: Writable;
  readonly secrets?: SecretStore;
  readonly channels?: ChannelMap;
  readonly exitOnClose?: boolean;
  readonly agentName?: string;
}

function writeJsonLine(stream: Writable, payload: RpcResponse | RpcNotification): void {
  if (!stream.writableEnded && !stream.destroyed) {
    stream.write(`${JSON.stringify(payload)}\n`);
  }
}

export async function runDaemon(options: DaemonOptions): Promise<{
  readonly bridge: ImBridge;
  readonly done: Promise<void>;
}> {
  const dataDir = resolve(options.dataDir);
  mkdirSync(dataDir, { recursive: true });

  const stdin = options.stdin ?? process.stdin;
  const stdout = options.stdout ?? process.stdout;
  const stderr = options.stderr ?? process.stderr;

  const store = new Store(join(dataDir, "im.db"));
  const secrets = options.secrets ?? defaultSecrets(join(dataDir, "dpapi-secrets.json"));
  const channels = options.channels ?? (await loadChannels());

  const bridge = new ImBridge({
    store,
    secrets,
    channels,
    agentName: options.agentName,
    notify: (notification) => writeJsonLine(stdout, notification),
  });

  await bridge.start();

  const rl = createInterface({ input: stdin, crlfDelay: Number.POSITIVE_INFINITY });
  let closing = false;
  let resolveDone!: () => void;
  const done = new Promise<void>((r) => {
    resolveDone = r;
  });

  const gracefulStop = async () => {
    if (closing) return;
    closing = true;
    rl.close();
    await bridge.shutdown().catch((error) => {
      stderr.write(`[im-bridge] shutdown error: ${error instanceof Error ? error.message : String(error)}\n`);
    });
    resolveDone();
    if (options.exitOnClose) {
      process.exitCode = 0;
    }
  };

  let inFlight: Promise<void> = Promise.resolve();

  rl.on("line", (line) => {
    const trimmed = line.trim();
    if (!trimmed) return;
    inFlight = inFlight.then(async () => {
      let parsed: unknown;
      try {
        parsed = JSON.parse(trimmed);
      } catch {
        writeJsonLine(stdout, {
          id: 0,
          ok: false,
          error: { code: "PARSE_ERROR", message: "Malformed JSONL request line" },
        });
        return;
      }
      if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) {
        writeJsonLine(stdout, {
          id: 0,
          ok: false,
          error: { code: "INVALID_REQUEST", message: "Request must be a JSON object" },
        });
        return;
      }
      const record = parsed as Record<string, unknown>;
      const id = typeof record.id === "string" || typeof record.id === "number" ? record.id : 0;
      const method = typeof record.method === "string" ? record.method : "";
      if (!method) {
        writeJsonLine(stdout, {
          id,
          ok: false,
          error: { code: "INVALID_REQUEST", message: "Missing request method" },
        });
        return;
      }
      const req: RpcRequest = {
        id,
        method,
        ...(record.params && typeof record.params === "object" && !Array.isArray(record.params)
          ? { params: record.params as Record<string, unknown> }
          : {}),
      };
      const response = await bridge.handleRequest(req);
      writeJsonLine(stdout, response);
      if (method === "bridge.shutdown") {
        await gracefulStop();
      }
    });
  });

  rl.on("close", () => {
    void inFlight.finally(() => gracefulStop());
  });

  return { bridge, done };
}

function isMainModule(): boolean {
  const entry = process.argv[1];
  if (!entry) return false;
  let canonicalEntry: string;
  try {
    canonicalEntry = realpathSync(entry);
  } catch {
    canonicalEntry = resolve(entry);
  }
  return import.meta.url === pathToFileURL(canonicalEntry).href;
}

if (isMainModule()) {
  const dataDir = process.env.XTWORK_IM_DATA_DIR || join(process.cwd(), ".im-bridge-data");
  const agentName = process.env.XTWORK_AGENT_NAME || "Xtwork";
  const { bridge } = await runDaemon({ dataDir, agentName, exitOnClose: true });

  const onSignal = () => {
    void bridge.shutdown().finally(() => {
      process.exit(0);
    });
  };
  process.once("SIGTERM", onSignal);
  process.once("SIGINT", onSignal);
}
