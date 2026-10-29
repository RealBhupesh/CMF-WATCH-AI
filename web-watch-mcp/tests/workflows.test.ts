import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { WorkflowStore } from "../src/workflows/store.js";
import { recoveryStatus } from "../src/workflows/model.js";

let directory: string;
let path: string;
let store: WorkflowStore;
beforeEach(async () => { directory = await mkdtemp(join(tmpdir(), "workflow-store-")); path = join(directory, "workflows.json"); store = new WorkflowStore(path); });
afterEach(async () => { await rm(directory, { recursive: true, force: true }); });

describe("workflow recovery", () => {
  it("distinguishes unclaimed actions from existing uncertainty evidence", async () => {
    const workflow = await store.create({ name: "Send", sessionId: "default", actions: [{ action: "click", target: { selector: "button" }, expect: { kind: "text", value: "Saved" } }] });
    const step = workflow.steps[0];
    expect(recoveryStatus({ ...step, status: "blocked" })).toBe("pending");
    for (const evidence of [{ attempts: 1 }, { result: "{}" }, { applicationId: "attempt-id" }, { status: "verifying" as const }]) {
      expect(recoveryStatus({ ...step, ...evidence })).toBe("verifying");
    }
    await store.change(workflow.id, (current) => ({ ...current, status: "running", steps: [{ ...step, status: "running" }] }));
    const reopened = new WorkflowStore(path);
    await reopened.recover();
    expect(await reopened.get(workflow.id)).toMatchObject({ status: "queued", steps: [{ status: "pending", attempts: 0 }] });
  });

  it("automatically requeues repeatable steps and verifies uncertain side effects", async () => {
    const repeatable = await store.create({ name: "Fill", sessionId: "default", actions: [{ action: "fill", fields: [{ action: "fill", selector: "#name", value: "Pune Repairs" }] }] });
    const click = await store.create({ name: "Submit", sessionId: "default", actions: [{ action: "click", target: { selector: "button" }, expect: { kind: "text", value: "Saved" } }] });
    for (const workflow of [repeatable, click]) await store.change(workflow.id, (current) => ({ ...current, status: "running", steps: current.steps.map((step) => ({ ...step, status: "running", attempts: 1 })) }));
    const reopened = new WorkflowStore(path);
    await reopened.recover();
    expect(await reopened.get(repeatable.id)).toMatchObject({ status: "queued", steps: [{ status: "pending", attempts: 1 }] });
    expect(await reopened.get(click.id)).toMatchObject({ status: "queued", steps: [{ status: "verifying", attempts: 1 }] });
  });

  it("keeps completed/stopped workflows stopped and prevents deleting active work", async () => {
    const workflow = await store.create({ name: "Read", sessionId: "default", actions: [{ action: "extract" }] });
    await expect(store.delete(workflow.id)).rejects.toThrow(/Stop/);
    await store.change(workflow.id, (current) => ({ ...current, status: "stopped" }));
    await store.recover();
    expect((await store.get(workflow.id)).status).toBe("stopped");
    await store.delete(workflow.id);
    expect(await store.list()).toHaveLength(0);
  });
});
