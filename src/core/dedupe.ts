import type { RawPosting, SourceId } from "../types.ts";
import { normalizeCompany } from "./company.ts";

const TRACKING_PARAM = /^(utm_|gh_src$|source$|ref$|lever-source|lever-origin)/i;

/**
 * The URL that identifies a posting. Only tracking parameters are dropped:
 * Greenhouse links on company sites are `/jobs?gh_jid=123`, so stripping the
 * whole query would merge every job at that company into one.
 */
export function canonicalUrl(url: string): string {
  try {
    const u = new URL(url);
    u.hash = "";
    u.hostname = u.hostname.toLowerCase();
    for (const key of [...u.searchParams.keys()]) if (TRACKING_PARAM.test(key)) u.searchParams.delete(key);
    u.searchParams.sort();
    const path = u.pathname.replace(/\/+$/, "") || "/";
    return `${u.protocol}//${u.host}${path}${u.search}`;
  } catch {
    return url.trim();
  }
}

/** Title normalized the way job-pipeline's _normalize_title does: no years or punctuation. */
export function normalizeTitle(title: string): string {
  return title
    .toLowerCase()
    .replace(/\b20\d{2}\b/g, "")
    .replace(/[^\w\s]/g, " ")
    .replace(/\s+/g, " ")
    .trim();
}

/** Same role at the same company in the same place, whichever site listed it. */
export function fuzzyKey(p: Pick<RawPosting, "title" | "company" | "location">): string {
  const loc = p.location
    .toLowerCase()
    .replace(/[^\w\s]/g, " ")
    .replace(/\s+/g, " ")
    .trim();
  return `${normalizeTitle(p.title)}|${normalizeCompany(p.company)}|${loc}`;
}

// When two sources list the same posting, keep the company's own board.
const PRIORITY: Record<SourceId, number> = { greenhouse: 0, lever: 0, ashby: 0, arbeitnow: 1, remotive: 2 };

/** Drops duplicate postings by canonical URL, then by title + company + location. */
export function dedupe(postings: RawPosting[]): RawPosting[] {
  const sorted = [...postings].sort((a, b) => PRIORITY[a.source] - PRIORITY[b.source]);
  const seenUrl = new Set<string>();
  const seenKey = new Set<string>();
  const out: RawPosting[] = [];
  for (const p of sorted) {
    const url = canonicalUrl(p.url);
    const key = fuzzyKey(p);
    if (seenUrl.has(url) || seenKey.has(key)) continue;
    seenUrl.add(url);
    seenKey.add(key);
    out.push({ ...p, url });
  }
  return out;
}
