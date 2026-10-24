/**
 * End-to-end against the mock seller: official client -> ledger -> validators
 * -> settlement lookup -> classifier -> SQLite. One case per mock route, each
 * asserting the taxonomy outcome the route is designed to trigger.
 */
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { generatePrivateKey } from "viem/accounts";
import { openDb, type Db } from "../src/db/index.js";
import { runPaidCall, resolveIndeterminate, type SettlementFact, type SettlementLookup } from "../src/pipeline/paidCall.js";
import { createPayer, type Payer } from "../src/x402/pay.js";
import { fetchQuote, selectRequirements } from "../src/x402/quote.js";
import { startMockSeller, type MockSeller } from "../tools/mock-seller/server.js";
import type { ServiceConfig } from "../src/validators/types.js";

let seller: MockSeller;
let db: Db;
let payer: Payer;
let resourceId = 0;
const NETWORK = "eip155:84532" as const;
const LISTED = "10000";

const service: ServiceConfig = {
  domain: "127.0.0.1",
  json_schema: {
    type: "object",
    required: ["symbol", "price", "timestamp"],
    properties: { symbol: { type: "string" }, price: { type: "number" }, timestamp: { type: "string" } },
  },
  entity: { request_param: "symbol", response_path: "$.symbol" },
  freshness: { response_path: "$.timestamp", max_age_seconds: 3600 },
};

const lookupFromMock: SettlementLookup = async (signed) =>
  seller
    .settlements()
    .filter((s) => s.nonce.toLowerCase() === signed.nonce.toLowerCase())
    .map<SettlementFact>((s) => ({ txHash: s.txHash, from: s.from, to: s.to, valueAtomic: s.value, nonce: s.nonce, source: "mock" }));

function call(path: string, extra: Partial<Parameters<typeof runPaidCall>[0]> = {}) {
  const url = seller.url + path;
  const existing = db.prepare("SELECT id FROM resources WHERE url = ? AND method = 'GET' AND source = 'manual'").get(url) as { id: number } | undefined;
  if (existing) resourceId = existing.id;
  else {
    resourceId = (db.prepare("SELECT COALESCE(MAX(id),0)+1 id FROM resources").get() as { id: number }).id;
    db.prepare("INSERT INTO resources (id, seller_id, url, source, raw_json, first_seen_at, last_seen_at) VALUES (?, 1, ?, 'manual', '{}', 0, 0)").run(resourceId, url);
  }
  return runPaidCall({
    db,
    payer,
    source: "buy",
    resource: { id: resourceId, sellerId: 1, url: seller.url + path },
    reference: { amountAtomic: LISTED, source: "bazaar" },
    perCallCapAtomic: 500_000n,
    service,
    defaultMaxTimeoutSeconds: 30,
    settlementLookup: lookupFromMock,
    timeoutMs: 5_000,
    ...extra,
  });
}

beforeAll(async () => {
  seller = await startMockSeller({ port: 0, network: NETWORK, listedPriceAtomic: LISTED });
  db = openDb(":memory:");
  db.prepare("INSERT INTO sellers (id, domain, first_seen_at, last_seen_at) VALUES (1, '127.0.0.1', 0, 0)").run();
  payer = createPayer({ privateKey: generatePrivateKey(), network: NETWORK, maxAmountAtomic: 500_000n, timeoutMs: 5_000 });
});
afterAll(async () => {
  await seller.close();
  db.close();
});

describe("e2e against the mock seller", () => {
  it("ok: paid, delivered, every validator passes, one settlement, ledger has planned+signed rows", async () => {
    const o = await call("/ok?symbol=BTC");
    expect(o.classification.outcome).toBe("ok");
    expect(o.classification.flags).toEqual([]);
    expect(o.settlements).toHaveLength(1);
    expect(Object.values(o.validators!).every((v) => v.status === "pass")).toBe(true);
    const attempts = db.prepare("SELECT phase, nonce FROM attempts WHERE intent_id = ? ORDER BY id").all(o.intentId) as { phase: string; nonce: string | null }[];
    expect(attempts.map((a) => a.phase)).toEqual(["planned", "signed"]);
    expect(attempts[1]!.nonce).toBe(o.result.signed!.nonce);
    const row = db.prepare("SELECT outcome, paid, settlement_count, response_body_sha256, settlement_tx_hash FROM calls WHERE id = ?").get(o.callId) as any;
    expect(row.outcome).toBe("ok");
    expect(row.paid).toBe(1);
    expect(row.settlement_count).toBe(1);
    expect(row.settlement_tx_hash).toBe(o.settlements[0]!.txHash);
    expect(row.response_body_sha256).toMatch(/^[0-9a-f]{64}$/);
    expect(db.prepare("SELECT COUNT(*) c FROM validator_results WHERE call_id = ?").get(o.callId)).toEqual({ c: 8 });
  });

  it("non_delivery: 500 after settlement", async () => {
    const o = await call("/fail/500-after-settle?symbol=BTC");
    expect(o.classification.outcome).toBe("non_delivery");
    expect(o.settlements).toHaveLength(1);
    expect(o.validators!.http_status.status).toBe("fail");
  });

  it("non_delivery: empty body, wrong content type, truncated, unterminated json", async () => {
    for (const p of ["/fail/empty", "/fail/wrong-content-type", "/fail/truncate", "/fail/not-json"]) {
      const o = await call(`${p}?symbol=BTC`);
      expect(o.classification.outcome, p).toBe("non_delivery");
      expect(o.settlements, p).toHaveLength(1);
    }
  });

  it("wrong_goods: wrong entity and stale timestamp; schema_missing when no service config", async () => {
    const wrong = await call("/fail/wrong-entity?symbol=BTC");
    expect(wrong.classification.outcome).toBe("wrong_goods");
    expect(wrong.validators!.entity_matches.status).toBe("fail");
    const stale = await call("/fail/stale?symbol=BTC");
    expect(stale.classification.outcome).toBe("wrong_goods");
    expect(stale.validators!.freshness.status).toBe("fail");
    const noCfg = await call("/fail/wrong-entity?symbol=BTC", { service: undefined });
    expect(noCfg.classification.outcome).toBe("ok");
    expect(noCfg.classification.flags).toContain("schema_missing");
  });

  it("overcharge: quote 10x the listed price, still paid and delivered", async () => {
    const o = await call("/fail/overcharge?symbol=BTC");
    expect(o.classification.outcome).toBe("overcharge");
    expect(o.classification.overchargeRatio).toBeCloseTo(10, 6);
    expect(o.result.signed?.value).toBe("100000");
    expect(o.settlements).toHaveLength(1);
  });

  it("overcharge over the per-call cap is refused before signing and flagged unpaid_overcharge", async () => {
    const o = await call("/fail/overcharge?symbol=BTC", { perCallCapAtomic: 50_000n });
    expect(o.classification.outcome).toBe("overcharge");
    expect(o.classification.flags).toContain("unpaid_overcharge");
    expect(o.result.signed).toBeUndefined();
    expect(o.settlements).toHaveLength(0);
    expect(db.prepare("SELECT COUNT(*) c FROM attempts WHERE intent_id = ?").get(o.intentId)).toEqual({ c: 0 });
  });

  it("injection: valid data with an instruction string is flagged, not ok", async () => {
    const o = await call("/fail/inject?symbol=BTC");
    expect(o.classification.outcome).toBe("injection");
    expect(o.classification.flags).toContain("injection_hit");
    const hits = (o.validators!.injection_scan.evidence as any).hits;
    expect(hits.length).toBeGreaterThan(0);
    expect(hits.some((h: any) => h.match.toLowerCase().includes("ignore previous instructions"))).toBe(true);
  });

  it("duplicate: the same authorization settled twice", async () => {
    const o = await call("/fail/double-settle?symbol=BTC");
    expect(o.classification.outcome).toBe("duplicate");
    expect(o.settlements).toHaveLength(2);
    expect(db.prepare("SELECT COUNT(*) c FROM settlements WHERE intent_id = ?").get(o.intentId)).toEqual({ c: 2 });
  });

  it("not_paid: seller rejects the payment and never settles", async () => {
    const o = await call("/fail/reject?symbol=BTC");
    expect(o.classification.outcome).toBe("not_paid");
    expect(o.result.response?.status).toBe(402);
    expect(o.settlements).toHaveLength(0);
  });

  it("slow: delivered after the declared maxTimeoutSeconds", async () => {
    const o = await call("/fail/slow?symbol=BTC");
    expect(o.classification.outcome).toBe("ok");
    expect(o.classification.flags).toContain("slow");
  }, 15_000);

  it("indeterminate: seller hangs after payment, settlement not yet visible; resolves to non_delivery later", async () => {
    const pending: SettlementLookup = async () => [];
    const o = await call("/fail/hang-after-payment?symbol=BTC", { timeoutMs: 1_500, settlementLookup: pending });
    expect(o.result.error?.kind).toBe("timeout");
    expect(o.result.signed).toBeDefined();
    expect(o.classification.outcome).toBe("indeterminate");
    const row = db.prepare("SELECT resolve_until FROM calls WHERE id = ?").get(o.callId) as any;
    expect(row.resolve_until).toBeGreaterThan(Date.now());
    // Background poller later finds the settlement on chain:
    const found = await lookupFromMock(o.result.signed!);
    expect(found).toHaveLength(1);
    const resolved = resolveIndeterminate(db, o.callId, found, 30);
    expect(resolved.outcome).toBe("non_delivery");
    expect(resolved.flags).toContain("resolved_late");
    expect(db.prepare("SELECT outcome FROM calls WHERE id = ?").get(o.callId)).toEqual({ outcome: "non_delivery" });
  });

  it("payto_changed and price_discrimination are detectable from two unpaid quotes", async () => {
    const a = await fetchQuote(seller.url + "/fail/payto-change");
    const b = await fetchQuote(seller.url + "/fail/payto-change");
    const pa = selectRequirements(a.parsed!.accepts, { network: NETWORK, scheme: "exact" })!.payTo;
    const pb = selectRequirements(b.parsed!.accepts, { network: NETWORK, scheme: "exact" })!.payTo;
    expect(pa).not.toBe(pb);
    const ia = await fetchQuote(seller.url + "/fail/price-discriminate", { headers: { "user-agent": "x402-audit identity-a" } });
    const ib = await fetchQuote(seller.url + "/fail/price-discriminate", { headers: { "user-agent": "x402-audit identity-b" } });
    const qa = selectRequirements(ia.parsed!.accepts, { network: NETWORK, scheme: "exact" })!.amountAtomic;
    const qb = selectRequirements(ib.parsed!.accepts, { network: NETWORK, scheme: "exact" })!.amountAtomic;
    expect(BigInt(qb)).toBe(BigInt(qa) * 2n);
    const o = await call("/ok?symbol=BTC", { payToChanged: pa !== pb, priceDiscrimination: qa !== qb });
    expect(o.classification.outcome).toBe("ok");
    expect(o.classification.flags).toEqual(expect.arrayContaining(["payto_changed", "price_discrimination"]));
  });

  it("stress shape: aborting 300 ms after the paid request still leaves a ledger row and a settlement", async () => {
    const o = await call("/fail/slow?symbol=BTC", { source: "stress_timeout", abortAfterMs: 300 });
    expect(o.result.error?.kind).toBe("aborted");
    expect(o.result.signed).toBeDefined();
    expect(o.settlements).toHaveLength(1);
    expect(o.classification.outcome).toBe("non_delivery");
    expect(db.prepare("SELECT source FROM calls WHERE id = ?").get(o.callId)).toEqual({ source: "stress_timeout" });
  });
});

describe("reclassify from stored rows", () => {
  it("restores the right outcome after a validator fix (simulated by corrupting a row)", async () => {
    const { reclassifyCalls } = await import("../src/pipeline/reclassify.js");
    const o = await call("/ok?symbol=ETH");
    expect(o.classification.outcome).toBe("ok");
    db.prepare("UPDATE calls SET outcome = 'non_delivery', flags_json = '[\"slow\"]' WHERE id = ?").run(o.callId);
    const dry = await reclassifyCalls(db, { reason: "test", apply: false, callIds: [o.callId], services: () => service });
    expect(dry.changed.map((c) => [c.oldOutcome, c.newOutcome])).toEqual([["non_delivery", "ok"]]);
    expect(db.prepare("SELECT outcome FROM calls WHERE id = ?").get(o.callId)).toEqual({ outcome: "non_delivery" });
    const applied = await reclassifyCalls(db, { reason: "test", apply: true, callIds: [o.callId], services: () => service });
    expect(applied.changed).toHaveLength(1);
    expect(db.prepare("SELECT outcome, flags_json FROM calls WHERE id = ?").get(o.callId)).toEqual({ outcome: "ok", flags_json: "[]" });
    expect(db.prepare("SELECT reason, old_outcome, new_outcome FROM reclassifications WHERE call_id = ?").get(o.callId)).toEqual({ reason: "test", old_outcome: "non_delivery", new_outcome: "ok" });
    const again = await reclassifyCalls(db, { reason: "test", apply: false, callIds: [o.callId], services: () => service });
    expect(again.changed).toHaveLength(0);
  });
});
