import type { Level } from "../types.ts";
import { phraseMatcher } from "./text.ts";

// Ported from job-pipeline's tag_level: most specific first, first match wins,
// substring checks over title + description padded with spaces.
const SIGNALS: [Level, string[]][] = [
  [
    "New Grad",
    [
      "new grad",
      "new-grad",
      "new graduate",
      "university graduate",
      "campus hire",
      "recent grad",
      "recent graduate",
    ],
  ],
  [
    "Mid",
    [
      "mid-level",
      "mid level",
      "swe ii",
      "sde ii",
      "eng ii",
      "software engineer ii",
      "level ii",
      "level 2",
      "2-5 year",
      "3-5 year",
      "2 to 5 year",
      "3 to 5 year",
    ],
  ],
  [
    "Entry",
    [
      "entry level",
      "entry-level",
      "junior",
      "jr.",
      " jr ",
      "associate",
      "0-2 year",
      "0 to 2 year",
      "swe i",
      "sde i",
      "eng i",
      "software engineer i",
      "level i",
      "level 1",
    ],
  ],
];

// Interns are judged from the title alone: descriptions often mention "interns"
// on the team. Whole words, so "internal" doesn't count.
const isIntern = phraseMatcher(["intern", "interns", "internship", "co-op"]);
const SENIOR: [Level, ReturnType<typeof phraseMatcher>][] = [
  ["Principal", phraseMatcher(["principal", "distinguished"])],
  ["Staff", phraseMatcher(["staff"])],
  ["Senior", phraseMatcher(["senior", "sr"])],
];

export function tagLevel(title: string, description: string | null): Level {
  if (isIntern(title)) return "Intern";
  for (const [level, match] of SENIOR) if (match(title)) return level;
  const text = ` ${title} ${description ?? ""} `.toLowerCase();
  for (const [level, signals] of SIGNALS) {
    if (signals.some((s) => text.includes(s))) return level;
  }
  // The role filter already removes senior titles, so unlabelled means entry-ish.
  return "Entry";
}
