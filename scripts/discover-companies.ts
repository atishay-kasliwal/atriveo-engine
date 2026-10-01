// Finds which of the companies in data/top_500_companies.csv publish a public
// Greenhouse, Lever, or Ashby job board, and writes data/companies.json.
//
//   bun scripts/discover-companies.ts
//
// A maintainer runs this now and then and commits the result; CI never does.
// Matching is by board token guessed from the company name, so it is a
// heuristic: Greenhouse boards are confirmed by the name they report. Lever and
// Ashby boards report no name, so at least a third of their postings must
// mention the company (a "linkedin" Lever board belongs to someone else).
// Anything missed can be added with `atriveo companies add <careers-url>`.

import { readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { normalizeCompany } from "../src/core/company.ts";
import { Http, HttpError, mapPool } from "../src/sources/http.ts";
import type { AtsId, CompanyBoard } from "../src/types.ts";

const ROOT = join(import.meta.dir, "..");
const http = new Http({ retries: 2 });
const signal = new AbortController().signal;

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
function mentionsCompany(texts: string[], company: string): boolean {
  const word = normalizeCompany(company)
    .split(" ")
    .find((w) => !DROPPABLE_TAIL.has(w));
  if (!word || !texts.length) return false;
  const re = new RegExp(`\\b${word}`, "i");
  return texts.filter((t) => re.test(t.replace(/[^a-z0-9\s]/gi, ""))).length / texts.length >= 1 / 3;
}

function sameCompany(a: string, b: string): boolean {
  const x = normalizeCompany(a);
  const y = normalizeCompany(b);
  if (!x || !y) return false;
  return x === y || x.startsWith(`${y} `) || y.startsWith(`${x} `);
}

async function getJson<T>(url: string): Promise<T | null> {
  try {
    return await http.json<T>(url, { signal });
  } catch (e) {
    if (e instanceof HttpError && (e.status === 404 || e.status === 400)) return null;
    throw e;
  }
}

const PROBES: Record<AtsId, (token: string, company: string) => Promise<boolean>> = {
  async greenhouse(token, company) {
    const board = await getJson<{ name?: string }>(`https://boards-api.greenhouse.io/v1/boards/${token}`);
    if (!board?.name || !sameCompany(board.name, company)) return false;
    const jobs = await getJson<{ jobs: unknown[] }>(
      `https://boards-api.greenhouse.io/v1/boards/${token}/jobs`,
    );
    return (jobs?.jobs.length ?? 0) > 0;
  },
  async ashby(token, company) {
    const board = await getJson<{ jobs: { isListed?: boolean; descriptionPlain?: string }[] }>(
      `https://api.ashbyhq.com/posting-api/job-board/${token}`,
    );
    const listed = board?.jobs.filter((j) => j.isListed !== false) ?? [];
    return mentionsCompany(
      listed.map((j) => j.descriptionPlain ?? ""),
      company,
    );
  },
  async lever(token, company) {
    const postings = await getJson<{ descriptionPlain?: string; additionalPlain?: string }[]>(
      `https://api.lever.co/v0/postings/${token}?mode=json`,
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

async function discover(company: string): Promise<CompanyBoard | null> {
  const slugs = slugCandidates(company);
  for (const ats of ["greenhouse", "ashby", "lever"] as const) {
    for (const token of slugs) {
      if (await PROBES[ats](token, company)) return { name: company, ats, token };
    }
  }
  return null;
}

async function main() {
  const companies = readFileSync(join(ROOT, "data", "top_500_companies.csv"), "utf8")
    .split(/\r?\n/)
    .slice(1)
    .map((line) => line.trim().replace(/^"(.*)"$/, "$1"))
    .filter(Boolean);
  const unique = [...new Map(companies.map((c) => [c.toLowerCase(), c])).values()];

  let done = 0;
  const found = await mapPool(unique, 6, async (company) => {
    let board: CompanyBoard | null = null;
    try {
      board = await discover(company);
    } catch (e) {
      console.warn(`  ${company}: ${(e as Error).message}`);
    }
    done += 1;
    if (done % 50 === 0) console.log(`${done}/${unique.length}`);
    return board;
  });

  const seen = new Set<string>();
  const boards = found
    .filter((b): b is CompanyBoard => b !== null)
    .filter((b) => {
      const key = `${b.ats}:${b.token}`;
      if (seen.has(key)) return false;
      seen.add(key);
      return true;
    })
    .sort((a, b) => a.name.localeCompare(b.name));

  writeFileSync(join(ROOT, "data", "companies.json"), `${JSON.stringify(boards, null, 2)}\n`);
  const by = (ats: AtsId) => boards.filter((b) => b.ats === ats).length;
  console.log(
    `${boards.length} of ${unique.length} companies: greenhouse ${by("greenhouse")}, ashby ${by("ashby")}, lever ${by("lever")}`,
  );
}

if (import.meta.main) await main();
