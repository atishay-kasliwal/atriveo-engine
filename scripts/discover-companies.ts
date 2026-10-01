// Finds which of the companies in data/top_500_companies.csv publish a public
// Greenhouse, Lever, or Ashby job board, and writes data/companies.json.
//
//   bun scripts/discover-companies.ts
//
// A maintainer runs this now and then and commits the result; CI never does.
// Matching is a heuristic (see src/sources/discover.ts). Anything it misses
// can be added with `atriveo companies add <careers-url>`.

import { readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { discoverBoard } from "../src/sources/discover.ts";
import { Http, mapPool } from "../src/sources/http.ts";
import type { AtsId, CompanyBoard } from "../src/types.ts";

const ROOT = join(import.meta.dir, "..");

async function main() {
  const http = new Http({ retries: 2 });
  const signal = new AbortController().signal;
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
      board = await discoverBoard(http, company, signal);
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

await main();
