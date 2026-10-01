import { afterAll, describe, expect, test } from "bun:test";
import { mkdtempSync, readFileSync, rmSync, statSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { DEFAULT_CONFIG } from "../src/config.ts";
import { startSchedule } from "../src/scheduler/schedule.ts";
import { Store } from "../src/store/db.ts";

const home = mkdtempSync(join(tmpdir(), "atriveo-cli-"));
afterAll(() => rmSync(home, { recursive: true, force: true }));

function atriveo(...args: string[]) {
  const env: Record<string, string> = { ...process.env, ATRIVEO_HOME: home } as Record<string, string>;
  delete env.ATRIVEO_TOKEN;
  const proc = Bun.spawnSync(["bun", join(import.meta.dir, "..", "src", "cli", "index.ts"), ...args], {
    env,
  });
  return { code: proc.exitCode, out: proc.stdout.toString().trim(), err: proc.stderr.toString().trim() };
}

describe("cli", () => {
  test("version and help", () => {
    expect(atriveo("--version").out).toBe("0.1.0");
    expect(atriveo("help").out).toContain("atriveo serve");
  });

  test("first use creates a private config with a token", () => {
    const token = atriveo("token").out;
    expect(token).toMatch(/^[0-9a-f]{64}$/);
    expect(atriveo("token").out).toBe(token);
    const path = atriveo("config", "path").out;
    expect(path).toBe(join(home, "config.json"));
    expect(statSync(path).mode & 0o777).toBe(0o600);
    expect(atriveo("config", "get").out).not.toContain(token);
  });

  test("config set parses JSON values and dotted keys", () => {
    expect(atriveo("config", "set", "remote", "remote-only").code).toBe(0);
    expect(atriveo("config", "set", "schedule.intervalMinutes", "30").code).toBe(0);
    expect(atriveo("config", "set", "locations", '["New York", "Remote"]').code).toBe(0);
    const saved = JSON.parse(readFileSync(join(home, "config.json"), "utf8"));
    expect(saved.remote).toBe("remote-only");
    expect(saved.schedule).toEqual({ enabled: false, intervalMinutes: 30 });
    expect(saved.locations).toEqual(["New York", "Remote"]);
    expect(atriveo("config", "get", "schedule.intervalMinutes").out).toBe("30");
  });

  test("bad settings are refused", () => {
    const res = atriveo("config", "set", "schedule.intervalMinutes", "1");
    expect(res.code).toBe(1);
    expect(res.err).toContain("at least 15");
    expect(atriveo("config", "set", "levels", '["Wizard"]').code).toBe(1);
  });

  test("token --rotate replaces the token", () => {
    const before = atriveo("token").out;
    const after = atriveo("token", "--rotate").out;
    expect(after).not.toBe(before);
    expect(atriveo("token").out).toBe(after);
  });

  test("serve refuses a non-loopback host without --allow-remote", () => {
    const res = atriveo("serve", "--host", "0.0.0.0");
    expect(res.code).toBe(2);
    expect(res.err).toContain("--allow-remote");
  });

  test("companies add rejects non-board links without touching the network", () => {
    const res = atriveo("companies", "add", "https://careers.example.com/jobs");
    expect(res.code).toBe(1);
    expect(res.err).toContain("Greenhouse, Lever, or Ashby");
  });

  test("unknown commands exit 2", () => {
    expect(atriveo("frobnicate").code).toBe(2);
  });
});

describe("schedule", () => {
  test("starts a run when the last one is older than the interval", () => {
    const store = new Store(":memory:");
    let starts = 0;
    const runner = {
      start: () => {
        starts += 1;
      },
    } as never;
    let schedule = { enabled: true, intervalMinutes: 60 };
    const config = () => ({ ...DEFAULT_CONFIG, token: "t", schedule });
    const now = Date.parse("2026-10-01T15:00:00Z");

    store.createRun("2026-10-01T14:30:00Z", 0);
    store.finishRun("2026-10-01T14:30:00Z", "done", { phases: [] });
    let stop = startSchedule({ runner, store, config, now: () => now, checkEveryMs: 1e9 });
    stop();
    expect(starts).toBe(0);

    stop = startSchedule({ runner, store, config, now: () => now + 31 * 60_000, checkEveryMs: 1e9 });
    stop();
    expect(starts).toBe(1);

    schedule = { enabled: false, intervalMinutes: 60 };
    stop = startSchedule({ runner, store, config, now: () => now + 600 * 60_000, checkEveryMs: 1e9 });
    stop();
    expect(starts).toBe(1);
  });
});
