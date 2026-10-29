/**
 * Resources that quote above their applicable per-call cap (MAX_PER_CALL_USD for scheduled runs and audits, or the
 * seller's own cap in config/expensive-sellers.yaml). They are recorded `too_expensive` with the amount and exported,
 * never bought and never silently skipped. A later quote at or under the cap clears the row.
 */
import type { Db } from "../db/index.js";

export function recordTooExpensive(db: Db, o: { resourceId: number; quotedAtomic: bigint; capAtomic: bigint; basis: "probe" | "declared" | "quote"; now: number }): void {
  db.prepare(
    `INSERT INTO resource_states (resource_id, state, quoted_atomic, cap_atomic, basis, updated_at) VALUES (?, 'too_expensive', ?, ?, ?, ?)
     ON CONFLICT(resource_id) DO UPDATE SET state = excluded.state, quoted_atomic = excluded.quoted_atomic, cap_atomic = excluded.cap_atomic,
       basis = excluded.basis, updated_at = excluded.updated_at`,
  ).run(o.resourceId, o.quotedAtomic.toString(), o.capAtomic.toString(), o.basis, o.now);
}

export function clearTooExpensive(db: Db, resourceId: number): void {
  db.prepare("DELETE FROM resource_states WHERE resource_id = ? AND state = 'too_expensive'").run(resourceId);
}

export interface TooExpensiveRow {
  resource_id: number;
  url: string;
  method: string;
  domain: string;
  quoted_atomic: string | null;
  cap_atomic: string | null;
  basis: string | null;
  updated_at: number;
}

export function listTooExpensive(db: Db): TooExpensiveRow[] {
  return db
    .prepare(
      `SELECT rs.resource_id, r.url, r.method, s.domain, rs.quoted_atomic, rs.cap_atomic, rs.basis, rs.updated_at
       FROM resource_states rs JOIN resources r ON r.id = rs.resource_id JOIN sellers s ON s.id = r.seller_id
       WHERE rs.state = 'too_expensive' ORDER BY s.domain, r.url`,
    )
    .all() as TooExpensiveRow[];
}
