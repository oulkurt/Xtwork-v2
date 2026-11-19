import { spawnSync } from "node:child_process";
import { readFileSync } from "node:fs";
import { join } from "node:path";

export const root = join(import.meta.dirname, "..");
export const build = join(root, ".build");
export const source = join(build, "upstream");
export const t3 = join(build, "t3code");
export const overlay = join(root, "overlay");
export const lock = readJson(join(root, "upstream.lock"));
export const brand = readJson(join(overlay, "brand", "brand.json"));

export function readJson(path) {
  return JSON.parse(readFileSync(path, "utf8"));
}

export function run(program, args, options = {}) {
  const result = spawnSync(program, args, { cwd: root, stdio: "inherit", ...options });
  if (result.error) throw result.error;
  if (result.status !== 0) {
    throw new Error(`${program} ${args.join(" ")} exited with ${result.signal ?? result.status}`);
  }
}

export function gitOutput(cwd, ...args) {
  const result = spawnSync("git", ["-C", cwd, ...args], { encoding: "utf8" });
  return result.status === 0 ? result.stdout.trim() : null;
}
