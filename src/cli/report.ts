import type { Command } from "commander";
import { resolve } from "node:path";
import type { Network } from "../config/index.js";
import { openDb } from "../db/index.js";
import { log } from "../log.js";
import { computeReport } from "../report/compute.js";
import { renderMarkdown, writeReport } from "../report/render.js";

export function registerReport(program: Command, globals: (cmd: Command) => { network: Network; db: string }) {
  program
    .command("report")
    .description("write reports/YYYY-MM-DD.md and its JSON twin; every number comes from a named query in src/report/queries.ts")
    .option("--since <iso>", "only rows at or after this time")
    .option("--until <iso>", "only rows at or before this time")
    .option("--out <dir>", "output directory", "reports")
    .option("--stdout", "print the markdown instead of writing files", false)
    .action(function (this: Command, o: { since?: string; until?: string; out: string; stdout: boolean }) {
      const g = globals(this);
      const db = openDb(g.db);
      const data = computeReport(db, {
        network: g.network,
        now: Date.now(),
        ...(o.since ? { sinceMs: Date.parse(o.since) } : {}),
        ...(o.until ? { untilMs: Date.parse(o.until) } : {}),
      });
      if (o.stdout) {
        console.log(renderMarkdown(data));
        return;
      }
      const { mdPath, jsonPath } = writeReport(data, resolve(o.out));
      log.info(`report written`, { mdPath, jsonPath });
      console.log(JSON.stringify({ mdPath, jsonPath }));
    });
}
