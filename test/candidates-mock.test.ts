/**
 * `discover import-candidates`: parse the index's list, import only URLs we do not know, probe each once (free) against
 * the mock seller, and classify queued / too_expensive / not_x402. A 404 from the index is a no-op.
 */
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { openDb, type Db } from "../src/db/index.js";
import { startMockSeller, type MockSeller } from "../tools/mock-seller/server.js";
import { candidateUrl, fetchCandidates, importCandidates, parseCandidates, probeCandidates } from "../src/discover/candidates.js";
import { listTooExpensive } from "../src/buy/states.js";
import { buildBuyPlan } from "../src/buy/plan.js";
import { usdToAtomic } from "../src/config/index.js";

const NETWORK = "eip155:84532";
let seller: MockSeller;
let db: Db;

beforeAll(async () => {
  seller = await startMockSeller({ port: 0, network: NETWORK, listedPriceAtomic: "10000" });
  db = openDb(":memory:");
});
afterAll(async () => {
  await seller.close();
  db.close();
});

describe("candidate URLs", () => {
  it("keeps scheme, host and path only", () => {
    expect(candidateUrl("API.Example.com", "/v1/quote?x=1#f")).toBe("https://api.example.com/v1/quote");
    expect(candidateUrl("example.com", null)).toBe("https://example.com/");
    expect(candidateUrl("example.com", "https://other.com/x")).toBeNull();
    expect(candidateUrl("not a host", "/x")).toBeNull();
    expect(candidateUrl("localhost", "/x")).toBeNull();
  });

  it("reads the Prompt 10 shape and a bare host", () => {
    const items = parseCandidates({
      days: 30,
      candidates: [
        { host: "a.example", checks: 9, payments: 1, paths: [{ path: "/p1", checks: 5, payments: 1, first_seen: "2026-10-20", last_seen: "2026-10-28" }, { path: "/p2?q=1", checks: 4 }] },
        { host: "b.example", checks: 2, payments: 0, first_seen: "2026-10-27", last_seen: "2026-10-28", paths: [] },
        { nothing: true },
      ],
    });
    expect(items.map((i) => [i.url, i.checks, i.payments])).toEqual([
      ["https://a.example/p1", 5, 1],
      ["https://a.example/p2", 4, 0],
      ["https://b.example/", 2, 0],
    ]);
  });

  it("a 404 from the index is not_live, not an error", async () => {
    const r = await fetchCandidates("https://index.test", async () => new Response("<html>", { status: 404 }));
    expect(r).toEqual({ status: "not_live" });
  });
});

describe("import and probe against the mock seller", () => {
  it("imports unknown URLs as source user, then classifies each with one unpaid quote", async () => {
    const base = new URL(seller.url);
    // The mock listens on 127.0.0.1, which candidateUrl refuses for real imports; insert its items directly.
    const items = [
      { url: `${seller.url}/ok`, host: base.host, checks: 7, payments: 2, first_seen: null, last_seen: null },
      { url: `${seller.url}/fail/overcharge`, host: base.host, checks: 3, payments: 0, first_seen: null, last_seen: null },
      { url: `${seller.url}/__mock/catalog`, host: base.host, checks: 1, payments: 0, first_seen: null, last_seen: null },
    ];
    db.prepare("INSERT INTO sellers (id, domain, first_seen_at, last_seen_at) VALUES (50, 'known.example', 0, 0)").run();
    db.prepare("INSERT INTO resources (seller_id, url, source, raw_json, first_seen_at, last_seen_at) VALUES (50, 'https://known.example/r', 'bazaar', '{}', 0, 0)").run();
    const st = importCandidates(db, [...items, { url: "https://known.example/r", host: "known.example", checks: 4, payments: 0, first_seen: null, last_seen: null }], 1_000);
    expect(st).toMatchObject({ received: 4, alreadyKnown: 1, imported: 3, newSellers: 1 });
    expect((db.prepare("SELECT COUNT(*) n FROM resources WHERE source = 'user'").get() as { n: number }).n).toBe(3);

    // Re-import refreshes counts and adds nothing.
    const again = importCandidates(db, [{ ...items[0]!, checks: 11 }], 2_000);
    expect(again).toMatchObject({ imported: 0, updated: 1 });

    const probed = await probeCandidates(db, { perCallCapAtomic: usdToAtomic(0.1), network: NETWORK, timeoutMs: 5_000 });
    const byUrl = Object.fromEntries(probed.map((p) => [new URL(p.url).pathname, p.state]));
    expect(byUrl["/ok"]).toBe("queued");
    expect(byUrl["/__mock/catalog"]).toBe("not_x402");
    // The overcharge route quotes above its listing; at a 0.01 cap it is too expensive.
    const strict = await probeCandidates(db, { perCallCapAtomic: usdToAtomic(0.005), network: NETWORK, timeoutMs: 5_000, all: true });
    expect(strict.filter((p) => p.state === "too_expensive").length).toBeGreaterThanOrEqual(1);
    expect(listTooExpensive(db).length).toBeGreaterThanOrEqual(1);
    const row = db.prepare("SELECT network, scheme, declared_price_atomic FROM resources WHERE url = ?").get(`${seller.url}/ok`) as { network: string; scheme: string; declared_price_atomic: string };
    expect(row).toEqual({ network: NETWORK, scheme: "exact", declared_price_atomic: "10000" });
  });

  it("user resources never enter the stratified plan", () => {
    const plan = buildBuyPlan(db, {
      sample: { target_calls: 10, max_total_usd: 1, tiers: { top: { size: 5, share: 0.5 }, tail: { size: 5, share: 0.5 } }, categories: ["other"], price_floor_usd: 0.001, max_share_per_resource: 1, max_resources_per_seller: 10, max_calls_per_seller: 10, seed: 1, min_seconds_between_calls_per_resource: 60 },
      caps: { perCallAtomic: usdToAtomic(0.5), perSellerPerDayAtomic: usdToAtomic(20), perDayAtomic: usdToAtomic(100), totalAtomic: usdToAtomic(300), stressTotalAtomic: usdToAtomic(30), auditPerDayAtomic: usdToAtomic(5) },
      network: NETWORK,
      persistTiers: false,
    });
    expect(plan.allocations).toEqual([]);
  });
});
