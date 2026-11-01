/**
 * `audit-host` (planOperatorAudit): the operator names hosts; the planner is the triggered audit's (caps, once a day,
 * round-robin), plus --measured-only (resources we have paid before) and --max-usd over the whole plan, above which
 * every item is refused and nothing is bought.
 */
import { describe, expect, it } from "vitest";
import { MAINNET, usdToAtomic, type Caps } from "../config/index.js";
import { openDb, type Db } from "../db/index.js";
import { planOperatorAudit, recordDecisions } from "./run.js";

const caps: Caps = { perCallAtomic: usdToAtomic(0.5), perSellerPerDayAtomic: usdToAtomic(20), perDayAtomic: usdToAtomic(100), totalAtomic: usdToAtomic(300), stressTotalAtomic: usdToAtomic(30), auditPerDayAtomic: usdToAtomic(5) };
const NOW = Date.UTC(2026, 10, 1, 19, 0, 0);

function seed(): Db {
  const db = openDb(":memory:");
  db.prepare("INSERT INTO sellers (id, domain, first_seen_at, last_seen_at) VALUES (1, 'api.fade.example', 0, 0), (2, 'api.site.example', 0, 0)").run();
  const ins = db.prepare("INSERT INTO resources (id, seller_id, url, method, source, network, scheme, declared_price_atomic, pay_to, raw_json, first_seen_at, last_seen_at) VALUES (?, ?, ?, 'GET', 'bazaar', ?, 'exact', '2000', '0xpay', '{}', 0, 0)");
  for (let k = 1; k <= 5; k++) ins.run(k, 1, `https://api.fade.example/api/r${k}`, MAINNET);
  for (let k = 6; k <= 8; k++) ins.run(k, 2, `https://api.site.example/api/r${k}`, MAINNET);
  // Paid before: fade r1..r3, site r6.
  db.prepare("INSERT INTO runs (id, subcommand, args_json, config_hash, network, dry_run, started_at, status) VALUES (1, 'buy run', '{}', '', ?, 0, 0, 'ok')").run(MAINNET);
  const call = db.prepare("INSERT INTO calls (intent_id, run_id, source, resource_id, seller_id, ts, quote_amount_atomic, paid, amount_paid_atomic, request_json, settlement_count, outcome, flags_json) VALUES (?, 1, 'buy', ?, ?, ?, '2000', 1, '2000', '{}', 1, 'ok', '[]')");
  let i = 0;
  for (const [r, s] of [[1, 1], [2, 1], [3, 1], [6, 2]] as const) call.run(`i${++i}`, r, s, Date.UTC(2026, 9, 25) + i * 1000);
  return db;
}

describe("planOperatorAudit", () => {
  it("plans --calls per host round-robin over the resources we paid before, under --max-usd, and records the operator's reason", () => {
    const db = seed();
    const p = planOperatorAudit(db, { hosts: ["API.Fade.example", "api.site.example", "unknown.example"], calls: 6, maxUsd: 0.25, reason: "seller reply", measuredOnly: true, caps, network: MAINNET, now: NOW, maxSellersPerDay: 10 });
    expect(p.withinMax).toBe(true);
    expect(p.plannedAtomic).toBe(24_000n);
    expect(p.items.map((i) => [i.trigger.host, i.decision, i.plannedCalls])).toEqual([
      ["api.fade.example", "planned", 6],
      ["api.site.example", "planned", 6],
      ["unknown.example", "refused", 0],
    ]);
    expect(p.items[0]!.allocations.map((a) => [a.resourceId, a.calls])).toEqual([[1, 2], [2, 2], [3, 2]]);
    expect(p.items[1]!.allocations.map((a) => [a.resourceId, a.calls])).toEqual([[6, 6]]);
    expect(p.items[0]!.trigger).toMatchObject({ source: "audit_operator", reasons: ["operator"], inputs: { operator: { reason: "seller reply", calls: 6, maxUsd: "0.250000", measuredOnly: true }, measured: { n: 3, failures: 0 } } });
    const ids = recordDecisions(db, p.items, { now: NOW });
    expect(ids).toHaveLength(3);
    const row = db.prepare("SELECT source, reasons_json, inputs_json, planned_calls FROM audit_triggers WHERE id = ?").get(ids[0]) as { source: string; reasons_json: string; inputs_json: string; planned_calls: number };
    expect(row.source).toBe("audit_operator");
    expect(JSON.parse(row.reasons_json)).toEqual(["operator"]);
    expect(JSON.parse(row.inputs_json).operator.reason).toBe("seller reply");
  });

  it("without --measured-only spreads over every buyable resource", () => {
    const p = planOperatorAudit(seed(), { hosts: ["api.fade.example"], calls: 5, maxUsd: 1, reason: "r", measuredOnly: false, caps, network: MAINNET, now: NOW, maxSellersPerDay: 10 });
    expect(p.items[0]!.allocations.map((a) => [a.resourceId, a.calls])).toEqual([[1, 1], [2, 1], [3, 1], [4, 1], [5, 1]]);
  });

  it("refuses the whole plan above --max-usd and leaves nothing to buy", () => {
    const p = planOperatorAudit(seed(), { hosts: ["api.fade.example", "api.site.example"], calls: 50, maxUsd: 0.1, reason: "r", measuredOnly: false, caps, network: MAINNET, now: NOW, maxSellersPerDay: 10 });
    expect(p.withinMax).toBe(false);
    expect(p.plannedAtomic).toBe(200_000n);
    expect(p.items.every((i) => i.decision === "refused" && i.plannedCalls === 0 && i.allocations.length === 0)).toBe(true);
    expect(p.items[0]!.decisionReason).toMatch(/--max-usd 0\.100000: the whole plan is 0\.200000 USDC; nothing bought/);
  });

  it("keeps the triggered audit's caps: a host audited today is refused", () => {
    const db = seed();
    db.prepare("INSERT INTO calls (intent_id, run_id, source, resource_id, seller_id, ts, quote_amount_atomic, paid, amount_paid_atomic, request_json, settlement_count, outcome, flags_json) VALUES ('a1', 1, 'audit_operator', 1, 1, ?, '2000', 1, '2000', '{}', 1, 'ok', '[]')").run(NOW - 3_600_000);
    const p = planOperatorAudit(db, { hosts: ["api.fade.example"], calls: 3, maxUsd: 1, reason: "r", measuredOnly: true, caps, network: MAINNET, now: NOW, maxSellersPerDay: 10 });
    expect(p.items[0]).toMatchObject({ decision: "refused", decisionReason: "already audited today" });
  });
});
