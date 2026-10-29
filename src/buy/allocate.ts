/**
 * Coverage-first allocation for scheduled runs (docs/PLAN.md "Coverage-first allocation", 2026-10-29).
 *
 * The per-run random draw kept landing on sellers we already knew. This planner splits a run's budget into two pools:
 *  - coverage (COVERAGE_SHARE of the budget, default 0.7): sellers below SELLER_MIN_CALLS (30) denominator calls,
 *    fewest calls first, ties seeded-random, at most 4 calls per seller per run spread over its eligible resources,
 *    so a seller reaches 30 across several runs and times of day;
 *  - maintenance (the rest): sellers at 30 or more, drawn by 30-day on-chain inflow with a floor so the tail keeps
 *    being sampled, at most 2 calls per seller per run.
 * A seller is eligible while it has one resource whose price (latest probe quote, else modal quote over the last 7 days,
 * else listing) is at or under the scheduled per-call cap; the cheapest ones are used first, rotating across runs.
 * A resource whose last three attempts were not_paid or our_error sits out 48 hours (logged; never deleted).
 * Every allocation and back-off becomes a run_allocations row before any signature (writeRunAllocations).
 * No cap is touched here: every cap is still checked from the database before every signature (guard.ts).
 */
import type { Db } from "../db/index.js";
import { atomicToUsd, isExcluded, usdToAtomic, type Caps, type ExcludeConfig } from "../config/index.js";
import { MEASURED_SOURCES, OUTCOMES, PAID_DENOMINATOR_OUTCOMES, FLAGS } from "../taxonomy.js";
import { seededRandom, type BuyPlan, type PlanAllocation } from "./plan.js";
import { clearTooExpensive, recordTooExpensive } from "./states.js";

export const SELLER_TARGET_CALLS = 30;
export const COVERAGE_MAX_PER_SELLER = 4;
export const MAINTENANCE_MAX_PER_SELLER = 2;
export const BACKOFF_MS = 48 * 3_600_000;
const BACKOFF_OUTCOMES = new Set<string>([OUTCOMES.NOT_PAID, OUTCOMES.OUR_ERROR]);
const WEEK_MS = 7 * 24 * 3_600_000;

const sqlList = (xs: Iterable<string>) => [...xs].map((x) => `'${x.replace(/'/g, "''")}'`).join(", ");
const MEASURED_LIST = sqlList(MEASURED_SOURCES);
const DENOM_LIST = sqlList(PAID_DENOMINATOR_OUTCOMES);
const TEMPLATED = /\/:[A-Za-z_]+|\{[^}]+\}/;

export type PriceBasis = "probe" | "modal" | "declared";

export interface PricedResource {
  resourceId: number;
  sellerId: number;
  domain: string;
  url: string;
  method: string;
  inputJson: string | null;
  priceAtomic: bigint;
  basis: PriceBasis;
}

export interface SellerFacts {
  sellerId: number;
  domain: string;
  category: string;
  /** Denominator calls in the seller's own measured series (scheduled, breadth and audit). */
  calls: number;
  /** Every measured attempt to the seller, any outcome (drives the resource rotation). */
  attempts: number;
  inflowAtomic: bigint;
  /** Resources at or under the cap, not in back-off, cheapest first. */
  eligible: PricedResource[];
  /** Resources above the cap. */
  over: PricedResource[];
}

export interface Backoff {
  resourceId: number;
  sellerId: number;
  url: string;
  until: number;
  outcomes: string[];
}

/** Count of a seller's denominator calls per seller id, over the measured sources (what SELLER_MIN_CALLS counts). */
export function sellerDenominatorCalls(db: Db, until?: number): Map<number, number> {
  const rows = db
    .prepare(
      `SELECT seller_id, COUNT(*) n FROM calls
       WHERE source IN (${MEASURED_LIST}) AND outcome IN (${DENOM_LIST}) AND instr(flags_json, '"${FLAGS.UNPAID_OVERCHARGE}"') = 0
         ${until !== undefined ? "AND ts <= ?" : ""}
       GROUP BY seller_id`,
    )
    .all(...(until !== undefined ? [until] : [])) as { seller_id: number; n: number }[];
  return new Map(rows.map((r) => [r.seller_id, r.n]));
}

/** Resources whose last three measured attempts were all not_paid or our_error, with the back-off end. */
export function resourceBackoffs(db: Db, now: number): Map<number, Backoff> {
  const rows = db
    .prepare(
      `SELECT x.resource_id, x.seller_id, x.outcome, x.ts, r.url FROM (
         SELECT resource_id, seller_id, outcome, ts, ROW_NUMBER() OVER (PARTITION BY resource_id ORDER BY ts DESC, id DESC) rn
         FROM calls WHERE source IN (${MEASURED_LIST}) AND outcome IS NOT NULL
       ) x JOIN resources r ON r.id = x.resource_id WHERE x.rn <= 3 ORDER BY x.resource_id, x.rn`,
    )
    .all() as { resource_id: number; seller_id: number; outcome: string; ts: number; url: string }[];
  const by = new Map<number, typeof rows>();
  for (const r of rows) {
    const l = by.get(r.resource_id);
    if (l) l.push(r);
    else by.set(r.resource_id, [r]);
  }
  const out = new Map<number, Backoff>();
  for (const [id, l] of by) {
    if (l.length < 3 || !l.every((r) => BACKOFF_OUTCOMES.has(r.outcome))) continue;
    const until = l[0]!.ts + BACKOFF_MS;
    if (until > now) out.set(id, { resourceId: id, sellerId: l[0]!.seller_id, url: l[0]!.url, until, outcomes: l.map((r) => r.outcome) });
  }
  return out;
}

export interface SellerUniverseOptions {
  network: string;
  capAtomic: bigint;
  now: number;
  exclude?: ExcludeConfig;
  /** Resources in back-off are left out of `eligible` (default: computed here). */
  backoffs?: Map<number, Backoff>;
}

/**
 * Every buyable seller with its priced resources split at the cap. The same filters as the stratified plan
 * (Base exact, EIP-3009, not excluded, not a path template, not a user candidate, the seller answered a 402 probe).
 */
export function sellerUniverse(db: Db, o: SellerUniverseOptions): SellerFacts[] {
  const requireProbe = (db.prepare("SELECT 1 FROM probes LIMIT 1").get() as unknown) !== undefined;
  const rows = db
    .prepare(
      `SELECT r.id resource_id, r.seller_id, s.domain, r.url, r.method, r.input_json, r.declared_price_atomic declared,
              COALESCE(s.category, 'other') category, s.volume_30d_atomic vol, s.volume_30d_source vol_src
       FROM resources r JOIN sellers s ON s.id = r.seller_id
       WHERE r.network = ? AND r.scheme = 'exact' AND COALESCE(r.transfer_method, 'eip3009') != 'permit2'
         AND s.excluded = 0 AND r.source != 'user'
         ${requireProbe ? "AND EXISTS (SELECT 1 FROM probes p JOIN resources pr ON pr.id = p.resource_id WHERE pr.seller_id = r.seller_id AND p.status = 402)" : ""}
       ORDER BY r.seller_id, r.id`,
    )
    .all(o.network) as { resource_id: number; seller_id: number; domain: string; url: string; method: string; input_json: string | null; declared: string | null; category: string; vol: string | null; vol_src: string | null }[];
  // Latest 402 quote per resource, and the modal paid quote over the last 7 days.
  const probe = new Map(
    (db
      .prepare(
        `SELECT p.resource_id, p.amount_atomic a FROM probes p
         WHERE p.id IN (SELECT MAX(id) FROM probes WHERE status = 402 AND amount_atomic IS NOT NULL GROUP BY resource_id)`,
      )
      .all() as { resource_id: number; a: string }[]).filter((r) => /^\d+$/.test(r.a)).map((r) => [r.resource_id, BigInt(r.a)]),
  );
  const modal = new Map<number, bigint>();
  const best = new Map<number, number>();
  for (const r of db
    .prepare(
      `SELECT resource_id, quote_amount_atomic q, COUNT(*) n FROM calls
       WHERE ts >= ? AND quote_amount_atomic GLOB '[0-9]*' AND quote_amount_atomic NOT GLOB '*[^0-9]*'
       GROUP BY resource_id, quote_amount_atomic`,
    )
    .all(o.now - WEEK_MS) as { resource_id: number; q: string; n: number }[]) {
    const v = BigInt(r.q);
    const b = best.get(r.resource_id);
    if (b === undefined || r.n > b || (r.n === b && v < modal.get(r.resource_id)!)) {
      best.set(r.resource_id, r.n);
      modal.set(r.resource_id, v);
    }
  }
  const denom = sellerDenominatorCalls(db);
  const attempts = new Map((db.prepare(`SELECT seller_id, COUNT(*) n FROM calls WHERE source IN (${MEASURED_LIST}) GROUP BY seller_id`).all() as { seller_id: number; n: number }[]).map((r) => [r.seller_id, r.n]));
  const backoffs = o.backoffs ?? resourceBackoffs(db, o.now);

  const sellers = new Map<number, SellerFacts>();
  for (const r of rows) {
    if (TEMPLATED.test(r.url)) continue; // cannot be fetched literally
    if (o.exclude && isExcluded(o.exclude, r.domain, r.url)) continue;
    const p = probe.get(r.resource_id);
    const m = modal.get(r.resource_id);
    const d = r.declared && /^\d+$/.test(r.declared) ? BigInt(r.declared) : undefined;
    const price = p ?? m ?? d;
    if (price === undefined) continue;
    let s = sellers.get(r.seller_id);
    if (!s) {
      const inflow = r.vol_src === "chain" && r.vol && /^\d+$/.test(r.vol) ? BigInt(r.vol) : 0n;
      s = { sellerId: r.seller_id, domain: r.domain, category: r.category, calls: denom.get(r.seller_id) ?? 0, attempts: attempts.get(r.seller_id) ?? 0, inflowAtomic: inflow, eligible: [], over: [] };
      sellers.set(r.seller_id, s);
    }
    const pr: PricedResource = { resourceId: r.resource_id, sellerId: r.seller_id, domain: r.domain, url: r.url, method: r.method, inputJson: r.input_json, priceAtomic: price, basis: p !== undefined ? "probe" : m !== undefined ? "modal" : "declared" };
    if (price > o.capAtomic) s.over.push(pr);
    else if (!backoffs.has(r.resource_id)) s.eligible.push(pr);
  }
  const byPrice = (a: PricedResource, b: PricedResource) => (a.priceAtomic < b.priceAtomic ? -1 : a.priceAtomic > b.priceAtomic ? 1 : a.resourceId - b.resourceId);
  for (const s of sellers.values()) {
    s.eligible.sort(byPrice);
    s.over.sort(byPrice);
  }
  return [...sellers.values()];
}

/**
 * The resources a seller's calls rotate over: the cheapest eligible one and any others within twice its price
 * (so rotation never trades a 0.001 endpoint for a 0.09 one), starting at an offset that moves with every attempt.
 */
export function rotationFor(s: SellerFacts): PricedResource[] {
  if (!s.eligible.length) return [];
  const cheapest = s.eligible[0]!.priceAtomic;
  const limit = cheapest === 0n ? 0n : cheapest * 2n;
  const group = s.eligible.filter((r) => r.priceAtomic <= limit);
  const k = s.attempts % group.length;
  return [...group.slice(k), ...group.slice(0, k)];
}

export interface AllocationRow {
  sellerId: number;
  resourceId: number | null;
  pool: "coverage" | "maintenance" | "expensive" | "candidate" | "breadth" | "backoff";
  plannedCalls: number;
  reason: string;
  priceAtomic: bigint | null;
}

export interface CoverageOptions {
  network: string;
  caps: Caps;
  /** What coverage and maintenance may plan together (the run budget minus the other lanes). */
  budgetAtomic: bigint;
  coverageShare: number;
  seed: number;
  now: number;
  exclude?: ExcludeConfig;
  /** Record above-cap resources of sellers with no eligible resource as too_expensive, clear the rest (live runs). */
  recordTooExpensive?: boolean;
  /** Weight floor for maintenance draws, USDC of 30-day inflow (default 100). */
  inflowFloorUsd?: number;
  /** How sellers with the same call count are ordered: seeded-random (default) or cheapest first, then random. */
  ties?: "random" | "price";
  /** Sellers whose too_expensive rows another lane owns (config/expensive-sellers.yaml, judged at their own cap). */
  ownCapDomains?: readonly string[];
}

export interface CoverageStats {
  sellersBelowTarget: number;
  sellersAtTarget: number;
  coverageSellers: number;
  coverageCalls: number;
  coverageAtomic: bigint;
  maintenanceSellers: number;
  maintenanceCalls: number;
  maintenanceAtomic: bigint;
  backoffs: number;
  /** Sellers that have an eligible resource and at least one above the cap (they are bought on the cheap one). */
  sellersWithCheapAndExpensive: number;
  /** Sellers with no resource at or under the cap (breadth-run material). */
  sellersAllAboveCap: number;
}

export interface CoveragePlan {
  plan: BuyPlan;
  rows: AllocationRow[];
  stats: CoverageStats;
  backoffs: Backoff[];
}

/** Coverage pool, then maintenance pool, under `budgetAtomic`. Reads only, except resource_states when recording. */
export function buildCoveragePlan(db: Db, o: CoverageOptions): CoveragePlan {
  const cap = o.caps.perCallAtomic;
  const backoffMap = resourceBackoffs(db, o.now);
  const universe = sellerUniverse(db, { network: o.network, capAtomic: cap, now: o.now, ...(o.exclude ? { exclude: o.exclude } : {}), backoffs: backoffMap });
  const rnd = seededRandom(o.seed);
  const notes: string[] = [];
  const rows: AllocationRow[] = [];
  const allocations: PlanAllocation[] = [];

  if (o.recordTooExpensive) {
    // A seller is never excluded while it has one affordable endpoint: only sellers with none stay too_expensive.
    const own = new Set((o.ownCapDomains ?? []).map((d) => d.toLowerCase()));
    for (const s of universe) {
      if (own.has(s.domain.toLowerCase())) continue;
      const hasCheap = s.eligible.length > 0 || s.over.length === 0;
      for (const r of s.over) {
        if (hasCheap) clearTooExpensive(db, r.resourceId);
        else recordTooExpensive(db, { resourceId: r.resourceId, quotedAtomic: r.priceAtomic, capAtomic: cap, basis: r.basis === "modal" ? "quote" : r.basis, now: o.now });
      }
      for (const r of s.eligible) clearTooExpensive(db, r.resourceId);
    }
  }

  const backoffs = [...backoffMap.values()];
  for (const b of backoffs)
    rows.push({ sellerId: b.sellerId, resourceId: b.resourceId, pool: "backoff", plannedCalls: 0, reason: `last 3 attempts ${b.outcomes.join(", ")}; backed off until ${new Date(b.until).toISOString()}`, priceAtomic: null });

  const buyable = universe.filter((s) => s.eligible.length > 0);
  const below = buyable.filter((s) => s.calls < SELLER_TARGET_CALLS);
  const at = buyable.filter((s) => s.calls >= SELLER_TARGET_CALLS);
  // Fewest calls first; ties broken by a seeded random key so equal sellers rotate across runs.
  const tie = new Map(below.map((s) => [s.sellerId, rnd()]));
  const cheapest = (s: SellerFacts) => s.eligible[0]!.priceAtomic;
  const byPrice = (a: SellerFacts, b: SellerFacts) => (o.ties === "price" ? (cheapest(a) < cheapest(b) ? -1 : cheapest(a) > cheapest(b) ? 1 : 0) : 0);
  below.sort((a, b) => a.calls - b.calls || byPrice(a, b) || tie.get(a.sellerId)! - tie.get(b.sellerId)! || a.sellerId - b.sellerId);

  const share = Math.min(1, Math.max(0, o.coverageShare));
  const coverageBudget = (o.budgetAtomic * BigInt(Math.round(share * 1_000_000))) / 1_000_000n;
  const counts = new Map<number, Map<number, number>>(); // seller -> resource -> calls
  const add = (s: SellerFacts, r: PricedResource) => {
    const m = counts.get(s.sellerId) ?? new Map<number, number>();
    m.set(r.resourceId, (m.get(r.resourceId) ?? 0) + 1);
    counts.set(s.sellerId, m);
  };
  const callsOf = (s: SellerFacts) => [...(counts.get(s.sellerId)?.values() ?? [])].reduce((a, n) => a + n, 0);

  // One call per seller per pass, so the budget reaches as many sellers as possible before anyone gets a second.
  const fill = (list: SellerFacts[], maxFor: (s: SellerFacts) => number, budget: bigint): bigint => {
    let spent = 0n;
    const maxPasses = Math.max(0, ...list.map(maxFor));
    for (let pass = 0; pass < maxPasses; pass++) {
      let placed = false;
      for (const s of list) {
        const k = callsOf(s);
        if (k >= maxFor(s)) continue;
        const rot = rotationFor(s);
        const r = rot[k % rot.length]!;
        if (spent + r.priceAtomic > budget) continue;
        add(s, r);
        spent += r.priceAtomic;
        placed = true;
      }
      if (!placed) break;
    }
    return spent;
  };
  const coverageSpent = fill(below, (s) => Math.min(COVERAGE_MAX_PER_SELLER, SELLER_TARGET_CALLS - s.calls), coverageBudget);

  // Maintenance: weighted draw without replacement (Efraimidis-Spirakis key u^(1/w)), weight = max(inflow, floor).
  const floor = usdToAtomic(o.inflowFloorUsd ?? 100);
  const keyed = at.map((s) => {
    const w = Number(s.inflowAtomic > floor ? s.inflowAtomic : floor) / 1e6;
    return { s, key: Math.pow(rnd(), 1 / w) };
  });
  keyed.sort((a, b) => b.key - a.key || a.s.sellerId - b.s.sellerId);
  const maint = keyed.map((x) => x.s);
  const maintenanceSpent = fill(maint, () => MAINTENANCE_MAX_PER_SELLER, o.budgetAtomic - coverageSpent);

  const emit = (list: SellerFacts[], pool: "coverage" | "maintenance") => {
    let sellers = 0;
    let calls = 0;
    list.forEach((s, rank) => {
      const m = counts.get(s.sellerId);
      if (!m) return;
      sellers++;
      for (const r of s.eligible) {
        const n = m.get(r.resourceId);
        if (!n) continue;
        calls += n;
        const reason =
          pool === "coverage"
            ? `${s.calls} denominator call(s), ${SELLER_TARGET_CALLS - s.calls} to go; rank ${rank + 1} of ${list.length} below ${SELLER_TARGET_CALLS}; price from ${r.basis}`
            : `${s.calls} denominator call(s); 30-day inflow ${atomicToUsd(s.inflowAtomic)} USDC; draw ${rank + 1} of ${list.length}; price from ${r.basis}`;
        allocations.push({ resourceId: r.resourceId, sellerId: s.sellerId, sellerDomain: s.domain, url: r.url, method: r.method, inputJson: r.inputJson, tier: pool, category: s.category, priceAtomic: r.priceAtomic, calls: n, reason });
        rows.push({ sellerId: s.sellerId, resourceId: r.resourceId, pool, plannedCalls: n, reason, priceAtomic: r.priceAtomic });
      }
    });
    return { sellers, calls };
  };
  const cov = emit(below, "coverage");
  const mnt = emit(maint, "maintenance");

  const unreached = below.filter((s) => !counts.has(s.sellerId)).length;
  if (unreached) notes.push(`${unreached} seller(s) below ${SELLER_TARGET_CALLS} calls did not fit this run's coverage budget (${atomicToUsd(coverageBudget)} USDC); they keep their place for the next run.`);
  if (backoffs.length) notes.push(`${backoffs.length} resource(s) in a 48-hour back-off (last three attempts not_paid or our_error).`);
  const allOver = universe.filter((s) => s.eligible.length === 0 && s.over.length > 0).length;
  if (allOver) notes.push(`${allOver} seller(s) have no resource at or under ${atomicToUsd(cap)} USDC (too_expensive; weekly breadth-run material).`);

  const totalCalls = allocations.reduce((a, x) => a + x.calls, 0);
  const totalSpend = coverageSpent + maintenanceSpent;
  const plan: BuyPlan = {
    network: o.network,
    seed: o.seed,
    createdAt: o.now,
    targetCalls: totalCalls,
    strata: [],
    totalCalls,
    totalSpendAtomic: totalSpend,
    sampleMaxTotalAtomic: o.budgetAtomic,
    allocations,
    notes,
  };
  return {
    plan,
    rows,
    backoffs,
    stats: {
      sellersBelowTarget: below.length,
      sellersAtTarget: at.length,
      coverageSellers: cov.sellers,
      coverageCalls: cov.calls,
      coverageAtomic: coverageSpent,
      maintenanceSellers: mnt.sellers,
      maintenanceCalls: mnt.calls,
      maintenanceAtomic: maintenanceSpent,
      backoffs: backoffs.length,
      sellersWithCheapAndExpensive: universe.filter((s) => s.eligible.length > 0 && s.over.length > 0).length,
      sellersAllAboveCap: allOver,
    },
  };
}

/** One run_allocations row per allocation and back-off, before any signature. */
export function writeRunAllocations(db: Db, runId: number, rows: readonly AllocationRow[], now: number): number {
  const ins = db.prepare(
    "INSERT INTO run_allocations (run_id, created_at, seller_id, resource_id, pool, planned_calls, reason, price_atomic, estimated_atomic) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)",
  );
  db.transaction(() => {
    for (const r of rows) ins.run(runId, now, r.sellerId, r.resourceId, r.pool, r.plannedCalls, r.reason, r.priceAtomic?.toString() ?? null, ((r.priceAtomic ?? 0n) * BigInt(r.plannedCalls)).toString());
  })();
  return rows.length;
}

/** Plan allocations as run_allocations rows (lanes and the stratified plan, which carry no reason of their own). */
export function rowsFromAllocations(allocs: readonly PlanAllocation[]): AllocationRow[] {
  return allocs.map((a) => ({
    sellerId: a.sellerId,
    resourceId: a.resourceId,
    pool: (a.tier === "top" || a.tier === "tail" || a.tier === "audit" ? "maintenance" : a.tier) as AllocationRow["pool"],
    plannedCalls: a.calls,
    reason: a.reason ?? (a.tier === "top" || a.tier === "tail" ? `stratified plan, tier ${a.tier}, category ${a.category}` : `${a.tier} lane`),
    priceAtomic: a.priceAtomic,
  }));
}

export function renderCoverage(c: CoveragePlan, extra: { lanes: PlanAllocation[]; runBudgetAtomic: bigint }): string {
  const s = c.stats;
  const laneAtomic = extra.lanes.reduce((a, x) => a + x.priceAtomic * BigInt(x.calls), 0n);
  const laneCalls = extra.lanes.reduce((a, x) => a + x.calls, 0);
  const pct = (x: bigint) => (extra.runBudgetAtomic > 0n ? `${(Number((x * 10000n) / extra.runBudgetAtomic) / 100).toFixed(1)}%` : "-");
  const lines = [
    `# Scheduled run allocation (coverage-first, seed ${c.plan.seed})`,
    "",
    `Run budget ${atomicToUsd(extra.runBudgetAtomic)} USDC. Sellers below ${SELLER_TARGET_CALLS} calls with an eligible resource: ${s.sellersBelowTarget}; at or above: ${s.sellersAtTarget}.`,
    "",
    "| pool | sellers | calls | estimated USDC | share of run budget |",
    "|---|---:|---:|---:|---:|",
    `| coverage | ${s.coverageSellers} | ${s.coverageCalls} | ${atomicToUsd(s.coverageAtomic)} | ${pct(s.coverageAtomic)} |`,
    `| maintenance | ${s.maintenanceSellers} | ${s.maintenanceCalls} | ${atomicToUsd(s.maintenanceAtomic)} | ${pct(s.maintenanceAtomic)} |`,
    `| lanes (expensive, candidate) | ${new Set(extra.lanes.map((a) => a.sellerId)).size} | ${laneCalls} | ${atomicToUsd(laneAtomic)} | ${pct(laneAtomic)} |`,
    `| **total** | | ${s.coverageCalls + s.maintenanceCalls + laneCalls} | ${atomicToUsd(s.coverageAtomic + s.maintenanceAtomic + laneAtomic)} | ${pct(s.coverageAtomic + s.maintenanceAtomic + laneAtomic)} |`,
    "",
    `Back-offs: ${s.backoffs}. Sellers bought on a cheap endpoint while another endpoint is above the cap: ${s.sellersWithCheapAndExpensive}. Sellers with every endpoint above the cap: ${s.sellersAllAboveCap}.`,
  ];
  if (c.plan.notes.length) lines.push("", "Notes:", "", ...c.plan.notes.map((n) => `- ${n}`));
  return lines.join("\n") + "\n";
}

export interface Projection {
  sellersBelow: number;
  usdcToTarget: string;
  callsToTarget: number;
  runsAtCurrentCap: number;
  daysAtCurrentDailyCap: number;
  exceedsSevenDays: boolean;
  bySeller: { domain: string; calls: number; need: number; modalUsdc: string; usdc: string }[];
}

/** USDC needed to bring every eligible seller below 30 calls to 30 at its cheapest eligible price (the price it is
 * bought at), and how many runs and days that takes at the current per-run and daily caps. */
export function projectCoverage(db: Db, o: { network: string; capAtomic: bigint; now: number; exclude?: ExcludeConfig; runAtomic: bigint; dailyAtomic: bigint; coverageShare: number }): Projection {
  const uni = sellerUniverse(db, { network: o.network, capAtomic: o.capAtomic, now: o.now, ...(o.exclude ? { exclude: o.exclude } : {}) });
  const below = uni.filter((s) => s.eligible.length > 0 && s.calls < SELLER_TARGET_CALLS);
  let total = 0n;
  let calls = 0;
  const bySeller = below
    .map((s) => {
      const need = SELLER_TARGET_CALLS - s.calls;
      const p = s.eligible[0]!.priceAtomic;
      total += p * BigInt(need);
      calls += need;
      return { domain: s.domain, calls: s.calls, need, modalUsdc: atomicToUsd(p), usdc: atomicToUsd(p * BigInt(need)) };
    })
    .sort((a, b) => b.need - a.need || a.domain.localeCompare(b.domain));
  const perRunCoverage = (o.runAtomic * BigInt(Math.round(o.coverageShare * 1_000_000))) / 1_000_000n;
  // A seller takes at most 4 calls per run, so the slowest seller needs ceil(need / 4) runs whatever the budget.
  const byBudget = perRunCoverage > 0n ? Number((total + perRunCoverage - 1n) / perRunCoverage) : Infinity;
  const byPerSeller = Math.max(0, ...bySeller.map((s) => Math.ceil(s.need / COVERAGE_MAX_PER_SELLER)));
  const runs = Math.max(byBudget, byPerSeller);
  const runsPerDay = o.runAtomic > 0n ? Number(o.dailyAtomic / o.runAtomic) || 1 : 1;
  const days = runs / runsPerDay;
  return { sellersBelow: below.length, usdcToTarget: atomicToUsd(total), callsToTarget: calls, runsAtCurrentCap: runs, daysAtCurrentDailyCap: Math.round(days * 10) / 10, exceedsSevenDays: total > o.dailyAtomic * 7n, bySeller };
}
