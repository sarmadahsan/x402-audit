/**
 * A scheduled run the loop did not start leaves a `buy run` row with status skipped (src/cli/runs.ts recordSkippedRun,
 * reached through `buy skipped`), and both consumers show it as the latest buy run: the export's `last_buy_run` and the
 * health post's runs.buy. Before 2026-10-30 a skip left only a line in data/loop.log and both kept showing the previous run.
 */
import { mkdtempSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { MAINNET } from "../config/index.js";
import { runExport } from "../export/index.js";
import { healthRuns } from "../health/body.js";
import { NOW, seedDb } from "../report/test-helpers.js";
import { recordSkippedRun } from "./runs.js";

describe("skipped scheduled run", () => {
  it("is one finished row with the reason, and the export's last_buy_run and the health post's runs.buy", () => {
    const db = seedDb();
    const before = db.prepare("SELECT COUNT(*) n FROM runs").get() as { n: number };
    const id = recordSkippedRun(db, "buy run", { allocation: "coverage", live: true, skipped: true, slot: "2026-10-30T00" }, MAINNET, "pnpm gate failed");
    const row = db.prepare("SELECT subcommand, dry_run, status, notes, started_at, finished_at, args_json FROM runs WHERE id = ?").get(id) as Record<string, unknown>;
    expect((db.prepare("SELECT COUNT(*) n FROM runs").get() as { n: number }).n).toBe(before.n + 1);
    expect(row).toMatchObject({ subcommand: "buy run", dry_run: 0, status: "skipped" });
    expect(JSON.parse(row.notes as string)).toEqual({ reason: "pnpm gate failed" });
    expect(JSON.parse(row.args_json as string)).toMatchObject({ allocation: "coverage", live: true, skipped: true, slot: "2026-10-30T00" });
    expect(row.finished_at).toBe(row.started_at);

    const out = mkdtempSync(join(tmpdir(), "export-skipped-"));
    runExport(db, { network: MAINNET, now: Date.now(), outDir: out, gitCommit: "test" });
    const summary = JSON.parse(readFileSync(join(out, "summary.json"), "utf8"));
    expect(summary.last_buy_run.status).toBe("skipped");
    expect(summary.last_buy_run.started_at).toBe(new Date(row.started_at as number).toISOString());
    expect(summary.last_buy_run.finished_at).toBe(summary.last_buy_run.started_at);
    expect(summary.last_buy_run.reason).toBe("pnpm gate failed");
    expect(summary.last_probe_run?.reason ?? null).toBeNull();

    const runs = healthRuns(db, MAINNET, [], NOW);
    expect(runs.buy).toMatchObject({ status: "skipped", planned_calls: null, spent_usdc: "0.000000", failures: 0, errors: 0 });
  });
});
