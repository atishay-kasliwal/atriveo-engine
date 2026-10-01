import { describe, expect, test } from "bun:test";
import { DEFAULT_CONFIG, type EngineConfig } from "../src/config.ts";
import { normalizeCompany, parseCompanyCsv } from "../src/core/company.ts";
import { canonicalUrl, dedupe } from "../src/core/dedupe.ts";
import { extractExperience, requiresMoreThan } from "../src/core/experience.ts";
import { buildFilters } from "../src/core/filters.ts";
import { tagLevel } from "../src/core/level.ts";
import { buildScorer, experienceScore, recencyScore, toPercent } from "../src/core/scoring.ts";
import { htmlToText, phraseMatcher, summarize } from "../src/core/text.ts";
import type { RawPosting } from "../src/types.ts";

const config: EngineConfig = { ...DEFAULT_CONFIG, token: "t" };

describe("text", () => {
  test("htmlToText unescapes Greenhouse's double-encoded HTML", () => {
    const gh =
      "&lt;p&gt;Build &amp;amp; ship&lt;/p&gt;&lt;ul&gt;&lt;li&gt;Go&lt;/li&gt;&lt;li&gt;Rust&lt;/li&gt;&lt;/ul&gt;";
    expect(htmlToText(gh)).toBe("Build & ship\n• Go\n• Rust");
  });

  test("summarize keeps whole sentences under the limit", () => {
    const text = "Join our platform team. You will build APIs that serve millions. ".repeat(6);
    const s = summarize(text, 100);
    expect(s.length).toBeLessThanOrEqual(100);
    expect(s.endsWith(".")).toBe(true);
  });

  test("phraseMatcher matches whole words only", () => {
    const m = phraseMatcher(["sr", "lead"]);
    expect(m("Sr. Software Engineer")).toBe("sr");
    expect(m("Software Engineer, SRE")).toBeNull();
    expect(m("Leading data platforms")).toBeNull();
    expect(m("Tech Lead")).toBe("lead");
  });
});

describe("experience", () => {
  test.each([
    ["2-4 years of experience", 2, 4],
    ["3 to 5 years of professional experience", 3, 5],
    ["5+ years building APIs", 5, 5],
    ["at least 1 year in Python", 1, 1],
    ["No experience requirement mentioned", null, null],
  ])("extracts from %p", (text, min, max) => {
    expect(extractExperience(text)).toEqual({ min, max });
  });

  test("requiresMoreThan uses the configured limit", () => {
    expect(requiresMoreThan("5+ years of experience with Java", 3)).toBe(true);
    expect(requiresMoreThan("minimum of 4 years", 3)).toBe(true);
    expect(requiresMoreThan("3 to 5 years of experience", 3)).toBe(false);
    expect(requiresMoreThan("5+ years of experience", 5)).toBe(false);
    expect(requiresMoreThan("We were founded 15 years ago", 3)).toBe(false);
  });
});

describe("level", () => {
  test.each([
    ["Software Engineer Intern, Summer 2027", null, "Intern"],
    ["Software Engineer, Internal Tools", null, "Entry"],
    ["Software Engineer, New Grad", null, "New Grad"],
    ["Software Engineer II", null, "Mid"],
    ["Staff Engineer", null, "Staff"],
    ["Backend Engineer", "Mentorship from senior engineers", "Entry"],
  ])("%p → %p", (title, description, level) => {
    expect(tagLevel(title, description)).toBe(level as ReturnType<typeof tagLevel>);
  });
});

describe("filters", () => {
  const f = buildFilters(config);

  test("roles: include term returned, seniority excluded", () => {
    expect(f.roleTerm("Software Engineer")).toBe("software");
    expect(f.roleTerm("Senior Software Engineer")).toBeNull();
    expect(f.roleTerm("Software Engineer, SRE")).toBe("software");
    expect(f.roleTerm("Account Executive")).toBeNull();
  });

  test("locations: US names and uppercase codes, blank passes", () => {
    expect(f.locationAllowed("San Francisco, CA")).toBe(true);
    expect(f.locationAllowed("New York City")).toBe(true);
    expect(f.locationAllowed("")).toBe(true);
    expect(f.locationAllowed("London, United Kingdom")).toBe(false);
    expect(f.locationAllowed("Berlin, in office")).toBe(false);
  });

  test("sponsorship blockers", () => {
    expect(f.sponsorshipBlocked("We are unable to sponsor visas for this role")).toBe(true);
    expect(f.sponsorshipBlocked("Must hold an active TS/SCI clearance")).toBe(true);
    expect(f.sponsorshipBlocked("Visa sponsorship available")).toBe(false);
  });

  test("aggregator companies and remote-only", () => {
    expect(f.companyExcluded("Jobs via Dice")).toBe(true);
    expect(f.companyExcluded("Northwind Labs")).toBe(false);
    const remoteOnly = buildFilters({ ...config, remote: "remote-only" });
    expect(remoteOnly.remoteAllowed({ isRemote: false, location: "Austin, TX" })).toBe(false);
    expect(remoteOnly.remoteAllowed({ isRemote: false, location: "Remote - US" })).toBe(true);
  });
});

describe("company lists", () => {
  test("normalizeCompany strips legal suffixes", () => {
    expect(normalizeCompany("Waymo LLC")).toBe("waymo");
    expect(normalizeCompany("Example Technologies, Inc.")).toBe("example");
  });

  test("parseCompanyCsv reads a quoted one-column CSV", () => {
    expect([...parseCompanyCsv('"company"\n"Acme Corp"\n"Beta, Inc."\n')]).toEqual(["acme", "beta"]);
  });
});

describe("scoring", () => {
  test("component tables match the Python pipeline", () => {
    expect(experienceScore(null, null)).toBe(0);
    expect(experienceScore(1, 3)).toBe(10);
    expect(experienceScore(0, 1)).toBe(8);
    expect(experienceScore(3, 5)).toBe(6);
    expect(experienceScore(5, 7)).toBe(0);
    expect(recencyScore(1)).toBe(10);
    expect(recencyScore(30)).toBe(2);
    expect(recencyScore(100)).toBe(-5);
  });

  test("keywords match whole words, boosts apply", () => {
    const scorer = buildScorer(config, { h1b: new Set(["acme"]), top500: new Set() });
    const now = new Date("2026-10-01T12:00:00Z");
    const base = {
      company: "Acme",
      location: "Austin, TX",
      site: "greenhouse" as const,
      postedAt: now,
      minExp: null,
      maxExp: null,
    };
    const strong = scorer.score(
      { ...base, title: "Backend Engineer", description: "Python, FastAPI, AWS, REST API" },
      now,
    );
    const weak = scorer.score(
      { ...base, title: "Backend Engineer", description: "We take interest in rapid growth" },
      now,
    );
    expect(strong.h1b).toBe(true);
    expect(strong.raw).toBeGreaterThan(40);
    expect(weak.raw).toBe(0);
  });

  test("toPercent scales to the run's best job", () => {
    expect(toPercent(120, 120)).toBe(100);
    expect(toPercent(60, 120)).toBe(50);
    expect(toPercent(-10, 120)).toBe(0);
  });
});

describe("dedupe", () => {
  const p = (over: Partial<RawPosting>): RawPosting => ({
    source: "greenhouse",
    url: "https://example.com/jobs/1",
    company: "Acme",
    title: "Software Engineer",
    location: "Austin, TX",
    isRemote: false,
    postedAt: null,
    description: "",
    ...over,
  });

  test("canonicalUrl keeps gh_jid and drops tracking params", () => {
    expect(canonicalUrl("https://Acme.com/careers?gh_jid=42&utm_source=x#apply")).toBe(
      "https://acme.com/careers?gh_jid=42",
    );
    expect(canonicalUrl("https://acme.com/careers?gh_jid=43")).not.toBe(
      canonicalUrl("https://acme.com/careers?gh_jid=42"),
    );
  });

  test("same role listed twice keeps the company board", () => {
    const out = dedupe([
      p({ source: "remotive", url: "https://remotive.com/job/9" }),
      p({ source: "greenhouse", url: "https://boards.greenhouse.io/acme/jobs/1" }),
      p({ title: "Data Engineer", url: "https://boards.greenhouse.io/acme/jobs/2" }),
    ]);
    expect(out.map((x) => x.source).sort()).toEqual(["greenhouse", "greenhouse"]);
  });
});
