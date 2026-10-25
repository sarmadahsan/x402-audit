/**
 * Re-run the validators and the classifier on stored call rows. Every call row keeps the full request,
 * response (headers, body, status, framing flags), quote, reference and settlement facts, so a validator
 * bug fix can be applied to history without touching the chain or the seller. Each change is written to
 * the `reclassifications` audit table with the reason and the code commit.
 */
import { execSync } from "node:child_process";
import { classify } from "../classify.js";
import type { Db } from "../db/index.js";
import { FLAGS, type Flag, type ReferenceSource } from "../taxonomy.js";
import { runAllValidators } from "../validators/index.js";
import { malformedRequestReason } from "./badRequest.js";
import type { ServiceConfig, ValidationContext, ValidatorResult } from "../validators/types.js";

export interface ReclassifyOptions {
  reason: string;
  apply: boolean;
  /** Restrict to these call ids; default: every buy/stress row that has a stored response. */
  callIds?: number[];
  services?: (domain: string) => ServiceConfig | undefined;
  defaultMaxTimeoutSeconds?: number;
  now?: () => number;
}

export interface ReclassifyChange { callId: number; intentId: string; url: string; oldOutcome: string | null; newOutcome: string; oldFlags: string[]; newFlags: string[] }
export interface ReclassifyResult { examined: number; changed: ReclassifyChange[]; applied: boolean }

interface Row {
  id: number; intent_id: string; url: string; domain: string; ts: number; paid: number; settlement_count: number;
  quote_amount_atomic: string | null; reference_price_atomic: string | null; reference_source: string | null; quote_requirements_json: string | null;
  request_json: string; response_status: number | null; response_headers_json: string | null; response_body: Buffer | null;
  response_truncated_by_us: number; response_incomplete: number; latency_ms: number | null; outcome: string | null; flags_json: string;
}

function currentCommit(): string | null {
  try { return execSync("git rev-parse HEAD", { encoding: "utf8" }).trim(); } catch { return null; }
}

export async function reclassifyCalls(db: Db, o: ReclassifyOptions): Promise<ReclassifyResult> {
  const now = o.now ?? Date.now;
  const where = o.callIds?.length ? `AND c.id IN (${o.callIds.map(() => "?").join(",")})` : "";
  const rows = db
    .prepare(
      `SELECT c.id, c.intent_id, r.url, s.domain, c.ts, c.paid, c.settlement_count, c.quote_amount_atomic, c.reference_price_atomic, c.reference_source,
              c.quote_requirements_json, c.request_json, c.response_status, c.response_headers_json, c.response_body, c.response_truncated_by_us,
              c.response_incomplete, c.latency_ms, c.outcome, c.flags_json
         FROM calls c JOIN resources r ON r.id = c.resource_id JOIN sellers s ON s.id = c.seller_id
        WHERE c.response_body IS NOT NULL AND c.outcome IS NOT NULL ${where} ORDER BY c.id`,
    )
    .all(...(o.callIds ?? [])) as Row[];

  const changed: ReclassifyChange[] = [];
  const commit = currentCommit();

  // Rows with no response at all whose error says the seller never offered a payable 402: not_paid, not our_error.
  const unavailable = db
    .prepare(`SELECT c.id, c.intent_id, r.url, c.outcome, c.flags_json FROM calls c JOIN resources r ON r.id = c.resource_id
               WHERE c.response_body IS NULL AND c.outcome = 'our_error' AND (c.error LIKE 'no_quote:%' OR c.error LIKE 'network:%') ${where}`)
    .all(...(o.callIds ?? [])) as { id: number; intent_id: string; url: string; outcome: string; flags_json: string }[];
  for (const u of unavailable) {
    changed.push({ callId: u.id, intentId: u.intent_id, url: u.url, oldOutcome: u.outcome, newOutcome: "not_paid", oldFlags: JSON.parse(u.flags_json), newFlags: JSON.parse(u.flags_json) });
    if (o.apply) {
      db.transaction(() => {
        db.prepare("UPDATE calls SET outcome = 'not_paid', our_error_reason = NULL, classified_at = ? WHERE id = ?").run(now(), u.id);
        db.prepare("INSERT INTO reclassifications (call_id, ts, reason, old_outcome, new_outcome, old_flags_json, new_flags_json, code_commit) VALUES (?,?,?,?,?,?,?,?)")
          .run(u.id, now(), o.reason, u.outcome, "not_paid", u.flags_json, u.flags_json, commit);
      })();
    }
  }
  const upd = db.prepare("UPDATE calls SET outcome = ?, flags_json = ?, classified_at = ? WHERE id = ?");
  const delV = db.prepare("DELETE FROM validator_results WHERE call_id = ?");
  const insV = db.prepare("INSERT INTO validator_results (call_id, validator, status, reason, evidence_json) VALUES (?,?,?,?,?)");
  const audit = db.prepare("INSERT INTO reclassifications (call_id, ts, reason, old_outcome, new_outcome, old_flags_json, new_flags_json, code_commit) VALUES (?,?,?,?,?,?,?,?)");

  for (const row of rows) {
    const req = JSON.parse(row.request_json) as { url: string; method: string; headers: Record<string, string>; params: Record<string, unknown>; body: string | null };
    const headers = (row.response_headers_json ? JSON.parse(row.response_headers_json) : {}) as Record<string, string>;
    const quote = (row.quote_requirements_json ? JSON.parse(row.quote_requirements_json) : {}) as Record<string, unknown>;
    const declaredLength = headers["content-length"] ? Number(headers["content-length"]) : undefined;
    const ctx: ValidationContext = {
      request: { url: req.url, method: req.method, headers: req.headers ?? {}, params: req.params ?? {}, ...(req.body != null ? { body: req.body } : {}), sentAt: row.ts },
      response: {
        status: row.response_status ?? 0,
        headers,
        body: new Uint8Array(row.response_body!),
        truncatedByUs: row.response_truncated_by_us === 1,
        incomplete: row.response_incomplete === 1,
        ...(declaredLength !== undefined && Number.isFinite(declaredLength) ? { declaredLength } : {}),
        receivedAt: row.ts + (row.latency_ms ?? 0),
        latencyMs: row.latency_ms ?? 0,
      },
      requirements: {
        ...(typeof quote.mimeType === "string" ? { mimeType: quote.mimeType } : {}),
        ...(typeof quote.maxTimeoutSeconds === "number" ? { maxTimeoutSeconds: quote.maxTimeoutSeconds } : {}),
      },
      ...(o.services?.(row.domain) ? { service: o.services(row.domain)! } : {}),
      // Freshness is judged relative to when the response was received, not to now.
      now: row.ts + (row.latency_ms ?? 0),
    };
    const validators: Record<string, ValidatorResult> = await runAllValidators(ctx);
    const oldFlags = JSON.parse(row.flags_json) as Flag[];
    const badReason = malformedRequestReason(row.response_status, Buffer.from(row.response_body!).toString("utf8").slice(0, 4096), row.settlement_count);
    const c = classify({
      ...(badReason ? { ourError: { reason: badReason } } : {}),
      paymentSent: row.paid === 1,
      settlementCount: row.settlement_count,
      responseReceived: true,
      ...(row.response_status != null ? { responseStatus: row.response_status } : {}),
      elapsedSinceSignMs: now() - row.ts,
      quoteAmountAtomic: row.quote_amount_atomic ?? "0",
      ...(row.reference_price_atomic ? { referencePriceAtomic: row.reference_price_atomic, referenceSource: (row.reference_source ?? "first_seen") as ReferenceSource } : {}),
      paid: row.paid === 1,
      validators,
      ...(row.latency_ms != null ? { latencyMs: row.latency_ms } : {}),
      ...(typeof quote.maxTimeoutSeconds === "number" ? { declaredMaxTimeoutSeconds: quote.maxTimeoutSeconds } : {}),
      defaultMaxTimeoutSeconds: o.defaultMaxTimeoutSeconds ?? 30,
      serviceConfigPresent: Boolean(o.services?.(row.domain)),
      payToChanged: oldFlags.includes(FLAGS.PAYTO_CHANGED),
      priceDiscrimination: oldFlags.includes(FLAGS.PRICE_DISCRIMINATION),
      truncatedByUs: row.response_truncated_by_us === 1,
      rateLimited: row.response_status === 429,
      resolvedLate: oldFlags.includes(FLAGS.RESOLVED_LATE),
    });
    const same = c.outcome === row.outcome && JSON.stringify([...c.flags].sort()) === JSON.stringify([...oldFlags].sort());
    if (same) continue;
    changed.push({ callId: row.id, intentId: row.intent_id, url: row.url, oldOutcome: row.outcome, newOutcome: c.outcome, oldFlags, newFlags: c.flags });
    if (o.apply) {
      db.transaction(() => {
        upd.run(c.outcome, JSON.stringify(c.flags), now(), row.id);
        delV.run(row.id);
        for (const [name, v] of Object.entries(validators)) insV.run(row.id, name, v.status, v.reason ?? null, JSON.stringify(v.evidence));
        audit.run(row.id, now(), o.reason, row.outcome, c.outcome, JSON.stringify(oldFlags), JSON.stringify(c.flags), commit);
      })();
    }
  }
  return { examined: rows.length, changed, applied: o.apply };
}
