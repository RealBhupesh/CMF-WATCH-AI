import type { CallToolResult } from "@modelcontextprotocol/server";
import type { Runtime } from "../runtime.js";
import { requireNoHumanVerification } from "../browser/verification.js";
import { buildJobSearchUrl } from "../jobs/search.js";
import { extractJobs } from "../tools/job-tools.js";
import { reconcileApplication, submitApplication } from "../tools/application-tools.js";
import type { Condition, WorkflowAction, WorkflowStep } from "./model.js";

export class WorkflowBlocked extends Error {
  constructor(readonly reason: string, message: string) { super(message); this.name = "WorkflowBlocked"; }
}

export function toolPayload(result: CallToolResult): Record<string, unknown> {
  const content = result.content.find((entry) => entry.type === "text");
  if (!content || content.type !== "text") throw new Error("Expected a JSON tool result");
  return JSON.parse(content.text) as Record<string, unknown>;
}

export async function conditionMatches(runtime: Runtime, condition: Condition): Promise<boolean> {
  const page = await runtime.browser.getPage();
  if (condition.kind === "url") return page.url().includes(condition.value);
  if (condition.kind === "selector") return page.locator(condition.value).first().isVisible();
  return page.getByText(condition.value, { exact: false }).first().isVisible();
}

export async function waitForCondition(runtime: Runtime, condition: Condition, timeoutMs: number): Promise<void> {
  await runtime.browser.waitFor({ timeoutMs,
    text: condition.kind === "text" ? condition.value : undefined,
    selector: condition.kind === "selector" ? condition.value : undefined,
    urlIncludes: condition.kind === "url" ? condition.value : undefined });
  await requireNoHumanVerification(await runtime.browser.getPage());
}

/** This function executes one chosen action. Retry/recovery decisions belong to the runner. */
export async function executeAction(runtime: Runtime, command: WorkflowAction): Promise<Record<string, unknown>> {
  if (command.action === "open") {
    const result = await runtime.browser.navigate(command.url);
    await requireNoHumanVerification(await runtime.browser.getPage());
    if (result.status && result.status >= 400 && result.status < 500) throw new WorkflowBlocked("http_error", `Navigation returned HTTP ${result.status}`);
    if (result.status && result.status >= 500) throw new Error(`Navigation returned HTTP ${result.status}`);
    return { url: result.url, status: result.status };
  }
  await requireNoHumanVerification(await runtime.browser.getPage());
  switch (command.action) {
    case "fill": {
      const result = await runtime.browser.fillForm(command.fields);
      if (result.requiresHuman) throw new WorkflowBlocked("site_verification", "Website requires human verification");
      if (!result.ok) throw new Error(result.error ?? "Form changed during fill");
      return { filled: result.completed };
    }
    case "click":
      await runtime.browser.click(command.target);
      return { clicked: true };
    case "wait": return { waiting: true };
    case "extract": {
      const result = await runtime.browser.extract({ maxTextChars: command.maxTextChars });
      return { url: result.url, title: result.title, text: result.text, links: result.links.slice(0, 100) };
    }
    case "jobs_search": {
      const result = await extractJobs(runtime, { url: buildJobSearchUrl(command), maxJobs: 50, maxLinks: 100 });
      if (result.requiresHuman) throw new WorkflowBlocked("site_verification", "Job search provider requires verification");
      return { jobs: result.jobs, links: result.links, url: result.url };
    }
    case "upload": {
      const payload = await runtime.files.uploadPayload(command.fileId);
      await runtime.browser.uploadFile(command.target, payload);
      return { uploaded: command.fileId, filename: payload.name };
    }
    case "download": {
      const downloaded = await runtime.browser.downloadFile(command.target);
      const file = await runtime.files.saveBuffer(downloaded.filename, downloaded.buffer, "download", { sessionId: downloaded.sessionId, tabId: downloaded.tabId });
      return { file };
    }
    case "application_submit": return toolPayload(await submitApplication(runtime, { ...command.target, company: command.company, title: command.title, resumeId: command.resumeId, confirmationText: command.confirmationText }));
  }
}

export async function verifyEffect(runtime: Runtime, step: WorkflowStep, timeoutMs: number): Promise<Record<string, unknown>> {
  const command = step.command;
  if (command.action === "click") {
    await waitForCondition(runtime, command.expect, timeoutMs);
    return { verified: true, condition: command.expect };
  }
  if (command.action === "application_submit") {
    const matches = await runtime.applications.findMatches({ company: command.company, title: command.title });
    const application = step.applicationId ? matches.find((entry) => entry.id === step.applicationId) : matches[0];
    if (!application) throw new WorkflowBlocked("outcome_unknown", "No application outcome is available; the submission will not be repeated");
    if (application.status === "confirmed") return { confirmed: true, application };
    // Poll observations, never the submit button. Delayed confirmations do not need a person.
    const deadline = Date.now() + timeoutMs;
    do {
      const result = toolPayload(await reconcileApplication(runtime, { id: application.id, confirmationText: command.confirmationText }));
      if (result.confirmed === true) return result;
      if (result.requiresHuman === true) throw new WorkflowBlocked("site_verification", "Website requires human verification");
      if (result.status === "failed") throw new WorkflowBlocked("validation_error", "Website reported form validation errors");
      if (Date.now() < deadline) await (await runtime.browser.getPage()).waitForTimeout(Math.min(250, deadline - Date.now()));
    } while (Date.now() < deadline);
  }
  throw new WorkflowBlocked("outcome_unknown", "The effect could not be confirmed. It will not be repeated automatically.");
}
