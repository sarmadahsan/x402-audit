/**
 * A fetch function that plays the paidfor index and two x402 sellers, in process, with no sockets and no network.
 * Paid requests to the sellers carry a real EIP-3009 authorization signed by a throwaway in-memory key; the mock
 * verifies the signature (so a test can prove exactly what was, or was not, signed) and "settles" by answering with
 * a PAYMENT-RESPONSE header. Nothing is ever broadcast and no funds exist.
 */
import { readFileSync } from "node:fs";
import { encodePaymentRequiredHeader, encodePaymentResponseHeader, decodePaymentSignatureHeader } from "@x402/core/http";
import { getAddress, verifyTypedData, type Hex } from "viem";
import { generatePrivateKey, privateKeyToAccount } from "viem/accounts";
import { BASE_MAINNET, USDC_BASE } from "../src/constants.js";

export const INDEX_URL = "https://paidfor.dev/v1";
export const DATA_URL = "https://raw.githubusercontent.com/sarmadahsan/paidfor-data/main/sellers.json";
/** Rated avoid by the index on 2026-11-01 (test/fixtures/check-api-xpay.json). */
export const AVOID_HOST = "www.api-xpay.com";
export const OK_HOST = "good-seller.example";
export const UNKNOWN_HOST = "never-seen.example";
export const TX = "0x" + "ab".repeat(32);
export const AMOUNT = "10000";

export function fixture<T = unknown>(name: string): T {
  return JSON.parse(readFileSync(new URL(`./fixtures/${name}.json`, import.meta.url), "utf8")) as T;
}

/** The avoid seller's pay-to, from the public data (sellers.json) and the fixture built from it. */
export const AVOID_PAY_TO: string = (fixture("sellers-data-api-xpay") as { sellers: Array<{ pay_to_addresses: string[] }> }).sellers[0]!.pay_to_addresses[0]!;
/** Throwaway pay-to addresses for the other two sellers: random, unfunded, never reused. */
export const OK_PAY_TO = privateKeyToAccount(generatePrivateKey()).address.toLowerCase();
export const UNKNOWN_PAY_TO = privateKeyToAccount(generatePrivateKey()).address.toLowerCase();

export type SellerMode = "ok" | "fail_500" | "settle_fail" | "reject_402" | "no_header" | "throw";
export type Answer = { kind: "json"; body: unknown; status?: number } | { kind: "status"; status: number } | { kind: "hang" } | { kind: "throw" };

export interface MockState {
  sellers: Answer;
  data: Answer;
  checks: Record<string, Answer>;
  telemetry: Answer;
  sellerMode: SellerMode;
  network: string;
  asset: string;
  /** Every /v1/check request path, in order. */
  checkCalls: string[];
  /** Every body POSTed to /v1/telemetry, with the headers sent. */
  telemetryPosts: Array<{ body: unknown; headers: Record<string, string> }>;
  sellersCalls: number;
  dataCalls: number;
  unpaidCalls: number;
  paidCalls: number;
  /** Payers and nonces of signatures the sellers verified. */
  signatures: Array<{ payer: string; nonce: string; to: string; value: string; valid: boolean }>;
}

const PAY_TO_BY_HOST: Record<string, string> = { [AVOID_HOST]: AVOID_PAY_TO, [OK_HOST]: OK_PAY_TO, [UNKNOWN_HOST]: UNKNOWN_PAY_TO };

function checkOk(host: string) {
  return {
    input: `https://${host}/`,
    host,
    verdict: "ok",
    verdict_text: `OK: 0 of 240 paid calls to ${host} failed the buyer (95% interval up to 1.6%). Evidence: https://raw.githubusercontent.com/sarmadahsan/paidfor-data/main/evidence/${host}.json`,
    seller: { domain: host, tier: "tail", category: "data", calls: 240, failures: 0, failure_rate: 0, wilson_low: 0, wilson_high: 0.0158, verdict: "ok", url: `https://paidfor.dev/seller/${host}`, evidence_url: `https://raw.githubusercontent.com/sarmadahsan/paidfor-data/main/evidence/${host}.json` },
    resource: null,
    probe: null,
    seller_url: `https://paidfor.dev/seller/${host}`,
    evidence_url: `https://raw.githubusercontent.com/sarmadahsan/paidfor-data/main/evidence/${host}.json`,
    methodology_url: "https://paidfor.dev/methodology",
    generated_at: "2026-11-01T23:24:02.078Z",
    verdict_basis: "measured",
    candidate: null,
  };
}

function checkUnknown(host: string) {
  return {
    input: `https://${host}/`,
    host,
    verdict: "unknown",
    verdict_text: `Unknown: ${host} was never seen in the study or in the hourly probe set. Methodology: https://paidfor.dev/methodology`,
    seller: null,
    resource: null,
    probe: null,
    seller_url: null,
    evidence_url: null,
    methodology_url: "https://paidfor.dev/methodology",
    generated_at: "2026-11-01T23:24:02.078Z",
    verdict_basis: "measured",
    candidate: null,
  };
}

export function freshState(): MockState {
  return {
    sellers: { kind: "json", body: fixture("v1-sellers-api-xpay") },
    data: { kind: "json", body: fixture("sellers-data-api-xpay") },
    checks: {
      [AVOID_HOST]: { kind: "json", body: fixture("check-api-xpay") },
      [OK_HOST]: { kind: "json", body: checkOk(OK_HOST) },
      [UNKNOWN_HOST]: { kind: "json", body: checkUnknown(UNKNOWN_HOST) },
    },
    telemetry: { kind: "json", body: { status: "pending" }, status: 202 },
    sellerMode: "ok",
    network: BASE_MAINNET,
    asset: USDC_BASE,
    checkCalls: [],
    telemetryPosts: [],
    sellersCalls: 0,
    dataCalls: 0,
    unpaidCalls: 0,
    paidCalls: 0,
    signatures: [],
  };
}

/** Never answers, like a stalled connection; rejects only when the caller's own timeout signal fires. */
const hang = (signal: AbortSignal | null | undefined) =>
  new Promise<Response>((_, reject) => {
    if (signal?.aborted) reject(signal.reason);
    signal?.addEventListener("abort", () => reject(signal.reason), { once: true });
  });

function answer(a: Answer, signal?: AbortSignal | null): Promise<Response> {
  switch (a.kind) {
    case "hang":
      return hang(signal);
    case "throw":
      return Promise.reject(new TypeError("fetch failed"));
    case "status":
      return Promise.resolve(new Response(null, { status: a.status }));
    case "json":
      return Promise.resolve(new Response(JSON.stringify(a.body), { status: a.status ?? 200, headers: { "content-type": "application/json" } }));
  }
}

interface Authorization {
  from: Hex;
  to: Hex;
  value: string;
  validAfter: string;
  validBefore: string;
  nonce: Hex;
}

async function verify(st: MockState, header: string, host: string): Promise<{ payer: string }> {
  const p = decodePaymentSignatureHeader(header) as unknown as { accepted: { network: string }; payload: { signature: Hex; authorization: Authorization } };
  const a = p.payload.authorization;
  const chainId = Number(st.network.split(":")[1]);
  const valid = await verifyTypedData({
    address: a.from,
    domain: { name: "USDC", version: "2", chainId, verifyingContract: getAddress(st.asset) },
    types: {
      TransferWithAuthorization: [
        { name: "from", type: "address" },
        { name: "to", type: "address" },
        { name: "value", type: "uint256" },
        { name: "validAfter", type: "uint256" },
        { name: "validBefore", type: "uint256" },
        { name: "nonce", type: "bytes32" },
      ],
    },
    primaryType: "TransferWithAuthorization",
    message: { from: a.from, to: a.to, value: BigInt(a.value), validAfter: BigInt(a.validAfter), validBefore: BigInt(a.validBefore), nonce: a.nonce },
    signature: p.payload.signature,
  });
  st.signatures.push({ payer: a.from.toLowerCase(), nonce: a.nonce.toLowerCase(), to: a.to.toLowerCase(), value: a.value, valid: valid && a.to.toLowerCase() === PAY_TO_BY_HOST[host] && a.value === AMOUNT });
  return { payer: a.from };
}

function paymentRequired(st: MockState, url: string, host: string) {
  return {
    x402Version: 2,
    resource: { url, description: "test resource", mimeType: "application/json" },
    accepts: [{ scheme: "exact", network: st.network, amount: AMOUNT, asset: st.asset, payTo: PAY_TO_BY_HOST[host]!, maxTimeoutSeconds: 60, extra: { name: "USDC", version: "2" } }],
  };
}

async function seller(st: MockState, req: Request): Promise<Response> {
  const u = new URL(req.url);
  const sig = req.headers.get("PAYMENT-SIGNATURE") ?? req.headers.get("X-PAYMENT");
  if (!sig) {
    st.unpaidCalls++;
    const pr = paymentRequired(st, `${u.origin}${u.pathname}`, u.hostname);
    return new Response(JSON.stringify({ error: "payment required" }), {
      status: 402,
      headers: { "content-type": "application/json", "PAYMENT-REQUIRED": encodePaymentRequiredHeader(pr as never) },
    });
  }
  st.paidCalls++;
  if (st.sellerMode === "throw") throw new TypeError("fetch failed: socket hang up");
  const { payer } = await verify(st, sig, u.hostname);
  const settled = encodePaymentResponseHeader({ success: true, transaction: TX, network: st.network, payer } as never);
  switch (st.sellerMode) {
    case "ok":
      return new Response(JSON.stringify({ ok: true, data: "the goods", secret_body_marker: "BODY-7731" }), { status: 200, headers: { "content-type": "application/json", "PAYMENT-RESPONSE": settled } });
    case "fail_500":
      return new Response("upstream error", { status: 500, headers: { "content-type": "text/plain", "PAYMENT-RESPONSE": settled } });
    case "no_header":
      return new Response(JSON.stringify({ ok: true }), { status: 200, headers: { "content-type": "application/json" } });
    case "settle_fail":
      return new Response(JSON.stringify({ error: "settlement failed" }), {
        status: 402,
        headers: { "content-type": "application/json", "PAYMENT-RESPONSE": encodePaymentResponseHeader({ success: false, transaction: "", network: st.network, errorReason: "insufficient_funds" } as never) },
      });
    case "reject_402":
      return new Response(JSON.stringify({ error: "invalid payment" }), {
        status: 402,
        headers: { "content-type": "application/json", "PAYMENT-REQUIRED": encodePaymentRequiredHeader(paymentRequired(st, `${u.origin}${u.pathname}`, u.hostname) as never) },
      });
  }
}

/** The mock fetch. Sellers are any host in PAY_TO_BY_HOST; everything else is the index. */
export function mockFetch(st: MockState): typeof globalThis.fetch {
  return async (input, init) => {
    const req = input instanceof Request ? input : new Request(input, init);
    const u = new URL(req.url);
    if (req.url === DATA_URL) {
      st.dataCalls++;
      return answer(st.data, init?.signal ?? req.signal);
    }
    if (`${u.origin}${u.pathname}` === `${INDEX_URL}/sellers`) {
      st.sellersCalls++;
      return answer(st.sellers, init?.signal ?? req.signal);
    }
    if (`${u.origin}${u.pathname}` === `${INDEX_URL}/check`) {
      st.checkCalls.push(`${u.pathname}${u.search}`);
      const target = u.searchParams.get("url") ?? "";
      const host = new URL(target).hostname;
      return answer(st.checks[host] ?? { kind: "json", body: checkUnknown(host) }, init?.signal ?? req.signal);
    }
    if (`${u.origin}${u.pathname}` === `${INDEX_URL}/telemetry`) {
      const headers: Record<string, string> = {};
      req.headers.forEach((v, k) => (headers[k] = v));
      st.telemetryPosts.push({ body: JSON.parse(await req.text()), headers });
      return answer(st.telemetry, init?.signal ?? req.signal);
    }
    if (u.hostname in PAY_TO_BY_HOST) return seller(st, req);
    return new Response("not found", { status: 404 });
  };
}

/** A fresh in-memory signer with no funds. The key lives only in this object and is never printed. */
export function throwawaySigner() {
  return privateKeyToAccount(generatePrivateKey());
}
