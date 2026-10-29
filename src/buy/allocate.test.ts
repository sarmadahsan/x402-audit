/**
 * Coverage-first allocation (docs/PLAN.md "Coverage-first allocation") and the weekly breadth lane.
 */
import { describe, expect, it } from "vitest";
import { openDb, type Db } from "../db/index.js";
import { usdToAtomic, type Caps } from "../config/index.js";
import { buildCoveragePlan, projectCoverage, resourceBackoffs, rowsFromAllocations, writeRunAllocations } from "./allocate.js";
import { breadthAllocations } from "./lanes.js";
import { listTooExpensive } from "./states.js";

const NET = "eip155:8453";
const NOW = Date.UTC(2026, 9, 29, 12, 0, 0);
const caps: Caps = {
  perCallAtomic: usdToAtomic(0.1),
  perSellerPerDayAtomic: usdToAtomic(20),
  perDayAtomic: usdToAtomic(100),
  totalAtomic: usdToAtomic(300),
  stressTotalAtomic: usdToAtomic(30),
  auditPerDayAtomic: usdToAtomic(5),
};

let n = 0;
function seller(d: Db, id: number, o: { prices: string[]; calls?: number; inflowUsd?: number; probe?: boolean }) {
  d.prepare("INSERT INTO sellers (id, domain, volume_30d_atomic, volume_30d_source, first_seen_at, last_seen_at) VALUES (?, ?, ?, 'chain', 0, 0)").run(id, `s${id}.example`, usdToAtomic(o.inflowUsd ?? 0).toString());
  o.prices.forEach((p, j) => {
    const rid = id * 10 + j;
    d.prepare("INSERT INTO resources (id, seller_id, url, source, network, scheme, declared_price_atomic, raw_json, first_seen_at, last_seen_at) VALUES (?, ?, ?, 'bazaar', ?, 'exact', ?, '{}', 0, 0)").run(rid, id, `https://s${id}.example/r${j}`, NET, p);
    if (o.probe !== false) d.prepare("INSERT INTO probes (resource_id, client_identity, ts, status, amount_atomic, network) VALUES (?, 'A', ?, 402, ?, ?)").run(rid, NOW - 3_600_000, p, NET);
  });
  for (let k = 0; k < (o.calls ?? 0); k++) call(d, { seller: id, resource: id * 10, outcome: "ok", ts: NOW - 10 * 86_400_000 + k });
}
function call(d: Db, o: { seller: number; resource: number; outcome: string; ts: number; source?: string; usd?: number }) {
  d.prepare("INSERT INTO calls (intent_id, source, resource_id, seller_id, ts, paid, amount_paid_atomic, request_json, outcome) VALUES (?, ?, ?, ?, ?, ?, ?, '{}', ?)").run(
    `i${++n}`, o.source ?? "buy", o.resource, o.seller, o.ts, o.outcome === "ok" ? 1 : 0, o.outcome === "ok" ? usdToAtomic(o.usd ?? 0.001).toString() : null, o.outcome,
  );
}

function universe(): Db {
  const d = openDb(":memory:");
  seller(d, 1, { prices: ["1000"], calls: 0 }); // new, cheapest
  seller(d, 2, { prices: ["1000", "1500", "90000"], calls: 10 });
  seller(d, 3, { prices: ["1000"], calls: 29 }); // one call to go
  seller(d, 4, { prices: ["1000"], calls: 40, inflowUsd: 50_000 });
  seller(d, 5, { prices: ["1000"], calls: 35, inflowUsd: 0 });
  seller(d, 6, { prices: ["300000", "200000"], calls: 3 }); // nothing under the cap
  seller(d, 7, { prices: ["1000", "5000000"], calls: 0 }); // one cheap, one too expensive
  seller(d, 8, { prices: ["1000"], calls: 0, probe: false }); // never answered a probe... but others did
  return d;
}

describe("buildCoveragePlan", () => {
  it("gives the coverage pool to sellers below 30, fewest first, at most 4 calls each, and maintenance at most 2", () => {
    const d = universe();
    const c = buildCoveragePlan(d, { network: NET, caps, budgetAtomic: usdToAtomic(1), coverageShare: 0.7, seed: 1, now: NOW });
    const callsBy = (id: number) => c.plan.allocations.filter((a) => a.sellerId === id).reduce((s, a) => s + a.calls, 0);
    expect(callsBy(1)).toBe(4);
    expect(callsBy(2)).toBe(4);
    expect(callsBy(3)).toBe(1); // capped at 30 - 29
    expect(callsBy(7)).toBe(4); // bought on its cheap endpoint
    expect(callsBy(6)).toBe(0); // breadth material
    expect(callsBy(4)).toBe(2);
    expect(callsBy(5)).toBe(2);
    // Seller 8 has no probe of its own, but the eligibility rule is per seller: it has none, so it is left out.
    expect(callsBy(8)).toBe(0);
    expect(c.plan.allocations.filter((a) => a.tier === "coverage").every((a) => a.priceAtomic <= caps.perCallAtomic)).toBe(true);
    // Seller 2 rotates over its two cheap endpoints (1000 and 1500), never the 0.09 one.
    const s2 = c.plan.allocations.filter((a) => a.sellerId === 2).map((a) => a.resourceId).sort();
    expect(s2).toEqual([20, 21]);
    expect(c.stats.sellersAllAboveCap).toBe(1);
    // Coverage allocations come first in plan order, fewest calls first.
    expect(c.plan.allocations[0]!.tier).toBe("coverage");
    expect(c.plan.allocations.at(-1)!.tier).toBe("maintenance");
  });

  it("spreads a thin budget one call per seller per pass", () => {
    const d = universe();
    const c = buildCoveragePlan(d, { network: NET, caps, budgetAtomic: 5000n, coverageShare: 0.7, seed: 1, now: NOW });
    // 3,500 atomic of coverage at 1,000 each: three sellers get one call each, nobody gets two.
    expect(c.stats.coverageCalls).toBe(3);
    expect(new Set(c.plan.allocations.filter((a) => a.tier === "coverage").map((a) => a.sellerId)).size).toBe(3);
    // What coverage could not place (500) rolls into maintenance with its own 1,500: two calls.
    expect(c.stats.maintenanceCalls).toBe(2);
    expect(c.plan.totalSpendAtomic).toBeLessThanOrEqual(5000n);
  });

  it("backs off a resource whose last three attempts were not_paid or our_error, for 48 hours", () => {
    const d = universe();
    call(d, { seller: 1, resource: 10, outcome: "not_paid", ts: NOW - 3 * 3_600_000 });
    call(d, { seller: 1, resource: 10, outcome: "our_error", ts: NOW - 2 * 3_600_000 });
    call(d, { seller: 1, resource: 10, outcome: "not_paid", ts: NOW - 3_600_000 });
    expect([...resourceBackoffs(d, NOW).keys()]).toEqual([10]);
    expect(resourceBackoffs(d, NOW + 48 * 3_600_000).size).toBe(0);
    const c = buildCoveragePlan(d, { network: NET, caps, budgetAtomic: usdToAtomic(1), coverageShare: 0.7, seed: 1, now: NOW });
    expect(c.plan.allocations.some((a) => a.resourceId === 10)).toBe(false);
    expect(c.rows.find((r) => r.pool === "backoff")?.resourceId).toBe(10);
    // The resource is never deleted.
    expect(d.prepare("SELECT COUNT(*) n FROM resources WHERE id = 10").get()).toEqual({ n: 1 });
  });

  it("keeps too_expensive only for sellers with no endpoint at or under the cap", () => {
    const d = universe();
    d.prepare("INSERT INTO resource_states (resource_id, state, quoted_atomic, cap_atomic, basis, updated_at) VALUES (71, 'too_expensive', '5000000', '100000', 'probe', 0)").run();
    buildCoveragePlan(d, { network: NET, caps, budgetAtomic: usdToAtomic(1), coverageShare: 0.7, seed: 1, now: NOW, recordTooExpensive: true });
    expect(listTooExpensive(d).map((r) => r.domain).sort()).toEqual(["s6.example", "s6.example"]);
  });

  it("writes one run_allocations row per allocation and back-off", () => {
    const d = universe();
    const c = buildCoveragePlan(d, { network: NET, caps, budgetAtomic: usdToAtomic(1), coverageShare: 0.7, seed: 1, now: NOW });
    const runId = Number(d.prepare("INSERT INTO runs (subcommand, args_json, config_hash, network, dry_run, started_at) VALUES ('buy run', '{}', 'x', ?, 1, ?)").run(NET, NOW).lastInsertRowid);
    const rows = rowsFromAllocations(c.plan.allocations);
    writeRunAllocations(d, runId, rows, NOW);
    const got = d.prepare("SELECT pool, SUM(planned_calls) n FROM run_allocations WHERE run_id = ? GROUP BY pool ORDER BY pool").all(runId);
    expect(got).toEqual([
      { pool: "coverage", n: c.stats.coverageCalls },
      { pool: "maintenance", n: c.stats.maintenanceCalls },
    ]);
    expect((d.prepare("SELECT reason FROM run_allocations WHERE pool = 'coverage' LIMIT 1").get() as { reason: string }).reason).toMatch(/to go/);
  });

  it("projects the USDC and runs to bring every seller to 30", () => {
    const d = universe();
    const p = projectCoverage(d, { network: NET, capAtomic: caps.perCallAtomic, now: NOW, runAtomic: usdToAtomic(1), dailyAtomic: usdToAtomic(4), coverageShare: 0.7 });
    // Sellers 1, 7 (30 each), 2 (20), 3 (1) at 0.001.
    expect(p.sellersBelow).toBe(4);
    expect(p.callsToTarget).toBe(81);
    expect(p.usdcToTarget).toBe("0.081000");
    expect(p.runsAtCurrentCap).toBe(8); // 30 calls at 4 per run
    expect(p.exceedsSevenDays).toBe(false);
  });
});

describe("breadthAllocations", () => {
  it("one call per seller with nothing under the scheduled cap, by inflow, under the weekly budget", () => {
    const d = universe();
    seller(d, 9, { prices: ["400000"], calls: 0, inflowUsd: 9_000 });
    seller(d, 10, { prices: ["700000"], calls: 0, inflowUsd: 99_000 }); // above the breadth cap
    const r = breadthAllocations(d, { network: NET, now: NOW, scheduledCapAtomic: caps.perCallAtomic, breadthCapAtomic: usdToAtomic(0.5), weeklyBudgetAtomic: usdToAtomic(0.5), recordTooExpensive: true });
    expect(r.universe).toBe(3);
    expect(r.allocations.map((a) => [a.sellerDomain, a.priceAtomic, a.calls])).toEqual([["s9.example", 400000n, 1]]);
    expect(r.skipped.map((s) => s.domain)).toEqual(["s10.example", "s6.example"]); // s6's 0.20 no longer fits 0.10 left
    expect(r.allocations[0]!.perCallCapAtomic).toBe(usdToAtomic(0.5));
    expect(listTooExpensive(d).some((x) => x.domain === "s10.example")).toBe(true);
    // Breadth spend this week counts against the weekly budget.
    call(d, { seller: 9, resource: 90, outcome: "ok", ts: NOW - 86_400_000, source: "breadth", usd: 0.4 });
    const again = breadthAllocations(d, { network: NET, now: NOW, scheduledCapAtomic: caps.perCallAtomic, breadthCapAtomic: usdToAtomic(0.5), weeklyBudgetAtomic: usdToAtomic(0.5) });
    expect(again.remainingAtomic).toBe(usdToAtomic(0.1));
    expect(again.allocations).toEqual([]);
  });
});
