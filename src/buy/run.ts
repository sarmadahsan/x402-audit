/**
 * `buy`: execute a BuyPlan through the one paid-call path (src/pipeline/paidCall.ts runPaidCall).
 *
 * - Sequential by design. Each paid call waits for its settlement (confirmWithTimeout) before the next
 *   call starts. A confirmed call returns as soon as the Transfer + AuthorizationUsed receipt is seen
 *   (normally < 10 s on Base); an unconfirmed one waits up to `confirmTimeoutMs` (default 10 min), so a
 *   mainnet run spends up to 10 minutes per unconfirmed call. A visibly rejected payment (non-2xx and no
 *   successful PAYMENT-RESPONSE) waits only `rejectGraceMs` (default 60 s).
 * - Round-robin over resources, interleaving sellers, never hitting a resource more than once per
 *   `minSecondsBetweenCallsPerResource`.
 * - Wallet rotation per seller: seller i's k-th call uses payers[(i + k) % n].
 * - Caps are checked from the DB before every signature (and again in the pre-sign hook with the actual
 *   quote); a breach writes a `halts` row and stops the run. So does the `halt` file.
 * - A 429 backs that seller off for 5 minutes; the call is not retried.
 */
import type { Db } from "../db/index.js";
import type { Caps } from "../config/index.js";
import { log as defaultLog } from "../log.js";
import { exampleBodyFromInput, urlWithExampleQuery } from "../probe/run.js";
import { runPaidCall, type SettlementLookup } from "../pipeline/paidCall.js";
import { haltRequested } from "../safety.js";
import type { Payer } from "../x402/pay.js";
import type { BuyPlan, PlanAllocation } from "./plan.js";
import { referencePriceFor } from "./reference.js";
import { loadServiceConfigs, serviceLookup, type ServiceLookup } from "./services.js";
import {
  checkCaps,
  confirmingLookup,
  finishRun,
  guardPayer,
  insertHalt,
  startRun,
  type CapBreach,
  type ConfirmPolicy,
  type Logger, utcDayStart } from "./guard.js";

export const RATE_LIMIT_BACKOFF_MS = 5 * 60_000;

export interface RunBuyOptions extends ConfirmPolicy {
  plan: BuyPlan;
  /** One payer per wallet. */
  payers: Payer[];
  caps: Caps;
  network: string;
  /** Fixed lookup (e.g. mock ledger), or... */
  settlementLookup?: SettlementLookup;
  /** ...a factory called just before each call (captures the block number before signing). Preferred for chain. */
  settlementLookupFactory?: () => Promise<SettlementLookup>;
  /** Service config by seller domain. Default: config/schemas/*.json under process.cwd(). */
  services?: ServiceLookup;
  defaultMaxTimeoutSeconds?: number;
  minSecondsBetweenCallsPerResource?: number;
  /** Per HTTP request timeout passed to the payer (quote and paid request separately). */
  timeoutMs?: number;
  runId?: number;
  configHash?: string;
  log?: Logger;
  now?: () => number;
  sleep?: (ms: number) => Promise<void>;
  /** Directory checked for the `halt` file (default process.cwd()). */
  haltRoot?: string;
  dryRun: boolean;
  /** Concurrent calls, each to a different seller (default 1 = sequential). Caps are read from the DB before every
   * signature, so N workers can overshoot a cap by at most N-1 calls; per-resource spacing is unchanged. */
  concurrency?: number;
}

const BODY_METHODS = new Set(["POST", "PUT", "PATCH"]);
/** Same request shape the probe module uses: JSON body from the seller's Bazaar input example, else `{}`. */
export function requestBodyFor(method: string, inputJson: string | null): { headers?: Record<string, string>; body?: string } {
  if (!BODY_METHODS.has((method || "GET").toUpperCase())) return {};
  const ex = exampleBodyFromInput(inputJson);
  return { headers: { "content-type": "application/json" }, body: ex !== undefined ? JSON.stringify(ex) : "{}" };
}

/** True when this resource has at least one paid 2xx call with no settlement found (seen in any earlier run). */
export function knownUnsettled(db: Db, resourceId: number): boolean {
  const r = db.prepare("SELECT 1 FROM calls WHERE resource_id = ? AND paid = 1 AND settlement_count = 0 AND response_status BETWEEN 200 AND 299 LIMIT 1").get(resourceId);
  return Boolean(r);
}

export interface ScheduledCall {
  seq: number;
  at: number;
  resourceId: number;
  sellerId: number;
  url: string;
  wallet: string;
}

export interface BuyStats {
  runId: number;
  dryRun: boolean;
  calls: number;
  byOutcome: Record<string, number>;
  spentAtomic: bigint;
  halted: boolean;
  haltReason?: string;
  durationMs: number;
  callIds: number[];
  /** Every call made (live) or that would be made (dry run), in order. */
  schedule: ScheduledCall[];
  backoffs: { sellerId: number; until: number; reason: string }[];
  /** Calls dropped because a resource produced UNFORMABLE_AFTER consecutive malformed-request our_errors. */
  skippedUnformable: { resourceId: number; url: string; dropped: number }[];
}

/** After this many consecutive malformed-request our_errors on one resource, its remaining calls are dropped. */
export const UNFORMABLE_AFTER = 2;

interface Slot {
  alloc: PlanAllocation;
  remaining: number;
  lastAt: number;
}

/** Interleaved order: each seller's 1st resource, then each seller's 2nd, ... */
function interleave(allocs: PlanAllocation[]): { slots: Slot[]; sellerOrder: number[] } {
  const bySeller = new Map<number, PlanAllocation[]>();
  for (const a of allocs.filter((a) => a.calls > 0)) {
    const l = bySeller.get(a.sellerId);
    if (l) l.push(a);
    else bySeller.set(a.sellerId, [a]);
  }
  const sellerOrder = [...bySeller.keys()].sort((a, b) => a - b);
  for (const l of bySeller.values()) l.sort((a, b) => a.resourceId - b.resourceId);
  const slots: Slot[] = [];
  const depth = Math.max(0, ...[...bySeller.values()].map((l) => l.length));
  for (let d = 0; d < depth; d++)
    for (const s of sellerOrder) {
      const a = bySeller.get(s)![d];
      if (a) slots.push({ alloc: a, remaining: a.calls, lastAt: -Infinity });
    }
  return { slots, sellerOrder };
}

function priceEventFlag(db: Db, resourceId: number, kind: string, now: number): boolean {
  return Boolean(db.prepare(`SELECT 1 FROM price_events WHERE resource_id = ? AND kind = ? AND ts >= ? LIMIT 1`).get(resourceId, kind, now - 7 * 24 * 3600_000));
}

export async function runBuy(db: Db, o: RunBuyOptions): Promise<BuyStats> {
  if (o.payers.length === 0) throw new Error("runBuy: at least one payer is required");
  if (!o.dryRun && !o.settlementLookup && !o.settlementLookupFactory) throw new Error("runBuy: settlementLookup or settlementLookupFactory is required");
  for (const p of o.payers) if (p.network !== o.network) throw new Error(`payer ${p.address} is for ${p.network}, run is for ${o.network}`);
  const L = o.log ?? defaultLog;
  const realNow = o.now ?? Date.now;
  const realSleep = o.sleep ?? ((ms: number) => new Promise<void>((r) => setTimeout(r, ms)));
  // Dry run simulates the clock so the printed schedule shows real spacing without waiting.
  let virtual = realNow();
  const now = o.dryRun ? () => virtual : realNow;
  const sleep = o.dryRun ? async (ms: number) => void (virtual += ms) : realSleep;
  const gapMs = (o.minSecondsBetweenCallsPerResource ?? 60) * 1000;
  const defaultMaxTimeoutSeconds = o.defaultMaxTimeoutSeconds ?? 30;
  const services = o.services ?? serviceLookup(loadServiceConfigs());
  const t0 = realNow();

  const runId =
    o.runId ??
    startRun(db, {
      subcommand: "buy",
      args: { totalCalls: o.plan.totalCalls, totalSpendAtomic: o.plan.totalSpendAtomic, seed: o.plan.seed, minSecondsBetweenCallsPerResource: gapMs / 1000, wallets: o.payers.map((p) => p.address) },
      ...(o.configHash !== undefined ? { configHash: o.configHash } : {}),
      network: o.network,
      dryRun: o.dryRun,
      now: t0,
    });

  const stats: BuyStats = { runId, dryRun: o.dryRun, calls: 0, byOutcome: {}, spentAtomic: 0n, halted: false, durationMs: 0, callIds: [], schedule: [], backoffs: [], skippedUnformable: [] };
  const malformedStreak = new Map<number, number>();
  const { slots, sellerOrder } = interleave(o.plan.allocations);
  const sellerIdx = new Map(sellerOrder.map((s, i) => [s, i]));
  const sellerK = new Map<number, number>();
  const backoffUntil = new Map<number, number>();
  let cursor = 0;

  // A seller's daily cap is a per-seller limit, not a reason to stop every other seller: record it in `halts`
  // (so the breach is auditable) and park that seller until the next UTC day. Per-day and total caps still halt.
  const parkedSellers = new Set<number>();
  const parkSeller = (sellerId: number, details: unknown) => {
    const until = utcDayStart(realNow()) + 24 * 3_600_000;
    backoffUntil.set(sellerId, until);
    parkedSellers.add(sellerId);
    stats.backoffs.push({ sellerId, until, reason: "cap_per_seller_per_day" });
    if (!o.dryRun) insertHalt(db, runId, "cap_per_seller_per_day", { ...(details as object), action: "seller parked until next UTC day", until }, realNow());
    L.warn(`seller ${sellerId} reached its daily cap; parked until ${new Date(until).toISOString()}`, details);
  };
  const halt = (reason: string, details: unknown) => {
    stats.halted = true;
    stats.haltReason = reason;
    if (!o.dryRun) insertHalt(db, runId, reason, details, realNow());
    L.warn(`buy halted: ${reason}`, details);
  };

  const inflight = new Set<number>(); // seller ids with a call in progress: never two concurrent calls to one seller
  const worker = async (): Promise<void> => {
    for (;;) {
      if (stats.halted) return;
      if (haltRequested(o.haltRoot, "buy")) {
        halt("halt_file", { root: o.haltRoot ?? process.cwd() });
        return;
      }
      if (!slots.some((s) => s.remaining > 0)) return;
      const t = now();
      let pick: Slot | undefined;
      for (let j = 0; j < slots.length; j++) {
        const s = slots[(cursor + j) % slots.length]!;
        if (s.remaining <= 0) continue;
        if (inflight.has(s.alloc.sellerId)) continue;
        if ((backoffUntil.get(s.alloc.sellerId) ?? 0) > t) continue;
        if (t - s.lastAt < gapMs) continue;
        pick = s;
        cursor = (cursor + j + 1) % slots.length;
        break;
      }
      if (!pick) {
        if (inflight.size > 0) {
          await sleep(500); // everything eligible is busy in another worker; re-check soon
          continue;
        }
        // Only sellers parked by their daily cap are left: nothing more can be bought today. End the run
        // (status completed); a later `buy run` resumes the remaining allocations.
        if (slots.filter((s) => s.remaining > 0).every((s) => parkedSellers.has(s.alloc.sellerId))) {
          L.warn(`every remaining allocation belongs to a seller parked by its daily cap; ending the run`);
          return;
        }
        const next = Math.min(
          ...slots.filter((s) => s.remaining > 0).map((s) => Math.max(s.lastAt + gapMs, backoffUntil.get(s.alloc.sellerId) ?? 0)),
        );
        await sleep(Math.max(1, Math.min(next - t, 60_000)));
        continue;
      }

      const a = pick.alloc;
      inflight.add(a.sellerId);
      try {
      const k = sellerK.get(a.sellerId) ?? 0;
      const payer = o.payers[((sellerIdx.get(a.sellerId) ?? 0) + k) % o.payers.length]!;
      const reference = referencePriceFor(db, a.resourceId, t);
      const seq = stats.schedule.length + 1;
      stats.schedule.push({ seq, at: t, resourceId: a.resourceId, sellerId: a.sellerId, url: a.url, wallet: payer.address });
      pick.lastAt = t;
      pick.remaining--;
      sellerK.set(a.sellerId, k + 1);

      if (o.dryRun) {
        L.info(`[dry-run] #${seq} ${new Date(t).toISOString()} ${a.method} ${a.url} seller=${a.sellerDomain} wallet=${payer.address} price=${a.priceAtomic} ref=${reference?.amountAtomic ?? "-"}`);
        continue;
      }

      // Cap check before anything is quoted, using the expected price.
      const expected = BigInt(reference?.amountAtomic ?? a.priceAtomic.toString());
      const pre = checkCaps(db, { caps: o.caps, sellerId: a.sellerId, amountAtomic: expected, now: realNow(), scope: "buy" });
      if (pre && pre.reason === "cap_per_seller_per_day") {
        parkSeller(a.sellerId, { ...pre.details, resourceId: a.resourceId, stage: "before_quote" });
        continue;
      }
      if (pre && pre.reason !== "cap_per_call") {
        halt(pre.reason, { ...pre.details, resourceId: a.resourceId, stage: "before_quote" });
        return;
      }

      let breach: CapBreach | null = null;
      const guarded = guardPayer(payer, {
        perCallCapAtomic: o.caps.perCallAtomic,
        guard: (amount) => checkCaps(db, { caps: o.caps, sellerId: a.sellerId, amountAtomic: amount, now: realNow(), scope: "buy" }),
        onBreach: (b) => (breach = b),
      });
      const base = o.settlementLookupFactory ? await o.settlementLookupFactory() : o.settlementLookup!;
      const service = services(a.sellerDomain);
      const out = await runPaidCall({
        db,
        payer: guarded.payer,
        runId,
        source: "buy",
        resource: { id: a.resourceId, sellerId: a.sellerId, url: urlWithExampleQuery(a.url, a.inputJson ?? null), method: a.method, ...requestBodyFor(a.method, a.inputJson ?? null) },
        ...(reference ? { reference } : {}),
        perCallCapAtomic: o.caps.perCallAtomic,
        ...(service ? { service } : {}),
        defaultMaxTimeoutSeconds,
        // A resource that already delivered 2xx with no settlement visible to us (free delivery, or a settlement
        // path we cannot see) gets a short wait instead of the full window; `buy resolve` re-checks later.
        settlementLookup: confirmingLookup(base, guarded.last, knownUnsettled(db, a.resourceId) ? { ...o, confirmTimeoutMs: Math.min(o.confirmTimeoutMs ?? 600_000, 60_000) } : o),
        ...(o.timeoutMs !== undefined ? { timeoutMs: o.timeoutMs } : {}),
        payToChanged: priceEventFlag(db, a.resourceId, "payto_changed", t),
        priceDiscrimination: priceEventFlag(db, a.resourceId, "price_discrimination", t),
        now: realNow,
      });
      stats.calls++;
      stats.callIds.push(out.callId);
      stats.byOutcome[out.classification.outcome] = (stats.byOutcome[out.classification.outcome] ?? 0) + 1;
      if (out.result.signed) stats.spentAtomic += BigInt(out.result.signed.value);

      // A listing we cannot form a valid request from fails identically every time; stop spending slots on it.
      const malformed = out.classification.outcome === "our_error" && out.classification.reasons.some((r) => r.includes("malformed_request"));
      const streak = malformed ? (malformedStreak.get(a.resourceId) ?? 0) + 1 : 0;
      malformedStreak.set(a.resourceId, streak);
      if (streak >= UNFORMABLE_AFTER && pick.remaining > 0) {
        stats.skippedUnformable.push({ resourceId: a.resourceId, url: a.url, dropped: pick.remaining });
        L.warn(`unformable: ${a.url} rejected ${streak} requests in a row as malformed; dropping its remaining ${pick.remaining} call(s)`);
        pick.remaining = 0;
      }

      if (breach) {
        const b = breach as CapBreach;
        if (b.reason === "cap_per_seller_per_day") {
          parkSeller(a.sellerId, { ...b.details, resourceId: a.resourceId, callId: out.callId, stage: "before_sign" });
        } else {
          halt(b.reason, { ...b.details, resourceId: a.resourceId, callId: out.callId, stage: "before_sign" });
          return;
        }
      }
      if (out.result.response?.status === 429 || out.result.quoteResult?.status === 429) {
        const until = realNow() + RATE_LIMIT_BACKOFF_MS;
        backoffUntil.set(a.sellerId, until);
        stats.backoffs.push({ sellerId: a.sellerId, until, reason: `429 from ${a.url}` });
        L.warn(`seller ${a.sellerDomain} returned 429; backing off until ${new Date(until).toISOString()}`);
      }
      } catch (e) {
        // One bad call must not take the whole pool down: record it and keep going (money is tracked by the
        // attempts ledger and, if a signature happened, by runPaidCall's own exception guard).
        const msg = e instanceof Error ? e.message : String(e);
        stats.byOutcome["exception"] = (stats.byOutcome["exception"] ?? 0) + 1;
        L.error(`worker exception on ${a.url}: ${msg}`);
      } finally {
        inflight.delete(a.sellerId);
      }
    }
  };

  try {
    const n = Math.max(1, Math.floor(o.concurrency ?? 1));
    if (n > 1) L.info(`buy: ${n} concurrent workers (one call per seller at a time)`);
    await Promise.all(Array.from({ length: n }, () => worker()));
  } catch (e) {
    stats.durationMs = realNow() - t0;
    finishRun(db, runId, "error", e instanceof Error ? e.message : String(e), realNow());
    throw e;
  }

  stats.durationMs = realNow() - t0;
  finishRun(
    db,
    runId,
    stats.halted ? "halted" : "completed",
    JSON.stringify({ calls: stats.calls, planned: stats.schedule.length, byOutcome: stats.byOutcome, spentAtomic: stats.spentAtomic.toString(), haltReason: stats.haltReason ?? null }),
    realNow(),
  );
  return stats;
}

export function renderSchedule(s: ScheduledCall[]): string {
  return s.map((c) => `#${c.seq} ${new Date(c.at).toISOString()} seller=${c.sellerId} resource=${c.resourceId} wallet=${c.wallet} ${c.url}`).join("\n");
}
