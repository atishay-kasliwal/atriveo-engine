import { randomBytes } from "node:crypto";
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import { type CompanyBoard, type Level, SOURCE_IDS, type SourceId } from "./types.ts";

export interface EngineConfig {
  token: string;
  port: number;
  /** Title must contain one of `include` and none of `exclude` (whole-word match). */
  roles: { include: string[]; exclude: string[] };
  levels: Level[];
  maxYearsExperience: number;
  /** Location terms a posting must mention; empty means anywhere. Postings with no location pass. */
  locations: string[];
  remote: "any" | "remote-only";
  sponsorsOnly: boolean;
  excludeSponsorshipBlocked: boolean;
  /** Ignore never-seen postings published more than this many days ago. */
  maxAgeDays: number;
  companyExclude: string[];
  keywords: Record<string, number>;
  synergy: { keywords: string[]; points: number }[];
  levelScores: Record<string, number>;
  locationBonuses: { patterns: string[]; points: number }[];
  bigTech: string[];
  bonuses: { h1b: number; top500: number; bigTech: number; consultingPenalty: number };
  sources: Record<SourceId, boolean>;
  /** Boards added with `atriveo companies add`, on top of the bundled list. */
  companies: CompanyBoard[];
  useBundledCompanies: boolean;
  schedule: { enabled: boolean; intervalMinutes: number };
}

// Defaults ported from job-pipeline/job_pipeline/config.py.
export const DEFAULT_CONFIG: Omit<EngineConfig, "token"> = {
  port: 8787,
  roles: {
    include: [
      "software",
      "python",
      "backend",
      "new grad",
      "machine learning",
      "data scientist",
      "ml engineer",
      "ai engineer",
      "applied scientist",
      "full stack",
      "full-stack",
      "fullstack",
      "research engineer",
      "forward deployed",
      "forward-deployed",
      "data analyst",
      "data engineer",
      "frontend",
      "front end",
      "platform engineer",
      "site reliability",
      "infrastructure engineer",
      "developer",
    ],
    exclude: [
      "senior",
      "sr",
      "staff",
      "principal",
      "manager",
      "lead",
      "director",
      "architect",
      "vp",
      "vice president",
      "head of",
      "sdet",
      "test automation",
      "automation engineer",
      "qa engineer",
      "quality assurance",
      "quality engineer",
      "test engineer",
      "testing engineer",
      "physical therapist",
      "physical therapy",
      "therapist",
      "electrical engineer",
      "electrical engineering",
      "nurse",
      "nursing",
    ],
  },
  levels: ["Intern", "Entry", "New Grad", "Mid"],
  maxYearsExperience: 3,
  locations: [
    "Alabama",
    "Alaska",
    "Arizona",
    "Arkansas",
    "California",
    "Colorado",
    "Connecticut",
    "Delaware",
    "Florida",
    "Georgia",
    "Hawaii",
    "Idaho",
    "Illinois",
    "Indiana",
    "Iowa",
    "Kansas",
    "Kentucky",
    "Louisiana",
    "Maine",
    "Maryland",
    "Massachusetts",
    "Michigan",
    "Minnesota",
    "Mississippi",
    "Missouri",
    "Montana",
    "Nebraska",
    "Nevada",
    "New Hampshire",
    "New Jersey",
    "New Mexico",
    "New York",
    "North Carolina",
    "North Dakota",
    "Ohio",
    "Oklahoma",
    "Oregon",
    "Pennsylvania",
    "Rhode Island",
    "South Carolina",
    "South Dakota",
    "Tennessee",
    "Texas",
    "Utah",
    "Vermont",
    "Virginia",
    "Washington",
    "West Virginia",
    "Wisconsin",
    "Wyoming",
    "AL",
    "AK",
    "AZ",
    "AR",
    "CA",
    "CO",
    "CT",
    "DE",
    "FL",
    "GA",
    "HI",
    "ID",
    "IL",
    "IN",
    "IA",
    "KS",
    "KY",
    "LA",
    "ME",
    "MD",
    "MA",
    "MI",
    "MN",
    "MS",
    "MO",
    "MT",
    "NE",
    "NV",
    "NH",
    "NJ",
    "NM",
    "NY",
    "NC",
    "ND",
    "OH",
    "OK",
    "OR",
    "PA",
    "RI",
    "SC",
    "SD",
    "TN",
    "TX",
    "UT",
    "VT",
    "VA",
    "WA",
    "WV",
    "WI",
    "WY",
    "United States",
    "Remote",
    "USA",
    "US",
  ],
  remote: "any",
  sponsorsOnly: false,
  excludeSponsorshipBlocked: false,
  maxAgeDays: 30,
  companyExclude: [
    "dice",
    "remotehunter",
    "jobs via dice",
    "jobot",
    "cybercoders",
    "lancesoft",
    "haystack",
    "turing",
    "micro1",
    "hackajob",
    "sundayy",
    "jobright.ai",
  ],
  keywords: {
    java: 5,
    spring: 6,
    "spring boot": 8,
    python: 7,
    fastapi: 7,
    django: 6,
    flask: 5,
    pydantic: 5,
    asyncio: 5,
    celery: 4,
    sqlalchemy: 4,
    aws: 7,
    lambda: 5,
    ecs: 5,
    sqs: 4,
    sns: 4,
    "api gateway": 5,
    gcp: 4,
    "google cloud": 4,
    microservices: 7,
    rest: 6,
    api: 6,
    "distributed systems": 8,
    grpc: 5,
    graphql: 4,
    docker: 6,
    kubernetes: 7,
    "ci/cd": 6,
    jenkins: 4,
    terraform: 5,
    postgresql: 4,
    postgres: 4,
    kafka: 5,
    redis: 4,
    airflow: 4,
    pandas: 3,
  },
  synergy: [
    { keywords: ["java", "spring", "aws"], points: 10 },
    { keywords: ["microservices", "docker", "kubernetes"], points: 10 },
    { keywords: ["python", "fastapi", "aws"], points: 10 },
    { keywords: ["python", "django", "aws"], points: 8 },
    { keywords: ["python", "fastapi", "postgresql"], points: 8 },
    { keywords: ["python", "celery", "kafka"], points: 7 },
    { keywords: ["rest", "api", "backend"], points: 10 },
  ],
  levelScores: { "new grad": 100, entry: 6, associate: 8, mid: 10, sde2: 10, senior: -3 },
  locationBonuses: [],
  bigTech: [
    "google",
    "amazon",
    "meta",
    "apple",
    "microsoft",
    "netflix",
    "uber",
    "airbnb",
    "twitter",
    "x corp",
  ],
  bonuses: { h1b: 8, top500: 50, bigTech: 2, consultingPenalty: -200 },
  sources: { greenhouse: true, lever: true, ashby: true, remotive: true, arbeitnow: true },
  companies: [],
  useBundledCompanies: true,
  schedule: { enabled: false, intervalMinutes: 60 },
};

/** Where the config, database, and caches live. ATRIVEO_HOME overrides. */
export function engineHome(): string {
  if (process.env.ATRIVEO_HOME) return process.env.ATRIVEO_HOME;
  switch (process.platform) {
    case "darwin":
      return join(homedir(), "Library", "Application Support", "atriveo-engine");
    case "win32":
      return join(process.env.APPDATA ?? join(homedir(), "AppData", "Roaming"), "atriveo-engine");
    default:
      return join(process.env.XDG_CONFIG_HOME ?? join(homedir(), ".config"), "atriveo-engine");
  }
}

export function configPath(): string {
  return join(engineHome(), "config.json");
}

export function databasePath(): string {
  return join(engineHome(), "atriveo.sqlite");
}

export function newToken(): string {
  return randomBytes(32).toString("hex");
}

export interface LoadedConfig {
  config: EngineConfig;
  /** True when this call created the token, so it should be shown once. */
  tokenCreated: boolean;
}

/** Reads the config, filling gaps from defaults; creates the file and a token on first use. */
export function loadConfig(): LoadedConfig {
  const path = configPath();
  let saved: Partial<EngineConfig> = {};
  if (existsSync(path)) {
    try {
      saved = JSON.parse(readFileSync(path, "utf8")) as Partial<EngineConfig>;
    } catch (e) {
      throw new Error(`Could not read ${path}: ${(e as Error).message}`);
    }
  }
  const config: EngineConfig = {
    ...DEFAULT_CONFIG,
    ...saved,
    roles: { ...DEFAULT_CONFIG.roles, ...saved.roles },
    bonuses: { ...DEFAULT_CONFIG.bonuses, ...saved.bonuses },
    sources: { ...DEFAULT_CONFIG.sources, ...saved.sources },
    schedule: { ...DEFAULT_CONFIG.schedule, ...saved.schedule },
    token: saved.token ?? "",
  };
  let tokenCreated = false;
  if (!config.token) {
    config.token = newToken();
    tokenCreated = true;
    saveConfig(config);
  }
  if (process.env.ATRIVEO_TOKEN) config.token = process.env.ATRIVEO_TOKEN;
  return { config, tokenCreated };
}

export function saveConfig(config: EngineConfig): void {
  mkdirSync(engineHome(), { recursive: true });
  // ATRIVEO_TOKEN (set by an app that launches the engine) applies to this
  // process only; keep the user's own token in the file.
  const envToken = process.env.ATRIVEO_TOKEN;
  if (envToken && config.token === envToken && existsSync(configPath())) {
    try {
      const saved = JSON.parse(readFileSync(configPath(), "utf8")) as Partial<EngineConfig>;
      if (saved.token) config = { ...config, token: saved.token };
    } catch {
      // Unreadable file: it's about to be replaced anyway.
    }
  }
  // The token guards the API, so keep the file private to this user.
  writeFileSync(configPath(), `${JSON.stringify(config, null, 2)}\n`, { mode: 0o600 });
}

const EDITABLE: readonly (keyof EngineConfig)[] = [
  "port",
  "roles",
  "levels",
  "maxYearsExperience",
  "locations",
  "remote",
  "sponsorsOnly",
  "excludeSponsorshipBlocked",
  "maxAgeDays",
  "companyExclude",
  "keywords",
  "synergy",
  "levelScores",
  "locationBonuses",
  "bigTech",
  "bonuses",
  "sources",
  "companies",
  "useBundledCompanies",
  "schedule",
];

const LEVELS: readonly Level[] = ["Intern", "Entry", "New Grad", "Mid", "Senior", "Staff", "Principal"];
const ATS_IDS = ["greenhouse", "lever", "ashby"];

const kind = (v: unknown) => (v === null ? "null" : Array.isArray(v) ? "array" : typeof v);

/** Problems with a partial config update; empty when it can be applied. */
export function validateConfigPatch(patch: Record<string, unknown>): string[] {
  const errors: string[] = [];
  for (const [key, value] of Object.entries(patch)) {
    if (!(EDITABLE as readonly string[]).includes(key)) {
      errors.push(`${key}: not a setting (see \`atriveo config get\`)`);
      continue;
    }
    const expected = kind(DEFAULT_CONFIG[key as keyof typeof DEFAULT_CONFIG]);
    if (kind(value) !== expected) {
      errors.push(`${key}: expected ${expected === "object" ? "an object" : `a ${expected}`}`);
      continue;
    }
    const list = value as unknown[];
    const record = value as Record<string, unknown>;
    switch (key) {
      case "port":
        if (!Number.isInteger(value) || (value as number) < 1 || (value as number) > 65535)
          errors.push("port: 1-65535");
        break;
      case "maxYearsExperience":
      case "maxAgeDays":
        if ((value as number) < 0) errors.push(`${key}: must not be negative`);
        break;
      case "remote":
        if (value !== "any" && value !== "remote-only") errors.push('remote: "any" or "remote-only"');
        break;
      case "levels":
        for (const l of list)
          if (!LEVELS.includes(l as Level))
            errors.push(`levels: "${String(l)}" is not one of ${LEVELS.join(", ")}`);
        break;
      case "locations":
      case "companyExclude":
      case "bigTech":
        if (list.some((x) => typeof x !== "string")) errors.push(`${key}: a list of strings`);
        break;
      case "roles":
        for (const k of ["include", "exclude"])
          if (
            record[k] !== undefined &&
            (kind(record[k]) !== "array" || (record[k] as unknown[]).some((x) => typeof x !== "string"))
          )
            errors.push(`roles.${k}: a list of strings`);
        break;
      case "keywords":
      case "levelScores":
        if (Object.values(record).some((x) => typeof x !== "number"))
          errors.push(`${key}: values must be numbers`);
        break;
      case "sources":
        for (const [id, on] of Object.entries(record)) {
          if (!(SOURCE_IDS as readonly string[]).includes(id)) errors.push(`sources.${id}: unknown source`);
          else if (typeof on !== "boolean") errors.push(`sources.${id}: true or false`);
        }
        break;
      case "companies":
        for (const c of list as Partial<CompanyBoard>[])
          if (
            typeof c?.name !== "string" ||
            typeof c.token !== "string" ||
            !ATS_IDS.includes(c.ats as string)
          )
            errors.push("companies: each needs name, token, and ats (greenhouse, lever, or ashby)");
        break;
      case "schedule":
        if (record.enabled !== undefined && typeof record.enabled !== "boolean")
          errors.push("schedule.enabled: true or false");
        if (
          record.intervalMinutes !== undefined &&
          (typeof record.intervalMinutes !== "number" || record.intervalMinutes < 15)
        )
          errors.push("schedule.intervalMinutes: at least 15");
        break;
    }
  }
  return errors;
}

/** Applies a partial update from the CLI or the API. Nested objects merge one level deep. */
export function applyConfigPatch(config: EngineConfig, patch: Record<string, unknown>): EngineConfig {
  const next = { ...config } as Record<string, unknown>;
  for (const [key, value] of Object.entries(patch)) {
    if (!(EDITABLE as readonly string[]).includes(key)) continue;
    const current = next[key];
    next[key] =
      kind(current) === "object" && kind(value) === "object" && key !== "keywords" && key !== "levelScores"
        ? { ...(current as object), ...(value as object) }
        : value;
  }
  return next as unknown as EngineConfig;
}

/**
 * A patch that sets one possibly nested setting, keeping its siblings:
 * `schedule.enabled` + `true` → `{ schedule: { ...current, enabled: true } }`.
 */
export function patchFromPath(config: EngineConfig, path: string, value: unknown): Record<string, unknown> {
  const [top, ...rest] = path.split(".").filter(Boolean);
  if (!top) return {};
  if (!rest.length) return { [top]: value };
  const root = structuredClone((config as unknown as Record<string, unknown>)[top] ?? {}) as Record<
    string,
    unknown
  >;
  let node = root;
  for (const key of rest.slice(0, -1)) {
    if (kind(node[key]) !== "object") node[key] = {};
    node = node[key] as Record<string, unknown>;
  }
  node[rest.at(-1) as string] = value;
  return { [top]: root };
}

/** The config without its token, safe to return over the API. */
export function publicConfig(config: EngineConfig): Omit<EngineConfig, "token"> {
  const { token: _token, ...rest } = config;
  return rest;
}
