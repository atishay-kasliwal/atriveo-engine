// End to end: a real server on a free port, real sources and pipeline, with the
// network replaced by fixtures. The client side uses plain fetch, like the dock.
import { afterAll, describe, expect, test } from "bun:test";
import { DEFAULT_CONFIG, type EngineConfig } from "../src/config.ts";
import { Runner } from "../src/scheduler/runner.ts";
import { startServer } from "../src/server/index.ts";
import { Http } from "../src/sources/http.ts";
import { Store } from "../src/store/db.ts";
import type { CompanyBoard } from "../src/types.ts";
import { fixture, mockFetch, noSleep } from "./helpers.ts";

const GH = "https://boards-api.greenhouse.io/v1/boards/northwind";
const network = mockFetch({
  [`${GH}/jobs`]: fixture("greenhouse-list"),
  [`${GH}/jobs/4001`]: fixture("greenhouse-job"),
  "https://api.lever.co/v0/postings/contoso?mode=json": fixture("lever"),
  "https://api.ashbyhq.com/posting-api/job-board/fabrikam": fixture("ashby"),
  "https://remotive.com/api/remote-jobs?category=software-dev": fixture("remotive"),
  "https://www.arbeitnow.com/api/job-board-api?page=1": fixture("arbeitnow"),
});
const boards: CompanyBoard[] = [
  { name: "Northwind", ats: "greenhouse", token: "northwind" },
  { name: "Contoso", ats: "lever", token: "contoso" },
  { name: "Fabrikam", ats: "ashby", token: "fabrikam" },
];

const TOKEN = "e2e-token";
const config: EngineConfig = { ...DEFAULT_CONFIG, token: TOKEN };
const store = new Store(":memory:");
const http = new Http({ fetch: network.fetch, store, sleep: noSleep });
const runner = new Runner({
  store,
  http,
  config: () => config,
  pipeline: {
    boards,
    lists: { h1b: new Set(["contoso"]), top500: new Set() },
    now: new Date("2026-10-01T15:00:00Z"),
  },
});
const server = startServer({
  store,
  runner,
  http,
  config: () => config,
  saveConfig: () => {},
  host: "127.0.0.1",
  port: 0,
});
afterAll(() => server.stop(true));

const api = async (path: string, method = "GET") => {
  const res = await fetch(`http://127.0.0.1:${server.port}${path}`, {
    method,
    headers: { "X-Tailor-Token": TOKEN },
  });
  return { status: res.status, body: (await res.json()) as Record<string, unknown> & { jobs?: never[] } };
};

async function scrapeAndWait() {
  const start = await api("/scrape/start", "POST");
  expect(start.status).toBe(200);
  for (let i = 0; i < 200; i += 1) {
    const { body } = await api("/scrape/status");
    if (!body.running) return body as { state: { status: string; jobsBefore: number; jobsAfter: number } };
    await Bun.sleep(10);
  }
  throw new Error("scrape did not finish");
}

describe("serve + scrape", () => {
  test("a run fills the feed from every source", async () => {
    const status = await scrapeAndWait();
    expect(status.state.status).toBe("done");

    const { body } = await api("/jobs?type=hour");
    const jobs = body.jobs as unknown as Record<string, unknown>[];
    expect(jobs.map((j) => j.job_url).sort()).toEqual([
      "https://jobs.ashbyhq.com/fabrikam/aaaa0000-0000-4000-8000-000000000001",
      "https://jobs.lever.co/contoso/1111aaaa-0000-4000-8000-000000000001",
      "https://jobs.lever.co/contoso/2222bbbb-0000-4000-8000-000000000002",
      "https://northwind.example/careers?gh_jid=4001",
      "https://remotive.com/remote-jobs/software-dev/backend-engineer-501",
      "https://remotive.com/remote-jobs/software-dev/developer-advocate-502",
    ]);
    expect(status.state.jobsAfter - status.state.jobsBefore).toBe(6);
    expect(Math.max(...jobs.map((j) => j.score_pct as number))).toBe(100);

    const byUrl = new Map(jobs.map((j) => [j.job_url, j]));
    expect(byUrl.get("https://northwind.example/careers?gh_jid=4001")).toMatchObject({
      company: "Northwind Labs",
      site: "greenhouse",
      level: "New Grad",
      min_exp: 0,
      max_exp: 2,
      date_posted: "2026-09-30",
    });
    expect(byUrl.get("https://jobs.lever.co/contoso/1111aaaa-0000-4000-8000-000000000001")).toMatchObject({
      h1b_sponsor: true,
      search_term: "backend",
    });
    expect(byUrl.get("https://jobs.lever.co/contoso/2222bbbb-0000-4000-8000-000000000002")?.level).toBe(
      "Intern",
    );
    // Every job has what the dock needs to show it.
    for (const j of jobs) {
      expect(typeof j.title === "string" && typeof j.company === "string").toBe(true);
      expect(Number.isNaN(Date.parse(j.batch_time as string))).toBe(false);
      expect(new URL(j.job_url as string).protocol).toBe("https:");
    }
  });

  test("the next run finds nothing new and reuses cached data", async () => {
    const before = network.calls.length;
    const status = await scrapeAndWait();
    expect(status.state.jobsAfter - status.state.jobsBefore).toBe(0);
    expect((await api("/jobs?type=hour")).body.jobs).toEqual([]);
    expect(((await api("/jobs?type=today")).body.jobs as unknown[]).length).toBe(6);
    const again = network.calls.slice(before);
    // Remotive and Arbeitnow come from cache; Greenhouse's description isn't fetched again.
    expect(again.some((u) => u.includes("remotive.com") || u.includes("arbeitnow.com"))).toBe(false);
    expect(again.some((u) => u.endsWith("/jobs/4001"))).toBe(false);
  });

  test("status reports the phases and an estimate", async () => {
    const { body } = await api("/scrape/status");
    const state = body.state as { phases: { name: string; status: string; exitCode: number }[] };
    expect(state.phases.map((p) => `${p.name}:${p.status}:${p.exitCode}`)).toEqual([
      "fetch:ok:0",
      "filter:ok:0",
      "score:ok:0",
      "store:ok:0",
    ]);
    expect((body.estimate as { samples: number }).samples).toBe(2);
  });
});
