/**
 * `buy reconcile`: the attempts ledger is written before signing, so a crash or halt after a signature can
 * leave a `signed` attempt with no `calls` row. Money may have moved. This turns every such orphan into a
 * calls row: settled on-chain -> non_delivery (paid, no usable response; the request died with the process),
 * not settled and the 24 h window still open -> indeterminate (resolve keeps polling), window closed -> not_paid.
 */
import { randomUUID } from "node:crypto";
import type { Db } from "../db/index.js";
import { INDETERMINATE_POLL_MAX_MS, OUTCOMES } from "../taxonomy.js";
import type { SettlementFact, SettlementLookup } from "./paidCall.js";

export interface OrphanAttempt { id: number; intent_id: string; run_id: number | null; source: string; ts: number; resource_id: number; wallet: string; pay_to: string; network: string; asset: string; amount_atomic: string; nonce: string }

/** A call in flight looks like an orphan until its row lands (up to the 10 min confirmation window); ignore anything younger than this. */
export const ORPHAN_MIN_AGE_MS = 20 * 60 * 1000;

export function listOrphanAttempts(db: Db, now = Date.now(), minAgeMs = ORPHAN_MIN_AGE_MS): OrphanAttempt[] {
  return db
    .prepare(
      `SELECT a.* FROM attempts a
        WHERE a.phase = 'signed' AND a.nonce IS NOT NULL AND a.ts <= ?
          AND NOT EXISTS (SELECT 1 FROM calls c WHERE c.nonce = a.nonce)
        ORDER BY a.id`,
    )
    .all(now - minAgeMs) as OrphanAttempt[];
}

export async function reconcileOrphans(db: Db, o: { lookup: SettlementLookup; apply: boolean; now?: () => number; minAgeMs?: number }): Promise<{ orphans: number; created: { attemptId: number; outcome: string; settlements: number }[] }> {
  const now = o.now ?? Date.now;
  const created: { attemptId: number; outcome: string; settlements: number }[] = [];
  for (const a of listOrphanAttempts(db, now(), o.minAgeMs)) {
    const planned = db.prepare("SELECT ts FROM attempts WHERE intent_id = ? AND phase = 'planned' ORDER BY id LIMIT 1").get(a.intent_id) as { ts: number } | undefined;
    let settlements: SettlementFact[] = [];
    try {
      settlements = await o.lookup({ nonce: a.nonce, validAfter: "0", validBefore: String(Math.floor(a.ts / 1000) + 3600), value: a.amount_atomic, to: a.pay_to, from: a.wallet });
    } catch {
      settlements = [];
    }
    const elapsed = now() - a.ts;
    const outcome = settlements.length > 0 ? OUTCOMES.NON_DELIVERY : elapsed >= INDETERMINATE_POLL_MAX_MS ? OUTCOMES.NOT_PAID : OUTCOMES.INDETERMINATE;
    created.push({ attemptId: a.id, outcome, settlements: settlements.length });
    if (!o.apply) continue;
    const sellerId = (db.prepare("SELECT seller_id FROM resources WHERE id = ?").get(a.resource_id) as { seller_id: number }).seller_id;
    db.transaction(() => {
      const res = db
        .prepare(
          `INSERT INTO calls (intent_id, run_id, source, resource_id, seller_id, ts, wallet, quote_amount_atomic, quote_asset, quote_network, quote_pay_to,
             paid, amount_paid_atomic, request_json, nonce, settlement_tx_hash, settlement_block, settlement_confirmed_at, settlement_count, outcome, flags_json,
             classified_at, resolve_until, error)
           VALUES (?,?,?,?,?,?,?,?,?,?,?, 1,?,?,?,?,?,?,?,?,?, ?,?,?)`,
        )
        .run(
          a.intent_id, a.run_id, a.source, a.resource_id, sellerId, planned?.ts ?? a.ts, a.wallet, a.amount_atomic, a.asset, a.network, a.pay_to,
          a.amount_atomic, JSON.stringify({ reconstructed_from_attempt: a.id, note: "process stopped after signing; request/response not recorded" }), a.nonce,
          settlements[0]?.txHash ?? null, settlements[0]?.blockNumber ?? null, settlements[0] ? now() : null, settlements.length, outcome, "[]",
          now(), outcome === OUTCOMES.INDETERMINATE ? a.ts + INDETERMINATE_POLL_MAX_MS : null, `reconciled_orphan_attempt:${a.id}`,
        );
      const callId = Number(res.lastInsertRowid);
      const si = db.prepare(`INSERT OR IGNORE INTO settlements (call_id, intent_id, tx_hash, log_index, block_number, block_ts, from_addr, to_addr, value_atomic, nonce, source, found_at) VALUES (?,?,?,?,?,?,?,?,?,?,?,?)`);
      for (const s of settlements) si.run(callId, a.intent_id, s.txHash, s.logIndex ?? 0, s.blockNumber ?? null, s.blockTs ?? null, s.from, s.to, s.valueAtomic, s.nonce ?? null, s.source, now());
    })();
  }
  return { orphans: created.length, created };
}

export { randomUUID as _uuid };
