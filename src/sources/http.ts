import type { Store } from "../store/db.ts";
import { USER_AGENT } from "../version.ts";

export class HttpError extends Error {
  constructor(
    readonly status: number,
    readonly url: string,
  ) {
    super(`HTTP ${status} from ${url}`);
    this.name = "HttpError";
  }
}

export interface HttpOptions {
  fetch?: typeof fetch;
  /** Where `cacheMs` responses are kept. Without it nothing is cached. */
  store?: Store;
  retries?: number;
  /** Delay before the first retry; it doubles each time. */
  backoffMs?: number;
  timeoutMs?: number;
  sleep?: (ms: number, signal: AbortSignal) => Promise<void>;
}

export interface GetOptions {
  signal: AbortSignal;
  /** Serve a stored copy younger than this instead of asking again. */
  cacheMs?: number;
}

const RETRYABLE = new Set([408, 425, 429, 500, 502, 503, 504]);
const MAX_RETRY_AFTER_MS = 60_000;

export function abortableSleep(ms: number, signal: AbortSignal): Promise<void> {
  return new Promise((resolve, reject) => {
    if (signal.aborted) return reject(signal.reason);
    const timer = setTimeout(() => {
      signal.removeEventListener("abort", onAbort);
      resolve();
    }, ms);
    const onAbort = () => {
      clearTimeout(timer);
      reject(signal.reason);
    };
    signal.addEventListener("abort", onAbort, { once: true });
  });
}

/** Retry-After as milliseconds: either delta-seconds or an HTTP date. */
function retryAfterMs(res: Response, now = Date.now()): number | null {
  const header = res.headers.get("retry-after");
  if (!header) return null;
  const seconds = Number(header);
  const ms = Number.isFinite(seconds) ? seconds * 1000 : Date.parse(header) - now;
  return Number.isFinite(ms) ? Math.min(Math.max(ms, 0), MAX_RETRY_AFTER_MS) : null;
}

/** GETs with a descriptive User-Agent, a timeout, backoff on 429/5xx, and an optional SQLite cache. */
export class Http {
  private readonly fetchImpl: typeof fetch;
  private readonly store: Store | undefined;
  private readonly retries: number;
  private readonly backoffMs: number;
  private readonly timeoutMs: number;
  private readonly sleep: (ms: number, signal: AbortSignal) => Promise<void>;

  constructor(options: HttpOptions = {}) {
    this.fetchImpl = options.fetch ?? fetch;
    this.store = options.store;
    this.retries = options.retries ?? 3;
    this.backoffMs = options.backoffMs ?? 1000;
    this.timeoutMs = options.timeoutMs ?? 30_000;
    this.sleep = options.sleep ?? abortableSleep;
  }

  async text(url: string, options: GetOptions): Promise<string> {
    const { signal, cacheMs } = options;
    if (cacheMs && this.store) {
      const hit = this.store.getCached(url, cacheMs);
      if (hit !== null) return hit;
    }
    for (let attempt = 0; ; attempt += 1) {
      signal.throwIfAborted();
      let delay = this.backoffMs * 2 ** attempt;
      try {
        const res = await this.fetchImpl(url, {
          headers: { "User-Agent": USER_AGENT, Accept: "application/json" },
          signal: AbortSignal.any([signal, AbortSignal.timeout(this.timeoutMs)]),
        });
        if (res.ok) {
          const body = await res.text();
          if (cacheMs && this.store) this.store.putCached(url, body);
          return body;
        }
        await res.body?.cancel();
        if (!RETRYABLE.has(res.status) || attempt >= this.retries) throw new HttpError(res.status, url);
        delay = retryAfterMs(res) ?? delay;
      } catch (e) {
        if (e instanceof HttpError) throw e;
        if (signal.aborted) throw signal.reason;
        // Network errors and timeouts are worth another try.
        if (attempt >= this.retries) throw e;
      }
      await this.sleep(delay, signal);
    }
  }

  async json<T>(url: string, options: GetOptions): Promise<T> {
    return JSON.parse(await this.text(url, options)) as T;
  }
}

/** Runs `fn` over `items` with at most `limit` in flight, keeping input order in the result. */
export async function mapPool<T, R>(
  items: readonly T[],
  limit: number,
  fn: (item: T, index: number) => Promise<R>,
  signal?: AbortSignal,
): Promise<R[]> {
  const results = new Array<R>(items.length);
  let next = 0;
  const worker = async () => {
    while (next < items.length) {
      signal?.throwIfAborted();
      const index = next;
      next += 1;
      results[index] = await fn(items[index] as T, index);
    }
  };
  await Promise.all(Array.from({ length: Math.min(Math.max(limit, 1), items.length) }, worker));
  return results;
}
