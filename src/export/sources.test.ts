/**
 * Statistics stated honestly (docs/taxonomy.md "Audit purchases", "Candidate sellers"): audit rows and young
 * candidate sellers count in their seller's own series and evidence, never in the headline, by_tier or by_category.
 */
import { mkdtempSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { seedDb, NOW, T0 } from "../report/test-helpers.js";
import { runExport } from "./index.js";
import { MAINNET } from "../config/index.js";

function exportOf(db: ReturnType<typeof seedDb>, now = NOW) {
  const out = mkdtempSync(join(tmpdir(), "export-src-"));
  runExport(db, { network: MAINNET, now, outDir: out, gitCommit: "test" });
  const read = (f: string) => JSON.parse(readFileSync(join(out, f), "utf8"));
  return { summary: read("summary.json"), sellers: read("sellers.json"), evidence: (d: string) => read(`evidence/${d}.json`) };
}

const ins = (db: ReturnType<typeof seedDb>) =>
  db.prepare(`INSERT INTO calls (intent_id, run_id, source, resource_id, seller_id, ts, wallet, quote_amount_atomic, quote_network, reference_price_atomic,
      paid, amount_paid_atomic, request_json, settlement_count, outcome, flags_json) VALUES (?, 1, ?, ?, ?, ?, '0xw', '10000', ?, '10000', 1, '10000', '{}', 1, ?, '[]')`);

describe("export: audit and candidate rows", () => {
  it("audit purchases are in the seller's figures and evidence, not in the headline or by_tier", () => {
    const base = exportOf(seedDb());
    const db = seedDb();
    const add = ins(db);
    for (let k = 0; k < 10; k++) add.run(`aud-${k}`, "audit_disagreement", 1, 1, T0 + 86_400_000 + k, MAINNET, k < 4 ? "non_delivery" : "ok");
    const e = exportOf(db);
    expect(e.summary.denominator_paid_calls).toBe(base.summary.denominator_paid_calls);
    expect(e.summary.count_weighted).toEqual(base.summary.count_weighted);
    expect(e.summary.by_tier).toEqual(base.summary.by_tier);
    expect(e.summary.audit_purchases).toEqual({ audit_disagreement: { paid_calls: 10, sellers: 1 }, audit_demand: { paid_calls: 0, sellers: 0 } });
    const s1 = e.sellers.sellers.find((s: { domain: string }) => s.domain === "big.example");
    const b1 = base.sellers.sellers.find((s: { domain: string }) => s.domain === "big.example");
    expect(s1.denominator_calls).toBe(b1.denominator_calls + 10);
    expect(s1.failures).toBe(b1.failures + 4);
    expect(s1.audit_purchases).toBe(10);
    expect(s1.source).toBe("discovery");
    const samples = e.evidence("big.example").samples as { source: string }[];
    expect(samples.filter((x) => x.source === "audit_disagreement")).toHaveLength(4);
  });

  it("a user-candidate seller stays out of the headline until its first scheduled purchase is 7 days old", () => {
    const db = seedDb();
    db.prepare("INSERT INTO sellers (id, domain, category, first_seen_at, last_seen_at) VALUES (9, 'new.example', 'data', ?, ?)").run(T0, T0);
    db.prepare("INSERT INTO resources (id, seller_id, url, source, raw_json, first_seen_at, last_seen_at) VALUES (9, 9, 'https://new.example/r', 'user', '{}', ?, ?)").run(T0, T0);
    db.prepare("INSERT INTO candidates (url, host, checks, payments, imported_at, seller_id, resource_id, seller_new, state) VALUES ('https://new.example/r', 'new.example', 12, 1, ?, 9, 9, 1, 'measuring')").run(NOW - 3 * 86_400_000);
    const add = ins(db);
    const first = NOW - 2 * 86_400_000;
    for (let k = 0; k < 6; k++) add.run(`cand-${k}`, "buy", 9, 9, first + k, MAINNET, k < 3 ? "non_delivery" : "ok");
    const young = exportOf(db);
    const base = exportOf(seedDb());
    expect(young.summary.denominator_paid_calls).toBe(base.summary.denominator_paid_calls);
    const s9 = young.sellers.low_sample.find((s: { domain: string }) => s.domain === "new.example");
    expect(s9).toMatchObject({ denominator_calls: 6, failures: 3, source: "user", entered_after_checks: 12, entered_after_payments: 1 });
    // Eight days after its first scheduled purchase it joins the headline.
    const later = exportOf(db, first + 8 * 86_400_000);
    expect(later.summary.denominator_paid_calls).toBe(base.summary.denominator_paid_calls + 6);
  });
});
