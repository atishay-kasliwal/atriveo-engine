// Contract tests: responses match docs/API.md, which the dock depends on.
import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { DEFAULT_CONFIG, type EngineConfig } from "../src/config.ts";
import { Runner } from "../src/scheduler/runner.ts";
import { createHandler, isLoopback } from "../src/server/index.ts";
import { Http } from "../src/sources/http.ts";
import { Store, type StoredJob } from "../src/store/db.ts";
import { mockFetch } from "./helpers.ts";

const home = mkdtempSync(join(tmpdir(), "atriveo-test-"));
beforeAll(() => {
  process.env.ATRIVEO_HOME = home;
});
afterAll(() => rmSync(home, { recursive: true, force: true }));

const TOKEN = "secret-token";

// Tests compare whole bodies with toEqual, so loose typing is enough here.
// biome-ignore lint/suspicious/noExplicitAny: response bodies are checked by value
type JsonResponse = Omit<Response, "json"> & { json(): Promise<any> };

function setup(overrides: Partial<EngineConfig> = {}) {
  const store = new Store(":memory:");
  let config: EngineConfig = { ...DEFAULT_CONFIG, token: TOKEN, ...overrides };
  const http = new Http({ fetch: mockFetch({}).fetch });
  const runner = new Runner({ store, http, config: () => config, pipeline: { boards: [] } });
  const handler = createHandler({
    store,
    runner,
    http,
    config: () => config,
    saveConfig: (next) => {
      config = next;
    },
  });
  const call = (path: string, init: RequestInit & { token?: string | null } = {}) => {
    const headers = new Headers(init.headers);
    const token = init.token === undefined ? TOKEN : init.token;
    if (token) headers.set("X-Tailor-Token", token);
    return handler(new Request(`http://127.0.0.1${path}`, { ...init, headers })) as Promise<JsonResponse>;
  };
  return { store, call, config: () => config };
}

const stored = (url: string, score: number): StoredJob => ({
  job_url: url,
  site: "greenhouse",
  company: "Northwind",
  title: "Software Engineer",
  location: "Austin, TX",
  date_posted: "2026-10-01",
  summary: "Build APIs.",
  search_term: "software",
  level: "Entry",
  min_exp: 1,
  max_exp: 2,
  h1b_sponsor: true,
  sponsorship_blocked: false,
  score,
  score_pct: score,
  competition_score: 2,
  board: "greenhouse:northwind",
});

describe("auth and CORS", () => {
  test("requests without the token are refused", async () => {
    const { call } = setup();
    for (const token of [null, "wrong", `${TOKEN}x`]) {
      const res = await call("/health", { token });
      expect(res.status).toBe(401);
      expect(await res.json()).toEqual({ ok: false, error: "Unauthorized" });
      expect(res.headers.get("access-control-allow-origin")).toBe("*");
    }
  });

  test("preflight needs no token", async () => {
    const { call } = setup();
    const res = await call("/jobs", { method: "OPTIONS", token: null });
    expect(res.status).toBe(204);
    expect(res.headers.get("access-control-allow-headers")).toBe("Content-Type, X-Tailor-Token");
    expect(res.headers.get("access-control-allow-methods")).toBe("GET,POST,PUT,OPTIONS");
  });

  test("unknown routes are 404 JSON", async () => {
    const res = await setup().call("/nope");
    expect(res.status).toBe(404);
    expect((await res.json()).ok).toBe(false);
  });

  test("only loopback hosts count as local", () => {
    expect(["127.0.0.1", "localhost", "::1", "[::1]", "127.0.0.2"].every(isLoopback)).toBe(true);
    expect(["0.0.0.0", "192.168.1.5", "example.com"].some(isLoopback)).toBe(false);
  });
});

describe("health and feed", () => {
  test("health before any run", async () => {
    const body = await (await setup().call("/health")).json();
    expect(body).toEqual({ ok: true, version: "0.1.0", jobs: 0, lastRunAt: null });
  });

  test("jobs have every field the API documents", async () => {
    const { store, call } = setup();
    store.createRun("2026-10-01T14:00:00Z", 0);
    store.upsertJobs("2026-10-01T14:00:00Z", [
      stored("https://x.test/a", 80),
      stored("https://x.test/b", 90),
    ]);
    store.finishRun("2026-10-01T14:00:00Z", "done", { phases: [], jobsAfter: 2 });

    const body = await (await call("/jobs?type=hour")).json();
    expect(body).toMatchObject({ ok: true, type: "hour", count: 2 });
    expect(body.jobs[0]).toEqual({
      job_url: "https://x.test/b",
      session_id: "2026-10-01T14:00:00Z",
      batch_time: "2026-10-01T14:00:00Z",
      company: "Northwind",
      title: "Software Engineer",
      location: "Austin, TX",
      level: "Entry",
      score: 90,
      score_pct: 90,
      competition_score: 2,
      summary: "Build APIs.",
      search_term: "software",
      site: "greenhouse",
      date_posted: "2026-10-01",
      min_exp: 1,
      max_exp: 2,
      pipeline: "standard",
      h1b_sponsor: true,
      sponsorship_blocked: false,
    });
    expect((await (await call("/health")).json()).jobs).toBe(2);
  });

  test("type defaults to today; bad types are 400", async () => {
    const { call } = setup();
    expect((await (await call("/jobs")).json()).type).toBe("today");
    expect((await call("/jobs?type=month")).status).toBe(400);
  });
});

describe("scrape runs", () => {
  test("idle status before any run", async () => {
    const body = await (await setup().call("/scrape/status?t=123")).json();
    expect(body).toEqual({
      ok: true,
      running: false,
      knownPhases: ["fetch", "filter", "score", "store"],
      state: { runId: null, status: "idle", phase: null, phases: [] },
      estimate: { totalSec: null, samples: 0, byPhase: {} },
    });
  });

  test("a second start while running is 409 with the running id", async () => {
    const { call } = setup({
      sources: { ...DEFAULT_CONFIG.sources, greenhouse: false, lever: false, ashby: false },
    });
    const first = await (await call("/scrape/start", { method: "POST" })).json();
    expect(first.ok).toBe(true);
    const second = await call("/scrape/start", { method: "POST" });
    expect(second.status).toBe(409);
    expect(await second.json()).toEqual({ ok: false, error: "already running", runId: first.runId });
  });

  test("log lines", async () => {
    expect(await (await setup().call("/scrape/log")).json()).toEqual({ ok: true, lines: [] });
  });
});

describe("settings", () => {
  test("GET /config never includes the token", async () => {
    const body = await (await setup().call("/config")).json();
    expect(body.ok).toBe(true);
    expect(body.config.token).toBeUndefined();
    expect(body.config.levels).toEqual(["Intern", "Entry", "New Grad", "Mid"]);
  });

  test("PUT /config validates, then saves", async () => {
    const { call, config } = setup();
    const bad = await call("/config", { method: "PUT", body: JSON.stringify({ remote: "sometimes" }) });
    expect(bad.status).toBe(400);
    const good = await call("/config", {
      method: "PUT",
      body: JSON.stringify({ remote: "remote-only", sponsorsOnly: true, schedule: { enabled: true } }),
    });
    expect(good.status).toBe(200);
    expect(config()).toMatchObject({ remote: "remote-only", sponsorsOnly: true, token: TOKEN });
    expect(config().schedule).toEqual({ enabled: true, intervalMinutes: 60 });
  });

  test("POST /companies rejects links that aren't job boards", async () => {
    const res = await setup().call("/companies", {
      method: "POST",
      body: JSON.stringify({ url: "https://careers.example.com" }),
    });
    expect(res.status).toBe(400);
  });
});

describe("resume endpoints in v1", () => {
  test("queue reads are empty, writes are 501", async () => {
    const { call } = setup();
    expect(await (await call("/compile-queue?limit=2000")).json()).toEqual({ ok: true, jobs: [] });
    expect(await (await call("/compile-queue/stats")).json()).toEqual({
      ok: true,
      queued: 0,
      running: 0,
      active: 0,
    });
    expect(await (await call("/compile-queue/lookup", { method: "POST", body: "{}" })).json()).toEqual({
      ok: true,
      jobs: [],
    });
    for (const path of ["/compile-enqueue", "/compile-enqueue-batch", "/cover-enqueue", "/manual-jd"]) {
      const res = await call(path, { method: "POST", body: "{}" });
      expect(res.status).toBe(501);
      expect((await res.json()).error).toBe("Resume building isn't available in local mode yet");
    }
  });

  test("resume profile is stored locally; unknown fields are ignored", async () => {
    const { call } = setup();
    const put = await call("/resume-profile", {
      method: "PUT",
      body: JSON.stringify({ name: " Ada ", bogus: "x" }),
    });
    const { profile } = await put.json();
    expect(profile).toEqual({
      name: "Ada",
      title: "",
      email: "",
      phone: "",
      location: "",
      linkedin: "",
      github: "",
      portfolio: "",
    });
    expect((await (await call("/resume-profile")).json()).profile.name).toBe("Ada");
  });
});
