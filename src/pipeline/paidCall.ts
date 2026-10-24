/**
 * The one paid-call path shared by `buy` and `stress`: ledger before signing,
 * official client for the payment, validators, settlement lookup, classifier,
 * and one `calls` row with every piece of evidence.
 */
import { createHash, randomUUID } from "node:crypto";
import type { Db } from "../db/index.js";
import { classify, type Classification } from "../classify.js";
import { log } from "../log.js";
import { CALL_SOURCES, FLAGS, INDETERMINATE_POLL_MAX_MS, type CallSource, type ReferenceSource } from "../taxonomy.js";
import { runAllValidators } from "../validators/index.js";
import type { ServiceConfig, ValidationContext, ValidatorResult } from "../validators/types.js";
import type { PaidResult, Payer, SignedAuthorization } from "../x402/pay.js";
import type { NormalizedRequirements } from "../x402/types.js";

export interface SettlementFact {
  txHash: string;
  logIndex?: number;
  blockNumber?: number;
  blockTs?: number;
  from: string;
  to: string;
  valueAtomic: string;
  nonce?: string;
  source: "chain" | "facilitator_header" | "x402scan" | "mock";
}

/** Finds settlements for a signed authorization. Milestone 1: the mock's ledger. Milestone 3+: viem over Base. */
export type SettlementLookup = (signed: SignedAuthorization) => Promise<SettlementFact[]>;

export interface PaidCallInput {
  db: Db;
  payer: Payer;
  runId?: number;
  source: CallSource;
  resource: { id: number; sellerId: number; url: string; method?: string; headers?: Record<string, string>; body?: string };
  clientIdentity?: string;
  /** Reference price in atomic units and where it came from; undefined when we have none. */
  reference?: { amountAtomic: string; source: ReferenceSource };
  /** Per-call cap in atomic units; the quote is refused (not signed) above this. */
  perCallCapAtomic: bigint;
  service?: ServiceConfig;
  defaultMaxTimeoutSeconds: number;
  settlementLookup: SettlementLookup;
  timeoutMs?: number;
  abortAfterMs?: number;
  /** Probe-derived flags supplied by the caller. */
  payToChanged?: boolean;
  priceDiscrimination?: boolean;
  /** Reuse an intent id (stress duplicate test). */
  intentId?: string;
  now?: () => number;
}

export interface PaidCallOutput {
  callId: number;
  intentId: string;
  result: PaidResult;
  classification: Classification;
  validators?: Record<string, ValidatorResult>;
  settlements: SettlementFact[];
}

const sha256 = (b: Uint8Array) => createHash("sha256").update(b).digest("hex");

export async function runPaidCall(i: PaidCallInput): Promise<PaidCallOutput> {
  const now = i.now ?? Date.now;
  const intentId = i.intentId ?? randomUUID();
  const method = i.resource.method ?? "GET";
  const startedAt = now();
  let signedAt = 0;
  let overCap = false;
  let declinedReason: string | undefined;
  let quoteSeen: NormalizedRequirements | undefined;

  const insertAttempt = i.db.prepare(
    `INSERT INTO attempts (intent_id, run_id, source, ts, resource_id, wallet, pay_to, network, asset, amount_atomic, nonce, phase)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
  );

  const result = await i.payer.payAndFetch(
    i.resource.url,
    {
      method,
      ...(i.resource.headers ? { headers: i.resource.headers } : {}),
      ...(i.resource.body !== undefined ? { body: i.resource.body } : {}),
      ...(i.timeoutMs !== undefined ? { timeoutMs: i.timeoutMs } : {}),
      ...(i.abortAfterMs !== undefined ? { abortAfterMs: i.abortAfterMs } : {}),
    },
    {
      async beforeSign(req) {
        quoteSeen = req;
        const amount = BigInt(req.amountAtomic);
        if (amount > i.perCallCapAtomic) {
          overCap = true;
          declinedReason = `quote ${req.amountAtomic} exceeds per-call cap ${i.perCallCapAtomic}`;
          return { abort: declinedReason };
        }
        // Ledger row BEFORE signing. If we crash after this, the row says money may have moved.
        insertAttempt.run(intentId, i.runId ?? null, i.source, now(), i.resource.id, i.payer.address, req.payTo, req.network, req.asset, req.amountAtomic, null, "planned");
        return "proceed";
      },
      async afterSign(info) {
        signedAt = now();
        insertAttempt.run(intentId, i.runId ?? null, i.source, signedAt, i.resource.id, info.from, info.to, quoteSeen?.network ?? "", quoteSeen?.asset ?? "", info.value, info.nonce, "signed");
      },
    },
  );

  const quote = result.quote ?? quoteSeen;
  const paymentSent = Boolean(result.signed);
  const response = result.response;

  let validators: Record<string, ValidatorResult> | undefined;
  if (response) {
    const ctx: ValidationContext = {
      request: result.request,
      response,
      requirements: {
        ...(quote?.mimeType !== undefined ? { mimeType: quote.mimeType } : {}),
        ...(quote?.maxTimeoutSeconds !== undefined ? { maxTimeoutSeconds: quote.maxTimeoutSeconds } : {}),
        ...(quote?.outputSchema !== undefined ? { outputSchema: quote.outputSchema } : {}),
      },
      ...(i.service ? { service: i.service } : {}),
      now: now(),
    };
    validators = await runAllValidators(ctx);
  }

  const settlements = result.signed ? await i.settlementLookup(result.signed) : [];
  // The seller's own settlement header is evidence too, but it is not a settlement fact: only the chain is.

  const ourError = (() => {
    if (!result.error) return undefined;
    switch (result.error.kind) {
      case "cap":
      case "declined":
        return overCap ? undefined : { reason: `${result.error.kind}: ${result.error.message}` };
      case "no_quote":
      case "network":
      case "sdk":
        return paymentSent ? undefined : { reason: `${result.error.kind}: ${result.error.message}` };
      default:
        return undefined; // timeout / aborted after signing are not our error
    }
  })();
  const rateLimited = response?.status === 429 || result.quoteResult?.status === 429;
  // A 400/405/415/422 with no settlement means the seller rejected the request itself, not the payment:
  // our malformed request (docs/taxonomy.md #8), excluded from the denominator and counted separately.
  const badRequest = response && [400, 405, 415, 422].includes(response.status) && settlements.length === 0;
  const ourErrorFinal = ourError ?? (badRequest ? { reason: `malformed_request:http_${response!.status}` } : undefined);

  const classification = classify({
    ...(ourErrorFinal ? { ourError: ourErrorFinal } : {}),
    paymentSent,
    settlementCount: new Set(settlements.map((s) => s.txHash)).size,
    responseReceived: Boolean(response),
    ...(response ? { responseStatus: response.status } : {}),
    elapsedSinceSignMs: signedAt ? now() - signedAt : 0,
    quoteAmountAtomic: quote?.amountAtomic ?? "0",
    ...(i.reference ? { referencePriceAtomic: i.reference.amountAtomic, referenceSource: i.reference.source } : {}),
    paid: paymentSent,
    overCap,
    ...(validators ? { validators } : {}),
    ...(response ? { latencyMs: response.latencyMs } : {}),
    ...(quote?.maxTimeoutSeconds !== undefined ? { declaredMaxTimeoutSeconds: i.service?.max_timeout_seconds ?? quote.maxTimeoutSeconds } : {}),
    defaultMaxTimeoutSeconds: i.defaultMaxTimeoutSeconds,
    serviceConfigPresent: Boolean(i.service),
    ...(i.payToChanged !== undefined ? { payToChanged: i.payToChanged } : {}),
    ...(i.priceDiscrimination !== undefined ? { priceDiscrimination: i.priceDiscrimination } : {}),
    ...(response?.truncatedByUs ? { truncatedByUs: true } : {}),
    ...(rateLimited ? { rateLimited: true } : {}),
  });

  const callId = persistCall(i, intentId, result, quote, classification, validators, settlements, signedAt, startedAt);
  log.info(`call ${intentId.slice(0, 8)} ${i.resource.url} -> ${classification.outcome} [${classification.flags.join(",")}]`);
  return { callId, intentId, result, classification, ...(validators ? { validators } : {}), settlements };
}

function persistCall(
  i: PaidCallInput,
  intentId: string,
  r: PaidResult,
  quote: NormalizedRequirements | undefined,
  c: Classification,
  validators: Record<string, ValidatorResult> | undefined,
  settlements: SettlementFact[],
  signedAt: number,
  startedAt: number,
): number {
  const db = i.db;
  const resolveUntil = c.outcome === "indeterminate" ? signedAt + INDETERMINATE_POLL_MAX_MS : null;
  const first = settlements[0];
  const insert = db.transaction(() => {
    const res = db
      .prepare(
        `INSERT INTO calls (intent_id, run_id, source, resource_id, seller_id, ts, wallet, client_identity, x402_version,
           quote_amount_atomic, quote_asset, quote_network, quote_pay_to, quote_requirements_json,
           reference_price_atomic, reference_source, paid, amount_paid_atomic, request_json, nonce, valid_after, valid_before,
           response_status, response_headers_json, response_body, response_body_sha256, response_body_bytes,
           response_truncated_by_us, response_incomplete, settlement_header_json, settlement_tx_hash, settlement_block,
           settlement_confirmed_at, settlement_count, latency_ms, outcome, flags_json, our_error_reason, classified_at, resolve_until, error)
         VALUES (?,?,?,?,?,?,?,?,?, ?,?,?,?,?, ?,?,?,?,?,?,?,?, ?,?,?,?,?, ?,?,?,?,?, ?,?,?,?,?,?,?,?,?)`,
      )
      .run(
        intentId, i.runId ?? null, i.source, i.resource.id, i.resource.sellerId, startedAt, i.payer.address, i.clientIdentity ?? null, quote?.x402Version ?? null,
        quote?.amountAtomic ?? null, quote?.asset ?? null, quote?.network ?? null, quote?.payTo ?? null, quote ? JSON.stringify(quote.raw) : null,
        i.reference?.amountAtomic ?? null, i.reference?.source ?? null, r.signed ? 1 : 0, r.signed?.value ?? null,
        JSON.stringify({ url: r.request.url, method: r.request.method, headers: r.request.headers, params: r.request.params, body: r.request.body ?? null }),
        r.signed?.nonce ?? null, r.signed ? Number(r.signed.validAfter) : null, r.signed ? Number(r.signed.validBefore) : null,
        r.response?.status ?? null, r.response ? JSON.stringify(r.response.headers) : null, r.response ? Buffer.from(r.response.body) : null,
        r.response ? sha256(r.response.body) : null, r.response?.body.length ?? null,
        r.response?.truncatedByUs ? 1 : 0, r.response?.incomplete ? 1 : 0,
        r.settlement ? JSON.stringify(r.settlement) : r.settlementHeaderRaw ?? null,
        first?.txHash ?? null, first?.blockNumber ?? null, first ? Date.now() : null, settlements.length,
        r.response?.latencyMs ?? null, c.outcome, JSON.stringify(c.flags), c.outcome === "our_error" ? c.reasons.join("; ") : null, Date.now(), resolveUntil,
        r.error ? `${r.error.kind}: ${r.error.message}` : null,
      );
    const callId = Number(res.lastInsertRowid);
    if (validators) {
      const vi = db.prepare(`INSERT INTO validator_results (call_id, validator, status, reason, evidence_json) VALUES (?,?,?,?,?)`);
      for (const [name, v] of Object.entries(validators)) vi.run(callId, name, v.status, v.reason ?? null, JSON.stringify(v.evidence));
    }
    const si = db.prepare(
      `INSERT OR IGNORE INTO settlements (call_id, intent_id, tx_hash, log_index, block_number, block_ts, from_addr, to_addr, value_atomic, nonce, source, found_at)
       VALUES (?,?,?,?,?,?,?,?,?,?,?,?)`,
    );
    for (const s of settlements) si.run(callId, intentId, s.txHash, s.logIndex ?? 0, s.blockNumber ?? null, s.blockTs ?? null, s.from, s.to, s.valueAtomic, s.nonce ?? null, s.source, Date.now());
    return callId;
  });
  return insert();
}

/** Re-classify an indeterminate row once the background poller has a settlement answer. */
export function resolveIndeterminate(db: Db, callId: number, settlements: SettlementFact[], defaultMaxTimeoutSeconds: number): Classification {
  const row = db.prepare(`SELECT * FROM calls WHERE id = ?`).get(callId) as Record<string, unknown> | undefined;
  if (!row) throw new Error(`call ${callId} not found`);
  if (row.outcome !== "indeterminate") throw new Error(`call ${callId} is ${String(row.outcome)}, not indeterminate`);
  const signedAt = Number(row.ts);
  const c = classify({
    paymentSent: true,
    settlementCount: new Set(settlements.map((s) => s.txHash)).size,
    responseReceived: false,
    elapsedSinceSignMs: Date.now() - signedAt,
    quoteAmountAtomic: String(row.quote_amount_atomic ?? "0"),
    ...(row.reference_price_atomic ? { referencePriceAtomic: String(row.reference_price_atomic), referenceSource: row.reference_source as ReferenceSource } : {}),
    paid: true,
    defaultMaxTimeoutSeconds,
    serviceConfigPresent: false,
    resolvedLate: true,
  });
  const flags = Array.from(new Set([...(JSON.parse(String(row.flags_json)) as string[]), ...c.flags, FLAGS.RESOLVED_LATE]));
  db.transaction(() => {
    db.prepare(`UPDATE calls SET outcome = ?, flags_json = ?, settlement_count = ?, settlement_tx_hash = ?, settlement_confirmed_at = ?, classified_at = ? WHERE id = ?`).run(
      c.outcome, JSON.stringify(flags), settlements.length, settlements[0]?.txHash ?? null, settlements[0] ? Date.now() : null, Date.now(), callId,
    );
    const si = db.prepare(
      `INSERT OR IGNORE INTO settlements (call_id, intent_id, tx_hash, log_index, block_number, block_ts, from_addr, to_addr, value_atomic, nonce, source, found_at) VALUES (?,?,?,?,?,?,?,?,?,?,?,?)`,
    );
    for (const s of settlements) si.run(callId, String(row.intent_id), s.txHash, s.logIndex ?? 0, s.blockNumber ?? null, s.blockTs ?? null, s.from, s.to, s.valueAtomic, s.nonce ?? null, s.source, Date.now());
  })();
  return { ...c, flags: flags as Classification["flags"] };
}

export { CALL_SOURCES };
