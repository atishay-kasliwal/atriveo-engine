import type { EngineConfig } from "../config.ts";
import { isoSeconds } from "../core/days.ts";
import { type PipelineOptions, runPipeline } from "../core/pipeline.ts";
import type { Http } from "../sources/http.ts";
import type { Store } from "../store/db.ts";
import { PHASES, type PhaseName, type PhaseState, type RunState } from "../types.ts";

export interface ScrapeStatus {
  ok: true;
  running: boolean;
  knownPhases: readonly PhaseName[];
  state: RunState;
  estimate: ReturnType<Store["estimate"]>;
}

export type StartResult = { ok: true; runId: string } | { ok: false; error: string; runId?: string };

export interface RunnerOptions {
  store: Store;
  http: Http;
  config: () => EngineConfig;
  /** Overrides for tests: sources, boards, lists, concurrency. */
  pipeline?: Partial<Pick<PipelineOptions, "sources" | "boards" | "lists" | "concurrency" | "now">>;
  /** Called with each progress line. */
  onLog?: (line: string) => void;
}

const MAX_LOG_LINES = 200;
const CANCEL_KEY = (runId: string) => `cancel:${runId}`;

export function pidAlive(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch (e) {
    // EPERM: it exists but belongs to someone else.
    return (e as NodeJS.ErrnoException).code === "EPERM";
  }
}

/**
 * Runs scrapes one at a time. State lives in SQLite, so `atriveo scrape` and
 * `atriveo serve` see each other's runs, and a run whose process died is
 * reported as interrupted.
 */
export class Runner {
  private current: { id: string; controller: AbortController; done: Promise<void> } | null = null;
  private lines: string[] = [];

  constructor(private readonly options: RunnerOptions) {}

  start(): StartResult {
    const { store } = this.options;
    store.reapStaleRuns(pidAlive);
    const running = this.current?.id ?? store.runningRun()?.id;
    if (running) return { ok: false, error: "already running", runId: running };

    let start = new Date();
    while (store.runExists(isoSeconds(start))) start = new Date(start.getTime() + 1000);
    const id = isoSeconds(start);
    store.createRun(id, store.jobCount());
    this.lines = [];
    const controller = new AbortController();
    this.current = { id, controller, done: this.execute(id, controller) };
    return { ok: true, runId: id };
  }

  /** Cancels the running scrape, here or in another engine process. */
  cancel(): boolean {
    if (this.current) {
      this.current.controller.abort(new Error("Cancelled"));
      return true;
    }
    const other = this.options.store.runningRun();
    if (!other) return false;
    this.options.store.setKv(CANCEL_KEY(other.id), "1");
    return true;
  }

  /** Resolves once no run started by this process is in flight. */
  async idle(): Promise<void> {
    await this.current?.done;
  }

  status(): ScrapeStatus {
    const { store } = this.options;
    store.reapStaleRuns(pidAlive);
    const state = store.latestRunState();
    return {
      ok: true,
      running: state.status === "running",
      knownPhases: PHASES,
      state,
      estimate: store.estimate(),
    };
  }

  log(): string[] {
    return [...this.lines];
  }

  private say(line: string): void {
    this.lines.push(line);
    if (this.lines.length > MAX_LOG_LINES) this.lines.shift();
    this.options.onLog?.(line);
  }

  private async execute(id: string, controller: AbortController): Promise<void> {
    const { store } = this.options;
    const phases: PhaseState[] = [];
    const closePhase = (status: PhaseState["status"]) => {
      const last = phases.at(-1);
      if (last?.status !== "running") return;
      last.status = status;
      last.finishedAt = isoSeconds();
      last.exitCode = status === "ok" ? 0 : status === "cancelled" ? 130 : 1;
    };
    // Lets `atriveo scrape --cancel` or another process's server stop this run.
    const watch = setInterval(() => {
      if (store.getKv(CANCEL_KEY(id))) controller.abort(new Error("Cancelled"));
    }, 1000);

    try {
      const result = await runPipeline({
        ...this.options.pipeline,
        runId: id,
        config: this.options.config(),
        store,
        http: this.options.http,
        signal: controller.signal,
        log: (line) => this.say(line),
        onPhase: (name) => {
          closePhase("ok");
          phases.push({ name, status: "running", startedAt: isoSeconds() });
          store.updateRun(id, { phase: name, phases });
        },
      });
      closePhase("ok");
      const jobsAfter = store.jobCount();
      store.finishRun(id, "done", { phases, jobsAfter });
      const before = store.latestRunState().jobsBefore ?? jobsAfter;
      this.say(`done: ${result.stored} matching jobs, ${jobsAfter - before} new`);
    } catch (e) {
      const cancelled = controller.signal.aborted;
      closePhase(cancelled ? "cancelled" : "failed");
      const message = cancelled ? "Cancelled" : (e as Error).message;
      store.finishRun(id, cancelled ? "cancelled" : "failed", {
        phases,
        jobsAfter: store.jobCount(),
        error: message,
      });
      this.say(cancelled ? "cancelled" : `failed: ${message}`);
    } finally {
      clearInterval(watch);
      store.deleteKv(CANCEL_KEY(id));
      this.current = null;
    }
  }
}
