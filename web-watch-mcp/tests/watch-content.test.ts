import { describe, expect, it } from "vitest";
import {
  diffLines,
  hashContent,
  makeExcerpt,
  normalizeLines,
  normalizeText,
} from "../src/watches/content.js";

describe("watch content", () => {
  it("normalizes line endings, whitespace, and empty lines", () => {
    expect(normalizeLines("  Line one \r\n\tLine   two\r\n\r\nLine three  ")).toEqual([
      "Line one",
      "Line two",
      "Line three",
    ]);
    expect(normalizeText("A\n\n B  C ")).toBe("A\nB C");
  });

  it("hashes the title and normalized text together", () => {
    expect(hashContent("Jobs", "A\nB")).toBe(hashContent("Jobs", "A\r\n\r\nB"));
    expect(hashContent("Jobs", "A\nB")).not.toBe(hashContent("Careers", "A\nB"));
    expect(hashContent("Jobs", "A\nB")).not.toBe(hashContent("Jobs", "A\nC"));
  });

  it("reports an unchanged page with an empty diff", () => {
    expect(diffLines("A\nB\nC", "A\nB\nC")).toEqual({
      added: [],
      removed: [],
      addedCount: 0,
      removedCount: 0,
      truncated: false,
    });
  });

  it("reports inserted and removed lines in order", () => {
    expect(diffLines("A\nB\nD", "A\nC\nD")).toEqual({
      added: ["C"],
      removed: ["B"],
      addedCount: 1,
      removedCount: 1,
      truncated: false,
    });
    expect(diffLines("A\nB", "A\nB\nC")).toEqual({
      added: ["C"],
      removed: [],
      addedCount: 1,
      removedCount: 0,
      truncated: false,
    });
    expect(diffLines("A\nB\nC", "A\nC")).toEqual({
      added: [],
      removed: ["B"],
      addedCount: 0,
      removedCount: 1,
      truncated: false,
    });
  });

  it("limits displayed diff lines and clips very long lines", () => {
    const added = Array.from({ length: 250 }, (_, index) => `Line ${index}`);
    const diff = diffLines("", added.join("\n"));
    expect(diff.addedCount).toBe(250);
    expect(diff.added).toHaveLength(200);
    expect(diff.truncated).toBe(true);

    const long = "x".repeat(600);
    const clipped = diffLines("", long);
    expect(clipped.added[0]).toHaveLength(500);
    expect(clipped.added[0].endsWith("…")).toBe(true);
    expect(clipped.truncated).toBe(true);
  });

  it("builds a bounded current excerpt", () => {
    const excerpt = makeExcerpt("A\n\nB   C", 3);
    expect(excerpt).toBe("A\nB");
    expect(makeExcerpt("A\nB", 100)).toBe("A\nB");
  });
});
