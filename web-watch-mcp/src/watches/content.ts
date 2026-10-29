import { createHash } from "node:crypto";
import {
  WATCH_MAX_DIFF_LINE_CHARS,
  WATCH_MAX_DIFF_LINES,
  WATCH_MAX_EXCERPT_CHARS,
} from "./model.js";

/** Linearize page text into stable, comparable lines. */
export function normalizeLines(text: string): string[] {
  return text
    .replace(/\r\n?/g, "\n")
    .split("\n")
    .map((line) => line.replace(/[ \t\f\v]+/g, " ").trim())
    .filter((line) => line.length > 0);
}

export function normalizeText(text: string): string {
  return normalizeLines(text).join("\n");
}

/** The title participates so a title-only change still produces an event. */
export function hashContent(title: string, text: string): string {
  return createHash("sha256")
    .update(`${title.trim()}\n${normalizeText(text)}`)
    .digest("hex");
}

export interface ContentDiff {
  added: string[];
  removed: string[];
  addedCount: number;
  removedCount: number;
  truncated: boolean;
}

/**
 * A prefix/suffix line diff is enough evidence for an agent to judge a page
 * change. It intentionally does not try to be a minimal edit script: the
 * changed region is preserved in order, which is easier for a model to read.
 */
export function diffLines(previous: string, next: string): ContentDiff {
  const before = normalizeLines(previous);
  const after = normalizeLines(next);

  let prefix = 0;
  while (
    prefix < before.length &&
    prefix < after.length &&
    before[prefix] === after[prefix]
  ) {
    prefix += 1;
  }

  let suffix = 0;
  while (
    suffix < before.length - prefix &&
    suffix < after.length - prefix &&
    before[before.length - 1 - suffix] === after[after.length - 1 - suffix]
  ) {
    suffix += 1;
  }

  const removedAll = before.slice(prefix, before.length - suffix);
  const addedAll = after.slice(prefix, after.length - suffix);

  const truncated =
    removedAll.length > WATCH_MAX_DIFF_LINES ||
    addedAll.length > WATCH_MAX_DIFF_LINES ||
    removedAll.some((line) => line.length > WATCH_MAX_DIFF_LINE_CHARS) ||
    addedAll.some((line) => line.length > WATCH_MAX_DIFF_LINE_CHARS);

  return {
    added: addedAll
      .slice(0, WATCH_MAX_DIFF_LINES)
      .map((line) => clipLine(line)),
    removed: removedAll
      .slice(0, WATCH_MAX_DIFF_LINES)
      .map((line) => clipLine(line)),
    addedCount: addedAll.length,
    removedCount: removedAll.length,
    truncated,
  };
}

export function makeExcerpt(text: string, maxChars = WATCH_MAX_EXCERPT_CHARS): string {
  return normalizeText(text).slice(0, maxChars);
}

function clipLine(line: string): string {
  if (line.length <= WATCH_MAX_DIFF_LINE_CHARS) {
    return line;
  }

  return `${line.slice(0, WATCH_MAX_DIFF_LINE_CHARS - 1)}…`;
}
