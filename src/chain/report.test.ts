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
    // A has an unchecked row and no sample -> partial; B fully verified: share-adjusted = verified rows here
    expect(d.shareRules.map((r) => r.rule)).toEqual(["partial", "fully-verified"]);
    expect(d.shareAdjusted.market.n).toBe(16);
    expect(d.adjusted).toBe(d.shareAdjusted.market);
    expect(d.adjustedBasis).toBe("share-adjusted");
  });

  it("no verified rows -> adjusted is null; dust floor and window are parameters", () => {
    const db = seed();
    db.prepare("UPDATE chain_transfers SET via_authorization = NULL").run();
    const d = computeChainProxies(db, { network: NET });
    expect(d.verified.market.n).toBe(0);
    expect(d.shareAdjusted.market.n).toBe(0);
    expect(d.adjusted).toBeNull();
    expect(d.adjustedBasis).toBeNull();
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
    expect(Object.keys(CHAIN_PROXY_QUERIES).sort()).toEqual([
      "chain_proxy_duplicate_runs",
      "chain_proxy_isolated_pairs",
      "chain_proxy_overcharge",
      "chain_proxy_totals",
    ]);
    expect(CHAIN_PROXY_QUERIES.chain_proxy_duplicate_runs).toContain("LAG(block_ts) OVER w");
    expect(CHAIN_PROXY_QUERIES.chain_proxy_isolated_pairs).toContain("PARTITION BY from_addr, to_addr, value_atomic");
    expect(CHAIN_PROXY_QUERIES.chain_proxy_isolated_pairs).toContain("PARTITION BY from_addr, to_addr ORDER BY");
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
    expect(md).toContain(
      "| proxy | verified only (n = 16, 2 pay-tos) | pay-tos | share-adjusted (n = 16, 2 pay-tos) | pay-tos | " +
        "all non-dust (not x402-filtered; shown for transparency only, not a floor) (n = 20, 2 pay-tos) | pay-tos |",
    );
    // verified 0/16 > mode (0 pay-tos), share-adjusted same, all 4/20 (1 pay-to): all non-dust column last
    expect(md).toMatch(/\| overcharge proxy: value > mode \| 0\.00% \[[^\]]+\] \(0\) \| 0 \| 0\.00% \[[^\]]+\] \(0\) \| 0 \| 20\.00% \[[^\]]+\] \(4\) \| 1 \|/);
    expect(md).toContain("| isolated duplicate pairs (lone retry) |");
    expect(md).toContain("## Per pay-to (all non-dust view; not x402-filtered, transparency only)");
    expect(md).toContain(`| 1 | ${A} | a.example | 15 | $0.220000 | $0.010000 | 4 (26.67%) | 2 (13.33%) | 0 | 11 | 90.00% [60.00%, 98.00%] (n = 10) |`);
    expect(md).toContain("## Per pay-to (verified view)");
    expect(md).toContain("## Per pay-to (share-adjusted view)");
    expect(md).toContain("## Share-adjusted rule per pay-to");
    expect(md).toContain(`| 1 | ${A} | partially verified: verified rows only | 15 | 1 | 11 | 11 | 60.00% |`);
    expect(md).toContain("Adjusted (share-adjusted view)");
    expect(md).toContain("### EIP-3009 share (sampled receipts)");
    for (const c of CHAIN_CAVEATS) expect(md).toContain(c);
    expect(md).toMatch(/Delivery is invisible on-chain/);
    expect(md).toMatch(/floors/);
    expect(md).toMatch(/legitimately different product or a dynamic price/);
    expect(md).toMatch(/within 120 s may be a legitimate second purchase/);
  });
});

/**
 * Share-adjusted and isolated-pair fixture (all within block window 1000..2000):
 *   P1: 4 x 5000 via = 1 + 1 x 5000 via = 0, distinct payers, hours apart -> rule (a), 4 rows used.
 *   P2: all unverified, sampled share lo 0.963 -> rule (b), all 18 rows used:
 *       X: isolated pair, 2 x 10000 30 s apart, nothing else from X to P2;
 *       H: 10 x 2000 20 s apart (high-frequency consumer): 9 followers, 0 isolated pairs;
 *       Y: 2 x 10000 30 s apart + 1 x 3000 30 min later (not isolated): 1 follower, 0 isolated pairs;
 *       3 x 10000 singles from distinct payers.
 *   P3: 2 x 7000 via = 1 + 3 x 7000 unverified, sampled share lo 0.30 -> partial, 2 rows used.
 */
const P1 = addr(0xa1);
const P2 = addr(0xa2);
const P3 = addr(0xa3);
function seedShares(): Db {
  txN = 0;
  const db = openDb(":memory:");
  const H = 3_600_000;
  for (let i = 0; i < 4; i++) ins(db, { from: addr(0x1000 + i), to: P1, value: "5000", ts: T0 + i * 2 * H, via: 1 });
  ins(db, { from: addr(0x1010), to: P1, value: "5000", ts: T0 + 9 * H, via: 0 });
  const X = addr(0x2000);
  ins(db, { from: X, to: P2, value: "10000", ts: T0 + 10 * H });
  ins(db, { from: X, to: P2, value: "10000", ts: T0 + 10 * H + 30_000 });
  const HF = addr(0x2001);
  for (let i = 0; i < 10; i++) ins(db, { from: HF, to: P2, value: "2000", ts: T0 + 12 * H + i * 20_000 });
  const Y = addr(0x2002);
  ins(db, { from: Y, to: P2, value: "10000", ts: T0 + 14 * H });
  ins(db, { from: Y, to: P2, value: "10000", ts: T0 + 14 * H + 30_000 });
  ins(db, { from: Y, to: P2, value: "3000", ts: T0 + 14 * H + 30 * 60_000 });
  for (let i = 0; i < 3; i++) ins(db, { from: addr(0x2100 + i), to: P2, value: "10000", ts: T0 + (16 + i) * H });
  for (let i = 0; i < 5; i++) ins(db, { from: addr(0x3000 + i), to: P3, value: "7000", ts: T0 + i * 2 * H, via: i < 2 ? 1 : null });
  computePayToVolumes(db, { network: NET, payTos: [P1, P2, P3], fromBlock: 1_000n, toBlock: 2_000n, fromTsMs: BigInt(T0), toTsMs: BigInt(T0 + 100_000_000), dustFloorAtomic: 100n });
  const meta = (payTo: string, sampled: number, via: number, lo: number, hi: number) =>
    db.prepare("INSERT INTO meta (key, value) VALUES (?, ?)").run(
      eip3009ShareMetaKey(NET, payTo),
      JSON.stringify({ payTo, sampled, viaAuthorization: via, share: via / sampled, lo, hi, population: sampled, errors: 0 }),
    );
  meta(P2, 100, 100, 0.963, 1);
  meta(P3, 10, 4, 0.3, 0.7);
  return db;
}

describe("share-adjusted view and isolated duplicate pairs", () => {
  it("chooses a rule per pay-to", () => {
    const d = computeChainProxies(seedShares(), { network: NET });
    expect(d.universePayTos).toBe(3);
    const rule = (p: string) => d.shareRules.find((r) => r.payTo === p)!;
    expect(rule(P1)).toMatchObject({ rule: "fully-verified", nonDustRows: 5, uncheckedRows: 0, verifiedRows: 4, includedRows: 4, shareLo: null });
    expect(rule(P2)).toMatchObject({ rule: "high-share", nonDustRows: 18, uncheckedRows: 18, verifiedRows: 0, includedRows: 18, shareLo: 0.963 });
    expect(rule(P3)).toMatchObject({ rule: "partial", nonDustRows: 5, uncheckedRows: 3, verifiedRows: 2, includedRows: 2, shareLo: 0.3 });
  });

  it("three views' counts and pay-to counts", () => {
    const d = computeChainProxies(seedShares(), { network: NET });
    expect(d.verified.market).toMatchObject({ n: 6, payTos: 2 });
    expect(d.shareAdjusted.market).toMatchObject({ n: 24, payTos: 3 });
    expect(d.all.market).toMatchObject({ n: 28, payTos: 3 });
    expect(d.shareAdjusted.rows.find((r) => r.payTo === P1)!.transfers).toBe(4);
    expect(d.shareAdjusted.rows.find((r) => r.payTo === P2)!.transfers).toBe(18);
    expect(d.shareAdjusted.rows.find((r) => r.payTo === P3)!.transfers).toBe(2);
    expect(d.adjusted).toBe(d.shareAdjusted.market);
    expect(d.adjustedBasis).toBe("share-adjusted");
    // P1 / P3 have no rows in their own (payer-distinct) duplicates; only P2 contributes duplicates
    expect(d.shareAdjusted.market.duplicate.payTos).toBe(1);
    expect(d.verified.market.isolatedPairs.count.k).toBe(0);
  });

  it("isolated pairs: lone retry counts, high-frequency consumer and non-isolated pair do not", () => {
    const d = computeChainProxies(seedShares(), { network: NET });
    const p2 = d.shareAdjusted.rows.find((r) => r.payTo === P2)!;
    expect(p2.dupFollowers.count).toBe(1 + 9 + 1);
    expect(p2.isolatedPairs).toEqual({ count: 1, atomic: 10_000n });
    const m = d.shareAdjusted.market.isolatedPairs;
    expect(m.count).toMatchObject({ k: 1, n: 24 });
    expect(m.dollar.atomic).toBe(10_000n);
    expect(m.payTos).toBe(1);
    expect(d.all.market.isolatedPairs.count.k).toBe(1);
    // isolation window shrunk below 30 min -> Y's pair also isolated
    expect(computeChainProxies(seedShares(), { network: NET, isolationS: 600 }).all.market.isolatedPairs.count.k).toBe(2);
    // window shrunk below 30 s -> no pairs, H's 20 s run still has followers
    const w = computeChainProxies(seedShares(), { network: NET, windowS: 25 }).all.market;
    expect(w.isolatedPairs.count.k).toBe(0);
    expect(w.duplicate.count.k).toBe(9);
  });

  it("threshold is a parameter; share-adjusted always contains the verified rows", () => {
    const db = seedShares();
    // lo 0.963 < 0.99 -> P2 becomes partial and contributes its 0 verified rows
    const d = computeChainProxies(db, { network: NET, shareAdjustMinLo: 0.99 });
    expect(Object.fromEntries(d.shareRules.map((r) => [r.payTo, r.rule]))).toEqual({ [P1]: "fully-verified", [P2]: "partial", [P3]: "partial" });
    expect(d.shareAdjusted.market.n).toBe(d.verified.market.n);
    expect(d.adjustedBasis).toBe("share-adjusted");
    db.prepare("DELETE FROM meta").run();
    db.prepare("UPDATE chain_transfers SET via_authorization = NULL").run();
    const e = computeChainProxies(db, { network: NET });
    expect(e.shareRules.map((r) => r.rule)).toEqual(["partial", "partial", "partial"]);
    expect(e.adjusted).toBeNull();
  });

  it("renders the rule labels", () => {
    const md = renderChainReport(computeChainProxies(seedShares(), { network: NET }));
    expect(md).toContain(`| ${P1} | (a) fully verified: via_authorization = 1 rows | 5 | 0 | 4 | 4 | not sampled |`);
    expect(md).toContain(`| ${P2} | (b) sampled share lo >= 95%: all non-dust rows, assumed x402 | 18 | 18 | 0 | 18 | 96.30% |`);
    expect(md).toContain(`| ${P3} | partially verified: verified rows only | 5 | 3 | 2 | 2 | 30.00% |`);
    expect(md).toContain("isolated duplicate pairs 4.17%");
    expect(md).toContain("(1 pairs, $0.010000)");
  });
});
