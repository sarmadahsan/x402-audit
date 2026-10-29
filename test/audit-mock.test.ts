/**
 * Audits end to end against the mock seller: triggers -> planAudits (caps) -> recorded decisions -> runBuy with an
 * audit source -> the audit's own result -> signed POST to the index. Plus the caps refusing and logging.
 */
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { generatePrivateKey } from "viem/accounts";
import { openDb, type Db } from "../src/db/index.js";
import { createPayer } from "../src/x402/pay.js";
import type { SettlementFact, SettlementLookup } from "../src/pipeline/paidCall.js";
import { startMockSeller, type MockSeller } from "../tools/mock-seller/server.js";
import { evaluateTriggers, measuredSeries, sellerIdsByHost } from "../src/audit/triggers.js";
import { auditResult, planAudits, recordDecisions, runAudits, signAuditBody } from "../src/audit/run.js";
import { listTooExpensive } from "../src/buy/states.js";
import { usdToAtomic, type Caps } from "../src/config/index.js";
import { runQuery } from "../src/report/queries.js";

const NETWORK = "eip155:84532" as const;
let seller: MockSeller;
let db: Db;
const silent = { info() {}, warn() {}, error() {} };
const caps: Caps = {
  perCallAtomic: usdToAtomic(0.5),
  perSellerPerDayAtomic: usdToAtomic(20),
  perDayAtomic: usdToAtomic(100),
  totalAtomic: usdToAtomic(300),
  stressTotalAtomic: usdToAtomic(30),
  auditPerDayAtomic: usdToAtomic(5),
};
const lookup: SettlementLookup = async (signed) =>
  seller
    .settlements()
    .filter((s) => s.nonce.toLowerCase() === signed.nonce.toLowerCase())
    .map<SettlementFact>((s) => ({ txHash: s.txHash, from: s.from, to: s.to, valueAtomic: s.value, nonce: s.nonce, source: "mock" }));

beforeAll(async () => {
  seller = await startMockSeller({ port: 0, network: NETWORK, listedPriceAtomic: "10000" });
  db = openDb(":memory:");
  const host = new URL(seller.url).hostname; // 127.0.0.1
  db.prepare("INSERT INTO sellers (id, domain, first_seen_at, last_seen_at) VALUES (1, ?, 0, 0)").run(host);
  const res = db.prepare(
    "INSERT INTO resources (id, seller_id, url, source, network, scheme, declared_price_atomic, raw_json, first_seen_at, last_seen_at) VALUES (?, ?, ?, 'manual', ?, 'exact', ?, '{}', 0, 0)",
  );
  res.run(1, 1, `${seller.url}/ok?symbol=BTC`, NETWORK, "10000");
  res.run(2, 1, `${seller.url}/fail/500-after-settle?symbol=BTC`, NETWORK, "10000");
  res.run(3, 1, `${seller.url}/ok?symbol=ETH`, NETWORK, "900000"); // above the per-call cap
  // A second seller with no resource we can buy.
  db.prepare("INSERT INTO sellers (id, domain, first_seen_at, last_seen_at) VALUES (2, 'nothing.example', 0, 0)").run();
});
afterAll(async () => {
  await seller.close();
  db.close();
});

describe("audits against the mock seller", () => {
  it("plans up to 10 calls round-robin under the caps, records every decision, buys with the audit source and posts a signed result", async () => {
    const now = Date.now();
    const host = new URL(seller.url).hostname;
    const triggers = evaluateTriggers({
      reported: [],
      demand: [
        { host, checks: 7 },
        { host: "nothing.example", checks: 3 },
        { host: "unknown.example", checks: 2 },
      ],
      measured: measuredSeries(db, { network: NETWORK, now }),
      sellers: sellerIdsByHost(db),
      now,
    });
    expect(triggers.map((t) => t.host)).toEqual([host, "nothing.example", "unknown.example"]);

    const items = planAudits(db, triggers, { caps, network: NETWORK, now, maxSellersPerDay: 10, maxCallsPerSeller: 10 });
    expect(items.map((i) => i.decision)).toEqual(["planned", "refused", "refused"]);
    expect(items[0]!.plannedCalls).toBe(10);
    expect(items[0]!.allocations.map((a) => [a.resourceId, a.calls])).toEqual([
      [1, 5],
      [2, 5],
    ]);
    expect(listTooExpensive(db).map((r) => r.resource_id)).toEqual([3]);

    const ids = recordDecisions(db, items, { now });
    const rows = db.prepare("SELECT host, decision, reasons_json, inputs_json FROM audit_triggers ORDER BY id").all() as { host: string; decision: string; reasons_json: string; inputs_json: string }[];
    expect(rows.map((r) => r.decision)).toEqual(["planned", "refused", "refused"]);
    expect(JSON.parse(rows[0]!.inputs_json).demand.checks).toBe(7);

    const posted: { url: string; headers: Record<string, string>; body: string }[] = [];
    const fetchImpl = async (url: string, init?: RequestInit) => {
      posted.push({ url, headers: init!.headers as Record<string, string>, body: String(init!.body) });
      return new Response("{}", { status: 201 });
    };
    let runSeq = 100;
    const results = await runAudits(db, items, {
      index: "https://index.test",
      secret: "s3cret",
      triggerIds: ids,
      fetchImpl,
      payers: [0, 1].map(() => createPayer({ privateKey: generatePrivateKey(), network: NETWORK, maxAmountAtomic: caps.perCallAtomic, timeoutMs: 5_000 })),
      caps,
      network: NETWORK,
      settlementLookup: lookup,
      minSecondsBetweenCallsPerResource: 0,
      confirmTimeoutMs: 2_000,
      confirmIntervalMs: 50,
      rejectGraceMs: 200,
      startRun: () => {
        db.prepare("INSERT INTO runs (id, subcommand, args_json, config_hash, network, dry_run, started_at) VALUES (?, 'audit', '{}', '', ?, 0, ?)").run(++runSeq, NETWORK, Date.now());
        return runSeq;
      },
      log: silent,
      haltRoot: mkdtempSync(join(tmpdir(), "audit-halt-")), // the laptop checkout carries a halt file
      dryRun: false,
    });
    expect(results).toHaveLength(1);
    const calls = db.prepare("SELECT source, COUNT(*) n, COUNT(DISTINCT wallet) w FROM calls GROUP BY source").all() as { source: string; n: number; w: number }[];
    expect(calls).toEqual([{ source: "audit_demand", n: 10, w: 2 }]);
    expect(results[0]!.result.calls).toBe(10);
    expect(results[0]!.result.failures).toBe(5);
    expect(results[0]!.post).toBe("posted");
    expect(posted[0]!.url).toBe("https://index.test/v1/audits");
    const ts = posted[0]!.headers["x-paidfor-audit-timestamp"]!;
    expect(posted[0]!.headers["x-paidfor-audit-signature"]).toBe(signAuditBody("s3cret", ts, posted[0]!.body));
    expect(Object.keys(JSON.parse(posted[0]!.body)).sort()).toEqual(["calls", "evidence_url", "failures", "host", "rate", "reason", "triggered_at", "wilson_high", "wilson_low"]);
    expect((db.prepare("SELECT post_status FROM audit_results").get() as { post_status: string }).post_status).toBe("posted");

    // The audit rows count in the seller's own series, not in the headline.
    const own = measuredSeries(db, { network: NETWORK, now: Date.now() });
    expect(own[0]!.n).toBe(10);
    const headline = runQuery<{ n: number }>(db, "buy_headline_counts", { since: 0, until: Date.now(), network: NETWORK });
    expect(headline.reduce((s, r) => s + Number(r.n), 0)).toBe(0);

    // Same seller again today: refused, never bought twice in a day.
    const again = planAudits(db, triggers, { caps, network: NETWORK, now: Date.now(), maxSellersPerDay: 10, maxCallsPerSeller: 10 });
    expect(again[0]!.decision).toBe("refused");
    expect(again[0]!.decisionReason).toBe("already audited today");
  });

  it("refuses and logs when the audit budget or the seller count would be exceeded", () => {
    const now = Date.now();
    const t = { host: "x.example", sellerId: 1, reasons: ["demand" as const], source: "audit_demand" as const, priority: 1, inputs: { reported: null, measured: null, demand: null } };
    const fresh = openDb(":memory:");
    fresh.prepare("INSERT INTO sellers (id, domain, first_seen_at, last_seen_at) VALUES (1, 'x.example', 0, 0), (2, 'y.example', 0, 0)").run();
    fresh.prepare("INSERT INTO resources (id, seller_id, url, source, network, scheme, declared_price_atomic, raw_json, first_seen_at, last_seen_at) VALUES (1, 1, 'https://x.example/r', 'manual', ?, 'exact', '400000', '{}', 0, 0), (2, 2, 'https://y.example/r', 'manual', ?, 'exact', '10000', '{}', 0, 0)").run(NETWORK, NETWORK);
    const tight = { ...caps, auditPerDayAtomic: usdToAtomic(1) };
    const [a] = planAudits(fresh, [t], { caps: tight, network: NETWORK, now, maxSellersPerDay: 10, maxCallsPerSeller: 10 });
    expect(a!.decision).toBe("planned");
    expect(a!.plannedCalls).toBe(2); // 2 x 0.40 fits 1.00, a third does not
    const [b, c] = planAudits(fresh, [t, { ...t, host: "y.example", sellerId: 2 }], { caps, network: NETWORK, now, maxSellersPerDay: 1, maxCallsPerSeller: 10 });
    expect(b!.decision).toBe("planned");
    expect(c!.decision).toBe("refused");
    expect(c!.decisionReason).toMatch(/at most 1 audited sellers per UTC day/);
    fresh.close();
  });

  it("auditResult leaves out-of-denominator rows out", () => {
    const r = auditResult(db, { runId: 999, sellerId: 1, host: "127.0.0.1", triggeredAt: 0, reason: "demand" });
    expect(r).toMatchObject({ calls: 0, failures: 0, rate: null });
  });
});
