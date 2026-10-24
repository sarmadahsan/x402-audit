/**
 * Every number in the report comes from one of these named queries. The
 * renderer and compute layer never build ad-hoc SQL: they call
 * `runQuery(db, name, params)`.
 *
 * Conventions
 * - Named parameters: @since, @until (unix ms, inclusive), @network (CAIP-2),
 *   @min_calls, @window_ms. `runQuery` passes only the parameters a query uses.
 * - Money columns are TEXT atomic units. Sums are computed as SQLite INTEGER
 *   (exact up to 2^63-1) and returned CAST AS TEXT so JS reads them with BigInt
 *   without passing through a float. Any amount that is not a plain digit string
 *   of at most 18 digits contributes 0 (it can never overflow the sum).
 * - Sums of squared weights (for the Kish effective n) are REAL: that figure is
 *   an approximation already, and REAL cannot overflow.
 * - Calls are filtered by `quote_network = @network OR quote_network IS NULL`
 *   (rows that never got a quote, e.g. some our_error rows, carry no network).
 * - Chain proxy "mode" (per pay_to modal transfer value) is computed in JS from
 *   the per-pay_to value histogram returned by `chain_proxy_overcharge`, because
 *   value_atomic is TEXT and must be compared as a bigint. Ties go to the lower
 *   value. Dust (below the dust floor) is removed in JS before the mode is taken.
 */
import type { Db } from "../db/index.js";
import { FLAGS, HEADLINE_FAILURE_OUTCOMES, OUTCOMES, PAID_DENOMINATOR_OUTCOMES } from "../taxonomy.js";

const sqlList = (xs: Iterable<string>): string => [...xs].map((x) => `'${x.replace(/'/g, "''")}'`).join(", ");
const DENOM_LIST = sqlList(PAID_DENOMINATOR_OUTCOMES);
const FAIL_LIST = sqlList(HEADLINE_FAILURE_OUTCOMES);

/** Exact integer from a TEXT atomic amount; anything malformed counts as 0. */
const intOf = (e: string): string =>
  `(CASE WHEN ${e} IS NOT NULL AND ${e} <> '' AND ${e} NOT GLOB '*[^0-9]*' AND length(${e}) <= 18 THEN CAST(${e} AS INTEGER) ELSE 0 END)`;

const CALL_WINDOW = `c.ts >= @since AND c.ts <= @until AND (c.quote_network = @network OR c.quote_network IS NULL)`;

const hasFlag = (flagsCol: string, flag: string): string =>
  `EXISTS (SELECT 1 FROM json_each(${flagsCol}) WHERE json_each.value = '${flag}')`;

/**
 * `b`: every buy row in the window with its dollar weight `w`:
 *   paid=1 and settlement_count>=1 -> amount_paid_atomic
 *   paid=1 and settlement_count=0  -> settlement_header_json.amount if present, else 0
 *   otherwise                      -> 0
 * plus `exposure` (= quote_amount_atomic for unpaid_overcharge rows, else 0),
 * `in_denom` (outcome in the paid denominator and not an unpaid overcharge),
 * and `failed` (outcome is a headline failure).
 */
const BUY_CTE = `WITH b0 AS (
  SELECT c.id, c.seller_id, c.outcome, c.paid, c.settlement_count, c.amount_paid_atomic,
         c.quote_amount_atomic, c.reference_price_atomic,
         CASE WHEN json_valid(c.flags_json) THEN c.flags_json ELSE '[]' END AS flags,
         CASE WHEN json_valid(c.settlement_header_json)
              THEN CAST(json_extract(c.settlement_header_json, '$.amount') AS TEXT) END AS hdr_amount
  FROM calls c
  WHERE c.source = 'buy' AND ${CALL_WINDOW}
), b1 AS (
  SELECT b0.*,
    CASE WHEN paid = 1 AND settlement_count >= 1 THEN ${intOf("amount_paid_atomic")}
         WHEN paid = 1 THEN ${intOf("hdr_amount")}
         ELSE 0 END AS w,
    ${hasFlag("b0.flags", FLAGS.UNPAID_OVERCHARGE)} AS unpaid_oc,
    ${hasFlag("b0.flags", FLAGS.INJECTION_HIT)} AS inj_hit,
    ${hasFlag("b0.flags", FLAGS.RESOLVED_LATE)} AS resolved_late
  FROM b0
), b AS (
  SELECT b1.*,
    CASE WHEN outcome IN (${DENOM_LIST}) AND NOT unpaid_oc THEN 1 ELSE 0 END AS in_denom,
    CASE WHEN outcome IN (${FAIL_LIST}) THEN 1 ELSE 0 END AS failed,
    CASE WHEN unpaid_oc THEN ${intOf("quote_amount_atomic")} ELSE 0 END AS exposure
  FROM b1
)`;

/** Columns shared by every grouped rate query over `b` (restricted to in_denom rows). */
const RATE_COLS = `COUNT(*) AS n,
    COALESCE(SUM(failed), 0) AS failures,
    CAST(COALESCE(SUM(w), 0) AS TEXT) AS w_sum,
    CAST(COALESCE(SUM(CASE WHEN failed = 1 THEN w ELSE 0 END), 0) AS TEXT) AS w_failed,
    COALESCE(SUM(CAST(w AS REAL) * w), 0.0) AS w_sumsq`;

const RUN_WINDOW = `network = @network AND started_at <= @until AND (finished_at IS NULL OR finished_at >= @since)`;
const CHAIN_WINDOW = `network = @network AND block_ts >= @since AND block_ts <= @until`;

const settlementsForIntent = (alias: string) =>
  `(SELECT COUNT(DISTINCT s.tx_hash || ':' || COALESCE(s.log_index, '')) FROM settlements s WHERE s.intent_id = ${alias}.intent_id)`;

export const QUERIES = {
  /** Every call row in the window by source and outcome (NULL outcome shown as 'unclassified'). */
  calls_by_source_outcome: `SELECT c.source AS source, COALESCE(c.outcome, 'unclassified') AS outcome, COUNT(*) AS n
    FROM calls c WHERE ${CALL_WINDOW}
    GROUP BY 1, 2 ORDER BY 1, 2`,

  /** Buy rows in the paid denominator, per outcome: n, dollar weight sum, sum of squared weights, rows without a visible settlement. */
  buy_headline_counts: `${BUY_CTE}
    SELECT outcome, ${RATE_COLS},
      COALESCE(SUM(CASE WHEN paid = 1 AND settlement_count = 0 THEN 1 ELSE 0 END), 0) AS unconfirmed_settlement
    FROM b WHERE in_denom = 1 GROUP BY outcome ORDER BY outcome`,

  /** Headline failure outcomes only: n, dollars, how many were resolved late. */
  buy_by_failure_type: `${BUY_CTE}
    SELECT outcome, COUNT(*) AS n, CAST(COALESCE(SUM(w), 0) AS TEXT) AS w_sum,
      COALESCE(SUM(resolved_late), 0) AS resolved_late
    FROM b WHERE in_denom = 1 AND failed = 1 GROUP BY outcome ORDER BY outcome`,

  /** Denominator rows grouped by sellers.tier. */
  buy_by_tier: `${BUY_CTE}
    SELECT COALESCE(s.tier, 'unassigned') AS grp, ${RATE_COLS}
    FROM b JOIN sellers s ON s.id = b.seller_id
    WHERE in_denom = 1 GROUP BY 1 ORDER BY 1`,

  /** Denominator rows grouped by sellers.category. */
  buy_by_category: `${BUY_CTE}
    SELECT COALESCE(s.category, 'unassigned') AS grp, ${RATE_COLS}
    FROM b JOIN sellers s ON s.id = b.seller_id
    WHERE in_denom = 1 GROUP BY 1 ORDER BY 1`,

  /** Rows outside the paid denominator, and flagged rows, for the separate lines. */
  /** Secondary flags among denominator rows: how many rows carry each flag and their dollar weight. */
  buy_flag_counts: `${BUY_CTE}
    SELECT j.value AS flag, COUNT(*) AS n, CAST(COALESCE(SUM(w), 0) AS TEXT) AS dollars_atomic,
           COALESCE(SUM(failed), 0) AS failed
    FROM b, json_each(b.flags) j
    WHERE in_denom = 1
    GROUP BY j.value ORDER BY n DESC, j.value`,

  buy_excluded_counts: `${BUY_CTE}
    SELECT
      COALESCE(SUM(outcome = '${OUTCOMES.OUR_ERROR}'), 0) AS our_error,
      COALESCE(SUM(outcome = '${OUTCOMES.INDETERMINATE}'), 0) AS indeterminate,
      COALESCE(SUM(outcome = '${OUTCOMES.NOT_PAID}'), 0) AS not_paid,
      COALESCE(SUM(outcome IS NULL), 0) AS unclassified,
      COALESCE(SUM(in_denom = 1 AND outcome = '${OUTCOMES.INJECTION}'), 0) AS injection,
      COALESCE(SUM(inj_hit), 0) AS injection_hit_total,
      COALESCE(SUM(unpaid_oc), 0) AS unpaid_overcharge,
      CAST(COALESCE(SUM(exposure), 0) AS TEXT) AS exposure_atomic,
      COALESCE(SUM(in_denom = 1 AND resolved_late), 0) AS resolved_late_in_denominator,
      COALESCE(SUM(in_denom = 1 AND paid = 1 AND settlement_count = 0), 0) AS delivered_without_settlement,
      COUNT(*) AS buy_rows
    FROM b`,

  /** Overcharge rows in the denominator with quote and reference, for the ratio sensitivity rows (ratio computed in JS as bigint). */
  buy_overcharge_ratios: `${BUY_CTE}
    SELECT id, quote_amount_atomic, reference_price_atomic, CAST(w AS TEXT) AS w
    FROM b WHERE in_denom = 1 AND outcome = '${OUTCOMES.OVERCHARGE}' ORDER BY id`,

  /** Per seller with at least @min_calls denominator rows. */
  buy_sellers_min_calls: `${BUY_CTE}
    SELECT s.id AS seller_id, s.domain AS domain, s.tier AS tier, s.category AS category, ${RATE_COLS}
    FROM b JOIN sellers s ON s.id = b.seller_id
    WHERE in_denom = 1
    GROUP BY s.id HAVING COUNT(*) >= @min_calls
    ORDER BY s.id`,

  /** stress_duplicate: one row per intent with its settlement count (max of calls.settlement_count and distinct settlements rows). */
  stress_duplicate_summary: `SELECT c.intent_id AS intent_id, COUNT(*) AS call_rows,
      MAX(c.settlement_count) AS call_settlements, ${settlementsForIntent("c")} AS settlement_rows
    FROM calls c WHERE c.source = 'stress_duplicate' AND ${CALL_WINDOW}
    GROUP BY c.intent_id ORDER BY c.intent_id`,

  /**
   * stress_timeout: one row per intent. Rows after the earliest one for the same
   * intent_id are retries (retry_rows = call_rows - 1).
   */
  stress_timeout_summary: `SELECT c.intent_id AS intent_id, COUNT(*) AS call_rows, COUNT(*) - 1 AS retry_rows,
      MIN(c.ts) AS first_ts, MAX(c.settlement_count) AS call_settlements, ${settlementsForIntent("c")} AS settlement_rows
    FROM calls c WHERE c.source = 'stress_timeout' AND ${CALL_WINDOW}
    GROUP BY c.intent_id ORDER BY c.intent_id`,

  /** Per pay_to value histogram over the window; the mode and the over-mode count/sum are computed in JS. */
  chain_proxy_overcharge: `SELECT to_addr AS pay_to, value_atomic, COUNT(*) AS n
    FROM chain_transfers WHERE ${CHAIN_WINDOW}
    GROUP BY to_addr, value_atomic ORDER BY to_addr, value_atomic`,

  /**
   * Transfers whose predecessor with identical (from_addr, to_addr, value_atomic)
   * is at most @window_ms earlier (block_ts is unix ms). prev_id lets JS group
   * them into runs: a row whose prev_id is not itself returned starts a run.
   */
  chain_proxy_duplicate_runs: `WITH t AS (
      SELECT id, tx_hash, from_addr, to_addr, value_atomic, block_ts,
        LAG(block_ts) OVER w AS prev_ts, LAG(id) OVER w AS prev_id
      FROM chain_transfers WHERE ${CHAIN_WINDOW}
      WINDOW w AS (PARTITION BY from_addr, to_addr, value_atomic ORDER BY block_ts, block_number, log_index, id)
    )
    SELECT id, tx_hash, from_addr, to_addr, value_atomic, block_ts, prev_ts, prev_id
    FROM t WHERE prev_ts IS NOT NULL AND block_ts - prev_ts <= @window_ms
    ORDER BY to_addr, block_ts, id`,

  /** Per pay_to totals (all transfers incl. dust; dust is removed in JS from the histogram). */
  chain_totals: `SELECT to_addr AS pay_to, COUNT(*) AS n, COUNT(DISTINCT from_addr) AS payers,
      MIN(block_ts) AS first_ts, MAX(block_ts) AS last_ts
    FROM chain_transfers WHERE ${CHAIN_WINDOW}
    GROUP BY to_addr ORDER BY to_addr`,

  /** Stored payto_volume windows (source of the default dust floor). */
  payto_volume_windows: `SELECT pay_to, from_block, to_block, from_ts, to_ts, transfer_count, sum_atomic, dust_count, dust_floor_atomic, unique_payers
    FROM payto_volume WHERE network = @network ORDER BY pay_to, from_block`,

  /** Telemetry rows by operator source and outcome. */
  telemetry_by_source_outcome: `SELECT t.source_id AS source_id, t.outcome AS outcome, COUNT(*) AS n,
      CAST(COALESCE(SUM(${intOf("t.amount_atomic")}), 0) AS TEXT) AS amount_atomic
    FROM telemetry_calls t
    WHERE t.received_at >= @since AND t.received_at <= @until AND (t.network = @network OR t.network IS NULL)
    GROUP BY 1, 2 ORDER BY 1, 2`,

  /** Registered telemetry sources. */
  telemetry_sources: `SELECT source_id, label, first_seen_at FROM telemetry_sources ORDER BY source_id`,

  /** Probe rounds and outcomes, plus price_events by kind. */
  probes_summary: `SELECT COUNT(DISTINCT p.round_id) AS rounds, COUNT(*) AS probes,
      COALESCE(SUM(p.outcome = '${OUTCOMES.OK}'), 0) AS ok,
      COALESCE(SUM(p.outcome = '${OUTCOMES.OVERCHARGE}'), 0) AS overcharge,
      COALESCE(SUM(p.outcome = '${OUTCOMES.OUR_ERROR}'), 0) AS our_error,
      (SELECT COUNT(*) FROM price_events e WHERE e.kind = 'price_discrimination' AND e.ts >= @since AND e.ts <= @until) AS price_discrimination,
      (SELECT COUNT(*) FROM price_events e WHERE e.kind = 'payto_changed' AND e.ts >= @since AND e.ts <= @until) AS payto_changed,
      (SELECT COUNT(*) FROM price_events e WHERE e.kind = 'quote_drift' AND e.ts >= @since AND e.ts <= @until) AS quote_drift
    FROM probes p
    WHERE p.ts >= @since AND p.ts <= @until AND (p.network = @network OR p.network IS NULL)`,

  /** Exact spend: SUM(amount_paid_atomic) over paid=1 calls, by source. */
  spend_total: `SELECT c.source AS source, COUNT(*) AS paid_calls,
      CAST(COALESCE(SUM(${intOf("c.amount_paid_atomic")}), 0) AS TEXT) AS spent_atomic,
      CAST(COALESCE((SELECT SUM(${intOf("s.value_atomic")}) FROM settlements s JOIN calls c2 ON c2.id = s.call_id
                      WHERE c2.source = c.source AND c2.ts BETWEEN @since AND @until), 0) AS TEXT) AS settled_atomic
    FROM calls c WHERE c.paid = 1 AND ${CALL_WINDOW}
    GROUP BY c.source ORDER BY c.source`,

  /** Distinct wallets that appear on call rows. */
  wallets_used: `SELECT COUNT(DISTINCT c.wallet) AS wallets FROM calls c WHERE c.wallet IS NOT NULL AND ${CALL_WINDOW}`,

  /** First and last call timestamp in the window. */
  date_range: `SELECT MIN(c.ts) AS min_ts, MAX(c.ts) AS max_ts, COUNT(*) AS n FROM calls c WHERE ${CALL_WINDOW}`,

  halts_list: `SELECT id, run_id, ts, reason, details_json FROM halts WHERE ts >= @since AND ts <= @until ORDER BY ts, id`,

  runs_list: `SELECT id, subcommand, config_hash, network, dry_run, started_at, finished_at, status
    FROM runs WHERE ${RUN_WINDOW} ORDER BY started_at, id`,

  config_hashes: `SELECT DISTINCT config_hash FROM runs WHERE ${RUN_WINDOW} ORDER BY config_hash`,

  schema_version: `SELECT value FROM meta WHERE key = 'schema_version'`,
} as const satisfies Record<string, string>;

export type QueryName = keyof typeof QUERIES;
export const QUERY_NAMES = Object.keys(QUERIES) as QueryName[];

export type QueryParams = Partial<Record<"since" | "until" | "network" | "min_calls" | "window_ms", string | number | bigint | null>>;

/** Named parameters a query references, in order of first appearance. */
export function paramsOf(name: QueryName): string[] {
  const out: string[] = [];
  for (const m of QUERIES[name].matchAll(/@([a-z_]+)/g)) if (!out.includes(m[1]!)) out.push(m[1]!);
  return out;
}

/** Prepare and run a named query, passing only the parameters it references. */
export function runQuery<T = Record<string, unknown>>(db: Db, name: QueryName, params: QueryParams = {}): T[] {
  const sql = QUERIES[name];
  if (sql === undefined) throw new Error(`unknown report query: ${String(name)}`);
  const bound: Record<string, unknown> = {};
  for (const p of paramsOf(name)) {
    const v = (params as Record<string, unknown>)[p];
    if (v === undefined) throw new Error(`report query ${name}: missing parameter @${p}`);
    bound[p] = v;
  }
  const stmt = db.prepare(sql);
  return (Object.keys(bound).length ? stmt.all(bound) : stmt.all()) as T[];
}
