/**
 * The Bazaar listing at purchase time (src/discover/listing.ts). The merchant endpoint lists a pay-to's entries newest
 * `lastUpdated` first, so a lookup reads one page in the common case, finds a rewritten entry at once, and knows an
 * entry is unchanged as soon as a page's oldest entry predates our snapshot of it. Changes leave `listing_changed`
 * price events; failures keep the snapshot.
 */
import { describe, expect, it } from "vitest";
import { MAINNET } from "../config/index.js";
import { openDb, type Db } from "../db/index.js";
import { upsertFromBazaar } from "./index.js";
import type { BazaarItem } from "./bazaar.js";
import { LISTING_CHANGED, ListingCache, MERCHANT_PAGE_SIZE, refreshListing } from "./listing.js";

const USDC = "0x833589fCD6eDb6E08f4c7C32D4f71b54bdA02913";
const PAY = "0xb8491F953e6860D3b5840b73c60883Ff099ceAfA";
const accept = (amount: string, payTo = PAY) => ({ scheme: "exact", network: "eip155:8453", amount, asset: USDC, payTo, maxTimeoutSeconds: 300, extra: { name: "USD Coin", version: "2" } });
const item = (resource: string, amount: string, lastUpdated: string, method = "GET") => ({
  resource, type: "http", x402Version: 2, description: "d", lastUpdated, accepts: [accept(amount)],
  quality: { l30DaysTotalCalls: 10, l30DaysUniquePayers: 2, lastCalledAt: lastUpdated },
  extensions: { bazaar: { info: { input: { type: "http", method } } } },
});
const T_SNAPSHOT = "2026-10-24T01:40:00.000Z";
const NOW = Date.parse("2026-10-25T10:27:00.000Z");

function seed(): Db {
  const db = openDb(":memory:");
  db.prepare("INSERT INTO sellers (id, domain, first_seen_at, last_seen_at) VALUES (1, 'api.seller.example', 0, 0)").run();
  const ins = db.prepare(
    "INSERT INTO resources (id, seller_id, url, method, source, network, scheme, declared_price_atomic, pay_to, raw_json, first_seen_at, last_seen_at) VALUES (?, 1, ?, 'GET', 'bazaar', ?, 'exact', ?, ?, ?, 0, 0)",
  );
  ins.run(1, "https://api.seller.example/api/macro", MAINNET, "1000", PAY, JSON.stringify({ lastUpdated: T_SNAPSHOT }));
  ins.run(2, "https://api.seller.example/api/qr", MAINNET, "1000", PAY, JSON.stringify({ lastUpdated: T_SNAPSHOT }));
  ins.run(3, "https://api.seller.example/api/old", MAINNET, "3000", PAY, JSON.stringify({ lastUpdated: "2026-10-16T08:00:00.000Z" }));
  ins.run(4, "https://api.seller.example/api/no-snapshot-time", MAINNET, "1000", PAY, "{}");
  db.prepare("INSERT INTO resources (id, seller_id, url, method, source, network, scheme, declared_price_atomic, raw_json, first_seen_at, last_seen_at) VALUES (5, 1, 'https://api.seller.example/manual', 'GET', 'manual', ?, 'exact', '1000', '{}', 0, 0)").run(MAINNET);
  return db;
}

/** A merchant endpoint over `entries` (already newest first), recording every request. */
function merchant(entries: unknown[], opts: { status?: number } = {}) {
  const urls: string[] = [];
  const fetchImpl = (async (u: string) => {
    urls.push(u);
    if (opts.status) return new Response("{}", { status: opts.status });
    const q = new URL(u).searchParams;
    expect(q.get("payTo")).toBe(PAY);
    const limit = Math.min(Number(q.get("limit")), MERCHANT_PAGE_SIZE);
    const offset = Number(q.get("offset") ?? 0);
    return new Response(JSON.stringify({ payTo: PAY, x402Version: 2, pagination: { limit, offset, total: entries.length }, resources: entries.slice(offset, offset + limit) }), { status: 200, headers: { "content-type": "application/json" } });
  }) as unknown as typeof fetch;
  return { fetchImpl, urls };
}

describe("refreshListing", () => {
  it("adopts a listing rewritten since the snapshot and records a listing_changed event", async () => {
    const db = seed();
    const m = merchant([item("https://api.seller.example/api/macro", "2000", "2026-10-25T08:48:11.000Z"), item("https://api.seller.example/api/other", "2000", "2026-10-25T07:00:00.000Z"), item("https://api.seller.example/api/qr", "1000", "2026-10-24T01:40:00.000Z")]);
    const r = await refreshListing(db, { resourceId: 1, now: NOW, fetchImpl: m.fetchImpl });
    expect(r).toMatchObject({ status: "updated", resourceId: 1, payTo: PAY, amountAtomic: "2000", previousAmountAtomic: "1000", lastUpdated: "2026-10-25T08:48:11.000Z", pages: 1 });
    expect(db.prepare("SELECT declared_price_atomic, json_extract(raw_json, '$.lastUpdated') lu FROM resources WHERE id = 1").get()).toEqual({ declared_price_atomic: "2000", lu: "2026-10-25T08:48:11.000Z" });
    const ev = db.prepare("SELECT resource_id, kind, old_value, new_value, details_json FROM price_events").all() as { resource_id: number; kind: string; old_value: string; new_value: string; details_json: string }[];
    expect(ev).toHaveLength(1);
    expect(ev[0]).toMatchObject({ resource_id: 1, kind: LISTING_CHANGED, old_value: "1000", new_value: "2000" });
    expect(JSON.parse(ev[0]!.details_json)).toMatchObject({ lastUpdated: "2026-10-25T08:48:11.000Z", previousLastUpdated: T_SNAPSHOT, via: "buy_refresh" });
    // The unchanged sibling in the same page kept its price; nothing recorded for it.
    expect(db.prepare("SELECT declared_price_atomic FROM resources WHERE id = 2").get()).toEqual({ declared_price_atomic: "1000" });
  });

  it("stops after one page when the page's oldest entry predates the snapshot and the target is not in it", async () => {
    const db = seed();
    const entries = [item("https://api.seller.example/api/macro", "2000", "2026-10-25T08:48:11.000Z"), item("https://api.seller.example/api/other", "2000", "2026-10-21T22:00:00.000Z"), item("https://api.seller.example/api/qr", "1000", "2026-10-16T00:00:00.000Z")];
    const m = merchant(entries);
    const r = await refreshListing(db, { resourceId: 2, now: NOW, fetchImpl: m.fetchImpl });
    expect(r).toMatchObject({ status: "unchanged", amountAtomic: "1000", pages: 1 });
    expect(m.urls).toHaveLength(1);
    // The rewritten sibling seen on the way was refreshed too.
    expect(db.prepare("SELECT declared_price_atomic FROM resources WHERE id = 1").get()).toEqual({ declared_price_atomic: "2000" });
    expect((db.prepare("SELECT COUNT(*) n FROM price_events WHERE kind = ?").get(LISTING_CHANGED) as { n: number }).n).toBe(1);
  });

  it("pages until the entry is found, and reports an entry that is no longer listed", async () => {
    const db = seed();
    const filler = Array.from({ length: 2 * MERCHANT_PAGE_SIZE }, (_, k) => item(`https://api.seller.example/api/f${k}`, "2000", new Date(Date.parse("2026-10-25T09:00:00Z") - k * 1000).toISOString()));
    const m = merchant([...filler, item("https://api.seller.example/api/old", "4000", "2026-10-20T00:00:00.000Z")]);
    const r = await refreshListing(db, { resourceId: 3, now: NOW, fetchImpl: m.fetchImpl });
    expect(r).toMatchObject({ status: "updated", amountAtomic: "4000", previousAmountAtomic: "3000", pages: 3 });
    expect(m.urls.map((u) => new URL(u).searchParams.get("offset"))).toEqual(["0", "100", "200"]);

    const m2 = merchant(filler.slice(0, 50));
    const r2 = await refreshListing(seed(), { resourceId: 3, now: NOW, fetchImpl: m2.fetchImpl });
    expect(r2).toMatchObject({ status: "not_listed", pages: 1 });
  });

  it("gives up after maxPages when the snapshot has no time, and skips resources without a listed pay-to", async () => {
    const db = seed();
    const filler = Array.from({ length: 3 * MERCHANT_PAGE_SIZE }, (_, k) => item(`https://api.seller.example/api/f${k}`, "2000", new Date(Date.parse("2026-10-25T09:00:00Z") - k * 1000).toISOString()));
    const m = merchant(filler);
    const r = await refreshListing(db, { resourceId: 4, now: NOW, fetchImpl: m.fetchImpl, maxPages: 2 });
    expect(r).toMatchObject({ status: "skipped", pages: 2 });
    expect(r.reason).toMatch(/not found in the 200 most recently updated entries/);
    expect(db.prepare("SELECT declared_price_atomic FROM resources WHERE id = 4").get()).toEqual({ declared_price_atomic: "1000" });
    const s = await refreshListing(db, { resourceId: 5, now: NOW, fetchImpl: m.fetchImpl });
    expect(s).toMatchObject({ status: "skipped", pages: 0, payTo: null });
    expect(m.urls).toHaveLength(2);
  });

  it("keeps the snapshot on an HTTP or network failure and never throws", async () => {
    const db = seed();
    const warnings: string[] = [];
    const r = await refreshListing(db, { resourceId: 1, now: NOW, fetchImpl: merchant([], { status: 503 }).fetchImpl, log: { info() {}, warn: (m) => warnings.push(m) } });
    expect(r).toMatchObject({ status: "error", pages: 0 });
    expect(r.reason).toMatch(/HTTP 503/);
    expect(warnings[0]).toMatch(/snapshot kept/);
    const boom = (async () => { throw new Error("ECONNRESET"); }) as unknown as typeof fetch;
    expect(await refreshListing(db, { resourceId: 1, now: NOW, fetchImpl: boom })).toMatchObject({ status: "error", reason: "ECONNRESET" });
    expect(db.prepare("SELECT declared_price_atomic FROM resources WHERE id = 1").get()).toEqual({ declared_price_atomic: "1000" });
  });

  it("reuses the pages for a pay-to within the cache TTL and refetches after an invalidation (our own settlement)", async () => {
    const db = seed();
    const m = merchant([item("https://api.seller.example/api/macro", "2000", "2026-10-25T08:48:11.000Z"), item("https://api.seller.example/api/qr", "1000", "2026-10-16T00:00:00.000Z")]);
    const cache = new ListingCache(60_000);
    await refreshListing(db, { resourceId: 1, now: NOW, fetchImpl: m.fetchImpl, cache });
    await refreshListing(db, { resourceId: 2, now: NOW + 1000, fetchImpl: m.fetchImpl, cache });
    expect(m.urls).toHaveLength(1);
    cache.invalidate(PAY.toLowerCase());
    await refreshListing(db, { resourceId: 2, now: NOW + 2000, fetchImpl: m.fetchImpl, cache });
    expect(m.urls).toHaveLength(2);
    await refreshListing(db, { resourceId: 2, now: NOW + 2000 + 61_000, fetchImpl: m.fetchImpl, cache });
    expect(m.urls).toHaveLength(3);
  });
});

describe("discover refresh records listing_changed", () => {
  it("writes one price event per resource whose listed price moved between crawls, none for new or unchanged ones", () => {
    const db = openDb(":memory:");
    const raw = (resource: string, amount: string, lu: string) => ({ ...item(resource, amount, lu), raw: item(resource, amount, lu) }) as unknown as BazaarItem;
    upsertFromBazaar(db, [raw("https://api.seller.example/api/macro", "1000", "2026-10-21T00:00:00Z"), raw("https://api.seller.example/api/qr", "1000", "2026-10-21T00:00:00Z")], 1);
    expect((db.prepare("SELECT COUNT(*) n FROM price_events").get() as { n: number }).n).toBe(0);
    upsertFromBazaar(db, [raw("https://api.seller.example/api/macro", "2000", "2026-10-25T08:48:11Z"), raw("https://api.seller.example/api/qr", "1000", "2026-10-21T00:00:00Z"), raw("https://api.seller.example/api/new", "500", "2026-10-25T00:00:00Z")], 2);
    const ev = db.prepare("SELECT r.url, e.kind, e.old_value, e.new_value, e.ts, e.details_json FROM price_events e JOIN resources r ON r.id = e.resource_id").all() as { url: string; kind: string; old_value: string; new_value: string; ts: number; details_json: string }[];
    expect(ev).toHaveLength(1);
    expect(ev[0]).toMatchObject({ url: "https://api.seller.example/api/macro", kind: LISTING_CHANGED, old_value: "1000", new_value: "2000", ts: 2 });
    expect(JSON.parse(ev[0]!.details_json)).toEqual({ lastUpdated: "2026-10-25T08:48:11Z", via: "discover" });
  });
});
