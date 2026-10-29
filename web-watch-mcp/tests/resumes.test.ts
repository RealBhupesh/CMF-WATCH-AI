import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { PDFDocument } from "pdf-lib";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { loadConfig } from "../src/config.js";
import { createPaths, ensurePaths, type AppPaths } from "../src/paths.js";
import { ResumeStore, ResumeValidationError } from "../src/resumes.js";

let directory: string;
let paths: AppPaths;
let store: ResumeStore;

beforeEach(async () => {
  directory = await mkdtemp(join(tmpdir(), "job-crawler-resumes-"));
  const config = loadConfig("stdio", { DATA_DIR: directory });
  paths = createPaths(config);
  await ensurePaths(paths);
  store = new ResumeStore(paths, config.limits);
});

afterEach(async () => {
  await rm(directory, { recursive: true, force: true });
});

describe("ResumeStore", () => {
  it("saves a PDF and deduplicates identical content", async () => {
    const content = Buffer.from("%PDF-1.4\n1 0 obj\n<<>>\nendobj\n%%EOF\n");
    const first = await store.save({
      filename: "resume.pdf",
      base64: content.toString("base64"),
    });
    const second = await store.save({
      filename: "resume-copy.pdf",
      base64: content.toString("base64"),
    });

    expect(first.isDefault).toBe(false);
    expect(second.id).toBe(first.id);
    expect(await store.list()).toHaveLength(1);
  });

  it("rejects files with mismatched magic bytes", async () => {
    await expect(
      store.save({
        filename: "fake.pdf",
        base64: Buffer.from("not a pdf").toString("base64"),
      }),
    ).rejects.toBeInstanceOf(ResumeValidationError);
  });

  it("scans the inbox and skips duplicates", async () => {
    await writeFile(join(paths.resumeInboxDir, "resume.docx"), Buffer.from("PK\u0003\u0004docx"));

    const first = await store.scanInbox();
    const second = await store.scanInbox();

    expect(first.imported).toHaveLength(1);
    expect(second.imported).toHaveLength(0);
    expect(second.skipped).toContain("resume.docx");
  });

  it("generates a PDF from resume text", async () => {
    const record = await store.saveText({
      filename: "resume.docx",
      text: [
        "JANE DOE",
        "jane@example.com | +1 555 0100 | https://linkedin.com/in/janedoe",
        "",
        "EXPERIENCE",
        "- Senior Engineer, Acme Corp, 2020-2026",
        "- Built and operated distributed systems",
        "",
        "EDUCATION",
        "BSc Computer Science, Example University",
      ].join("\n"),
    });

    expect(record.originalName).toBe("resume.pdf");
    expect(record.mimeType).toBe("application/pdf");
    expect(record.isDefault).toBe(false);

    const content = await readFile(join(paths.resumeFilesDir, record.storedName));
    expect(content.subarray(0, 5).toString("latin1")).toBe("%PDF-");
  });

  it("deduplicates identical resume text", async () => {
    const first = await store.saveText({ text: "JANE DOE\njane@example.com" });
    const second = await store.saveText({ text: "JANE DOE\njane@example.com" });
    expect(second.id).toBe(first.id);
    expect(await store.list()).toHaveLength(1);
  });

  it("paginates long resume text", async () => {
    const text = [
      "JANE DOE",
      "jane@example.com",
      "",
      "EXPERIENCE",
      ...Array.from({ length: 120 }, (_, index) => `- Role ${index + 1}: delivered measurable results for customers`),
    ].join("\n");

    const record = await store.saveText({ text });
    const content = await readFile(join(paths.resumeFilesDir, record.storedName));
    const pdf = await PDFDocument.load(content);
    expect(pdf.getPageCount()).toBeGreaterThan(1);
  });

  it("rejects empty resume text", async () => {
    await expect(store.saveText({ text: "   " })).rejects.toBeInstanceOf(ResumeValidationError);
  });

  it("changes the default resume", async () => {
    const first = await store.save({
      filename: "one.pdf",
      base64: Buffer.from("%PDF-1.4 one").toString("base64"),
    });
    const second = await store.save({
      filename: "two.pdf",
      base64: Buffer.from("%PDF-1.4 two").toString("base64"),
    });

    await store.setDefault(second.id);
    expect((await store.get())?.id).toBe(second.id);
    expect((await store.list()).find((resume) => resume.id === first.id)?.isDefault).toBe(false);
  });

  it("deletes a resume without selecting a fallback default", async () => {
    await store.save({
      filename: "one.pdf",
      base64: Buffer.from("%PDF-1.4 one").toString("base64"),
    });
    const second = await store.save({
      filename: "two.pdf",
      base64: Buffer.from("%PDF-1.4 two").toString("base64"),
    });

    await store.setDefault(second.id);
    const deleted = await store.delete(second.id);

    expect(deleted.id).toBe(second.id);
    expect(await store.get()).toBeUndefined();
    expect(await store.list()).toHaveLength(1);
    await expect(
      readFile(join(paths.resumeFilesDir, second.storedName)),
    ).rejects.toThrow();
  });
});
