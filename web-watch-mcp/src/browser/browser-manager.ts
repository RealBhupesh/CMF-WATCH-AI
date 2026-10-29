import { readFile, stat } from "node:fs/promises";
import { join } from "node:path";
import { randomUUID } from "node:crypto";
import { chromium, type BrowserContext, type Page, type Locator } from "playwright";
import type { AppConfig, BrowserConfig } from "../config.js";
import type { Logger } from "../logger.js";
import type { AppPaths } from "../paths.js";
import { assertSafeUrl, UnsafeUrlError } from "../security/url-guard.js";
import { isSensitiveField } from "../security/fields.js";
import {
  captureSnapshot,
  resolveFrame,
  resolveLocator,
  StaleRefError,
  type PageSnapshot,
  type SnapshotOptions,
  type Target,
} from "./snapshot.js";
import {
  detectHumanVerification,
  requireNoHumanVerification,
  type VerificationResult,
} from "./verification.js";

export interface NavigateResult {
  url: string;
  status: number | null;
  snapshot: PageSnapshot;
}

export interface ActionResult {
  action: string;
  target?: string;
  snapshot: PageSnapshot;
}

export type FormField = Target & (
  | { action: "fill"; value: string }
  | { action: "select"; values: string[] }
  | { action: "check"; checked: boolean }
);

export interface ScreenshotResult {
  path: string;
  mimeType: "image/png" | "image/jpeg";
  bytes: number;
  base64?: string;
}

export interface BrowserStatus {
  sessionId: string;
  activeTabId?: string;
  running: boolean;
  headless: boolean;
  activeUrl?: string;
  title?: string;
  pageCount: number;
  profileDir: string;
}

export interface ReadPageOptions {
  url: string;
  selector?: string;
  maxTextChars?: number;
}

const READ_PAGE_MAX_TITLE_CHARS = 1_000;

export interface ReadPageResult {
  url: string;
  title: string;
  text: string;
  truncated: boolean;
  verification: VerificationResult;
}

export class ReadPageError extends Error {
  constructor(
    message: string,
    readonly kind: "http" | "selector",
    readonly status?: number,
  ) {
    super(message);
    this.name = "ReadPageError";
  }
}

export class BrowserManager {
  private context?: BrowserContext;
  private activePage?: Page;
  private launchPromise?: Promise<void>;
  private readonly tabIds = new WeakMap<Page, string>();

  constructor(
    private readonly config: AppConfig,
    private readonly browserConfig: BrowserConfig,
    private readonly paths: AppPaths,
    private readonly logger: Logger,
    readonly sessionId = "default",
  ) {}

  async ensureStarted(): Promise<BrowserContext> {
    if (this.context) {
      return this.context;
    }

    if (!this.launchPromise) {
      this.launchPromise = this.launch().catch((error) => {
        this.launchPromise = undefined;
        throw error;
      });
    }

    await this.launchPromise;
    if (!this.context) {
      throw new Error("Browser failed to start");
    }

    return this.context;
  }

  async status(): Promise<BrowserStatus> {
    const page = this.activePage && !this.activePage.isClosed() ? this.activePage : undefined;
    return {
      sessionId: this.sessionId,
      activeTabId: page ? this.tabId(page) : undefined,
      running: Boolean(this.context),
      headless: this.browserConfig.headless,
      activeUrl: page?.url(),
      title: page ? await page.title().catch(() => undefined) : undefined,
      pageCount: this.context?.pages().length ?? 0,
      profileDir: this.browserConfig.profileDir,
    };
  }

  async getPage(): Promise<Page> {
    const context = await this.ensureStarted();

    if (this.activePage && !this.activePage.isClosed()) {
      return this.activePage;
    }

    const pages = context.pages().filter((page) => !page.isClosed());
    this.activePage = pages.at(-1) ?? (await context.newPage());
    return this.activePage;
  }

  async navigate(input: string): Promise<NavigateResult> {
    const page = await this.getPage();
    const safeUrl = await assertSafeUrl(input, { resolveDns: true });

    this.logger.info("Navigating", { url: safeUrl.href });
    const response = await page.goto(safeUrl.href, {
      waitUntil: "domcontentloaded",
      timeout: this.browserConfig.timeoutMs,
    });

    await assertSafeUrl(page.url(), { resolveDns: true });
    await page.waitForTimeout(300);

    return {
      url: page.url(),
      status: response?.status() ?? null,
      snapshot: await this.snapshot(),
    };
  }

  async snapshot(options: SnapshotOptions = {}): Promise<PageSnapshot> {
    const page = await this.getPage();
    const snapshot = await captureSnapshot(page, {
      includeText: options.includeText ?? true,
      maxTextChars: options.maxTextChars ?? this.config.limits.maxTextChars,
      maxElements: options.maxElements ?? this.config.limits.maxSnapshotElements,
    });
    return { ...snapshot, sessionId: this.sessionId, tabId: this.tabId(page) };
  }

  tabId(page: Page): string {
    let id = this.tabIds.get(page);
    if (!id) { id = randomUUID(); this.tabIds.set(page, id); }
    return id;
  }

  async selectTab(id: string): Promise<void> {
    // A missing handle must never cause a launch or select a different tab.
    const page = this.context?.pages().find((candidate) => this.tabIds.get(candidate) === id && !candidate.isClosed());
    if (!page) throw new Error(`Unknown or closed tabId: ${id}. Call browser_tabs to get current IDs. Tab IDs expire after a browser restart.`);
    this.activePage = page;
    await page.bringToFront();
  }

  async click(target: Target, waitForNavigation = false): Promise<ActionResult> {
    const page = await this.getPage();
    await requireNoHumanVerification(page);

    const locator = await this.locator(page, target);
    await locator.waitFor({ state: "visible", timeout: this.browserConfig.timeoutMs });
    await locator.scrollIntoViewIfNeeded().catch(() => undefined);

    if (waitForNavigation) {
      const navigation = page
        .waitForNavigation({
          waitUntil: "domcontentloaded",
          timeout: this.browserConfig.timeoutMs,
        })
        .catch(() => undefined);
      await Promise.all([navigation, locator.click({ timeout: this.browserConfig.timeoutMs })]);
    } else {
      await locator.click({ timeout: this.browserConfig.timeoutMs });
      await page.waitForTimeout(400);
    }

    await this.ensureSafeActivePage(page);

    return {
      action: "click",
      target: describeTarget(target),
      snapshot: await this.snapshot({ includeText: false }),
    };
  }

  async type(target: Target, text: string, clear = true): Promise<ActionResult> {
    const page = await this.getPage();
    await requireNoHumanVerification(page);

    const locator = await this.locator(page, target);
    await locator.waitFor({ state: "visible", timeout: this.browserConfig.timeoutMs });
    await assertNotSensitiveField(locator);

    if (clear) {
      await locator.fill(text, { timeout: this.browserConfig.timeoutMs });
    } else {
      // Appending is explicit. Never retry a failed fill with keystrokes: it may have partially succeeded.
      await locator.focus();
      await locator.press("ControlOrMeta+End");
      await locator.pressSequentially(text, { timeout: this.browserConfig.timeoutMs });
    }

    return {
      action: "type",
      target: describeTarget(target),
      snapshot: await this.snapshot({ includeText: false }),
    };
  }

  async select(target: Target, values: string[]): Promise<ActionResult> {
    const page = await this.getPage();
    await requireNoHumanVerification(page);

    const locator = await this.locator(page, target);
    await locator.waitFor({ state: "visible", timeout: this.browserConfig.timeoutMs });
    await this.selectValues(locator, values);

    return {
      action: "select",
      target: describeTarget(target),
      snapshot: await this.snapshot({ includeText: false }),
    };
  }

  async check(target: Target, checked: boolean): Promise<ActionResult> {
    const page = await this.getPage();
    await requireNoHumanVerification(page);
    const locator = await this.locator(page, target);
    await locator.setChecked(checked, { timeout: this.browserConfig.timeoutMs });
    return { action: "check", target: describeTarget(target), snapshot: await this.snapshot({ includeText: false }) };
  }

  async fillForm(fields: FormField[]): Promise<{
    ok: boolean; completed: number; failedIndex?: number; error?: string;
    requiresHuman: boolean; snapshot: PageSnapshot;
  }> {
    if (fields.length < 1 || fields.length > 50) throw new Error("Provide between 1 and 50 form fields");
    const page = await this.getPage();
    await requireNoHumanVerification(page);
    // Resolve and inspect every field before changing any of them.
    const locators: Locator[] = [];
    for (const field of fields) {
      const locator = await this.locator(page, field);
      await locator.waitFor({ state: "visible", timeout: this.browserConfig.timeoutMs });
      await assertNotSensitiveField(locator);
      locators.push(locator);
    }
    let navigated = false;
    const onNavigation = (): void => { navigated = true; };
    page.on("framenavigated", onNavigation);
    let completed = 0;
    let error: string | undefined;
    try {
      for (const [index, field] of fields.entries()) {
        if (navigated || page !== this.activePage) throw new Error("Page changed during form fill; inspect a fresh snapshot before continuing");
        await requireNoHumanVerification(page);
        const locator = locators[index];
        if (await locator.count() !== 1) throw new Error("Form field changed during fill; inspect a fresh snapshot");
        await assertNotSensitiveField(locator);
        if (field.action === "fill") await locator.fill(field.value);
        else if (field.action === "select") await this.selectValues(locator, field.values);
        else await locator.setChecked(field.checked);
        completed += 1;
      }
    } catch (cause) {
      error = cause instanceof Error ? cause.message : String(cause);
    } finally {
      page.off("framenavigated", onNavigation);
    }
    const snapshot = await this.snapshot({ includeText: false });
    return { ok: !error && !snapshot.verification.detected, completed,
      failedIndex: error ? completed : undefined, error,
      requiresHuman: snapshot.verification.detected, snapshot };
  }

  async reload(): Promise<ActionResult> {
    const page = await this.getPage();
    await requireNoHumanVerification(page);
    await page.reload({ waitUntil: "domcontentloaded" });
    await this.ensureSafeActivePage(page);
    return { action: "reload", snapshot: await this.snapshot() };
  }

  async press(key: string): Promise<ActionResult> {
    const page = await this.getPage();
    await requireNoHumanVerification(page);
    await page.keyboard.press(key);
    await page.waitForTimeout(200);

    return {
      action: "press",
      target: key,
      snapshot: await this.snapshot({ includeText: false }),
    };
  }

  async scroll(direction: "up" | "down", amount = 700, target?: Target): Promise<ActionResult> {
    const page = await this.getPage();
    await requireNoHumanVerification(page);

    if (target) {
      const locator = await this.locator(page, target);
      await locator.scrollIntoViewIfNeeded();
    } else {
      const delta = direction === "down" ? amount : -amount;
      await page.evaluate((y) => window.scrollBy(0, y), delta);
      await page.waitForTimeout(250);
    }

    return {
      action: "scroll",
      target: direction,
      snapshot: await this.snapshot({ includeText: false }),
    };
  }

  async waitFor(input: {
    text?: string;
    selector?: string;
    urlIncludes?: string;
    ms?: number;
    timeoutMs?: number;
    frame?: string;
  }): Promise<{
    snapshot: PageSnapshot;
    verification: VerificationResult;
    matched: string;
  }> {
    const page = await this.getPage();
    const timeout = input.timeoutMs ?? this.browserConfig.timeoutMs;
    let matched = "timeout";

    if (input.text) {
      const target = resolveFrame(page, input.frame);
      await target.getByText(input.text, { exact: false }).first().waitFor({
        state: "visible",
        timeout,
      });
      matched = `text: ${input.text}`;
    } else if (input.selector) {
      await resolveFrame(page, input.frame).locator(input.selector).waitFor({ state: "visible", timeout });
      matched = `selector: ${input.selector}`;
    } else if (input.urlIncludes) {
      await page.waitForURL((url) => url.href.includes(input.urlIncludes as string), { timeout });
      matched = `url includes: ${input.urlIncludes}`;
    } else {
      await page.waitForTimeout(input.ms ?? 1000);
      matched = `waited ${input.ms ?? 1000}ms`;
    }

    await this.ensureSafeActivePage(page);
    const snapshot = await this.snapshot();
    return { snapshot, verification: snapshot.verification, matched };
  }

  async back(): Promise<ActionResult> {
    const page = await this.getPage();
    await page.goBack({ waitUntil: "domcontentloaded", timeout: this.browserConfig.timeoutMs });
    await this.ensureSafeActivePage(page);

    return {
      action: "back",
      snapshot: await this.snapshot(),
    };
  }

  async extract(options: {
    includeText?: boolean;
    includeLinks?: boolean;
    maxTextChars?: number;
    maxLinks?: number;
  } = {}): Promise<{
    url: string;
    title: string;
    text: string;
    links: Array<{ text: string; href: string }>;
    verification: VerificationResult;
  }> {
    const page = await this.getPage();
    const includeText = options.includeText ?? true;
    const includeLinks = options.includeLinks ?? true;
    const maxTextChars = options.maxTextChars ?? this.config.limits.maxTextChars;
    const maxLinks = options.maxLinks ?? 300;

    const data = await page.evaluate(
      ({ maxText, maxLinkCount, withText, withLinks }) => {
        const normalize = (value: string | null | undefined): string =>
          (value ?? "").replace(/\s+/g, " ").trim();

        const links = withLinks
          ? Array.from(document.querySelectorAll("a[href]"))
              .map((element) => ({
                text: normalize((element as HTMLAnchorElement).innerText).slice(0, 300),
                href: (element as HTMLAnchorElement).href,
              }))
              .filter((entry) => entry.href.startsWith("http") && entry.text !== "")
              .slice(0, maxLinkCount)
          : [];

        return {
          text: withText ? (document.body?.innerText ?? "").slice(0, maxText) : "",
          links,
        };
      },
      {
        maxText: maxTextChars,
        maxLinkCount: maxLinks,
        withText: includeText,
        withLinks: includeLinks,
      },
    );

    return {
      url: page.url(),
      title: await page.title().catch(() => ""),
      text: data.text,
      links: data.links,
      verification: await detectHumanVerification(page),
    };
  }

  /** Read one page as stable text for a watch. Read-only; no form mutation. */
  async readPage(options: ReadPageOptions): Promise<ReadPageResult> {
    const page = await this.getPage();
    const safeUrl = await assertSafeUrl(options.url, { resolveDns: true });
    this.logger.debug("Reading watched page", { url: safeUrl.href });

    const response = await page.goto(safeUrl.href, {
      waitUntil: "domcontentloaded",
      timeout: this.browserConfig.timeoutMs,
    });
    await assertSafeUrl(page.url(), { resolveDns: true });

    const status = response?.status() ?? null;
    if (status !== null && status >= 400) {
      throw new ReadPageError(`Watched page returned HTTP ${status}`, "http", status);
    }

    await page.waitForTimeout(300);
    if (options.selector) {
      await page
        .locator(options.selector)
        .first()
        .waitFor({
          state: "attached",
          timeout: Math.min(5_000, this.browserConfig.timeoutMs),
        })
        .catch(() => undefined);
    }

    const data = await page.evaluate(
      ({ selector, maxChars }) => {
        const normalize = (value: string): string =>
          value
            .replace(/\r\n?/g, "\n")
            .split("\n")
            .map((line) => line.replace(/[ \t\f\v]+/g, " ").trim())
            .filter((line) => line.length > 0)
            .join("\n");

        let target: HTMLElement | null = null;
        let selectorProblem: "missing" | "invalid" | null = null;
        let hideChrome = false;

        if (selector) {
          let found: Element | null = null;
          try {
            found = document.querySelector(selector);
          } catch {
            selectorProblem = "invalid";
          }
          if (selectorProblem !== "invalid") {
            if (!found) {
              selectorProblem = "missing";
            } else if (found instanceof HTMLElement) {
              target = found;
            } else {
              target = document.createElement("div");
              target.textContent = found.textContent;
            }
          }
        } else {
          const candidates = Array.from(
            document.querySelectorAll("main, [role='main'], article"),
          )
            .filter(
              (element): element is HTMLElement => element instanceof HTMLElement,
            )
            .filter((element) => element.getClientRects().length > 0)
            .map((element) => ({ element, text: element.innerText ?? "" }))
            .filter((entry) => entry.text.trim().length > 0)
            .sort((left, right) => right.text.length - left.text.length);

          target = candidates[0]?.element ?? document.body;
          hideChrome = !candidates[0];
        }

        if (!target) {
          return {
            text: "",
            title: document.title,
            selectorProblem,
            truncated: false,
          };
        }

        let raw = "";
        if (hideChrome) {
          const hidden: Array<{ element: HTMLElement; display: string }> = [];
          try {
            for (const element of Array.from(
              document.querySelectorAll(
                "nav, header, footer, aside, script, style, noscript, template, svg, canvas, form, [role='navigation'], [role='banner'], [role='contentinfo'], [aria-hidden='true']",
              ),
            )) {
              if (!(element instanceof HTMLElement)) continue;
              hidden.push({ element, display: element.style.display });
              element.style.display = "none";
            }
            raw = target.innerText ?? target.textContent ?? "";
          } finally {
            for (const entry of hidden) {
              entry.element.style.display = entry.display;
            }
          }
        } else {
          raw = target.innerText ?? target.textContent ?? "";
        }

        const text = normalize(raw);
        return {
          text: text.slice(0, maxChars),
          title: document.title,
          selectorProblem,
          truncated: text.length > maxChars,
        };
      },
      {
        selector: options.selector,
        maxChars: options.maxTextChars ?? this.config.limits.maxTextChars,
      },
    );

    if (data.selectorProblem) {
      throw new ReadPageError(
        data.selectorProblem === "invalid"
          ? `Watch selector is invalid: ${options.selector}. Update the watch selector.`
          : `Watch selector not found: ${options.selector}. Update the watch selector.`,
        "selector",
      );
    }

    return {
      url: page.url(),
      title: data.title.slice(0, READ_PAGE_MAX_TITLE_CHARS),
      text: data.text,
      truncated: data.truncated,
      verification: await detectHumanVerification(page),
    };
  }

  async screenshot(options: {
    fullPage?: boolean;
    inline?: boolean;
    type?: "png" | "jpeg";
  } = {}): Promise<ScreenshotResult> {
    const page = await this.getPage();
    const type = options.type ?? "png";
    const extension = type === "jpeg" ? "jpg" : "png";
    const filePath = join(
      this.paths.screenshotsDir,
      `${new Date().toISOString().replace(/[:.]/g, "-")}-${randomUUID().slice(0, 8)}.${extension}`,
    );

    await page.screenshot({
      path: filePath,
      fullPage: options.fullPage ?? false,
      type,
    });

    const info = await stat(filePath);
    const result: ScreenshotResult = {
      path: filePath,
      mimeType: type === "jpeg" ? "image/jpeg" : "image/png",
      bytes: info.size,
    };

    if (options.inline) {
      result.base64 = (await readFile(filePath)).toString("base64");
    }

    return result;
  }

  async uploadFile(target: Target, filePath: string | { name: string; mimeType: string; buffer: Buffer }): Promise<ActionResult> {
    const page = await this.getPage();
    await requireNoHumanVerification(page);

    const locator = await this.locator(page, target);
    await locator.waitFor({ state: "attached", timeout: this.browserConfig.timeoutMs });

    const input = await locator.evaluate((element) => ({
      tag: element.tagName.toLowerCase(),
      type: (element as HTMLInputElement).type,
    }));

    if (input.tag === "input" && input.type === "file") {
      await locator.setInputFiles(filePath, { timeout: this.browserConfig.timeoutMs });
    } else {
      const [chooser] = await Promise.all([
        page.waitForEvent("filechooser", { timeout: this.browserConfig.timeoutMs }),
        locator.click({ timeout: this.browserConfig.timeoutMs }),
      ]);
      await chooser.setFiles(filePath);
    }

    await page.waitForTimeout(400);

    return {
      action: "upload",
      target: describeTarget(target),
      snapshot: await this.snapshot({ includeText: false }),
    };
  }

  async downloadFile(target: Target, timeoutMs = this.browserConfig.timeoutMs): Promise<{
    filename: string; buffer: Buffer; sessionId: string; tabId: string;
  }> {
    const page = await this.getPage();
    await requireNoHumanVerification(page);
    const locator = await this.locator(page, target);
    // Register before clicking, so a fast response cannot be missed.
    const pending = page.waitForEvent("download", { timeout: timeoutMs });
    void pending.catch(() => undefined);
    await locator.click({ timeout: timeoutMs });
    const download = await pending;
    const timer = setTimeout(() => { void download.cancel().catch(() => undefined); }, timeoutMs);
    timer.unref();
    try {
      const stream = await download.createReadStream();
      const chunks: Buffer[] = []; let size = 0;
      for await (const chunk of stream) {
        const bytes = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk);
        size += bytes.length;
        if (size > this.config.limits.maxUploadBytes) {
          stream.destroy();
          await download.cancel();
          throw new Error(`Downloaded file exceeds ${this.config.limits.maxUploadBytes} bytes`);
        }
        chunks.push(bytes);
      }
      const failure = await download.failure();
      if (failure) throw new Error(`Download failed: ${failure}`);
      return { filename: download.suggestedFilename(), buffer: Buffer.concat(chunks), sessionId: this.sessionId, tabId: this.tabId(page) };
    } finally {
      clearTimeout(timer);
      await download.delete().catch(() => undefined);
    }
  }

  async tabs(action: "list" | "select" | "close" | "new", index?: number, tabId?: string): Promise<{
    sessionId: string;
    pages: Array<{ id: string; index: number; url: string; title: string; active: boolean }>;
  }> {
    const context = await this.ensureStarted();

    if (index !== undefined && tabId) throw new Error("Use tabId or legacy index, not both");
    if (tabId) {
      index = context.pages().findIndex((page) => this.tabId(page) === tabId);
      if (index < 0) throw new Error(`Unknown or closed tabId: ${tabId}`);
    }

    if (action === "new") {
      if (context.pages().length >= this.browserConfig.maxTabs) throw new Error(`Tab limit (${this.browserConfig.maxTabs}) reached. Close an unused tab first.`);
      this.activePage = await context.newPage();
    } else if ((action === "select" || action === "close") && index === undefined) {
      throw new Error(`Tab index is required for ${action}`);
    } else if (action === "select" && index !== undefined) {
      const page = context.pages()[index];
      if (!page) {
        throw new Error(`Tab index out of range: ${index}`);
      }
      this.activePage = page;
      await page.bringToFront();
    } else if (action === "close" && index !== undefined) {
      const page = context.pages()[index];
      if (!page) {
        throw new Error(`Tab index out of range: ${index}`);
      }
      await page.close();
      if (this.activePage === page) {
        this.activePage = context.pages().at(-1);
      }
    }

    const pages = await Promise.all(
      context.pages().map(async (page, pageIndex) => ({
        id: this.tabId(page),
        index: pageIndex,
        url: page.url(),
        title: await page.title().catch(() => ""),
        active: page === this.activePage,
      })),
    );

    return { sessionId: this.sessionId, pages };
  }

  async humanVerificationCheck(): Promise<VerificationResult> {
    return detectHumanVerification(await this.getPage());
  }

  async humanVerificationWait(timeoutMs = 120_000): Promise<VerificationResult> {
    const page = await this.getPage();
    const deadline = Date.now() + timeoutMs;

    while (Date.now() < deadline) {
      const result = await detectHumanVerification(page);
      if (!result.detected) {
        return result;
      }
      await page.waitForTimeout(1500);
    }

    return detectHumanVerification(page);
  }

  async close(): Promise<void> {
    if (this.context) {
      this.logger.info("Closing browser");
      await this.context.close().catch((error) => {
        this.logger.warn("Failed to close browser cleanly", { error: String(error) });
      });
    }

    this.context = undefined;
    this.activePage = undefined;
    this.launchPromise = undefined;
  }

  private async launch(): Promise<void> {
    this.logger.info("Launching browser", {
      headless: this.browserConfig.headless,
      profileDir: this.browserConfig.profileDir,
    });

    const options: Parameters<typeof chromium.launchPersistentContext>[1] = {
      headless: this.browserConfig.headless,
      slowMo: this.browserConfig.slowMoMs,
      viewport: this.browserConfig.viewport,
      acceptDownloads: true,
      serviceWorkers: "block",
      locale: "en-US",
      timeout: this.browserConfig.timeoutMs,
    };

    if (this.browserConfig.channel) {
      options.channel = this.browserConfig.channel;
    }

    const context = await chromium.launchPersistentContext(
      this.browserConfig.profileDir,
      options,
    );

    await context.addInitScript(() => {
      const globalWithName = globalThis as typeof globalThis & {
        __name?: (target: unknown, name: string) => unknown;
      };
      if (typeof globalWithName.__name !== "function") {
        globalWithName.__name = (target: unknown, name: string) => {
          Object.defineProperty(target as object, "name", { value: name, configurable: true });
          return target;
        };
      }
    });

    context.setDefaultTimeout(this.browserConfig.timeoutMs);
    context.setDefaultNavigationTimeout(this.browserConfig.timeoutMs);

    await context.route("**/*", async (route) => {
      const request = route.request();
      const requestUrl = request.url();

      if (!requestUrl.startsWith("http://") && !requestUrl.startsWith("https://")) {
        if (request.isNavigationRequest()) {
          await route.abort("blockedbyclient").catch(() => undefined);
          return;
        }
        await route.continue().catch(() => undefined);
        return;
      }

      try {
        await assertSafeUrl(requestUrl, {
          resolveDns: true,
        });
      } catch (error) {
        this.logger.warn("Blocked unsafe browser request", {
          url: requestUrl,
          error: error instanceof UnsafeUrlError ? error.message : String(error),
        });
        await route.abort("blockedbyclient").catch(() => undefined);
        return;
      }

      await route.continue().catch(() => undefined);
    });

    context.on("page", (page) => {
      if (context.pages().length > this.browserConfig.maxTabs) {
        void page.close().catch(() => undefined);
        return;
      }
      this.tabId(page);
      // A popup must not steal the target of the next action. Explicitly select it.
      if (!this.activePage || this.activePage.isClosed()) this.activePage = page;
      this.logger.debug("New browser page", { url: page.url() });
    });

    context.on("close", () => {
      this.context = undefined;
      this.activePage = undefined;
      this.launchPromise = undefined;
    });

    this.context = context;
    const pages = context.pages().filter((page) => !page.isClosed());
    for (const page of pages) this.tabId(page);
    this.activePage = pages.at(-1) ?? (await context.newPage());
  }

  private async ensureSafeActivePage(page: Page): Promise<void> {
    const currentUrl = page.url();
    if (currentUrl === "about:blank" || currentUrl.startsWith("chrome-error:")) {
      return;
    }

    await assertSafeUrl(currentUrl, { resolveDns: true });
  }

  private async locator(page: Page, target: Target): Promise<Locator> {
    const locator = resolveLocator(page, target);
    if (target.ref && await locator.count() !== 1) throw new StaleRefError(target.ref);
    return locator;
  }

  private async selectValues(locator: Locator, values: string[]): Promise<void> {
    const options = await locator.locator("option").evaluateAll((elements) => elements.map((element) => {
      const option = element as HTMLOptionElement;
      return { value: option.value, label: option.label };
    }));
    const resolved = values.map((value) => {
      const byValue = options.find((option) => option.value === value);
      if (byValue) return byValue.value;
      const byLabel = options.filter((option) => option.label === value);
      if (byLabel.length !== 1) throw new Error(`Dropdown option is missing or ambiguous: ${value}`);
      return byLabel[0].value;
    });
    await locator.selectOption(resolved, { timeout: this.browserConfig.timeoutMs });
  }
}

function describeTarget(target: Target): string {
  if (target.ref) return `ref=${target.ref}`;
  if (target.selector) return `selector=${target.selector}`;
  if (target.text) return `text=${target.text}`;
  return "unknown";
}

async function assertNotSensitiveField(locator: ReturnType<typeof resolveLocator>): Promise<void> {
  const info = await locator.evaluate((element) => {
    const input = element as HTMLInputElement;
    const labels = input.labels
      ? Array.from(input.labels)
          .map((label) => label.innerText)
          .join(" ")
      : "";
    return {
      type: input.type,
      name: element.getAttribute("name") ?? "",
      id: element.id,
      autocomplete: element.getAttribute("autocomplete") ?? "",
      ariaLabel: element.getAttribute("aria-label") ?? "",
      placeholder: input.placeholder ?? "",
      labels,
    };
  });

  if (info.type === "password" || info.autocomplete.includes("password")) {
    throw new Error(
      "Refusing to type into a password field. Ask the user to sign in manually in the visible browser window.",
    );
  }

  const haystack = [
    info.name,
    info.id,
    info.autocomplete,
    info.ariaLabel,
    info.placeholder,
    info.labels,
  ].join(" ");

  if (isSensitiveField(haystack)) {
    throw new Error(
      "Refusing to type sensitive personal or financial data. Ask the user to fill this field manually.",
    );
  }
}
