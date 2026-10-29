/**
 * Caps for continuous running (docs/PLAN.md "Schedule"): per run, per seller per run, the scheduled-buy day budget,
 * the audit day cap, and the expensive-sellers lane (own cap, weekly frequency, too_expensive recording).
 */
import { describe, expect, it } from "vitest";
import { openDb, type Db } from "../db/index.js";
import { usdToAtomic, type Caps } from "../config/index.js";
import { checkCaps } from "./guard.js";
import { expensiveAllocations } from "./lanes.js";
import { listTooExpensive } from "./states.js";

const NET = "eip155:8453";
const DAY0 = Date.UTC(2026, 9, 29, 0, 0, 0);
const caps: Caps = {
  perCallAtomic: usdToAtomic(0.1),
  perSellerPerDayAtomic: usdToAtomic(20),
  perDayAtomic: usdToAtomic(100),
  totalAtomic: usdToAtomic(300),
  stressTotalAtomic: usdToAtomic(30),
  auditPerDayAtomic: usdToAtomic(5),
};

function db(): Db {
  const d = openDb(":memory:");
  d.prepare("INSERT INTO sellers (id, domain, first_seen_at, last_seen_at) VALUES (1, 'a.example', 0, 0), (2, 'b.example', 0, 0)").run();
  d.prepare("INSERT INTO resources (id, seller_id, url, source, network, scheme, declared_price_atomic, raw_json, first_seen_at, last_seen_at) VALUES (1, 1, 'https://a.example/r', 'bazaar', ?, 'exact', '100000', '{}', 0, 0), (2, 2, 'https://b.example/r', 'bazaar', ?, 'exact', '100000', '{}', 0, 0)").run(NET, NET);
  return d;
}
let n = 0;
const paid = (d: Db, o: { seller: number; usd: number; ts: number; source?: string }) =>
  d
    .prepare(`INSERT INTO calls (intent_id, source, resource_id, seller_id, ts, paid, amount_paid_atomic, request_json, outcome) VALUES (?, ?, ?, ?, ?, 1, ?, '{}', 'ok')`)
    .run(`i${++n}`, o.source ?? "buy", o.seller, o.seller, o.ts, usdToAtomic(o.usd).toString());

describe("scheduled-run caps", () => {
  it("per-run cap counts only this run's buy spend", () => {
    const d = db();
    const runStart = DAY0 + 6 * 3_600_000;
    paid(d, { seller: 1, usd: 0.7, ts: DAY0 + 3_600_000 }); // the 00:00 run
    paid(d, { seller: 1, usd: 0.7, ts: runStart + 60_000 });
    const run = { since: runStart, perRunAtomic: usdToAtomic(0.75) };
    expect(checkCaps(d, { caps, sellerId: 2, amountAtomic: usdToAtomic(0.05), now: runStart + 120_000, scope: "buy", run })).toBeNull();
    expect(checkCaps(d, { caps, sellerId: 2, amountAtomic: usdToAtomic(0.06), now: runStart + 120_000, scope: "buy", run })?.reason).toBe("cap_per_run");
  });

  it("per-seller-per-run is the daily per-seller cap scaled to the run", () => {
    const d = db();
    const runStart = DAY0 + 12 * 3_600_000;
    paid(d, { seller: 1, usd: 4.95, ts: runStart + 1 });
    const run = { since: runStart, perSellerPerRunAtomic: caps.perSellerPerDayAtomic / 4n };
    expect(checkCaps(d, { caps: { ...caps, perCallAtomic: usdToAtomic(1) }, sellerId: 1, amountAtomic: usdToAtomic(0.1), now: runStart + 2, scope: "buy", run })?.reason).toBe("cap_per_seller_per_run");
    expect(checkCaps(d, { caps, sellerId: 2, amountAtomic: usdToAtomic(0.1), now: runStart + 2, scope: "buy", run })).toBeNull();
  });

  it("the scheduled-buy day budget counts buy rows only; audits have their own day cap", () => {
    const d = db();
    paid(d, { seller: 1, usd: 1.95, ts: DAY0 + 1 });
    paid(d, { seller: 2, usd: 4.95, ts: DAY0 + 2, source: "audit_demand" });
    const run = { since: DAY0 + 18 * 3_600_000, dayBudgetAtomic: usdToAtomic(2) };
    expect(checkCaps(d, { caps, sellerId: 2, amountAtomic: usdToAtomic(0.05), now: DAY0 + 19 * 3_600_000, scope: "buy", run })).toBeNull();
    expect(checkCaps(d, { caps, sellerId: 2, amountAtomic: usdToAtomic(0.06), now: DAY0 + 19 * 3_600_000, scope: "buy", run })?.reason).toBe("cap_buy_day_budget");
    expect(checkCaps(d, { caps, sellerId: 1, amountAtomic: usdToAtomic(0.06), now: DAY0 + 19 * 3_600_000, scope: "audit" })?.reason).toBe("cap_audit_per_day");
    // The next UTC day starts fresh.
    expect(checkCaps(d, { caps, sellerId: 1, amountAtomic: usdToAtomic(0.06), now: DAY0 + 25 * 3_600_000, scope: "audit" })).toBeNull();
  });
});

describe("expensive-sellers lane", () => {
  it("one call at the seller's own cap, at most max_per_week in 7 days, above-cap resources recorded", () => {
    const d = db();
    d.prepare("INSERT INTO resources (id, seller_id, url, source, network, scheme, declared_price_atomic, raw_json, first_seen_at, last_seen_at) VALUES (3, 1, 'https://a.example/big', 'bazaar', ?, 'exact', '900000', '{}', 0, 0)").run(NET);
    const now = DAY0 + 6 * 3_600_000;
    const list = [
      { domain: "a.example", per_call_usd: 0.29, max_per_week: 3, reason: "" },
      { domain: "b.example", per_call_usd: 0.29, max_per_week: 3, reason: "" },
      { domain: "missing.example", per_call_usd: 1, max_per_week: 3, reason: "" },
    ];
    for (let k = 0; k < 3; k++) paid(d, { seller: 2, usd: 0.1, ts: now - (k + 1) * 86_400_000 });
    const lane = expensiveAllocations(d, list, { network: NET, now });
    expect(lane.allocations.map((a) => [a.sellerDomain, a.calls, a.perCallCapAtomic])).toEqual([["a.example", 1, usdToAtomic(0.29)]]);
    expect(lane.skipped.map((s) => s.domain)).toEqual(["b.example", "missing.example"]);
    expect(listTooExpensive(d).map((r) => [r.url, r.quoted_atomic, r.cap_atomic])).toEqual([["https://a.example/big", "900000", "290000"]]);
  });
});
