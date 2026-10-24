/**
 * Verification of scanned USDC Transfers against EIP-3009 `AuthorizationUsed` (module 5 `chain`).
 *
 * `chain scan-volume` stores every USDC Transfer to a known pay-to with via_authorization = NULL. A Transfer
 * counts as an x402 (EIP-3009) settlement only when the same tx also has an `AuthorizationUsed` log from the
 * USDC contract whose authorizer equals Transfer.from (docs/protocol-notes.md Part 2 C). Checking that needs
 * one eth_getTransactionReceipt per tx, so instead of joining every transfer we:
 *   - verifySample: a seeded uniform sample of `perPayTo` unverified non-dust txs per pay-to, giving an
 *     EIP-3009 share with a Wilson 95% interval (stored in meta for the report);
 *   - verifyAll: every unverified non-dust tx, for a short list of pay-tos that matter.
 *
 * Writes: via_authorization = 1 (+ nonce = AuthorizationUsed topic2) on the tx's rows whose from_addr is an
 * authorizer, 0 on the tx's other rows. Permit2, `upto` and batch-settlement payments do not emit
 * AuthorizationUsed and therefore end up 0 here: 0 means "not EIP-3009", not "not x402".
 * Read-only on chain: nothing here signs or sends a transaction.
 */
import type { Db } from "../db/index.js";
import { log as defaultLog } from "../log.js";
import { mulberry32, shuffle } from "../probe/set.js";
import { wilsonInterval } from "../report/wilson.js";
import { AUTHORIZATION_USED_TOPIC0, usdcFor } from "./client.js";
import { isRateLimitError } from "./volume.js";

type Logger = Pick<typeof defaultLog, "info" | "warn" | "debug">;

export interface ReceiptLog {
  address: string;
  topics: readonly (string | null | undefined)[];
  logIndex?: number | null;
}
/** The subset of a viem PublicClient used here. A real PublicClient satisfies it. */
export interface ReceiptClient {
  getTransactionReceipt(args: { hash: `0x${string}` }): Promise<{ logs: readonly ReceiptLog[] } | null>;
}

export interface VerifyOptions {
  client: ReceiptClient;
  network: string;
  txHashes: string[];
  concurrency?: number;
  log?: Logger;
  /** Delays for successive rate-limit retries (ms); its length is the retry count. Injectable for tests. */
  backoffMs?: number[];
  sleep?: (ms: number) => Promise<void>;
  /** Txs fetched and written per DB transaction. */
  batchSize?: number;
}

export interface VerifyStats {
  /** Distinct txs whose receipt was fetched and whose rows were updated. */
  checked: number;
  /** chain_transfers rows set to via_authorization = 1. */
  viaAuthorization: number;
  /** chain_transfers rows set to via_authorization = 0. */
  plain: number;
  /** Txs whose receipt could not be fetched (rows left NULL). */
  errors: number;
  rpcCalls: number;
  retries: number;
}

export const VERIFY_BATCH_SIZE = 50;
export const DEFAULT_VERIFY_BACKOFF_MS = [2_000, 8_000, 30_000];
const defaultSleep = (ms: number) => new Promise<void>((r) => setTimeout(r, ms));

/** Address from a 32-byte topic (last 20 bytes), lowercase. */
const topicAddress = (t: string): string => `0x${t.slice(-40)}`.toLowerCase();

/**
 * Pure: the via_authorization/nonce assignment for one tx's rows given its receipt logs.
 * AuthorizationUsed logs from `usdc` are grouped by authorizer in log order; an authorizer's Transfer rows
 * (in log_index order) take its nonces in the same order (EIP-3009 emits AuthorizationUsed right before the
 * Transfer it authorizes); rows beyond the number of nonces keep the last nonce.
 */
export function classifyTxRows(
  logs: readonly ReceiptLog[],
  usdc: string,
  rows: readonly { id: number; from_addr: string; log_index: number }[],
): { id: number; via: 0 | 1; nonce: string | null }[] {
  const u = usdc.toLowerCase();
  const nonces = new Map<string, string[]>();
  const auth = logs
    .filter((l) => l.address.toLowerCase() === u && (l.topics[0] ?? "").toLowerCase() === AUTHORIZATION_USED_TOPIC0.toLowerCase())
    .sort((a, b) => (a.logIndex ?? 0) - (b.logIndex ?? 0));
  for (const l of auth) {
    const t1 = l.topics[1];
    if (!t1) continue;
    const k = topicAddress(t1);
    const arr = nonces.get(k) ?? [];
    arr.push((l.topics[2] ?? "").toLowerCase());
    nonces.set(k, arr);
  }
  const used = new Map<string, number>();
  return [...rows]
    .sort((a, b) => a.log_index - b.log_index)
    .map((r) => {
      const from = r.from_addr.toLowerCase();
      const ns = nonces.get(from);
      if (!ns || ns.length === 0) return { id: r.id, via: 0 as const, nonce: null };
      const i = used.get(from) ?? 0;
      used.set(from, i + 1);
      const n = ns[Math.min(i, ns.length - 1)] ?? "";
      return { id: r.id, via: 1 as const, nonce: n === "" ? null : n };
    });
}

export async function verifyTransfers(db: Db, opts: VerifyOptions): Promise<VerifyStats> {
  const {
    client,
    network,
    concurrency = 4,
    log = defaultLog,
    backoffMs = DEFAULT_VERIFY_BACKOFF_MS,
    sleep = defaultSleep,
    batchSize = VERIFY_BATCH_SIZE,
  } = opts;
  const usdc = usdcFor(network);
  const hashes = [...new Set(opts.txHashes.map((h) => h.toLowerCase()))];
  const stats: VerifyStats = { checked: 0, viaAuthorization: 0, plain: 0, errors: 0, rpcCalls: 0, retries: 0 };

  const rowsOf = db.prepare("SELECT id, from_addr, log_index FROM chain_transfers WHERE network = ? AND tx_hash = ?");
  const upd = db.prepare("UPDATE chain_transfers SET via_authorization = ?, nonce = ? WHERE id = ?");

  async function fetchReceipt(hash: string): Promise<readonly ReceiptLog[]> {
    for (let attempt = 0; ; attempt++) {
      stats.rpcCalls++;
      try {
        const r = await client.getTransactionReceipt({ hash: hash as `0x${string}` });
        if (!r) throw new Error(`no receipt for ${hash}`);
        return r.logs;
      } catch (err) {
        if (isRateLimitError(err) && attempt < backoffMs.length) {
          const d = backoffMs[attempt] ?? 30_000;
          stats.retries++;
          log.warn(`chain verify: rate limited, backing off ${d} ms`, { attempt: attempt + 1 });
          await sleep(d);
          continue;
        }
        throw err;
      }
    }
  }

  for (let b = 0; b < hashes.length; b += batchSize) {
    const batch = hashes.slice(b, b + batchSize);
    const results = new Map<string, readonly ReceiptLog[]>();
    let next = 0;
    const worker = async () => {
      while (next < batch.length) {
        const h = batch[next++] as string;
        try {
          results.set(h, await fetchReceipt(h));
        } catch (err) {
          stats.errors++;
          log.warn(`chain verify: receipt failed`, { tx: h, error: err instanceof Error ? err.message : String(err) });
        }
      }
    };
    await Promise.all(Array.from({ length: Math.max(1, Math.min(concurrency, batch.length)) }, worker));
    db.transaction(() => {
      for (const h of batch) {
        const logs = results.get(h);
        if (!logs) continue;
        const rows = rowsOf.all(network, h) as { id: number; from_addr: string; log_index: number }[];
        for (const r of classifyTxRows(logs, usdc, rows)) {
          upd.run(r.via, r.nonce, r.id);
          if (r.via === 1) stats.viaAuthorization++;
          else stats.plain++;
        }
        stats.checked++;
      }
    })();
    log.debug(`chain verify: ${Math.min(b + batchSize, hashes.length)}/${hashes.length} txs`, { ...stats });
  }
  return stats;
}

// ------------------------------------------------------------------ sampling

export interface PayToWindow {
  payTo: string;
  fromBlock: number;
  toBlock: number;
  fromTs: number;
  toTs: number;
  dustFloorAtomic: bigint;
}

/** The pay-to's latest payto_volume window (largest to_block, then widest range: same rule as topPayTos). */
export function latestWindow(db: Db, network: string, payTo: string): PayToWindow | null {
  const r = db
    .prepare(
      `SELECT pay_to, from_block, to_block, from_ts, to_ts, dust_floor_atomic FROM payto_volume
        WHERE network = ? AND LOWER(pay_to) = ? ORDER BY to_block DESC, from_block ASC LIMIT 1`,
    )
    .get(network, payTo.toLowerCase()) as
    | { pay_to: string; from_block: number; to_block: number; from_ts: number; to_ts: number; dust_floor_atomic: string }
    | undefined;
  if (!r) return null;
  return { payTo: payTo.toLowerCase(), fromBlock: r.from_block, toBlock: r.to_block, fromTs: r.from_ts, toTs: r.to_ts, dustFloorAtomic: BigInt(r.dust_floor_atomic) };
}

/** Non-dust value test on TEXT atomic amounts (> 18 digits is always above any floor). */
export const NON_DUST_SQL = `(length(value_atomic) > 18 OR CAST(value_atomic AS INTEGER) >= @dust_floor)`;

/** Distinct unverified non-dust tx hashes to a pay-to in a block window (sorted, so sampling is reproducible). */
export const VERIFY_CANDIDATES_SQL = `SELECT DISTINCT tx_hash FROM chain_transfers
  WHERE network = @network AND to_addr = @pay_to AND block_number BETWEEN @from_block AND @to_block
    AND via_authorization IS NULL AND ${NON_DUST_SQL}
  ORDER BY tx_hash`;

function candidates(db: Db, network: string, w: PayToWindow): string[] {
  return (
    db.prepare(VERIFY_CANDIDATES_SQL).all({
      network,
      pay_to: w.payTo,
      from_block: w.fromBlock,
      to_block: w.toBlock,
      dust_floor: w.dustFloorAtomic,
    }) as { tx_hash: string }[]
  ).map((r) => r.tx_hash);
}

/** 32-bit FNV-1a of a string, mixed with the seed: one reproducible sub-seed per pay-to. */
export function subSeed(seed: number, key: string): number {
  let h = (0x811c9dc5 ^ (seed >>> 0)) >>> 0;
  for (let i = 0; i < key.length; i++) {
    h ^= key.charCodeAt(i);
    h = Math.imul(h, 0x01000193) >>> 0;
  }
  return h >>> 0;
}

/** Seeded uniform sample of k distinct items (without replacement). */
export function sampleWithoutReplacement<T>(items: readonly T[], k: number, seed: number): T[] {
  if (k >= items.length) return [...items];
  return shuffle([...items], mulberry32(seed)).slice(0, k);
}

export interface SampleStat {
  payTo: string;
  /** Sampled txs whose receipt was checked. */
  sampled: number;
  /** Of those, txs with a non-dust transfer to the pay-to that is via AuthorizationUsed. */
  viaAuthorization: number;
  share: number;
  lo: number;
  hi: number;
  /** Unverified non-dust txs the sample was drawn from. */
  population: number;
  errors: number;
}
export type SampleStats = SampleStat[];

export const EIP3009_SHARE_META_PREFIX = "eip3009_share_";
export const eip3009ShareMetaKey = (network: string, payTo: string) => `${EIP3009_SHARE_META_PREFIX}${network}_${payTo.toLowerCase()}`;

export interface SampleOptions {
  client: ReceiptClient;
  network: string;
  payTos: string[];
  perPayTo?: number;
  seed: number;
  log?: Logger;
  concurrency?: number;
  backoffMs?: number[];
  sleep?: (ms: number) => Promise<void>;
}

/**
 * Per pay-to: seeded uniform sample of `perPayTo` distinct unverified non-dust txs in its latest
 * payto_volume window, verified against AuthorizationUsed, giving the EIP-3009 share with a Wilson 95%
 * interval. The sample unit is the tx. Each run samples among txs still unverified, and the meta row holds
 * the latest run's estimate only.
 */
export async function verifySample(db: Db, opts: SampleOptions): Promise<SampleStats> {
  const { client, network, perPayTo = 100, seed, log = defaultLog } = opts;
  const setMeta = db.prepare("INSERT INTO meta (key, value) VALUES (?, ?) ON CONFLICT(key) DO UPDATE SET value = excluded.value");
  const viaOf = db.prepare(
    `SELECT MAX(via_authorization) AS via FROM chain_transfers
      WHERE network = @network AND tx_hash = @tx AND to_addr = @pay_to AND ${NON_DUST_SQL}`,
  );
  const out: SampleStats = [];
  for (const raw of [...new Set(opts.payTos.map((p) => p.toLowerCase()))]) {
    const w = latestWindow(db, network, raw);
    if (!w) {
      log.warn(`chain verify-sample: no payto_volume window for ${raw}, skipped`);
      continue;
    }
    const pool = candidates(db, network, w);
    const sample = sampleWithoutReplacement(pool, perPayTo, subSeed(seed, raw));
    const st = await verifyTransfers(db, {
      client,
      network,
      txHashes: sample,
      log,
      ...(opts.concurrency !== undefined ? { concurrency: opts.concurrency } : {}),
      ...(opts.backoffMs ? { backoffMs: opts.backoffMs } : {}),
      ...(opts.sleep ? { sleep: opts.sleep } : {}),
    });
    let sampled = 0;
    let via = 0;
    for (const tx of sample) {
      const r = viaOf.get({ network, tx, pay_to: raw, dust_floor: w.dustFloorAtomic }) as { via: number | null } | undefined;
      if (r?.via === null || r?.via === undefined) continue; // receipt failed
      sampled++;
      if (r.via === 1) via++;
    }
    const iv = wilsonInterval(via, sampled);
    const stat: SampleStat = { payTo: raw, sampled, viaAuthorization: via, share: iv.p, lo: iv.lo, hi: iv.hi, population: pool.length, errors: st.errors };
    setMeta.run(
      eip3009ShareMetaKey(network, raw),
      JSON.stringify({ ...stat, network, seed, perPayTo, fromBlock: w.fromBlock, toBlock: w.toBlock, computedAt: Date.now() }),
    );
    log.info(`chain verify-sample ${raw}: ${via}/${sampled} via AuthorizationUsed`, { lo: iv.lo, hi: iv.hi, population: pool.length });
    out.push(stat);
  }
  return out;
}

export interface VerifyAllOptions {
  client: ReceiptClient;
  network: string;
  payTos: string[];
  log?: Logger;
  concurrency?: number;
  backoffMs?: number[];
  sleep?: (ms: number) => Promise<void>;
}

/** Full verification: every unverified non-dust tx to each pay-to in its latest window. */
export async function verifyAll(db: Db, opts: VerifyAllOptions): Promise<VerifyStats & { payTos: number; txs: number }> {
  const { client, network, log = defaultLog } = opts;
  const total: VerifyStats & { payTos: number; txs: number } = { checked: 0, viaAuthorization: 0, plain: 0, errors: 0, rpcCalls: 0, retries: 0, payTos: 0, txs: 0 };
  for (const raw of [...new Set(opts.payTos.map((p) => p.toLowerCase()))]) {
    const w = latestWindow(db, network, raw);
    if (!w) {
      log.warn(`chain verify-all: no payto_volume window for ${raw}, skipped`);
      continue;
    }
    const txs = candidates(db, network, w);
    log.info(`chain verify-all ${raw}: ${txs.length} unverified txs`);
    const st = await verifyTransfers(db, {
      client,
      network,
      txHashes: txs,
      log,
      ...(opts.concurrency !== undefined ? { concurrency: opts.concurrency } : {}),
      ...(opts.backoffMs ? { backoffMs: opts.backoffMs } : {}),
      ...(opts.sleep ? { sleep: opts.sleep } : {}),
    });
    total.payTos++;
    total.txs += txs.length;
    for (const k of ["checked", "viaAuthorization", "plain", "errors", "rpcCalls", "retries"] as const) total[k] += st[k];
  }
  return total;
}
