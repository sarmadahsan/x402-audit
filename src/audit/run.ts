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
    const all = buyableResources(db, t.sellerId, o.network);
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
    evidence_url: EVIDENCE_BASE + o.host.toLowerCase().replace(/[^a-z0-9.-]/g, "_") + ".json",
  };
}

/** docs/audit-callback.md: body signed as HMAC-SHA256(secret, `${timestamp}.${body}`). */
export function signAuditBody(secret: string, timestamp: string, body: string): string {
  return "sha256=" + createHmac("sha256", secret).update(`${timestamp}.${body}`).digest("hex");
}

export async function postAuditResult(index: string, secret: string, result: AuditResult, fetchImpl: FetchImpl = fetch, now = Date.now()): Promise<string> {
  if (!secret) return "skipped_no_secret";
  const body = JSON.stringify(result);
  const ts = String(Math.floor(now / 1000));
  try {
    const res = await fetchImpl(`${index.replace(/\/$/, "")}/v1/audits`, {
      method: "POST",
      headers: { "content-type": "application/json", "x-paidfor-audit-timestamp": ts, "x-paidfor-audit-signature": signAuditBody(secret, ts, body) },
      body,
    });
    return res.ok ? "posted" : `failed:${res.status}`;
  } catch (e) {
    return `failed:${(e as Error).message}`;
  }
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
