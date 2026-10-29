import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { loadConfig } from "../src/config.js";
import { createPaths, ensurePaths, type AppPaths } from "../src/paths.js";
import { BrowserSessions } from "../src/browser/sessions.js";
import { Logger } from "../src/logger.js";

let directory: string;
let paths: AppPaths;
let sessions: BrowserSessions;
let config: ReturnType<typeof loadConfig>;
const logger = new Logger("error", "sessions-test");
beforeEach(async () => {
  directory = await mkdtemp(join(tmpdir(), "browser-sessions-"));
  config = loadConfig("stdio", { DATA_DIR: directory, BROWSER_MAX_SESSIONS: "2" });
  paths = createPaths(config);
  await ensurePaths(paths);
  sessions = new BrowserSessions(config, paths, logger);
});
afterEach(async () => { await sessions.closeAll(); await rm(directory, { recursive: true, force: true }); });

describe("persistent browser session registry", () => {
  it("bounds sessions without launching browsers and persists IDs", async () => {
    const created = await sessions.create("Supplier work");
    expect((await sessions.list()).every((entry) => !entry.running)).toBe(true);
    await expect(sessions.create("Too many")).rejects.toThrow(/limit/);
    const reopened = new BrowserSessions(config, paths, logger);
    expect(await reopened.list()).toContainEqual({ ...created, running: false });
    expect((await (await reopened.get(created.id)).status()).sessionId).toBe(created.id);
    await reopened.closeAll();
  });

  it("rejects invalid sessions, protects default, and deletes explicit sessions", async () => {
    await expect(sessions.get("../../private")).rejects.toThrow(/Unknown/);
    await expect(sessions.delete("default")).rejects.toThrow(/cannot be deleted/);
    const created = await sessions.create("Disposable");
    await sessions.delete(created.id);
    await expect(sessions.get(created.id)).rejects.toThrow(/Unknown/);
    expect(await sessions.list()).toHaveLength(1);
  });
});
