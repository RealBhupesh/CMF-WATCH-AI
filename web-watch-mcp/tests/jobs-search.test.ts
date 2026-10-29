import { describe, expect, it } from "vitest";
import { buildJobSearchUrl } from "../src/jobs/search.js";

describe("job searches", () => {
  it.each(["google", "bing", "indeed", "linkedin"] as const)("encodes role, location and remote preference for %s", (source) => {
    const url = new URL(buildJobSearchUrl({ source, query: "C++ & repair", location: "Pune, India", remote: true }));
    expect(url.protocol).toBe("https:");
    expect([...url.searchParams.values()].join(" ")).toContain("C++ & repair");
    expect([...url.searchParams.values()].join(" ")).toContain("Pune, India");
    expect([...url.searchParams.values()].join(" ")).toContain("remote");
    if (source === "linkedin") expect(url.searchParams.get("f_WT")).toBe("2");
  });
  it("rejects whitespace-only queries", () => {
    expect(() => buildJobSearchUrl({ query: "  " })).toThrow(/empty/);
  });
});
