// Company-name normalization, ported from job-pipeline's important_filter._norm_company,
// so "Waymo LLC" and "Waymo" both match the same list entry.
const LEGAL_SUFFIXES =
  /\b(llc|llp|lp|inc|corp|corporation|ltd|limited|co|company|companies|technologies|technology|tech|solutions|services|service|systems|system|group|international|global|americas|america|north america|us|usa|u\.s\.a?|holdings|holding|ventures|partners|associates|consulting|consultants|staffing|software|enterprises|enterprise)\b[.,]?/gi;

export function normalizeCompany(name: string): string {
  return name
    .toLowerCase()
    .replace(LEGAL_SUFFIXES, " ")
    .replace(/[^\w\s]/g, " ")
    .replace(/\s+/g, " ")
    .trim();
}

/** Company names from a one-column CSV (header `company`), normalized. */
export function parseCompanyCsv(csv: string): Set<string> {
  const names = new Set<string>();
  for (const [i, raw] of csv.split(/\r?\n/).entries()) {
    const value = raw
      .trim()
      .replace(/^"(.*)"$/, "$1")
      .replace(/""/g, '"');
    if (!value || (i === 0 && value.toLowerCase() === "company")) continue;
    const norm = normalizeCompany(value);
    if (norm) names.add(norm);
  }
  return names;
}

export function inList(company: string, list: ReadonlySet<string>): boolean {
  const norm = normalizeCompany(company);
  return norm.length > 0 && list.has(norm);
}
