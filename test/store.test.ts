process.env.TZ = "America/New_York";

import { describe, expect, test } from "bun:test";
import { localDayBounds } from "../src/core/days.ts";
import { Store, type StoredJob } from "../src/store/db.ts";

const job = (url: string, score: number, over: Partial<StoredJob> = {}): StoredJob => ({
  job_url: url,
  site: "greenhouse",
  company: "Acme",
  title: "Software Engineer",
  location: "Austin, TX",
  date_posted: "2026-10-01",
  summary: "Build things.",
  search_term: "software",
  level: "Entry",
  min_exp: null,
  max_exp: null,
  h1b_sponsor: false,
  sponsorship_blocked: false,
  score,
  score_pct: score,
  competition_score: 0,
  board: "",
  ...over,
});

function completedRun(store: Store, id: string, jobs: StoredJob[]) {
  store.createRun(id, store.jobCount());
  store.upsertJobs(id, jobs);
  store.finishRun(id, "done", { phases: [], jobsAfter: store.jobCount() });
}

describe("day bounds", () => {
  test("DST days are 25 and 23 hours long", () => {
    const fall = localDayBounds(0, new Date("2026-11-01T17:00:00Z"));
    const spring = localDayBounds(0, new Date("2026-03-08T16:00:00Z"));
    expect((fall[1].getTime() - fall[0].getTime()) / 3_600_000).toBe(25);
    expect((spring[1].getTime() - spring[0].getTime()) / 3_600_000).toBe(23);
    expect(fall[0].toISOString()).toBe("2026-11-01T04:00:00.000Z");
  });
});

describe("feed", () => {
  test("hour is the latest run's new jobs; closed jobs drop out", () => {
    const store = new Store(":memory:");
    completedRun(store, "2026-10-01T13:00:00Z", [job("https://x.test/a", 50), job("https://x.test/b", 40)]);
    completedRun(store, "2026-10-01T14:00:00Z", [job("https://x.test/a", 55), job("https://x.test/c", 70)]);

    const hour = store.feed("hour", new Date("2026-10-01T14:30:00Z"));
    expect(hour.map((j) => j.job_url)).toEqual(["https://x.test/c"]);
    expect(hour[0]?.batch_time).toBe("2026-10-01T14:00:00Z");

    // b was not seen in the latest run, so it's closed and leaves every view.
    const today = store.feed("today", new Date("2026-10-01T14:30:00Z"));
    expect(today.map((j) => j.job_url)).toEqual(["https://x.test/c", "https://x.test/a"]);
    expect(today.find((j) => j.job_url === "https://x.test/a")?.batch_time).toBe("2026-10-01T13:00:00Z");
  });

  test("today vs yesterday use local midnight", () => {
    const store = new Store(":memory:");
    // 03:30Z is 23:30 the previous evening in New York.
    completedRun(store, "2026-10-01T03:30:00Z", [job("https://x.test/late", 10)]);
    completedRun(store, "2026-10-01T14:00:00Z", [
      job("https://x.test/late", 10),
      job("https://x.test/now", 20),
    ]);
    const now = new Date("2026-10-01T15:00:00Z");
    expect(store.feed("yesterday", now).map((j) => j.job_url)).toEqual(["https://x.test/late"]);
    expect(store.feed("today", now).map((j) => j.job_url)).toEqual(["https://x.test/now"]);
    expect(store.feed("week", now).map((j) => j.job_url)).toEqual([
      "https://x.test/now",
      "https://x.test/late",
    ]);
  });

  test("a failed source's jobs are carried forward", () => {
    const store = new Store(":memory:");
    completedRun(store, "2026-10-01T13:00:00Z", [job("https://x.test/lv", 30, { site: "lever" })]);
    store.createRun("2026-10-01T14:00:00Z", 1);
    store.carryForward("2026-10-01T13:00:00Z", "2026-10-01T14:00:00Z", ["lever"]);
    store.finishRun("2026-10-01T14:00:00Z", "done", { phases: [] });
    expect(store.feed("today", new Date("2026-10-01T15:00:00Z")).length).toBe(1);
  });
});

describe("runs", () => {
  test("a running row from a dead process becomes interrupted", () => {
    const store = new Store(":memory:");
    store.db
      .query(
        "INSERT INTO runs (id, status, phases, started_at, updated_at, pid) VALUES (?, 'running', '[]', ?, ?, ?)",
      )
      .run("2026-10-01T10:00:00Z", "2026-10-01T10:00:00Z", "2026-10-01T10:00:00Z", 999_999);
    store.reapStaleRuns(() => false);
    expect(store.latestRunState().status).toBe("interrupted");
  });

  test("estimate is the median of recent successful runs", () => {
    const store = new Store(":memory:");
    for (const [id, secs] of [
      ["2026-10-01T10:00:00Z", 30],
      ["2026-10-01T11:00:00Z", 50],
      ["2026-10-01T12:00:00Z", 40],
    ] as const) {
      store.createRun(id, 0);
      store.db
        .query("UPDATE runs SET status='done', finished_at=? WHERE id=?")
        .run(new Date(Date.parse(id) + secs * 1000).toISOString().replace(/\.\d{3}Z$/, "Z"), id);
    }
    expect(store.estimate()).toMatchObject({ totalSec: 40, samples: 3 });
  });

  test("idle state when nothing has run", () => {
    expect(new Store(":memory:").latestRunState()).toEqual({
      runId: null,
      status: "idle",
      phase: null,
      phases: [],
    });
  });
});
