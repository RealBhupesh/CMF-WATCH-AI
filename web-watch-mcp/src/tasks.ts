import { randomUUID } from "node:crypto";
import { z } from "zod";
import { JsonFile } from "./storage/json-file.js";

export const stepStatusSchema = z.enum(["pending", "running", "completed", "failed", "needs_review", "skipped"]);
export type StepStatus = z.infer<typeof stepStatusSchema>;
const stepSchema = z.object({ id: z.uuid(), description: z.string().min(1).max(2000), status: stepStatusSchema, note: z.string().max(4000).optional() });
export const checkpointSchema = z.object({
  capturedAt: z.string(), url: z.string(), title: z.string(), sessionId: z.string(), tabId: z.string(),
  screenshot: z.string().optional(), note: z.string().max(4000).optional(),
});
export type TaskCheckpoint = z.infer<typeof checkpointSchema>;
const taskSchema = z.object({
  id: z.uuid(), name: z.string().min(1).max(200), objective: z.string().min(1).max(8000), sessionId: z.string(),
  status: z.enum(["active", "paused", "completed", "failed"]), steps: z.array(stepSchema).min(1).max(100),
  createdAt: z.string(), updatedAt: z.string(), revision: z.number().int().nonnegative(),
  checkpoint: checkpointSchema.optional(), recoveryNote: z.string().optional(),
});
export type TaskRecord = z.infer<typeof taskSchema>;

export class TaskStore {
  private readonly index;
  constructor(filePath: string) {
    this.index = new JsonFile(filePath, z.object({ tasks: z.array(taskSchema) }), () => ({ tasks: [] as TaskRecord[] }));
  }

  async list(): Promise<TaskRecord[]> { return structuredClone((await this.index.read()).tasks).reverse(); }
  async get(id: string): Promise<TaskRecord> {
    const record = (await this.list()).find((task) => task.id === id);
    if (!record) throw new Error(`Task not found: ${id}`);
    return record;
  }

  async create(name: string, objective: string, steps: string[], sessionId: string): Promise<TaskRecord> {
    const now = new Date().toISOString();
    const task = taskSchema.parse({ id: randomUUID(), name: name.trim(), objective: objective.trim(), sessionId,
      status: "active", steps: steps.map((description) => ({ id: randomUUID(), description: description.trim(), status: "pending" })),
      createdAt: now, updatedAt: now, revision: 0 });
    await this.index.update((current) => {
      if (current.tasks.length >= 1000) throw new Error("Task storage limit reached; delete old tasks first");
      return { tasks: [...current.tasks, task] };
    });
    return task;
  }

  async update(id: string, revision: number, change: (task: TaskRecord) => TaskRecord): Promise<TaskRecord> {
    let updated!: TaskRecord;
    await this.index.update((current) => {
      const task = current.tasks.find((entry) => entry.id === id);
      if (!task) throw new Error(`Task not found: ${id}`);
      if (task.revision !== revision) throw new Error(`Task revision changed (current ${task.revision}). Read task_get before updating.`);
      updated = taskSchema.parse({ ...change(structuredClone(task)), id: task.id, sessionId: task.sessionId,
        revision: task.revision + 1, updatedAt: new Date().toISOString() });
      return { tasks: current.tasks.map((entry) => entry.id === id ? updated : entry) };
    });
    return updated;
  }

  async step(id: string, revision: number, stepId: string, status: StepStatus, note?: string): Promise<TaskRecord> {
    return this.update(id, revision, (task) => {
      if (task.status !== "active") throw new Error("Resume the task before updating its steps");
      const index = task.steps.findIndex((step) => step.id === stepId);
      if (index < 0) throw new Error(`Step not found: ${stepId}`);
      if (status === "running") {
        if (task.steps[index].status === "needs_review") throw new Error("Inspect the interrupted action, then explicitly resolve the step before starting it again");
        if (["completed", "skipped"].includes(task.steps[index].status)) throw new Error("This step is already finished. Explicitly reset it to pending before starting it again.");
        if (task.steps.some((step, position) => position !== index && step.status === "running")) throw new Error("Another task step is already running");
        if (task.steps.slice(0, index).some((step) => !["completed", "skipped"].includes(step.status))) throw new Error("Complete or skip preceding steps first");
      }
      task.steps[index] = { ...task.steps[index], status, note };
      return task;
    });
  }

  async checkpoint(id: string, revision: number, checkpoint: TaskCheckpoint): Promise<TaskRecord> {
    return this.update(id, revision, (task) => {
      if (checkpoint.sessionId !== task.sessionId) throw new Error("Checkpoint session does not match task session");
      return { ...task, checkpoint };
    });
  }

  async setStatus(id: string, revision: number, status: TaskRecord["status"]): Promise<TaskRecord> {
    return this.update(id, revision, (task) => {
      if (status === "completed" && task.steps.some((step) => !["completed", "skipped"].includes(step.status))) throw new Error("Complete or skip all steps before completing the task");
      // Resuming an interrupted step never silently permits its replay.
      return { ...task, status, steps: status === "paused" || status === "failed"
        ? task.steps.map((step) => step.status === "running" ? { ...step, status: "needs_review" as const } : step)
        : task.steps };
    });
  }

  async recoverInterrupted(): Promise<void> {
    const current = await this.index.read();
    if (!current.tasks.some((task) => task.status === "active")) return;
    await this.index.update((state) => ({ tasks: state.tasks.map((task) => task.status !== "active" ? task : {
      ...task, status: "paused" as const, revision: task.revision + 1, updatedAt: new Date().toISOString(),
      recoveryNote: "Server restarted. Inspect the browser and application audit before resuming. Running steps may already have had an effect; they must not be replayed automatically.",
      steps: task.steps.map((step) => step.status === "running" ? { ...step, status: "needs_review" as const } : step),
    }) }));
  }

  async delete(id: string): Promise<void> {
    await this.get(id);
    await this.index.update((current) => ({ tasks: current.tasks.filter((task) => task.id !== id) }));
  }
}
