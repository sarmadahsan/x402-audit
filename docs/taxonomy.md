# Failure taxonomy

This is the heart of the project. Every paid or probed call gets **exactly one
primary outcome** and **zero or more secondary flags**. The constants live in
`src/taxonomy.ts`; a unit test (`src/taxonomy.test.ts`) fails if that file and
this document disagree. **Never add or rename an outcome or flag without
updating this file in the same commit.**

## Primary outcomes

| # | Constant | Meaning | Counts in paid denominator? | Counts as failure in headline? |
|---|---|---|---|---|
| 1 | `ok` | Paid, response received, every validator that ran passed. | yes | no |
| 2 | `overcharge` | The 402 quote's required amount exceeded the reference price for that resource (see "Reference price"). We still pay if the quote is within `MAX_PER_CALL_USD`, because a naive agent would, so delivery is also assessed and recorded as flags. | yes if paid; if unpaid, counted separately with the `unpaid_overcharge` flag | yes |
| 3 | `non_delivery` | Payment settled on-chain (tx hash or settlement response) but the response was 4xx/5xx, empty, truncated, or the wrong content type. | yes | yes |
| 4 | `wrong_goods` | Response well-formed but does not match the request: wrong entity, wrong parameters echoed back, or stale beyond the per-service freshness threshold. Requires a per-service schema/extractor; otherwise `schema_missing` is flagged and this outcome cannot be assigned. | yes | yes |
| 5 | `injection` | Response body contains text addressed to an agent or model rather than data (conservative regex and phrase list in `src/validators/injection_scan.ts`). Every hit is logged with the matched span. **Flagged for human review, reported separately, not counted as a confirmed failure in the headline number.** | yes | no (separate line) |
| 6 | `duplicate` | The same purchase intent produced more than one on-chain settlement. | yes | yes |
| 7 | `indeterminate` | Facilitator or seller timed out after we signed, and we could not establish within 10 minutes whether a settlement occurred. A background job keeps polling for 24 h; on resolution the row is re-classified (see "Resolution") and keeps the `resolved_late` flag. | reported separately | reported separately |
| 8 | `our_error` | We sent a malformed request (the seller answered 400, 405, 415 or 422, or re-issued a 402 whose error text is an embedded 4xx validation error, and nothing settled), hit a rate limit (429), had a local bug, or the cap/halt logic stopped the call before signing. Excluded from the denominator; the count is always printed. | no | no (count shown) |
| 9 | `not_paid` | We attempted payment, the seller or facilitator rejected it or failed before any settlement, and no settlement was found on-chain within 24 h. No money moved, no goods received. This is a seller availability failure, not a buyer-money failure. Excluded from the paid denominator; reported as its own count. (Added because the eight outcomes above have no home for "paid nothing, got nothing", and silently folding it into `non_delivery` would overstate dollar losses.) | no | no (count shown) |

### Precedence

Classification runs the checks below in order; the first that matches is the
primary outcome, and every later condition that also holds becomes a secondary
flag. The order is "the outcome that loses the buyer the most money wins; ties
broken by the order in which the question was defined".

1. `our_error`
2. `not_paid`
3. `indeterminate`
4. `duplicate`
5. `non_delivery`
6. `wrong_goods`
7. `overcharge`
8. `injection`
9. `ok`

So a call that was overcharged *and* returned a 500 after settlement is
`non_delivery` with the `overcharged` flag. A call that paid the listed price,
returned the right entity, and contained an injection string is `injection`
(reported separately) and does not count as `ok`.

### Reference price (for `overcharge`)

In order of preference, recorded per call in `calls.reference_source`:

1. `bazaar`: the price listed in the Bazaar discovery index for that resource.
2. `modal_7d`: the modal quote observed by `probe` for that resource in the last
   7 days (ties broken toward the lower price).
3. `first_seen`: the first price we ever observed for that resource.

`overcharge` means `quote_amount > reference_amount` strictly, in atomic units
of the same asset. The ratio is stored, and the report also shows sensitivity
rows at ratio >= 1.1 and >= 2.0 so a reader can discount one-cent jitter.

### Resolution of `indeterminate`

The background poller re-checks the chain for 24 h after signing.

- Settlement found, no usable response was ever received: `non_delivery`.
- Settlement found twice: `duplicate`.
- No settlement after 24 h: `not_paid`.
- Resolved rows keep the `resolved_late` flag so the report can show how many
  headline rows were classified after the 10-minute window.

### Delivered without a visible settlement

If the seller returned 2xx but no settlement is ever found on-chain (the
facilitator may have settled through a path our scanner does not see, or not
at all), the row is classified by the validators as if paid, with the reason
`settlement_unconfirmed` (and `settlement_absent_after_24h` once the poll
window closes). Such rows stay in the count-weighted denominator; their dollar
weight is the amount from the settlement response header if one was returned,
otherwise zero. The report prints how many rows this is.

### Validator configuration errors

If our own config is broken (a JSON Schema that does not compile, an invalid
JSONPath), the validator returns `skipped` with reason `schema_invalid` or
`path_invalid`, never `fail`: the seller is not blamed for our mistake, and the
row is flagged `schema_missing`.

### Probe rows

Probe rows (module 2, no payment) can only be `ok`, `overcharge` or `our_error`
plus flags. They are never mixed into paid denominators.

### Stress rows

Stress rows (module 4) use the same outcomes but carry `source =
stress_duplicate` or `stress_timeout` and are never mixed into the headline
rate. The stress report counts "second settlement observed" directly.

## Secondary flags

| Constant | Meaning |
|---|---|
| `payto_changed` | The pay-to address in this quote differs from the last observed for this resource. |
| `price_discrimination` | A different quote for the same resource was returned to a different client identity within 10 minutes. |
| `slow` | Latency exceeded the service's declared `maxTimeoutSeconds` (or the harness default when the seller declared none; the evidence records which). |
| `schema_missing` | We had no schema or extractor for this service, so `wrong_goods` could not be assessed. |
| `overcharged` | The overcharge condition held but a higher-precedence outcome won. |
| `unpaid_overcharge` | The quote was over the reference price *and* over `MAX_PER_CALL_USD`, so we did not pay. Dollar weight for this row is the quoted amount in a separate "exposure" column, never in "spent". |
| `injection_hit` | The injection scanner matched, regardless of primary outcome. |
| `resolved_late` | The row was `indeterminate` and was re-classified by the background poller. |
| `truncated_by_us` | We stopped reading the body at 2 MB; `not_truncated` was evaluated on declared length and framing, not on the full body. |
| `rate_limited` | Seller returned 429 at some point during this intent (the row itself is `our_error`). |
| `charged_then_rejected` | A settlement exists and the response was a 400/405/415/422: the seller took payment before validating the request. The row is `non_delivery` (money gone, nothing delivered); this flag lets the report show how much of `non_delivery` is sellers that charge before validating, including requests we built from an empty or absent listing example. |

## Validators

Validators live in `src/validators/` and share one interface:

```ts
type ValidatorStatus = "pass" | "fail" | "skipped";
interface ValidatorResult { status: ValidatorStatus; evidence: Record<string, unknown>; reason?: string }
```

`skipped` is returned when the validator cannot run because configuration is
missing (no schema, no extractor, no freshness rule). **A validator never
returns `pass` by default.** Mapping from validator failures to outcomes:

| Validator | Fails into |
|---|---|
| `http_status` | `non_delivery` |
| `non_empty` | `non_delivery` |
| `content_type` | `non_delivery` |
| `not_truncated` | `non_delivery` |
| `json_schema` | `wrong_goods` |
| `entity_matches` | `wrong_goods` |
| `freshness` | `wrong_goods` |
| `injection_scan` | `injection` (and always sets `injection_hit`) |
