import { browserContextFields } from "./context.js";
import type { McpServer } from "@modelcontextprotocol/server";
import { z } from "zod";
import { canonicalizeUrl } from "../applications.js";
import type { Runtime } from "../runtime.js";
import { jsonResult, runtimeTool } from "./result.js";
import { buildJobSearchUrl } from "../jobs/search.js";

interface ExtractedJob {
  title: string;
  company?: string;
  location?: string;
  url?: string;
  datePosted?: string;
  employmentType?: string;
  salary?: string;
  description?: string;
  remote?: boolean;
  validThrough?: string;
  source: "json-ld" | "link";
}

export function registerJobTools(server: McpServer, runtime: Runtime): void {
  server.registerTool(
    "jobs_search",
    {
      title: "Search Jobs By Role And Location",
      description: "Open a job search for a client-supplied role and optional city/region or remote preference. Choose Google, Bing, Indeed, or LinkedIn. Extracts structured postings and relevant links from the loaded page, without claiming links are verified jobs. Search providers may require sign-in or human verification. Does not apply or follow result links automatically.",
      inputSchema: z.object({ ...browserContextFields,
        query: z.string().trim().min(1).max(500),
        location: z.string().trim().max(200).optional(),
        remote: z.boolean().optional(),
        source: z.enum(["google", "bing", "indeed", "linkedin"]).optional(),
        includeDescription: z.boolean().optional(),
        maxJobs: z.number().int().min(1).max(200).optional(),
        maxLinks: z.number().int().min(1).max(500).optional(),
      }),
      annotations: { readOnlyHint: false, openWorldHint: true },
    },
    runtimeTool(runtime, async (input) => {
      const searchUrl = buildJobSearchUrl(input);
      return jsonResult({ search: { ...input, source: input.source ?? "google", url: searchUrl },
        ...await extractJobs(runtime, { ...input, url: searchUrl }) });
    }),
  );
  server.registerTool(
    "jobs_extract",
    {
      title: "Extract Jobs From Page",
      description:
        "Extract job postings from the current page, or navigate to a URL first. Reads schema.org JobPosting JSON-LD and common job-link patterns. Returns a deduplicated list of jobs and links. Use browser_snapshot and browser_click to inspect or open individual postings.",
      inputSchema: z.object({ ...browserContextFields,
        url: z.string().optional().describe("Optional URL to open before extracting"),
        includeDescription: z.boolean().optional().describe("Include a trimmed job description"),
        maxJobs: z.number().int().min(1).max(200).optional(),
        maxLinks: z.number().int().min(1).max(500).optional(),
      }),
      annotations: { readOnlyHint: false, openWorldHint: true },
    },
    runtimeTool(runtime, async (input) => jsonResult(await extractJobs(runtime, input))),
  );
}

export interface ExtractJobsInput {
  url?: string;
  includeDescription?: boolean;
  maxJobs?: number;
  maxLinks?: number;
}

export async function extractJobs(runtime: Runtime, { url, includeDescription, maxJobs, maxLinks }: ExtractJobsInput) {
  if (url) {
    await runtime.browser.navigate(url);
  }

  const page = await runtime.browser.getPage();
  const extracted = await page.evaluate(
    ({ withDescription, jobLimit, linkLimit }) => {
      const normalize = (value: unknown): string =>
        (typeof value === "string" ? value : "").replace(/\s+/g, " ").trim();

      const stripHtml = (value: string): string => {
        const container = document.createElement("div");
        container.innerHTML = value;
        return normalize(container.textContent);
      };

      const absoluteUrl = (value: unknown): string | undefined => {
        if (typeof value !== "string" || value === "") {
          return undefined;
        }
        try {
          const url = new URL(value, window.location.href);
          return ["http:", "https:"].includes(url.protocol) && !url.username && !url.password ? url.href : undefined;
        } catch {
          return undefined;
        }
      };

      const addressText = (value: unknown): string | undefined => {
        if (!value || typeof value !== "object") {
          return undefined;
        }

        const record = value as Record<string, unknown>;
        const address =
          record.address && typeof record.address === "object"
            ? (record.address as Record<string, unknown>)
            : record;

        const parts = [
          address.addressLocality,
          address.addressRegion,
          address.addressCountry &&
          typeof address.addressCountry === "object"
            ? (address.addressCountry as Record<string, unknown>).name
            : address.addressCountry,
        ]
          .filter((part): part is string => typeof part === "string" && part.trim() !== "")
          .map(normalize);

        return parts.length > 0 ? parts.join(", ") : undefined;
      };

      const salaryText = (value: unknown): string | undefined => {
        if (!value || typeof value !== "object") {
          return undefined;
        }

        const record = value as Record<string, unknown>;
        const quantity = record.value && typeof record.value === "object"
          ? record.value as Record<string, unknown> : undefined;
        const amount =
          record.value && typeof record.value === "object"
            ? (record.value as Record<string, unknown>).value
            : record.value;
        const currency =
          record.currency ??
          (record.value && typeof record.value === "object"
            ? (record.value as Record<string, unknown>).currency
            : undefined);

        const range = quantity && (quantity.minValue !== undefined || quantity.maxValue !== undefined)
          ? [quantity.minValue, quantity.maxValue].filter((part) => typeof part === "number" || typeof part === "string").join(" - ")
          : typeof amount === "number" || typeof amount === "string" ? String(amount) : undefined;
        if (range === undefined && currency === undefined) {
          return undefined;
        }

        return [range, currency, quantity?.unitText].filter((part) => typeof part === "string" && part.length > 0).join(" ") || undefined;
      };

      const jobs: Array<Record<string, unknown>> = [];
      const seenJobs = new Set<string>();

      const addJobPosting = (node: Record<string, unknown>): void => {
        if (jobs.length >= jobLimit) {
          return;
        }

        const types = Array.isArray(node["@type"]) ? node["@type"] : [node["@type"]];
        if (!types.includes("JobPosting")) {
          return;
        }

        const title = normalize(
          typeof node.title === "string" ? node.title : undefined,
        );
        if (!title) {
          return;
        }

        const hiringOrganization = node.hiringOrganization;
        const company =
          hiringOrganization && typeof hiringOrganization === "object"
            ? normalize(
                (hiringOrganization as Record<string, unknown>).name as string | undefined,
              )
            : undefined;

        const locations = Array.isArray(node.jobLocation) ? node.jobLocation : [node.jobLocation];
        const location = locations.map(addressText).filter(Boolean).join("; ") || undefined;
        const postingUrl =
          absoluteUrl(node.url) ??
          absoluteUrl(
            node.mainEntityOfPage && typeof node.mainEntityOfPage === "object"
              ? (node.mainEntityOfPage as Record<string, unknown>)["@id"]
              : node.mainEntityOfPage,
          );

        const key = `${title.toLowerCase()}|${(company ?? "").toLowerCase()}|${postingUrl ?? ""}`;
        if (seenJobs.has(key)) {
          return;
        }
        seenJobs.add(key);

        const description =
          withDescription && typeof node.description === "string"
            ? stripHtml(node.description).slice(0, 4000)
            : undefined;

        jobs.push({
          title,
          company,
          location,
          url: postingUrl,
          datePosted: typeof node.datePosted === "string" ? node.datePosted : undefined,
          employmentType: Array.isArray(node.employmentType)
            ? node.employmentType.join(", ")
            : typeof node.employmentType === "string"
              ? node.employmentType
              : undefined,
          salary: salaryText(node.baseSalary),
          remote: node.jobLocationType === "TELECOMMUTE",
          validThrough: typeof node.validThrough === "string" ? node.validThrough : undefined,
          description,
          source: "json-ld",
        });
      };

      let visited = 0;
      const visit = (value: unknown, depth = 0): void => {
        if (!value || jobs.length >= jobLimit || depth > 15 || ++visited > 10_000) {
          return;
        }

        if (Array.isArray(value)) {
          for (const entry of value) {
            visit(entry, depth + 1);
          }
          return;
        }

        if (typeof value !== "object") {
          return;
        }

        const record = value as Record<string, unknown>;
        addJobPosting(record);

        for (const entry of Object.values(record)) {
          if (entry && typeof entry === "object") visit(entry, depth + 1);
        }
      };

      for (const script of Array.from(
        document.querySelectorAll('script[type="application/ld+json"]'),
      )) {
        try {
          visit(JSON.parse(script.textContent ?? ""));
        } catch {
          continue;
        }
      }

      const jobLinkPattern = /(job|jobs|career|careers|position|positions|opening|openings|apply|vacancy|role)/i;
      const links: Array<{ text: string; href: string }> = [];
      const seenLinks = new Set<string>();

      for (const anchor of Array.from(document.querySelectorAll("a[href]"))) {
        if (links.length >= linkLimit) {
          break;
        }

        const href = absoluteUrl((anchor as HTMLAnchorElement).href);
        const text = normalize((anchor as HTMLAnchorElement).innerText).slice(0, 300);
        if (!href || !text) {
          continue;
        }

        if (!jobLinkPattern.test(href) && !jobLinkPattern.test(text)) {
          continue;
        }

        const key = href.toLowerCase();
        if (seenLinks.has(key)) {
          continue;
        }
        seenLinks.add(key);
        links.push({ text, href });
      }

      return {
        jobs,
        links,
        textSnippet: normalize(document.body?.innerText).slice(0, 2000),
      };
    },
    {
      withDescription: includeDescription ?? false,
      jobLimit: maxJobs ?? 50,
      linkLimit: maxLinks ?? 200,
    },
  );

  const deduped = dedupeJobs(extracted.jobs as unknown as ExtractedJob[]);
  const verification = await runtime.browser.humanVerificationCheck();

  return {
    ok: true,
    url: page.url(),
    title: await page.title().catch(() => ""),
    count: deduped.length,
    jobs: deduped,
    links: extracted.links,
    textSnippet: extracted.textSnippet,
    verification,
    requiresHuman: verification.detected,
  };
}

function dedupeJobs(jobs: ExtractedJob[]): ExtractedJob[] {
  const seen = new Set<string>();
  const output: ExtractedJob[] = [];

  for (const job of jobs) {
    const key = job.url
      ? canonicalizeUrl(job.url)
      : `${job.title.toLowerCase()}|${(job.company ?? "").toLowerCase()}`;
    if (seen.has(key)) {
      continue;
    }
    seen.add(key);
    output.push(job);
  }

  return output;
}
