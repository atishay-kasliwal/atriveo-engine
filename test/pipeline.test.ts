import { describe, expect, test } from "bun:test";
import { DEFAULT_CONFIG, type EngineConfig } from "../src/config.ts";
import { runPipeline } from "../src/core/pipeline.ts";
import { Http } from "../src/sources/http.ts";
import type { Source, SourceResult } from "../src/sources/types.ts";
import { Store } from "../src/store/db.ts";
import type { CompanyBoard, RawPosting, SourceId } from "../src/types.ts";

const NOW = new Date("2026-10-01T15:00:00Z");
const config: EngineConfig = { ...DEFAULT_CONFIG, token: "t" };
const lists = { h1b: new Set(["northwind"]), top500: new Set<string>() };
const boards: CompanyBoard[] = [
  { name: "Northwind", ats: "greenhouse", token: "northwind" },
  { name: "Contoso", ats: "greenhouse", token: "contoso" },
  { name: "X", ats: "lever", token: "x" },
];
const STACK = "Python, FastAPI, AWS, REST API, Docker, Kubernetes. 1-2 years of experience.";

// Each posting gets its own title: postings with the same title, company, and
// location are one job to the cross-site dedupe.
const posting = (over: Partial<RawPosting>): RawPosting => ({
  source: "greenhouse",
  url: "https://example.test/jobs/1",
  company: "Northwind",
  title: `Software Engineer, ${(over.url ?? "1").split("/").pop()}`,
  location: "Austin, TX",
  isRemote: false,
  postedAt: "2026-10-01T12:00:00.000Z",
  description: STACK,
  board: "greenhouse:northwind",
  ...over,
});

const ok = (postings: RawPosting[], extra: Partial<SourceResult> = {}): SourceResult => ({
  postings,
  failed: [],
  warnings: [],
  ok: true,
  ...extra,
});

function sources(results: Partial<Record<SourceId, SourceResult | Error>>): Record<SourceId, Source> {
  const make = (id: SourceId): Source => ({
    id,
    async fetch() {
      const r = results[id] ?? ok([]);
      if (r instanceof Error) throw r;
      return r;
    },
  });
  return {
    greenhouse: make("greenhouse"),
    lever: make("lever"),
    ashby: make("ashby"),
    remotive: make("remotive"),
    arbeitnow: make("arbeitnow"),
  };
}

async function run(
  store: Store,
  runId: string,
  results: Partial<Record<SourceId, SourceResult | Error>>,
  overrides: Partial<EngineConfig> = {},
) {
  store.createRun(runId, store.jobCount());
  const result = await runPipeline({
    runId,
    config: { ...config, ...overrides },
    store,
    http: new Http(),
    signal: new AbortController().signal,
    sources: sources(results),
    boards,
    lists,
    now: NOW,
  });
  store.finishRun(runId, "done", { phases: [], jobsAfter: store.jobCount() });
  return result;
}

describe("pipeline", () => {
  test("filters, scores against the run's best, and stores", async () => {
    const store = new Store(":memory:");
    const result = await run(store, "2026-10-01T15:00:00Z", {
      greenhouse: ok([
        posting({ url: "https://example.test/jobs/1" }),
        posting({
          url: "https://example.test/jobs/2",
          title: "Software Engineer II",
          description: "Python.",
        }),
        posting({ url: "https://example.test/jobs/3", title: "Senior Software Engineer" }),
        posting({ url: "https://example.test/jobs/4", location: "London, UK" }),
        posting({ url: "https://example.test/jobs/5", description: `${STACK} 5+ years of experience.` }),
        posting({ url: "https://example.test/jobs/6", title: "Account Executive" }),
      ]),
    });
    expect(result.stored).toBe(2);
    const jobs = store.feed("hour", NOW);
    expect(jobs.map((j) => j.job_url)).toEqual([
      "https://example.test/jobs/1",
      "https://example.test/jobs/2",
    ]);
    expect(jobs[0]).toMatchObject({
      score_pct: 100,
      h1b_sponsor: true,
      search_term: "software",
      level: "Entry",
    });
    expect(jobs[1]?.score_pct).toBeLessThan(100);
    expect(jobs[0]?.min_exp).toBe(1);
  });

  test("descriptions load only for plausible postings, once", async () => {
    const store = new Store(":memory:");
    const loaded: string[] = [];
    const lazy = (url: string, title: string) =>
      posting({
        url,
        title,
        description: null,
        loadDescription: async () => {
          loaded.push(url);
          return STACK;
        },
      });
    const results = {
      greenhouse: ok([
        lazy("https://example.test/a", "Backend Engineer"),
        lazy("https://example.test/b", "Recruiter"),
      ]),
    };
    await run(store, "2026-10-01T14:00:00Z", results);
    await run(store, "2026-10-01T15:00:00Z", results);
    expect(loaded).toEqual(["https://example.test/a"]);
    expect(store.feed("today", NOW).length).toBe(1);
  });

  test("a failed source or board keeps its jobs open; a missing one closes them", async () => {
    const store = new Store(":memory:");
    await run(store, "2026-10-01T13:00:00Z", {
      greenhouse: ok([
        posting({ url: "https://example.test/nw" }),
        posting({ url: "https://example.test/co", company: "Contoso", board: "greenhouse:contoso" }),
      ]),
      lever: ok([posting({ url: "https://example.test/lv", source: "lever", board: "lever:x" })]),
    });
    // Contoso's board fails and Lever is down: their jobs stay. Northwind's job is gone: it closes.
    await run(store, "2026-10-01T14:00:00Z", {
      greenhouse: ok([], {
        failed: [{ board: "greenhouse:contoso", company: "Contoso", error: "HTTP 500" }],
      }),
      lever: new Error("network down"),
    });
    expect(
      store
        .feed("today", NOW)
        .map((j) => j.job_url)
        .sort(),
    ).toEqual(["https://example.test/co", "https://example.test/lv"]);
  });

  test("every source failing fails the run", async () => {
    const store = new Store(":memory:");
    store.createRun("2026-10-01T15:00:00Z", 0);
    const down = Object.fromEntries(
      ["greenhouse", "lever", "ashby", "remotive", "arbeitnow"].map((id) => [id, new Error("offline")]),
    );
    await expect(
      runPipeline({
        runId: "2026-10-01T15:00:00Z",
        config,
        store,
        http: new Http(),
        signal: new AbortController().signal,
        sources: sources(down),
        boards,
        lists,
        now: NOW,
      }),
    ).rejects.toThrow("Every source failed");
  });

  test("settings: sponsors only, sponsorship blockers, levels, age, remote", async () => {
    const results = {
      greenhouse: ok([
        posting({ url: "https://example.test/sponsor" }),
        posting({ url: "https://example.test/other", company: "Contoso", board: "greenhouse:contoso" }),
        posting({
          url: "https://example.test/blocked",
          description: `${STACK} We are unable to sponsor visas.`,
        }),
        posting({ url: "https://example.test/intern", title: "Software Engineer Intern" }),
        posting({ url: "https://example.test/old", postedAt: "2026-07-01T00:00:00Z" }),
        posting({ url: "https://example.test/remote", location: "Remote - US", isRemote: true }),
      ]),
    };
    const urls = async (overrides: Partial<EngineConfig>) => {
      const store = new Store(":memory:");
      await run(store, "2026-10-01T15:00:00Z", results, overrides);
      return store
        .feed("hour", NOW)
        .map((j) => j.job_url.replace("https://example.test/", ""))
        .sort();
    };
    expect(await urls({})).toEqual(["blocked", "intern", "other", "remote", "sponsor"]);
    expect(await urls({ sponsorsOnly: true })).toEqual(["blocked", "intern", "remote", "sponsor"]);
    expect(await urls({ excludeSponsorshipBlocked: true })).not.toContain("blocked");
    expect(await urls({ levels: ["Entry", "Mid"] })).not.toContain("intern");
    expect(await urls({ remote: "remote-only" })).toEqual(["remote"]);
    expect(await urls({ maxAgeDays: 365 })).toContain("old");
  });

  test("a job already in the feed stays open even when its posting is old", async () => {
    const store = new Store(":memory:");
    const old = posting({ url: "https://example.test/old", postedAt: "2026-08-01T00:00:00Z" });
    await run(store, "2026-10-01T14:00:00Z", { greenhouse: ok([old]) }, { maxAgeDays: 365 });
    await run(store, "2026-10-01T15:00:00Z", { greenhouse: ok([old]) });
    expect(store.feed("today", NOW).length).toBe(1);
  });
});
