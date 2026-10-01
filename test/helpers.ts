import { readFileSync } from "node:fs";
import { join } from "node:path";

export function fixture<T = unknown>(name: string): T {
  return JSON.parse(readFileSync(join(import.meta.dir, "fixtures", `${name}.json`), "utf8")) as T;
}

type Route = unknown | ((attempt: number) => Response | Promise<Response>);

/** A fetch that answers from a URL → body table and records what was asked. Unknown URLs get 404. */
export function mockFetch(routes: Record<string, Route>) {
  const calls: string[] = [];
  const impl = async (input: string | URL | Request, init?: RequestInit) => {
    init?.signal?.throwIfAborted();
    const url = String(input);
    calls.push(url);
    const route = routes[url];
    if (route === undefined) return new Response('{"error":"not found"}', { status: 404 });
    if (typeof route === "function") return route(calls.filter((c) => c === url).length);
    return Response.json(route);
  };
  return { fetch: impl as unknown as typeof fetch, calls };
}

export const noSleep = async () => {};
