/**
 * Make model output safe to write to the watch.
 *
 * The watch's accepted encoding and per-reply byte limit are TBD until M0.
 * Until they are observed, assume the strictest plausible case — ASCII-only,
 * short — because a reply that renders as mojibake is worse than a blunter
 * reply that renders.
 *
 * When M0 fills in the real limits, relax WATCH_REPLY_MAX_CHARS and ASCII_ONLY
 * rather than scattering new rules through the generator.
 */

export const WATCH_REPLY_MAX_CHARS = 40;
export const ASCII_ONLY = true;

const SMART_PUNCT: ReadonlyArray<readonly [string, string]> = [
  ['\u2018', "'"],
  ['\u2019', "'"],
  ['\u201C', '"'],
  ['\u201D', '"'],
  ['\u2013', '-'],
  ['\u2014', '-'],
  ['\u2026', '...'],
  ['\u00A0', ' '],
];

const WHITESPACE = /\s+/g;
const TRAILING_PUNCT = /[ ,;:-]+$/;

/**
 * Strip accents and drop anything still non-ASCII (emoji, CJK, Devanagari).
 *
 * NFKD splits accented characters into base + combining mark; dropping the
 * marks turns "café" into "cafe" rather than deleting the letter outright.
 */
export function foldToAscii(text: string): string {
  let out = text;
  for (const [bad, good] of SMART_PUNCT) {
    out = out.split(bad).join(good);
  }
  return out
    .normalize('NFKD')
    .replace(/\p{M}/gu, '')
    .replace(/[^\x00-\x7F]/g, '');
}

function truncate(text: string, limit: number): string {
  if (text.length <= limit) return text;

  let cut = text.slice(0, limit);
  const space = cut.lastIndexOf(' ');
  // Only honour the word boundary if it doesn't gut the reply.
  if (space >= Math.floor(limit / 2)) {
    cut = cut.slice(0, space);
  }
  return cut.replace(TRAILING_PUNCT, '');
}

/** Normalise one reply to something the watch can certainly render. */
export function sanitizeReply(text: string): string {
  let out = text.trim().replace(/^"+|"+$/g, '').trim();
  if (ASCII_ONLY) out = foldToAscii(out);
  out = out.replace(WHITESPACE, ' ').trim();
  return truncate(out, WATCH_REPLY_MAX_CHARS);
}

/**
 * Drop near-duplicates, preserving order.
 *
 * Three replies that all mean "yes" waste two of the three slots, which is the
 * entire product. Compared case- and punctuation-insensitively.
 */
export function dedupe(texts: string[]): string[] {
  const seen = new Set<string>();
  const out: string[] = [];
  for (const text of texts) {
    const key = text
      .toLowerCase()
      .replace(/[^a-z0-9 ]/g, '')
      .trim();
    if (!key || seen.has(key)) continue;
    seen.add(key);
    out.push(text);
  }
  return out;
}
