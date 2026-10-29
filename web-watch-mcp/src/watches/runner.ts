import { HumanVerificationRequiredError } from "../browser/verification.js";
import { ReadPageError, type ReadPageResult } from "../browser/browser-manager.js";
import { ToolBusyError } from "../control.js";
import type { Runtime } from "../runtime.js";
import { UnsafeUrlError } from "../security/url-guard.js";
import { diffLines, hashContent, makeExcerpt, normalizeText } from "./content.js";
import {
  WATCH_MAX_FAILURES,
  watchIntervalMs,
  type Watch,
  type WatchEvent,
} from "./model.js";

const TICK_INTERVAL_MS = 15_000;
const TICK_BUDGET_MS = 45_000;

export interface WatchCheckOutcome {
  result: "baseline" | "unchanged" | "changed" | "error";
  watch: Watch;
  event?: WatchEvent;
  error?: string;
  requiresHuman?: boolean;
  reason?: string;
}

export class WatchRunner {
  private timer?: NodeJS.Timeout;
  private ticking?: Promise<void>;
  private closing = false;

  constructor(private readonly runtime: Runtime) {}

  start(): void {
    if (this.timer || this.closing) return;
    this.timer = setInterval(() => {
      void this.tick();
    }, TICK_INTERVAL_MS);
    this.timer.unref();
  }

  async close(): Promise<void> {
    this.closing = true;
    if (this.timer) clearInterval(this.timer);
    await this.ticking;
  }

  private async tick(): Promise<void> {
    if (this.ticking || this.closing) return;
    this.ticking = this.runDue()
      .catch((error: unknown) => {
        this.runtime.logger.error("Watch worker failed", {
          error: error instanceof Error ? error.message : String(error),
        });
      })
      .finally(() => {
        this.ticking = undefined;
      });
    await this.ticking;
  }

  private async runDue(): Promise<void> {
    const deadline = Date.now() + TICK_BUDGET_MS;

    while (!this.closing && Date.now() < deadline) {
      const next = await this.nextDue();
      if (!next) return;

      try {
        await this.runtime.control.run(async () => {
          const current = await this.runtime.watches.get(next.id);
          if (
            current.status !== "active" ||
            Date.parse(current.nextRunAt) > Date.now()
          ) {
            return;
          }
          await this.check(next.id);
        });
      } catch (error) {
        if (error instanceof ToolBusyError) return;
        this.runtime.logger.error("Watch check could not record its outcome", {
          watchId: next.id,
          error: error instanceof Error ? error.message : String(error),
        });
        // Do not hot-loop a watch whose state update failed.
        await this.runtime.watches
          .change(next.id, (watch) => ({
            ...watch,
            nextRunAt: new Date(
              Date.now() + watchIntervalMs(watch),
            ).toISOString(),
          }))
          .catch(() => undefined);
      }
    }
  }

  private async nextDue(): Promise<Watch | undefined> {
    const now = Date.now();
    return (await this.runtime.watches.list())
      .filter(
        (watch) =>
          watch.status === "active" && Date.parse(watch.nextRunAt) <= now,
      )
      .sort((left, right) => left.nextRunAt.localeCompare(right.nextRunAt))[0];
  }

  /**
   * Run one check. The caller must hold Runtime.control; the runner owns the
   * session scope and temporary tab. The watch is not deleted or changed by
   * another mutating tool while this runs because those tools take the lock.
   */
  async check(
    id: string,
    options: { manual?: boolean } = {},
  ): Promise<WatchCheckOutcome> {
    const watch = await this.runtime.watches.get(id);

    if (options.manual && watch.status === "blocked") {
      throw new Error(
        `Watch is blocked (${watch.reason ?? "unknown"}). Resolve the cause, then call watch_resume.`,
      );
    }

    const startedAt = Date.now();

    try {
      return await this.runtime.sessions.run(
        { sessionId: watch.sessionId },
        async () => {
          const browser = this.runtime.browser;
          const previousTabId = (await browser.status()).activeTabId;
          let watchTabId: string | undefined;

          try {
            await browser.tabs("new");
            const page = await browser.getPage();
            watchTabId = browser.tabId(page);

            const readable = await browser.readPage({
              url: watch.url,
              selector: watch.selector,
            });

            if (readable.verification.detected) {
              throw new HumanVerificationRequiredError(readable.verification);
            }

            return await this.recordSuccess(watch, readable, startedAt);
          } finally {
            if (watchTabId) {
              await browser
                .tabs("close", undefined, watchTabId)
                .catch(() => undefined);
            }
            if (previousTabId) {
              await browser.selectTab(previousTabId).catch(() => undefined);
            }
          }
        },
      );
    } catch (error) {
      return this.recordFailure(watch, error, startedAt);
    }
  }

  private async recordSuccess(
    watch: Watch,
    readable: ReadPageResult,
    startedAt: number,
  ): Promise<WatchCheckOutcome> {
    const now = Date.now();
    const at = new Date(now).toISOString();
    const text = normalizeText(readable.text);
    const hash = hashContent(readable.title, text);
    const durationMs = now - startedAt;
    const nextRunAt = new Date(now + watchIntervalMs(watch)).toISOString();

    if (!watch.baseline) {
      await this.runtime.watches.writeSnapshot(watch.id, text);
      const updated = await this.runtime.watches.change(watch.id, (current) => ({
        ...current,
        baseline: {
          hash,
          title: readable.title,
          url: readable.url,
          capturedAt: at,
          chars: text.length,
          truncated: readable.truncated,
        },
        lastCheck: { at, result: "baseline", durationMs },
        nextRunAt,
        consecutiveFailures: 0,
        lastError: undefined,
        reason: current.status === "paused" ? current.reason : undefined,
      }));

      this.runtime.logger.info("Watch baseline captured", {
        watchId: watch.id,
        chars: text.length,
      });
      return { result: "baseline", watch: updated };
    }

    if (hash === watch.baseline.hash) {
      const updated = await this.runtime.watches.change(watch.id, (current) => ({
        ...current,
        lastCheck: { at, result: "unchanged", durationMs },
        nextRunAt,
        consecutiveFailures: 0,
        lastError: undefined,
        reason: current.status === "paused" ? current.reason : undefined,
      }));

      this.runtime.logger.debug("Watch unchanged", { watchId: watch.id });
      return { result: "unchanged", watch: updated };
    }

    const previousText = await this.runtime.watches.readSnapshot(watch.id);
    const diff = diffLines(previousText ?? "", text);
    const event = await this.runtime.watches.addEvent({
      watchId: watch.id,
      watchName: watch.name,
      url: readable.url,
      previousUrl: watch.baseline.url,
      title: readable.title,
      previousTitle: watch.baseline.title,
      titleChanged: readable.title !== watch.baseline.title,
      intent: watch.intent,
      added: diff.added,
      removed: diff.removed,
      addedCount: diff.addedCount,
      removedCount: diff.removedCount,
      diffTruncated: diff.truncated || previousText === undefined,
      currentExcerpt: makeExcerpt(text),
      snapshotChars: text.length,
      truncated: readable.truncated,
    });

    await this.runtime.watches.writeSnapshot(watch.id, text);
    const updated = await this.runtime.watches.change(watch.id, (current) => ({
      ...current,
      baseline: {
        hash,
        title: readable.title,
        url: readable.url,
        capturedAt: at,
        chars: text.length,
        truncated: readable.truncated,
      },
      lastCheck: { at, result: "changed", durationMs },
      lastChangeAt: at,
      nextRunAt,
      consecutiveFailures: 0,
      lastError: undefined,
      reason: current.status === "paused" ? current.reason : undefined,
    }));

    this.runtime.logger.info("Watch change detected", {
      watchId: watch.id,
      added: diff.addedCount,
      removed: diff.removedCount,
    });
    return { result: "changed", watch: updated, event };
  }

  private async recordFailure(
    watch: Watch,
    error: unknown,
    startedAt: number,
  ): Promise<WatchCheckOutcome> {
    const now = Date.now();
    const message = (
      error instanceof Error ? error.message : String(error)
    ).slice(0, 2_000);
    const failures = watch.consecutiveFailures + 1;
    const verification = error instanceof HumanVerificationRequiredError;
    const unsafe = error instanceof UnsafeUrlError;
    const selectorError =
      error instanceof ReadPageError && error.kind === "selector";
    const paused = watch.status === "paused";
    const blocked =
      verification || unsafe || selectorError || failures >= WATCH_MAX_FAILURES;

    const reason = paused
      ? watch.reason
      : verification
        ? "site_verification"
        : unsafe
          ? "unsafe_url"
          : selectorError
            ? "selector_not_found"
            : blocked
              ? "check_failures"
              : undefined;

    const delay =
      watchIntervalMs(watch) * Math.min(2 ** failures, 8);
    const updated = await this.runtime.watches.change(watch.id, (current) => ({
      ...current,
      status: paused ? "paused" : blocked ? "blocked" : "active",
      reason,
      lastError: message,
      consecutiveFailures: failures,
      nextRunAt: new Date(now + delay).toISOString(),
      lastCheck: {
        at: new Date(now).toISOString(),
        result: "error",
        durationMs: now - startedAt,
        error: message,
      },
    }));

    this.runtime.logger.warn("Watch check failed", {
      watchId: watch.id,
      failures,
      blocked,
      reason,
      error: message,
    });

    return {
      result: "error",
      watch: updated,
      error: message,
      requiresHuman: verification,
      reason: updated.reason,
    };
  }
}
