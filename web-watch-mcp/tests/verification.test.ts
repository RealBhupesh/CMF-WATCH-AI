import type { Page } from "playwright";
import { describe, expect, it } from "vitest";
import { detectHumanVerification } from "../src/browser/verification.js";

function fakePage(input: {
  url: string;
  title: string;
  providers?: string[];
  text?: string;
}): Page {
  return {
    url: () => input.url,
    title: async () => input.title,
    frames: () => [
      {
        evaluate: async () => ({
          providers: input.providers ?? [],
          text: input.text ?? "",
        }),
      },
    ],
  } as unknown as Page;
}

describe("detectHumanVerification", () => {
  it("detects provider iframes", async () => {
    const result = await detectHumanVerification(
      fakePage({
        url: "https://example.com/apply",
        title: "Apply",
        providers: ["recaptcha"],
      }),
    );

    expect(result.detected).toBe(true);
    expect(result.providers).toContain("recaptcha");
    expect(result.policy).toBe("human");
  });

  it("detects challenge text", async () => {
    const result = await detectHumanVerification(
      fakePage({
        url: "https://example.com/apply",
        title: "Apply",
        text: "verify you are human",
      }),
    );

    expect(result.detected).toBe(true);
    expect(result.signals).toContain("verify you are human");
  });

  it("detects challenge page titles and URLs", async () => {
    const result = await detectHumanVerification(
      fakePage({
        url: "https://example.com/cdn-cgi/challenge-platform/h/b",
        title: "Just a moment...",
      }),
    );

    expect(result.detected).toBe(true);
    expect(result.providers).toContain("cloudflare-challenge");
  });

  it("returns clear on normal pages", async () => {
    const result = await detectHumanVerification(
      fakePage({ url: "https://example.com/jobs", title: "Jobs" }),
    );

    expect(result.detected).toBe(false);
    expect(result.providers).toHaveLength(0);
    expect(result.signals).toHaveLength(0);
  });
});
