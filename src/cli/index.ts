#!/usr/bin/env bun
import { parseArgs } from "node:util";
import {
  applyConfigPatch,
  configPath,
  databasePath,
  type EngineConfig,
  engineHome,
  loadConfig,
  newToken,
  patchFromPath,
  publicConfig,
  saveConfig,
  validateConfigPatch,
} from "../config.ts";
import { pidAlive, Runner } from "../scheduler/runner.ts";
import { startSchedule } from "../scheduler/schedule.ts";
import { isLoopback, startServer } from "../server/index.ts";
import { BUNDLED_BOARDS, boardKey, boardsFor, parseBoardUrl } from "../sources/boards.ts";
import { discoverBoard, inspectBoard } from "../sources/discover.ts";
import { Http } from "../sources/http.ts";
import { Store } from "../store/db.ts";
import { VERSION } from "../version.ts";

const HELP = `atriveo ${VERSION}: a local job-search engine

Usage:
  atriveo serve [--port 8787] [--host 127.0.0.1] [--allow-remote]
                                  Serve the HTTP API (docs/API.md)
  atriveo scrape [--json]         Run one scrape now and print the matches
  atriveo companies list [--mine] Company job boards that are scraped
  atriveo companies add <careers-url> [--name "Acme"]
                                  Add a Greenhouse, Lever, or Ashby board
  atriveo companies remove <careers-url | token>
  atriveo companies discover <company> [<company> ...]
                                  Look up companies' boards and add them
  atriveo config path             Where settings live
  atriveo config get [key]        Show settings (all, or one key)
  atriveo config set <key> <value>
                                  e.g. config set remote remote-only
                                       config set schedule.enabled true
                                       config set locations '["New York", "Remote"]'
  atriveo token [--rotate]        Show (or replace) the API token
  atriveo --version

Data directory: ${engineHome()}  (override with ATRIVEO_HOME)
`;

class UsageError extends Error {}

function die(message: string, code = 1): never {
  console.error(`atriveo: ${message}`);
  process.exit(code);
}

/** Values from the command line: JSON when it parses, otherwise the plain string. */
function parseValue(raw: string): unknown {
  try {
    return JSON.parse(raw);
  } catch {
    return raw;
  }
}

function openStore(): Store {
  const store = new Store(databasePath());
  store.reapStaleRuns(pidAlive);
  return store;
}

function showTokenOnce(token: string, created: boolean) {
  if (!created || process.env.ATRIVEO_TOKEN) return;
  console.log(`\nAPI token (created now; \`atriveo token\` shows it again):\n  ${token}\n`);
}

async function serve(args: string[]) {
  const { values } = parseArgs({
    args,
    options: {
      port: { type: "string" },
      host: { type: "string", default: "127.0.0.1" },
      "allow-remote": { type: "boolean", default: false },
    },
  });
  const { config: initial, tokenCreated } = loadConfig();
  let config = initial;
  const port = values.port !== undefined ? Number(values.port) : config.port;
  if (!Number.isInteger(port) || port < 0 || port > 65535) throw new UsageError(`bad --port ${values.port}`);
  const host = values.host ?? "127.0.0.1";
  if (!isLoopback(host) && !values["allow-remote"]) {
    throw new UsageError(
      `refusing to listen on ${host}: anyone who can reach it could use the API. Pass --allow-remote if you mean it.`,
    );
  }

  const store = openStore();
  const http = new Http({ store });
  const runner = new Runner({
    store,
    http,
    config: () => config,
    onLog: (line) => console.log(`[scrape] ${line}`),
  });
  const deps = {
    store,
    runner,
    http,
    config: () => config,
    saveConfig: (next: EngineConfig) => {
      saveConfig(next);
      config = next;
    },
  };
  let server: ReturnType<typeof startServer>;
  try {
    server = startServer({ ...deps, host, port });
  } catch (e) {
    const code = (e as NodeJS.ErrnoException).code;
    die(
      code === "EADDRINUSE" ? `port ${port} is already in use; try --port ${port + 1}` : (e as Error).message,
    );
  }
  const stopSchedule = startSchedule({ runner, store, config: () => config });

  console.log(
    `atriveo-engine ${VERSION} listening on http://${host.includes(":") ? `[${host}]` : host}:${server.port}`,
  );
  console.log(`data: ${engineHome()}`);
  if (config.schedule.enabled) console.log(`scraping every ${config.schedule.intervalMinutes} minutes`);
  showTokenOnce(config.token, tokenCreated);

  let stopping = false;
  const stop = async () => {
    if (stopping) return;
    stopping = true;
    stopSchedule();
    runner.cancel();
    await Promise.race([runner.idle(), Bun.sleep(5000)]);
    server.stop(true);
    store.close();
    process.exit(0);
  };
  process.on("SIGINT", stop);
  process.on("SIGTERM", stop);
}

async function scrape(args: string[]) {
  const { values } = parseArgs({ args, options: { json: { type: "boolean", default: false } } });
  const { config, tokenCreated } = loadConfig();
  const store = openStore();
  const runner = new Runner({
    store,
    http: new Http({ store }),
    config: () => config,
    onLog: (line) => console.error(line),
  });
  const started = runner.start();
  if (!started.ok) die(`a scrape is already running (${started.runId})`);
  process.on("SIGINT", () => runner.cancel());
  await runner.idle();

  const state = store.latestRunState();
  const jobs = store.feed("today");
  if (values.json) {
    console.log(JSON.stringify({ state, jobs }, null, 2));
  } else if (state.status === "done") {
    const added = (state.jobsAfter ?? 0) - (state.jobsBefore ?? 0);
    console.log(`\n${jobs.length} matching jobs today (${added} new this run). Top 10:\n`);
    for (const j of jobs.slice(0, 10)) {
      const via =
        j.site === "remotive" ? " (via Remotive)" : j.site === "arbeitnow" ? " (via Arbeitnow)" : "";
      console.log(`  ${String(j.score_pct).padStart(3)}%  ${j.title} | ${j.company}${via}`);
      console.log(`        ${j.location || "location not listed"} · ${j.job_url}`);
    }
    console.log(`\nServe them to the dock or any client with \`atriveo serve\`.`);
  }
  showTokenOnce(config.token, tokenCreated);
  store.close();
  process.exit(state.status === "done" ? 0 : state.status === "cancelled" ? 130 : 1);
}

async function companies(args: string[]) {
  const [action, ...rest] = args;
  const { values, positionals } = parseArgs({
    args: rest,
    allowPositionals: true,
    options: { name: { type: "string" }, mine: { type: "boolean", default: false } },
  });
  const { config } = loadConfig();
  const signal = new AbortController().signal;
  const http = new Http({ retries: 1 });

  switch (action) {
    case "list": {
      const mine = new Set(config.companies.map(boardKey));
      const boards = values.mine ? config.companies : boardsFor(config);
      for (const b of boards) {
        console.log(
          `${b.name.padEnd(28)} ${b.ats.padEnd(10)} ${b.token}${mine.has(boardKey(b)) ? "  (added)" : ""}`,
        );
      }
      console.log(
        `\n${boards.length} boards (${config.companies.length} added by you${
          config.useBundledCompanies ? `, ${BUNDLED_BOARDS.length} bundled` : ", bundled list off"
        })`,
      );
      return;
    }
    case "add": {
      const url = positionals[0];
      if (!url) throw new UsageError("companies add <careers-url>");
      const parsed = parseBoardUrl(url);
      if (!parsed) {
        die(
          "that isn't a Greenhouse, Lever, or Ashby board link (e.g. https://boards.greenhouse.io/acme, https://jobs.lever.co/acme, https://jobs.ashbyhq.com/acme)",
        );
      }
      const info = await inspectBoard(http, parsed, signal);
      if (!info.exists) die(`no public ${parsed.ats} board "${parsed.token}"`);
      const board = { name: values.name?.trim() || info.name || parsed.token, ...parsed };
      saveConfig({
        ...config,
        companies: [...config.companies.filter((c) => boardKey(c) !== boardKey(board)), board],
      });
      console.log(`Added ${board.name} (${board.ats}:${board.token}), ${info.postings} open postings.`);
      return;
    }
    case "remove": {
      const target = positionals[0];
      if (!target) throw new UsageError("companies remove <careers-url | token>");
      const token = (parseBoardUrl(target)?.token ?? target).toLowerCase();
      const kept = config.companies.filter((c) => c.token.toLowerCase() !== token);
      if (kept.length === config.companies.length) {
        die(
          `"${target}" isn't one of your added boards${
            BUNDLED_BOARDS.some((b) => b.token.toLowerCase() === token)
              ? " (it's bundled; `atriveo config set useBundledCompanies false` turns the bundled list off)"
              : ""
          }`,
        );
      }
      saveConfig({ ...config, companies: kept });
      console.log(`Removed ${config.companies.length - kept.length} board(s).`);
      return;
    }
    case "discover": {
      if (!positionals.length) throw new UsageError("companies discover <company> [<company> ...]");
      let added = [...config.companies];
      for (const name of positionals) {
        const board = await discoverBoard(http, name, signal);
        if (!board) {
          console.log(`${name}: no public Greenhouse, Lever, or Ashby board found`);
          continue;
        }
        added = [...added.filter((c) => boardKey(c) !== boardKey(board)), board];
        console.log(`${name}: ${board.ats}:${board.token}`);
      }
      saveConfig({ ...config, companies: added });
      return;
    }
    default:
      throw new UsageError("companies list | add <careers-url> | remove <url|token> | discover <company...>");
  }
}

function configCommand(args: string[]) {
  const [action, key, ...rest] = args;
  switch (action) {
    case "path":
      console.log(configPath());
      return;
    case "get": {
      const shown = publicConfig(loadConfig().config) as unknown as Record<string, unknown>;
      let value: unknown = shown;
      for (const part of key ? key.split(".") : [])
        value = (value as Record<string, unknown> | undefined)?.[part];
      if (value === undefined) die(`no setting "${key}"`);
      console.log(typeof value === "string" ? value : JSON.stringify(value, null, 2));
      return;
    }
    case "set": {
      if (!key || !rest.length) throw new UsageError("config set <key> <value>");
      const { config } = loadConfig();
      const patch = patchFromPath(config, key, parseValue(rest.join(" ")));
      const errors = validateConfigPatch(patch);
      if (errors.length) die(errors.join("\n"));
      saveConfig(applyConfigPatch(config, patch));
      console.log(`${key} = ${JSON.stringify(parseValue(rest.join(" ")))}`);
      return;
    }
    default:
      throw new UsageError("config path | get [key] | set <key> <value>");
  }
}

function token(args: string[]) {
  const { values } = parseArgs({ args, options: { rotate: { type: "boolean", default: false } } });
  const { config } = loadConfig();
  if (values.rotate) {
    const next = { ...config, token: newToken() };
    saveConfig(next);
    console.log(next.token);
    console.error("Restart `atriveo serve` and update any client that used the old token.");
    return;
  }
  console.log(process.env.ATRIVEO_TOKEN || config.token);
}

export async function main(argv: string[]) {
  const [command, ...args] = argv;
  try {
    switch (command) {
      case "serve":
        return await serve(args);
      case "scrape":
        return await scrape(args);
      case "companies":
        return await companies(args);
      case "config":
        return configCommand(args);
      case "token":
        return token(args);
      case "-v":
      case "--version":
      case "version":
        console.log(VERSION);
        return;
      case undefined:
      case "-h":
      case "--help":
      case "help":
        console.log(HELP);
        return;
      default:
        throw new UsageError(`unknown command "${command}"`);
    }
  } catch (e) {
    if (e instanceof UsageError) die(`${e.message}\nRun \`atriveo help\` for usage.`, 2);
    if ((e as { code?: string }).code?.startsWith("ERR_PARSE_ARGS")) die((e as Error).message, 2);
    die((e as Error).message);
  }
}

if (import.meta.main) await main(process.argv.slice(2));
