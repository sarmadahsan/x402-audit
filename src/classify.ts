/**
 * Outcome classifier. Implements docs/taxonomy.md "Precedence" exactly:
 * our_error > not_paid > indeterminate > duplicate > non_delivery > wrong_goods
 * > overcharge > injection > ok. The first matching outcome wins; later
 * conditions that also hold become secondary flags.
 *
 * Pure function: no I/O, no clock. All amounts are atomic-unit bigint strings
 * and are compared as bigint so large values never lose precision.
 */
import {
  FLAGS,
  INDETERMINATE_POLL_MAX_MS,
  OUTCOMES,
  VALIDATORS,
  type Flag,
  type Outcome,
  type ReferenceSource,
  type ValidatorName,
} from "./taxonomy.js";
import type { ValidatorResult } from "./validators/types.js";

export interface ClassificationInput {
  /** Did the harness itself fail (malformed request, local exception, 429, cap/halt before signing)? */
  ourError?: { reason: string };
  /** Was a payment signed and sent at all? */
  paymentSent: boolean;
  /** Number of distinct on-chain (or facilitator-confirmed) settlements for this intent. */
  settlementCount: number;
  /** True if we received a usable HTTP response after paying (status + body), false if the seller/facilitator timed out or the connection dropped. */
  responseReceived: boolean;
  /** HTTP status of the post-payment response, when one was received. */
  responseStatus?: number;
  /** ms since signing; used with settlementCount to decide indeterminate vs not_paid. */
  elapsedSinceSignMs: number;
  /** Quote vs reference. Atomic units as bigint strings. reference may be undefined if we had none at all. */
  quoteAmountAtomic: string;
  referencePriceAtomic?: string;
  referenceSource?: ReferenceSource;
  /** Whether the quote was actually paid (false when over MAX_PER_CALL_USD, and false for probe rows). */
  paid: boolean;
  /** True when a buy attempt was skipped because the quote exceeded MAX_PER_CALL_USD. Distinguishes "unpaid because over cap" from probe rows. */
  overCap?: boolean;
  validators?: Partial<Record<ValidatorName, ValidatorResult>>;
  latencyMs?: number;
  declaredMaxTimeoutSeconds?: number;
  defaultMaxTimeoutSeconds: number;
  /** Did we have a service config (schema/extractor) for this seller? */
  serviceConfigPresent: boolean;
  payToChanged?: boolean;
  priceDiscrimination?: boolean;
  truncatedByUs?: boolean;
  rateLimited?: boolean;
  /** Set when a previously-indeterminate row is being re-classified by the background poller. */
  resolvedLate?: boolean;
}

export interface Classification {
  outcome: Outcome;
  flags: Flag[];
  reasons: string[];
  overchargeRatio?: number;
}

const DELIVERY_VALIDATORS: readonly ValidatorName[] = [
  VALIDATORS.HTTP_STATUS,
  VALIDATORS.NON_EMPTY,
  VALIDATORS.CONTENT_TYPE,
  VALIDATORS.NOT_TRUNCATED,
];
const GOODS_VALIDATORS: readonly ValidatorName[] = [
  VALIDATORS.JSON_SCHEMA,
  VALIDATORS.ENTITY_MATCHES,
  VALIDATORS.FRESHNESS,
];

/** Ratio precision for overchargeRatio (computed in bigint, then scaled down). */
const RATIO_SCALE = 10n ** 12n;

function parseAtomic(label: string, value: string): bigint {
  if (!/^\d+$/.test(value)) {
    throw new Error(`classify: ${label} must be a non-negative integer string of atomic units, got ${JSON.stringify(value)}`);
  }
  return BigInt(value);
}

function failed(input: ClassificationInput, name: ValidatorName): boolean {
  // "skipped" never counts as a failure; an absent validator did not run.
  return input.validators?.[name]?.status === "fail";
}

function is2xx(status: number): boolean {
  return status >= 200 && status < 300;
}

export function classify(input: ClassificationInput): Classification {
  const reasons: string[] = [];
  const flags = new Set<Flag>();

  // ---- price comparison (needed by several branches) ----
  const quote = parseAtomic("quoteAmountAtomic", input.quoteAmountAtomic);
  let overchargeRatio: number | undefined;
  let isOver = false;
  if (input.referencePriceAtomic === undefined) {
    reasons.push("reference:none");
  } else {
    const ref = parseAtomic("referencePriceAtomic", input.referencePriceAtomic);
    isOver = quote > ref;
    if (ref === 0n) {
      overchargeRatio = quote === 0n ? 1 : Number.POSITIVE_INFINITY;
    } else {
      overchargeRatio = Number((quote * RATIO_SCALE) / ref) / Number(RATIO_SCALE);
    }
    reasons.push(
      `quote=${quote} reference=${ref} source=${input.referenceSource ?? "unknown"}${isOver ? " (over)" : ""}`,
    );
  }

  // ---- pass-through and outcome-independent flags ----
  if (input.payToChanged) flags.add(FLAGS.PAYTO_CHANGED);
  if (input.priceDiscrimination) flags.add(FLAGS.PRICE_DISCRIMINATION);
  if (input.truncatedByUs) flags.add(FLAGS.TRUNCATED_BY_US);
  if (input.resolvedLate) flags.add(FLAGS.RESOLVED_LATE);
  if (input.rateLimited) flags.add(FLAGS.RATE_LIMITED);
  // Seller settled, then rejected the request as malformed: money gone for nothing (docs/taxonomy.md flags).
  if (input.settlementCount >= 1 && input.responseStatus !== undefined && [400, 405, 415, 422].includes(input.responseStatus)) {
    flags.add(FLAGS.CHARGED_THEN_REJECTED);
    reasons.push(`charged_then_rejected:status=${input.responseStatus}`);
  }

  if (failed(input, VALIDATORS.INJECTION_SCAN)) {
    flags.add(FLAGS.INJECTION_HIT);
    reasons.push("injection_scan:fail");
  }

  if (!input.serviceConfigPresent) {
    flags.add(FLAGS.SCHEMA_MISSING);
    reasons.push("schema_missing:no_service_config");
  } else if (
    // Literal reading of the contract: all three were run and all three skipped.
    // An absent validator means validation never ran (e.g. no response), which is not a config gap.
    GOODS_VALIDATORS.every((v) => input.validators?.[v]?.status === "skipped")
  ) {
    flags.add(FLAGS.SCHEMA_MISSING);
    reasons.push("schema_missing:wrong_goods_validators_all_skipped");
  }

  if (input.latencyMs !== undefined) {
    const declared = input.declaredMaxTimeoutSeconds;
    const limitS = declared ?? input.defaultMaxTimeoutSeconds;
    const which = declared !== undefined ? "declared" : "default";
    if (input.latencyMs > limitS * 1000) {
      flags.add(FLAGS.SLOW);
      reasons.push(`slow:latency=${input.latencyMs}ms>${limitS}s(${which})`);
    }
  }

  const outcome = decide(input, isOver, reasons, flags);

  if (isOver && outcome !== OUTCOMES.OVERCHARGE) flags.add(FLAGS.OVERCHARGED);

  // Keep flags in canonical (taxonomy) order for stable output.
  const ordered = (Object.values(FLAGS) as Flag[]).filter((f) => flags.has(f));
  const result: Classification = { outcome, flags: ordered, reasons };
  if (overchargeRatio !== undefined) result.overchargeRatio = overchargeRatio;
  return result;
}

function decide(input: ClassificationInput, isOver: boolean, reasons: string[], flags: Set<Flag>): Outcome {
  // 1. our_error
  if (input.ourError || input.rateLimited) {
    if (input.ourError) reasons.push(`our_error:${input.ourError.reason}`);
    if (input.rateLimited) reasons.push("our_error:rate_limited");
    return OUTCOMES.OUR_ERROR;
  }

  // Quote over reference and over the per-call cap: nothing paid, nothing delivered.
  if (isOver && !input.paid && input.overCap) {
    flags.add(FLAGS.UNPAID_OVERCHARGE);
    reasons.push("unpaid_overcharge:quote_over_reference_not_paid");
    return OUTCOMES.OVERCHARGE;
  }

  if (!input.paymentSent) {
    // Probe rows (no payment): only ok / overcharge / our_error are possible.
    reasons.push("payment_not_sent");
    if (isOver) {
      reasons.push("overcharge:quote>reference");
      return OUTCOMES.OVERCHARGE;
    }
    return OUTCOMES.OK;
  }

  const n = input.settlementCount;
  reasons.push(`settlementCount=${n}`);

  if (n === 0) {
    if (input.responseReceived) {
      const status = input.responseStatus;
      const delivered =
        status !== undefined ? is2xx(status) : input.validators?.[VALIDATORS.HTTP_STATUS]?.status === "pass";
      if (!delivered) {
        // 2. not_paid: seller/facilitator rejected the payment, nothing settled.
        reasons.push(`not_paid:rejected status=${status ?? "unknown"}`);
        return OUTCOMES.NOT_PAID;
      }
      // Delivered without a visible settlement: classify by validators as if paid.
      reasons.push(`settlement_unconfirmed status=${status ?? "unknown"}`);
      if (input.elapsedSinceSignMs >= INDETERMINATE_POLL_MAX_MS) {
        reasons.push("settlement_absent_after_24h");
      }
      return byValidators(input, isOver, reasons);
    }
    if (input.elapsedSinceSignMs >= INDETERMINATE_POLL_MAX_MS) {
      reasons.push("not_paid:no_response_no_settlement_after_24h");
      return OUTCOMES.NOT_PAID;
    }
    // 3. indeterminate
    reasons.push(`indeterminate:no_response elapsed=${input.elapsedSinceSignMs}ms`);
    return OUTCOMES.INDETERMINATE;
  }

  // 4. duplicate
  if (n > 1) {
    reasons.push("duplicate:multiple_settlements");
    return OUTCOMES.DUPLICATE;
  }

  if (!input.responseReceived) {
    reasons.push("non_delivery:paid_no_response");
    return OUTCOMES.NON_DELIVERY;
  }

  return byValidators(input, isOver, reasons);
}

/** Steps 5-9 of the precedence list, given that money moved (or the seller delivered as if it had). */
function byValidators(input: ClassificationInput, isOver: boolean, reasons: string[]): Outcome {
  const delivery = DELIVERY_VALIDATORS.filter((v) => failed(input, v));
  if (delivery.length > 0) {
    for (const v of delivery) reasons.push(`${v}:fail`);
    return OUTCOMES.NON_DELIVERY;
  }
  const goods = GOODS_VALIDATORS.filter((v) => failed(input, v));
  if (goods.length > 0) {
    for (const v of goods) reasons.push(`${v}:fail`);
    return OUTCOMES.WRONG_GOODS;
  }
  if (isOver) {
    reasons.push("overcharge:quote>reference");
    return OUTCOMES.OVERCHARGE;
  }
  if (failed(input, VALIDATORS.INJECTION_SCAN)) {
    return OUTCOMES.INJECTION;
  }
  return OUTCOMES.OK;
}
