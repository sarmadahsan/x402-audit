/**
 * Market-wide proxy floors from on-chain transfers (module 5 `chain report`).
 *
 * Universe: the top N pay-tos by payto_volume (topPayTos), each restricted to its own latest payto_volume
 * block window, value >= dust floor. Three views:
 *   - "verified": only rows with via_authorization = 1 (an AuthorizationUsed from the same sender in the
 *     same tx), i.e. EIP-3009 settlements. Empty until `verifySample` / `verifyAll` have run.
 *   - "share-adjusted": per pay-to, (a) every non-dust row checked (no via_authorization NULL) -> its
 *     via_authorization = 1 rows; else (b) sampled EIP-3009 share Wilson lower bound >= SHARE_ADJUST_MIN_LO
 *     (0.95) -> all its non-dust rows, assumed x402 settlements; else its verified rows only, flagged
 *     "partially verified". The rule is chosen in JS and passed per pay-to in @universe (`verified_only`).
 *   - "all non-dust": every such transfer, verified or not (unchecked rows can include unrelated transfers);
 *     not x402-filtered, shown for transparency only, not a floor.
 *
 * Proxies per pay-to (all from the SQL constants below; mode and sums are taken in JS with bigint because
 * value_atomic is TEXT):
 *   - overcharge: transfers with value > mode, and > 2 x mode (stricter), where mode = most frequent value
 *     (ties -> lower value);
 *   - duplicate loop: order rows by (from_addr, to_addr, value_atomic, block_ts); a row whose predecessor in
 *     that group is at most windowS seconds earlier is a "duplicate-run follower"; a run is a maximal chain
 *     of followers (counted once);
 *   - isolated duplicate pair (stricter): a (from, to, value) run of exactly 2 transfers at most windowS apart
 *     where the payer made no other transfer to that payee within ISOLATION_S (1 h) before the first or after
 *     the second: a lone retry, not a high-frequency consumer.
 * These are floors with large caveats (CHAIN_CAVEATS), never outcomes.
 *
 * Relation to src/report/queries.ts: that file exports `chain_proxy_overcharge` and
 * `chain_proxy_duplicate_runs` over the whole time window with no universe, dust or verified restriction
 * (and the duplicate query returns row-level followers). They do not match what this report needs, so the
 * queries here keep the same names (in CHAIN_PROXY_QUERIES) for a later merge.
 */
import type { Db } from "../db/index.js";
import { atomicToUsd } from "../config/index.js";
import { dollarWeightedWilson, wilsonInterval, type Interval, type WeightedRow } from "../report/wilson.js";
import { DUPLICATE_RUN_WINDOW_S } from "../taxonomy.js";
import { topPayTos } from "./rank.js";
import { EIP3009_SHARE_META_PREFIX, type SampleStat } from "./verify.js";

/**
 * Shared CTE `x`: universe rows. Parameters:
 *   @network, @universe (JSON array of {pay_to, from_block, to_block}), @dust_floor (atomic integer),
 *   @verified_only (0 = all non-dust rows, 1 = via_authorization = 1 only). A universe entry may carry its
 *   own `verified_only` (0/1), which overrides @verified_only for that pay-to (used by the share-adjusted view).
 */
export const CHAIN_PROXY_UNIVERSE_CTE = `WITH u AS (
    SELECT LOWER(json_extract(value, '$.pay_to')) AS pay_to,
           json_extract(value, '$.from_block') AS from_block,
           json_extract(value, '$.to_block') AS to_block,
           json_extract(value, '$.verified_only') AS verified_only
    FROM json_each(@universe)
  ), x AS (
    SELECT c.id, c.tx_hash, c.log_index, c.block_number, c.block_ts, c.from_addr, c.to_addr, c.value_atomic, c.via_authorization
    FROM chain_transfers c JOIN u ON c.to_addr = u.pay_to AND c.block_number BETWEEN u.from_block AND u.to_block
    WHERE c.network = @network
      AND (length(c.value_atomic) > 18 OR CAST(c.value_atomic AS INTEGER) >= @dust_floor)
      AND (COALESCE(u.verified_only, @verified_only) = 0 OR c.via_authorization = 1)
  )`;

export const CHAIN_PROXY_QUERIES = {
  /** Per pay-to totals over the universe view. */
  chain_proxy_totals: `${CHAIN_PROXY_UNIVERSE_CTE}
    SELECT to_addr AS pay_to, COUNT(*) AS n, COUNT(DISTINCT from_addr) AS payers,
      COALESCE(SUM(via_authorization = 1), 0) AS verified, COALESCE(SUM(via_authorization = 0), 0) AS plain,
      COALESCE(SUM(via_authorization IS NULL), 0) AS unchecked,
      MIN(block_number) AS first_block, MAX(block_number) AS last_block, MIN(block_ts) AS first_ts, MAX(block_ts) AS last_ts
    FROM x GROUP BY to_addr ORDER BY to_addr`,

  /** Per pay-to value histogram; mode, sum, > mode and > 2 x mode are computed from it in JS (bigint). */
  chain_proxy_overcharge: `${CHAIN_PROXY_UNIVERSE_CTE}
    SELECT to_addr AS pay_to, value_atomic, COUNT(*) AS n
    FROM x GROUP BY to_addr, value_atomic ORDER BY to_addr, value_atomic`,

  /**
   * Duplicate-run followers per (pay_to, value): within (from_addr, to_addr, value_atomic) ordered by
   * (block_ts, block_number, log_index, id), a row is a follower when its predecessor is at most @window_ms
   * earlier (block_ts is unix ms). A run starts at a follower whose own predecessor is not a follower.
   */
  chain_proxy_duplicate_runs: `${CHAIN_PROXY_UNIVERSE_CTE}, l AS (
      SELECT id, from_addr, to_addr, value_atomic, block_ts, block_number, log_index,
        LAG(block_ts) OVER w AS prev_ts
      FROM x WINDOW w AS (PARTITION BY from_addr, to_addr, value_atomic ORDER BY block_ts, block_number, log_index, id)
    ), f AS (
      SELECT l.*, CASE WHEN prev_ts IS NOT NULL AND block_ts - prev_ts <= @window_ms THEN 1 ELSE 0 END AS follower FROM l
    ), r AS (
      SELECT to_addr, value_atomic, follower,
        LAG(follower, 1, 0) OVER w2 AS prev_follower
      FROM f WINDOW w2 AS (PARTITION BY from_addr, to_addr, value_atomic ORDER BY block_ts, block_number, log_index, id)
    )
    SELECT to_addr AS pay_to, value_atomic, SUM(follower) AS followers,
      SUM(CASE WHEN follower = 1 AND prev_follower = 0 THEN 1 ELSE 0 END) AS runs
    FROM r GROUP BY to_addr, value_atomic HAVING SUM(follower) > 0 ORDER BY to_addr, value_atomic`,

  /**
   * Isolated duplicate pairs per (pay_to, value). Two window passes over the view rows, both ordered by
   * (block_ts, block_number, log_index, id):
   *   - `PARTITION BY from_addr, to_addr, value_atomic` (the run): v_prev_ts / v_prev2_ts / v_next_ts;
   *     a row closes a run of exactly 2 when its predecessor is at most @window_ms earlier, the
   *     predecessor's own predecessor is more than @window_ms before it (or absent), and the next same-value
   *     row is more than @window_ms later (or absent);
   *   - `PARTITION BY from_addr, to_addr` (any value, the neighbour check): the pair must be adjacent
   *     (the row's any-value predecessor is the first of the pair, i.e. same ts and value), with no other
   *     transfer from that payer to that payee within @isolation_ms before the first (a_prev2_ts) or after
   *     the second (a_next_ts).
   * One row per pair (its second transfer); `pairs` is also the follower count, dollars = value x pairs.
   */
  chain_proxy_isolated_pairs: `${CHAIN_PROXY_UNIVERSE_CTE}, w AS (
      SELECT id, from_addr, to_addr, value_atomic, block_ts,
        LAG(block_ts, 1) OVER wv AS v_prev_ts,
        LAG(block_ts, 2) OVER wv AS v_prev2_ts,
        LEAD(block_ts, 1) OVER wv AS v_next_ts,
        LAG(id, 1) OVER wv AS v_prev_id,
        LAG(id, 1) OVER wa AS a_prev_id,
        LAG(block_ts, 2) OVER wa AS a_prev2_ts,
        LEAD(block_ts, 1) OVER wa AS a_next_ts
      FROM x
      WINDOW wv AS (PARTITION BY from_addr, to_addr, value_atomic ORDER BY block_ts, block_number, log_index, id),
             wa AS (PARTITION BY from_addr, to_addr ORDER BY block_ts, block_number, log_index, id)
    ), p AS (
      SELECT to_addr, value_atomic FROM w
      WHERE v_prev_ts IS NOT NULL AND block_ts - v_prev_ts <= @window_ms
        AND (v_prev2_ts IS NULL OR v_prev_ts - v_prev2_ts > @window_ms)
        AND (v_next_ts IS NULL OR v_next_ts - block_ts > @window_ms)
        AND a_prev_id = v_prev_id
        AND (a_prev2_ts IS NULL OR v_prev_ts - a_prev2_ts > @isolation_ms)
        AND (a_next_ts IS NULL OR a_next_ts - block_ts > @isolation_ms)
    )
    SELECT to_addr AS pay_to, value_atomic, COUNT(*) AS pairs
    FROM p GROUP BY to_addr, value_atomic ORDER BY to_addr, value_atomic`,
} as const;
export type ChainProxyQueryName = keyof typeof CHAIN_PROXY_QUERIES;

/** Isolation window for `chain_proxy_isolated_pairs`: no other transfer payer -> payee within 1 h either side. */
export const ISOLATION_S = 3600;
/** Share-adjusted rule (b): sampled EIP-3009 share Wilson lower bound at or above this -> all rows count. */
export const SHARE_ADJUST_MIN_LO = 0.95;

export interface UniverseEntry {
  pay_to: string;
  from_block: number;
  to_block: number;
  /** Per pay-to override of ChainProxyParams.verifiedOnly (0/1). */
  verified_only?: 0 | 1;
}
export interface ChainProxyParams {
  network: string;
  universe: UniverseEntry[];
  dustFloorAtomic: bigint;
  verifiedOnly: boolean;
  windowMs: number;
  /** Default ISOLATION_S * 1000. */
  isolationMs?: number;
}

export function runChainProxyQuery<T>(db: Db, name: ChainProxyQueryName, p: ChainProxyParams): T[] {
  const bound: Record<string, unknown> = {
    network: p.network,
    universe: JSON.stringify(p.universe),
    dust_floor: p.dustFloorAtomic,
    verified_only: p.verifiedOnly ? 1 : 0,
  };
  if (name === "chain_proxy_duplicate_runs" || name === "chain_proxy_isolated_pairs") bound.window_ms = p.windowMs;
  if (name === "chain_proxy_isolated_pairs") bound.isolation_ms = p.isolationMs ?? ISOLATION_S * 1000;
  return db.prepare(CHAIN_PROXY_QUERIES[name]).all(bound) as T[];
}

export const CHAIN_CAVEATS: readonly string[] = [
  "Delivery is invisible on-chain: these numbers say nothing about whether the buyer received what they paid for.",
  "These are floors, not failure rates: only patterns visible in transfers are counted, and every proxy can miss real failures.",
  "A payment above the mode may be a legitimately different product or a dynamic price, not an overcharge.",
  "A repeated identical transfer within 120 s may be a legitimate second purchase, not a duplicate charge.",
  "Isolated duplicate pairs (a lone repeat within 120 s with nothing else from that payer to that payee for 1 h either side) are the stricter duplicate proxy; they can still be deliberate repeat purchases.",
  "In the share-adjusted view, pay-tos whose sampled EIP-3009 share has a Wilson lower bound >= 95% have all their non-dust rows counted as x402 settlements (an assumption: a few unrelated transfers may remain); other unverified pay-tos contribute only verified rows.",
  "Dust and unrelated transfers are excluded by the dust floor and (where verified) by the AuthorizationUsed join; in the all non-dust view, unrelated transfers above the floor remain.",
];

export interface ProxyCount {
  count: number;
  atomic: bigint;
}
export interface PayToProxies {
  payTo: string;
  sellerDomains: string[];
  transfers: number;
  sumAtomic: bigint;
  uniquePayers: number;
  verifiedRows: number;
  plainRows: number;
  uncheckedRows: number;
  /** null when the pay-to has no rows in this view. */
  modeAtomic: bigint | null;
  overMode: ProxyCount;
  over2xMode: ProxyCount;
  dupFollowers: ProxyCount;
  dupRuns: number;
  /** Isolated duplicate pairs: count = pairs (= followers in pairs), atomic = value of the second transfers. */
  isolatedPairs: ProxyCount;
  eip3009: SampleStat | null;
}
export interface RatePair {
  count: Interval & { k: number; n: number };
  dollar: Interval & { effectiveN: number; atomic: bigint; totalAtomic: bigint };
  /** Pay-tos with at least one flagged transfer. */
  payTos: number;
}
export interface MarketRates {
  n: number;
  sumAtomic: bigint;
  /** Pay-tos with at least one row in this view. */
  payTos: number;
  overMode: RatePair;
  over2xMode: RatePair;
  duplicate: RatePair;
  isolatedPairs: RatePair;
}
export type ProxyViewLabel = "all non-dust" | "verified (AuthorizationUsed)" | "share-adjusted";
export interface ProxyView {
  label: ProxyViewLabel;
  rows: PayToProxies[];
  market: MarketRates;
}
/**
 * Share-adjusted rule per pay-to:
 *   - "fully-verified": every non-dust row checked; its via_authorization = 1 rows are used;
 *   - "high-share": sampled EIP-3009 share Wilson lo >= SHARE_ADJUST_MIN_LO; all non-dust rows used (assumed x402);
 *   - "partial": neither; only its verified rows are used (flagged "partially verified");
 *   - "empty": no non-dust rows in the window.
 */
export type ShareAdjustRule = "fully-verified" | "high-share" | "partial" | "empty";
export interface ShareAdjustDecision {
  payTo: string;
  rule: ShareAdjustRule;
  /** Non-dust rows in the window (all view). */
  nonDustRows: number;
  uncheckedRows: number;
  verifiedRows: number;
  /** Rows this pay-to contributes to the share-adjusted view. */
  includedRows: number;
  shareLo: number | null;
}
export interface ChainProxyData {
  network: string;
  dustFloorAtomic: bigint;
  windowS: number;
  topN: number;
  window: { fromBlock: number; toBlock: number; fromTs: number; toTs: number; uniform: boolean } | null;
  universePayTos: number;
  verified: ProxyView;
  shareAdjusted: ProxyView;
  /** Not x402-filtered; transparency only, not a floor. */
  all: ProxyView;
  shareRules: ShareAdjustDecision[];
  shareAdjustMinLo: number;
  isolationS: number;
  /** shareAdjusted.market when it has rows, else verified.market when it has rows, else null. */
  adjusted: MarketRates | null;
  adjustedBasis: "share-adjusted" | "verified" | null;
  eip3009: SampleStat[];
  queryNames: ChainProxyQueryName[];
}

function modeOf(hist: readonly { v: bigint; n: number }[]): bigint | null {
  let best: { v: bigint; n: number } | null = null;
  for (const h of hist) if (!best || h.n > best.n || (h.n === best.n && h.v < best.v)) best = h;
  return best ? best.v : null;
}

function rate(k: number, n: number, rows: WeightedRow[], payTos: number): RatePair {
  const d = dollarWeightedWilson(rows);
  let atomic = 0n;
  let total = 0n;
  for (const r of rows) {
    total += r.weightAtomic;
    if (r.failed) atomic += r.weightAtomic;
  }
  return { count: { ...wilsonInterval(k, n), k, n }, dollar: { ...d, atomic, totalAtomic: total }, payTos };
}

/** One WeightedRow per transfer; `failed(v, i)` marks the i-th of the bucket's n rows. */
function pushRows(out: WeightedRow[], v: bigint, n: number, failedCount: number): void {
  for (let i = 0; i < n; i++) out.push({ weightAtomic: v, failed: i < failedCount });
}

function buildView(
  db: Db,
  label: ProxyView["label"],
  p: ChainProxyParams,
  meta: Map<string, { domains: string[]; eip: SampleStat | null }>,
  order: string[],
): ProxyView {
  const totals = runChainProxyQuery<{ pay_to: string; n: number; payers: number; verified: number; plain: number; unchecked: number }>(db, "chain_proxy_totals", p);
  const histRows = runChainProxyQuery<{ pay_to: string; value_atomic: string; n: number }>(db, "chain_proxy_overcharge", p);
  const dupRows = runChainProxyQuery<{ pay_to: string; value_atomic: string; followers: number; runs: number }>(db, "chain_proxy_duplicate_runs", p);
  const pairRows = runChainProxyQuery<{ pay_to: string; value_atomic: string; pairs: number }>(db, "chain_proxy_isolated_pairs", p);

  const hist = new Map<string, { v: bigint; n: number }[]>();
  for (const h of histRows) {
    const a = hist.get(h.pay_to) ?? [];
    a.push({ v: BigInt(h.value_atomic), n: h.n });
    hist.set(h.pay_to, a);
  }
  const dup = new Map<string, Map<bigint, { followers: number; runs: number }>>();
  for (const d of dupRows) {
    const m = dup.get(d.pay_to) ?? new Map();
    m.set(BigInt(d.value_atomic), { followers: d.followers, runs: d.runs });
    dup.set(d.pay_to, m);
  }
  const pairs = new Map<string, Map<bigint, number>>();
  for (const d of pairRows) {
    const m = pairs.get(d.pay_to) ?? new Map();
    m.set(BigInt(d.value_atomic), d.pairs);
    pairs.set(d.pay_to, m);
  }
  const tot = new Map(totals.map((t) => [t.pay_to, t]));

  const wOver: WeightedRow[] = [];
  const wOver2: WeightedRow[] = [];
  const wDup: WeightedRow[] = [];
  const wPair: WeightedRow[] = [];
  let nAll = 0;
  let sumAll = 0n;
  let kOver = 0;
  let kOver2 = 0;
  let kDup = 0;
  let kPair = 0;
  const pt = { rows: 0, over: 0, over2: 0, dup: 0, pair: 0 };
  const rows: PayToProxies[] = [];
  for (const payTo of order) {
    const h = hist.get(payTo) ?? [];
    const t = tot.get(payTo);
    const mode = modeOf(h);
    const r: PayToProxies = {
      payTo,
      sellerDomains: meta.get(payTo)?.domains ?? [],
      transfers: t?.n ?? 0,
      sumAtomic: 0n,
      uniquePayers: t?.payers ?? 0,
      verifiedRows: t?.verified ?? 0,
      plainRows: t?.plain ?? 0,
      uncheckedRows: t?.unchecked ?? 0,
      modeAtomic: mode,
      overMode: { count: 0, atomic: 0n },
      over2xMode: { count: 0, atomic: 0n },
      dupFollowers: { count: 0, atomic: 0n },
      dupRuns: 0,
      isolatedPairs: { count: 0, atomic: 0n },
      eip3009: meta.get(payTo)?.eip ?? null,
    };
    const dm = dup.get(payTo);
    const pm = pairs.get(payTo);
    for (const { v, n } of h) {
      r.sumAtomic += v * BigInt(n);
      const over = mode !== null && v > mode;
      const over2 = mode !== null && v > 2n * mode;
      if (over) {
        r.overMode.count += n;
        r.overMode.atomic += v * BigInt(n);
      }
      if (over2) {
        r.over2xMode.count += n;
        r.over2xMode.atomic += v * BigInt(n);
      }
      const d = dm?.get(v);
      const f = d?.followers ?? 0;
      if (d) {
        r.dupFollowers.count += f;
        r.dupFollowers.atomic += v * BigInt(f);
        r.dupRuns += d.runs;
      }
      const np = pm?.get(v) ?? 0;
      r.isolatedPairs.count += np;
      r.isolatedPairs.atomic += v * BigInt(np);
      pushRows(wOver, v, n, over ? n : 0);
      pushRows(wOver2, v, n, over2 ? n : 0);
      pushRows(wDup, v, n, f);
      pushRows(wPair, v, n, np);
    }
    nAll += r.transfers;
    sumAll += r.sumAtomic;
    kOver += r.overMode.count;
    kOver2 += r.over2xMode.count;
    kDup += r.dupFollowers.count;
    kPair += r.isolatedPairs.count;
    if (r.transfers > 0) pt.rows++;
    if (r.overMode.count > 0) pt.over++;
    if (r.over2xMode.count > 0) pt.over2++;
    if (r.dupFollowers.count > 0) pt.dup++;
    if (r.isolatedPairs.count > 0) pt.pair++;
    rows.push(r);
  }
  return {
    label,
    rows,
    market: {
      n: nAll,
      sumAtomic: sumAll,
      payTos: pt.rows,
      overMode: rate(kOver, nAll, wOver, pt.over),
      over2xMode: rate(kOver2, nAll, wOver2, pt.over2),
      duplicate: rate(kDup, nAll, wDup, pt.dup),
      isolatedPairs: rate(kPair, nAll, wPair, pt.pair),
    },
  };
}

/** Every eip3009_share_<network>_<payTo> meta row, keyed by pay-to. */
export function readEip3009Shares(db: Db, network: string): Map<string, SampleStat> {
  const prefix = `${EIP3009_SHARE_META_PREFIX}${network}_`;
  const rows = db.prepare("SELECT key, value FROM meta WHERE substr(key, 1, ?) = ?").all(prefix.length, prefix) as { key: string; value: string }[];
  const out = new Map<string, SampleStat>();
  for (const r of rows) {
    try {
      const v = JSON.parse(r.value) as SampleStat;
      out.set(r.key.slice(prefix.length).toLowerCase(), v);
    } catch {
      /* malformed meta row: ignore */
    }
  }
  return out;
}

export function computeChainProxies(
  db: Db,
  o: { network: string; dustFloorAtomic?: bigint; windowS?: number; topN?: number; isolationS?: number; shareAdjustMinLo?: number },
): ChainProxyData {
  const { network, dustFloorAtomic = 100n, windowS = DUPLICATE_RUN_WINDOW_S, topN = 60, isolationS = ISOLATION_S, shareAdjustMinLo = SHARE_ADJUST_MIN_LO } = o;
  const top = topPayTos(db, { network, n: topN });
  const shares = readEip3009Shares(db, network);
  const universe: UniverseEntry[] = top.map((t) => ({ pay_to: t.payTo, from_block: t.fromBlock, to_block: t.toBlock }));
  const order = top.map((t) => t.payTo);
  const meta = new Map(top.map((t) => [t.payTo, { domains: t.sellerDomains, eip: shares.get(t.payTo) ?? null }]));

  let window: ChainProxyData["window"] = null;
  if (top.length) {
    const tsQ = db.prepare("SELECT from_ts, to_ts FROM payto_volume WHERE network = ? AND LOWER(pay_to) = ? AND from_block = ? AND to_block = ?");
    let fromTs = Infinity;
    let toTs = -Infinity;
    for (const t of top) {
      const r = tsQ.get(network, t.payTo, t.fromBlock, t.toBlock) as { from_ts: number; to_ts: number } | undefined;
      if (r) {
        fromTs = Math.min(fromTs, r.from_ts);
        toTs = Math.max(toTs, r.to_ts);
      }
    }
    window = {
      fromBlock: Math.min(...top.map((t) => t.fromBlock)),
      toBlock: Math.max(...top.map((t) => t.toBlock)),
      fromTs: Number.isFinite(fromTs) ? fromTs : 0,
      toTs: Number.isFinite(toTs) ? toTs : 0,
      uniform: top.every((t) => t.fromBlock === top[0]!.fromBlock && t.toBlock === top[0]!.toBlock),
    };
  }

  const base = { network, universe, dustFloorAtomic, windowMs: windowS * 1000, isolationMs: isolationS * 1000 };
  const all = buildView(db, "all non-dust", { ...base, verifiedOnly: false }, meta, order);
  const verified = buildView(db, "verified (AuthorizationUsed)", { ...base, verifiedOnly: true }, meta, order);

  const allBy = new Map(all.rows.map((r) => [r.payTo, r]));
  const verBy = new Map(verified.rows.map((r) => [r.payTo, r]));
  const shareRules: ShareAdjustDecision[] = order.map((payTo) => {
    const a = allBy.get(payTo)!;
    const eip = meta.get(payTo)?.eip ?? null;
    const shareLo = eip && eip.sampled > 0 ? eip.lo : null;
    const rule: ShareAdjustRule =
      a.transfers === 0 ? "empty" : a.uncheckedRows === 0 ? "fully-verified" : shareLo !== null && shareLo >= shareAdjustMinLo ? "high-share" : "partial";
    return {
      payTo,
      rule,
      nonDustRows: a.transfers,
      uncheckedRows: a.uncheckedRows,
      verifiedRows: a.verifiedRows,
      includedRows: rule === "high-share" ? a.transfers : (verBy.get(payTo)?.transfers ?? 0),
      shareLo,
    };
  });
  const ruleBy = new Map(shareRules.map((r) => [r.payTo, r.rule]));
  const adjUniverse: UniverseEntry[] = universe.map((u) => ({ ...u, verified_only: ruleBy.get(u.pay_to) === "high-share" ? 0 : 1 }));
  const shareAdjusted = buildView(db, "share-adjusted", { ...base, universe: adjUniverse, verifiedOnly: true }, meta, order);
  const adjusted = shareAdjusted.market.n > 0 ? shareAdjusted.market : verified.market.n > 0 ? verified.market : null;
  return {
    network,
    dustFloorAtomic,
    windowS,
    topN,
    window,
    universePayTos: top.length,
    verified,
    shareAdjusted,
    all,
    shareRules,
    shareAdjustMinLo,
    isolationS,
    adjusted,
    adjustedBasis: adjusted === null ? null : adjusted === shareAdjusted.market ? "share-adjusted" : "verified",
    eip3009: order.map((p) => shares.get(p)).filter((s): s is SampleStat => !!s),
    queryNames: Object.keys(CHAIN_PROXY_QUERIES) as ChainProxyQueryName[],
  };
}

// ------------------------------------------------------------------ render

const pct = (x: number) => `${(x * 100).toFixed(2)}%`;
const ci = (i: Interval) => `[${pct(i.lo)}, ${pct(i.hi)}]`;
const usd = (a: bigint) => `$${atomicToUsd(a)}`;
const iso = (ms: number) => (ms > 0 ? new Date(ms).toISOString() : "n/a");
const share = (k: number, n: number) => (n > 0 ? pct(k / n) : "n/a");

export const ALL_VIEW_TABLE_LABEL = "all non-dust (not x402-filtered; shown for transparency only, not a floor)";
export const SHARE_RULE_LABELS: Record<ShareAdjustRule, string> = {
  "fully-verified": "(a) fully verified: via_authorization = 1 rows",
  "high-share": "(b) sampled share lo >= 95%: all non-dust rows, assumed x402",
  partial: "partially verified: verified rows only",
  empty: "no non-dust rows",
};

type Proxy = "overMode" | "over2xMode" | "duplicate" | "isolatedPairs";
const PROXY_ROWS: [Proxy, string][] = [
  ["overMode", "overcharge proxy: value > mode"],
  ["over2xMode", "overcharge proxy: value > 2 x mode"],
  ["duplicate", "duplicate-run followers"],
  ["isolatedPairs", "isolated duplicate pairs (lone retry)"],
];

function marketTable(title: string, views: { label: string; m: MarketRates }[], dollars: boolean): string[] {
  const cell = (m: MarketRates, r: RatePair) => {
    if (m.n === 0) return "n/a (no rows)";
    const x = dollars ? r.dollar : r.count;
    const k = dollars ? usd(r.dollar.atomic) : String(r.count.k);
    return `${pct(x.p)} ${ci(x)} (${k})`;
  };
  const head = views.map((v) => `${v.label} (${dollars ? usd(v.m.sumAtomic) : `n = ${v.m.n}`}, ${v.m.payTos} pay-tos) | pay-tos`).join(" | ");
  return [
    `### ${title}`,
    "",
    `| proxy | ${head} |`,
    `|---|${views.map(() => "---|---|").join("")}`,
    ...PROXY_ROWS.map(([key, name]) => `| ${name} | ${views.map((v) => `${cell(v.m, v.m[key])} | ${v.m.n === 0 ? "-" : v.m[key].payTos}`).join(" | ")} |`),
    "",
  ];
}

export function renderChainReport(d: ChainProxyData): string {
  const L: string[] = [];
  L.push(`# Chain proxy floors (${d.network})`, "");
  if (d.window) {
    L.push(
      `- Window: blocks ${d.window.fromBlock}..${d.window.toBlock}, ${iso(d.window.fromTs)} to ${iso(d.window.toTs)}` +
        (d.window.uniform ? "" : " (pay-tos use their own latest scanned window; the range shown is the union)"),
    );
  } else L.push("- Window: no payto_volume rows; run `chain scan-volume` first.");
  const counts = { "fully-verified": 0, "high-share": 0, partial: 0, empty: 0 } as Record<ShareAdjustRule, number>;
  for (const r of d.shareRules) counts[r.rule]++;
  L.push(
    `- Universe: top ${d.universePayTos} pay-to addresses by scanned USDC volume (requested ${d.topN}), transfers with value >= ${d.dustFloorAtomic} atomic units (dust floor).`,
    `- Verified view: ${d.verified.market.n} transfers, ${usd(d.verified.market.sumAtomic)}, ${d.verified.market.payTos} pay-tos. Only rows whose tx has AuthorizationUsed from the same sender (EIP-3009 settlements).`,
    `- Share-adjusted view: ${d.shareAdjusted.market.n} transfers, ${usd(d.shareAdjusted.market.sumAtomic)}, ${d.shareAdjusted.market.payTos} pay-tos. ` +
      `Per pay-to: (a) every non-dust row checked -> its verified rows (${counts["fully-verified"]} pay-tos); ` +
      `(b) sampled EIP-3009 share Wilson lower bound >= ${pct(d.shareAdjustMinLo)} -> all its non-dust rows, assumed to be x402 settlements (${counts["high-share"]}); ` +
      `otherwise verified rows only, "partially verified" (${counts.partial}); no rows (${counts.empty}).`,
    `- All non-dust view: ${d.all.market.n} transfers, ${usd(d.all.market.sumAtomic)}, ${d.all.market.payTos} pay-tos. Not x402-filtered (includes unverified rows and plain transfers); shown for transparency only, not a floor.`,
    `- Duplicate window: ${d.windowS} s; isolated pairs also need no other transfer from that payer to that payee within ${d.isolationS} s before the first or after the second. Intervals: Wilson 95%; dollar-weighted intervals are approximate (Kish effective n).`,
    `- Named queries: ${d.queryNames.map((q) => `\`${q}\``).join(", ")} (src/chain/report.ts).`,
    "",
  );

  const views = [
    { label: "verified only", m: d.verified.market },
    { label: "share-adjusted", m: d.shareAdjusted.market },
    { label: ALL_VIEW_TABLE_LABEL, m: d.all.market },
  ];
  L.push("## Market-wide proxy rates", "");
  L.push(...marketTable("Count-weighted", views, false));
  L.push(...marketTable("Dollar-weighted", views, true));
  if (d.adjusted) {
    const a = d.adjusted;
    L.push(
      `Adjusted (${d.adjustedBasis === "share-adjusted" ? "share-adjusted view" : "verified rows only"}): overcharge > mode ${pct(a.overMode.count.p)} ${ci(a.overMode.count)}, ` +
        `> 2 x mode ${pct(a.over2xMode.count.p)} ${ci(a.over2xMode.count)}, ` +
        `duplicate followers ${pct(a.duplicate.count.p)} ${ci(a.duplicate.count)}, ` +
        `isolated duplicate pairs ${pct(a.isolatedPairs.count.p)} ${ci(a.isolatedPairs.count)} (${a.isolatedPairs.count.k} pairs, ${usd(a.isolatedPairs.dollar.atomic)}) ` +
        `(count-weighted, n = ${a.n}, ${a.payTos} pay-tos).`,
      "",
    );
  } else L.push("Adjusted: not available, no verified rows yet (run verification).", "");

  L.push(
    "## Share-adjusted rule per pay-to",
    "",
    "| # | pay-to | rule | non-dust rows | unchecked | verified rows | rows used | sampled share lo |",
    "|---|---|---|---|---|---|---|---|",
  );
  d.shareRules.forEach((r, i) => {
    L.push(
      `| ${i + 1} | ${r.payTo} | ${SHARE_RULE_LABELS[r.rule]} | ${r.nonDustRows} | ${r.uncheckedRows} | ${r.verifiedRows} | ${r.includedRows} | ${r.shareLo === null ? "not sampled" : pct(r.shareLo)} |`,
    );
  });
  L.push("");

  if (d.eip3009.length) {
    L.push("### EIP-3009 share (sampled receipts)", "", "| pay-to | sampled txs | via AuthorizationUsed | share [95% CI] | population |", "|---|---|---|---|---|");
    for (const s of d.eip3009) L.push(`| ${s.payTo} | ${s.sampled} | ${s.viaAuthorization} | ${pct(s.share)} [${pct(s.lo)}, ${pct(s.hi)}] | ${s.population} |`);
    L.push("");
  }

  const viewTable = (title: string, v: ProxyView) => {
    L.push(
      `## Per pay-to (${title})`,
      "",
      "| # | pay-to | transfers | USDC | mode price | > mode n (%) | > 2 x mode n | dup followers n (%) | dup runs | isolated pairs n (USDC) |",
      "|---|---|---|---|---|---|---|---|---|---|",
    );
    v.rows.filter((r) => r.transfers > 0).forEach((r, i) => {
      L.push(
        `| ${i + 1} | ${r.payTo} | ${r.transfers} | ${usd(r.sumAtomic)} | ${r.modeAtomic === null ? "-" : usd(r.modeAtomic)} | ` +
          `${r.overMode.count} (${share(r.overMode.count, r.transfers)}) | ${r.over2xMode.count} | ${r.dupFollowers.count} (${share(r.dupFollowers.count, r.transfers)}) | ${r.dupRuns} | ` +
          `${r.isolatedPairs.count} (${usd(r.isolatedPairs.atomic)}) |`,
      );
    });
    L.push("");
  };
  if (d.verified.market.n > 0) viewTable("verified view", d.verified);
  if (d.shareAdjusted.market.n > 0) viewTable("share-adjusted view", d.shareAdjusted);

  L.push(
    "## Per pay-to (all non-dust view; not x402-filtered, transparency only)",
    "",
    "| # | pay-to | sellers | transfers | USDC | mode price | > mode n (%) | dup followers n (%) | isolated pairs n | verified rows | EIP-3009 share [lo, hi] |",
    "|---|---|---|---|---|---|---|---|---|---|---|",
  );
  d.all.rows.forEach((r, i) => {
    const e = r.eip3009 ? `${pct(r.eip3009.share)} [${pct(r.eip3009.lo)}, ${pct(r.eip3009.hi)}] (n = ${r.eip3009.sampled})` : "not sampled";
    L.push(
      `| ${i + 1} | ${r.payTo} | ${r.sellerDomains.join(", ") || "-"} | ${r.transfers} | ${usd(r.sumAtomic)} | ${r.modeAtomic === null ? "-" : usd(r.modeAtomic)} | ` +
        `${r.overMode.count} (${share(r.overMode.count, r.transfers)}) | ${r.dupFollowers.count} (${share(r.dupFollowers.count, r.transfers)}) | ${r.isolatedPairs.count} | ${r.verifiedRows} | ${e} |`,
    );
  });
  L.push("");

  L.push("## Caveats", "", ...CHAIN_CAVEATS.map((c) => `- ${c}`), "");
  return L.join("\n");
}
