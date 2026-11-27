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
  "T3 Code orchestration",
  "T3 Code browser",
  "T3 Code devices",
  "T3 Code interaction mode",
  "<t3_code_instructions>",
  "<t3_code_orchestration_instructions>",
  "t3_code_orchestration",
  "t3_code_runtime",
  "t3_code_tools",
  "List T3 threads",
  "Listing T3 threads",
  "Create T3 threads",
  "Update T3 thread metadata",
  "T3 对话",
  "t3-code MCP unavailable",
  "MCP tool t3-code/",
  "Used t3 code integration",
  "已使用 t3 code 集成",
  "T3 server restarted",
  "T3 Server",
  "Restart the T3 server",
  "This environment's T3 server",
  "T3 server is running as root",
  "Refusing to signal the T3 server process",
  "Remote T3 server",
  "The T3 server on this machine",
  "the T3 server's PATH",
  "the T3 server's environment",
  "on this T3 server host",
  "T3 服务器",
  "T3 desktop",
  "T3 桌面版",
  "T3 process",
  "T3 进程",
  "T3 system footprint",
  "T3 系统资源占用",
  "T3 home folder",
  "T3 主目录",
  "T3 requests zero data retention",
  "T3 会请求不保留数据",
  "known T3 operations",
  "已知的 T3 操作",
  "A T3 Code user",
  "from the T3 Code app",
  "This session runs inside T3 Code",
  "T3 Code triage context",
  "T3 Code triage playbook",
  "T3 Code's device connection",
  "T3 Code manages this command's connection",
  "Reconnect in T3 Code",
  "manages T3 Code updates.",
  'title: "T3 Code"',
  'title:"T3 Code"',
  "Explicit T3 Code data directory",
  "A T3 Code server is already running",
  "No running T3 Code server found.",
  "Run T3 Code in this terminal",
  "T3 Code background service",
  "T3 Code service",
  "T3 Code server is ready.",
  "Restart T3 Code",
  "T3's browser",
  "T3's headless browser",
  "Open T3 Code using the pairing URL.",
  "T3 could not install its headless browser",
  "T3 is installing its headless browser",
  "<displayName>T3 Code</displayName>",
  "T3 Code policy for",
  "Choose another T3 home",
  "for another T3 home",
  "for this T3 home",
  "from this T3 home",
  "owns this T3 home",
  "share this T3 home",
  "separate T3 home",
  "The T3 home is free again",
  "because the T3 home",
  "<strong>T3</strong> Code",
  "do not run T3 with sudo.",
  "signalable T3 backend descendant",
  "Start T3 to ",
  "Restart T3 to ",
  "Restart T3 and retry.",
  "The T3 runtime path cannot be used",
  '"T3 environment"',
  "Give T3 Code Full Disk Access",
  "previous T3 Code server",
  "from T3 Code.",
  "on the T3 Code server",
  "The T3 relay client",
  "T3 Code ssh-askpass",
  'agent_name_hint: "T3 Code"',
  'agent_name_hint:"T3 Code"',
  'CODEX_AGENT_NAME_HINT = "T3 Code"',
  'CODEX_AGENT_NAME_HINT="T3 Code"',
  'CODEX_CLIENT_TITLE = "T3 Code"',
  'CODEX_CLIENT_TITLE="T3 Code"',
  'PEER_LINK_CLIENT_BRAND = "T3 Code"',
  'PEER_LINK_CLIENT_BRAND="T3 Code"',
  "Needs T3 Connect",
  "需要 T3 Connect",
  "through T3 Connect",
  "Sign in to T3 Connect",
  "T3 Connect devices",
  "T3 Connect is disabled",
  "Allow T3 Connect",
  "T3 Connect authorization",
  "a running T3 Connect tunnel",
  "set up a T3 Connect tunnel",
  "T3 Connect tunnel is still",
  "its T3 Connect tunnel was removed",
  "T3 Connect tunnel log",
  "T3 Connect returned an error",
  "can't reach T3 Connect",
  "not allow T3 Connect",
  "your T3 account",
  "T3 Connect remote access",
  "with T3 Connect and run permission",
  "M33.4509 93V47.56H15.5309",
];

export function replaceBrandString(value, brandName) {
  return value
    .replaceAll(SOURCE_BRAND, () => brandName)
    .replaceAll("T3 Connect", () => `${brandName} Connect`)
    .replaceAll("your T3 account", () => `your ${brandName} account`)
    .replaceAll("T3 threads", "threads")
    .replaceAll("T3 thread", "thread")
    .replaceAll(" T3 对话", "对话")
    .replaceAll("T3 对话", "对话")
    .replaceAll("T3 Server", () => `${brandName} server`)
    .replaceAll("T3 server", () => `${brandName} server`)
    .replaceAll("T3 服务器", () => `${brandName} 服务器`)
    .replaceAll("T3 desktop", () => `${brandName} desktop`)
    .replaceAll("T3 桌面版", () => `${brandName} 桌面版`)
    .replaceAll("T3 process", () => `${brandName} process`)
    .replaceAll("T3 进程", () => `${brandName} 进程`)
    .replaceAll("T3 system footprint", () => `${brandName} system footprint`)
    .replaceAll("T3 系统资源占用", () => `${brandName} 系统资源占用`)
    .replaceAll("known T3 operations", () => `known ${brandName} operations`)
    .replaceAll("已知的 T3 操作", () => `已知的${brandName} 操作`)
    .replaceAll("T3 home folder", () => `${brandName} home folder`)
    .replaceAll("T3 主目录", () => `${brandName} 主目录`)
    .replaceAll("T3 requests zero data retention", () => `${brandName} requests zero data retention`)
    .replaceAll("T3 会请求不保留数据", () => `${brandName} 会请求不保留数据`);
}

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
  if (typeof node === "string") return replaceBrandString(node, brandName);
  if (Array.isArray(node)) return node.map((item) => replaceBrandDeep(item, brandName));
  if (node && typeof node === "object") {
    return Object.fromEntries(
      Object.entries(node).map(([key, value]) => [key, replaceBrandDeep(value, brandName)]),
    );
  }
  return node;
}

export function buildBrandedMessageKeys(enCatalog, brandName) {
  const brandedMessageKeys = [];
  for (const [key, entrySource] of Object.entries(enCatalog)) {
    const brandedSource = replaceBrandDeep(entrySource, brandName);
    if (stableStringify(brandedSource) === stableStringify(entrySource)) continue;
    const matchedFormat = GT_DATA_FORMATS.find(
      (candidate) =>
        gtHashSource({ source: entrySource, dataFormat: candidate ?? undefined }) === key,
    );
    if (matchedFormat === undefined) {
      throw new Error(`Unmatched GT translation key containing brand text: ${key}`);
    }
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
    if (
      !entry.isFile() ||
      !/\.(?:mjs|js|html|css|json)$/.test(entry.name) ||
      entry.name.endsWith(".map") ||
      /(?:OpenSourceLicenses|THIRD_PARTY|package\.json)/i.test(entry.name)
    ) {
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
