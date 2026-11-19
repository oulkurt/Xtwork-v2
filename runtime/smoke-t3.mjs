import assert from "node:assert/strict";
import { execFile, spawn } from "node:child_process";
import { once } from "node:events";
import { access, mkdir, mkdtemp, open, readFile, rm } from "node:fs/promises";
import { createServer } from "node:net";
import { join, resolve } from "node:path";
import { setTimeout as delay } from "node:timers/promises";
import { fileURLToPath } from "node:url";
import { promisify } from "node:util";

const [serverArg, dimArg, pluginHostArg] = process.argv.slice(2);
if (!serverArg || !dimArg || !pluginHostArg) {
  throw new Error(
    "Usage: node runtime/smoke-t3.mjs <T3 bin.mjs> <Dim binary> <plugin host binary>",
  );
}

// Dim's macOS Unix socket needs a short canonical path.
const scratch = await mkdtemp("/tmp/xtw-smoke-");
const dataDir = join(scratch, "data");
const project = join(scratch, "project");
const logPath = join(scratch, "server.log");
const serverEntry = resolve(serverArg);
const todoTitle = "Xtwork smoke test todo";
const env = {
  ...process.env,
  T3CODE_TELEMETRY_ENABLED: "false",
  XTWORK_DIM_BINARY: resolve(dimArg),
  XTWORK_PLUGIN_HOST_BIN: resolve(pluginHostArg),
  XTWORK_PLUGINS_DIR: fileURLToPath(new URL("../plugins/", import.meta.url)),
  XTWORK_PLUGIN_DATA_DIR: join(dataDir, "userdata", "plugins"),
  XTWORK_PLUGINS_DISABLED: "",
};

async function startServer() {
  const listener = createServer().listen(0, "127.0.0.1");
  await once(listener, "listening");
  const { port } = listener.address();
  await new Promise((resolve) => listener.close(resolve));

  const log = await open(logPath, "a", 0o600);
  const child = spawn(
    process.execPath,
    [
      serverEntry,
      "--no-browser",
      "--host",
      "127.0.0.1",
      "--port",
      String(port),
      "--base-dir",
      dataDir,
      "--auto-bootstrap-project-from-cwd",
      project,
    ],
    { env, stdio: ["ignore", log.fd, log.fd] },
  );
  const exited = once(child, "exit");
  await log.close();
  const stop = async () => {
    child.kill("SIGTERM");
    const timeout = setTimeout(() => child.kill("SIGKILL"), 20_000);
    try {
      const [code, signal] = await exited;
      // The Effect CLI reports interrupted fibers as exit status 130 on graceful termination.
      assert.ok(
        code === 0 || code === 130 || signal === "SIGTERM",
        `T3 exited with ${code ?? signal}`,
      );
    } finally {
      clearTimeout(timeout);
    }
    await assert.rejects(access(join(dataDir, "runtime", "dim", "rust", "daemon.sock")), {
      code: "ENOENT",
    });
  };

  try {
    const readyUrl = `http://127.0.0.1:${port}/.well-known/t3/environment`;
    for (let attempt = 0; attempt < 100 && child.exitCode === null; attempt++) {
      const response = await fetch(readyUrl, { signal: AbortSignal.timeout(500) }).catch(
        () => undefined,
      );
      if (response?.ok) return stop;
      await delay(200);
    }
  } catch (error) {
    await stop().catch(() => {});
    throw error;
  }
  await stop().catch(() => {});
  throw new Error(`T3 did not become ready. See ${logPath}`);
}

async function cli(command, subcommand, ...args) {
  const { stdout } = await promisify(execFile)(
    process.execPath,
    [
      serverEntry,
      command,
      subcommand,
      "--log-level",
      "error",
      "--base-dir",
      dataDir,
      "--json",
      ...args,
    ],
    { timeout: 120_000 },
  );
  return JSON.parse(stdout);
}

async function turn(prompt) {
  const result = await cli("thread", "start", "--wait", project, prompt);
  assert.equal(result.status, "completed", result.error ?? "T3 turn did not complete");
  return result;
}

let stop;
let succeeded = false;
try {
  await mkdir(project);
  stop = await startServer();
  const settings = JSON.parse(await readFile(join(dataDir, "userdata", "settings.json"), "utf8"));
  assert.deepEqual(settings.defaultModelSelection, { instanceId: "xtworkDim", model: "default" });
  assert.equal(settings.providerInstances.xtworkDim.config.source, "local");
  assert.equal(settings.providerInstances.xtworkDim.environment, undefined);

  const created = await turn(
    `Use the todo plugin to save one new todo exactly titled "${todoTitle}".`,
  );
  const { thread } = await cli("thread", "show", created.threadId);
  assert.equal(thread.providerInstanceId, "xtworkDim");
  const storagePath = join(env.XTWORK_PLUGIN_DATA_DIR, "todo", "storage.json");
  const records = JSON.parse(await readFile(storagePath, "utf8"));
  assert.equal(Object.values(records).filter((item) => item.title === todoTitle).length, 1);
  await stop();
  stop = undefined;

  stop = await startServer();
  const listed = await turn(
    "Use the todo list tool to list the saved todos. Reply with their exact titles.",
  );
  assert.ok(listed.reply.includes(todoTitle), "The new T3 session did not read the saved todo");
  await stop();
  stop = undefined;
  succeeded = true;
  console.log(
    "Default Dim created a todo through T3 MCP, read it after restart, and shut down cleanly.",
  );
} finally {
  if (stop) await stop().catch(() => {});
  if (succeeded) await rm(scratch, { recursive: true, force: true });
  else console.error(`Smoke test state retained at ${scratch}`);
}
