import type { McpServer } from "@modelcontextprotocol/server";
import { z } from "zod";
import { profilePatchSchema } from "../profile.js";
import type { Runtime } from "../runtime.js";
import { jsonResult, runtimeTool } from "./result.js";

export function registerProfileTools(server: McpServer, runtime: Runtime): void {
  server.registerTool(
    "profile_get",
    {
      title: "Get Job Application Profile",
      description:
        "Return exactly the profile the client last stored, plus a list of missing required fields. The server does not infer, enrich, or rewrite profile data.",
      inputSchema: z.object({}),
      annotations: { readOnlyHint: true, openWorldHint: false },
    },
    runtimeTool(runtime, async () => {
      const profile = await runtime.profile.get();
      return jsonResult({
        ok: true,
        profile: profile.profile,
        updatedAt: profile.updatedAt,
        isEmpty: profile.isEmpty,
        missingFields: profile.missingFields,
      });
    }),
  );

  server.registerTool(
    "profile_set",
    {
      title: "Set Complete Profile",
      description:
        "Replace the active profile with the exact structured object supplied by the client. Use this when switching to a different candidate. The server does not merge, infer, or fill missing values.",
      inputSchema: z.object({
        profile: profilePatchSchema.describe("Complete profile object supplied by the client"),
      }),
      annotations: { readOnlyHint: false, destructiveHint: true, openWorldHint: false },
    },
    runtimeTool(runtime, async ({ profile }) => {
      const file = await runtime.profile.update(profile, true);
      const current = await runtime.profile.get();
      return jsonResult({
        ok: true,
        updatedAt: file.updatedAt,
        profile: file.profile,
        missingFields: current.missingFields,
      });
    }),
  );

  server.registerTool(
    "profile_update",
    {
      title: "Update Job Application Profile",
      description:
        "Merge explicit structured fields supplied by the client into the active profile. The server does not infer, extract, or fill missing values. Use profile_set to replace the whole profile when switching candidates.",
      inputSchema: z.object({
        patch: profilePatchSchema.describe("Partial profile fields to merge"),
        replace: z
          .boolean()
          .optional()
          .describe("Replace the entire profile instead of merging (default false)"),
      }),
      annotations: { readOnlyHint: false, destructiveHint: true, openWorldHint: false },
    },
    runtimeTool(runtime, async ({ patch, replace }) => {
      const file = await runtime.profile.update(patch, replace ?? false);
      const profile = await runtime.profile.get();
      return jsonResult({
        ok: true,
        updatedAt: file.updatedAt,
        profile: file.profile,
        missingFields: profile.missingFields,
      });
    }),
  );

  server.registerTool(
    "profile_clear",
    {
      title: "Clear Active Profile",
      description:
        "Delete the active profile from local storage. Use this when a candidate's data should no longer be retained. The server does not keep a backup.",
      inputSchema: z.object({}),
      annotations: { readOnlyHint: false, destructiveHint: true, openWorldHint: false },
    },
    runtimeTool(runtime, async () => {
      const file = await runtime.profile.clear();
      const profile = await runtime.profile.get();
      return jsonResult({
        ok: true,
        updatedAt: file.updatedAt,
        profile: file.profile,
        missingFields: profile.missingFields,
      });
    }),
  );
}
