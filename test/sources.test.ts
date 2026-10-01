import { describe, expect, test } from "bun:test";
import { boardsFor, parseBoardUrl } from "../src/sources/boards.ts";
import { Http, HttpError, mapPool } from "../src/sources/http.ts";
import { SOURCES } from "../src/sources/index.ts";
import type { SourceContext } from "../src/sources/types.ts";
import { Store } from "../src/store/db.ts";
import type { CompanyBoard } from "../src/types.ts";
import { fixture, mockFetch, noSleep } from "./helpers.ts";

const GH = "https://boards-api.greenhouse.io/v1/boards";
const signal = new AbortController().signal;

function context(
  routes: Parameters<typeof mockFetch>[0],
  boards: CompanyBoard[] = [],
  store?: Store,
): { ctx: SourceContext; calls: string[] } {
  const { fetch, calls } = mockFetch(routes);
  const http = new Http({ fetch, store, sleep: noSleep, retries: 2 });
  return { ctx: { http, signal, boards, concurrency: 6 }, calls };
}

describe("greenhouse", () => {
  const board: CompanyBoard = { name: "Northwind", ats: "greenhouse", token: "northwind" };

  test("lists without descriptions, then loads one on demand", async () => {
    const { ctx, calls } = context(
      {
        [`${GH}/northwind/jobs`]: fixture("greenhouse-list"),
        [`${GH}/northwind/jobs/4001`]: fixture("greenhouse-job"),
      },
      [board],
    );
    const result = await SOURCES.greenhouse.fetch(ctx);
    expect(result.ok).toBe(true);
    expect(calls).toEqual([`${GH}/northwind/jobs`]);
    const [first, second] = result.postings;
    expect(first).toMatchObject({
      source: "greenhouse",
      url: "https://northwind.example/careers?gh_jid=4001",
      company: "Northwind Labs",
      title: "Software Engineer, New Grad",
      location: "San Francisco, CA",
      isRemote: false,
      postedAt: "2026-09-30T14:00:00.000Z",
      description: null,
    });
    expect(second?.isRemote).toBe(true);
    const text = await first?.loadDescription?.(signal);
    expect(text).toBe(
      "About the role\nBuild REST APIs in Python & Go on AWS.\n• 0-2 years of experience\n• Kubernetes a plus",
    );
  });

  test("a missing board is a warning; a failing one is reported for carry-forward", async () => {
    const { ctx } = context(
      {
        [`${GH}/northwind/jobs`]: fixture("greenhouse-list"),
        [`${GH}/flaky/jobs`]: () => new Response("busy", { status: 503 }),
      },
      [
        board,
        { name: "Gone Co", ats: "greenhouse", token: "gone" },
        { name: "Flaky", ats: "greenhouse", token: "flaky" },
      ],
    );
    const result = await SOURCES.greenhouse.fetch(ctx);
    expect(result.postings.length).toBe(2);
    expect(result.warnings).toEqual(['Gone Co: no greenhouse board "gone"']);
    expect(result.failed).toEqual([{ company: "Flaky", error: `HTTP 503 from ${GH}/flaky/jobs` }]);
    expect(result.ok).toBe(true);
  });

  test("not ok when every board fails", async () => {
    const { ctx } = context({ [`${GH}/northwind/jobs`]: () => new Response("", { status: 500 }) }, [board]);
    expect((await SOURCES.greenhouse.fetch(ctx)).ok).toBe(false);
  });
});

describe("lever", () => {
  test("joins lists into the description and all locations into one", async () => {
    const { ctx } = context({ "https://api.lever.co/v0/postings/contoso?mode=json": fixture("lever") }, [
      { name: "Contoso", ats: "lever", token: "contoso" },
    ]);
    const [backend, intern] = (await SOURCES.lever.fetch(ctx)).postings;
    expect(backend).toMatchObject({
      source: "lever",
      company: "Contoso",
      title: "Backend Engineer",
      location: "New York, NY / Remote - US",
      isRemote: true,
      postedAt: new Date(1790800000000).toISOString(),
    });
    expect(backend?.description).toBe(
      "Contoso builds payment infrastructure.\n\nWhat you'll do\n• Build services in Python and Kafka\n• Own REST APIs\n\nQualifications\n• 1+ years of experience\n\nContoso sponsors visas for this role.",
    );
    expect(intern).toMatchObject({ location: "Remote", isRemote: true });
  });
});

describe("ashby", () => {
  test("skips unlisted jobs and includes secondary locations", async () => {
    const { ctx } = context({ "https://api.ashbyhq.com/posting-api/job-board/fabrikam": fixture("ashby") }, [
      { name: "Fabrikam", ats: "ashby", token: "fabrikam" },
    ]);
    const { postings } = await SOURCES.ashby.fetch(ctx);
    expect(postings.length).toBe(1);
    expect(postings[0]).toMatchObject({
      title: "Software Engineer, Frontend",
      location: "New York, NY (HQ) / Remote (US)",
      isRemote: true,
      postedAt: "2026-09-29T17:44:00.817Z",
      description: "React and TypeScript.",
    });
  });
});

describe("remotive", () => {
  const URL = "https://remotive.com/api/remote-jobs?category=software-dev";

  test("keeps the Remotive link and attribution; dates are UTC", async () => {
    const { ctx } = context({ [URL]: fixture("remotive") });
    const [usa, world] = (await SOURCES.remotive.fetch(ctx)).postings;
    expect(usa).toMatchObject({
      source: "remotive",
      url: "https://remotive.com/remote-jobs/software-dev/backend-engineer-501",
      company: "Tailspin Toys",
      location: "USA",
      isRemote: true,
      postedAt: "2026-09-30T08:15:00.000Z",
      description: "Python & AWS. 2+ years of experience.",
      attribution: "Remotive",
    });
    expect(world?.location).toBe("Remote (Worldwide)");
  });

  test("asks at most once per six hours", async () => {
    const store = new Store(":memory:");
    const { ctx, calls } = context({ [URL]: fixture("remotive") }, [], store);
    await SOURCES.remotive.fetch(ctx);
    await SOURCES.remotive.fetch(ctx);
    expect(calls.length).toBe(1);
  });
});

describe("arbeitnow", () => {
  test("reads one page with attribution and epoch-second dates", async () => {
    const { ctx, calls } = context({
      "https://www.arbeitnow.com/api/job-board-api?page=1": fixture("arbeitnow"),
    });
    const { postings } = await SOURCES.arbeitnow.fetch(ctx);
    expect(calls.length).toBe(1);
    expect(postings[0]).toMatchObject({
      company: "Litware GmbH",
      location: "Berlin",
      isRemote: false,
      postedAt: new Date(1790850000 * 1000).toISOString(),
      description: "Go & PostgreSQL.",
      attribution: "Arbeitnow",
    });
    expect(postings[1]?.isRemote).toBe(true);
  });
});

describe("http", () => {
  test("retries a 503 and honors Retry-After", async () => {
    const waits: number[] = [];
    const { fetch, calls } = mockFetch({
      "https://x.test/a": (n: number) =>
        n === 1
          ? new Response("", { status: 503, headers: { "Retry-After": "2" } })
          : Response.json({ ok: true }),
    });
    const http = new Http({ fetch, sleep: async (ms) => void waits.push(ms) });
    expect(await http.json<{ ok: boolean }>("https://x.test/a", { signal })).toEqual({ ok: true });
    expect(calls.length).toBe(2);
    expect(waits).toEqual([2000]);
  });

  test("backs off exponentially, then gives up", async () => {
    const waits: number[] = [];
    const { fetch, calls } = mockFetch({ "https://x.test/a": () => new Response("", { status: 429 }) });
    const http = new Http({ fetch, retries: 2, backoffMs: 100, sleep: async (ms) => void waits.push(ms) });
    await expect(http.text("https://x.test/a", { signal })).rejects.toBeInstanceOf(HttpError);
    expect(calls.length).toBe(3);
    expect(waits).toEqual([100, 200]);
  });

  test("does not retry a 404", async () => {
    const { fetch, calls } = mockFetch({});
    const http = new Http({ fetch, sleep: noSleep });
    await expect(http.text("https://x.test/missing", { signal })).rejects.toMatchObject({ status: 404 });
    expect(calls.length).toBe(1);
  });

  test("sends a descriptive User-Agent", async () => {
    let agent: string | null = null;
    const http = new Http({
      fetch: (async (_url: string, init: RequestInit) => {
        agent = new Headers(init.headers).get("user-agent");
        return Response.json({});
      }) as unknown as typeof fetch,
    });
    await http.text("https://x.test/", { signal });
    expect(agent ?? "").toMatch(/^atriveo-engine\/\d+\.\d+\.\d+ \(\+https:\/\/github\.com\//);
  });

  test("cancelling stops before the next request", async () => {
    const controller = new AbortController();
    controller.abort(new Error("cancelled"));
    const { fetch, calls } = mockFetch({ "https://x.test/a": {} });
    await expect(new Http({ fetch }).text("https://x.test/a", { signal: controller.signal })).rejects.toThrow(
      "cancelled",
    );
    expect(calls.length).toBe(0);
  });

  test("mapPool keeps order and the concurrency limit", async () => {
    let inFlight = 0;
    let peak = 0;
    const out = await mapPool([5, 1, 4, 2, 3, 0, 6], 3, async (n) => {
      inFlight += 1;
      peak = Math.max(peak, inFlight);
      await Bun.sleep(n);
      inFlight -= 1;
      return n * 10;
    });
    expect(out).toEqual([50, 10, 40, 20, 30, 0, 60]);
    expect(peak).toBe(3);
  });
});

describe("boards", () => {
  test.each([
    ["https://boards.greenhouse.io/stripe", "greenhouse", "stripe"],
    ["https://job-boards.greenhouse.io/stripe/jobs/123", "greenhouse", "stripe"],
    ["https://boards.greenhouse.io/embed/job_board?for=acme", "greenhouse", "acme"],
    ["jobs.lever.co/palantir", "lever", "palantir"],
    ["https://jobs.ashbyhq.com/ramp/1234", "ashby", "ramp"],
    ["https://api.ashbyhq.com/posting-api/job-board/ramp", "ashby", "ramp"],
  ])("%s", (url, ats, token) => {
    expect(parseBoardUrl(url)).toEqual({ ats: ats as CompanyBoard["ats"], token });
  });

  test("other careers sites are not boards", () => {
    expect(parseBoardUrl("https://www.linkedin.com/jobs/view/1")).toBeNull();
    expect(parseBoardUrl("https://careers.example.com/")).toBeNull();
    expect(parseBoardUrl("not a url")).toBeNull();
  });

  test("user boards come first and duplicates are dropped", () => {
    const mine: CompanyBoard = { name: "Mine", ats: "lever", token: "Mine" };
    const boards = boardsFor({ companies: [mine, { ...mine, token: "mine" }], useBundledCompanies: false });
    expect(boards).toEqual([mine]);
  });
});
