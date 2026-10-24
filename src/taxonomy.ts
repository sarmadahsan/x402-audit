/**
 * Failure taxonomy constants. Mirrors docs/taxonomy.md exactly; the test in
 * taxonomy.test.ts parses that document and fails if the two drift.
 * NEVER add, remove or rename a constant without updating docs/taxonomy.md.
 */

export const OUTCOMES = {
  OK: "ok",
  OVERCHARGE: "overcharge",
  NON_DELIVERY: "non_delivery",
  WRONG_GOODS: "wrong_goods",
  INJECTION: "injection",
  DUPLICATE: "duplicate",
  INDETERMINATE: "indeterminate",
  OUR_ERROR: "our_error",
  NOT_PAID: "not_paid",
} as const;
export type Outcome = (typeof OUTCOMES)[keyof typeof OUTCOMES];
export const ALL_OUTCOMES: readonly Outcome[] = Object.values(OUTCOMES);

/** Precedence: first match wins. See docs/taxonomy.md "Precedence". */
export const OUTCOME_PRECEDENCE: readonly Outcome[] = [
  OUTCOMES.OUR_ERROR,
  OUTCOMES.NOT_PAID,
  OUTCOMES.INDETERMINATE,
  OUTCOMES.DUPLICATE,
  OUTCOMES.NON_DELIVERY,
  OUTCOMES.WRONG_GOODS,
  OUTCOMES.OVERCHARGE,
  OUTCOMES.INJECTION,
  OUTCOMES.OK,
];

/** Outcomes that count in the paid denominator. */
export const PAID_DENOMINATOR_OUTCOMES: ReadonlySet<Outcome> = new Set<Outcome>([
  OUTCOMES.OK,
  OUTCOMES.OVERCHARGE,
  OUTCOMES.NON_DELIVERY,
  OUTCOMES.WRONG_GOODS,
  OUTCOMES.INJECTION,
  OUTCOMES.DUPLICATE,
]);

/** Outcomes that count as a confirmed failure in the headline number. */
export const HEADLINE_FAILURE_OUTCOMES: ReadonlySet<Outcome> = new Set<Outcome>([
  OUTCOMES.OVERCHARGE,
  OUTCOMES.NON_DELIVERY,
  OUTCOMES.WRONG_GOODS,
  OUTCOMES.DUPLICATE,
]);

export const FLAGS = {
  PAYTO_CHANGED: "payto_changed",
  PRICE_DISCRIMINATION: "price_discrimination",
  SLOW: "slow",
  SCHEMA_MISSING: "schema_missing",
  OVERCHARGED: "overcharged",
  UNPAID_OVERCHARGE: "unpaid_overcharge",
  INJECTION_HIT: "injection_hit",
  RESOLVED_LATE: "resolved_late",
  TRUNCATED_BY_US: "truncated_by_us",
  RATE_LIMITED: "rate_limited",
  CHARGED_THEN_REJECTED: "charged_then_rejected",
} as const;
export type Flag = (typeof FLAGS)[keyof typeof FLAGS];
export const ALL_FLAGS: readonly Flag[] = Object.values(FLAGS);

export const VALIDATORS = {
  HTTP_STATUS: "http_status",
  NON_EMPTY: "non_empty",
  CONTENT_TYPE: "content_type",
  NOT_TRUNCATED: "not_truncated",
  JSON_SCHEMA: "json_schema",
  ENTITY_MATCHES: "entity_matches",
  FRESHNESS: "freshness",
  INJECTION_SCAN: "injection_scan",
} as const;
export type ValidatorName = (typeof VALIDATORS)[keyof typeof VALIDATORS];
export const ALL_VALIDATORS: readonly ValidatorName[] = Object.values(VALIDATORS);

/** Which outcome a failing validator implies (docs/taxonomy.md "Validators"). */
export const VALIDATOR_FAILS_INTO: Readonly<Record<ValidatorName, Outcome>> = {
  http_status: OUTCOMES.NON_DELIVERY,
  non_empty: OUTCOMES.NON_DELIVERY,
  content_type: OUTCOMES.NON_DELIVERY,
  not_truncated: OUTCOMES.NON_DELIVERY,
  json_schema: OUTCOMES.WRONG_GOODS,
  entity_matches: OUTCOMES.WRONG_GOODS,
  freshness: OUTCOMES.WRONG_GOODS,
  injection_scan: OUTCOMES.INJECTION,
};

export const REFERENCE_SOURCES = {
  BAZAAR: "bazaar",
  MODAL_7D: "modal_7d",
  FIRST_SEEN: "first_seen",
} as const;
export type ReferenceSource = (typeof REFERENCE_SOURCES)[keyof typeof REFERENCE_SOURCES];

export const CALL_SOURCES = {
  BUY: "buy",
  STRESS_DUPLICATE: "stress_duplicate",
  STRESS_TIMEOUT: "stress_timeout",
} as const;
export type CallSource = (typeof CALL_SOURCES)[keyof typeof CALL_SOURCES];

/** Time limits from the spec. */
export const INDETERMINATE_WINDOW_MS = 10 * 60 * 1000;
export const INDETERMINATE_POLL_MAX_MS = 24 * 60 * 60 * 1000;
export const PRICE_DISCRIMINATION_WINDOW_MS = 10 * 60 * 1000;
export const MODAL_PRICE_WINDOW_MS = 7 * 24 * 60 * 60 * 1000;
export const MAX_BODY_BYTES = 2 * 1024 * 1024;
export const DUPLICATE_RUN_WINDOW_S = 120;
