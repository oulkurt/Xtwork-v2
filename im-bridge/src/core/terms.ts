/**
 * Search query tokenization preserving "quoted phrases".
 *
 * Adapted from earayu/Mingle (MIT, commit 006220e880d2134665ce2745ab6233f52c8eabe9),
 * src/core/terms.ts.
 */

/** The words of a search query; a "quoted phrase" stays one term. */
export function searchTerms(query: string): string[] {
  return (query.match(/"([^"]+)"|\S+/g) ?? []).map((t) => t.replace(/^"|"$/g, "").trim()).filter(Boolean);
}
