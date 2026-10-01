import type { CompanyBoard, RawPosting, SourceId } from "../types.ts";
import type { Http } from "./http.ts";

export interface SourceContext {
  http: Http;
  signal: AbortSignal;
  /** Company boards for this source's ATS; empty for aggregators. */
  boards: readonly CompanyBoard[];
  /** Boards fetched at once. */
  concurrency: number;
}

export interface SourceResult {
  postings: RawPosting[];
  /** Boards that could not be read this run (`ats:token`), so their jobs can be carried forward. */
  failed: { board: string; company: string; error: string }[];
  /** Things worth logging that didn't stop the run, e.g. a board that no longer exists. */
  warnings: string[];
  /** False when nothing could be read at all. */
  ok: boolean;
}

export interface Source {
  id: SourceId;
  fetch(ctx: SourceContext): Promise<SourceResult>;
}
