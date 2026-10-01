import type { SourceId } from "../types.ts";
import { arbeitnow } from "./arbeitnow.ts";
import { ashby } from "./ashby.ts";
import { greenhouse } from "./greenhouse.ts";
import { lever } from "./lever.ts";
import { remotive } from "./remotive.ts";
import type { Source } from "./types.ts";

export const SOURCES: Record<SourceId, Source> = { greenhouse, lever, ashby, remotive, arbeitnow };

export { BUNDLED_BOARDS, boardsFor, parseBoardUrl } from "./boards.ts";
export { Http, HttpError, mapPool } from "./http.ts";
export type { Source, SourceContext, SourceResult } from "./types.ts";
