import { createHash } from "node:crypto";
import { execFileSync } from "node:child_process";
import { access, cp, mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { basename, join, resolve } from "node:path";

const destinationArg = process.argv[2];
if (!destinationArg) throw new Error("Usage: node runtime/install-dim.mjs <output-directory>");

const destination = resolve(destinationArg);
const lock = JSON.parse(await readFile(new URL("dim.lock", import.meta.url), "utf8"));
const platform = `${process.platform === "win32" ? "windows" : process.platform}-${process.arch}`;
const asset = lock.assets[platform];
if (!asset) throw new Error(`No pinned Dim release for ${platform}`);

const executable = process.platform === "win32" ? "dimcode.exe" : "dimcode";
const download = await mkdtemp(join(tmpdir(), "xtwork-dim-"));
try {
  const archiveName = basename(new URL(asset.url).pathname);
  const archivePath = join(download, archiveName);
  const response = await fetch(asset.url);
  if (!response.ok) throw new Error(`Dim ${lock.tag} download returned HTTP ${response.status}`);
  const bytes = new Uint8Array(await response.arrayBuffer());
  const sha256 = createHash("sha256").update(bytes).digest("hex");
  if (sha256 !== asset.sha256) throw new Error(`Dim ${lock.tag} failed SHA-256 verification`);
  await writeFile(archivePath, bytes);

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
