/**
 * [start, end) of a local calendar day, `daysAgo` days before `now`.
 * The local Date constructor normalizes across DST, so those days come out
 * as 23 or 25 hours rather than shifting midnight.
 */
export function localDayBounds(daysAgo: number, now = new Date()): [Date, Date] {
  const y = now.getFullYear();
  const m = now.getMonth();
  const d = now.getDate() - daysAgo;
  return [new Date(y, m, d), new Date(y, m, d + 1)];
}

/** YYYY-MM-DD in local time. */
export function localDateKey(date: Date): string {
  const p = (n: number) => String(n).padStart(2, "0");
  return `${date.getFullYear()}-${p(date.getMonth() + 1)}-${p(date.getDate())}`;
}

/** Run ids and batch times: ISO without milliseconds, e.g. 2026-10-01T14:45:00Z. */
export function isoSeconds(date = new Date()): string {
  return date.toISOString().replace(/\.\d{3}Z$/, "Z");
}
