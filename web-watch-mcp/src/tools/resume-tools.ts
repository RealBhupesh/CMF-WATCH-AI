import type { McpServer } from "@modelcontextprotocol/server";
import { z } from "zod";
import type { Runtime } from "../runtime.js";
import { jsonResult, runtimeTool } from "./result.js";

export function registerResumeTools(server: McpServer, runtime: Runtime): void {
  server.registerTool(
    "resume_list",
    {
      title: "List Resumes",
      description:
        "List resume files saved on this machine. The default resume is used by browser_upload_resume only when the client omits resumeId. The server does not fall back to another resume.",
      inputSchema: z.object({}),
      annotations: { readOnlyHint: true, openWorldHint: false },
    },
    runtimeTool(runtime, async () => {
      const resumes = await runtime.resumes.list();
      return jsonResult({
        ok: true,
        count: resumes.length,
        defaultResumeId: resumes.find((resume) => resume.isDefault)?.id,
        resumes: resumes.map((resume) => ({
          id: resume.id,
          originalName: resume.originalName,
          label: resume.label,
          mimeType: resume.mimeType,
          size: resume.size,
          isDefault: resume.isDefault,
          createdAt: resume.createdAt,
        })),
        inbox: runtime.paths.resumeInboxDir,
      });
    }),
  );

  server.registerTool(
    "resume_save",
    {
      title: "Save Resume File",
      description:
        "Save exactly the base64 file content supplied by the client. Supported types: PDF, DOC, DOCX, RTF, and TXT. Files are stored privately under the local data directory. Use resume_save_text when the client only has text; use resume_scan for a file the client placed in the local inbox.",
      inputSchema: z.object({
        filename: z.string().min(1).describe("Original filename including extension"),
        base64: z.string().min(1).describe("Base64-encoded file content"),
        label: z.string().optional().describe("Optional human-friendly label"),
      }),
      annotations: { readOnlyHint: false, destructiveHint: false, openWorldHint: false },
    },
    runtimeTool(runtime, async ({ filename, base64, label }) => {
      const record = await runtime.resumes.save({ filename, base64, label });
      return jsonResult({
        ok: true,
        resume: {
          id: record.id,
          originalName: record.originalName,
          label: record.label,
          mimeType: record.mimeType,
          size: record.size,
          isDefault: record.isDefault,
        },
      });
    }),
  );

  server.registerTool(
    "resume_save_text",
    {
      title: "Save Resume Text as PDF",
      description:
        "Render exactly the resume text supplied by the client into a local PDF. Use this when the client can read a resume as text but cannot send the original file bytes. The server does not rewrite, enrich, or infer content. The saved resume is not made default automatically.",
      inputSchema: z.object({
        text: z
          .string()
          .min(1)
          .max(100_000)
          .describe("Plain-text resume content, including name, contact details, experience, and education"),
        filename: z
          .string()
          .optional()
          .describe("Optional filename; the server always generates a PDF, for example resume.pdf"),
        label: z.string().optional().describe("Optional human-friendly label"),
      }),
      annotations: { readOnlyHint: false, destructiveHint: false, openWorldHint: false },
    },
    runtimeTool(runtime, async ({ text, filename, label }) => {
      const record = await runtime.resumes.saveText({ text, filename, label });
      return jsonResult({
        ok: true,
        resume: {
          id: record.id,
          originalName: record.originalName,
          label: record.label,
          mimeType: record.mimeType,
          size: record.size,
          isDefault: record.isDefault,
        },
      });
    }),
  );

  server.registerTool(
    "resume_scan",
    {
      title: "Scan Resume Inbox",
      description:
        "Import files the client placed in the local resume inbox folder. Duplicate files are skipped. The server does not read, rewrite, or infer resume contents. Returns the inbox path.",
      inputSchema: z.object({}),
      annotations: { readOnlyHint: false, destructiveHint: false, openWorldHint: false },
    },
    runtimeTool(runtime, async () => {
      const result = await runtime.resumes.scanInbox();
      return jsonResult({
        ok: true,
        inbox: runtime.paths.resumeInboxDir,
        imported: result.imported.map((resume) => ({
          id: resume.id,
          originalName: resume.originalName,
          isDefault: resume.isDefault,
        })),
        skipped: result.skipped,
      });
    }),
  );

  server.registerTool(
    "resume_set_default",
    {
      title: "Set Default Resume",
      description:
        "Explicitly choose which saved resume is uploaded when browser_upload_resume is called without a resumeId. No resume becomes default automatically.",
      inputSchema: z.object({
        id: z.string().min(1).describe("Resume id from resume_list"),
      }),
      annotations: { readOnlyHint: false, destructiveHint: false, openWorldHint: false },
    },
    runtimeTool(runtime, async ({ id }) => {
      const record = await runtime.resumes.setDefault(id);
      return jsonResult({
        ok: true,
        resume: {
          id: record.id,
          originalName: record.originalName,
          label: record.label,
          isDefault: true,
        },
      });
    }),
  );

  server.registerTool(
    "resume_delete",
    {
      title: "Delete Resume",
      description:
        "Permanently delete a saved resume and its local file. Use this when a candidate's resume should no longer be retained. The server does not keep a backup.",
      inputSchema: z.object({
        id: z.string().min(1).describe("Resume id from resume_list"),
      }),
      annotations: { readOnlyHint: false, destructiveHint: true, openWorldHint: false },
    },
    runtimeTool(runtime, async ({ id }) => {
      const record = await runtime.resumes.delete(id);
      return jsonResult({
        ok: true,
        deleted: {
          id: record.id,
          originalName: record.originalName,
          label: record.label,
        },
      });
    }),
  );
}
