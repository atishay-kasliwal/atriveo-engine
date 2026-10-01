# Roadmap

## Decisions

| Decision | Choice | Why |
|---|---|---|
| Job sources | Public company job-board APIs (Greenhouse, Lever, Ashby) plus Remotive and Arbeitnow | Published by the companies for exactly this use: free, no keys, legal, and they cover thousands of tech employers |
| LinkedIn / Indeed | Not in the default build | Their terms forbid scraping and they block it at scale; possible later as an opt-in plugin |
| Storage | SQLite, one local file | No database server and no quota to fill |
| Language | TypeScript on Bun | Same language as Atriveo Dock; compiles to a single binary per platform; no Python runtime to break |
| Scope of v1 | Jobs only: feed, filters, scoring, scrape runs | Tailored resumes need a personal accomplishment bank; they stay with the full Atriveo pipeline for now |
| Platforms | macOS (universal), Linux, Windows | The engine is useful without the dock |
| License | MIT | |

## Phase 1: engine core

- [ ] Source plugins: Greenhouse, Lever, Ashby, Remotive, Arbeitnow, with concurrency limits, retries, response caching, and attribution where a source asks for it
- [ ] Company → job-board map, built by a discovery script from the top-500 company list and committed as data; `atriveo companies add <careers-url>` for more
- [ ] Normalize to one job shape; deduplicate across sources and runs
- [ ] Filters and scoring, ported from [job-pipeline](https://github.com/atishay-kasliwal/job-pipeline): role, seniority, years of experience, location/remote, sponsorship blockers, keyword weights
- [ ] H-1B sponsor flag and a "sponsors only" option, from the H-1B 2026 sponsor list
- [ ] SQLite store: runs, jobs, sightings
- [ ] HTTP API exactly as in [API.md](API.md)
- [ ] CLI: `atriveo serve`, `atriveo scrape`, `atriveo companies list|add|discover`, `atriveo config`
- [ ] Tests on recorded fixtures (no live network in CI), plus API contract tests

## Phase 2: packaging

- [ ] Single binaries: macOS universal, Linux x64/arm64, Windows x64
- [ ] GitHub Actions: CI on every push; tagged releases with binaries and `SHA256SUMS`
- [ ] npm package with an `atriveo` bin (`npx atriveo-engine serve`)
- [ ] README with a terminal demo, quick start, configuration, sources and their terms

## Phase 3: Atriveo Dock integration (dock repo)

- [ ] Bundle the engine binary with the dock; the dock starts and stops it on a free local port with a per-launch token
- [ ] Settings → Connection: **Local** (default), Remote sidecar, Demo
- [ ] First-run setup: roles, locations, remote preference, companies, sponsors-only
- [ ] Hide resume actions in Local mode until local resume building exists

## Phase 4: launch

- [ ] Re-record the dock demo on real local jobs
- [ ] Homebrew: `brew install atriveo-engine`, `brew install --cask atriveo-dock`
- [ ] Launch posts: Hacker News, Reddit (r/cscareerquestions, r/jobs), Product Hunt

## Later

- Opt-in plugins for other sources
- Local resume building from a user's own profile
- Windows and Linux builds of the dock
