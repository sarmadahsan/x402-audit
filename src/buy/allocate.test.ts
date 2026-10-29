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

const TIERS = NOW - 1; // every existing call predates the tiers
const opts = (budget: bigint, extra: Partial<Parameters<typeof buildCoveragePlan>[1]> = {}) => ({ network: NET, caps, budgetAtomic: budget, runBudgetAtomic: usdToAtomic(1), coverageShare: 0.7, seed: 1, now: NOW, tiersSince: TIERS, ...extra });

describe("buildCoveragePlan", () => {
  it("finish lane: closest to target first, at most 4 a run; admit lane takes zero-call sellers; maintenance at most 2", () => {
    const d = universe();
    const c = buildCoveragePlan(d, opts(usdToAtomic(1)));
    const callsBy = (id: number) => c.plan.allocations.filter((a) => a.sellerId === id).reduce((s, a) => s + a.calls, 0);
    const poolOf = (id: number) => c.plan.allocations.find((a) => a.sellerId === id)?.tier;
    expect([poolOf(3), callsBy(3)]).toEqual(["finish", 1]); // 29 -> 30
    expect([poolOf(2), callsBy(2)]).toEqual(["finish", 4]);
    expect([poolOf(1), callsBy(1)]).toEqual(["admit", 4]);
    expect([poolOf(7), callsBy(7)]).toEqual(["admit", 4]); // bought on its cheap endpoint
    expect(callsBy(6)).toBe(0); // nothing under the cap: breadth material
    expect(callsBy(8)).toBe(0); // never answered a probe
    expect([poolOf(4), callsBy(4)]).toEqual(["maintenance", 2]);
    // Finish allocations first (seller 3 is closest to 30), then admit, then maintenance.
    expect(c.plan.allocations[0]!.sellerId).toBe(3);
    expect(c.plan.allocations.at(-1)!.tier).toBe("maintenance");
    // Planned at quote x1.2, never the listing.
    const a = c.plan.allocations.find((x) => x.sellerId === 1)!;
    expect([a.priceAtomic, a.planAtomic]).toEqual([1000n, 1200n]);
    // Seller 2 rotates over its two cheap endpoints, never the 0.09 one.
    expect(c.plan.allocations.filter((x) => x.sellerId === 2).map((x) => x.resourceId).sort()).toEqual([20, 21]);
    expect(c.stats.sellersAllAboveCap).toBe(1);
  });

  it("new zero-call sellers get the 5-call target unless they matter", () => {
    const d = universe();
    // Seller 1 was first bought after the tiers began, with 3 calls: 2 to go to 5, so it is in the finish lane.
    for (let k = 0; k < 3; k++) call(d, { seller: 1, resource: 10, outcome: "ok", ts: NOW + k });
    const c = buildCoveragePlan(d, opts(usdToAtomic(1), { now: NOW + 10 }));
    const s1 = c.plan.allocations.filter((a) => a.sellerId === 1);
    expect(s1.reduce((n, a) => n + a.calls, 0)).toBe(2);
    expect(s1[0]!.reason).toMatch(/3 of 5 call/);
    // In demand: the same seller keeps the 30-call target and takes 4.
    const c2 = buildCoveragePlan(d, opts(usdToAtomic(1), { now: NOW + 10, demand: new Map([["s1.example", 7]]) }));
    expect(c2.plan.allocations.filter((a) => a.sellerId === 1).reduce((n, a) => n + a.calls, 0)).toBe(4);
  });

  it("no seller plans more than 15% of the run", () => {
    const d = universe();
    seller(d, 11, { prices: ["60000"], calls: 0, inflowUsd: 1_000_000 }); // top of the admit order by inflow
    const c = buildCoveragePlan(d, opts(usdToAtomic(1)));
    const s11 = c.plan.allocations.filter((a) => a.sellerId === 11).reduce((n, a) => n + (a.planAtomic ?? 0n) * BigInt(a.calls), 0n);
    expect(s11).toBe(144000n); // two calls at 0.072; a third would pass 0.15
  });

  it("backs off a resource whose last three attempts were not_paid or our_error, for 48 hours", () => {
    const d = universe();
    call(d, { seller: 2, resource: 20, outcome: "not_paid", ts: NOW - 3 * 3_600_000 });
    call(d, { seller: 2, resource: 20, outcome: "our_error", ts: NOW - 2 * 3_600_000 });
    call(d, { seller: 2, resource: 20, outcome: "not_paid", ts: NOW - 3_600_000 });
    expect([...resourceBackoffs(d, NOW).keys()]).toEqual([20]);
    expect(resourceBackoffs(d, NOW + 48 * 3_600_000).size).toBe(0);
    const c = buildCoveragePlan(d, opts(usdToAtomic(1)));
    expect(c.plan.allocations.some((a) => a.resourceId === 20)).toBe(false);
    expect(c.rows.find((r) => r.pool === "backoff")?.resourceId).toBe(20);
    expect(d.prepare("SELECT COUNT(*) n FROM resources WHERE id = 20").get()).toEqual({ n: 1 });
  });

  it("keeps too_expensive only for sellers with no endpoint at or under the cap", () => {
    const d = universe();
    d.prepare("INSERT INTO resource_states (resource_id, state, quoted_atomic, cap_atomic, basis, updated_at) VALUES (71, 'too_expensive', '5000000', '100000', 'probe', 0)").run();
    buildCoveragePlan(d, opts(usdToAtomic(1), { recordTooExpensive: true }));
    expect(listTooExpensive(d).map((r) => r.domain).sort()).toEqual(["s6.example", "s6.example"]);
  });

  it("writes one run_allocations row per allocation and back-off", () => {
    const d = universe();
    const c = buildCoveragePlan(d, opts(usdToAtomic(1)));
    const runId = Number(d.prepare("INSERT INTO runs (subcommand, args_json, config_hash, network, dry_run, started_at) VALUES ('buy run', '{}', 'x', ?, 1, ?)").run(NET, NOW).lastInsertRowid);
    writeRunAllocations(d, runId, rowsFromAllocations(c.plan.allocations), NOW);
    const got = d.prepare("SELECT pool, SUM(planned_calls) n FROM run_allocations WHERE run_id = ? GROUP BY pool ORDER BY pool").all(runId);
    expect(got).toEqual([
      { pool: "admit", n: c.stats.admitCalls },
      { pool: "finish", n: c.stats.finishCalls },
      { pool: "maintenance", n: c.stats.maintenanceCalls },
    ]);
  });

  it("projects the tiered targets and simulates the runs", () => {
    const d = universe();
    const p = projectCoverage(d, { network: NET, capAtomic: caps.perCallAtomic, now: NOW, coverageShare: 0.7, tiersSince: TIERS, scenarios: [{ label: "x", runAtomic: usdToAtomic(1), runsPerDay: 4, days: 3 }] });
    // Sellers 2 (20 to go) and 3 (1) keep 30; zero-call sellers 1 and 7 get 5 each.
    expect([p.sellersBelowTarget, p.fullTarget, p.admitTarget, p.callsToTargets]).toEqual([4, 2, 2, 31]);
    expect(p.scenarios[0]!.daysToAllTargets).toBe(2);
    expect(p.scenarios[0]!.atTargetByDay[0]).toBe(2);
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
