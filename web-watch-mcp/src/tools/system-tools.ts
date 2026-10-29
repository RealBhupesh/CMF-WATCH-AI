import { browserContextFields } from "./context.js";
import type { McpServer } from "@modelcontextprotocol/server";
import { z } from "zod";
import type { Runtime } from "../runtime.js";
import { jsonResult, runtimeTool } from "./result.js";

export function registerSystemTools(server: McpServer, runtime: Runtime): void {
  server.registerTool(
    "server_status",
    {
      title: "Server Status",
      description:
        "Show local server status: transport mode, deterministic-control flags, browser state, data paths, profile completeness, resume count, application statistics, and watch counts. Does not expose secrets.",
      inputSchema: z.object({ ...browserContextFields }),
      annotations: { readOnlyHint: true, openWorldHint: false },
    },
    runtimeTool(runtime, async () => {
      const profile = await runtime.profile.get();
      const resumes = await runtime.resumes.list();
      const stats = await runtime.applications.stats();
      const browser = await runtime.browser.status();
      const files = await runtime.files.list();
      const tasks = await runtime.tasks.list();
      const watches = await runtime.watches.list();
      const unreadWatchEvents = await runtime.watches.unreadCount();

      return jsonResult({
        ok: true,
        mode: runtime.config.mode,
        control: {
          deterministic: true,
          clientSuppliedDataOnly: true,
          autonomousActions: true,
          planning: "connected_mcp_agent",
          execution: "background_workflow_and_watch_runners",
          routineReviews: false,
        },
        browser,
        sessions: await runtime.sessions.list(),
        documents: { count: files.length, bytes: files.reduce((size, file) => size + file.size, 0),
          maxFileBytes: runtime.config.limits.maxUploadBytes, maxStoredBytes: runtime.config.limits.maxStoredFilesBytes, inbox: runtime.paths.fileInboxDir },
        tasks: { count: tasks.length, active: tasks.filter((task) => task.status === "active").length, paused: tasks.filter((task) => task.status === "paused").length },
        workflows: (await runtime.workflows.list()).map((workflow) => ({ id: workflow.id, name: workflow.name, status: workflow.status, reason: workflow.reason })),
        watches: {
          count: watches.length,
          active: watches.filter((watch) => watch.status === "active").length,
          paused: watches.filter((watch) => watch.status === "paused").length,
          blocked: watches.filter((watch) => watch.status === "blocked").length,
          unread: unreadWatchEvents,
        },
        captchaPolicy: runtime.config.captchaPolicy,
        dataDir: runtime.paths.dataDir,
        resumeInbox: runtime.paths.resumeInboxDir,
        profile: {
          isEmpty: profile.isEmpty,
          missingFields: profile.missingFields.map((entry) => entry.field),
          updatedAt: profile.updatedAt,
        },
        resumes: {
          count: resumes.length,
          defaultResumeId: resumes.find((resume) => resume.isDefault)?.id,
        },
        applications: stats,
      });
    }),
  );

  server.registerTool(
    "browser_reset",
    {
      title: "Reset Browser Session",
      description:
        "Close the Playwright browser process. The persistent profile, cookies, and saved logins on disk are kept. The next browser tool call relaunches the browser.",
      inputSchema: z.object({ ...browserContextFields }),
      annotations: { readOnlyHint: false, destructiveHint: true, openWorldHint: false },
    },
    runtimeTool(runtime, async () => {
      await runtime.browser.close();
      return jsonResult({ ok: true, closed: true });
    }),
  );
}
