import { cpSync } from "node:fs";
import { join } from "node:path";
import { brand, lock, root, run, t3 } from "./project.mjs";

if (process.versions.node !== lock.node) throw new Error(`Use Node ${lock.node} to build T3`);

const env = Object.fromEntries(
  Object.entries(process.env).filter(([key]) => !/^(?:T3CODE_|VITE_|EXPO_PUBLIC_)/.test(key)),
);
env.APP_VERSION = brand.version;
env.T3CODE_DESKTOP_UPDATE_REPOSITORY = brand.repository;
env.CI = "true";

run(process.execPath, [join(root, "scripts", "prepare.mjs")]);
run("pnpm", ["--filter", "t3...", "--filter", "@t3tools/web...", "install", "--frozen-lockfile"], { cwd: t3, env });
run("pnpm", ["--filter", "@t3tools/web", "run", "build"], { cwd: t3, env });
run("pnpm", ["--filter", "t3", "run", "build:bundle"], { cwd: t3, env });
cpSync(join(t3, "apps", "web", "dist"), join(t3, "apps", "server", "dist", "client"), { recursive: true });
