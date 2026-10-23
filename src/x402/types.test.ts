import { createServer, type Server } from "node:http";
import type { AddressInfo } from "node:net";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { generatePrivateKey, privateKeyToAccount } from "viem/accounts";
import { fetchQuote, selectRequirements } from "./quote.js";
import { decodeSettlementHeader } from "./settlement.js";
import { HEADERS, decodeHeaderJson, encodeHeaderJson, parse402, type NormalizedRequirements } from "./types.js";

const USDC_SEPOLIA = "0x036CbD53842c5426634e7929541eC2318f3dCF7e";
const payTo = privateKeyToAccount(generatePrivateKey()).address;

const v2Envelope = {
  x402Version: 2,
  error: "Payment required",
  resource: { url: "http://x/weather", description: "Weather", mimeType: "application/json" },
  accepts: [
    { scheme: "upto", network: "eip155:84532", amount: "5", asset: USDC_SEPOLIA, payTo, maxTimeoutSeconds: 60, extra: { name: "USDC", version: "2" } },
    { scheme: "exact", network: "eip155:8453", amount: "7", asset: "0x833589fCD6eDb6E08f4c7C32D4f71b54bdA02913", payTo, maxTimeoutSeconds: 60 },
    { scheme: "exact", network: "eip155:84532", amount: "10000", asset: USDC_SEPOLIA, payTo, maxTimeoutSeconds: 60, extra: { name: "USDC", version: "2", custom: 1 } },
  ],
};
const v1Body = {
  x402Version: 1,
  error: "Payment required to access this resource",
  accepts: [
    {
      scheme: "exact",
      network: "base-sepolia",
      maxAmountRequired: "10000",
      asset: USDC_SEPOLIA,
      payTo,
      resource: "https://api.example.com/premium-data",
      description: "premium",
      mimeType: "application/json",
      outputSchema: { type: "object" },
      maxTimeoutSeconds: 60,
      extra: { name: "USDC", version: "2" },
    },
  ],
};

let server: Server;
let base: string;
beforeAll(async () => {
  server = createServer((req, res) => {
    if (req.url === "/v2") {
      res.writeHead(402, { [HEADERS.V2_REQUIRED]: encodeHeaderJson(v2Envelope), "content-type": "application/json", "X-Custom": "A" });
      res.end("{}");
    } else if (req.url === "/v1") {
      res.writeHead(402, { "content-type": "application/json" });
      res.end(JSON.stringify(v1Body));
    } else if (req.url === "/bad") {
      res.writeHead(402, { [HEADERS.V2_REQUIRED]: "%%%not-base64" });
      res.end();
    } else {
      res.writeHead(200, { "content-type": "text/plain" });
      res.end("free");
    }
  });
  await new Promise<void>((r) => server.listen(0, "127.0.0.1", r));
  base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
});
afterAll(() => new Promise<void>((r) => server.close(() => r())));

describe("header json", () => {
  it("round-trips UTF-8 through standard base64", () => {
    const obj = { a: "é✓", n: 1 };
    const enc = encodeHeaderJson(obj);
    expect(enc).toBe(Buffer.from(JSON.stringify(obj)).toString("base64"));
    expect(decodeHeaderJson(enc)).toEqual(obj);
    expect(() => decodeHeaderJson("not base64!")).toThrow();
  });
});

describe("fetchQuote", () => {
  it("parses a v2 PAYMENT-REQUIRED header and captures lowercase headers", async () => {
    const q = await fetchQuote(`${base}/v2`, { fetchImpl: (i, n) => fetch(i, n) });
    expect(q.status).toBe(402);
    expect(q.headers?.["x-custom"]).toBe("A");
    expect(q.headers?.["payment-required"]).toBeDefined();
    expect(q.bodyText).toBe("{}");
    expect(q.parsed?.version).toBe(2);
    expect(q.parsed?.parseError).toBeUndefined();
    expect(q.parsed?.accepts).toHaveLength(3);
    const a = q.parsed!.accepts[2]!;
    expect(a).toMatchObject({
      x402Version: 2,
      scheme: "exact",
      network: "eip155:84532",
      amountAtomic: "10000",
      asset: USDC_SEPOLIA,
      payTo,
      maxTimeoutSeconds: 60,
      resourceUrl: "http://x/weather",
      description: "Weather",
      mimeType: "application/json",
      extra: { name: "USDC", version: "2", custom: 1 },
    });
    expect(a.raw).toEqual(v2Envelope.accepts[2]);
  });

  it("parses a v1 JSON body and normalises it", async () => {
    const q = await fetchQuote(`${base}/v1`);
    expect(q.parsed?.version).toBe(1);
    const a = q.parsed!.accepts[0]!;
    expect(a).toMatchObject({
      x402Version: 1,
      network: "base-sepolia",
      amountAtomic: "10000",
      resourceUrl: "https://api.example.com/premium-data",
      outputSchema: { type: "object" },
      mimeType: "application/json",
    });
  });

  it("reports parse errors without throwing", async () => {
    const q = await fetchQuote(`${base}/bad`);
    expect(q.status).toBe(402);
    expect(q.parsed?.version).toBe(2);
    expect(q.parsed?.accepts).toEqual([]);
    expect(q.parsed?.parseError).toMatch(/decode failed/);
  });

  it("does not parse non-402 responses", async () => {
    const q = await fetchQuote(`${base}/free`);
    expect(q.status).toBe(200);
    expect(q.parsed).toBeUndefined();
  });

  it("returns error for network failures", async () => {
    const q = await fetchQuote("http://127.0.0.1:1/x", { timeoutMs: 2000 });
    expect(q.error?.kind).toBe("network");
  });

  it("parse402 keeps valid accepts and reports invalid ones", () => {
    const env = { ...v2Envelope, accepts: [{ scheme: "exact" }, v2Envelope.accepts[2]] };
    const p = parse402({ "payment-required": encodeHeaderJson(env) }, undefined);
    expect(p.accepts).toHaveLength(1);
    expect(p.parseError).toMatch(/accepts\[0\]/);
    expect(parse402({}, "not json").version).toBeNull();
    expect(parse402({}, JSON.stringify({ x402Version: 2 })).version).toBeNull();
  });
});

describe("selectRequirements", () => {
  it("picks the first exact requirement on the network (and asset)", () => {
    const v2 = parse402({ "payment-required": encodeHeaderJson(v2Envelope) }, undefined).accepts;
    expect(selectRequirements(v2, { network: "eip155:84532", scheme: "exact" })?.amountAtomic).toBe("10000");
    expect(selectRequirements(v2, { network: "eip155:8453", scheme: "exact" })?.amountAtomic).toBe("7");
    expect(selectRequirements(v2, { network: "eip155:84532", scheme: "exact", asset: USDC_SEPOLIA.toLowerCase() })?.amountAtomic).toBe("10000");
    expect(selectRequirements(v2, { network: "eip155:84532", scheme: "exact", asset: "0xdead" })).toBeUndefined();
    expect(selectRequirements(v2, { network: "eip155:1", scheme: "exact" })).toBeUndefined();
  });
  it("maps v1 network names to CAIP-2", () => {
    const v1: NormalizedRequirements[] = parse402({}, JSON.stringify(v1Body)).accepts;
    expect(selectRequirements(v1, { network: "eip155:84532", scheme: "exact" })?.x402Version).toBe(1);
    expect(selectRequirements(v1, { network: "eip155:8453", scheme: "exact" })).toBeUndefined();
  });
});

describe("decodeSettlementHeader", () => {
  const ok = { success: true, transaction: "0xabc", network: "eip155:84532", payer: payTo, extraField: 1 };
  it("decodes PAYMENT-RESPONSE (v2), case-insensitively", () => {
    const d = decodeSettlementHeader({ "Payment-Response": encodeHeaderJson(ok) });
    expect(d.version).toBe(2);
    expect(d.parsed).toMatchObject({ success: true, transaction: "0xabc", payer: payTo });
  });
  it("falls back to X-PAYMENT-RESPONSE (v1) and prefers v2 when both present", () => {
    expect(decodeSettlementHeader({ "x-payment-response": encodeHeaderJson(ok) }).version).toBe(1);
    const both = decodeSettlementHeader({
      "payment-response": encodeHeaderJson({ ...ok, transaction: "0x2" }),
      "x-payment-response": encodeHeaderJson({ ...ok, transaction: "0x1" }),
    });
    expect(both.parsed?.transaction).toBe("0x2");
  });
  it("reports failures and absence", () => {
    expect(decodeSettlementHeader({})).toEqual({});
    expect(decodeSettlementHeader({ "payment-response": "!!" }).parseError).toMatch(/decode/);
    const bad = decodeSettlementHeader({ "payment-response": encodeHeaderJson({ success: "yes" }) });
    expect(bad.parsed).toBeUndefined();
    expect(bad.raw).toBeDefined();
    expect(bad.parseError).toBeDefined();
    const failed = decodeSettlementHeader({
      "payment-response": encodeHeaderJson({ success: false, transaction: "", network: "eip155:84532", errorReason: "insufficient_funds" }),
    });
    expect(failed.parsed?.errorReason).toBe("insufficient_funds");
  });
});
