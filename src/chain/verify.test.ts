import { describe, expect, it } from "vitest";
import { openDb, type Db } from "../db/index.js";
import { AUTHORIZATION_USED_TOPIC0, TRANSFER_TOPIC0, USDC_BY_NETWORK } from "./client.js";
import { computePayToVolumes } from "./volume.js";
import {
  classifyTxRows,
  eip3009ShareMetaKey,
  sampleWithoutReplacement,
  verifyAll,
  verifySample,
  verifyTransfers,
  type ReceiptClient,
  type ReceiptLog,
} from "./verify.js";

const NET = "eip155:8453";
const USDC = USDC_BY_NETWORK[NET];
const PAYTO = "0xaaaa00000000000000000000000000000000aaaa";
const P = "0x1111111111111111111111111111111111111111";
const Q = "0x2222222222222222222222222222222222222222";
const R = "0x3333333333333333333333333333333333333333";
const pad = (a: string) => `0x${a.slice(2).padStart(64, "0")}`;
const nonceHex = (n: number) => `0x${n.toString(16).padStart(64, "0")}`;
const tx = (n: number) => `0x${n.toString(16).padStart(64, "0")}`;
const silent = { info: () => {}, warn: () => {}, debug: () => {} };

function authLog(authorizer: string, nonce: string, logIndex = 0, address: string = USDC): ReceiptLog {
  return { address, topics: [AUTHORIZATION_USED_TOPIC0, pad(authorizer), nonce], logIndex };
}
function transferLog(from: string, to: string, logIndex = 1): ReceiptLog {
  return { address: USDC, topics: [TRANSFER_TOPIC0, pad(from), pad(to)], logIndex };
}

function insert(db: Db, r: { tx: string; idx?: number; block: number; from: string; to?: string; value: string; via?: number | null }) {
  db.prepare(
    "INSERT INTO chain_transfers (network, tx_hash, log_index, block_number, block_ts, from_addr, to_addr, value_atomic, via_authorization) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)",
  ).run(NET, r.tx, r.idx ?? 1, r.block, r.block * 2000, r.from, r.to ?? PAYTO, r.value, r.via ?? null);
}
const rowsOf = (db: Db, h: string) =>
  db.prepare("SELECT from_addr, via_authorization AS via, nonce FROM chain_transfers WHERE tx_hash = ? ORDER BY log_index").all(h) as {
    from_addr: string;
    via: number | null;
    nonce: string | null;
  }[];

function fakeClient(receipts: Map<string, ReceiptLog[]>, opts: { rateLimitOnce?: Set<string>; fail?: Set<string> } = {}) {
  const calls: string[] = [];
  const limited = new Set(opts.rateLimitOnce ?? []);
  const client: ReceiptClient = {
    async getTransactionReceipt({ hash }) {
      calls.push(hash);
      if (limited.has(hash)) {
        limited.delete(hash);
        throw Object.assign(new Error("HTTP request failed. Status: 429"), { status: 429 });
      }
      if (opts.fail?.has(hash)) throw new Error("boom");
      return { logs: receipts.get(hash) ?? [] };
    },
  };
  return { client, calls };
}

describe("classifyTxRows", () => {
  it("marks only rows from an authorizer and pairs multiple nonces in log order", () => {
    const logs = [authLog(P, nonceHex(1), 0), transferLog(P, PAYTO, 1), authLog(P, nonceHex(2), 2), transferLog(P, PAYTO, 3), authLog(Q, nonceHex(9), 4, "0x000000000000000000000000000000000000dead")];
    const out = classifyTxRows(logs, USDC, [
      { id: 2, from_addr: P, log_index: 3 },
      { id: 1, from_addr: P, log_index: 1 },
      { id: 3, from_addr: Q, log_index: 5 },
    ]);
    expect(out).toEqual([
      { id: 1, via: 1, nonce: nonceHex(1) },
      { id: 2, via: 1, nonce: nonceHex(2) },
      { id: 3, via: 0, nonce: null }, // Q's AuthorizationUsed came from a non-USDC contract
    ]);
  });
});

describe("verifyTransfers", () => {
  it("sets via_authorization/nonce per row, retries a 429 once, counts errors", async () => {
    const db = openDb(":memory:");
    insert(db, { tx: tx(1), idx: 1, block: 10, from: P, value: "10000" });
    insert(db, { tx: tx(1), idx: 2, block: 10, from: Q, value: "20" }); // other row in the same tx
    insert(db, { tx: tx(2), block: 11, from: Q, value: "10000" }); // plain transfer
    insert(db, { tx: tx(3), block: 12, from: R, value: "10000" }); // 429 once, then authorized
    insert(db, { tx: tx(4), block: 13, from: R, value: "10000" }); // AuthorizationUsed from someone else
    insert(db, { tx: tx(5), block: 14, from: R, value: "10000" }); // receipt keeps failing
    const receipts = new Map<string, ReceiptLog[]>([
      [tx(1), [authLog(P, nonceHex(7), 0), transferLog(P, PAYTO, 1), transferLog(Q, PAYTO, 2)]],
      [tx(2), [transferLog(Q, PAYTO, 0)]],
      [tx(3), [authLog(R, nonceHex(8), 0), transferLog(R, PAYTO, 1)]],
      [tx(4), [authLog(P, nonceHex(9), 0), transferLog(R, PAYTO, 1)]],
    ]);
    const { client, calls } = fakeClient(receipts, { rateLimitOnce: new Set([tx(3)]), fail: new Set([tx(5)]) });
    const slept: number[] = [];
    const st = await verifyTransfers(db, {
      client,
      network: NET,
      txHashes: [tx(1), tx(2), tx(3), tx(4), tx(5), tx(1)],
      concurrency: 2,
      log: silent,
      backoffMs: [5, 10, 20],
      sleep: async (ms) => void slept.push(ms),
    });
    expect(st).toMatchObject({ checked: 4, viaAuthorization: 2, plain: 3, errors: 1, retries: 1 });
    expect(slept).toEqual([5]);
    expect(calls.filter((c) => c === tx(3))).toHaveLength(2);
    expect(rowsOf(db, tx(1))).toEqual([
      { from_addr: P, via: 1, nonce: nonceHex(7) },
      { from_addr: Q, via: 0, nonce: null },
    ]);
    expect(rowsOf(db, tx(2))[0]).toMatchObject({ via: 0 });
    expect(rowsOf(db, tx(3))[0]).toMatchObject({ via: 1, nonce: nonceHex(8) });
    expect(rowsOf(db, tx(4))[0]).toMatchObject({ via: 0 });
    expect(rowsOf(db, tx(5))[0]).toMatchObject({ via: null });
  });

  it("gives up after the retry budget on persistent rate limiting", async () => {
    const db = openDb(":memory:");
    insert(db, { tx: tx(1), block: 1, from: P, value: "10000" });
    const client: ReceiptClient = {
      async getTransactionReceipt() {
        throw new Error("too many requests");
      },
    };
    const st = await verifyTransfers(db, { client, network: NET, txHashes: [tx(1)], log: silent, backoffMs: [1, 1, 1], sleep: async () => {} });
    expect(st).toMatchObject({ checked: 0, errors: 1, retries: 3, rpcCalls: 4 });
  });
});

function seedSampleDb(): Db {
  const db = openDb(":memory:");
  for (let i = 1; i <= 30; i++) insert(db, { tx: tx(i), block: 100 + i, from: P, value: "10000" });
  insert(db, { tx: tx(31), block: 140, from: Q, value: "20" }); // dust: never sampled
  insert(db, { tx: tx(32), block: 141, from: Q, value: "10000", via: 1 }); // already verified: never sampled
  insert(db, { tx: tx(33), block: 9_999, from: Q, value: "10000" }); // outside the window
  computePayToVolumes(db, { network: NET, payTos: [PAYTO], fromBlock: 100n, toBlock: 200n, fromTsMs: 200_000n, toTsMs: 400_000n, dustFloorAtomic: 100n });
  return db;
}
/** Even tx numbers are EIP-3009. */
const evenReceipts = () => {
  const m = new Map<string, ReceiptLog[]>();
  for (let i = 1; i <= 33; i++) m.set(tx(i), i % 2 === 0 ? [authLog(i === 32 ? Q : P, nonceHex(i), 0), transferLog(P, PAYTO, 1)] : [transferLog(P, PAYTO, 0)]);
  return m;
};

describe("verifySample", () => {
  it("samples perPayTo unverified non-dust txs in the window, stores the share in meta", async () => {
    const db = seedSampleDb();
    const { client, calls } = fakeClient(evenReceipts(), { rateLimitOnce: new Set([tx(2), tx(3), tx(4)]) });
    const out = await verifySample(db, { client, network: NET, payTos: [PAYTO.toUpperCase().replace("0X", "0x")], perPayTo: 10, seed: 42, log: silent, sleep: async () => {} });
    expect(out).toHaveLength(1);
    const s = out[0]!;
    expect(s.payTo).toBe(PAYTO);
    expect(s.sampled).toBe(10);
    expect(s.population).toBe(30);
    const sampledTx = [...new Set(calls)];
    expect(sampledTx).toHaveLength(10);
    for (const h of sampledTx) expect(Number(BigInt(h))).toBeLessThanOrEqual(30);
    const expectedVia = sampledTx.filter((h) => Number(BigInt(h)) % 2 === 0).length;
    expect(s.viaAuthorization).toBe(expectedVia);
    expect(s.share).toBeCloseTo(expectedVia / 10, 10);
    expect(s.lo).toBeLessThanOrEqual(s.share);
    expect(s.hi).toBeGreaterThanOrEqual(s.share);
    const meta = db.prepare("SELECT value FROM meta WHERE key = ?").get(eip3009ShareMetaKey(NET, PAYTO)) as { value: string };
    expect(JSON.parse(meta.value)).toMatchObject({ payTo: PAYTO, sampled: 10, viaAuthorization: expectedVia, seed: 42, perPayTo: 10, fromBlock: 100, toBlock: 200 });

    // same seed on a fresh db: same sample
    const db2 = seedSampleDb();
    const f2 = fakeClient(evenReceipts());
    await verifySample(db2, { client: f2.client, network: NET, payTos: [PAYTO], perPayTo: 10, seed: 42, log: silent });
    expect([...new Set(f2.calls)].sort()).toEqual(sampledTx.sort());
  });

  it("is a seeded uniform draw without replacement", () => {
    const items = Array.from({ length: 50 }, (_, i) => i);
    const a = sampleWithoutReplacement(items, 10, 7);
    expect(new Set(a).size).toBe(10);
    expect(sampleWithoutReplacement(items, 10, 7)).toEqual(a);
    expect(sampleWithoutReplacement(items, 10, 8)).not.toEqual(a);
    expect(sampleWithoutReplacement(items, 99, 7)).toEqual(items);
  });
});

describe("verifyAll", () => {
  it("verifies every unverified non-dust tx in the window", async () => {
    const db = seedSampleDb();
    const { client, calls } = fakeClient(evenReceipts());
    const st = await verifyAll(db, { client, network: NET, payTos: [PAYTO], log: silent });
    expect(st).toMatchObject({ payTos: 1, txs: 30, checked: 30, viaAuthorization: 15, plain: 15, errors: 0 });
    expect(calls).not.toContain(tx(31));
    expect(calls).not.toContain(tx(32));
    expect(calls).not.toContain(tx(33));
    const left = db.prepare("SELECT COUNT(*) AS n FROM chain_transfers WHERE via_authorization IS NULL").get() as { n: number };
    expect(left.n).toBe(2); // dust + out-of-window
  });
});
