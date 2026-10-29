import type { McpServer } from "@modelcontextprotocol/server";
import { z } from "zod";
import type { Runtime } from "../runtime.js";
import { jsonResult, runtimeTool } from "./result.js";

export function registerSessionTools(server: McpServer, runtime: Runtime): void {
  server.registerTool("browser_sessions", {
    title: "Manage Browser Sessions",
    description: "List persistent sessions, create a named session with a separate browser profile/cookies, close its browser, or delete its session and profile. One deployment still has one owner. Session IDs survive restarts; tab IDs last for the life of the open tab. New sessions launch lazily when used. Existing calls default to the default session.",
    inputSchema: z.discriminatedUnion("action", [
      z.object({ action: z.literal("list") }),
      z.object({ action: z.literal("create"), name: z.string().trim().min(1).max(100) }),
      z.object({ action: z.enum(["close", "delete"]), id: z.string().min(1) }),
    ]),
    annotations: { readOnlyHint: false, destructiveHint: true, openWorldHint: false },
  }, runtimeTool(runtime, async (input) => {
    if (input.action === "create") return jsonResult({ ok: true, session: await runtime.sessions.create(input.name) });
    if (input.action === "close") await runtime.sessions.close(input.id);
    if (input.action === "delete") await runtime.sessions.delete(input.id);
    return jsonResult({ ok: true, sessions: await runtime.sessions.list() });
  }));
}
