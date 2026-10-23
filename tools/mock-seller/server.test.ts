import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { generatePrivateKey, privateKeyToAccount } from "viem/accounts";
import { getAddress } from "viem";
import {
  decodePaymentRequiredHeader,
  decodePaymentResponseHeader,
  encodePaymentSignatureHeader,
} from "@x402/core/http";
import { PaymentRequiredV2Schema } from "@x402/core/schemas";
import type { PaymentRequired, PaymentRequirements } from "@x402/core/types";
import { wrapFetchWithPayment, x402Client } from "@x402/fetch";
import { ExactEvmScheme } from "@x402/evm/exact/client";
import { startMockSeller, type MockSeller, BASE_SEPOLIA_USDC } from "./server.js";
import { signExactPayment } from "./sign.js";

// eslint-disable-next-line @typescript-eslint/no-explicit-any
const json = (r: Response): Promise<any> => r.json();

let seller: MockSeller;
const account = privateKeyToAccount(generatePrivateKey());

beforeAll(async () => {
  seller = await startMockSeller({ port: 0 });
});
afterAll(async () => {
  await seller.close();
});
beforeEach(() => seller.reset());

async function quote(path: string, init?: RequestInit): Promise<{ res: Response; pr: PaymentRequired; req: PaymentRequirements }> {
  const res = await fetch(`${seller.url}${path}`, init);
  expect(res.status).toBe(402);
  const h = res.headers.get("payment-required");
  expect(h).toBeTruthy();
  const pr = decodePaymentRequiredHeader(h!);
  return { res, pr, req: pr.accepts[0]! };
}

async function pay(path: string, init: RequestInit = {}) {
  const { pr, req } = await quote(path, init);
  const payload = await signExactPayment({ account, requirements: req, resource: pr.resource });
  const header = encodePaymentSignatureHeader(payload);
  const res = await fetch(`${seller.url}${path}`, {
    ...init,
    headers: { ...(init.headers as Record<string, string> | undefined), "PAYMENT-SIGNATURE": header },
  });
  return { res, payload, header, req };
}

describe("mock seller", () => {
  it("(a) unpaid GET /ok returns 402 with a decodable v2 PAYMENT-REQUIRED header", async () => {
    const { res, pr, req } = await quote("/ok?symbol=BTC");
    expect(await res.json()).toEqual({});
    expect(res.headers.get("cache-control")).toBe("no-store");
    expect(PaymentRequiredV2Schema.safeParse(pr).success).toBe(true);
    expect(pr.x402Version).toBe(2);
    expect(pr.resource.url).toBe(`${seller.url}/ok?symbol=BTC`);
    expect(pr.resource.mimeType).toBe("application/json");
    expect(req).toEqual({
      scheme: "exact",
      network: "eip155:84532",
      amount: "10000",
      asset: getAddress(BASE_SEPOLIA_USDC),
      payTo: expect.stringMatching(/^0x[0-9a-fA-F]{40}$/),
      maxTimeoutSeconds: 60,
      extra: { name: "USDC", version: "2" },
    });
  });

  it("(b) hand-signed payment on /ok succeeds with one settlement", async () => {
    const { res, payload } = await pay("/ok?symbol=BTC");
    expect(res.status).toBe(200);
    const body = await json(res);
    expect(body).toMatchObject({ symbol: "BTC", source: "mock" });
    expect(Math.abs(Date.parse(body.timestamp) - Date.now())).toBeLessThan(10_000);
    const pr = decodePaymentResponseHeader(res.headers.get("payment-response")!);
    expect(pr.success).toBe(true);
    expect(pr.network).toBe("eip155:84532");
    expect(pr.payer).toBe(account.address);
    expect(pr.transaction).toMatch(/^0x[0-9a-f]{64}$/);
    const s = seller.settlements();
    expect(s).toHaveLength(1);
    const auth = (payload.payload as { authorization: { nonce: string } }).authorization;
    expect(s[0]!.nonce).toBe(auth.nonce);
    expect(s[0]!.txHash).toBe(pr.transaction);
    expect(s[0]!.from).toBe(account.address);
  });

  it("(c) replaying the same payload yields 402 invalid_exact_evm_nonce_already_used", async () => {
    const { res, header } = await pay("/ok?symbol=BTC");
    expect(res.status).toBe(200);
    const replay = await fetch(`${seller.url}/ok?symbol=BTC`, { headers: { "PAYMENT-SIGNATURE": header } });
    expect(replay.status).toBe(402);
    const r = decodePaymentResponseHeader(replay.headers.get("payment-response")!);
    expect(r).toMatchObject({ success: false, errorReason: "invalid_exact_evm_nonce_already_used", transaction: "" });
    expect(seller.settlements()).toHaveLength(1);
  });

  it("(d) /fail/double-settle produces two settlements with the same nonce", async () => {
    const { res } = await pay("/fail/double-settle?symbol=BTC");
    expect(res.status).toBe(200);
    const s = seller.settlements();
    expect(s).toHaveLength(2);
    expect(s[0]!.nonce).toBe(s[1]!.nonce);
    expect(s[0]!.txHash).not.toBe(s[1]!.txHash);
  });

  it("(e) /fail/reject never settles", async () => {
    const { res } = await pay("/fail/reject");
    expect(res.status).toBe(402);
    const r = decodePaymentResponseHeader(res.headers.get("payment-response")!);
    expect(r).toMatchObject({ success: false, errorReason: "invalid_exact_evm_signature" });
    expect(seller.settlements()).toHaveLength(0);
  });

  it("(f) /fail/overcharge quotes 10x the catalog price", async () => {
    const entry = seller.catalog().find((e) => e.url.includes("/fail/overcharge"))!;
    const { req } = await quote("/fail/overcharge?symbol=BTC");
    expect(BigInt(req.amount)).toBe(BigInt(entry.listedPriceAtomic) * 10n);
    const { res } = await pay("/fail/overcharge?symbol=BTC");
    expect(res.status).toBe(200);
    expect(seller.settlements()[0]!.value).toBe(req.amount);
  });

  it("(g) /fail/price-discriminate differs by User-Agent", async () => {
    const a = await quote("/fail/price-discriminate", { headers: { "User-Agent": "agent identity-a" } });
    const b = await quote("/fail/price-discriminate", { headers: { "User-Agent": "agent identity-b" } });
    expect(BigInt(b.req.amount)).toBe(BigInt(a.req.amount) * 2n);
  });

  it("(h) /fail/payto-change alternates pay-to and both quotes are payable", async () => {
    const q1 = await quote("/fail/payto-change");
    const q2 = await quote("/fail/payto-change");
    const q3 = await quote("/fail/payto-change");
    expect(q1.req.payTo).not.toBe(q2.req.payTo);
    expect(q3.req.payTo).toBe(q1.req.payTo);
    const payload = await signExactPayment({ account, requirements: q2.req });
    const res = await fetch(`${seller.url}/fail/payto-change`, {
      headers: { "PAYMENT-SIGNATURE": encodePaymentSignatureHeader(payload) },
    });
    expect(res.status).toBe(200);
    expect(seller.settlements()[0]!.to).toBe(q2.req.payTo);
  });

  it("catalog and control endpoints", async () => {
    const cat = (await (await fetch(`${seller.url}/__mock/catalog`)).json()) as unknown[];
    expect(cat).toHaveLength(16);
    expect(cat).toEqual(seller.catalog());
    await pay("/ok");
    expect(await (await fetch(`${seller.url}/__mock/settlements`)).json()).toHaveLength(1);
    await fetch(`${seller.url}/__mock/reset`, { method: "POST" });
    expect(seller.settlements()).toHaveLength(0);
  });

  it("delivery faults: 500, empty, wrong content type, not-json, wrong entity, stale, inject", async () => {
    const r500 = (await pay("/fail/500-after-settle")).res;
    expect(r500.status).toBe(500);
    expect(r500.headers.get("payment-response")).toBeTruthy();
    const empty = (await pay("/fail/empty")).res;
    expect(empty.status).toBe(200);
    expect(empty.headers.get("content-type")).toContain("application/json");
    expect(await empty.text()).toBe("");
    const html = (await pay("/fail/wrong-content-type")).res;
    expect(html.headers.get("content-type")).toContain("text/html");
    const nj = (await pay("/fail/not-json")).res;
    expect(await nj.text()).toBe('{"symbol": "BTC", "price":');
    expect((await json((await pay("/fail/wrong-entity?symbol=BTC")).res)).symbol).toBe("ETH");
    const stale = await json((await pay("/fail/stale?symbol=BTC")).res);
    expect(Date.now() - Date.parse(stale.timestamp)).toBeGreaterThan(2.9 * 24 * 3600 * 1000);
    const inj = await json((await pay("/fail/inject?symbol=BTC")).res);
    expect(inj.note).toContain("ignore previous instructions");
    expect(seller.settlements()).toHaveLength(7);
  });

  it("/fail/truncate sends fewer bytes than Content-Length", async () => {
    const { res } = await pay("/fail/truncate?symbol=BTC");
    expect(res.status).toBe(200);
    expect(Number(res.headers.get("content-length"))).toBeGreaterThan(0);
    await expect(res.text()).rejects.toThrow();
    expect(seller.settlements()).toHaveLength(1);
  });

  it("/fail/hang-after-payment settles and never responds", async () => {
    const ac = new AbortController();
    const t = setTimeout(() => ac.abort(), 500);
    await expect(pay("/fail/hang-after-payment", { signal: ac.signal })).rejects.toThrow();
    clearTimeout(t);
    expect(seller.settlements()).toHaveLength(1);
  });

  it("/fail/slow declares maxTimeoutSeconds 1 and takes ~3s", async () => {
    const { req } = await quote("/fail/slow");
    expect(req.maxTimeoutSeconds).toBe(1);
    const t0 = Date.now();
    const { res } = await pay("/fail/slow");
    expect(res.status).toBe(200);
    expect(Date.now() - t0).toBeGreaterThanOrEqual(2900);
  }, 10_000);

  it("HTTP facilitator endpoints mirror the in-process facilitator", async () => {
    const sup = await json(await fetch(`${seller.url}/facilitator/supported`));
    expect(sup.kinds).toEqual([{ x402Version: 2, scheme: "exact", network: "eip155:84532" }]);
    const { req } = await quote("/ok");
    const paymentPayload = await signExactPayment({ account, requirements: req });
    const body = JSON.stringify({ x402Version: 2, paymentPayload, paymentRequirements: req });
    const post = (p: string) =>
      fetch(`${seller.url}/facilitator/${p}`, { method: "POST", headers: { "Content-Type": "application/json" }, body }).then((r) => r.json());
    expect(await post("verify")).toEqual({ isValid: true, payer: account.address });
    const s1 = await post("settle");
    expect(s1).toMatchObject({ success: true, network: "eip155:84532", payer: account.address });
    expect(await post("settle")).toMatchObject({ success: false, errorReason: "invalid_exact_evm_nonce_already_used", transaction: "" });
    const bad = await fetch(`${seller.url}/facilitator/verify`, { method: "POST", body: "nope" });
    expect(bad.status).toBe(400);
  });

  it("a real @x402/fetch client with ExactEvmScheme can pay /ok", async () => {
    const client = new x402Client().register("eip155:*", new ExactEvmScheme(account));
    const payFetch = wrapFetchWithPayment(fetch, client);
    const res = await payFetch(`${seller.url}/ok?symbol=ETH`);
    expect(res.status).toBe(200);
    expect((await json(res)).symbol).toBe("ETH");
    expect(decodePaymentResponseHeader(res.headers.get("payment-response")!).success).toBe(true);
    expect(seller.settlements()).toHaveLength(1);
  });
});
