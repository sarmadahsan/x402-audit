/**
 * The rolling window (sellers.json `window`, 2026-11-02): every seller row and evidence header carries the figures over
 * the seller's most recent 50 paid-denominator calls, from the same rows the all-time figures count (every measured
 * source, corrections applied), with the same Wilson code. The all-time figures do not change; summary.json says
 * which window verdicts use.
 */
import { mkdtempSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { MAINNET } from "../config/index.js";
import { countRate } from "../report/compute.js";
import { NOW, seedDb, T0 } from "../report/test-helpers.js";
import { runExport, VERDICT_BASIS_NOTE, WINDOW_SIZE, windowBlock } from "./index.js";

function exportOf(db: ReturnType<typeof seedDb>, now = NOW) {
  const out = mkdtempSync(join(tmpdir(), "export-window-"));
  runExport(db, { network: MAINNET, now, outDir: out, gitCommit: "test" });
  const read = (f: string) => JSON.parse(readFileSync(join(out, f), "utf8"));
  return { summary: read("summary.json"), sellers: read("sellers.json"), evidence: (d: string) => read(`evidence/${d}.json`) };
}

const ins = (db: ReturnType<typeof seedDb>) =>
  db.prepare(`INSERT INTO calls (intent_id, run_id, source, resource_id, seller_id, ts, wallet, quote_amount_atomic, quote_network, reference_price_atomic,
      paid, amount_paid_atomic, request_json, settlement_count, outcome, flags_json) VALUES (?, 1, ?, ?, ?, ?, '0xw', '10000', ?, '10000', 1, '10000', '{}', 1, ?, '[]')`);

describe("export: rolling window", () => {
  it("summary.json says which window verdicts use", () => {
    const e = exportOf(seedDb());
    expect(e.summary.window_size).toBe(50);
    expect(e.summary.verdict_basis_note).toBe(VERDICT_BASIS_NOTE);
    expect(WINDOW_SIZE).toBe(50);
  });

  it("a seller with more than 50 calls: the window is its newest 50, failures outside it are history only", () => {
    const base = exportOf(seedDb());
    const db = seedDb();
    const add = ins(db);
    // The seed gives big.example 30 denominator rows (6 failures) at T0 + k minutes. Add 60 newer rows: the first 10 of
    // them (old) are overcharges, then 45 ok, then 5 non_delivery at the very end; one of the 60 is an audit purchase.
    const later = T0 + 7 * 86_400_000;
    for (let k = 0; k < 60; k++) {
      const outcome = k < 10 ? "overcharge" : k >= 55 ? "non_delivery" : "ok";
      add.run(`w-${k}`, k === 20 ? "audit_operator" : "buy", 1, 1, later + k * 60_000, MAINNET, outcome);
    }
    const e = exportOf(db);
    const s = e.sellers.sellers.find((x: { domain: string }) => x.domain === "big.example");
    const b = base.sellers.sellers.find((x: { domain: string }) => x.domain === "big.example");
    // All-time figures: every row still counts, nothing renamed.
    expect(s.denominator_calls).toBe(b.denominator_calls + 60);
    expect(s.failures).toBe(b.failures + 15);
    for (const k of Object.keys(b)) expect(k in s).toBe(true);
    // The window: the newest 50 of the 60 (k = 10..59): 45 ok and 5 non_delivery; the 10 overcharges have aged out.
    const w = countRate(5, 50);
    expect(s.window).toEqual({
      size: 50,
      calls: 50,
      failures: 5,
      failure_rate: w.rate,
      wilson_low: w.lo,
      wilson_high: w.hi,
      by_type: { non_delivery: 5, overcharge: 0, duplicate: 0, wrong_goods: 0 },
      first_ts: new Date(later + 10 * 60_000).toISOString(),
      last_ts: new Date(later + 59 * 60_000).toISOString(),
      last_failure_ts: new Date(later + 59 * 60_000).toISOString(),
    });
    // The audit purchase (k = 20) is inside the window: every measured source counts, as in the all-time figures.
    expect(s.purchases_by_source.audit_operator).toBe(1);
    // The evidence header carries the same block.
    expect(e.evidence("big.example").window).toEqual(s.window);
  });

  it("a seller with fewer than 50 calls: the window is all of them and equals the all-time figures", () => {
    const e = exportOf(seedDb());
    const s = e.sellers.low_sample.find((x: { domain: string }) => x.domain === "almost.example");
    expect(s.denominator_calls).toBe(29);
    expect(s.window).toMatchObject({ size: 50, calls: 29, failures: s.failures, failure_rate: s.failure_rate, wilson_low: s.wilson_low, wilson_high: s.wilson_high, by_type: s.failures_by_type });
    expect(typeof s.window.first_ts).toBe("string");
    expect(typeof s.window.last_ts).toBe("string");
    expect(typeof s.window.last_failure_ts).toBe("string");
    expect(e.evidence("almost.example").window).toEqual(s.window);
  });

  it("honours a correction: a re-scored row counts with its corrected outcome", () => {
    const db = seedDb();
    const before = exportOf(db).sellers.sellers.find((x: { domain: string }) => x.domain === "big.example");
    expect(before.window.by_type.overcharge).toBe(2);
    // `buy correct` replaces the row's outcome in place (and writes a corrections row); the window reads the row as it stands.
    db.prepare("UPDATE calls SET outcome = 'ok' WHERE seller_id = 1 AND outcome = 'overcharge' AND quote_amount_atomic = '105000'").run();
    const after = exportOf(db).sellers.sellers.find((x: { domain: string }) => x.domain === "big.example");
    expect(after.window.by_type.overcharge).toBe(1);
    expect(after.window.failures).toBe(before.window.failures - 1);
    expect(after.failures).toBe(before.failures - 1);
  });

  it("windowBlock: empty input gives zero calls and null rate and timestamps; more than 50 rows keep the newest", () => {
    expect(windowBlock([])).toEqual({ size: 50, calls: 0, failures: 0, failure_rate: null, wilson_low: null, wilson_high: null, by_type: { non_delivery: 0, overcharge: 0, duplicate: 0, wrong_goods: 0 }, first_ts: null, last_ts: null, last_failure_ts: null });
    const rows = Array.from({ length: 70 }, (_, k) => ({ outcome: k === 0 ? "duplicate" : "ok", failed: k === 0 ? 1 : 0, ts: 1_000 + k }));
    const w = windowBlock(rows);
    expect(w.calls).toBe(50);
    expect(w.failures).toBe(0); // the one failure is the oldest row, outside the window
    expect(w.first_ts).toBe(new Date(1_020).toISOString());
    expect(w.last_ts).toBe(new Date(1_069).toISOString());
  });
});
