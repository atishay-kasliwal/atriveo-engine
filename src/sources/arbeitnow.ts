import { htmlToText } from "../core/text.ts";
import type { RawPosting } from "../types.ts";
import { REMOTE_RE, toIso } from "./boards.ts";
import type { Source } from "./types.ts";

// Arbeitnow job board API: https://www.arbeitnow.com/blog/job-board-api
//
// Free and keyless; the terms ask for a link back and no abuse. Postings keep
// their Arbeitnow URL and attribution. The feed updates hourly and is sorted
// newest first, so one page (a few hundred jobs) per run is enough.
const API = "https://www.arbeitnow.com/api/job-board-api";
const CACHE_MS = 55 * 60 * 1000;
export const ARBEITNOW_PAGES = 1;

interface ArbeitnowJob {
  url: string;
  company_name: string;
  title: string;
  description: string;
  remote: boolean;
  location: string;
  /** Unix seconds. */
  created_at: number;
}

interface ArbeitnowPage {
  data: ArbeitnowJob[];
  links: { next: string | null };
}

function toPosting(job: ArbeitnowJob): RawPosting {
  const location = job.location.trim();
  return {
    source: "arbeitnow",
    url: job.url,
    company: job.company_name.trim(),
    title: job.title.trim(),
    location,
    isRemote: job.remote || REMOTE_RE.test(location),
    postedAt: toIso(job.created_at * 1000),
    description: htmlToText(job.description) || null,
    attribution: "Arbeitnow",
  };
}

export const arbeitnow: Source = {
  id: "arbeitnow",
  async fetch(ctx) {
    const postings: RawPosting[] = [];
    for (let page = 1; page <= ARBEITNOW_PAGES; page += 1) {
      const data = await ctx.http.json<ArbeitnowPage>(`${API}?page=${page}`, {
        signal: ctx.signal,
        cacheMs: CACHE_MS,
      });
      postings.push(...data.data.map(toPosting));
      if (!data.links.next) break;
    }
    return { postings, failed: [], warnings: [], ok: true };
  },
};
