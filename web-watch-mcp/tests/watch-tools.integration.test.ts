import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  createMcpHandler,
  type CallToolResult,
  type McpHttpHandler,
} from "@modelcontextprotocol/server";
import type { ReadPageResult } from "../src/browser/browser-manager.js";
import type { VerificationResult } from "../src/browser/verification.js";
import { loadConfig } from "../src/config.js";
import { Logger } from "../src/logger.js";
import { createMcpServer } from "../src/mcp-server.js";
import { createRuntime, type Runtime } from "../src/runtime.js";

let runtime: Runtime;
let directory: string;
let endpoint: McpHttpHandler;
let requestId = 0;
const logger = new Logger("error", "watch-tools-test");

const verification: VerificationResult = {
  detected: false,
  providers: [],
  signals: [],
  url: "https://example.com/careers",
  title: "Careers",
  policy: "human",
  message: "No human-verification challenge detected.",
};

function page(text: string): ReadPageResult {
  return {
    url: "https://example.com/careers",
    title: "Careers",
    text,
    truncated: false,
    verification,
  };
}

beforeEach(async () => {
  directory = await mkdtemp(join(tmpdir(), "watch-tools-"));
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
  endpoint = createMcpHandler(() => createMcpServer(runtime));
});

afterEach(async () => {
  vi.restoreAllMocks();
  await endpoint.close();
  await runtime.close();
  await rm(directory, { recursive: true, force: true });
});

async function call(
  name: string,
  args: Record<string, unknown>,
): Promise<Record<string, unknown>> {
  const response = await endpoint.fetch(
    new Request("http://localhost/mcp", {
      method: "POST",
      headers: {
        "content-type": "application/json",
        accept: "application/json, text/event-stream",
        "mcp-protocol-version": "2025-06-18",
      },
      body: JSON.stringify({
        jsonrpc: "2.0",
        id: ++requestId,
        method: "tools/call",
        params: { name, arguments: args },
      }),
    }),
  );
  const body = await response.text();
  const json = body.startsWith("event:") || body.startsWith("data:")
    ? body.split("\n").find((line) => line.startsWith("data: "))!.slice(6)
    : body;
  const result = (JSON.parse(json) as { result: CallToolResult }).result;
  const text = result.content.find((entry) => entry.type === "text");
  if (!text || text.type !== "text") throw new Error("Missing JSON result");
  return JSON.parse(text.text) as Record<string, unknown>;
}

describe("watch MCP tools", () => {
  it("creates, checks, queues, acknowledges, updates, and deletes a watch", async () => {
    const read = vi
      .spyOn(runtime.browser, "readPage")
      .mockResolvedValue(page("Engineer\nDesigner"));

    const created = await call("watch_create", {
      name: "Careers",
      url: "https://example.com/careers",
      intent: "New engineering roles in Pune",
      intervalMinutes: 60,
      checkNow: true,
    });
    expect(created).toMatchObject({
      ok: true,
      checked: true,
      watch: { status: "active" },
      check: { result: "baseline" },
    });
    const id = String((created.watch as { id: string }).id);

    read.mockResolvedValue(page("Engineer\nDesigner\nManager"));
    const checked = await call("watch_check", { id });
    expect(checked).toMatchObject({
      ok: true,
      check: { result: "changed" },
    });
    const event = (checked.check as { event: { id: string } }).event;
    expect(event.id).toBeTruthy();

    const inbox = await call("watch_inbox", {});
    expect(inbox).toMatchObject({ ok: true, count: 1, unread: 1 });
    expect((inbox.events as Array<{ added: string[] }>)[0].added).toContain(
      "Manager",
    );

    const acknowledged = await call("watch_ack", { eventIds: [event.id] });
    expect(acknowledged).toMatchObject({ ok: true, acknowledged: 1, unread: 0 });
    expect(await call("watch_inbox", {})).toMatchObject({ count: 0 });

    const listed = await call("watch_list", {});
    expect(listed).toMatchObject({ ok: true, count: 1 });
    expect((listed.watches as Array<{ unread: number }>)[0].unread).toBe(0);

    const status = await call("server_status", {});
    expect(status).toMatchObject({
      ok: true,
      watches: { count: 1, active: 1, unread: 0 },
    });

    const updated = await call("watch_update", {
      id,
      selector: "#jobs",
      intent: "New engineering roles only",
    });
    expect(updated).toMatchObject({
      ok: true,
      selectorReset: true,
      watch: { selector: "#jobs" },
    });
    expect((updated.watch as Record<string, unknown>).baseline).toBeUndefined();

    read.mockResolvedValue(page("Role A"));
    const rebased = await call("watch_check", { id });
    expect(rebased).toMatchObject({ ok: true, check: { result: "baseline" } });
    expect(read).toHaveBeenLastCalledWith({
      url: "https://example.com/careers",
      selector: "#jobs",
    });

    const deleted = await call("watch_delete", { id });
    expect(deleted).toMatchObject({ ok: true, deleted: id });
    expect(await runtime.watches.list()).toHaveLength(0);
  });

  it("creates the watch without checking when the browser lock is busy", async () => {
    const read = vi.spyOn(runtime.browser, "readPage");
    let release!: () => void;
    const busy = runtime.control.run(
      () =>
        new Promise<void>((resolve) => {
          release = resolve;
        }),
    );

    const created = await call("watch_create", {
      name: "Busy",
      url: "https://example.com/careers",
      intent: "Any change",
      checkNow: true,
    });
    expect(created).toMatchObject({
      ok: true,
      checked: false,
      watch: { status: "active" },
    });
    expect(read).not.toHaveBeenCalled();

    release();
    await busy;
    expect(await runtime.watches.list()).toHaveLength(1);
  });

  it("returns a blocked watch result without running a check", async () => {
    const read = vi
      .spyOn(runtime.browser, "readPage")
      .mockResolvedValue(page("Engineer"));
    const created = await call("watch_create", {
      name: "Blocked",
      url: "https://example.com/careers",
      intent: "Any change",
      checkNow: false,
    });
    const id = String((created.watch as { id: string }).id);
    await runtime.watches.change(id, (current) => ({
      ...current,
      status: "blocked",
      reason: "site_verification",
    }));

    const result = await call("watch_check", { id });
    expect(result).toMatchObject({
      ok: false,
      reason: "site_verification",
    });
    expect(read).not.toHaveBeenCalled();
  });
});
