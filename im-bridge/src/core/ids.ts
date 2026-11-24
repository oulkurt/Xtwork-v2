/**
 * Short human/model-readable IDs (no ambiguous 0/o/1/l/i characters).
 *
 * Adapted from earayu/Mingle (MIT, commit 006220e880d2134665ce2745ab6233f52c8eabe9),
 * src/core/ids.ts.
 */

import { randomBytes } from "node:crypto";

const ALPHABET = "23456789abcdefghjkmnpqrstuvwxyz";

export function shortId(prefix: string, length = 5): string {
  const bytes = randomBytes(length);
  let out = prefix;
  for (const byte of bytes) out += ALPHABET[byte % ALPHABET.length];
  return out;
}

export function slugify(name: string): string {
  const ascii = name
    .normalize("NFKD")
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "");
  return ascii || shortId("chat-", 4);
}
