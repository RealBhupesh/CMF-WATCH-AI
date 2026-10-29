import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { createMcpHandler, type McpHttpHandler, type CallToolResult } from "@modelcontextprotocol/server";
import { createMcpServer } from "../src/mcp-server.js";
import { loadConfig } from "../src/config.js";
import { Logger } from "../src/logger.js";
import { createRuntime, type Runtime } from "../src/runtime.js";
import type { WorkflowAction } from "../src/workflows/model.js";

let directory: string;
let runtime: Runtime;
let endpoint: McpHttpHandler;
let requestId = 0;
const logger = new Logger("error", "workflow-test");
const form = '<form onsubmit="event.preventDefault(); document.querySelector(\'#result\').textContent=\'Saved\'; document.body.dataset.submits=String(Number(document.body.dataset.submits || 0)+1)"><label>Name<input id="name"></label><button>Save</button><p id="result"></p></form>';

beforeEach(async () => {
  directory = await mkdtemp(join(tmpdir(), "workflow-integration-"));
  runtime = await createRuntime(loadConfig("stdio", { DATA_DIR: directory, BROWSER_HEADLESS: "true", BROWSER_TIMEOUT_MS: "500" }), logger);
  await (await runtime.browser.getPage()).setContent(form);
  endpoint = createMcpHandler(() => createMcpServer(runtime));
});
afterEach(async () => { vi.restoreAllMocks(); await endpoint.close(); await runtime.close(); await rm(directory, { recursive: true, force: true }); });

async function call(name: string, args: Record<string, unknown>): Promise<Record<string, unknown>> {
  const response = await endpoint.fetch(new Request("http://localhost/mcp", {
    method: "POST", headers: { "content-type": "application/json", accept: "application/json, text/event-stream", "mcp-protocol-version": "2025-06-18" },
    body: JSON.stringify({ jsonrpc: "2.0", id: ++requestId, method: "tools/call", params: { name, arguments: args } }),
  }));
  const body = await response.text();
  const json = body.startsWith("event:") || body.startsWith("data:") ? body.split("\n").find((line) => line.startsWith("data: "))!.slice(6) : body;
  const result = (JSON.parse(json) as { result: CallToolResult }).result;
  const text = result.content.find((entry) => entry.type === "text");
  if (!text || text.type !== "text") throw new Error("Missing JSON result");
  return JSON.parse(text.text) as Record<string, unknown>;
}
async function create(actions: WorkflowAction[], conditionTimeoutMs = 200) {
  const page = await runtime.browser.getPage();
  return runtime.workflows.create({ name: "Automated business work", sessionId: "default", tabId: runtime.browser.tabId(page), actions, conditionTimeoutMs });
}

describe("automated workflows in Chromium", () => {
  it("fills, submits, verifies and completes through one MCP call without step reviews", async () => {
    const page = await runtime.browser.getPage();
    const result = await call("workflow_start", { name: "Save business", tabId: runtime.browser.tabId(page), background: false,
      actions: [{ action: "fill", fields: [{ action: "fill", selector: "#name", value: "Pune Repairs" }] },
        { action: "click", target: { selector: "button" }, expect: { kind: "text", value: "Saved" } }, { action: "extract" }] });
    expect(result).toMatchObject({ status: "completed", completed: 3, total: 3 });
    expect(await page.locator("#name").inputValue()).toBe("Pune Repairs");
    expect(await page.locator("body").getAttribute("data-submits")).toBe("1");
  });

  it("retries a transient repeatable failure automatically", async () => {
    const actualFill = runtime.browser.fillForm.bind(runtime.browser);
    const fill = vi.spyOn(runtime.browser, "fillForm").mockRejectedValueOnce(new Error("Transient frame replacement")).mockImplementation(actualFill);
    const workflow = await create([{ action: "fill", fields: [{ action: "fill", selector: "#name", value: "Pune Repairs" }] }]);
    const result = await runtime.automation.run(workflow.id);
    expect(result.status).toBe("completed");
    expect(result.steps[0].attempts).toBe(2);
    expect(fill).toHaveBeenCalledTimes(2);
  });

  it("skips clicking when the requested outcome is already satisfied", async () => {
    const page = await runtime.browser.getPage();
    await page.locator("#result").evaluate((element) => { element.textContent = "Saved"; });
    const workflow = await create([{ action: "click", target: { selector: "button" }, expect: { kind: "text", value: "Saved" } }]);
    const result = await runtime.automation.run(workflow.id);
    expect(result.status).toBe("completed");
    expect(JSON.parse(result.steps[0].result!)).toMatchObject({ alreadySatisfied: true, clicked: false });
    expect(await page.locator("body").getAttribute("data-submits")).toBeNull();
  });

  it("observes a delayed result after a click timeout without clicking twice", async () => {
    const page = await runtime.browser.getPage();
    const click = vi.spyOn(runtime.browser, "click").mockImplementationOnce(async () => {
      await page.locator("button").click();
      throw new Error("Connection dropped after click");
    });
    const workflow = await create([{ action: "click", target: { selector: "button" }, expect: { kind: "text", value: "Saved" } }]);
    const result = await runtime.automation.run(workflow.id);
    expect(result.status).toBe("completed");
    expect(click).toHaveBeenCalledTimes(1);
    expect(await page.locator("body").getAttribute("data-submits")).toBe("1");
  });

  it("automatically reconciles delayed application confirmation", async () => {
    const page = await runtime.browser.getPage();
    await page.setContent('<button onclick="document.body.dataset.submits=String(Number(document.body.dataset.submits || 0)+1);setTimeout(()=>document.querySelector(\'#result\').textContent=\'Application received\',650)">Apply</button><p id="result"></p>');
    const workflow = await create([{ action: "application_submit", target: { selector: "button" }, company: "Pune Repairs", title: "Technician" }], 2000);
    const result = await runtime.automation.run(workflow.id);
    expect(result.status).toBe("completed");
    expect((await runtime.applications.list())[0].status).toBe("confirmed");
    expect(await page.locator("body").getAttribute("data-submits")).toBe("1");
  });

  it("continues in the background and exposes status without the browser lock", async () => {
    const page = await runtime.browser.getPage();
    const started = await call("workflow_start", { name: "Background fill", tabId: runtime.browser.tabId(page), actions: [{ action: "fill", fields: [{ action: "fill", selector: "#name", value: "Automatic" }] }] });
    expect(started.status).toBe("queued");
    const id = String(started.id);
    await vi.waitFor(async () => { expect((await runtime.workflows.get(id)).status).toBe("completed"); }, { timeout: 5000 });
    let release!: () => void;
    const held = runtime.control.run(() => new Promise<void>((resolve) => { release = resolve; }));
    try { expect(await call("workflow_status", { id })).toMatchObject({ status: "completed" }); }
    finally { release(); await held; }
    expect(await page.locator("#name").inputValue()).toBe("Automatic");
  });

  it("blocks an uncertain side effect and never repeats it on continue", async () => {
    const page = await runtime.browser.getPage();
    await page.setContent('<button onclick="document.body.dataset.clicks=String(Number(document.body.dataset.clicks||0)+1)">Send</button>');
    const workflow = await create([{ action: "click", target: { selector: "button" }, expect: { kind: "text", value: "Definitely delivered" } }], 100);
    expect(await runtime.automation.run(workflow.id)).toMatchObject({ status: "blocked", reason: "outcome_unknown" });
    await runtime.automation.resume(workflow.id);
    expect((await runtime.automation.run(workflow.id)).status).toBe("blocked");
    expect(await page.locator("body").getAttribute("data-clicks")).toBe("1");
  });

  it("stops at a website verification challenge without modifying it", async () => {
    const page = await runtime.browser.getPage();
    await page.setContent('<p>Verify you are human</p><input id="name">');
    const workflow = await create([{ action: "fill", fields: [{ action: "fill", selector: "#name", value: "Blocked" }] }]);
    expect(await runtime.automation.run(workflow.id)).toMatchObject({ status: "blocked", reason: "site_verification" });
    expect(await page.locator("#name").inputValue()).toBe("");
    expect((await runtime.workflows.get(workflow.id)).steps[0].attempts).toBe(0);
    await page.setContent(form);
    await runtime.automation.resume(workflow.id);
    expect((await runtime.automation.run(workflow.id)).status).toBe("completed");
    expect(await page.locator("#name").inputValue()).toBe("Blocked");
  });

  it("bounds repeatable retries instead of looping forever", async () => {
    const fill = vi.spyOn(runtime.browser, "fillForm").mockRejectedValue(new Error("Field missing"));
    const workflow = await create([{ action: "fill", fields: [{ action: "fill", selector: "#missing", value: "test" }] }]);
    expect(await runtime.automation.run(workflow.id)).toMatchObject({ status: "blocked", reason: "retry_exhausted" });
    expect(fill).toHaveBeenCalledTimes(2);
  });

  it("executes an unattempted click once after a verification exception is cleared", async () => {
    const page = await runtime.browser.getPage();
    await page.setContent('<p>Verify you are human</p>' + form);
    const click = vi.spyOn(runtime.browser, "click");
    const workflow = await create([{ action: "click", target: { selector: "button" }, expect: { kind: "text", value: "Saved" } }]);
    expect(await runtime.automation.run(workflow.id)).toMatchObject({ status: "blocked", reason: "site_verification", steps: [{ attempts: 0 }] });
    expect(click).not.toHaveBeenCalled();
    await page.setContent(form);
    expect(await runtime.automation.resume(workflow.id)).toMatchObject({ steps: [{ status: "pending", attempts: 0 }] });
    expect((await runtime.automation.run(workflow.id)).status).toBe("completed");
    expect(click).toHaveBeenCalledTimes(1);
    expect(await page.locator("body").getAttribute("data-submits")).toBe("1");
  });

  it("keeps a preflight observation failure unclaimed and can continue it", async () => {
    const page = await runtime.browser.getPage();
    const click = vi.spyOn(runtime.browser, "click");
    vi.spyOn(page, "getByText").mockImplementationOnce(() => { throw new Error("Transient observation failure"); });
    const workflow = await create([{ action: "click", target: { selector: "button" }, expect: { kind: "text", value: "Saved" } }]);
    expect(await runtime.automation.run(workflow.id)).toMatchObject({ status: "blocked", reason: "execution_error", steps: [{ status: "blocked", attempts: 0 }] });
    expect(click).not.toHaveBeenCalled();
    await runtime.automation.resume(workflow.id);
    expect((await runtime.automation.run(workflow.id)).status).toBe("completed");
    expect(click).toHaveBeenCalledTimes(1);
  });

  it("preserves explicit uncertainty without a claim across repeated continues", async () => {
    const page = await runtime.browser.getPage();
    await page.setContent('<button onclick="document.body.dataset.clicks=\'1\'">Send</button>');
    const click = vi.spyOn(runtime.browser, "click");
    const workflow = await create([{ action: "click", target: { selector: "button" }, expect: { kind: "text", value: "Delivered" } }], 100);
    await runtime.workflows.change(workflow.id, (current) => ({ ...current, status: "blocked", steps: current.steps.map((step) => ({ ...step, status: "verifying" })) }));
    for (let index = 0; index < 2; index++) {
      await runtime.automation.resume(workflow.id);
      expect(await runtime.automation.run(workflow.id)).toMatchObject({ status: "blocked", steps: [{ status: "verifying", attempts: 0 }] });
    }
    expect(click).not.toHaveBeenCalled();
    expect(await page.locator("body").getAttribute("data-clicks")).toBeNull();
  });

  it.each([1, undefined])("persists exhausted preflight attempts across continue (maxAttempts=%s)", async (maxAttempts) => {
    const page = await runtime.browser.getPage();
    const workflow = await runtime.workflows.create({ name: "Bounded preflight", sessionId: "default", tabId: runtime.browser.tabId(page), maxAttempts, actions: [{ action: "extract" }] });
    const getPage = vi.spyOn(runtime.browser, "getPage").mockRejectedValue(new Error("Transient page access failure"));
    const extract = vi.spyOn(runtime.browser, "extract");
    expect(await runtime.automation.run(workflow.id)).toMatchObject({ status: "blocked", reason: "retry_exhausted", steps: [{ attempts: maxAttempts ?? 2 }] });
    expect(getPage).toHaveBeenCalledTimes(maxAttempts ?? 2);
    getPage.mockRestore();
    await runtime.automation.resume(workflow.id);
    expect(await runtime.automation.run(workflow.id)).toMatchObject({ status: "blocked", reason: "retry_exhausted", steps: [{ attempts: maxAttempts ?? 2 }] });
    expect(extract).not.toHaveBeenCalled();
  });

  it("persists progress and resumes safe work automatically after a restart", async () => {
    const context = await runtime.browser.ensureStarted();
    const url = "https://8.8.8.8/workflow-fixture";
    await context.route("https://8.8.8.8/**", (route) => route.fulfill({ contentType: "text/html", body: form }));
    const workflow = await create([{ action: "open", url }, { action: "fill", fields: [{ action: "fill", selector: "#name", value: "Recovered" }] }]);
    await runtime.workflows.change(workflow.id, (current) => ({ ...current, status: "running", lastUrl: url, steps: current.steps.map((step, index) => ({ ...step, status: index === 0 ? "completed" : "running", attempts: 1 })) }));
    await endpoint.close(); await runtime.close();
    runtime = await createRuntime(loadConfig("stdio", { DATA_DIR: directory, BROWSER_HEADLESS: "true", BROWSER_TIMEOUT_MS: "500" }), logger);
    endpoint = createMcpHandler(() => createMcpServer(runtime));
    const restoredContext = await runtime.browser.ensureStarted();
    await restoredContext.route("https://8.8.8.8/**", (route) => route.fulfill({ contentType: "text/html", body: form }));
    expect((await runtime.workflows.get(workflow.id)).status).toBe("queued");
    runtime.automation.start();
    await vi.waitFor(async () => { expect((await runtime.workflows.get(workflow.id)).status).toBe("completed"); }, { timeout: 5000 });
    expect(await (await runtime.browser.getPage()).locator("#name").inputValue()).toBe("Recovered");
  });

  it("honors stop requests between actions without a routine review gate", async () => {
    const workflow = await create([{ action: "fill", fields: [{ action: "fill", selector: "#name", value: "Should not run" }] }]);
    expect(await call("workflow_stop", { id: workflow.id })).toMatchObject({ status: "stopped" });
    expect((await runtime.automation.run(workflow.id)).status).toBe("stopped");
    expect(await (await runtime.browser.getPage()).locator("#name").inputValue()).toBe("");
  });

  it("accepts a stop request while an action is in progress and prevents the following action", async () => {
    const page = await runtime.browser.getPage();
    const workflow = await create([{ action: "wait", expect: { kind: "selector", value: "#ready" } }, { action: "fill", fields: [{ action: "fill", selector: "#name", value: "Must not run" }] }], 2000);
    const active = runtime.control.run(() => runtime.automation.run(workflow.id));
    await vi.waitFor(async () => { expect((await runtime.workflows.get(workflow.id)).steps[0].status).toBe("running"); });
    expect(await call("workflow_stop", { id: workflow.id })).toMatchObject({ status: "stopped" });
    await page.evaluate(() => { document.body.insertAdjacentHTML("beforeend", '<p id="ready">Ready</p>'); });
    expect((await active).status).toBe("stopped");
    expect(await page.locator("#name").inputValue()).toBe("");
  });

  it("does not launch a browser or reissue an interrupted click after restart", async () => {
    const workflow = await create([{ action: "click", target: { selector: "button" }, expect: { kind: "text", value: "Saved" } }]);
    await runtime.workflows.change(workflow.id, (current) => ({ ...current, status: "running", steps: current.steps.map((step) => ({ ...step, status: "running", attempts: 1 })) }));
    await endpoint.close(); await runtime.close();
    runtime = await createRuntime(loadConfig("stdio", { DATA_DIR: directory, BROWSER_HEADLESS: "true" }), logger);
    endpoint = createMcpHandler(() => createMcpServer(runtime));
    expect(await runtime.automation.run(workflow.id)).toMatchObject({ status: "blocked", reason: "outcome_unknown" });
    expect((await runtime.browser.status()).running).toBe(false);
  });

  it("uses a confirmed audit record to finish an interrupted application without a browser", async () => {
    const workflow = await create([{ action: "application_submit", target: { selector: "button" }, company: "Pune Repairs", title: "Technician" }]);
    const application = await runtime.applications.record({ url: "https://example.com/jobs/123", company: "Pune Repairs", title: "Technician", status: "confirmed" });
    await runtime.workflows.change(workflow.id, (current) => ({ ...current, status: "running", steps: current.steps.map((step) => ({ ...step, status: "running", attempts: 1, applicationId: application.record.id })) }));
    await endpoint.close(); await runtime.close();
    runtime = await createRuntime(loadConfig("stdio", { DATA_DIR: directory, BROWSER_HEADLESS: "true" }), logger);
    endpoint = createMcpHandler(() => createMcpServer(runtime));
    expect((await runtime.automation.run(workflow.id)).status).toBe("completed");
    expect((await runtime.browser.status()).running).toBe(false);
  });
});
