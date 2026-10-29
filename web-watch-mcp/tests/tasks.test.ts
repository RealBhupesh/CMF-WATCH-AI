import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { TaskStore } from "../src/tasks.js";

let directory: string;
let path: string;
let store: TaskStore;
beforeEach(async () => { directory = await mkdtemp(join(tmpdir(), "business-tasks-")); path = join(directory, "tasks.json"); store = new TaskStore(path); });
afterEach(async () => { await rm(directory, { recursive: true, force: true }); });

describe("resumable tasks", () => {
  it("enforces step order, revision checks, and completion criteria", async () => {
    let task = await store.create("Request a quote", "Prepare and submit an authorized quote request", ["Prepare form", "Submit and inspect"], "default");
    await expect(store.step(task.id, task.revision, task.steps[1].id, "running")).rejects.toThrow(/preceding/);
    await expect(store.setStatus(task.id, task.revision, "completed")).rejects.toThrow(/all steps/);
    task = await store.step(task.id, task.revision, task.steps[0].id, "running");
    await expect(store.step(task.id, 0, task.steps[0].id, "completed")).rejects.toThrow(/revision/);
    task = await store.step(task.id, task.revision, task.steps[0].id, "completed");
    task = await store.step(task.id, task.revision, task.steps[1].id, "completed", "Inspected confirmation");
    task = await store.setStatus(task.id, task.revision, "completed");
    expect(task.status).toBe("completed");
    await expect(store.step(task.id, task.revision, task.steps[0].id, "pending")).rejects.toThrow(/Resume/);
  });

  it("recovers running actions as needs_review without replaying them", async () => {
    let task = await store.create("Apply", "Apply to a supplied vacancy", ["Submit application"], "default");
    task = await store.step(task.id, task.revision, task.steps[0].id, "running");
    const reopened = new TaskStore(path);
    await reopened.recoverInterrupted();
    task = await reopened.get(task.id);
    expect(task.status).toBe("paused");
    expect(task.steps[0].status).toBe("needs_review");
    task = await reopened.setStatus(task.id, task.revision, "active");
    await expect(reopened.step(task.id, task.revision, task.steps[0].id, "running")).rejects.toThrow(/interrupted/);
    task = await reopened.step(task.id, task.revision, task.steps[0].id, "completed", "Confirmed via application audit");
    expect(task.steps[0].status).toBe("completed");
  });

  it("does not lose progress on pause and rejects checkpoints from another session", async () => {
    let task = await store.create("Research", "Find suppliers", ["Collect quotes"], "default");
    await expect(store.checkpoint(task.id, task.revision, { capturedAt: new Date().toISOString(), url: "https://example.com", title: "Supplier", tabId: "tab", sessionId: "other" })).rejects.toThrow(/session/);
    task = await store.step(task.id, task.revision, task.steps[0].id, "running");
    task = await store.setStatus(task.id, task.revision, "paused");
    expect(task.steps[0].status).toBe("needs_review");
    await store.delete(task.id);
    expect(await store.list()).toHaveLength(0);
  });

  it("allows only one competing update for a revision", async () => {
    const task = await store.create("Research", "Find suppliers", ["Collect quotes"], "default");
    const results = await Promise.allSettled([store.step(task.id, 0, task.steps[0].id, "running"), store.setStatus(task.id, 0, "paused")]);
    expect(results.filter((result) => result.status === "fulfilled")).toHaveLength(1);
    expect((await store.get(task.id)).revision).toBe(1);
  });
});
