import type { Command } from "commander";
import { discoverReport, runDiscover } from "../discover/index.js";
import { loadFileConfigs, type Network } from "../config/index.js";
import { openDb } from "../db/index.js";
import { log } from "../log.js";
import { finishRun, startRun } from "./runs.js";

export function registerDiscover(program: Command, globals: (cmd: Command) => { network: Network; db: string }) {
  const d = program.command("discover").description("build the universe of sellers and resources (free; never moves money)");
  d.command("run")
    .description("pull every resource from the CDP Bazaar index and config/manual-sellers.yaml")
    .option("--throttle-ms <n>", "delay between index pages", (v) => parseInt(v, 10), 1000)
    .action(async function (this: Command, o: { throttleMs: number }) {
      const g = globals(this);
      const db = openDb(g.db);
      const files = loadFileConfigs();
      const runId = startRun(db, "discover run", o, g.network, false);
      try {
        const stats = await runDiscover(db, { manual: files.manual.resources, exclude: files.exclude, log, throttleMs: o.throttleMs });
        finishRun(db, runId, "ok", stats);
        console.log(JSON.stringify(stats, null, 2));
      } catch (e) {
        finishRun(db, runId, "error", { error: (e as Error).message });
        throw e;
      }
    });
  d.command("report")
    .description("top sellers by 30-day volume with resource counts")
    .option("--top <n>", "how many sellers", (v) => parseInt(v, 10), 100)
    .action(function (this: Command, o: { top: number }) {
      const g = globals(this);
      console.log(discoverReport(openDb(g.db), { top: o.top }));
    });
  return d;
}
