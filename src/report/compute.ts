/**
 * computeReport: turns the named queries in queries.ts into one plain,
 * JSON-serialisable ReportData object. All atomic amounts are exact decimal
 * strings; rates are numbers in [0, 1].
 */
import { execSync } from "node:child_process";
import { atomicToUsd } from "../config/index.js";
import type { Db } from "../db/index.js";
import { DUPLICATE_RUN_WINDOW_S, HEADLINE_FAILURE_OUTCOMES, PAID_DENOMINATOR_OUTCOMES, type Outcome } from "../taxonomy.js";
import { runQuery, type QueryName, type QueryParams } from "./queries.js";
import { wilsonInterval } from "./wilson.js";

export const TOP_SELLERS_MIN_CALLS = 30;
export const TOP_SELLERS_LIMIT = 20;
export const KISH_NOTE = "Kish effective-n approximation";
export const CHAIN_CAVEAT = "delivery is invisible on-chain; these are floors";

export interface ComputeOptions {
  network: string;
  now: number;
  sinceMs?: number;
  untilMs?: number;
  /** Chain transfers below this are dust (address-poisoning spam) and ignored. Default: max dust_floor_atomic in payto_volume, else 0. */
  dustFloorAtomic?: bigint;
}

export interface CountRate { n: number; failures: number; rate: number; lo: number; hi: number }
export interface DollarRate {
  total_atomic: string;
  failed_atomic: string;
  rate: number;
  lo: number;
  hi: number;
  effective_n: number;
  note: string;
}
export interface GroupRow { key: string; n: number; failures: number; count: CountRate; dollar: DollarRate }
export interface SellerRow extends GroupRow { seller_id: number; domain: string; tier: string | null; category: string | null }

export interface SensitivityRow {
  min_ratio: string;
  overcharge_kept: number;
  overcharge_dropped: number;
  overcharge_unknown_ratio: number;
  count: CountRate;
  dollar_rate: number;
}

export interface ReportData {
  meta: {
    generated_at: string;
    network: string;
    params: { since_ms: number; until_ms: number; dust_floor_atomic: string; duplicate_run_window_s: number; top_sellers_min_calls: number };
    date_range: { first_call_ts: number | null; last_call_ts: number | null; first_call: string | null; last_call: string | null };
    config_hashes: string[];
    wallet_count: number;
    spend_atomic: string;
    spend_usdc: string;
    /** spent = sum of signed authorizations (upper bound); settled = sum of on-chain settlements matched to those calls (exact). */
    spend_by_source: { source: string; paid_calls: number; spent_atomic: string; spent_usdc: string; settled_atomic: string; settled_usdc: string }[];
    calls_by_source: Record<string, number>;
    calls_by_source_outcome: { source: string; outcome: string; n: number }[];
  };
  headline: {
    count: CountRate;
    dollar: DollarRate & { exposure_atomic: string };
    delivered_without_settlement: number;
    resolved_late_in_denominator: number;
    excluded: { our_error: number; indeterminate: number; not_paid: number; unclassified: number; unpaid_overcharge: number; exposure_atomic: string };
    our_error_reasons: { reason: string; n: number }[];
    /** non_delivery timeouts where our client gave up before the seller's declared window: possibly our fault, listed for transparency. */
    timeout_below_declared: number;
    flagged: { injection: number; injection_hit_total: number; note: string };
    /** Secondary flags among denominator rows (a row can carry several). */
    flag_counts: { flag: string; n: number; failed: number; dollars_atomic: string }[];
    sensitivity: SensitivityRow[];
  };
  by_failure_type: { outcome: string; n: number; share_of_calls: number; share_of_failures: number; dollars_atomic: string; resolved_late: number }[];
  by_tier: GroupRow[];
  by_category: GroupRow[];
  top_sellers: SellerRow[];
  stress: {
    duplicate: { intents: number; intents_with_second_settlement: number; rate: number; lo: number; hi: number };
    timeout: { intents: number; settled_despite_abort: number; intents_with_retry: number; second_settlement_on_retry: number };
  };
  chain_proxy: {
    window: { since_ms: number; until_ms: number; first_transfer_ts: number | null; last_transfer_ts: number | null };
    dust_floor_atomic: string;
    pay_tos: number;
    transfers: number;
    dust_transfers: number;
    total_atomic: string;
    overcharge_proxy: { count: number; sum_atomic: string; excess_atomic: string; count_rate: number; dollar_rate: number; method: string };
    duplicate_proxy: { runs: number; count: number; sum_atomic: string; count_rate: number; dollar_rate: number; window_s: number };
    per_pay_to: { pay_to: string; transfers: number; total_atomic: string; mode_atomic: string | null; over_mode: number; duplicates: number }[];
    caveat: string;
  };
  telemetry: { source_id: string; label: string | null; rows: number; n: number; failures: number; rate: number; lo: number; hi: number; excluded: number; injection: number }[];
  probes: { rounds: number; probes: number; ok: number; overcharge: number; our_error: number; price_discrimination: number; payto_changed: number; quote_drift: number };
  reproducibility: {
    config_hashes: string[];
    wallet_count: number;
    date_range: { first_call: string | null; last_call: string | null };
    spend_atomic: string;
    spend_usdc: string;
    schema_version: string | null;
    git_commit: string | null;
    runs: { id: number; subcommand: string; config_hash: string; network: string; dry_run: number; started_at: number; finished_at: number | null; status: string | null }[];
    halts: { id: number; run_id: number | null; ts: number; reason: string; details_json: string | null }[];
    query_names: QueryName[];
  };
  queries_used: Record<string, QueryName[]>;
}

// ------------------------------------------------------------------ helpers

const SCALE = 10n ** 15n;
/** num/den as a number via bigint (same precision as wilson.ts). */
export function bigRatio(num: bigint, den: bigint): number {
  if (den === 0n) return 0;
  return Number((num * SCALE) / den) / Number(SCALE);
}

const num = (v: unknown): number => (v == null ? 0 : Number(v));
const big = (v: unknown): bigint => (v == null || v === "" ? 0n : BigInt(String(v)));
const isoOrNull = (ms: number | null): string | null => (ms == null ? null : new Date(ms).toISOString());

export function countRate(failures: number, n: number): CountRate {
  const w = wilsonInterval(failures, n);
  return { n, failures, rate: w.p, lo: w.lo, hi: w.hi };
}

/**
 * Dollar-weighted rate with the Kish effective-n Wilson interval, from
 * aggregates (sum w, sum w over failures, sum w^2). Same formula as
 * wilson.ts dollarWeightedWilson, which needs the individual rows.
 */
export function dollarRate(totalAtomic: bigint, failedAtomic: bigint, sumSq: number): DollarRate {
  const base = { total_atomic: totalAtomic.toString(), failed_atomic: failedAtomic.toString(), note: KISH_NOTE };
  if (totalAtomic === 0n || !(sumSq > 0)) return { ...base, rate: 0, lo: 0, hi: 1, effective_n: 0 };
  const p = bigRatio(failedAtomic, totalAtomic);
  const t = Number(totalAtomic);
  const effectiveN = (t * t) / sumSq;
  const w = wilsonInterval(Math.min(effectiveN, Math.max(0, p * effectiveN)), effectiveN);
  return { ...base, rate: p, lo: w.lo, hi: w.hi, effective_n: effectiveN };
}

interface RateAgg { n: number; failures: number; w_sum: string; w_failed: string; w_sumsq: number }
function groupRow(key: string, r: RateAgg): GroupRow {
  return {
    key,
    n: num(r.n),
    failures: num(r.failures),
    count: countRate(num(r.failures), num(r.n)),
    dollar: dollarRate(big(r.w_sum), big(r.w_failed), num(r.w_sumsq)),
  };
}

function gitCommit(): string | null {
  try {
    return execSync("git rev-parse HEAD", { cwd: process.cwd(), stdio: ["ignore", "pipe", "ignore"] }).toString().trim() || null;
  } catch {
    return null;
  }
}

/** Mode of a value histogram (ties toward the lower value). */
export function modeOf(hist: { value: bigint; n: number }[]): bigint | null {
  let best: { value: bigint; n: number } | null = null;
  for (const h of hist) if (!best || h.n > best.n || (h.n === best.n && h.value < best.value)) best = h;
  return best ? best.value : null;
}

// ------------------------------------------------------------------ main

export function computeReport(db: Db, opts: ComputeOptions): ReportData {
  const since = opts.sinceMs ?? 0;
  const until = opts.untilMs ?? opts.now;
  const network = opts.network;
  const base: QueryParams = { since, until, network };
  const used: Record<string, QueryName[]> = {};
  const note = (section: string, ...names: QueryName[]): void => {
    const list = (used[section] ??= []);
    for (const name of names) if (!list.includes(name)) list.push(name);
  };
  const q = <T>(section: string, name: QueryName, extra: QueryParams = {}): T[] => {
    note(section, name);
    return runQuery<T>(db, name, { ...base, ...extra });
  };

  // ---- meta
  const bySourceOutcome = q<{ source: string; outcome: string; n: number }>("meta", "calls_by_source_outcome");
  const spendRows = q<{ source: string; paid_calls: number; spent_atomic: string; settled_atomic: string }>("meta", "spend_total");
  const wallets = num(q<{ wallets: number }>("meta", "wallets_used")[0]?.wallets);
  const dr = q<{ min_ts: number | null; max_ts: number | null }>("meta", "date_range")[0];
  const configHashes = q<{ config_hash: string }>("meta", "config_hashes").map((r) => r.config_hash);
  const spend = spendRows.reduce((a, r) => a + big(r.spent_atomic), 0n);

  // ---- chain proxy (computed early: its transfer count goes into calls_by_source)
  const pvw = q<{ dust_floor_atomic: string }>("chain_proxy", "payto_volume_windows");
  const dustFloor = opts.dustFloorAtomic ?? pvw.reduce((m, r) => (big(r.dust_floor_atomic) > m ? big(r.dust_floor_atomic) : m), 0n);
  const hist = q<{ pay_to: string; value_atomic: string; n: number }>("chain_proxy", "chain_proxy_overcharge");
  const totals = q<{ pay_to: string; n: number; first_ts: number; last_ts: number }>("chain_proxy", "chain_totals");
  const dupRows = q<{ id: number; to_addr: string; value_atomic: string; prev_id: number }>("chain_proxy", "chain_proxy_duplicate_runs", {
    window_ms: DUPLICATE_RUN_WINDOW_S * 1000,
  });

  const perPayTo = new Map<string, { hist: { value: bigint; n: number }[]; transfers: number; total: bigint; dust: number }>();
  for (const h of hist) {
    const v = big(h.value_atomic);
    const e = perPayTo.get(h.pay_to) ?? { hist: [], transfers: 0, total: 0n, dust: 0 };
    perPayTo.set(h.pay_to, e);
    if (v < dustFloor) {
      e.dust += num(h.n);
      continue;
    }
    e.hist.push({ value: v, n: num(h.n) });
    e.transfers += num(h.n);
    e.total += v * BigInt(num(h.n));
  }
  let chainTransfers = 0;
  let chainDust = 0;
  let chainTotal = 0n;
  let ocCount = 0;
  let ocSum = 0n;
  let ocExcess = 0n;
  const dupByPayTo = new Map<string, number>();
  const perPayToOut: ReportData["chain_proxy"]["per_pay_to"] = [];
  for (const [payTo, e] of perPayTo) {
    chainTransfers += e.transfers;
    chainDust += e.dust;
    chainTotal += e.total;
    const mode = modeOf(e.hist);
    let over = 0;
    if (mode != null)
      for (const h of e.hist)
        if (h.value > mode) {
          over += h.n;
          ocCount += h.n;
          ocSum += h.value * BigInt(h.n);
          ocExcess += (h.value - mode) * BigInt(h.n);
        }
    perPayToOut.push({ pay_to: payTo, transfers: e.transfers, total_atomic: e.total.toString(), mode_atomic: mode?.toString() ?? null, over_mode: over, duplicates: 0 });
  }
  const dupKept = dupRows.filter((r) => big(r.value_atomic) >= dustFloor);
  const dupIds = new Set(dupKept.map((r) => r.id));
  let dupSum = 0n;
  let dupRuns = 0;
  for (const r of dupKept) {
    dupSum += big(r.value_atomic);
    if (!dupIds.has(r.prev_id)) dupRuns++;
    dupByPayTo.set(r.to_addr, (dupByPayTo.get(r.to_addr) ?? 0) + 1);
  }
  for (const p of perPayToOut) p.duplicates = dupByPayTo.get(p.pay_to) ?? 0;
  const firstTs = totals.length ? Math.min(...totals.map((t) => num(t.first_ts))) : null;
  const lastTs = totals.length ? Math.max(...totals.map((t) => num(t.last_ts))) : null;

  // ---- telemetry (row count goes into calls_by_source)
  const telRows = q<{ source_id: string; outcome: string; n: number }>("telemetry", "telemetry_by_source_outcome");
  const telSources = q<{ source_id: string; label: string | null }>("telemetry", "telemetry_sources");

  const callsBySource: Record<string, number> = { buy: 0, stress_duplicate: 0, stress_timeout: 0 };
  for (const r of bySourceOutcome) callsBySource[r.source] = (callsBySource[r.source] ?? 0) + num(r.n);
  callsBySource.chain_proxy = chainTransfers;
  callsBySource.telemetry = telRows.reduce((a, r) => a + num(r.n), 0);
  note("meta", "chain_proxy_overcharge", "telemetry_by_source_outcome");

  // ---- headline
  const hc = q<RateAgg & { outcome: string; unconfirmed_settlement: number }>("headline", "buy_headline_counts");
  let n = 0;
  let failures = 0;
  let wSum = 0n;
  let wFailed = 0n;
  let wSq = 0;
  for (const r of hc) {
    n += num(r.n);
    wSum += big(r.w_sum);
    wSq += num(r.w_sumsq);
    if (HEADLINE_FAILURE_OUTCOMES.has(r.outcome as Outcome)) {
      failures += num(r.n);
      wFailed += big(r.w_sum);
    }
  }
  const ex = (q<Record<string, number | string>>("headline", "buy_excluded_counts")[0] ?? {}) as Record<string, number | string | null>;
  const exposure = big(ex.exposure_atomic);

  const ocRows = q<{ id: number; quote_amount_atomic: string | null; reference_price_atomic: string | null; w: string }>("headline", "buy_overcharge_ratios");
  const sensitivity: SensitivityRow[] = [
    { label: "1.1", numr: 11n, den: 10n },
    { label: "2.0", numr: 2n, den: 1n },
  ].map(({ label, numr, den }) => {
    let dropped = 0;
    let unknown = 0;
    let droppedW = 0n;
    for (const r of ocRows) {
      const quote = /^\d+$/.test(r.quote_amount_atomic ?? "") ? BigInt(r.quote_amount_atomic!) : null;
      const ref = /^\d+$/.test(r.reference_price_atomic ?? "") ? BigInt(r.reference_price_atomic!) : null;
      if (quote == null || ref == null || ref === 0n) {
        unknown++; // ratio cannot be computed: kept as a failure
        continue;
      }
      if (quote * den < ref * numr) {
        dropped++;
        droppedW += big(r.w);
      }
    }
    return {
      min_ratio: label,
      overcharge_kept: ocRows.length - dropped,
      overcharge_dropped: dropped,
      overcharge_unknown_ratio: unknown,
      count: countRate(failures - dropped, n),
      dollar_rate: bigRatio(wFailed - droppedW, wSum),
    };
  });

  const headline: ReportData["headline"] = {
    count: countRate(failures, n),
    dollar: { ...dollarRate(wSum, wFailed, wSq), exposure_atomic: exposure.toString() },
    delivered_without_settlement: num(ex.delivered_without_settlement),
    resolved_late_in_denominator: num(ex.resolved_late_in_denominator),
    excluded: {
      our_error: num(ex.our_error),
      indeterminate: num(ex.indeterminate),
      not_paid: num(ex.not_paid),
      unclassified: num(ex.unclassified),
      unpaid_overcharge: num(ex.unpaid_overcharge),
      exposure_atomic: exposure.toString(),
    },
    flagged: { injection: num(ex.injection), injection_hit_total: num(ex.injection_hit_total), note: "flagged for human review" },
    timeout_below_declared: num(q<{ n: number }>("headline", "buy_timeout_below_declared")[0]?.n),
    our_error_reasons: q<{ reason: string; n: number }>("headline", "buy_our_error_reasons").map((r) => ({ reason: r.reason, n: num(r.n) })),
    flag_counts: q<{ flag: string; n: number; failed: number; dollars_atomic: string }>("headline", "buy_flag_counts").map((r) => ({ flag: r.flag, n: num(r.n), failed: num(r.failed), dollars_atomic: big(r.dollars_atomic).toString() })),
    sensitivity,
  };

  // ---- breakdowns
  const ft = q<{ outcome: string; n: number; w_sum: string; resolved_late: number }>("by_failure_type", "buy_by_failure_type");
  const byFailureType = [...HEADLINE_FAILURE_OUTCOMES].map((o) => {
    const r = ft.find((x) => x.outcome === o);
    const k = num(r?.n);
    return { outcome: o, n: k, share_of_calls: n ? k / n : 0, share_of_failures: failures ? k / failures : 0, dollars_atomic: big(r?.w_sum).toString(), resolved_late: num(r?.resolved_late) };
  });
  const byTier = q<RateAgg & { grp: string }>("by_tier", "buy_by_tier").map((r) => groupRow(r.grp, r));
  const byCategory = q<RateAgg & { grp: string }>("by_category", "buy_by_category").map((r) => groupRow(r.grp, r));
  const topSellers: SellerRow[] = q<RateAgg & { seller_id: number; domain: string; tier: string | null; category: string | null }>(
    "top_sellers",
    "buy_sellers_min_calls",
    { min_calls: TOP_SELLERS_MIN_CALLS },
  )
    .map((r) => ({ ...groupRow(r.domain, r), seller_id: num(r.seller_id), domain: r.domain, tier: r.tier, category: r.category }))
    .sort((a, b) => b.count.rate - a.count.rate || b.n - a.n || a.domain.localeCompare(b.domain))
    .slice(0, TOP_SELLERS_LIMIT);

  // ---- stress
  type IntentRow = { intent_id: string; call_rows: number; retry_rows?: number; call_settlements: number; settlement_rows: number };
  const settlementsOf = (r: IntentRow) => Math.max(num(r.call_settlements), num(r.settlement_rows));
  const sd = q<IntentRow>("stress", "stress_duplicate_summary");
  const sdSecond = sd.filter((r) => settlementsOf(r) > 1).length;
  const sdw = wilsonInterval(sdSecond, sd.length);
  const st = q<IntentRow>("stress", "stress_timeout_summary");
  const stress: ReportData["stress"] = {
    duplicate: { intents: sd.length, intents_with_second_settlement: sdSecond, rate: sdw.p, lo: sdw.lo, hi: sdw.hi },
    timeout: {
      intents: st.length,
      settled_despite_abort: st.filter((r) => settlementsOf(r) >= 1).length,
      intents_with_retry: st.filter((r) => num(r.retry_rows) > 0).length,
      second_settlement_on_retry: st.filter((r) => num(r.retry_rows) > 0 && settlementsOf(r) >= 2).length,
    },
  };

  // ---- telemetry rates
  const telIds = [...new Set([...telSources.map((s) => s.source_id), ...telRows.map((r) => r.source_id)])].sort();
  const telemetry = telIds.map((id) => {
    const rows = telRows.filter((r) => r.source_id === id);
    let tn = 0;
    let tf = 0;
    let all = 0;
    let inj = 0;
    for (const r of rows) {
      all += num(r.n);
      if (PAID_DENOMINATOR_OUTCOMES.has(r.outcome as Outcome)) tn += num(r.n);
      if (HEADLINE_FAILURE_OUTCOMES.has(r.outcome as Outcome)) tf += num(r.n);
      if (r.outcome === "injection") inj += num(r.n);
    }
    const w = wilsonInterval(tf, tn);
    return { source_id: id, label: telSources.find((s) => s.source_id === id)?.label ?? null, rows: all, n: tn, failures: tf, rate: w.p, lo: w.lo, hi: w.hi, excluded: all - tn, injection: inj };
  });

  // ---- probes
  const ps = (q<Record<string, number>>("probes", "probes_summary")[0] ?? {}) as Record<string, number | null>;
  const probes = {
    rounds: num(ps.rounds),
    probes: num(ps.probes),
    ok: num(ps.ok),
    overcharge: num(ps.overcharge),
    our_error: num(ps.our_error),
    price_discrimination: num(ps.price_discrimination),
    payto_changed: num(ps.payto_changed),
    quote_drift: num(ps.quote_drift),
  };

  // ---- reproducibility
  const schemaVersion = q<{ value: string }>("reproducibility", "schema_version")[0]?.value ?? null;
  const runs = q<ReportData["reproducibility"]["runs"][number]>("reproducibility", "runs_list");
  const halts = q<ReportData["reproducibility"]["halts"][number]>("reproducibility", "halts_list");
  note("reproducibility", "config_hashes", "wallets_used", "date_range", "spend_total");

  const firstCall = dr?.min_ts ?? null;
  const lastCall = dr?.max_ts ?? null;
  const allNames = [...new Set(Object.values(used).flat())] as QueryName[];

  return {
    meta: {
      generated_at: new Date(opts.now).toISOString(),
      network,
      params: { since_ms: since, until_ms: until, dust_floor_atomic: dustFloor.toString(), duplicate_run_window_s: DUPLICATE_RUN_WINDOW_S, top_sellers_min_calls: TOP_SELLERS_MIN_CALLS },
      date_range: { first_call_ts: firstCall, last_call_ts: lastCall, first_call: isoOrNull(firstCall), last_call: isoOrNull(lastCall) },
      config_hashes: configHashes,
      wallet_count: wallets,
      spend_atomic: spend.toString(),
      spend_usdc: atomicToUsd(spend),
      spend_by_source: spendRows.map((r) => ({ source: r.source, paid_calls: num(r.paid_calls), spent_atomic: big(r.spent_atomic).toString(), spent_usdc: atomicToUsd(big(r.spent_atomic)), settled_atomic: big(r.settled_atomic).toString(), settled_usdc: atomicToUsd(big(r.settled_atomic)) })),
      calls_by_source: callsBySource,
      calls_by_source_outcome: bySourceOutcome.map((r) => ({ source: r.source, outcome: r.outcome, n: num(r.n) })),
    },
    headline,
    by_failure_type: byFailureType,
    by_tier: byTier,
    by_category: byCategory,
    top_sellers: topSellers,
    stress,
    chain_proxy: {
      window: { since_ms: since, until_ms: until, first_transfer_ts: firstTs, last_transfer_ts: lastTs },
      dust_floor_atomic: dustFloor.toString(),
      pay_tos: perPayTo.size,
      transfers: chainTransfers,
      dust_transfers: chainDust,
      total_atomic: chainTotal.toString(),
      overcharge_proxy: {
        count: ocCount,
        sum_atomic: ocSum.toString(),
        excess_atomic: ocExcess.toString(),
        count_rate: chainTransfers ? ocCount / chainTransfers : 0,
        dollar_rate: bigRatio(ocSum, chainTotal),
        method: "per pay_to modal value (JS, ties to lower value, dust removed); transfers strictly above the mode",
      },
      duplicate_proxy: {
        runs: dupRuns,
        count: dupKept.length,
        sum_atomic: dupSum.toString(),
        count_rate: chainTransfers ? dupKept.length / chainTransfers : 0,
        dollar_rate: bigRatio(dupSum, chainTotal),
        window_s: DUPLICATE_RUN_WINDOW_S,
      },
      per_pay_to: perPayToOut.sort((a, b) => a.pay_to.localeCompare(b.pay_to)),
      caveat: CHAIN_CAVEAT,
    },
    telemetry,
    probes,
    reproducibility: {
      config_hashes: configHashes,
      wallet_count: wallets,
      date_range: { first_call: isoOrNull(firstCall), last_call: isoOrNull(lastCall) },
      spend_atomic: spend.toString(),
      spend_usdc: atomicToUsd(spend),
      schema_version: schemaVersion,
      git_commit: gitCommit(),
      runs: runs.map((r) => ({ ...r })),
      halts: halts.map((h) => ({ ...h })),
      query_names: allNames,
    },
    queries_used: used,
  };
}
