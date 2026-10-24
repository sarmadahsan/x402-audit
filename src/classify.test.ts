import { describe, expect, it } from "vitest";
import { classify, type ClassificationInput } from "./classify.js";
import { ALL_FLAGS, ALL_OUTCOMES, INDETERMINATE_POLL_MAX_MS, type ValidatorName } from "./taxonomy.js";
import type { ValidatorResult } from "./validators/types.js";

const pass: ValidatorResult = { status: "pass", evidence: {} };
const fail: ValidatorResult = { status: "fail", evidence: {}, reason: "test" };
const skip: ValidatorResult = { status: "skipped", evidence: {}, reason: "no config" };

function allPass(): Partial<Record<ValidatorName, ValidatorResult>> {
  return {
    http_status: pass,
    non_empty: pass,
    content_type: pass,
    not_truncated: pass,
    json_schema: pass,
    entity_matches: pass,
    freshness: pass,
    injection_scan: pass,
  };
}

/** A clean paid call: settled once, 200, every validator passes, quote == reference. */
function base(over: Partial<ClassificationInput> = {}): ClassificationInput {
  return {
    paymentSent: true,
    settlementCount: 1,
    responseReceived: true,
    responseStatus: 200,
    elapsedSinceSignMs: 1_000,
    quoteAmountAtomic: "10000",
    referencePriceAtomic: "10000",
    referenceSource: "bazaar",
    paid: true,
    validators: allPass(),
    latencyMs: 500,
    defaultMaxTimeoutSeconds: 60,
    serviceConfigPresent: true,
    ...over,
  };
}

function withValidators(v: Partial<Record<ValidatorName, ValidatorResult>>): Partial<ClassificationInput> {
  return { validators: { ...allPass(), ...v } };
}

describe("classify: one test per outcome", () => {
  it("ok", () => {
    const c = classify(base());
    expect(c.outcome).toBe("ok");
    expect(c.flags).toEqual([]);
    expect(c.overchargeRatio).toBe(1);
  });

  it("overcharge", () => {
    const c = classify(base({ quoteAmountAtomic: "20000" }));
    expect(c.outcome).toBe("overcharge");
    expect(c.flags).not.toContain("overcharged");
    expect(c.overchargeRatio).toBe(2);
  });

  it("non_delivery (validator failure)", () => {
    const c = classify(base({ responseStatus: 500, ...withValidators({ http_status: fail }) }));
    expect(c.outcome).toBe("non_delivery");
    expect(c.reasons).toContain("http_status:fail");
  });

  it("non_delivery (settled, no response)", () => {
    const c = classify(base({ responseReceived: false, validators: {} }));
    expect(c.outcome).toBe("non_delivery");
    expect(c.reasons).toContain("non_delivery:paid_no_response");
  });

  it.each(["non_empty", "content_type", "not_truncated"] as const)("non_delivery from %s", (v) => {
    expect(classify(base(withValidators({ [v]: fail }))).outcome).toBe("non_delivery");
  });

  it.each(["json_schema", "entity_matches", "freshness"] as const)("wrong_goods from %s", (v) => {
    const c = classify(base(withValidators({ [v]: fail })));
    expect(c.outcome).toBe("wrong_goods");
    expect(c.reasons).toContain(`${v}:fail`);
  });

  it("injection", () => {
    const c = classify(base(withValidators({ injection_scan: fail })));
    expect(c.outcome).toBe("injection");
    expect(c.flags).toContain("injection_hit");
  });

  it("duplicate", () => {
    const c = classify(base({ settlementCount: 2 }));
    expect(c.outcome).toBe("duplicate");
    expect(c.reasons).toContain("settlementCount=2");
  });

  it("indeterminate (no response, no settlement, < 24h)", () => {
    const c = classify(
      base({ settlementCount: 0, responseReceived: false, elapsedSinceSignMs: 11 * 60 * 1000, validators: {} }),
    );
    expect(c.outcome).toBe("indeterminate");
  });

  it("indeterminate even before the 10-minute window", () => {
    const c = classify(base({ settlementCount: 0, responseReceived: false, elapsedSinceSignMs: 5_000 }));
    expect(c.outcome).toBe("indeterminate");
  });

  it("our_error", () => {
    const c = classify(base({ ourError: { reason: "malformed request" } }));
    expect(c.outcome).toBe("our_error");
    expect(c.reasons).toContain("our_error:malformed request");
  });

  it("not_paid (seller rejected with non-2xx, nothing settled)", () => {
    const c = classify(base({ settlementCount: 0, responseStatus: 402, ...withValidators({ http_status: fail }) }));
    expect(c.outcome).toBe("not_paid");
  });

  it("not_paid (no response, no settlement after 24h)", () => {
    const c = classify(
      base({ settlementCount: 0, responseReceived: false, elapsedSinceSignMs: INDETERMINATE_POLL_MAX_MS }),
    );
    expect(c.outcome).toBe("not_paid");
  });

  it("covers all nine outcomes", () => {
    const seen = new Set([
      classify(base()).outcome,
      classify(base({ quoteAmountAtomic: "20000" })).outcome,
      classify(base(withValidators({ http_status: fail }))).outcome,
      classify(base(withValidators({ freshness: fail }))).outcome,
      classify(base(withValidators({ injection_scan: fail }))).outcome,
      classify(base({ settlementCount: 3 })).outcome,
      classify(base({ settlementCount: 0, responseReceived: false })).outcome,
      classify(base({ ourError: { reason: "x" } })).outcome,
      classify(base({ settlementCount: 0, responseStatus: 500 })).outcome,
    ]);
    expect([...seen].sort()).toEqual([...ALL_OUTCOMES].sort());
  });
});

describe("classify: one test per flag", () => {
  it("payto_changed", () => {
    expect(classify(base({ payToChanged: true })).flags).toEqual(["payto_changed"]);
  });
  it("price_discrimination", () => {
    expect(classify(base({ priceDiscrimination: true })).flags).toEqual(["price_discrimination"]);
  });
  it("slow with declared maxTimeoutSeconds", () => {
    const c = classify(base({ latencyMs: 11_000, declaredMaxTimeoutSeconds: 10 }));
    expect(c.flags).toEqual(["slow"]);
    expect(c.outcome).toBe("ok");
    expect(c.reasons.some((r) => r.includes("(declared)"))).toBe(true);
  });
  it("slow with harness default", () => {
    const c = classify(base({ latencyMs: 61_000 }));
    expect(c.flags).toEqual(["slow"]);
    expect(c.reasons.some((r) => r.includes("(default)"))).toBe(true);
  });
  it("not slow at exactly the limit", () => {
    expect(classify(base({ latencyMs: 10_000, declaredMaxTimeoutSeconds: 10 })).flags).toEqual([]);
  });
  it("schema_missing when no service config", () => {
    const c = classify(base({ serviceConfigPresent: false }));
    expect(c.flags).toEqual(["schema_missing"]);
  });
  it("schema_missing when all wrong_goods validators skipped", () => {
    const c = classify(base(withValidators({ json_schema: skip, entity_matches: skip, freshness: skip })));
    expect(c.flags).toEqual(["schema_missing"]);
    expect(c.outcome).toBe("ok");
  });
  it("no schema_missing when only some wrong_goods validators skipped", () => {
    expect(classify(base(withValidators({ json_schema: skip, freshness: skip }))).flags).toEqual([]);
  });
  it("overcharged", () => {
    const c = classify(base({ quoteAmountAtomic: "10001", ...withValidators({ json_schema: fail }) }));
    expect(c.outcome).toBe("wrong_goods");
    expect(c.flags).toEqual(["overcharged"]);
  });
  it("unpaid_overcharge", () => {
    const c = classify(
      base({
        quoteAmountAtomic: "5000000000",
        paid: false,
        overCap: true,
        paymentSent: false,
        settlementCount: 0,
        responseReceived: false,
        validators: {},
      }),
    );
    expect(c.outcome).toBe("overcharge");
    expect(c.flags).toContain("unpaid_overcharge");
    expect(c.flags).not.toContain("overcharged");
  });
  it("probe rows over the reference are overcharge without the unpaid_overcharge flag", () => {
    const c = classify(
      base({ quoteAmountAtomic: "5000000000", paid: false, paymentSent: false, settlementCount: 0, responseReceived: false, validators: {} }),
    );
    expect(c.outcome).toBe("overcharge");
    expect(c.flags).not.toContain("unpaid_overcharge");
  });
  it("unpaid_overcharge loses to our_error", () => {
    const c = classify(base({ quoteAmountAtomic: "20000", paid: false, ourError: { reason: "cap" } }));
    expect(c.outcome).toBe("our_error");
    expect(c.flags).toEqual(["overcharged"]);
  });
  it("charged_then_rejected", () => {
    const c = classify(base({ settlementCount: 1, responseStatus: 400, validators: { http_status: { status: "fail", evidence: { status: 400 }, reason: "non_2xx_status" } } }));
    expect(c.outcome).toBe("non_delivery");
    expect(c.flags).toContain("charged_then_rejected");
    const paidOk = classify(base({ settlementCount: 1, responseStatus: 200 }));
    expect(paidOk.flags).not.toContain("charged_then_rejected");
    const notFound = classify(base({ settlementCount: 1, responseStatus: 404, validators: { http_status: { status: "fail", evidence: { status: 404 }, reason: "non_2xx_status" } } }));
    expect(notFound.flags).toContain("charged_then_rejected");
    const serverErr = classify(base({ settlementCount: 1, responseStatus: 500, validators: { http_status: { status: "fail", evidence: { status: 500 }, reason: "non_2xx_status" } } }));
    expect(serverErr.flags).not.toContain("charged_then_rejected");
    const unsettled = classify(base({ settlementCount: 0, paymentSent: true, responseStatus: 400, responseReceived: true }));
    expect(unsettled.flags).not.toContain("charged_then_rejected");
  });
  it("injection_hit", () => {
    expect(classify(base(withValidators({ injection_scan: fail }))).flags).toEqual(["injection_hit"]);
  });
  it("resolved_late", () => {
    const c = classify(base({ resolvedLate: true, responseReceived: false, validators: {} }));
    expect(c.outcome).toBe("non_delivery");
    expect(c.flags).toEqual(["resolved_late"]);
  });
  it("truncated_by_us", () => {
    expect(classify(base({ truncatedByUs: true })).flags).toEqual(["truncated_by_us"]);
  });
  it("rate_limited (and the row is our_error)", () => {
    const c = classify(base({ rateLimited: true }));
    expect(c.outcome).toBe("our_error");
    expect(c.flags).toEqual(["rate_limited"]);
  });
  it("every flag can be produced together, in canonical order", () => {
    const c = classify(
      base({
        settlementCount: 1,
        responseStatus: 400,
        payToChanged: true,
        priceDiscrimination: true,
        latencyMs: 999_999,
        serviceConfigPresent: false,
        quoteAmountAtomic: "20000",
        paid: false,
        truncatedByUs: true,
        resolvedLate: true,
        rateLimited: true,
        ...withValidators({ injection_scan: fail }),
      }),
    );
    // our_error wins over unpaid_overcharge, so unpaid_overcharge is absent here and overcharged is set.
    expect(c.outcome).toBe("our_error");
    const expected = ALL_FLAGS.filter((f) => f !== "unpaid_overcharge");
    expect(c.flags).toEqual(expected);
  });
});

describe("classify: precedence cases from docs/taxonomy.md", () => {
  it("overcharge + 500 after settlement -> non_delivery with overcharged", () => {
    const c = classify(base({ quoteAmountAtomic: "30000", responseStatus: 500, ...withValidators({ http_status: fail }) }));
    expect(c.outcome).toBe("non_delivery");
    expect(c.flags).toEqual(["overcharged"]);
    expect(c.overchargeRatio).toBe(3);
  });
  it("injection + everything else passing -> injection with injection_hit (not ok)", () => {
    const c = classify(base(withValidators({ injection_scan: fail })));
    expect(c.outcome).toBe("injection");
    expect(c.flags).toEqual(["injection_hit"]);
  });
  it("non_delivery + injection -> non_delivery with injection_hit", () => {
    const c = classify(base(withValidators({ content_type: fail, injection_scan: fail })));
    expect(c.outcome).toBe("non_delivery");
    expect(c.flags).toEqual(["injection_hit"]);
  });
  it("overcharge beats injection", () => {
    const c = classify(base({ quoteAmountAtomic: "10001", ...withValidators({ injection_scan: fail }) }));
    expect(c.outcome).toBe("overcharge");
    expect(c.flags).toEqual(["injection_hit"]);
  });
  it("duplicate beats non_delivery", () => {
    const c = classify(base({ settlementCount: 2, ...withValidators({ http_status: fail }) }));
    expect(c.outcome).toBe("duplicate");
  });
  it("non_delivery beats wrong_goods", () => {
    expect(classify(base(withValidators({ non_empty: fail, json_schema: fail }))).outcome).toBe("non_delivery");
  });
  it("our_error beats everything", () => {
    expect(classify(base({ ourError: { reason: "bug" }, settlementCount: 2 })).outcome).toBe("our_error");
  });
  it("skipped validators never count as failures", () => {
    const v: Partial<Record<ValidatorName, ValidatorResult>> = {};
    for (const k of Object.keys(allPass()) as ValidatorName[]) v[k] = skip;
    expect(classify(base({ validators: v })).outcome).toBe("ok");
  });
});

describe("classify: resolution of indeterminate", () => {
  it("settlement found, no response -> non_delivery + resolved_late", () => {
    const c = classify(base({ responseReceived: false, resolvedLate: true, validators: {} }));
    expect(c.outcome).toBe("non_delivery");
    expect(c.flags).toContain("resolved_late");
  });
  it("two settlements found -> duplicate", () => {
    expect(classify(base({ responseReceived: false, settlementCount: 2, resolvedLate: true })).outcome).toBe("duplicate");
  });
  it("nothing after 24h -> not_paid", () => {
    const c = classify(
      base({ settlementCount: 0, responseReceived: false, elapsedSinceSignMs: INDETERMINATE_POLL_MAX_MS + 1, resolvedLate: true }),
    );
    expect(c.outcome).toBe("not_paid");
    expect(c.flags).toEqual(["resolved_late"]);
  });
});

describe("classify: 2xx without visible settlement", () => {
  it("is classified by validators as if paid, with settlement_unconfirmed reason and no extra flag", () => {
    const c = classify(base({ settlementCount: 0, responseStatus: 200 }));
    expect(c.outcome).toBe("ok");
    expect(c.flags).toEqual([]);
    expect(c.reasons.some((r) => r.startsWith("settlement_unconfirmed"))).toBe(true);
  });
  it("still reaches wrong_goods via validators", () => {
    const c = classify(base({ settlementCount: 0, responseStatus: 204, ...withValidators({ entity_matches: fail }) }));
    expect(c.outcome).toBe("wrong_goods");
    expect(c.reasons.some((r) => r.startsWith("settlement_unconfirmed"))).toBe(true);
  });
  it("falls back to the http_status validator when responseStatus is missing", () => {
    const { responseStatus: _omit, ...rest } = base({ settlementCount: 0 });
    expect(classify(rest).outcome).toBe("ok");
    expect(classify({ ...rest, validators: { ...allPass(), http_status: fail } }).outcome).toBe("not_paid");
  });
  it("non-2xx with no settlement is not_paid even with an overcharge", () => {
    const c = classify(base({ settlementCount: 0, responseStatus: 503, quoteAmountAtomic: "20000" }));
    expect(c.outcome).toBe("not_paid");
    expect(c.flags).toEqual(["overcharged"]);
  });
});

describe("classify: probe rows (no payment sent)", () => {
  it("ok when quote == reference", () => {
    expect(classify(base({ paymentSent: false, settlementCount: 0, paid: false, validators: {} })).outcome).toBe("ok");
  });
});

describe("classify: bigint-safe amounts", () => {
  it("1e21 > 1e21-1 is an overcharge (Number would call them equal)", () => {
    expect(Number("1000000000000000000000")).toBe(Number("999999999999999999999"));
    const c = classify(base({ quoteAmountAtomic: "1000000000000000000000", referencePriceAtomic: "999999999999999999999" }));
    expect(c.outcome).toBe("overcharge");
    expect(c.overchargeRatio).toBeGreaterThanOrEqual(1);
  });
  it("1e21-1 vs 1e21 is not an overcharge", () => {
    const c = classify(base({ quoteAmountAtomic: "999999999999999999999", referencePriceAtomic: "1000000000000000000000" }));
    expect(c.outcome).toBe("ok");
    expect(c.flags).toEqual([]);
  });
  it("equal large amounts are not an overcharge", () => {
    expect(classify(base({ quoteAmountAtomic: "123456789012345678901234567890", referencePriceAtomic: "123456789012345678901234567890" })).outcome).toBe("ok");
  });
  it("no reference -> never overcharge, no ratio", () => {
    const { referencePriceAtomic: _r, referenceSource: _s, ...rest } = base({ quoteAmountAtomic: "999999" });
    const c = classify(rest);
    expect(c.outcome).toBe("ok");
    expect(c.overchargeRatio).toBeUndefined();
  });
  it("rejects non-integer amounts", () => {
    expect(() => classify(base({ quoteAmountAtomic: "1.5" }))).toThrow(/atomic/);
  });
});

describe("classify: schema_missing edge cases", () => {
  it("absent wrong_goods validators (validation never ran) do not set schema_missing", () => {
    expect(classify(base({ responseReceived: false, validators: {} })).flags).toEqual([]);
  });
});
