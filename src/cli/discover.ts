import type { Command } from "commander";
import { discoverReport, runDiscover } from "../discover/index.js";
import { loadEnv, loadFileConfigs, usdToAtomic, type Network } from "../config/index.js";
import { fetchCandidates, importCandidates, probeCandidates } from "../discover/candidates.js";
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
  d.command("import-candidates")
    .description("import resources users checked or paid that we never measured (GET {index}/v1/candidates), probe each once (free), classify queued / too_expensive / not_x402")
    .option("--index <url>", "index origin (default PAIDFOR_INDEX_URL)")
    .option("--per-call-usd <usd>", "per-call cap a quote is judged against (default LOOP_PER_CALL_USD, else 0.10)", parseFloat)
    .option("--no-probe", "import only")
    .action(async function (this: Command, o: { index?: string; perCallUsd?: number; probe: boolean }) {
      const g = globals(this);
      const env = loadEnv();
      const db = openDb(g.db);
      const index = o.index ?? env.PAIDFOR_INDEX_URL;
      const capUsd = o.perCallUsd ?? Number(process.env.LOOP_PER_CALL_USD ?? "0.10");
      const runId = startRun(db, "discover import-candidates", { index, capUsd }, g.network, false);
      const got = await fetchCandidates(index);
      if (got.status === "not_live") {
        log.info(`import-candidates: ${index}/v1/candidates answered 404 (index Prompt 10 not live yet); nothing imported`);
        finishRun(db, runId, "ok", { status: "not_live" });
        console.log(JSON.stringify({ status: "not_live", imported: 0 }));
        return;
      }
      if (got.status === "error") {
        finishRun(db, runId, "error", { error: got.message });
        throw new Error(`import-candidates: ${got.message}`);
      }
      const imported = importCandidates(db, got.items, Date.now());
      const probed = o.probe ? await probeCandidates(db, { perCallCapAtomic: usdToAtomic(capUsd), network: g.network }) : [];
      finishRun(db, runId, "ok", { imported, probed: probed.length });
      for (const p of probed) console.log(`${p.state}\t${p.quoted_usdc ?? "-"}\t${p.url}\t${p.note}`);
      console.log(JSON.stringify({ status: "ok", ...imported, probed: probed.length, byState: probed.reduce<Record<string, number>>((a, p) => ((a[p.state] = (a[p.state] ?? 0) + 1), a), {}) }));
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
