/**
 * Local anvil chain + TestUSDC deployment for integration tests. Nothing here touches a public network.
 *
 * The chain runs with chain id 84532 (Base Sepolia) so the official x402 client signs EIP-712 for the
 * same chain id it would on Base Sepolia, and the TestUSDC domain ("USDC", "2") matches Base Sepolia USDC.
 */
import { spawn, type ChildProcess } from "node:child_process";
import { existsSync, readFileSync } from "node:fs";
import { createServer, type AddressInfo } from "node:net";
import {
  createPublicClient,
  createWalletClient,
  defineChain,
  getAddress,
  http,
  type Abi,
  type Address,
  type Chain,
  type Hex,
} from "viem";
import { privateKeyToAccount } from "viem/accounts";

export const ANVIL_BIN = process.env["ANVIL_BIN"] ?? "/opt/homebrew/bin/anvil";

/**
 * Anvil's default dev keys, derived from the public mnemonic
 * "test test test test test test test test test test test junk" (m/44'/60'/0'/0/i).
 * These are PUBLIC TEST KEYS printed by every anvil/hardhat install. They must NEVER hold real funds
 * and must never be used on any public network.
 */
export const ANVIL_DEFAULT_KEYS: readonly Hex[] = [
  "0xac0974bec39a17e36ba4a6b4d238ff944bacb478cbed5efcae784d7bf4f2ff80",
  "0x59c6995e998f97a5a0044966f0945389dc9e86dae88c7a8412f4603b6b78690d",
  "0x5de4111afa1a4b94908f83103eb1f1706367c2e68ca870fc3fb9a804cdab365a",
  "0x7c852118294e51e653712a81e05800f419141751be58f605c371e15141b007a6",
  "0x47e179ec197488593b187f80a00eb0da91f1b9d0b13f8733639f19c30a34926a",
];

export interface AnvilAccount {
  address: Address;
  privateKey: Hex;
}

export interface Anvil {
  rpcUrl: string;
  port: number;
  chainId: number;
  chain: Chain;
  accounts: AnvilAccount[];
  close(): Promise<void>;
}

export interface StartAnvilOptions {
  chainId?: number;
  /** 0 = pick a free port. */
  port?: number;
  /**
   * Seconds the chain clock runs behind wall-clock time (default 60). The mock seller's /fail/slow
   * declares maxTimeoutSeconds 1, so the client signs validBefore = now + 1; a chain clock that is
   * slightly behind keeps that authorization valid for the settle transaction (the off-chain mock
   * facilitator is equally lenient). Set 0 to run the chain at wall-clock time.
   */
  clockLagSeconds?: number;
  startTimeoutMs?: number;
}

export function anvilAvailable(): boolean {
  return existsSync(ANVIL_BIN);
}

async function freePort(): Promise<number> {
  return new Promise((resolve, reject) => {
    const s = createServer();
    s.once("error", reject);
    s.listen(0, "127.0.0.1", () => {
      const p = (s.address() as AddressInfo).port;
      s.close(() => resolve(p));
    });
  });
}

export function anvilChain(chainId: number, rpcUrl: string): Chain {
  return defineChain({
    id: chainId,
    name: `anvil-${chainId}`,
    nativeCurrency: { name: "Ether", symbol: "ETH", decimals: 18 },
    rpcUrls: { default: { http: [rpcUrl] } },
  });
}

export async function startAnvil(opts: StartAnvilOptions = {}): Promise<Anvil> {
  if (!anvilAvailable()) throw new Error(`anvil not found at ${ANVIL_BIN}`);
  const chainId = opts.chainId ?? 84532;
  const port = opts.port && opts.port > 0 ? opts.port : await freePort();
  const lag = opts.clockLagSeconds ?? 60;
  const args = ["--chain-id", String(chainId), "--port", String(port), "--host", "127.0.0.1", "--silent"];
  if (lag > 0) args.push("--timestamp", String(Math.floor(Date.now() / 1000) - lag));
  const child: ChildProcess = spawn(ANVIL_BIN, args, { stdio: ["ignore", "ignore", "pipe"] });
  let stderr = "";
  child.stderr?.on("data", (d: Buffer) => (stderr += d.toString()));
  let exited = false;
  child.once("exit", () => (exited = true));

  const rpcUrl = `http://127.0.0.1:${port}`;
  const deadline = Date.now() + (opts.startTimeoutMs ?? 15_000);
  for (;;) {
    if (exited) throw new Error(`anvil exited during startup: ${stderr.trim()}`);
    try {
      const r = await fetch(rpcUrl, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ jsonrpc: "2.0", id: 1, method: "eth_chainId", params: [] }),
      });
      const j = (await r.json()) as { result?: string };
      if (j.result && Number(j.result) === chainId) break;
    } catch {
      /* not up yet */
    }
    if (Date.now() > deadline) {
      child.kill("SIGKILL");
      throw new Error(`anvil did not answer on ${rpcUrl} within timeout: ${stderr.trim()}`);
    }
    await new Promise((r) => setTimeout(r, 100));
  }

  const accounts = ANVIL_DEFAULT_KEYS.map((k) => ({ privateKey: k, address: privateKeyToAccount(k).address }));
  return {
    rpcUrl,
    port,
    chainId,
    chain: anvilChain(chainId, rpcUrl),
    accounts,
    close: () =>
      new Promise<void>((resolve) => {
        if (exited) return resolve();
        child.once("exit", () => resolve());
        child.kill("SIGTERM");
        setTimeout(() => {
          if (!exited) child.kill("SIGKILL");
        }, 2_000).unref();
      }),
  };
}

export interface TestUsdcArtifact {
  contractName: string;
  abi: Abi;
  bytecode: Hex;
  compiler: Record<string, unknown>;
  sourceSha256: string;
}

let artifactCache: TestUsdcArtifact | undefined;
/** The committed compile output (tools/mock-seller/contracts/TestUSDC.json); no compiler needed. */
export function testUsdcArtifact(): TestUsdcArtifact {
  artifactCache ??= JSON.parse(readFileSync(new URL("./contracts/TestUSDC.json", import.meta.url), "utf8")) as TestUsdcArtifact;
  return artifactCache;
}

export interface TestUsdc {
  address: Address;
  mint(to: string, amountAtomic: bigint): Promise<Hex>;
  balanceOf(who: string): Promise<bigint>;
}

async function chainIdOf(rpcUrl: string): Promise<number> {
  const pc = createPublicClient({ transport: http(rpcUrl) });
  return pc.getChainId();
}

/** Deploys TestUSDC from `deployerKey` (which becomes the mint owner). */
export async function deployTestUsdc(rpcUrl: string, deployerKey: Hex): Promise<TestUsdc> {
  const art = testUsdcArtifact();
  const chain = anvilChain(await chainIdOf(rpcUrl), rpcUrl);
  const account = privateKeyToAccount(deployerKey);
  const wallet = createWalletClient({ account, chain, transport: http(rpcUrl) });
  const pub = createPublicClient({ chain, transport: http(rpcUrl) });
  const hash = await wallet.deployContract({ abi: art.abi, bytecode: art.bytecode, args: [] });
  const receipt = await pub.waitForTransactionReceipt({ hash, pollingInterval: 50 });
  if (receipt.status !== "success" || !receipt.contractAddress) throw new Error(`TestUSDC deploy failed (${hash})`);
  const address = getAddress(receipt.contractAddress);
  return {
    address,
    async mint(to, amountAtomic) {
      const h = await wallet.writeContract({ address, abi: art.abi, functionName: "mint", args: [getAddress(to), amountAtomic] });
      const r = await pub.waitForTransactionReceipt({ hash: h, pollingInterval: 50 });
      if (r.status !== "success") throw new Error(`mint reverted (${h})`);
      return h;
    },
    async balanceOf(who) {
      return (await pub.readContract({ address, abi: art.abi, functionName: "balanceOf", args: [getAddress(who)] })) as bigint;
    },
  };
}
