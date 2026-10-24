import { describe, expect, it } from "vitest";
import { openDb, type Db } from "../db/index.js";
import { computePayToVolumes } from "./volume.js";
import { CHAIN_CAVEATS, CHAIN_PROXY_QUERIES, computeChainProxies, renderChainReport } from "./report.js";
import { eip3009ShareMetaKey } from "./verify.js";

const NET = "eip155:8453";
const A = "0xaaaa00000000000000000000000000000000aaaa";
const B = "0xbbbb00000000000000000000000000000000bbbb";
const addr = (n: number) => `0x${n.toString(16).padStart(40, "0")}`;
const T0 = 1_700_000_000_000; // ms

let txN = 0;
function ins(db: Db, r: { from: string; to: string; value: string; ts: number; block?: number; via?: number | null }) {
  txN++;
  db.prepare(
    "INSERT INTO chain_transfers (network, tx_hash, log_index, block_number, block_ts, from_addr, to_addr, value_atomic, via_authorization) VALUES (?, ?, 0, ?, ?, ?, ?, ?, ?)",
  ).run(NET, `0x${txN.toString(16).padStart(64, "0")}`, r.block ?? 1_000 + txN, r.ts, r.from, r.to, r.value, r.via ?? null);
}

/**
 * A: 11 x 10000 (6 single payers far apart, a 3-row exact duplicate run 10 s apart, a pair 500 s apart),
 *    3 x 20000, 1 x 50000, 3 dust rows (a dust "run" 1 s apart), 1 row outside the window.
 * B: 5 x 5000 from distinct payers.
 * Verified: A's 10000 rows and B's rows = 1, A's 20000 = 0, A's 50000 = NULL.
 */
function seed(): Db {
  txN = 0;
  const db = openDb(":memory:");
  const now = Date.now();
  db.prepare("INSERT INTO sellers (id, domain, first_seen_at, last_seen_at) VALUES (1, 'a.example', ?, ?)").run(now, now);
  db.prepare("INSERT INTO resources (seller_id, url, source, pay_to, raw_json, first_seen_at, last_seen_at) VALUES (1, 'https://a.example/x', 'bazaar', ?, '{}', ?, ?)").run(
    A.toUpperCase().replace("0X", "0x"),
    now,
    now,
  );
  for (let i = 0; i < 6; i++) ins(db, { from: addr(100 + i), to: A, value: "10000", ts: T0 + i * 3_600_000, via: 1 });
  const D = addr(200);
  for (let i = 0; i < 3; i++) ins(db, { from: D, to: A, value: "10000", ts: T0 + 50_000_000 + i * 10_000, via: 1 });
  const N = addr(300);
  ins(db, { from: N, to: A, value: "10000", ts: T0 + 60_000_000, via: 1 });
  ins(db, { from: N, to: A, value: "10000", ts: T0 + 60_500_000, via: 1 });
  for (let i = 0; i < 3; i++) ins(db, { from: addr(400 + i), to: A, value: "20000", ts: T0 + 70_000_000 + i * 1000, via: 0 });
  ins(db, { from: addr(500), to: A, value: "50000", ts: T0 + 80_000_000 });
  for (let i = 0; i < 3; i++) ins(db, { from: addr(666), to: A, value: "20", ts: T0 + 90_000_000 + i * 1000 });
  ins(db, { from: addr(777), to: A, value: "10000", ts: T0 + 99_000_000, block: 99_999, via: 1 }); // outside window
  for (let i = 0; i < 5; i++) ins(db, { from: addr(800 + i), to: B, value: "5000", ts: T0 + i * 1_000_000, via: 1 });
  computePayToVolumes(db, { network: NET, payTos: [A, B], fromBlock: 1_000n, toBlock: 2_000n, fromTsMs: BigInt(T0), toTsMs: BigInt(T0 + 100_000_000), dustFloorAtomic: 100n });
  return db;
}

describe("computeChainProxies", () => {
  it("per pay-to numbers, all non-dust view", () => {
    const d = computeChainProxies(seed(), { network: NET });
    expect(d.universePayTos).toBe(2);
    expect(d.window).toMatchObject({ fromBlock: 1_000, toBlock: 2_000, fromTs: T0, toTs: T0 + 100_000_000, uniform: true });
    const a = d.all.rows.find((r) => r.payTo === A)!;
    expect(a.sellerDomains).toEqual(["a.example"]);
    expect(a.transfers).toBe(15);
    expect(a.sumAtomic).toBe(220_000n);
    expect(a.uniquePayers).toBe(6 + 1 + 1 + 3 + 1);
    expect(a.modeAtomic).toBe(10_000n);
    expect(a.overMode).toEqual({ count: 4, atomic: 110_000n });
    expect(a.over2xMode).toEqual({ count: 1, atomic: 50_000n });
    expect(a.dupFollowers).toEqual({ count: 2, atomic: 20_000n });
    expect(a.dupRuns).toBe(1);
    expect(a).toMatchObject({ verifiedRows: 11, plainRows: 3, uncheckedRows: 1 });
    const b = d.all.rows.find((r) => r.payTo === B)!;
    expect(b).toMatchObject({ transfers: 5, sumAtomic: 25_000n, modeAtomic: 5_000n, dupRuns: 0 });
    expect(b.overMode.count).toBe(0);
  });

  it("market-wide rates, count- and dollar-weighted", () => {
    const m = computeChainProxies(seed(), { network: NET }).all.market;
    expect(m.n).toBe(20);
    expect(m.sumAtomic).toBe(245_000n);
    expect(m.overMode.count).toMatchObject({ k: 4, n: 20, p: 0.2 });
    expect(m.over2xMode.count).toMatchObject({ k: 1, n: 20, p: 0.05 });
    expect(m.duplicate.count).toMatchObject({ k: 2, n: 20, p: 0.1 });
    expect(m.overMode.count.lo).toBeGreaterThan(0);
    expect(m.overMode.count.hi).toBeLessThan(1);
    expect(m.overMode.dollar.atomic).toBe(110_000n);
    expect(m.overMode.dollar.p).toBeCloseTo(110_000 / 245_000, 10);
    expect(m.over2xMode.dollar.p).toBeCloseTo(50_000 / 245_000, 10);
    expect(m.duplicate.dollar.p).toBeCloseTo(20_000 / 245_000, 10);
    expect(m.overMode.dollar.effectiveN).toBeGreaterThan(0);
    expect(m.overMode.dollar.effectiveN).toBeLessThan(20);
  });

  it("verified view keeps only via_authorization = 1 rows", () => {
    const d = computeChainProxies(seed(), { network: NET });
    const v = d.verified;
    const a = v.rows.find((r) => r.payTo === A)!;
    expect(a.transfers).toBe(11);
    expect(a.modeAtomic).toBe(10_000n);
    expect(a.overMode.count).toBe(0);
    expect(a.dupFollowers.count).toBe(2);
    expect(v.market.n).toBe(16);
    expect(v.market.duplicate.count).toMatchObject({ k: 2, n: 16 });
    expect(d.adjusted).toBe(v.market);
  });

  it("no verified rows -> adjusted is null; dust floor and window are parameters", () => {
    const db = seed();
    db.prepare("UPDATE chain_transfers SET via_authorization = NULL").run();
    const d = computeChainProxies(db, { network: NET });
    expect(d.verified.market.n).toBe(0);
    expect(d.adjusted).toBeNull();
    // dust floor 10 -> the 3 dust rows join: 2 more followers
    expect(computeChainProxies(db, { network: NET, dustFloorAtomic: 10n }).all.market.duplicate.count.k).toBe(4);
    // window 600 s -> the 500 s pair also counts
    expect(computeChainProxies(db, { network: NET, windowS: 600 }).all.market.duplicate.count.k).toBe(3); // 2-follower run + the 500 s pair (the 20000s are different payers)
    expect(computeChainProxies(db, { network: NET, topN: 1 }).universePayTos).toBe(1);
  });

  it("reads the eip3009 sample shares from meta", () => {
    const db = seed();
    const s = { payTo: A, sampled: 100, viaAuthorization: 80, share: 0.8, lo: 0.71, hi: 0.87, population: 15, errors: 0 };
    db.prepare("INSERT INTO meta (key, value) VALUES (?, ?)").run(eip3009ShareMetaKey(NET, A), JSON.stringify(s));
    const d = computeChainProxies(db, { network: NET });
    expect(d.eip3009).toEqual([s]);
    expect(d.all.rows.find((r) => r.payTo === A)!.eip3009).toEqual(s);
    expect(d.all.rows.find((r) => r.payTo === B)!.eip3009).toBeNull();
  });

  it("exports the SQL under the names shared with src/report/queries.ts", () => {
    expect(Object.keys(CHAIN_PROXY_QUERIES).sort()).toEqual(["chain_proxy_duplicate_runs", "chain_proxy_overcharge", "chain_proxy_totals"]);
    expect(CHAIN_PROXY_QUERIES.chain_proxy_duplicate_runs).toContain("LAG(block_ts) OVER w");
  });
});

describe("renderChainReport", () => {
  it("contains window, both market tables, the per pay-to table and the caveats", () => {
    const db = seed();
    db.prepare("INSERT INTO meta (key, value) VALUES (?, ?)").run(
      eip3009ShareMetaKey(NET, A),
      JSON.stringify({ payTo: A, sampled: 10, viaAuthorization: 9, share: 0.9, lo: 0.6, hi: 0.98, population: 15, errors: 0 }),
    );
    const md = renderChainReport(computeChainProxies(db, { network: NET }));
    expect(md).toContain("blocks 1000..2000");
    expect(md).toContain(new Date(T0).toISOString());
    expect(md).toContain("### Count-weighted");
    expect(md).toContain("### Dollar-weighted");
    expect(md).toContain("| proxy | all non-dust (n = 20) | verified only (n = 16) |");
    expect(md).toContain("| overcharge proxy: value > mode | 20.00%");
    expect(md).toContain("## Per pay-to (all non-dust view)");
    expect(md).toContain(`| 1 | ${A} | a.example | 15 | $0.220000 | $0.010000 | 4 (26.67%) | 2 (13.33%) | 11 | 90.00% [60.00%, 98.00%] (n = 10) |`);
    expect(md).toContain("## Per pay-to (verified view)");
    expect(md).toContain("Adjusted (verified rows only)");
    expect(md).toContain("### EIP-3009 share (sampled receipts)");
    for (const c of CHAIN_CAVEATS) expect(md).toContain(c);
    expect(md).toMatch(/Delivery is invisible on-chain/);
    expect(md).toMatch(/floors/);
    expect(md).toMatch(/legitimately different product or a dynamic price/);
    expect(md).toMatch(/within 120 s may be a legitimate second purchase/);
  });
});
