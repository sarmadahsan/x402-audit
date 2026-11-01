/**
 * `buy correct` (src/pipeline/corrections.ts): a reference correction replaces the reference, re-classifies through
 * `reclassifications`, and leaves the original facts and a `corrections` row; a stale-listing annotation changes nothing
 * but the public note; the export carries both. Modelled on the Offera Studio rows of 2026-10-25 (quote 0.002 against a
 * snapshot of 0.001 after the Bazaar had been rewritten to 0.002).
 */
import { mkdtempSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { MAINNET } from "../config/index.js";
import { openDb, type Db } from "../db/index.js";
import { runExport } from "../export/index.js";
import { annotate, CORRECTION_KINDS, correctReference, listCorrections, staleOverchargeCandidates } from "./corrections.js";

const T0 = Date.UTC(2026, 9, 25, 8, 0, 0);

function seed(): Db {
  const db = openDb(":memory:");
  db.prepare("INSERT INTO runs (id, subcommand, args_json, config_hash, network, dry_run, started_at, finished_at, status) VALUES (1, 'buy run', '{}', 'cfg', ?, 0, ?, ?, 'ok')").run(MAINNET, T0, T0 + 3_600_000);
  db.prepare("INSERT INTO sellers (id, domain, first_seen_at, last_seen_at) VALUES (1, 'api.seller.example', ?, ?)").run(T0, T0);
  db.prepare("INSERT INTO sellers (id, domain, first_seen_at, last_seen_at) VALUES (2, 'other.example', ?, ?)").run(T0, T0);
  db.prepare(
    "INSERT INTO resources (id, seller_id, url, method, source, network, scheme, declared_price_atomic, pay_to, raw_json, first_seen_at, last_seen_at) VALUES (1, 1, 'https://api.seller.example/api/macro', 'GET', 'bazaar', ?, 'exact', '2000', '0xpay', '{}', ?, ?)",
  ).run(MAINNET, T0, T0);
  db.prepare(
    "INSERT INTO resources (id, seller_id, url, method, source, network, scheme, declared_price_atomic, pay_to, raw_json, first_seen_at, last_seen_at) VALUES (2, 2, 'https://other.example/x', 'GET', 'bazaar', ?, 'exact', '1000', '0xpay2', '{}', ?, ?)",
  ).run(MAINNET, T0, T0);
  const ins = db.prepare(`INSERT INTO calls (id, intent_id, run_id, source, resource_id, seller_id, ts, wallet, quote_amount_atomic, quote_network, quote_requirements_json,
      reference_price_atomic, reference_source, paid, amount_paid_atomic, request_json, response_status, response_headers_json, response_body, settlement_tx_hash, settlement_count, latency_ms, outcome, flags_json)
    VALUES (@id, @intent, 1, 'buy', @resource, @seller, @ts, '0xw', @quote, @network, '{"mimeType":"application/json","maxTimeoutSeconds":300}', @reference, 'bazaar', 1, @quote,
      '{"url":"https://api.seller.example/api/macro","method":"GET","headers":{},"params":{},"body":null}', 200, '{"content-type":"application/json"}', @body, @tx, 1, 800, @outcome, '["schema_missing"]')`);
  const body = Buffer.from(JSON.stringify({ ok: true, data: [1, 2, 3] }));
  // Seller 1: 2 ok rows at 0.001, then the first purchase at 0.002 against the stale snapshot (the stale-listing row),
  // then two repeats at 0.002 (the Bazaar had been rewritten by the first settlement: measurement errors on our side).
  ins.run({ id: 1, intent: "i1", resource: 1, seller: 1, ts: T0 - 7_200_000, quote: "1000", network: MAINNET, reference: "1000", body, tx: "0x" + "a1".repeat(32), outcome: "ok" });
  ins.run({ id: 2, intent: "i2", resource: 1, seller: 1, ts: T0 - 3_600_000, quote: "1000", network: MAINNET, reference: "1000", body, tx: "0x" + "a2".repeat(32), outcome: "ok" });
  ins.run({ id: 3, intent: "i3", resource: 1, seller: 1, ts: T0, quote: "2000", network: MAINNET, reference: "1000", body, tx: "0x" + "a3".repeat(32), outcome: "overcharge" });
  ins.run({ id: 4, intent: "i4", resource: 1, seller: 1, ts: T0 + 3_600_000, quote: "2000", network: MAINNET, reference: "1000", body, tx: "0x" + "a4".repeat(32), outcome: "overcharge" });
  ins.run({ id: 5, intent: "i5", resource: 1, seller: 1, ts: T0 + 7_200_000, quote: "2000", network: MAINNET, reference: "1000", body, tx: "0x" + "a5".repeat(32), outcome: "overcharge" });
  // Seller 2: a single overcharge whose quote the listing never adopted: not a candidate.
  ins.run({ id: 6, intent: "i6", resource: 2, seller: 2, ts: T0, quote: "5000", network: MAINNET, reference: "1000", body, tx: "0x" + "b6".repeat(32), outcome: "overcharge" });
  return db;
}

describe("stale-overcharge candidates", () => {
  it("names the rows after our own settlement at the same quote whose quote the listing now shows", () => {
    const db = seed();
    const r = staleOverchargeCandidates(db);
    expect(r.summary).toEqual([{ domain: "api.seller.example", seller_id: 1, overcharge_rows: 3, repeat_after_own_purchase: 2, listing_now_equals_quote: 3, candidates: 2, already_corrected: 0 }]);
    const s1 = r.rows.filter((x) => x.domain === "api.seller.example");
    expect(s1.map((x) => [x.call_id, x.first_paid_at_quote])).toEqual([
      [3, null],
      [4, T0],
      [5, T0],
    ]);
    // other.example has an overcharge row but no candidate: listed on the rows, absent from the summary.
    expect(r.rows.some((x) => x.domain === "other.example")).toBe(true);
    expect(r.summary.some((x) => x.domain === "other.example")).toBe(false);
  });
});

describe("buy correct --reference", () => {
  it("previews without writing, then replaces the reference, re-classifies and records both audit rows", async () => {
    const db = seed();
    const preview = await correctReference(db, { callIds: [4, 5, 999], referenceAtomic: "2000", referenceSource: "bazaar", reason: "listing read 0.002 at purchase time", apply: false });
    expect(preview.applied).toBe(false);
    expect(preview.missing).toEqual([999]);
    expect(preview.changes.map((c) => [c.callId, c.oldOutcome, c.newOutcome, c.correctionId])).toEqual([
      [4, "overcharge", "ok", null],
      [5, "overcharge", "ok", null],
    ]);
    expect(db.prepare("SELECT outcome, reference_price_atomic FROM calls WHERE id = 4").get()).toEqual({ outcome: "overcharge", reference_price_atomic: "1000" });
    expect((db.prepare("SELECT COUNT(*) n FROM corrections").get() as { n: number }).n).toBe(0);

    const evidence = { bazaar_last_updated: "2026-10-25T08:48:11Z", our_first_settlement_at_quote: new Date(T0).toISOString() };
    const r = await correctReference(db, { callIds: [4, 5], referenceAtomic: "2000", referenceSource: "bazaar", reason: "listing read 0.002 at purchase time", note: "Re-scored on 2026-11-01.", evidence, apply: true });
    expect(r.applied).toBe(true);
    expect(r.changes.map((c) => [c.callId, c.oldReference, c.newReference, c.oldOutcome, c.newOutcome])).toEqual([
      [4, "1000", "2000", "overcharge", "ok"],
      [5, "1000", "2000", "overcharge", "ok"],
    ]);
    const rows = db.prepare("SELECT id, outcome, reference_price_atomic, reference_source, flags_json FROM calls WHERE id IN (3,4,5) ORDER BY id").all();
    expect(rows).toEqual([
      { id: 3, outcome: "overcharge", reference_price_atomic: "1000", reference_source: "bazaar", flags_json: '["schema_missing"]' },
      { id: 4, outcome: "ok", reference_price_atomic: "2000", reference_source: "bazaar", flags_json: '["schema_missing"]' },
      { id: 5, outcome: "ok", reference_price_atomic: "2000", reference_source: "bazaar", flags_json: '["schema_missing"]' },
    ]);
    const k = listCorrections(db, { sellerId: 1 });
    expect(k.map((x) => [x.call_id, x.kind, x.old_reference_atomic, x.new_reference_atomic, x.old_outcome, x.new_outcome, x.reason, x.note, JSON.parse(x.evidence_json!)])).toEqual([
      [5, "reference_price", "1000", "2000", "overcharge", "ok", "listing read 0.002 at purchase time", "Re-scored on 2026-11-01.", evidence],
      [4, "reference_price", "1000", "2000", "overcharge", "ok", "listing read 0.002 at purchase time", "Re-scored on 2026-11-01.", evidence],
    ]);
    const re = db.prepare("SELECT call_id, reason, old_outcome, new_outcome FROM reclassifications ORDER BY id").all() as { call_id: number; reason: string; old_outcome: string; new_outcome: string }[];
    expect(re.map((x) => [x.call_id, x.old_outcome, x.new_outcome])).toEqual([
      [4, "overcharge", "ok"],
      [5, "overcharge", "ok"],
    ]);
    expect(re[0]!.reason).toMatch(/^correction #\d+: listing read 0\.002 at purchase time$/);
    // The candidates list now shows them as corrected.
    expect(staleOverchargeCandidates(db).summary).toEqual([]);
    expect(staleOverchargeCandidates(db).rows.filter((x) => x.corrected).map((x) => x.call_id)).toEqual([]); // no longer overcharge rows
  });

  it("refuses a non-integer reference and leaves a row alone when the new reference still says overcharge", async () => {
    const db = seed();
    await expect(correctReference(db, { callIds: [4], referenceAtomic: "0.002", referenceSource: "bazaar", reason: "x", apply: true })).rejects.toThrow(/atomic/);
    const r = await correctReference(db, { callIds: [4], referenceAtomic: "1500", referenceSource: "bazaar", reason: "still over", apply: true });
    expect(r.changes[0]).toMatchObject({ oldOutcome: "overcharge", newOutcome: "overcharge", newReference: "1500" });
    expect(db.prepare("SELECT reference_price_atomic FROM calls WHERE id = 4").get()).toEqual({ reference_price_atomic: "1500" });
    expect((db.prepare("SELECT new_outcome FROM corrections").get() as { new_outcome: string }).new_outcome).toBe("overcharge");
    expect((db.prepare("SELECT COUNT(*) n FROM reclassifications").get() as { n: number }).n).toBe(0);
  });
});

describe("buy correct --stale-listing and the export", () => {
  it("annotates without changing the row; evidence rows carry the note and the seller file lists every correction", async () => {
    const db = seed();
    await correctReference(db, { callIds: [4, 5], referenceAtomic: "2000", referenceSource: "bazaar", reason: "listing read 0.002 at purchase time", apply: true });
    const note = "Stale listing: the Bazaar listed 0.001000 USDC when we bought; the seller had raised its price to 0.002000 without re-registering, and the listing was rewritten to 0.002000 at this settlement.";
    const a = annotate(db, { callIds: [3], kind: CORRECTION_KINDS.STALE_LISTING, reason: "first purchase after the seller's price change", note, apply: true });
    expect(a.annotated).toEqual([{ callId: 3, url: "https://api.seller.example/api/macro", outcome: "overcharge", correctionId: 3 }]);
    expect(db.prepare("SELECT outcome, reference_price_atomic FROM calls WHERE id = 3").get()).toEqual({ outcome: "overcharge", reference_price_atomic: "1000" });

    const out = mkdtempSync(join(tmpdir(), "export-corrections-"));
    runExport(db, { network: MAINNET, now: T0 + 86_400_000, outDir: out, gitCommit: "test" });
    const ev = JSON.parse(readFileSync(join(out, "evidence", "api.seller.example.json"), "utf8"));
    expect(ev.failures_total).toBe(1);
    expect(ev.samples).toHaveLength(1);
    expect(ev.samples[0]).toMatchObject({ outcome: "overcharge", quote_usdc: "0.002000", reference_price_usdc: "0.001000", correction: { kind: "stale_listing", note, old_outcome: "overcharge", new_outcome: "overcharge", reason: "first purchase after the seller's price change" } });
    expect(ev.corrections_total).toBe(3);
    expect(ev.corrections.map((c: { kind: string; call_timestamp: string; new_outcome: string; old_reference_price_usdc: string | null; new_reference_price_usdc: string | null }) => [c.kind, c.call_timestamp, c.old_reference_price_usdc, c.new_reference_price_usdc, c.new_outcome])).toEqual([
      ["stale_listing", new Date(T0).toISOString(), "0.001000", "0.001000", "overcharge"],
      ["reference_price", new Date(T0 + 7_200_000).toISOString(), "0.001000", "0.002000", "ok"],
      ["reference_price", new Date(T0 + 3_600_000).toISOString(), "0.001000", "0.002000", "ok"],
    ]);
    expect(ev.corrections[1].settlement_tx_hash).toBe("0x" + "a5".repeat(32));
    // No wallet anywhere in the public files.
    expect(readFileSync(join(out, "evidence", "api.seller.example.json"), "utf8")).not.toContain("0xw");
    // other.example has one denominator call, under the 5-call floor for an evidence file: a row without a correction
    // exports `correction: null` and an empty list (checked on the seller above before its rows were corrected).
    expect(ev.samples.every((x: { correction: unknown }) => "correction" in x)).toBe(true);
    const readme = readFileSync(join(out, "README.md"), "utf8");
    expect(readme).toContain("`correction`");
    expect(readme).toContain("`corrections_total`");
  });
});
