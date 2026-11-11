import type { Command } from "commander";
import { loadFileConfigs, type Network } from "../config/index.js";
import { openDb } from "../db/index.js";
import { log } from "../log.js";
import { archiveRawProbes, awsUploader, planArchive, vacuumIfRoom } from "../probe/archive.js";
import { probeReport } from "../probe/report.js";
import { runProbeRound } from "../probe/run.js";
import { probeLoop } from "../probe/schedule.js";
import { buildProbeSet, listProbeSet } from "../probe/set.js";
import { finishRun, startRun } from "./runs.js";

export function registerProbe(program: Command, globals: (cmd: Command) => { network: Network; db: string }) {
  const p = program.command("probe").description("capture 402 quotes without paying (free; never moves money)");
  p.command("plan")
    .description("select the probe set: one resource for each of the top N sellers by volume, plus M random tail resources")
    .option("--top <n>", "top sellers", (v) => parseInt(v, 10), 60)
    .option("--tail <n>", "random tail resources", (v) => parseInt(v, 10), 40)
    .option("--seed <n>", "PRNG seed (default: config/sample.yaml seed)", (v) => parseInt(v, 10))
    .action(function (this: Command, o: { top: number; tail: number; seed?: number }) {
      const g = globals(this);
      const db = openDb(g.db);
      const files = loadFileConfigs();
      const seed = o.seed ?? files.sample.seed;
      const r = buildProbeSet(db, { topSellers: o.top, tailResources: o.tail, seed, network: g.network, exclude: files.exclude });
      console.log(JSON.stringify({ ...r, seed }));
      for (const row of listProbeSet(db)) console.log(`${row.stratum}\t${row.sellerDomain}\t${row.method} ${row.url}`);
    });
  p.command("run")
    .description("probe every resource in the set from two client identities; --once for one round, default hourly loop")
    .option("--once", "run one round and exit", false)
    .option("--every-minutes <n>", "loop period", (v) => parseInt(v, 10), 60)
    .option("--max-rounds <n>", "stop after N rounds", (v) => parseInt(v, 10))
    .action(async function (this: Command, o: { once: boolean; everyMinutes: number; maxRounds?: number }) {
      const g = globals(this);
      const db = openDb(g.db);
      const runId = startRun(db, "probe run", o, g.network, false);
      const ac = new AbortController();
      process.on("SIGINT", () => ac.abort());
      process.on("SIGTERM", () => ac.abort());
      try {
        if (o.once) {
          const stats = await runProbeRound(db, { runId, network: g.network, log, signal: ac.signal });
          finishRun(db, runId, stats.halted ? "halted" : "ok", stats);
          console.log(JSON.stringify(stats));
        } else {
          const rounds = await probeLoop(db, {
            runId,
            network: g.network,
            log,
            signal: ac.signal,
            everyMs: o.everyMinutes * 60_000,
            ...(o.maxRounds ? { maxRounds: o.maxRounds } : {}),
            onRound: (s) => log.info("probe round done", s),
          });
          finishRun(db, runId, "ok", { rounds });
          console.log(JSON.stringify({ rounds }));
        }
      } catch (e) {
        finishRun(db, runId, "error", { error: (e as Error).message });
        throw e;
      }
    });
  p.command("report")
    .description("quote drift and pay-to changes per seller")
    .option("--since-hours <n>", "only probes newer than N hours", (v) => parseInt(v, 10))
    .action(function (this: Command, o: { sinceHours?: number }) {
      const g = globals(this);
      console.log(probeReport(openDb(g.db), o.sinceHours ? { sinceMs: Date.now() - o.sinceHours * 3_600_000 } : {}));
    });
  p.command("archive-raw")
    .description("move old raw probe headers and bodies to S3, then clear them locally; a dry run without --apply")
    .option("--apply", "upload and clear; without it only the plan is printed", false)
    .option("--upload-only", "upload and record but leave the rows; a later run without this clears them", false)
    .option("--bucket <name>", "S3 bucket (default BACKUP_BUCKET)", process.env.BACKUP_BUCKET)
    .option("--keep-days <n>", "whole UTC days of raw data to keep locally", (v) => parseInt(v, 10), 7)
    .option("--max-days <n>", "days to archive in this run", (v) => parseInt(v, 10), 3)
    .option("--work-dir <dir>", "where the temporary files go", "data/loop-state/probe-archive")
    .option("--vacuum", "with --apply: compact the database afterwards (blocks writers; run between loop cycles)", false)
    .action(async function (this: Command, o: { apply: boolean; uploadOnly: boolean; bucket?: string; keepDays: number; maxDays: number; workDir: string; vacuum: boolean }) {
      const g = globals(this);
      if (!Number.isInteger(o.keepDays) || o.keepDays < 1) throw new Error("--keep-days must be a whole number of at least 1");
      if (!Number.isInteger(o.maxDays) || o.maxDays < 1) throw new Error("--max-days must be a whole number of at least 1");
      const db = openDb(g.db);
      const now = Date.now();
      if (!o.apply) {
        const chunks = planArchive(db, { now, keepDays: o.keepDays, maxDays: o.maxDays });
        for (const c of chunks) console.log(`${c.day}: probes ${c.minId}..${c.maxId}`);
        console.log(`${chunks.length} day(s) would be archived; pass --apply to do it`);
        return;
      }
      if (!o.bucket) throw new Error("--bucket or BACKUP_BUCKET is required with --apply");
      const runId = startRun(db, "probe archive-raw", o, g.network, false);
      try {
        const summary = await archiveRawProbes(db, { now, keepDays: o.keepDays, maxDays: o.maxDays, workDir: o.workDir, upload: awsUploader(o.bucket), trim: !o.uploadOnly, log: (m) => log.info(m) });
        const vacuum = o.vacuum ? vacuumIfRoom(db, o.workDir) : undefined;
        finishRun(db, runId, "ok", { ...summary, ...(vacuum ? { vacuum } : {}) });
        console.log(`${summary.uploaded.length} day(s) archived, ${summary.trimmedRanges} range(s) cleared${vacuum ? `, database ${vacuum.beforeBytes} -> ${vacuum.afterBytes} bytes` : ""}`);
      } catch (e) {
        finishRun(db, runId, "error", { error: (e as Error).message });
        throw e;
      }
    });
  return p;
}
