import { randomUUID } from "node:crypto";
import { mkdir, readFile, rename, writeFile, chmod } from "node:fs/promises";
import { dirname } from "node:path";
import type { z } from "zod";

export class JsonFile<T> {
  private cache: T | undefined;
  private queue: Promise<unknown> = Promise.resolve();

  constructor(
    readonly filePath: string,
    private readonly schema: z.ZodType<T>,
    private readonly createDefault: () => T,
  ) {}

  async read(): Promise<T> {
    if (this.cache !== undefined) {
      return this.cache;
    }

    try {
      const text = await readFile(this.filePath, "utf8");
      const parsed = this.schema.parse(JSON.parse(text));
      this.cache = parsed;
      return parsed;
    } catch (error) {
      if (isNodeError(error) && error.code === "ENOENT") {
        const value = this.createDefault();
        this.cache = value;
        return value;
      }

      if (error instanceof SyntaxError) {
        throw new Error(`Invalid JSON in ${this.filePath}: ${error.message}`, {
          cause: error,
        });
      }

      throw error;
    }
  }

  async write(value: T): Promise<void> {
    const validated = this.schema.parse(value);
    await this.writeAtomic(validated);
    this.cache = validated;
  }

  async update(update: (current: T) => T | Promise<T>): Promise<T> {
    const operation = this.queue.then(async () => {
      const current = await this.read();
      const next = this.schema.parse(await update(current));
      await this.writeAtomic(next);
      this.cache = next;
      return next;
    });

    this.queue = operation.then(
      () => undefined,
      () => undefined,
    );

    return operation;
  }

  private async writeAtomic(value: T): Promise<void> {
    await mkdir(dirname(this.filePath), { recursive: true, mode: 0o700 });
    const tempPath = `${this.filePath}.${process.pid}.${randomUUID()}.tmp`;
    const contents = `${JSON.stringify(value, null, 2)}\n`;
    await writeFile(tempPath, contents, { encoding: "utf8", mode: 0o600 });
    await chmod(tempPath, 0o600).catch(() => undefined);
    await rename(tempPath, this.filePath);
    await chmod(this.filePath, 0o600).catch(() => undefined);
  }
}

function isNodeError(error: unknown): error is NodeJS.ErrnoException {
  return error instanceof Error && "code" in error;
}
