/**
 * Settlement confirmation from chain logs (docs/PLAN.md "Settlement confirmation").
 *
 * A settlement for a signed EIP-3009 authorization is a USDC `Transfer(from, to, value)` whose
 * transaction also emitted `AuthorizationUsed(authorizer = from, nonce = signed.nonce)` from the
 * same token contract. Matching on the nonce (not just amount and addresses) is what lets us tell
 * two purchases of the same price apart, and count duplicates per intent.
 *
 * Read-only: nothing here signs or sends a transaction.
 */
import { getAddress, pad, type Address, type Hex } from "viem";
import type { Db } from "../db/index.js";
import { log } from "../log.js";
import { resolveIndeterminate, type SettlementFact, type SettlementLookup } from "../pipeline/paidCall.js";
import type { Classification } from "../classify.js";
import type { SignedAuthorization } from "../x402/pay.js";
import { AUTHORIZATION_USED_TOPIC0, TRANSFER_EVENT, usdcFor } from "./client.js";

/** The subset of a viem PublicClient used here (a real PublicClient satisfies it; tests pass a fake). */
export interface ConfirmClient {
  getBlockNumber(): Promise<bigint>;
  getLogs(args: {
    address: Address;
    event: typeof TRANSFER_EVENT;
    args: { from: Address; to: Address };
    fromBlock: bigint;
    toBlock: bigint;
  }): Promise<
    readonly {
      transactionHash: Hex | null;
      logIndex: number | null;
      blockNumber: bigint | null;
      args: { from?: Address | undefined; to?: Address | undefined; value?: bigint | undefined };
    }[]
  >;
  getTransactionReceipt(args: { hash: Hex }): Promise<{
    status: "success" | "reverted";
    logs: readonly { address: Address; topics: readonly Hex[] | [] ; logIndex: number | null }[];
  }>;
  getBlock(args: { blockNumber: bigint }): Promise<{ timestamp: bigint }>;
}

export interface ChainLookupOptions {
  client: ConfirmClient;
  network: string;
  /** Block number captured just before signing; logs are searched from here to latest. */
  fromBlock: bigint;
  /** Token address; defaults to USDC for `network` (override for TestUSDC on anvil). */
  asset?: string;
  /** Max blocks per eth_getLogs request (publicnode allows 50k; default 10k). */
  maxBlockRange?: bigint;
}

const eq = (a: string, b: string) => a.toLowerCase() === b.toLowerCase();

export function makeChainSettlementLookup(o: ChainLookupOptions): SettlementLookup {
  const token = getAddress(o.asset ?? usdcFor(o.network));
  const step = o.maxBlockRange ?? 10_000n;
  const blockTs = new Map<bigint, number>();

  return async (signed: SignedAuthorization): Promise<SettlementFact[]> => {
    const from = getAddress(signed.from);
    const to = getAddress(signed.to);
    const value = BigInt(signed.value);
    const nonce = signed.nonce.toLowerCase();
    const latest = await o.client.getBlockNumber();
    if (latest < o.fromBlock) return [];

    const candidates: { tx: Hex; logIndex: number; blockNumber: bigint }[] = [];
    for (let lo = o.fromBlock; lo <= latest; lo += step) {
      const hi = lo + step - 1n < latest ? lo + step - 1n : latest;
      const logs = await o.client.getLogs({ address: token, event: TRANSFER_EVENT, args: { from, to }, fromBlock: lo, toBlock: hi });
      for (const l of logs) {
        if (l.args.value !== value || !l.transactionHash || l.blockNumber === null) continue;
        candidates.push({ tx: l.transactionHash, logIndex: l.logIndex ?? 0, blockNumber: l.blockNumber });
      }
    }

    const facts: SettlementFact[] = [];
    const seenTx = new Set<string>();
    const fromTopic = pad(from, { size: 32 }).toLowerCase();
    for (const c of candidates) {
      if (seenTx.has(c.tx.toLowerCase())) continue;
      const receipt = await o.client.getTransactionReceipt({ hash: c.tx });
      if (receipt.status !== "success") continue;
      const auth = receipt.logs.find(
        (l) =>
          eq(l.address, token) &&
          l.topics[0]?.toLowerCase() === AUTHORIZATION_USED_TOPIC0.toLowerCase() &&
          l.topics[1]?.toLowerCase() === fromTopic &&
          l.topics[2]?.toLowerCase() === nonce,
      );
      if (!auth) continue;
      seenTx.add(c.tx.toLowerCase());
      let ts = blockTs.get(c.blockNumber);
      if (ts === undefined) {
        ts = Number((await o.client.getBlock({ blockNumber: c.blockNumber })).timestamp) * 1000;
        blockTs.set(c.blockNumber, ts);
      }
      facts.push({
        txHash: c.tx,
        logIndex: c.logIndex,
        blockNumber: Number(c.blockNumber),
        blockTs: ts,
        from,
        to,
        valueAtomic: value.toString(),
        nonce: signed.nonce,
        source: "chain",
      });
    }
    return facts;
  };
}

/**
 * Returns a factory that captures the current block number (minus a small safety margin) and
 * returns a lookup searching from there. Call it just before signing.
 */
export function makeChainLookupFactory(o: Omit<ChainLookupOptions, "fromBlock"> & { marginBlocks?: bigint }): () => Promise<SettlementLookup> {
  return async () => {
    const n = await o.client.getBlockNumber();
    const m = o.marginBlocks ?? 2n;
    return makeChainSettlementLookup({ ...o, fromBlock: n > m ? n - m : 0n });
  };
}

export interface ConfirmOptions {
  /** Default 10 minutes (docs/taxonomy.md: indeterminate after 10 min). */
  timeoutMs?: number;
  /** Default 15 s. */
  intervalMs?: number;
  abortSignal?: AbortSignal;
}

const sleep = (ms: number, signal?: AbortSignal) =>
  new Promise<void>((resolve) => {
    if (signal?.aborted) return resolve();
    const t = setTimeout(done, ms);
    function done() {
      clearTimeout(t);
      signal?.removeEventListener("abort", done);
      resolve();
    }
    signal?.addEventListener("abort", done, { once: true });
  });

/**
 * Polls `lookup` until at least one settlement is found, the timeout passes, or the signal aborts.
 * The first check is immediate. Lookup errors (RPC hiccups) are logged and retried. Returns [] on timeout.
 */
export async function confirmWithTimeout(lookup: SettlementLookup, signed: SignedAuthorization, o: ConfirmOptions = {}): Promise<SettlementFact[]> {
  const timeoutMs = o.timeoutMs ?? 10 * 60_000;
  const intervalMs = o.intervalMs ?? 15_000;
  const deadline = Date.now() + timeoutMs;
  for (;;) {
    try {
      const found = await lookup(signed);
      if (found.length > 0) return found;
    } catch (e) {
      log.warn(`settlement lookup failed for nonce ${signed.nonce.slice(0, 10)}…: ${e instanceof Error ? e.message : String(e)}`);
    }
    const left = deadline - Date.now();
    if (left <= 0 || o.abortSignal?.aborted) return [];
    await sleep(Math.min(intervalMs, left), o.abortSignal);
    if (o.abortSignal?.aborted) return [];
  }
}

interface PendingRow {
  id: number;
  intent_id: string;
  ts: number;
  wallet: string | null;
  quote_pay_to: string | null;
  amount_paid_atomic: string | null;
  nonce: string | null;
  valid_after: number | null;
  valid_before: number | null;
  resolve_until: number | null;
}

export interface ResolvePendingOptions {
  /** Lookup covering the whole resolve window (e.g. fromBlock = block at the oldest pending row's ts). */
  lookup: SettlementLookup;
  now?: () => number;
  defaultMaxTimeoutSeconds: number;
}

export interface ResolvePendingResult {
  checked: number;
  resolved: { callId: number; intentId: string; outcome: Classification["outcome"]; settlements: number; windowClosed: boolean }[];
  stillPending: number[];
  errors: { callId: number; error: string }[];
}

/**
 * Background resolver for `indeterminate` rows. Rows whose window is open are re-checked and resolved
 * when a settlement appears; rows whose `resolve_until` has passed get one final check and are then
 * resolved with what was found (an empty list makes them `not_paid`).
 *
 * Note: resolveIndeterminate (src/pipeline/paidCall.ts) measures elapsed time with the real clock, so the
 * not_paid outcome for a closed window requires 24 h of real time since the call, whatever `now` says.
 */
export async function resolvePendingIndeterminate(db: Db, o: ResolvePendingOptions): Promise<ResolvePendingResult> {
  const now = (o.now ?? Date.now)();
  const rows = db
    .prepare(
      `SELECT id, intent_id, ts, wallet, quote_pay_to, amount_paid_atomic, nonce, valid_after, valid_before, resolve_until
       FROM calls WHERE outcome = 'indeterminate' ORDER BY id`,
    )
    .all() as PendingRow[];
  const out: ResolvePendingResult = { checked: 0, resolved: [], stillPending: [], errors: [] };
  for (const r of rows) {
    if (!r.nonce || !r.wallet || !r.quote_pay_to || !r.amount_paid_atomic) {
      out.errors.push({ callId: r.id, error: "row lacks nonce/wallet/pay_to/amount; cannot look up" });
      continue;
    }
    out.checked++;
    const signed: SignedAuthorization = {
      nonce: r.nonce,
      from: r.wallet,
      to: r.quote_pay_to,
      value: r.amount_paid_atomic,
      validAfter: String(r.valid_after ?? 0),
      validBefore: String(r.valid_before ?? 0),
    };
    const windowClosed = r.resolve_until !== null && r.resolve_until <= now;
    let found: SettlementFact[];
    try {
      found = await o.lookup(signed);
    } catch (e) {
      out.errors.push({ callId: r.id, error: e instanceof Error ? e.message : String(e) });
      continue;
    }
    if (found.length === 0 && !windowClosed) {
      out.stillPending.push(r.id);
      continue;
    }
    const c = resolveIndeterminate(db, r.id, found, o.defaultMaxTimeoutSeconds);
    if (c.outcome === "indeterminate") out.stillPending.push(r.id);
    else out.resolved.push({ callId: r.id, intentId: r.intent_id, outcome: c.outcome, settlements: found.length, windowClosed });
    log.info(`resolve ${r.intent_id.slice(0, 8)} call ${r.id} -> ${c.outcome} (${found.length} settlement(s)${windowClosed ? ", window closed" : ""})`);
  }
  return out;
}


/**
 * Paid rows (any outcome) whose settlement was never found, still inside the 24 h window: look again and, when a
 * settlement now appears, record it. The outcome is NOT changed here; run `buy reclassify` afterwards so the
 * change is audited (settlement_count is a classifier input).
 */
export async function resolveUnconfirmedSettlements(
  db: Db,
  o: { lookup: SettlementLookup; now?: () => number; maxAgeMs?: number },
): Promise<{ checked: number; found: number[] }> {
  const now = (o.now ?? Date.now)();
  const rows = db
    .prepare(
      `SELECT id, intent_id, ts, wallet, quote_pay_to, amount_paid_atomic, nonce, valid_after, valid_before
         FROM calls WHERE paid = 1 AND settlement_count = 0 AND nonce IS NOT NULL AND outcome != 'indeterminate' AND ts >= ? ORDER BY id`,
    )
    .all(now - (o.maxAgeMs ?? 24 * 60 * 60 * 1000)) as { id: number; intent_id: string; ts: number; wallet: string; quote_pay_to: string; amount_paid_atomic: string; nonce: string; valid_after: number | null; valid_before: number | null }[];
  const found: number[] = [];
  const si = db.prepare(`INSERT OR IGNORE INTO settlements (call_id, intent_id, tx_hash, log_index, block_number, block_ts, from_addr, to_addr, value_atomic, nonce, source, found_at) VALUES (?,?,?,?,?,?,?,?,?,?,?,?)`);
  for (const r of rows) {
    let s: SettlementFact[] = [];
    try {
      s = await o.lookup({ nonce: r.nonce, validAfter: String(r.valid_after ?? 0), validBefore: String(r.valid_before ?? 0), value: r.amount_paid_atomic, to: r.quote_pay_to, from: r.wallet });
    } catch {
      continue;
    }
    if (s.length === 0) continue;
    db.transaction(() => {
      for (const f of s) si.run(r.id, r.intent_id, f.txHash, f.logIndex ?? 0, f.blockNumber ?? null, f.blockTs ?? null, f.from, f.to, f.valueAtomic, f.nonce ?? null, f.source, now);
      db.prepare("UPDATE calls SET settlement_count = ?, settlement_tx_hash = ?, settlement_block = ?, settlement_confirmed_at = ? WHERE id = ?").run(s.length, s[0]!.txHash, s[0]!.blockNumber ?? null, now, r.id);
    })();
    found.push(r.id);
  }
  return { checked: rows.length, found };
}
