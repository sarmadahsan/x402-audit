/**
 * The candidate lane (docs/PLAN.md "Candidates"): one call per queued user candidate, most checked first, and the
 * per-seller limits that keep one seller with many queued URLs from reserving a run off the top.
 */
import { describe, expect, it } from "vitest";
import { openDb, type Db } from "../db/index.js";
import { usdToAtomic } from "../config/index.js";
import { candidateAllocations } from "./lanes.js";
import { BACKOFF_MS, resourceBackoffs } from "./allocate.js";

const NET = "eip155:8453";
const NOW = Date.UTC(2026, 10, 1, 0, 0, 0);

function seller(d: Db, id: number, prices: string[], o: { checks?: number[]; excluded?: boolean } = {}) {
  d.prepare("INSERT INTO sellers (id, domain, excluded, first_seen_at, last_seen_at) VALUES (?, ?, ?, 0, 0)").run(id, `s${id}.example`, o.excluded ? 1 : 0);
  prices.forEach((p, j) => {
    const rid = id * 100 + j;
    d.prepare("INSERT INTO resources (id, seller_id, url, source, network, scheme, declared_price_atomic, raw_json, first_seen_at, last_seen_at) VALUES (?, ?, ?, 'user', ?, 'exact', ?, '{}', 0, 0)").run(rid, id, `https://s${id}.example/r${j}`, NET, p);
    d.prepare("INSERT INTO candidates (url, host, checks, payments, imported_at, seller_id, resource_id, state) VALUES (?, ?, ?, 0, 0, ?, ?, 'queued')").run(`https://s${id}.example/r${j}`, `s${id}.example`, o.checks?.[j] ?? 1, id, rid);
  });
}
let n = 0;
function call(d: Db, seller: number, resource: number, outcome: string, ts: number) {
  d.prepare("INSERT INTO calls (intent_id, source, resource_id, seller_id, ts, paid, amount_paid_atomic, request_json, outcome) VALUES (?, 'buy', ?, ?, ?, 0, NULL, '{}', ?)").run(`i${++n}`, resource, seller, ts, outcome);
}

const base = { perCallCapAtomic: usdToAtomic(0.1), network: NET };

describe("candidateAllocations", () => {
  it("without limits plans one call per queued candidate, most checked first", () => {
    const d = openDb(":memory:");
    seller(d, 1, ["100000", "50000", "100000"], { checks: [1, 5, 2] });
    const r = candidateAllocations(d, base);
    expect(r.allocations.map((a) => a.resourceId)).toEqual([101, 102, 100]);
    expect(r.deferred).toEqual([]);
  });

  it("a seller with many queued URLs gets at most its run share; the rest stay queued with a reason", () => {
    const d = openDb(":memory:");
    // 19 URLs at 0.10, like run 177: planned at 0.12 each, a 0.30 share allows two.
    seller(d, 1, Array.from({ length: 19 }, () => "100000"));
    seller(d, 2, ["1000", "1000"]);
    const r = candidateAllocations(d, { ...base, sellerCapAtomic: usdToAtomic(0.3) });
    const bySeller = (id: number) => r.allocations.filter((a) => a.sellerId === id);
    expect(bySeller(1)).toHaveLength(2);
    expect(bySeller(2)).toHaveLength(2);
    const planned = bySeller(1).reduce((s, a) => s + a.priceAtomic, 0n);
    expect(planned).toBe(usdToAtomic(0.2));
    expect(r.deferred).toHaveLength(17);
    expect(r.deferred[0]!.reason).toMatch(/run share 0\.30/);
    // Every deferred row is still queued for the next run.
    expect((d.prepare("SELECT COUNT(*) n FROM candidates WHERE state = 'queued'").get() as { n: number }).n).toBe(21);
  });

  it("caps calls per seller at the coverage ceiling even when the money would allow more", () => {
    const d = openDb(":memory:");
    seller(d, 1, Array.from({ length: 6 }, () => "1000"));
    const r = candidateAllocations(d, { ...base, sellerCapAtomic: usdToAtomic(0.3) });
    expect(r.allocations).toHaveLength(4);
    expect(r.deferred.map((x) => x.reason)).toEqual(Array(2).fill("seller already has 4 call(s) this run (max 4)"));
    expect(candidateAllocations(d, { ...base, maxPerSeller: 1 }).allocations).toHaveLength(1);
  });

  it("leaves a resource in back-off queued and keeps the lane's other rules", () => {
    const d = openDb(":memory:");
    seller(d, 1, ["1000", "1000"], { checks: [9, 1] });
    seller(d, 2, ["1000"], { excluded: true });
    seller(d, 3, ["500000"]); // above the per-call cap: the importer's too_expensive, not this lane's
    for (let k = 0; k < 3; k++) call(d, 1, 100, "not_paid", NOW - 3_600_000 - k);
    const backoffs = resourceBackoffs(d, NOW);
    expect(backoffs.get(100)?.until).toBe(NOW - 3_600_000 + BACKOFF_MS);
    const r = candidateAllocations(d, { ...base, backoffs });
    expect(r.allocations.map((a) => a.resourceId)).toEqual([101]);
    expect(r.deferred).toHaveLength(1);
    expect(r.deferred[0]).toMatchObject({ url: "https://s1.example/r0" });
    expect(r.deferred[0]!.reason).toMatch(/in back-off until .* \(not_paid, not_paid, not_paid\)/);
  });
});
