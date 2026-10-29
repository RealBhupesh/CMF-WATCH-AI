import { createHash, randomUUID } from "node:crypto";
import { z } from "zod";
import { JsonlFile } from "./storage/jsonl-file.js";

const statusSchema = z.enum([
  "submitted",
  "confirmed",
  "needs_human",
  "needs_review",
  "awaiting_confirmation",
  "failed",
]);

export type ApplicationStatus = z.infer<typeof statusSchema>;

const applicationSchema = z.object({
  id: z.string(),
  submittedAt: z.string(),
  url: z.string(),
  canonicalUrl: z.string(),
  company: z.string(),
  title: z.string(),
  location: z.string().optional(),
  resumeId: z.string().optional(),
  resumeName: z.string().optional(),
  status: statusSchema,
  dedupeKey: z.string(),
  confirmation: z.string().optional(),
  notes: z.string().optional(),
});

export type ApplicationRecord = z.infer<typeof applicationSchema>;

export interface NewApplication {
  url: string;
  company: string;
  title: string;
  location?: string;
  resumeId?: string;
  resumeName?: string;
  status: ApplicationStatus;
  confirmation?: string;
  notes?: string;
}

export interface ApplicationStats {
  total: number;
  last30Days: number;
  byStatus: Record<string, number>;
  lastSubmittedAt?: string;
}

const TRACKING_PARAMETERS = new Set([
  "utm_source",
  "utm_medium",
  "utm_campaign",
  "utm_term",
  "utm_content",
  "utm_id",
  "gclid",
  "fbclid",
  "msclkid",
  "mc_cid",
  "mc_eid",
  "ref",
  "referrer",
  "source",
]);

export class ApplicationStore {
  private readonly file: JsonlFile<ApplicationRecord>;

  constructor(filePath: string) {
    this.file = new JsonlFile(filePath, applicationSchema);
  }

  async record(input: NewApplication, allowDuplicate = false): Promise<{ record: ApplicationRecord; duplicate?: ApplicationRecord }> {
    const canonicalUrl = canonicalizeUrl(input.url);
    const dedupeKey = makeDedupeKey(canonicalUrl, input.company, input.title);
    const existing = await this.findByDedupeKey(dedupeKey);

    if (existing && !allowDuplicate) {
      return { record: existing, duplicate: existing };
    }

    const record: ApplicationRecord = {
      id: randomUUID(),
      submittedAt: new Date().toISOString(),
      url: input.url,
      canonicalUrl,
      company: input.company.trim(),
      title: input.title.trim(),
      location: input.location?.trim() || undefined,
      resumeId: input.resumeId,
      resumeName: input.resumeName,
      status: input.status,
      dedupeKey,
      confirmation: input.confirmation?.slice(0, 2000),
      notes: input.notes?.slice(0, 2000),
    };

    await this.file.append(record);
    return { record };
  }

  async list(limit = 50): Promise<ApplicationRecord[]> {
    const records = await this.readLatest();
    return records.slice(-Math.max(1, limit)).reverse();
  }

  async findByDedupeKey(dedupeKey: string): Promise<ApplicationRecord | undefined> {
    const records = await this.readLatest();
    return records.findLast((record) => record.dedupeKey === dedupeKey);
  }

  async findMatches(input: {
    url?: string;
    company?: string;
    title?: string;
  }): Promise<ApplicationRecord[]> {
    const records = await this.readLatest();
    const canonicalUrl = input.url ? canonicalizeUrl(input.url) : undefined;
    const company = input.company?.trim().toLowerCase();
    const title = input.title?.trim().toLowerCase();

    return records
      .filter((record) => {
        if (canonicalUrl && record.canonicalUrl === canonicalUrl) {
          return true;
        }
        if (company && record.company.toLowerCase() === company) {
          if (!title || record.title.toLowerCase() === title) {
            return true;
          }
        }
        return false;
      })
      .reverse();
  }

  async stats(): Promise<ApplicationStats> {
    const records = await this.readLatest();
    const cutoff = Date.now() - 30 * 86_400_000;
    const byStatus: Record<string, number> = {};

    for (const record of records) {
      byStatus[record.status] = (byStatus[record.status] ?? 0) + 1;
    }

    return {
      total: records.length,
      last30Days: records.filter(
        (record) => Date.parse(record.submittedAt) >= cutoff,
      ).length,
      byStatus,
      lastSubmittedAt: records.at(-1)?.submittedAt,
    };
  }

  /** Append an observation to the audit trail, keeping the same application attempt id. */
  async updateOutcome(id: string, outcome: Pick<NewApplication, "status" | "confirmation" | "notes">): Promise<ApplicationRecord> {
    const record = (await this.readLatest()).find((entry) => entry.id === id);
    if (!record) throw new Error(`Application not found: ${id}`);
    const updated = { ...record, ...outcome };
    await this.file.append(updated);
    return updated;
  }

  private async readLatest(): Promise<ApplicationRecord[]> {
    const records = await this.file.readAll();
    const latest = new Map<string, ApplicationRecord>();
    for (const record of records) latest.set(record.id, record);
    return [...latest.values()];
  }
}

export function canonicalizeUrl(input: string): string {
  let url: URL;
  try {
    url = new URL(input);
  } catch {
    return input.trim();
  }

  url.hash = "";
  url.hostname = url.hostname.toLowerCase().replace(/^www\./, "");
  url.protocol = url.protocol.toLowerCase();

  const entries = [...url.searchParams.entries()].filter(
    ([key]) => !TRACKING_PARAMETERS.has(key.toLowerCase()) && !key.toLowerCase().startsWith("utm_"),
  );
  entries.sort(([aKey, aValue], [bKey, bValue]) => {
    const keyCompare = aKey.localeCompare(bKey);
    return keyCompare !== 0 ? keyCompare : aValue.localeCompare(bValue);
  });

  url.search = "";
  for (const [key, value] of entries) {
    url.searchParams.append(key, value);
  }

  if (url.pathname.length > 1 && url.pathname.endsWith("/")) {
    url.pathname = url.pathname.slice(0, -1);
  }

  return url.href;
}

export function makeDedupeKey(url: string, company: string, title: string): string {
  const material = [
    canonicalizeUrl(url).toLowerCase(),
    company.trim().toLowerCase(),
    title.trim().toLowerCase(),
  ].join("\n");

  return createHash("sha256").update(material).digest("hex");
}
