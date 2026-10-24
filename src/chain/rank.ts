/**
 * Seller ranking from on-chain pay-to volume (payto_volume) and the top pay-tos list.
 */
import type { Db } from "../db/index.js";

export interface AssignOptions {
  network: string;
  fromBlock: bigint;
  toBlock: bigint;
}

/**
 * Sum each seller's distinct pay-tos' volume over the scanned window (bigint in JS, never SQL floats) and write
 * sellers.volume_30d_* and rank_30d (1 = largest; ties by transfer_count desc, then domain asc). Sellers with no
 * pay-to volume get "0" / 0 calls and rank after every non-zero seller.
 */
export function assignSellerVolumes(db: Db, o: AssignOptions): { sellersRanked: number } {
  // Distinct (seller, lowercase pay_to) pairs, so a pay-to listed by many resources of one seller counts once.
  // No filter on resources.network: v1 resources say "base", v2 "eip155:8453"; payto_volume is already per network.
  const pairs = db
    .prepare(
      `SELECT DISTINCT r.seller_id AS seller_id, LOWER(r.pay_to) AS pay_to
       FROM resources r
       WHERE r.pay_to IS NOT NULL`,
    )
    .all() as { seller_id: number; pay_to: string }[];
  const vols = db
    .prepare("SELECT LOWER(pay_to) AS pay_to, sum_atomic, transfer_count FROM payto_volume WHERE network = ? AND from_block = ? AND to_block = ?")
    .all(o.network, Number(o.fromBlock), Number(o.toBlock)) as { pay_to: string; sum_atomic: string; transfer_count: number }[];
  const volByPayTo = new Map(vols.map((v) => [v.pay_to, v]));

  const sellers = db.prepare("SELECT id, domain FROM sellers").all() as { id: number; domain: string }[];
  const agg = new Map<number, { id: number; domain: string; sum: bigint; calls: number }>();
  for (const s of sellers) agg.set(s.id, { id: s.id, domain: s.domain, sum: 0n, calls: 0 });
  for (const p of pairs) {
    const a = agg.get(p.seller_id);
    const v = volByPayTo.get(p.pay_to);
    if (!a || !v) continue;
    a.sum += BigInt(v.sum_atomic);
    a.calls += v.transfer_count;
  }

  const ordered = [...agg.values()].sort((x, y) => {
    if (x.sum !== y.sum) return x.sum > y.sum ? -1 : 1;
    if (x.calls !== y.calls) return y.calls - x.calls;
    return x.domain < y.domain ? -1 : x.domain > y.domain ? 1 : 0;
  });
  const upd = db.prepare(
    "UPDATE sellers SET volume_30d_atomic = ?, volume_30d_calls = ?, volume_30d_source = 'chain', volume_30d_computed_at = ?, rank_30d = ? WHERE id = ?",
  );
  const now = Date.now();
  db.transaction(() => {
    ordered.forEach((s, i) => upd.run(s.sum.toString(), s.calls, now, i + 1, s.id));
  })();
  return { sellersRanked: ordered.length };
}

export interface TopPayTo {
  payTo: string;
  sumAtomic: string;
  transferCount: number;
  uniquePayers: number;
  dustCount: number;
  fromBlock: number;
  toBlock: number;
  sellerDomains: string[];
}

/**
 * Top n pay-to addresses by sum_atomic (bigint ordering) with the domains of sellers that list them.
 * Uses each pay-to's most recent payto_volume window (largest to_block, then widest range).
 */
export function topPayTos(db: Db, o: { network: string; n: number }): TopPayTo[] {
  const rows = db
    .prepare(
      `SELECT pay_to, sum_atomic, transfer_count, unique_payers, dust_count, from_block, to_block
       FROM payto_volume WHERE network = ? ORDER BY to_block DESC, from_block ASC`,
    )
    .all(o.network) as { pay_to: string; sum_atomic: string; transfer_count: number; unique_payers: number; dust_count: number; from_block: number; to_block: number }[];
  const latest = new Map<string, (typeof rows)[number]>();
  for (const r of rows) {
    const k = r.pay_to.toLowerCase();
    if (!latest.has(k)) latest.set(k, r);
  }
  const top = [...latest.entries()]
    .sort(([ka, a], [kb, b]) => {
      const x = BigInt(a.sum_atomic);
      const y = BigInt(b.sum_atomic);
      if (x !== y) return x > y ? -1 : 1;
      if (a.transfer_count !== b.transfer_count) return b.transfer_count - a.transfer_count;
      return ka < kb ? -1 : 1;
    })
    .slice(0, Math.max(0, o.n));
  const domainsQ = db.prepare(
    `SELECT DISTINCT s.domain FROM resources r JOIN sellers s ON s.id = r.seller_id WHERE LOWER(r.pay_to) = ? ORDER BY s.domain`,
  );
  return top.map(([k, r]) => ({
    payTo: k,
    sumAtomic: r.sum_atomic,
    transferCount: r.transfer_count,
    uniquePayers: r.unique_payers,
    dustCount: r.dust_count,
    fromBlock: r.from_block,
    toBlock: r.to_block,
    sellerDomains: (domainsQ.all(k) as { domain: string }[]).map((d) => d.domain),
  }));
}
