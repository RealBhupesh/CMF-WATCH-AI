import { randomUUID } from "node:crypto";
import { appendFile, mkdir, readFile, chmod } from "node:fs/promises";
import { dirname } from "node:path";
import type { z } from "zod";

export class JsonlFile<T> {
  constructor(
    readonly filePath: string,
    private readonly schema: z.ZodType<T>,
  ) {}

  async append(value: T): Promise<void> {
    const validated = this.schema.parse(value);
    await mkdir(dirname(this.filePath), { recursive: true, mode: 0o700 });
    await appendFile(this.filePath, `${JSON.stringify(validated)}\n`, {
      encoding: "utf8",
      mode: 0o600,
    });
    await chmod(this.filePath, 0o600).catch(() => undefined);
  }

  async readAll(): Promise<T[]> {
    let text: string;
    try {
      text = await readFile(this.filePath, "utf8");
    } catch (error) {
      if (isNodeError(error) && error.code === "ENOENT") {
        return [];
      }
      throw error;
    }

    const records: T[] = [];
    const lines = text.split("\n");
    for (const [index, line] of lines.entries()) {
      if (line.trim() === "") {
        continue;
      }

      let parsed: unknown;
      try {
        parsed = JSON.parse(line);
      } catch (error) {
        throw new Error(
          `Invalid JSON at ${this.filePath}:${index + 1}: ${(error as Error).message}`,
        );
      }

      const result = this.schema.safeParse(parsed);
      if (!result.success) {
        throw new Error(
          `Invalid record at ${this.filePath}:${index + 1}: ${result.error.message}`,
        );
      }

      records.push(result.data);
    }

    return records;
  }

  static newId(): string {
    return randomUUID();
  }
}

function isNodeError(error: unknown): error is NodeJS.ErrnoException {
  return error instanceof Error && "code" in error;
}
