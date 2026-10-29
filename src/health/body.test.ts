/**
 * The health post body (docs: the contract in src/health/body.ts): exact shape, figures from the DB and the loop's env,
 * no key material, halt files checked for existence only, and the signed POST.
 */
import { createHmac } from "node:crypto";
import { chmodSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, describe, expect, it } from "vitest";
import { privateKeyToAccount } from "viem/accounts";
import { loadEnv, usdToAtomic } from "../config/index.js";
import { openDb, type Db } from "../db/index.js";
import { buildHealthBody, effectiveLoopCaps, exportRunFromLog, logTail } from "./body.js";
import { postHealth } from "./post.js";

const NET = "eip155:8453";
const NOW = Date.UTC(2026, 9, 29, 18, 30, 0);
const H = 3_600_000;
const DAY = 24 * H;
const KEY = ("0x" + "5a".repeat(32)) as `0x${string}`;
const ADDR = privateKeyToAccount(KEY).address;
const SECRET = "test-audit-secret-value";
const HALT_TEXT = "operator note: do-not-post-this-halt-text";

const repo = mkdtempSync(join(tmpdir(), "health-"));
writeFileSync(join(repo, "halt"), HALT_TEXT);
chmodSync(join(repo, "halt"), 0o000); // unreadable: reading it would throw; existence must still be reported
afterAll(() => {
  chmodSync(join(repo, "halt"), 0o600);
  rmSync(repo, { recursive: true, force: true });
});

function envWith(vars: Record<string, string>) {
  const saved = Object.fromEntries(Object.keys(vars).map((k) => [k, process.env[k]]));
  Object.assign(process.env, vars);
  try {
    return loadEnv();
  } finally {
    for (const [k, v] of Object.entries(saved)) if (v === undefined) delete process.env[k];
    else process.env[k] = v;
  }
}
const env = envWith({ X402_AUDIT_WALLET_KEYS: KEY, AUDIT_SECRET: SECRET, MAX_TOTAL_USD: "300", BREADTH_WEEKLY_USD: "2.25", BREADTH_RUN_ENABLED: "1" });

const loopEnv = { LOOP_RUN_USD: "1.00", LOOP_DAILY_USD: "4.00", LOOP_CAP_OVERRIDE_UNTIL_UTC: "2026-11-05T00:00:00Z", LOOP_CAP_OVERRIDE_RUN_USD: "2.00", LOOP_CAP_OVERRIDE_DAILY_USD: "8.00" };

let n = 0;
function seed(): Db {
  const d = openDb(":memory:");
  d.prepare("INSERT INTO sellers (id, domain, first_seen_at, last_seen_at) VALUES (1, 'a.example', 0, 0)").run();
  d.prepare("INSERT INTO resources (id, seller_id, url, source, network, scheme, declared_price_atomic, raw_json, first_seen_at, last_seen_at) VALUES (1, 1, 'https://a.example/r', 'bazaar', ?, 'exact', '10000', '{}', 0, 0)").run(NET);
  const run = (id: number, sub: string, args: unknown, dry: 0 | 1, start: number, end: number | null, status: string, notes: unknown = null) =>
    d.prepare("INSERT INTO runs (id, subcommand, args_json, config_hash, network, dry_run, started_at, finished_at, status, notes) VALUES (?,?,?,?,?,?,?,?,?,?)").run(id, sub, JSON.stringify(args), "h", NET, dry, start, end, status, notes === null ? null : JSON.stringify(notes));
  run(1, "probe run", { once: true }, 0, NOW - H, NOW - H + 600_000, "ok", { resources: 660, ourErrors: 3 });
  run(2, "buy run", { allocation: "coverage", live: true }, 0, NOW - 30 * 60_000, NOW - 10 * 60_000, "cap_reached", { spentAtomic: "1605664" });
  run(3, "buy run", { allocation: "coverage", live: false }, 1, NOW - 5 * 60_000, NOW - 4 * 60_000, "ok"); // a dry run is not the last buy
  run(4, "buy run", { allocation: "breadth", live: true }, 0, NOW - 2 * DAY, null, "error");
  run(5, "audit-triggers", { live: true, enabled: false }, 1, NOW - 6 * H, NOW - 6 * H + 1000, "ok", { triggered: 2, planned: 1, spent: "0" });
  d.prepare("INSERT INTO run_allocations (run_id, created_at, seller_id, resource_id, pool, planned_calls, reason) VALUES (2, ?, 1, 1, 'coverage', 7, 'r'), (2, ?, 1, 1, 'maintenance', 3, 'r'), (2, ?, 1, 1, 'backoff', 0, 'b')").run(NOW, NOW, NOW);
  d.prepare("INSERT INTO audit_triggers (evaluated_at, run_id, host, reasons_json, source, priority, inputs_json, decision, planned_calls) VALUES (?, 5, 'a.example', '[]', 'audit_demand', 0, '{}', 'dry_run', 4), (?, 5, 'b.example', '[]', 'audit_demand', 1, '{}', 'refused', 9)").run(NOW, NOW);
  const call = (runId: number | null, source: string, ts: number, usd: number, outcome: string) =>
    d.prepare("INSERT INTO calls (intent_id, run_id, source, resource_id, seller_id, ts, wallet, paid, amount_paid_atomic, request_json, outcome) VALUES (?,?,?,1,1,?,?,1,?, '{}', ?)").run(`i${++n}`, runId, source, ts, ADDR, usdToAtomic(usd).toString(), outcome);
  call(2, "buy", NOW - 20 * 60_000, 0.5, "ok");
  call(2, "buy", NOW - 19 * 60_000, 0.25, "overcharge");
  call(2, "buy", NOW - 18 * 60_000, 0.05, "our_error");
  call(null, "buy", NOW - 2 * DAY, 3, "ok"); // an earlier day: total, not today
  call(4, "breadth", NOW - 2 * DAY, 0.4, "non_delivery");
  call(null, "audit_demand", NOW - 3 * DAY, 0.3, "ok");
  const attempt = (wallet: string, ts: number, network = NET) =>
    d.prepare("INSERT INTO attempts (intent_id, source, ts, resource_id, wallet, pay_to, network, asset, amount_atomic, phase) VALUES (?, 'buy', ?, 1, ?, '0xpay', ?, 'usdc', '1', 'planned')").run(`a${++n}`, ts, wallet, network);
  attempt("0x00000000000000000000000000000000000000b2", NOW - 5 * DAY);
  attempt(ADDR, NOW - 6 * DAY, "base");
  attempt(ADDR, NOW - H);
  attempt("0x00000000000000000000000000000000000000a1", NOW - 30 * DAY); // an earlier pool: dropped
  return d;
}

const LOG = [
  "2026-10-29T17:00:01Z [100] run: pnpm -s tsx src/cli.ts --db data/audit.sqlite --network eip155:8453 export --out /home/audit/x402-audit/data/paidfor-data",
  "2026-10-29T17:01:10.000Z INFO  export written {\"out\":\"/home/audit/x402-audit/data/paidfor-data\"}",
  "2026-10-29T17:01:12Z [100] published data: 2026-10-29T17:01:10Z to paidfor-data main",
  "2026-10-29T18:00:30Z [200] run: pnpm -s tsx src/cli.ts --db data/audit.sqlite --network eip155:8453 --live buy run --seed 2026102918",
  `X402_AUDIT_WALLET_KEYS=${KEY}`,
  ...Array.from({ length: 45 }, (_, i) => `2026-10-29T18:01:${String(i).padStart(2, "0")}.000Z INFO  call ${i} wallet=${ADDR}`),
  `2026-10-29T18:02:00.000Z INFO  key ${KEY.slice(2)} Authorization: Bearer abc`,
];

const build = (o: { db?: Db; procEnv?: Record<string, string | undefined>; balances?: (a: string[]) => Promise<(bigint | null)[]>; now?: number } = {}) =>
  buildHealthBody({
    db: o.db ?? seed(),
    env,
    procEnv: o.procEnv ?? loopEnv,
    network: NET,
    repo,
    trigger: "buy",
    now: o.now ?? NOW,
    logLines: LOG,
    balances: o.balances ?? (async (a) => a.map((_, i) => (i === 0 ? 12_345_678n : null))),
    host: "audit-host",
  });

describe("health body", () => {
  it("has exactly the contract's keys, in order, at every level", async () => {
    const b = await build();
    expect(Object.keys(b)).toEqual(["v", "posted_at", "trigger", "host", "machine", "flags", "runs", "caps", "wallets", "log_tail"]);
    expect(Object.keys(b.machine)).toEqual(["unit_active", "uptime_s", "disk_free_pct", "mem_used_pct", "halt_file", "halt_buy_file", "halt_probe_file", "harness_commit"]);
    expect(Object.keys(b.flags)).toEqual(["AUDIT_TRIGGERS_ENABLED", "CANDIDATE_BUYS_ENABLED", "BREADTH_RUN_ENABLED"]);
    expect(Object.keys(b.runs)).toEqual(["probe", "buy", "export", "audit", "breadth"]);
    for (const r of Object.values(b.runs)) expect(Object.keys(r!)).toEqual(["status", "started_at", "finished_at", "planned_calls", "spent_usdc", "failures", "errors"]);
    expect(Object.keys(b.caps)).toEqual([
      "per_run_usdc", "per_day_usdc", "total_usdc", "spent_run_usdc", "spent_today_usdc", "spent_total_usdc",
      "audit_day_usdc", "audit_spent_today_usdc", "audit_spent_week_usdc", "breadth_week_usdc", "breadth_spent_today_usdc", "breadth_spent_week_usdc",
    ]);
    for (const w of b.wallets) expect(Object.keys(w)).toEqual(["label", "address", "usdc"]);
    expect(Object.keys(b.log_tail)).toEqual(["run", "lines"]);
    expect(b).toMatchObject({ v: 1, posted_at: "2026-10-29T18:30:00.000Z", trigger: "buy", host: "audit-host" });
    expect(b.flags).toEqual({ AUDIT_TRIGGERS_ENABLED: "0", CANDIDATE_BUYS_ENABLED: "0", BREADTH_RUN_ENABLED: "1" });
    // Every amount is a 6-decimal string.
    const amounts = [...Object.values(b.caps), ...Object.values(b.runs).map((r) => r!.spent_usdc), ...b.wallets.map((w) => w.usdc)].filter((x) => x !== null);
    for (const a of amounts) expect(a).toMatch(/^\d+\.\d{6}$/);
  });

  it("takes runs from the runs table, planned calls from run_allocations, spend as the run counted it", async () => {
    const { runs } = await build();
    expect(runs.probe).toEqual({ status: "ok", started_at: "2026-10-29T17:30:00.000Z", finished_at: "2026-10-29T17:40:00.000Z", planned_calls: null, spent_usdc: "0.000000", failures: null, errors: 3 });
    expect(runs.buy).toEqual({ status: "cap_reached", started_at: "2026-10-29T18:00:00.000Z", finished_at: "2026-10-29T18:20:00.000Z", planned_calls: 10, spent_usdc: "1.605664", failures: 1, errors: 1 });
    expect(runs.breadth).toEqual({ status: "failed", started_at: "2026-10-27T18:30:00.000Z", finished_at: null, planned_calls: null, spent_usdc: "0.400000", failures: 1, errors: 0 });
    expect(runs.audit).toMatchObject({ status: "ok", planned_calls: 4, spent_usdc: "0.000000", failures: 0, errors: 0 });
    expect(runs.export).toEqual({ status: "ok", started_at: "2026-10-29T17:00:01.000Z", finished_at: "2026-10-29T17:01:12.000Z", planned_calls: null, spent_usdc: "0.000000", failures: null, errors: null });
  });

  it("caps are the effective ones now, with the dated override, and spend matches what each cap counts", async () => {
    const b = await build();
    expect(b.caps).toEqual({
      per_run_usdc: "2.000000",
      per_day_usdc: "8.000000",
      total_usdc: "300.000000",
      spent_run_usdc: "1.605664",
      spent_today_usdc: "0.800000", // source buy since 00:00 UTC
      spent_total_usdc: "4.500000", // buy + breadth + audit, all time (MAX_TOTAL_USD)
      audit_day_usdc: "5.000000",
      audit_spent_today_usdc: "0.000000",
      audit_spent_week_usdc: "0.300000",
      breadth_week_usdc: "2.250000",
      breadth_spent_today_usdc: "0.000000",
      breadth_spent_week_usdc: "0.400000",
    });
    const after = await build({ now: Date.UTC(2026, 10, 5, 0, 0, 0) });
    expect([after.caps.per_run_usdc, after.caps.per_day_usdc]).toEqual(["1.000000", "4.000000"]);
  });

  it("wallets are the recent public addresses from the attempts ledger, lowercase, with balances or null", async () => {
    const seen: string[][] = [];
    const b = await build({ balances: async (a) => (seen.push(a), a.map((_, i) => (i === 0 ? 12_345_678n : null))) });
    expect(b.wallets).toEqual([
      { label: "pool-1", address: ADDR.toLowerCase(), usdc: "12.345678" },
      { label: "pool-2", address: "0x00000000000000000000000000000000000000b2", usdc: null },
    ]);
    expect(seen).toEqual([[ADDR.toLowerCase(), "0x00000000000000000000000000000000000000b2"]]);
    const failing = await build({ balances: async () => { throw new Error("rpc down"); } });
    expect(failing.wallets.map((w) => w.usdc)).toEqual([null, null]);
  });

  it("carries no key material, no secret and no halt file contents", async () => {
    const text = JSON.stringify(await build());
    expect(text.toLowerCase()).not.toContain(KEY.slice(2).toLowerCase());
    expect(text).not.toContain(SECRET);
    expect(text).not.toContain(HALT_TEXT);
    expect(text).not.toContain("/home/audit");
  });

  it("reports halt files by existence only (the halt file here is unreadable)", async () => {
    const { machine } = await build();
    expect(machine).toMatchObject({ halt_file: true, halt_buy_file: false, halt_probe_file: false, harness_commit: null });
    expect(typeof machine.uptime_s).toBe("number");
  });
});

describe("log tail", () => {
  it("is the last run's lines, at most 40, redacted", () => {
    const t = logTail(LOG);
    expect(t.run).toBe("2026-10-29T18:00:30Z x402-audit --live buy run --seed 2026102918");
    expect(t.lines).toHaveLength(40);
    expect(t.lines.at(-1)).toBe("2026-10-29T18:02:00.000Z INFO  key [REDACTED] Authorization: [REDACTED]");
    expect(t.lines.join("\n")).not.toContain(KEY.slice(2));
    expect(t.lines[0]).toContain("call 6 wallet=" + ADDR); // public addresses stay
    const short = logTail(LOG.slice(0, 5));
    expect(short.lines).toEqual([LOG[3], "X402_AUDIT_WALLET_KEYS=[REDACTED]"]);
  });

  it("with no run marker is the last lines and run null; an empty log is empty", () => {
    expect(logTail(["a", "b"])).toEqual({ run: null, lines: ["a", "b"] });
    expect(logTail([])).toEqual({ run: null, lines: [] });
  });

  it("export run: failed, running, publish failed", () => {
    const m = "2026-10-29T17:00:01Z [7] run: pnpm -s tsx src/cli.ts --db d --network n export --out x";
    expect(exportRunFromLog([m, "2026-10-29T17:00:09Z [7] exit 1: pnpm -s tsx src/cli.ts --db d --network n export --out x"])?.status).toBe("failed");
    expect(exportRunFromLog([m])).toMatchObject({ status: "running", finished_at: null });
    expect(exportRunFromLog([m, "2026-10-29T17:00:09Z [8] published data: x", "2026-10-29T17:00:10Z [7] publish failed (commit or push)"])).toMatchObject({ status: "publish_failed", finished_at: "2026-10-29T17:00:10.000Z" });
    expect(exportRunFromLog(["2026-10-29T17:00:01Z [7] run: x probe run --once"])).toBeNull();
  });
});

describe("effective caps (scripts/loop.sh effective_caps)", () => {
  const until = Date.UTC(2026, 10, 5);
  it("override while now is before the until time, base from it on, base when unreadable or absent", () => {
    expect(effectiveLoopCaps(loopEnv, until - 1000)).toMatchObject({ runUsd: "2.000000", dailyUsd: "8.000000", note: "override until 2026-11-05T00:00:00Z" });
    expect(effectiveLoopCaps(loopEnv, until)).toMatchObject({ runUsd: "1.000000", dailyUsd: "4.000000", note: "base (override ended 2026-11-05T00:00:00Z)" });
    expect(effectiveLoopCaps({ ...loopEnv, LOOP_CAP_OVERRIDE_UNTIL_UTC: "soon" }, 0)).toMatchObject({ runUsd: "1.000000", dailyUsd: "4.000000" });
    expect(effectiveLoopCaps({}, 0)).toEqual({ runUsd: "1.000000", dailyUsd: "4.000000", note: "base" });
    expect(effectiveLoopCaps({ LOOP_RUN_USD: "x" }, 0).runUsd).toBeNull();
  });
});

describe("health post", () => {
  it("signs exactly like the audit callback and posts to /v1/admin/health", async () => {
    let got: { url: string; init: RequestInit } | undefined;
    const body = JSON.stringify({ v: 1 });
    const r = await postHealth("https://paidfor.example/", SECRET, body, async (url, init) => ((got = { url, init }), new Response("{}", { status: 201 })), 1_761_739_200_000);
    expect(r).toBe("posted 201");
    expect(got!.url).toBe("https://paidfor.example/v1/admin/health");
    const h = got!.init.headers as Record<string, string>;
    expect(h["x-paidfor-audit-timestamp"]).toBe("1761739200");
    expect(h["x-paidfor-audit-signature"]).toBe("sha256=" + createHmac("sha256", SECRET).update(`1761739200.${body}`).digest("hex"));
    expect(got!.init.body).toBe(body);
  });

  it("never throws: no secret, a refusal and a network failure are words", async () => {
    expect(await postHealth("https://x", "", "{}", async () => { throw new Error("unused"); })).toBe("skipped_no_secret");
    expect(await postHealth("https://x", SECRET, "{}", async () => new Response("", { status: 400 }))).toBe("failed:400");
    expect(await postHealth("https://x", SECRET, "{}", async () => { throw new Error("getaddrinfo ENOTFOUND x"); })).toBe("failed:getaddrinfo ENOTFOUND x");
  });
});

