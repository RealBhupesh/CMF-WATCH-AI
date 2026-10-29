import { createHash, randomUUID } from "node:crypto";
import { readFile, readdir, rm, stat, writeFile, chmod } from "node:fs/promises";
import { basename, extname, join } from "node:path";
import { z } from "zod";
import type { AppConfig } from "./config.js";
import type { AppPaths } from "./paths.js";
import { renderTextResumePdf } from "./resume-pdf.js";
import { JsonFile } from "./storage/json-file.js";

const resumeRecordSchema = z.object({
  id: z.string(),
  originalName: z.string(),
  storedName: z.string(),
  label: z.string().optional(),
  mimeType: z.string(),
  size: z.number().int().nonnegative(),
  sha256: z.string(),
  createdAt: z.string(),
  isDefault: z.boolean().default(false),
});

export type ResumeRecord = z.infer<typeof resumeRecordSchema>;

const resumeIndexSchema = z.object({
  resumes: z.array(resumeRecordSchema).default([]),
});

type ResumeIndex = z.infer<typeof resumeIndexSchema>;

const ALLOWED_EXTENSIONS = new Set([".pdf", ".doc", ".docx", ".rtf", ".txt"]);

const MIME_BY_EXTENSION: Record<string, string> = {
  ".pdf": "application/pdf",
  ".doc": "application/msword",
  ".docx": "application/vnd.openxmlformats-officedocument.wordprocessingml.document",
  ".rtf": "application/rtf",
  ".txt": "text/plain",
};

export interface ResumeSaveInput {
  filename: string;
  base64: string;
  label?: string;
}

export interface ResumeTextInput {
  text: string;
  filename?: string;
  label?: string;
}

export class ResumeValidationError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "ResumeValidationError";
  }
}

export class ResumeStore {
  private readonly index: JsonFile<ResumeIndex>;

  constructor(
    private readonly paths: AppPaths,
    private readonly limits: AppConfig["limits"],
  ) {
    this.index = new JsonFile(paths.resumeIndexFile, resumeIndexSchema, () => ({ resumes: [] }));
  }

  async list(): Promise<ResumeRecord[]> {
    const current = await this.index.read();
    return current.resumes;
  }

  async get(id?: string): Promise<ResumeRecord | undefined> {
    const resumes = await this.list();
    if (id) {
      return resumes.find((resume) => resume.id === id);
    }
    return resumes.find((resume) => resume.isDefault);
  }

  async setDefault(id: string): Promise<ResumeRecord> {
    const selected = (await this.list()).find((resume) => resume.id === id);
    if (!selected) {
      throw new Error(`Resume not found: ${id}`);
    }

    await this.index.update((current) => ({
      resumes: current.resumes.map((resume) => ({
        ...resume,
        isDefault: resume.id === id,
      })),
    }));

    return { ...selected, isDefault: true };
  }

  async delete(id: string): Promise<ResumeRecord> {
    const record = (await this.list()).find((resume) => resume.id === id);
    if (!record) {
      throw new Error(`Resume not found: ${id}`);
    }

    await rm(join(this.paths.resumeFilesDir, record.storedName), { force: true });
    await this.index.update((current) => ({
      resumes: current.resumes.filter((resume) => resume.id !== id),
    }));

    return record;
  }

  async save(input: ResumeSaveInput): Promise<ResumeRecord> {
    const base64 = stripDataUrl(input.base64).replace(/\s+/g, "");
    if (!/^[A-Za-z0-9+/]*={0,2}$/.test(base64)) {
      throw new ResumeValidationError("Resume content is not valid base64");
    }

    const buffer = Buffer.from(base64, "base64");
    if (buffer.length === 0) {
      throw new ResumeValidationError("Resume file is empty");
    }

    return this.saveBuffer(input.filename, buffer, input.label);
  }

  async saveText(input: ResumeTextInput): Promise<ResumeRecord> {
    const text = input.text.trim();
    if (text === "") {
      throw new ResumeValidationError("Resume text is empty");
    }
    if (text.length > 100_000) {
      throw new ResumeValidationError("Resume text is too long");
    }

    const buffer = await renderTextResumePdf(text);
    return this.saveBuffer(pdfFilename(input.filename), buffer, input.label);
  }

  async scanInbox(): Promise<{ imported: ResumeRecord[]; skipped: string[] }> {
    let entries: string[];
    try {
      entries = await readdir(this.paths.resumeInboxDir);
    } catch (error) {
      if (isNodeError(error) && error.code === "ENOENT") {
        return { imported: [], skipped: [] };
      }
      throw error;
    }

    const imported: ResumeRecord[] = [];
    const skipped: string[] = [];

    for (const entry of entries.sort()) {
      const sourcePath = join(this.paths.resumeInboxDir, entry);
      const info = await stat(sourcePath);
      if (!info.isFile() || entry.startsWith(".")) {
        continue;
      }

      const buffer = await readFile(sourcePath);
      const existing = await this.findByHash(sha256(buffer));
      if (existing) {
        skipped.push(entry);
        continue;
      }

      try {
        const record = await this.saveBuffer(entry, buffer);
        imported.push(record);
      } catch (error) {
        if (error instanceof ResumeValidationError) {
          skipped.push(`${entry}: ${error.message}`);
          continue;
        }
        throw error;
      }
    }

    return { imported, skipped };
  }

  async filePath(record: ResumeRecord): Promise<string> {
    return join(this.paths.resumeFilesDir, record.storedName);
  }

  private async findByHash(hash: string): Promise<ResumeRecord | undefined> {
    const current = await this.index.read();
    return current.resumes.find((resume) => resume.sha256 === hash);
  }

  private async saveBuffer(
    filename: string,
    buffer: Buffer,
    label?: string,
  ): Promise<ResumeRecord> {
    if (buffer.length > this.limits.maxUploadBytes) {
      throw new ResumeValidationError(
        `Resume exceeds the ${Math.floor(this.limits.maxUploadBytes / (1024 * 1024))} MB upload limit`,
      );
    }

    const safeName = sanitizeFilename(filename);
    const extension = extname(safeName).toLowerCase();
    if (!ALLOWED_EXTENSIONS.has(extension)) {
      throw new ResumeValidationError(
        `Unsupported resume type "${extension || "(none)"}". Allowed: ${[...ALLOWED_EXTENSIONS].join(", ")}`,
      );
    }

    validateMagicBytes(extension, buffer);

    const hash = sha256(buffer);
    const duplicate = await this.findByHash(hash);
    if (duplicate) {
      return duplicate;
    }

    const id = randomUUID();
    const storedName = `${id}-${safeName}`;
    const destination = join(this.paths.resumeFilesDir, storedName);
    await writeFile(destination, buffer, { mode: 0o600 });
    await chmod(destination, 0o600).catch(() => undefined);

    const record: ResumeRecord = {
      id,
      originalName: safeName,
      storedName,
      label: label?.trim() || undefined,
      mimeType: MIME_BY_EXTENSION[extension],
      size: buffer.length,
      sha256: hash,
      createdAt: new Date().toISOString(),
      isDefault: false,
    };

    await this.index.update((current) => ({
      resumes: [...current.resumes, record],
    }));

    return record;
  }
}

function pdfFilename(filename: string | undefined): string {
  const base = sanitizeFilename(filename?.trim() || "resume.pdf");
  const extension = extname(base);
  if (extension.toLowerCase() === ".pdf") {
    return base;
  }
  return `${extension ? base.slice(0, -extension.length) : base}.pdf`;
}

function sanitizeFilename(filename: string): string {
  const base = basename(filename).replace(/[^A-Za-z0-9._ -]/g, "_").trim();
  if (base === "" || base === "." || base === "..") {
    throw new ResumeValidationError("Resume filename is invalid");
  }

  return base.slice(0, 120);
}

function stripDataUrl(value: string): string {
  return value.replace(/^data:[^;]+;base64,/, "");
}

function sha256(buffer: Buffer): string {
  return createHash("sha256").update(buffer).digest("hex");
}

function validateMagicBytes(extension: string, buffer: Buffer): void {
  switch (extension) {
    case ".pdf":
      if (buffer.subarray(0, 5).toString("latin1") !== "%PDF-") {
        throw new ResumeValidationError("File does not look like a PDF");
      }
      return;
    case ".docx":
      if (buffer.subarray(0, 2).toString("latin1") !== "PK") {
        throw new ResumeValidationError("File does not look like a DOCX archive");
      }
      return;
    case ".doc":
      if (
        buffer.length < 8 ||
        buffer.subarray(0, 8).toString("hex") !== "d0cf11e0a1b11ae1"
      ) {
        throw new ResumeValidationError("File does not look like a legacy DOC file");
      }
      return;
    case ".rtf":
      if (buffer.subarray(0, 5).toString("latin1") !== "{\\rtf") {
        throw new ResumeValidationError("File does not look like an RTF document");
      }
      return;
    case ".txt":
      return;
    default:
      throw new ResumeValidationError(`Unsupported resume extension: ${extension}`);
  }
}

function isNodeError(error: unknown): error is NodeJS.ErrnoException {
  return error instanceof Error && "code" in error;
}
