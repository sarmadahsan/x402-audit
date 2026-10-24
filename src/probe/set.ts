/**
 * Probe set: the fixed list of resources `probe` visits each round.
 *
 * Two strata (docs/PLAN.md):
 *  - top:  one resource from each of the top-N sellers by 30-day volume rank
 *          (rank_30d ASC NULLS LAST, then calls_30d_bazaar DESC, then domain).
 *  - tail: a seeded uniform random sample of eligible resources from all other
 *          sellers, at most one per seller.
 *
 * Rebuilding never deletes: every existing row is marked inactive, then the new
 * selection is upserted (resource_id is UNIQUE), so selection history stays auditable.
 */
import type { Db } from "../db/index.js";
import { isExcluded, type ExcludeConfig } from "../config/index.js";

export interface BuildProbeSetOptions {
  topSellers?: number;
  tailResources?: number;
  /** PRNG seed for the tail stratum. Recorded on every probe_set row. */
  seed: number;
  /** CAIP-2 network. Default Base mainnet. */
  network?: string;
  /** Selection timestamp (ms). Default Date.now(). */
  now?: number;
  /**
   * Optional config/exclude.yaml contents. sellers.excluded = 1 always excludes;
   * this additionally applies domain and resource-prefix rules at selection time.
   */
  exclude?: ExcludeConfig;
}

export interface BuildProbeSetResult {
  top: number;
  tail: number;
  /** Resources that were otherwise eligible but whose seller (or URL prefix) is excluded. */
  skippedExcluded: number;
  /** Resources on the network with scheme exact whose transfer method is permit2. */
  skippedPermit2: number;
}

export interface ProbeSetRow {
  probeSetId: number;
  resourceId: number;
  stratum: "top" | "tail";
  seed: number;
  selectedAt: number;
  url: string;
  method: string;
  /** resources.source: bazaar | x402scan | manual */
  resourceSource: string;
  sellerId: number;
  sellerDomain: string;
  network: string | null;
  asset: string | null;
  declaredPriceAtomic: string | null;
  payTo: string | null;
  maxTimeoutSeconds: number | null;
  inputJson: string | null;
}

/** mulberry32: small, fast, seedable 32-bit PRNG. Returns floats in [0, 1). */
export function mulberry32(seed: number): () => number {
  let a = seed >>> 0;
  return () => {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

/** In-place Fisher-Yates shuffle driven by `rand`. */
export function shuffle<T>(arr: T[], rand: () => number): T[] {
  for (let i = arr.length - 1; i > 0; i--) {
    const j = Math.floor(rand() * (i + 1));
    const tmp = arr[i] as T;
    arr[i] = arr[j] as T;
    arr[j] = tmp;
  }
  return arr;
}

interface Candidate {
  id: number;
  url: string;
  seller_id: number;
  domain: string;
  seller_excluded: number;
  declared_price_atomic: string;
  bazaar_calls_30d: number | null;
}

function cmpAtomic(a: string, b: string): number {
  const okA = /^\d+$/.test(a);
  const okB = /^\d+$/.test(b);
  if (okA && okB) {
    const x = BigInt(a);
    const y = BigInt(b);
    return x < y ? -1 : x > y ? 1 : 0;
  }
  if (okA !== okB) return okA ? -1 : 1;
  return a < b ? -1 : a > b ? 1 : 0;
}

export function buildProbeSet(db: Db, opts: BuildProbeSetOptions): BuildProbeSetResult {
  const topN = opts.topSellers ?? 60;
  const tailN = opts.tailResources ?? 40;
  const network = opts.network ?? "eip155:8453";
  const now = opts.now ?? Date.now();
  const seed = Math.trunc(opts.seed);

  const skippedPermit2 = (
    db
      .prepare(
        `SELECT COUNT(*) AS n FROM resources
         WHERE network = ? AND scheme = 'exact' AND transfer_method = 'permit2'`,
      )
      .get(network) as { n: number }
  ).n;

  const rows = db
    .prepare(
      `SELECT r.id, r.url, r.seller_id, s.domain, s.excluded AS seller_excluded,
              r.declared_price_atomic, r.bazaar_calls_30d
       FROM resources r JOIN sellers s ON s.id = r.seller_id
       WHERE r.network = ? AND r.scheme = 'exact'
         AND (r.transfer_method IS NULL OR r.transfer_method != 'permit2')
         AND r.pay_to IS NOT NULL AND r.declared_price_atomic IS NOT NULL
       ORDER BY r.id`,
    )
    .all(network) as Candidate[];

  let skippedExcluded = 0;
  const eligible: Candidate[] = [];
  for (const r of rows) {
    const excluded =
      r.seller_excluded === 1 || (opts.exclude !== undefined && isExcluded(opts.exclude, r.domain, r.url) !== null);
    if (excluded) skippedExcluded++;
    else eligible.push(r);
  }

  const bySeller = new Map<number, Candidate[]>();
  for (const r of eligible) {
    let list = bySeller.get(r.seller_id);
    if (!list) bySeller.set(r.seller_id, (list = []));
    list.push(r);
  }

  // ---- top stratum ----
  const sellerOrder = db
    .prepare(
      `SELECT id FROM sellers
       ORDER BY (rank_30d IS NULL) ASC, rank_30d ASC, COALESCE(calls_30d_bazaar, -1) DESC, domain ASC`,
    )
    .all() as { id: number }[];
  const top: Candidate[] = [];
  const topSellerIds = new Set<number>();
  for (const { id } of sellerOrder) {
    if (top.length >= topN) break;
    const list = bySeller.get(id);
    if (!list || list.length === 0) continue; // sellers with no eligible resource do not use a slot
    const pick = [...list].sort(
      (a, b) =>
        (b.bazaar_calls_30d ?? -1) - (a.bazaar_calls_30d ?? -1) ||
        cmpAtomic(a.declared_price_atomic, b.declared_price_atomic) ||
        (a.url < b.url ? -1 : a.url > b.url ? 1 : 0) ||
        a.id - b.id,
    )[0] as Candidate;
    top.push(pick);
    topSellerIds.add(id);
  }

  // ---- tail stratum: seeded uniform shuffle over eligible resources of non-top sellers ----
  const chosenIds = new Set(top.map((r) => r.id));
  const pool = eligible.filter((r) => !topSellerIds.has(r.seller_id) && !chosenIds.has(r.id));
  shuffle(pool, mulberry32(seed));
  const tail: Candidate[] = [];
  const tailSellers = new Set<number>();
  for (const r of pool) {
    if (tail.length >= tailN) break;
    if (tailSellers.has(r.seller_id)) continue;
    tail.push(r);
    tailSellers.add(r.seller_id);
  }

  const deactivate = db.prepare(`UPDATE probe_set SET active = 0 WHERE active != 0`);
  const upsert = db.prepare(
    `INSERT INTO probe_set (resource_id, stratum, seed, selected_at, active)
     VALUES (?, ?, ?, ?, 1)
     ON CONFLICT(resource_id) DO UPDATE SET
       stratum = excluded.stratum, seed = excluded.seed, selected_at = excluded.selected_at, active = 1`,
  );
  db.transaction(() => {
    deactivate.run();
    for (const r of top) upsert.run(r.id, "top", seed, now);
    for (const r of tail) upsert.run(r.id, "tail", seed, now);
  })();

  return { top: top.length, tail: tail.length, skippedExcluded, skippedPermit2 };
}

export function listProbeSet(db: Db): ProbeSetRow[] {
  return db
    .prepare(
      `SELECT p.id AS probeSetId, p.resource_id AS resourceId, p.stratum, p.seed, p.selected_at AS selectedAt,
              r.url, COALESCE(r.method, 'GET') AS method, r.source AS resourceSource,
              s.id AS sellerId, s.domain AS sellerDomain, r.network, r.asset,
              r.declared_price_atomic AS declaredPriceAtomic, r.pay_to AS payTo,
              r.max_timeout_seconds AS maxTimeoutSeconds, r.input_json AS inputJson
       FROM probe_set p
       JOIN resources r ON r.id = p.resource_id
       JOIN sellers s ON s.id = r.seller_id
       WHERE p.active = 1
       ORDER BY p.stratum, p.id`,
    )
    .all() as ProbeSetRow[];
}
