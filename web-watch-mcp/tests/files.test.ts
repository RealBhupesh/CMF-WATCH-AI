import { mkdtemp, readFile, rm, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { loadConfig } from "../src/config.js";
import { FileStore } from "../src/files.js";
import { createPaths, ensurePaths, type AppPaths } from "../src/paths.js";

let directory: string;
let paths: AppPaths;
let store: FileStore;
beforeEach(async () => {
  directory = await mkdtemp(join(tmpdir(), "business-files-"));
  const config = loadConfig("stdio", { DATA_DIR: directory });
  paths = createPaths(config);
  await ensurePaths(paths);
  store = new FileStore(paths, config.limits);
});
afterEach(async () => { await rm(directory, { recursive: true, force: true }); });

describe("managed document storage", () => {
  it("preserves names and bytes across chunks and restarts", async () => {
    const bytes = Buffer.from("invoice,total\n123,4500\n");
    const file = await store.save("../../receipts.csv", bytes.toString("base64"));
    expect(file.filename).toBe("receipts.csv");
    const buffers: Buffer[] = []; let offset: number | null = 0;
    do {
      const chunk = await store.read(file.id, offset, 5);
      buffers.push(Buffer.from(chunk.base64, "base64"));
      if (chunk.nextOffset === null) break;
      offset = chunk.nextOffset;
    } while (offset !== null);
    expect(Buffer.concat(buffers)).toEqual(bytes);
    const reopened = new FileStore(paths, loadConfig("stdio", {}).limits);
    expect((await reopened.get(file.id)).sha256).toBe(file.sha256);
    expect((await reopened.uploadPayload(file.id)).name).toBe("receipts.csv");
    await reopened.delete(file.id);
    await expect(readFile(join(paths.fileBlobsDir, file.id))).rejects.toThrow();
    await expect(reopened.get(file.id)).rejects.toThrow(/not found/);
  });

  it("rejects malformed base64, executable types, header mismatches and traversal IDs", async () => {
    await expect(store.save("file.txt", "abc")).rejects.toThrow(/base64/);
    await expect(store.save("file.txt", "AB==")).rejects.toThrow(/canonical/);
    await expect(store.save("file.exe", "aGVsbG8=")).rejects.toThrow(/Unsupported/);
    await expect(store.save("file.pdf", "aGVsbG8=")).rejects.toThrow(/header/);
    await expect(store.read("../../secret")).rejects.toThrow(/not found/);
  });

  it("bounds file and total storage sizes even for concurrent imports", async () => {
    store = new FileStore(paths, { ...loadConfig("stdio", {}).limits, maxUploadBytes: 12, maxStoredFilesBytes: 15 });
    await expect(store.saveBuffer("big.txt", Buffer.alloc(13), "upload")).rejects.toThrow(/bytes/);
    const results = await Promise.allSettled([store.saveBuffer("a.txt", Buffer.alloc(10), "upload"), store.saveBuffer("b.txt", Buffer.alloc(10), "upload")]);
    expect(results.filter((result) => result.status === "fulfilled")).toHaveLength(1);
    expect(await store.list()).toHaveLength(1);
  });

  it("imports regular inbox documents once and skips symlinks", async () => {
    await writeFile(join(paths.fileInboxDir, "invoice.txt"), "Invoice 123");
    await writeFile(join(directory, "outside.txt"), "Private file");
    await symlink(join(directory, "outside.txt"), join(paths.fileInboxDir, "linked.txt"));
    expect((await store.scanInbox()).imported).toHaveLength(1);
    expect((await store.scanInbox()).imported).toHaveLength(0);
    expect(await store.list()).toHaveLength(1);
    expect(await readFile(join(paths.fileInboxDir, "invoice.txt"), "utf8")).toBe("Invoice 123");
  });

  it("detects modified bytes before upload and refuses symlink blobs", async () => {
    const file = await store.save("invoice.txt", Buffer.from("Invoice 123").toString("base64"));
    const blob = join(paths.fileBlobsDir, file.id);
    await writeFile(blob, "Invoice 456");
    await expect(store.uploadPayload(file.id)).rejects.toThrow(/integrity/);
    await rm(blob);
    await symlink(join(directory, "private.txt"), blob);
    await expect(store.read(file.id)).rejects.toThrow();
  });
});
