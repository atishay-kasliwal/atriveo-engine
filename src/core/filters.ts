import type { EngineConfig } from "../config.ts";
import type { RawPosting } from "../types.ts";
import { phraseMatcher } from "./text.ts";

// Ported from job-pipeline's SPONSORSHIP_REJECT_PHRASES: explicit sponsorship
// refusals, citizenship/permanent-residency requirements, and security clearance.
export const SPONSORSHIP_BLOCK_PHRASES = [
  "no sponsorship",
  "no need for visa sponsorship",
  "must have the right to work in the uk without current or future sponsorship",
  "will not sponsor",
  "cannot sponsor",
  "does not sponsor",
  "not eligible for sponsorship",
  "not eligible for visa sponsorship",
  "not eligible for immigration sponsorship",
  "not eligible for u.s. immigration sponsorship",
  "not eligible for us immigration sponsorship",
  "sponsorship not available",
  "sponsorship is not available",
  "sponsorship: not available",
  "sponsorship not provided",
  "sponsorship is not provided",
  "unable to sponsor",
  "not able to sponsor",
  "not offer sponsorship",
  "not offering sponsorship",
  "no visa",
  "visa: not available",
  "us citizen only",
  "u.s. citizen only",
  "citizens only",
  "must be a us citizen",
  "must be a u.s. citizen",
  "must be a united states citizen",
  "us citizenship required",
  "u.s. citizenship required",
  "united states citizenship required",
  "citizenship is required",
  "gc holder",
  "green card holder",
  "green card only",
  "authorization to work in the us or canada without sponsorship",
  "authorized to work in the us without sponsorship",
  "authorized to work in the united states without sponsorship",
  "work authorization without sponsorship",
  "work in the us without sponsorship",
  "eligible to work in the us without sponsorship",
  "legally authorized to work for any company in the united states without sponsorship",
  "without the need for sponsorship",
  "without requiring sponsorship",
  "lawful permanent resident",
  "security clearance required",
  "clearance required",
  "active clearance",
  "active secret clearance",
  "active top secret",
  "top secret clearance",
  "top-secret clearance",
  "ts/sci",
  "ts sci",
  "top secret/sci",
  "sci eligibility",
  "sci access",
  "dod clearance",
  "dod secret",
  "government clearance",
  "public trust clearance",
  "secret clearance",
  "must have clearance",
  "must hold clearance",
  "ability to obtain a clearance",
  "obtain a government clearance",
  "obtain a security clearance",
  "obtain and maintain a security clearance",
];
// Dropped from the Python list: "must be authorized to work", "authorization to work
// in the us", "permanent resident" and "not available for this role". Nearly every US
// posting carries the first two as boilerplate, so they flagged sponsor-friendly jobs.

export interface Filters {
  /** The include term the title matched, or null when the role is out of scope. */
  roleTerm(title: string): string | null;
  companyExcluded(company: string): boolean;
  locationAllowed(location: string): boolean;
  remoteAllowed(posting: Pick<RawPosting, "isRemote" | "location">): boolean;
  sponsorshipBlocked(text: string): boolean;
}

export function buildFilters(config: EngineConfig): Filters {
  const include = phraseMatcher(config.roles.include);
  const exclude = phraseMatcher(config.roles.exclude);
  const blocked = phraseMatcher(SPONSORSHIP_BLOCK_PHRASES);
  const companyExclude = config.companyExclude.map((c) => c.toLowerCase());

  // Full names match anywhere; two-letter codes must be uppercase whole words,
  // so "in", "or" and "me" in a sentence don't pass as Indiana, Oregon, Maine.
  const names = config.locations.filter((l) => l.length > 2).map((l) => l.toLowerCase());
  const codes = config.locations.filter((l) => l.length <= 2);
  const codeRe = codes.length ? new RegExp(`(?<![A-Za-z])(${codes.join("|")})(?![A-Za-z])`) : null;

  return {
    roleTerm(title) {
      if (exclude(title)) return null;
      return include(title);
    },
    companyExcluded(company) {
      const c = company.toLowerCase();
      return companyExclude.some((ex) => c.includes(ex));
    },
    locationAllowed(location) {
      if (!config.locations.length || !location.trim()) return true;
      const lower = location.toLowerCase();
      if (names.some((n) => lower.includes(n))) return true;
      return codeRe ? codeRe.test(location) : false;
    },
    remoteAllowed({ isRemote, location }) {
      if (config.remote !== "remote-only") return true;
      return isRemote || /\bremote\b/i.test(location);
    },
    sponsorshipBlocked(text) {
      return blocked(text) !== null;
    },
  };
}
