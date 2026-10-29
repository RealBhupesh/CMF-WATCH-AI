import type { McpServer } from "@modelcontextprotocol/server";
import { z } from "zod";
import type { Runtime } from "../runtime.js";
import { browserContextFields } from "./context.js";
import { jsonResult, runtimeTool } from "./result.js";

const target = { ref: z.string().optional(), selector: z.string().optional(), text: z.string().optional(), frame: z.string().optional() };

export function registerFileTools(server: McpServer, runtime: Runtime): void {
  server.registerTool("file_save", {
    title: "Save A Document",
    description: "Save client-supplied document bytes (canonical padded base64) to the private managed file store. Supports PDFs, Office/OpenDocument files, text/CSV/JSON, common images, and ZIP. Enforces size, header checks, and storage quota. Never reads arbitrary filesystem paths or executes files. Returns a fileId for uploads and reads.",
    inputSchema: z.object({ filename: z.string().min(1).max(500), base64: z.string().min(1) }),
    annotations: { readOnlyHint: false, openWorldHint: false },
  }, runtimeTool(runtime, async ({ filename, base64 }) => jsonResult({ ok: true, file: await runtime.files.save(filename, base64) })));

  server.registerTool("file_list", {
    title: "List Managed Documents",
    description: "List saved uploads and browser downloads with IDs, filenames, sizes, hashes, and origin. Files are shared by the single owner across browser sessions.",
    inputSchema: z.object({}), annotations: { readOnlyHint: true, openWorldHint: false },
  }, runtimeTool(runtime, async () => jsonResult({ ok: true, files: await runtime.files.list() })));

  server.registerTool("file_read", {
    title: "Read Document Bytes",
    description: "Read a saved file by ID as base64 in bounded chunks (default 256 KiB, maximum 1 MiB). Decode each chunk separately before concatenating bytes. Follow nextOffset until null. This returns bytes, not parsed document text.",
    inputSchema: z.object({ id: z.uuid(), offset: z.number().int().min(0).optional(), length: z.number().int().min(1).max(1024 * 1024).optional() }),
    annotations: { readOnlyHint: true, openWorldHint: false },
  }, runtimeTool(runtime, async ({ id, offset, length }) => jsonResult({ ok: true, ...await runtime.files.read(id, offset, length) })));

  server.registerTool("file_delete", {
    title: "Delete A Managed Document",
    description: "Delete one managed document and its bytes by ID. Does not delete the original local inbox file or remote website copy.",
    inputSchema: z.object({ id: z.uuid() }), annotations: { readOnlyHint: false, destructiveHint: true, openWorldHint: false },
  }, runtimeTool(runtime, async ({ id }) => jsonResult({ ok: true, deleted: await runtime.files.delete(id) })));

  server.registerTool("file_scan", {
    title: "Import Document Inbox",
    description: "Import regular files placed by the owner in DATA_DIR/files/inbox. Skips symlinks, unsupported types, duplicates, and oversized files. Does not accept arbitrary paths.",
    inputSchema: z.object({}), annotations: { readOnlyHint: false, openWorldHint: false },
  }, runtimeTool(runtime, async () => jsonResult({ ok: true, ...await runtime.files.scanInbox(), inbox: runtime.paths.fileInboxDir })));

  server.registerTool("browser_upload_file", {
    title: "Upload A Business Document",
    description: "Upload a managed document by fileId to a file input or upload button in the selected session/tab. Verifies saved bytes against the recorded hash and preserves the original filename. Refuses during human verification. Does not submit the form.",
    inputSchema: z.object({ ...browserContextFields, ...target, fileId: z.uuid() }),
    annotations: { readOnlyHint: false, openWorldHint: true },
  }, runtimeTool(runtime, async (input) => {
    const payload = await runtime.files.uploadPayload(input.fileId);
    const result = await runtime.browser.uploadFile(input, payload);
    return jsonResult({ ok: true, file: await runtime.files.get(input.fileId), ...result, requiresHuman: result.snapshot.verification.detected });
  }));

  server.registerTool("browser_download", {
    title: "Download A Document From A Page",
    description: "Click one explicitly chosen download control and save the resulting browser download to the managed file store. Preserves authenticated browser cookies. Use this instead of browser_click for download links. Saved bytes must meet document type, size, and storage limits. Download timeouts may mean the click already happened; inspect before retrying. Does not execute files.",
    inputSchema: z.object({ ...browserContextFields, ...target, timeoutMs: z.number().int().min(100).max(120_000).optional() }),
    annotations: { readOnlyHint: false, openWorldHint: true },
  }, runtimeTool(runtime, async (input) => {
    const downloaded = await runtime.browser.downloadFile(input, input.timeoutMs);
    const file = await runtime.files.saveBuffer(downloaded.filename, downloaded.buffer, "download", { sessionId: downloaded.sessionId, tabId: downloaded.tabId });
    const snapshot = await runtime.browser.snapshot({ includeText: false });
    return jsonResult({ ok: true, file, snapshot, requiresHuman: snapshot.verification.detected });
  }));
}
