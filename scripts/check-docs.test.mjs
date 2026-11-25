import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";
import {
  checkRepositoryDocs,
  extractHeadingSlugs,
  extractLinks,
  slugifyHeading,
  stripInlineCode,
} from "./check-docs.mjs";

const REPO_ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "..");

function makeFixture(files) {
  const root = mkdtempSync(join(tmpdir(), "xtwork-check-docs-"));
  for (const [relPath, content] of Object.entries(files)) {
    const full = join(root, relPath);
    mkdirSync(dirname(full), { recursive: true });
    writeFileSync(full, content, "utf8");
  }
  return root;
}

test("slugifyHeading matches GitHub CJK, punctuation, and snake_case rules", () => {
  assert.equal(slugifyHeading("2. 接口、协议保真与进程边界"), "2-接口协议保真与进程边界");
  assert.equal(
    slugifyHeading("3. 受开关控制的入口清单【已定 Q-02，见 PR #19/#20 与 ADR-012】"),
    "3-受开关控制的入口清单已定-q-02见-pr-1920-与-adr-012",
  );
  assert.equal(slugifyHeading("4. 实建补丁台账（As-Built）"), "4-实建补丁台账as-built");
  assert.equal(slugifyHeading("M1 · 通用任务桌面版"), "m1--通用任务桌面版");
  assert.equal(slugifyHeading("API_KEY"), "api_key");
  assert.equal(slugifyHeading("Use _italic_ and `snake_case`"), "use-italic-and-snake_case");
});

test("extractHeadingSlugs avoids collisions for pre-suffixed headings and ignores fenced code", () => {
  const md = [
    "# 标题",
    "```markdown",
    "## 假标题",
    "```",
    "## 计划",
    "## 计划-1",
    "## 计划",
  ].join("\n");
  const slugs = extractHeadingSlugs(md);
  assert.equal(slugs.has("假标题"), false);
  assert.equal(slugs.has("计划"), true);
  assert.equal(slugs.has("计划-1"), true);
  assert.equal(slugs.has("计划-2"), true);
});

test("extractLinks handles balanced parentheses, images, nested linked images, reference definitions, and multi-backtick spans", () => {
  assert.deepEqual(extractLinks("See [doc](foo_(bar).md#sec) and ![img](pic%201.png)"), [
    { label: "doc", href: "foo_(bar).md#sec", isImage: false, kind: "inline" },
    { label: "img", href: "pic%201.png", isImage: true, kind: "image" },
  ]);
  assert.deepEqual(extractLinks("[![status](missing.svg)](README.md)"), [
    { label: "![status](missing.svg)", href: "README.md", isImage: false, kind: "inline" },
    { label: "status", href: "missing.svg", isImage: true, kind: "image" },
  ]);
  assert.deepEqual(extractLinks("[ref-id]: doc/plan/01.md#top \"Title\""), [
    { label: "ref-id", refId: "ref-id", href: "doc/plan/01.md#top", isImage: false, kind: "ref-def" },
  ]);
  assert.equal(
    extractLinks("Keep `` `[fake](missing.md)` `` ignored while keeping [real](ok.md)").length,
    1,
  );
  assert.equal(stripInlineCode("a `` `b` `` c").includes("b"), false);
});

test("checkRepositoryDocs catches broken links/anchors, linked images, repo escapes, ADR mismatches, unused ref-def index, and patch table drift", () => {
  const root = makeFixture({
    "README.md": [
      "[ok](doc/README.md#总览)",
      "[space-ok](doc/my%20note.md#api_key)",
      "[escape](../../../etc/hosts)",
      "![missing-img](doc/missing.png)",
      "[![badge](doc/missing-badge.svg)](README.md)",
      "[ref-broken]: doc/missing-ref.md",
    ].join("\n"),
    "DECISIONS.md": [
      "See [ADR-003][adr-three] in body.",
      "",
      "[unused-ref]: doc/decisions/001-alpha.md",
      "[adr-three]: doc/decisions/003-used-ref.md",
    ].join("\n"),
    "doc/my note.md": "# API_KEY\n",
    "doc/README.md": [
      "# 总览",
      "- [bad link](missing.md)",
      "- [bad anchor](plan/02-上游与改造层.md#不存在的标题)",
      "- [ADR-002](decisions/001-alpha.md)",
      "- see [local](file:///Users/alice/secret)",
      "- see `AGENTS.md` for rules",
      "```md",
      "[ignored-in-fence](does-not-exist.md#nope)",
      "```",
    ].join("\n"),
    "doc/decisions/001-alpha.md": [
      "# ADR-001 · Alpha",
      "- **Status** Accepted",
    ].join("\n"),
    "doc/decisions/002-unindexed.md": [
      "# ADR-099 · Wrong heading",
    ].join("\n"),
    "doc/decisions/003-used-ref.md": [
      "# ADR-003 · Referenced via used ref-def",
      "- **Status** Accepted",
    ].join("\n"),
    "doc/plan/02-上游与改造层.md": [
      "# 02 上游",
      "## 3. 代码仓库布局",
      "Mention `02-only-outside-table.patch` outside section 4 table must NOT satisfy table coverage.",
      "## 4. 实建补丁台账（As-Built）",
      "| `01-existing.patch` | ok |",
      "| `99-phantom.patch` | gone |",
      "```",
      "| `03-only-in-fence.patch` | fake |",
      "```",
      "## 5. 同步流程",
    ].join("\n"),
    "overlay/patches/01-existing.patch": "diff",
    "overlay/patches/02-only-outside-table.patch": "diff",
    "overlay/patches/03-only-in-fence.patch": "diff",
  });

  try {
    const { errors } = checkRepositoryDocs(root);
    const rules = new Set(errors.map((e) => e.rule));
    assert.ok(rules.has("broken-link"), `expected broken-link in ${JSON.stringify(errors)}`);
    assert.ok(rules.has("broken-anchor"), `expected broken-anchor in ${JSON.stringify(errors)}`);
    assert.ok(rules.has("repo-escape"), `expected repo-escape in ${JSON.stringify(errors)}`);
    assert.ok(rules.has("adr-id-mismatch"), `expected adr-id-mismatch in ${JSON.stringify(errors)}`);
    assert.ok(rules.has("no-local-path"), `expected no-local-path in ${JSON.stringify(errors)}`);
    assert.ok(rules.has("missing-repo-file-ref"), `expected missing-repo-file-ref in ${JSON.stringify(errors)}`);
    assert.ok(rules.has("adr-heading-mismatch"), `expected adr-heading-mismatch in ${JSON.stringify(errors)}`);
    assert.ok(rules.has("adr-missing-status"), `expected adr-missing-status in ${JSON.stringify(errors)}`);
    assert.ok(rules.has("adr-unindexed"), `expected adr-unindexed in ${JSON.stringify(errors)}`);
    assert.ok(rules.has("phantom-patch"), `expected phantom-patch in ${JSON.stringify(errors)}`);

    const unindexedMessages = errors.filter((e) => e.rule === "adr-unindexed").map((e) => e.message);
    assert.ok(
      unindexedMessages.some((m) => m.includes("001-alpha.md")),
      "unused [ref]: definition in DECISIONS.md must NOT satisfy ADR indexing",
    );
    assert.equal(
      unindexedMessages.some((m) => m.includes("003-used-ref.md")),
      false,
      "used reference link in DECISIONS.md must satisfy ADR indexing",
    );

    const undocMessages = errors.filter((e) => e.rule === "undocumented-patch").map((e) => e.message);
    assert.ok(
      undocMessages.some((m) => m.includes("02-only-outside-table.patch")),
      "patch mentioned outside section 4 table must still fail",
    );
    assert.ok(
      undocMessages.some((m) => m.includes("03-only-in-fence.patch")),
      "patch mentioned inside code fence must still fail",
    );

    const brokenMessages = errors.filter((e) => e.rule === "broken-link").map((e) => e.message);
    assert.ok(brokenMessages.some((m) => m.includes("missing.png")), "missing image link must fail");
    assert.ok(brokenMessages.some((m) => m.includes("missing-badge.svg")), "missing image inside linked badge must fail");
    assert.ok(brokenMessages.some((m) => m.includes("missing-ref.md")), "missing reference def must fail");
    assert.equal(
      errors.some((e) => e.message.includes("my%20note.md")),
      false,
      "valid URI-encoded filename with space and snake_case anchor must pass",
    );
    assert.equal(
      errors.some((e) => e.message.includes("does-not-exist.md")),
      false,
      "fenced code links must be ignored",
    );
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("current repository passes checkRepositoryDocs with zero errors", () => {
  const { checkedFiles, errors } = checkRepositoryDocs(REPO_ROOT);
  assert.ok(checkedFiles.length >= 30, `expected >=30 docs, got ${checkedFiles.length}`);
  assert.deepEqual(errors, []);
});
