import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type {
  ReadPageResult,
} from "../src/browser/browser-manager.js";
import { ReadPageError } from "../src/browser/browser-manager.js";
import type { VerificationResult } from "../src/browser/verification.js";
import { loadConfig } from "../src/config.js";
import { Logger } from "../src/logger.js";
import { createRuntime, type Runtime } from "../src/runtime.js";
import type { NewWatch } from "../src/watches/model.js";

let runtime: Runtime;
let directory: string;
const logger = new Logger("error", "watch-integration");

const cleanVerification: VerificationResult = {
  detected: false,
  providers: [],
  signals: [],
  url: "https://example.com/careers",
  title: "Careers",
  policy: "human",
  message: "No human-verification challenge detected.",
};

beforeEach(async () => {
  directory = await mkdtemp(join(tmpdir(), "watch-integration-"));
  runtime = await createRuntime(
    loadConfig("stdio", {
      DATA_DIR: directory,
      BROWSER_HEADLESS: "true",
      BROWSER_TIMEOUT_MS: "1000",
      BROWSER_MAX_TABS: "3",
    }),
    logger,
  );
  await runtime.browser.ensureStarted();
});

afterEach(async () => {
  vi.restoreAllMocks();
  await runtime.close();
  await rm(directory, { recursive: true, force: true });
});

const newWatch: NewWatch = {
  name: "Careers",
  url: "https://example.com/careers",
  intent: "New engineering roles in Pune",
  intervalMinutes: 60,
  sessionId: "default",
};

function page(
  text: string,
  title = "Careers",
  overrides: Partial<ReadPageResult> = {},
): ReadPageResult {
  return {
    url: "https://example.com/careers",
    title,
    text,
    truncated: false,
    verification: { ...cleanVerification, title },
    ...overrides,
  };
}

async function createWatch(overrides: Partial<NewWatch> = {}) {
  return runtime.watches.create({ ...newWatch, ...overrides });
}

describe("watch runner in Chromium", () => {
  it("captures a baseline, stays quiet when unchanged, and queues evidence when changed", async () => {
    const watch = await createWatch();
    const previousTabId = (await runtime.browser.status()).activeTabId;
    const read = vi
      .spyOn(runtime.browser, "readPage")
      .mockResolvedValue(page("Engineer\nDesigner"));

    const baseline = await runtime.watchRunner.check(watch.id);
    expect(baseline.result).toBe("baseline");
    expect(baseline.watch.baseline).toMatchObject({
      title: "Careers",
      chars: "Engineer\nDesigner".length,
    });
    expect(await runtime.watches.listEvents()).toHaveLength(0);
    expect(read).toHaveBeenCalledWith({
      url: watch.url,
      selector: undefined,
    });

    const unchanged = await runtime.watchRunner.check(watch.id);
    expect(unchanged.result).toBe("unchanged");
    expect(await runtime.watches.listEvents()).toHaveLength(0);

    read.mockResolvedValue(page("Engineer\nDesigner\nManager"));
    const changed = await runtime.watchRunner.check(watch.id);
    expect(changed.result).toBe("changed");
    expect(changed.event).toMatchObject({
      intent: "New engineering roles in Pune",
      added: ["Manager"],
      removed: [],
      addedCount: 1,
      removedCount: 0,
      titleChanged: false,
    });

    const events = await runtime.watches.listEvents({ unreadOnly: true });
    expect(events).toHaveLength(1);
    expect(events[0].watchId).toBe(watch.id);
    expect((await runtime.browser.status()).activeTabId).toBe(previousTabId);
  });

  it("scopes extraction to the supplied selector", async () => {
    const watch = await createWatch({ selector: "#jobs" });
    const read = vi
      .spyOn(runtime.browser, "readPage")
      .mockResolvedValue(page("Role A"));

    await runtime.watchRunner.check(watch.id);
    expect(read).toHaveBeenCalledWith({
      url: watch.url,
      selector: "#jobs",
    });
  });

  it("queues a title-only change", async () => {
    const watch = await createWatch();
    const read = vi
      .spyOn(runtime.browser, "readPage")
      .mockResolvedValue(page("Engineer"));

    await runtime.watchRunner.check(watch.id);
    read.mockResolvedValue(page("Engineer", "Careers v2"));
    const changed = await runtime.watchRunner.check(watch.id);
    expect(changed.result).toBe("changed");
    expect(changed.event).toMatchObject({
      titleChanged: true,
      title: "Careers v2",
      added: [],
      removed: [],
    });
  });

  it("blocks immediately on human verification", async () => {
    const watch = await createWatch();
    vi.spyOn(runtime.browser, "readPage").mockResolvedValue(
      page("Verify you are human", "Careers", {
        verification: {
          ...cleanVerification,
          detected: true,
          signals: ["verify you are human"],
          message: "Human verification or a bot wall was detected.",
        },
      }),
    );

    const outcome = await runtime.watchRunner.check(watch.id);
    expect(outcome.result).toBe("error");
    expect(outcome.requiresHuman).toBe(true);
    expect(outcome.watch.status).toBe("blocked");
    expect(outcome.watch.reason).toBe("site_verification");
    expect(outcome.watch.lastError).toMatch(/Human verification/);
  });

  it("backs off after transient failures and blocks after five", async () => {
    const watch = await createWatch();
    vi.spyOn(runtime.browser, "readPage").mockRejectedValue(
      new Error("Network down"),
    );

    let outcome = await runtime.watchRunner.check(watch.id);
    expect(outcome.watch.status).toBe("active");
    expect(outcome.watch.consecutiveFailures).toBe(1);
    expect(Date.parse(outcome.watch.nextRunAt)).toBeGreaterThan(Date.now());

    for (let attempt = 0; attempt < 4; attempt += 1) {
      outcome = await runtime.watchRunner.check(watch.id);
    }

    expect(outcome.watch.status).toBe("blocked");
    expect(outcome.watch.reason).toBe("check_failures");
    expect(outcome.watch.consecutiveFailures).toBe(5);
    expect(outcome.watch.lastError).toBe("Network down");
  });

  it("blocks immediately when the selector is missing", async () => {
    const watch = await createWatch({ selector: "#gone" });
    vi.spyOn(runtime.browser, "readPage").mockRejectedValue(
      new ReadPageError("Watch selector not found: #gone", "selector"),
    );

    const outcome = await runtime.watchRunner.check(watch.id);
    expect(outcome.result).toBe("error");
    expect(outcome.watch.status).toBe("blocked");
    expect(outcome.watch.reason).toBe("selector_not_found");
  });

  it("keeps a paused watch paused during a manual check", async () => {
    const watch = await createWatch();
    await runtime.watches.change(watch.id, (current) => ({
      ...current,
      status: "paused",
      reason: "paused_by_owner",
    }));
    const read = vi
      .spyOn(runtime.browser, "readPage")
      .mockResolvedValue(page("Engineer"));

    const baseline = await runtime.watchRunner.check(watch.id, { manual: true });
    expect(baseline.result).toBe("baseline");
    expect(baseline.watch.status).toBe("paused");

    read.mockResolvedValue(page("Engineer\nManager"));
    const changed = await runtime.watchRunner.check(watch.id, { manual: true });
    expect(changed.result).toBe("changed");
    expect(changed.watch.status).toBe("paused");
  });

  it("refuses a manual check for a blocked watch", async () => {
    const watch = await createWatch();
    await runtime.watches.change(watch.id, (current) => ({
      ...current,
      status: "blocked",
      reason: "site_verification",
    }));

    await expect(
      runtime.watchRunner.check(watch.id, { manual: true }),
    ).rejects.toThrow(/blocked/);
  });
});
