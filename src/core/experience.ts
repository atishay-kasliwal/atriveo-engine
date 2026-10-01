// Ported from job-pipeline/job_pipeline/filters.py (_EXP_RANGE_RE, filter_by_experience).

const YEARS = "(?:years?|yrs?)";
const EXP = "(?:experience|exp(?:erience)?)";

// Six alternatives, two groups each: (min, max).
const EXP_RANGE_RE = new RegExp(
  [
    String.raw`\b(\d+)\s+to\s+(\d+)\s*\+?\s*${YEARS}\b`,
    String.raw`(?<!to )\b(\d+)\s*(?:[-–—]\s*(\d+))?\s*\+?\s*${YEARS}\s+(?:(?!\d)(?:\w+[/\w]*\s+){0,5})?${EXP}\b`,
    String.raw`\b(\d+)\s*(?:[-–—]\s*(\d+))?\s*\+\s*${YEARS}\b`,
    String.raw`(?:minimum|at\s+least|requires?|minimum\s+of)\s+(?:of\s+)?(\d+)\s*(?:[-–—]\s*(\d+))?\s*\+?\s*${YEARS}\b`,
    String.raw`${EXP}\s*(?:of|:|\()\s*(\d+)\s*(?:[-–—]\s*(\d+))?\s*\+?\s*${YEARS}\b`,
    String.raw`\b(\d+)\s*(?:[-–—]\s*(\d+))?\s*\+?\s*yrs?\s+(?:of\s+)?${EXP}\b`,
  ].join("|"),
  "gi",
);

// Above 40 is a date or a dollar figure, not a requirement.
const PLAUSIBLE = (n: number) => n >= 0 && n <= 40;

/** Lowest and highest years of experience the posting asks for, or nulls when it doesn't say. */
export function extractExperience(text: string): { min: number | null; max: number | null } {
  const mins: number[] = [];
  const maxs: number[] = [];
  for (const m of text.matchAll(EXP_RANGE_RE)) {
    for (let i = 1; i <= 11; i += 2) {
      const lo = m[i];
      if (lo === undefined) continue;
      const min = Number(lo);
      const max = m[i + 1] !== undefined ? Number(m[i + 1]) : min;
      if (!PLAUSIBLE(min) || !PLAUSIBLE(max)) continue;
      mins.push(min);
      maxs.push(max);
    }
  }
  return {
    min: mins.length ? Math.min(...mins) : null,
    max: maxs.length ? Math.max(...maxs) : null,
  };
}

// The "explicitly requires more than N years" patterns. Each captures the
// minimum; the caller compares it with the configured limit. The Python version
// also rejected any bare two-digit "NN years", which threw out postings that
// merely said "founded 15 years ago", so that alternative is gone.
const OVERQUALIFIED_RE = new RegExp(
  [
    String.raw`(?<!\d)(?<!-)(?<!to )(\d+)\s*(?:\+|[-–—]\s*\d+)?\s*\+?\s*${YEARS}\s+(?:\w+\s+){0,5}${EXP}\b`,
    String.raw`${EXP}\s*(?:of|:)\s*(\d+)\s*(?:\+|[-–—]\s*\d+)?\s*\+?\s*${YEARS}\b`,
    String.raw`(?:minimum|min\.?)\s+(?:of\s+)?(\d+)\s*\+?\s*${YEARS}`,
    String.raw`at\s+least\s+(\d+)\s*\+?\s*${YEARS}`,
    String.raw`\b(\d+)\+?\s*or\s+more\s+${YEARS}`,
    String.raw`requires?\s+(\d+)\s*\+?\s*${YEARS}`,
    String.raw`\b(\d+)\s*(?:[-–—]|to)\s*\d+\s*\+?\s*${YEARS}\b`,
    String.raw`\b(\d+)\+\s*${YEARS}\b`,
  ].join("|"),
  "gi",
);

/** True when the posting explicitly requires more than `maxYears` of experience. */
export function requiresMoreThan(text: string, maxYears: number): boolean {
  for (const m of text.matchAll(OVERQUALIFIED_RE)) {
    const n = Number(m.slice(1).find((g) => g !== undefined));
    if (PLAUSIBLE(n) && n > maxYears) return true;
  }
  return false;
}
