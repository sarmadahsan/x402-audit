/**
 * Pieces shared by `buy` and `stress`: spend accounting from the DB, cap checks before every
 * signature, halts rows, run rows, and the payer / settlement-lookup wrappers.
 */
import type { Db } from "../db/index.js";
import { atomicToUsd, type Caps } from "../config/index.js";
import type { SettlementFact, SettlementLookup } from "../pipeline/paidCall.js";
import type { CallSource } from "../taxonomy.js";
import type { PaidResult, Payer, PayHooks } from "../x402/pay.js";
import { confirmWithTimeout } from "../chain/confirm.js";

export interface Logger {
  info(msg: string, data?: unknown): void;
  warn(msg: string, data?: unknown): void;
  error(msg: string, data?: unknown): void;
}

export const DAY_MS = 24 * 60 * 60 * 1000;
export const utcDayStart = (ts: number) => ts - (((ts % DAY_MS) + DAY_MS) % DAY_MS);

export interface SpendFilter {
  /** Only rows with ts >= since. */
  since?: number;
  sellerId?: number;
  /** Only these call sources (default: all). */
  sources?: readonly CallSource[];
}

/**
 * Money that has moved or may have moved: SUM(amount_paid_atomic) over paid calls, plus every
 * `signed` attempt whose nonce has no calls row yet (a crash between signing and persisting the call
 * can therefore never undercount). Matching is by nonce, not intent id, because stress reuses intent ids.
 */
export function spentAtomic(db: Db, f: SpendFilter = {}): bigint {
  const where: string[] = [];
  const params: unknown[] = [];
  if (f.since !== undefined) {
    where.push("ts >= ?");
    params.push(f.since);
  }
  if (f.sources && f.sources.length) {
    where.push(`source IN (${f.sources.map(() => "?").join(",")})`);
    params.push(...f.sources);
  }
  const calls = db
    .prepare(
      `SELECT amount_paid_atomic a FROM calls WHERE paid = 1 AND amount_paid_atomic IS NOT NULL
       ${f.sellerId !== undefined ? "AND seller_id = ?" : ""} ${where.length ? "AND " + where.join(" AND ") : ""}`,
    )
    .all(...(f.sellerId !== undefined ? [f.sellerId] : []), ...params) as { a: string }[];
  const attempts = db
    .prepare(
      `SELECT a.amount_atomic a FROM attempts a ${f.sellerId !== undefined ? "JOIN resources r ON r.id = a.resource_id AND r.seller_id = ?" : ""}
       WHERE a.phase = 'signed' AND a.nonce IS NOT NULL
         AND NOT EXISTS (SELECT 1 FROM calls c WHERE c.nonce = a.nonce)
         ${where.length ? "AND " + where.map((w) => "a." + w).join(" AND ") : ""}`,
    )
    .all(...(f.sellerId !== undefined ? [f.sellerId] : []), ...params) as { a: string }[];
  let s = 0n;
  for (const r of calls) if (/^\d+$/.test(r.a)) s += BigInt(r.a);
  for (const r of attempts) if (/^\d+$/.test(r.a)) s += BigInt(r.a);
  return s;
}

export interface CapBreach {
  reason: "cap_per_call" | "cap_per_seller_per_day" | "cap_per_day" | "cap_total" | "cap_stress_total";
  details: Record<string, string | number>;
}

export interface CapCheckInput {
  caps: Caps;
  sellerId: number;
  amountAtomic: bigint;
  now: number;
  /** Which total applies: buy -> caps.totalAtomic over source 'buy'; stress -> caps.stressTotalAtomic over stress sources. */
  scope: "buy" | "stress";
}

/**
 * Would paying `amountAtomic` breach any cap? Per-seller-per-day and per-day count every source (money is
 * money); the total cap counts only the scope's sources (MAX_TOTAL_USD for buy, STRESS_MAX_TOTAL_USD for stress).
 */
export function checkCaps(db: Db, i: CapCheckInput): CapBreach | null {
  const a = i.amountAtomic;
  const fmt = (x: bigint) => `${x} (${atomicToUsd(x)} USD)`;
  if (a > i.caps.perCallAtomic) return { reason: "cap_per_call", details: { amount: fmt(a), cap: fmt(i.caps.perCallAtomic) } };
  const day = utcDayStart(i.now);
  const seller = spentAtomic(db, { since: day, sellerId: i.sellerId });
  if (seller + a > i.caps.perSellerPerDayAtomic)
    return { reason: "cap_per_seller_per_day", details: { sellerId: i.sellerId, spentToday: fmt(seller), next: fmt(a), cap: fmt(i.caps.perSellerPerDayAtomic) } };
  const today = spentAtomic(db, { since: day });
  if (today + a > i.caps.perDayAtomic) return { reason: "cap_per_day", details: { spentToday: fmt(today), next: fmt(a), cap: fmt(i.caps.perDayAtomic) } };
  if (i.scope === "buy") {
    const total = spentAtomic(db, { sources: ["buy"] });
    if (total + a > i.caps.totalAtomic) return { reason: "cap_total", details: { spent: fmt(total), next: fmt(a), cap: fmt(i.caps.totalAtomic) } };
  } else {
    const total = spentAtomic(db, { sources: ["stress_duplicate", "stress_timeout"] });
    if (total + a > i.caps.stressTotalAtomic)
      return { reason: "cap_stress_total", details: { spent: fmt(total), next: fmt(a), cap: fmt(i.caps.stressTotalAtomic) } };
  }
  return null;
}

export function insertHalt(db: Db, runId: number | undefined, reason: string, details: unknown, now = Date.now()): void {
  db.prepare(`INSERT INTO halts (run_id, ts, reason, details_json) VALUES (?, ?, ?, ?)`).run(runId ?? null, now, reason, JSON.stringify(details ?? null));
}

export function startRun(db: Db, r: { subcommand: string; args: unknown; configHash?: string; network: string; dryRun: boolean; now: number }): number {
  const res = db
    .prepare(`INSERT INTO runs (subcommand, args_json, config_hash, network, dry_run, started_at, status) VALUES (?, ?, ?, ?, ?, ?, 'running')`)
    .run(r.subcommand, JSON.stringify(r.args ?? {}, (_k, v: unknown) => (typeof v === "bigint" ? v.toString() : v)), r.configHash ?? "", r.network, r.dryRun ? 1 : 0, r.now);
  return Number(res.lastInsertRowid);
}

export function finishRun(db: Db, runId: number, status: string, notes: string, now = Date.now()): void {
  db.prepare(`UPDATE runs SET finished_at = ?, status = ?, notes = ? WHERE id = ?`).run(now, status, notes, runId);
}

/**
 * Wraps a payer so that (1) a cap check runs in the pre-sign hook with the ACTUAL quoted amount, and
 * (2) the last PaidResult is visible to the settlement lookup. A quote above the per-call cap is left to
 * runPaidCall's own hook (so it is recorded as unpaid_overcharge, not a halt).
 */
export function guardPayer(
  inner: Payer,
  o: { perCallCapAtomic: bigint; guard: (amountAtomic: bigint) => CapBreach | null; onBreach: (b: CapBreach) => void },
): { payer: Payer; last: () => PaidResult | undefined } {
  let last: PaidResult | undefined;
  const payer: Payer = {
    address: inner.address,
    network: inner.network,
    async payAndFetch(url, init, hooks): Promise<PaidResult> {
      last = undefined;
      const wrapped: PayHooks = {
        async beforeSign(req) {
          const amount = /^\d+$/.test(req.amountAtomic) ? BigInt(req.amountAtomic) : -1n;
          if (amount < 0n || amount > o.perCallCapAtomic) return hooks.beforeSign(req);
          const b = o.guard(amount);
          if (b) {
            o.onBreach(b);
            return { abort: `${b.reason}: ${JSON.stringify(b.details)}` };
          }
          return hooks.beforeSign(req);
        },
        afterSign: (info) => hooks.afterSign(info),
      };
      last = await inner.payAndFetch(url, init, wrapped);
      return last;
    },
  };
  return { payer, last: () => last };
}

/** True when the seller answered non-2xx and did not claim a successful settlement (e.g. a 402 reject). */
export function looksRejected(r: PaidResult | undefined): boolean {
  if (!r?.response) return false;
  const st = r.response.status;
  return !(st >= 200 && st < 300) && r.settlement?.success !== true;
}

export interface ConfirmPolicy {
  /** Max wait for a settlement after a paid call (default 10 min). */
  confirmTimeoutMs?: number;
  /** Poll interval (default 15 s; use ~250 ms on anvil). */
  confirmIntervalMs?: number;
  /** Max wait when the seller visibly rejected the payment (default 60 s, capped at confirmTimeoutMs). */
  rejectGraceMs?: number;
  /** Max wait when the seller rejected the request itself (400/404/405/415/422, no settlement header): it never tried to settle (default 10 s). */
  badRequestGraceMs?: number;
  /** Max INLINE wait when no response arrived at all (timeout/abort after signing). The row becomes `indeterminate`
   * and `buy resolve` keeps checking the chain for 24 h (the 10-minute rule in docs/taxonomy.md is honoured by the
   * resolver, not by blocking a worker). Default 120 s. */
  noResponseGraceMs?: number;
}

/** Seller rejected the request body/params, not the payment: a 4xx client error other than 402/429 with no success header. */
export function looksBadRequest(r: PaidResult | undefined): boolean {
  if (!r?.response) return false;
  const st = r.response.status;
  return st >= 400 && st < 500 && st !== 402 && st !== 429 && r.settlement?.success !== true;
}

/** A lookup for runPaidCall that polls `base` per the policy, waiting less after a visible reject. */
export function confirmingLookup(base: SettlementLookup, last: () => PaidResult | undefined, p: ConfirmPolicy = {}): SettlementLookup {
  const full = p.confirmTimeoutMs ?? 10 * 60_000;
  const grace = Math.min(p.rejectGraceMs ?? 60_000, full);
  const badGrace = Math.min(p.badRequestGraceMs ?? 10_000, grace);
  const noResponseGrace = Math.min(p.noResponseGraceMs ?? 120_000, full);
  const intervalMs = p.confirmIntervalMs ?? 15_000;
  return (signed, hint): Promise<SettlementFact[]> => {
    // Prefer the call's own response (passed by runPaidCall); fall back to the payer's last result only when absent.
    // With concurrent workers sharing a payer, `last()` can belong to another call, so the hint is authoritative.
    let timeoutMs: number;
    if (hint && !hint.response) {
      timeoutMs = noResponseGrace; // nothing came back: do not pin a worker for 10 min; the resolver takes over
    } else if (hint?.response) {
      const st = hint.response.status;
      const ok2xx = st >= 200 && st < 300;
      const success = hint.settlementSuccess === true;
      const badReq = st >= 400 && st < 500 && st !== 402 && st !== 429 && !success;
      // Full window only when the seller claims a settlement (success header) or the response is a non-2xx that
      // may still settle. A 2xx WITHOUT a settlement claim is either free delivery or a settlement path we cannot
      // see; waiting 10 min per such call starved the run, so it gets the 60 s grace and `buy resolve` re-checks
      // these rows for 2 h afterwards.
      timeoutMs = badReq ? badGrace : success ? full : ok2xx ? grace : grace;
    } else {
      const r = last();
      timeoutMs = looksBadRequest(r) ? badGrace : looksRejected(r) ? grace : full;
    }
    return confirmWithTimeout(base, signed, { timeoutMs, intervalMs, ...(hint ? { hint } : {}) });
  };
}
