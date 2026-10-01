import { htmlToText } from "../core/text.ts";
import type { CompanyBoard, RawPosting } from "../types.ts";
import { fetchBoards, REMOTE_RE, toIso } from "./boards.ts";
import type { Source } from "./types.ts";

// Lever Postings API: https://github.com/lever/postings-api
const API = "https://api.lever.co/v0/postings";

interface LeverPosting {
  id: string;
  text: string;
  hostedUrl: string;
  createdAt: number;
  categories: { location?: string; allLocations?: string[]; commitment?: string; team?: string };
  /** "remote", "hybrid", "onsite", or "unspecified". */
  workplaceType?: string;
  descriptionPlain?: string;
  lists?: { text: string; content: string }[];
  additionalPlain?: string;
}

function description(p: LeverPosting): string {
  const parts = [p.descriptionPlain?.trim()];
  for (const list of p.lists ?? [])
    parts.push(`${list.text.trim()}\n${htmlToText(`<ul>${list.content}</ul>`)}`);
  parts.push(p.additionalPlain?.trim());
  return parts.filter(Boolean).join("\n\n");
}

function toPosting(board: CompanyBoard, p: LeverPosting): RawPosting {
  const all = p.categories.allLocations?.filter(Boolean) ?? [];
  const location = (all.length > 1 ? all.join(" / ") : (p.categories.location ?? all[0] ?? "")).trim();
  return {
    source: "lever",
    url: p.hostedUrl,
    company: board.name,
    title: p.text.trim(),
    location,
    isRemote: p.workplaceType === "remote" || REMOTE_RE.test(location),
    postedAt: toIso(p.createdAt),
    description: description(p) || null,
  };
}

export const lever: Source = {
  id: "lever",
  fetch: (ctx) =>
    fetchBoards(ctx, async (board) => {
      const postings = await ctx.http.json<LeverPosting[]>(
        `${API}/${encodeURIComponent(board.token)}?mode=json`,
        { signal: ctx.signal },
      );
      return postings.map((p) => toPosting(board, p));
    }),
};
