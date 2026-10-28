import type { Command } from "commander";
import type { Network } from "../config/index.js";
import { openDb } from "../db/index.js";
import { log } from "../log.js";
import { runExport } from "../export/index.js";

export function registerExport(program: Command, globals: (cmd: Command) => { network: Network; db: string }) {
  program
    .command("export")
    .description("write public-data/ (summary, sellers, resources, evidence, stress, probe JSON) from the same queries as the report; reads only")
    .option("--out <dir>", "output directory", "public-data")
    .action(function (this: Command, o: { out: string }) {
      const g = globals(this);
      const db = openDb(g.db);
      const r = runExport(db, { network: g.network, now: Date.now(), outDir: o.out });
      log.info("export written", { out: o.out, sellers: r.sellers, lowSample: r.lowSample, resources: r.resources });
      console.log(JSON.stringify({ out: o.out, ...r, files: r.files.length }));
    });
}
