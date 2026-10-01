import { htmlToText } from "../core/text.ts";
import type { RawPosting } from "../types.ts";
import { toIso } from "./boards.ts";
import type { Source } from "./types.ts";

// Remotive public API: https://remotive.com/api-documentation
//
// Its terms ask callers to link back to the Remotive URL, name Remotive as the
// source, not pass jobs on to other job sites, and call at most four times a
// day. So the URL is kept as Remotive's, every posting carries the attribution,
// and the response is cached for six hours.
const URL = "https://remotive.com/api/remote-jobs?category=software-dev";
export const REMOTIVE_CACHE_MS = 6 * 60 * 60 * 1000;

interface RemotiveJob {
  url: string;
  title: string;
  company_name: string;
  /** UTC without a zone suffix, e.g. "2026-09-21T12:55:11". */
  publication_date: string;
  /** Where candidates must be: "USA", "Worldwide", "Europe", ... */
  candidate_required_location: string;
  description: string;
}

function location(required: string): string {
  const place = required.trim();
  // Open to anyone, so label it so a "Remote" location filter lets it through.
  if (!place || /^(worldwide|anywhere)\b/i.test(place)) return "Remote (Worldwide)";
  return place;
}

function toPosting(job: RemotiveJob): RawPosting {
  const published = job.publication_date;
  return {
    source: "remotive",
    url: job.url,
    company: job.company_name.trim(),
    title: job.title.trim(),
    location: location(job.candidate_required_location),
    isRemote: true,
    postedAt: toIso(/[zZ]|[+-]\d\d:?\d\d$/.test(published) ? published : `${published}Z`),
    description: htmlToText(job.description) || null,
    attribution: "Remotive",
  };
}

export const remotive: Source = {
  id: "remotive",
  async fetch(ctx) {
    const data = await ctx.http.json<{ jobs: RemotiveJob[] }>(URL, {
      signal: ctx.signal,
      cacheMs: REMOTIVE_CACHE_MS,
    });
    return { postings: data.jobs.map(toPosting), failed: [], warnings: [], ok: true };
  },
};
