import companiesJson from "../../data/companies.json" with { type: "json" };
import type { EngineConfig } from "../config.ts";
import type { AtsId, CompanyBoard, RawPosting } from "../types.ts";
import { HttpError, mapPool } from "./http.ts";
import type { SourceContext, SourceResult } from "./types.ts";

/** Company boards found by scripts/discover-companies.ts, bundled into the binary. */
export const BUNDLED_BOARDS: readonly CompanyBoard[] = companiesJson as CompanyBoard[];

/** Bundled boards (unless turned off) plus the user's, without duplicates. */
export function boardsFor(config: Pick<EngineConfig, "companies" | "useBundledCompanies">): CompanyBoard[] {
  const seen = new Set<string>();
  const out: CompanyBoard[] = [];
  for (const board of [...config.companies, ...(config.useBundledCompanies ? BUNDLED_BOARDS : [])]) {
    const key = `${board.ats}:${board.token.toLowerCase()}`;
    if (seen.has(key)) continue;
    seen.add(key);
    out.push(board);
  }
  return out;
}

const BOARD_HOSTS: { ats: AtsId; host: RegExp; token: (u: URL) => string | undefined }[] = [
  {
    ats: "greenhouse",
    host: /^(boards|job-boards)\.greenhouse\.io$/,
    token: (u) => u.searchParams.get("for") ?? u.pathname.split("/").find((p) => p && p !== "embed"),
  },
  { ats: "greenhouse", host: /^boards-api\.greenhouse\.io$/, token: (u) => u.pathname.split("/")[3] },
  { ats: "lever", host: /^jobs\.lever\.co$/, token: (u) => u.pathname.split("/")[1] },
  { ats: "lever", host: /^api\.lever\.co$/, token: (u) => u.pathname.split("/")[3] },
  { ats: "ashby", host: /^jobs\.ashbyhq\.com$/, token: (u) => u.pathname.split("/")[1] },
  { ats: "ashby", host: /^api\.ashbyhq\.com$/, token: (u) => u.pathname.split("/")[3] },
];

/**
 * The ATS and board token behind a careers URL such as
 * https://boards.greenhouse.io/acme, https://jobs.lever.co/acme or
 * https://jobs.ashbyhq.com/acme. Null for anything else.
 */
export function parseBoardUrl(input: string): { ats: AtsId; token: string } | null {
  let url: URL;
  try {
    url = new URL(/^https?:\/\//i.test(input) ? input : `https://${input}`);
  } catch {
    return null;
  }
  const host = url.hostname.toLowerCase();
  for (const rule of BOARD_HOSTS) {
    if (!rule.host.test(host)) continue;
    const token = rule.token(url);
    if (token && /^[\w.-]+$/.test(token)) return { ats: rule.ats, token: decodeURIComponent(token) };
  }
  return null;
}

/**
 * Reads every board with bounded concurrency. One board failing doesn't fail
 * the source; it's reported so its jobs can be carried forward. A 404 means the
 * board is gone, so its jobs are left to close.
 */
export async function fetchBoards(
  ctx: SourceContext,
  fetchOne: (board: CompanyBoard) => Promise<RawPosting[]>,
): Promise<SourceResult> {
  const result: SourceResult = { postings: [], failed: [], warnings: [], ok: true };
  await mapPool(
    ctx.boards,
    ctx.concurrency,
    async (board) => {
      try {
        result.postings.push(...(await fetchOne(board)));
      } catch (e) {
        if (ctx.signal.aborted) throw ctx.signal.reason;
        if (e instanceof HttpError && e.status === 404) {
          result.warnings.push(`${board.name}: no ${board.ats} board "${board.token}"`);
        } else {
          result.failed.push({ company: board.name, error: (e as Error).message });
        }
      }
    },
    ctx.signal,
  );
  result.ok = ctx.boards.length === 0 || result.failed.length < ctx.boards.length;
  return result;
}

/** Milliseconds or an ISO string to ISO-8601 UTC, or null when unparseable. */
export function toIso(value: string | number | null | undefined): string | null {
  if (value === null || value === undefined || value === "") return null;
  const ms = typeof value === "number" ? value : Date.parse(value);
  return Number.isFinite(ms) ? new Date(ms).toISOString() : null;
}

export const REMOTE_RE = /\bremote\b/i;
