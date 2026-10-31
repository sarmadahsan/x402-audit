import type { Db } from "../db/index.js";
import { loadFileConfigs } from "../config/index.js";
import { safeJson } from "../log.js";

/** Every subcommand records a runs row so the report can list what ran with which config hash. */
export function startRun(db: Db, subcommand: string, args: unknown, network: string, dryRun: boolean): number {
  const { configHash } = loadFileConfigs();
  const r = db
    .prepare("INSERT INTO runs (subcommand, args_json, config_hash, network, dry_run, started_at, status) VALUES (?,?,?,?,?,?, 'running')")
    .run(subcommand, JSON.stringify(args ?? {}), configHash, network, dryRun ? 1 : 0, Date.now());
  return Number(r.lastInsertRowid);
}

export function finishRun(db: Db, runId: number, status: "ok" | "halted" | "cap_reached" | "error" | "skipped", notes?: unknown): void {
  db.prepare("UPDATE runs SET finished_at = ?, status = ?, notes = ? WHERE id = ?").run(Date.now(), status, notes === undefined ? null : safeJson(notes), runId);
}

/** A run that did not go ahead (the loop's gates before a scheduled buy: halt file, X402_AUDIT_LIVE, dirty tree,
 * `pnpm gate`, wallet pool): one row, started and finished at the same instant, status `skipped`, the reason in notes.
 * The export's `last_buy_run` (with `reason`) and the health post then date the skip instead of showing the previous
 * run as the latest one. One `Date.now()` for both columns: a skip has no duration, and two reads straddled a
 * millisecond often enough (2 of 7 gate runs on the server) to fail the test that asserts they are equal and so skip
 * the 06:00 runs of 2026-10-30 and 2026-10-31 themselves. */
export function recordSkippedRun(db: Db, subcommand: string, args: unknown, network: string, reason: string): number {
  const { configHash } = loadFileConfigs();
  const at = Date.now();
  const r = db
    .prepare("INSERT INTO runs (subcommand, args_json, config_hash, network, dry_run, started_at, finished_at, status, notes) VALUES (?,?,?,?,0,?,?,'skipped',?)")
    .run(subcommand, JSON.stringify(args ?? {}), configHash, network, at, at, safeJson({ reason }));
  return Number(r.lastInsertRowid);
}
