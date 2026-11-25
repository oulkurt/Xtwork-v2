// @effect-diagnostics nodeBuiltinImport:off globalTimers:off globalDate:off globalDateInEffect:off globalJsonInEffect:off effectTryWithoutCatch:off globalErrorInEffectCatch:off globalErrorInEffectFailure:off effectFnOpportunity:off deterministicKeys:off matchBooleanToIsSuccess:off
import { mkdir, readFile, rename, rm, writeFile } from "node:fs/promises";
import { randomUUID } from "node:crypto";
import { dirname, join } from "node:path";
import { scopedPath, type MemoryScope } from "./XtworkImSecurity.ts";

export function memoryScope(value: unknown): MemoryScope {
  if (value === "role" || value === "private") return value;
  if (typeof value === "string" && /^group:[a-zA-Z0-9_-]{1,160}$/u.test(value)) {
    return value as MemoryScope;
  }
  throw new Error("Unknown companion memory scope.");
}

export class XtworkImMemory {
  private readonly root: string;

  constructor(root: string) {
    this.root = root;
  }

  private async path(scope: MemoryScope, note?: string) {
    if (note !== undefined && (scope === "role" || !/^[\p{L}\p{N}_-]{1,100}\.md$/u.test(note))) {
      throw new Error("Expected a Markdown note name.");
    }
    const folder = scope === "role" ? "" : scope === "private" ? "private" : join("groups", scope.slice(6));
    await mkdir(this.root, { recursive: true, mode: 0o700 });
    return scopedPath(this.root, join(folder, note === undefined ? scope === "role" ? "ROLE.md" : "MEMORY.md" : join("notes", note)));
  }

  async read(scope: MemoryScope, note?: string) {
    const path = await this.path(scope, note);
    try {
      return (await readFile(path, "utf8")).slice(0, 65_536);
    } catch (error) {
      if (error instanceof Error && "code" in error && error.code === "ENOENT") return "";
      throw error;
    }
  }

  async write(scope: MemoryScope, text: string, note?: string) {
    if (Buffer.byteLength(text) > 65_536) throw new Error("Companion files must fit within 64 KiB.");
    const path = await this.path(scope, note);
    await mkdir(dirname(path), { recursive: true, mode: 0o700 });
    const temp = join(dirname(path), `.${randomUUID()}.tmp`);
    try {
      await writeFile(temp, text, { flag: "wx", mode: 0o600 });
      await rename(temp, path);
    } finally {
      await rm(temp, { force: true });
    }
  }
}
