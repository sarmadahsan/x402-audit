/**
 * `audit-triggers`, the spending half (docs/PLAN.md "Audits"). Per triggered seller, up to
 * AUDIT_MAX_CALLS_PER_SELLER paid calls spread round-robin over its known resources (resources plus recent probe
 * quotes, since the index only has path hashes), through the same runBuy path as scheduled buys: same wallets in
 * rotation, validators, settlement matching and taxonomy, source audit_disagreement or audit_demand.
 *
 * Caps, all refused and logged before anything is signed: at most AUDIT_MAX_SELLERS_PER_DAY sellers per UTC day,
 * at most AUDIT_MAX_PER_DAY_USD per UTC day over the audit sources (on top of the scheduled buy), the per-call cap
 * MAX_PER_CALL_USD unchanged, and every existing cap (per seller per day, per day, total). No retries.
 * Nothing here spends unless AUDIT_TRIGGERS_ENABLED=1 as well as --live and X402_AUDIT_LIVE=1.
 */
import { createHmac } from "node:crypto";
import type { Db } from "../db/index.js";
import { atomicToUsd, isExcluded, type Caps, type ExcludeConfig } from "../config/index.js";
import { spentAtomic, utcDayStart, type Logger } from "../buy/guard.js";
import type { BuyPlan, PlanAllocation } from "../buy/plan.js";
import { runBuy, type RunBuyOptions } from "../buy/run.js";
import { countRate } from "../report/compute.js";
import { AUDIT_SOURCES, FLAGS, HEADLINE_FAILURE_OUTCOMES, PAID_DENOMINATOR_OUTCOMES } from "../taxonomy.js";
import type { FetchImpl, Trigger } from "./triggers.js";
import { recordTooExpensive } from "../buy/states.js";
import { CALL_SOURCES } from "../taxonomy.js";
import { measuredSeries as measuredSeriesLocal, measuredVerdict, sellerIdsByHost as sellerIdsByHostLocal } from "./triggers.js";

export type AuditDecision = "planned" | "dry_run" | "disabled" | "refused";

export interface AuditPlanItem {
  trigger: Trigger;
  decision: AuditDecision;
  decisionReason: string | null;
  allocations: PlanAllocation[];
  plannedAtomic: bigint;
  plannedCalls: number;
}

export interface PlanAuditsOptions {
  caps: Caps;
  network: string;
  now: number;
  maxSellersPerDay: number;
  maxCallsPerSeller: number;
  exclude?: ExcludeConfig;
  /** Keep only these resources (operator audits: `--measured-only`, the resources we have paid before). */
  resourceFilter?: (r: { resource_id: number; url: string }) => boolean;
}

interface BuyableResource {
  resource_id: number;
  seller_id: number;
  domain: string;
  url: string;
  method: string;
  input_json: string | null;
  declared: string | null;
  quote: string | null;
}

/** A seller's resources we can form a request for, with the latest Base-exact 402 quote when probes have one. */
export function buyableResources(db: Db, sellerId: number, network: string): (BuyableResource & { price: bigint; basis: "probe" | "declared" })[] {
  const rows = db
    .prepare(
      `SELECT r.id resource_id, r.seller_id, s.domain, r.url, r.method, r.input_json, r.declared_price_atomic declared,
         (SELECT p.amount_atomic FROM probes p WHERE p.resource_id = r.id AND p.status = 402 AND p.amount_atomic IS NOT NULL
            AND (p.network = @network OR p.network IS NULL) ORDER BY p.ts DESC LIMIT 1) quote
       FROM resources r JOIN sellers s ON s.id = r.seller_id
       WHERE r.seller_id = @seller AND s.excluded = 0 AND r.network = @network AND COALESCE(r.scheme, 'exact') = 'exact'
         AND COALESCE(r.transfer_method, 'eip3009') != 'permit2'
       ORDER BY r.id`,
    )
    .all({ seller: sellerId, network }) as BuyableResource[];
  const out: (BuyableResource & { price: bigint; basis: "probe" | "declared" })[] = [];
  for (const r of rows) {
    if (/\/:[A-Za-z_]+|\{[^}]+\}/.test(r.url)) continue; // path template: cannot be fetched literally
    const q = r.quote && /^\d+$/.test(r.quote) ? r.quote : null;
    const d = r.declared && /^\d+$/.test(r.declared) ? r.declared : null;
    if (!q && !d) continue;
    out.push({ ...r, price: BigInt((q ?? d)!), basis: q ? "probe" : "declared" });
  }
  // Resources the seller was actually seen quoting first, then cheapest.
  return out.sort((a, b) => (a.basis === b.basis ? 0 : a.basis === "probe" ? -1 : 1) || (a.price < b.price ? -1 : a.price > b.price ? 1 : 0) || a.resource_id - b.resource_id);
}

/** Sellers with a planned audit or an audit purchase since 00:00 UTC. */
function sellersAuditedToday(db: Db, now: number): Set<number> {
  const day = utcDayStart(now);
  const ids = new Set<number>();
  for (const r of db.prepare("SELECT DISTINCT seller_id FROM audit_triggers WHERE decision = 'planned' AND evaluated_at >= ? AND seller_id IS NOT NULL").all(day) as { seller_id: number }[]) ids.add(r.seller_id);
  for (const r of db.prepare(`SELECT DISTINCT seller_id FROM calls WHERE source IN (${AUDIT_SOURCES.map(() => "?").join(",")}) AND ts >= ?`).all(...AUDIT_SOURCES, day) as { seller_id: number }[]) ids.add(r.seller_id);
  return ids;
}

/** Turn ordered triggers into audit allocations under the audit caps. Reads only, except `resource_states`. */
export function planAudits(db: Db, triggers: readonly Trigger[], o: PlanAuditsOptions): AuditPlanItem[] {
  const audited = sellersAuditedToday(db, o.now);
  let budget = o.caps.auditPerDayAtomic - spentAtomic(db, { since: utcDayStart(o.now), sources: AUDIT_SOURCES });
  if (budget < 0n) budget = 0n;
  const items: AuditPlanItem[] = [];
  const refuse = (t: Trigger, why: string) => items.push({ trigger: t, decision: "refused", decisionReason: why, allocations: [], plannedAtomic: 0n, plannedCalls: 0 });
  for (const t of triggers) {
    if (t.sellerId === null) {
      refuse(t, "not in the database: no resource URL to buy (the candidate import brings user-discovered sellers in)");
      continue;
    }
    if (o.exclude && isExcluded(o.exclude, t.host)) {
      refuse(t, "excluded by config/exclude.yaml");
      continue;
    }
    if (audited.has(t.sellerId)) {
      refuse(t, "already audited today");
      continue;
    }
    if (audited.size >= o.maxSellersPerDay) {
      refuse(t, `cap: at most ${o.maxSellersPerDay} audited sellers per UTC day`);
      continue;
    }
    const all = buyableResources(db, t.sellerId, o.network).filter((r) => (o.resourceFilter ? o.resourceFilter(r) : true));
    const over = all.filter((r) => r.price > o.caps.perCallAtomic);
    for (const r of over) recordTooExpensive(db, { resourceId: r.resource_id, quotedAtomic: r.price, capAtomic: o.caps.perCallAtomic, basis: r.basis, now: o.now });
    const res = all.filter((r) => r.price <= o.caps.perCallAtomic);
    if (!res.length) {
      refuse(t, all.length ? `every known resource quotes above the per-call cap ${atomicToUsd(o.caps.perCallAtomic)} USDC (recorded too_expensive)` : "no known resource we can form a request for");
      continue;
    }
    // Round-robin over the seller's resources until the per-seller call count or the day's audit budget runs out.
    const counts = new Map<number, number>();
    let spend = 0n;
    let calls = 0;
    for (let k = 0; calls < o.maxCallsPerSeller; k++) {
      const r = res[k % res.length]!;
      if (spend + r.price > budget) break;
      counts.set(r.resource_id, (counts.get(r.resource_id) ?? 0) + 1);
      spend += r.price;
      calls++;
    }
    if (calls === 0) {
      refuse(t, `cap: the day's audit budget (${atomicToUsd(o.caps.auditPerDayAtomic)} USDC) has ${atomicToUsd(budget)} USDC left, less than one call`);
      continue;
    }
    budget -= spend;
    audited.add(t.sellerId);
    const allocations: PlanAllocation[] = res
      .filter((r) => counts.has(r.resource_id))
      .map((r) => ({
        resourceId: r.resource_id,
        sellerId: r.seller_id,
        sellerDomain: r.domain,
        url: r.url,
        method: r.method,
        inputJson: r.input_json,
        tier: "audit" as const,
        category: "audit",
        priceAtomic: r.price,
        calls: counts.get(r.resource_id)!,
      }));
    items.push({
      trigger: t,
      decision: "planned",
      decisionReason: calls < o.maxCallsPerSeller ? `${calls} of ${o.maxCallsPerSeller} calls fit the day's audit budget` : null,
      allocations,
      plannedAtomic: spend,
      plannedCalls: calls,
    });
  }
  return items;
}

export interface OperatorAuditOptions {
  hosts: string[];
  /** Paid calls per host, round-robin over its resources. */
  calls: number;
  /** Hard limit on the whole plan, refused (nothing bought) when the plan is above it. */
  maxUsd: number;
  reason: string;
  /** Only resources this seller has been paid on before (a re-measurement of the disputed endpoints). */
  measuredOnly: boolean;
  caps: Caps;
  network: string;
  now: number;
  maxSellersPerDay: number;
  exclude?: ExcludeConfig;
}

/**
 * `audit-host`: the operator names the hosts (a seller's reply, a dispute). Same planner and caps as a triggered audit
 * (per call, per seller per day, the day's audit budget, at most AUDIT_MAX_SELLERS_PER_DAY, never twice a day), plus the
 * operator's own --max-usd on the whole plan: above it every item is refused and nothing is bought. Source audit_operator,
 * so the calls count in the seller's own series and never in the headline.
 */
export function planOperatorAudit(db: Db, o: OperatorAuditOptions): { items: AuditPlanItem[]; plannedAtomic: bigint; withinMax: boolean } {
  const byHost = sellerIdsByHostLocal(db);
  const measured = new Map(measuredSeriesLocal(db, o).map((m) => [m.sellerId, m]));
  const triggers: Trigger[] = o.hosts.map((raw) => {
    const host = raw.trim().toLowerCase().replace(/\.$/, "").replace(/^www\./, "");
    const sellerId = byHost.get(host) ?? null;
    const m = sellerId !== null ? (measured.get(sellerId) ?? null) : null;
    return {
      host,
      sellerId,
      reasons: ["operator"],
      source: CALL_SOURCES.AUDIT_OPERATOR,
      priority: 0,
      inputs: {
        reported: null,
        measured: m ? { ...m, last_call: m.lastCallTs == null ? null : new Date(m.lastCallTs).toISOString(), verdict: measuredVerdict(m) } : null,
        demand: null,
        operator: { reason: o.reason, calls: o.calls, maxUsd: o.maxUsd.toFixed(6), measuredOnly: o.measuredOnly },
      },
    };
  });
  const paidBefore = new Set((db.prepare("SELECT DISTINCT resource_id FROM calls WHERE paid = 1").all() as { resource_id: number }[]).map((r) => r.resource_id));
  const items = planAudits(db, triggers, {
    caps: o.caps,
    network: o.network,
    now: o.now,
    maxSellersPerDay: o.maxSellersPerDay,
    maxCallsPerSeller: o.calls,
    ...(o.exclude ? { exclude: o.exclude } : {}),
    ...(o.measuredOnly ? { resourceFilter: (r: { resource_id: number }) => paidBefore.has(r.resource_id) } : {}),
  });
  const plannedAtomic = items.reduce((s, i) => s + i.plannedAtomic, 0n);
  const maxAtomic = BigInt(Math.round(o.maxUsd * 1_000_000));
  const withinMax = plannedAtomic <= maxAtomic;
  if (!withinMax)
    return {
      items: items.map((i) => (i.decision === "planned" ? { ...i, decision: "refused" as const, decisionReason: `operator --max-usd ${o.maxUsd.toFixed(6)}: the whole plan is ${atomicToUsd(plannedAtomic)} USDC; nothing bought`, allocations: [], plannedAtomic: 0n, plannedCalls: 0 } : i)),
      plannedAtomic,
      withinMax,
    };
  return { items, plannedAtomic, withinMax };
}

/** Write every decision (with its inputs) before anything is spent. Returns the row id per item. */
export function recordDecisions(db: Db, items: readonly AuditPlanItem[], o: { now: number; runId?: number }): number[] {
  const ins = db.prepare(
    `INSERT INTO audit_triggers (evaluated_at, run_id, host, seller_id, reasons_json, source, priority, inputs_json, decision, decision_reason, planned_calls, planned_atomic)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
  );
  return db.transaction(() =>
    items.map((it) =>
      Number(
        ins.run(
          o.now,
          o.runId ?? null,
          it.trigger.host,
          it.trigger.sellerId,
          JSON.stringify(it.trigger.reasons),
          it.trigger.source,
          it.trigger.priority,
          JSON.stringify({ ...it.trigger.inputs, allocations: it.allocations.map((a) => ({ resource_id: a.resourceId, url: a.url, calls: a.calls, price_atomic: a.priceAtomic.toString() })) }),
          it.decision,
          it.decisionReason,
          it.plannedCalls,
          it.plannedAtomic.toString(),
        ).lastInsertRowid,
      ),
    ),
  )();
}

export function renderAuditPlan(items: readonly AuditPlanItem[]): string {
  const lines = ["| # | host | reasons | source | decision | calls | planned USDC | note |", "|---:|---|---|---|---|---:|---:|---|"];
  items.forEach((it, k) =>
    lines.push(`| ${k + 1} | ${it.trigger.host} | ${it.trigger.reasons.join(", ")} | ${it.trigger.source} | ${it.decision} | ${it.plannedCalls} | ${atomicToUsd(it.plannedAtomic)} | ${it.decisionReason ?? ""} |`),
  );
  if (!items.length) lines.push("| | (no seller triggered) | | | | | | |");
  const planned = items.filter((i) => i.plannedCalls > 0);
  lines.push("", `${planned.length} seller(s) with planned calls, ${planned.reduce((s, i) => s + i.plannedCalls, 0)} call(s), ${atomicToUsd(planned.reduce((s, i) => s + i.plannedAtomic, 0n))} USDC.`);
  return lines.join("\n") + "\n";
}

export interface AuditResult {
  host: string;
  triggered_at: string;
  reason: string;
  calls: number;
  failures: number;
  rate: number | null;
  wilson_low: number | null;
  wilson_high: number | null;
  evidence_url: string;
}

export const EVIDENCE_BASE = "https://raw.githubusercontent.com/sarmadahsan/paidfor-data/main/evidence/";

/** The audit's own numbers: its paid-denominator calls and failures (same definitions as the report). */
export function auditResult(db: Db, o: { runId: number; sellerId: number; host: string; triggeredAt: number; reason: string }): AuditResult {
  const rows = db.prepare("SELECT outcome, flags_json FROM calls WHERE run_id = ? AND seller_id = ?").all(o.runId, o.sellerId) as { outcome: string | null; flags_json: string }[];
  let n = 0;
  let f = 0;
  for (const r of rows) {
    let flags: string[] = [];
    try {
      flags = JSON.parse(r.flags_json) as string[];
    } catch {
      flags = [];
    }
    if (!r.outcome || !PAID_DENOMINATOR_OUTCOMES.has(r.outcome as never) || flags.includes(FLAGS.UNPAID_OVERCHARGE)) continue;
    n++;
    if (HEADLINE_FAILURE_OUTCOMES.has(r.outcome as never)) f++;
  }
  const c = n > 0 ? countRate(f, n) : null;
  return {
    host: o.host,
    triggered_at: new Date(o.triggeredAt).toISOString(),
    reason: o.reason,
    calls: n,
    failures: f,
    rate: c?.rate ?? null,
    wilson_low: c?.lo ?? null,
    wilson_high: c?.hi ?? null,
    evidence_url: evidenceUrlFor(o.host),
  };
}

/** docs/audit-callback.md: body signed as HMAC-SHA256(secret, `${timestamp}.${body}`). */
export function signAuditBody(secret: string, timestamp: string, body: string): string {
  return "sha256=" + createHmac("sha256", secret).update(`${timestamp}.${body}`).digest("hex");
}

/** The evidence file the index links for a host (same name the export writes). */
export function evidenceUrlFor(host: string): string {
  return EVIDENCE_BASE + host.toLowerCase().replace(/[^a-z0-9.-]/g, "_") + ".json";
}

export interface AuditPost {
  /** `posted`, `skipped_no_secret`, or `failed:<http status or error>` (the value stored in audit_results.post_status). */
  status: string;
  /** The index's HTTP status, or null when no response arrived. */
  http: number | null;
}

/** POST the result to `{index}/v1/audits`, signed with the secret (never logged). The secret is only ever read here and by the caller from the environment. */
export async function postAuditResultDetailed(index: string, secret: string, result: AuditResult, fetchImpl: FetchImpl = fetch, now = Date.now()): Promise<AuditPost> {
  if (!secret) return { status: "skipped_no_secret", http: null };
  const body = JSON.stringify(result);
  const ts = String(Math.floor(now / 1000));
  try {
    const res = await fetchImpl(`${index.replace(/\/$/, "")}/v1/audits`, {
      method: "POST",
      headers: { "content-type": "application/json", "x-paidfor-audit-timestamp": ts, "x-paidfor-audit-signature": signAuditBody(secret, ts, body) },
      body,
    });
    return { status: res.ok ? "posted" : `failed:${res.status}`, http: res.status };
  } catch (e) {
    return { status: `failed:${(e as Error).message}`, http: null };
  }
}

export async function postAuditResult(index: string, secret: string, result: AuditResult, fetchImpl: FetchImpl = fetch, now = Date.now()): Promise<string> {
  return (await postAuditResultDetailed(index, secret, result, fetchImpl, now)).status;
}

export interface StoredAuditResult {
  id: number;
  trigger_id: number;
  run_id: number | null;
  host: string;
  source: string;
  finished_at: number;
  calls: number;
  failures: number;
  rate: number | null;
  wilson_low: number | null;
  wilson_high: number | null;
  post_status: string | null;
  posted_at: number | null;
  /** The trigger's first reason (`operator`, `disagreement`, ...), as the original post carried it. */
  reason: string;
}

const STORED_SELECT = `SELECT a.id, a.trigger_id, a.run_id, a.host, a.source, a.finished_at, a.calls, a.failures, a.rate, a.wilson_low, a.wilson_high, a.post_status, a.posted_at, t.reasons_json
  FROM audit_results a JOIN audit_triggers t ON t.id = a.trigger_id`;

function storedRow(r: Record<string, unknown> | undefined): StoredAuditResult | null {
  if (!r) return null;
  let reasons: unknown = [];
  try {
    reasons = JSON.parse(String(r.reasons_json));
  } catch {
    reasons = [];
  }
  const reason = Array.isArray(reasons) && typeof reasons[0] === "string" ? (reasons[0] as string) : "operator";
  const { reasons_json: _r, ...rest } = r;
  return { ...(rest as Omit<StoredAuditResult, "reason">), reason };
}

/** One stored audit result by id, with its trigger's reason. */
export function storedAuditResult(db: Db, id: number): StoredAuditResult | null {
  return storedRow(db.prepare(`${STORED_SELECT} WHERE a.id = ?`).get(id) as Record<string, unknown> | undefined);
}

/** The newest stored audit result for a host (as the index names it). */
export function latestStoredAuditResult(db: Db, host: string): StoredAuditResult | null {
  const h = host.trim().toLowerCase().replace(/\.$/, "").replace(/^www\./, "");
  return storedRow(db.prepare(`${STORED_SELECT} WHERE lower(a.host) = ? ORDER BY a.finished_at DESC, a.id DESC LIMIT 1`).get(h) as Record<string, unknown> | undefined);
}

/**
 * The body a stored result posts as: the nine fields of docs/audit-callback.md, from the stored figures. `triggered_at`
 * is the stored `finished_at`, so the same stored row always produces the same body and the index's replay rule
 * (same host and triggered_at answers 200 and stores nothing) makes a repeated re-post idempotent.
 */
export function storedAuditBody(r: StoredAuditResult): AuditResult {
  return {
    host: r.host,
    triggered_at: new Date(r.finished_at).toISOString(),
    reason: r.reason,
    calls: r.calls,
    failures: r.failures,
    rate: r.rate,
    wilson_low: r.wilson_low,
    wilson_high: r.wilson_high,
    evidence_url: evidenceUrlFor(r.host),
  };
}

export interface RepostOptions {
  index: string;
  /** AUDIT_SECRET from the environment; never printed or stored. */
  secret: string;
  /** Re-send a result whose stored post_status is already `posted` (otherwise it is skipped as `already_posted`). */
  force?: boolean;
  fetchImpl?: FetchImpl;
  now?: number;
}

export interface RepostOutcome {
  id: number;
  host: string;
  body: AuditResult;
  /** `posted`, `already_posted`, `skipped_no_secret`, or `failed:<status>`. */
  status: string;
  http: number | null;
}

/**
 * `audit-post`: re-send a stored audit-host (or triggered audit) result to the index, signed like the original post.
 * Spends nothing and reads nothing but the stored row; on a response the row's post_status (and posted_at when the
 * index accepted it) are updated so the stored outcome matches what the index holds.
 */
export async function repostAuditResult(db: Db, r: StoredAuditResult, o: RepostOptions): Promise<RepostOutcome> {
  const body = storedAuditBody(r);
  if (r.post_status === "posted" && !o.force) return { id: r.id, host: r.host, body, status: "already_posted", http: null };
  const p = await postAuditResultDetailed(o.index, o.secret, body, o.fetchImpl ?? fetch, o.now ?? Date.now());
  if (p.status !== "skipped_no_secret") {
    const at = o.now ?? Date.now();
    db.prepare("UPDATE audit_results SET post_status = ?, posted_at = CASE WHEN ? = 'posted' THEN ? ELSE posted_at END WHERE id = ?").run(p.status, p.status, at, r.id);
  }
  return { id: r.id, host: r.host, body, status: p.status, http: p.http };
}

export interface RunAuditsOptions extends Omit<RunBuyOptions, "plan" | "source" | "capScope" | "runId"> {
  index: string;
  secret: string;
  triggerIds: number[];
  fetchImpl?: FetchImpl;
  startRun: (host: string) => number;
  log: Logger;
}

/** Execute the planned audits one seller at a time, then store and post each result. */
export async function runAudits(db: Db, items: readonly AuditPlanItem[], o: RunAuditsOptions): Promise<{ host: string; result: AuditResult; post: string; halted: boolean }[]> {
  const out: { host: string; result: AuditResult; post: string; halted: boolean }[] = [];
  for (let k = 0; k < items.length; k++) {
    const it = items[k]!;
    if (it.decision !== "planned" || !it.allocations.length || it.trigger.sellerId === null) continue;
    const plan: BuyPlan = {
      network: o.network,
      seed: 0,
      createdAt: Date.now(),
      targetCalls: it.plannedCalls,
      strata: [],
      totalCalls: it.plannedCalls,
      totalSpendAtomic: it.plannedAtomic,
      sampleMaxTotalAtomic: o.caps.auditPerDayAtomic,
      allocations: it.allocations,
      notes: [],
    };
    const runId = o.startRun(it.trigger.host);
    const stats = await runBuy(db, { ...o, plan, source: it.trigger.source, capScope: "audit", runId });
    const result = auditResult(db, { runId, sellerId: it.trigger.sellerId, host: it.trigger.host, triggeredAt: Date.now(), reason: it.trigger.reasons[0]! });
    const post = o.dryRun ? "skipped_dry_run" : await postAuditResult(o.index, o.secret, result, o.fetchImpl);
    if (!o.dryRun)
      db.prepare(
        `INSERT INTO audit_results (trigger_id, run_id, host, source, finished_at, calls, failures, rate, wilson_low, wilson_high, post_status, posted_at)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      ).run(o.triggerIds[k] ?? null, runId, it.trigger.host, it.trigger.source, Date.now(), result.calls, result.failures, result.rate, result.wilson_low, result.wilson_high, post, post === "posted" ? Date.now() : null);
    o.log.info(`audit ${it.trigger.host}: ${result.calls} denominator call(s), ${result.failures} failure(s); post ${post}`);
    out.push({ host: it.trigger.host, result, post, halted: stats.halted });
    if (stats.halted) {
      o.log.warn(`audit run halted (${stats.haltReason}); remaining audits skipped`);
      break;
    }
  }
  return out;
}
