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

test("buildBrandedMessageKeys remaps all 138 upstream T3 Code entries and updates zh.json", () => {
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
  assert.equal(pairs.length, 138);

  const brandedEn = brandTranslationCatalog(enCatalog, "小瞳 Work", pairs);
  const brandedZh = brandTranslationCatalog(zhCatalog, "小瞳 Work", pairs);

  for (const [oldKey, newKey] of pairs) {
    assert.notEqual(newKey, oldKey);
    assert.ok(Object.hasOwn(brandedEn, newKey), `Missing ${newKey} in branded en.json`);
    assert.equal(
      JSON.stringify(brandedEn[newKey]).includes("T3 Code"),
      false,
      `Found leftover T3 Code in ${newKey}`,
    );
    if (Object.hasOwn(zhCatalog, oldKey)) {
      assert.ok(Object.hasOwn(brandedZh, newKey), `Missing ${newKey} in branded zh.json`);
      assert.equal(
        JSON.stringify(brandedZh[newKey]).includes("T3 Code"),
        false,
        `Found leftover T3 Code in zh ${newKey}`,
      );
    }
  }
});

test("assertNoLeakedUserVisibleBrand rejects leaked server error strings and ignores clean bundles", () => {
  const dir = mkdtempSync(join(tmpdir(), "xtwork-brand-leak-"));
  try {
    const cleanFile = join(dir, "bundle.mjs");
    writeFileSync(cleanFile, 'export const msg = "小瞳 Work could not confirm";\n');
    assert.doesNotThrow(() => assertNoLeakedUserVisibleBrand(dir));

    writeFileSync(
      cleanFile,
      'export const msg = "T3 Code could not confirm that your answer reached the agent.";\n',
    );
    assert.throws(
      () => assertNoLeakedUserVisibleBrand(dir),
      /bundle\.mjs: T3 Code could not/,
    );
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});
