/**
 * `discover refresh` (docs/discovery.md): the daily discovery job, run after the 00:00 scheduled run. Free: it never
 * signs or pays. Three sources of new sellers:
 *
 *  1. Bazaar: re-crawl the CDP discovery API (runDiscover); sellers that were not in the database get a
 *     seller_discovery row (source discovery, discovered_at).
 *  2. config/seed-sellers.yaml: hand-kept hosts from ecosystem pages, directories and partner catalogs. A host we do
 *     not know is probed once at its root; a 402 with a Base exact option becomes a `seed` resource.
 *  3. Chain: facilitator settlements on Base in the last 24 hours. Facilitators are the senders of the settlement
 *     transactions we matched for our own purchases (table facilitators). A seeded sample of the day's EIP-3009
 *     AuthorizationUsed transactions is read receipt by receipt; a USDC Transfer from the authorizer in a transaction a
 *     facilitator sent is a settlement, and its payee is checked against every pay-to we know (listings and quotes).
 *     Payees nobody can name go to unmapped_payees with their 30-day inflow (the chain scan's own window and dust
 *     floor); a later refresh that finds the payee in a listing marks it matched.
 *
 * Every new seller has tier NULL, gets one resource in the probe set (stratum `discovery`) so the next hourly probe
 * sees it, and enters the coverage pool of the next scheduled run because it has zero calls.
 */
import type { Db } from "../db/index.js";
import { MAINNET, type ExcludeConfig, type ManualResourceConfig } from "../config/index.js";
import { AUTHORIZATION_USED_TOPIC0, blockAtTimestamp, TRANSFER_TOPIC0, usdcFor } from "../chain/client.js";
import { isTooMuchError, scanPayToVolume, type LogClient } from "../chain/volume.js";
import { seededRandom } from "../buy/plan.js";
import { fetchQuote, selectRequirements } from "../x402/quote.js";
import type { FetchImpl } from "../x402/http.js";
import { runDiscover, toCaip2, type DiscoverLogger } from "./index.js";

export interface SeedSeller {
  host: string;
  source: string;
}

/** The subset of a viem PublicClient refresh uses. */
export interface RefreshChainClient extends LogClient {
  getBlockNumber(): Promise<bigint>;
  getBlock(args?: any): Promise<{ number: bigint | null; timestamp: bigint }>;
  request(args: { method: string; params: unknown[] }): Promise<unknown>;
  getTransaction(args: { hash: `0x${string}` }): Promise<{ from: string }>;
  getTransactionReceipt(args: { hash: `0x${string}` }): Promise<{ from: string; logs: readonly { address: string; topics: readonly string[]; data: string }[] }>;
}

export interface RefreshOptions {
  network?: string;
  log: DiscoverLogger;
  now?: () => number;
  manual: readonly ManualResourceConfig[];
  exclude: ExcludeConfig;
  seeds: readonly SeedSeller[];
  /** Skip the Bazaar crawl (tests, or a chain-only refresh). */
  skipBazaar?: boolean;
  /** Bazaar crawl options passed through. */
  fetchImpl?: typeof fetch;
  throttleMs?: number;
  quoteFetch?: FetchImpl;
  chain?: RefreshChainClient;
  /** Receipts read from the day's AuthorizationUsed transactions (default 1500). */
  receiptSample?: number;
  /** Settlement transactions of ours re-read to learn the facilitators (default 200). */
  facilitatorSample?: number;
  /** New sellers added to the probe set per refresh (default 300, busiest first). */
  maxProbeAdds?: number;
  /** Unmapped payees whose 30-day inflow is (re)computed per refresh (default 40). */
  maxInflowScans?: number;
  seed?: number;
}

export interface RefreshStats {
  startedAt: number;
  finishedAt: number;
  bazaar: { sellersNew: number; resourcesNew: number; unique: number } | null;
  seeds: { listed: number; known: number; added: number; notX402: number; notes: string[] };
  newSellers: number;
  probeSetAdded: number;
  chain: {
    fromBlock: string;
    toBlock: string;
    facilitators: number;
    authorizations: number;
    sampled: number;
    facilitatorSettlements: number;
    payeesSeen: number;
    newUnmapped: number;
    matchedNow: number;
    inflowScanned: number;
  } | null;
  errors: string[];
}

const lc = (s: string) => s.toLowerCase();
const topicAddr = (t: string | undefined) => (t ? `0x${t.slice(-40)}`.toLowerCase() : "");

/** Every pay-to we can name: listed on a resource or quoted to us. */
function knownPayTos(db: Db): Set<string> {
  const rows = db
    .prepare(
      `SELECT lower(pay_to) p FROM resources WHERE pay_to IS NOT NULL AND pay_to <> ''
       UNION SELECT lower(quote_pay_to) FROM calls WHERE quote_pay_to IS NOT NULL AND quote_pay_to <> ''`,
    )
    .all() as { p: string }[];
  return new Set(rows.map((r) => r.p));
}

/** One resource per new seller into the probe set (stratum `discovery`), busiest listing first. */
export function addNewSellersToProbeSet(db: Db, sellerIds: readonly number[], o: { network: string; now: number; max: number }): number {
  if (!sellerIds.length) return 0;
  const pick = db.prepare(
    `SELECT r.id FROM resources r JOIN sellers s ON s.id = r.seller_id
     WHERE r.seller_id = ? AND s.excluded = 0 AND r.network = ? AND r.scheme = 'exact' AND COALESCE(r.transfer_method, 'eip3009') != 'permit2'
       AND r.pay_to IS NOT NULL AND r.declared_price_atomic GLOB '[0-9]*' AND r.url NOT LIKE '%{%' AND r.url NOT LIKE '%/:%'
     ORDER BY COALESCE(r.bazaar_calls_30d, -1) DESC, CAST(r.declared_price_atomic AS INTEGER), r.id LIMIT 1`,
  );
  const calls = db.prepare("SELECT COALESCE(calls_30d_bazaar, 0) c FROM sellers WHERE id = ?");
  const ordered = [...sellerIds].sort((a, b) => (calls.get(b) as { c: number }).c - (calls.get(a) as { c: number }).c || a - b);
  const ins = db.prepare(
    `INSERT INTO probe_set (resource_id, stratum, seed, selected_at, active, note) VALUES (?, 'discovery', 0, ?, 1, 'discover refresh')
     ON CONFLICT(resource_id) DO UPDATE SET active = 1`,
  );
  let added = 0;
  db.transaction(() => {
    for (const id of ordered) {
      if (added >= o.max) break;
      const r = pick.get(id, o.network) as { id: number } | undefined;
      if (!r) continue;
      ins.run(r.id, o.now);
      added++;
    }
  })();
  return added;
}

/** Hosts from config/seed-sellers.yaml that we do not know yet: probed once at the root, added when they answer 402. */
export async function importSeeds(db: Db, seeds: readonly SeedSeller[], o: { network: string; now: number; fetchImpl?: FetchImpl }): Promise<{ listed: number; known: number; added: number; notX402: number; newSellerIds: number[]; notes: string[] }> {
  const st = { listed: seeds.length, known: 0, added: 0, notX402: 0, newSellerIds: [] as number[], notes: [] as string[] };
  const find = db.prepare<[string], { id: number }>("SELECT id FROM sellers WHERE domain = ?");
  for (const s of seeds) {
    const host = lc(s.host).replace(/^www\./, "").replace(/\/.*$/, "");
    if (find.get(host)) {
      st.known++;
      continue;
    }
    const url = `https://${host}/`;
    const q = await fetchQuote(url, { timeoutMs: 15_000, ...(o.fetchImpl ? { fetchImpl: o.fetchImpl } : {}) });
    const req = !q.error && q.status === 402 && q.parsed ? selectRequirements(q.parsed.accepts, { network: o.network, scheme: "exact" }) : undefined;
    if (!req || !/^\d+$/.test(req.amountAtomic)) {
      // Not a seller row: a host whose root answers no Base exact 402 is retried at the next refresh.
      st.notX402++;
      st.notes.push(`${host}: root ${q.error ? `unreachable (${q.error.kind})` : `answered ${q.status}`}, no Base exact 402`);
      continue;
    }
    const sellerId = Number(db.prepare("INSERT INTO sellers (domain, first_seen_at, last_seen_at) VALUES (?, ?, ?)").run(host, o.now, o.now).lastInsertRowid);
    db.prepare("INSERT INTO seller_discovery (seller_id, source, discovered_at, note) VALUES (?, 'seed', ?, ?)").run(sellerId, o.now, `seed: ${s.source}`);
    db.prepare(
      `INSERT INTO resources (seller_id, url, method, source, x402_version, scheme, network, asset, declared_price_atomic, pay_to, max_timeout_seconds, accepts_json, description, category, category_reason, raw_json, first_seen_at, last_seen_at)
       VALUES (?, ?, 'GET', 'seed', ?, 'exact', ?, ?, ?, ?, ?, ?, ?, 'other', 'seed', ?, ?, ?)`,
    ).run(sellerId, url, req.x402Version, toCaip2(req.network), req.asset, req.amountAtomic, req.payTo, req.maxTimeoutSeconds, JSON.stringify(q.parsed!.accepts.map((a) => a.raw)), req.description ?? null, JSON.stringify(s), o.now, o.now);
    st.added++;
    st.newSellerIds.push(sellerId);
  }
  return st;
}

/** The senders of our matched settlement transactions, from the most recent `sample` of them. */
export async function learnFacilitators(db: Db, client: Pick<RefreshChainClient, "getTransaction">, o: { network: string; now: number; sample: number }): Promise<Set<string>> {
  const txs = db
    .prepare("SELECT tx_hash FROM settlements WHERE tx_hash GLOB '0x*' AND length(tx_hash) = 66 GROUP BY tx_hash ORDER BY MAX(found_at) DESC LIMIT ?")
    .all(o.sample) as { tx_hash: string }[];
  const count = new Map<string, number>();
  await pool(txs, 8, async ({ tx_hash }) => {
    try {
      const t = await client.getTransaction({ hash: tx_hash as `0x${string}` });
      count.set(lc(t.from), (count.get(lc(t.from)) ?? 0) + 1);
    } catch {
      /* a transaction the RPC cannot return is skipped */
    }
  });
  const up = db.prepare(
    `INSERT INTO facilitators (address, network, settlements, first_seen_at, last_seen_at) VALUES (?, ?, ?, ?, ?)
     ON CONFLICT(address) DO UPDATE SET settlements = excluded.settlements, last_seen_at = excluded.last_seen_at`,
  );
  db.transaction(() => {
    for (const [a, n] of count) up.run(a, o.network, n, o.now, o.now);
  })();
  return new Set((db.prepare("SELECT address FROM facilitators WHERE network = ?").all(o.network) as { address: string }[]).map((r) => r.address));
}

async function pool<T>(items: readonly T[], n: number, f: (x: T) => Promise<void>): Promise<void> {
  let i = 0;
  await Promise.all(Array.from({ length: Math.min(n, items.length) }, async () => {
    while (i < items.length) await f(items[i++]!);
  }));
}

/** Reservoir sample of the window's AuthorizationUsed transaction hashes (block range halved on too-many-results). */
async function sampleAuthorizations(client: RefreshChainClient, o: { network: string; fromBlock: bigint; toBlock: bigint; k: number; rnd: () => number }): Promise<{ total: number; sample: string[] }> {
  const usdc = usdcFor(o.network);
  const sample: string[] = [];
  const seen = new Set<string>();
  let total = 0;
  let span = 2_000n;
  for (let from = o.fromBlock; from <= o.toBlock; ) {
    const to = from + span - 1n > o.toBlock ? o.toBlock : from + span - 1n;
    let logs: { transactionHash: string }[];
    try {
      logs = (await client.request({ method: "eth_getLogs", params: [{ address: usdc, topics: [AUTHORIZATION_USED_TOPIC0], fromBlock: `0x${from.toString(16)}`, toBlock: `0x${to.toString(16)}` }] })) as { transactionHash: string }[];
    } catch (e) {
      if (isTooMuchError(e) && span > 16n) {
        span /= 2n;
        continue;
      }
      throw e;
    }
    for (const l of logs) {
      if (seen.has(l.transactionHash)) continue; // one sample slot per transaction
      seen.add(l.transactionHash);
      total++;
      if (sample.length < o.k) sample.push(l.transactionHash);
      else {
        const j = Math.floor(o.rnd() * total);
        if (j < o.k) sample[j] = l.transactionHash;
      }
    }
    seen.clear(); // a transaction's logs sit in one block, so de-duplication never needs to cross windows
    from = to + 1n;
  }
  return { total, sample };
}

/** Payees of facilitator settlements in the sample: payee -> settlements seen, one tx, its facilitator. */
async function payeesFromReceipts(client: RefreshChainClient, txs: readonly string[], o: { network: string; facilitators: Set<string> }): Promise<{ settlements: number; payees: Map<string, { n: number; tx: string; facilitator: string }> }> {
  const usdc = lc(usdcFor(o.network));
  const payees = new Map<string, { n: number; tx: string; facilitator: string }>();
  let settlements = 0;
  await pool(txs, 8, async (hash) => {
    let r: Awaited<ReturnType<RefreshChainClient["getTransactionReceipt"]>>;
    try {
      r = await client.getTransactionReceipt({ hash: hash as `0x${string}` });
    } catch {
      return;
    }
    const sender = lc(r.from);
    if (!o.facilitators.has(sender)) return;
    const logs = r.logs.filter((l) => lc(l.address) === usdc);
    const authorizers = new Set(logs.filter((l) => lc(l.topics[0] ?? "") === lc(AUTHORIZATION_USED_TOPIC0)).map((l) => topicAddr(l.topics[1])));
    for (const l of logs) {
      if (lc(l.topics[0] ?? "") !== lc(TRANSFER_TOPIC0) || !authorizers.has(topicAddr(l.topics[1]))) continue;
      const to = topicAddr(l.topics[2]);
      settlements++;
      const p = payees.get(to);
      if (p) p.n++;
      else payees.set(to, { n: 1, tx: hash, facilitator: sender });
    }
  });
  return { settlements, payees };
}

export async function runRefresh(db: Db, o: RefreshOptions): Promise<RefreshStats> {
  const network = o.network ?? MAINNET;
  const now = o.now ?? Date.now;
  const t0 = now();
  const stats: RefreshStats = { startedAt: t0, finishedAt: 0, bazaar: null, seeds: { listed: 0, known: 0, added: 0, notX402: 0, notes: [] }, newSellers: 0, probeSetAdded: 0, chain: null, errors: [] };
  const before = (db.prepare("SELECT COALESCE(MAX(id), 0) m FROM sellers").get() as { m: number }).m;

  // 1. Bazaar.
  if (!o.skipBazaar) {
    try {
      const d = await runDiscover(db, { manual: o.manual, exclude: o.exclude, log: o.log, now, ...(o.fetchImpl ? { fetchImpl: o.fetchImpl } : {}), ...(o.throttleMs !== undefined ? { throttleMs: o.throttleMs } : {}) });
      stats.bazaar = { sellersNew: d.bazaar.sellersNew, resourcesNew: d.bazaar.resourcesNew, unique: d.bazaar.unique };
    } catch (e) {
      stats.errors.push(`bazaar: ${(e as Error).message}`);
      o.log.warn(`discover refresh: Bazaar crawl failed (${(e as Error).message}); continuing with seeds and chain`);
    }
  }
  const newFromBazaar = (db.prepare("SELECT id FROM sellers WHERE id > ? AND id NOT IN (SELECT seller_id FROM seller_discovery) AND id NOT IN (SELECT seller_id FROM candidates WHERE seller_id IS NOT NULL)").all(before) as { id: number }[]).map((r) => r.id);
  const insDisc = db.prepare("INSERT OR IGNORE INTO seller_discovery (seller_id, source, discovered_at, note) VALUES (?, 'discovery', ?, 'Bazaar recrawl')");
  db.transaction(() => {
    for (const id of newFromBazaar) insDisc.run(id, now());
  })();

  // 2. Seeds.
  const seeds = await importSeeds(db, o.seeds, { network, now: now(), ...(o.quoteFetch ? { fetchImpl: o.quoteFetch } : {}) });
  stats.seeds = { listed: seeds.listed, known: seeds.known, added: seeds.added, notX402: seeds.notX402, notes: seeds.notes };
  const newIds = [...newFromBazaar, ...seeds.newSellerIds];
  stats.newSellers = newIds.length;
  // Every discovered seller still without an active probe resource (this refresh's and any left over by the cap).
  const unprobed = (db
    .prepare("SELECT d.seller_id id FROM seller_discovery d WHERE NOT EXISTS (SELECT 1 FROM probe_set p JOIN resources r ON r.id = p.resource_id WHERE r.seller_id = d.seller_id AND p.active = 1)")
    .all() as { id: number }[]).map((r) => r.id);
  stats.probeSetAdded = addNewSellersToProbeSet(db, unprobed, { network, now: now(), max: o.maxProbeAdds ?? 300 });

  // 3. Chain.
  if (o.chain) {
    try {
      const client = o.chain;
      const facilitators = await learnFacilitators(db, client, { network, now: now(), sample: o.facilitatorSample ?? 200 });
      const toBlock = await client.getBlockNumber();
      const fromBlock = await blockAtTimestamp(client as never, Math.floor(now() / 1000) - 86_400);
      const rnd = seededRandom(o.seed ?? Math.floor(now() / 86_400_000));
      const auth = await sampleAuthorizations(client, { network, fromBlock, toBlock, k: o.receiptSample ?? 1500, rnd });
      const got = await payeesFromReceipts(client, auth.sample, { network, facilitators });
      const known = knownPayTos(db);
      const getU = db.prepare<[string], { pay_to: string }>("SELECT pay_to FROM unmapped_payees WHERE pay_to = ?");
      const insU = db.prepare("INSERT INTO unmapped_payees (pay_to, network, first_seen_at, last_seen_at, sample_tx, facilitator, sampled_settlements) VALUES (?, ?, ?, ?, ?, ?, ?)");
      const updU = db.prepare("UPDATE unmapped_payees SET last_seen_at = ?, sampled_settlements = sampled_settlements + ? WHERE pay_to = ?");
      let newUnmapped = 0;
      db.transaction(() => {
        for (const [payee, p] of got.payees) {
          if (known.has(payee)) continue;
          if (getU.get(payee)) updU.run(now(), p.n, payee);
          else {
            insU.run(payee, network, now(), now(), p.tx, p.facilitator, p.n);
            newUnmapped++;
          }
        }
      })();
      // A payee that now appears in a listing or a quote is mapped.
      const matchedNow = db
        .prepare(
          `UPDATE unmapped_payees SET matched_seller_id = (SELECT r.seller_id FROM resources r WHERE lower(r.pay_to) = unmapped_payees.pay_to LIMIT 1), matched_at = ?
           WHERE matched_seller_id IS NULL AND EXISTS (SELECT 1 FROM resources r WHERE lower(r.pay_to) = unmapped_payees.pay_to)`,
        )
        .run(now()).changes;
      // 30-day inflow for the unmapped payees seen most often, oldest figure first.
      const todo = (db
        .prepare(`SELECT pay_to FROM unmapped_payees WHERE matched_seller_id IS NULL AND network = ? AND (inflow_computed_at IS NULL OR inflow_computed_at < ?) ORDER BY inflow_computed_at IS NOT NULL, sampled_settlements DESC LIMIT ?`)
        .all(network, now() - 6 * 86_400_000, o.maxInflowScans ?? 20) as { pay_to: string }[]).map((r) => r.pay_to);
      let inflowScanned = 0;
      // The 30-day scan is the slow, RPC-heavy part; a dropped connection keeps everything above and is retried tomorrow.
      if (todo.length) try {
        const from30 = await blockAtTimestamp(client as never, Math.floor(now() / 1000) - 30 * 86_400);
        await scanPayToVolume(db, { client, network, payTos: todo, fromBlock: from30, toBlock, log: { info: o.log.info, warn: o.log.warn, debug: () => {} } as never });
        const vol = db.prepare("SELECT sum_atomic, transfer_count FROM payto_volume WHERE network = ? AND pay_to = ? AND from_block = ? AND to_block = ?");
        const set = db.prepare("UPDATE unmapped_payees SET inflow_30d_atomic = ?, transfers_30d = ?, inflow_computed_at = ? WHERE pay_to = ?");
        for (const p of todo) {
          const v = vol.get(network, p, Number(from30), Number(toBlock)) as { sum_atomic: string; transfer_count: number } | undefined;
          if (v) {
            set.run(v.sum_atomic, v.transfer_count, now(), p);
            inflowScanned++;
          }
        }
      } catch (e) {
        stats.errors.push(`inflow scan: ${(e as Error).message.split("\n")[0]}`);
        o.log.warn(`discover refresh: 30-day inflow scan failed (${(e as Error).message.split("\n")[0]}); payees kept, retried next refresh`);
      }
      stats.chain = { fromBlock: fromBlock.toString(), toBlock: toBlock.toString(), facilitators: facilitators.size, authorizations: auth.total, sampled: auth.sample.length, facilitatorSettlements: got.settlements, payeesSeen: got.payees.size, newUnmapped, matchedNow, inflowScanned };
    } catch (e) {
      stats.errors.push(`chain: ${(e as Error).message.split("\n")[0]}`);
      o.log.warn(`discover refresh: chain diff failed (${(e as Error).message})`);
    }
  }

  stats.finishedAt = now();
  db.prepare("INSERT INTO meta (key, value) VALUES ('discover_refresh_last', ?) ON CONFLICT(key) DO UPDATE SET value = excluded.value").run(JSON.stringify(stats));
  return stats;
}
