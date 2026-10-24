import { describe, expect, it } from "vitest";
import { openDb } from "../db/index.js";
import { discoverReport, formatUsd, listPayTos, runDiscover, selectAccept, upsertManual } from "./index.js";

const silent = { info() {}, warn() {}, debug() {} };
const USDC = "0x833589fCD6eDb6E08f4c7C32D4f71b54bdA02913";
const PAY_A = "0x7284D41b5b852F2bd4c99bDf95043D84452d299C";
const PAY_B = "0xe9030014F5DAe217d0A152f02A043567b16c1aBf";
const baseAccept = (payTo: string, amount: string, extra: Record<string, unknown> = { name: "USD Coin", version: "2" }) => ({
  scheme: "exact", network: "eip155:8453", amount, asset: USDC, payTo, maxTimeoutSeconds: 300, extra,
});
const quality = (calls: number, payers = 1) => ({ l30DaysTotalCalls: calls, l30DaysUniquePayers: payers, lastCalledAt: "2026-10-21T09:39:38.381Z" });

// Modelled on the real items in docs/protocol-notes.md Part 2 §A and the 2026-10-23 smoke call.
const verdict = {
  resource: "https://www.ax1.vc/api/dashboard/q-verdict/resource", type: "http", x402Version: 2, serviceName: "AX1 Console",
  description: "Send a Base token contract address, get an AI-written verdict", lastUpdated: "2026-10-11T14:48:09.674Z",
  tags: ["agents", "token", "verdict"], quality: quality(238665, 2608), accepts: [baseAccept(PAY_A, "20000")],
  extensions: { bazaar: { info: { input: { type: "http", method: "POST", bodyType: "json", body: { address: "0x..." } }, output: { type: "json", example: { verdict: "ok" } } }, schema: {} } },
};
const ax1Second = {
  resource: "https://ax1.vc/api/other", type: "http", x402Version: 2, description: "Token price lookup",
  quality: quality(10), accepts: [baseAccept(PAY_A.toLowerCase(), "1000")],
  extensions: { bazaar: { info: { input: { type: "http", method: "GET" } } } },
};
const chatV1 = {
  resource: "https://blockrun.ai/api/v1/chat/completions", type: "http", x402Version: 2, curated: true, serviceName: "BlockRun.AI",
  description: "AI chat completions API", lastUpdated: "2026-10-01T00:00:00.000Z", tags: ["ai", "inference", "llm", "gateway"],
  quality: quality(80000, 290), accepts: [baseAccept(PAY_B, "2000")],
  extensions: { bazaar: { info: { input: { type: "http", method: "POST" } } } },
};
const chatV2 = { ...chatV1, lastUpdated: "2026-10-23T21:58:43.669Z", quality: quality(84716, 291) };
const permit2 = {
  resource: "https://p2.example/api/scrape", type: "http", x402Version: 2, description: "Scrape a page",
  quality: quality(50), accepts: [baseAccept("0x1111111111111111111111111111111111111111", "5000", { name: "USD Coin", version: "2", assetTransferMethod: "permit2" })],
};
const solanaOnly = {
  resource: "https://sol.example/weather", type: "http", x402Version: 2, description: "Weather",
  quality: quality(7), accepts: [{ scheme: "exact", network: "solana:5eykt4UsFv8P8NJdTREpY1vzqKqZKvdp", amount: "1000", asset: "EPj", payTo: "So1", maxTimeoutSeconds: 60 }],
};
const malformed = {
  resource: "https://mal.example/gpu", type: "http", x402Version: 2, description: "GPU compute",
  quality: quality(3),
  // first Base-exact entry has no amount: skipped; second is valid and gets selected
  accepts: ["junk", { scheme: "exact", network: "eip155:8453", asset: USDC, payTo: "0x2222222222222222222222222222222222222222" }, baseAccept("0x3333333333333333333333333333333333333333", "7000")],
};
const excludedItem = {
  resource: "http://localhost:4021/data", type: "http", x402Version: 2, description: "local data",
  quality: quality(1), accepts: [baseAccept("0x4444444444444444444444444444444444444444", "1000")],
};
const rejected = { type: "http", x402Version: 2 }; // no resource

const PAGES = [
  [verdict, chatV1, permit2],
  [solanaOnly, malformed, chatV2, rejected],
  [excludedItem, ax1Second],
];
const TOTAL = PAGES.flat().length;

function fakeFetch() {
  const calls: string[] = [];
  const fetchImpl = (async (u: string) => {
    calls.push(u);
    const offset = Number(new URL(u).searchParams.get("offset"));
    let start = 0;
    let page: unknown[] = [];
    for (const p of PAGES) {
      if (start === offset) page = p;
      start += p.length;
    }
    return new Response(JSON.stringify({ x402Version: 2, items: page, pagination: { limit: 1000, offset, total: TOTAL } }), { status: 200 });
  }) as unknown as typeof fetch;
  return { fetchImpl, calls };
}

const exclude = { sellers: [{ domain: "localhost", reason: "local only" }], resource_prefixes: [] };
const manual = [
  { url: "https://manual.example/api/news", method: "get", seller_domain: "manual.example", category: "data", declared_price_atomic: "10000", asset: USDC, network: "base", pay_to: PAY_A, description: "" },
];

function setup() {
  const db = openDb(":memory:");
  const f = fakeFetch();
  const run = (now: number) => runDiscover(db, { fetchImpl: f.fetchImpl, manual, exclude, log: silent, now: () => now, throttleMs: 0 });
  return { db, f, run };
}
const res = (db: ReturnType<typeof openDb>, url: string) => db.prepare("SELECT * FROM resources WHERE url = ?").get(url) as Record<string, any>;
const seller = (db: ReturnType<typeof openDb>, domain: string) => db.prepare("SELECT * FROM sellers WHERE domain = ?").get(domain) as Record<string, any>;

describe("runDiscover", () => {
  it("pages, de-duplicates, upserts and aggregates", async () => {
    const { db, f, run } = setup();
    const s = await run(1000);
    expect(f.calls).toHaveLength(3);
    expect(s.bazaar).toMatchObject({ pages: 3, totalReported: TOTAL, received: TOTAL, rejected: 1, duplicates: 1, unique: 7 });
    expect(s.bazaar).toMatchObject({ resourcesNew: 7, resourcesSeen: 0, sellersNew: 6, sellersSeen: 0, skippedNoBaseExact: 1, permit2: 1, excludedSellers: 1 });
    expect(s.manual).toMatchObject({ resourcesNew: 1, sellersNew: 1 });

    // www. stripped, both ax1 resources under one seller
    const ax1 = seller(db, "ax1.vc");
    expect(ax1.calls_30d_bazaar).toBe(238665 + 10);
    expect(ax1.category).toBe("data");

    const v = res(db, verdict.resource);
    expect(v).toMatchObject({ method: "POST", source: "bazaar", scheme: "exact", network: "eip155:8453", declared_price_atomic: "20000", pay_to: PAY_A, transfer_method: "eip3009", bazaar_calls_30d: 238665, bazaar_unique_payers_30d: 2608, last_called_at: Date.parse("2026-10-21T09:39:38.381Z"), category: "data", category_reason: "tag:token", max_timeout_seconds: 300, curated: 0 });
    expect(JSON.parse(v.input_json)).toMatchObject({ method: "POST", bodyType: "json" });
    expect(JSON.parse(v.output_schema_json)).toMatchObject({ type: "json" });
    expect(JSON.parse(v.raw_json)).toEqual(verdict);

    // newer duplicate wins
    const chat = res(db, chatV1.resource);
    expect(chat).toMatchObject({ bazaar_calls_30d: 84716, method: "POST", category: "inference", category_reason: "tag:llm", curated: 1 });

    expect(res(db, permit2.resource)).toMatchObject({ transfer_method: "permit2", category: "scraping" });
    expect(res(db, solanaOnly.resource)).toMatchObject({ network: "solana:5eykt4UsFv8P8NJdTREpY1vzqKqZKvdp", scheme: null, pay_to: null, declared_price_atomic: null, transfer_method: null, method: "GET" });
    expect(seller(db, "sol.example").calls_30d_bazaar).toBeNull();

    const mal = res(db, malformed.resource);
    expect(mal).toMatchObject({ pay_to: "0x3333333333333333333333333333333333333333", declared_price_atomic: "7000", category: "compute" });
    expect(JSON.parse(mal.accepts_json)).toHaveLength(3);

    expect(seller(db, "localhost")).toMatchObject({ excluded: 1, excluded_reason: "exclude.yaml: local only" });
    expect(seller(db, "manual.example")).toMatchObject({ category: "data", excluded: 0 });
    expect(res(db, manual[0]!.url)).toMatchObject({ method: "GET", source: "manual", network: "eip155:8453", category_reason: "manual" });

    const meta = Object.fromEntries((db.prepare("SELECT key, value FROM meta").all() as { key: string; value: string }[]).map((r) => [r.key, r.value]));
    expect(meta.discover_last_run_at).toBe("1000");
    expect(meta.discover_last_total).toBe(String(TOTAL));
  });

  it("is idempotent on a second run", async () => {
    const { db, run } = setup();
    await run(1000);
    const s = await run(2000);
    expect(s.bazaar).toMatchObject({ resourcesNew: 0, resourcesSeen: 7, sellersNew: 0, sellersSeen: 6 });
    expect(s.manual).toMatchObject({ resourcesNew: 0, resourcesSeen: 1 });
    const v = res(db, verdict.resource);
    expect(v.first_seen_at).toBe(1000);
    expect(v.last_seen_at).toBe(2000);
    expect(seller(db, "ax1.vc")).toMatchObject({ first_seen_at: 1000, last_seen_at: 2000 });
    expect((db.prepare("SELECT COUNT(*) AS n FROM resources").get() as { n: number }).n).toBe(8);
  });

  it("listPayTos aggregates case-insensitively and filters", async () => {
    const { db, run } = setup();
    await run(1000);
    const all = listPayTos(db);
    expect(all[0]).toMatchObject({ payTo: PAY_A.toLowerCase(), resourceCount: 3, bazaarCalls: 238665 + 10 });
    expect(all[0]!.sellerIds).toHaveLength(2); // ax1.vc + manual.example
    expect(all.map((r) => r.payTo)).not.toContain("so1");
    expect(listPayTos(db, { minBazaarCalls: 100 }).map((r) => r.payTo)).toEqual([PAY_A.toLowerCase(), PAY_B.toLowerCase()]);
    expect(listPayTos(db, { network: "solana:5eykt4UsFv8P8NJdTREpY1vzqKqZKvdp" })).toEqual([]);
  });

  it("discoverReport falls back to bazaar calls when volume is NULL, and ranks by volume once set", async () => {
    const { db, run } = setup();
    await run(1000);
    const r = discoverReport(db, { top: 10 });
    expect(r).toMatch(/fallback: 30-day USDC volume is not computed yet/);
    expect(r).toMatch(/\| 1 \| ax1\.vc \| data \|  \|  \| 238,675 \| 2 \| 1 \|  \|/);
    expect(r).toMatch(/x402scan 0 \(x402scan API is paid per call; not used in discover, see docs\/protocol-notes.md\)/);
    expect(r).toMatch(/Base-exact resources using permit2.*: 1/);
    expect(r).toMatch(/yes \(exclude.yaml: local only\)/);

    db.prepare("UPDATE sellers SET volume_30d_atomic = '123456789', volume_30d_calls = 42 WHERE domain = 'blockrun.ai'").run();
    db.prepare("UPDATE sellers SET volume_30d_atomic = '99999999' WHERE domain = 'ax1.vc'").run();
    const r2 = discoverReport(db, { top: 3 });
    expect(r2).not.toMatch(/fallback/);
    expect(r2).toMatch(/\| 1 \| blockrun\.ai \| inference \| \$123\.46 \| 42 \|/);
    expect(r2).toMatch(/\| 2 \| ax1\.vc \| data \| \$100\.00 \|/);
  });
});

describe("helpers", () => {
  it("selectAccept handles legacy v1 'base' with maxAmountRequired", () => {
    const sel = selectAccept([{ scheme: "exact", network: "base", maxAmountRequired: "1000", asset: USDC, payTo: PAY_A, maxTimeoutSeconds: 60 }]);
    expect(sel).toMatchObject({ network: "eip155:8453", amount: "1000", transferMethod: "eip3009" });
    expect(selectAccept([{ scheme: "upto", network: "eip155:8453", amount: "1", asset: USDC, payTo: PAY_A, maxTimeoutSeconds: 60 }])).toBeNull();
  });
  it("formatUsd", () => {
    expect(formatUsd("1234567890")).toBe("$1,234.57");
    expect(formatUsd("4999")).toBe("$0.00");
    expect(formatUsd("5000")).toBe("$0.01");
    expect(formatUsd(null)).toBe("");
  });
  it("upsertManual alone", () => {
    const db = openDb(":memory:");
    expect(upsertManual(db, manual, 5)).toMatchObject({ resourcesNew: 1, sellersNew: 1 });
    expect(upsertManual(db, manual, 6)).toMatchObject({ resourcesNew: 0, resourcesSeen: 1, sellersSeen: 1 });
  });
});
