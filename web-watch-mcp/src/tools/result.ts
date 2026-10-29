import type { CallToolResult } from "@modelcontextprotocol/server";
import { HumanVerificationRequiredError } from "../browser/verification.js";
import { UnsafeUrlError } from "../security/url-guard.js";
import { ResumeValidationError } from "../resumes.js";
import { ToolBusyError } from "../control.js";
import { StaleRefError } from "../browser/snapshot.js";
import type { Runtime } from "../runtime.js";
import { FileValidationError } from "../files.js";

export function jsonResult(value: unknown): CallToolResult {
  return {
    content: [
      {
        type: "text",
        text: JSON.stringify(value, null, 2),
      },
    ],
  };
}

export function textResult(text: string): CallToolResult {
  return {
    content: [{ type: "text", text }],
  };
}

export function errorResult(message: string, details?: unknown): CallToolResult {
  const payload =
    details === undefined
      ? { ok: false, error: message }
      : { ok: false, error: message, details };

  return {
    isError: true,
    content: [{ type: "text", text: JSON.stringify(payload, null, 2) }],
  };
}

export function safeTool<Args>(
  handler: (args: Args) => Promise<CallToolResult>,
): (args: Args) => Promise<CallToolResult> {
  return async (args: Args) => {
    try {
      return await handler(args);
    } catch (error) {
      return handleToolError(error);
    }
  };
}

export function runtimeTool<Args>(
  runtime: Runtime,
  handler: (args: Args) => Promise<CallToolResult>,
): (args: Args) => Promise<CallToolResult> {
  return safeTool((args: Args) => runtime.control.run(async () => {
    const target = { ...(args ?? {}) } as { sessionId?: string; tabId?: string; taskId?: string };
    if (target.taskId) {
      const task = await runtime.tasks.get(target.taskId);
      if (target.sessionId && task.sessionId !== target.sessionId) throw new Error("Task belongs to a different browser session");
      target.sessionId = task.sessionId;
    }
    return runtime.sessions.run(target, () => handler(args));
  }));
}

export function handleToolError(error: unknown): CallToolResult {
  if (error instanceof ToolBusyError || error instanceof StaleRefError) {
    return {
      isError: true,
      ...jsonResult({
        ok: false,
        reason: error instanceof ToolBusyError ? "tool_busy" : "stale_ref",
        retryable: true,
        error: error.message,
        next: "Wait for any running call, then call browser_snapshot before retrying. Never blindly retry a submission.",
      }),
    };
  }
  if (error instanceof Error && error.name === "TimeoutError") {
    return {
      isError: true,
      ...jsonResult({ ok: false, reason: "timeout", error: error.message,
        next: "Inspect browser_snapshot to see whether the action completed before deciding to retry. Never blindly retry a submission." }),
    };
  }
  if (error instanceof HumanVerificationRequiredError) {
    return jsonResult({
      ok: false,
      requiresHuman: true,
      reason: "human_verification",
      verification: error.result,
      next:
        "Ask the user to complete the challenge in the visible browser window. Then call browser_human_verification with action=wait (or action=check), followed by browser_snapshot.",
    });
  }

  if (error instanceof UnsafeUrlError) {
    return errorResult(error.message, { url: error.url });
  }

  if (error instanceof ResumeValidationError || error instanceof FileValidationError) {
    return errorResult(error.message);
  }

  const message = error instanceof Error ? error.message : String(error);
  return errorResult(message);
}
