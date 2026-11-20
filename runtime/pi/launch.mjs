import { fileURLToPath } from "node:url";

// T3 inherits the host environment. The bundled assistant uses its own model and MCP credentials.
const inherited = new Set([
  "HOME", "USER", "LOGNAME", "SHELL", "PATH", "TMPDIR", "LANG", "TZ",
  "PI_CODING_AGENT_DIR", "PI_CODING_AGENT_SESSION_DIR", "PI_SKIP_VERSION_CHECK", "PI_TELEMETRY",
  "XTWORK_MODEL_GATEWAY_TOKEN",
  "T3_MCP_URL", "T3_MCP_BEARER_TOKEN", "T3_PI_RUNTIME_MODE", "T3_PI_MCP_EXTENSION_PATH",
  "T3CODE_THREAD_ID",
]);
for (const name of Object.keys(process.env)) {
  if (!inherited.has(name) && !name.startsWith("LC_")) delete process.env[name];
}

const cli = new URL("./node_modules/@earendil-works/pi-coding-agent/dist/bundle/cli.js", import.meta.url);
process.argv[1] = fileURLToPath(cli);
await import(cli.href);
