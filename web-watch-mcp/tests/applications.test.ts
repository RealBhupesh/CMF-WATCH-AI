import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import {
  ApplicationStore,
  canonicalizeUrl,
  makeDedupeKey,
} from "../src/applications.js";

let directory: string;
let file: string;

beforeEach(async () => {
  directory = await mkdtemp(join(tmpdir(), "job-crawler-applications-"));
  file = join(directory, "applications.jsonl");
});

afterEach(async () => {
  await rm(directory, { recursive: true, force: true });
});

describe("canonicalizeUrl", () => {
  it("removes tracking parameters, fragments, and www", () => {
    expect(
      canonicalizeUrl("https://www.Example.com/job/123/?utm_source=x&b=2&a=1#apply"),
    ).toBe("https://example.com/job/123?a=1&b=2");
  });

  it("produces stable dedupe keys", () => {
    const first = makeDedupeKey(
      "https://example.com/jobs/1?utm_source=linkedin",
      "Acme",
      "Engineer",
    );
    const second = makeDedupeKey("https://www.example.com/jobs/1", " acme ", "engineer");
    expect(first).toBe(second);
  });
});

describe("ApplicationStore", () => {
  it("preserves attempts before submission and appends outcomes without inflating counts", async () => {
    const store = new ApplicationStore(file);
    const input = { url: "https://example.com/jobs/1", company: "Acme", title: "Engineer", status: "needs_review" as const };
    const first = await store.record(input);
    await store.updateOutcome(first.record.id, { status: "confirmed", confirmation: "Application received" });
    expect(await store.list()).toHaveLength(1);
    expect((await store.stats()).byStatus.confirmed).toBe(1);
    const retry = await store.record(input, true);
    expect(retry.record.id).not.toBe(first.record.id);
    expect(await store.list()).toHaveLength(2);
    expect((await store.findByDedupeKey(first.record.dedupeKey))?.id).toBe(retry.record.id);
    await expect(store.updateOutcome("missing", { status: "failed" })).rejects.toThrow(/not found/);
  });

  it("records and deduplicates applications", async () => {
    const store = new ApplicationStore(file);
    const first = await store.record({
      url: "https://example.com/jobs/1?utm_source=test",
      company: "Acme",
      title: "Engineer",
      status: "confirmed",
    });

    expect(first.duplicate).toBeUndefined();
    expect(first.record.status).toBe("confirmed");

    const second = await store.record({
      url: "https://www.example.com/jobs/1",
      company: "acme",
      title: "engineer",
      status: "confirmed",
    });

    expect(second.duplicate?.id).toBe(first.record.id);
    expect(await store.list()).toHaveLength(1);
  });

  it("finds matches and computes stats", async () => {
    const store = new ApplicationStore(file);
    await store.record({
      url: "https://example.com/jobs/1",
      company: "Acme",
      title: "Engineer",
      status: "submitted",
    });
    await store.record({
      url: "https://example.com/jobs/2",
      company: "Beta",
      title: "Designer",
      status: "failed",
    });

    expect(await store.findMatches({ company: "Acme" })).toHaveLength(1);
    const stats = await store.stats();
    expect(stats.total).toBe(2);
    expect(stats.byStatus.submitted).toBe(1);
    expect(stats.byStatus.failed).toBe(1);
  });
});
