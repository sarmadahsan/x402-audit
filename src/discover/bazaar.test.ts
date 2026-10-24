import { describe, expect, it } from "vitest";
import { fetchAllBazaarResources } from "./bazaar.js";

const silent = { info() {}, warn() {}, debug() {} };
const json = (body: unknown, status = 200) => new Response(JSON.stringify(body), { status, headers: { "content-type": "application/json" } });
const item = (resource: string, lastUpdated?: string) => ({ resource, type: "http", x402Version: 2, ...(lastUpdated ? { lastUpdated } : {}) });

describe("fetchAllBazaarResources", () => {
  it("retries 429/5xx/network errors with the backoff schedule, then succeeds", async () => {
    const sleeps: number[] = [];
    let n = 0;
    const fetchImpl = (async () => {
      n++;
      if (n === 1) return json({}, 429);
      if (n === 2) return json({}, 503);
      if (n === 3) throw new TypeError("fetch failed");
      return json({ items: [item("https://a.com/x")], pagination: { limit: 1000, offset: 0, total: 1 } });
    }) as unknown as typeof fetch;
    const r = await fetchAllBazaarResources({ fetchImpl, log: silent, throttleMs: 0, sleep: async (ms) => void sleeps.push(ms) });
    expect(n).toBe(4);
    expect(sleeps).toEqual([2000, 8000, 30000]);
    expect(r.items).toHaveLength(1);
  });

  it("gives up after 3 retries", async () => {
    const fetchImpl = (async () => json({}, 500)) as unknown as typeof fetch;
    await expect(fetchAllBazaarResources({ fetchImpl, log: silent, throttleMs: 0, sleep: async () => {} })).rejects.toThrow(/HTTP 500/);
  });

  it("does not retry a 4xx other than 429", async () => {
    let n = 0;
    const fetchImpl = (async () => (n++, json({}, 400))) as unknown as typeof fetch;
    await expect(fetchAllBazaarResources({ fetchImpl, log: silent, throttleMs: 0, sleep: async () => {} })).rejects.toThrow(/HTTP 400/);
    expect(n).toBe(1);
  });

  it("stops on an empty page even if total is larger, and rejects bad items without throwing", async () => {
    const urls: string[] = [];
    const fetchImpl = (async (u: string) => {
      urls.push(u);
      const offset = Number(new URL(u).searchParams.get("offset"));
      if (offset === 0)
        return json({ items: [item("https://a.com/1"), { resource: "not a url", type: "http", x402Version: 2 }, { type: "http" }, item("https://a.com/1", "2026-10-01T00:00:00Z")], pagination: { total: 99 } });
      return json({ items: [], pagination: { total: 99 } });
    }) as unknown as typeof fetch;
    const r = await fetchAllBazaarResources({ fetchImpl, log: silent, throttleMs: 0, pageSize: 4 });
    expect(urls).toEqual([
      "https://api.cdp.coinbase.com/platform/v2/x402/discovery/resources?limit=4&offset=0",
      "https://api.cdp.coinbase.com/platform/v2/x402/discovery/resources?limit=4&offset=4",
    ]);
    expect(r).toMatchObject({ pages: 2, totalReported: 99, received: 4, rejected: 2, duplicates: 1 });
    expect(r.items).toHaveLength(1);
    expect(r.items[0]!.lastUpdated).toBe("2026-10-01T00:00:00Z");
  });

  it("tolerates malformed optional fields", async () => {
    const fetchImpl = (async () =>
      json({ items: [{ ...item("https://a.com/q"), quality: "oops", tags: "x", accepts: [null, 3, { scheme: "exact" }] }], pagination: { total: 1 } })) as unknown as typeof fetch;
    const r = await fetchAllBazaarResources({ fetchImpl, log: silent, throttleMs: 0 });
    expect(r.rejected).toBe(0);
    expect(r.items[0]!.quality).toBeUndefined();
    expect(r.items[0]!.tags).toBeUndefined();
    expect(r.items[0]!.accepts).toEqual([{ scheme: "exact" }]);
  });
});
