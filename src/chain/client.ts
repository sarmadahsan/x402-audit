/**
 * Base RPC client, USDC addresses, the two event ABIs we read, and block-by-timestamp lookup.
 * Read-only: nothing here signs or sends a transaction.
 */
import { createPublicClient, http, parseAbiItem, toEventSelector, type Address, type Hex, type PublicClient } from "viem";
import { base, baseSepolia } from "viem/chains";
import { MAINNET, SEPOLIA, type Network } from "../config/index.js";

export const USDC_BY_NETWORK: Record<Network, Address> = {
  [MAINNET]: "0x833589fCD6eDb6E08f4c7C32D4f71b54bdA02913",
  [SEPOLIA]: "0x036CbD53842c5426634e7929541eC2318f3dCF7e",
};

export const TRANSFER_EVENT = parseAbiItem("event Transfer(address indexed from, address indexed to, uint256 value)");
export const AUTHORIZATION_USED_EVENT = parseAbiItem("event AuthorizationUsed(address indexed authorizer, bytes32 indexed nonce)");
/** 0xddf252ad…b3ef */
export const TRANSFER_TOPIC0: Hex = toEventSelector(TRANSFER_EVENT);
/** 0x98de5035…10a5 */
export const AUTHORIZATION_USED_TOPIC0: Hex = toEventSelector(AUTHORIZATION_USED_EVENT);

export const DEFAULT_RPC_TIMEOUT_MS = 30_000;

export function chainForNetwork(network: string) {
  if (network === MAINNET) return base;
  if (network === SEPOLIA) return baseSepolia;
  throw new Error(`unsupported network ${network} (expected ${MAINNET} or ${SEPOLIA})`);
}

export function usdcFor(network: string): Address {
  const a = (USDC_BY_NETWORK as Record<string, Address | undefined>)[network];
  if (!a) throw new Error(`no USDC address for network ${network}`);
  return a;
}

export function makeChainClient(opts: { rpcUrl: string; network: string; timeoutMs?: number }): PublicClient {
  return createPublicClient({
    chain: chainForNetwork(opts.network),
    transport: http(opts.rpcUrl, { retryCount: 3, retryDelay: 500, timeout: opts.timeoutMs ?? DEFAULT_RPC_TIMEOUT_MS }),
  }) as PublicClient;
}

/** The subset of a viem PublicClient this module uses; lets tests pass a fake. */
export interface BlockReader {
  getBlock(args: { blockNumber: bigint }): Promise<{ number: bigint | null; timestamp: bigint }>;
  getBlock(args?: { blockTag: "latest" }): Promise<{ number: bigint | null; timestamp: bigint }>;
  getBlockNumber(): Promise<bigint>;
}

const LATEST_TTL_MS = 10_000;
const latestCache = new WeakMap<object, { n: bigint; ts: bigint; at: number }>();
const BASE_BLOCK_SECONDS = 2n;
const MAX_CALLS = 25;

/**
 * First block with timestamp >= tsSeconds. If tsSeconds is past the latest block, returns the latest block.
 * Base produces a block every 2 s, so a linear estimate from the latest block is usually exact or off by one;
 * the search interpolates for a few steps, then bisects, and uses at most ~25 RPC calls.
 */
export async function blockAtTimestamp(client: Pick<BlockReader, "getBlock">, tsSeconds: number | bigint): Promise<bigint> {
  const target = BigInt(tsSeconds);
  let calls = 0;
  const tsOf = async (n: bigint): Promise<bigint> => {
    calls++;
    return (await client.getBlock({ blockNumber: n })).timestamp;
  };

  let latest = latestCache.get(client as object);
  if (!latest || Date.now() - latest.at > LATEST_TTL_MS) {
    calls++;
    const b = await (client.getBlock as (a?: { blockTag: "latest" }) => Promise<{ number: bigint | null; timestamp: bigint }>)({ blockTag: "latest" });
    if (b.number === null) throw new Error("latest block has no number");
    latest = { n: b.number, ts: b.timestamp, at: Date.now() };
    latestCache.set(client as object, latest);
  }
  if (target >= latest.ts) return latest.n;

  // Invariant: hi.ts >= target; lo (if known) has lo.ts < target.
  let hi = { n: latest.n, ts: latest.ts };
  let lo: { n: bigint; ts: bigint } | null = null;
  let step = 0;
  while (calls < MAX_CALLS) {
    if (lo && hi.n - lo.n <= 1n) return hi.n;
    if (!lo && hi.n === 0n) return 0n;
    let guess: bigint;
    if (!lo) {
      // Estimate from hi assuming 2 s blocks, aim one block low so we land on a lower bracket.
      const back = (hi.ts - target + BASE_BLOCK_SECONDS - 1n) / BASE_BLOCK_SECONDS + 1n + BigInt(step) * 8n;
      guess = hi.n - back < 0n ? 0n : hi.n - back;
    } else if (step < 4 && hi.ts > lo.ts) {
      guess = lo.n + ((target - lo.ts) * (hi.n - lo.n)) / (hi.ts - lo.ts);
      if (guess <= lo.n) guess = lo.n + 1n;
      if (guess >= hi.n) guess = hi.n - 1n;
    } else {
      guess = (lo.n + hi.n) / 2n;
    }
    step++;
    const ts = await tsOf(guess);
    if (ts >= target) hi = { n: guess, ts };
    else lo = { n: guess, ts };
  }
  if (lo && hi.n - lo.n <= 1n) return hi.n;
  throw new Error(`blockAtTimestamp(${target}) did not converge in ${MAX_CALLS} calls (lo=${lo?.n}, hi=${hi.n})`);
}
