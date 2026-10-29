import { createHash, randomUUID } from "node:crypto";
import { constants } from "node:fs";
import { open, readdir, rm, writeFile } from "node:fs/promises";
import { basename, extname, join } from "node:path";
import { z } from "zod";
import type { AppConfig } from "./config.js";
import type { AppPaths } from "./paths.js";
import { JsonFile } from "./storage/json-file.js";

const recordSchema = z.object({
  id: z.uuid(), filename: z.string().min(1).max(160), mimeType: z.string(),
  size: z.number().int().positive(), sha256: z.string(), createdAt: z.string(),
  source: z.enum(["upload", "inbox", "download"]), sessionId: z.string().optional(), tabId: z.string().optional(),
});
export type FileRecord = z.infer<typeof recordSchema>;

const MIME: Record<string, string> = {
  ".pdf": "application/pdf", ".txt": "text/plain", ".csv": "text/csv", ".tsv": "text/tab-separated-values",
  ".json": "application/json", ".doc": "application/msword", ".rtf": "application/rtf",
  ".docx": "application/vnd.openxmlformats-officedocument.wordprocessingml.document",
  ".xlsx": "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet",
  ".xls": "application/vnd.ms-excel", ".ods": "application/vnd.oasis.opendocument.spreadsheet",
  ".odt": "application/vnd.oasis.opendocument.text", ".pptx": "application/vnd.openxmlformats-officedocument.presentationml.presentation",
  ".png": "image/png", ".jpg": "image/jpeg", ".jpeg": "image/jpeg", ".webp": "image/webp", ".gif": "image/gif", ".zip": "application/zip",
};

export class FileValidationError extends Error {
  constructor(message: string) { super(message); this.name = "FileValidationError"; }
}

export class FileStore {
  private readonly index;
  constructor(private readonly paths: AppPaths, private readonly limits: AppConfig["limits"]) {
    this.index = new JsonFile(paths.fileIndexFile, z.object({ files: z.array(recordSchema) }), () => ({ files: [] as FileRecord[] }));
  }

  async list(): Promise<FileRecord[]> { return structuredClone((await this.index.read()).files); }

  async get(id: string): Promise<FileRecord> {
    const record = (await this.list()).find((file) => file.id === id);
    if (!record) throw new FileValidationError(`File not found: ${id}`);
    return record;
  }

  async save(filename: string, base64: string): Promise<FileRecord> {
    const encoded = base64.replace(/^data:[^;,]+;base64,/, "").replace(/\s/g, "");
    if (!encoded || encoded.length > Math.ceil(this.limits.maxUploadBytes / 3) * 4 || !/^(?:[A-Za-z0-9+/]{4})*(?:[A-Za-z0-9+/]{2}==|[A-Za-z0-9+/]{3}=)?$/.test(encoded)) {
      throw new FileValidationError("Content is empty, too large, or not valid padded base64");
    }
    const bytes = Buffer.from(encoded, "base64");
    if (bytes.toString("base64") !== encoded) throw new FileValidationError("Content is not canonical base64");
    return this.saveBuffer(filename, bytes, "upload");
  }

  async saveBuffer(filename: string, bytes: Buffer, source: FileRecord["source"], context: { sessionId?: string; tabId?: string } = {}): Promise<FileRecord> {
    const safeName = basename(filename.replaceAll("\\", "/")).replace(/[^\p{L}\p{N}._ -]/gu, "_").trim();
    if (!safeName || safeName.startsWith(".") || safeName.length > 160) throw new FileValidationError("Invalid document filename (maximum 160 characters)");
    const extension = extname(safeName).toLowerCase();
    const mimeType = MIME[extension];
    if (!mimeType) throw new FileValidationError(`Unsupported document type: ${extension || "(none)"}`);
    if (!bytes.length || bytes.length > this.limits.maxUploadBytes) throw new FileValidationError(`File must contain 1 to ${this.limits.maxUploadBytes} bytes`);
    validateHeader(extension, bytes);
    const hash = createHash("sha256").update(bytes).digest("hex");
    const record: FileRecord = { id: randomUUID(), filename: safeName, mimeType, size: bytes.length, sha256: hash, createdAt: new Date().toISOString(), source, ...context };
    // One index transaction also bounds disk growth when callers overlap outside MCP.
    await this.index.update(async (current) => {
      if (current.files.reduce((total, file) => total + file.size, 0) + bytes.length > this.limits.maxStoredFilesBytes) throw new FileValidationError("Managed file storage limit reached. Delete unneeded files first.");
      await writeFile(this.blobPath(record.id), bytes, { mode: 0o600, flag: "wx" });
      return { files: [...current.files, record] };
    }).catch(async (error: unknown) => { await rm(this.blobPath(record.id), { force: true }); throw error; });
    return record;
  }

  async read(id: string, offset = 0, length = 256 * 1024): Promise<{ file: FileRecord; base64: string; offset: number; nextOffset: number | null }> {
    const file = await this.get(id);
    if (!Number.isInteger(offset) || offset < 0 || offset > file.size || !Number.isInteger(length) || length < 1 || length > 1024 * 1024) throw new FileValidationError("Invalid file offset or chunk length (maximum 1 MiB)");
    const handle = await open(this.blobPath(file.id), constants.O_RDONLY | constants.O_NOFOLLOW);
    try {
      const info = await handle.stat();
      if (!info.isFile() || info.size !== file.size) throw new FileValidationError("Stored file changed; import it again");
      const buffer = Buffer.alloc(Math.min(length, file.size - offset));
      const { bytesRead } = await handle.read(buffer, 0, buffer.length, offset);
      if (bytesRead !== buffer.length) throw new FileValidationError("Stored file changed while reading");
      return { file, base64: buffer.subarray(0, bytesRead).toString("base64"), offset, nextOffset: offset + bytesRead < file.size ? offset + bytesRead : null };
    } finally { await handle.close(); }
  }

  async uploadPayload(id: string): Promise<{ name: string; mimeType: string; buffer: Buffer }> {
    const file = await this.get(id);
    const handle = await open(this.blobPath(file.id), constants.O_RDONLY | constants.O_NOFOLLOW);
    try {
      const info = await handle.stat();
      if (!info.isFile() || info.size !== file.size || info.size > this.limits.maxUploadBytes) throw new FileValidationError("Stored file changed; import it again");
      const buffer = await handle.readFile();
      if (createHash("sha256").update(buffer).digest("hex") !== file.sha256) throw new FileValidationError("Stored file integrity check failed");
      return { name: file.filename, mimeType: file.mimeType, buffer };
    } finally { await handle.close(); }
  }

  async delete(id: string): Promise<FileRecord> {
    const file = await this.get(id);
    await this.index.update((current) => ({ files: current.files.filter((entry) => entry.id !== id) }));
    await rm(this.blobPath(file.id), { force: true });
    return file;
  }

  async scanInbox(): Promise<{ imported: FileRecord[]; skipped: string[] }> {
    const imported: FileRecord[] = []; const skipped: string[] = [];
    for (const entry of (await readdir(this.paths.fileInboxDir, { withFileTypes: true })).sort((a, b) => a.name.localeCompare(b.name))) {
      if (!entry.isFile() || entry.name.startsWith(".")) continue;
      let handle;
      try {
        handle = await open(join(this.paths.fileInboxDir, entry.name), constants.O_RDONLY | constants.O_NOFOLLOW);
        const info = await handle.stat();
        if (!info.isFile() || info.size > this.limits.maxUploadBytes) throw new FileValidationError("Not a regular file or exceeds upload limit");
        const bytes = await handle.readFile();
        const hash = createHash("sha256").update(bytes).digest("hex");
        if ((await this.list()).some((file) => file.sha256 === hash && file.filename === entry.name)) { skipped.push(entry.name); continue; }
        imported.push(await this.saveBuffer(entry.name, bytes, "inbox"));
      } catch (error) { skipped.push(`${entry.name}: ${error instanceof Error ? error.message : String(error)}`); }
      finally { await handle?.close(); }
    }
    return { imported, skipped };
  }

  private blobPath(id: string): string {
    if (!z.uuid().safeParse(id).success) throw new FileValidationError("Invalid file id");
    return join(this.paths.fileBlobsDir, id);
  }
}

function validateHeader(extension: string, bytes: Buffer): void {
  const hex = bytes.subarray(0, 8).toString("hex");
  const ascii = bytes.subarray(0, 12).toString("latin1");
  const matches = extension === ".pdf" ? ascii.startsWith("%PDF-")
    : extension === ".png" ? hex === "89504e470d0a1a0a"
    : [".jpg", ".jpeg"].includes(extension) ? hex.startsWith("ffd8ff")
    : extension === ".gif" ? /^GIF8[79]a/.test(ascii)
    : extension === ".webp" ? ascii.startsWith("RIFF") && ascii.endsWith("WEBP")
    : [".docx", ".xlsx", ".pptx", ".ods", ".odt", ".zip"].includes(extension) ? hex.startsWith("504b0304") || hex.startsWith("504b0506")
    : [".doc", ".xls"].includes(extension) ? hex === "d0cf11e0a1b11ae1"
    : extension === ".rtf" ? ascii.startsWith("{\\rtf") : true;
  if (!matches) throw new FileValidationError(`File header does not match ${extension}`);
}
