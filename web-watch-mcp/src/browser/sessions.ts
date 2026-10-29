import { AsyncLocalStorage } from "node:async_hooks";
import { randomUUID } from "node:crypto";
import { mkdir, rm } from "node:fs/promises";
import { join } from "node:path";
import { z } from "zod";
import type { AppConfig } from "../config.js";
import type { Logger } from "../logger.js";
import type { AppPaths } from "../paths.js";
import { JsonFile } from "../storage/json-file.js";
import { BrowserManager } from "./browser-manager.js";

const sessionSchema = z.object({ id: z.string().regex(/^(default|[0-9a-f-]{36})$/), name: z.string().min(1).max(100), createdAt: z.string() });
export type BrowserSession = z.infer<typeof sessionSchema>;

export class BrowserTargetError extends Error {
  constructor(message: string) { super(message); this.name = "BrowserTargetError"; }
}

export class BrowserSessions {
  private readonly index;
  private readonly browsers = new Map<string, BrowserManager>();
  private readonly scope = new AsyncLocalStorage<BrowserManager>();

  constructor(private readonly config: AppConfig, private readonly paths: AppPaths, private readonly logger: Logger) {
    this.index = new JsonFile(paths.sessionsFile, z.object({ sessions: z.array(sessionSchema) }), () => ({ sessions: [{ id: "default", name: "Default", createdAt: new Date().toISOString() }] }));
    this.browsers.set("default", new BrowserManager(config, config.browser, paths, logger.child("default"), "default"));
  }

  current(): BrowserManager { return this.scope.getStore() ?? this.browsers.get("default")!; }

  async get(id = "default"): Promise<BrowserManager> {
    if (!(await this.index.read()).sessions.some((session) => session.id === id)) throw new BrowserTargetError(`Unknown browser session: ${id}. Call browser_sessions with action=list.`);
    let browser = this.browsers.get(id);
    if (!browser) {
      const profileDir = join(this.paths.sessionsDir, id, "profile");
      await mkdir(profileDir, { recursive: true, mode: 0o700 });
      browser = new BrowserManager(this.config, { ...this.config.browser, profileDir }, this.paths, this.logger.child(id), id);
      this.browsers.set(id, browser);
    }
    return browser;
  }

  async run<T>(target: { sessionId?: string; tabId?: string }, operation: () => Promise<T>): Promise<T> {
    const browser = target.sessionId ? await this.get(target.sessionId) : this.browsers.get("default")!;
    if (target.tabId) await browser.selectTab(target.tabId);
    return this.scope.run(browser, operation);
  }

  async list() {
    return Promise.all((await this.index.read()).sessions.map(async (session) => ({ ...session, running: (await this.browsers.get(session.id)?.status())?.running ?? false })));
  }

  async create(name: string): Promise<BrowserSession> {
    const session = sessionSchema.parse({ id: randomUUID(), name: name.trim(), createdAt: new Date().toISOString() });
    await this.index.update((current) => {
      if (current.sessions.length >= this.config.browser.maxSessions) throw new Error(`Session limit (${this.config.browser.maxSessions}) reached. Delete an unused session first.`);
      return { sessions: [...current.sessions, session] };
    });
    return session;
  }

  async close(id: string): Promise<void> { await (await this.get(id)).close(); }

  async delete(id: string): Promise<void> {
    if (id === "default") throw new Error("The default session cannot be deleted; use browser_reset to close it");
    await this.close(id);
    await rm(join(this.paths.sessionsDir, id), { recursive: true, force: true });
    await this.index.update((current) => ({ sessions: current.sessions.filter((session) => session.id !== id) }));
    this.browsers.delete(id);
  }

  async closeAll(): Promise<void> { await Promise.all([...this.browsers.values()].map((browser) => browser.close())); }
}
