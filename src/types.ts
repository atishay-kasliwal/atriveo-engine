export type SourceId = "greenhouse" | "lever" | "ashby" | "remotive" | "arbeitnow";

export const SOURCE_IDS: readonly SourceId[] = ["greenhouse", "lever", "ashby", "remotive", "arbeitnow"];

export type AtsId = "greenhouse" | "lever" | "ashby";

export type Level = "Intern" | "Entry" | "New Grad" | "Mid" | "Senior" | "Staff" | "Principal";

/** A company job board on an ATS that publishes a public postings API. */
export interface CompanyBoard {
  name: string;
  ats: AtsId;
  token: string;
}

/** One posting as a source returns it, before filtering and scoring. */
export interface RawPosting {
  source: SourceId;
  url: string;
  company: string;
  title: string;
  location: string;
  isRemote: boolean;
  /** ISO timestamp, or null when the source doesn't say. */
  postedAt: string | null;
  /** Plain text. Null when the listing omits it and `loadDescription` must be called. */
  description: string | null;
  loadDescription?: (signal: AbortSignal) => Promise<string | null>;
  /** Sources whose terms require naming them, e.g. "Remotive". */
  attribution?: string;
}

/** A job as the HTTP API returns it (docs/API.md). */
export interface ApiJob {
  job_url: string;
  session_id: string;
  batch_time: string;
  company: string;
  title: string;
  location: string;
  level: Level | null;
  score: number;
  score_pct: number;
  competition_score: number;
  summary: string;
  search_term: string;
  site: SourceId;
  date_posted: string | null;
  min_exp: number | null;
  max_exp: number | null;
  pipeline: "standard";
  h1b_sponsor: boolean;
  sponsorship_blocked: boolean;
}

export type RunStatus = "idle" | "running" | "done" | "failed" | "cancelled" | "interrupted";
export type PhaseName = "fetch" | "filter" | "score" | "store";
export type PhaseStatus = "running" | "ok" | "failed" | "cancelled";

export const PHASES: readonly PhaseName[] = ["fetch", "filter", "score", "store"];

export interface PhaseState {
  name: PhaseName;
  status: PhaseStatus;
  startedAt: string;
  finishedAt?: string;
  exitCode?: number;
}

export interface RunState {
  runId: string | null;
  status: RunStatus;
  phase: PhaseName | null;
  phases: PhaseState[];
  startedAt?: string;
  updatedAt?: string;
  finishedAt?: string | null;
  jobsBefore?: number | null;
  jobsAfter?: number | null;
  error?: string;
}
