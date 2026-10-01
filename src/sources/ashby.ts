import type { CompanyBoard, RawPosting } from "../types.ts";
import { fetchBoards, REMOTE_RE, toIso } from "./boards.ts";
import type { Source } from "./types.ts";

// Ashby public job postings API: https://developers.ashbyhq.com/docs/public-job-posting-api
const API = "https://api.ashbyhq.com/posting-api/job-board";

interface AshbyJob {
  title: string;
  location: string;
  secondaryLocations?: { location: string }[];
  isRemote: boolean | null;
  /** "OnSite", "Hybrid", "Remote", or null. */
  workplaceType: string | null;
  publishedAt: string;
  isListed: boolean;
  jobUrl: string;
  descriptionPlain?: string;
}

function toPosting(board: CompanyBoard, job: AshbyJob): RawPosting {
  // The primary office is often the HQ; the US or remote option may only be a secondary location.
  const places = [job.location, ...(job.secondaryLocations ?? []).map((s) => s.location)]
    .map((s) => s?.trim())
    .filter(Boolean);
  const location = [...new Set(places)].join(" / ");
  return {
    source: "ashby",
    url: job.jobUrl,
    company: board.name,
    title: job.title.trim(),
    location,
    isRemote: job.isRemote === true || job.workplaceType === "Remote" || REMOTE_RE.test(location),
    postedAt: toIso(job.publishedAt),
    description: job.descriptionPlain?.trim() || null,
  };
}

export const ashby: Source = {
  id: "ashby",
  fetch: (ctx) =>
    fetchBoards(ctx, async (board) => {
      const data = await ctx.http.json<{ jobs: AshbyJob[] }>(`${API}/${encodeURIComponent(board.token)}`, {
        signal: ctx.signal,
      });
      return data.jobs.filter((job) => job.isListed !== false).map((job) => toPosting(board, job));
    }),
};
