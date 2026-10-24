/**
 * Reference price for a resource (docs/taxonomy.md "Reference price"): bazaar (declared) > modal of the
 * last 7 days of probes (ties toward the lower price) > first probe ever. Same rule as the probe module;
 * duplicated here in a few lines so `buy` does not depend on probe internals.
 */
import type { Db } from "../db/index.js";
import { MODAL_PRICE_WINDOW_MS, REFERENCE_SOURCES, type ReferenceSource } from "../taxonomy.js";

const isAtomic = (v: unknown): v is string => typeof v === "string" && /^\d+$/.test(v);

export function modalAtomic(amounts: readonly string[]): string | undefined {
  const counts = new Map<string, { n: number; v: bigint }>();
  for (const a of amounts) {
    if (!isAtomic(a)) continue;
    const v = BigInt(a);
    const c = counts.get(v.toString());
    if (c) c.n++;
    else counts.set(v.toString(), { n: 1, v });
  }
  let best: { n: number; v: bigint } | undefined;
  for (const c of counts.values()) if (!best || c.n > best.n || (c.n === best.n && c.v < best.v)) best = c;
  return best?.v.toString();
}

export function referencePriceFor(db: Db, resourceId: number, now: number): { amountAtomic: string; source: ReferenceSource } | undefined {
  const r = db.prepare(`SELECT declared_price_atomic FROM resources WHERE id = ?`).get(resourceId) as { declared_price_atomic: string | null } | undefined;
  if (r && isAtomic(r.declared_price_atomic)) return { amountAtomic: BigInt(r.declared_price_atomic).toString(), source: REFERENCE_SOURCES.BAZAAR };
  const recent = db
    .prepare(`SELECT amount_atomic FROM probes WHERE resource_id = ? AND amount_atomic IS NOT NULL AND ts >= ?`)
    .all(resourceId, now - MODAL_PRICE_WINDOW_MS) as { amount_atomic: string }[];
  const modal = modalAtomic(recent.map((x) => x.amount_atomic));
  if (modal !== undefined) return { amountAtomic: modal, source: REFERENCE_SOURCES.MODAL_7D };
  const first = db
    .prepare(`SELECT amount_atomic FROM probes WHERE resource_id = ? AND amount_atomic IS NOT NULL ORDER BY ts ASC, id ASC LIMIT 1`)
    .get(resourceId) as { amount_atomic: string } | undefined;
  if (first && isAtomic(first.amount_atomic)) return { amountAtomic: BigInt(first.amount_atomic).toString(), source: REFERENCE_SOURCES.FIRST_SEEN };
  return undefined;
}
