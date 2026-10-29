export type JobSource = "google" | "bing" | "indeed" | "linkedin";

export interface JobSearchInput {
  query: string;
  location?: string;
  remote?: boolean;
  source?: JobSource;
}

/** Build an explicit search, without scraping multiple sites or inventing results. */
export function buildJobSearchUrl(input: JobSearchInput): string {
  const query = input.query.trim();
  if (!query) throw new Error("Job search query must not be empty");
  const keywords = [query, input.remote ? "remote" : undefined].filter(Boolean).join(" ");
  const source = input.source ?? "google";
  const location = input.location?.trim();
  if (source === "indeed") {
    const url = new URL("https://www.indeed.com/jobs");
    url.searchParams.set("q", keywords);
    if (location) url.searchParams.set("l", location);
    return url.href;
  }
  if (source === "linkedin") {
    const url = new URL("https://www.linkedin.com/jobs/search/");
    url.searchParams.set("keywords", keywords);
    if (location) url.searchParams.set("location", location);
    if (input.remote) url.searchParams.set("f_WT", "2");
    return url.href;
  }
  const url = new URL(source === "bing" ? "https://www.bing.com/search" : "https://www.google.com/search");
  url.searchParams.set("q", [keywords, "jobs", location].filter(Boolean).join(" "));
  return url.href;
}
