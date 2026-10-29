import { describe, expect, it } from "vitest";
import { ConfigError, loadConfig } from "../src/config.js";

describe("loadConfig", () => {
  it("loads stdio defaults", () => {
    const config = loadConfig("stdio", {});
    expect(config.mode).toBe("stdio");
    expect(config.http.port).toBe(8787);
    expect(config.browser.headless).toBe(false);
    expect(config.captchaPolicy).toBe("human");
    expect(config.oauth).toBeUndefined();
    expect(config.browser.maxSessions).toBe(3);
    expect(config.limits.maxStoredFilesBytes).toBe(500 * 1024 * 1024);
    expect(config.limits.maxRequestBytes).toBeGreaterThan(config.limits.maxUploadBytes * 4 / 3);
  });

  it("parses boolean and numeric environment values", () => {
    const config = loadConfig("stdio", {
      BROWSER_HEADLESS: "true",
      BROWSER_TIMEOUT_MS: "45000",
      MAX_UPLOAD_MB: "5",
    });

    expect(config.browser.headless).toBe(true);
    expect(config.browser.timeoutMs).toBe(45_000);
    expect(config.limits.maxUploadBytes).toBe(5 * 1024 * 1024);
  });

  it("requires HTTP public URL", () => {
    expect(() =>
      loadConfig("http", {
        MCP_OWNER_PASSWORD: "a-long-owner-password",
        MCP_JWT_SECRET: "x".repeat(48),
      }),
    ).toThrow(ConfigError);
  });

  it("requires an owner password in HTTP mode", () => {
    expect(() =>
      loadConfig("http", {
        MCP_PUBLIC_URL: "https://jobs.example.com",
        MCP_JWT_SECRET: "x".repeat(48),
      }),
    ).toThrow(/MCP_OWNER_PASSWORD/);
  });

  it("builds HTTP OAuth configuration", () => {
    const config = loadConfig("http", {
      MCP_PUBLIC_URL: "https://jobs.example.com",
      MCP_OWNER_PASSWORD: "a-long-owner-password",
      MCP_JWT_SECRET: "x".repeat(48),
      MCP_ALLOWED_HOSTS: "extra.example.com",
    });

    expect(config.oauth?.resourceUrl).toBe("https://jobs.example.com/mcp");
    expect(config.oauth?.allowedHosts).toContain("jobs.example.com");
    expect(config.oauth?.allowedHosts).toContain("extra.example.com");
  });

  it("rejects invalid ports", () => {
    expect(() => loadConfig("stdio", { MCP_HTTP_PORT: "0" })).toThrow(ConfigError);
    expect(() => loadConfig("stdio", { PORT: "65536" })).toThrow(ConfigError);
  });

  it("uses Render URL, host and port defaults with explicit overrides", () => {
    const env = { RENDER_EXTERNAL_URL: "https://browser.onrender.com", PORT: "10000", MCP_OWNER_PASSWORD: "owner-password-123", MCP_JWT_SECRET: "x".repeat(48) };
    const config = loadConfig("http", env);
    expect(config.http).toEqual({ host: "0.0.0.0", port: 10000 });
    expect(config.oauth?.resourceUrl).toBe("https://browser.onrender.com/mcp");
    expect(loadConfig("http", { ...env, MCP_HTTP_PORT: "9000", MCP_PUBLIC_URL: "https://custom.example.com" }).http.port).toBe(9000);
    expect(loadConfig("http", { ...env, MCP_PUBLIC_URL: "https://custom.example.com" }).oauth?.resourceUrl).toBe("https://custom.example.com/mcp");
  });

  it.each(["ftp://localhost", "https://user:secret@example.com", "https://example.com?secret=1", "https://example.com#fragment"])("rejects invalid public origin %s", (url) => {
    expect(() => loadConfig("http", { MCP_PUBLIC_URL: url, MCP_OWNER_PASSWORD: "owner-password-123", MCP_JWT_SECRET: "x".repeat(48) })).toThrow(ConfigError);
  });
});
