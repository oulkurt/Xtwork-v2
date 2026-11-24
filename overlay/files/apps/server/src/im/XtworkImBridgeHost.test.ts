// @effect-diagnostics nodeBuiltinImport:off globalTimers:off globalDate:off
import { access, mkdtemp, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vite-plus/test";
import { XtworkImBridgeHost } from "./XtworkImBridgeHost.ts";

describe("XtworkImBridgeHost", () => {
  it("uses bundled Node JSONL handshake and graceful shutdown", async () => {
    const root = await mkdtemp(join(tmpdir(), "xtwork-im-bridge-"));
    const entry = join(root, "bridge.mjs");
    await writeFile(entry, [
      'import { createInterface } from "node:readline";',
      'const input = createInterface({ input: process.stdin });',
      'input.on("line", (line) => {',
      '  const request = JSON.parse(line);',
      '  if (request.method === "bridge.hello") process.stdout.write(JSON.stringify({ id: request.id, result: { protocolVersion: 1 } }) + String.fromCharCode(10));',
      '  else if (request.method === "bridge.status") process.stdout.write(JSON.stringify({ id: request.id, result: { state: "idle" } }) + String.fromCharCode(10));',
      '  else if (request.method === "bridge.shutdown") { process.stdout.write(JSON.stringify({ id: request.id, result: {} }) + String.fromCharCode(10)); process.exit(0); }',
      '});',
    ].join(String.fromCharCode(10)));
    const host = new XtworkImBridgeHost({ entry, dataDir: join(root, "im"), companionDir: join(root, "companion") }, () => undefined);
    host.start();
    for (let attempt = 0; attempt < 30 && !host.available; attempt += 1) {
      await new Promise((resolve) => setTimeout(resolve, 10));
    }
    expect(host.available).toBe(true);
    await expect(host.request("bridge.status")).resolves.toEqual({ state: "idle" });
    await host.close();
    expect(host.available).toBe(false);
  });

  it("runs the compiled IM bridge through every management RPC and exits cleanly", async () => {
    const root = await mkdtemp(join(tmpdir(), "xtwork-im-live-"));
    const entry = join(dirname(fileURLToPath(import.meta.url)), "../../../../../../im-bridge/dist/main.js");
    await access(entry);
    const host = new XtworkImBridgeHost({
      entry,
      dataDir: join(root, "im"),
      companionDir: join(root, "companion"),
    }, () => undefined);
    try {
      host.start();
      for (let attempt = 0; attempt < 100 && !host.available; attempt += 1) {
        await new Promise((resolve) => setTimeout(resolve, 20));
      }
      expect(host.available).toBe(true);
      await expect(host.request("bridge.hello", { protocolVersion: 1 })).resolves.toMatchObject({ protocolVersion: 1 });
      await expect(host.request("bridge.status")).resolves.toMatchObject({ lifecycle: "idle" });
      await expect(host.request("connections.list")).resolves.toEqual({ connections: [] });
      await expect(host.request("access.list")).resolves.toMatchObject({ held: [], contacts: [], groups: [] });
      await expect(host.request("people.link", { contactIds: ["c1", "c2"] })).rejects.toThrow(/by must be explicitly/u);
      await expect(host.request("people.link", { contactIds: ["c1", "c2"], by: "agent" })).rejects.toThrow(/Contact not found/u);
    } finally {
      await host.close();
    }
    expect(host.lastExitCode).toBe(0);
  });
});
