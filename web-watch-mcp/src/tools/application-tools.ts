import { browserContextFields } from "./context.js";
import type { McpServer } from "@modelcontextprotocol/server";
import { z } from "zod";
import type { Runtime } from "../runtime.js";
import { jsonResult, runtimeTool } from "./result.js";
import { requireNoHumanVerification } from "../browser/verification.js";

const targetFields = {
  ref: z.string().optional().describe("Element ref from browser_snapshot, for example f0:e12"),
  selector: z.string().optional().describe("CSS selector, used when ref is not available"),
  text: z.string().optional().describe("Visible text of the element, used when ref is not available"),
  frame: z.string().optional().describe("Frame id (f0), name, or URL substring"),
};

const SUCCESS_PATTERNS = [
  "thank you for applying",
  "thanks for applying",
  "application submitted",
  "application received",
  "we have received your application",
  "your application has been submitted",
  "successfully applied",
  "application complete",
  "application has been received",
];

const ERROR_SELECTORS = [
  '[role="alert"]',
  '[aria-invalid="true"]',
  ".error",
  ".error-message",
  ".field-error",
  ".form-error",
  ".validation-error",
];

export function registerApplicationTools(server: McpServer, runtime: Runtime): void {
  server.registerTool(
    "application_check",
    {
      title: "Check Previous Applications",
      description:
        "Check the local application log for a matching URL, company, or job title before applying. Matching is case-insensitive and ignores common tracking parameters.",
      inputSchema: z.object({ ...browserContextFields,
        url: z.string().optional(),
        company: z.string().optional(),
        title: z.string().optional(),
      }),
      annotations: { readOnlyHint: true, openWorldHint: false },
    },
    runtimeTool(runtime, async (input) => {
      const matches = await runtime.applications.findMatches(input);
      return jsonResult({
        ok: true,
        count: matches.length,
        alreadyApplied: matches.length > 0,
        matches,
      });
    }),
  );

  server.registerTool(
    "application_log",
    {
      title: "Read Application Log",
      description: "Return recent application attempts with their latest observed outcomes, newest first.",
      inputSchema: z.object({ ...browserContextFields,
        limit: z.number().int().min(1).max(500).optional(),
      }),
      annotations: { readOnlyHint: true, openWorldHint: false },
    },
    runtimeTool(runtime, async ({ limit }) => {
      const records = await runtime.applications.list(limit ?? 50);
      return jsonResult({ ok: true, count: records.length, applications: records });
    }),
  );

  server.registerTool(
    "application_stats",
    {
      title: "Application Statistics",
      description: "Summarize the local application log: total applications, applications in the last 30 days, and counts by status.",
      inputSchema: z.object({ ...browserContextFields }),
      annotations: { readOnlyHint: true, openWorldHint: false },
    },
    runtimeTool(runtime, async () => {
      return jsonResult({ ok: true, stats: await runtime.applications.stats() });
    }),
  );

  server.registerTool(
    "application_submit",
    {
      title: "Submit Job Application",
      description:
        "Click the final submit control only when the client explicitly calls this tool. The server verifies the result and appends an entry to the local audit log. It does not decide that a form is ready, does not search for jobs, and does not submit on its own. It refuses to act while a CAPTCHA or bot wall is present and refuses to bypass one. It also refuses duplicate submissions unless allowDuplicate is true.",
      inputSchema: z.object({ ...browserContextFields,
        ...targetFields,
        company: z.string().min(1).describe("Company name for the audit log"),
        title: z.string().min(1).describe("Job title for the audit log"),
        location: z.string().optional(),
        resumeId: z.string().optional().describe("Resume id used for this application"),
        allowDuplicate: z.boolean().optional().describe("Allow a duplicate submission for the same URL/company/title"),
        confirmationText: z.string().optional().describe("Expected confirmation text, if known"),
        waitForNavigation: z.boolean().optional().describe("Wait for a navigation after clicking submit"),
      }),
      annotations: {
        readOnlyHint: false,
        destructiveHint: true,
        idempotentHint: false,
        openWorldHint: true,
      },
    },
    runtimeTool(runtime, async (input) => submitApplication(runtime, input)),
  );

  server.registerTool(
    "application_reconcile",
    {
      title: "Recheck An Application Without Submitting Again",
      description: "Automatically check the current page after a timeout or delayed response and append the observed outcome to an existing application attempt. Never clicks or resubmits. Use the attempt id returned by application_submit. An unconfirmed page stays awaiting_confirmation; do not ask for a routine human review.",
      inputSchema: z.object({ ...browserContextFields, id: z.string().min(1), confirmationText: z.string().min(1).optional() }),
      annotations: { readOnlyHint: false, openWorldHint: true },
    },
    runtimeTool(runtime, async (input) => reconcileApplication(runtime, input)),
  );
}

async function collectFormErrors(page: Awaited<ReturnType<Runtime["browser"]["getPage"]>>): Promise<string[]> {
  try {
    const messages = await page.locator(ERROR_SELECTORS.map((selector) => `${selector}:visible`).join(",")).evaluateAll((elements) => elements.map((element) => {
      const input = element as HTMLInputElement;
      return (element as HTMLElement).innerText || input.validationMessage || element.getAttribute("aria-label") || "Invalid form field";
    }));
    return messages
      .map((message) => message.replace(/\s+/g, " ").trim())
      .filter(Boolean)
      .slice(0, 10);
  } catch {
    return [];
  }
}

export async function submitApplication(runtime: Runtime, input: ApplicationSubmitInput) {
  const page = await runtime.browser.getPage();
  const currentUrl = page.url();
  const resume = await runtime.resumes.get(input.resumeId);

  if (!input.ref && !input.selector && !input.text) {
    return jsonResult({
      ok: false,
      error: "Provide ref, selector, or text identifying the final submit control.",
    });
  }

  const existingMatches = await runtime.applications.findMatches({
    url: currentUrl,
    company: input.company,
    title: input.title,
  });

  if (existingMatches.length > 0 && !input.allowDuplicate) {
    return jsonResult({
      ok: false,
      duplicate: true,
      error:
        "This application appears in the local log already. Set allowDuplicate=true only if the user explicitly wants to submit again.",
      existing: existingMatches[0],
    });
  }

  // Persist the attempt before clicking. A timeout must not erase evidence of a possible submission.
  await requireNoHumanVerification(page);
  const attempt = await runtime.applications.record({
    url: currentUrl, company: input.company, title: input.title,
    location: input.location, resumeId: resume?.id, resumeName: resume?.originalName,
    status: "awaiting_confirmation", notes: "Submission attempt started; checking outcome automatically.",
  }, input.allowDuplicate ?? false);
  try {
    await runtime.browser.click(
      {
        ref: input.ref,
        selector: input.selector,
        text: input.text,
        frame: input.frame,
      },
      input.waitForNavigation ?? false,
    );
  } catch (error) {
    return jsonResult({ ok: false, reason: "submission_uncertain", requiresVerification: true,
      application: attempt.record,
      error: error instanceof Error ? error.message : String(error),
      next: "Inspect browser_snapshot before taking any further action. The click may have succeeded. Automatically call application_reconcile to check the outcome without clicking again. Continue when confirmed; do not repeat the submission." });
  }

  const snapshot = await runtime.browser.snapshot({ includeText: true });
  const verification = snapshot.verification;

  if (verification.detected) {
    const recorded = await runtime.applications.updateOutcome(attempt.record.id, {
      status: "needs_human",
      notes: `Human verification after submit: ${verification.providers.join(", ") || verification.signals.join(", ")}`,
    });

    return jsonResult({
      ok: false,
      requiresHuman: true,
      reason: "human_verification_after_submit",
      verification,
      application: recorded,
      snapshot,
      next:
        "Ask the user to complete the challenge in the visible browser. Then call browser_human_verification and browser_snapshot to confirm whether the submission succeeded.",
    });
  }

  const haystack = `${snapshot.title}\n${snapshot.url}\n${snapshot.text}`.toLowerCase();
  const matchedSuccess = [input.confirmationText, ...SUCCESS_PATTERNS]
    .filter((value): value is string => Boolean(value))
    .find((value) => haystack.includes(value.toLowerCase()));

  const formErrors = await collectFormErrors(page);
  const confirmed = Boolean(matchedSuccess);
  const status = formErrors.length > 0 ? "failed" : confirmed ? "confirmed" : "awaiting_confirmation";

  const recorded = await runtime.applications.updateOutcome(attempt.record.id, {
    status,
    confirmation: matchedSuccess,
    notes:
      formErrors.length > 0
        ? `Possible validation errors: ${formErrors.join(" | ").slice(0, 1500)}`
        : undefined,
  });

  return jsonResult({
    ok: status === "confirmed",
    requiresVerification: status === "awaiting_confirmation",
    status,
    confirmed: status === "confirmed",
    confirmationText: matchedSuccess,
    formErrors,
    duplicate: false,
    application: recorded,
    snapshot,
  });
}

export async function reconcileApplication(runtime: Runtime, { id, confirmationText }: { id: string; confirmationText?: string }) {
  const snapshot = await runtime.browser.snapshot();
  const errors = await collectFormErrors(await runtime.browser.getPage());
  const text = `${snapshot.title}\n${snapshot.text}`.toLowerCase();
  const confirmation = [confirmationText, ...SUCCESS_PATTERNS]
    .filter((value): value is string => Boolean(value)).find((value) => text.includes(value.toLowerCase()));
  const status = snapshot.verification.detected ? "needs_human" : errors.length ? "failed" : confirmation ? "confirmed" : "awaiting_confirmation";
  const application = await runtime.applications.updateOutcome(id, {
    status, confirmation,
    notes: `Observed at ${new Date().toISOString()} on ${snapshot.url}${errors.length ? `; validation errors: ${errors.join(" | ").slice(0, 1500)}` : ""}`,
  });
  return jsonResult({ ok: true, status, confirmed: status === "confirmed", requiresHuman: snapshot.verification.detected, application, snapshot });
}

export interface ApplicationSubmitInput {
  ref?: string; selector?: string; text?: string; frame?: string;
  company: string; title: string; location?: string; resumeId?: string;
  allowDuplicate?: boolean; confirmationText?: string; waitForNavigation?: boolean;
}
