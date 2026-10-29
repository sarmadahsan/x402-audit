/**
 * Allocations a scheduled run adds next to the stratified plan (docs/PLAN.md "Schedule"):
 *  - candidate lane: one call per `queued` user candidate (src/discover/candidates.ts), only with CANDIDATE_BUYS_ENABLED=1;
 *  - breadth lane (weekly, its own command): sellers with no resource under the scheduled cap, see breadthAllocations;
 *  - expensive lane: config/expensive-sellers.yaml, each seller at its own per-call cap and at most
 *    `max_per_week` purchases in any 7 days, one call per run so they spread across runs.
 * Neither lane raises a cap: the run's per-run and per-seller caps and every global cap still apply before signing.
 */
import type { Db } from "../db/index.js";
import { atomicToUsd, usdToAtomic, type ExcludeConfig, type ExpensiveSeller } from "../config/index.js";
import type { PlanAllocation } from "./plan.js";
import { buyableResources } from "../audit/run.js";
import { clearTooExpensive, recordTooExpensive } from "./states.js";
import { CALL_SOURCES, MEASURED_SOURCES } from "../taxonomy.js";
import { sellerUniverse, type AllocationRow } from "./allocate.js";
import { spentAtomic } from "./guard.js";

const WEEK_MS = 7 * 24 * 3_600_000;

export function candidateAllocations(db: Db, o: { perCallCapAtomic: bigint; network: string }): PlanAllocation[] {
  const rows = db
    .prepare(
      `SELECT k.resource_id, r.seller_id, s.domain, r.url, r.method, r.input_json, r.declared_price_atomic price
       FROM candidates k JOIN resources r ON r.id = k.resource_id JOIN sellers s ON s.id = r.seller_id
       WHERE k.state = 'queued' AND s.excluded = 0 AND r.network = ? AND r.declared_price_atomic GLOB '[0-9]*'
       ORDER BY k.checks + k.payments DESC, k.id`,
    )
    .all(o.network) as { resource_id: number; seller_id: number; domain: string; url: string; method: string; input_json: string | null; price: string }[];
  return rows
    .filter((r) => BigInt(r.price) <= o.perCallCapAtomic)
    .map((r) => ({ resourceId: r.resource_id, sellerId: r.seller_id, sellerDomain: r.domain, url: r.url, method: r.method, inputJson: r.input_json, tier: "candidate" as const, category: "candidate", priceAtomic: BigInt(r.price), calls: 1 }));
}

export interface ExpensiveLaneResult {
  allocations: PlanAllocation[];
  skipped: { domain: string; reason: string }[];
}

/** One call per listed seller that is under its weekly frequency, on its cheapest resource above the scheduled cap and
 * within its own cap. */
export function expensiveAllocations(db: Db, list: readonly ExpensiveSeller[], o: { network: string; now: number; scheduledCapAtomic: bigint }): ExpensiveLaneResult {
  const out: ExpensiveLaneResult = { allocations: [], skipped: [] };
  const findSeller = db.prepare<[string], { id: number; excluded: number }>("SELECT id, excluded FROM sellers WHERE domain = ?");
  // The weekly frequency counts this seller's paid calls above the scheduled cap (the purchases this list exists for).
  const recent = db.prepare(
    `SELECT COUNT(*) n FROM calls WHERE seller_id = ? AND paid = 1 AND ts >= ? AND source IN (${MEASURED_SOURCES.map(() => "?").join(",")})
       AND amount_paid_atomic GLOB '[0-9]*' AND CAST(amount_paid_atomic AS INTEGER) > ?`,
  );
  for (const e of list) {
    const s = findSeller.get(e.domain.toLowerCase());
    if (!s) {
      out.skipped.push({ domain: e.domain, reason: "not in the database" });
      continue;
    }
    if (s.excluded) {
      out.skipped.push({ domain: e.domain, reason: "excluded" });
      continue;
    }
    const n = (recent.get(s.id, o.now - WEEK_MS, ...MEASURED_SOURCES, o.scheduledCapAtomic.toString()) as { n: number }).n;
    if (n >= e.max_per_week) {
      out.skipped.push({ domain: e.domain, reason: `${n} purchase(s) above the scheduled cap in the last 7 days; at most ${e.max_per_week}` });
      continue;
    }
    const cap = usdToAtomic(e.per_call_usd);
    const res = buyableResources(db, s.id, o.network);
    for (const r of res) {
      if (r.price > cap) recordTooExpensive(db, { resourceId: r.resource_id, quotedAtomic: r.price, capAtomic: cap, basis: r.basis, now: o.now });
      else clearTooExpensive(db, r.resource_id);
    }
    // Only the resources this list exists for: above the scheduled cap (cheaper ones are in the stratified plan).
    const pick = res
      .filter((r) => r.price > o.scheduledCapAtomic && r.price <= cap)
      .sort((a, b) => (a.price < b.price ? -1 : a.price > b.price ? 1 : a.resource_id - b.resource_id))[0];
    if (!pick) {
      const above = res.filter((r) => r.price > o.scheduledCapAtomic);
      out.skipped.push({
        domain: e.domain,
        reason: !res.length ? "no buyable resource" : !above.length ? "no resource above the scheduled cap" : "every resource above the scheduled cap quotes above its own cap (recorded too_expensive)",
      });
      continue;
    }
    out.allocations.push({ resourceId: pick.resource_id, sellerId: s.id, sellerDomain: pick.domain, url: pick.url, method: pick.method, inputJson: pick.input_json, tier: "expensive", category: "expensive", priceAtomic: pick.price, calls: 1, perCallCapAtomic: cap });
  }
  return out;
}

export interface BreadthLaneResult {
  allocations: PlanAllocation[];
  rows: AllocationRow[];
  skipped: { domain: string; reason: string }[];
  /** BREADTH_WEEKLY_USD minus breadth spend in the last 7 days. */
  remainingAtomic: bigint;
  /** Sellers with every resource above the scheduled cap (the breadth universe). */
  universe: number;
}

/**
 * Weekly breadth run (docs/PLAN.md "Breadth run"): one call per seller that has no resource at or under the scheduled
 * per-call cap, on its cheapest resource at or under the breadth cap, ordered by 30-day inflow descending then fewest
 * calls, until the week's breadth budget is used. Sellers on config/expensive-sellers.yaml have their own lane.
 * A resource above the breadth cap stays too_expensive (recorded when `recordTooExpensive`).
 */
export function breadthAllocations(
  db: Db,
  o: { network: string; now: number; scheduledCapAtomic: bigint; breadthCapAtomic: bigint; weeklyBudgetAtomic: bigint; exclude?: ExcludeConfig; skipDomains?: readonly string[]; recordTooExpensive?: boolean },
): BreadthLaneResult {
  const uni = sellerUniverse(db, { network: o.network, capAtomic: o.scheduledCapAtomic, now: o.now, ...(o.exclude ? { exclude: o.exclude } : {}) }).filter((s) => s.eligible.length === 0 && s.over.length > 0);
  const skip = new Set((o.skipDomains ?? []).map((d) => d.toLowerCase()));
  const spent = spentAtomic(db, { since: o.now - WEEK_MS, sources: [CALL_SOURCES.BREADTH] });
  const recent = db.prepare(`SELECT 1 FROM calls WHERE seller_id = ? AND source = '${CALL_SOURCES.BREADTH}' AND ts >= ? LIMIT 1`);
  const out: BreadthLaneResult = { allocations: [], rows: [], skipped: [], remainingAtomic: o.weeklyBudgetAtomic > spent ? o.weeklyBudgetAtomic - spent : 0n, universe: uni.length };
  uni.sort((a, b) => (a.inflowAtomic > b.inflowAtomic ? -1 : a.inflowAtomic < b.inflowAtomic ? 1 : 0) || a.calls - b.calls || a.sellerId - b.sellerId);
  let left = out.remainingAtomic;
  uni.forEach((s, rank) => {
    if (o.recordTooExpensive) for (const r of s.over) if (r.priceAtomic > o.breadthCapAtomic) recordTooExpensive(db, { resourceId: r.resourceId, quotedAtomic: r.priceAtomic, capAtomic: o.breadthCapAtomic, basis: r.basis === "modal" ? "quote" : r.basis, now: o.now });
    if (skip.has(s.domain.toLowerCase())) return void out.skipped.push({ domain: s.domain, reason: "on config/expensive-sellers.yaml (own lane)" });
    const pick = s.over.find((r) => r.priceAtomic <= o.breadthCapAtomic);
    if (!pick) return void out.skipped.push({ domain: s.domain, reason: `every resource quotes above the breadth cap ${atomicToUsd(o.breadthCapAtomic)} USDC (too_expensive)` });
    if (recent.get(s.sellerId, o.now - 6 * 24 * 3_600_000)) return void out.skipped.push({ domain: s.domain, reason: "breadth purchase in the last 6 days" });
    if (pick.priceAtomic > left) return void out.skipped.push({ domain: s.domain, reason: `weekly breadth budget has ${atomicToUsd(left)} USDC left` });
    left -= pick.priceAtomic;
    const reason = `no resource at or under ${atomicToUsd(o.scheduledCapAtomic)} USDC; ${s.calls} denominator call(s); 30-day inflow ${atomicToUsd(s.inflowAtomic)} USDC; breadth rank ${rank + 1} of ${uni.length}`;
    out.allocations.push({ resourceId: pick.resourceId, sellerId: s.sellerId, sellerDomain: s.domain, url: pick.url, method: pick.method, inputJson: pick.inputJson, tier: "breadth", category: s.category, priceAtomic: pick.priceAtomic, calls: 1, perCallCapAtomic: o.breadthCapAtomic, reason });
    out.rows.push({ sellerId: s.sellerId, resourceId: pick.resourceId, pool: "breadth", plannedCalls: 1, reason, priceAtomic: pick.priceAtomic });
  });
  return out;
}
