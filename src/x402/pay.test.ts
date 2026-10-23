import { createServer, type IncomingMessage, type Server, type ServerResponse } from "node:http";
import type { AddressInfo } from "node:net";
import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { getAddress, verifyTypedData } from "viem";
import { generatePrivateKey, privateKeyToAccount } from "viem/accounts";
import { MAX_BODY_BYTES } from "../taxonomy.js";
import { createPayer, type AfterSignInfo, type PayHooks } from "./pay.js";
import { HEADERS, decodeHeaderJson, encodeHeaderJson, type NormalizedRequirements } from "./types.js";

const USDC_SEPOLIA = "0x036CbD53842c5426634e7929541eC2318f3dCF7e";
const NETWORK = "eip155:84532" as const;
const payTo = privateKeyToAccount(generatePrivateKey()).address;

type Mode = "ok" | "big" | "short" | "hang" | "settle_fail" | "offnet" | "free";
interface State {
  mode: Mode;
  amount: string;
  unpaidCount: number;
  paidCount: number;
  afterSignSeenBeforeRequest: boolean[];
  verifyErrors: string[];
}
const st: State = { mode: "ok", amount: "10000", unpaidCount: 0, paidCount: 0, afterSignSeenBeforeRequest: [], verifyErrors: [] };
let afterSignDone = false;

function envelope(url: string) {
  return {
    x402Version: 2,
    resource: { url, description: "test", mimeType: "application/json" },
    accepts: [
      { scheme: "exact", network: "eip155:8453", amount: "1", asset: USDC_SEPOLIA, payTo, maxTimeoutSeconds: 60, extra: { name: "USDC", version: "2" } },
      ...(st.mode === "offnet" ? [] : [{ scheme: "exact", network: NETWORK, amount: st.amount, asset: USDC_SEPOLIA, payTo, maxTimeoutSeconds: 60, extra: { name: "USDC", version: "2" } }]),
    ],
  };
}

async function checkPayment(header: string): Promise<{ payer: string }> {
  const p = decodeHeaderJson(header) as {
    x402Version: number;
    accepted: { payTo: string; amount: string; network: string; asset: string };
    payload: { signature: `0x${string}`; authorization: { from: `0x${string}`; to: `0x${string}`; value: string; validAfter: string; validBefore: string; nonce: `0x${string}` } };
  };
  const a = p.payload.authorization;
  const errs: string[] = [];
  if (p.x402Version !== 2) errs.push("version");
  if (p.accepted.network !== NETWORK) errs.push("network");
  if (getAddress(a.to) !== getAddress(payTo)) errs.push("to");
  if (a.value !== st.amount) errs.push("value");
  if (BigInt(a.validBefore) <= BigInt(Math.floor(Date.now() / 1000))) errs.push("validBefore");
  if (!/^0x[0-9a-f]{64}$/i.test(a.nonce)) errs.push("nonce");
  const valid = await verifyTypedData({
    address: a.from,
    domain: { name: "USDC", version: "2", chainId: 84532, verifyingContract: getAddress(USDC_SEPOLIA) },
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
  if (!valid) errs.push("signature");
  st.verifyErrors.push(...errs);
  return { payer: a.from };
}

async function handler(req: IncomingMessage, res: ServerResponse) {
  const sig = req.headers["payment-signature"];
  if (st.mode === "free") {
    res.writeHead(200, { "content-type": "text/plain" });
    res.end("free");
    return;
  }
  if (typeof sig !== "string") {
    st.unpaidCount++;
    res.writeHead(402, { [HEADERS.V2_REQUIRED]: encodeHeaderJson(envelope(`http://test${req.url}`)), "content-type": "application/json" });
    res.end("{}");
    return;
  }
  st.paidCount++;
  st.afterSignSeenBeforeRequest.push(afterSignDone);
  const { payer } = await checkPayment(sig);
  const settle = { success: true, transaction: "0x" + "ab".repeat(32), network: NETWORK, payer };
  switch (st.mode) {
    case "ok":
      res.writeHead(200, { "content-type": "application/json", [HEADERS.V2_RESPONSE]: encodeHeaderJson(settle) });
      res.end(JSON.stringify({ ok: true }));
      return;
    case "settle_fail":
      res.writeHead(402, {
        [HEADERS.V2_RESPONSE]: encodeHeaderJson({ success: false, transaction: "", network: NETWORK, errorReason: "insufficient_funds" }),
        "cache-control": "no-store",
      });
      res.end("{}");
      return;
    case "big": {
      const size = 3 * 1024 * 1024;
      res.writeHead(200, { "content-type": "application/octet-stream", "content-length": String(size), [HEADERS.V2_RESPONSE]: encodeHeaderJson(settle) });
      const chunk = Buffer.alloc(64 * 1024, 0x61);
      let sent = 0;
      const pump = () => {
        while (sent < size) {
          sent += chunk.length;
          if (!res.write(chunk)) return void res.once("drain", pump);
        }
        res.end();
      };
      res.on("error", () => undefined);
      pump();
      return;
    }
    case "short":
      res.writeHead(200, { "content-type": "text/plain", "content-length": "1000", [HEADERS.V2_RESPONSE]: encodeHeaderJson(settle) });
      res.write("0123456789", () => setTimeout(() => res.socket?.destroy(), 20));
      return;
    case "hang":
      return; // never respond
  }
}

let server: Server;
let base: string;
let fetchCalls = 0;
const fetchImpl = (input: string | URL | Request, init?: RequestInit) => {
  fetchCalls++;
  return fetch(input, init);
};

beforeAll(async () => {
  server = createServer((req, res) => {
    handler(req, res).catch((e) => {
      st.verifyErrors.push(String(e));
      res.destroy();
    });
  });
  await new Promise<void>((r) => server.listen(0, "127.0.0.1", r));
  base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
});
afterAll(() => {
  server.closeAllConnections();
  return new Promise<void>((r) => server.close(() => r()));
});
beforeEach(() => {
  Object.assign(st, { mode: "ok", amount: "10000", unpaidCount: 0, paidCount: 0, afterSignSeenBeforeRequest: [], verifyErrors: [] });
  afterSignDone = false;
  fetchCalls = 0;
});

function makePayer(max = 1_000_000n, timeoutMs = 5000) {
  return createPayer({ privateKey: generatePrivateKey(), network: NETWORK, maxAmountAtomic: max, fetchImpl, timeoutMs });
}

function recordingHooks(decision: "proceed" | { abort: string } = "proceed") {
  const seen: { before: NormalizedRequirements[]; after: AfterSignInfo[] } = { before: [], after: [] };
  const hooks: PayHooks = {
    beforeSign: async (r) => {
      seen.before.push(r);
      return decision;
    },
    afterSign: async (info) => {
      await new Promise((r) => setTimeout(r, 30)); // simulate a durable ledger write
      seen.after.push(info);
      afterSignDone = true;
    },
  };
  return { hooks, seen };
}

describe("createPayer.payAndFetch", () => {
  it("pays via the SDK, fires afterSign before the paid request, decodes settlement", async () => {
    const payer = makePayer();
    const { hooks, seen } = recordingHooks();
    const r = await payer.payAndFetch(`${base}/ok?q=1`, { method: "GET", headers: { "X-Trace": "t" } }, hooks);
    expect(r.error).toBeUndefined();
    expect(st.verifyErrors).toEqual([]);
    expect(st.unpaidCount).toBe(1);
    expect(st.paidCount).toBe(1);
    expect(st.afterSignSeenBeforeRequest).toEqual([true]);
    expect(seen.before).toHaveLength(1);
    expect(seen.before[0]).toMatchObject({ x402Version: 2, scheme: "exact", network: NETWORK, amountAtomic: "10000", payTo });
    expect(seen.after).toHaveLength(1);
    const info = seen.after[0]!;
    expect(getAddress(info.to)).toBe(getAddress(payTo));
    expect(info.from).toBe(payer.address);
    expect(info.value).toBe("10000");
    expect(info.signature).toMatch(/^0x[0-9a-f]+$/i);
    expect(JSON.parse(info.payloadJson).payload.authorization.nonce).toBe(info.nonce);
    expect(r.signed).toEqual({ nonce: info.nonce, validAfter: info.validAfter, validBefore: info.validBefore, value: "10000", to: info.to, from: info.from });
    expect(r.quote?.amountAtomic).toBe("10000");
    expect(r.response?.status).toBe(200);
    expect(new TextDecoder().decode(r.response!.body)).toBe('{"ok":true}');
    expect(r.response?.truncatedByUs).toBe(false);
    expect(r.response?.incomplete).toBe(false);
    expect(r.response?.headers["content-type"]).toBe("application/json");
    expect(r.settlement).toMatchObject({ success: true, network: NETWORK, payer: payer.address });
    expect(r.settlementHeaderRaw).toBeDefined();
    expect(r.request.headers["payment-signature"]).toBeDefined();
    expect(r.request.headers["x-trace"]).toBe("t");
    expect(r.request.params).toEqual({ q: "1" });
    expect(r.timing.quoteMs).toBeTypeOf("number");
    expect(r.timing.signMs).toBeTypeOf("number");
    expect(r.timing.paidRequestMs).toBeTypeOf("number");
    expect(fetchCalls).toBe(2);
  });

  it("beforeSign abort prevents any signature and any paid request", async () => {
    const payer = makePayer();
    const { hooks, seen } = recordingHooks({ abort: "price too high" });
    const r = await payer.payAndFetch(`${base}/x`, {}, hooks);
    expect(r.error).toEqual({ kind: "declined", message: "price too high" });
    expect(seen.before).toHaveLength(1);
    expect(seen.after).toHaveLength(0);
    expect(r.signed).toBeUndefined();
    expect(st.paidCount).toBe(0);
    expect(st.unpaidCount).toBe(1);
  });

  it("throws CapViolation (error.kind cap) when amount > maxAmountAtomic, before signing or sending", async () => {
    st.amount = "2000000";
    const payer = makePayer(1_000_000n);
    const { hooks, seen } = recordingHooks();
    const r = await payer.payAndFetch(`${base}/x`, {}, hooks);
    expect(r.error?.kind).toBe("cap");
    expect(r.error?.message).toMatch(/2000000/);
    expect(seen.before).toHaveLength(0); // our cap check runs before the caller's hook
    expect(seen.after).toHaveLength(0);
    expect(r.signed).toBeUndefined();
    expect(st.paidCount).toBe(0);
  });

  it("does not retry when the paid request comes back 402 (settle failure)", async () => {
    st.mode = "settle_fail";
    const payer = makePayer();
    const { hooks, seen } = recordingHooks();
    const r = await payer.payAndFetch(`${base}/x`, {}, hooks);
    expect(r.error).toBeUndefined();
    expect(r.response?.status).toBe(402);
    expect(r.settlement).toMatchObject({ success: false, errorReason: "insufficient_funds" });
    expect(st.paidCount).toBe(1);
    expect(seen.after).toHaveLength(1);
  });

  it("truncates bodies at MAX_BODY_BYTES", async () => {
    st.mode = "big";
    const payer = makePayer();
    const r = await payer.payAndFetch(`${base}/x`, {}, recordingHooks().hooks);
    expect(r.error).toBeUndefined();
    expect(r.response?.truncatedByUs).toBe(true);
    expect(r.response?.body.byteLength).toBe(MAX_BODY_BYTES);
    expect(r.response?.declaredLength).toBe(3 * 1024 * 1024);
    expect(r.response?.incomplete).toBe(false);
  });

  it("sets incomplete when the body ends before Content-Length", async () => {
    st.mode = "short";
    const payer = makePayer();
    const r = await payer.payAndFetch(`${base}/x`, {}, recordingHooks().hooks);
    expect(r.response?.status).toBe(200);
    expect(r.response?.incomplete).toBe(true);
    expect(r.response?.declaredLength).toBe(1000);
    expect(r.response?.truncatedByUs).toBe(false);
    expect(new TextDecoder().decode(r.response!.body)).toBe("0123456789");
  });

  it("timeout after signing returns kind timeout with signed populated", async () => {
    st.mode = "hang";
    const payer = makePayer(1_000_000n, 300);
    const r = await payer.payAndFetch(`${base}/x`, {}, recordingHooks().hooks);
    expect(r.error?.kind).toBe("timeout");
    expect(r.signed?.nonce).toMatch(/^0x[0-9a-f]{64}$/i);
    expect(r.response).toBeUndefined();
    expect(st.paidCount).toBe(1);
  });

  it("abortAfterMs returns kind aborted with signed populated", async () => {
    st.mode = "hang";
    const payer = makePayer(1_000_000n, 5000);
    const t = Date.now();
    const r = await payer.payAndFetch(`${base}/x`, { abortAfterMs: 100 }, recordingHooks().hooks);
    expect(Date.now() - t).toBeLessThan(3000);
    expect(r.error?.kind).toBe("aborted");
    expect(r.signed?.value).toBe("10000");
    expect(st.paidCount).toBe(1);
  });

  it("network error on the quote yields kind network and no signature", async () => {
    const payer = createPayer({ privateKey: generatePrivateKey(), network: NETWORK, maxAmountAtomic: 1n, fetchImpl, timeoutMs: 2000 });
    const { hooks, seen } = recordingHooks();
    const r = await payer.payAndFetch("http://127.0.0.1:1/x", {}, hooks);
    expect(r.error?.kind).toBe("network");
    expect(seen.before).toHaveLength(0);
    expect(r.signed).toBeUndefined();
  });

  it("no exact requirement on the configured network yields no_quote without signing", async () => {
    st.mode = "offnet";
    const payer = makePayer();
    const { hooks, seen } = recordingHooks();
    const r = await payer.payAndFetch(`${base}/x`, {}, hooks);
    expect(r.error?.kind).toBe("no_quote");
    expect(r.quoteResult?.parsed?.accepts).toHaveLength(1);
    expect(seen.before).toHaveLength(0);
    expect(st.paidCount).toBe(0);
  });

  it("a non-402 unpaid response yields no_quote with the response recorded", async () => {
    st.mode = "free";
    const payer = makePayer();
    const r = await payer.payAndFetch(`${base}/x`, {}, recordingHooks().hooks);
    expect(r.error?.kind).toBe("no_quote");
    expect(r.response?.status).toBe(200);
    expect(new TextDecoder().decode(r.response!.body)).toBe("free");
    expect(st.paidCount).toBe(0);
  });
});
