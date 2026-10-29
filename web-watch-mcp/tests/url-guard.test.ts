import { describe, expect, it } from "vitest";
import { assertSafeUrl, isPrivateAddress, UnsafeUrlError } from "../src/security/url-guard.js";

async function rejects(url: string): Promise<void> {
  await expect(assertSafeUrl(url, { resolveDns: false })).rejects.toBeInstanceOf(UnsafeUrlError);
}

describe("assertSafeUrl", () => {
  it("allows public HTTP(S) URLs", async () => {
    await expect(assertSafeUrl("https://example.com/jobs", { resolveDns: false })).resolves.toBeInstanceOf(URL);
    await expect(assertSafeUrl("http://8.8.8.8/", { resolveDns: false })).resolves.toBeInstanceOf(URL);
    await expect(assertSafeUrl("http://172.32.0.1/", { resolveDns: false })).resolves.toBeInstanceOf(URL);
  });

  it("blocks private and local targets", async () => {
    await rejects("http://localhost:8787/");
    await rejects("http://127.0.0.1/");
    await rejects("http://10.1.2.3/");
    await rejects("http://172.16.0.1/");
    await rejects("http://192.168.1.1/");
    await rejects("http://169.254.169.254/latest/meta-data");
    await rejects("http://0.0.0.0/");
    await rejects("http://[::1]/");
    await rejects("http://[fd00::1]/");
    await rejects("http://[::ffff:127.0.0.1]/");
    await rejects("http://service.internal/");
  });

  it("blocks non-HTTP protocols and embedded credentials", async () => {
    await rejects("file:///etc/passwd");
    await rejects("ftp://example.com/file");
    await rejects("https://user:pass@example.com/");
  });

  it("classifies private addresses", () => {
    expect(isPrivateAddress("10.0.0.1")).toBe(true);
    expect(isPrivateAddress("8.8.8.8")).toBe(false);
    expect(isPrivateAddress("::1")).toBe(true);
    expect(isPrivateAddress("2606:4700:4700::1111")).toBe(false);
  });
});
