/**
 * Allocations a scheduled run adds next to the stratified plan (docs/PLAN.md "Schedule"):
 *  - candidate lane: one call per `queued` user candidate (src/discover/candidates.ts), only with CANDIDATE_BUYS_ENABLED=1;
 *  - expensive lane: config/expensive-sellers.yaml, each seller at its own per-call cap and at most
 *    `max_per_week` purchases in any 7 days, one call per run so they spread across runs.
 * Neither lane raises a cap: the run's per-run and per-seller caps and every global cap still apply before signing.
 */
import type { Db } from "../db/index.js";
import { usdToAtomic, type ExpensiveSeller } from "../config/index.js";
import type { PlanAllocation } from "./plan.js";
import { buyableResources } from "../audit/run.js";
import { clearTooExpensive, recordTooExpensive } from "./states.js";
import { MEASURED_SOURCES } from "../taxonomy.js";

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

/** One call per listed seller that is under its weekly frequency, on its cheapest resource within its own cap. */
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
    const pick = res.filter((r) => r.price <= cap).sort((a, b) => (a.price < b.price ? -1 : a.price > b.price ? 1 : a.resource_id - b.resource_id))[0];
    if (!pick) {
      out.skipped.push({ domain: e.domain, reason: res.length ? "every resource quotes above its own cap (recorded too_expensive)" : "no buyable resource" });
      continue;
    }
    out.allocations.push({ resourceId: pick.resource_id, sellerId: s.id, sellerDomain: pick.domain, url: pick.url, method: pick.method, inputJson: pick.input_json, tier: "expensive", category: "expensive", priceAtomic: pick.price, calls: 1, perCallCapAtomic: cap });
  }
  return out;
}
