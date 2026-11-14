/**
 * Issue 40: usable content in another format than declared is a warning, not a failed delivery. Rows stored before
 * the rule are re-judged by `buy reclassify` from their stored headers, body and quote; the export then counts them as
 * delivered and lists them per seller as `format_mismatch`. Modelled on aiact-api.com (declares application/json,
 * answers with the article as text/markdown), recorded 20 of 20 non_delivery before the rule.
 */
import { mkdtempSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { MAINNET } from "../config/index.js";
import { openDb, type Db } from "../db/index.js";
import { runExport } from "../export/index.js";
import { reclassifyCalls } from "./reclassify.js";

const T0 = Date.UTC(2026, 10, 12, 8, 0, 0);
const ARTICLE = "# Article 5: Prohibited AI practices\n\n1. The following AI practices shall be prohibited: ...\n".repeat(40);

function seed(): Db {
  const db = openDb(":memory:");
  db.prepare("INSERT INTO runs (id, subcommand, args_json, config_hash, network, dry_run, started_at, finished_at, status) VALUES (1, 'buy run', '{}', 'cfg', ?, 0, ?, ?, 'ok')").run(MAINNET, T0, T0 + 86_400_000);
  db.prepare("INSERT INTO sellers (id, domain, first_seen_at, last_seen_at) VALUES (1, 'aiact-api.com', ?, ?)").run(T0, T0);
  db.prepare(
    "INSERT INTO resources (id, seller_id, url, method, source, network, scheme, declared_price_atomic, pay_to, raw_json, first_seen_at, last_seen_at) VALUES (1, 1, 'https://aiact-api.com/v1/articles/5', 'GET', 'user', ?, 'exact', '10000', '0xpay', '{}', ?, ?)",
  ).run(MAINNET, T0, T0);
  const ins = db.prepare(`INSERT INTO calls (id, intent_id, run_id, source, resource_id, seller_id, ts, wallet, quote_amount_atomic, quote_network, quote_requirements_json,
      reference_price_atomic, reference_source, paid, amount_paid_atomic, request_json, response_status, response_headers_json, response_body, settlement_tx_hash, settlement_count, latency_ms, outcome, flags_json)
    VALUES (@id, @intent, 1, 'buy', 1, 1, @ts, '0xw', '10000', @network, '{"mimeType":"application/json","maxTimeoutSeconds":60}', '10000', 'bazaar', 1, '10000',
      '{"url":"https://aiact-api.com/v1/articles/5","method":"GET","headers":{},"params":{},"body":null}', 200, @headers, @body, @tx, 1, 800, 'non_delivery', '["schema_missing"]')`);
  const v = db.prepare("INSERT INTO validator_results (call_id, validator, status, reason, evidence_json) VALUES (?, 'content_type', 'fail', ?, ?)");
  for (let i = 1; i <= 20; i++) {
    ins.run({ id: i, intent: `i${i}`, ts: T0 + i * 60_000, network: MAINNET, headers: '{"content-type":"text/markdown; charset=utf-8"}', body: Buffer.from(ARTICLE), tx: "0x" + i.toString(16).padStart(64, "0") });
    v.run(i, "content_type_mismatch", JSON.stringify({ header: "text/markdown; charset=utf-8", actual: "text/markdown", expected: "application/json", expected_source: "requirements" }));
  }
  // An HTML error page served with 200: stays a failure.
  ins.run({ id: 21, intent: "i21", ts: T0 + 21 * 60_000, network: MAINNET, headers: '{"content-type":"text/html"}', body: Buffer.from("<!doctype html><html><body>502 Bad Gateway</body></html>"), tx: "0x" + "ff".repeat(32) });
  v.run(21, "content_type_mismatch", JSON.stringify({ header: "text/html", actual: "text/html", expected: "application/json", expected_source: "requirements" }));
  // Markdown again, but the connection ended early: not_truncated fails, so it stays a failure and is not a format warning.
  ins.run({ id: 22, intent: "i22", ts: T0 + 22 * 60_000, network: MAINNET, headers: '{"content-type":"text/markdown"}', body: Buffer.from(ARTICLE.slice(0, 100)), tx: "0x" + "fe".repeat(32) });
  db.prepare("UPDATE calls SET response_incomplete = 1 WHERE id = 22").run();
  return db;
}

describe("re-judging stored rows under the format rule", () => {
  it("previews, then turns the markdown rows into ok with format_mismatch and leaves the HTML page a failure", async () => {
    const db = seed();
    const preview = await reclassifyCalls(db, { reason: "issue 40: format warning", apply: false });
    expect(preview.applied).toBe(false);
    expect(preview.changed.filter((c) => c.newOutcome === "ok").map((c) => c.callId)).toEqual(Array.from({ length: 20 }, (_, i) => i + 1));
    expect(preview.changed[0]).toMatchObject({ oldOutcome: "non_delivery", newOutcome: "ok", newFlags: ["schema_missing", "format_mismatch"] });
    expect((db.prepare("SELECT COUNT(*) n FROM calls WHERE outcome = 'non_delivery'").get() as { n: number }).n).toBe(22);

    const r = await reclassifyCalls(db, { reason: "issue 40: format warning", apply: true });
    expect(r.changed.filter((c) => c.newOutcome === "ok")).toHaveLength(20);
    expect(db.prepare("SELECT outcome, COUNT(*) n FROM calls GROUP BY outcome ORDER BY outcome").all()).toEqual([
      { outcome: "non_delivery", n: 2 },
      { outcome: "ok", n: 20 },
    ]);
    expect(db.prepare("SELECT status, reason FROM validator_results WHERE call_id = 1 AND validator = 'content_type'").get()).toEqual({ status: "pass", reason: "content_type_mismatch" });
    const audit = db.prepare("SELECT COUNT(*) n, MIN(reason) reason FROM reclassifications WHERE new_outcome = 'ok'").get() as { n: number; reason: string };
    expect(audit).toEqual({ n: 20, reason: "issue 40: format warning" });
    expect(db.prepare("SELECT outcome FROM calls WHERE id = 22").get()).toEqual({ outcome: "non_delivery" });

    const out = mkdtempSync(join(tmpdir(), "export-format-"));
    runExport(db, { network: MAINNET, now: T0 + 86_400_000, outDir: out, gitCommit: "test" });
    const sellers = JSON.parse(readFileSync(join(out, "sellers.json"), "utf8"));
    const s = [...sellers.sellers, ...sellers.low_sample].find((x: { domain: string }) => x.domain === "aiact-api.com");
    expect(s).toMatchObject({ denominator_calls: 22, failures: 2, failures_by_type: { non_delivery: 2 } });
    expect(s.format_mismatch).toEqual({ calls: 20, last_ts: new Date(T0 + 20 * 60_000).toISOString(), by_type: [{ declared: "application/json", received: "text/markdown", calls: 20 }] });
  });
});
