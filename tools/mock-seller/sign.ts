/**
 * Builds a valid x402 v2 exact/EVM/EIP-3009 PaymentPayload, mirroring what
 * @x402/evm's ExactEvmScheme client does (protocol-notes §3 and §5):
 *   nonce = 32 random bytes hex, validAfter = "0", validBefore = now + maxTimeoutSeconds,
 *   value = requirements.amount, to = getAddress(payTo),
 *   domain = { name: extra.name, version: extra.version, chainId, verifyingContract: getAddress(asset) }.
 */
import type { PaymentPayload, PaymentRequirements, ResourceInfo } from "@x402/core/types";
import { getAddress, toHex, type LocalAccount } from "viem";
import { randomBytes } from "node:crypto";
import { authorizationTypes } from "./facilitator.js";

export interface SignExactPaymentOptions {
  /** Any viem account that can sign typed data (e.g. privateKeyToAccount(generatePrivateKey())). */
  account: Pick<LocalAccount, "address" | "signTypedData">;
  requirements: PaymentRequirements;
  /** Unix time in seconds; defaults to Math.floor(Date.now()/1000). */
  now?: number;
  /** Echoed as payload.resource, as the SDK client does (paymentRequired.resource). */
  resource?: ResourceInfo;
  /** Override the nonce (bytes32 hex). Defaults to 32 random bytes. */
  nonce?: `0x${string}`;
}

export async function signExactPayment(opts: SignExactPaymentOptions): Promise<PaymentPayload> {
  const { account, requirements } = opts;
  const m = /^eip155:(\d+)$/.exec(requirements.network);
  if (!m) throw new Error(`signExactPayment: unsupported network ${requirements.network}`);
  const chainId = Number(m[1]);
  const name = requirements.extra?.["name"];
  const version = requirements.extra?.["version"];
  if (typeof name !== "string" || typeof version !== "string") {
    throw new Error(`EIP-712 domain parameters (name, version) are required in payment requirements for asset ${requirements.asset}`);
  }
  const now = opts.now ?? Math.floor(Date.now() / 1000);
  const authorization = {
    from: getAddress(account.address),
    to: getAddress(requirements.payTo),
    value: requirements.amount,
    validAfter: "0",
    validBefore: (now + requirements.maxTimeoutSeconds).toString(),
    nonce: opts.nonce ?? toHex(randomBytes(32)),
  };
  const signature = await account.signTypedData({
    domain: { name, version, chainId, verifyingContract: getAddress(requirements.asset) },
    types: authorizationTypes,
    primaryType: "TransferWithAuthorization",
    message: {
      from: authorization.from,
      to: authorization.to,
      value: BigInt(authorization.value),
      validAfter: BigInt(authorization.validAfter),
      validBefore: BigInt(authorization.validBefore),
      nonce: authorization.nonce,
    },
  });
  const payload: PaymentPayload = {
    x402Version: 2,
    accepted: requirements,
    payload: { authorization, signature },
  };
  if (opts.resource !== undefined) payload.resource = opts.resource;
  return payload;
}
