import type { EngineConfig } from "../config.ts";
import type { SourceId } from "../types.ts";
import { inList } from "./company.ts";
import { phraseMatcher } from "./text.ts";

// Ported from job-pipeline/job_pipeline/scoring.py. Keyword, synergy and level
// matches use whole words here: as plain substrings, "rest" scored inside
// "interest", "api" inside "rapid" and "ecs" inside "specs".

export interface ScoreInput {
  title: string;
  description: string;
  company: string;
  location: string;
  site: SourceId;
  /** When the posting was published, or first seen when the source doesn't say. */
  postedAt: Date;
  minExp: number | null;
  maxExp: number | null;
}

export interface ScoreResult {
  raw: number;
  competition: number;
  h1b: boolean;
  top500: boolean;
}

export function experienceScore(min: number | null, max: number | null): number {
  if (min === null && max === null) return 0;
  if ((min === null || min <= 2) && (max === null || max >= 2)) return 10;
  if (max === 1) return 8;
  if (min === 3) return 6;
  if (min !== null && min > 3) return 0;
  return 4;
}

export function recencyScore(hoursOld: number): number {
  if (hoursOld < 6) return 10;
  if (hoursOld < 12) return 8;
  if (hoursOld < 24) return 5;
  if (hoursOld < 48) return 2;
  return -5;
}

/** Company job boards rank above aggregators, as "company" did over LinkedIn. */
export function sourceScore(site: SourceId): number {
  return site === "greenhouse" || site === "lever" || site === "ashby" ? 3 : 0;
}

export interface Scorer {
  score(input: ScoreInput, now?: Date): ScoreResult;
}

export function buildScorer(
  config: EngineConfig,
  lists: { h1b: ReadonlySet<string>; top500: ReadonlySet<string> },
): Scorer {
  const keywords = Object.entries(config.keywords).map(([k, w]) => [phraseMatcher([k]), w] as const);
  const anyKeyword = phraseMatcher(Object.keys(config.keywords));
  const synergy = config.synergy.map(
    ({ keywords: ks, points }) => [ks.map((k) => phraseMatcher([k])), points] as const,
  );
  const levels = Object.entries(config.levelScores).map(([k, pts]) => [phraseMatcher([k]), pts] as const);
  const seniorTitle = phraseMatcher(["staff", "principal"]);
  const bigTech = config.bigTech.map((b) => b.toLowerCase());

  return {
    score(input, now = new Date()) {
      const text = `${input.title} ${input.description}`;
      const company = input.company.toLowerCase();
      const h1b = inList(input.company, lists.h1b);
      const top500 = inList(input.company, lists.top500);
      const isBigTech = bigTech.some((b) => company.includes(b));
      const hoursOld = Math.max(0, (now.getTime() - input.postedAt.getTime()) / 3_600_000);
      const competition = (isBigTech ? 5 : 0) + (hoursOld > 48 ? 5 : hoursOld > 24 ? 2 : 0);

      // should_skip: senior-only titles, 4+ year minimums, or no overlap with the stack.
      const skip =
        seniorTitle(input.title) !== null ||
        /(?<!\d)(?:[4-9]|1\d)\+ years/i.test(text) ||
        anyKeyword(text) === null;
      if (skip && !top500) return { raw: 0, competition, h1b, top500 };

      let raw = 0;
      for (const [match, weight] of keywords) if (match(text)) raw += weight;
      for (const [matchers, points] of synergy) if (matchers.every((m) => m(text))) raw += points;
      raw += experienceScore(input.minExp, input.maxExp);
      raw += levels.find(([match]) => match(input.title))?.[1] ?? 4;
      raw += recencyScore(hoursOld);
      raw += sourceScore(input.site);
      const loc = input.location.toLowerCase();
      raw +=
        config.locationBonuses.find(({ patterns }) => patterns.some((p) => loc.includes(p.toLowerCase())))
          ?.points ?? 0;
      if (isBigTech) raw += config.bonuses.bigTech;
      if (h1b) raw += config.bonuses.h1b;
      if (top500) raw += config.bonuses.top500;
      if (/consulting|llc|beaconfire/.test(company)) raw += config.bonuses.consultingPenalty;
      return { raw, competition, h1b, top500 };
    },
  };
}

/** score_pct for a run: the best job is 100, the rest scale against it. */
export function toPercent(raw: number, bestRaw: number): number {
  if (bestRaw <= 0 || raw <= 0) return 0;
  return Math.min(100, Math.round((raw / bestRaw) * 100));
}
