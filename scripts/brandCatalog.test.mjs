import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import {
  assertNoLeakedUserVisibleBrand,
  brandTranslationCatalog,
  buildBrandedMessageKeys,
  gtHashSource,
} from "./brandCatalog.mjs";
import { readJson, root, t3 } from "./project.mjs";

test("gtHashSource matches ICU strings, JSX strings, and JSX array/object entries", () => {
  const enCatalog = JSON.parse(
    execFileSync("git", ["-C", t3, "show", "HEAD:apps/web/src/i18n/translations/en.json"], {
      encoding: "utf8",
    }),
  );

  // ICU string entry from upstream catalog
  assert.equal(enCatalog["a11d4c010567faac"], "Restart T3 Code on this device.");
  assert.equal(
    gtHashSource({ source: enCatalog["a11d4c010567faac"], dataFormat: "ICU" }),
    "a11d4c010567faac",
  );
  // JSX entries (including arrays/objects with Branch/Var metadata)
  for (const key of ["33194f3e1b80f838", "3683040758069062", "d783af11f0615e84"]) {
    assert.ok(key in enCatalog, `Expected upstream JSX key ${key}`);
    assert.equal(gtHashSource({ source: enCatalog[key], dataFormat: "JSX" }), key);
  }
});

test("buildBrandedMessageKeys remaps all upstream T3 Code, T3 thread, and bare T3 entries and updates zh.json", () => {
  const enCatalog = JSON.parse(
    execFileSync("git", ["-C", t3, "show", "HEAD:apps/web/src/i18n/translations/en.json"], {
      encoding: "utf8",
    }),
  );
  const zhCatalog = JSON.parse(
    execFileSync("git", ["-C", t3, "show", "HEAD:apps/web/src/i18n/translations/zh.json"], {
      encoding: "utf8",
    }),
  );
  const overlayZh = readJson(join(root, ".build/t3code/apps/web/src/i18n/translations/zh.json"));
  assert.ok(overlayZh);

  const pairs = buildBrandedMessageKeys(enCatalog, "小瞳 Work");
  assert.equal(pairs.length, 282);

  const brandedEn = brandTranslationCatalog(enCatalog, "小瞳 Work", pairs);
  const brandedZh = brandTranslationCatalog(zhCatalog, "小瞳 Work", pairs);

  assert.equal(brandedEn["1b8c5c84222ed138"], "List threads");
  assert.equal(overlayZh["1b8c5c84222ed138"], "列出对话");
  assert.equal(overlayZh["55cb2eb842d7b91b"], "列出对话");
  assert.equal(overlayZh["1f9cf5bf4b81c465"].includes("已知的小瞳 Work 操作"), true);
  assert.equal(overlayZh["207267a58d3542ba"].includes("小瞳 Work 会请求不保留数据"), true);
  assert.equal(overlayZh["207267a58d3542ba"].includes("OpenRouter"), true);

  for (const [oldKey, newKey] of pairs) {
    assert.notEqual(newKey, oldKey);
    assert.ok(Object.hasOwn(brandedEn, newKey), `Missing ${newKey} in branded en.json`);
    assert.equal(
      JSON.stringify(brandedEn[newKey]).includes("T3 Code"),
      false,
      `Found leftover T3 Code in ${newKey}`,
    );
    assert.equal(
      JSON.stringify(brandedEn[newKey]).includes("T3 thread"),
      false,
      `Found leftover T3 thread in ${newKey}`,
    );
    assert.equal(
      JSON.stringify(brandedEn[newKey]).includes("T3 Connect"),
      false,
      `Found leftover T3 Connect in ${newKey}`,
    );
    if (Object.hasOwn(zhCatalog, oldKey)) {
      assert.ok(Object.hasOwn(brandedZh, newKey), `Missing ${newKey} in branded zh.json`);
      assert.equal(
        JSON.stringify(brandedZh[newKey]).includes("T3 Code"),
        false,
        `Found leftover T3 Code in zh ${newKey}`,
      );
      assert.equal(
        JSON.stringify(brandedZh[newKey]).includes("T3 对话"),
        false,
        `Found leftover T3 对话 in zh ${newKey}`,
      );
      assert.equal(
        JSON.stringify(brandedZh[newKey]).includes("T3 Connect"),
        false,
        `Found leftover T3 Connect in zh ${newKey}`,
      );
    }
  }
});

test("assertNoLeakedUserVisibleBrand rejects leaked server, prompt, SVG, and UI strings and ignores clean bundles", () => {
  const dir = mkdtempSync(join(tmpdir(), "xtwork-brand-leak-"));
  try {
    const cleanFile = join(dir, "bundle.mjs");
    writeFileSync(cleanFile, 'export const msg = "小瞳 Work could not confirm";\n');
    assert.doesNotThrow(() => assertNoLeakedUserVisibleBrand(dir));

    for (const leaked of [
      'export const msg = "T3 Code could not confirm that your answer reached the agent.";\n',
      'export const msg = "## T3 Code orchestration";\n',
      'export const msg = "<t3_code_instructions>";\n',
      'export const msg = "List T3 threads";\n',
      'export const msg = "Used t3 code integration";\n',
      'export const msg = "A T3 Code user is having a problem";\n',
      'export const msg = "This shell cannot reach T3 Code\'s device connection at 127.0.0.1:1";\n',
      'export const msg = "Example Corp manages T3 Code updates.";\n',
      'export const msg = "Explicit T3 Code data directory";\n',
      'export const msg = "Run T3 Code in this terminal, with no browser.";\n',
      'export const msg = "This host is ready for T3\'s browser.";\n',
      'export const msg = "Authentication required. Open T3 Code using the pairing URL.";\n',
      'export const msg = "T3 could not install its headless browser: failed";\n',
      'export const msg = "<displayName>T3 Code</displayName>";\n',
      'export const msg = "Choose another T3 home with --base-dir.";\n',
      'export const html = "<div class=\\"brand\\"><strong>T3</strong> Code</div>";\n',
      'export const msg = "do not run T3 with sudo.";\n',
      'export const msg = "Process 1 is not a signalable T3 backend descendant.";\n',
      'export const msg = "Start T3 to publish agent activity";\n',
      'export const msg = "Restart T3 and retry.";\n',
      'export const msg = "The T3 runtime path cannot be used";\n',
      'export const msg = "T3 environment";\n',
      'export const msg = "The T3 relay client is required";\n',
      'export const msg = "T3 Code ssh-askpass invoked without T3_SSH_AUTH_SECRET.";\n',
      'export const o = { agent_name_hint: "T3 Code" };\n',
      'const CODEX_AGENT_NAME_HINT = "T3 Code";\n',
      'const CODEX_CLIENT_TITLE = "T3 Code";\n',
      'const PEER_LINK_CLIENT_BRAND = "T3 Code";\n',
      'export const msg = "Needs T3 Connect";\n',
      'export const msg = "需要 T3 Connect";\n',
      'export const msg = "Approve and revoke devices that reach this host through T3 Connect.";\n',
      'export const msg = "Allow access through T3 Connect with your T3 account.";\n',
      'export const svg = "M33.4509 93V47.56H15.5309V37H64.3309";\n',
    ]) {
      writeFileSync(cleanFile, leaked);
      assert.throws(() => assertNoLeakedUserVisibleBrand(dir));
    }
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});
