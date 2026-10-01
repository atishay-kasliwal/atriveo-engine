import type { EngineConfig } from "../config.ts";
import { type CompanyLists, companyLists } from "../data.ts";
import { boardsFor } from "../sources/boards.ts";
import { type Http, mapPool } from "../sources/http.ts";
import { SOURCES } from "../sources/index.ts";
import type { Source, SourceResult } from "../sources/types.ts";
import type { Store, StoredJob } from "../store/db.ts";
import type { AtsId, CompanyBoard, PhaseName, RawPosting, SourceId } from "../types.ts";
import { SOURCE_IDS } from "../types.ts";
import { inList } from "./company.ts";
import { localDateKey } from "./days.ts";
import { dedupe } from "./dedupe.ts";
import { extractExperience, requiresMoreThan } from "./experience.ts";
import { buildFilters } from "./filters.ts";
import { tagLevel } from "./level.ts";
import { buildScorer, toPercent } from "./scoring.ts";
import { summarize } from "./text.ts";

const ATS: readonly SourceId[] = ["greenhouse", "lever", "ashby"];

export interface PipelineOptions {
  runId: string;
  config: EngineConfig;
  store: Store;
  http: Http;
  signal: AbortSignal;
  sources?: Record<SourceId, Source>;
  /** Defaults to the bundled boards plus the user's. */
  boards?: CompanyBoard[];
  lists?: CompanyLists;
  now?: Date;
  /** Requests in flight per source, and description loads at once. */
  concurrency?: number;
  onPhase?: (phase: PhaseName) => void;
  log?: (line: string) => void;
}

export interface PipelineResult {
  fetched: number;
  stored: number;
  failedSources: SourceId[];
  failedBoards: string[];
}

interface Candidate {
  posting: RawPosting;
  searchTerm: string;
  description: string;
}

/**
 * One scrape: fetch every enabled source, filter, score, and store.
 *
 * A source or board that fails keeps its previous jobs open (carried forward)
 * so a flaky network doesn't empty the feed. If every source fails the run
 * throws, leaving the last good run as the feed.
 */
export async function runPipeline(options: PipelineOptions): Promise<PipelineResult> {
  const { runId, config, store, http, signal } = options;
  const sources = options.sources ?? SOURCES;
  const lists = options.lists ?? companyLists();
  const now = options.now ?? new Date();
  const concurrency = options.concurrency ?? 6;
  const log = options.log ?? (() => {});
  const phase = options.onPhase ?? (() => {});
  const previousRun = store.latestCompletedRunId();

  // ── fetch ────────────────────────────────────────────────────────────────
  phase("fetch");
  const boards = options.boards ?? boardsFor(config);
  const enabled = SOURCE_IDS.filter((id) => config.sources[id]);
  if (!enabled.length) throw new Error("Every source is turned off in the config");

  // A board source with no boards configured has nothing to ask.
  const attempted = enabled.filter((id) => !ATS.includes(id) || boards.some((b) => b.ats === id));
  const results = await Promise.all(
    attempted.map(async (id): Promise<[SourceId, SourceResult]> => {
      const own = ATS.includes(id) ? boards.filter((b) => b.ats === (id as AtsId)) : [];
      try {
        return [id, await sources[id].fetch({ http, signal, boards: own, concurrency })];
      } catch (e) {
        signal.throwIfAborted();
        return [id, { postings: [], failed: [], warnings: [(e as Error).message], ok: false }];
      }
    }),
  );

  const failedSources: SourceId[] = [];
  const failedBoards: string[] = [];
  const postings: RawPosting[] = [];
  for (const [id, result] of results) {
    const boardCount = ATS.includes(id) ? boards.filter((b) => b.ats === id).length : 0;
    const from = boardCount ? ` from ${boardCount} boards` : "";
    const failed = result.failed.length ? `, ${result.failed.length} failed` : "";
    log(`${id}: ${result.ok ? `${result.postings.length} postings${from}${failed}` : "failed"}`);
    for (const w of result.warnings) log(`  ${w}`);
    for (const f of result.failed) log(`  ${f.company}: ${f.error}`);
    if (!result.ok) failedSources.push(id);
    else failedBoards.push(...result.failed.map((f) => f.board));
    postings.push(...result.postings);
  }
  if (!attempted.length) throw new Error("No sources to fetch: add company boards or turn on an aggregator");
  if (failedSources.length === attempted.length) {
    throw new Error("Every source failed; is this machine offline?");
  }
  signal.throwIfAborted();

  // ── filter ───────────────────────────────────────────────────────────────
  phase("filter");
  const filters = buildFilters(config);
  const known = store.knownUrls();
  const oldest = now.getTime() - config.maxAgeDays * 86_400_000;
  const unique = dedupe(postings);

  // Cheap checks first, so descriptions are only loaded for plausible jobs.
  const plausible: { posting: RawPosting; searchTerm: string }[] = [];
  for (const posting of unique) {
    const searchTerm = filters.roleTerm(posting.title);
    if (searchTerm === null) continue;
    if (filters.companyExcluded(posting.company)) continue;
    if (!filters.locationAllowed(posting.location)) continue;
    if (!filters.remoteAllowed(posting)) continue;
    if (config.sponsorsOnly && !inList(posting.company, lists.h1b)) continue;
    const posted = posting.postedAt ? Date.parse(posting.postedAt) : Number.NaN;
    if (!known.has(posting.url) && posted < oldest) continue;
    plausible.push({ posting, searchTerm });
  }

  let loaded = 0;
  let loadFailures = 0;
  const candidates: Candidate[] = await mapPool(
    plausible,
    concurrency,
    async ({ posting, searchTerm }) => {
      let description = posting.description ?? store.getDescription(posting.url);
      if (description === null && posting.loadDescription) {
        try {
          description = (await posting.loadDescription(signal)) ?? "";
          store.putDescription(posting.url, description);
          loaded += 1;
        } catch {
          signal.throwIfAborted();
          loadFailures += 1;
          description = "";
        }
      }
      return { posting, searchTerm, description: description ?? "" };
    },
    signal,
  );
  if (loaded || loadFailures) {
    log(`descriptions: ${loaded} loaded${loadFailures ? `, ${loadFailures} failed` : ""}`);
  }

  const kept = candidates.filter(({ posting, description }) => {
    if (requiresMoreThan(description, config.maxYearsExperience)) return false;
    if (config.excludeSponsorshipBlocked && filters.sponsorshipBlocked(description)) return false;
    return config.levels.includes(tagLevel(posting.title, description));
  });
  log(`filter: ${unique.length} unique postings → ${kept.length} match`);
  signal.throwIfAborted();

  // ── score ────────────────────────────────────────────────────────────────
  phase("score");
  const scorer = buildScorer(config, lists);
  const scored = kept.map(({ posting, searchTerm, description }) => {
    const exp = extractExperience(description);
    const postedAt = posting.postedAt ? new Date(posting.postedAt) : now;
    const result = scorer.score(
      {
        title: posting.title,
        description,
        company: posting.company,
        location: posting.location,
        site: posting.source,
        postedAt,
        minExp: exp.min,
        maxExp: exp.max,
      },
      now,
    );
    const job: StoredJob = {
      job_url: posting.url,
      site: posting.source,
      company: posting.company,
      title: posting.title,
      location: posting.location,
      date_posted: posting.postedAt ? localDateKey(postedAt) : null,
      summary: summarize(description),
      search_term: searchTerm,
      level: tagLevel(posting.title, description),
      min_exp: exp.min,
      max_exp: exp.max,
      h1b_sponsor: result.h1b,
      sponsorship_blocked: filters.sponsorshipBlocked(description),
      score: result.raw,
      score_pct: 0,
      competition_score: result.competition,
      board: posting.board ?? "",
    };
    return job;
  });
  const best = Math.max(0, ...scored.map((j) => j.score));
  for (const job of scored) job.score_pct = toPercent(job.score, best);
  signal.throwIfAborted();

  // ── store ────────────────────────────────────────────────────────────────
  phase("store");
  store.upsertJobs(runId, scored);
  if (previousRun) {
    store.carryForward(previousRun, runId, failedSources);
    store.carryForwardBoards(previousRun, runId, failedBoards);
  }
  store.prune(now);

  return { fetched: postings.length, stored: scored.length, failedSources, failedBoards };
}
