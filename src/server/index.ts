import { timingSafeEqual } from "node:crypto";
import {
  applyConfigPatch,
  configPath,
  type EngineConfig,
  publicConfig,
  validateConfigPatch,
} from "../config.ts";
import type { Runner } from "../scheduler/runner.ts";
import { boardKey, boardsFor, parseBoardUrl } from "../sources/boards.ts";
import { inspectBoard } from "../sources/discover.ts";
import type { Http } from "../sources/http.ts";
import type { FeedType, Store } from "../store/db.ts";
import { VERSION } from "../version.ts";

export interface ServerDeps {
  store: Store;
  runner: Runner;
  http: Http;
  config: () => EngineConfig;
  saveConfig: (config: EngineConfig) => void;
}

const CORS = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Headers": "Content-Type, X-Tailor-Token",
  "Access-Control-Allow-Methods": "GET,POST,PUT,OPTIONS",
};

const FEEDS: readonly FeedType[] = ["hour", "today", "yesterday", "week"];

const NOT_LOCAL = "Resume building isn't available in local mode yet";

const PROFILE_KEY = "resume-profile";
const EMPTY_PROFILE = {
  name: "",
  title: "",
  email: "",
  phone: "",
  location: "",
  linkedin: "",
  github: "",
  portfolio: "",
};

function json(body: unknown, status = 200): Response {
  return Response.json(body, { status, headers: CORS });
}

const fail = (status: number, error: string) => json({ ok: false, error }, status);

function tokenMatches(given: string | null, expected: string): boolean {
  if (!expected) return true;
  if (!given) return false;
  const a = Buffer.from(given);
  const b = Buffer.from(expected);
  return a.length === b.length && timingSafeEqual(a, b);
}

async function readJson(req: Request): Promise<Record<string, unknown> | null> {
  try {
    const body = await req.json();
    return body && typeof body === "object" && !Array.isArray(body)
      ? (body as Record<string, unknown>)
      : null;
  } catch {
    return null;
  }
}

/** The engine's HTTP API (docs/API.md) as a fetch handler, so tests can call it without a socket. */
export function createHandler(deps: ServerDeps): (req: Request) => Promise<Response> {
  const { store, runner } = deps;

  const routes: Record<string, (req: Request, url: URL) => Response | Promise<Response>> = {
    "GET /health": () =>
      json({ ok: true, version: VERSION, jobs: store.openJobCount(), lastRunAt: store.lastRunAt() }),

    "GET /jobs": (_req, url) => {
      const type = (url.searchParams.get("type") ?? "today") as FeedType;
      if (!FEEDS.includes(type)) return fail(400, `type must be one of ${FEEDS.join(", ")}`);
      const jobs = store.feed(type);
      return json({ ok: true, type, count: jobs.length, jobs });
    },

    "POST /scrape/start": () => {
      const result = runner.start();
      return result.ok ? json(result) : json(result, 409);
    },
    "POST /scrape/cancel": () => {
      runner.cancel();
      return json({ ok: true });
    },
    "GET /scrape/status": () => json(runner.status()),
    "GET /scrape/log": () => json({ ok: true, lines: runner.log() }),

    // Engine extensions: settings and company boards, for setup screens.
    "GET /config": () => json({ ok: true, path: configPath(), config: publicConfig(deps.config()) }),
    "PUT /config": async (req) => {
      const patch = await readJson(req);
      if (!patch) return fail(400, "Send a JSON object of settings to change");
      const errors = validateConfigPatch(patch);
      if (errors.length) return fail(400, errors.join("; "));
      const next = applyConfigPatch(deps.config(), patch);
      deps.saveConfig(next);
      return json({ ok: true, config: publicConfig(next) });
    },
    "GET /companies": () => {
      const config = deps.config();
      const mine = new Set(config.companies.map(boardKey));
      return json({
        ok: true,
        useBundledCompanies: config.useBundledCompanies,
        companies: boardsFor(config).map((b) => ({ ...b, added: mine.has(boardKey(b)) })),
      });
    },
    "POST /companies": async (req) => {
      const body = await readJson(req);
      const parsed = typeof body?.url === "string" ? parseBoardUrl(body.url) : null;
      if (!parsed) {
        return fail(
          400,
          "url must be a Greenhouse, Lever, or Ashby job board link, e.g. https://jobs.lever.co/acme",
        );
      }
      const info = await inspectBoard(deps.http, parsed, req.signal);
      if (!info.exists) return fail(404, `No public ${parsed.ats} board "${parsed.token}"`);
      const config = deps.config();
      const board = {
        name: (typeof body?.name === "string" && body.name.trim()) || info.name || parsed.token,
        ...parsed,
      };
      const companies = [...config.companies.filter((c) => boardKey(c) !== boardKey(board)), board];
      deps.saveConfig({ ...config, companies });
      return json({ ok: true, company: board, postings: info.postings });
    },

    // Resume building isn't part of v1; answer so the dock degrades quietly.
    "GET /compile-queue": () => json({ ok: true, jobs: [] }),
    "GET /compile-queue/stats": () => json({ ok: true, queued: 0, running: 0, active: 0 }),
    "POST /compile-queue/lookup": () => json({ ok: true, jobs: [] }),
    "POST /compile-enqueue": () => fail(501, NOT_LOCAL),
    "POST /compile-enqueue-batch": () => fail(501, NOT_LOCAL),
    "POST /cover-enqueue": () => fail(501, NOT_LOCAL),
    "POST /manual-jd": () => fail(501, NOT_LOCAL),
    "GET /resume-profile": () => {
      const saved = store.getKv(PROFILE_KEY);
      return json({ ok: true, profile: { ...EMPTY_PROFILE, ...(saved ? JSON.parse(saved) : {}) } });
    },
    "PUT /resume-profile": async (req) => {
      const patch = await readJson(req);
      if (!patch) return fail(400, "Send a JSON object");
      const saved = store.getKv(PROFILE_KEY);
      const profile: Record<string, string> = { ...EMPTY_PROFILE, ...(saved ? JSON.parse(saved) : {}) };
      for (const key of Object.keys(EMPTY_PROFILE)) {
        if (typeof patch[key] === "string") profile[key] = (patch[key] as string).trim();
      }
      store.setKv(PROFILE_KEY, JSON.stringify(profile));
      return json({ ok: true, profile });
    },
  };

  return async (req) => {
    if (req.method === "OPTIONS") return new Response(null, { status: 204, headers: CORS });
    if (!tokenMatches(req.headers.get("x-tailor-token"), deps.config().token))
      return fail(401, "Unauthorized");
    const url = new URL(req.url);
    const route = routes[`${req.method} ${url.pathname.replace(/\/+$/, "") || "/"}`];
    if (!route) return fail(404, `No route for ${req.method} ${url.pathname}`);
    try {
      return await route(req, url);
    } catch (e) {
      return fail(500, (e as Error).message);
    }
  };
}

export function isLoopback(host: string): boolean {
  const h = host.replace(/^\[|\]$/g, "").toLowerCase();
  return h === "localhost" || h === "::1" || /^127\.\d+\.\d+\.\d+$/.test(h);
}

export function startServer(deps: ServerDeps & { host: string; port: number }) {
  return Bun.serve({ hostname: deps.host, port: deps.port, fetch: createHandler(deps) });
}
