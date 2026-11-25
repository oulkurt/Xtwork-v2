import assert from "node:assert/strict";
import { mkdtempSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, it } from "node:test";
import {
  checkMemoryLimit,
  companionPaths,
  ensureCompanionLayout,
  evaluateCompanionWrite,
  loadCompanionContext,
  MEMORY_SOFT_LIMIT_BYTES,
  sanitizeChatKey,
} from "../src/core/companion.ts";

describe("tiered companion memory directory and cross-scope write policy", () => {
  it("creates tiered layout, enforces 64 KB soft limit, and isolates private memory from groups", () => {
    const dir = mkdtempSync(join(tmpdir(), "im-bridge-companion-"));
    try {
      const paths = ensureCompanionLayout(dir, "feishu_grp_1");
      writeFileSync(paths.roleFile, "# Role\nHelpful assistant.\n");
      writeFileSync(paths.privateMemoryFile, "Owner private secret memo");
      writeFileSync(join(paths.privateNotesDir, "taxes.md"), "private tax note");
      writeFileSync(paths.groupMemoryFile!, "Group sprint goal");
      writeFileSync(join(paths.groupNotesDir!, "standup.md"), "group standup");

      // Private scope sees ROLE + private
      const priv = loadCompanionContext(dir, { scope: "private" });
      assert.equal(priv.role, "# Role\nHelpful assistant.\n");
      assert.equal(priv.privateMemory, "Owner private secret memo");
      assert.deepEqual(priv.privateNotes, ["taxes.md"]);
      assert.equal(priv.groupMemory, null);

      // Group scope sees ROLE + group ONLY (never private by default!)
      const grp = loadCompanionContext(dir, { scope: "group", chatKey: "feishu_grp_1" });
      assert.equal(grp.role, "# Role\nHelpful assistant.\n");
      assert.equal(grp.groupMemory, "Group sprint goal");
      assert.deepEqual(grp.groupNotes, ["standup.md"]);
      assert.equal(grp.privateMemory, null);
      assert.deepEqual(grp.privateNotes, []);

      // Explicit opt-in allows private in group
      const grpOptIn = loadCompanionContext(dir, {
        scope: "group",
        chatKey: "feishu_grp_1",
        allowPrivateInGroup: true,
      });
      assert.equal(grpOptIn.privateMemory, "Owner private secret memo");

      // 64 KB soft limit check
      assert.equal(checkMemoryLimit(paths.privateMemoryFile).exceeded, false);
      writeFileSync(paths.privateMemoryFile, "x".repeat(MEMORY_SOFT_LIMIT_BYTES + 1));
      const over = checkMemoryLimit(paths.privateMemoryFile);
      assert.equal(over.exceeded, true);
      assert.equal(over.bytes, MEMORY_SOFT_LIMIT_BYTES + 1);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it("rejects unsafe chatKey traversal segments", () => {
    assert.throws(() => sanitizeChatKey(""));
    assert.throws(() => sanitizeChatKey(".."));
    assert.throws(() => sanitizeChatKey("../private"));
    assert.throws(() => sanitizeChatKey("a/b"));
    assert.throws(() => sanitizeChatKey("a\\b"));
  });

  it("enforces ADR-011 L3 cross-scope write protection including tidy and symlink escapes", () => {
    const dir = mkdtempSync(join(tmpdir(), "im-bridge-companion-policy-"));
    const outside = mkdtempSync(join(tmpdir(), "im-bridge-outside-"));
    try {
      const g1 = ensureCompanionLayout(dir, "grp_1");
      const g2 = ensureCompanionLayout(dir, "grp_2");

      // Same-group write is allowed
      assert.equal(
        evaluateCompanionWrite({
          companionDir: dir,
          sourceScope: { kind: "group", chatKey: "grp_1" },
          targetPath: g1.groupMemoryFile!,
        }).decision,
        "allow",
      );

      // Group writing ROLE.md, private/MEMORY.md, private/notes, or another group requires owner approval (even via tidy!)
      for (const targetPath of [
        g1.roleFile,
        g1.privateMemoryFile,
        join(g1.privateNotesDir, "inject.md"),
        g2.groupMemoryFile!,
        join(g1.groupDir!, "..", "..", "private", "MEMORY.md"),
      ]) {
        const res = evaluateCompanionWrite({
          companionDir: dir,
          sourceScope: { kind: "group", chatKey: "grp_1" },
          targetPath,
          viaTidy: true,
        });
        assert.equal(res.decision, "require_owner_approval", `expected owner approval for ${targetPath}`);
      }

      // Symlink inside grp_1 pointing into private/ must STILL be caught as cross-scope!
      const evilLink = join(g1.groupNotesDir!, "link-to-private.md");
      symlinkSync(g1.privateMemoryFile, evilLink);
      assert.equal(
        evaluateCompanionWrite({
          companionDir: dir,
          sourceScope: { kind: "group", chatKey: "grp_1" },
          targetPath: evilLink,
        }).decision,
        "require_owner_approval",
      );

      // Symlink pointing outside companionDir must be denied!
      const outsideLink = join(g1.groupNotesDir!, "escape.md");
      symlinkSync(join(outside, "pwn.md"), outsideLink);
      assert.equal(
        evaluateCompanionWrite({
          companionDir: dir,
          sourceScope: { kind: "group", chatKey: "grp_1" },
          targetPath: outsideLink,
        }).decision,
        "deny",
      );

      // owner_dm can write private/ and ROLE.md, but writing group memory requires owner approval
      const p = companionPaths(dir, "grp_1");
      assert.equal(
        evaluateCompanionWrite({ companionDir: dir, sourceScope: { kind: "owner_dm" }, targetPath: p.privateMemoryFile }).decision,
        "allow",
      );
      assert.equal(
        evaluateCompanionWrite({ companionDir: dir, sourceScope: { kind: "owner_dm" }, targetPath: p.roleFile }).decision,
        "allow",
      );
      assert.equal(
        evaluateCompanionWrite({ companionDir: dir, sourceScope: { kind: "owner_dm" }, targetPath: p.groupMemoryFile! }).decision,
        "require_owner_approval",
      );
    } finally {
      rmSync(dir, { recursive: true, force: true });
      rmSync(outside, { recursive: true, force: true });
    }
  });
});
