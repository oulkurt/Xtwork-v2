import { createHash } from "node:crypto";
import { readdirSync, readFileSync } from "node:fs";
import { join, relative } from "node:path";

const GT_DATA_FORMATS = ["ICU", "JSX", "STRING", null];
const SOURCE_BRAND = "T3 Code";
const USER_VISIBLE_BRAND_LEAKS = [
  "T3 Code could not",
  "The T3 Code server",
  "T3 Code restarted",
  "disabled in T3 Code settings",
  "with this T3 Code release",
  "not installed in T3 Code",
  "install Codex in T3 Code",
  "not support sign-in in T3 Code",
  "Return to T3 Code",
  "Returning to T3 Code",
  "T3 Code database at",
  "A T3 Code server already owns",
  "Stop T3 Code",
  "Created in [T3 Code]",
  "which T3 Code cannot show",
  "which T3 Code is watching",
  "T3 Code stopped watching",
  "from the previous T3 Code orchestrator",
  "is managed by the T3 Code desktop app",
  "show or restore the T3 Code window",
  "run T3 Code on it",
];

/**
 * Deterministic JSON serialization with sorted object keys matching generaltranslation's hashSource input.
 */
export function stableStringify(node) {
  if (node === undefined) return undefined;
  if (node === null) return "null";
  if (typeof node === "number") return Number.isFinite(node) ? String(node) : "null";
  if (typeof node !== "object") return JSON.stringify(node);
  if (Array.isArray(node)) {
    let out = "[";
    for (let i = 0; i < node.length; i++) {
      if (i > 0) out += ",";
      out += stableStringify(node[i]) || "null";
    }
    return `${out}]`;
  }
  const keys = Object.keys(node).sort();
  let out = "";
  for (const key of keys) {
    const value = stableStringify(node[key]);
    if (!value) continue;
    if (out) out += ",";
    out += `${JSON.stringify(key)}:${value}`;
  }
  return `{${out}}`;
}

/**
 * Matches generaltranslation's variable leaf check so variable placeholders keep only `{ k, v? }`.
 */
export function isVariable(obj) {
  if (!obj || typeof obj !== "object" || typeof obj.k !== "string") return false;
  const keys = Object.keys(obj);
  if (keys.length === 1) return true;
  if (keys.length === 2) return typeof obj.i === "number" || typeof obj.v === "string";
  if (keys.length === 3) return typeof obj.v === "string" && typeof obj.i === "number";
  return false;
}

function sanitizeChild(child) {
  if (child && typeof child === "object") {
    const newChild = {};
    if ("c" in child && child.c) newChild.c = sanitizeJsxChildren(child.c);
    if ("d" in child) {
      const gt = child?.d;
      if (gt?.b) {
        newChild.b = Object.fromEntries(
          Object.entries(gt.b).map(([key, value]) => [key, sanitizeJsxChildren(value)]),
        );
      }
      if (gt?.t) newChild.t = gt.t;
    }
    if (isVariable(child)) {
      return { k: child.k, ...(child.v ? { v: child.v } : {}) };
    }
    return newChild;
  }
  return child;
}

/**
 * Normalizes GT JSX AST entries into the canonical shape hashed by generaltranslation.
 */
export function sanitizeJsxChildren(childrenAsObjects) {
  return Array.isArray(childrenAsObjects)
    ? childrenAsObjects.map(sanitizeChild)
    : sanitizeChild(childrenAsObjects);
}

/**
 * Computes the 16-char SHA-256 translation key for a GT source entry and dataFormat.
 */
export function gtHashSource({ source, dataFormat }) {
  const sanitizedSource = dataFormat === "JSX" ? sanitizeJsxChildren(source) : source;
  const serialized =
    stableStringify({
      source: sanitizedSource,
      ...(dataFormat ? { dataFormat } : {}),
    }) ?? "";
  return createHash("sha256").update(serialized).digest("hex").slice(0, 16);
}

/**
 * Recursively replaces the upstream brand name across string, array, and object translation values.
 */
export function replaceBrandDeep(node, brandName) {
  if (typeof node === "string") return node.replaceAll(SOURCE_BRAND, () => brandName);
  if (Array.isArray(node)) return node.map((item) => replaceBrandDeep(item, brandName));
  if (node && typeof node === "object") {
    return Object.fromEntries(
      Object.entries(node).map(([key, value]) => [key, replaceBrandDeep(value, brandName)]),
    );
  }
  return node;
}

/**
 * Resolves `[oldKey, newKey]` pairs for every entry in `en.json` whose source contains `T3 Code`.
 */
export function buildBrandedMessageKeys(enCatalog, brandName) {
  const brandedMessageKeys = [];
  for (const [key, entrySource] of Object.entries(enCatalog)) {
    if (!JSON.stringify(entrySource).includes(SOURCE_BRAND)) continue;
    const matchedFormat = GT_DATA_FORMATS.find(
      (candidate) =>
        gtHashSource({ source: entrySource, dataFormat: candidate ?? undefined }) === key,
    );
    if (matchedFormat === undefined) {
      throw new Error(`Unmatched GT translation key containing "${SOURCE_BRAND}": ${key}`);
    }
    const brandedSource = replaceBrandDeep(entrySource, brandName);
    const newKey = gtHashSource({
      source: brandedSource,
      dataFormat: matchedFormat ?? undefined,
    });
    if (newKey !== key) brandedMessageKeys.push([key, newKey]);
  }
  return brandedMessageKeys;
}

/**
 * Applies deep brand replacement and remaps hashed translation keys inside one GT locale catalog.
 */
export function brandTranslationCatalog(catalog, brandName, brandedMessageKeys) {
  const nextCatalog = replaceBrandDeep(catalog, brandName);
  for (const [oldKey, newKey] of brandedMessageKeys) {
    if (Object.hasOwn(nextCatalog, oldKey) && !Object.hasOwn(nextCatalog, newKey)) {
      nextCatalog[newKey] = nextCatalog[oldKey];
    }
  }
  return nextCatalog;
}

/**
 * Verifies no user-visible upstream brand error or UI strings remain in built dist artifacts.
 */
export function assertNoLeakedUserVisibleBrand(distDir) {
  const leaks = [];
  for (const entry of readdirSync(distDir, { recursive: true, withFileTypes: true })) {
    if (!entry.isFile() || !/\.(?:mjs|js|html|css)$/.test(entry.name) || entry.name.endsWith(".map")) {
      continue;
    }
    const filePath = join(entry.parentPath, entry.name);
    const content = readFileSync(filePath, "utf8");
    for (const phrase of USER_VISIBLE_BRAND_LEAKS) {
      if (content.includes(phrase)) {
        leaks.push(`${relative(distDir, filePath)}: ${phrase}`);
      }
    }
  }
  if (leaks.length > 0) {
    throw new Error(`Found user-visible upstream brand strings in ${distDir}:\n${leaks.join("\n")}`);
  }
}
