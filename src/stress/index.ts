/**
 * `stress`: two client-behaviour experiments, run through the same paid-call path as `buy`
 * (src/pipeline/paidCall.ts). Stress rows are distinguished only by calls.source
 * ('stress_duplicate' | 'stress_timeout'); headline report queries filter on source = 'buy'.
 *
 * - duplicate: one purchase intent, two back-to-back paid calls (a fresh signature each, as a naive
 *   client that retries without idempotency would produce). Counts on-chain settlements per intent.
 * - timeout: call 1 aborts the connection `abortAfterMs` after sending the payment; we then wait for the
 *   chain and record whether it settled anyway; call 2 retries the same intent with a new signature and
 *   we record whether that produced a second settlement.
 *
 * Caps: every call is checked against per-seller-per-day, per-day and STRESS_MAX_TOTAL_USD before signing.
 */
import { randomUUID } from "node:crypto";
import type { Db } from "../db/index.js";
import { atomicToUsd, isExcluded, type Caps, type ExcludeConfig } from "../config/index.js";
import { log as defaultLog } from "../log.js";
import { runPaidCall, type PaidCallOutput, type SettlementLookup } from "../pipeline/paidCall.js";
import { haltRequested } from "../safety.js";
import type { CallSource } from "../taxonomy.js";
import type { Payer } from "../x402/pay.js";
import { checkCaps, confirmingLookup, finishRun, guardPayer, insertHalt, startRun, type CapBreach, type ConfirmPolicy, type Logger } from "../buy/guard.js";
import { referencePriceFor } from "../buy/reference.js";
import { loadServiceConfigs, serviceLookup, type ServiceLookup } from "../buy/services.js";

export interface ResourceRef {
  resourceId: number;
  sellerId: number;
  sellerDomain: string;
  url: string;
  method?: string;
  priceAtomic?: bigint;
}

export interface StressOptions extends ConfirmPolicy {
  payers: Payer[];
  /** Uses caps.stressTotalAtomic (STRESS_MAX_TOTAL_USD) as the total; per-call, per-seller-per-day and per-day as usual. */
  caps: Caps;
  network: string;
  settlementLookup?: SettlementLookup;
  settlementLookupFactory?: () => Promise<SettlementLookup>;
  /** Default: selectStressResources(db, ...) (cheapest eligible resource of each of 10 sellers ranked 1..30). */
  resources?: ResourceRef[];
  services?: ServiceLookup;
  defaultMaxTimeoutSeconds?: number;
  timeoutMs?: number;
  runId?: number;
  configHash?: string;
  exclude?: ExcludeConfig;
  log?: Logger;
  now?: () => number;
  haltRoot?: string;
  dryRun?: boolean;
}

export interface StressTimeoutOptions extends StressOptions {
  /** Abort the paid request this long after sending it (default 2000 ms). */
  abortAfterMs?: number;
}

export interface StressDuplicateRow {
  resourceId: number;
  url: string;
  intentId: string;
  callIds: number[];
  settlements: number;
  doubleSettled: boolean;
}

export interface StressTimeoutRow {
  resourceId: number;
  url: string;
  intentId: string;
  callIds: number[];
  firstAborted: boolean;
  settledDespiteAbort: boolean;
  secondSettlementOnRetry: boolean;
  settlements: number;
}

export interface StressResult<R> {
  runId: number;
  rows: R[];
  halted: boolean;
  haltReason?: string;
  spentAtomic: bigint;
}

/** Cheapest eligible resource of each of `count` sellers with rank_30d in 1..maxRank, by rank. */
export function selectStressResources(db: Db, o: { network: string; caps: Caps; count?: number; maxRank?: number; exclude?: ExcludeConfig }): ResourceRef[] {
  const rows = db
    .prepare(
      `SELECT r.id, r.seller_id, s.domain, r.url, r.method, r.declared_price_atomic price, s.rank_30d
       FROM resources r JOIN sellers s ON s.id = r.seller_id
       WHERE r.network = ? AND r.scheme = 'exact' AND COALESCE(r.transfer_method, 'eip3009') != 'permit2'
         AND r.declared_price_atomic IS NOT NULL AND s.excluded = 0 AND s.rank_30d BETWEEN 1 AND ?
       ORDER BY s.rank_30d, r.id`,
    )
    .all(o.network, o.maxRank ?? 30) as { id: number; seller_id: number; domain: string; url: string; method: string; price: string; rank_30d: number }[];
  const best = new Map<number, ResourceRef & { rank: number }>();
  for (const r of rows) {
    if (!/^\d+$/.test(r.price) || BigInt(r.price) > o.caps.perCallAtomic) continue;
    if (o.exclude && isExcluded(o.exclude, r.domain, r.url)) continue;
    const cur = best.get(r.seller_id);
    if (!cur || BigInt(r.price) < cur.priceAtomic!)
      best.set(r.seller_id, { resourceId: r.id, sellerId: r.seller_id, sellerDomain: r.domain, url: r.url, method: r.method, priceAtomic: BigInt(r.price), rank: r.rank_30d });
  }
  return [...best.values()]
    .sort((a, b) => a.rank - b.rank)
    .slice(0, o.count ?? 10)
    .map(({ rank: _rank, ...ref }) => ref);
}

interface Ctx {
  db: Db;
  o: StressOptions;
  runId: number;
  L: Logger;
  now: () => number;
  services: ServiceLookup;
  halt: (reason: string, details: unknown) => void;
  state: { halted: boolean; haltReason?: string; spent: bigint };
}

function setup(db: Db, o: StressOptions, subcommand: string): Ctx {
  if (o.payers.length === 0) throw new Error(`${subcommand}: at least one payer is required`);
  if (!o.dryRun && !o.settlementLookup && !o.settlementLookupFactory) throw new Error(`${subcommand}: settlementLookup or settlementLookupFactory is required`);
  const now = o.now ?? Date.now;
  const L = o.log ?? defaultLog;
  const runId =
    o.runId ??
    startRun(db, {
      subcommand,
      args: { resources: o.resources?.map((r) => r.resourceId) ?? "auto", wallets: o.payers.map((p) => p.address) },
      ...(o.configHash !== undefined ? { configHash: o.configHash } : {}),
      network: o.network,
      dryRun: Boolean(o.dryRun),
      now: now(),
    });
  const state: Ctx["state"] = { halted: false, spent: 0n };
  return {
    db,
    o,
    runId,
    L,
    now,
    services: o.services ?? serviceLookup(loadServiceConfigs()),
    state,
    halt: (reason, details) => {
      state.halted = true;
      state.haltReason = reason;
      if (!o.dryRun) insertHalt(db, runId, reason, details, now());
      L.warn(`${subcommand} halted: ${reason}`, details);
    },
  };
}

/** One guarded paid call. Returns undefined when a cap or the halt file stopped it (and the run). */
async function stressCall(
  c: Ctx,
  r: ResourceRef,
  payer: Payer,
  source: CallSource,
  intentId: string,
  extra: { abortAfterMs?: number } = {},
): Promise<PaidCallOutput | undefined> {
  const { db, o } = c;
  if (haltRequested(o.haltRoot, "stress")) {
    c.halt("halt_file", { root: o.haltRoot ?? process.cwd() });
    return undefined;
  }
  const reference = referencePriceFor(db, r.resourceId, c.now());
  const expected = BigInt(reference?.amountAtomic ?? (r.priceAtomic ?? 0n).toString());
  const pre = checkCaps(db, { caps: o.caps, sellerId: r.sellerId, amountAtomic: expected, now: c.now(), scope: "stress" });
  if (pre && pre.reason !== "cap_per_call") {
    c.halt(pre.reason, { ...pre.details, resourceId: r.resourceId, stage: "before_quote" });
    return undefined;
  }
  let breach: CapBreach | null = null;
  const guarded = guardPayer(payer, {
    perCallCapAtomic: o.caps.perCallAtomic,
    guard: (amount) => checkCaps(db, { caps: o.caps, sellerId: r.sellerId, amountAtomic: amount, now: c.now(), scope: "stress" }),
    onBreach: (b) => (breach = b),
  });
  const base = o.settlementLookupFactory ? await o.settlementLookupFactory() : o.settlementLookup!;
  const service = c.services(r.sellerDomain);
  const out = await runPaidCall({
    db,
    payer: guarded.payer,
    runId: c.runId,
    source,
    intentId,
    resource: { id: r.resourceId, sellerId: r.sellerId, url: r.url, ...(r.method ? { method: r.method } : {}) },
    ...(reference ? { reference } : {}),
    perCallCapAtomic: o.caps.perCallAtomic,
    ...(service ? { service } : {}),
    defaultMaxTimeoutSeconds: o.defaultMaxTimeoutSeconds ?? 30,
    settlementLookup: confirmingLookup(base, guarded.last, o),
    ...(o.timeoutMs !== undefined ? { timeoutMs: o.timeoutMs } : {}),
    ...(extra.abortAfterMs !== undefined ? { abortAfterMs: extra.abortAfterMs } : {}),
    now: c.now,
  });
  if (out.result.signed) c.state.spent += BigInt(out.result.signed.value);
  if (breach) {
    const b = breach as CapBreach;
    c.halt(b.reason, { ...b.details, resourceId: r.resourceId, callId: out.callId, stage: "before_sign" });
    return undefined;
  }
  return out;
}

const settlementsForIntent = (db: Db, intentId: string) =>
  (db.prepare(`SELECT COUNT(DISTINCT tx_hash) n FROM settlements WHERE intent_id = ?`).get(intentId) as { n: number }).n;
const settlementsForCall = (db: Db, callId: number) => (db.prepare(`SELECT COUNT(DISTINCT tx_hash) n FROM settlements WHERE call_id = ?`).get(callId) as { n: number }).n;

function finish<R>(c: Ctx, rows: R[]): StressResult<R> {
  finishRun(
    c.db,
    c.runId,
    c.state.halted ? "halted" : "completed",
    JSON.stringify({ intents: rows.length, spentAtomic: c.state.spent.toString(), haltReason: c.state.haltReason ?? null }),
    c.now(),
  );
  return { runId: c.runId, rows, halted: c.state.halted, ...(c.state.haltReason ? { haltReason: c.state.haltReason } : {}), spentAtomic: c.state.spent };
}

export async function runStressDuplicate(db: Db, o: StressOptions): Promise<StressResult<StressDuplicateRow>> {
  const c = setup(db, o, "stress duplicate");
  const resources = o.resources ?? selectStressResources(db, { network: o.network, caps: o.caps, ...(o.exclude ? { exclude: o.exclude } : {}) });
  const rows: StressDuplicateRow[] = [];
  for (const [i, r] of resources.entries()) {
    const payer = o.payers[i % o.payers.length]!;
    if (o.dryRun) {
      c.L.info(`[dry-run] stress duplicate: 2 paid calls, one intent, ${r.url} wallet=${payer.address}`);
      continue;
    }
    const intentId = randomUUID();
    const a = await stressCall(c, r, payer, "stress_duplicate", intentId);
    if (!a) break;
    const b = await stressCall(c, r, payer, "stress_duplicate", intentId);
    const callIds = b ? [a.callId, b.callId] : [a.callId];
    const n = settlementsForIntent(db, intentId);
    rows.push({ resourceId: r.resourceId, url: r.url, intentId, callIds, settlements: n, doubleSettled: n > 1 });
    if (n > 1) {
      // docs/taxonomy.md: "the same purchase intent produced more than one on-chain settlement" is `duplicate`.
      // Both rows of the intent get the outcome; the stress report still counts per intent.
      db.prepare(`UPDATE calls SET outcome = 'duplicate', settlement_count = ?, classified_at = ? WHERE intent_id = ? AND source = 'stress_duplicate'`).run(n, Date.now(), intentId);
    }
    c.L.info(`stress duplicate ${r.url}: ${n} settlement(s) for intent ${intentId.slice(0, 8)}`);
    if (!b) break;
  }
  return finish(c, rows);
}

export async function runStressTimeout(db: Db, o: StressTimeoutOptions): Promise<StressResult<StressTimeoutRow>> {
  const c = setup(db, o, "stress timeout");
  const resources = o.resources ?? selectStressResources(db, { network: o.network, caps: o.caps, ...(o.exclude ? { exclude: o.exclude } : {}) });
  const abortAfterMs = o.abortAfterMs ?? 2000;
  const rows: StressTimeoutRow[] = [];
  for (const [i, r] of resources.entries()) {
    const payer = o.payers[i % o.payers.length]!;
    if (o.dryRun) {
      c.L.info(`[dry-run] stress timeout: abort after ${abortAfterMs} ms then retry, ${r.url} wallet=${payer.address}`);
      continue;
    }
    const intentId = randomUUID();
    // Call 1: abort shortly after the payment is sent; the paid-call lookup then waits for the chain.
    const a = await stressCall(c, r, payer, "stress_timeout", intentId, { abortAfterMs });
    if (!a) break;
    const firstAborted = a.result.error?.kind === "aborted" || a.result.error?.kind === "timeout";
    const firstSettled = settlementsForCall(db, a.callId) > 0;
    // Call 2: what a naive client does next: retry the same purchase with a fresh signature.
    const b = await stressCall(c, r, payer, "stress_timeout", intentId);
    const secondSettled = b ? settlementsForCall(db, b.callId) > 0 : false;
    const n = settlementsForIntent(db, intentId);
    rows.push({
      resourceId: r.resourceId,
      url: r.url,
      intentId,
      callIds: b ? [a.callId, b.callId] : [a.callId],
      firstAborted,
      settledDespiteAbort: firstAborted && firstSettled,
      secondSettlementOnRetry: firstSettled && secondSettled,
      settlements: n,
    });
    c.L.info(`stress timeout ${r.url}: aborted=${firstAborted} settledAnyway=${firstSettled} retrySettled=${secondSettled}`);
    if (!b) break;
  }
  return finish(c, rows);
}

/** Markdown report over every stress row in the DB (both tests), per resource and in total. */
export function stressReport(db: Db): string {
  type CallRow = { id: number; intent_id: string; resource_id: number; url: string; error: string | null; amount_paid_atomic: string | null; source: string };
  const calls = db
    .prepare(
      `SELECT c.id, c.intent_id, c.resource_id, r.url, c.error, c.amount_paid_atomic, c.source
       FROM calls c JOIN resources r ON r.id = c.resource_id
       WHERE c.source IN ('stress_duplicate', 'stress_timeout') ORDER BY c.id`,
    )
    .all() as CallRow[];
  const byIntent = new Map<string, CallRow[]>();
  for (const c of calls) {
    const k = `${c.source}\0${c.intent_id}`;
    const l = byIntent.get(k);
    if (l) l.push(c);
    else byIntent.set(k, [c]);
  }
  const perCall = (id: number) => settlementsForCall(db, id);
  const spentOf = (l: CallRow[]) => l.reduce((s, c) => s + (c.amount_paid_atomic && /^\d+$/.test(c.amount_paid_atomic) ? BigInt(c.amount_paid_atomic) : 0n), 0n);

  const dup: string[] = [];
  const to: string[] = [];
  const tot = { dupIntents: 0, doubleSettled: 0, toIntents: 0, settledDespiteAbort: 0, secondOnRetry: 0, spent: 0n };
  for (const [k, l] of byIntent) {
    const source = k.split("\0")[0];
    const first = l[0]!;
    const n = settlementsForIntent(db, first.intent_id);
    tot.spent += spentOf(l);
    if (source === "stress_duplicate") {
      tot.dupIntents++;
      if (n > 1) tot.doubleSettled++;
      dup.push(`| ${first.url} | \`${first.intent_id.slice(0, 8)}\` | ${l.length} | ${n} | ${n > 1 ? "**yes**" : "no"} | $${atomicToUsd(spentOf(l))} |`);
    } else {
      tot.toIntents++;
      const aborted = /^(aborted|timeout):/.test(first.error ?? "");
      const s1 = perCall(first.id) > 0;
      const s2 = l[1] ? perCall(l[1].id) > 0 : false;
      if (aborted && s1) tot.settledDespiteAbort++;
      if (s1 && s2) tot.secondOnRetry++;
      to.push(
        `| ${first.url} | \`${first.intent_id.slice(0, 8)}\` | ${aborted ? "yes" : "no"} | ${aborted && s1 ? "**yes**" : "no"} | ${l[1] ? (s1 && s2 ? "**yes**" : "no") : "not retried"} | ${n} | $${atomicToUsd(spentOf(l))} |`,
      );
    }
  }
  const out = [
    "# Stress report",
    "",
    "Stress rows are excluded from the headline numbers (calls.source != 'buy').",
    "",
    "## Duplicate: one intent, two back-to-back paid calls",
    "",
    "| resource | intent | calls | settlements | double-settled | spent |",
    "|---|---|---:|---:|---|---:|",
    ...(dup.length ? dup : ["| (none) | | | | | |"]),
    "",
    "## Timeout: abort after payment, then a naive retry",
    "",
    "| resource | intent | call 1 aborted | settled despite abort | second settlement on retry | settlements | spent |",
    "|---|---|---|---|---|---:|---:|",
    ...(to.length ? to : ["| (none) | | | | | | |"]),
    "",
    "## Totals",
    "",
    "| metric | value |",
    "|---|---:|",
    `| intents (duplicate test) | ${tot.dupIntents} |`,
    `| double-settled intents | ${tot.doubleSettled} |`,
    `| intents (timeout test) | ${tot.toIntents} |`,
    `| settled despite abort | ${tot.settledDespiteAbort} |`,
    `| second settlement on retry | ${tot.secondOnRetry} |`,
    `| total stress spend | $${atomicToUsd(tot.spent)} |`,
  ];
  return out.join("\n") + "\n";
}
