import { describe, expect, it } from "vitest";
import { AUTHORIZATION_USED_TOPIC0, TRANSFER_TOPIC0, USDC_BY_NETWORK, blockAtTimestamp, chainForNetwork } from "./client.js";

describe("chain client constants", () => {
  it("event topic0 hashes match protocol-notes", () => {
    expect(TRANSFER_TOPIC0).toBe("0xddf252ad1be2c89b69c2b068fc378daa952ba7f163c4a11628f55a4df523b3ef");
    expect(AUTHORIZATION_USED_TOPIC0.startsWith("0x98de5035")).toBe(true);
    expect(AUTHORIZATION_USED_TOPIC0).toBe("0x98de503528ee59b575ef0c0a2576a82497bfc029a5685b209e9ec333479b10a5");
  });
  it("USDC addresses and chains", () => {
    expect(USDC_BY_NETWORK["eip155:8453"]).toBe("0x833589fCD6eDb6E08f4c7C32D4f71b54bdA02913");
    expect(USDC_BY_NETWORK["eip155:84532"]).toBe("0x036CbD53842c5426634e7929541eC2318f3dCF7e");
    expect(chainForNetwork("eip155:8453").id).toBe(8453);
    expect(chainForNetwork("eip155:84532").id).toBe(84532);
  });
});

describe("blockAtTimestamp", () => {
  // Block n has timestamp GENESIS + 2n, except a 7 s gap after block 500_000 to make it non-uniform.
  const GENESIS = 1_686_789_347n;
  const tsOf = (n: bigint) => GENESIS + 2n * n + (n > 500_000n ? 7n : 0n);
  const LATEST = 37_000_000n;
  const mk = () => {
    let calls = 0;
    const client = {
      getBlock: async (a?: { blockNumber?: bigint; blockTag?: string }) => {
        calls++;
        const n = a?.blockNumber ?? LATEST;
        return { number: n, timestamp: tsOf(n) };
      },
      calls: () => calls,
    };
    return client;
  };
  const brute = (t: bigint) => {
    // first n with tsOf(n) >= t
    let lo = 0n,
      hi = LATEST;
    while (lo < hi) {
      const m = (lo + hi) / 2n;
      if (tsOf(m) >= t) hi = m;
      else lo = m + 1n;
    }
    return lo;
  };
  it("finds the first block at or after a timestamp within 25 calls", async () => {
    for (const t of [tsOf(36_000_000n), tsOf(36_000_000n) - 1n, tsOf(500_001n) - 3n, GENESIS + 5n, tsOf(LATEST) - 2_592_000n]) {
      const c = mk();
      expect(await blockAtTimestamp(c, t)).toBe(brute(t));
      expect(c.calls()).toBeLessThanOrEqual(25);
    }
  });
  it("returns latest for a future timestamp", async () => {
    expect(await blockAtTimestamp(mk(), tsOf(LATEST) + 100n)).toBe(LATEST);
  });
});
