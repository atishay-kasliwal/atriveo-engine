# atriveo-engine HTTP API

The engine serves the same HTTP API as the Atriveo tailor sidecar, so
[Atriveo Dock](https://github.com/atishay-kasliwal/atriveo-job-dock) works with
it unchanged. The dock's demo backend,
[`src/demo/demoServer.ts`](https://github.com/atishay-kasliwal/atriveo-job-dock/blob/main/src/demo/demoServer.ts),
is a complete in-process implementation of this contract and the reference
for any edge case not spelled out here.

## Conventions

- Default address: `http://127.0.0.1:8787`. Bind to loopback only.
- Every request must carry `X-Tailor-Token: <token>` when the engine has a token
  configured. Missing or wrong token → `401 {"ok":false,"error":"Unauthorized"}`.
- CORS: `Access-Control-Allow-Origin: *`, allow headers `Content-Type, X-Tailor-Token`,
  methods `GET,POST,PUT,OPTIONS`. `OPTIONS` → `204`.
- JSON in and out. Errors are `{"ok": false, "error": "<message>"}`.

## Health

`GET /health` → `{"ok": true, "version": "0.1.0", "jobs": 1234, "lastRunAt": "<ISO>"}`

## Feed

`GET /jobs?type=hour|today|yesterday|week` → `{"ok": true, "type": "today", "count": 42, "jobs": [Job, ...]}`

| type | Returns |
|---|---|
| `hour` | Jobs first seen in the most recent completed run (empty when that run found nothing new) |
| `today` | Open jobs first seen today (local calendar day), highest score first |
| `yesterday` | Same for yesterday |
| `week` | Open jobs first seen in the last 7 days, newest day first, then highest score |

A job is open while the latest completed run still sees it. A source or a
single company board that fails in a run keeps its jobs open until it answers
again. `batch_time` is when the job was first seen, so it stays put across runs.

### Job

| Field | Type | Notes |
|---|---|---|
| `job_url` | string | **Required.** Absolute http(s) URL; the job's identity |
| `company` | string | **Required** |
| `title` | string | **Required** |
| `batch_time` | ISO string | **Required.** When the run that found it happened |
| `session_id` | string | Run id (the run's ISO start time is fine) |
| `location` | string | May be `""` |
| `level` | string \| null | `Intern`, `Entry`, `New Grad`, `Mid`, `Senior`, `Staff`, `Principal` |
| `score` | number | Raw score |
| `score_pct` | number | 0–100; the best job in a run is 100 |
| `summary` | string | One or two sentences |
| `search_term` | string | The keyword or category that matched |
| `site` | string | Source: `greenhouse`, `lever`, `ashby`, `remotive`, `arbeitnow` |
| `date_posted` | string \| null | `YYYY-MM-DD` |
| `min_exp`, `max_exp` | number \| null | Years of experience parsed from the description |
| `pipeline` | string | `standard` |
| `h1b_sponsor` | boolean | Company appears in the H-1B sponsor list (engine extension) |
| `sponsorship_blocked` | boolean | Posting excludes visa sponsorship, citizenship-only or clearance (engine extension) |

The dock drops any row missing `job_url`, `company`, `title`, or a parseable
`batch_time`/`date_posted`. Extra fields are ignored.

## Scrape runs

`POST /scrape/start` → `{"ok": true, "runId": "<id>"}`, or `409 {"ok": false, "error": "already running", "runId": "<running id>"}`

`POST /scrape/cancel` → `{"ok": true}`

`GET /scrape/status` →

```json
{
  "ok": true,
  "running": true,
  "knownPhases": ["fetch", "filter", "score", "store"],
  "state": {
    "runId": "2026-10-01T14:45:00Z",
    "status": "running",
    "phase": "fetch",
    "phases": [
      { "name": "fetch", "status": "running", "startedAt": "2026-10-01T14:45:00Z" }
    ],
    "startedAt": "2026-10-01T14:45:00Z",
    "updatedAt": "2026-10-01T14:45:12Z",
    "finishedAt": null,
    "jobsBefore": 1200,
    "jobsAfter": null
  },
  "estimate": { "totalSec": 48, "samples": 5, "byPhase": { "fetch": 40, "filter": 2, "score": 2, "store": 4 } }
}
```

- `state.status`: `idle`, `running`, `done`, `failed`, `cancelled`, `interrupted`
- Phase `status`: `running`, `ok`, `failed`, `cancelled`; finished phases add `finishedAt` and `exitCode`
- `jobsAfter - jobsBefore` is shown to the user as "N new jobs"
- `estimate` is the median of recent successful runs; `totalSec: null` until one exists
- Idle with no run yet: `state = {"runId": null, "status": "idle", "phase": null, "phases": []}`

`GET /scrape/log` → `{"ok": true, "lines": ["greenhouse: 12472 postings from 96 boards", ...]}`, the
current or last run's progress lines (engine and sidecar both serve it).

The dock polls every 2 s while running and every 30 s when idle, and starts a
run at :45 past each hour while it's open.

## Settings and companies (engine extensions)

For setup screens. Not served by the Atriveo sidecar.

| Endpoint | Response |
|---|---|
| `GET /config` | `{"ok": true, "path": "<config file>", "config": {...}}`, every setting except the token |
| `PUT /config` | Body: settings to change, e.g. `{"remote": "remote-only", "schedule": {"enabled": true}}`. Objects merge one level deep (`keywords` and `levelScores` are replaced). → `{"ok": true, "config": {...}}`, or `400` listing what's wrong |
| `GET /companies` | `{"ok": true, "useBundledCompanies": true, "companies": [{"name", "ats", "token", "added"}]}` |
| `POST /companies` | Body: `{"url": "<Greenhouse, Lever, or Ashby board link>", "name"?: "Acme"}`. Checks the board exists, then adds it → `{"ok": true, "company": {...}, "postings": 42}`; `400` for other links, `404` when there's no such board |

## Resume endpoints (not in v1)

The dock also calls these. Until resume building exists locally, answer so the
dock degrades quietly:

| Endpoint | v1 response |
|---|---|
| `GET /compile-queue?limit=N` | `{"ok": true, "jobs": []}` |
| `GET /compile-queue/stats` | `{"ok": true, "queued": 0, "running": 0, "active": 0}` |
| `POST /compile-queue/lookup` | `{"ok": true, "jobs": []}` |
| `POST /compile-enqueue`, `/compile-enqueue-batch`, `/cover-enqueue`, `/manual-jd` | `501 {"ok": false, "error": "Resume building isn't available in local mode yet"}` |
| `GET` / `PUT /resume-profile` | `{"ok": true, "profile": {name, title, email, phone, location, linkedin, github, portfolio}}`, stored locally |
