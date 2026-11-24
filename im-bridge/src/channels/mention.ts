/**
 * `@name` in what an agent writes, and the people it stands for.
 *
 * Adapted from earayu/Mingle (MIT, commit 006220e880d2134665ce2745ab6233f52c8eabe9),
 * src/channels/mention.ts.
 *
 * The core finds which written names are people in the chat; adapters find the same spots again
 * with only those people and write each one the platform's way. Both sides use `mentionSpots`, so
 * they always agree on where the mentions are.
 */

/** One person the text @-mentions. */
export interface Mention {
  /** Their platform user ID on this bot. */
  readonly id: string;
  /** The name as written after `@`. */
  readonly name: string;
}

export interface MentionSpot {
  /** Index of the `@`. */
  readonly start: number;
  /** Index just after the name. */
  readonly end: number;
  readonly mention: Mention;
}

const WORD = /[A-Za-z0-9_]/;
/** Before an `@` that is part of an address or a handle, not a mention: `a@b.com`, `x@y`. */
const ADDRESS = /[A-Za-z0-9._%+-]/;

/**
 * Where `@name` stands for one of `mentions`. The longest name wins, so `@Bob Smith` is not `@Bob`.
 * Case does not matter. A name ending in a letter or digit must not run on into another one
 * (`@Bob` is not in `@Bobby`); CJK names may be followed by anything, as people write them.
 * Code spans and fenced blocks are left alone, and so are e-mail addresses.
 */
export function mentionSpots(text: string, mentions: readonly Mention[]): MentionSpot[] {
  if (!mentions.length || !text.includes("@")) return [];
  const sorted = [...mentions].filter((m) => m.name).sort((a, b) => b.name.length - a.name.length);
  const code = codeRanges(text);
  const spots: MentionSpot[] = [];
  let i = text.indexOf("@");
  while (i !== -1) {
    const inCode = code.some(([from, to]) => i >= from && i < to);
    const prev = i > 0 ? (text[i - 1] as string) : "";
    let next = i + 1;
    if (!inCode && !ADDRESS.test(prev)) {
      for (const mention of sorted) {
        const end = i + 1 + mention.name.length;
        if (text.slice(i + 1, end).toLowerCase() !== mention.name.toLowerCase()) continue;
        const last = mention.name.at(-1) as string;
        if (WORD.test(last) && WORD.test(text[end] ?? "")) continue;
        spots.push({ start: i, end, mention });
        next = end;
        break;
      }
    }
    i = text.indexOf("@", next);
  }
  return spots;
}

/** The text with each mention written by `render`; everything else as it was. */
export function renderMentions(
  text: string,
  mentions: readonly Mention[] | undefined,
  render: (mention: Mention) => string,
): string {
  const spots = mentionSpots(text, mentions ?? []);
  if (!spots.length) return text;
  let out = "";
  let at = 0;
  for (const spot of spots) {
    out += text.slice(at, spot.start) + render(spot.mention);
    at = spot.end;
  }
  return out + text.slice(at);
}

/** `[from, to)` of fenced code blocks and inline code spans. */
export function codeRanges(text: string): [number, number][] {
  const ranges: [number, number][] = [];
  for (const m of text.matchAll(/```[\s\S]*?(?:```|$)|`[^`\n]*`/g)) ranges.push([m.index, m.index + m[0].length]);
  return ranges;
}
