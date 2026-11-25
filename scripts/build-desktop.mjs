import { execFileSync, spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import { createReadStream } from "node:fs";
import { chmodSync, cpSync, existsSync, mkdirSync, mkdtempSync, renameSync, rmSync, statSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { brand, build, lock, overlay, readJson, root, run, t3 } from "./project.mjs";

if (process.platform !== "darwin" || process.arch !== "arm64") {
  throw new Error("This desktop preview builds on Apple Silicon macOS");
}

const upload = process.argv.includes("--upload");
const skipDmg = process.argv.includes("--skip-dmg");
const publicKey = process.env.XTWORK_UPDATE_PUBLIC_KEY;
if (upload && (!publicKey || !process.env.R2_ACCOUNT_ID || !process.env.R2_BUCKET ||
    !process.env.R2_ACCESS_KEY_ID || !process.env.R2_SECRET_ACCESS_KEY)) {
  throw new Error("R2 upload needs XTWORK_UPDATE_PUBLIC_KEY, R2_ACCOUNT_ID, R2_BUCKET, R2_ACCESS_KEY_ID and R2_SECRET_ACCESS_KEY");
}
if (publicKey && !process.env.MYGO_UPDATER_PRIVATE_KEY) {
  throw new Error("Signed update artifacts need MYGO_UPDATER_PRIVATE_KEY");
}

const serverDist = join(t3, "apps", "server", "dist");
if (!existsSync(join(serverDist, "client", "index.html"))) {
  throw new Error("Build the desktop server first with node scripts/build-server.mjs");
}

const desktop = join(build, "mygo");
const resources = join(desktop, "resources");
const runtime = join(resources, "runtime");
const server = join(resources, "server");
rmSync(desktop, { recursive: true, force: true });
cpSync(join(root, "shell"), desktop, { recursive: true });
mkdirSync(resources, { recursive: true });
cpSync(join(overlay, "brand", "icons", "app.png"), join(resources, "icon.png"));
writeFileSync(join(resources, "brand.json"), `${JSON.stringify(brand, null, 2)}\n`);

// Use the exact Node distribution instead of copying the build machine's Node executable.
const nodeRelease = `node-v${lock.node}-${process.platform}-${process.arch}`;
const archive = join(build, `${nodeRelease}.tar.xz`);
if (!existsSync(archive)) {
  run("curl", ["--fail", "--silent", "--show-error", "--location", "--retry", "2", "--output", `${archive}.partial`,
    `https://nodejs.org/dist/v${lock.node}/${nodeRelease}.tar.xz`]);
}
const downloaded = existsSync(archive) ? archive : `${archive}.partial`;
const digest = createHash("sha256");
for await (const chunk of createReadStream(downloaded)) digest.update(chunk);
if (digest.digest("hex") !== lock.nodeMacArm64Sha256) {
  rmSync(downloaded);
  throw new Error("Node archive checksum differs from upstream.lock");
}
if (downloaded !== archive) renameSync(downloaded, archive);
const nodeDir = join(resources, "node");
mkdirSync(nodeDir);
run("tar", ["-xJf", archive, "-C", nodeDir, "--strip-components=1", `${nodeRelease}/bin/node`, `${nodeRelease}/LICENSE`]);

// Deploy the upstream server as a portable package, then use the branded build output.
// mygo omits hidden resource directories, including pnpm's default .pnpm store.
run("pnpm", ["--filter", "t3", "--prod", "deploy", "--legacy", "--node-linker", "hoisted", "--config.allowUnusedPatches=true", server], {
  cwd: t3,
  env: { ...process.env, CI: "true" },
});
cpSync(serverDist, join(server, "dist"), { recursive: true });
cpSync(join(t3, "LICENSE"), join(server, "LICENSE.T3-Code"));
run("go", ["mod", "download", "github.com/egoist/mygo"], { cwd: desktop });
const mygoModule = execFileSync("go", ["list", "-m", "-f", "{{.Dir}}", "github.com/egoist/mygo"], {
  cwd: desktop,
  encoding: "utf8",
}).trim();
cpSync(join(mygoModule, "LICENSE"), join(resources, "LICENSE.MyGo"));

const pi = join(runtime, "pi");
cpSync(join(root, "runtime", "pi"), pi, { recursive: true });
run("npm", ["ci", "--omit=dev", "--ignore-scripts", "--no-audit", "--no-fund"], { cwd: pi });
for (const binary of ["pi", "pi-shell"]) chmodSync(join(pi, binary), 0o755);
const imSource = join(root, "im-bridge");
const imBridge = join(resources, "im-bridge");
const hasImBridge = existsSync(imSource);
if (hasImBridge) {
  const stagingRoot = mkdtempSync(join(tmpdir(), "xtwork-im-build-"));
  try {
    const imStaging = join(stagingRoot, "im-bridge");
    mkdirSync(imStaging);
    cpSync(imSource, imStaging, {
      recursive: true,
      filter: (path) => ![".git", "node_modules", "dist", ".im-bridge-data"].includes(path.slice(path.lastIndexOf("/") + 1)),
    });
    run("npm", ["ci", "--ignore-scripts", "--no-audit", "--no-fund"], { cwd: imStaging });
    run("npm", ["run", "build"], { cwd: imStaging });
    rmSync(imBridge, { recursive: true, force: true });
    mkdirSync(imBridge, { recursive: true });
    cpSync(join(imStaging, "dist"), join(imBridge, "dist"), { recursive: true });
    for (const file of ["package.json", "package-lock.json", "THIRD_PARTY_NOTICES"]) {
      cpSync(join(imStaging, file), join(imBridge, file));
    }
    run("npm", ["ci", "--omit=dev", "--ignore-scripts", "--no-audit", "--no-fund"], { cwd: imBridge });
    if (!existsSync(join(imBridge, "dist", "main.js"))) {
      throw new Error("Build im-bridge/dist/main.js before packaging the desktop app");
    }
    if (!existsSync(join(imBridge, "THIRD_PARTY_NOTICES"))) {
      throw new Error("The IM bridge is missing THIRD_PARTY_NOTICES");
    }
    for (const forbidden of ["src", "test", "tsconfig.json", "tsconfig.build.json", ".im-bridge-data"]) {
      if (existsSync(join(imBridge, forbidden))) throw new Error(`The packaged IM bridge contains ${forbidden}`);
    }
  } finally {
    rmSync(stagingRoot, { recursive: true, force: true });
  }
}
const pluginHost = join(resources, "plugin-host");
mkdirSync(pluginHost);
run("go", ["build", "-trimpath", "-o", join(pluginHost, "xtwork-plugin-host"), "."], { cwd: join(root, "plugin-host") });
cpSync(join(root, "plugin-host", "THIRD_PARTY_NOTICES"), join(pluginHost, "THIRD_PARTY_NOTICES"));
cpSync(join(root, "plugins"), join(resources, "plugins"), { recursive: true });

const config = {
  name: brand.displayName,
  identifier: brand.identifier,
  version: brand.version,
  slug: brand.slug,
  urlSchemes: [brand.scheme],
  icon: "resources/icon.png",
  resourcesExclude: ["server/dist/**/*.map"],
  macos: { minimumSystemVersion: "13.5" },
};
if (publicKey) config.updates = { url: brand.updateUrl, publicKey, deltas: 0 };
writeFileSync(join(desktop, "mygo.json"), `${JSON.stringify(config, null, 2)}\n`);

const platform = `${process.platform}-${process.arch}`;
const dist = join(build, "desktop-dist");
const release = join(dist, platform);
const flags = ["build", "-o", dist];
if (skipDmg) flags.push("-skip-dmg");
if (process.env.XTWORK_MACOS_SIGN_IDENTITY) flags.push("-sign", process.env.XTWORK_MACOS_SIGN_IDENTITY);
run("go", ["run", `github.com/egoist/mygo/cmd/mygo@${lock.mygo}`, ...flags], { cwd: desktop });
const app = join(release, `${brand.displayName}.app`);
run("codesign", ["--verify", "--strict", app]);
const appResources = join(app, "Contents", "Resources");
run(join(appResources, "node", "bin", "node"), [join(appResources, "server", "dist", "bin.mjs"), "--version"]);
run(join(appResources, "runtime", "pi", "pi"), ["--version"]);

if (hasImBridge) {
  const packagedBridge = join(appResources, "im-bridge");
  const entry = join(packagedBridge, "dist", "main.js");
  if (!existsSync(entry) || !existsSync(join(packagedBridge, "THIRD_PARTY_NOTICES"))) {
    throw new Error("The packaged IM bridge is missing its entry point or notices");
  }
  const scratch = mkdtempSync(join(tmpdir(), "xtwork-im-smoke-"));
  try {
    const probe = spawnSync(join(appResources, "node", "bin", "node"), [entry], {
      cwd: scratch,
      env: {
        PATH: "/usr/bin:/bin",
        HOME: scratch,
        XTWORK_IM_DATA_DIR: join(scratch, "im"),
        XTWORK_COMPANION_DIR: join(scratch, "companion"),
        XTWORK_IM_PROTOCOL_VERSION: "1",
      },
      input: [
        { id: 1, method: "bridge.hello", params: { protocolVersion: 1 } },
        { id: 2, method: "bridge.shutdown", params: {} },
      ].map((frame) => JSON.stringify(frame)).join("\n") + "\n",
      encoding: "utf8",
      timeout: 10_000,
      killSignal: "SIGKILL",
    });
    if (probe.error) throw probe.error;
    const replies = probe.stdout.split("\n").filter(Boolean).map(JSON.parse);
    const hello = replies.find((reply) => reply.id === 1);
    const shutdown = replies.find((reply) => reply.id === 2);
    if (probe.status !== 0 || Number(hello?.result?.protocolVersion) !== 1 || !shutdown || shutdown.error) {
      throw new Error("The packaged IM bridge failed its bundled Node handshake or shutdown");
    }
    console.log("Packaged IM bridge hello/shutdown passed");
  } finally {
    rmSync(scratch, { recursive: true, force: true });
  }
}


if (upload) {
  const manifestName = `update-${platform}.json`;
  const archiveName = `${brand.slug}-${brand.version}-${platform}.tar.gz`;
  const manifest = readJson(join(release, manifestName));
  if (manifest.version !== brand.version || !manifest.signature ||
      manifest.url !== `${brand.updateUrl}/${archiveName}` ||
      manifest.size !== statSync(join(release, archiveName)).size) {
    throw new Error("The signed update manifest does not match the verified build");
  }
  const endpoint = `https://${process.env.R2_ACCOUNT_ID}.r2.cloudflarestorage.com`;
  const prefix = new URL(brand.updateUrl).pathname.slice(1);
  const env = {
    ...process.env,
    AWS_ACCESS_KEY_ID: process.env.R2_ACCESS_KEY_ID,
    AWS_SECRET_ACCESS_KEY: process.env.R2_SECRET_ACCESS_KEY,
    AWS_REQUEST_CHECKSUM_CALCULATION: "when_required",
  };
  function put(file, cacheControl) {
    run("aws", ["s3", "cp", join(release, file), `s3://${process.env.R2_BUCKET}/${prefix}/${file}`,
      "--region", "auto", "--endpoint-url", endpoint, "--cache-control", cacheControl, "--only-show-errors"], { env });
  }
  put(archiveName, "public, max-age=31536000, immutable");
  if (!skipDmg) put(`${brand.slug}-${brand.version}-${process.arch}.dmg`, "public, max-age=31536000, immutable");
  // The update becomes visible after the verified versioned artifacts are present.
  put(manifestName, "no-store");
}
