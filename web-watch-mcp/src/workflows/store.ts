import { randomUUID } from "node:crypto";
import { z } from "zod";
import { JsonFile } from "../storage/json-file.js";
import { recoveryStatus, workflowSchema, type Workflow, type WorkflowAction } from "./model.js";

export class WorkflowStore {
  private readonly file;
  constructor(path: string) {
    this.file = new JsonFile(path, z.object({ workflows: z.array(workflowSchema) }), () => ({ workflows: [] as Workflow[] }));
  }
  async list(): Promise<Workflow[]> { return structuredClone((await this.file.read()).workflows); }
  async get(id: string): Promise<Workflow> {
    const workflow = (await this.list()).find((entry) => entry.id === id);
    if (!workflow) throw new Error(`Workflow not found: ${id}`);
    return workflow;
  }
  async create(input: { name: string; sessionId: string; tabId?: string; actions: WorkflowAction[]; maxAttempts?: number; conditionTimeoutMs?: number }): Promise<Workflow> {
    const now = new Date().toISOString();
    const workflow = workflowSchema.parse({ ...input, id: randomUUID(), status: "queued", createdAt: now, updatedAt: now,
      steps: input.actions.map((command) => ({ id: randomUUID(), command, status: "pending", attempts: 0 })) });
    await this.file.update((current) => {
      if (current.workflows.length >= 500) throw new Error("Workflow storage limit reached; delete finished workflows first");
      return { workflows: [...current.workflows, workflow] };
    });
    return workflow;
  }
  async change(id: string, change: (workflow: Workflow) => Workflow): Promise<Workflow> {
    let updated!: Workflow;
    await this.file.update((current) => ({ workflows: current.workflows.map((workflow) => {
      if (workflow.id !== id) return workflow;
      updated = workflowSchema.parse({ ...change(structuredClone(workflow)), id, updatedAt: new Date().toISOString() });
      return updated;
    }) }));
    if (!updated) throw new Error(`Workflow not found: ${id}`);
    return updated;
  }
  async recover(): Promise<void> {
    const workflows = await this.list();
    for (const workflow of workflows.filter((entry) => entry.status === "running")) {
      await this.change(workflow.id, (current) => ({ ...current, status: "queued", steps: current.steps.map((step) =>
        step.status === "running" ? { ...step, status: recoveryStatus(step) } : step) }));
    }
  }
  async delete(id: string): Promise<void> {
    const workflow = await this.get(id);
    if (["queued", "running"].includes(workflow.status)) throw new Error("Stop the workflow before deleting it");
    await this.file.update((current) => ({ workflows: current.workflows.filter((entry) => entry.id !== id) }));
  }
}
