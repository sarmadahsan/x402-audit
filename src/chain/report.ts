/**
 * Market-wide proxy floors from on-chain transfers (module 5 `chain report`).
 *
 * Universe: the top N pay-tos by payto_volume (topPayTos), each restricted to its own latest payto_volume
 * block window, value >= dust floor. Two views:
 *   - "all non-dust": every such transfer, verified or not (unchecked rows can include unrelated transfers);
 *   - "verified": only rows with via_authorization = 1 (an AuthorizationUsed from the same sender in the
 *     same tx), i.e. EIP-3009 settlements. Empty until `verifySample` / `verifyAll` have run.
 *
 * Proxies per pay-to (all from the SQL constants below; mode and sums are taken in JS with bigint because
 * value_atomic is TEXT):
 *   - overcharge: transfers with value > mode, and > 2 x mode (stricter), where mode = most frequent value
 *     (ties -> lower value);
 *   - duplicate loop: order rows by (from_addr, to_addr, value_atomic, block_ts); a row whose predecessor in
 *     that group is at most windowS seconds earlier is a "duplicate-run follower"; a run is a maximal chain
 *     of followers (counted once).
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
 *   @verified_only (0 = all non-dust rows, 1 = via_authorization = 1 only).
 */
export const CHAIN_PROXY_UNIVERSE_CTE = `WITH u AS (
    SELECT LOWER(json_extract(value, '$.pay_to')) AS pay_to,
           json_extract(value, '$.from_block') AS from_block,
           json_extract(value, '$.to_block') AS to_block
    FROM json_each(@universe)
  ), x AS (
    SELECT c.id, c.tx_hash, c.log_index, c.block_number, c.block_ts, c.from_addr, c.to_addr, c.value_atomic, c.via_authorization
    FROM chain_transfers c JOIN u ON c.to_addr = u.pay_to AND c.block_number BETWEEN u.from_block AND u.to_block
    WHERE c.network = @network
      AND (length(c.value_atomic) > 18 OR CAST(c.value_atomic AS INTEGER) >= @dust_floor)
      AND (@verified_only = 0 OR c.via_authorization = 1)
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
} as const;
export type ChainProxyQueryName = keyof typeof CHAIN_PROXY_QUERIES;

export interface ChainProxyParams {
  network: string;
  universe: { pay_to: string; from_block: number; to_block: number }[];
  dustFloorAtomic: bigint;
  verifiedOnly: boolean;
  windowMs: number;
}

export function runChainProxyQuery<T>(db: Db, name: ChainProxyQueryName, p: ChainProxyParams): T[] {
  const bound: Record<string, unknown> = {
    network: p.network,
    universe: JSON.stringify(p.universe),
    dust_floor: p.dustFloorAtomic,
    verified_only: p.verifiedOnly ? 1 : 0,
  };
  if (name === "chain_proxy_duplicate_runs") bound.window_ms = p.windowMs;
  return db.prepare(CHAIN_PROXY_QUERIES[name]).all(bound) as T[];
}

export const CHAIN_CAVEATS: readonly string[] = [
  "Delivery is invisible on-chain: these numbers say nothing about whether the buyer received what they paid for.",
  "These are floors, not failure rates: only patterns visible in transfers are counted, and every proxy can miss real failures.",
  "A payment above the mode may be a legitimately different product or a dynamic price, not an overcharge.",
  "A repeated identical transfer within 120 s may be a legitimate second purchase, not a duplicate charge.",
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
  eip3009: SampleStat | null;
}
export interface RatePair {
  count: Interval & { k: number; n: number };
  dollar: Interval & { effectiveN: number; atomic: bigint; totalAtomic: bigint };
}
export interface MarketRates {
  n: number;
  sumAtomic: bigint;
  overMode: RatePair;
  over2xMode: RatePair;
  duplicate: RatePair;
}
export interface ProxyView {
  label: "all non-dust" | "verified (AuthorizationUsed)";
  rows: PayToProxies[];
  market: MarketRates;
}
export interface ChainProxyData {
  network: string;
  dustFloorAtomic: bigint;
  windowS: number;
  topN: number;
  window: { fromBlock: number; toBlock: number; fromTs: number; toTs: number; uniform: boolean } | null;
  universePayTos: number;
  all: ProxyView;
  verified: ProxyView;
  /** Proxy rates over verified rows only, when any exist (else null). */
  adjusted: MarketRates | null;
  eip3009: SampleStat[];
  queryNames: ChainProxyQueryName[];
}

function modeOf(hist: readonly { v: bigint; n: number }[]): bigint | null {
  let best: { v: bigint; n: number } | null = null;
  for (const h of hist) if (!best || h.n > best.n || (h.n === best.n && h.v < best.v)) best = h;
  return best ? best.v : null;
}

function rate(k: number, n: number, rows: WeightedRow[]): RatePair {
  const d = dollarWeightedWilson(rows);
  let atomic = 0n;
  let total = 0n;
  for (const r of rows) {
    total += r.weightAtomic;
    if (r.failed) atomic += r.weightAtomic;
  }
  return { count: { ...wilsonInterval(k, n), k, n }, dollar: { ...d, atomic, totalAtomic: total } };
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
  const tot = new Map(totals.map((t) => [t.pay_to, t]));

  const wOver: WeightedRow[] = [];
  const wOver2: WeightedRow[] = [];
  const wDup: WeightedRow[] = [];
  let nAll = 0;
  let sumAll = 0n;
  let kOver = 0;
  let kOver2 = 0;
  let kDup = 0;
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
      eip3009: meta.get(payTo)?.eip ?? null,
    };
    const dm = dup.get(payTo);
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
      pushRows(wOver, v, n, over ? n : 0);
      pushRows(wOver2, v, n, over2 ? n : 0);
      pushRows(wDup, v, n, f);
    }
    nAll += r.transfers;
    sumAll += r.sumAtomic;
    kOver += r.overMode.count;
    kOver2 += r.over2xMode.count;
    kDup += r.dupFollowers.count;
    rows.push(r);
  }
  return {
    label,
    rows,
    market: { n: nAll, sumAtomic: sumAll, overMode: rate(kOver, nAll, wOver), over2xMode: rate(kOver2, nAll, wOver2), duplicate: rate(kDup, nAll, wDup) },
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
  o: { network: string; dustFloorAtomic?: bigint; windowS?: number; topN?: number },
): ChainProxyData {
  const { network, dustFloorAtomic = 100n, windowS = DUPLICATE_RUN_WINDOW_S, topN = 60 } = o;
  const top = topPayTos(db, { network, n: topN });
  const shares = readEip3009Shares(db, network);
  const universe = top.map((t) => ({ pay_to: t.payTo, from_block: t.fromBlock, to_block: t.toBlock }));
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

  const base = { network, universe, dustFloorAtomic, windowMs: windowS * 1000 };
  const all = buildView(db, "all non-dust", { ...base, verifiedOnly: false }, meta, order);
  const verified = buildView(db, "verified (AuthorizationUsed)", { ...base, verifiedOnly: true }, meta, order);
  return {
    network,
    dustFloorAtomic,
    windowS,
    topN,
    window,
    universePayTos: top.length,
    all,
    verified,
    adjusted: verified.market.n > 0 ? verified.market : null,
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

function marketTable(title: string, pick: (r: RatePair) => RatePair["count"] | RatePair["dollar"], a: MarketRates, v: MarketRates, dollars: boolean): string[] {
  const cell = (m: MarketRates, r: RatePair) => {
    if (m.n === 0) return "n/a (no rows)";
    const x = pick(r);
    const k = dollars ? usd((x as RatePair["dollar"]).atomic) : String((x as RatePair["count"]).k);
    return `${pct(x.p)} ${ci(x)} (${k})`;
  };
  const header = dollars ? `| proxy | all non-dust (${usd(a.sumAtomic)}) | verified only (${usd(v.sumAtomic)}) |` : `| proxy | all non-dust (n = ${a.n}) | verified only (n = ${v.n}) |`;
  return [
    `### ${title}`,
    "",
    header,
    "|---|---|---|",
    `| overcharge proxy: value > mode | ${cell(a, a.overMode)} | ${cell(v, v.overMode)} |`,
    `| overcharge proxy: value > 2 x mode | ${cell(a, a.over2xMode)} | ${cell(v, v.over2xMode)} |`,
    `| duplicate-run followers | ${cell(a, a.duplicate)} | ${cell(v, v.duplicate)} |`,
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
  L.push(
    `- Universe: top ${d.universePayTos} pay-to addresses by scanned USDC volume (requested ${d.topN}), transfers with value >= ${d.dustFloorAtomic} atomic units (dust floor).`,
    `- All non-dust view: ${d.all.market.n} transfers, ${usd(d.all.market.sumAtomic)}. Includes unverified rows (via_authorization NULL) and plain transfers.`,
    `- Verified view: ${d.verified.market.n} transfers, ${usd(d.verified.market.sumAtomic)}. Only rows whose tx has AuthorizationUsed from the same sender (EIP-3009 settlements).`,
    `- Duplicate window: ${d.windowS} s. Intervals: Wilson 95%; dollar-weighted intervals are approximate (Kish effective n).`,
    `- Named queries: ${d.queryNames.map((q) => `\`${q}\``).join(", ")} (src/chain/report.ts).`,
    "",
  );

  L.push("## Market-wide proxy rates", "");
  L.push(...marketTable("Count-weighted", (r) => r.count, d.all.market, d.verified.market, false));
  L.push(...marketTable("Dollar-weighted", (r) => r.dollar, d.all.market, d.verified.market, true));
  if (d.adjusted) {
    L.push(
      `Adjusted (verified rows only): overcharge > mode ${pct(d.adjusted.overMode.count.p)} ${ci(d.adjusted.overMode.count)}, ` +
        `> 2 x mode ${pct(d.adjusted.over2xMode.count.p)} ${ci(d.adjusted.over2xMode.count)}, ` +
        `duplicate ${pct(d.adjusted.duplicate.count.p)} ${ci(d.adjusted.duplicate.count)} (count-weighted, n = ${d.adjusted.n}).`,
      "",
    );
  } else L.push("Adjusted (verified rows only): not available, no verified rows yet (run verification).", "");

  if (d.eip3009.length) {
    L.push("### EIP-3009 share (sampled receipts)", "", "| pay-to | sampled txs | via AuthorizationUsed | share [95% CI] | population |", "|---|---|---|---|---|");
    for (const s of d.eip3009) L.push(`| ${s.payTo} | ${s.sampled} | ${s.viaAuthorization} | ${pct(s.share)} [${pct(s.lo)}, ${pct(s.hi)}] | ${s.population} |`);
    L.push("");
  }

  L.push(
    "## Per pay-to (all non-dust view)",
    "",
    "| # | pay-to | sellers | transfers | USDC | mode price | > mode n (%) | dup followers n (%) | verified rows | EIP-3009 share [lo, hi] |",
    "|---|---|---|---|---|---|---|---|---|---|",
  );
  d.all.rows.forEach((r, i) => {
    const e = r.eip3009 ? `${pct(r.eip3009.share)} [${pct(r.eip3009.lo)}, ${pct(r.eip3009.hi)}] (n = ${r.eip3009.sampled})` : "not sampled";
    L.push(
      `| ${i + 1} | ${r.payTo} | ${r.sellerDomains.join(", ") || "-"} | ${r.transfers} | ${usd(r.sumAtomic)} | ${r.modeAtomic === null ? "-" : usd(r.modeAtomic)} | ` +
        `${r.overMode.count} (${share(r.overMode.count, r.transfers)}) | ${r.dupFollowers.count} (${share(r.dupFollowers.count, r.transfers)}) | ${r.verifiedRows} | ${e} |`,
    );
  });
  L.push("");

  if (d.verified.market.n > 0) {
    L.push(
      "## Per pay-to (verified view)",
      "",
      "| # | pay-to | transfers | USDC | mode price | > mode n (%) | > 2 x mode n | dup followers n (%) | dup runs |",
      "|---|---|---|---|---|---|---|---|---|",
    );
    d.verified.rows.filter((r) => r.transfers > 0).forEach((r, i) => {
      L.push(
        `| ${i + 1} | ${r.payTo} | ${r.transfers} | ${usd(r.sumAtomic)} | ${r.modeAtomic === null ? "-" : usd(r.modeAtomic)} | ` +
          `${r.overMode.count} (${share(r.overMode.count, r.transfers)}) | ${r.over2xMode.count} | ${r.dupFollowers.count} (${share(r.dupFollowers.count, r.transfers)}) | ${r.dupRuns} |`,
      );
    });
    L.push("");
  }

  L.push("## Caveats", "", ...CHAIN_CAVEATS.map((c) => `- ${c}`), "");
  return L.join("\n");
}
