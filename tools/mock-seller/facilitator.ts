/**
 * x402 v2 facilitator for the mock seller. It verifies exact/EVM/EIP-3009 payloads off-chain
 * (viem verifyTypedData). Two modes:
 *
 * - in-memory (default): "settles" by recording the authorization in memory. No chain, no
 *   balances: any valid signature is treated as funded.
 * - chain (`chain: { rpcUrl, tokenAddress, facilitatorPrivateKey }`): settle() submits
 *   `transferWithAuthorization` to the token from the facilitator account (local anvil +
 *   TestUSDC, see anvil.ts) and returns the real tx hash. Reused nonces surface as
 *   `invalid_exact_evm_nonce_already_used`, as with the SDK facilitator.
 *
 * Shapes follow docs/protocol-notes.md §5 (EIP-712 types/domain, verify checks) and §6
 * (VerifyRequest / VerifyResponse / SettleResponse / SupportedResponse).
 */
import type { Hono } from "hono";
import type {
  Network,
  PaymentPayload,
  PaymentRequirements,
  SettleResponse,
  SupportedResponse,
  VerifyResponse,
} from "@x402/core/types";
import {
  createPublicClient,
  createWalletClient,
  defineChain,
  encodePacked,
  getAddress,
  http,
  isAddress,
  isHex,
  keccak256,
  parseAbi,
  parseSignature,
  verifyTypedData,
  type Hex,
  type PublicClient,
} from "viem";
import { nonceManager, privateKeyToAccount } from "viem/accounts";

/** EIP-712 types for EIP-3009 TransferWithAuthorization (protocol-notes §5). */
export const authorizationTypes = {
  TransferWithAuthorization: [
    { name: "from", type: "address" },
    { name: "to", type: "address" },
    { name: "value", type: "uint256" },
    { name: "validAfter", type: "uint256" },
    { name: "validBefore", type: "uint256" },
    { name: "nonce", type: "bytes32" },
  ],
} as const;

/** Fake facilitator signer address published in /supported. Not a real key. */
export const MOCK_FACILITATOR_SIGNER = "0x000000000000000000000000000000000000FaC1";

export interface Settlement {
  nonce: `0x${string}`;
  from: `0x${string}`;
  to: `0x${string}`;
  value: string;
  txHash: `0x${string}`;
  settledAt: string;
  network: string;
  asset: string;
  /** Resource path that triggered the settlement, if settled via the seller (not /facilitator/settle). */
  route?: string;
}

export interface ExactAuthorization {
  from: `0x${string}`;
  to: `0x${string}`;
  value: string;
  validAfter: string;
  validBefore: string;
  nonce: `0x${string}`;
}

export interface SettleOptions {
  /** Settle the same authorization twice (double-settle fault). */
  duplicate?: boolean;
  /** Recorded on the Settlement for debugging. */
  route?: string;
}

/** Chain mode: settle on a real (local) chain through the token's EIP-3009 entry point. */
export interface ChainFacilitatorOptions {
  rpcUrl: string;
  /** EIP-3009 token (TestUSDC on anvil). Requirements with another asset are rejected. */
  tokenAddress: string;
  /** Account that submits (and pays gas for) transferWithAuthorization. Anvil test keys only. */
  facilitatorPrivateKey: Hex;
}

export interface MockFacilitatorOptions {
  network: Network;
  now?: () => number;
  chain?: ChainFacilitatorOptions;
}

/** The subset of the token ABI the chain-mode facilitator calls. */
export const EIP3009_ABI = parseAbi([
  "function transferWithAuthorization(address from, address to, uint256 value, uint256 validAfter, uint256 validBefore, bytes32 nonce, uint8 v, bytes32 r, bytes32 s)",
  "function authorizationState(address authorizer, bytes32 nonce) view returns (bool)",
]);

/** Maps a FiatTokenV2-style revert message to the SDK's error code. */
export function settleErrorFromRevert(message: string): string {
  if (/authorization is used or canceled/i.test(message)) return "invalid_exact_evm_nonce_already_used";
  if (/authorization is expired/i.test(message)) return "invalid_exact_evm_payload_authorization_valid_before";
  if (/authorization is not yet valid/i.test(message)) return "invalid_exact_evm_payload_authorization_valid_after";
  if (/exceeds balance/i.test(message)) return "insufficient_funds";
  if (/invalid signature/i.test(message)) return "invalid_exact_evm_signature";
  return "unexpected_settle_error";
}

export interface MockFacilitator {
  /** "memory" (default) or "chain". */
  mode: "memory" | "chain";
  verify(payload: PaymentPayload, requirements: PaymentRequirements, opts?: { allowUsedNonce?: boolean }): Promise<VerifyResponse>;
  settle(payload: PaymentPayload, requirements: PaymentRequirements, opts?: SettleOptions): Promise<SettleResponse>;
  supported(): SupportedResponse;
  settlements(): Settlement[];
  reset(): void;
}

function parseChainId(network: string): number | undefined {
  const m = /^eip155:(\d+)$/.exec(network);
  return m ? Number(m[1]) : undefined;
}

function isUintString(v: unknown): v is string {
  return typeof v === "string" && /^\d+$/.test(v);
}

/** Extracts the EIP-3009 authorization from a v2 payload, or undefined if malformed. */
export function extractAuthorization(payload: PaymentPayload): { authorization: ExactAuthorization; signature: `0x${string}` } | undefined {
  const inner = payload.payload as { authorization?: Record<string, unknown>; signature?: unknown } | undefined;
  const a = inner?.authorization;
  const sig = inner?.signature;
  if (!a || typeof sig !== "string" || !isHex(sig)) return undefined;
  if (typeof a.from !== "string" || !isAddress(a.from)) return undefined;
  if (typeof a.to !== "string" || !isAddress(a.to)) return undefined;
  if (!isUintString(a.value) || !isUintString(a.validAfter) || !isUintString(a.validBefore)) return undefined;
  if (typeof a.nonce !== "string" || !isHex(a.nonce) || a.nonce.length !== 66) return undefined;
  return {
    authorization: {
      from: a.from as `0x${string}`,
      to: a.to as `0x${string}`,
      value: a.value,
      validAfter: a.validAfter,
      validBefore: a.validBefore,
      nonce: a.nonce as `0x${string}`,
    },
    signature: sig as `0x${string}`,
  };
}

export function createMockFacilitator(opts: MockFacilitatorOptions): MockFacilitator {
  const nowSec = () => Math.floor((opts.now ? opts.now() : Date.now()) / 1000);
  let records: Settlement[] = [];
  let counter = 0n;
  const usedNonces = new Set<string>();

  // ---- chain mode ----
  const chainCfg = opts.chain;
  const chainId = parseChainId(opts.network);
  let pub: PublicClient | undefined;
  let submit: ((a: ExactAuthorization, signature: Hex) => Promise<Hex>) | undefined;
  let token: `0x${string}` | undefined;
  if (chainCfg) {
    if (chainId === undefined) throw new Error(`chain mode needs an eip155 network, got ${opts.network}`);
    token = getAddress(chainCfg.tokenAddress);
    const chain = defineChain({
      id: chainId,
      name: `mock-${chainId}`,
      nativeCurrency: { name: "Ether", symbol: "ETH", decimals: 18 },
      rpcUrls: { default: { http: [chainCfg.rpcUrl] } },
    });
    const account = privateKeyToAccount(chainCfg.facilitatorPrivateKey, { nonceManager });
    pub = createPublicClient({ chain, transport: http(chainCfg.rpcUrl) }) as PublicClient;
    const wallet = createWalletClient({ account, chain, transport: http(chainCfg.rpcUrl) });
    // Serialise submissions so the facilitator's own tx nonces never race.
    let queue: Promise<unknown> = Promise.resolve();
    submit = (a, signature) => {
      const run = async (): Promise<Hex> => {
        const sig = parseSignature(signature);
        const v = sig.v !== undefined ? Number(sig.v) : sig.yParity + 27;
        const hash = await wallet.writeContract({
          address: token!,
          abi: EIP3009_ABI,
          functionName: "transferWithAuthorization",
          args: [getAddress(a.from), getAddress(a.to), BigInt(a.value), BigInt(a.validAfter), BigInt(a.validBefore), a.nonce, v, sig.r, sig.s],
        });
        const receipt = await pub!.waitForTransactionReceipt({ hash, pollingInterval: 50, timeout: 30_000 });
        if (receipt.status !== "success") throw new Error(`transferWithAuthorization reverted in ${hash}`);
        return hash;
      };
      const p = queue.then(run, run);
      queue = p.catch(() => undefined);
      return p;
    };
  }

  const invalid = (invalidReason: string, payer?: string, invalidMessage?: string): VerifyResponse => {
    const r: VerifyResponse = { isValid: false, invalidReason };
    if (payer !== undefined) r.payer = payer;
    if (invalidMessage !== undefined) r.invalidMessage = invalidMessage;
    return r;
  };

  async function verify(
    payload: PaymentPayload,
    requirements: PaymentRequirements,
    vopts: { allowUsedNonce?: boolean } = {},
  ): Promise<VerifyResponse> {
    if (!payload || typeof payload !== "object") return invalid("invalid_payload");
    if (payload.x402Version !== 2) return invalid("invalid_x402_version");
    if (!requirements || typeof requirements !== "object") return invalid("invalid_payment_requirements");
    const accepted = payload.accepted;
    if (!accepted || typeof accepted !== "object") return invalid("invalid_payload");
    if (requirements.scheme !== "exact" || accepted.scheme !== "exact") return invalid("invalid_exact_evm_scheme");
    if (accepted.network !== requirements.network || requirements.network !== opts.network) {
      return invalid("invalid_exact_evm_network_mismatch");
    }
    const chainId = parseChainId(requirements.network);
    if (chainId === undefined) return invalid("invalid_network");

    const parsed = extractAuthorization(payload);
    if (!parsed) return invalid("invalid_payload");
    const { authorization: a, signature } = parsed;
    const payer = getAddress(a.from);

    const name = requirements.extra?.["name"];
    const version = requirements.extra?.["version"];
    if (typeof name !== "string" || typeof version !== "string") {
      return invalid("invalid_exact_evm_missing_eip712_domain", payer);
    }
    if (!isAddress(requirements.asset) || !isAddress(requirements.payTo)) {
      return invalid("invalid_payment_requirements", payer);
    }

    // 1. Signature (ecrecover via viem).
    let sigOk = false;
    try {
      sigOk = await verifyTypedData({
        address: payer,
        domain: { name, version, chainId, verifyingContract: getAddress(requirements.asset) },
        types: authorizationTypes,
        primaryType: "TransferWithAuthorization",
        message: {
          from: payer,
          to: getAddress(a.to),
          value: BigInt(a.value),
          validAfter: BigInt(a.validAfter),
          validBefore: BigInt(a.validBefore),
          nonce: a.nonce,
        },
        signature,
      });
    } catch {
      return invalid("invalid_exact_evm_failed_to_parse_signature", payer);
    }
    if (!sigOk) return invalid("invalid_exact_evm_signature", payer);

    // 2. to == payTo.
    if (getAddress(a.to) !== getAddress(requirements.payTo)) return invalid("invalid_exact_evm_recipient_mismatch", payer);

    // 3/4. Time window. The SDK facilitator requires validBefore >= now + 6; we only require
    // validBefore > now so that /fail/slow (maxTimeoutSeconds: 1) is payable by a real client.
    // In chain mode "now" is the latest block's timestamp, i.e. the clock the token itself checks.
    const now = pub ? (await pub.getBlock({ blockTag: "latest" })).timestamp : BigInt(nowSec());
    if (BigInt(a.validBefore) <= now) return invalid("invalid_exact_evm_payload_authorization_valid_before", payer);
    if (BigInt(a.validAfter) > now) return invalid("invalid_exact_evm_payload_authorization_valid_after", payer);

    // 5. value == amount exactly (SDK behaviour).
    if (BigInt(a.value) !== BigInt(requirements.amount)) {
      return invalid("invalid_exact_evm_payload_authorization_value_mismatch", payer);
    }

    // 7. Stand-in for the on-chain simulation: a used nonce fails verify.
    if (!vopts.allowUsedNonce && usedNonces.has(a.nonce.toLowerCase())) {
      return invalid("invalid_exact_evm_nonce_already_used", payer);
    }
    if (pub && token) {
      if (getAddress(requirements.asset) !== token) return invalid("invalid_payment_requirements", payer, "asset is not the chain-mode token");
      const used = await pub.readContract({ address: token, abi: EIP3009_ABI, functionName: "authorizationState", args: [payer, a.nonce] });
      if (used && !vopts.allowUsedNonce) return invalid("invalid_exact_evm_nonce_already_used", payer);
    }

    return { isValid: true, payer };
  }

  function record(a: ExactAuthorization, requirements: PaymentRequirements, route?: string, realTxHash?: `0x${string}`): Settlement {
    counter += 1n;
    const txHash = realTxHash ?? keccak256(encodePacked(["bytes32", "uint256"], [a.nonce, counter]));
    const s: Settlement = {
      nonce: a.nonce,
      from: getAddress(a.from),
      to: getAddress(a.to),
      value: a.value,
      txHash,
      settledAt: new Date().toISOString(),
      network: requirements.network,
      asset: requirements.asset,
    };
    if (route !== undefined) s.route = route;
    records.push(s);
    usedNonces.add(a.nonce.toLowerCase());
    return s;
  }

  async function settle(
    payload: PaymentPayload,
    requirements: PaymentRequirements,
    sopts: SettleOptions = {},
  ): Promise<SettleResponse> {
    const network = requirements?.network ?? opts.network;
    const fail = (errorReason: string, payer?: string): SettleResponse => {
      const r: SettleResponse = { success: false, errorReason, transaction: "", network };
      if (payer !== undefined) r.payer = payer;
      return r;
    };
    // Settle re-runs verify (as the SDK does). A reused nonce is reported with the same code
    // the SDK maps an EIP-3009 "authorization used" revert to.
    const v = await verify(payload, requirements, { allowUsedNonce: sopts.duplicate === true });
    if (!v.isValid) return fail(v.invalidReason ?? "unexpected_settle_error", v.payer);
    const parsed = extractAuthorization(payload);
    if (!parsed) return fail("invalid_payload");
    const a = parsed.authorization;
    if (!sopts.duplicate && usedNonces.has(a.nonce.toLowerCase())) {
      return fail("invalid_exact_evm_nonce_already_used", getAddress(a.from));
    }
    if (submit) {
      // An exact-scheme authorization can move funds on chain only once (the token burns the nonce),
      // so the duplicate fault cannot exist in chain mode.
      if (sopts.duplicate) return fail("unsupported_in_chain_mode", getAddress(a.from));
      let hash: Hex;
      try {
        hash = await submit(a, parsed.signature);
      } catch (e) {
        return fail(settleErrorFromRevert(e instanceof Error ? e.message : String(e)), getAddress(a.from));
      }
      const rec = record(a, requirements, sopts.route, hash);
      return { success: true, transaction: rec.txHash, network: requirements.network, payer: rec.from };
    }
    let s = record(a, requirements, sopts.route);
    if (sopts.duplicate) s = record(a, requirements, sopts.route);
    return { success: true, transaction: s.txHash, network: requirements.network, payer: s.from };
  }

  return {
    mode: submit ? "chain" : "memory",
    verify,
    settle,
    supported: () => ({
      kinds: [{ x402Version: 2, scheme: "exact", network: opts.network }],
      extensions: [],
      signers: { "eip155:*": [MOCK_FACILITATOR_SIGNER] },
    }),
    settlements: () => records.map((r) => ({ ...r })),
    reset: () => {
      records = [];
      counter = 0n;
      usedNonces.clear();
    },
  };
}

/**
 * Mounts POST {prefix}/verify, POST {prefix}/settle, GET {prefix}/supported with the
 * HTTPFacilitatorClient wire shapes (protocol-notes §6). Malformed bodies get HTTP 400
 * `{error:"invalid_json"|"missing_parameters"}` like the hosted x402.org facilitator.
 */
export function mountFacilitatorRoutes(app: Hono, facilitator: MockFacilitator, prefix = "/facilitator"): void {
  const readBody = async (req: Request): Promise<{ paymentPayload: PaymentPayload; paymentRequirements: PaymentRequirements } | { error: string }> => {
    let body: unknown;
    try {
      body = await req.json();
    } catch {
      return { error: "invalid_json" };
    }
    const b = body as { paymentPayload?: PaymentPayload; paymentRequirements?: PaymentRequirements } | null;
    if (!b || typeof b !== "object" || !b.paymentPayload || !b.paymentRequirements) return { error: "missing_parameters" };
    return { paymentPayload: b.paymentPayload, paymentRequirements: b.paymentRequirements };
  };
  app.post(`${prefix}/verify`, async (c) => {
    const b = await readBody(c.req.raw);
    if ("error" in b) return c.json({ error: b.error }, 400);
    return c.json(await facilitator.verify(b.paymentPayload, b.paymentRequirements));
  });
  app.post(`${prefix}/settle`, async (c) => {
    const b = await readBody(c.req.raw);
    if ("error" in b) return c.json({ error: b.error }, 400);
    return c.json(await facilitator.settle(b.paymentPayload, b.paymentRequirements, { route: `${prefix}/settle` }));
  });
  app.get(`${prefix}/supported`, (c) => c.json(facilitator.supported()));
}
