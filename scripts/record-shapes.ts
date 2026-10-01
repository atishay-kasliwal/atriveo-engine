// Records the structure (field names and types, no values) of each source's live
// response into test/fixtures/shapes. Run by a maintainer when a source changes:
//
//   bun scripts/record-shapes.ts
//
// CI never runs this; it only checks the committed fixtures against these shapes.
// Values are not saved so no company's postings end up in the repo.

import { mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { USER_AGENT } from "../src/version.ts";
import { shapeOf } from "./shape.ts";

const OUT = join(import.meta.dir, "..", "test", "fixtures", "shapes");

async function get(url: string): Promise<unknown> {
  const res = await fetch(url, { headers: { "User-Agent": USER_AGENT, Accept: "application/json" } });
  if (!res.ok) throw new Error(`HTTP ${res.status} from ${url}`);
  return res.json();
}

// Public boards with many postings, so optional fields show up.
const GREENHOUSE = ["stripe", "airbnb", "databricks"];
const LEVER = ["palantir", "spotify", "zoox"];
const ASHBY = ["openai", "ramp", "notion"];

async function main() {
  mkdirSync(OUT, { recursive: true });
  const save = (name: string, ...samples: unknown[]) => {
    writeFileSync(join(OUT, `${name}.json`), `${JSON.stringify(shapeOf(...samples), null, 2)}\n`);
    console.log(`recorded ${name}`);
  };

  const ghLists = await Promise.all(
    GREENHOUSE.map((t) => get(`https://boards-api.greenhouse.io/v1/boards/${t}/jobs`)),
  );
  save("greenhouse-list", ...ghLists);
  const ghDetails = await Promise.all(
    ghLists.map((list, i) => {
      const id = (list as { jobs: { id: number }[] }).jobs[0]?.id;
      return get(`https://boards-api.greenhouse.io/v1/boards/${GREENHOUSE[i]}/jobs/${id}`);
    }),
  );
  save("greenhouse-job", ...ghDetails);
  save(
    "lever",
    ...(await Promise.all(LEVER.map((t) => get(`https://api.lever.co/v0/postings/${t}?mode=json`)))),
  );
  save(
    "ashby",
    ...(await Promise.all(ASHBY.map((t) => get(`https://api.ashbyhq.com/posting-api/job-board/${t}`)))),
  );
  // One request each: Remotive asks for at most four a day.
  save("remotive", await get("https://remotive.com/api/remote-jobs?category=software-dev"));
  save("arbeitnow", await get("https://www.arbeitnow.com/api/job-board-api?page=1"));
}

await main();
