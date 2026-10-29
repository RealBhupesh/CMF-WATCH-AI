import type { Runtime } from "../runtime.js";
import { ToolBusyError } from "../control.js";
import { HumanVerificationRequiredError, requireNoHumanVerification } from "../browser/verification.js";
import { UnsafeUrlError, assertSafeUrl } from "../security/url-guard.js";
import { isRepeatable, recoveryStatus, type Workflow, type WorkflowStep } from "./model.js";
import { conditionMatches, executeAction, verifyEffect, waitForCondition, WorkflowBlocked } from "./executor.js";

export class WorkflowRunner {
  private timer?: NodeJS.Timeout;
  private ticking?: Promise<void>;
  private closing = false;
  constructor(private readonly runtime: Runtime) {}

  start(): void {
    if (this.timer || this.closing) return;
    this.timer = setInterval(() => { void this.tick(); }, 1000);
    this.timer.unref();
  }
  private async tick(): Promise<void> {
    if (this.ticking || this.closing) return;
    this.ticking = this.runNext().catch((error: unknown) => {
      if (!(error instanceof ToolBusyError)) this.runtime.logger.error("Workflow worker failed", { error: String(error) });
    }).finally(() => { this.ticking = undefined; });
    await this.ticking;
  }
  private async runNext(): Promise<void> {
    const next = (await this.runtime.workflows.list()).filter((entry) => ["queued", "running"].includes(entry.status)).sort((a, b) => a.updatedAt.localeCompare(b.updatedAt))[0];
    if (next) await this.runtime.control.run(() => this.run(next.id));
  }
  async close(): Promise<void> {
    this.closing = true;
    if (this.timer) clearInterval(this.timer);
    await this.ticking;
  }
  async stop(id: string): Promise<Workflow> {
    return this.runtime.workflows.change(id, (workflow) => workflow.status === "completed" ? workflow : { ...workflow, status: "stopped", reason: "Stopped by owner" });
  }
  async resume(id: string): Promise<Workflow> {
    const workflow = await this.runtime.workflows.change(id, (current) => {
      if (current.status === "completed") return current;
      return { ...current, status: "queued", reason: undefined, steps: current.steps.map((step) =>
        ["blocked", "failed", "running", "verifying"].includes(step.status)
          ? { ...step, status: recoveryStatus(step), error: undefined } : step) };
    });
    this.start();
    return workflow;
  }

  /** Caller holds Runtime.control. Every decision and completed action is persisted. */
  async run(id: string, budgetMs = 20_000): Promise<Workflow> {
    let workflow = await this.runtime.workflows.get(id);
    if (!["queued", "running"].includes(workflow.status)) return workflow;
    const deadline = Date.now() + budgetMs;
    try {
      return await this.runtime.sessions.run({ sessionId: workflow.sessionId }, async () => {
        const browser = this.runtime.browser;
        let tabAvailable = false;
        if (workflow.tabId) {
          try { await browser.selectTab(workflow.tabId); tabAvailable = true; } catch { /* Restore only repeatable work below. */ }
        }
        const next = workflow.steps.find((step) => step.status !== "completed");
        if (!tabAvailable && next && !isRepeatable(next.command) && (next.status === "verifying" || next.status === "running")) {
          // An application audit can prove completion even when its tab disappeared.
          if (next.command.action === "application_submit") {
            const matches = await this.runtime.applications.findMatches({ company: next.command.company, title: next.command.title });
            const confirmed = next.applicationId ? matches.find((entry) => entry.id === next.applicationId && entry.status === "confirmed") : matches.find((entry) => entry.status === "confirmed");
            if (confirmed) {
              workflow = await this.finish(workflow.id, next.id, { confirmed: true, application: confirmed });
              return workflow;
            }
          }
          throw new WorkflowBlocked("outcome_unknown", "Browser closed during a non-repeatable action; no duplicate action will be issued");
        }
        if (!tabAvailable) {
          if ((await browser.status()).running) await browser.tabs("new");
          const page = await browser.getPage();
          if (workflow.lastUrl && workflow.lastUrl !== "about:blank" && next?.command.action !== "open") {
            await assertSafeUrl(workflow.lastUrl, { resolveDns: true });
            await browser.navigate(workflow.lastUrl);
          }
          workflow = await this.change(id, (current) => ({ ...current, tabId: browser.tabId(page) }));
        }
        while (!this.closing && Date.now() < deadline) {
          workflow = await this.runtime.workflows.get(id);
          if (workflow.status === "stopped") return workflow;
          const step = workflow.steps.find((entry) => entry.status !== "completed");
          if (!step) return this.change(id, (current) => ({ ...current, status: "completed", reason: undefined }));
          workflow = await this.change(id, (current) => ({ ...current, status: "running" }));
          let attempted = false;
          try {
            if (step.status === "verifying" || (step.status === "running" && !isRepeatable(step.command))) {
              const verified = await verifyEffect(this.runtime, step, workflow.conditionTimeoutMs);
              workflow = await this.finish(id, step.id, verified);
              continue;
            }
            const maxAttempts = isRepeatable(step.command) ? workflow.maxAttempts : 1;
            if (step.attempts >= maxAttempts) throw new WorkflowBlocked("retry_exhausted", "Bounded automatic retries exhausted");
            if (step.command.action !== "open") await requireNoHumanVerification(await browser.getPage());
            if (step.command.action === "click" && await conditionMatches(this.runtime, step.command.expect)) {
              workflow = await this.finish(id, step.id, { alreadySatisfied: true, clicked: false });
              continue;
            }
            workflow = await this.step(id, step.id, (current) => ({ ...current, status: "running", attempts: current.attempts + 1, error: undefined }));
            attempted = true;
            if (workflow.status === "stopped" || this.closing) return workflow;
            let result = await executeAction(this.runtime, step.command);
            if (step.command.action === "click" || step.command.action === "application_submit") {
              const application = result.application ?? result.existing;
              const applicationId = application && typeof application === "object" && "id" in application ? String(application.id) : undefined;
              workflow = await this.step(id, step.id, (current) => ({ ...current, status: "verifying", applicationId, result: JSON.stringify(result).slice(0, 16_000) }));
              result = await verifyEffect(this.runtime, workflow.steps.find((entry) => entry.id === step.id)!, workflow.conditionTimeoutMs);
            } else if (step.command.action === "wait") {
              await waitForCondition(this.runtime, step.command.expect, workflow.conditionTimeoutMs);
              result = { matched: step.command.expect };
            }
            workflow = await this.finish(id, step.id, result);
          } catch (error) {
            const latest = (await this.runtime.workflows.get(id)).steps.find((entry) => entry.id === step.id)!;
            const message = error instanceof Error ? error.message : String(error);
            if (error instanceof HumanVerificationRequiredError || error instanceof WorkflowBlocked || error instanceof UnsafeUrlError || /sensitive|password/i.test(message)) throw error;
            if (attempted && !isRepeatable(step.command) && ["click", "application_submit"].includes(step.command.action)) {
              // A click timeout is followed by observation, never another click.
              workflow = await this.step(id, step.id, (current) => ({ ...current, status: "verifying", error: message }));
              try {
                const verified = await verifyEffect(this.runtime, workflow.steps.find((entry) => entry.id === step.id)!, workflow.conditionTimeoutMs);
                workflow = await this.finish(id, step.id, verified);
                continue;
              } catch (verificationError) {
                if (verificationError instanceof HumanVerificationRequiredError || verificationError instanceof WorkflowBlocked) throw verificationError;
                throw new WorkflowBlocked("outcome_unknown", "Automatic outcome checks did not establish success; the action will not be repeated");
              }
            }
            if (!isRepeatable(step.command) && !attempted) throw new WorkflowBlocked("execution_error", message);
            const attempts = latest.attempts + (attempted ? 0 : 1);
            if (isRepeatable(step.command)) {
              workflow = await this.step(id, step.id, (current) => ({ ...current, status: "pending", attempts, error: message }));
              if (attempts < workflow.maxAttempts) continue;
            }
            throw new WorkflowBlocked(isRepeatable(step.command) ? "retry_exhausted" : "outcome_unknown", message);
          }
        }
        return this.change(id, (current) => ({ ...current, status: "queued" }));
      });
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      const reason = error instanceof HumanVerificationRequiredError ? "site_verification" : error instanceof WorkflowBlocked ? error.reason : error instanceof UnsafeUrlError ? "unsafe_url" : /sensitive|password/i.test(message) ? "sensitive_input" : "execution_error";
      return this.change(id, (current) => ({ ...current, status: "blocked", reason,
        steps: current.steps.map((step, index) => index === current.steps.findIndex((entry) => entry.status !== "completed") ? { ...step, status: step.status === "verifying" ? "verifying" : "blocked", error: message } : step) }));
    }
  }

  private async finish(id: string, stepId: string, result: Record<string, unknown>): Promise<Workflow> {
    const status = await this.runtime.browser.status();
    return this.change(id, (workflow) => {
      const steps = workflow.steps.map((step): WorkflowStep => step.id === stepId ? { ...step, status: "completed", result: JSON.stringify(result).slice(0, 16_000), error: undefined } : step);
      return { ...workflow, lastUrl: status.activeUrl ?? workflow.lastUrl, tabId: status.activeTabId ?? workflow.tabId,
        steps, status: steps.every((step) => step.status === "completed") ? "completed" : workflow.status };
    });
  }
  private step(id: string, stepId: string, change: (step: WorkflowStep) => WorkflowStep): Promise<Workflow> {
    return this.change(id, (workflow) => ({ ...workflow, steps: workflow.steps.map((step) => step.id === stepId ? change(step) : step) }));
  }
  private change(id: string, change: (workflow: Workflow) => Workflow): Promise<Workflow> {
    return this.runtime.workflows.change(id, (workflow) => workflow.status === "stopped" ? workflow : change(workflow));
  }
}
