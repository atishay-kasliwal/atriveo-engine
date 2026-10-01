import { htmlToText } from "../core/text.ts";
import type { CompanyBoard, RawPosting } from "../types.ts";
import { fetchBoards, REMOTE_RE, toIso } from "./boards.ts";
import type { Http } from "./http.ts";
import type { Source } from "./types.ts";

// Greenhouse Job Board API: https://developers.greenhouse.io/job-board.html
const API = "https://boards-api.greenhouse.io/v1/boards";

interface GreenhouseJob {
  id: number;
  title: string;
  absolute_url: string;
  location: { name: string } | null;
  first_published?: string | null;
  updated_at: string;
  company_name?: string;
}

interface GreenhouseJobDetail extends GreenhouseJob {
  /** Entity-escaped HTML. */
  content: string;
}

/**
 * The listing is fetched without `content=true`: with it, a large board is
 * about twelve times bigger. Descriptions are loaded per job, and only for
 * postings that pass the title and location filters.
 */
function toPosting(http: Http, board: CompanyBoard, job: GreenhouseJob): RawPosting {
  const location = job.location?.name?.trim() ?? "";
  return {
    source: "greenhouse",
    url: job.absolute_url,
    company: job.company_name?.trim() || board.name,
    title: job.title.trim(),
    location,
    isRemote: REMOTE_RE.test(location),
    postedAt: toIso(job.first_published) ?? toIso(job.updated_at),
    description: null,
    loadDescription: async (signal) => {
      const detail = await http.json<GreenhouseJobDetail>(
        `${API}/${encodeURIComponent(board.token)}/jobs/${job.id}`,
        { signal },
      );
      return detail.content ? htmlToText(detail.content) : null;
    },
  };
}

export const greenhouse: Source = {
  id: "greenhouse",
  fetch: (ctx) =>
    fetchBoards(ctx, async (board) => {
      const data = await ctx.http.json<{ jobs: GreenhouseJob[] }>(
        `${API}/${encodeURIComponent(board.token)}/jobs`,
        { signal: ctx.signal },
      );
      return data.jobs.map((job) => toPosting(ctx.http, board, job));
    }),
};
