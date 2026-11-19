import { createHash } from "node:crypto";
import { execFileSync } from "node:child_process";
import { access, cp, mkdir, mkdtemp, readFile, rename, rm } from "node:fs/promises";
import { basename, join, resolve } from "node:path";

const destinationArg = process.argv[2];
if (!destinationArg) throw new Error("Usage: node runtime/install-dim.mjs <output-directory>");

const destination = resolve(destinationArg);
const lock = JSON.parse(await readFile(new URL("dim.lock", import.meta.url), "utf8"));
const platform = `${process.platform === "win32" ? "windows" : process.platform}-${process.arch}`;
const asset = lock.assets[platform];
if (!asset) throw new Error(`No pinned Dim release for ${platform}`);

const executable = process.platform === "win32" ? "dimcode.exe" : "dimcode";
const cache = resolve(import.meta.dirname, "../.build/downloads");
const archivePath = join(cache, basename(new URL(asset.url).pathname));
await mkdir(cache, { recursive: true });
const download = await mkdtemp(join(cache, "dim-"));

async function matchesLock(path) {
  try {
    const bytes = await readFile(path);
    return createHash("sha256").update(bytes).digest("hex") === asset.sha256;
  } catch (error) {
    if (error.code === "ENOENT") return false;
    throw error;
  }
}

try {
  if (!await matchesLock(archivePath)) {
    const temporary = join(download, "archive");
    execFileSync("curl", ["--fail", "--silent", "--show-error", "--location", "--retry", "2",
      "--connect-timeout", "15", "--max-time", "90", "--output", temporary, asset.url], { stdio: "inherit" });
    if (!await matchesLock(temporary)) throw new Error(`Dim ${lock.tag} failed SHA-256 verification`);
    await rename(temporary, archivePath);
  }

  execFileSync("tar", ["-xf", archivePath, "-C", download], { stdio: "inherit" });
  const releaseDir = join(download, `dimcode-${platform}`);
  await access(join(releaseDir, "bin", executable));
  await mkdir(destination, { recursive: true });
  await cp(join(releaseDir, "bin", executable), join(destination, executable));
  for (const notice of ["LICENSE", "NOTICE", "licenses"]) {
    await cp(join(releaseDir, notice), join(destination, notice), { recursive: true });
  }
  console.log(`Installed Dim ${lock.tag} at ${join(destination, executable)}`);
} finally {
  await rm(download, { recursive: true, force: true });
}
