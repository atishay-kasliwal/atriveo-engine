import { normalizeCompany } from "../core/company.ts";
import type { AtsId, CompanyBoard } from "../types.ts";
import { type Http, HttpError } from "./http.ts";

// Guesses a company's public job board from its name. Greenhouse boards are
// confirmed by the name they report. Lever and Ashby boards report no name,
// so at least a third of their postings must mention the company (a
// "linkedin" Lever board belongs to someone else).

/** Trailing words a company often leaves out of its board token ("Scale AI" → "scale"). */
const DROPPABLE_TAIL = new Set(["ai", "labs", "lab", "hq", "io", "ml", "app"]);

export function slugCandidates(company: string): string[] {
  const plain = company
    .toLowerCase()
    .replace(/&/g, " and ")
    .replace(/[^a-z0-9\s]/g, " ")
    .split(/\s+/)
    .filter(Boolean);
  const stripped = normalizeCompany(company).split(" ").filter(Boolean);
  const out = new Set<string>();
  for (const words of [plain, stripped]) {
    if (!words.length) continue;
    out.add(words.join(""));
    out.add(words.join("-"));
    if (words.length > 1 && DROPPABLE_TAIL.has(words[words.length - 1] as string)) {
      out.add(words.slice(0, -1).join(""));
      out.add(words.slice(0, -1).join("-"));
    }
  }
  return [...out].filter((s) => s.length >= 3);
}

/** True when enough postings name the company, for boards that don't report a name. */
export function mentionsCompany(texts: string[], company: string): boolean {
  const word = normalizeCompany(company)
    .split(" ")
    .find((w) => !DROPPABLE_TAIL.has(w));
  if (!word || !texts.length) return false;
  const re = new RegExp(`\\b${word}`, "i");
  return texts.filter((t) => re.test(t.replace(/[^a-z0-9\s]/gi, ""))).length / texts.length >= 1 / 3;
}

export function sameCompany(a: string, b: string): boolean {
  const x = normalizeCompany(a);
  const y = normalizeCompany(b);
  if (!x || !y) return false;
  return x === y || x.startsWith(`${y} `) || y.startsWith(`${x} `);
}

async function getJson<T>(http: Http, url: string, signal: AbortSignal): Promise<T | null> {
  try {
    return await http.json<T>(url, { signal });
  } catch (e) {
    if (e instanceof HttpError && (e.status === 404 || e.status === 400)) return null;
    throw e;
  }
}

type Probe = (http: Http, token: string, company: string, signal: AbortSignal) => Promise<boolean>;

const PROBES: Record<AtsId, Probe> = {
  async greenhouse(http, token, company, signal) {
    const base = `https://boards-api.greenhouse.io/v1/boards/${token}`;
    const board = await getJson<{ name?: string }>(http, base, signal);
    if (!board?.name || !sameCompany(board.name, company)) return false;
    const list = await getJson<{ jobs: unknown[] }>(http, `${base}/jobs`, signal);
    return (list?.jobs.length ?? 0) > 0;
  },
  async ashby(http, token, company, signal) {
    const board = await getJson<{ jobs: { isListed?: boolean; descriptionPlain?: string }[] }>(
      http,
      `https://api.ashbyhq.com/posting-api/job-board/${token}`,
      signal,
    );
    const listed = board?.jobs.filter((j) => j.isListed !== false) ?? [];
    return mentionsCompany(
      listed.map((j) => j.descriptionPlain ?? ""),
      company,
    );
  },
  async lever(http, token, company, signal) {
    const postings = await getJson<{ descriptionPlain?: string; additionalPlain?: string }[]>(
      http,
      `https://api.lever.co/v0/postings/${token}?mode=json`,
      signal,
    );
    return (
      Array.isArray(postings) &&
      mentionsCompany(
        postings.map((p) => `${p.descriptionPlain ?? ""} ${p.additionalPlain ?? ""}`),
        company,
      )
    );
  },
};

/** The first public board found for `company`, trying Greenhouse, then Ashby, then Lever. */
export async function discoverBoard(
  http: Http,
  company: string,
  signal: AbortSignal,
): Promise<CompanyBoard | null> {
  const slugs = slugCandidates(company);
  for (const ats of ["greenhouse", "ashby", "lever"] as const) {
    for (const token of slugs) {
      if (await PROBES[ats](http, token, company, signal)) return { name: company, ats, token };
    }
  }
  return null;
}

/** Whether a board exists and has postings; for Greenhouse also its display name. */
export async function inspectBoard(
  http: Http,
  board: Pick<CompanyBoard, "ats" | "token">,
  signal: AbortSignal,
): Promise<{ exists: boolean; name: string | null; postings: number }> {
  const token = encodeURIComponent(board.token);
  if (board.ats === "greenhouse") {
    const base = `https://boards-api.greenhouse.io/v1/boards/${token}`;
    const meta = await getJson<{ name?: string }>(http, base, signal);
    if (!meta) return { exists: false, name: null, postings: 0 };
    const list = await getJson<{ jobs: unknown[] }>(http, `${base}/jobs`, signal);
    return { exists: true, name: meta.name?.trim() || null, postings: list?.jobs.length ?? 0 };
  }
  const url =
    board.ats === "lever"
      ? `https://api.lever.co/v0/postings/${token}?mode=json`
      : `https://api.ashbyhq.com/posting-api/job-board/${token}`;
  const data = await getJson<unknown[] | { jobs: unknown[] }>(http, url, signal);
  if (!data) return { exists: false, name: null, postings: 0 };
  return { exists: true, name: null, postings: Array.isArray(data) ? data.length : data.jobs.length };
}
