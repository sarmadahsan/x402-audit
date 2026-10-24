import { describe, expect, it } from "vitest";
import { openDb } from "../db/index.js";
import { MAINNET } from "../config/index.js";
import { computeReport, dollarRate, modeOf } from "./compute.js";
import { QUERIES, QUERY_NAMES, paramsOf, runQuery } from "./queries.js";
import { NOW, P1, P2, seedDb } from "./test-helpers.js";
import { dollarWeightedWilson, wilsonInterval } from "./wilson.js";

const opts = { network: MAINNET, now: NOW, dustFloorAtomic: 100n };

describe("queries", () => {
  it("every query in QUERIES prepares against an empty schema", () => {
    const db = openDb(":memory:");
    for (const name of QUERY_NAMES) expect(() => db.prepare(QUERIES[name]), name).not.toThrow();
  });
  it("every query runs on an empty schema with the standard params", () => {
    const db = openDb(":memory:");
    for (const name of QUERY_NAMES) {
      expect(() => runQuery(db, name, { since: 0, until: NOW, network: MAINNET, min_calls: 30, window_ms: 120_000 }), name).not.toThrow();
    }
  });
  it("runQuery rejects missing params", () => {
    const db = openDb(":memory:");
    expect(paramsOf("buy_sellers_min_calls")).toContain("min_calls");
    expect(() => runQuery(db, "buy_sellers_min_calls", { since: 0, until: 1, network: MAINNET })).toThrow(/min_calls/);
  });
  it("computeReport on an empty db does not throw", () => {
    const r = computeReport(openDb(":memory:"), { network: MAINNET, now: NOW });
    expect(r.headline.count.n).toBe(0);
    expect(r.headline.count.hi).toBe(1);
    expect(r.meta.spend_usdc).toBe("0.000000");
  });
});

describe("computeReport", () => {
  const r = computeReport(seedDb(), opts);

  it("denominator excludes our_error, indeterminate, not_paid and unpaid overcharges", () => {
    expect(r.headline.count.n).toBe(60);
    expect(r.headline.excluded).toEqual({ our_error: 2, indeterminate: 2, not_paid: 2, unclassified: 0, unpaid_overcharge: 1, exposure_atomic: "900000" });
    expect(r.headline.dollar.exposure_atomic).toBe("900000");
  });

  it("injection is flagged, not a failure", () => {
    expect(r.headline.count.failures).toBe(12);
    expect(r.headline.flagged.injection).toBe(2);
    expect(r.headline.flagged.injection_hit_total).toBe(3);
    expect(r.by_failure_type.map((x) => x.outcome)).not.toContain("injection");
  });

  it("count rate and CI match wilsonInterval", () => {
    const w = wilsonInterval(12, 60);
    expect(r.headline.count.rate).toBe(w.p);
    expect(r.headline.count.lo).toBe(w.lo);
    expect(r.headline.count.hi).toBe(w.hi);
  });

  it("dollar totals are exact bigint strings and the interval matches dollarWeightedWilson", () => {
    expect(r.headline.dollar.total_atomic).toBe("822000");
    expect(r.headline.dollar.failed_atomic).toBe("355000");
    expect(r.headline.delivered_without_settlement).toBe(2);
    expect(r.headline.resolved_late_in_denominator).toBe(1);
    expect(r.headline.dollar.note).toBe("Kish effective-n approximation");
    // rebuild per-row weights from the seed spec
    const rows = [
      ...Array(24).fill({ w: 10000n, f: false }), ...Array(4).fill({ w: 10000n, f: true }),
      { w: 105000n, f: true }, { w: 150000n, f: true },
      ...Array(20).fill({ w: 10000n, f: false }), { w: 7000n, f: false }, { w: 0n, f: false },
      ...Array(5).fill({ w: 10000n, f: true }), ...Array(2).fill({ w: 10000n, f: false }),
      { w: 10000n, f: true },
    ].map((x) => ({ weightAtomic: x.w, failed: x.f }));
    expect(rows.length).toBe(60);
    const dw = dollarWeightedWilson(rows);
    expect(r.headline.dollar.rate).toBeCloseTo(dw.p, 12);
    expect(r.headline.dollar.effective_n).toBeCloseTo(dw.effectiveN, 9);
    expect(r.headline.dollar.lo).toBeCloseTo(dw.lo, 9);
    expect(r.headline.dollar.hi).toBeCloseTo(dw.hi, 9);
  });

  it("overcharge sensitivity uses the bigint quote/reference ratio", () => {
    const [s11, s20] = r.headline.sensitivity;
    expect(s11).toMatchObject({ min_ratio: "1.1", overcharge_kept: 1, overcharge_dropped: 1 });
    expect(s11!.count.failures).toBe(11);
    expect(s20).toMatchObject({ min_ratio: "2.0", overcharge_kept: 0, overcharge_dropped: 2 });
    expect(s20!.count.failures).toBe(10);
    expect(s20!.dollar_rate).toBeCloseTo(100000 / 822000, 12);
  });

  it("breakdowns by failure type, tier and category", () => {
    const nd = r.by_failure_type.find((x) => x.outcome === "non_delivery")!;
    expect(nd).toMatchObject({ n: 7, dollars_atomic: "70000", resolved_late: 1 });
    expect(nd.share_of_failures).toBeCloseTo(7 / 12, 12);
    expect(r.by_tier.map((t) => [t.key, t.n, t.failures])).toEqual([["tail", 30, 6], ["top", 30, 6]]);
    expect(r.by_category.map((t) => [t.key, t.n])).toEqual([["data", 30], ["inference", 29], ["unassigned", 1]]);
    expect(r.by_tier[1]!.count).toEqual({ n: 30, failures: 6, ...(({ p, lo, hi }) => ({ rate: p, lo, hi }))(wilsonInterval(6, 30)) });
  });

  it("top sellers requires at least 30 calls (30 in, 29 out)", () => {
    expect(r.top_sellers.map((s) => [s.domain, s.n])).toEqual([["big.example", 30]]);
  });

  it("stress summaries", () => {
    expect(r.stress.duplicate).toMatchObject({ intents: 3, intents_with_second_settlement: 2 });
    expect(r.stress.timeout).toEqual({ intents: 3, settled_despite_abort: 2, intents_with_retry: 1, second_settlement_on_retry: 1 });
  });

  it("chain proxy finds exactly the seeded duplicate run and overcharge spike", () => {
    const c = r.chain_proxy;
    expect(c.pay_tos).toBe(2);
    expect(c.transfers).toBe(21);
    expect(c.dust_transfers).toBe(2);
    expect(c.total_atomic).toBe("300000");
    expect(c.duplicate_proxy).toMatchObject({ runs: 1, count: 2, sum_atomic: "20000" });
    expect(c.duplicate_proxy.count_rate).toBeCloseTo(2 / 21, 12);
    expect(c.overcharge_proxy).toMatchObject({ count: 1, sum_atomic: "50000", excess_atomic: "40000" });
    expect(c.overcharge_proxy.dollar_rate).toBeCloseTo(50000 / 300000, 12);
    expect(c.per_pay_to.find((p) => p.pay_to === P1)).toMatchObject({ mode_atomic: "10000", over_mode: 1, duplicates: 2 });
    expect(c.per_pay_to.find((p) => p.pay_to === P2)).toMatchObject({ mode_atomic: "20000", over_mode: 0, duplicates: 0 });
    expect(c.caveat).toBe("delivery is invisible on-chain; these are floors");
  });

  it("telemetry per source", () => {
    expect(r.telemetry.map((t) => [t.source_id, t.n, t.failures, t.excluded, t.injection])).toEqual([["op-a", 10, 2, 1, 0], ["op-b", 6, 1, 0, 1]]);
    expect(r.telemetry[0]!.lo).toBe(wilsonInterval(2, 10).lo);
  });

  it("meta, probes and reproducibility", () => {
    expect(r.meta.calls_by_source).toEqual({ buy: 67, stress_duplicate: 3, stress_timeout: 4, chain_proxy: 21, telemetry: 17 });
    expect(r.meta.spend_atomic).toBe("915000");
    expect(r.meta.spend_usdc).toBe("0.915000");
    expect(r.meta.wallet_count).toBe(3);
    expect(r.meta.config_hashes).toEqual(["cfg-abc123"]);
    expect(r.probes).toMatchObject({ rounds: 2, probes: 3, overcharge: 1, payto_changed: 1, price_discrimination: 1 });
    expect(r.reproducibility.schema_version).toBe("1");
    expect(r.reproducibility.halts).toHaveLength(1);
    for (const name of r.reproducibility.query_names) expect(QUERY_NAMES).toContain(name);
    expect(r.queries_used.headline).toContain("buy_headline_counts");
    expect(r.queries_used.chain_proxy).toContain("chain_proxy_duplicate_runs");
  });

  it("window filtering excludes calls outside since/until", () => {
    const later = computeReport(seedDb(), { ...opts, sinceMs: NOW - 1000 });
    expect(later.headline.count.n).toBe(0);
    expect(later.chain_proxy.transfers).toBe(0);
  });
});

describe("helpers", () => {
  it("modeOf ties toward the lower value", () => {
    expect(modeOf([{ value: 5n, n: 2 }, { value: 3n, n: 2 }, { value: 9n, n: 1 }])).toBe(3n);
    expect(modeOf([])).toBeNull();
  });
  it("dollarRate with zero total is uninformative", () => {
    expect(dollarRate(0n, 0n, 0)).toMatchObject({ rate: 0, lo: 0, hi: 1, effective_n: 0 });
  });
});
