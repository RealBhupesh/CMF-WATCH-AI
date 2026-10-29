import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { loadConfig } from "../src/config.js";
import { Logger } from "../src/logger.js";
import { createRuntime, type Runtime } from "../src/runtime.js";
import { ReadPageError } from "../src/browser/browser-manager.js";
import { extractJobs } from "../src/tools/job-tools.js";
import { createMcpHandler, type McpHttpHandler, type CallToolResult } from "@modelcontextprotocol/server";
import { createMcpServer } from "../src/mcp-server.js";

let runtime: Runtime;
let directory: string;
let handler: McpHttpHandler;
let requestId = 0;

async function callTool(name: string, args: Record<string, unknown>, transport = handler): Promise<Record<string, unknown>> {
  const response = await transport.fetch(new Request("http://localhost/mcp", {
    method: "POST",
    headers: { "content-type": "application/json", accept: "application/json, text/event-stream", "mcp-protocol-version": "2025-06-18" },
    body: JSON.stringify({ jsonrpc: "2.0", id: ++requestId, method: "tools/call", params: { name, arguments: args } }),
  }));
  expect(response.status).toBe(200);
  const body = await response.text();
  const json = body.startsWith("event:") || body.startsWith("data:")
    ? body.split("\n").find((line) => line.startsWith("data: "))!.slice(6) : body;
  const envelope = JSON.parse(json) as { result: CallToolResult };
  const text = envelope.result.content.find((content) => content.type === "text");
  if (!text || text.type !== "text") throw new Error("No text tool result");
  return JSON.parse(text.text) as Record<string, unknown>;
}
const form = `<form onsubmit="event.preventDefault(); document.querySelector('#result').textContent='Saved';">
  <label>Name <input id="name" name="name"></label>
  <label>City <select id="city"><option value="pn">Pune</option><option value="mb">Mumbai</option></select></label>
  <label><input type="checkbox" id="agree">Receive updates</label>
  <label>Password <input id="password" type="password"></label>
  <button type="submit">Save</button><p id="result"></p>
</form>`;

beforeAll(async () => {
  directory = await mkdtemp(join(tmpdir(), "browser-integration-"));
  runtime = await createRuntime(loadConfig("stdio", {
    DATA_DIR: directory, BROWSER_HEADLESS: "true", BROWSER_TIMEOUT_MS: "2000", BROWSER_MAX_TABS: "2",
  }), new Logger("error", "browser-test"));
  await runtime.browser.ensureStarted();
  handler = createMcpHandler(() => createMcpServer(runtime));
});

beforeEach(async () => {
  const page = await runtime.browser.getPage();
  await page.setContent(form);
});

afterAll(async () => {
  await handler?.close();
  await runtime?.close();
  if (directory) await rm(directory, { recursive: true, force: true });
});

describe("real Chromium browser control", () => {
  it("reports snapshot truncation based on visible controls", async () => {
    const page = await runtime.browser.getPage();
    await page.setContent('<button>Visible</button><button hidden>Hidden</button>');
    expect((await runtime.browser.snapshot({ maxElements: 1 })).truncatedElements).toBe(false);
    await page.setContent('<button>One</button><button>Two</button>');
    expect((await runtime.browser.snapshot({ maxElements: 1 })).truncatedElements).toBe(true);
  });

  it("appends text, selects by label and value, and checks idempotently", async () => {
    await runtime.browser.type({ selector: "#name" }, "Ada");
    await runtime.browser.type({ selector: "#name" }, " Lovelace", false);
    const page = await runtime.browser.getPage();
    expect(await page.locator("#name").inputValue()).toBe("Ada Lovelace");
    await runtime.browser.select({ selector: "#city" }, ["Mumbai"]);
    expect(await page.locator("#city").inputValue()).toBe("mb");
    await runtime.browser.select({ selector: "#city" }, ["pn"]);
    expect(await page.locator("#city").inputValue()).toBe("pn");
    await runtime.browser.check({ selector: "#agree" }, true);
    await runtime.browser.check({ selector: "#agree" }, true);
    expect(await page.locator("#agree").isChecked()).toBe(true);
  });

  it("fills multiple snapshot refs without intermediate snapshots and never submits", async () => {
    const snapshot = await runtime.browser.snapshot();
    const ref = (field: string) => snapshot.elements.find((element) => element.fieldName === field)!.ref;
    const result = await runtime.browser.fillForm([
      { action: "fill", ref: ref("name"), value: "Local Repair Shop" },
      { action: "select", ref: ref("city"), values: ["Mumbai"] },
      { action: "check", ref: ref("agree"), checked: true },
    ]);
    expect(result.ok).toBe(true);
    expect(result.completed).toBe(3);
    const page = await runtime.browser.getPage();
    expect(await page.locator("#name").inputValue()).toBe("Local Repair Shop");
    expect(await page.locator("#result").innerText()).toBe("");
    // Exercise a real click and verify its visible result.
    await runtime.browser.click({ selector: "button" });
    expect(await page.locator("#result").innerText()).toBe("Saved");
  });

  it("preflights sensitive fields before changing any field", async () => {
    await expect(runtime.browser.fillForm([
      { action: "fill", selector: "#name", value: "Should not be entered" },
      { action: "fill", selector: "#password", value: "secret" },
    ])).rejects.toThrow(/password/);
    expect(await (await runtime.browser.getPage()).locator("#name").inputValue()).toBe("");
  });

  it("accepts business names and redacts sensitive field values from snapshots", async () => {
    const page = await runtime.browser.getPage();
    await page.setContent('<label>Business name<input id="businessname"></label><label>Card number<input id="cardNumber" value="4111111111111111"></label>');
    await runtime.browser.type({ selector: "#businessname" }, "Pune Repairs");
    await expect(runtime.browser.type({ selector: "#cardNumber" }, "blocked")).rejects.toThrow(/sensitive/);
    const snapshot = await runtime.browser.snapshot();
    expect(snapshot.elements.find((element) => element.fieldName === "cardNumber")?.value).toBe("***");
  });

  it("returns partial progress when a dynamic form removes the next target", async () => {
    const page = await runtime.browser.getPage();
    await page.locator("#name").evaluate((element) => element.addEventListener("input", () => document.querySelector("#city")?.remove()));
    const result = await runtime.browser.fillForm([
      { action: "fill", selector: "#name", value: "Done" },
      { action: "select", selector: "#city", values: ["Mumbai"] },
    ]);
    expect(result.ok).toBe(false);
    expect(result.completed).toBe(1);
    expect(result.failedIndex).toBe(1);
  });

  it("rejects old snapshot refs and detached elements rather than acting on a replacement", async () => {
    const first = await runtime.browser.snapshot();
    const old = first.elements.find((element) => element.fieldName === "name")!.ref;
    const second = await runtime.browser.snapshot();
    await expect(runtime.browser.type({ ref: old }, "wrong")).rejects.toThrow(/stale/);
    const current = second.elements.find((element) => element.fieldName === "name")!.ref;
    const page = await runtime.browser.getPage();
    await page.locator("#name").evaluate((element) => { element.outerHTML = '<input id="name">'; });
    await expect(runtime.browser.type({ ref: current }, "wrong")).rejects.toThrow(/stale/);
  });

  it("addresses shadow DOM controls and refuses old refs after another snapshot", async () => {
    const page = await runtime.browser.getPage();
    await page.evaluate(() => {
      const host = document.createElement("section");
      document.body.append(host);
      host.attachShadow({ mode: "open" }).innerHTML = '<input aria-label="Shadow field">';
    });
    const first = await runtime.browser.snapshot();
    const ref = first.elements.find((element) => element.name === "Shadow field")!.ref;
    await runtime.browser.type({ ref }, "Works");
    expect(await page.getByLabel("Shadow field").inputValue()).toBe("Works");
    await expect(runtime.browser.type({ ref }, "wrong")).rejects.toThrow(/stale/);
  });

  it("stops mutations at a visible verification challenge", async () => {
    const page = await runtime.browser.getPage();
    await page.evaluate(() => { document.body.insertAdjacentHTML("beforeend", "<p>Verify you are human</p>"); });
    await expect(runtime.browser.type({ selector: "#name" }, "blocked")).rejects.toThrow(/verification/i);
    expect(await page.locator("#name").inputValue()).toBe("");
  });

  it("waits for selectors in a specified iframe", async () => {
    const page = await runtime.browser.getPage();
    await page.setContent('<iframe name="details" srcdoc="<p id=loaded>Ready</p>"></iframe>');
    const result = await runtime.browser.waitFor({ frame: "details", selector: "#loaded" });
    expect(result.matched).toBe("selector: #loaded");
  });

  it("extracts nested JobPosting data, salary ranges, all locations, and remote status", async () => {
    const page = await runtime.browser.getPage();
    const job = {
      "@type": "JobPosting", title: "Workshop Technician", hiringOrganization: { name: "Pune Repairs" },
      url: "https://example.com/jobs/technician", jobLocationType: "TELECOMMUTE",
      jobLocation: [{ address: { addressLocality: "Pune" } }, { address: { addressLocality: "Mumbai" } }],
      baseSalary: { currency: "INR", value: { minValue: 25000, maxValue: 40000, unitText: "MONTH" } },
      description: "<p>Repair equipment.</p>",
    };
    await page.setContent(`<script type="application/ld+json">${JSON.stringify({ "@type": "ItemList", itemListElement: [{ item: job }, { item: job }] })}</script>
      <script type="application/ld+json">{"@type":"JobPosting","title":{"malformed":true}}</script>
      <a href="javascript:alert(1)">Apply for job</a>`);
    const result = await extractJobs(runtime, { includeDescription: true });
    expect(result.jobs).toHaveLength(1);
    expect(result.jobs[0]).toMatchObject({ title: "Workshop Technician", location: "Pune; Mumbai", salary: "25000 - 40000 INR MONTH", remote: true, description: "Repair equipment." });
    expect(result.links).toHaveLength(0);
  });

  it("submits through MCP, blocks duplicates, and reconciles without clicking again", async () => {
    const page = await runtime.browser.getPage();
    await page.setContent('<button onclick="document.querySelector(\'#outcome\').textContent=\'Application received\'">Apply</button><p id="outcome"></p>');
    const submitted = await callTool("application_submit", { selector: "button", company: "Pune Repairs", title: "Technician" });
    expect(submitted).toMatchObject({ status: "confirmed", confirmed: true });
    const id = String((submitted.application as { id: string }).id);
    expect(await callTool("application_submit", { selector: "button", company: "Pune Repairs", title: "Technician" })).toMatchObject({ duplicate: true, ok: false });
    await page.setContent("<p>Application received</p>");
    expect(await callTool("application_reconcile", { id })).toMatchObject({ status: "confirmed", confirmed: true });
    expect((await runtime.applications.stats()).total).toBe(1);

    // A failed click still leaves an attempt, and repeating it requires explicit authorization.
    const uncertain = await callTool("application_submit", { selector: "#missing", company: "Pune Repairs", title: "Technician", allowDuplicate: true });
    expect(uncertain).toMatchObject({ ok: false, reason: "submission_uncertain", requiresVerification: true });
    expect((await runtime.applications.stats()).total).toBe(2);
    expect((await runtime.applications.list())[0].status).toBe("awaiting_confirmation");
  });

  it("reports overlapping MCP calls as busy", async () => {
    let finish!: () => void;
    const active = runtime.control.run(() => new Promise<void>((resolve) => { finish = resolve; }));
    try {
      expect(await callTool("browser_snapshot", {})).toMatchObject({ reason: "tool_busy", retryable: true });
    } finally {
      finish();
      await active;
    }
  });

  it("targets stable tab IDs after indices change and refuses closed handles", async () => {
    const first = await runtime.browser.getPage();
    const firstId = runtime.browser.tabId(first);
    await runtime.browser.tabs("new");
    const second = await runtime.browser.getPage();
    const secondId = runtime.browser.tabId(second);
    await second.setContent(form);
    await runtime.browser.tabs("close", undefined, firstId);
    const result = await callTool("browser_type", { tabId: secondId, selector: "#name", value: "Correct tab" });
    expect(result).toMatchObject({ ok: true, snapshot: { sessionId: "default", tabId: secondId } });
    expect(await second.locator("#name").inputValue()).toBe("Correct tab");
    expect(await callTool("browser_type", { tabId: firstId, selector: "#name", value: "Wrong" })).toMatchObject({ ok: false });
    expect(await second.locator("#name").inputValue()).toBe("Correct tab");
  });

  it("isolates session profiles and routes browser actions through MCP", async () => {
    const created = await callTool("browser_sessions", { action: "create", name: "Supplier research" });
    const id = (created.session as { id: string }).id;
    try {
      const separate = await runtime.sessions.get(id);
      const context = await separate.ensureStarted();
      await context.addCookies([{ name: "business", value: "supplier-session", url: "https://example.com" }]);
      await (await separate.getPage()).setContent(form);
      const defaultPage = await runtime.browser.getPage();
      expect(await callTool("browser_type", { sessionId: id, selector: "#name", value: "Supplier" })).toMatchObject({ snapshot: { sessionId: id } });
      expect(await defaultPage.locator("#name").inputValue()).toBe("");
      expect(await (await runtime.browser.ensureStarted()).cookies("https://example.com")).toHaveLength(0);
      expect((await context.cookies("https://example.com"))[0].value).toBe("supplier-session");
      const tabId = separate.tabId(await separate.getPage());
      expect(await callTool("browser_type", { sessionId: "default", tabId, selector: "#name", value: "Wrong" })).toMatchObject({ ok: false });
    } finally { await callTool("browser_sessions", { action: "delete", id }); }
  });

  it("uploads general documents with their original names and saves browser downloads", async () => {
    const bytes = "invoice,total\n123,4500\n";
    const saved = await callTool("file_save", { filename: "invoice.csv", base64: Buffer.from(bytes).toString("base64") });
    const fileId = (saved.file as { id: string }).id;
    const page = await runtime.browser.getPage();
    await page.setContent('<label>Invoice<input id="invoice" type="file"></label><a id="download">Download receipt</a>');
    expect(await callTool("browser_upload_file", { selector: "#invoice", fileId })).toMatchObject({ ok: true });
    expect(await page.locator("#invoice").evaluate((element) => (element as HTMLInputElement).files?.[0].name)).toBe("invoice.csv");
    await page.evaluate((text) => {
      const anchor = document.querySelector("#download") as HTMLAnchorElement;
      anchor.href = URL.createObjectURL(new Blob([text], { type: "text/csv" }));
      anchor.download = "receipt.csv";
    }, bytes);
    const downloaded = await callTool("browser_download", { selector: "#download" });
    expect(downloaded).toMatchObject({ ok: true, file: { filename: "receipt.csv", source: "download", sessionId: "default" } });
    const downloadId = (downloaded.file as { id: string }).id;
    await runtime.browser.close();
    const read = await callTool("file_read", { id: downloadId });
    expect(Buffer.from(String(read.base64), "base64").toString()).toBe(bytes);
    expect(read.nextOffset).toBeNull();
  });

  it("resumes task progress after restart without replaying an interrupted action", async () => {
    const scratch = await mkdtemp(join(tmpdir(), "task-recovery-integration-"));
    const config = loadConfig("stdio", { DATA_DIR: scratch, BROWSER_HEADLESS: "true" });
    const logger = new Logger("error", "task-recovery");
    let isolated = await createRuntime(config, logger);
    let endpoint = createMcpHandler(() => createMcpServer(isolated));
    try {
      const session = await isolated.sessions.create("Business work");
      const created = await callTool("task_create", { name: "Submit quote", objective: "Prepare an authorized quote request", sessionId: session.id, steps: ["Prepare quote", "Submit quote"] }, endpoint);
      let task = created.task as { id: string; revision: number; steps: Array<{ id: string; status: string }> };
      const browser = await isolated.sessions.get(session.id);
      const checkpointUrl = "https://8.8.8.8/task-fixture";
      const context = await browser.ensureStarted();
      await context.route("https://8.8.8.8/**", (route) => route.fulfill({ contentType: "text/html", body: form }));
      await browser.navigate(checkpointUrl);
      const tabId = browser.tabId(await browser.getPage());
      const filled = await callTool("browser_type", { taskId: task.id, tabId, selector: "#name", value: "Saved progress" }, endpoint);
      expect(filled).toMatchObject({ ok: true, snapshot: { sessionId: session.id } });
      const checkpointed = await callTool("task_checkpoint", { taskId: task.id, tabId, revision: task.revision, screenshot: true, note: "Form prepared, not submitted" }, endpoint);
      expect(checkpointed).toMatchObject({ ok: true });
      task = checkpointed.task as typeof task;
      task = (await callTool("task_step", { id: task.id, revision: task.revision, stepId: task.steps[0].id, status: "completed" }, endpoint)).task as typeof task;
      task = (await callTool("task_step", { id: task.id, revision: task.revision, stepId: task.steps[1].id, status: "running" }, endpoint)).task as typeof task;
      await endpoint.close();
      await isolated.close();
      isolated = await createRuntime(config, logger);
      endpoint = createMcpHandler(() => createMcpServer(isolated));
      task = (await callTool("task_get", { id: task.id }, endpoint)).task as typeof task;
      expect(task.steps.map((step) => step.status)).toEqual(["completed", "needs_review"]);
      const resumed = await callTool("task_resume", { id: task.id, revision: task.revision }, endpoint);
      expect(resumed).toMatchObject({ ok: true, browserRestored: false });
      expect((await (await isolated.sessions.get(session.id)).status()).running).toBe(false);
      expect((await isolated.sessions.list()).some((entry) => entry.id === session.id)).toBe(true);
      expect(await callTool("browser_type", { sessionId: session.id, tabId, selector: "#name", value: "Wrong" }, endpoint)).toMatchObject({ ok: false });
      const recoveredBrowser = await isolated.sessions.get(session.id);
      const restoredContext = await recoveredBrowser.ensureStarted();
      await restoredContext.route("https://8.8.8.8/**", (route) => route.fulfill({ contentType: "text/html", body: form }));
      const reopened = await callTool("task_resume", { id: task.id, revision: (resumed.task as typeof task).revision, reopen: true }, endpoint);
      expect(reopened).toMatchObject({ ok: true, browserRestored: true, checkpointUrlMatches: true, snapshot: { sessionId: session.id, url: checkpointUrl } });
      expect((reopened.snapshot as { tabId: string }).tabId).not.toBe(tabId);
      expect(await (await recoveredBrowser.getPage()).locator("#name").inputValue()).toBe("");
    } finally {
      await endpoint.close();
      await isolated.close();
      await rm(scratch, { recursive: true, force: true });
    }
  });

  it("requires tab indices, bounds tabs, and relaunches after reset", async () => {
    await expect(runtime.browser.tabs("select")).rejects.toThrow(/required/);
    await runtime.browser.tabs("new");
    await expect(runtime.browser.tabs("new")).rejects.toThrow(/limit/);
    await runtime.browser.close();
    await runtime.browser.ensureStarted();
    expect((await runtime.browser.status()).running).toBe(true);
  });

  it("reads watch text without semantic chrome and scopes to a selector", async () => {
    const context = await runtime.browser.ensureStarted();
    await context.route("https://8.8.8.8/**", (route) => {
      const path = new URL(route.request().url()).pathname;
      if (path === "/watch") {
        return route.fulfill({
          contentType: "text/html",
          body: "<!doctype html><title>Careers</title><nav>Menu</nav><main><h1>Open roles</h1><p>Engineer</p></main><footer>Footer</footer>",
        });
      }
      if (path === "/bare") {
        return route.fulfill({
          contentType: "text/html",
          body: "<!doctype html><title>Bare</title><nav>Menu</nav><div>Body copy</div><footer>Footer</footer>",
        });
      }
      return route.fulfill({
        status: 404,
        contentType: "text/html",
        body: "Not found",
      });
    });

    const result = await runtime.browser.readPage({
      url: "https://8.8.8.8/watch",
      maxTextChars: 1_000,
    });
    expect(result).toMatchObject({
      url: "https://8.8.8.8/watch",
      title: "Careers",
      truncated: false,
    });
    expect(result.text).toContain("Open roles");
    expect(result.text).toContain("Engineer");
    expect(result.text).not.toContain("Menu");
    expect(result.text).not.toContain("Footer");
    expect(result.verification.detected).toBe(false);

    const scoped = await runtime.browser.readPage({
      url: "https://8.8.8.8/watch",
      selector: "main",
    });
    expect(scoped.text).toContain("Open roles");
    expect(scoped.text).toContain("Engineer");

    const bare = await runtime.browser.readPage({ url: "https://8.8.8.8/bare" });
    expect(bare.text).toContain("Body copy");
    expect(bare.text).not.toContain("Menu");
    expect(bare.text).not.toContain("Footer");

    await expect(
      runtime.browser.readPage({
        url: "https://8.8.8.8/watch",
        selector: "#gone",
      }),
    ).rejects.toMatchObject({ kind: "selector" });
    await expect(
      runtime.browser.readPage({
        url: "https://8.8.8.8/watch",
        selector: "main[",
      }),
    ).rejects.toMatchObject({
      kind: "selector",
      message: expect.stringContaining("invalid"),
    });
    await expect(
      runtime.browser.readPage({ url: "https://8.8.8.8/missing" }),
    ).rejects.toBeInstanceOf(ReadPageError);
  });
});
