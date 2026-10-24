import { describe, expect, it } from "vitest";
import { openDb } from "../db/index.js";
import { USDC_BY_NETWORK } from "./client.js";
import { isRateLimitError, isTooMuchError, scanPayToVolume, type LogClient } from "./volume.js";

const NET = "eip155:8453";
const A = "0x7284D41b5b852F2bd4c99bDf95043D84452d299C"; // checksummed on purpose
const B = "0xe9030014F5DAe217d0A152f02A043567b16c1aBf";
const P1 = "0x1111111111111111111111111111111111111111";
const P2 = "0x2222222222222222222222222222222222222222";
const P3 = "0x3333333333333333333333333333333333333333";
const SPAM = "0x75161f0000000000000000000000000000eb96";
const ts = (n: bigint) => 1_700_000_000n + 2n * n;

interface L {
  block: bigint;
  idx: number;
  from: string;
  to: string;
  value: bigint;
}
const DATA: L[] = [
  { block: 10_100n, idx: 0, from: P1, to: A, value: 5000n },
  { block: 10_200n, idx: 3, from: P2, to: A, value: 5000n },
  { block: 11_100n, idx: 1, from: P3, to: B, value: 1_000_000n },
  { block: 11_500n, idx: 7, from: SPAM, to: A, value: 20n }, // dust
  { block: 12_900n, idx: 2, from: P1, to: A, value: 10_000n },
  { block: 13_500n, idx: 0, from: P2, to: B, value: 3000n },
];

function fakeClient(opts: { tooManyOnce?: [bigint, bigint]; rateLimitOnceAtFrom?: bigint } = {}) {
  const calls: { from: bigint; to: bigint; addrs: string[] }[] = [];
  let tooManyArmed = !!opts.tooManyOnce;
  let rlArmed = opts.rateLimitOnceAtFrom !== undefined;
  let getBlockCalls = 0;
  const client: LogClient = {
    async getLogs(a: any) {
      expect(a.address).toBe(USDC_BY_NETWORK[NET]);
      expect(a.event.name).toBe("Transfer");
      const addrs = (a.args.to as string[]).map((x) => x.toLowerCase());
      calls.push({ from: a.fromBlock, to: a.toBlock, addrs });
      if (rlArmed && a.fromBlock === opts.rateLimitOnceAtFrom) {
        rlArmed = false;
        throw Object.assign(new Error("HTTP request failed.\n\nStatus: 429"), { status: 429 });
      }
      if (tooManyArmed && opts.tooManyOnce && a.fromBlock <= opts.tooManyOnce[0] && a.toBlock >= opts.tooManyOnce[1]) {
        tooManyArmed = false;
        throw Object.assign(new Error("RPC Request failed."), { details: "query returned more than 20000 results", code: -32005 });
      }
      return DATA.filter((l) => l.block >= a.fromBlock && l.block <= a.toBlock && addrs.includes(l.to.toLowerCase())).map((l) => ({
        transactionHash: `0x${l.block.toString(16).padStart(64, "0")}`,
        logIndex: l.idx,
        blockNumber: l.block,
        args: { from: l.from, to: l.to, value: l.value },
      }));
    },
    async getBlock({ blockNumber }: { blockNumber: bigint }) {
      getBlockCalls++;
      return { timestamp: ts(blockNumber) };
    },
  };
  return { client, calls, getBlockCalls: () => getBlockCalls };
}

const quiet = { info: () => {}, warn: () => {}, debug: () => {} };

describe("scanPayToVolume", () => {
  it("scans windows, halves on too-many, backs off on 429, inserts, aggregates, resumes", async () => {
    const db = openDb(":memory:");
    const sleeps: number[] = [];
    const f = fakeClient({ tooManyOnce: [11_000n, 11_999n], rateLimitOnceAtFrom: 12_000n });
    const progress: number[] = [];
    const base = { client: f.client, network: NET, payTos: [A, B], fromBlock: 10_000n, toBlock: 12_999n, maxBlockSpan: 1000, minBlockSpan: 100, log: quiet, backoffMs: [1, 2, 3], sleep: async (ms: number) => void sleeps.push(ms) };
    const s1 = await scanPayToVolume(db, { ...base, onProgress: (p) => progress.push(p.window) });

    // w1 10000-10999; w2 11000-11999 fails once and is split in two halves; span then shrinks to 500,
    // so the last 1000 blocks take two windows, the first of which hits a 429 once.
    expect(f.calls.map((c) => `${c.from}-${c.to}`)).toEqual([
      "10000-10999",
      "11000-11999",
      "11000-11499",
      "11500-11999",
      "12000-12499",
      "12000-12499",
      "12500-12999",
    ]);
    expect(f.calls.every((c) => c.addrs.length === 2 && c.addrs.every((a) => a === a.toLowerCase()))).toBe(true);
    expect(sleeps).toEqual([1]);
    expect(s1.windows).toBe(4);
    expect(progress).toEqual([1, 2, 3, 4]);
    expect(s1.errorsRetried).toBe(2);
    expect(s1.logsFetched).toBe(5);
    expect(s1.inserted).toBe(5);
    expect(s1.payTosScanned).toBe(2);
    expect(s1.rpcCalls).toBe(f.calls.length + f.getBlockCalls());

    const rows = db.prepare("SELECT * FROM chain_transfers ORDER BY block_number").all() as any[];
    expect(rows).toHaveLength(5);
    expect(rows.every((r) => r.to_addr === r.to_addr.toLowerCase() && r.from_addr === r.from_addr.toLowerCase())).toBe(true);
    expect(rows[0].block_ts).toBe(Number(ts(10_100n)) * 1000); // interpolation is exact for uniform 2 s blocks
    expect(rows[0].via_authorization).toBeNull();

    const vol = (addr: string) => db.prepare("SELECT * FROM payto_volume WHERE network = ? AND pay_to = ? AND from_block = 10000 AND to_block = 12999").get(NET, addr.toLowerCase()) as any;
    expect(vol(A)).toMatchObject({ transfer_count: 3, sum_atomic: "20000", dust_count: 1, unique_payers: 2, dust_floor_atomic: "100", from_ts: Number(ts(10_000n)) * 1000, to_ts: Number(ts(12_999n)) * 1000 });
    expect(vol(B)).toMatchObject({ transfer_count: 1, sum_atomic: "1000000", dust_count: 0, unique_payers: 1 });
    expect(db.prepare("SELECT to_addr, from_block, to_block FROM chain_scan_progress ORDER BY to_addr").all()).toEqual([
      { to_addr: A.toLowerCase(), from_block: 10_000, to_block: 12_999 },
      { to_addr: B.toLowerCase(), from_block: 10_000, to_block: 12_999 },
    ]);

    // Re-run the same range: fully covered, no getLogs.
    const before = f.calls.length;
    const s2 = await scanPayToVolume(db, base);
    expect(f.calls.length).toBe(before);
    expect(s2.inserted).toBe(0);
    expect(vol(A).sum_atomic).toBe("20000");

    // Extend the range: only the new 1000 blocks are fetched.
    const s3 = await scanPayToVolume(db, { ...base, toBlock: 13_999n });
    expect(f.calls.slice(before).map((c) => `${c.from}-${c.to}`)).toEqual(["13000-13999"]);
    expect(s3.inserted).toBe(1);
    const volB = db.prepare("SELECT * FROM payto_volume WHERE pay_to = ? AND to_block = 13999").get(B.toLowerCase()) as any;
    expect(volB).toMatchObject({ transfer_count: 2, sum_atomic: "1003000", unique_payers: 2 });

    // Forget progress: logs are refetched but INSERT OR IGNORE keeps rows unique.
    db.prepare("DELETE FROM chain_scan_progress").run();
    const s4 = await scanPayToVolume(db, { ...base, toBlock: 13_999n });
    expect(s4.logsFetched).toBe(6);
    expect(s4.inserted).toBe(0);
    expect((db.prepare("SELECT COUNT(*) AS n FROM chain_transfers").get() as any).n).toBe(6);
  });

  it("splits the address batch when the minimum span still returns too much, and batches addresses", async () => {
    const db = openDb(":memory:");
    const f = fakeClient();
    let fail = 1;
    const inner = f.client.getLogs.bind(f.client);
    f.client.getLogs = async (a: any) => {
      if (fail > 0 && a.args.to.length === 2) {
        fail = a.toBlock - a.fromBlock + 1n <= 100n ? fail - 1 : fail;
        throw new Error("query exceeds max results 20000, retry with the range 10000-10099");
      }
      return inner(a);
    };
    const s = await scanPayToVolume(db, { client: f.client, network: NET, payTos: [A, B, A.toLowerCase()], fromBlock: 10_000n, toBlock: 10_199n, maxBlockSpan: 200, minBlockSpan: 100, maxAddressesPerQuery: 2, log: quiet, sleep: async () => {} });
    expect(s.payTosScanned).toBe(2);
    expect(s.inserted).toBe(1);
    expect(f.calls.some((c) => c.addrs.length === 1)).toBe(true);
  });

  it("splits at publicnode's suggested retry range", async () => {
    const db = openDb(":memory:");
    const f = fakeClient();
    let fail = true;
    const inner = f.client.getLogs.bind(f.client);
    f.client.getLogs = async (a: any) => {
      if (fail) {
        fail = false;
        f.calls.push({ from: a.fromBlock, to: a.toBlock, addrs: [] });
        throw Object.assign(new Error("RPC Request failed."), { details: "query exceeds max results 20000, retry with the range 10000-10299", code: -32602 });
      }
      return inner(a);
    };
    await scanPayToVolume(db, { client: f.client, network: NET, payTos: [A], fromBlock: 10_000n, toBlock: 10_999n, maxBlockSpan: 1000, log: quiet, sleep: async () => {} });
    expect(f.calls.map((c) => `${c.from}-${c.to}`)).toEqual(["10000-10999", "10000-10299", "10300-10999"]);
  });

  it("classifies real RPC error strings", () => {
    expect(isTooMuchError(new Error("exceed maximum block range: 50000"))).toBe(true);
    expect(isTooMuchError({ details: "query exceeds max results 20000, retry with the range 1-2" })).toBe(true);
    expect(isRateLimitError({ message: "x", details: "query exceeds max results 20000, retry with the range 34291234-34294290" })).toBe(false);
    expect(isRateLimitError({ message: "request limit reached", code: -32011 })).toBe(true);
    expect(isRateLimitError({ message: "HTTP request failed.", status: 429 })).toBe(true);
  });
});
