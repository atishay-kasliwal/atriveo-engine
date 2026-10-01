import type { EngineConfig } from "../config.ts";
import type { Store } from "../store/db.ts";
import type { Runner } from "./runner.ts";

/** Below this, boards would be asked for the same data over and over. */
export const MIN_INTERVAL_MINUTES = 15;

/**
 * While `serve` runs with `schedule.enabled`, starts a scrape whenever the last
 * one started more than `intervalMinutes` ago. Checks once a minute, so a
 * laptop waking from sleep catches up instead of waiting a full interval.
 * Returns a function that stops it.
 */
export function startSchedule(options: {
  runner: Runner;
  store: Store;
  config: () => EngineConfig;
  now?: () => number;
  checkEveryMs?: number;
}): () => void {
  const now = options.now ?? Date.now;
  const tick = () => {
    const { enabled, intervalMinutes } = options.config().schedule;
    if (!enabled) return;
    const last = options.store.latestRunState().startedAt;
    const minutes = Math.max(intervalMinutes, MIN_INTERVAL_MINUTES);
    if (last && now() - Date.parse(last) < minutes * 60_000) return;
    options.runner.start();
  };
  const timer = setInterval(tick, options.checkEveryMs ?? 60_000);
  tick();
  return () => clearInterval(timer);
}
