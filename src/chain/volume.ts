/**
 * Per pay-to USDC settlement volume from Transfer logs (module 5 `chain`, also used to rank sellers).
 *
 * Strategy: eth_getLogs on the USDC contract, Transfer events with topic2 (`to`) = OR(batch of pay-tos),
 * over block windows of at most `maxBlockSpan` (publicnode allows 50,000 blocks / 20,000 results).
 * Raw rows go to chain_transfers (traceable), coverage to chain_scan_progress (resumable), and
 * aggregates to payto_volume.
 *
 * Not done here: joining AuthorizationUsed to mark via_authorization (left NULL). The dust floor is the
 * cheap first filter against address-poisoning spam (docs/protocol-notes.md Part 2 C).
 */
import type { Address } from "viem";
import type { Db } from "../db/index.js";
import { log as defaultLog } from "../log.js";
import { TRANSFER_EVENT, usdcFor } from "./client.js";

export interface RawTransferLog {
  transactionHash: string | null;
  logIndex: number | null;
  blockNumber: bigint | null;
  /** Some RPCs return it; when present we store it instead of the interpolated value. */
  blockTimestamp?: bigint | string | number | null | undefined;
  args: { from?: string | undefined; to?: string | undefined; value?: bigint | undefined };
}

/** The subset of a viem PublicClient the scanner uses. A real PublicClient satisfies it. */
export interface LogClient {
  getLogs(args: any): Promise<readonly unknown[]>;
  getBlock(args: { blockNumber: bigint }): Promise<{ timestamp: bigint }>;
}

type Logger = Pick<typeof defaultLog, "info" | "warn" | "debug">;

export interface ScanProgress {
  window: number;
  windowFrom: bigint;
  windowTo: bigint;
  fromBlock: bigint;
  toBlock: bigint;
  logsFetched: number;
  inserted: number;
  rpcCalls: number;
}

export interface ScanOptions {
  client: LogClient;
  network: string;
  payTos: string[];
  fromBlock: bigint;
  toBlock: bigint;
  dustFloorAtomic?: bigint;
  maxBlockSpan?: number;
  /** Below this span a too-many-results error splits the address batch instead of the range. */
  minBlockSpan?: number;
  maxAddressesPerQuery?: number;
  log?: Logger;
  onProgress?: (p: ScanProgress) => void;
  /** Delays for successive 429 retries (ms). Injectable for tests. */
  backoffMs?: number[];
  sleep?: (ms: number) => Promise<void>;
}

export interface ScanStats {
  windows: number;
  rpcCalls: number;
  logsFetched: number;
  inserted: number;
  payTosScanned: number;
  errorsRetried: number;
  durationMs: number;
}

/**
 * Substrings (lowercased) of RPC errors that mean "ask for less": split the range (or the address batch).
 * The first two are publicnode's exact texts (see the smoke test notes in the report / protocol-notes):
 *   -32701 "exceed maximum block range: 50000"
 *   -32602 "query exceeds max results 20000, retry with the range …"
 * The rest cover geth/Infura/Alchemy-style wording and transport timeouts.
 */
export const TOO_MUCH_PATTERNS = [
  "exceed maximum block range",
  "query exceeds max results",
  "more than 10000 results",
  "more than 20000 results",
  "query returned more than",
  "log response size exceeded",
  "response size exceeded",
  "response too large",
  "too many results",
  "block range is too large",
  "block range too large",
  "range too large",
  "limit exceeded",
  "timed out",
  "timeout",
];
/** Rate limiting: back off and retry the same request. mainnet.base.org: -32011 "request limit reached". */
export const RATE_LIMIT_PATTERNS = ["429", "too many requests", "request limit reached", "rate limit", "-32011", "-32005"];

function errorText(err: unknown): string {
  const parts: string[] = [];
  let e: any = err;
  for (let i = 0; e && i < 6; i++) {
    for (const k of ["message", "shortMessage", "details"]) if (typeof e[k] === "string") parts.push(e[k]);
    if (typeof e.status === "number") parts.push(`status ${e.status}`);
    if (typeof e.code === "number") parts.push(`code ${e.code}`);
    e = e.cause;
  }
  return parts.join(" | ").toLowerCase();
}
export function isRateLimitError(err: unknown): boolean {
  const t = errorText(err);
  return RATE_LIMIT_PATTERNS.some((p) => t.includes(p));
}
export function isTooMuchError(err: unknown): boolean {
  const t = errorText(err);
  return TOO_MUCH_PATTERNS.some((p) => t.includes(p));
}

const defaultSleep = (ms: number) => new Promise<void>((r) => setTimeout(r, ms));

class LruMap<K, V> {
  private m = new Map<K, V>();
  constructor(private max: number) {}
  get(k: K): V | undefined {
    const v = this.m.get(k);
    if (v !== undefined) {
      this.m.delete(k);
      this.m.set(k, v);
    }
    return v;
  }
  set(k: K, v: V): void {
    this.m.delete(k);
    this.m.set(k, v);
    if (this.m.size > this.max) this.m.delete(this.m.keys().next().value as K);
  }
}

interface Interval {
  from: bigint;
  to: bigint;
}
const maxB = (a: bigint, b: bigint) => (a > b ? a : b);
const minB = (a: bigint, b: bigint) => (a < b ? a : b);

/** Parts of [from,to] not covered by `cov`. */
function uncovered(from: bigint, to: bigint, cov: Interval | undefined): Interval[] {
  if (!cov || cov.to < from || cov.from > to) return [{ from, to }];
  const out: Interval[] = [];
  if (from < cov.from) out.push({ from, to: cov.from - 1n });
  if (to > cov.to) out.push({ from: cov.to + 1n, to });
  return out;
}

export async function scanPayToVolume(db: Db, opts: ScanOptions): Promise<ScanStats> {
  const started = Date.now();
  const {
    client,
    network,
    fromBlock,
    toBlock,
    dustFloorAtomic = 100n,
    maxBlockSpan = 50_000,
    minBlockSpan = 256,
    maxAddressesPerQuery = 200,
    log = defaultLog,
    onProgress,
    backoffMs = [2_000, 8_000, 30_000],
    sleep = defaultSleep,
  } = opts;
  if (toBlock < fromBlock) throw new Error(`toBlock ${toBlock} < fromBlock ${fromBlock}`);
  const usdc = usdcFor(network);
  const payTos = [...new Set(opts.payTos.map((a) => a.toLowerCase()))].sort();
  const stats: ScanStats = { windows: 0, rpcCalls: 0, logsFetched: 0, inserted: 0, payTosScanned: payTos.length, errorsRetried: 0, durationMs: 0 };

  // ---- resume: what is already covered per address
  const getProgress = db.prepare("SELECT from_block, to_block FROM chain_scan_progress WHERE network = ? AND to_addr = ?");
  const putProgress = db.prepare(
    "INSERT INTO chain_scan_progress (network, to_addr, from_block, to_block) VALUES (?, ?, ?, ?) " +
      "ON CONFLICT(network, to_addr) DO UPDATE SET from_block = excluded.from_block, to_block = excluded.to_block",
  );
  const coverage = new Map<string, Interval | undefined>();
  const needed = new Map<string, Interval[]>();
  for (const a of payTos) {
    const r = getProgress.get(network, a) as { from_block: number; to_block: number } | undefined;
    const cov = r ? { from: BigInt(r.from_block), to: BigInt(r.to_block) } : undefined;
    coverage.set(a, cov);
    needed.set(a, uncovered(fromBlock, toBlock, cov));
  }
  /** Extend contiguous coverage with [f,t]. A disjoint range replaces the old one only if the old one is
   *  not part of the requested range (keep it simple: one contiguous range per address). */
  const markCovered = (a: string, f: bigint, t: bigint) => {
    const cov = coverage.get(a);
    let next: Interval;
    if (!cov) next = { from: f, to: t };
    else if (f <= cov.to + 1n && t + 1n >= cov.from) next = { from: minB(cov.from, f), to: maxB(cov.to, t) };
    else if (cov.to < fromBlock || cov.from > toBlock) next = { from: f, to: t };
    else return; // gap between old coverage and this piece; recorded once the gap is filled
    coverage.set(a, next);
    putProgress.run(network, a, Number(next.from), Number(next.to));
  };

  // ---- RPC helpers
  const tsCache = new LruMap<bigint, bigint>(256);
  const blockTs = async (n: bigint): Promise<bigint> => {
    const c = tsCache.get(n);
    if (c !== undefined) return c;
    const b = await withRateLimitRetry(() => client.getBlock({ blockNumber: n }));
    tsCache.set(n, b.timestamp);
    return b.timestamp;
  };
  async function withRateLimitRetry<T>(fn: () => Promise<T>): Promise<T> {
    for (let attempt = 0; ; attempt++) {
      stats.rpcCalls++;
      try {
        return await fn();
      } catch (err) {
        if (isRateLimitError(err) && attempt < backoffMs.length) {
          const d = backoffMs[attempt] ?? 30_000;
          stats.errorsRetried++;
          log.warn(`chain: rate limited, backing off ${d} ms`, { attempt: attempt + 1 });
          await sleep(d);
          continue;
        }
        throw err;
      }
    }
  }

  let splitHappened = false;
  async function fetchLogs(addrs: string[], f: bigint, t: bigint): Promise<RawTransferLog[]> {
    try {
      const logs = await withRateLimitRetry(() =>
        client.getLogs({ address: usdc, event: TRANSFER_EVENT, args: { to: addrs as Address[] }, fromBlock: f, toBlock: t }),
      );
      return logs as RawTransferLog[];
    } catch (err) {
      if (!isTooMuchError(err)) throw err;
      stats.errorsRetried++;
      splitHappened = true;
      const span = t - f + 1n;
      if (span > BigInt(minBlockSpan)) {
        const mid = f + span / 2n - 1n;
        log.debug("chain: too many results, halving range", { from: f.toString(), to: t.toString(), addrs: addrs.length });
        return [...(await fetchLogs(addrs, f, mid)), ...(await fetchLogs(addrs, mid + 1n, t))];
      }
      if (addrs.length > 1) {
        const h = Math.ceil(addrs.length / 2);
        log.debug("chain: too many results at min span, splitting addresses", { from: f.toString(), addrs: addrs.length });
        return [...(await fetchLogs(addrs.slice(0, h), f, t)), ...(await fetchLogs(addrs.slice(h), f, t))];
      }
      throw new Error(`chain: getLogs still too large for one address over ${span} blocks at ${f}: ${errorText(err)}`, { cause: err });
    }
  }

  const insert = db.prepare(
    "INSERT OR IGNORE INTO chain_transfers (network, tx_hash, log_index, block_number, block_ts, from_addr, to_addr, value_atomic, via_authorization) " +
      "VALUES (?, ?, ?, ?, ?, ?, ?, ?, NULL)",
  );

  // ---- window loop
  const totalWindowsEstimate = Number((toBlock - fromBlock) / BigInt(maxBlockSpan)) + 1;
  let span = BigInt(maxBlockSpan);
  let cleanStreak = 0;
  for (let ws = fromBlock; ws <= toBlock; ) {
    const we = minB(toBlock, ws + span - 1n);
    stats.windows++;
    // Group addresses by the uncovered sub-interval of this window they need.
    const groups = new Map<string, { f: bigint; t: bigint; addrs: string[] }>();
    for (const a of payTos) {
      for (const iv of needed.get(a) ?? []) {
        const f = maxB(ws, iv.from);
        const t = minB(we, iv.to);
        if (f > t) continue;
        const k = `${f}-${t}`;
        const g = groups.get(k) ?? { f, t, addrs: [] };
        g.addrs.push(a);
        groups.set(k, g);
      }
    }
    splitHappened = false;
    let windowLogs = 0;
    let windowInserted = 0;
    for (const g of groups.values()) {
      for (let i = 0; i < g.addrs.length; i += maxAddressesPerQuery) {
        const batch = g.addrs.slice(i, i + maxAddressesPerQuery);
        const logs = await fetchLogs(batch, g.f, g.t);
        stats.logsFetched += logs.length;
        windowLogs += logs.length;
        // block_ts is linearly interpolated between the group's first and last block timestamps
        // (2 getBlock calls, only when there are logs). Base makes a block every 2 s, so this is exact or
        // within a few seconds; a log's own blockTimestamp (some RPCs return it) is used when present.
        let t0 = 0n;
        let t1 = 0n;
        if (logs.some((l) => l.blockTimestamp == null)) {
          t0 = await blockTs(g.f);
          t1 = g.t === g.f ? t0 : await blockTs(g.t);
        }
        const interp = (n: bigint) => (g.t === g.f ? t0 : t0 + ((t1 - t0) * (n - g.f)) / (g.t - g.f));
        const batchSet = new Set(batch);
        db.transaction(() => {
          for (const l of logs) {
            if (l.transactionHash == null || l.logIndex == null || l.blockNumber == null) continue; // pending
            const to = (l.args.to ?? "").toLowerCase();
            const from = (l.args.from ?? "").toLowerCase();
            if (!batchSet.has(to) || l.args.value === undefined) continue;
            const tsSec = l.blockTimestamp != null ? BigInt(l.blockTimestamp) : interp(l.blockNumber);
            const r = insert.run(network, l.transactionHash.toLowerCase(), l.logIndex, Number(l.blockNumber), Number(tsSec) * 1000, from, to, l.args.value.toString());
            windowInserted += r.changes;
          }
          for (const a of batch) markCovered(a, g.f, g.t);
        })();
      }
    }
    stats.inserted += windowInserted;
    const p: ScanProgress = { window: stats.windows, windowFrom: ws, windowTo: we, fromBlock, toBlock, logsFetched: windowLogs, inserted: windowInserted, rpcCalls: stats.rpcCalls };
    log.info(`chain: window ${stats.windows}/~${totalWindowsEstimate} blocks ${ws}-${we}`, { queries: groups.size, logs: windowLogs, inserted: windowInserted, rpcCalls: stats.rpcCalls });
    onProgress?.(p);
    // Adapt the window: shrink after a window that needed splitting, grow back after 3 clean ones.
    if (splitHappened) {
      span = maxB(BigInt(minBlockSpan), span / 2n);
      cleanStreak = 0;
    } else if (++cleanStreak >= 3 && span < BigInt(maxBlockSpan)) {
      span = minB(BigInt(maxBlockSpan), span * 2n);
      cleanStreak = 0;
    }
    ws = we + 1n;
  }

  // ---- aggregates over [fromBlock, toBlock]
  const fromTs = (await blockTs(fromBlock)) * 1000n;
  const toTs = (await blockTs(toBlock)) * 1000n;
  computePayToVolumes(db, { network, payTos, fromBlock, toBlock, fromTsMs: fromTs, toTsMs: toTs, dustFloorAtomic });

  stats.durationMs = Date.now() - started;
  log.info("chain: scan done", { ...stats });
  return stats;
}

export interface PayToAggregate {
  payTo: string;
  transferCount: number;
  sumAtomic: bigint;
  dustCount: number;
  uniquePayers: number;
}

/** Aggregate chain_transfers per pay-to (bigint sums) and UPSERT into payto_volume. */
export function computePayToVolumes(
  db: Db,
  o: { network: string; payTos: string[]; fromBlock: bigint; toBlock: bigint; fromTsMs: bigint; toTsMs: bigint; dustFloorAtomic: bigint },
): PayToAggregate[] {
  const rows = db.prepare(
    "SELECT from_addr, value_atomic FROM chain_transfers WHERE network = ? AND to_addr = ? AND block_number BETWEEN ? AND ?",
  );
  const upsert = db.prepare(
    `INSERT INTO payto_volume (network, pay_to, from_block, to_block, from_ts, to_ts, transfer_count, sum_atomic, dust_count, dust_floor_atomic, unique_payers, computed_at)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
     ON CONFLICT(network, pay_to, from_block, to_block) DO UPDATE SET
       from_ts = excluded.from_ts, to_ts = excluded.to_ts, transfer_count = excluded.transfer_count,
       sum_atomic = excluded.sum_atomic, dust_count = excluded.dust_count, dust_floor_atomic = excluded.dust_floor_atomic,
       unique_payers = excluded.unique_payers, computed_at = excluded.computed_at`,
  );
  const now = Date.now();
  const out: PayToAggregate[] = [];
  db.transaction(() => {
    for (const raw of o.payTos) {
      const payTo = raw.toLowerCase();
      let sum = 0n;
      let count = 0;
      let dust = 0;
      const payers = new Set<string>();
      for (const r of rows.all(o.network, payTo, Number(o.fromBlock), Number(o.toBlock)) as { from_addr: string; value_atomic: string }[]) {
        const v = BigInt(r.value_atomic);
        if (v < o.dustFloorAtomic) {
          dust++;
          continue;
        }
        sum += v;
        count++;
        payers.add(r.from_addr); // dust senders (address-poisoning spam) are not counted as payers
      }
      upsert.run(o.network, payTo, Number(o.fromBlock), Number(o.toBlock), Number(o.fromTsMs), Number(o.toTsMs), count, sum.toString(), dust, o.dustFloorAtomic.toString(), payers.size, now);
      out.push({ payTo, transferCount: count, sumAtomic: sum, dustCount: dust, uniquePayers: payers.size });
    }
  })();
  return out;
}
