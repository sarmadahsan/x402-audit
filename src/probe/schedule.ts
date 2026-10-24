/**
 * Hourly probe loop: run a round, sleep until the next `everyMs` boundary
 * (the next hour boundary by default), repeat. Stops on the halt file, on
 * `signal` abort, or after `maxRounds`.
 */
import type { Db } from "../db/index.js";
import { haltRequested } from "../safety.js";
import { runProbeRound, type ProbeRoundOptions, type RoundStats } from "./run.js";

export interface ProbeLoopOptions extends ProbeRoundOptions {
  /** Period between round starts; rounds are aligned to multiples of this (hour boundaries by default). */
  everyMs?: number;
  maxRounds?: number;
  /** How often the halt file is checked while sleeping. Default 10 s. */
  haltCheckMs?: number;
  /** Called after each round. */
  onRound?: (stats: RoundStats) => void;
}

/** Next multiple of `everyMs` strictly after `t`. */
export function nextBoundary(t: number, everyMs: number): number {
  return (Math.floor(t / everyMs) + 1) * everyMs;
}

function wait(ms: number, signal?: AbortSignal): Promise<void> {
  return new Promise((resolve) => {
    if (ms <= 0 || signal?.aborted) return resolve();
    const t = setTimeout(done, ms);
    function done() {
      clearTimeout(t);
      signal?.removeEventListener("abort", done);
      resolve();
    }
    signal?.addEventListener("abort", done, { once: true });
  });
}

/** Returns the number of rounds run. */
export async function probeLoop(db: Db, opts: ProbeLoopOptions): Promise<number> {
  const everyMs = opts.everyMs ?? 3_600_000;
  const haltCheckMs = opts.haltCheckMs ?? 10_000;
  const clock = opts.now ?? Date.now;
  const { signal, log } = opts;
  let rounds = 0;

  for (;;) {
    if (signal?.aborted) break;
    if (haltRequested(opts.haltRoot)) {
      log.warn("probe loop: halt file present, stopping");
      break;
    }
    const stats = await runProbeRound(db, opts);
    rounds++;
    opts.onRound?.(stats);
    if (stats.halted) break;
    if (opts.maxRounds !== undefined && rounds >= opts.maxRounds) break;

    const until = nextBoundary(clock(), everyMs);
    log.info(`probe loop: round ${rounds} done, next round at ${new Date(until).toISOString()}`);
    let halted = false;
    while (!signal?.aborted) {
      const remaining = until - clock();
      if (remaining <= 0) break;
      await wait(Math.min(remaining, haltCheckMs), signal);
      if (haltRequested(opts.haltRoot)) {
        halted = true;
        break;
      }
    }
    if (halted) {
      log.warn("probe loop: halt file present, stopping");
      break;
    }
  }
  return rounds;
}
