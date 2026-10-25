import { describe, expect, it } from "vitest";
import { getAddress, pad, type Address, type Hex } from "viem";
import { openDb } from "../db/index.js";
import { runPaidCall } from "../pipeline/paidCall.js";
import type { PaidResult, Payer, SignedAuthorization } from "../x402/pay.js";
import { AUTHORIZATION_USED_TOPIC0, TRANSFER_TOPIC0 } from "./client.js";
import { confirmWithTimeout, makeChainSettlementLookup, resolvePendingIndeterminate, type ConfirmClient } from "./confirm.js";

const TOKEN = getAddress("0x036CbD53842c5426634e7929541eC2318f3dCF7e");
const FROM = getAddress("0x1111111111111111111111111111111111111111");
const TO = getAddress("0x2222222222222222222222222222222222222222");
const NONCE = ("0x" + "ab".repeat(32)) as Hex;
const NONCE2 = ("0x" + "cd".repeat(32)) as Hex;
const signed: SignedAuthorization = { nonce: NONCE, from: FROM, to: TO, value: "10000", validAfter: "0", validBefore: "9999999999" };

interface FakeTransfer {
  tx: Hex;
  logIndex: number;
  block: bigint;
  from: Address;
  to: Address;
  value: bigint;
  /** nonce emitted via AuthorizationUsed in the same tx, or undefined for a plain transfer */
  authNonce?: Hex;
  authorizer?: Address;
  authFromOtherContract?: boolean;
  reverted?: boolean;
}

function fakeClient(transfers: FakeTransfer[], latest = 100n) {
  const calls = { getLogs: [] as { fromBlock: bigint; toBlock: bigint }[], receipts: 0, blocks: 0 };
  const client: ConfirmClient & { latest: bigint } = {
    latest,
    async getBlockNumber() {
      return client.latest;
    },
    async getLogs(a) {
      calls.getLogs.push({ fromBlock: a.fromBlock, toBlock: a.toBlock });
      return transfers
        .filter((t) => t.block >= a.fromBlock && t.block <= a.toBlock && t.from === a.args.from && t.to === a.args.to)
        .map((t) => ({ transactionHash: t.tx, logIndex: t.logIndex, blockNumber: t.block, args: { from: t.from, to: t.to, value: t.value } }));
    },
    async getTransactionReceipt({ hash }) {
      calls.receipts++;
      const ts = transfers.filter((t) => t.tx === hash);
      const logs = ts.flatMap((t) => [
        { address: TOKEN, topics: [TRANSFER_TOPIC0, pad(t.from), pad(t.to)] as Hex[], logIndex: t.logIndex, data: pad(("0x" + t.value.toString(16)) as Hex, { size: 32 }) },
        ...(t.authNonce
          ? [{ address: t.authFromOtherContract ? FROM : TOKEN, topics: [AUTHORIZATION_USED_TOPIC0, pad(t.authorizer ?? t.from), t.authNonce] as Hex[], logIndex: t.logIndex - 1 }]
          : []),
      ]);
      return { status: ts.some((t) => t.reverted) ? ("reverted" as const) : ("success" as const), logs, blockNumber: ts[0]?.block, transactionHash: hash };
    },
    async getBlock({ blockNumber }) {
      calls.blocks++;
      return { timestamp: 1_700_000_000n + blockNumber * 2n };
    },
  };
  return { client, calls };
}

const tx = (n: number) => ("0x" + n.toString(16).padStart(64, "0")) as Hex;

describe("makeChainSettlementLookup", () => {
  it("matches Transfer + AuthorizationUsed(from, nonce) in the same tx and ignores look-alikes", async () => {
    const { client } = fakeClient([
      { tx: tx(1), logIndex: 5, block: 50n, from: FROM, to: TO, value: 10000n, authNonce: NONCE }, // the one
      { tx: tx(2), logIndex: 3, block: 51n, from: FROM, to: TO, value: 10000n, authNonce: NONCE2 }, // other purchase, same price
      { tx: tx(3), logIndex: 1, block: 52n, from: FROM, to: TO, value: 10000n }, // plain transfer, no auth
      { tx: tx(4), logIndex: 2, block: 53n, from: FROM, to: TO, value: 20000n, authNonce: NONCE }, // wrong value
      { tx: tx(5), logIndex: 2, block: 54n, from: FROM, to: TO, value: 10000n, authNonce: NONCE, authFromOtherContract: true },
      { tx: tx(6), logIndex: 2, block: 55n, from: FROM, to: TO, value: 10000n, authNonce: NONCE, authorizer: TO }, // wrong authorizer
      { tx: tx(7), logIndex: 2, block: 10n, from: FROM, to: TO, value: 10000n, authNonce: NONCE }, // before fromBlock
    ]);
    const lookup = makeChainSettlementLookup({ client, network: "eip155:84532", fromBlock: 40n });
    const facts = await lookup(signed);
    expect(facts).toEqual([
      { txHash: tx(1), logIndex: 5, blockNumber: 50, blockTs: (1_700_000_000 + 100) * 1000, from: FROM, to: TO, valueAtomic: "10000", nonce: NONCE, source: "chain" },
    ]);
  });

  it("finds two settlements for one nonce in two txs (duplicate) and chunks the block range", async () => {
    const { client, calls } = fakeClient(
      [
        { tx: tx(1), logIndex: 1, block: 5n, from: FROM, to: TO, value: 10000n, authNonce: NONCE },
        { tx: tx(2), logIndex: 1, block: 25n, from: FROM, to: TO, value: 10000n, authNonce: NONCE },
      ],
      30n,
    );
    const facts = await makeChainSettlementLookup({ client, network: "eip155:84532", fromBlock: 0n, maxBlockRange: 10n })(signed);
    expect(facts.map((f) => f.txHash)).toEqual([tx(1), tx(2)]);
    expect(calls.getLogs).toEqual([
      { fromBlock: 0n, toBlock: 9n },
      { fromBlock: 10n, toBlock: 19n },
      { fromBlock: 20n, toBlock: 29n },
      { fromBlock: 30n, toBlock: 30n },
    ]);
  });

  it("returns [] when latest is before fromBlock, and skips reverted txs", async () => {
    const { client } = fakeClient([{ tx: tx(1), logIndex: 1, block: 5n, from: FROM, to: TO, value: 10000n, authNonce: NONCE, reverted: true }], 10n);
    expect(await makeChainSettlementLookup({ client, network: "eip155:84532", fromBlock: 20n })(signed)).toEqual([]);
    expect(await makeChainSettlementLookup({ client, network: "eip155:84532", fromBlock: 0n })(signed)).toEqual([]);
  });

  it("uses the asset override (e.g. TestUSDC on anvil)", async () => {
    const other = getAddress("0x3333333333333333333333333333333333333333");
    const { client } = fakeClient([{ tx: tx(1), logIndex: 1, block: 5n, from: FROM, to: TO, value: 10000n, authNonce: NONCE }]);
    // Receipt logs come from TOKEN, so an override to another address must not match.
    expect(await makeChainSettlementLookup({ client, network: "eip155:84532", fromBlock: 0n, asset: other })(signed)).toEqual([]);
  });
});

describe("receipt-first verification from the seller-reported tx hash", () => {
  it("verifies the hinted receipt without scanning logs, and falls back to the scan when the hash does not match", async () => {
    const good = { tx: tx(7), block: 50n, logIndex: 3, from: FROM, to: TO, value: 1000n, authNonce: NONCE };
    const { client, calls } = fakeClient([good]);
    const lookup = makeChainSettlementLookup({ client, network: "eip155:84532", fromBlock: 40n });
    const signed = { nonce: NONCE, validAfter: "0", validBefore: "0", value: "1000", to: TO, from: FROM };
    const facts = await lookup(signed, { response: { status: 200 }, settlementSuccess: true, settlementTx: tx(7) });
    expect(facts.map((f) => f.txHash)).toEqual([tx(7)]);
    expect(calls.getLogs).toHaveLength(0);
    expect(calls.receipts).toBe(1);
    // A hash whose receipt does not carry our nonce falls through to the log scan and still finds the settlement.
    const other = fakeClient([good, { tx: tx(8), block: 51n, logIndex: 1, from: FROM, to: TO, value: 1000n }]);
    const lookup2 = makeChainSettlementLookup({ client: other.client, network: "eip155:84532", fromBlock: 40n });
    const facts2 = await lookup2(signed, { settlementTx: tx(8) });
    expect(facts2.map((f) => f.txHash)).toEqual([tx(7)]);
    expect(other.calls.getLogs.length).toBeGreaterThan(0);
  });
});

describe("confirmWithTimeout", () => {
  it("forwards the hint to the lookup on every poll", async () => {
    const seen: unknown[] = [];
    const lookup = async (_s: SignedAuthorization, hint?: unknown) => { seen.push(hint); return seen.length >= 2 ? [{ txHash: tx(1), from: FROM, to: TO, valueAtomic: "1", source: "chain" as const }] : []; };
    const r = await confirmWithTimeout(lookup, signed, { timeoutMs: 5_000, intervalMs: 5, hint: { settlementTx: tx(9) } });
    expect(r).toHaveLength(1);
    expect(seen).toEqual([{ settlementTx: tx(9) }, { settlementTx: tx(9) }]);
  });
  it("polls until found", async () => {
    let n = 0;
    const found = await confirmWithTimeout(
      async () => (++n >= 3 ? [{ txHash: "0x1", from: FROM, to: TO, valueAtomic: "1", source: "chain" }] : []),
      signed,
      { timeoutMs: 5_000, intervalMs: 10 },
    );
    expect(n).toBe(3);
    expect(found).toHaveLength(1);
  });
  it("returns [] after the timeout and survives lookup errors", async () => {
    let n = 0;
    const t0 = Date.now();
    const found = await confirmWithTimeout(
      async () => {
        n++;
        if (n === 1) throw new Error("rpc down");
        return [];
      },
      signed,
      { timeoutMs: 120, intervalMs: 20 },
    );
    expect(found).toEqual([]);
    expect(n).toBeGreaterThan(2);
    expect(Date.now() - t0).toBeGreaterThanOrEqual(110);
  });
  it("stops on abort", async () => {
    const ac = new AbortController();
    setTimeout(() => ac.abort(), 30);
    const t0 = Date.now();
    expect(await confirmWithTimeout(async () => [], signed, { timeoutMs: 10_000, intervalMs: 1_000, abortSignal: ac.signal })).toEqual([]);
    expect(Date.now() - t0).toBeLessThan(1_000);
  });
});

describe("resolvePendingIndeterminate", () => {
  /** A payer that signs and then times out, leaving the call indeterminate. */
  const hangingPayer = (nonce: Hex): Payer => ({
    address: FROM,
    network: "eip155:84532",
    async payAndFetch(url, _init, hooks): Promise<PaidResult> {
      const quote = { x402Version: 2, scheme: "exact", network: "eip155:84532", amountAtomic: "10000", asset: TOKEN, payTo: TO, maxTimeoutSeconds: 60, raw: {} } as never;
      await hooks.beforeSign(quote);
      const s = { nonce, from: FROM, to: TO, value: "10000", validAfter: "0", validBefore: "9999999999" };
      await hooks.afterSign({ ...s, signature: "0x", payloadJson: "{}" });
      return { request: { url, method: "GET", headers: {}, params: {}, sentAt: Date.now() }, quote, signed: s, error: { kind: "timeout", message: "t" }, timing: { totalMs: 1 } };
    },
  });

  async function seedIndeterminate(nonce: Hex) {
    const db = openDb(":memory:");
    db.prepare("INSERT INTO sellers (id, domain, first_seen_at, last_seen_at) VALUES (1, 'x', 0, 0)").run();
    db.prepare("INSERT INTO resources (id, seller_id, url, source, raw_json, first_seen_at, last_seen_at) VALUES (1, 1, 'http://x/a', 'manual', '{}', 0, 0)").run();
    const o = await runPaidCall({
      db,
      payer: hangingPayer(nonce),
      source: "buy",
      resource: { id: 1, sellerId: 1, url: "http://x/a" },
      perCallCapAtomic: 1_000_000n,
      defaultMaxTimeoutSeconds: 30,
      settlementLookup: async () => [],
    });
    expect(o.classification.outcome).toBe("indeterminate");
    return { db, callId: o.callId };
  }

  it("resolves to non_delivery + resolved_late once the chain shows the settlement; leaves others pending", async () => {
    const { db, callId } = await seedIndeterminate(NONCE);
    const { client } = fakeClient([]);
    const lookup = makeChainSettlementLookup({ client, network: "eip155:84532", fromBlock: 0n });
    const r1 = await resolvePendingIndeterminate(db, { lookup, defaultMaxTimeoutSeconds: 30 });
    expect(r1.stillPending).toEqual([callId]);
    const { client: c2 } = fakeClient([{ tx: tx(9), logIndex: 1, block: 5n, from: FROM, to: TO, value: 10000n, authNonce: NONCE }]);
    const r2 = await resolvePendingIndeterminate(db, { lookup: makeChainSettlementLookup({ client: c2, network: "eip155:84532", fromBlock: 0n }), defaultMaxTimeoutSeconds: 30 });
    expect(r2.resolved).toEqual([{ callId, intentId: expect.any(String), outcome: "non_delivery", settlements: 1, windowClosed: false }]);
    const row = db.prepare("SELECT outcome, flags_json, settlement_tx_hash FROM calls WHERE id = ?").get(callId) as { outcome: string; flags_json: string; settlement_tx_hash: string };
    expect(row.outcome).toBe("non_delivery");
    expect(JSON.parse(row.flags_json)).toContain("resolved_late");
    expect(row.settlement_tx_hash).toBe(tx(9));
  });

  it("closes the window with an empty list -> not_paid", async () => {
    const { db, callId } = await seedIndeterminate(NONCE2);
    // Pretend the call happened 25 h ago (resolveIndeterminate measures elapsed time with the real clock).
    const past = Date.now() - 25 * 3600_000;
    db.prepare("UPDATE calls SET ts = ?, resolve_until = ? WHERE id = ?").run(past, past + 24 * 3600_000, callId);
    const r = await resolvePendingIndeterminate(db, { lookup: async () => [], defaultMaxTimeoutSeconds: 30 });
    expect(r.resolved).toEqual([{ callId, intentId: expect.any(String), outcome: "not_paid", settlements: 0, windowClosed: true }]);
  });
});
