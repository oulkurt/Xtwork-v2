// @effect-diagnostics nodeBuiltinImport:off globalFetch:off -- The standalone gateway uses Node HTTP streams.
import { execFile } from "node:child_process";
import { randomBytes, randomUUID } from "node:crypto";
import { once } from "node:events";
import { constants } from "node:fs";
import { access, mkdir, readFile, rename, rm, writeFile } from "node:fs/promises";
import { createServer, type IncomingMessage, type ServerResponse } from "node:http";
import { join, resolve } from "node:path";
import { Readable } from "node:stream";
import { pipeline } from "node:stream/promises";
import { promisify } from "node:util";
import modelTemplate from "./model.json" with { type: "json" };

export const XTWORK_DIM_INSTANCE_ID = "xtworkDim";
const GATEWAY_TOKEN_ENV = "XTWORK_DIM_GATEWAY_TOKEN";
const MAGPIE_URL = "http://127.0.0.1:3425/v1";
const MAGPIE_MODEL = "our-free-model/hy4-flash-free";
const REQUEST_LIMIT = 16 * 1024 * 1024;

function rejectRequest(response: ServerResponse, status: number, message: string) {
  response.writeHead(status, { "content-type": "application/json" });
  response.end(JSON.stringify({ error: { message, type: "xtwork_gateway_error" } }));
}

async function completion(
  request: IncomingMessage,
  response: ServerResponse,
  gateway: { token: string; url: URL; model: string; upstreamKey: string | undefined },
) {
  if (request.method !== "POST" || request.url !== "/v1/chat/completions") {
    rejectRequest(response, 404, "Unknown model endpoint.");
    return;
  }
  if (request.headers.authorization !== `Bearer ${gateway.token}`) {
    rejectRequest(response, 401, "Invalid Xtwork model gateway token.");
    return;
  }

  const abort = new AbortController();
  response.once("close", () => abort.abort());
  const chunks: Buffer[] = [];
  let size = 0;
  try {
    // Keep the socket writable long enough to send a 413 before disposing of the iterator.
    for await (const chunk of request.iterator({ destroyOnReturn: false })) {
      size += Buffer.byteLength(chunk);
      if (size > REQUEST_LIMIT) {
        response.setHeader("connection", "close");
        rejectRequest(response, 413, "Model request is too large.");
        return;
      }
      chunks.push(chunk);
    }
  } catch {
    if (!response.destroyed) rejectRequest(response, 400, "Could not read the model request.");
    return;
  }

  let body: unknown;
  try {
    body = JSON.parse(Buffer.concat(chunks, size).toString("utf8"));
  } catch {
    rejectRequest(response, 400, "Expected a JSON model request.");
    return;
  }
  if (
    body === null ||
    typeof body !== "object" ||
    !("model" in body) ||
    body.model !== "standard"
  ) {
    rejectRequest(response, 400, "The Xtwork gateway accepts the standard model.");
    return;
  }

  try {
    const upstream = await fetch(gateway.url, {
      method: "POST",
      headers: {
        "content-type": "application/json",
        ...(gateway.upstreamKey ? { authorization: `Bearer ${gateway.upstreamKey}` } : {}),
      },
      body: JSON.stringify({ ...body, model: gateway.model }),
      redirect: "error",
      signal: abort.signal,
    });
    const headers: Record<string, string> = {};
    for (const name of ["content-type", "retry-after"]) {
      const value = upstream.headers.get(name);
      if (value !== null) headers[name] = value;
    }
    response.writeHead(upstream.status, headers);
    response.flushHeaders();
    if (upstream.body === null) response.end();
    else await pipeline(Readable.fromWeb(upstream.body), response);
  } catch {
    if (abort.signal.aborted) return;
    if (response.headersSent) response.destroy();
    else
      rejectRequest(
        response,
        502,
        "Could not reach the model service. Start Magpie or check XTWORK_MODEL_UPSTREAM_URL.",
      );
  }
}

export async function startDimRuntime(binaryPath: string, dataDir: string, env = process.env) {
  const commandPath = resolve(binaryPath);
  await access(commandPath, constants.X_OK);
  const runtimeDir = join(dataDir, "runtime");
  const dimHome = join(runtimeDir, "dim");
  const modelPath = join(runtimeDir, "model.json");
  const temporaryPath = join(runtimeDir, `model-${randomUUID()}.tmp`);
  const upstreamBase = new URL(env.XTWORK_MODEL_UPSTREAM_URL || MAGPIE_URL);
  if (
    !["http:", "https:"].includes(upstreamBase.protocol) ||
    upstreamBase.username ||
    upstreamBase.password ||
    upstreamBase.search ||
    upstreamBase.hash
  ) {
    throw new Error(
      "XTWORK_MODEL_UPSTREAM_URL must be an HTTP(S) base URL without credentials, query or fragment.",
    );
  }
  upstreamBase.pathname = `${upstreamBase.pathname.replace(/\/$/, "")}/chat/completions`;
  const gateway = {
    token: randomBytes(32).toString("hex"),
    url: upstreamBase,
    model: env.XTWORK_MODEL_UPSTREAM_MODEL || MAGPIE_MODEL,
    upstreamKey: env.XTWORK_MODEL_UPSTREAM_KEY_FILE
      ? (await readFile(env.XTWORK_MODEL_UPSTREAM_KEY_FILE, "utf8")).trim()
      : undefined,
  };

  const server = createServer((request, response) => {
    void completion(request, response, gateway);
  });
  const closeGateway = () =>
    new Promise<void>((resolve) => {
      server.close(() => resolve());
      server.closeAllConnections();
    });
  try {
    server.listen(0, "127.0.0.1");
    await once(server, "listening");
    const address = server.address();
    if (!address || typeof address === "string")
      throw new Error("Cannot bind the Xtwork model gateway.");
    const modelConfig = {
      ...modelTemplate,
      providers: modelTemplate.providers.map((provider) => ({
        ...provider,
        baseUrl: `http://127.0.0.1:${address.port}/v1`,
      })),
    };
    await mkdir(dimHome, { recursive: true, mode: 0o700 });
    await writeFile(temporaryPath, JSON.stringify(modelConfig, null, 2) + "\n", { mode: 0o600 });
    await rename(temporaryPath, modelPath);
  } catch (cause) {
    await closeGateway();
    await rm(temporaryPath, { force: true });
    throw cause;
  }

  return {
    config: {
      source: "local",
      commandPath,
      commandArgs: ["acp", "--home", dimHome, "--model-config", modelPath],
    },
    environment: [
      { name: GATEWAY_TOKEN_ENV, value: gateway.token, sensitive: true },
      { name: "DIMCODE_UPDATE_CHECK", value: "0", sensitive: false },
    ],
    async close() {
      try {
        await promisify(execFile)(commandPath, ["daemon", "stop", "--home", dimHome], {
          timeout: 8000,
        });
      } finally {
        await closeGateway();
      }
    },
  };
}
