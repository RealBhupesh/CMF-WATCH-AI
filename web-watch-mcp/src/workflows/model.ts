import { z } from "zod";

const target = { selector: z.string().min(1).optional(), text: z.string().min(1).optional(), frame: z.string().optional() };
const targetSchema = z.object(target).refine((value) => Boolean(value.selector || value.text), "Supply selector or text");
export const conditionSchema = z.discriminatedUnion("kind", [
  z.object({ kind: z.literal("text"), value: z.string().min(1) }),
  z.object({ kind: z.literal("selector"), value: z.string().min(1) }),
  z.object({ kind: z.literal("url"), value: z.string().min(1) }),
]);
export type Condition = z.infer<typeof conditionSchema>;
const formField = z.discriminatedUnion("action", [
  z.object({ ...target, action: z.literal("fill"), value: z.string() }),
  z.object({ ...target, action: z.literal("select"), values: z.array(z.string()).min(1) }),
  z.object({ ...target, action: z.literal("check"), checked: z.boolean() }),
]).refine((value) => Boolean(value.selector || value.text), "Supply selector or text for each field");

export const actionSchema = z.discriminatedUnion("action", [
  z.object({ action: z.literal("open"), url: z.string().url() }),
  z.object({ action: z.literal("fill"), fields: z.array(formField).min(1).max(50) }),
  z.object({ action: z.literal("click"), target: targetSchema, expect: conditionSchema }),
  z.object({ action: z.literal("wait"), expect: conditionSchema }),
  z.object({ action: z.literal("extract"), maxTextChars: z.number().int().min(0).max(20_000).optional() }),
  z.object({ action: z.literal("jobs_search"), query: z.string().trim().min(1).max(500), location: z.string().max(200).optional(), remote: z.boolean().optional(), source: z.enum(["google", "bing", "indeed", "linkedin"]).optional() }),
  z.object({ action: z.literal("upload"), target: targetSchema, fileId: z.uuid() }),
  z.object({ action: z.literal("download"), target: targetSchema }),
  z.object({ action: z.literal("application_submit"), target: targetSchema, company: z.string().min(1), title: z.string().min(1), confirmationText: z.string().min(1).optional(), resumeId: z.string().optional() }),
]);
export type WorkflowAction = z.infer<typeof actionSchema>;

export function isRepeatable(action: WorkflowAction): boolean {
  return ["open", "fill", "wait", "extract", "jobs_search"].includes(action.action);
}

export const workflowStepSchema = z.object({
  id: z.uuid(), command: actionSchema,
  status: z.enum(["pending", "running", "verifying", "completed", "blocked", "failed"]),
  attempts: z.number().int().nonnegative(), result: z.string().optional(), error: z.string().optional(),
  applicationId: z.string().optional(),
});
export type WorkflowStep = z.infer<typeof workflowStepSchema>;

/** A durable claim is enough to make a side effect uncertain, even without a result. */
export function recoveryStatus(step: WorkflowStep): "pending" | "verifying" {
  if (isRepeatable(step.command)) return "pending";
  return step.attempts > 0 || step.result !== undefined || step.applicationId !== undefined || step.status === "verifying"
    ? "verifying" : "pending";
}

export const workflowSchema = z.object({
  id: z.uuid(), name: z.string().min(1).max(200), sessionId: z.string(), tabId: z.string().optional(), lastUrl: z.string().optional(),
  status: z.enum(["queued", "running", "completed", "blocked", "failed", "stopped"]),
  steps: z.array(workflowStepSchema).min(1).max(100), createdAt: z.string(), updatedAt: z.string(),
  maxAttempts: z.number().int().min(1).max(3).default(2),
  conditionTimeoutMs: z.number().int().min(100).max(30_000).default(5000),
  reason: z.string().optional(),
});
export type Workflow = z.infer<typeof workflowSchema>;
