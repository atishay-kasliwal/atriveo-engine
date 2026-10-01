import { Database } from "bun:sqlite";
import { mkdirSync } from "node:fs";
import { dirname } from "node:path";
import { isoSeconds, localDateKey, localDayBounds } from "../core/days.ts";
import type { ApiJob, Level, PhaseState, RunState, RunStatus, SourceId } from "../types.ts";

const SCHEMA = `
CREATE TABLE IF NOT EXISTS runs (
  id TEXT PRIMARY KEY,
  status TEXT NOT NULL,
  phase TEXT,
  phases TEXT NOT NULL DEFAULT '[]',
  started_at TEXT NOT NULL,
  updated_at TEXT NOT NULL,
  finished_at TEXT,
  jobs_before INTEGER,
  jobs_after INTEGER,
  error TEXT,
  pid INTEGER
);
CREATE TABLE IF NOT EXISTS jobs (
  job_url TEXT PRIMARY KEY,
  site TEXT NOT NULL,
  company TEXT NOT NULL,
  title TEXT NOT NULL,
  location TEXT NOT NULL DEFAULT '',
  date_posted TEXT,
  summary TEXT NOT NULL DEFAULT '',
  search_term TEXT NOT NULL DEFAULT '',
  level TEXT,
  min_exp INTEGER,
  max_exp INTEGER,
  h1b_sponsor INTEGER NOT NULL DEFAULT 0,
  sponsorship_blocked INTEGER NOT NULL DEFAULT 0,
  score INTEGER NOT NULL DEFAULT 0,
  score_pct INTEGER NOT NULL DEFAULT 0,
  competition_score INTEGER NOT NULL DEFAULT 0,
  board TEXT NOT NULL DEFAULT '',
  first_run TEXT NOT NULL,
  last_run TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS jobs_first_run ON jobs (first_run);
CREATE INDEX IF NOT EXISTS jobs_last_run ON jobs (last_run);
CREATE TABLE IF NOT EXISTS descriptions (
  job_url TEXT PRIMARY KEY,
  text TEXT NOT NULL,
  fetched_at TEXT NOT NULL
);
CREATE TABLE IF NOT EXISTS http_cache (
  url TEXT PRIMARY KEY,
  fetched_at INTEGER NOT NULL,
  body TEXT NOT NULL
);
CREATE TABLE IF NOT EXISTS kv (
  key TEXT PRIMARY KEY,
  value TEXT NOT NULL
);
`;

export interface StoredJob {
  job_url: string;
  site: SourceId;
  company: string;
  title: string;
  location: string;
  date_posted: string | null;
  summary: string;
  search_term: string;
  level: Level | null;
  min_exp: number | null;
  max_exp: number | null;
  h1b_sponsor: boolean;
  sponsorship_blocked: boolean;
  score: number;
  score_pct: number;
  competition_score: number;
  /** `ats:token` for company-board jobs, "" for aggregators. */
  board: string;
}

interface JobRow extends Omit<StoredJob, "h1b_sponsor" | "sponsorship_blocked" | "board"> {
  h1b_sponsor: number;
  sponsorship_blocked: number;
  first_run: string;
  last_run: string;
}

interface RunRow {
  id: string;
  status: RunStatus;
  phase: string | null;
  phases: string;
  started_at: string;
  updated_at: string;
  finished_at: string | null;
  jobs_before: number | null;
  jobs_after: number | null;
  error: string | null;
  pid: number | null;
}

export type FeedType = "hour" | "today" | "yesterday" | "week";

const KEEP_CLOSED_DAYS = 30;
const KEEP_DESCRIPTION_DAYS = 60;

export class Store {
  readonly db: Database;

  constructor(path: string) {
    if (path !== ":memory:") mkdirSync(dirname(path), { recursive: true });
    this.db = new Database(path, { create: true });
    this.db.exec("PRAGMA journal_mode = WAL; PRAGMA busy_timeout = 5000;");
    this.db.exec(SCHEMA);
  }

  close(): void {
    this.db.close();
  }

  // ── runs ──────────────────────────────────────────────────────────────────

  createRun(id: string, jobsBefore: number): void {
    this.db
      .query(
        "INSERT INTO runs (id, status, phase, phases, started_at, updated_at, jobs_before, pid) VALUES (?, 'running', NULL, '[]', ?, ?, ?, ?)",
      )
      .run(id, id, id, jobsBefore, process.pid);
  }

  updateRun(id: string, patch: { phase?: string | null; phases?: PhaseState[] }): void {
    this.db
      .query("UPDATE runs SET phase = ?, phases = ?, updated_at = ? WHERE id = ?")
      .run(patch.phase ?? null, JSON.stringify(patch.phases ?? []), isoSeconds(), id);
  }

  finishRun(
    id: string,
    status: Exclude<RunStatus, "idle" | "running">,
    fields: { phases: PhaseState[]; jobsAfter?: number | null; error?: string | null },
  ): void {
    const now = isoSeconds();
    this.db
      .query(
        "UPDATE runs SET status = ?, phase = NULL, phases = ?, updated_at = ?, finished_at = ?, jobs_after = ?, error = ? WHERE id = ?",
      )
      .run(
        status,
        JSON.stringify(fields.phases),
        now,
        now,
        fields.jobsAfter ?? null,
        fields.error ?? null,
        id,
      );
  }

  /** Runs left "running" by a process that is gone (crash, sleep, kill) become "interrupted". */
  reapStaleRuns(isAlive: (pid: number) => boolean): void {
    const stale = this.db.query<RunRow, []>("SELECT * FROM runs WHERE status = 'running'").all();
    for (const run of stale) {
      if (run.pid !== null && run.pid !== process.pid && isAlive(run.pid)) continue;
      if (run.pid === process.pid) continue;
      this.finishRun(run.id, "interrupted", {
        phases: JSON.parse(run.phases),
        error: "Run ended without finishing",
      });
    }
  }

  runningRun(): RunRow | null {
    return this.db
      .query<RunRow, []>("SELECT * FROM runs WHERE status = 'running' ORDER BY id DESC LIMIT 1")
      .get();
  }

  latestRunState(): RunState {
    const row = this.db.query<RunRow, []>("SELECT * FROM runs ORDER BY id DESC LIMIT 1").get();
    if (!row) return { runId: null, status: "idle", phase: null, phases: [] };
    return {
      runId: row.id,
      status: row.status,
      phase: (row.phase as RunState["phase"]) ?? null,
      phases: JSON.parse(row.phases) as PhaseState[],
      startedAt: row.started_at,
      updatedAt: row.updated_at,
      finishedAt: row.finished_at,
      jobsBefore: row.jobs_before,
      jobsAfter: row.jobs_after,
      ...(row.error ? { error: row.error } : {}),
    };
  }

  latestCompletedRunId(): string | null {
    return (
      this.db
        .query<{ id: string }, []>("SELECT id FROM runs WHERE status = 'done' ORDER BY id DESC LIMIT 1")
        .get()?.id ?? null
    );
  }

  /** Median durations of the last successful runs, for the "about N left" estimate. */
  estimate(samples = 5): { totalSec: number | null; samples: number; byPhase: Record<string, number> } {
    const rows = this.db
      .query<{ phases: string; started_at: string; finished_at: string }, [number]>(
        "SELECT phases, started_at, finished_at FROM runs WHERE status = 'done' AND finished_at IS NOT NULL ORDER BY id DESC LIMIT ?",
      )
      .all(samples);
    if (!rows.length) return { totalSec: null, samples: 0, byPhase: {} };
    const median = (xs: number[]) => {
      const s = [...xs].sort((a, b) => a - b);
      const mid = Math.floor(s.length / 2);
      return s.length % 2 ? (s[mid] ?? 0) : ((s[mid - 1] ?? 0) + (s[mid] ?? 0)) / 2;
    };
    const secs = (a: string, b: string) => Math.max(0, (Date.parse(b) - Date.parse(a)) / 1000);
    const byPhaseLists: Record<string, number[]> = {};
    for (const r of rows) {
      for (const p of JSON.parse(r.phases) as PhaseState[]) {
        if (!p.finishedAt) continue;
        const list = byPhaseLists[p.name] ?? [];
        list.push(secs(p.startedAt, p.finishedAt));
        byPhaseLists[p.name] = list;
      }
    }
    const byPhase = Object.fromEntries(
      Object.entries(byPhaseLists).map(([k, v]) => [k, Math.round(median(v))]),
    );
    return {
      totalSec: Math.round(median(rows.map((r) => secs(r.started_at, r.finished_at)))),
      samples: rows.length,
      byPhase,
    };
  }

  // ── jobs ──────────────────────────────────────────────────────────────────

  jobCount(): number {
    return this.db.query<{ n: number }, []>("SELECT COUNT(*) AS n FROM jobs").get()?.n ?? 0;
  }

  knownUrls(): Set<string> {
    return new Set(
      this.db
        .query<{ job_url: string }, []>("SELECT job_url FROM jobs")
        .all()
        .map((r) => r.job_url),
    );
  }

  /** Inserts new jobs and refreshes existing ones; `first_run` never changes after insert. */
  upsertJobs(runId: string, jobs: StoredJob[]): void {
    const stmt = this.db.query(`
      INSERT INTO jobs (job_url, site, company, title, location, date_posted, summary, search_term, level,
        min_exp, max_exp, h1b_sponsor, sponsorship_blocked, score, score_pct, competition_score, board, first_run, last_run)
      VALUES ($job_url, $site, $company, $title, $location, $date_posted, $summary, $search_term, $level,
        $min_exp, $max_exp, $h1b_sponsor, $sponsorship_blocked, $score, $score_pct, $competition_score, $board, $run, $run)
      ON CONFLICT(job_url) DO UPDATE SET
        site = excluded.site, company = excluded.company, title = excluded.title, location = excluded.location,
        date_posted = excluded.date_posted, summary = excluded.summary, search_term = excluded.search_term,
        level = excluded.level, min_exp = excluded.min_exp, max_exp = excluded.max_exp,
        h1b_sponsor = excluded.h1b_sponsor, sponsorship_blocked = excluded.sponsorship_blocked,
        score = excluded.score, score_pct = excluded.score_pct, competition_score = excluded.competition_score,
        board = excluded.board, last_run = excluded.last_run`);
    this.db.transaction(() => {
      for (const j of jobs) {
        stmt.run({
          $job_url: j.job_url,
          $site: j.site,
          $company: j.company,
          $title: j.title,
          $location: j.location,
          $date_posted: j.date_posted,
          $summary: j.summary,
          $search_term: j.search_term,
          $level: j.level,
          $min_exp: j.min_exp,
          $max_exp: j.max_exp,
          $h1b_sponsor: j.h1b_sponsor ? 1 : 0,
          $sponsorship_blocked: j.sponsorship_blocked ? 1 : 0,
          $score: j.score,
          $score_pct: j.score_pct,
          $competition_score: j.competition_score,
          $board: j.board,
          $run: runId,
        });
      }
    })();
  }

  /** Keeps a failed source's open jobs open, so one bad fetch doesn't empty its part of the feed. */
  carryForward(previousRunId: string, runId: string, sites: SourceId[]): void {
    if (!sites.length) return;
    const marks = sites.map(() => "?").join(",");
    this.db
      .query(`UPDATE jobs SET last_run = ? WHERE last_run = ? AND site IN (${marks})`)
      .run(runId, previousRunId, ...sites);
  }

  /** Same, for individual company boards (`ats:token`) that failed while the rest of their source worked. */
  carryForwardBoards(previousRunId: string, runId: string, boards: string[]): void {
    const update = this.db.query("UPDATE jobs SET last_run = ? WHERE last_run = ? AND board = ?");
    this.db.transaction(() => {
      for (const board of boards) update.run(runId, previousRunId, board);
    })();
  }

  /** Jobs still open: seen in the latest completed run. */
  openJobCount(): number {
    const latest = this.latestCompletedRunId();
    if (!latest) return 0;
    return (
      this.db.query<{ n: number }, [string]>("SELECT COUNT(*) AS n FROM jobs WHERE last_run = ?").get(latest)
        ?.n ?? 0
    );
  }

  /** When the latest completed run finished. */
  lastRunAt(): string | null {
    return (
      this.db
        .query<{ finished_at: string }, []>(
          "SELECT finished_at FROM runs WHERE status = 'done' ORDER BY id DESC LIMIT 1",
        )
        .get()?.finished_at ?? null
    );
  }

  runExists(id: string): boolean {
    return this.db.query("SELECT 1 FROM runs WHERE id = ?").get(id) !== null;
  }

  feed(type: FeedType, now = new Date()): ApiJob[] {
    const latest = this.latestCompletedRunId();
    if (!latest) return [];
    let rows: JobRow[];
    if (type === "hour") {
      rows = this.db
        .query<JobRow, [string, string]>("SELECT * FROM jobs WHERE first_run = ? AND last_run = ?")
        .all(latest, latest);
    } else if (type === "week") {
      const since = new Date(now.getTime() - 7 * 86_400_000);
      rows = this.db
        .query<JobRow, [string, string]>("SELECT * FROM jobs WHERE last_run = ? AND first_run >= ?")
        .all(latest, isoSeconds(since));
    } else {
      const [start, end] = localDayBounds(type === "today" ? 0 : 1, now);
      rows = this.db
        .query<JobRow, [string, string, string]>(
          "SELECT * FROM jobs WHERE last_run = ? AND first_run >= ? AND first_run < ?",
        )
        .all(latest, isoSeconds(start), isoSeconds(end));
    }
    const jobs = rows.map(toApiJob);
    if (type === "week") {
      jobs.sort(
        (a, b) =>
          localDateKey(new Date(b.batch_time)).localeCompare(localDateKey(new Date(a.batch_time))) ||
          b.score - a.score,
      );
    } else {
      jobs.sort((a, b) => b.score - a.score);
    }
    return jobs;
  }

  // ── caches ────────────────────────────────────────────────────────────────

  getDescription(url: string): string | null {
    return (
      this.db.query<{ text: string }, [string]>("SELECT text FROM descriptions WHERE job_url = ?").get(url)
        ?.text ?? null
    );
  }

  putDescription(url: string, text: string): void {
    this.db
      .query("INSERT OR REPLACE INTO descriptions (job_url, text, fetched_at) VALUES (?, ?, ?)")
      .run(url, text, isoSeconds());
  }

  getCached(url: string, maxAgeMs: number): string | null {
    const row = this.db
      .query<{ body: string; fetched_at: number }, [string]>(
        "SELECT body, fetched_at FROM http_cache WHERE url = ?",
      )
      .get(url);
    return row && Date.now() - row.fetched_at <= maxAgeMs ? row.body : null;
  }

  putCached(url: string, body: string): void {
    this.db
      .query("INSERT OR REPLACE INTO http_cache (url, fetched_at, body) VALUES (?, ?, ?)")
      .run(url, Date.now(), body);
  }

  getKv(key: string): string | null {
    return (
      this.db.query<{ value: string }, [string]>("SELECT value FROM kv WHERE key = ?").get(key)?.value ?? null
    );
  }

  setKv(key: string, value: string): void {
    this.db.query("INSERT OR REPLACE INTO kv (key, value) VALUES (?, ?)").run(key, value);
  }

  deleteKv(key: string): void {
    this.db.query("DELETE FROM kv WHERE key = ?").run(key);
  }

  /** Drops jobs closed for a month, stale descriptions and cache, and old run rows. */
  prune(now = new Date()): void {
    const closedBefore = isoSeconds(new Date(now.getTime() - KEEP_CLOSED_DAYS * 86_400_000));
    const descBefore = isoSeconds(new Date(now.getTime() - KEEP_DESCRIPTION_DAYS * 86_400_000));
    this.db.transaction(() => {
      this.db.query("DELETE FROM jobs WHERE last_run < ?").run(closedBefore);
      this.db
        .query("DELETE FROM descriptions WHERE fetched_at < ? AND job_url NOT IN (SELECT job_url FROM jobs)")
        .run(descBefore);
      this.db.query("DELETE FROM http_cache WHERE fetched_at < ?").run(now.getTime() - 86_400_000);
      this.db.query("DELETE FROM runs WHERE id < ? AND status != 'running'").run(closedBefore);
    })();
  }
}

function toApiJob(row: JobRow): ApiJob {
  return {
    job_url: row.job_url,
    session_id: row.first_run,
    batch_time: row.first_run,
    company: row.company,
    title: row.title,
    location: row.location,
    level: row.level,
    score: row.score,
    score_pct: row.score_pct,
    competition_score: row.competition_score,
    summary: row.summary,
    search_term: row.search_term,
    site: row.site,
    date_posted: row.date_posted,
    min_exp: row.min_exp,
    max_exp: row.max_exp,
    pipeline: "standard",
    h1b_sponsor: row.h1b_sponsor === 1,
    sponsorship_blocked: row.sponsorship_blocked === 1,
  };
}
