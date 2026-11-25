import { existsSync, readdirSync, readFileSync, statSync } from "node:fs";
import { dirname, isAbsolute, join, relative, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const EXTERNAL_SCHEMES = [
  "http://",
  "https://",
  "mailto:",
  "t3-thread://",
  "t3-context://",
];

/**
 * GitHub-compatible Markdown heading slugifier supporting Unicode/CJK headings
 * and snake_case identifiers (e.g. `# API_KEY` -> `api_key`).
 */
export function slugifyHeading(rawHeading) {
  let text = rawHeading.trim();
  // Remove trailing ATX closing hashes (e.g. "## Title ##")
  text = text.replace(/\s+#+\s*$/, "");
  // Unwrap Markdown links [label](url) -> label
  text = text.replace(/\[([^\]]+)\]\([^)]*\)/g, "$1");
  // Remove inline code backticks and emphasis markers (*, ~), plus edge-only underscore emphasis
  // while preserving literal underscores inside identifiers such as API_KEY.
  text = text.replace(/[`*~]/g, "");
  text = text.replace(/(^|[\s(（【「『])_{1,2}(?=\S)(.+?)(?<=\S)_{1,2}(?=$|[\s.,;:!?)\]）】」』])/g, "$1$2");
  text = text.toLowerCase();

  let out = "";
  for (const ch of text) {
    if (ch === " ") {
      out += "-";
    } else if (ch === "-" || ch === "_" || /[\p{L}\p{M}\p{N}]/u.test(ch)) {
      out += ch;
    }
  }
  return out;
}

/**
 * Splits Markdown into lines while tracking fenced code blocks (` ``` ` / ` ~~~ `).
 */
function scanMarkdownLines(content) {
  const lines = content.split(/\r?\n/);
  const result = [];
  let fence = null;

  for (let idx = 0; idx < lines.length; idx += 1) {
    const line = lines[idx];
    const fenceMatch = line.match(/^\s*(`{3,}|~{3,})/);
    if (fenceMatch) {
      const marker = fenceMatch[1];
      if (!fence) {
        fence = { char: marker[0], len: marker.length };
      } else if (marker[0] === fence.char && marker.length >= fence.len) {
        fence = null;
      }
      result.push({ lineNumber: idx + 1, line, inCodeFence: true });
      continue;
    }
    result.push({ lineNumber: idx + 1, line, inCodeFence: fence !== null });
  }
  return result;
}

/**
 * Masks inline code spans (including multi-backtick spans containing inner backticks,
 * e.g. `` `` `code` `` ``) with spaces so link/path parsing ignores code literals.
 */
export function stripInlineCode(line) {
  let out = "";
  let i = 0;
  while (i < line.length) {
    if (line[i] === "`") {
      let tickLen = 0;
      while (i + tickLen < line.length && line[i + tickLen] === "`") {
        tickLen += 1;
      }
      const delimiter = "`".repeat(tickLen);
      let searchFrom = i + tickLen;
      let closeIdx = -1;
      while (searchFrom < line.length) {
        const idx = line.indexOf(delimiter, searchFrom);
        if (idx === -1) break;
        const beforeOk = idx === 0 || line[idx - 1] !== "`";
        const afterOk = idx + tickLen >= line.length || line[idx + tickLen] !== "`";
        if (beforeOk && afterOk) {
          closeIdx = idx;
          break;
        }
        searchFrom = idx + 1;
      }
      if (closeIdx !== -1) {
        out += " ".repeat(closeIdx + tickLen - i);
        i = closeIdx + tickLen;
        continue;
      }
      out += delimiter;
      i += tickLen;
      continue;
    }
    out += line[i];
    i += 1;
  }
  return out;
}

/**
 * Extracts GitHub-style heading anchors with collision-safe deduplication:
 * e.g. `# 计划`, `# 计划-1`, `# 计划` -> `计划`, `计划-1`, `计划-2`.
 */
export function extractHeadingSlugs(content) {
  const slugs = new Set();
  for (const { line, inCodeFence } of scanMarkdownLines(content)) {
    if (inCodeFence) continue;
    const match = line.match(/^#{1,6}\s+(.+)$/);
    if (!match) continue;
    const base = slugifyHeading(match[1]);
    if (!base) continue;
    let candidate = base;
    let suffix = 1;
    while (slugs.has(candidate)) {
      candidate = `${base}-${suffix}`;
      suffix += 1;
    }
    slugs.add(candidate);
  }
  return slugs;
}

function collectMarkdownFiles(rootDir) {
  const files = [];
  for (const entry of readdirSync(rootDir, { withFileTypes: true })) {
    if (entry.isFile() && entry.name.endsWith(".md")) {
      files.push(join(rootDir, entry.name));
    }
  }
  const docDir = join(rootDir, "doc");
  if (existsSync(docDir)) {
    const walk = (dir) => {
      for (const entry of readdirSync(dir, { withFileTypes: true })) {
        const full = join(dir, entry.name);
        if (entry.isDirectory()) {
          walk(full);
        } else if (entry.isFile() && entry.name.endsWith(".md")) {
          files.push(full);
        }
      }
    };
    walk(docDir);
  }
  return files.sort();
}

function cleanHrefTarget(rawTarget) {
  let target = rawTarget.trim();
  if (target.startsWith("<")) {
    const endAngle = target.indexOf(">");
    if (endAngle !== -1) {
      return target.slice(1, endAngle).trim();
    }
  }
  // Strip optional link title ("title" or 'title') separated by whitespace
  const titleIdx = target.search(/\s+(?:"[^"]*"|'[^']*')\s*$/);
  if (titleIdx !== -1) {
    target = target.slice(0, titleIdx).trim();
  }
  return target;
}

/**
 * Parses inline links `[label](href)`, image links `![alt](href)` (including nested
 * linked images such as `[![alt](img.svg)](page.md)` and balanced parentheses in paths),
 * and reference link definitions `[id]: href`.
 */
export function extractLinks(line) {
  const clean = stripInlineCode(line);
  const links = [];

  // Reference-style link definition: `  [id]: target "optional title"`
  const refDef = clean.match(/^\s{0,3}\[([^\]]+)\]:\s*(\S+(?:\s+(?:"[^"]*"|'[^']*'))?)\s*$/);
  if (refDef) {
    links.push({
      label: refDef[1],
      refId: refDef[1].trim().toLowerCase(),
      href: cleanHrefTarget(refDef[2]),
      isImage: false,
      kind: "ref-def",
    });
    return links;
  }

  const scanSegment = (segment) => {
    let i = 0;
    while (i < segment.length) {
      const isImage = segment[i] === "!" && segment[i + 1] === "[";
      const bracketStart = isImage ? i + 1 : segment[i] === "[" ? i : -1;
      if (bracketStart === -1) {
        i += 1;
        continue;
      }

      // Find matching closing `]` (respecting nested brackets for images inside links)
      let depth = 0;
      let closeBracket = -1;
      for (let j = bracketStart; j < segment.length; j += 1) {
        if (segment[j] === "\\") {
          j += 1;
          continue;
        }
        if (segment[j] === "[") depth += 1;
        else if (segment[j] === "]") {
          depth -= 1;
          if (depth === 0) {
            closeBracket = j;
            break;
          }
        }
      }
      if (closeBracket === -1 || segment[closeBracket + 1] !== "(") {
        i = bracketStart + 1;
        continue;
      }

      // Find matching closing `)` supporting balanced parentheses inside target URLs
      let parenDepth = 0;
      let closeParen = -1;
      for (let j = closeBracket + 1; j < segment.length; j += 1) {
        if (segment[j] === "\\") {
          j += 1;
          continue;
        }
        if (segment[j] === "(") parenDepth += 1;
        else if (segment[j] === ")") {
          parenDepth -= 1;
          if (parenDepth === 0) {
            closeParen = j;
            break;
          }
        }
      }
      if (closeParen === -1) {
        i = closeBracket + 1;
        continue;
      }

      const label = segment.slice(bracketStart + 1, closeBracket);
      const rawTarget = segment.slice(closeBracket + 2, closeParen);
      links.push({
        label,
        href: cleanHrefTarget(rawTarget),
        isImage,
        kind: isImage ? "image" : "inline",
      });
      // Recursively scan inner label so linked images like `[![alt](img.svg)](doc.md)` check both targets.
      if (!isImage && label.includes("](")) {
        scanSegment(label);
      }
      i = closeParen + 1;
    }
  };

  scanSegment(clean);
  return links;
}

/**
 * Extracts normalized reference-link labels actually referenced in body prose
 * (`[text][id]`, `[id][]`, or shortcut `[id]` outside definitions/inline links).
 */
function extractUsedRefIds(line) {
  const clean = stripInlineCode(line);
  if (/^\s{0,3}\[[^\]]+\]:\s*\S/.test(clean)) return [];
  const used = [];
  // Full/collapsed reference links: `[label][id]` or `[id][]`
  for (const m of clean.matchAll(/(?<!!)\[([^\]]+)\]\[([^\]]*)\]/g)) {
    const refId = (m[2] || m[1]).trim().toLowerCase();
    if (refId) used.push(refId);
  }
  // Shortcut reference links: `[id]` not followed by `(` or `[`
  const withoutFull = clean.replace(/(?<!!)\[[^\]]+\]\[[^\]]*\]/g, "");
  for (const m of withoutFull.matchAll(/(?<!!)\[([^\]]+)\](?!\s*[(\[])/g)) {
    const refId = m[1].trim().toLowerCase();
    if (refId) used.push(refId);
  }
  return used;
}

function safeDecodeUri(value) {
  try {
    return decodeURIComponent(value);
  } catch {
    return value;
  }
}

function isWithinRoot(absRoot, targetPath) {
  const relPath = relative(absRoot, targetPath);
  return relPath === "" || (!relPath.startsWith("..") && !isAbsolute(relPath));
}

export function checkRepositoryDocs(rootDir) {
  const absRoot = resolve(rootDir);
  const errors = [];
  const mdFiles = collectMarkdownFiles(absRoot);
  const contentByPath = new Map();
  const headingsByPath = new Map();
  const linksByFileRel = new Map();

  for (const filePath of mdFiles) {
    const content = readFileSync(filePath, "utf8");
    contentByPath.set(filePath, content);
    headingsByPath.set(filePath, extractHeadingSlugs(content));
  }

  const hasAgentsMd = existsSync(join(absRoot, "AGENTS.md"));
  const rel = (p) => relative(absRoot, p).replaceAll("\\", "/");

  for (const filePath of mdFiles) {
    const fileRel = rel(filePath);
    const content = contentByPath.get(filePath);
    const lines = scanMarkdownLines(content);
    const renderedTargets = new Set();
    const refDefTargets = new Map();
    const usedRefIds = new Set();

    for (const { lineNumber, line, inCodeFence } of lines) {
      if (inCodeFence) continue;

      for (const refId of extractUsedRefIds(line)) {
        usedRefIds.add(refId);
      }

      // 1. Reject machine-local file:/// or OS home directory absolute paths
      const hasLocalPath =
        /\bfile:\/\/\//i.test(line) ||
        /\/Users\/[A-Za-z0-9._-]+\//.test(line) ||
        /[A-Za-z]:\\Users\\/i.test(line);
      if (hasLocalPath) {
        errors.push({
          rule: "no-local-path",
          file: fileRel,
          line: lineNumber,
          message: "Contains machine-local absolute path or file:/// URI",
        });
      }

      // 2. Reject references to untracked AGENTS.md if it does not exist in repo root
      if (!hasAgentsMd && /\bAGENTS\.md\b/.test(line)) {
        errors.push({
          rule: "missing-repo-file-ref",
          file: fileRel,
          line: lineNumber,
          message: "References AGENTS.md which is not present in the repository root",
        });
      }

      // 3. Validate links, repo-boundary containment, heading anchors, and ADR-NNN label parity
      for (const { label, href, kind, refId } of extractLinks(line)) {
        if (!href || EXTERNAL_SCHEMES.some((scheme) => href.startsWith(scheme))) {
          continue;
        }
        if (href.startsWith("file:")) {
          if (!hasLocalPath) {
            errors.push({
              rule: "no-local-path",
              file: fileRel,
              line: lineNumber,
              message: `Forbidden file: link (${href})`,
            });
          }
          continue;
        }

        const hashIdx = href.indexOf("#");
        const rawPathPart = hashIdx === -1 ? href : href.slice(0, hashIdx);
        const rawFragment = hashIdx === -1 ? "" : href.slice(hashIdx + 1);
        const decodedPathPart = safeDecodeUri(rawPathPart);
        const targetPath = decodedPathPart ? resolve(dirname(filePath), decodedPathPart) : filePath;

        if (!isWithinRoot(absRoot, targetPath)) {
          errors.push({
            rule: "repo-escape",
            file: fileRel,
            line: lineNumber,
            message: `Relative link "${href}" escapes repository root`,
          });
          continue;
        }

        if (!existsSync(targetPath)) {
          errors.push({
            rule: "broken-link",
            file: fileRel,
            line: lineNumber,
            message: `Broken relative link "${href}" (resolved: ${rel(targetPath)})`,
          });
          continue;
        }

        const targetRel = rel(targetPath);
        if (kind === "inline") {
          renderedTargets.add(targetRel);
        } else if (kind === "ref-def" && refId) {
          refDefTargets.set(refId, targetRel);
        }

        if (rawFragment && statSync(targetPath).isFile() && targetPath.endsWith(".md")) {
          const targetHeadings =
            headingsByPath.get(targetPath) ?? extractHeadingSlugs(readFileSync(targetPath, "utf8"));
          const decodedFragment = safeDecodeUri(rawFragment);
          if (!targetHeadings.has(decodedFragment) && !targetHeadings.has(decodedFragment.toLowerCase())) {
            errors.push({
              rule: "broken-anchor",
              file: fileRel,
              line: lineNumber,
              message: `Broken heading anchor "${href}" in ${targetRel}`,
            });
          }
        }

        // ADR label vs filename consistency (e.g. [ADR-013](../decisions/012-foo.md))
        const labelAdrMatch = label.match(/\bADR-(\d{3})\b/);
        const targetAdrMatch = targetRel.match(/^doc\/decisions\/(\d{3})-[^/]+\.md$/);
        if (labelAdrMatch && targetAdrMatch && labelAdrMatch[1] !== targetAdrMatch[1]) {
          errors.push({
            rule: "adr-id-mismatch",
            file: fileRel,
            line: lineNumber,
            message: `Link label cites ADR-${labelAdrMatch[1]} but targets ${targetRel}`,
          });
        }
      }
    }

    for (const [refId, targetRel] of refDefTargets.entries()) {
      if (usedRefIds.has(refId)) {
        renderedTargets.add(targetRel);
      }
    }
    linksByFileRel.set(fileRel, renderedTargets);
  }

  // 4. ADR inventory checks: heading, status, and actual link indexing in DECISIONS.md
  const decisionsDir = join(absRoot, "doc", "decisions");
  const decisionsIndexLinks = linksByFileRel.get("DECISIONS.md") ?? new Set();

  if (existsSync(decisionsDir)) {
    const adrFiles = readdirSync(decisionsDir)
      .filter((name) => /^\d{3}-.+\.md$/.test(name))
      .sort();

    for (const fileName of adrFiles) {
      const id = fileName.slice(0, 3);
      const fullPath = join(decisionsDir, fileName);
      const content = contentByPath.get(fullPath) ?? readFileSync(fullPath, "utf8");
      const fileRel = rel(fullPath);

      if (!new RegExp(`^#\\s+ADR-${id}\\b`, "m").test(content)) {
        errors.push({
          rule: "adr-heading-mismatch",
          file: fileRel,
          line: 1,
          message: `Expected H1 heading starting with "# ADR-${id}"`,
        });
      }

      if (!/^-\s+\*\*Status\*\*\s+\S+/m.test(content)) {
        errors.push({
          rule: "adr-missing-status",
          file: fileRel,
          line: 1,
          message: 'Missing "- **Status**" metadata line',
        });
      }

      if (!decisionsIndexLinks.has(fileRel)) {
        errors.push({
          rule: "adr-unindexed",
          file: "DECISIONS.md",
          line: 1,
          message: `ADR ${fileRel} is not linked from DECISIONS.md`,
        });
      }
    }
  }

  // 5. As-Built patch inventory parity between overlay/patches/*.patch and section 4 table of doc/plan/02-上游与改造层.md
  const patchesDir = join(absRoot, "overlay", "patches");
  const overlayDocPath = join(absRoot, "doc", "plan", "02-上游与改造层.md");
  if (existsSync(patchesDir) && existsSync(overlayDocPath)) {
    const actualPatches = readdirSync(patchesDir)
      .filter((name) => name.endsWith(".patch"))
      .sort();
    const overlayDoc = contentByPath.get(overlayDocPath) ?? readFileSync(overlayDocPath, "utf8");
    const overlayDocRel = rel(overlayDocPath);

    const overlayLines = scanMarkdownLines(overlayDoc);
    let inSection4 = false;
    const actualSet = new Set(actualPatches);
    const tablePatches = new Set();

    for (const { lineNumber, line, inCodeFence } of overlayLines) {
      if (inCodeFence) continue;
      if (/^##\s+4\./.test(line)) {
        inSection4 = true;
        continue;
      }
      if (inSection4 && /^##\s+/.test(line)) {
        break;
      }
      if (!inSection4 || !line.trimStart().startsWith("|")) continue;
      for (const match of line.matchAll(/`([0-9]+-[a-z0-9-]+\.patch)`/g)) {
        const patchName = match[1];
        tablePatches.add(patchName);
        if (!actualSet.has(patchName)) {
          errors.push({
            rule: "phantom-patch",
            file: overlayDocRel,
            line: lineNumber,
            message: `Documented patch "${patchName}" does not exist in overlay/patches/`,
          });
        }
      }
    }

    for (const patchName of actualPatches) {
      if (!tablePatches.has(patchName)) {
        errors.push({
          rule: "undocumented-patch",
          file: overlayDocRel,
          line: 1,
          message: `Patch overlay/patches/${patchName} is missing from section 4 patch table in ${overlayDocRel}`,
        });
      }
    }
  }

  return {
    checkedFiles: mdFiles.map(rel),
    errors,
  };
}

const isMain = process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url);
if (isMain) {
  const repoRoot = resolve(dirname(fileURLToPath(import.meta.url)), "..");
  const { checkedFiles, errors } = checkRepositoryDocs(repoRoot);
  if (errors.length > 0) {
    console.error(`Doc check failed with ${errors.length} error(s) across ${checkedFiles.length} files:\n`);
    for (const err of errors) {
      console.error(`- [${err.rule}] ${err.file}:${err.line} — ${err.message}`);
    }
    process.exitCode = 1;
  } else {
    console.log(`Doc check passed (${checkedFiles.length} Markdown files verified, 0 errors).`);
  }
}
