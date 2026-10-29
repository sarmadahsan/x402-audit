/**
 * Coverage-first allocation for scheduled runs (docs/PLAN.md "Coverage-first allocation: finish and admit lanes").
 *
 * Coverage (COVERAGE_SHARE of the budget) has two lanes: finish (70%: sellers with calls below their target, closest to
 * it first) and admit (30%: zero-call sellers by demand this week, then inflow, then price). Targets are 30 calls for
 * measured or important sellers and 5 for the rest. Maintenance (the rest) keeps sellers at target sampled by inflow.
 * Every call is planned at its quote (modal, else probe; never the listing) x1.2, and no seller plans more than 15% of
 * the run. A resource whose last three attempts were not_paid or our_error sits out 48 hours (logged; never deleted).
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

export type PriceBasis = "probe" | "modal";
/** Plans price every call at the quote times this (sellers quote above listings: the overcharge we measure). */
export const PLAN_MARKUP_PCT = 120n;
export const planPrice = (quote: bigint): bigint => (quote * PLAN_MARKUP_PCT + 99n) / 100n;

export interface PricedResource {
  resourceId: number;
  sellerId: number;
  domain: string;
  url: string;
  method: string;
  inputJson: string | null;
  /** The quote: modal paid quote over the last 7 days, else the latest 402 probe. Never the listing. */
  priceAtomic: bigint;
  /** What a plan budgets per call: the quote times 1.2. */
  planAtomic: bigint;
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
  /** 1 = highest 30-day inflow on Base (sellers.rank_30d). */
  rank30d: number | null;
  /** First measured call to the seller (unix ms), if any. */
  firstCallTs: number | null;
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
              COALESCE(s.category, 'other') category, s.volume_30d_atomic vol, s.volume_30d_source vol_src, s.rank_30d rank
       FROM resources r JOIN sellers s ON s.id = r.seller_id
       WHERE r.network = ? AND r.scheme = 'exact' AND COALESCE(r.transfer_method, 'eip3009') != 'permit2'
         AND s.excluded = 0 AND r.source != 'user'
         ${requireProbe ? "AND EXISTS (SELECT 1 FROM probes p JOIN resources pr ON pr.id = p.resource_id WHERE pr.seller_id = r.seller_id AND p.status = 402)" : ""}
       ORDER BY r.seller_id, r.id`,
    )
    .all(o.network) as { resource_id: number; seller_id: number; domain: string; url: string; method: string; input_json: string | null; declared: string | null; category: string; vol: string | null; vol_src: string | null; rank: number | null }[];
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
  const firstCall = new Map((db.prepare(`SELECT seller_id, MIN(ts) t FROM calls WHERE source IN (${MEASURED_LIST}) GROUP BY seller_id`).all() as { seller_id: number; t: number }[]).map((r) => [r.seller_id, r.t]));
  const attempts = new Map((db.prepare(`SELECT seller_id, COUNT(*) n FROM calls WHERE source IN (${MEASURED_LIST}) GROUP BY seller_id`).all() as { seller_id: number; n: number }[]).map((r) => [r.seller_id, r.n]));
  const backoffs = o.backoffs ?? resourceBackoffs(db, o.now);

  const sellers = new Map<number, SellerFacts>();
  for (const r of rows) {
    if (TEMPLATED.test(r.url)) continue; // cannot be fetched literally
    if (o.exclude && isExcluded(o.exclude, r.domain, r.url)) continue;
    // What the seller actually charges, never what it lists: the modal paid quote, else the latest probe quote.
    const p = probe.get(r.resource_id);
    const m = modal.get(r.resource_id);
    const price = m ?? p;
    if (price === undefined) continue;
    let s = sellers.get(r.seller_id);
    if (!s) {
      const inflow = r.vol_src === "chain" && r.vol && /^\d+$/.test(r.vol) ? BigInt(r.vol) : 0n;
      s = { sellerId: r.seller_id, domain: r.domain, category: r.category, calls: denom.get(r.seller_id) ?? 0, attempts: attempts.get(r.seller_id) ?? 0, inflowAtomic: inflow, rank30d: r.rank, firstCallTs: firstCall.get(r.seller_id) ?? null, eligible: [], over: [] };
      sellers.set(r.seller_id, s);
    }
    const pr: PricedResource = { resourceId: r.resource_id, sellerId: r.seller_id, domain: r.domain, url: r.url, method: r.method, inputJson: r.input_json, priceAtomic: price, planAtomic: planPrice(price), basis: m !== undefined ? "modal" : "probe" };
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
  pool: "finish" | "admit" | "maintenance" | "expensive" | "candidate" | "breadth" | "backoff";
  plannedCalls: number;
  reason: string;
  priceAtomic: bigint | null;
}

/** A seller's call target: 30 for sellers measured before the tiers began or that matter (top 50 by inflow, in demand,
 * on config/expensive-sellers.yaml, from user candidates); 5 for the rest, enough for an honest low-sample interval. */
export const FULL_TARGET = SELLER_TARGET_CALLS;
export const ADMIT_TARGET = 5;
export const TOP_INFLOW_RANK = 50;
export const FINISH_SHARE = 0.7;
export const SELLER_SHARE_OF_RUN = 0.15;
/** Admitted sellers take at most this many calls a run (zero-call sellers, and 5-target sellers until they reach 5), so
 * the admit lane reaches many sellers instead of a few pricey ones (operator, 2026-10-29). */
export const ADMIT_MAX_PER_RUN = 2;

export interface TargetContext {
  /** Hosts with checks on the index this week (GET /v1/demand), lowercase, with their checks. */
  demand: Map<string, number>;
  /** Domains on config/expensive-sellers.yaml (lowercase). */
  expensive: Set<string>;
  /** Seller ids that entered through the user-candidate import. */
  candidates: Set<number>;
  /** Sellers first bought before this time keep the 30-call target (the tiers start here). */
  tiersSince: number;
}

export function targetFor(s: SellerFacts, t: TargetContext): { target: number; why: string } {
  if (s.firstCallTs !== null && s.firstCallTs < t.tiersSince) return { target: FULL_TARGET, why: "measured before the tiers" };
  if (s.rank30d !== null && s.rank30d <= TOP_INFLOW_RANK) return { target: FULL_TARGET, why: `top ${TOP_INFLOW_RANK} by inflow (rank ${s.rank30d})` };
  if (t.demand.has(s.domain.toLowerCase())) return { target: FULL_TARGET, why: `in demand (${t.demand.get(s.domain.toLowerCase())} checks this week)` };
  if (t.expensive.has(s.domain.toLowerCase())) return { target: FULL_TARGET, why: "on the expensive-sellers list" };
  if (t.candidates.has(s.sellerId)) return { target: FULL_TARGET, why: "user candidate" };
  return { target: ADMIT_TARGET, why: "admitted at the low-sample target" };
}

export function targetContext(db: Db, o: { demand?: Map<string, number>; expensiveDomains?: readonly string[]; tiersSince: number }): TargetContext {
  return {
    demand: o.demand ?? new Map(),
    expensive: new Set((o.expensiveDomains ?? []).map((d) => d.toLowerCase())),
    candidates: new Set((db.prepare("SELECT DISTINCT seller_id FROM candidates WHERE seller_id IS NOT NULL").all() as { seller_id: number }[]).map((r) => r.seller_id)),
    tiersSince: o.tiersSince,
  };
}

export type CoveragePool = "finish" | "admit" | "maintenance";

export interface Selection {
  /** seller -> resource -> calls, per pool. */
  counts: Map<number, { pool: CoveragePool; byResource: Map<number, number> }>;
  spent: Record<CoveragePool, bigint>;
  order: { pool: CoveragePool; sellers: SellerFacts[] }[];
  budgets: Record<CoveragePool, bigint>;
}

export interface SelectOptions {
  budgetAtomic: bigint;
  coverageShare: number;
  /** No seller's planned spend may exceed this in one run (15% of the run budget). */
  sellerCapAtomic: bigint;
  targets: TargetContext;
  rnd: () => number;
  inflowFloorAtomic: bigint;
}

const cmpBig = (a: bigint, b: bigint) => (a < b ? -1 : a > b ? 1 : 0);

/**
 * The lanes, in order: finish (FINISH_SHARE of coverage; sellers with 1+ calls below their target, closest to it first),
 * admit (the rest of coverage; zero-call sellers by demand this week, then 30-day inflow, then price), then maintenance
 * (sellers at or past their target, inflow-weighted with a floor). Finish sellers take up to 4 calls a run, admitted
 * sellers (zero calls, or a 5-call target not yet reached) 2, maintenance 2; each seller's plan stays under `sellerCapAtomic`. Unused budget flows on: finish -> admit -> finish -> maintenance.
 */
export function selectCoverage(sellers: readonly SellerFacts[], o: SelectOptions): Selection {
  const buyable = sellers.filter((s) => s.eligible.length > 0);
  const tgt = new Map(buyable.map((s) => [s.sellerId, targetFor(s, o.targets).target]));
  const tie = new Map(buyable.map((s) => [s.sellerId, o.rnd()]));
  const cheapest = (s: SellerFacts) => s.eligible[0]!.planAtomic;
  const finish = buyable
    .filter((s) => s.calls > 0 && s.calls < tgt.get(s.sellerId)!)
    .sort((a, b) => tgt.get(a.sellerId)! - a.calls - (tgt.get(b.sellerId)! - b.calls) || cmpBig(cheapest(a), cheapest(b)) || tie.get(a.sellerId)! - tie.get(b.sellerId)!);
  const demandOf = (s: SellerFacts) => o.targets.demand.get(s.domain.toLowerCase()) ?? 0;
  const admit = buyable
    .filter((s) => s.calls === 0)
    .sort((a, b) => demandOf(b) - demandOf(a) || cmpBig(cheapest(a), cheapest(b)) || cmpBig(b.inflowAtomic, a.inflowAtomic) || tie.get(a.sellerId)! - tie.get(b.sellerId)!);
  // The inflow reserve: highest 30-day inflow first, so volume sellers are not starved by the cheap breadth.
  const byInflow = buyable
    .filter((s) => s.calls === 0 && s.inflowAtomic > 0n)
    .sort((a, b) => cmpBig(b.inflowAtomic, a.inflowAtomic) || cmpBig(cheapest(a), cheapest(b)) || tie.get(a.sellerId)! - tie.get(b.sellerId)!);
  const maint = buyable
    .filter((s) => s.calls >= tgt.get(s.sellerId)!)
    .map((s) => ({ s, key: Math.pow(o.rnd(), 1 / (Number(s.inflowAtomic > o.inflowFloorAtomic ? s.inflowAtomic : o.inflowFloorAtomic) / 1e6)) }))
    .sort((a, b) => b.key - a.key || a.s.sellerId - b.s.sellerId)
    .map((x) => x.s);

  const share = Math.min(1, Math.max(0, o.coverageShare));
  const coverage = (o.budgetAtomic * BigInt(Math.round(share * 1e6))) / 1_000_000n;
  const finishBudget = (coverage * BigInt(Math.round(FINISH_SHARE * 1e6))) / 1_000_000n;
  const sel: Selection = {
    counts: new Map(),
    spent: { finish: 0n, admit: 0n, maintenance: 0n },
    order: [{ pool: "finish", sellers: finish }, { pool: "admit", sellers: admit }, { pool: "maintenance", sellers: maint }],
    budgets: { finish: finishBudget, admit: coverage - finishBudget, maintenance: o.budgetAtomic - coverage },
  };
  const planned = new Map<number, bigint>();
  // Seller by seller: each takes its run's share of calls before the next one, so sellers reach their target.
  const fill = (pool: CoveragePool, list: SellerFacts[], maxFor: (s: SellerFacts) => number, budget: bigint): bigint => {
    let spent = 0n;
    for (const s of list) {
      const entry = sel.counts.get(s.sellerId);
      if (entry && entry.pool !== pool) continue;
      const rot = rotationFor(s);
      let k = [...(entry?.byResource.values() ?? [])].reduce((a, n) => a + n, 0);
      while (k < maxFor(s)) {
        const r = rot[k % rot.length]!;
        const p = planned.get(s.sellerId) ?? 0n;
        if (spent + r.planAtomic > budget || p + r.planAtomic > o.sellerCapAtomic) break;
        const e = sel.counts.get(s.sellerId) ?? { pool, byResource: new Map<number, number>() };
        e.byResource.set(r.resourceId, (e.byResource.get(r.resourceId) ?? 0) + 1);
        sel.counts.set(s.sellerId, e);
        planned.set(s.sellerId, p + r.planAtomic);
        spent += r.planAtomic;
        k++;
      }
    }
    sel.spent[pool] += spent;
    return spent;
  };
  /**
   * Admit lane, call by call: four calls from the price queue (external demand, then cheapest, then inflow; each seller up
   * to its per-run limit before the next), then one call for the highest-inflow seller not yet admitted, and so on. A call
   * that does not fit the budget or the seller's limit is skipped; when one queue is spent the other takes every slot.
   */
  const fillAdmit = (priceQ: SellerFacts[], inflowQ: SellerFacts[], budget: bigint): bigint => {
    let spent = 0n;
    let placed = 0;
    const callsIn = (s: SellerFacts) => [...(sel.counts.get(s.sellerId)?.byResource.values() ?? [])].reduce((a, n) => a + n, 0);
    const tryOne = (s: SellerFacts): boolean => {
      const entry = sel.counts.get(s.sellerId);
      if (entry && entry.pool !== "admit") return false;
      const k = callsIn(s);
      if (k >= maxCov(s)) return false;
      const r = rotationFor(s)[k % rotationFor(s).length]!;
      const p = planned.get(s.sellerId) ?? 0n;
      if (spent + r.planAtomic > budget || p + r.planAtomic > o.sellerCapAtomic) return false;
      const e = entry ?? { pool: "admit" as const, byResource: new Map<number, number>() };
      e.byResource.set(r.resourceId, (e.byResource.get(r.resourceId) ?? 0) + 1);
      sel.counts.set(s.sellerId, e);
      planned.set(s.sellerId, p + r.planAtomic);
      spent += r.planAtomic;
      placed++;
      reserved.add(s.sellerId);
      return true;
    };
    const reserved = new Set<number>();
    let pi = 0;
    let ii = 0;
    const nextPrice = (): boolean => {
      for (; pi < priceQ.length; pi++) if (tryOne(priceQ[pi]!)) return true;
      return false;
    };
    const nextInflow = (): boolean => {
      for (; ii < inflowQ.length; ii++) {
        const s = inflowQ[ii]!;
        if (reserved.has(s.sellerId) || sel.counts.has(s.sellerId)) continue; // "not yet admitted"
        if (tryOne(s)) {
          ii++;
          return true;
        }
      }
      return false;
    };
    for (;;) {
      const reserveSlot = placed % 5 === 4;
      const ok = reserveSlot ? nextInflow() || nextPrice() : nextPrice() || nextInflow();
      if (!ok) break;
    }
    sel.spent.admit += spent;
    return spent;
  };
  const maxCov = (s: SellerFacts) => {
    const t = tgt.get(s.sellerId)!;
    const per = s.calls === 0 || t === ADMIT_TARGET ? ADMIT_MAX_PER_RUN : COVERAGE_MAX_PER_SELLER;
    return Math.min(per, t - s.calls);
  };
  const f1 = fill("finish", finish, maxCov, sel.budgets.finish);
  const a1 = fillAdmit(admit, byInflow, sel.budgets.admit + (sel.budgets.finish - f1));
  const f2 = fill("finish", finish, maxCov, coverage - f1 - a1);
  fill("maintenance", maint, () => MAINTENANCE_MAX_PER_SELLER, o.budgetAtomic - (f1 + a1 + f2));
  return sel;
}

export interface CoverageOptions {
  network: string;
  caps: Caps;
  /** What the lanes may plan together (the run budget minus the expensive and candidate lanes). */
  budgetAtomic: bigint;
  /** The whole run's budget: no seller plans more than SELLER_SHARE_OF_RUN of it. */
  runBudgetAtomic: bigint;
  coverageShare: number;
  seed: number;
  now: number;
  exclude?: ExcludeConfig;
  /** Record above-cap resources of sellers with no eligible resource as too_expensive, clear the rest (live runs). */
  recordTooExpensive?: boolean;
  /** Weight floor for maintenance draws, USDC of 30-day inflow (default 100). */
  inflowFloorUsd?: number;
  /** Sellers whose too_expensive rows another lane owns (config/expensive-sellers.yaml, judged at their own cap). */
  ownCapDomains?: readonly string[];
  /** Index demand this week (host -> checks); empty when the index could not be read. */
  demand?: Map<string, number>;
  tiersSince: number;
}

export interface CoverageStats {
  finishSellers: number;
  finishCalls: number;
  finishAtomic: bigint;
  admitSellers: number;
  admitCalls: number;
  admitAtomic: bigint;
  maintenanceSellers: number;
  maintenanceCalls: number;
  maintenanceAtomic: bigint;
  finishPool: number;
  admitPool: number;
  atTarget: number;
  backoffs: number;
  sellersWithCheapAndExpensive: number;
  sellersAllAboveCap: number;
}

export interface CoveragePlan {
  plan: BuyPlan;
  rows: AllocationRow[];
  stats: CoverageStats;
  backoffs: Backoff[];
}

/** Finish, admit and maintenance under `budgetAtomic`. Reads only, except resource_states when recording. */
export function buildCoveragePlan(db: Db, o: CoverageOptions): CoveragePlan {
  const cap = o.caps.perCallAtomic;
  const backoffMap = resourceBackoffs(db, o.now);
  const universe = sellerUniverse(db, { network: o.network, capAtomic: cap, now: o.now, ...(o.exclude ? { exclude: o.exclude } : {}), backoffs: backoffMap });
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
    // Rows the planner can no longer see: every resource of a seller that has an eligible endpoint (including ones with
    // no quote), and listing-based rows of resources nothing ever quoted (a listing is not evidence of a price).
    const cheapSellers = universe.filter((s) => s.eligible.length > 0 && !own.has(s.domain.toLowerCase())).map((s) => s.sellerId);
    const quoted = new Set(universe.flatMap((s) => [...s.eligible, ...s.over].map((r) => r.resourceId)));
    const stale = (db
      .prepare("SELECT rs.resource_id id, r.seller_id sid, rs.basis, s.domain FROM resource_states rs JOIN resources r ON r.id = rs.resource_id JOIN sellers s ON s.id = r.seller_id WHERE rs.state = 'too_expensive'")
      .all() as { id: number; sid: number; basis: string | null; domain: string }[]).filter((r) => !own.has(r.domain.toLowerCase()) && (cheapSellers.includes(r.sid) || (r.basis === "declared" && !quoted.has(r.id))));
    for (const r of stale) clearTooExpensive(db, r.id);
  }

  const backoffs = [...backoffMap.values()];
  for (const b of backoffs)
    rows.push({ sellerId: b.sellerId, resourceId: b.resourceId, pool: "backoff", plannedCalls: 0, reason: `last 3 attempts ${b.outcomes.join(", ")}; backed off until ${new Date(b.until).toISOString()}`, priceAtomic: null });

  const targets = targetContext(db, { ...(o.demand ? { demand: o.demand } : {}), ...(o.ownCapDomains ? { expensiveDomains: o.ownCapDomains } : {}), tiersSince: o.tiersSince });
  const sellerCap = (o.runBudgetAtomic * BigInt(Math.round(SELLER_SHARE_OF_RUN * 1e6))) / 1_000_000n;
  const sel = selectCoverage(universe, { budgetAtomic: o.budgetAtomic, coverageShare: o.coverageShare, sellerCapAtomic: sellerCap, targets, rnd: seededRandom(o.seed), inflowFloorAtomic: usdToAtomic(o.inflowFloorUsd ?? 100) });

  const tally: Record<CoveragePool, { sellers: number; calls: number }> = { finish: { sellers: 0, calls: 0 }, admit: { sellers: 0, calls: 0 }, maintenance: { sellers: 0, calls: 0 } };
  for (const { pool, sellers } of sel.order) {
    sellers.forEach((s, rank) => {
      const e = sel.counts.get(s.sellerId);
      if (!e || e.pool !== pool) return;
      tally[pool].sellers++;
      const t = targetFor(s, targets);
      for (const r of s.eligible) {
        const n = e.byResource.get(r.resourceId);
        if (!n) continue;
        tally[pool].calls += n;
        const reason =
          pool === "maintenance"
            ? `${s.calls} denominator call(s), target ${t.target} reached; 30-day inflow ${atomicToUsd(s.inflowAtomic)} USDC; draw ${rank + 1} of ${sellers.length}; quote from ${r.basis}`
            : `${s.calls} of ${t.target} call(s) (${t.why}); ${pool} rank ${rank + 1} of ${sellers.length}; quote ${atomicToUsd(r.priceAtomic)} from ${r.basis}, planned at ${atomicToUsd(r.planAtomic)}`;
        allocations.push({ resourceId: r.resourceId, sellerId: s.sellerId, sellerDomain: s.domain, url: r.url, method: r.method, inputJson: r.inputJson, tier: pool, category: s.category, priceAtomic: r.priceAtomic, planAtomic: r.planAtomic, calls: n, reason });
        rows.push({ sellerId: s.sellerId, resourceId: r.resourceId, pool, plannedCalls: n, reason, priceAtomic: r.planAtomic });
      }
    });
  }
  const [fin, adm, mnt] = sel.order;
  const left = (x: { pool: CoveragePool; sellers: SellerFacts[] }) => x.sellers.filter((s) => !sel.counts.has(s.sellerId)).length;
  if (left(fin!)) notes.push(`${left(fin!)} finish-lane seller(s) did not fit this run; they keep their place.`);
  if (left(adm!)) notes.push(`${left(adm!)} zero-call seller(s) wait in the admit lane.`);
  if (backoffs.length) notes.push(`${backoffs.length} resource(s) in a 48-hour back-off (last three attempts not_paid or our_error).`);
  const allOver = universe.filter((s) => s.eligible.length === 0 && s.over.length > 0).length;
  if (allOver) notes.push(`${allOver} seller(s) have no resource quoting at or under ${atomicToUsd(cap)} USDC (too_expensive; breadth-run material).`);
  notes.push(`Every call is planned at its modal (else probe) quote x1.2, never the listing; no seller plans more than ${atomicToUsd(sellerCap)} USDC (15% of the run).`);

  const totalCalls = allocations.reduce((a, x) => a + x.calls, 0);
  const totalSpend = sel.spent.finish + sel.spent.admit + sel.spent.maintenance;
  const plan: BuyPlan = { network: o.network, seed: o.seed, createdAt: o.now, targetCalls: totalCalls, strata: [], totalCalls, totalSpendAtomic: totalSpend, sampleMaxTotalAtomic: o.budgetAtomic, allocations, notes };
  return {
    plan,
    rows,
    backoffs,
    stats: {
      finishSellers: tally.finish.sellers,
      finishCalls: tally.finish.calls,
      finishAtomic: sel.spent.finish,
      admitSellers: tally.admit.sellers,
      admitCalls: tally.admit.calls,
      admitAtomic: sel.spent.admit,
      maintenanceSellers: tally.maintenance.sellers,
      maintenanceCalls: tally.maintenance.calls,
      maintenanceAtomic: sel.spent.maintenance,
      finishPool: fin!.sellers.length,
      admitPool: adm!.sellers.length,
      atTarget: mnt!.sellers.length,
      backoffs: backoffs.length,
      sellersWithCheapAndExpensive: universe.filter((s) => s.eligible.length > 0 && s.over.length > 0).length,
      sellersAllAboveCap: allOver,
    },
  };
}

/** One run_allocations row per allocation and back-off, before any signature. price_atomic is the planned price. */
export function writeRunAllocations(db: Db, runId: number, rows: readonly AllocationRow[], now: number): number {
  const ins = db.prepare(
    "INSERT INTO run_allocations (run_id, created_at, seller_id, resource_id, pool, planned_calls, reason, price_atomic, estimated_atomic) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)",
  );
  db.transaction(() => {
    for (const r of rows) ins.run(runId, now, r.sellerId, r.resourceId, r.pool, r.plannedCalls, r.reason, r.priceAtomic?.toString() ?? null, ((r.priceAtomic ?? 0n) * BigInt(r.plannedCalls)).toString());
  })();
  return rows.length;
}

/** Plan allocations as run_allocations rows, priced at what the plan budgeted. */
export function rowsFromAllocations(allocs: readonly PlanAllocation[]): AllocationRow[] {
  return allocs.map((a) => ({
    sellerId: a.sellerId,
    resourceId: a.resourceId,
    pool: (a.tier === "top" || a.tier === "tail" || a.tier === "audit" ? "maintenance" : a.tier) as AllocationRow["pool"],
    plannedCalls: a.calls,
    reason: a.reason ?? (a.tier === "top" || a.tier === "tail" ? `stratified plan, tier ${a.tier}, category ${a.category}` : `${a.tier} lane`),
    priceAtomic: a.planAtomic ?? a.priceAtomic,
  }));
}

export function renderCoverage(c: CoveragePlan, extra: { lanes: PlanAllocation[]; runBudgetAtomic: bigint }): string {
  const s = c.stats;
  const laneAtomic = extra.lanes.reduce((a, x) => a + (x.planAtomic ?? x.priceAtomic) * BigInt(x.calls), 0n);
  const laneCalls = extra.lanes.reduce((a, x) => a + x.calls, 0);
  const pct = (x: bigint) => (extra.runBudgetAtomic > 0n ? `${(Number((x * 10000n) / extra.runBudgetAtomic) / 100).toFixed(1)}%` : "-");
  const total = s.finishAtomic + s.admitAtomic + s.maintenanceAtomic + laneAtomic;
  const lines = [
    `# Scheduled run allocation (finish / admit / maintenance, seed ${c.plan.seed})`,
    "",
    `Run budget ${atomicToUsd(extra.runBudgetAtomic)} USDC. Finish pool (1+ calls, below target): ${s.finishPool}; admit pool (zero calls): ${s.admitPool}; at target: ${s.atTarget}.`,
    "",
    "| pool | sellers | calls | planned USDC (quote x1.2) | share of run budget |",
    "|---|---:|---:|---:|---:|",
    `| finish | ${s.finishSellers} | ${s.finishCalls} | ${atomicToUsd(s.finishAtomic)} | ${pct(s.finishAtomic)} |`,
    `| admit | ${s.admitSellers} | ${s.admitCalls} | ${atomicToUsd(s.admitAtomic)} | ${pct(s.admitAtomic)} |`,
    `| maintenance | ${s.maintenanceSellers} | ${s.maintenanceCalls} | ${atomicToUsd(s.maintenanceAtomic)} | ${pct(s.maintenanceAtomic)} |`,
    `| lanes (expensive, candidate) | ${new Set(extra.lanes.map((a) => a.sellerId)).size} | ${laneCalls} | ${atomicToUsd(laneAtomic)} | ${pct(laneAtomic)} |`,
    `| **total** | | ${s.finishCalls + s.admitCalls + s.maintenanceCalls + laneCalls} | ${atomicToUsd(total)} | ${pct(total)} |`,
    "",
    `Back-offs: ${s.backoffs}. Sellers bought on a cheap endpoint while another is above the cap: ${s.sellersWithCheapAndExpensive}. Sellers with every endpoint above the cap: ${s.sellersAllAboveCap}.`,
  ];
  if (c.plan.notes.length) lines.push("", "Notes:", "", ...c.plan.notes.map((n) => `- ${n}`));
  return lines.join("\n") + "\n";
}

export interface ProjectionScenario {
  label: string;
  runAtomic: bigint;
  runsPerDay: number;
  /** Days simulated (the scenario's horizon). */
  days: number;
  /** Sellers at or past target at the start and at the end of each simulated day. */
  atTargetByDay: number[];
  /** Of those, sellers at 30 or more (what sellers_with_min_calls counts). */
  at30ByDay: number[];
  spentAtomic: bigint;
  /** Days until every seller reaches its target at this rate (null: not within 400 days). */
  daysToAllTargets: number | null;
}

export interface Projection {
  sellersBelowTarget: number;
  fullTarget: number;
  admitTarget: number;
  callsToTargets: number;
  usdcToTargets: string;
  scenarios: ProjectionScenario[];
}

/**
 * The tiered targets, costed at each seller's cheapest quote x1.2, and a run-by-run simulation of the lanes under each
 * scenario (expensive lane and maintenance included in the budget split; every call assumed to land in the denominator,
 * so the figures are an upper bound on progress).
 */
export function projectCoverage(db: Db, o: { network: string; capAtomic: bigint; now: number; exclude?: ExcludeConfig; coverageShare: number; demand?: Map<string, number>; expensiveDomains?: readonly string[]; tiersSince: number; laneAtomicPerRun?: bigint; scenarios: { label: string; runAtomic: bigint; runsPerDay: number; days: number }[] }): Projection {
  const uni = sellerUniverse(db, { network: o.network, capAtomic: o.capAtomic, now: o.now, ...(o.exclude ? { exclude: o.exclude } : {}) });
  const targets = targetContext(db, { ...(o.demand ? { demand: o.demand } : {}), ...(o.expensiveDomains ? { expensiveDomains: o.expensiveDomains } : {}), tiersSince: o.tiersSince });
  const buyable = uni.filter((s) => s.eligible.length > 0);
  let calls = 0;
  let usdc = 0n;
  let below = 0;
  let full = 0;
  let admitT = 0;
  for (const s of buyable) {
    const t = targetFor(s, targets).target;
    if (s.calls >= t) continue;
    below++;
    if (t === FULL_TARGET) full++;
    else admitT++;
    calls += t - s.calls;
    usdc += s.eligible[0]!.planAtomic * BigInt(t - s.calls);
  }
  const scenarios = o.scenarios.map((sc) => {
    const facts = buyable.map((s) => ({ ...s, eligible: s.eligible }));
    const rnd = seededRandom(1);
    const count = () => ({ t: facts.filter((s) => s.calls >= targetFor(s, targets).target).length, f: facts.filter((s) => s.calls >= FULL_TARGET).length });
    const atT = [count().t];
    const at30 = [count().f];
    let spent = 0n;
    let done: number | null = null;
    const horizon = 400;
    for (let day = 1; day <= horizon; day++) {
      for (let r = 0; r < sc.runsPerDay; r++) {
        const budget = (sc.runAtomic * 95n) / 100n - (o.laneAtomicPerRun ?? 0n);
        const sel = selectCoverage(facts, { budgetAtomic: budget, coverageShare: o.coverageShare, sellerCapAtomic: (sc.runAtomic * 15n) / 100n, targets, rnd, inflowFloorAtomic: usdToAtomic(100) });
        for (const s of facts) {
          const e = sel.counts.get(s.sellerId);
          if (!e) continue;
          const n = [...e.byResource.values()].reduce((a, x) => a + x, 0);
          s.calls += n;
          s.attempts += n;
          if (s.firstCallTs === null) s.firstCallTs = o.now + day * 86_400_000; // first bought now, so under the tiers
        }
        spent += sel.spent.finish + sel.spent.admit + sel.spent.maintenance;
      }
      const c = count();
      if (day <= sc.days) {
        atT.push(c.t);
        at30.push(c.f);
      }
      if (done === null && c.t === facts.length) done = day;
      if (day >= sc.days && done !== null) break;
      if (day >= sc.days && day >= 120) break; // long enough to say "not soon"
    }
    return { label: sc.label, runAtomic: sc.runAtomic, runsPerDay: sc.runsPerDay, days: sc.days, atTargetByDay: atT, at30ByDay: at30, spentAtomic: spent, daysToAllTargets: done };
  });
  return { sellersBelowTarget: below, fullTarget: full, admitTarget: admitT, callsToTargets: calls, usdcToTargets: atomicToUsd(usdc), scenarios };
}
