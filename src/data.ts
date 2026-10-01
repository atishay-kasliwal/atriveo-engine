// Company lists bundled into the binary (bun build --compile embeds imports).
import h1bCsv from "../data/h1b_2026.csv" with { type: "text" };
import top500Csv from "../data/top_500_companies.csv" with { type: "text" };
import { parseCompanyCsv } from "./core/company.ts";

export interface CompanyLists {
  h1b: ReadonlySet<string>;
  top500: ReadonlySet<string>;
}

let cached: CompanyLists | null = null;

export function companyLists(): CompanyLists {
  cached ??= { h1b: parseCompanyCsv(h1bCsv), top500: parseCompanyCsv(top500Csv) };
  return cached;
}
