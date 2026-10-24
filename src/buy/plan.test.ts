import { describe, expect, it } from "vitest";
import { openDb, type Db } from "../db/index.js";
import { usdToAtomic, type Caps, type SampleConfig } from "../config/index.js";
import { apportion, assertPlanWithinCaps, buildBuyPlan, renderPlan, seededRandom } from "./plan.js";
import { checkCaps, spentAtomic, utcDayStart } from "./guard.js";
import { modalAtomic, referencePriceFor } from "./reference.js";

const NET = "eip155:8453";
const caps: Caps = {
  perCallAtomic: usdToAtomic(0.5),
  perSellerPerDayAtomic: usdToAtomic(20),
  perDayAtomic: usdToAtomic(100),
  totalAtomic: usdToAtomic(300),
  stressTotalAtomic: usdToAtomic(30),
};
const sample: SampleConfig = {
  target_calls: 200,
  max_total_usd: 300,
  tiers: { top: { size: 4, share: 0.5 }, tail: { size: 3, share: 0.5 } },
  categories: ["inference", "data", "other"],
  price_floor_usd: 0.001,
  max_share_per_resource: 0.6,
  seed: 7,
  min_seconds_between_calls_per_resource: 60,
};

function seed(): Db {
  const db = openDb(":memory:");
  const cats = ["inference", "data", "data", null, "inference", "data", "other", "data", "inference", "other"];
  for (let i = 1; i <= 10; i++) {
    db.prepare("INSERT INTO sellers (id, domain, category, rank_30d, first_seen_at, last_seen_at) VALUES (?, ?, ?, ?, 0, 0)").run(i, `s${i}.example`, cats[i - 1], i);
    for (const [j, price] of [
      [1, "1000"],
      [2, "50000"],
    ] as const) {
      db.prepare(
        "INSERT INTO resources (id, seller_id, url, source, network, scheme, declared_price_atomic, raw_json, first_seen_at, last_seen_at) VALUES (?, ?, ?, 'bazaar', ?, 'exact', ?, '{}', 0, 0)",
      ).run(i * 10 + j, i, `https://s${i}.example/r${j}`, NET, price);
    }
  }
  // Ineligible look-alikes on seller 1.
  const ins = db.prepare(
    "INSERT INTO resources (id, seller_id, url, source, network, scheme, transfer_method, declared_price_atomic, raw_json, first_seen_at, last_seen_at) VALUES (?, 1, ?, 'bazaar', ?, ?, ?, ?, '{}', 0, 0)",
  );
  ins.run(901, "https://s1.example/permit2", NET, "exact", "permit2", "1000");
  ins.run(902, "https://s1.example/sepolia", "eip155:84532", "exact", null, "1000");
  ins.run(903, "https://s1.example/upto", NET, "upto", null, "1000");
  ins.run(904, "https://s1.example/pricey", NET, "exact", null, "900000");
  ins.run(905, "https://s1.example/noprice", NET, "exact", null, null);
  return db;
}

describe("buildBuyPlan", () => {
  it("stratifies by tier x category, weights cheap resources, persists tiers, stays deterministic", () => {
    const db = seed();
    const plan = buildBuyPlan(db, { sample, caps, network: NET, now: 0 });
    const ids = new Set(plan.allocations.map((a) => a.resourceId));
    for (const bad of [901, 902, 903, 904, 905]) expect(ids.has(bad)).toBe(false);
    expect(plan.totalCalls).toBe(200);
    expect(plan.strata.filter((s) => s.tier === "top").reduce((n, s) => n + s.calls, 0)).toBe(100);
    const topSellers = plan.strata.filter((s) => s.tier === "top").flatMap((s) => s.sellers).sort();
    expect(topSellers).toEqual([1, 2, 3, 4]);
    const tailSellers = plan.strata.filter((s) => s.tier === "tail").flatMap((s) => s.sellers);
    expect(tailSellers).toHaveLength(3);
    expect(tailSellers.every((s) => s > 4)).toBe(true);
    // Seller 4 has category NULL -> other.
    expect(plan.strata.find((s) => s.tier === "top" && s.category === "other")?.sellers).toEqual([4]);
    // Cheap resources (r1, $0.001) get more calls than $0.05 ones, but no resource exceeds max_share of its stratum.
    for (const st of plan.strata) {
      const al = plan.allocations.filter((a) => st.resources.includes(a.resourceId));
      for (const a of al) expect(a.calls).toBeLessThanOrEqual(Math.max(1, Math.floor(sample.max_share_per_resource * st.targetCalls)));
      expect(st.plannedSpendAtomic).toBe(al.reduce((s, a) => s + a.priceAtomic * BigInt(a.calls), 0n));
    }
    expect(plan.totalSpendAtomic).toBe(plan.strata.reduce((s, x) => s + x.plannedSpendAtomic, 0n));
    expect(plan.notes.join("\n")).toMatch(/No probes/);
    const tiers = db.prepare("SELECT id, tier FROM sellers ORDER BY id").all() as { id: number; tier: string | null }[];
    expect(tiers.filter((t) => t.tier === "top").map((t) => t.id)).toEqual([1, 2, 3, 4]);
    expect(tiers.filter((t) => t.tier === "tail").map((t) => t.id).sort()).toEqual(tailSellers.slice().sort());
    // Same seed, same plan.
    expect(buildBuyPlan(seed(), { sample, caps, network: NET, now: 0 }).allocations).toEqual(plan.allocations);
    const md = renderPlan(plan);
    expect(md).toContain("| tier | category |");
    expect(md).toMatch(/\| \*\*total\*\* \|/);
    expect(md).toContain("$");
    assertPlanWithinCaps(plan, caps);
    expect(() => assertPlanWithinCaps(plan, { ...caps, totalAtomic: 1n })).toThrow(/MAX_TOTAL_USD/);
    expect(() => assertPlanWithinCaps({ ...plan, sampleMaxTotalAtomic: 1n }, caps)).toThrow(/max_total_usd/);
  });

  it("requires the seller to have a 402 probe once any probes exist (every eligible resource of that seller is then usable)", () => {
    const db = seed();
    db.prepare("INSERT INTO probes (resource_id, client_identity, ts, status) VALUES (11, 'A', 0, 402)").run();
    db.prepare("INSERT INTO probes (resource_id, client_identity, ts, status) VALUES (21, 'A', 0, 200)").run();
    const plan = buildBuyPlan(db, { sample, caps, network: NET, now: 0 });
    expect(plan.allocations.map((a) => a.resourceId).sort((a, b) => a - b)).toEqual([11, 12]);
    expect(plan.notes.join("\n")).toMatch(/Tier tail has no eligible sellers/);
    // Two resources, each capped at max_share_per_resource of the stratum, together cover the whole target.
    expect(plan.totalCalls).toBe(Math.min(200, 2 * Math.floor(sample.max_share_per_resource * 200)));
  });

  it("apportion and the PRNG are stable", () => {
    expect(apportion(10, [1, 1, 1])).toEqual([4, 3, 3]);
    expect(apportion(0, [1])).toEqual([0]);
    const r = seededRandom(1);
    const a = [r(), r()];
    const r2 = seededRandom(1);
    expect([r2(), r2()]).toEqual(a);
  });
});

describe("reference price and spend accounting", () => {
  it("bazaar > modal_7d > first_seen", () => {
    const db = seed();
    expect(referencePriceFor(db, 11, 0)).toEqual({ amountAtomic: "1000", source: "bazaar" });
    db.prepare("UPDATE resources SET declared_price_atomic = NULL WHERE id = 11").run();
    expect(referencePriceFor(db, 11, 0)).toBeUndefined();
    const now = 10 * 24 * 3600_000;
    db.prepare("INSERT INTO probes (resource_id, client_identity, ts, amount_atomic) VALUES (11, 'A', 0, '7')").run();
    expect(referencePriceFor(db, 11, now)).toEqual({ amountAtomic: "7", source: "first_seen" });
    for (const a of ["5", "5", "9"]) db.prepare("INSERT INTO probes (resource_id, client_identity, ts, amount_atomic) VALUES (11, 'A', ?, ?)").run(now - 1000, a);
    expect(referencePriceFor(db, 11, now)).toEqual({ amountAtomic: "5", source: "modal_7d" });
    expect(modalAtomic(["3", "2", "3", "2"])).toBe("2");
  });

  it("counts paid calls plus signed attempts with no calls row; checks every cap", () => {
    const db = seed();
    const now = Date.UTC(2026, 9, 23, 12);
    const call = (id: number, seller: number, amount: string, ts: number, source = "buy", nonce = `0x${id}`) =>
      db
        .prepare("INSERT INTO calls (intent_id, source, resource_id, seller_id, ts, paid, amount_paid_atomic, request_json, nonce) VALUES (?, ?, ?, ?, ?, 1, ?, '{}', ?)")
        .run(`i${id}`, source, seller * 10 + 1, seller, ts, amount, nonce);
    call(1, 1, "100000", now);
    call(2, 1, "100000", now - 2 * 24 * 3600_000); // yesterday-ish
    call(3, 2, "50000", now, "stress_duplicate");
    // Crash after signing: attempt row exists, calls row does not.
    db.prepare("INSERT INTO attempts (intent_id, source, ts, resource_id, wallet, pay_to, network, asset, amount_atomic, nonce, phase) VALUES ('i9', 'buy', ?, 11, 'w', 'p', ?, 'a', '30000', '0xdead', 'signed')").run(now, NET);
    expect(spentAtomic(db)).toBe(280000n);
    expect(spentAtomic(db, { since: utcDayStart(now) })).toBe(180000n);
    expect(spentAtomic(db, { since: utcDayStart(now), sellerId: 1 })).toBe(130000n);
    expect(spentAtomic(db, { sources: ["buy"] })).toBe(230000n);
    const c = (over: Partial<Caps>, amount = 10000n, scope: "buy" | "stress" = "buy") => checkCaps(db, { caps: { ...caps, ...over }, sellerId: 1, amountAtomic: amount, now, scope })?.reason ?? null;
    expect(c({})).toBeNull();
    expect(c({ perSellerPerDayAtomic: 139999n })).toBe("cap_per_seller_per_day");
    expect(c({ perSellerPerDayAtomic: 140000n })).toBeNull();
    expect(c({ perDayAtomic: 189999n })).toBe("cap_per_day");
    expect(c({ totalAtomic: 239999n })).toBe("cap_total");
    expect(c({ stressTotalAtomic: 59999n }, 10000n, "stress")).toBe("cap_stress_total");
    expect(c({}, caps.perCallAtomic + 1n)).toBe("cap_per_call");
  });
});
