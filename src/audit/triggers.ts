/**
 * `audit-triggers`, the decision half (docs/PLAN.md "Audits"): which sellers deserve extra paid calls because the
 * index's two series disagree, the operator-reported series is mature while ours is thin, operators report failures
 * on a seller we mark ok, or people are checking a seller our data says little about.
 *
 * Reads only: GET {index}/v1/reported and GET {index}/v1/demand (public, keyless) and the seller's own measured
 * series from the database (scheduled buys plus earlier audits). Every decision, with the figures it used, is written
 * to `audit_triggers` before anything is spent (src/audit/run.ts).
 */
import type { Db } from "../db/index.js";
import { runQuery } from "../report/queries.js";
import { countRate } from "../report/compute.js";
import { CALL_SOURCES, type CallSource } from "../taxonomy.js";

/** Same thresholds as the index's verdict rule (paidfor-index lib/verdict.ts); used only to know which sellers we mark ok. */
export const AVOID_LOW_BOUND = 0.1;
export const CAUTION_RATE = 0.02;
export const MIN_CALLS = 30;
/** (b) and (d): measured calls under this count as thin. */
export const THIN_MEASURED_CALLS = 30;
/** (c): reported rate above this on a seller we mark ok. */
export const REPORTED_ABOVE_OK_RATE = 0.1;
/** (d): top N of /v1/demand over DEMAND_DAYS days; stale when no measured call in STALE_DAYS days. */
export const DEMAND_TOP = 20;
export const DEMAND_DAYS = 7;
export const STALE_DAYS = 14;
const DAY_MS = 24 * 3_600_000;

export type Verdict = "ok" | "caution" | "avoid";
export type TriggerReason = "disagreement" | "demand" | "thin_measured" | "reported_above_ok";
/** Expected information gain, roughly: disagreements first, then demand, then the rest. */
export const REASON_PRIORITY: Record<TriggerReason, number> = { disagreement: 0, demand: 1, thin_measured: 2, reported_above_ok: 3 };

export interface ReportedHost {
  host: string;
  operators?: number;
  calls: number;
  failures?: number;
  rate: number | null;
  wilson_low: number | null;
  wilson_high: number | null;
  mature: boolean;
}
export interface DemandHost {
  host: string;
  checks: number;
  /** checks split by the caller's X-Paidfor-Client channel (skill/<rev>, mcp/<ver>, x402-audit, api, ...), if served. */
  byChannel?: Record<string, number>;
}
export interface MeasuredSeller {
  sellerId: number;
  domain: string;
  n: number;
  failures: number;
  rate: number;
  lo: number;
  hi: number;
  lastCallTs: number | null;
}

export interface Trigger {
  host: string;
  sellerId: number | null;
  reasons: TriggerReason[];
  source: CallSource;
  priority: number;
  inputs: {
    reported: ReportedHost | null;
    measured: (Omit<MeasuredSeller, "lastCallTs"> & { last_call: string | null; verdict: Verdict }) | null;
    demand: { rank: number; checks: number; days: number } | null;
  };
}

export function measuredVerdict(m: Pick<MeasuredSeller, "n" | "rate" | "lo">): Verdict {
  const full = m.n >= MIN_CALLS;
  if (full && m.lo > AVOID_LOW_BOUND) return "avoid";
  if (m.rate > CAUTION_RATE || !full) return "caution";
  return "ok";
}

const norm = (h: string) => h.trim().toLowerCase().replace(/\.$/, "").replace(/^www\./, "");

/** Every seller's measured series from the database (buy + audit sources, the paid denominator). */
export function measuredSeries(db: Db, o: { network: string; now: number }): MeasuredSeller[] {
  const rows = runQuery<{ seller_id: number; domain: string; n: number; failures: number; last_call_ts: number | null }>(db, "seller_measured", {
    since: 0,
    until: o.now,
    network: o.network,
  });
  return rows.map((r) => {
    const c = countRate(Number(r.failures), Number(r.n));
    return { sellerId: Number(r.seller_id), domain: r.domain, n: c.n, failures: c.failures, rate: c.rate, lo: c.lo, hi: c.hi, lastCallTs: r.last_call_ts == null ? null : Number(r.last_call_ts) };
  });
}

/** Sellers by host as the index names them (seller domains without measured calls included, for demand on thin sellers). */
export function sellerIdsByHost(db: Db): Map<string, number> {
  const m = new Map<string, number>();
  for (const r of db.prepare("SELECT id, domain FROM sellers WHERE excluded = 0").all() as { id: number; domain: string }[]) m.set(norm(r.domain), r.id);
  return m;
}

export interface EvaluateInput {
  reported: readonly ReportedHost[];
  /** /v1/demand hosts for the last DEMAND_DAYS days, any order. */
  demand: readonly DemandHost[];
  measured: readonly MeasuredSeller[];
  sellers: Map<string, number>;
  now: number;
}

/** Pure: every host for which at least one condition holds, ordered by expected information gain. */
export function evaluateTriggers(i: EvaluateInput): Trigger[] {
  const measuredById = new Map(i.measured.map((m) => [m.sellerId, m]));
  const reportedByHost = new Map(i.reported.map((r) => [norm(r.host), r]));
  const ranked = [...i.demand].filter((d) => d.checks > 0).sort((a, b) => b.checks - a.checks || a.host.localeCompare(b.host)).slice(0, DEMAND_TOP);
  const demandByHost = new Map(ranked.map((d, k) => [norm(d.host), { rank: k + 1, checks: d.checks, days: DEMAND_DAYS }]));
  const hosts = new Set([...reportedByHost.keys(), ...demandByHost.keys()]);
  const out: Trigger[] = [];
  for (const host of hosts) {
    const sellerId = i.sellers.get(host) ?? null;
    const m = sellerId !== null ? (measuredById.get(sellerId) ?? null) : null;
    const r = reportedByHost.get(host) ?? null;
    const d = demandByHost.get(host) ?? null;
    const reasons: TriggerReason[] = [];
    const mN = m?.n ?? 0;
    if (r?.mature && m && m.n > 0 && r.wilson_low != null && r.wilson_high != null && (r.wilson_high < m.lo || m.hi < r.wilson_low)) reasons.push("disagreement");
    if (d && (mN < THIN_MEASURED_CALLS || m?.lastCallTs == null || m.lastCallTs < i.now - STALE_DAYS * DAY_MS)) reasons.push("demand");
    if (r?.mature && mN < THIN_MEASURED_CALLS) reasons.push("thin_measured");
    if (r && r.rate != null && r.rate > REPORTED_ABOVE_OK_RATE && m && measuredVerdict(m) === "ok") reasons.push("reported_above_ok");
    if (!reasons.length) continue;
    const priority = Math.min(...reasons.map((x) => REASON_PRIORITY[x]));
    out.push({
      host,
      sellerId,
      reasons,
      source: priority === REASON_PRIORITY.demand ? CALL_SOURCES.AUDIT_DEMAND : CALL_SOURCES.AUDIT_DISAGREEMENT,
      priority,
      inputs: {
        reported: r,
        measured: m ? { sellerId: m.sellerId, domain: m.domain, n: m.n, failures: m.failures, rate: m.rate, lo: m.lo, hi: m.hi, last_call: m.lastCallTs ? new Date(m.lastCallTs).toISOString() : null, verdict: measuredVerdict(m) } : null,
        demand: d,
      },
    });
  }
  return out.sort((a, b) => a.priority - b.priority || (b.inputs.demand?.checks ?? 0) - (a.inputs.demand?.checks ?? 0) || (a.inputs.measured?.n ?? 0) - (b.inputs.measured?.n ?? 0) || a.host.localeCompare(b.host));
}

// ------------------------------------------------------------------ index reads

export type FetchImpl = (url: string, init?: RequestInit) => Promise<Response>;

async function getJson(url: string, fetchImpl: FetchImpl, timeoutMs = 20_000): Promise<{ status: number; body: unknown }> {
  const ac = new AbortController();
  const t = setTimeout(() => ac.abort(), timeoutMs);
  try {
    const res = await fetchImpl(url, { headers: { accept: "application/json", "x-paidfor-client": "x402-audit" }, signal: ac.signal });
    const text = await res.text();
    let body: unknown = null;
    try {
      body = JSON.parse(text);
    } catch {
      body = null;
    }
    return { status: res.status, body };
  } finally {
    clearTimeout(t);
  }
}

export async function fetchReported(index: string, fetchImpl: FetchImpl = fetch): Promise<ReportedHost[]> {
  const r = await getJson(`${index.replace(/\/$/, "")}/v1/reported`, fetchImpl);
  if (r.status !== 200 || !r.body || typeof r.body !== "object") throw new Error(`GET /v1/reported answered ${r.status}`);
  const hosts = (r.body as { hosts?: unknown }).hosts;
  if (!Array.isArray(hosts)) throw new Error("GET /v1/reported: no hosts array");
  return hosts
    .filter((h): h is Record<string, unknown> => !!h && typeof h === "object" && typeof (h as { host?: unknown }).host === "string")
    .map((h) => ({
      host: String(h.host),
      operators: Number(h.operators ?? 0),
      calls: Number(h.calls ?? 0),
      failures: Number(h.failures ?? 0),
      rate: h.rate == null ? null : Number(h.rate),
      wilson_low: h.wilson_low == null ? null : Number(h.wilson_low),
      wilson_high: h.wilson_high == null ? null : Number(h.wilson_high),
      mature: h.mature === true,
    }));
}

export async function fetchDemand(index: string, fetchImpl: FetchImpl = fetch, days = DEMAND_DAYS): Promise<DemandHost[]> {
  const r = await getJson(`${index.replace(/\/$/, "")}/v1/demand?days=${days}`, fetchImpl);
  if (r.status !== 200 || !r.body || typeof r.body !== "object") throw new Error(`GET /v1/demand answered ${r.status}`);
  const hosts = (r.body as { hosts?: unknown }).hosts;
  if (!Array.isArray(hosts)) throw new Error("GET /v1/demand: no hosts array");
  return hosts
    .filter((h): h is Record<string, unknown> => !!h && typeof h === "object" && typeof (h as { host?: unknown }).host === "string")
    .map((h) => {
      // Per-host checks by X-Paidfor-Client channel, when the index provides them (lets the harness drop its own).
      const by = h.checks_by_channel && typeof h.checks_by_channel === "object" ? (h.checks_by_channel as Record<string, unknown>) : null;
      const byChannel = by ? Object.fromEntries(Object.entries(by).map(([k, v]) => [k, Number(v) || 0])) : undefined;
      return { host: String(h.host), checks: Number(h.checks ?? 0), ...(byChannel ? { byChannel } : {}) };
    });
}

export { getJson };
