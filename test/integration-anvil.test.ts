/**
 * Milestone 3 integration: buy plan -> buy (dry run and live) -> caps -> stress -> background resolver,
 * against the mock seller in chain mode on a local anvil chain (chain id 84532) with TestUSDC.
 * Every settlement here is a real transferWithAuthorization transaction confirmed from chain logs.
 * Skipped automatically when /opt/homebrew/bin/anvil (or $ANVIL_BIN) is missing.
 */
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { generatePrivateKey, privateKeyToAccount } from "viem/accounts";
import type { PublicClient } from "viem";
import { openDb, type Db } from "../src/db/index.js";
import { usdToAtomic, type Caps, type SampleConfig } from "../src/config/index.js";
import { makeChainClient } from "../src/chain/client.js";
import { makeChainLookupFactory, makeChainSettlementLookup, resolvePendingIndeterminate } from "../src/chain/confirm.js";
import { assertPlanWithinCaps, buildBuyPlan, renderPlan, type BuyPlan } from "../src/buy/plan.js";
import { runBuy } from "../src/buy/run.js";
import { runStressDuplicate, runStressTimeout, stressReport, type ResourceRef } from "../src/stress/index.js";
import { runPaidCall } from "../src/pipeline/paidCall.js";
import { createPayer, type Payer } from "../src/x402/pay.js";
import type { ServiceConfig } from "../src/validators/types.js";
import { ANVIL_BIN, anvilAvailable, deployTestUsdc, startAnvil, type Anvil, type TestUsdc } from "../tools/mock-seller/anvil.js";
import { startMockSeller, type MockSeller } from "../tools/mock-seller/server.js";

const NETWORK = "eip155:84532" as const;
const LISTED = "10000";
const HAVE_ANVIL = anvilAvailable();
if (!HAVE_ANVIL) console.warn(`[integration-anvil] SKIPPED: anvil not found at ${ANVIL_BIN} (install Foundry or set ANVIL_BIN)`);

const service: ServiceConfig = {
  domain: "mock",
  json_schema: {
    type: "object",
    required: ["symbol", "price", "timestamp"],
    properties: { symbol: { type: "string" }, price: { type: "number" }, timestamp: { type: "string" } },
  },
  entity: { request_param: "symbol", response_path: "$.symbol" },
  freshness: { response_path: "$.timestamp", max_age_seconds: 3600 },
};

const ROUTES = [
  { path: "/ok", domain: "ok.mock", rank: 1, category: "data" },
  { path: "/fail/500-after-settle", domain: "five-hundred.mock", rank: 2, category: "data" },
  { path: "/fail/overcharge", domain: "overcharge.mock", rank: 3, category: "inference" },
  { path: "/fail/slow", domain: "slow.mock", rank: 4, category: "other" },
  { path: "/fail/reject", domain: "reject.mock", rank: 5, category: "inference" },
  { path: "/fail/bad-request", domain: "bad-request.mock", rank: 6, category: "other" },
] as const;

const caps: Caps = {
  perCallAtomic: usdToAtomic(0.5),
  perSellerPerDayAtomic: usdToAtomic(20),
  perDayAtomic: usdToAtomic(100),
  totalAtomic: usdToAtomic(300),
  stressTotalAtomic: usdToAtomic(30),
};
const sample: SampleConfig = {
  target_calls: 12,
  max_total_usd: 5,
  tiers: { top: { size: 5, share: 1 }, tail: { size: 1, share: 0 } },
  categories: ["inference", "data", "other"],
  price_floor_usd: 0.001,
  max_share_per_resource: 1,
  seed: 1,
  min_seconds_between_calls_per_resource: 1,
};
const quiet = { info: () => {}, warn: () => {}, error: (m: string, d?: unknown) => console.error(m, d) };

describe.skipIf(!HAVE_ANVIL)("integration on anvil: buy + stress + resolver", () => {
  let anvil: Anvil;
  let token: TestUsdc;
  let seller: MockSeller;
  let client: PublicClient;
  let payers: Payer[];
  let db: Db;
  let plan: BuyPlan;
  const ids = new Map<string, { resourceId: number; sellerId: number; domain: string; url: string }>();

  function seed(d: Db) {
    for (const [i, r] of ROUTES.entries()) {
      const sellerId = i + 1;
      d.prepare("INSERT INTO sellers (id, domain, category, rank_30d, first_seen_at, last_seen_at) VALUES (?, ?, ?, ?, 0, 0)").run(sellerId, r.domain, r.category, r.rank);
      const url = `${seller.url}${r.path}?symbol=BTC`;
      d.prepare(
        `INSERT INTO resources (id, seller_id, url, source, network, scheme, asset, declared_price_atomic, pay_to, raw_json, first_seen_at, last_seen_at)
         VALUES (?, ?, ?, 'manual', ?, 'exact', ?, ?, ?, '{}', 0, 0)`,
      ).run(sellerId * 10, sellerId, url, NETWORK, token.address, LISTED, seller.catalog()[0]!.payTo);
      ids.set(r.path, { resourceId: sellerId * 10, sellerId, domain: r.domain, url });
    }
  }
  const ref = (path: string): ResourceRef => {
    const x = ids.get(path)!;
    return { resourceId: x.resourceId, sellerId: x.sellerId, sellerDomain: x.domain, url: x.url, priceAtomic: BigInt(LISTED) };
  };
  const common = () => ({
    payers,
    caps,
    network: NETWORK,
    settlementLookupFactory: makeChainLookupFactory({ client, network: NETWORK, asset: token.address }),
    services: () => service,
    confirmTimeoutMs: 20_000,
    confirmIntervalMs: 200,
    rejectGraceMs: 1_000,
    timeoutMs: 10_000,
    log: quiet,
    haltRoot: "/nonexistent-x402-audit-halt-root",
  });

  beforeAll(async () => {
    anvil = await startAnvil({ chainId: 84532, port: 0 });
    token = await deployTestUsdc(anvil.rpcUrl, anvil.accounts[0]!.privateKey);
    const keys = [generatePrivateKey(), generatePrivateKey(), generatePrivateKey()];
    for (const k of keys) await token.mint(privateKeyToAccount(k).address, 10_000_000n);
    seller = await startMockSeller({
      port: 0,
      network: NETWORK,
      asset: token.address,
      listedPriceAtomic: LISTED,
      chain: { rpcUrl: anvil.rpcUrl, tokenAddress: token.address, facilitatorPrivateKey: anvil.accounts[1]!.privateKey },
    });
    client = makeChainClient({ rpcUrl: anvil.rpcUrl, network: NETWORK });
    payers = keys.map((k) => createPayer({ privateKey: k, network: NETWORK, maxAmountAtomic: caps.perCallAtomic, timeoutMs: 10_000 }));
    db = openDb(":memory:");
    seed(db);
  }, 60_000);

  afterAll(async () => {
    await seller?.close();
    await anvil?.close();
    db?.close();
  });

  it("1. buildBuyPlan: 12 calls across tier x category, renders, respects caps", () => {
    plan = buildBuyPlan(db, { sample, caps, network: NETWORK, now: Date.now() });
    const md = renderPlan(plan);
    console.log(md);
    expect(plan.totalCalls).toBe(12);
    expect(plan.strata.map((s) => `${s.tier}/${s.category}:${s.calls}`).sort()).toEqual(["tail/other:0", "top/data:4", "top/inference:4", "top/other:4"]);
    expect(plan.totalSpendAtomic).toBe(12n * 10000n);
    expect(md).toContain("$0.12");
    expect(plan.notes.join("\n")).toMatch(/Tier tail: no eligible sellers in inference, data/);
    expect((db.prepare("SELECT COUNT(*) n FROM sellers WHERE tier = 'top'").get() as { n: number }).n).toBe(5);
    assertPlanWithinCaps(plan, caps);
    expect(() => assertPlanWithinCaps(plan, { ...caps, totalAtomic: usdToAtomic(0.05) })).toThrow(/MAX_TOTAL_USD/);
  });

  it("2. runBuy dry run writes no attempts or calls", async () => {
    const stats = await runBuy(db, { ...common(), plan, dryRun: true, minSecondsBetweenCallsPerResource: 60 });
    expect(stats.schedule).toHaveLength(12);
    expect(stats.calls).toBe(0);
    expect(db.prepare("SELECT COUNT(*) n FROM attempts").get()).toEqual({ n: 0 });
    expect(db.prepare("SELECT COUNT(*) n FROM calls").get()).toEqual({ n: 0 });
    // No resource twice within 60 s (virtual clock) and sellers interleave.
    const last = new Map<number, number>();
    for (const c of stats.schedule) {
      const prev = last.get(c.resourceId);
      if (prev !== undefined) expect(c.at - prev).toBeGreaterThanOrEqual(60_000);
      last.set(c.resourceId, c.at);
    }
    expect(new Set(stats.schedule.slice(0, 5).map((c) => c.sellerId)).size).toBe(5);
    expect(db.prepare("SELECT dry_run, status FROM runs WHERE id = ?").get(stats.runId)).toEqual({ dry_run: 1, status: "completed" });
  });

  it("3. runBuy live on anvil: real settlements, designed outcomes, wallet rotation, ledger rows", async () => {
    const stats = await runBuy(db, { ...common(), plan, dryRun: false, minSecondsBetweenCallsPerResource: 1 });
    expect(stats.halted).toBe(false);
    expect(stats.calls).toBe(12);
    const rows = db
      .prepare("SELECT c.*, r.url FROM calls c JOIN resources r ON r.id = c.resource_id WHERE c.run_id = ? ORDER BY c.id")
      .all(stats.runId) as Record<string, any>[];
    expect(rows).toHaveLength(12);
    const byPath = (p: string) => rows.filter((r) => r.resource_id === ids.get(p)!.resourceId);

    for (const r of byPath("/ok")) {
      expect(r.outcome).toBe("ok");
      expect(r.settlement_count).toBe(1);
      expect(r.settlement_tx_hash).toMatch(/^0x[0-9a-f]{64}$/);
      const receipt = await client.getTransactionReceipt({ hash: r.settlement_tx_hash });
      expect(receipt.status).toBe("success");
      const s = db.prepare("SELECT source, nonce FROM settlements WHERE call_id = ?").get(r.id) as any;
      expect(s).toEqual({ source: "chain", nonce: r.nonce });
    }
    for (const r of byPath("/fail/500-after-settle")) expect([r.outcome, r.settlement_count]).toEqual(["non_delivery", 1]);
    for (const r of byPath("/fail/reject")) expect([r.outcome, r.settlement_count]).toEqual(["not_paid", 0]);
    for (const r of byPath("/fail/overcharge")) expect([r.outcome, r.amount_paid_atomic, r.settlement_count]).toEqual(["overcharge", "100000", 1]);
    for (const r of byPath("/fail/slow")) {
      expect(r.outcome).toBe("ok");
      expect(JSON.parse(r.flags_json)).toContain("slow");
    }
    // Wallet rotation: a seller's calls use different wallets.
    for (const p of ["/ok", "/fail/slow"]) expect(new Set(byPath(p).map((r) => r.wallet)).size).toBeGreaterThan(1);
    // Ledger: planned + signed rows for every paid intent.
    for (const r of rows.filter((x) => x.paid === 1)) {
      const phases = (db.prepare("SELECT phase FROM attempts WHERE intent_id = ? ORDER BY id").all(r.intent_id) as { phase: string }[]).map((a) => a.phase);
      expect(phases).toEqual(["planned", "signed"]);
    }
    expect(stats.byOutcome).toMatchObject({ ok: 6, non_delivery: 2, not_paid: 2, overcharge: 2 });
    // Spend: 6 ok/slow + 2 non_delivery at 0.01, 2 overcharge at 0.10, 2 rejected signatures never settled (still counted as signed).
    expect(stats.spentAtomic).toBe(8n * 10000n + 2n * 100000n + 2n * 10000n);
    expect(db.prepare("SELECT status FROM runs WHERE id = ?").get(stats.runId)).toEqual({ status: "completed" });
  }, 90_000);

  it("4. per-seller-per-day cap breach writes a halts row, parks the seller, and the run continues", async () => {
    const d2 = openDb(":memory:");
    seed(d2);
    const ok = ids.get("/ok")!;
    const okPlan: BuyPlan = {
      ...plan,
      allocations: [{ resourceId: ok.resourceId, sellerId: ok.sellerId, sellerDomain: ok.domain, url: ok.url, method: "GET", tier: "top", category: "data", priceAtomic: 10000n, calls: 3 }],
      totalCalls: 3,
    };
    const stats = await runBuy(d2, { ...common(), plan: okPlan, caps: { ...caps, perSellerPerDayAtomic: 15000n }, dryRun: false, minSecondsBetweenCallsPerResource: 1 });
    // The seller's daily cap parks that seller (recorded in halts) but does not stop the run; with one seller in
    // the plan the run then has nothing left to do and completes.
    expect(stats.halted).toBe(false);
    expect(stats.calls).toBe(1);
    expect(stats.backoffs.map((b) => b.reason)).toEqual(["cap_per_seller_per_day"]);
    const h = d2.prepare("SELECT run_id, reason, details_json FROM halts").all() as any[];
    expect(h).toHaveLength(1);
    expect(h[0].run_id).toBe(stats.runId);
    expect(JSON.parse(h[0].details_json)).toMatchObject({ sellerId: ok.sellerId, stage: "before_quote" });
    expect(d2.prepare("SELECT status FROM runs WHERE id = ?").get(stats.runId)).toEqual({ status: "completed" });
    d2.close();
  }, 30_000);

  it("5. stress duplicate on /ok: one intent, two settlements", async () => {
    const res = await runStressDuplicate(db, { ...common(), resources: [ref("/ok")] });
    expect(res.halted).toBe(false);
    expect(res.rows).toHaveLength(1);
    expect(res.rows[0]!.settlements).toBe(2);
    expect(res.rows[0]!.doubleSettled).toBe(true);
    // Both rows of a double-settled intent carry the intent-level settlement count and the `duplicate` outcome (docs/taxonomy.md #6).
    const calls = db.prepare("SELECT source, settlement_count, outcome FROM calls WHERE intent_id = ?").all(res.rows[0]!.intentId);
    expect(calls).toEqual([
      { source: "stress_duplicate", settlement_count: 2, outcome: "duplicate" },
      { source: "stress_duplicate", settlement_count: 2, outcome: "duplicate" },
    ]);
    const md = stressReport(db);
    expect(md).toContain("| double-settled intents | 1 |");
    expect(md).toMatch(/\| 2 \| 2 \| \*\*yes\*\* \|/);
  }, 60_000);

  it("6. stress timeout on /fail/slow: aborted call settles anyway; naive retry settles again", async () => {
    const res = await runStressTimeout(db, { ...common(), resources: [ref("/fail/slow")], abortAfterMs: 2000 });
    expect(res.rows).toHaveLength(1);
    const row = res.rows[0]!;
    expect(row.firstAborted).toBe(true);
    expect(row.settledDespiteAbort).toBe(true);
    expect(row.secondSettlementOnRetry).toBe(true);
    expect(row.settlements).toBe(2);
    const first = db.prepare("SELECT outcome, error FROM calls WHERE id = ?").get(row.callIds[0]) as any;
    expect(first.outcome).toBe("non_delivery");
    expect(first.error).toMatch(/^aborted:/);
    const md = stressReport(db);
    console.log(md);
    expect(md).toContain("| settled despite abort | 1 |");
    expect(md).toContain("| second settlement on retry | 1 |");
    expect(md).toContain("| intents (timeout test) | 1 |");
    // Stress never changes the headline rows.
    expect((db.prepare("SELECT COUNT(*) n FROM calls WHERE source = 'buy'").get() as { n: number }).n).toBe(12);
  }, 60_000);

  it("7. resolvePendingIndeterminate: hang-after-payment row resolves to non_delivery via the chain", async () => {
    const sellerId = 1;
    const url = `${seller.url}/fail/hang-after-payment?symbol=BTC`;
    db.prepare("INSERT INTO resources (id, seller_id, url, source, network, scheme, declared_price_atomic, raw_json, first_seen_at, last_seen_at) VALUES (99, ?, ?, 'manual', ?, 'exact', ?, '{}', 0, 0)").run(sellerId, url, NETWORK, LISTED);
    const fromBlock = await client.getBlockNumber();
    const o = await runPaidCall({
      db,
      payer: payers[0]!,
      source: "buy",
      resource: { id: 99, sellerId, url },
      reference: { amountAtomic: LISTED, source: "bazaar" },
      perCallCapAtomic: caps.perCallAtomic,
      service,
      defaultMaxTimeoutSeconds: 30,
      settlementLookup: async () => [],
      timeoutMs: 1_500,
    });
    expect(o.classification.outcome).toBe("indeterminate");
    const lookup = makeChainSettlementLookup({ client, network: NETWORK, asset: token.address, fromBlock });
    const r = await resolvePendingIndeterminate(db, { lookup, defaultMaxTimeoutSeconds: 30 });
    expect(r.resolved).toEqual([{ callId: o.callId, intentId: o.intentId, outcome: "non_delivery", settlements: 1, windowClosed: false }]);
    const row = db.prepare("SELECT outcome, flags_json, settlement_count, settlement_tx_hash FROM calls WHERE id = ?").get(o.callId) as any;
    expect(row.outcome).toBe("non_delivery");
    expect(JSON.parse(row.flags_json)).toContain("resolved_late");
    expect(row.settlement_count).toBe(1);
    expect((await client.getTransactionReceipt({ hash: row.settlement_tx_hash })).status).toBe("success");
  }, 30_000);

  it("8. unformable resources stop consuming allocation after two malformed-request our_errors", async () => {
    const { runBuy, UNFORMABLE_AFTER } = await import("../src/buy/run.js");
    const bad = ref("/fail/bad-request");
    const alloc = { resourceId: bad.resourceId, sellerId: bad.sellerId, sellerDomain: bad.sellerDomain, url: bad.url, method: "GET", inputJson: null, tier: "tail" as const, category: "other", priceAtomic: BigInt(LISTED), calls: 5 };
    const plan = { ...buildBuyPlan(db, { sample, caps, network: NETWORK, now: Date.now() }), allocations: [alloc], totalCalls: 5, totalSpendAtomic: BigInt(LISTED) * 5n };
    const stats = await runBuy(db, { ...common(), plan, dryRun: false, minSecondsBetweenCallsPerResource: 1 });
    expect(stats.byOutcome["our_error"]).toBe(UNFORMABLE_AFTER);
    expect(stats.skippedUnformable).toEqual([expect.objectContaining({ resourceId: bad.resourceId, dropped: 5 - UNFORMABLE_AFTER })]);
    expect(stats.calls).toBe(UNFORMABLE_AFTER);
  });

  it("9. concurrency 3 completes the same plan with no seller called concurrently", async () => {
    const { runBuy } = await import("../src/buy/run.js");
    const plan = buildBuyPlan(db, { sample, caps, network: NETWORK, now: Date.now() });
    const before = (db.prepare("SELECT COUNT(*) n FROM calls WHERE source='buy'").get() as { n: number }).n;
    const stats = await runBuy(db, { ...common(), plan, dryRun: false, minSecondsBetweenCallsPerResource: 1, concurrency: 3 });
    expect(stats.halted).toBe(false);
    expect(stats.calls).toBe(plan.totalCalls);
    const rows = db.prepare("SELECT id, seller_id, ts, COALESCE(latency_ms,0) lat FROM calls WHERE source='buy' AND id > (SELECT MAX(id) FROM calls WHERE source='buy' AND rowid <= ?) ORDER BY seller_id, ts").all(before) as { seller_id: number; ts: number; lat: number }[];
    for (let i = 1; i < rows.length; i++) {
      if (rows[i]!.seller_id === rows[i - 1]!.seller_id) expect(rows[i]!.ts).toBeGreaterThanOrEqual(rows[i - 1]!.ts + rows[i - 1]!.lat);
    }
  });

  it("10. balance-aware rotation skips an empty wallet and ends the run when the pool cannot cover the cheapest call", async () => {
    const { runBuy } = await import("../src/buy/run.js");
    const ok = ref("/ok");
    const alloc = { resourceId: ok.resourceId, sellerId: ok.sellerId, sellerDomain: ok.sellerDomain, url: ok.url, method: "GET", inputJson: null, tier: "top" as const, category: "data", priceAtomic: BigInt(LISTED), calls: 4 };
    const plan2 = { ...buildBuyPlan(db, { sample, caps, network: NETWORK, now: Date.now() }), allocations: [alloc], totalCalls: 4, totalSpendAtomic: BigInt(LISTED) * 4n };
    const balances = new Map<string, bigint>(payers.map((p, i) => [p.address, i === 0 ? 0n : 10_000_000n]));
    const stats = await runBuy(db, { ...common(), plan: plan2, dryRun: false, minSecondsBetweenCallsPerResource: 1, walletBalance: async (a) => balances.get(a) ?? 0n, balanceTtlMs: 0 });
    expect(stats.calls).toBe(4);
    expect(stats.schedule.every((c) => c.wallet !== payers[0]!.address)).toBe(true); // the empty wallet was never used
    const plan3 = { ...plan2, allocations: [{ ...alloc, calls: 2 }], totalCalls: 2 };
    const stats2 = await runBuy(db, { ...common(), plan: plan3, dryRun: false, minSecondsBetweenCallsPerResource: 1, walletBalance: async () => 0n, balanceTtlMs: 0 });
    expect(stats2.poolExhausted).toBe(true);
    expect(stats2.calls).toBe(0);
  });
});
