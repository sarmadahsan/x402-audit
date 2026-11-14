/**
 * The re-test lane (docs/taxonomy.md "Re-test purchases"): every seller the index rates `avoid` gets a scheduled,
 * bounded path back. A verdict only moves when new paid calls reach the seller's rolling window, and nothing else
 * buys from a seller past its target except the inflow-weighted maintenance draw, so a small avoid seller could stay
 * avoid for good.
 *
 * The verdict is recomputed here from our own database with the index's rule (paidfor-index lib/verdict.ts: the last
 * WINDOW_SIZE paid calls decide once WINDOW_MIN_CALLS are in, else all-time; an all-time avoid with a failure younger
 * than AVOID_FLOOR_DAYS stays avoid). The phase is derived from the call history on every run, never stored, so a
 * crashed or resumed run cannot leave it out of step:
 *
 *   waiting   the last headline failure is younger than the cooldown (3, 7, 14, then 30 days, one step per earlier
 *             re-test cycle that ended in a failure); no calls
 *   sentinel  fewer than SENTINEL_STREAK clean paid calls since the last failure: one call, at most one a day
 *   ramp      SENTINEL_STREAK or more clean calls: up to RAMP_MAX_PER_RUN calls a run, until the window alone says ok
 *   holding   the window alone says ok and only the 7-day floor keeps the seller at avoid: no calls, the floor lifts
 *             (a window that says caution keeps buying, so the seller leaves avoid at ok where the calls allow)
 *   dormant   DORMANT_AFTER_CYCLES failed cycles: the 30-day cooldown, labelled so the export can say so
 *
 * Before any paid call the free 402 probe is consulted: a resource whose latest probe (within PROBE_FRESH_MS) has no
 * 402, is classified overcharge or quotes above the cap is not bought this run. With no recent probe the sentinel
 * call itself is the test.
 *
 * Calls are written with source `retest`: they count in the seller's own series and window like any measured call,
 * never in the headline (re-tests oversample sellers already rated avoid). Reads only; the plan is on record in
 * run_allocations before any signature, and every cap in guard.ts still applies.
 */
import type { Db } from "../db/index.js";
import { runQuery } from "../report/queries.js";
import { countRate } from "../report/compute.js";
import { CALL_SOURCES, HEADLINE_FAILURE_OUTCOMES } from "../taxonomy.js";
import type { PlanAllocation } from "./plan.js";
import { planPrice, rotationFor, type SellerFacts } from "./allocate.js";
import { spentAtomic } from "./guard.js";

/** Same thresholds as the index's verdict rule (paidfor-index lib/verdict.ts); a test pins them. */
export const AVOID_LOW_BOUND = 0.1;
export const CAUTION_RATE = 0.02;
export const MIN_CALLS = 30;
export const WINDOW_SIZE = 50;
export const WINDOW_MIN_CALLS = 30;
export const AVOID_FLOOR_DAYS = 7;

/** Cooldown after the last failure, by the number of earlier re-test cycles that ended in a failure. */
export const COOLDOWN_DAYS = [3, 7, 14, 30] as const;
export const DORMANT_AFTER_CYCLES = 4;
/** Failed cycles are counted over this many days, so a seller that recovered long ago starts again at 3 days. */
export const CYCLE_LOOKBACK_DAYS = 120;
export const SENTINEL_STREAK = 3;
/** One sentinel a day: a sentinel is skipped while the last re-test call is younger than this. */
export const SENTINEL_SPACING_MS = 20 * 3_600_000;
export const RAMP_MAX_PER_RUN = 4;
export const PROBE_FRESH_MS = 36 * 3_600_000;
const DAY_MS = 86_400_000;

export type Verdict = "ok" | "caution" | "avoid";
export const RETEST_PHASES = ["waiting", "sentinel", "ramp", "holding", "dormant"] as const;
export type RetestPhase = (typeof RETEST_PHASES)[number];

type Figures = { n: number; rate: number; lo: number };

/** The index's thresholds applied to one set of figures: avoid needs a full sample and a Wilson low above 10%. */
export function verdictFor(f: Figures): Verdict {
  const full = f.n >= MIN_CALLS;
  if (full && f.lo > AVOID_LOW_BOUND) return "avoid";
  if (f.rate > CAUTION_RATE || !full) return "caution";
  return "ok";
}

export interface WindowRow {
  failed: number;
  ts: number;
  source?: string;
}

export interface SellerVerdict {
  verdict: Verdict;
  /** What the window alone says (null when it has fewer than WINDOW_MIN_CALLS calls). */
  windowVerdict: Verdict | null;
  allTime: Verdict;
  /** True when the all-time avoid floor is what holds the seller at avoid. */
  floor: boolean;
  lastFailureTs: number | null;
  /** Paid-denominator calls since the last failure (window rows, newest first, before the first failed one). */
  cleanSinceFailure: number;
}

/** lib/verdict.ts measuredVerdict, over the same series (window rows newest first or in any order). */
export function sellerVerdict(allTime: { n: number; failures: number }, windowRows: readonly WindowRow[], now: number): SellerVerdict {
  const at = countRate(allTime.failures, allTime.n);
  const all = verdictFor({ n: at.n, rate: at.rate, lo: at.lo });
  const w = [...windowRows].sort((a, b) => b.ts - a.ts).slice(0, WINDOW_SIZE);
  const firstFailed = w.findIndex((r) => r.failed === 1);
  const lastFailureTs = firstFailed >= 0 ? w[firstFailed]!.ts : null;
  const cleanSinceFailure = firstFailed >= 0 ? firstFailed : w.length;
  if (w.length < WINDOW_MIN_CALLS || at.n < MIN_CALLS) return { verdict: all, windowVerdict: null, allTime: all, floor: false, lastFailureTs, cleanSinceFailure };
  const wc = countRate(w.filter((r) => r.failed === 1).length, w.length);
  const windowVerdict = verdictFor({ n: wc.n, rate: wc.rate, lo: wc.lo });
  const recent = lastFailureTs !== null && now - lastFailureTs < AVOID_FLOOR_DAYS * DAY_MS;
  const floor = all === "avoid" && windowVerdict !== "avoid" && recent;
  return { verdict: floor ? "avoid" : windowVerdict, windowVerdict, allTime: all, floor, lastFailureTs, cleanSinceFailure };
}

export interface RetestStatus {
  sellerId: number;
  domain: string;
  phase: RetestPhase;
  /** Earlier re-test cycles that ended in a failure (within CYCLE_LOOKBACK_DAYS). */
  cycle: number;
  cleanStreak: number;
  lastFailureTs: number;
  /** When the seller is next due a call (waiting, dormant, a spaced sentinel); null when due now or holding. */
  nextDueTs: number | null;
  /** First re-test call since the last failure, if any. */
  sinceTs: number | null;
  /** Re-test calls since the last failure. */
  retestCalls: number;
  lastRetestTs: number | null;
  verdict: SellerVerdict;
}

/** Every seller our own data rates avoid, with its re-test phase. Reads only. */
export function retestStatuses(db: Db, o: { network: string; now: number }): RetestStatus[] {
  const params = { since: 0, until: o.now, network: o.network };
  const allTime = new Map(
    runQuery<{ seller_id: number; domain: string; n: number; failures: number }>(db, "seller_measured", params).map((r) => [Number(r.seller_id), { domain: r.domain, n: Number(r.n), failures: Number(r.failures) }]),
  );
  const window = new Map<number, WindowRow[]>();
  for (const r of runQuery<{ seller_id: number; failed: number; ts: number }>(db, "buy_seller_window", params)) {
    const l = window.get(Number(r.seller_id)) ?? [];
    l.push({ failed: Number(r.failed), ts: Number(r.ts) });
    window.set(Number(r.seller_id), l);
  }
  const fails = [...HEADLINE_FAILURE_OUTCOMES].map((x) => `'${x}'`).join(", ");
  const retestCalls = db.prepare(`SELECT ts, outcome FROM calls WHERE seller_id = ? AND source = '${CALL_SOURCES.RETEST}' ORDER BY ts DESC`);
  const out: RetestStatus[] = [];
  for (const [sellerId, a] of allTime) {
    const v = sellerVerdict(a, window.get(sellerId) ?? [], o.now);
    if (v.verdict !== "avoid" || v.lastFailureTs === null) continue;
    const rs = retestCalls.all(sellerId) as { ts: number; outcome: string | null }[];
    // A failed cycle: a UTC day on which a re-test call failed. Several failures in one ramp are one cycle.
    const failDays = new Set(rs.filter((r) => r.ts >= o.now - CYCLE_LOOKBACK_DAYS * DAY_MS && r.outcome !== null && fails.includes(`'${r.outcome}'`)).map((r) => Math.floor(r.ts / DAY_MS)));
    const cycle = failDays.size;
    const cooldown = COOLDOWN_DAYS[Math.min(cycle, COOLDOWN_DAYS.length - 1)]! * DAY_MS;
    const sinceFailure = rs.filter((r) => r.ts > v.lastFailureTs!);
    const lastRetestTs = rs[0]?.ts ?? null;
    const base = {
      sellerId,
      domain: a.domain,
      cycle,
      cleanStreak: v.cleanSinceFailure,
      lastFailureTs: v.lastFailureTs,
      sinceTs: sinceFailure.length ? sinceFailure[sinceFailure.length - 1]!.ts : null,
      retestCalls: sinceFailure.length,
      lastRetestTs,
      verdict: v,
    };
    const due = v.lastFailureTs + cooldown;
    let phase: RetestPhase;
    let nextDueTs: number | null = null;
    // Only the floor is left (the window alone already says ok): buying more cannot help, the floor lifts by itself.
    if (v.floor && v.windowVerdict === "ok") phase = "holding";
    else if (o.now < due) {
      phase = cycle >= DORMANT_AFTER_CYCLES ? "dormant" : "waiting";
      nextDueTs = due;
    } else if (v.cleanSinceFailure >= SENTINEL_STREAK) phase = "ramp";
    else {
      phase = "sentinel";
      if (lastRetestTs !== null && o.now - lastRetestTs < SENTINEL_SPACING_MS) nextDueTs = lastRetestTs + SENTINEL_SPACING_MS;
    }
    out.push({ ...base, phase, nextDueTs });
  }
  return out.sort((x, y) => x.sellerId - y.sellerId);
}

/**
 * This run's re-test budget: RETEST_SHARE of the run budget, but never more than what the lanes planned before it
 * (expensive sellers, candidates) leave of the run's planned share (95% of the run budget, the same headroom coverage
 * keeps), all at quote x1.2. Without this a full candidate queue plus the re-test share can plan past the run budget,
 * which the trim does not touch, and the plan check then aborts the scheduled run before any payment.
 */
export function retestRunBudget(runBudgetAtomic: bigint, share: number, priorLanes: readonly Pick<PlanAllocation, "priceAtomic" | "calls">[]): bigint {
  const shareAtomic = (runBudgetAtomic * BigInt(Math.round(share * 1e6))) / 1_000_000n;
  const prior = priorLanes.reduce((a, x) => a + planPrice(x.priceAtomic) * BigInt(x.calls), 0n);
  const left = (runBudgetAtomic * 95n) / 100n - prior;
  if (left <= 0n) return 0n;
  return shareAtomic < left ? shareAtomic : left;
}

export interface RetestLaneOptions {
  network: string;
  now: number;
  /** This lane's share of the run (RETEST_SHARE of the run budget), planned at quote x1.2. */
  budgetAtomic: bigint;
  /** RETEST_WEEKLY_USD: re-test spend over any 7 days, source retest only. */
  weeklyBudgetAtomic: bigint;
  /** No seller plans more than this in one run (the run's per-seller share). */
  sellerCapAtomic: bigint;
  perCallCapAtomic: bigint;
  /** The buyable universe (sellerUniverse): eligible resources are under the cap, not excluded, not backed off. */
  universe: readonly SellerFacts[];
  /** Domains another lane owns (config/expensive-sellers.yaml). */
  skipDomains?: readonly string[];
  /** Index demand this week (host -> checks), for ordering. */
  demand?: Map<string, number>;
}

export interface RetestLaneResult {
  allocations: PlanAllocation[];
  statuses: RetestStatus[];
  /** Avoid sellers this run does not buy, with why (written to the plan notes). */
  skipped: { domain: string; phase: RetestPhase; reason: string }[];
  weeklyRemainingAtomic: bigint;
}

/** The latest probe of a resource says it is worth paying: a 402 inside the cap that the probe did not call an overcharge. */
export function probeGate(db: Db, resourceId: number, capAtomic: bigint, now: number): { pass: boolean; reason: string } {
  const p = db.prepare("SELECT status, outcome, amount_atomic a, ts FROM probes WHERE resource_id = ? ORDER BY id DESC LIMIT 1").get(resourceId) as { status: number | null; outcome: string | null; a: string | null; ts: number } | undefined;
  if (!p || now - p.ts > PROBE_FRESH_MS) return { pass: true, reason: "no recent probe" };
  if (p.status !== 402) return { pass: false, reason: `latest probe status ${p.status ?? "none"}` };
  if (p.outcome === "overcharge") return { pass: false, reason: "latest probe quoted above the reference price" };
  if (p.a && /^\d+$/.test(p.a) && BigInt(p.a) > capAtomic) return { pass: false, reason: "latest probe quoted above the cap" };
  return { pass: true, reason: "probe 402 ok" };
}

/** The lane: ramp sellers first (finish what is started), then sentinels; within each, demand, then inflow, then the longest since a re-test. */
export function retestAllocations(db: Db, o: RetestLaneOptions): RetestLaneResult {
  const statuses = retestStatuses(db, { network: o.network, now: o.now });
  const weekSpent = spentAtomic(db, { since: o.now - 7 * DAY_MS, sources: [CALL_SOURCES.RETEST] });
  const weeklyRemaining = o.weeklyBudgetAtomic > weekSpent ? o.weeklyBudgetAtomic - weekSpent : 0n;
  const skip = new Set((o.skipDomains ?? []).map((d) => d.toLowerCase()));
  const facts = new Map(o.universe.map((s) => [s.sellerId, s]));
  const skipped: RetestLaneResult["skipped"] = [];
  const due: { st: RetestStatus; s: SellerFacts }[] = [];
  for (const st of statuses) {
    if (st.phase === "waiting" || st.phase === "dormant") {
      skipped.push({ domain: st.domain, phase: st.phase, reason: `cooldown until ${new Date(st.nextDueTs!).toISOString()} (cycle ${st.cycle})` });
      continue;
    }
    if (st.phase === "holding") {
      skipped.push({ domain: st.domain, phase: st.phase, reason: `window says ${st.verdict.windowVerdict}; the 7-day floor lifts ${new Date(st.lastFailureTs + AVOID_FLOOR_DAYS * DAY_MS).toISOString()}` });
      continue;
    }
    if (st.nextDueTs !== null) {
      skipped.push({ domain: st.domain, phase: st.phase, reason: `one sentinel a day, next ${new Date(st.nextDueTs).toISOString()}` });
      continue;
    }
    if (skip.has(st.domain.toLowerCase())) {
      skipped.push({ domain: st.domain, phase: st.phase, reason: "bought by the expensive-sellers lane" });
      continue;
    }
    const s = facts.get(st.sellerId);
    if (!s || !s.eligible.length) {
      skipped.push({ domain: st.domain, phase: st.phase, reason: "no resource under the cap, not excluded and not backed off" });
      continue;
    }
    due.push({ st, s });
  }
  const demandOf = (d: string) => o.demand?.get(d.toLowerCase()) ?? 0;
  due.sort(
    (a, b) =>
      (a.st.phase === "ramp" ? 0 : 1) - (b.st.phase === "ramp" ? 0 : 1) ||
      demandOf(b.st.domain) - demandOf(a.st.domain) ||
      (b.s.inflowAtomic > a.s.inflowAtomic ? 1 : b.s.inflowAtomic < a.s.inflowAtomic ? -1 : 0) ||
      (a.st.lastRetestTs ?? 0) - (b.st.lastRetestTs ?? 0) ||
      a.st.sellerId - b.st.sellerId,
  );

  const budget = o.budgetAtomic < weeklyRemaining ? o.budgetAtomic : weeklyRemaining;
  let spent = 0n;
  const allocations: PlanAllocation[] = [];
  for (const { st, s } of due) {
    const gated = s.eligible.filter((r) => r.priceAtomic <= o.perCallCapAtomic).map((r) => ({ r, g: probeGate(db, r.resourceId, o.perCallCapAtomic, o.now) }));
    const open = new Set(gated.filter((x) => x.g.pass).map((x) => x.r.resourceId));
    if (!open.size) {
      skipped.push({ domain: st.domain, phase: st.phase, reason: `probe gate: ${gated.map((x) => x.g.reason).join("; ") || "no resource"}` });
      continue;
    }
    const rot = rotationFor({ ...s, eligible: s.eligible.filter((r) => open.has(r.resourceId)) });
    const want = st.phase === "ramp" ? RAMP_MAX_PER_RUN : 1;
    const byResource = new Map<number, number>();
    let planned = 0n;
    let k = 0;
    while (k < want) {
      const r = rot[k % rot.length]!;
      const p = planPrice(r.priceAtomic);
      if (spent + p > budget || planned + p > o.sellerCapAtomic) break;
      byResource.set(r.resourceId, (byResource.get(r.resourceId) ?? 0) + 1);
      planned += p;
      spent += p;
      k++;
    }
    if (!k) {
      skipped.push({ domain: st.domain, phase: st.phase, reason: spent >= budget ? "re-test budget used up this run" : "one call is above the seller's run share" });
      continue;
    }
    for (const [resourceId, calls] of byResource) {
      const r = rot.find((x) => x.resourceId === resourceId)!;
      allocations.push({
        resourceId,
        sellerId: s.sellerId,
        sellerDomain: s.domain,
        url: r.url,
        method: r.method,
        inputJson: r.inputJson,
        tier: "retest",
        category: s.category,
        priceAtomic: r.priceAtomic,
        planAtomic: planPrice(r.priceAtomic),
        calls,
        source: CALL_SOURCES.RETEST,
        reason: `retest ${st.phase}: clean streak ${st.cleanStreak}, cycle ${st.cycle}, last failure ${new Date(st.lastFailureTs).toISOString()}`,
      });
    }
  }
  return { allocations, statuses, skipped, weeklyRemainingAtomic: weeklyRemaining };
}

/** The export's per-seller `retest` block. */
export function retestBlock(st: RetestStatus): {
  phase: RetestPhase;
  cycle: number;
  clean_streak: number;
  retest_calls: number;
  since: string | null;
  last_failure_ts: string;
  next_due_at: string | null;
} {
  const iso = (t: number | null) => (t === null ? null : new Date(t).toISOString());
  return {
    phase: st.phase,
    cycle: st.cycle,
    clean_streak: st.cleanStreak,
    retest_calls: st.retestCalls,
    since: iso(st.sinceTs),
    last_failure_ts: new Date(st.lastFailureTs).toISOString(),
    next_due_at: st.phase === "holding" ? iso(st.lastFailureTs + AVOID_FLOOR_DAYS * DAY_MS) : iso(st.nextDueTs),
  };
}
