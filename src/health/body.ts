/**
 * The health post (`x402-audit health`, POST {index}/v1/admin/health): machine and loop state in one body whose shape is
 * a strict contract with the index, which refuses unknown keys. Every figure comes from where the harness already keeps
 * it: runs, run_allocations, calls and attempts in the DB, the caps from the env the loop runs under (with the dated
 * override, as `effective_caps` in scripts/loop.sh), and data/loop.log. A figure that does not exist is null.
 *
 * Never read here: the halt files' contents (existence only), any wallet key, data/server-wallets.env, /etc/paidfor/.
 * Wallet addresses are the public ones the attempts ledger already records for every signature.
 */
import { spawnSync } from "node:child_process";
import { closeSync, existsSync, openSync, readFileSync, readSync, statfsSync, statSync } from "node:fs";
import { freemem, hostname, totalmem, uptime } from "node:os";
import { join } from "node:path";
import { atomicToUsd, capsFromEnv, MAINNET, SEPOLIA, usdToAtomic, type Env } from "../config/index.js";
import type { Db } from "../db/index.js";
import { DAY_MS, spentAtomic, utcDayStart } from "../buy/guard.js";
import { AUDIT_SOURCES, CALL_SOURCES, HEADLINE_FAILURE_OUTCOMES, MEASURED_SOURCES, type CallSource } from "../taxonomy.js";
import { redactLine, redactLines } from "./redact.js";

export const HEALTH_TRIGGERS = ["timer", "probe", "buy", "export", "manual"] as const;
export type HealthTrigger = (typeof HEALTH_TRIGGERS)[number];
export const LOOP_UNIT = "paidfor-audit";
export const LOG_TAIL_LINES = 40;
/** How much of the end of data/loop.log is read; a run's lines are well inside it. */
export const LOG_READ_BYTES = 1024 * 1024;
const WEEK_MS = 7 * DAY_MS;

export interface HealthRun {
  status: string;
  started_at: string | null;
  finished_at: string | null;
  planned_calls: number | null;
  spent_usdc: string | null;
  failures: number | null;
  errors: number | null;
}

export interface HealthMachine {
  unit_active: boolean | null;
  uptime_s: number | null;
  disk_free_pct: number | null;
  mem_used_pct: number | null;
  halt_file: boolean;
  halt_buy_file: boolean;
  halt_probe_file: boolean;
  harness_commit: string | null;
}

export interface HealthBody {
  v: 1;
  posted_at: string;
  trigger: HealthTrigger;
  host: string;
  machine: HealthMachine;
  flags: { AUDIT_TRIGGERS_ENABLED: string; CANDIDATE_BUYS_ENABLED: string; BREADTH_RUN_ENABLED: string };
  runs: { probe: HealthRun | null; buy: HealthRun | null; export: HealthRun | null; audit: HealthRun | null; breadth: HealthRun | null };
  caps: {
    per_run_usdc: string | null;
    per_day_usdc: string | null;
    total_usdc: string;
    spent_run_usdc: string | null;
    spent_today_usdc: string;
    spent_total_usdc: string;
    audit_day_usdc: string;
    audit_spent_today_usdc: string;
    audit_spent_week_usdc: string;
    breadth_week_usdc: string;
    breadth_spent_today_usdc: string;
    breadth_spent_week_usdc: string;
  };
  wallets: { label: string; address: string; usdc: string | null }[];
  log_tail: { run: string | null; lines: string[] };
}

const iso = (ms: number | null | undefined) => (ms == null || !Number.isFinite(ms) ? null : new Date(ms).toISOString());
const round1 = (x: number) => Math.round(x * 10) / 10;
const usdStr = (s: string | undefined): string | null => {
  const n = Number(s);
  return s !== undefined && s.trim() !== "" && Number.isFinite(n) && n >= 0 ? atomicToUsd(usdToAtomic(n)) : null;
};

// ------------------------------------------------------------------------------------------------------------ caps

/**
 * `effective_caps` in scripts/loop.sh, in TypeScript: LOOP_RUN_USD (1.00) and LOOP_DAILY_USD (4.00), or the dated
 * LOOP_CAP_OVERRIDE_* values while now is before LOOP_CAP_OVERRIDE_UNTIL_UTC. An unreadable until time means no override.
 */
export function effectiveLoopCaps(e: Record<string, string | undefined>, now: number): { runUsd: string | null; dailyUsd: string | null; note: string } {
  const baseRun = e.LOOP_RUN_USD ?? "1.00";
  const baseDaily = e.LOOP_DAILY_USD ?? "4.00";
  const base = { runUsd: usdStr(baseRun), dailyUsd: usdStr(baseDaily) };
  const until = e.LOOP_CAP_OVERRIDE_UNTIL_UTC;
  if (!until) return { ...base, note: "base" };
  const t = Date.parse(until);
  if (!Number.isFinite(t)) return { ...base, note: `base (override until '${until}' is not a date; ignored)` };
  // loop.sh compares whole seconds.
  if (Math.floor(now / 1000) < Math.floor(t / 1000))
    return { runUsd: usdStr(e.LOOP_CAP_OVERRIDE_RUN_USD ?? baseRun), dailyUsd: usdStr(e.LOOP_CAP_OVERRIDE_DAILY_USD ?? baseDaily), note: `override until ${until}` };
  return { ...base, note: `base (override ended ${until})` };
}

// ------------------------------------------------------------------------------------------------------------ runs

interface RunRow { id: number; started_at: number; finished_at: number | null; status: string | null; notes: string | null }

/** The runs table's vocabulary in the contract's: `error` is `failed`, the stress/buy library's `completed` is `ok`. */
export function runStatusWord(r: { status: string | null; finished_at: number | null }): string {
  if (r.status === "error") return "failed";
  if (r.status === "completed") return "ok";
  return r.status ?? (r.finished_at == null ? "running" : "unknown");
}

const parseNotes = (n: string | null): Record<string, unknown> | null => {
  if (!n) return null;
  try {
    const j = JSON.parse(n) as unknown;
    return j && typeof j === "object" ? (j as Record<string, unknown>) : null;
  } catch {
    return null;
  }
};

const latest = (db: Db, where: string, params: unknown[]): RunRow | undefined =>
  db.prepare(`SELECT id, started_at, finished_at, status, notes FROM runs WHERE ${where} ORDER BY started_at DESC, id DESC LIMIT 1`).get(...params) as RunRow | undefined;

const outcomeCounts = (db: Db, where: string, params: unknown[]) => {
  const fails = [...HEADLINE_FAILURE_OUTCOMES];
  const r = db
    .prepare(`SELECT COALESCE(SUM(outcome IN (${fails.map(() => "?").join(",")})), 0) f, COALESCE(SUM(outcome = 'our_error'), 0) e, COUNT(*) n FROM calls WHERE ${where}`)
    .get(...fails, ...params) as { f: number; e: number; n: number };
  return { failures: Number(r.f), errors: Number(r.e) };
};

/** A `buy run` row (scheduled or breadth): planned calls from run_allocations (back-offs excluded), spend as the run
 * counted it (notes.spentAtomic) or, while it runs, its paid calls; failures are headline failures, errors our_error. */
function buyRun(db: Db, r: RunRow | undefined): HealthRun | null {
  if (!r) return null;
  const notes = parseNotes(r.notes);
  const planned = db.prepare("SELECT COUNT(*) n, COALESCE(SUM(planned_calls), 0) c FROM run_allocations WHERE run_id = ? AND pool != 'backoff'").get(r.id) as { n: number; c: number };
  let spent: bigint;
  if (typeof notes?.spentAtomic === "string" && /^\d+$/.test(notes.spentAtomic)) spent = BigInt(notes.spentAtomic);
  else {
    spent = 0n;
    for (const c of db.prepare("SELECT amount_paid_atomic a FROM calls WHERE run_id = ? AND paid = 1 AND amount_paid_atomic IS NOT NULL").all(r.id) as { a: string }[])
      if (/^\d+$/.test(c.a)) spent += BigInt(c.a);
  }
  return {
    status: runStatusWord(r),
    started_at: iso(r.started_at),
    finished_at: iso(r.finished_at),
    planned_calls: planned.n > 0 ? Number(planned.c) : null,
    spent_usdc: atomicToUsd(spent),
    ...outcomeCounts(db, "run_id = ?", [r.id]),
  };
}

/** Probes never pay: spend is zero, planned calls and failures do not apply; errors are the round's our_error rows. */
function probeRun(r: RunRow | undefined): HealthRun | null {
  if (!r) return null;
  const notes = parseNotes(r.notes);
  return {
    status: runStatusWord(r),
    started_at: iso(r.started_at),
    finished_at: iso(r.finished_at),
    planned_calls: null,
    spent_usdc: atomicToUsd(0n),
    failures: null,
    errors: typeof notes?.ourErrors === "number" ? notes.ourErrors : null,
  };
}

/** The latest audit-triggers row: planned calls from its non-refused decisions; spend and outcomes from the audit
 * sources' calls between its start and its end (or now while it runs), which is where its per-host audit runs write. */
function auditRun(db: Db, r: RunRow | undefined, now: number): HealthRun | null {
  if (!r) return null;
  const planned = db.prepare("SELECT COUNT(*) n, COALESCE(SUM(planned_calls), 0) c FROM audit_triggers WHERE run_id = ? AND decision != 'refused'").get(r.id) as { n: number; c: number };
  const end = r.finished_at ?? now;
  const src = AUDIT_SOURCES.map(() => "?").join(",");
  let spent = 0n;
  for (const c of db.prepare(`SELECT amount_paid_atomic a FROM calls WHERE source IN (${src}) AND ts >= ? AND ts <= ? AND paid = 1 AND amount_paid_atomic IS NOT NULL`).all(...AUDIT_SOURCES, r.started_at, end) as { a: string }[])
    if (/^\d+$/.test(c.a)) spent += BigInt(c.a);
  return {
    status: runStatusWord(r),
    started_at: iso(r.started_at),
    finished_at: iso(r.finished_at),
    planned_calls: Number(planned.c),
    spent_usdc: atomicToUsd(spent),
    ...outcomeCounts(db, `source IN (${src}) AND ts >= ? AND ts <= ?`, [...AUDIT_SOURCES, r.started_at, end]),
  };
}

const LOG_LINE = /^(\d{4}-\d\d-\d\dT\d\d:\d\d:\d\d(?:\.\d+)?Z) (?:\[(\d+)\] )?(.*)$/;
const RUN_MARKER = /^\S+Z \[\d+\] run: /;

/** Export writes no runs row; its run is read from the loop log: the last `run: … export` marker, then its own pid's
 * publish line (or `exit N`), else the CLI's `export written` line. Nothing found after the marker means running. */
export function exportRunFromLog(lines: readonly string[]): HealthRun | null {
  let at = -1;
  for (let i = lines.length - 1; i >= 0; i--) if (RUN_MARKER.test(lines[i]!) && / export --out /.test(lines[i]!)) { at = i; break; }
  if (at < 0) return null;
  const m = LOG_LINE.exec(lines[at]!)!;
  const pid = m[2];
  let status = "running";
  let finished: string | null = null;
  for (const l of lines.slice(at + 1)) {
    const x = LOG_LINE.exec(l);
    if (!x) continue;
    if (x[2] === undefined && / INFO\s+export written /.test(l) && status === "running") { status = "ok"; finished = x[1]!; continue; }
    if (x[2] !== pid) continue;
    const msg = x[3]!;
    if (/^exit \d+: .* export --out /.test(msg) || msg.startsWith("export failed")) { status = "failed"; finished = x[1]!; break; }
    if (msg.startsWith("published data:") || msg.startsWith("publish: no change")) { status = "ok"; finished = x[1]!; break; }
    if (msg.startsWith("publish failed")) { status = "publish_failed"; finished = x[1]!; break; }
    if (RUN_MARKER.test(l)) break; // the same loop process moved on
  }
  return { status, started_at: iso(Date.parse(m[1]!)), finished_at: finished === null ? null : iso(Date.parse(finished)), planned_calls: null, spent_usdc: atomicToUsd(0n), failures: null, errors: null };
}

export function healthRuns(db: Db, network: string, logLines: readonly string[], now: number): HealthBody["runs"] {
  const buyWhere = "subcommand = 'buy run' AND network = ? AND dry_run = 0";
  return {
    probe: probeRun(latest(db, "subcommand = 'probe run' AND network = ?", [network])),
    buy: buyRun(db, latest(db, `${buyWhere} AND json_extract(args_json, '$.allocation') IS NOT 'breadth'`, [network])),
    export: exportRunFromLog(logLines),
    // audit-triggers records its decisions on every run, dry or not (it buys only with AUDIT_TRIGGERS_ENABLED=1).
    audit: auditRun(db, latest(db, "subcommand = 'audit-triggers' AND network = ?", [network]), now),
    breadth: buyRun(db, latest(db, `${buyWhere} AND json_extract(args_json, '$.allocation') = 'breadth'`, [network])),
  };
}

// -------------------------------------------------------------------------------------------------------- log tail

/** The end of the loop log, at most LOG_READ_BYTES, split into lines (a partial first line is dropped). */
export function readLogEnd(path: string, bytes = LOG_READ_BYTES): string[] {
  if (!existsSync(path)) return [];
  const size = statSync(path).size;
  const start = Math.max(0, size - bytes);
  const buf = Buffer.alloc(size - start);
  const fd = openSync(path, "r");
  try {
    readSync(fd, buf, 0, buf.length, start);
  } finally {
    closeSync(fd);
  }
  const lines = buf.toString("utf8").split("\n");
  if (start > 0) lines.shift();
  if (lines.length && lines[lines.length - 1] === "") lines.pop();
  return lines;
}

const CLI_PREFIX = /^pnpm -s tsx src\/cli\.ts (?:--db \S+ )?(?:--network \S+ )?/;

/** The most recent run's lines: from the last `run:` marker on, the last LOG_TAIL_LINES of them, every line redacted.
 * With no marker in reach, the last lines of the log and run null. */
export function logTail(lines: readonly string[]): HealthBody["log_tail"] {
  let at = -1;
  for (let i = lines.length - 1; i >= 0; i--) if (RUN_MARKER.test(lines[i]!)) { at = i; break; }
  const from = at < 0 ? lines : lines.slice(at);
  let run: string | null = null;
  if (at >= 0) {
    const m = LOG_LINE.exec(lines[at]!)!;
    run = redactLine(`${m[1]} ${m[3]!.replace(/^run: /, "").replace(CLI_PREFIX, "x402-audit ")}`).slice(0, 200);
  }
  return { run, lines: redactLines(from.slice(-LOG_TAIL_LINES)) };
}

// --------------------------------------------------------------------------------------------------------- machine

export function machineHealth(repo: string, platform: string = process.platform): HealthMachine {
  let unitActive: boolean | null = null;
  if (platform === "linux") {
    const r = spawnSync("systemctl", ["is-active", LOOP_UNIT], { encoding: "utf8", timeout: 5_000 });
    unitActive = r.error ? null : r.stdout.trim() === "active";
  }
  let diskFree: number | null = null;
  try {
    const s = statfsSync(repo);
    diskFree = s.blocks > 0 ? round1((Number(s.bavail) / Number(s.blocks)) * 100) : null;
  } catch {
    diskFree = null;
  }
  let memUsed: number | null = null;
  try {
    if (platform === "linux" && existsSync("/proc/meminfo")) {
      const kb = (k: string) => Number(new RegExp(`^${k}:\\s+(\\d+)`, "m").exec(readFileSync("/proc/meminfo", "utf8"))?.[1]);
      const total = kb("MemTotal");
      const avail = kb("MemAvailable");
      if (total > 0 && Number.isFinite(avail)) memUsed = round1(((total - avail) / total) * 100);
    }
    if (memUsed === null) memUsed = round1(((totalmem() - freemem()) / totalmem()) * 100);
  } catch {
    memUsed = null;
  }
  const git = spawnSync("git", ["rev-parse", "HEAD"], { cwd: repo, encoding: "utf8", timeout: 5_000 });
  const commit = git.error || git.status !== 0 ? "" : git.stdout.trim();
  return {
    unit_active: unitActive,
    uptime_s: Math.floor(uptime()),
    disk_free_pct: diskFree,
    mem_used_pct: memUsed,
    // Existence only: the halt files are never opened.
    halt_file: existsSync(join(repo, "halt")),
    halt_buy_file: existsSync(join(repo, "halt-buy")),
    halt_probe_file: existsSync(join(repo, "halt-probe")),
    harness_commit: /^[0-9a-f]{40}$/.test(commit) ? commit : null,
  };
}

// --------------------------------------------------------------------------------------------------------- wallets

/** Older rows wrote the network as a name. */
const NETWORK_ALIASES: Record<string, string[]> = { [MAINNET]: [MAINNET, "base"], [SEPOLIA]: [SEPOLIA, "base-sepolia"] };

/**
 * The pool's public addresses, from the attempts ledger (every signature records its wallet before signing): wallets that
 * signed within 7 days of the latest signature on this network, oldest first, labelled pool-1, pool-2, ... Wallets that
 * signed before that window (an earlier pool) drop out. No key is read.
 */
export function poolWallets(db: Db, network: string): { label: string; address: string }[] {
  const nets = NETWORK_ALIASES[network] ?? [network];
  const rows = db
    .prepare(`SELECT lower(wallet) w, MIN(ts) first, MAX(ts) last FROM attempts WHERE network IN (${nets.map(() => "?").join(",")}) AND wallet LIKE '0x%' GROUP BY lower(wallet)`)
    .all(...nets) as { w: string; first: number; last: number }[];
  const newest = rows.reduce((m, r) => Math.max(m, r.last), 0);
  return rows
    .filter((r) => /^0x[0-9a-f]{40}$/.test(r.w) && r.last >= newest - WEEK_MS)
    .sort((a, b) => a.first - b.first || a.w.localeCompare(b.w))
    .slice(0, 8)
    .map((r, i) => ({ label: `pool-${i + 1}`, address: r.w }));
}

// ------------------------------------------------------------------------------------------------------------ body

export interface BuildHealthOptions {
  db: Db;
  env: Env;
  /** The environment the loop runs under (LOOP_* are read by loop.sh, not by the CLI's env schema). */
  procEnv: Record<string, string | undefined>;
  network: string;
  repo: string;
  trigger: HealthTrigger;
  now: number;
  logLines: readonly string[];
  /** USDC balance (atomic) per address; a failed read is null. */
  balances: (addresses: string[]) => Promise<(bigint | null)[]>;
  machine?: HealthMachine;
  host?: string;
}

/** The body, in the contract's key order. */
export async function buildHealthBody(o: BuildHealthOptions): Promise<HealthBody> {
  const caps = capsFromEnv(o.env);
  const eff = effectiveLoopCaps(o.procEnv, o.now);
  const runs = healthRuns(o.db, o.network, o.logLines, o.now);
  const day = utcDayStart(o.now);
  const spent = (since: number | undefined, sources: readonly CallSource[]) =>
    atomicToUsd(spentAtomic(o.db, { ...(since !== undefined ? { since } : {}), sources }));
  const wallets = poolWallets(o.db, o.network);
  let bals: (bigint | null)[];
  try {
    bals = await o.balances(wallets.map((w) => w.address));
  } catch {
    bals = wallets.map(() => null);
  }
  return {
    v: 1,
    posted_at: new Date(o.now).toISOString(),
    trigger: o.trigger,
    host: o.host ?? hostname(),
    machine: o.machine ?? machineHealth(o.repo),
    flags: { AUDIT_TRIGGERS_ENABLED: o.env.AUDIT_TRIGGERS_ENABLED, CANDIDATE_BUYS_ENABLED: o.env.CANDIDATE_BUYS_ENABLED, BREADTH_RUN_ENABLED: o.env.BREADTH_RUN_ENABLED },
    runs,
    caps: {
      per_run_usdc: eff.runUsd,
      per_day_usdc: eff.dailyUsd,
      total_usdc: atomicToUsd(caps.totalAtomic),
      spent_run_usdc: runs.buy?.spent_usdc ?? null,
      // What the scheduled-buy day budget counts (source buy since 00:00 UTC) and what MAX_TOTAL_USD counts.
      spent_today_usdc: spent(day, [CALL_SOURCES.BUY]),
      spent_total_usdc: spent(undefined, MEASURED_SOURCES),
      audit_day_usdc: atomicToUsd(caps.auditPerDayAtomic),
      audit_spent_today_usdc: spent(day, AUDIT_SOURCES),
      audit_spent_week_usdc: spent(o.now - WEEK_MS, AUDIT_SOURCES),
      breadth_week_usdc: atomicToUsd(usdToAtomic(o.env.BREADTH_WEEKLY_USD)),
      breadth_spent_today_usdc: spent(day, [CALL_SOURCES.BREADTH]),
      breadth_spent_week_usdc: spent(o.now - WEEK_MS, [CALL_SOURCES.BREADTH]),
    },
    wallets: wallets.map((w, i) => ({ label: w.label, address: w.address, usdc: bals[i] == null ? null : atomicToUsd(bals[i]!) })),
    log_tail: logTail(o.logLines),
  };
}
