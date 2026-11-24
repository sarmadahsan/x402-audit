/**
 * Probe set: the list of resources `probe` visits each round, one per seller.
 *
 * Four strata (docs/PLAN.md "Probe set: every listed seller"):
 *  - top:       one resource from each of the top-N sellers by 30-day volume rank
 *               (rank_30d ASC NULLS LAST, then calls_30d_bazaar DESC, then domain). `probe plan`.
 *  - tail:      a seeded uniform random sample of eligible resources from all other
 *               sellers, at most one per seller. `probe plan`.
 *  - discovery: one resource per seller new at a daily `discover refresh` (src/discover/refresh.ts).
 *  - all:       one resource per eligible seller the other strata left out, so every listed seller
 *               is quoted hourly and can enter the coverage lane of the scheduled buys. `probe select --apply`,
 *               run by scripts/loop.sh before every round; idempotent. Without --apply it only reports.
 *
 * Rebuilding never deletes: `probe plan` marks every existing row inactive, then upserts the new
 * selection (resource_id is UNIQUE), so selection history stays auditable. `probe select` only adds
 * rows (or reactivates one of its own).
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

export const PROBE_STRATA = ["top", "tail", "discovery", "all"] as const;
export type ProbeStratum = (typeof PROBE_STRATA)[number];

export interface ProbeSetRow {
  probeSetId: number;
  resourceId: number;
  stratum: ProbeStratum;
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

/**
 * The eligibility predicate of the incremental strata (`discovery`, `all`), on `resources r JOIN sellers s`:
 * the seller is not excluded, the resource is on the network with scheme `exact`, pays by EIP-3009 (not permit2),
 * names a pay-to and a numeric declared price, and its URL is not a path template (/users/{id}, /coin/:symbol),
 * which cannot be fetched literally. The network is the one bound parameter.
 */
export const ELIGIBLE_PROBE_RESOURCE_SQL = `s.excluded = 0 AND r.network = ? AND r.scheme = 'exact' AND COALESCE(r.transfer_method, 'eip3009') != 'permit2'
       AND r.pay_to IS NOT NULL AND r.declared_price_atomic GLOB '[0-9]*' AND r.url NOT LIKE '%{%' AND r.url NOT LIKE '%/:%'`;
/**
 * Pick order within a seller: a listed resource before a user candidate (source `user`; the buy lanes never price a
 * `user` row, so a seller covered only by one would stay unbuyable), then busiest listing, then cheapest, then the
 * oldest row.
 */
export const PROBE_PICK_ORDER_SQL = `(r.source = 'user') ASC, COALESCE(r.bazaar_calls_30d, -1) DESC, CAST(r.declared_price_atomic AS INTEGER), r.id`;

export interface AddAllSellersOptions {
  /** CAIP-2 network. */
  network: string;
  /** Selection timestamp (ms). */
  now: number;
  /** config/exclude.yaml: a seller or URL prefix listed there never joins, like in `probe plan`. */
  exclude?: ExcludeConfig;
  /** Report only; write nothing. */
  dryRun?: boolean;
  /** Client identities per resource, for the expected request count (default 2). */
  identities?: number;
}

export interface AddAllSellersReport {
  /** Rows in `sellers`. */
  sellers: number;
  /** sellers.excluded = 1. */
  excludedSellers: number;
  /** Sellers with an active probe_set row before this selection, by stratum. */
  coveredBefore: number;
  coveredByStratum: Record<string, number>;
  /** Sellers that get (or, in a dry run, would get) an `all` row, by sellers.category. */
  joining: number;
  joiningByCategory: Record<string, number>;
  /** Not covered, not excluded, and no resource passes the eligibility predicate. */
  noEligibleResource: number;
  /** Not covered, with eligible resources, every one of them under a config/exclude.yaml rule. */
  excludedByConfig: number;
  /** Active resources in the set before and after, and the requests one round sends after. */
  roundBefore: number;
  roundAfter: number;
  requestsPerRound: number;
  /** Rows written (0 in a dry run). */
  added: number;
  dryRun: boolean;
}

interface AllCandidate {
  id: number;
  url: string;
  seller_id: number;
  domain: string;
  category: string | null;
}

/**
 * Stratum `all`: one eligible resource for every seller that no active probe_set row covers, under the same predicate
 * and pick order as `discovery` (ELIGIBLE_PROBE_RESOURCE_SQL, PROBE_PICK_ORDER_SQL). Never deletes or deactivates:
 * a resource already in probe_set (inactive, from an old tail draw) is reactivated as `all`. Idempotent: a second
 * call adds nothing. The report says who joins, by category, and why the rest do not.
 */
export function addAllSellersToProbeSet(db: Db, opts: AddAllSellersOptions): AddAllSellersReport {
  const identities = opts.identities ?? 2;
  const sellers = (db.prepare("SELECT COUNT(*) n, SUM(excluded = 1) x FROM sellers").get() as { n: number; x: number | null });
  const covered = db
    .prepare(
      `SELECT r.seller_id, MIN(p.stratum) stratum FROM probe_set p JOIN resources r ON r.id = p.resource_id
       WHERE p.active = 1 GROUP BY r.seller_id`,
    )
    .all() as { seller_id: number; stratum: string }[];
  const coveredIds = new Set(covered.map((c) => c.seller_id));
  const coveredByStratum: Record<string, number> = {};
  for (const c of covered) coveredByStratum[c.stratum] = (coveredByStratum[c.stratum] ?? 0) + 1;
  const roundBefore = (db.prepare("SELECT COUNT(*) n FROM probe_set WHERE active = 1").get() as { n: number }).n;

  // Every eligible resource of every uncovered seller, in pick order, so the first row per seller is the pick.
  const rows = db
    .prepare(
      `SELECT r.id, r.url, r.seller_id, s.domain, s.category FROM resources r JOIN sellers s ON s.id = r.seller_id
       WHERE ${ELIGIBLE_PROBE_RESOURCE_SQL}
       ORDER BY r.seller_id, ${PROBE_PICK_ORDER_SQL}`,
    )
    .all(opts.network) as AllCandidate[];
  const picks: AllCandidate[] = [];
  const picked = new Set<number>();
  const sawEligible = new Set<number>();
  for (const r of rows) {
    if (coveredIds.has(r.seller_id) || picked.has(r.seller_id)) continue;
    sawEligible.add(r.seller_id);
    if (opts.exclude !== undefined && isExcluded(opts.exclude, r.domain, r.url) !== null) continue;
    picks.push(r);
    picked.add(r.seller_id);
  }
  const uncovered = (db.prepare("SELECT id FROM sellers WHERE excluded = 0").all() as { id: number }[]).filter((r) => !coveredIds.has(r.id)).length;
  const joiningByCategory: Record<string, number> = {};
  for (const r of picks) {
    const c = r.category ?? "uncategorized";
    joiningByCategory[c] = (joiningByCategory[c] ?? 0) + 1;
  }

  let added = 0;
  if (!opts.dryRun && picks.length) {
    const ins = db.prepare(
      `INSERT INTO probe_set (resource_id, stratum, seed, selected_at, active, note) VALUES (?, 'all', 0, ?, 1, 'probe select')
       ON CONFLICT(resource_id) DO UPDATE SET stratum = 'all', selected_at = excluded.selected_at, active = 1, note = excluded.note`,
    );
    db.transaction(() => {
      for (const r of picks) {
        ins.run(r.id, opts.now);
        added++;
      }
    })();
  }
  const roundAfter = roundBefore + picks.length;
  return {
    sellers: sellers.n,
    excludedSellers: sellers.x ?? 0,
    coveredBefore: coveredIds.size,
    coveredByStratum,
    joining: picks.length,
    joiningByCategory,
    noEligibleResource: uncovered - sawEligible.size,
    excludedByConfig: sawEligible.size - picks.length,
    roundBefore,
    roundAfter,
    requestsPerRound: roundAfter * identities,
    added,
    dryRun: opts.dryRun === true,
  };
}
